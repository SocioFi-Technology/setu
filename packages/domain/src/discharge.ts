/* The discharge checklist (ADR 0017, walkthrough B9; ADR 0018, B10–B12). A discharge is normal, LAMA or a death on the
   ward; each kind has its step graph — a step waits → in-progress → done (DISCHARGE_STEP) and starts when the steps it
   waits for are done. The header names who is blocking. ADR 0018: the summary, final bill and payment steps are done by
   their events (the summary signed, the bill issued, the bill balanced with any excess refund paid) — never by hand; the
   pharmacy's clearance and the patient leaving (or the body moved) are marked done with a PIN. */
import type { Role } from "./access.js";
import { DISCHARGE_STEP, transition, type DischargeStepState } from "./machines.js";
import { dispositionBlockers, type DispositionBlocker } from "./er.js";

export type DischargeKind = "normal" | "lama" | "death";
export const DISCHARGE_KINDS: readonly DischargeKind[] = ["normal", "lama", "death"];
export type DischargeStepKey = "order" | "summary" | "pharmacy" | "final-bill" | "payment" | "bed-release";
export type StepDepartment = "doctor" | "pharmacy" | "billing" | "ward";
export interface DischargeStepDef {
  key: DischargeStepKey; waitsFor: DischargeStepKey[]; roles: Role[]; department: StepDepartment;
  /** done by its event (the order itself, the summary signed, the bill issued / balanced) — no "Mark done" */ byEvent: boolean;
}
const ORDER: DischargeStepDef = { key: "order", waitsFor: [], roles: ["doctor"], department: "doctor", byEvent: true };
const SUMMARY: DischargeStepDef = { key: "summary", waitsFor: ["order"], roles: ["doctor"], department: "doctor", byEvent: true };
const PHARMACY: DischargeStepDef = { key: "pharmacy", waitsFor: ["order"], roles: ["pharmacist"], department: "pharmacy", byEvent: false };
// Kamrul, 2: the bill is issued once the discharge is ordered — the pharmacy gates the patient leaving, not the money
const FINAL_BILL: DischargeStepDef = { key: "final-bill", waitsFor: ["order"], roles: ["cashier", "owner"], department: "billing", byEvent: true };
const PAYMENT: DischargeStepDef = { key: "payment", waitsFor: ["final-bill"], roles: ["cashier", "owner"], department: "billing", byEvent: true };
const LEFT = (waitsFor: DischargeStepKey[]): DischargeStepDef => ({ key: "bed-release", waitsFor, roles: ["nurse"], department: "ward", byEvent: false });
export const STEP_GRAPHS: Record<DischargeKind, readonly DischargeStepDef[]> = {
  normal: [ORDER, SUMMARY, PHARMACY, FINAL_BILL, PAYMENT, LEFT(["summary", "pharmacy", "payment"])],
  // LAMA: the patient leaves once the pharmacy has cleared; the bill and the summary (within 24 h) follow
  lama: [ORDER, SUMMARY, PHARMACY, FINAL_BILL, PAYMENT, LEFT(["pharmacy"])],
  // death: no summary (the death record stands in its place); the body moved needs only the record
  death: [ORDER, FINAL_BILL, PAYMENT, LEFT(["order"])],
};
export const ALL_STEP_KEYS: readonly DischargeStepKey[] = ["order", "summary", "pharmacy", "final-bill", "payment", "bed-release"];
export const stepsOf = (kind: DischargeKind) => STEP_GRAPHS[kind];
export const stepKeysOf = (kind: DischargeKind) => STEP_GRAPHS[kind].map((s) => s.key);
export const stepDef = (kind: DischargeKind, k: DischargeStepKey) => STEP_GRAPHS[kind].find((s) => s.key === k)!;
export const isStepKey = (k: string): k is DischargeStepKey => ALL_STEP_KEYS.includes(k as DischargeStepKey);
export const isDischargeKind = (k: string): k is DischargeKind => DISCHARGE_KINDS.includes(k as DischargeKind);
export type StepStates = Partial<Record<DischargeStepKey, DischargeStepState>>;

