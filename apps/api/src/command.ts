/* One transaction per request. A command's writes, its AuditEvent(s) and its IdempotencyKey row commit together or not
   at all, under the session's tenant (RLS). Reads that reveal PHI use `query`, which writes the view audit in the same
   transaction. Routes built on these mark the request so the generic audit/idempotency hooks stand aside. */
import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Tx } from "@setu/db";
import { config } from "./config.js";
import { err } from "./errors.js";
import { requireSession, type SessionData } from "./plugins/session.js";

export interface AuditEntry { action: string; entity: string; entityId?: string; patientId?: string; basis?: string; detail?: Record<string, unknown> }
export interface CommandResult<T> { status?: number; body: T; audit: AuditEntry[] }

declare module "fastify" { interface FastifyRequest { txManaged?: boolean } }

async function writeAudit(tx: Tx, req: FastifyRequest, s: SessionData, entries: AuditEntry[]) {
  for (const a of entries) {
    await tx.auditEvent.create({ data: {
      tenantId: s.tenantId, userId: s.userId, role: s.role, action: a.action, entity: a.entity, entityId: a.entityId, patientId: a.patientId,
      basis: a.basis, ip: req.ip, detail: { route: req.routeOptions.url, method: req.method, ...(a.detail ?? {}) } as object,
    } });
  }
}

const dbOff = () => err(503, "db_off", "ডাটাবেস চালু নেই", "The database is not running");
const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

/** A write. Requires an Idempotency-Key: a replay returns the stored response without running `fn` again. */
/** `hashOmit`: request-body fields left out of the stored body hash (a signing PIN is never stored, not even hashed). */
/** `txTimeoutMs`: a longer transaction for work that waits on something slow inside it (rendering a receipt PDF). */
export async function command<T>(req: FastifyRequest, reply: FastifyReply, fn: (tx: Tx, s: SessionData) => Promise<CommandResult<T>>, opts: { hashOmit?: string[]; txTimeoutMs?: number } = {}): Promise<T> {
  const s = requireSession(req);
  req.txManaged = true;
  const key = req.headers["idempotency-key"];
  if (!config.dbEnabled) throw dbOff();
  if (typeof key !== "string" || !key || key.length > 200) {
    throw err(400, "idempotency_key_required", "Idempotency-Key হেডার দরকার", "Idempotency-Key header is required");
  }
  /* A key is scoped to this user and this exact URL, and bound to the request body: reusing it for another request is
     refused rather than answered with someone else's stored response. */
  const route = `${req.method} ${(req.url ?? "").split("?")[0]} #${s.userId}`;
  const hashed = opts.hashOmit?.length && req.body && typeof req.body === "object"
    ? Object.fromEntries(Object.entries(req.body as Record<string, unknown>).filter(([k]) => !opts.hashOmit!.includes(k)))
    : (req.body ?? null);
  const hash = createHash("sha256").update(JSON.stringify(hashed)).digest("hex");
  type Stored = { hash: string; body: T };
  const { forTenant } = await import("@setu/db");
  const find = (tx: Tx) => tx.idempotencyKey.findUnique({ where: { tenantId_key_route: { tenantId: s.tenantId, key, route } } });
  const answer = async (tx: Tx, hit: { statusCode: number; response: unknown }) => {
    const stored = hit.response as Stored;
    if (stored.hash !== hash) throw err(422, "idempotency_key_reused", "এই Idempotency-Key অন্য অনুরোধে ব্যবহার হয়েছে", "This Idempotency-Key was used for a different request");
    await writeAudit(tx, req, s, [{ action: "replay", entity: "IdempotencyKey", detail: { status: hit.statusCode } }]);
    return { replayed: true as const, status: hit.statusCode, body: stored.body };
  };
  const send = (out: { replayed: boolean; status: number; body: T }) => { if (out.replayed) reply.header("Idempotent-Replay", "true"); reply.code(out.status); return out.body; };
  try {
    return send(await forTenant(s.tenantId, async (tx) => {
      const hit = await find(tx);
      if (hit) return answer(tx, hit);
      const r = await fn(tx, s);
      const status = r.status ?? 200;
      await writeAudit(tx, req, s, r.audit);
      await tx.idempotencyKey.create({ data: { tenantId: s.tenantId, key, route, statusCode: status, response: { hash, body: r.body } as object } });
      return { replayed: false as const, status, body: r.body };
    }, { timeoutMs: opts.txTimeoutMs, userId: s.userId }));
  } catch (e) {
    // Two requests with the same key raced: the loser rolls back entirely and answers with the winner's response.
    if (!isUniqueViolation(e)) throw e;
    // Not a key race: another write took the same unique slot at the same moment (e.g. two shift opens) — a clean 409,
    // never a raw 500 (security review C1–C4 #8).
    return send(await forTenant(s.tenantId, async (tx) => {
      const hit = await find(tx);
      if (!hit) throw err(409, "conflict", "একই সময়ে অন্য একটি পরিবর্তন হয়েছে — আবার দেখুন", "Another change happened at the same moment — refresh and try again");
      return answer(tx, hit);
    }, { userId: s.userId }));
  }
}

/** A read under the session's tenant; `audit` (if any) is written in the same transaction. */
export async function query<T>(req: FastifyRequest, fn: (tx: Tx, s: SessionData) => Promise<{ body: T; audit: AuditEntry[] }>, opts: { timeoutMs?: number } = {}): Promise<T> {
  const s = requireSession(req);
  req.txManaged = true;
  if (!config.dbEnabled) throw dbOff();
  const { forTenant } = await import("@setu/db");
  return forTenant(s.tenantId, async (tx) => {
    const r = await fn(tx, s);
    await writeAudit(tx, req, s, r.audit);
    return r.body;
  }, { userId: s.userId, timeoutMs: opts.timeoutMs });
}
