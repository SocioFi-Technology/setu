/* ADR 0023 (E4) — what another clinic sees of a patient's history from the Setu network.
   By policy (no request; never when the person turned network sharing off): active allergies, current medicines,
   active problems, blood group. Sensitive categories (mental health, sexual and reproductive health, HIV) are never
   shown — not by policy, not by consent in this slice — and never hinted: they are dropped before anything is counted.
   The sensitive list is a SAMPLE (Kamrul 10/10/2026): a clinician's tagging rules replace it (gap 12). */

export interface SensitiveRule { prefix: string; category: "mental-health" | "sexual-reproductive" | "hiv"; sample: true }
const S = (prefix: string, category: SensitiveRule["category"]): SensitiveRule => ({ prefix, category, sample: true });
/** ICD-11 code prefixes (sample): chapter 06 mental and behavioural; HIV disease 1C60–1C62; infections predominantly
    sexually transmitted 1A60–1A9Z; chapter 17 conditions related to sexual health (HA); pregnancy with abortive outcome
    (JA00–JA05) */
export const SENSITIVE_CONDITIONS_SAMPLE: SensitiveRule[] = [
  S("6A", "mental-health"), S("6B", "mental-health"), S("6C", "mental-health"), S("6D", "mental-health"), S("6E", "mental-health"),
  S("1C6", "hiv"),
  S("1A6", "sexual-reproductive"), S("1A7", "sexual-reproductive"), S("1A8", "sexual-reproductive"), S("1A9", "sexual-reproductive"),
  S("HA", "sexual-reproductive"), S("JA0", "sexual-reproductive"),
];
/** medicine classes that reveal a sensitive condition (sample) */
export const SENSITIVE_MEDICINE_CLASSES_SAMPLE = ["antiretroviral", "antipsychotic", "antidepressant", "mood-stabiliser", "anxiolytic"];

export const isSensitiveCondition = (code: string, rules: SensitiveRule[] = SENSITIVE_CONDITIONS_SAMPLE) => {
  const c = code.trim().toUpperCase();
  return rules.some((r) => c.startsWith(r.prefix));
};
export const isSensitiveMedicine = (classes: readonly string[], list: readonly string[] = SENSITIVE_MEDICINE_CLASSES_SAMPLE) => classes.some((x) => list.includes(x));

/** a prescription line still being taken: an outpatient line within its days from the signing; an inpatient order active */
export function isCurrentMedicine(m: { kind: string; days: number; orderStatus: string; signedAt: Date | null }, now: Date): boolean {
  if (m.kind === "inpatient") return m.orderStatus === "active";
  if (!m.signedAt) return false;
  return m.signedAt.getTime() + Math.max(1, m.days) * 864e5 > now.getTime();
}
export const ACTIVE_PROBLEM_DAYS = 180;
/** a diagnosis of a signed note in the last 180 days (no resolved flag exists yet: recent = active) */
export const isActiveProblem = (signedAt: Date | null, now: Date) => !!signedAt && now.getTime() - signedAt.getTime() <= ACTIVE_PROBLEM_DAYS * 864e5;

/** the newest per code (a problem or a medicine named at several visits shows once) */
export function newestPerKey<T>(rows: T[], key: (t: T) => string, at: (t: T) => Date): T[] {
  const best = new Map<string, T>();
  for (const r of rows) { const k = key(r); const b = best.get(k); if (!b || at(r) > at(b)) best.set(k, r); }
  return [...best.values()].sort((a, b) => at(b).getTime() - at(a).getTime());
}

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];
export const isBloodGroup = (s: string): s is BloodGroup => (BLOOD_GROUPS as readonly string[]).includes(s);

/* ── access requests (by consent) ── */
export const ACCESS_KINDS = ["reports", "summaries", "prescriptions", "visits"] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];
export const ACCESS_PERIODS = { "24h": 24, "30d": 30 * 24 } as const;
export type AccessPeriod = keyof typeof ACCESS_PERIODS;
export const ACCESS_REASON_MIN = 10;
export type AccessProblem = "kinds" | "period" | "reason";
export function accessRequestProblems(r: { kinds: string[]; period: string; reason: string }): AccessProblem[] {
  const out: AccessProblem[] = [];
  if (!r.kinds.length || r.kinds.some((k) => !(ACCESS_KINDS as readonly string[]).includes(k)) || new Set(r.kinds).size !== r.kinds.length) out.push("kinds");
  if (!Object.prototype.hasOwnProperty.call(ACCESS_PERIODS, r.period)) out.push("period");
  if (r.reason.trim().length < ACCESS_REASON_MIN) out.push("reason");
  return out;
}
/** which history item kinds an access request's kinds open */
export const KINDS_OPEN: Record<AccessKind, ("report" | "summary" | "prescription" | "visit" | "admission")[]> = {
  reports: ["report"], summaries: ["summary"], prescriptions: ["prescription"], visits: ["visit", "admission"],
};
export const itemKindsFor = (kinds: AccessKind[]) => [...new Set(kinds.flatMap((k) => KINDS_OPEN[k]))];

export type AccessRequestState = "sent" | "granted" | "denied" | "expired";
/** the patient's answer to a request still waiting (ADR 0023: sent → granted | denied; a request unanswered for 7 days expires) */
export const ACCESS_REQUEST_WAIT_DAYS = 7;
export function answerRequest(state: AccessRequestState, createdAt: Date, answer: "approve" | "deny", now: Date): { state: AccessRequestState; refused?: "answered" | "expired" } {
  if (state !== "sent") return { state, refused: "answered" };
  if (now.getTime() - createdAt.getTime() > ACCESS_REQUEST_WAIT_DAYS * 864e5) return { state: "expired", refused: "expired" };
  return { state: answer === "approve" ? "granted" : "denied" };
}