/** The step states right after the doctor's record: the order done, the steps waiting only for it in progress. */
export function initialStepStates(kind: DischargeKind): StepStates {
  const s: StepStates = Object.fromEntries(stepKeysOf(kind).map((k) => [k, "waiting"]));
  s.order = transition("discharge step", DISCHARGE_STEP, transition("discharge step", DISCHARGE_STEP, "waiting", "start"), "finish");
  return startReady(kind, s);
}
/** Start every waiting step whose steps are all done. */
export function startReady(kind: DischargeKind, states: StepStates): StepStates {
  const out = { ...states };
  for (const d of stepsOf(kind)) if (out[d.key] === "waiting" && d.waitsFor.every((w) => out[w] === "done")) out[d.key] = transition("discharge step", DISCHARGE_STEP, "waiting", "start");
  return out;
}
/** Finish a step (it must be in progress) and start what it unlocks. */
export function finishStep(kind: DischargeKind, states: StepStates, key: DischargeStepKey): StepStates {
  if (!(key in states)) throw new Error(`discharge (${kind}) has no step ${key}`);
  return startReady(kind, { ...states, [key]: transition("discharge step", DISCHARGE_STEP, states[key]!, "finish") });
}
/** Blocking: a step in progress that a waiting step depends on, when that waiting step's other steps are all done (a step
    still waiting itself is behind the blocker, not one). */
export function blockingSteps(kind: DischargeKind, states: StepStates): DischargeStepKey[] {
  const out = new Set<DischargeStepKey>();
  for (const d of stepsOf(kind)) {
    if (states[d.key] !== "waiting") continue;
    const open = d.waitsFor.filter((w) => states[w] !== "done");
    if (open.length === 1 && states[open[0]!] === "in-progress") out.add(open[0]!);
  }
  return stepKeysOf(kind).filter((k) => out.has(k));
}
export const doneCount = (states: StepStates) => Object.values(states).filter((x) => x === "done").length;
/** Who may complete a step: its owner role; admin any. */
export const canDoStep = (kind: DischargeKind, key: DischargeStepKey, role: Role) => role === "admin" || Boolean(stepDef(kind, key)?.roles.includes(role));
/** "Mark done" (with a PIN) exists only for the steps no event finishes: the pharmacy's clearance, the patient leaving. */
export const markable = (kind: DischargeKind, key: DischargeStepKey) => !stepDef(kind, key).byEvent;
/** The visit finishes when the patient has left (or the body moved) and the bill is issued, whichever comes second. */
export const visitFinishes = (states: StepStates) => states["bed-release"] === "done" && states["final-bill"] === "done";

/* ───── the order ───── */
export const DISCHARGE_ADVICE_MIN = 10;
export const DISCHARGE_TARGET_HOURS = 3;
export const DISCHARGE_CANCEL_REASON_MIN = 10;
export const REMIND_GAP_MIN = 10;
export const LAMA_REASON_MIN = 10;
/** LAMA: the summary is due within 24 hours of the record (flagged on the owner's exceptions until signed). */
export const LAMA_SUMMARY_HOURS = 24;
export type OrderBlocker = "advice" | "target_past" | "target_far";
/** The doctor's order: advice of 10+ characters; the target time from now to 24 hours ahead. */
export function dischargeOrderBlockers(x: { advice: string; targetAt: Date; now: Date }): OrderBlocker[] {
  const b: OrderBlocker[] = [];
  if (x.advice.trim().length < DISCHARGE_ADVICE_MIN) b.push("advice");
  if (x.targetAt.getTime() < x.now.getTime() - 60_000) b.push("target_past");
  else if (x.targetAt.getTime() > x.now.getTime() + 24 * 3600_000) b.push("target_far");
  return b;
}
export const defaultTarget = (now: Date) => new Date(now.getTime() + DISCHARGE_TARGET_HOURS * 3600_000);
export const overdue = (targetAt: Date, now: Date) => now.getTime() > targetAt.getTime();
/** LAMA (Kamrul, decision 14): the reason, risks explained, the LAMA form signed by the patient or guardian, a witness
    (a nurse or doctor of the facility — never the doctor recording it). */
export interface LamaRecord { reason: string; risksExplained: boolean; formSigned: boolean; witnessId: string | null }
export type LamaBlocker = "reason" | "risks" | "form" | "witness" | "witness_self";
export function lamaBlockers(x: LamaRecord, recordedBy: string): LamaBlocker[] {
  const b: LamaBlocker[] = [];
  if (x.reason.trim().length < LAMA_REASON_MIN) b.push("reason");
  if (!x.risksExplained) b.push("risks");
  if (!x.formSigned) b.push("form");
  if (!x.witnessId) b.push("witness");
  else if (x.witnessId === recordedBy) b.push("witness_self");
  return b;
}
/** A death on the ward (decision 15): the ER's checks — time of death (not in the future, not before the admission),
    the cause, the certificate drafted, the family informed, police when medico-legal. */
