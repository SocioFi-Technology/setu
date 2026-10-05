/* The ward round of observations (ADR 0015, walkthrough B6, issue #24): NEWS2 (Royal College of Physicians 2017,
   SpO₂ scale 1) and the escalation rule. A SAMPLE pending clinician sign-off: the threshold, the red-score rule and the
   observation intervals. The API and the vitals screen run the same functions. */
import { toCelsius } from "./vitals.js";

export type Consciousness = "A" | "C" | "V" | "P" | "U";
export const CONSCIOUSNESS: readonly Consciousness[] = ["A", "C", "V", "P", "U"];
/** Stored as an Observation number (0 Alert … 4 Unresponsive) with method "acvpu". */
export const consciousnessCode = (c: Consciousness) => CONSCIOUSNESS.indexOf(c);
export const consciousnessOf = (n: number): Consciousness | null => CONSCIOUSNESS[n] ?? null;

export interface News2Input { rr?: number; spo2?: number; onOxygen?: boolean; sbp?: number; pulse?: number; consciousness?: Consciousness; /** °F, as the vitals screen takes it */ tempF?: number }
export type News2Param = "rr" | "spo2" | "oxygen" | "sbp" | "pulse" | "consciousness" | "temp";
export interface News2Result {
  total: number; parts: Partial<Record<News2Param, number>>; missing: News2Param[]; complete: boolean;
  /** a single parameter scoring 3 */ red: boolean;
  risk: "low" | "low-medium" | "medium" | "high";
}
const band = (v: number, rows: [number, number][]): number => { for (const [upTo, pts] of rows) if (v <= upTo) return pts; return rows[rows.length - 1]![1]; };
export function news2(i: News2Input): News2Result {
  const parts: Partial<Record<News2Param, number>> = {};
  if (i.rr !== undefined) parts.rr = band(i.rr, [[8, 3], [11, 1], [20, 0], [24, 2], [Infinity, 3]]);
  if (i.spo2 !== undefined) parts.spo2 = band(i.spo2, [[91, 3], [93, 2], [95, 1], [Infinity, 0]]);
  parts.oxygen = i.onOxygen ? 2 : 0;
  if (i.sbp !== undefined) parts.sbp = band(i.sbp, [[90, 3], [100, 2], [110, 1], [219, 0], [Infinity, 3]]);
  if (i.pulse !== undefined) parts.pulse = band(i.pulse, [[40, 3], [50, 1], [90, 0], [110, 1], [130, 2], [Infinity, 3]]);
  if (i.consciousness !== undefined) parts.consciousness = i.consciousness === "A" ? 0 : 3;
  if (i.tempF !== undefined) { const c = toCelsius(i.tempF); parts.temp = band(c, [[35.0, 3], [36.0, 1], [38.0, 0], [39.0, 1], [Infinity, 2]]); }
  const all: News2Param[] = ["rr", "spo2", "oxygen", "sbp", "pulse", "consciousness", "temp"];
  const missing = all.filter((p) => parts[p] === undefined);
  const total = Object.values(parts).reduce((a, b) => a + (b ?? 0), 0);
  const red = Object.values(parts).some((p) => p === 3);
  const risk = total >= 7 ? "high" : total >= 5 ? "medium" : red ? "low-medium" : "low";
  return { total, parts, missing, complete: missing.length === 0, red, risk };
}

/** Sample, pending clinician sign-off. */
export const NEWS2_THRESHOLD_SAMPLE = 5;
export const NEWS2_SAMPLE_NOTE = { bn: "ক্লিনিশিয়ানের অনুমোদন বাকি (নমুনা নিয়ম)", en: "Pending clinician sign-off (sample rule)" } as const;
/** Escalate: aggregate at or above the threshold, or a red score. A partial set can only under-score, so it escalates too. */
export const shouldEscalate = (r: Pick<News2Result, "total" | "red">, threshold = NEWS2_THRESHOLD_SAMPLE) => r.total >= threshold || r.red;
/** Minutes to the next observation set: 15 at or above the threshold or on a red score (issue #24); else NEWS2's intervals. */
export function nextObsMinutes(r: Pick<News2Result, "total" | "red">, threshold = NEWS2_THRESHOLD_SAMPLE): number {
  if (shouldEscalate(r, threshold)) return 15;
  return r.total === 0 ? 12 * 60 : 4 * 60;
}
/** A ward respiratory rate outside these is not possible (re-measure) — sample. */
export const RR_POSSIBLE: [number, number] = [1, 80];
export const rrPossible = (rr: number) => Number.isFinite(rr) && rr >= RR_POSSIBLE[0] && rr <= RR_POSSIBLE[1];

/* ───── nursing notes ───── */
export const NOTE_MIN = 3, NOTE_MAX = 4000;
export const noteOk = (text: string) => text.trim().length >= NOTE_MIN && text.length <= NOTE_MAX;
export const ESCALATION_LOG_MIN = 3;
/** Logging the doctor's contact (walkthrough B6: "spoke to" is required, with the instruction). */
export function informBlockers(x: { spokeTo: string; instruction: string }): ("spoke_to" | "instruction")[] {
  const out: ("spoke_to" | "instruction")[] = [];
  if (x.spokeTo.trim().length < ESCALATION_LOG_MIN) out.push("spoke_to");
  if (x.instruction.trim().length < ESCALATION_LOG_MIN) out.push("instruction");
  return out;
}
