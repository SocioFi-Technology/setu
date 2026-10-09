/* ADR 0020 — the patient app (slice D1–D3). A Person signs in with an SMS code; a Person sees no record until a claim
   on a facility is proven with the code printed on that facility's receipt or prescription; the timeline reads each
   linked facility's records inside that facility's own tenant (forTenant — row-level security unchanged). Every
   patient read and write is audited in the facility's tenant (actor person:<id>, basis patient). */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ClaimItem, ClaimList, ClaimProofRequest, ClaimProofResponse, PatientMe, Timeline, TimelineItem } from "@setu/contracts";
import { CLAIM, CLAIM_MAX_TRIES, SUMMARY_KIND, claimAttempt, normalizeClaimCode, transition, type ClaimState } from "@setu/domain";
import type { Tx } from "@setu/db";
import { counters } from "../adapters/counters.js";
import { messenger } from "../adapters/messaging/index.js";
import { err } from "../errors.js";
import { requirePerson, type PersonSession } from "../plugins/patientSession.js";

export const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_TRIES = 5, SENDS_PER_PHONE = 3, SENDS_PER_IP = 10, PROOFS_PER_HOUR = 20;
const ten = (phone01: string) => phone01.slice(1);
const dash = <T extends string>(s: string) => s.replace(/_/g, "-") as T;
const under = <T extends string>(s: string) => s.replace(/-/g, "_") as T;
type DbClaim = "candidate" | "proof_pending" | "linked" | "not_mine" | "locked";
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/* ── sign-in ── */
/** Send a sign-in code. The answer never says whether the number is known; limits per phone and per address. */
export async function sendOtp(phone01: string, lang: "bn" | "en", ip: string): Promise<number> {
  const c = counters(), ph = ten(phone01);
  if (await c.incr(`potp:send:${ph}`, 15 * 60_000) > SENDS_PER_PHONE) throw err(429, "otp_rate", "অনেকবার কোড চাওয়া হয়েছে — ১৫ মিনিট পর আবার চেষ্টা করুন", "Too many codes asked for — try again in 15 minutes");
  if (await c.incr(`potp:ip:${ip}`, 3600_000) > SENDS_PER_IP) throw err(429, "otp_rate", "অনেকবার কোড চাওয়া হয়েছে — পরে আবার চেষ্টা করুন", "Too many codes asked for — try again later");
  const code = randomInt(100_000, 1_000_000);
  await c.set(`potp:code:${ph}`, code, OTP_TTL_MS);
  await c.del(`potp:tries:${ph}`);
  // a fixed template (ADR 0006): the code, how long, never share — Latin digits so every phone shows them
  const text = lang === "bn" ? `সেতু: আপনার কোড ${code}। ৫ মিনিট কাজ করবে। কাউকে বলবেন না।` : `Setu: your code is ${code}. It works for 5 minutes. Never share it.`;
  const r = await messenger.sendSms({ messageId: `potp_${ph}_${Date.now()}`, to: phone01, text, tenantId: "network" });
  if (r.status === "failed") throw err(502, "otp_not_sent", "কোড পাঠানো গেল না — একটু পরে আবার চেষ্টা করুন", "The code could not be sent — try again shortly");
  return OTP_TTL_MS / 1000;
}
/** Check a sign-in code: 5 wrong tries end it. Right → the Person (made on the first sign-in). */
export async function verifyOtp(phone01: string, code: string): Promise<{ id: string; lang: string; generation: number }> {
  const c = counters(), ph = ten(phone01);
  const tries = await c.incr(`potp:tries:${ph}`, OTP_TTL_MS);
  if (tries > OTP_MAX_TRIES) { await c.del(`potp:code:${ph}`); throw err(429, "otp_locked", "অনেকবার ভুল হয়েছে — নতুন কোড চান", "Too many wrong tries — ask for a new code"); }
  const stored = await c.get(`potp:code:${ph}`);
  if (!stored) throw err(401, "otp_expired", "কোডের মেয়াদ শেষ — নতুন কোড চান", "The code has expired — ask for a new one");
  if (stored !== Number(code)) throw err(401, "otp_wrong", "কোড মেলেনি", "The code does not match", { triesLeft: OTP_MAX_TRIES - tries });
  await c.del(`potp:code:${ph}`, `potp:tries:${ph}`, `potp:send:${ph}`);
  const { personUpsert } = await import("@setu/db");
  return personUpsert(ph);
}