export interface DeathRecord { timeOfDeath: string; cause: string; medicoLegal: boolean; checks: string[] }
export function deathRecordBlockers(x: DeathRecord, admittedAt: Date, now: Date): DispositionBlocker[] {
  const out = dispositionBlockers({ kind: "death", timeOfDeath: x.timeOfDeath, cause: x.cause, medicoLegal: x.medicoLegal, checks: x.checks });
  const t = x.timeOfDeath ? new Date(x.timeOfDeath) : null;
  if (t && (Number.isNaN(t.getTime()) || t.getTime() > now.getTime() + 60_000 || t.getTime() < admittedAt.getTime())) out.push({ field: "timeOfDeath", code: "out_of_range" });
  return out;
}

/* ───── step checks ───── */
/** Pharmacy clearance (ADR 0017 decision 7 — a check, not a credit): the patient's own medicines are handed back (or there
    were none). */
export type OwnMedicines = "handed-back" | "none";
export function pharmacyClearanceBlockers(x: { ownMedicines: OwnMedicines | null }): "own_medicines"[] {
  return x.ownMedicines ? [] : ["own_medicines"];
}
/** Remind at most once every 10 minutes per step. */
export const canRemind = (lastAt: Date | null, now: Date) => !lastAt || now.getTime() - lastAt.getTime() >= REMIND_GAP_MIN * 60_000;

/* ───── the discharge summary (B11) ───── */
export const SUMMARY_KIND = "discharge-summary";
export const COURSE_MIN = 20;
export interface SummaryProcedure { name: string; date: string; surgeon: string }
export interface SummarySections { course: string; procedures: SummaryProcedure[]; followUp: { date: string | null; place: string }; redFlags: string[] }
export const emptySummarySections = (): SummarySections => ({ course: "", procedures: [], followUp: { date: null, place: "" }, redFlags: [] });
/** Sample red flags (pending clinician sign-off): ticked onto the summary's advice, free text beside them. */
export const RED_FLAGS_SAMPLE = [
  { key: "fever", bn: "জ্বর ১০০.৪°F (৩৮°C) এর বেশি", en: "Fever above 100.4°F (38°C)" },
  { key: "bleeding", bn: "ক্ষত থেকে রক্তপাত বা পুঁজ", en: "Bleeding or pus from the wound" },
  { key: "pain", bn: "ব্যথা বাড়ছে, ওষুধে কমছে না", en: "Pain getting worse despite the medicines" },
  { key: "breath", bn: "শ্বাসকষ্ট বা বুকে ব্যথা", en: "Breathlessness or chest pain" },
  { key: "vomit", bn: "বারবার বমি, কিছু খেতে না পারা", en: "Repeated vomiting, unable to eat or drink" },
  { key: "urine", bn: "প্রস্রাব কমে যাওয়া বা বন্ধ", en: "Passing little or no urine" },
] as const;
export type SummaryBlocker = "diagnosis_final" | "course" | "follow_up" | "red_flags" | "critical_unacked" | "escalation_open" | "rx_warnings";
/** What stops "Sign summary" (Kamrul, 12: also a critical lab result unacknowledged by the doctor, or an open escalation). */
export function summarySignBlockers(x: {
  sections: SummarySections; finalDiagnoses: number; today: string;
  criticalUnacked: number; openEscalations: number; rxBlocking: number;
}): SummaryBlocker[] {
  const b: SummaryBlocker[] = [];
  if (x.finalDiagnoses < 1) b.push("diagnosis_final");
  if (x.sections.course.trim().length < COURSE_MIN) b.push("course");
  if (!x.sections.followUp.date || x.sections.followUp.date < x.today) b.push("follow_up");
  if (!x.sections.redFlags.some((r) => r.trim().length > 0)) b.push("red_flags");
  if (x.criticalUnacked > 0) b.push("critical_unacked");
  if (x.openEscalations > 0) b.push("escalation_open");
  if (x.rxBlocking > 0) b.push("rx_warnings");
  return b;
}

/** Kamrul (07/10/2026, on 304): the take-home medicines wait on the pharmacy's queue this many days after the summary
    is signed; after that a line not (fully) given is "not collected" on the summary — shown to the doctor, never
    silently dropped. */
export const TAKE_HOME_DAYS = 3;
export type TakeHomeStatus = "waiting" | "partial" | "dispensed" | "declined" | "not-collected";
export function takeHomeStatus(x: { prescribed: number; given: number; declined: boolean; signedAt: Date; now: Date }): TakeHomeStatus {
  if (x.declined) return "declined";
  if (x.given >= x.prescribed) return "dispensed";
  if (x.now.getTime() - x.signedAt.getTime() >= TAKE_HOME_DAYS * 864e5) return "not-collected";
  return x.given > 0 ? "partial" : "waiting";
}
