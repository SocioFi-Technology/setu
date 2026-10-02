/* One transaction per request. A command's writes, its AuditEvent(s) and its IdempotencyKey row commit together or not
   at all, under the session's tenant (RLS). Reads that reveal PHI use `query`, which writes the view audit in the same
   transaction. Routes built on these mark the request so the generic audit/idempotency hooks stand aside. */
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
export async function command<T>(req: FastifyRequest, reply: FastifyReply, fn: (tx: Tx, s: SessionData) => Promise<CommandResult<T>>): Promise<T> {
  const s = requireSession(req);
  req.txManaged = true;
  const key = req.headers["idempotency-key"];
  if (!config.dbEnabled) throw dbOff();
  if (typeof key !== "string" || !key || key.length > 200) {
    throw err(400, "idempotency_key_required", "Idempotency-Key হেডার দরকার", "Idempotency-Key header is required");
  }
  const route = req.routeOptions.url ?? "";
  const { forTenant } = await import("@setu/db");
  const replay = async () => forTenant(s.tenantId, (tx) => tx.idempotencyKey.findUnique({ where: { tenantId_key_route: { tenantId: s.tenantId, key, route } } }));
  try {
    const out = await forTenant(s.tenantId, async (tx) => {
      const hit = await tx.idempotencyKey.findUnique({ where: { tenantId_key_route: { tenantId: s.tenantId, key, route } } });
      if (hit) return { replayed: true as const, status: hit.statusCode, body: hit.response as T };
      const r = await fn(tx, s);
      const status = r.status ?? 200;
      await writeAudit(tx, req, s, r.audit);
      await tx.idempotencyKey.create({ data: { tenantId: s.tenantId, key, route, statusCode: status, response: r.body as object } });
      return { replayed: false as const, status, body: r.body };
    });
    if (out.replayed) reply.header("Idempotent-Replay", "true");
    reply.code(out.status);
    return out.body;
  } catch (e) {
    // Two requests with the same key raced: the loser rolls back entirely and answers with the winner's response.
    if (!isUniqueViolation(e)) throw e;
    const hit = await replay();
    if (!hit) throw e;
    reply.header("Idempotent-Replay", "true").code(hit.statusCode);
    return hit.response as T;
  }
}

/** A read under the session's tenant; `audit` (if any) is written in the same transaction. */
export async function query<T>(req: FastifyRequest, fn: (tx: Tx, s: SessionData) => Promise<{ body: T; audit: AuditEntry[] }>): Promise<T> {
  const s = requireSession(req);
  req.txManaged = true;
  if (!config.dbEnabled) throw dbOff();
  const { forTenant } = await import("@setu/db");
  return forTenant(s.tenantId, async (tx) => {
    const r = await fn(tx, s);
    await writeAudit(tx, req, s, r.audit);
    return r.body;
  });
}