/* ── the person's own reads and writes ── */
/** A read as the signed-in person: the session's generation must still be current (sign out everywhere). */
export async function personQuery<T>(req: FastifyRequest, fn: (tx: Tx, p: PersonSession) => Promise<T>): Promise<T> {
  const p = requirePerson(req);
  const { forPerson } = await import("@setu/db");
  return forPerson(p.personId, async (tx) => { await live(tx, p); return fn(tx, p); });
}
async function live(tx: Tx, p: PersonSession) {
  const row = await tx.person.findFirst({ where: { id: p.personId }, select: { sessionGeneration: true } });
  if (!row || row.sessionGeneration !== p.generation) throw err(401, "patient_signed_out", "আবার সাইন ইন করুন", "Sign in again");
}
/** A write in one facility's tenant by the person: Idempotency-Key required; the change and the stored answer commit
    together (forPersonInTenant); a replay answers the stored response without running again. */
export async function personCommand<T>(req: FastifyRequest, reply: FastifyReply, tenantId: string, fn: (tx: Tx, p: PersonSession) => Promise<{ status?: number; body: T }>): Promise<T> {
  const p = requirePerson(req);
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !key || key.length > 200) throw err(400, "idempotency_key_required", "Idempotency-Key হেডার দরকার", "Idempotency-Key header is required");
  const route = `${req.method} ${(req.url ?? "").split("?")[0]}`;
  const hash = createHash("sha256").update(JSON.stringify(req.body ?? null)).digest("hex");
  const { forPersonInTenant } = await import("@setu/db");
  const out = await forPersonInTenant(p.personId, tenantId, async (tx) => {
    await live(tx, p);
    const hit = await tx.personIdempotency.findUnique({ where: { personId_key_route: { personId: p.personId, key, route } } });
    if (hit) {
      const stored = hit.response as { hash: string; body: T };
      if (stored.hash !== hash) throw err(422, "idempotency_key_reused", "এই Idempotency-Key অন্য অনুরোধে ব্যবহার হয়েছে", "This Idempotency-Key was used for a different request");
      return { replayed: true, status: hit.statusCode, body: stored.body };
    }
    const r = await fn(tx, p);
    const status = r.status ?? 200;
    await tx.personIdempotency.create({ data: { personId: p.personId, key, route, statusCode: status, response: { hash, body: r.body } as object } });
    return { replayed: false, status, body: r.body };
  });
  if (out.replayed) reply.header("Idempotent-Replay", "true");
  reply.code(out.status);
  return out.body;
}
/** An audit row in the facility's tenant for something the person did there. */
async function audit(tx: Tx, req: FastifyRequest, tenantId: string, p: PersonSession, a: { action: string; entity: string; entityId?: string | null; patientId?: string | null; detail?: object }) {
  await tx.auditEvent.create({ data: { tenantId, action: a.action, entity: a.entity, entityId: a.entityId ?? null, patientId: a.patientId ?? null, basis: "patient", ip: req.ip,
    detail: { actor: `person:${p.personId}`, route: req.routeOptions.url, method: req.method, ...(a.detail ?? {}) } as object } });
}

export async function patientMe(req: FastifyRequest): Promise<PatientMe> {
  const p = requirePerson(req);
  const { personClaims, personCandidates } = await import("@setu/db");
  const person = await personQuery(req, (tx) => tx.person.findFirstOrThrow({ where: { id: p.personId } }));
  const [claims, cands] = await Promise.all([personClaims(p.personId), personCandidates(p.phone)]);
  const linked = claims.filter((c) => c.status === "linked").length;
  const closed = new Set(claims.filter((c) => c.status === "linked" || c.status === "not-mine").map((c) => c.tenantId));
  return { person: { id: p.personId, phoneMasked: `0${p.phone.slice(0, 2)}*****${p.phone.slice(-3)}`, lang: person.lang === "en" ? "en" : "bn", networkSharing: person.networkSharing }, counts: { linked, toClaim: cands.filter((c) => !closed.has(c.tenantId)).length } };
}

