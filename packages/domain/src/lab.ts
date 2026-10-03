/* Lab rules (slice A8–A11, ADR 0006). The screens and the API call the same functions. Everything clinical here — tubes,
   analytes, reference ranges, critical thresholds and the delta rule — is the prototype's SAMPLE (Setu Lab.dc.html),
   labelled "pending clinician sign-off" (decision D1, pre-pilot list); it is not a laboratory's validated method sheet.
   Analyte names stay in English in both languages, as on Bangladeshi lab reports (like test names, open question 55). */
import { toEn } from "./format.js";
import { ORDER, can, type OrderState, type ResultState, type SpecimenState } from "./machines.js";

/* ───── tubes (A8) ───── */
export const TUBE_KINDS = ["edta", "fluoride", "plain", "urine"] as const;
export type TubeKind = (typeof TUBE_KINDS)[number];
/** Cap colour and draw volume per tube (prototype tube guidance). The screen names them through i18n `labApp.tube_*`. */
export const TUBES: Record<TubeKind, { colour: "purple" | "grey" | "red" | "none"; volumeMl: number }> = {
  edta: { colour: "purple", volumeMl: 3 }, fluoride: { colour: "grey", volumeMl: 2 }, plain: { colour: "red", volumeMl: 5 }, urine: { colour: "none", volumeMl: 20 },
};
const TEST_TUBE_SAMPLE: Record<string, TubeKind> = {
  cbc: "edta", hba1c: "edta", rbs: "fluoride", lipid: "plain", creat: "plain", elec: "plain", tsh: "plain", sgpt: "plain", ure: "urine", urinecs: "urine",
};
/** The tube a lab test is collected in, or null (imaging, ECG, … — not a lab specimen). */
export const tubeFor = (testCode: string): TubeKind | null => TEST_TUBE_SAMPLE[testCode] ?? null;

