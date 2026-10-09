/* ADR 0021 — a patient's share with a doctor or a facility (a Consent with basis "patient"). Kamrul 09/10/2026: every
   share is time-limited (30 days unless the patient picks 24 h or 7 days), revocable any time, scoped to one visit, one
   report or "all"; the server decides every read by the receiving doctor here, never by the stored status alone. */
import { CONSENT, transition, type ConsentState } from "./machines.js";

export const SHARE_PERIODS = { "24h": 24, "7d": 7 * 24, "30d": 30 * 24 } as const;
export type SharePeriod = keyof typeof SHARE_PERIODS;
export const SHARE_DEFAULT_PERIOD: SharePeriod = "30d";
export const isSharePeriod = (p: string): p is SharePeriod => Object.prototype.hasOwnProperty.call(SHARE_PERIODS, p);
export const shareEndsAt = (from: Date, period: SharePeriod = SHARE_DEFAULT_PERIOD) => new Date(from.getTime() + SHARE_PERIODS[period] * 3600_000);

/** what the share covers: all of the person's linked records (at every linked facility, during the period), one visit,
    or one report (and its later corrected versions) */
export type ShareScope =
  | { kind: "all" }
  | { kind: "visit"; tenantId: string; patientId: string; encounterId: string }
  | { kind: "report"; tenantId: string; patientId: string; reportId: string };
export interface LinkedRecord { tenantId: string; patientId: string }

export type ShareProblem = "period" | "not_linked" | "nothing_linked";
export function shareRequestProblems(r: { period: string; scope: ShareScope; grantee: { tenantId: string; organizationId: string; userId: string | null } }, linked: LinkedRecord[]): ShareProblem[] {
  const out: ShareProblem[] = [];
  if (!isSharePeriod(r.period)) out.push("period");
  if (r.scope.kind === "all") { if (!linked.length) out.push("nothing_linked"); }
  else { const s = r.scope; if (!linked.some((l) => l.tenantId === s.tenantId && l.patientId === s.patientId)) out.push("not_linked"); }
  return out;
}

/** `kinds`: the item kinds a consent from an access request opens (ADR 0023; empty = every kind — the patient's own
    share); `hideSensitive`: such a consent never opens an item of a visit with a sensitive condition or medicine */
export interface ShareFacts { status: ConsentState; endsAt: Date; granteeTenantId: string; granteeUserId: string | null; scope: ShareScope; kinds?: readonly ShareItem["kind"][]; hideSensitive?: boolean }
/** one record the receiving doctor asks for; `reportChain` = the report's versions up to this one (a corrected report
    stays covered by a share of its first version) */
export interface ShareItem { tenantId: string; patientId: string; kind: "visit" | "admission" | "report" | "prescription" | "summary"; id: string; encounterId: string | null; reportChain?: string[]; sensitive?: boolean }
export type ShareRefusal = "expired" | "revoked" | "out-of-scope" | "not-grantee";

export const shareStatusAt = (c: { status: ConsentState; endsAt: Date }, now: Date): ConsentState =>
  c.status === "active" && c.endsAt.getTime() <= now.getTime() ? "expired" : c.status;

export function shareCovers(c: ShareFacts, reader: { tenantId: string; userId: string }, item: ShareItem, linked: LinkedRecord[], now: Date): { ok: true } | { ok: false; reason: ShareRefusal } {
  const st = shareStatusAt(c, now);
  if (st === "revoked") return { ok: false, reason: "revoked" };
  if (st !== "active") return { ok: false, reason: "expired" };
  if (reader.tenantId !== c.granteeTenantId || (c.granteeUserId !== null && reader.userId !== c.granteeUserId)) return { ok: false, reason: "not-grantee" };
  const s = c.scope;
  const inScope = s.kind === "all" ? linked.some((l) => l.tenantId === item.tenantId && l.patientId === item.patientId)
    : item.tenantId === s.tenantId && item.patientId === s.patientId
      && (s.kind === "visit" ? item.encounterId === s.encounterId : item.kind === "report" && (item.reportChain ?? [item.id]).includes(s.reportId));
  if (!inScope) return { ok: false, reason: "out-of-scope" };
  if (c.kinds?.length && !c.kinds.includes(item.kind)) return { ok: false, reason: "out-of-scope" };
  // a sensitive item answers as if it did not exist (never hinted)
  if (c.hideSensitive && item.sensitive) return { ok: false, reason: "out-of-scope" };
  return { ok: true };
}

/** stop sharing: active → revoked; already revoked answers the same (a retried tap); an ended share stays ended */
export function shareRevoke(c: { status: ConsentState; endsAt: Date }, now: Date): { status: ConsentState; changed: boolean; refused?: "ended" } {
  const st = shareStatusAt(c, now);
  if (st === "revoked") return { status: "revoked", changed: false };
  if (st !== "active") return { status: st, changed: false, refused: "ended" };
  return { status: transition("consent", CONSENT, st, "revoke"), changed: true };
}