/* ── claims ── */
type ClaimRow = { id: string; status: string; method: string | null; tries: number; lockedUntil: Date | null };
function claimItem(c: ClaimRow, fac: { facilityEn: string | null; facilityBn: string | null; lastMonth: string }, now: Date): ClaimItem {
  let status = dash<ClaimItem["status"]>(c.status), tries = c.tries, lockedUntil = c.lockedUntil;
  // a lock past its 24 hours shows as open again (the next attempt lifts it — claimAttempt)
  if (status === "locked" && lockedUntil && lockedUntil.getTime() <= now.getTime()) { status = "proof-pending"; tries = 0; lockedUntil = null; }
  const triesLeft = status === "locked" ? 0 : status === "linked" || status === "not-mine" ? 0 : CLAIM_MAX_TRIES - tries;
  return { id: c.id, ...fac, status, method: (c.method as ClaimItem["method"]) ?? null, triesLeft, lockedUntil: iso(lockedUntil) };
}
/** One claim per facility with records on the person's phone (made here the first time it is seen) and any the person
    already has; the facility's name and the month of the last visit — nothing else. */
export async function listClaims(req: FastifyRequest, now = new Date()): Promise<ClaimList> {
  const p = requirePerson(req);
  await personQuery(req, async () => undefined); // the session is still current
  const { forTenant, personCandidates, personClaims } = await import("@setu/db");
  const cands = await personCandidates(p.phone);
  const known = new Map((await personClaims(p.personId)).map((c) => [c.tenantId, c]));
  const tenants = [...cands.map((c) => c.tenantId), ...[...known.keys()].filter((t) => !cands.some((c) => c.tenantId === t))];
  const items: ClaimItem[] = [];
  for (const t of tenants) {
    const cand = cands.find((c) => c.tenantId === t);
    const row = await forTenant(t, async (tx) => {
      const c = await tx.patientClaim.upsert({ where: { tenantId_personId: { tenantId: t, personId: p.personId } }, create: { tenantId: t, personId: p.personId }, update: {} });
      if (cand) return { c, fac: { facilityEn: cand.facilityEn, facilityBn: cand.facilityBn, lastMonth: cand.lastMonth } };
      const o = await tx.organization.findFirst({ where: { tenantId: t }, orderBy: { id: "asc" } });
      return { c, fac: { facilityEn: o?.name ?? null, facilityBn: o?.nameBn ?? null, lastMonth: (c.linkedAt ?? c.createdAt).toISOString().slice(0, 7) } };
    });
    items.push(claimItem(row.c, row.fac, now));
  }
  return { items };
}
const claimOf = async (p: PersonSession, claimId: string) => {
  const { personClaims } = await import("@setu/db");
  const c = (await personClaims(p.personId)).find((x) => x.id === claimId);
  if (!c) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
  return c;
};
/** The code inside a scanned QR: the last 6-character run of the alphabet (the QR carries a URL ending in the code). */
const codeFromQr = (raw: string) => { const m = raw.toUpperCase().match(/[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}(?=[^A-Z0-9]*$)/); return m ? m[0] : null; };
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export async function proveClaim(req: FastifyRequest, reply: FastifyReply, claimId: string, body: ClaimProofRequest, now = new Date()): Promise<ClaimProofResponse> {
  const p = requirePerson(req);
  const c0 = await claimOf(p, claimId);
  // review A3-style limit: proofs across every facility, per person, per hour
  if (await counters().incr(`pclaim:${p.personId}`, 3600_000) > PROOFS_PER_HOUR) throw err(429, "rate_limited", "অনেকবার চেষ্টা হয়েছে — পরে আবার করুন", "Too many tries — try again later");
  const code = body.method === "desk" ? null : body.method === "qr" ? codeFromQr(body.code) : normalizeClaimCode(body.code);
  if (body.method !== "desk" && !code) throw err(400, "code_format", "কোডটি ৬ অক্ষরের — আবার দেখে লিখুন", "The code has 6 characters — check it and type it again", { field: "code" });
  return personCommand<ClaimProofResponse>(req, reply, c0.tenantId, async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "PatientClaim" WHERE "id" = ${claimId} FOR UPDATE`;
    const c = (await tx.patientClaim.findUnique({ where: { id: claimId } }))!;
    const facts = { status: dash<ClaimState>(c.status), tries: c.tries, lockedUntil: c.lockedUntil };
    const fac = await facilityOf(tx, c.tenantId, p.phone);
    if (body.method === "desk") {
      if (facts.status !== "candidate" && facts.status !== "proof-pending") throw err(409, "claim_closed", "এই দাবি আর খোলা নেই", "This claim is no longer open");
      const status = facts.status === "candidate" ? transition("claim", CLAIM, facts.status, "startProof") : facts.status;
      const u = await tx.patientClaim.update({ where: { id: c.id }, data: { status: under<DbClaim>(status), method: "desk", statusAt: now } });
      await audit(tx, req, c.tenantId, p, { action: "claim", entity: "PatientClaim", entityId: c.id, detail: { method: "desk", outcome: "desk-pending" } });
      return { body: { claim: claimItem(u, fac, now), outcome: "desk-pending" as const } };
    }
    // the code against this facility's records on the person's phone (every one compared, constant time)
    const pts = await tx.patient.findMany({ where: { phone: p.phone, linkedToId: null }, select: { id: true, claimCode: true } });
    let match: string | null = null;
    for (const x of pts) if (x.claimCode && same(x.claimCode, code!)) match = x.id;
    const a = claimAttempt(facts, match !== null, now);
    if (a.refused === "closed") throw err(409, "claim_closed", "এই দাবি আর খোলা নেই", "This claim is no longer open");
    if (a.refused === "locked") {
      await audit(tx, req, c.tenantId, p, { action: "claim", entity: "PatientClaim", entityId: c.id, detail: { method: body.method, outcome: "locked" } });
      return { body: { claim: claimItem(c, fac, now), outcome: "locked" as const } };
    }
    const linked = a.status === "linked";
    const u = await tx.patientClaim.update({ where: { id: c.id }, data: {
      status: under<DbClaim>(a.status), tries: a.tries, lockedUntil: a.lockedUntil, method: body.method, statusAt: now,
      ...(linked ? { patientId: match, linkedAt: now } : {}),
    } });
    if (linked) await tx.provenance.create({ data: { tenantId: c.tenantId, targetType: "Patient", targetId: match!, activity: "patient-app-claim", agentId: `person:${p.personId}`, onBehalfOf: `person:${p.personId}`, recorded: now, source: "patient_reported", detail: { method: body.method, claimId: c.id } as object } });
    const outcome = linked ? "linked" as const : a.status === "locked" ? "locked" as const : "wrong-code" as const;
    await audit(tx, req, c.tenantId, p, { action: "claim", entity: "PatientClaim", entityId: c.id, patientId: match, detail: { method: body.method, outcome, triesLeft: a.triesLeft } });
    return { body: { claim: claimItem(u, fac, now), outcome } };
  });
}
export async function notMine(req: FastifyRequest, reply: FastifyReply, claimId: string, now = new Date()): Promise<ClaimItem> {
  const p = requirePerson(req);
  const c0 = await claimOf(p, claimId);
  return personCommand(req, reply, c0.tenantId, async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "PatientClaim" WHERE "id" = ${claimId} FOR UPDATE`;
    const c = (await tx.patientClaim.findUnique({ where: { id: claimId } }))!;
    const from = dash<ClaimState>(c.status);
    if (from !== "candidate" && from !== "proof-pending") throw err(409, "claim_closed", "এই দাবি আর খোলা নেই", "This claim is no longer open");
    const u = await tx.patientClaim.update({ where: { id: c.id }, data: { status: under<DbClaim>(transition("claim", CLAIM, from, "notMine")), statusAt: now } });
    // the facility learns of it from this row (its audit log): records on its patient's phone someone says are not theirs
    await audit(tx, req, c.tenantId, p, { action: "claim", entity: "PatientClaim", entityId: c.id, detail: { outcome: "not-mine" } });
    return { body: claimItem(u, await facilityOf(tx, c.tenantId, p.phone), now) };
  });
}
async function facilityOf(tx: Tx, tenantId: string, phone10: string) {
  const { personCandidates } = await import("@setu/db");
  const cand = (await personCandidates(phone10)).find((c) => c.tenantId === tenantId);
  if (cand) return { facilityEn: cand.facilityEn, facilityBn: cand.facilityBn, lastMonth: cand.lastMonth };
  const o = await tx.organization.findFirst({ where: { tenantId }, orderBy: { id: "asc" } });
  return { facilityEn: o?.name ?? null, facilityBn: o?.nameBn ?? null, lastMonth: new Date().toISOString().slice(0, 7) };
}