/** Reasons a tube is rejected (prototype accession list) + "other" with a note. */
export const REJECT_REASONS = ["haemolysed", "clotted", "insufficient", "label-mismatch", "wrong-container", "other"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
export const REJECT_NOTE_MIN = 10;
/** The reason recorded on a tube rejected because its test's results were withdrawn (not offered on the reject form). */
export const WITHDRAWN_REASON = "results-withdrawn";
export function rejectCheck(i: { reason: RejectReason; note?: string | null }): ("reason_invalid" | "note_required")[] {
  if (!(REJECT_REASONS as readonly string[]).includes(i.reason)) return ["reason_invalid"];
  if (i.reason === "other" && (i.note ?? "").trim().length < REJECT_NOTE_MIN) return ["note_required"];
  return [];
}

export interface PlanOrder { id: string; testCode: string; status: OrderState; /** current (not entered-in-error) results exist */ hasResults?: boolean }
export interface PlanSpecimen { id: string; tube: TubeKind; status: SpecimenState; orderIds: string[] }
export interface TubeNeed { tube: TubeKind; orderIds: string[]; /** a printed label (pending tube) for exactly these tests */ specimenId: string | null; recollect: boolean }
export type CollectionStatus = "none" | "pending" | "partial" | "collected" | "rejected";
const PRE_COLLECT: OrderState[] = ["active", "accepted", "partially-accepted"];
const LIVE: SpecimenState[] = ["collected", "received", "in-process", "done"];

/** Which tubes a visit still needs. An order needs a tube while it is placed but not collected, or when every tube it
    was collected in was rejected and it has no current results (recollect — also after its results were withdrawn).
    Tests sharing a tube kind share one tube. */
export function tubePlan(orders: PlanOrder[], specimens: PlanSpecimen[]): { tubes: TubeNeed[]; status: CollectionStatus } {
  const live = specimens.filter((s) => LIVE.includes(s.status));
  const covered = new Set(live.flatMap((s) => s.orderIds));
  const needs = new Map<TubeKind, { orderIds: string[]; recollect: boolean }>();
  for (const o of orders) {
    const tube = tubeFor(o.testCode);
    if (!tube || covered.has(o.id) || o.hasResults) continue;
    const recollect = !PRE_COLLECT.includes(o.status);
    if (recollect && !["in-progress", "partially-complete", "complete"].includes(o.status)) continue; // revoked, declined, draft
    const n = needs.get(tube) ?? { orderIds: [], recollect: false };
    n.orderIds.push(o.id);
    n.recollect ||= recollect;
    needs.set(tube, n);
  }
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const tubes = [...needs.entries()].map(([tube, n]): TubeNeed => ({
    tube, orderIds: n.orderIds, recollect: n.recollect,
    specimenId: specimens.find((s) => s.status === "pending" && s.tube === tube && sameSet(s.orderIds, n.orderIds))?.id ?? null,
  }));
  const status: CollectionStatus = !tubes.length ? (live.length ? "collected" : "none") : live.length ? "partial" : tubes.some((t) => t.recollect) ? "rejected" : "pending";
  return { tubes, status };
}

export const specimenNumber = (yymm: string, n: number) => `S-${yymm}-${String(n).padStart(4, "0")}`;
export const labReportNumber = (yy: string, n: number) => `LR/${yy}/${String(n).padStart(4, "0")}`;

/* ───── analytes, ranges, flags (A9, decision D1) ───── */
export interface AnalyteDef {
  code: string; testCode: string; nameEn: string; nameBn: string; unit: string; decimals: number;
  /** critical thresholds (strict: below critLow → LL, above critHigh → HH); adult values, applied at every age */
  critLow: number | null; critHigh: number | null;
  /** the delta check runs for this analyte (the prototype leaves WBC out) */
  deltaCheck: boolean; position: number; sample: true;
}
const A = (code: string, testCode: string, nameEn: string, unit: string, decimals: number, critLow: number | null, critHigh: number | null, position: number, deltaCheck = true): AnalyteDef =>
  ({ code, testCode, nameEn, nameBn: nameEn, unit, decimals, critLow, critHigh, deltaCheck, position, sample: true });
export const ANALYTES_SAMPLE: AnalyteDef[] = [
  A("hb", "cbc", "Haemoglobin", "g/dL", 1, 7, null, 1),
  A("wbc", "cbc", "Total WBC", "/cumm", 0, null, 30000, 2, false),
  A("plt", "cbc", "Platelets", "/cumm", 0, 50000, null, 3),
  A("rbs", "rbs", "Random blood sugar (RBS)", "mmol/L", 1, 2.8, 25, 1),
  A("na", "elec", "S. Sodium", "mmol/L", 0, 120, 160, 1),
  A("k", "elec", "S. Potassium", "mmol/L", 1, 2.8, 6.2, 2),
  A("cl", "elec", "S. Chloride", "mmol/L", 0, 80, 120, 3),
  A("hba1c", "hba1c", "HbA1c", "%", 1, null, null, 1),
  A("creat", "creat", "S. Creatinine", "mg/dL", 2, null, 4, 1),
];
/** The analytes entered for a test, in report order; empty = no result template in the sample list (cannot be entered). */
export const analytesOf = (testCode: string, list: AnalyteDef[] = ANALYTES_SAMPLE) => list.filter((a) => a.testCode === testCode).sort((a, b) => a.position - b.position);

export const ADULT_YEARS = 18;
export type RangeLabel = "adult" | "adult-female" | "adult-male";
export interface RangeDef { analyteCode: string; sex: "female" | "male" | null; ageMinYears: number; ageMaxYears: number | null; low: number; high: number; label: RangeLabel; sample: true }
const R = (analyteCode: string, low: number, high: number, sex: "female" | "male" | null = null): RangeDef =>
  ({ analyteCode, sex, ageMinYears: ADULT_YEARS, ageMaxYears: null, low, high, label: sex ? `adult-${sex}` : "adult", sample: true });
/** The prototype shows one range per analyte, for its 42-year-old woman. Ranges that differ by sex (Hb, creatinine) are
    seeded for adult women only; men get "no reference range in the sample list" until a clinician adds theirs. */
export const RANGES_SAMPLE: RangeDef[] = [
  R("hb", 12.0, 15.5, "female"), R("wbc", 4000, 11000), R("plt", 150000, 450000), R("rbs", 3.9, 7.8),
  R("na", 135, 145), R("k", 3.5, 5.1), R("cl", 98, 107), R("hba1c", 4.0, 5.6), R("creat", 0.5, 1.1, "female"),
];

/** Age in whole years at `at`, from a date of birth or an approximate age recorded at `approxAgeAt`; null if unknown. */
export function patientAgeYears(p: { birthDate: string | null; approxAgeYears: number | null; approxAgeAt: string | null }, at: Date): number | null {
  const Y = 365.25 * 864e5;
  if (p.birthDate) {
    const [y, m, d] = p.birthDate.split("-").map(Number) as [number, number, number];
    let a = at.getUTCFullYear() - y;
    if (at.getUTCMonth() + 1 < m || (at.getUTCMonth() + 1 === m && at.getUTCDate() < d)) a--;
    return a;
  }
  if (p.approxAgeYears == null) return null;
  const since = p.approxAgeAt ? at.getTime() - Date.parse(p.approxAgeAt) : 0;
  return Math.floor(p.approxAgeYears + Math.max(0, since) / Y);
}

/** The range that applies to this patient, or null (no range in the sample list: unknown age, under 18, other sex). */
export function rangeFor(ranges: RangeDef[], analyteCode: string, p: { sex: "female" | "male" | "other"; ageYears: number | null }): RangeDef | null {
  if (p.ageYears == null) return null;
  return ranges.find((r) => r.analyteCode === analyteCode && (r.sex === null || r.sex === p.sex) && p.ageYears! >= r.ageMinYears && (r.ageMaxYears === null || p.ageYears! <= r.ageMaxYears)) ?? null;
}

export type LabFlag = "N" | "H" | "L" | "HH" | "LL";
/** HH/LL from the critical thresholds (any age); H/L/N only when a range applies; null = no range, not critical. */
export function labFlag(value: number, range: { low: number; high: number } | null, crit: { critLow: number | null; critHigh: number | null }): LabFlag | null {
  if (crit.critLow !== null && value < crit.critLow) return "LL";
  if (crit.critHigh !== null && value > crit.critHigh) return "HH";
  if (!range) return null;
  if (value < range.low) return "L";
  if (value > range.high) return "H";
  return "N";
}
export const isCritical = (f: LabFlag | null | undefined): boolean => f === "HH" || f === "LL";

/* ───── result entry (decision D2) ───── */
export type ValueCode = "required" | "not_a_number" | "negative";
/** Digits with at most one decimal point (Bangla digits read as Latin). No commas, signs or units: impossible-value
    limits are for a clinician to set (pre-pilot), so only non-numbers and negatives are refused. */
export function parseLabValue(raw: string | number): { ok: true; value: number } | { ok: false; code: ValueCode } {
  const s = toEn(String(raw)).trim();
  if (!s) return { ok: false, code: "required" };
  if (/^-\s*\d/.test(s)) return { ok: false, code: "negative" };
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return { ok: false, code: "not_a_number" };
  const value = Number(s);
  return Number.isFinite(value) ? { ok: true, value } : { ok: false, code: "not_a_number" };
}

export interface EntryInput { analyteCode: string; raw: string; /** the critical value typed a second time */ confirm?: string | null }
export type EntryErrorCode = ValueCode | "unknown_analyte" | "duplicate" | "confirm_required" | "confirm_mismatch";
export interface EntryValue { analyteCode: string; value: number; flag: LabFlag | null }
/** "Send for verification" for one test: every analyte needs a valid value; a critical one must be typed twice. */
export function resultEntryCheck(analytes: AnalyteDef[], entries: EntryInput[], rangeOf: (analyteCode: string) => { low: number; high: number } | null): { errors: { field: string; code: EntryErrorCode }[]; values: EntryValue[] } {
  const errors: { field: string; code: EntryErrorCode }[] = [];
  const values: EntryValue[] = [];
  const seen = new Set<string>();
  const known = new Map(analytes.map((a) => [a.code, a]));
  for (const e of entries) {
    if (seen.has(e.analyteCode)) { errors.push({ field: e.analyteCode, code: "duplicate" }); continue; }
    seen.add(e.analyteCode);
    if (!known.has(e.analyteCode)) errors.push({ field: e.analyteCode, code: "unknown_analyte" });
  }
  for (const a of analytes) {
    const e = entries.find((x) => x.analyteCode === a.code);
    const v = e ? parseLabValue(e.raw) : ({ ok: false, code: "required" } as const);
    if (!v.ok) { errors.push({ field: a.code, code: v.code }); continue; }
    const flag = labFlag(v.value, rangeOf(a.code), a);
    if (isCritical(flag)) {
      const c = e?.confirm == null || String(e.confirm).trim() === "" ? null : parseLabValue(e.confirm);
      if (!c) { errors.push({ field: a.code, code: "confirm_required" }); continue; }
      if (!c.ok || c.value !== v.value) { errors.push({ field: a.code, code: "confirm_mismatch" }); continue; }
    }
    values.push({ analyteCode: a.code, value: v.value, flag });
  }
  const order = (f: string) => { const i = analytes.findIndex((a) => a.code === f); return i < 0 ? 999 : i; };
  errors.sort((x, y) => (x.code === "duplicate" || x.code === "unknown_analyte" ? 0 : 1) - (y.code === "duplicate" || y.code === "unknown_analyte" ? 0 : 1) || order(x.field) - order(y.field));
  return { errors, values };
}

/** Change against the patient's previous validated result (sample rule: more than 20% warns; pending sign-off). */
export const DELTA_LIMIT_PCT = 20;
export function deltaOf(value: number, prev: number | null | undefined, a: { deltaCheck: boolean }): { pct: number; hit: boolean } | null {
  if (!a.deltaCheck || prev == null || prev === 0) return null;
  const raw = ((value - prev) / prev) * 100;
  return { pct: Math.round(raw), hit: Math.abs(raw) > DELTA_LIMIT_PCT };
}

/* ───── roles, verify, call-back, validate (A10) ───── */
export const LAB_ROLES = {
  collect: ["labTech"], enter: ["labTech"], correct: ["labTech"], verify: ["labTech", "pathologist"], validate: ["pathologist"], return: ["pathologist"], withdraw: ["labTech", "pathologist"],
  callback: ["labTech", "pathologist"], release: ["labTech", "pathologist"], deliver: ["labTech", "admin"],
} as const satisfies Record<string, readonly string[]>;
export const labRoleCan = (action: keyof typeof LAB_ROLES, role: string) => (LAB_ROLES[action] as readonly string[]).includes(role);

/** May one person both verify and validate the same result? Facility setting, else by plan (Clinic yes, Hospital no). */
export const samePersonAllowed = (plan: "clinic" | "lite" | "pro", setting: boolean | null | undefined): boolean => setting ?? plan === "clinic";

export interface ResultFact { id: string; status: ResultState; flag: LabFlag | null; verifiedById: string | null; deltaHit: boolean }
export type VerifyBlocker = { code: "role" | "nothing_to_verify" } | { code: "not_preliminary" | "delta_unchecked"; observationId: string };
export function verifyBlockers(i: { role: string; results: ResultFact[]; deltaChecked: boolean }): VerifyBlocker[] {
  if (!labRoleCan("verify", i.role)) return [{ code: "role" }];
  if (!i.results.length) return [{ code: "nothing_to_verify" }];
  const out: VerifyBlocker[] = [];
  for (const r of i.results) {
    if (r.status !== "preliminary") out.push({ code: "not_preliminary", observationId: r.id });
    else if (r.deltaHit && !i.deltaChecked) out.push({ code: "delta_unchecked", observationId: r.id });
  }
  return out;
}

export interface CallbackFact { observationId: string; outcome: "reached" | "no-answer"; readBack: boolean }
export type ValidateBlocker = { code: "role" | "nothing_to_validate" } | { code: "not_verified" | "same_person" | "callback_missing"; observationId: string };
/** Clinical validation: a pathologist, only verified results, not the verifier (unless allowed), and every HH/LL result
    needs a call-back that reached someone with the value read back — logged for that exact result. */
export function validateBlockers(i: { role: string; userId: string; samePersonAllowed: boolean; results: ResultFact[]; callbacks: CallbackFact[] }): ValidateBlocker[] {
  if (!labRoleCan("validate", i.role)) return [{ code: "role" }];
  if (!i.results.length) return [{ code: "nothing_to_validate" }];
  const out: ValidateBlocker[] = [];
  for (const r of i.results) {
    if (r.status !== "verified") { out.push({ code: "not_verified", observationId: r.id }); continue; }
    if (!i.samePersonAllowed && r.verifiedById === i.userId) out.push({ code: "same_person", observationId: r.id });
    if (isCritical(r.flag) && !i.callbacks.some((c) => c.observationId === r.id && c.outcome === "reached" && c.readBack))
      out.push({ code: "callback_missing", observationId: r.id });
  }
  return out;
}

export const CALLBACK_RECIPIENTS = ["ordering-doctor", "duty-doctor", "patient"] as const;
export type CallbackRecipient = (typeof CALLBACK_RECIPIENTS)[number];
export const CALLBACK_VIA = ["phone", "app", "in-person"] as const;
export type CallbackVia = (typeof CALLBACK_VIA)[number];
export type CallbackCode = "recipient_role_invalid" | "via_invalid" | "name_required" | "time_future" | "time_before_result" | "read_back_required" | "read_back_without_answer";
/** How far ahead of the server clock a typed call time may be (device clocks drift). */
export const CALLBACK_CLOCK_SLACK_MS = 5 * 60_000;
export function callbackCheck(i: { outcome: "reached" | "no-answer"; recipientRole: CallbackRecipient; recipientName: string; at: Date; via: CallbackVia; readBack: boolean; now: Date; enteredAt: Date }): CallbackCode[] {
  const out: CallbackCode[] = [];
  if (!(CALLBACK_RECIPIENTS as readonly string[]).includes(i.recipientRole)) out.push("recipient_role_invalid");
  if (!(CALLBACK_VIA as readonly string[]).includes(i.via)) out.push("via_invalid");
  if (i.recipientName.trim().length < 2) out.push("name_required");
  if (i.at.getTime() > i.now.getTime() + CALLBACK_CLOCK_SLACK_MS) out.push("time_future");
  else if (i.at.getTime() < i.enteredAt.getTime() - 60_000) out.push("time_before_result");
  if (i.outcome === "reached" && !i.readBack) out.push("read_back_required");
  if (i.outcome === "no-answer" && i.readBack) out.push("read_back_without_answer");
  return out;
}

/* ───── corrections (decision D4) ───── */
export const CORRECTION_REASON_MIN = 10;
export function correctionCheck(i: { status: ResultState; oldValue: number; newValue: number; reason: string }): ("not_current" | "reason_required" | "same_value")[] {
  if (!["preliminary", "verified", "final", "amended"].includes(i.status)) return ["not_current"];
  const out: ("reason_required" | "same_value")[] = [];
  if (i.reason.trim().length < CORRECTION_REASON_MIN) out.push("reason_required");
  if (i.newValue === i.oldValue) out.push("same_value");
  return out;
}

/* ───── send-back and withdrawal (decisions 119, 133; ADR 0006 addendum) ───── */
export const RETURN_REASON_MIN = 10, WITHDRAW_REASON_MIN = 10;
/** The pathologist returns a verified test: every current result of it verified, a reason of 10+ characters. */
export function returnBlockers(i: { role: string; results: { status: ResultState }[]; reason: string }): ("role" | "not_verified" | "reason_required")[] {
  if (i.role !== "pathologist") return ["role"];
  const out: ("not_verified" | "reason_required")[] = [];
  const cur = i.results.filter((r) => r.status !== "entered-in-error");
  if (!cur.length || cur.some((r) => r.status !== "verified")) out.push("not_verified");
  if (i.reason.trim().length < RETURN_REASON_MIN) out.push("reason_required");
  return out;
}
/** Withdraw a test's results (no replacement value): lab technologist or pathologist, a reason, current results exist. */
export function withdrawBlockers(i: { role: string; results: { status: ResultState }[]; reason: string }): ("role" | "nothing_to_withdraw" | "reason_required")[] {
  if (i.role !== "labTech" && i.role !== "pathologist") return ["role"];
  const out: ("nothing_to_withdraw" | "reason_required")[] = [];
  if (!i.results.some((r) => r.status !== "entered-in-error" && r.status !== "registered")) out.push("nothing_to_withdraw");
  if (i.reason.trim().length < WITHDRAW_REASON_MIN) out.push("reason_required");
  return out;
}

/* ───── release (decision D3) ───── */
export interface ReleaseTest { orderId: string; revoked: boolean; analyteCount: number; results: { id: string; status: ResultState; replacesId: string | null }[] }
export type ReleaseStatus = "preliminary" | "final" | "corrected";
/** What a release would contain: every test whose current results are all validated. `lastReleased` = the observations
    in the current version; `everReleased` = every observation any version released. */
export function releasePlan(i: { tests: ReleaseTest[]; lastReleased: string[]; everReleased: string[] }): {
  orderIds: string[]; observationIds: string[]; pending: number; total: number; status: ReleaseStatus; blockers: ("nothing_validated" | "nothing_new")[];
} {
  const tests = i.tests.filter((t) => !t.revoked);
  const ready = tests.filter((t) => {
    const cur = t.results.filter((r) => r.status !== "entered-in-error");
    return t.analyteCount > 0 && cur.length === t.analyteCount && cur.every((r) => r.status === "final");
  });
  const observationIds = ready.flatMap((t) => t.results.filter((r) => r.status === "final").map((r) => r.id));
  const ever = new Set(i.everReleased);
  // ADR 0006 addendum: once a released result was corrected or withdrawn, every later version is "corrected".
  const changedAfterRelease = i.tests.some((t) => t.results.some((r) => r.status === "entered-in-error" && ever.has(r.id)));
  const pending = tests.length - ready.length;
  const status: ReleaseStatus = changedAfterRelease ? "corrected" : pending > 0 ? "preliminary" : "final";
  const last = new Set(i.lastReleased);
  const blockers: ("nothing_validated" | "nothing_new")[] = !observationIds.length ? ["nothing_validated"]
    : observationIds.length === last.size && observationIds.every((x) => last.has(x)) ? ["nothing_new"] : [];
  return { orderIds: ready.map((t) => t.orderId), observationIds, pending, total: tests.length, status, blockers };
}

/* ───── order cancellation (decision D5) ───── */
export const REVOKE_REASON_MIN = 10;
export type RevokeBlocker = "role" | "not_ordering_doctor" | "reason_required" | "collected" | "already_revoked" | "not_placed" | "not_cancellable";
export function revokeBlockers(i: { orderStatus: OrderState; role: string; userId: string; orderedById: string; reason: string }): RevokeBlocker[] {
  const out: RevokeBlocker[] = [];
  if (i.role === "doctor") { if (i.userId !== i.orderedById) out.push("not_ordering_doctor"); }
  else if (i.role !== "labTech" && i.role !== "pathologist") out.push("role");
  if (i.reason.trim().length < REVOKE_REASON_MIN) out.push("reason_required");
  if (!can(ORDER, i.orderStatus, "revoke"))
    out.push(i.orderStatus === "revoked" ? "already_revoked" : i.orderStatus === "draft" ? "not_placed" : ["in-progress", "partially-complete", "complete"].includes(i.orderStatus) ? "collected" : "not_cancellable");
  return out;
}

/* ───── messages ───── */
/** i18n keys (labApp) of the SMS templates. Only `{facility}` may be filled in: never a value, a test, a diagnosis or a
    name (CLAUDE.md rule; checked by a test against the real strings). */
export const SMS_TEMPLATES = { "report-ready": "sms_report_ready", recollect: "sms_recollect" } as const;
export const smsPlaceholdersOk = (template: string) => [...template.matchAll(/\{(\w+)\}/g)].every((m) => m[1] === "facility");
