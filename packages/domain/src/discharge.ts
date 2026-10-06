/* The discharge checklist (ADR 0017, walkthrough B9). Six steps, each waiting → in-progress → done (DISCHARGE_STEP);
   a step starts when the steps it waits for are done. The header names who is blocking. Until slices B10 (final bill,
   settled against the deposit) and B11 (the discharge summary) exist, steps 2, 4 and 5 are recorded by hand with a PIN
   and say so (Kamrul, decision 8). */
import type { Role } from "./access.js";
import { DISCHARGE_STEP, transition, type DischargeStepState } from "./machines.js";

export type DischargeStepKey = "order" | "summary" | "pharmacy" | "final-bill" | "payment" | "bed-release";
export type StepDepartment = "doctor" | "pharmacy" | "billing" | "ward";
export interface DischargeStepDef { key: DischargeStepKey; waitsFor: DischargeStepKey[]; roles: Role[]; department: StepDepartment; nameBn: string; nameEn: string; byHand: boolean }
export const DISCHARGE_STEPS: readonly DischargeStepDef[] = [
  { key: "order", waitsFor: [], roles: ["doctor"], department: "doctor", nameBn: "ডাক্তারের ছাড়পত্র আদেশ", nameEn: "Doctor discharge order", byHand: false },
  { key: "summary", waitsFor: ["order"], roles: ["doctor"], department: "doctor", nameBn: "ছাড়পত্র সারাংশ", nameEn: "Discharge summary", byHand: true },
  { key: "pharmacy", waitsFor: ["order"], roles: ["pharmacist"], department: "pharmacy", nameBn: "ফার্মেসি ছাড়পত্র", nameEn: "Pharmacy clearance", byHand: false },
  { key: "final-bill", waitsFor: ["pharmacy"], roles: ["cashier", "owner"], department: "billing", nameBn: "চূড়ান্ত বিল", nameEn: "Final bill", byHand: true },
  { key: "payment", waitsFor: ["final-bill"], roles: ["cashier", "owner"], department: "billing", nameBn: "পরিশোধ ও ছাড়পত্র", nameEn: "Payment & clearance", byHand: true },
  { key: "bed-release", waitsFor: ["summary", "payment"], roles: ["nurse"], department: "ward", nameBn: "শয্যা খালি → পরিষ্কার", nameEn: "Bed release to cleaning", byHand: false },
];
export const DISCHARGE_STEP_KEYS = DISCHARGE_STEPS.map((s) => s.key);
export const stepDef = (k: DischargeStepKey) => DISCHARGE_STEPS.find((s) => s.key === k)!;
export const isStepKey = (k: string): k is DischargeStepKey => DISCHARGE_STEP_KEYS.includes(k as DischargeStepKey);
export type StepStates = Record<DischargeStepKey, DischargeStepState>;

/** The step states right after the doctor's order: the order done, the steps waiting only for it in progress. */
export function initialStepStates(): StepStates {
  const s = Object.fromEntries(DISCHARGE_STEP_KEYS.map((k) => [k, "waiting"])) as StepStates;
  s.order = transition("discharge step", DISCHARGE_STEP, transition("discharge step", DISCHARGE_STEP, "waiting", "start"), "finish");
  return startReady(s);
}
/** Start every waiting step whose steps are all done. */
export function startReady(states: StepStates): StepStates {
  const out = { ...states };
  for (const d of DISCHARGE_STEPS) if (out[d.key] === "waiting" && d.waitsFor.every((w) => out[w] === "done")) out[d.key] = transition("discharge step", DISCHARGE_STEP, "waiting", "start");
  return out;
}
/** Finish a step (it must be in progress) and start what it unlocks. */
export function finishStep(states: StepStates, key: DischargeStepKey): StepStates {
  return startReady({ ...states, [key]: transition("discharge step", DISCHARGE_STEP, states[key], "finish") });
}
/** Blocking: a step in progress that a waiting step depends on, when that waiting step's other steps are all done (a step
    still waiting itself is behind the blocker, not one). */
export function blockingSteps(states: StepStates): DischargeStepKey[] {
  const out = new Set<DischargeStepKey>();
  for (const d of DISCHARGE_STEPS) {
    if (states[d.key] !== "waiting") continue;
    const open = d.waitsFor.filter((w) => states[w] !== "done");
    if (open.length === 1 && states[open[0]!] === "in-progress") out.add(open[0]!);
  }
  return DISCHARGE_STEP_KEYS.filter((k) => out.has(k));
}
export const doneCount = (states: StepStates) => DISCHARGE_STEP_KEYS.filter((k) => states[k] === "done").length;
/** Who may complete a step: its owner role; admin any. */
export const canDoStep = (key: DischargeStepKey, role: Role) => role === "admin" || stepDef(key).roles.includes(role);

/* ───── the order ───── */
export const DISCHARGE_ADVICE_MIN = 10;
export const DISCHARGE_TARGET_HOURS = 3;
export const DISCHARGE_CANCEL_REASON_MIN = 10;
export const REMIND_GAP_MIN = 10;
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

/* ───── step checks ───── */
/** Pharmacy clearance (decision 7 — a check, not a credit: the patient is charged per dose drawn): the patient's own
    medicines are handed back (or there were none). */
export type OwnMedicines = "handed-back" | "none";
export function pharmacyClearanceBlockers(x: { ownMedicines: OwnMedicines | null }): "own_medicines"[] {
  return x.ownMedicines ? [] : ["own_medicines"];
}
/** Remind at most once every 10 minutes per step. */
export const canRemind = (lastAt: Date | null, now: Date) => !lastAt || now.getTime() - lastAt.getTime() >= REMIND_GAP_MIN * 60_000;