/* ── the timeline ── */
const KIND_OF_FILTER: Record<Timeline["filter"], TimelineItem["kind"][] | null> = {
  all: null, reports: ["report"], prescriptions: ["prescription"], visits: ["visit", "admission", "summary"], mine: [],
};
/** Every linked facility's records of the linked patient, newest first — read in that facility's tenant and audited
    there. Only signed / released documents; never a draft. */
export async function timeline(req: FastifyRequest, filter: Timeline["filter"]): Promise<Timeline> {
  const p = requirePerson(req);
  await personQuery(req, async () => undefined);
  const { forTenant, personClaims } = await import("@setu/db");
  const linked = (await personClaims(p.personId)).filter((c) => c.status === "linked" && c.patientId);
  const items: TimelineItem[] = [];
  for (const c of linked) {
    const got = await forTenant(c.tenantId, async (tx) => {
      const pid = c.patientId!;
      const [encs, notes, reports] = await Promise.all([
        tx.encounter.findMany({ where: { patientId: pid, OR: [{ class: { in: ["opd", "er"] }, status: "finished" }, { class: "ipd", status: { notIn: ["cancelled", "entered_in_error"] } }] }, select: { id: true, class: true, arrivedAt: true, createdAt: true, organizationId: true, token: true, practitionerId: true } }),
        tx.composition.findMany({ where: { patientId: pid, kind: { in: ["consultation-note", SUMMARY_KIND] }, status: { in: ["final", "amended"] }, supersededById: null }, select: { id: true, kind: true, signedAt: true, organizationId: true, signedById: true, encounterId: true } }),
        tx.diagnosticReport.findMany({ where: { patientId: pid, supersededById: null, status: { in: ["preliminary", "final", "corrected"] } }, select: { id: true, number: true, status: true, releasedAt: true, organizationId: true } }),
      ]);
      const orgIds = [...new Set([...encs, ...notes, ...reports].map((x) => x.organizationId))];
      const userIds = [...new Set([...encs.map((e) => e.practitionerId), ...notes.map((n) => n.signedById)].filter((x): x is string => Boolean(x)))];
      const [orgs, users] = await Promise.all([
        tx.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true, nameBn: true } }),
        tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, nameEn: true, nameBn: true } }),
      ]);
      const org = (id: string) => orgs.find((o) => o.id === id);
      const doc = (id: string | null) => (id ? users.find((u) => u.id === id) : undefined);
      const base = (o: string, d: string | null | undefined) => ({ facilityEn: org(o)?.name ?? null, facilityBn: org(o)?.nameBn ?? null, doctorEn: doc(d ?? null)?.nameEn ?? null, doctorBn: doc(d ?? null)?.nameBn ?? null, source: "provider-verified" as const, claimId: c.id });
      const out: TimelineItem[] = [
        ...encs.map((e): TimelineItem => ({ key: `${e.class === "ipd" ? "admission" : "visit"}:${e.id}`, kind: e.class === "ipd" ? "admission" : "visit", at: (e.arrivedAt ?? e.createdAt).toISOString(), visitClass: e.class === "home" ? "opd" : e.class, number: e.token ?? null, status: null, recordId: e.id, ...base(e.organizationId, e.practitionerId) })),
        ...notes.map((n): TimelineItem => ({ key: `${n.kind === SUMMARY_KIND ? "summary" : "prescription"}:${n.id}`, kind: n.kind === SUMMARY_KIND ? "summary" : "prescription", at: (n.signedAt ?? new Date(0)).toISOString(), visitClass: null, number: null, status: null, recordId: n.id, ...base(n.organizationId, n.signedById) })),
        ...reports.map((r): TimelineItem => ({ key: `report:${r.id}`, kind: "report", at: r.releasedAt.toISOString(), visitClass: null, number: r.number, status: r.status, recordId: r.id, ...base(r.organizationId, null) })),
      ];
      await audit(tx, req, c.tenantId, p, { action: "view", entity: "Patient", entityId: pid, patientId: pid, detail: { purpose: "patient-app-timeline", count: out.length } });
      return out;
    });
    items.push(...got);
  }
  const kinds = KIND_OF_FILTER[filter];
  const shown = items.filter((i) => kinds === null || kinds.includes(i.kind)).sort((a, b) => b.at.localeCompare(a.at));
  return { filter, items: shown, facilities: linked.length };
}
