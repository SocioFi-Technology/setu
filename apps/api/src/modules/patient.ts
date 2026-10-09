/* ADR 0020 — the patient app (slice D1–D3). A Person signs in with an SMS code; a Person sees no record until a claim
   on a facility is proven with the code printed on that facility's receipt or prescription; the timeline reads each
   linked facility's records inside that facility's own tenant (forTenant — row-level security unchanged). Every
   patient read and write is audited in the facility's tenant (actor person:<id>, basis patient). */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AccessLog, ClaimItem, ClaimList, ClaimProofRequest, ClaimProofResponse, PatientMe, PatientReportView, Timeline, TimelineItem } from "@setu/contracts";
import { CLAIM, CLAIM_MAX_TRIES, claimAttempt, normalizeClaimCode, transition, type ClaimState } from "@setu/domain";
import type { Tx } from "@setu/db";
import { counters } from "../adapters/counters.js";
import { messenger } from "../adapters/messaging/index.js";
import { err } from "../errors.js";
import { requirePerson, type PersonSession } from "../plugins/patientSession.js";
import { copyPdf } from "./documents.js";
import { itemFacts, markNoticesRead, recordsIn, reportCodes, reportIn, trendIn, unreadNotices, withTrend } from "./records.js";

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
export async function personCommand<T>(req: FastifyRequest, reply: FastifyReply, tenantId: string | null, fn: (tx: Tx, p: PersonSession) => Promise<{ status?: number; body: T }>): Promise<T> {
  const p = requirePerson(req);
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !key || key.length > 200) throw err(400, "idempotency_key_required", "Idempotency-Key হেডার দরকার", "Idempotency-Key header is required");
  const route = `${req.method} ${(req.url ?? "").split("?")[0]}`;
  const hash = createHash("sha256").update(JSON.stringify(req.body ?? null)).digest("hex");
  const { forPerson, forPersonInTenant } = await import("@setu/db");
  // tenantId null: a network-level write (a share, ADR 0021) — the person's rows only
  const inScope = <R,>(run: (tx: Tx) => Promise<R>) => (tenantId ? forPersonInTenant(p.personId, tenantId, run) : forPerson(p.personId, run));
  const out = await inScope(async (tx) => {
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
export async function audit(tx: Tx, req: FastifyRequest, tenantId: string, p: PersonSession, a: { action: string; entity: string; entityId?: string | null; patientId?: string | null; detail?: object }) {
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
  const linked = await linkedClaims(req);
  const { forTenant } = await import("@setu/db");
  const items: TimelineItem[] = [];
  for (const c of linked) {
    const got = await forTenant(c.tenantId, async (tx) => {
      const pid = c.patientId!;
      const [facts, unread] = await Promise.all([recordsIn(tx, pid), unreadNotices(tx, pid)]);
      await audit(tx, req, c.tenantId, p, { action: "view", entity: "Patient", entityId: pid, patientId: pid, detail: { purpose: "patient-app-timeline", count: facts.length } });
      return facts.map((f): TimelineItem => ({ ...f, claimId: c.id, unread: unread.has(f.recordId) }));
    });
    items.push(...got);
  }
  const kinds = KIND_OF_FILTER[filter];
  const shown = items.filter((i) => kinds === null || kinds.includes(i.kind)).sort((a, b) => b.at.localeCompare(a.at));
  return { filter, items: shown, facilities: linked.length };
}
/** the person's linked claims (signed-in check included) */
export async function linkedClaims(req: FastifyRequest) {
  const p = requirePerson(req);
  await personQuery(req, async () => undefined);
  const { personClaims } = await import("@setu/db");
  return (await personClaims(p.personId)).filter((c) => c.status === "linked" && c.patientId);
}
async function linkedClaim(req: FastifyRequest, claimId: string) {
  const c = (await linkedClaims(req)).find((x) => x.id === claimId);
  if (!c) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
  return c;
}

/* ── D4 (ADR 0021): one report, the original PDF ── */
export async function patientReport(req: FastifyRequest, claimId: string, reportId: string, now = new Date()): Promise<PatientReportView> {
  const p = requirePerson(req);
  const linked = await linkedClaims(req);
  const c = await linkedClaim(req, claimId);
  const { forTenant } = await import("@setu/db");
  const core = await forTenant(c.tenantId, async (tx) => {
    const r = await reportIn(tx, c.patientId!, reportId);
    await markNoticesRead(tx, c.patientId!, reportId, now);
    await audit(tx, req, c.tenantId, p, { action: "view", entity: "DiagnosticReport", entityId: reportId, patientId: c.patientId, detail: { purpose: "patient-app-report", number: r.report.number, version: r.report.version } });
    return r;
  });
  // the trend: the same analytes at every linked facility, each read in its own tenant
  const codes = reportCodes(core), points = [];
  for (const l of linked) points.push(...await forTenant(l.tenantId, (tx) => trendIn(tx, l.patientId!, codes)));
  return { ...withTrend(core, points), claimId };
}
export async function patientPdf(req: FastifyRequest, claimId: string, kind: "lr" | "rx" | "ds", id: string, lang: "bn" | "en", now = new Date()): Promise<Uint8Array> {
  const p = requirePerson(req);
  const c = await linkedClaim(req, claimId);
  const { forTenant } = await import("@setu/db");
  return forTenant(c.tenantId, async (tx) => {
    // only this person's linked record (a document of another patient is "not found", never a hint)
    const f = await itemFacts(tx, c.patientId!, kind === "lr" ? "report" : kind === "rx" ? "prescription" : "summary", id);
    if (!f) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
    const out = await copyPdf(tx, c.tenantId, kind, id, lang, "patient");
    await markNoticesRead(tx, c.patientId!, id, now);
    await audit(tx, req, c.tenantId, p, { action: "print", entity: kind === "lr" ? "DiagnosticReport" : "Composition", entityId: id, patientId: c.patientId, detail: { purpose: "patient-app-copy", kind, label: out.label } });
    return out.bytes;
  });
}

/* ── D6 (ADR 0021): who viewed — every linked facility's audit about the linked patient, the patient's own reads left out ── */
const SEEN_ACTIONS = ["view", "print", "reprint", "break-glass"];
const WHAT: Record<string, string> = { Patient: "record", Encounter: "visit", DiagnosticReport: "report", Observation: "report", Composition: "prescription", Invoice: "bill", Receipt: "bill", Admission: "visit" };
const PAGE = 50;
export async function accessLog(req: FastifyRequest, before: string | null): Promise<AccessLog> {
  const linked = await linkedClaims(req);
  const { forTenant } = await import("@setu/db");
  const cut = before ? new Date(before) : null;
  if (cut && Number.isNaN(cut.getTime())) throw err(400, "validation", "তারিখ ঠিক নয়", "Bad cursor", { field: "before" });
  const all: (AccessLog["items"][number] & { t: number })[] = [];
  for (const c of linked) {
    const rows = await forTenant(c.tenantId, async (tx) => {
      const ev = await tx.auditEvent.findMany({
        // the patient's own reads (basis patient) left out; staff reads mostly have no basis (NULL): kept, explicitly
        where: { patientId: c.patientId!, action: { in: SEEN_ACTIONS }, OR: [{ basis: null }, { basis: { not: "patient" } }], ...(cut ? { at: { lt: cut } } : {}) },
        orderBy: { at: "desc" }, take: PAGE + 1,
      });
      const users = await tx.user.findMany({ where: { id: { in: [...new Set(ev.map((e) => e.userId).filter((x): x is string => Boolean(x)))] } }, select: { id: true, nameEn: true, nameBn: true } });
      const orgs = await tx.organization.findMany({ where: { tenantId: c.tenantId }, select: { id: true, name: true, nameBn: true } });
      return ev.map((e) => {
        const d = (e.detail ?? {}) as { kind?: string; reader?: { nameEn: string; nameBn: string; role: string; facilityEn: string; facilityBn: string | null }; reason?: string; reviewed?: boolean };
        const shared = e.basis === "patient-share" && d.reader;
        const u = users.find((x) => x.id === e.userId);
        const o = orgs.find((x) => x.id === e.organizationId) ?? orgs[0];
        const what = e.entity === "Composition" && d.kind === "ds" ? "summary" : (WHAT[e.entity] ?? "other");
        return {
          t: e.at.getTime(), at: e.at.toISOString(),
          kind: (e.action === "break-glass" || e.basis === "emergency" ? "break-glass" : shared ? "shared" : e.action) as AccessLog["items"][number]["kind"],
          what,
          nameEn: shared ? d.reader!.nameEn : u?.nameEn ?? null, nameBn: shared ? d.reader!.nameBn : u?.nameBn ?? null,
          role: shared ? d.reader!.role : e.role ?? null,
          facilityEn: shared ? d.reader!.facilityEn : o?.name ?? null, facilityBn: shared ? d.reader!.facilityBn : o?.nameBn ?? null,
          reason: e.action === "break-glass" || e.basis === "emergency" ? d.reason ?? null : null,
          reviewed: e.action === "break-glass" || e.basis === "emergency" ? d.reviewed ?? false : null,
        };
      });
    });
    all.push(...rows);
  }
  all.sort((a, b) => b.t - a.t);
  const page = all.slice(0, PAGE);
  return { items: page.map(({ t: _t, ...x }) => x), next: all.length > PAGE ? page[page.length - 1]!.at : null };
}
