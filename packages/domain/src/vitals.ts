/* Vital-sign rules (walkthrough A4). Pure functions shared by the vitals screen (warnings as you type) and the API (which
   refuses a batch with any impossible value). Limits are the prototype's (docs/prototype/Setu Front Desk.dc.html,
   screen "Vitals (tablet)"); the few it does not state are marked and listed in docs/open-questions.md (A4–A5).
   Abnormal values never block the save: they are stored with their interpretation and shown to the doctor flagged. */
import { toEn } from "./format.js";

export type VitalField = "bp" | "pulse" | "temp" | "spo2" | "rbs" | "weight" | "height";
export const VITAL_FIELDS: VitalField[] = ["bp", "pulse", "temp", "spo2", "rbs", "weight", "height"];
export type RbsMode = "random" | "fasting";
/** Numbers as entered (already parsed); null/undefined = not measured. NaN = typed but not a number. */
export interface VitalsInput {
  bpSys?: number | null; bpDia?: number | null; pulse?: number | null; temp?: number | null; spo2?: number | null;
  rbs?: number | null; rbsMode?: RbsMode; weight?: number | null; height?: number | null;
}
export type VitalLevel = "impossible" | "critical" | "high" | "low" | "normal";
/** FHIR Observation.interpretation codes used in Setu: normal, high, low, critical high, critical low. */
export type Interpretation = "N" | "H" | "L" | "HH" | "LL";
/** `confirm`: a value that is possible but often a unit mistake (e.g. glucose typed in mg/dL); it is saved only after
    the person entering it ticks that they re-checked it (the API requires the same). */
export interface VitalAssessment { field: VitalField; level: VitalLevel; interpretation: Interpretation | null; code: string; confirm?: boolean }
export type BmiClass = "underweight" | "normal" | "overweight" | "obese";

export const UNITS: Record<VitalField, string> = { bp: "mmHg", pulse: "/min", temp: "[degF]", spo2: "%", rbs: "mmol/L", weight: "kg", height: "cm" };

/** Systolic and diastolic each get their own flag (clinical review: 150/80 must not store the 80 as High). */
export function bpComponents(sys: number, dia: number): { sys: Interpretation; dia: Interpretation } {
  return {
    sys: sys >= 180 ? "HH" : sys >= 140 ? "H" : sys < 90 ? "L" : "N",
    dia: dia >= 120 ? "HH" : dia >= 90 ? "H" : "N",
  };
}

/** Typed text → number: Bangla or Latin digits, one decimal point. "" → null; anything else → NaN. */
export function parseVital(raw: string | null | undefined): number | null {
  const s = toEn(raw ?? "").trim();
  if (!s) return null;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN;
}

const given = (n: number | null | undefined): n is number => n !== null && n !== undefined;
const bad = (n: number) => !Number.isFinite(n);
const A = (field: VitalField, level: VitalLevel, code: string, interpretation: Interpretation | null = null): VitalAssessment =>
  ({ field, level, code, interpretation: level === "impossible" ? null : interpretation ?? (level === "normal" ? "N" : null) });

function bp(sys: number | null | undefined, dia: number | null | undefined): VitalAssessment | null {
  if (!given(sys) && !given(dia)) return null;
  if (!given(sys) || !given(dia)) return A("bp", "impossible", "bp_incomplete");
  if (bad(sys) || bad(dia)) return A("bp", "impossible", "not_a_number");
  // Diastolic < 20 is not in the prototype; added as impossible (open question 37). The low end says "if confirmed,
  // tell the doctor now" (clinical review: a real reading in shock must not just be "re-measure").
  if (sys > 300 || dia > 200 || dia >= sys) return A("bp", "impossible", "bp_impossible");
  if (sys < 40 || dia < 20) return A("bp", "impossible", "bp_impossible_low");
  if (sys >= 180 || dia >= 120) return A("bp", "critical", "bp_critical", "HH");
  if (sys >= 140 || dia >= 90) return A("bp", "high", "bp_high", "H");
  if (sys < 90) return A("bp", "low", "bp_low", "L");
  return A("bp", "normal", "normal");
}

type Rule = { impossible: (v: number) => string | null; levels: { test: (v: number, i: VitalsInput) => boolean; level: VitalLevel; code: string | ((i: VitalsInput) => string); interp: Interpretation }[] };
const RULES: Record<Exclude<VitalField, "bp">, Rule> = {
  pulse: { impossible: (v) => (v > 250 ? "pulse_impossible" : v < 20 ? "pulse_impossible_low" : null), levels: [
    { test: (v) => v > 120, level: "critical", code: "pulse_critical", interp: "HH" },
    { test: (v) => v > 100, level: "high", code: "pulse_high", interp: "H" },
    { test: (v) => v < 50, level: "low", code: "pulse_low", interp: "L" },
  ] },
  // 30–45 is almost certainly °C typed into the °F box (clinical review).
  temp: { impossible: (v) => (v >= 30 && v <= 45 ? "temp_celsius" : v > 110 || v < 85 ? "temp_impossible" : null), levels: [
    { test: (v) => v >= 103, level: "critical", code: "temp_critical", interp: "HH" },
    { test: (v) => v >= 100.4, level: "high", code: "temp_high", interp: "H" },
    { test: (v) => v < 95, level: "low", code: "temp_low", interp: "L" },
  ] },
  // SpO₂ 0 is not in the prototype; added as impossible (open question 37).
  spo2: { impossible: (v) => (v > 100 ? "spo2_over_100" : v < 1 ? "spo2_impossible" : null), levels: [
    { test: (v) => v < 90, level: "critical", code: "spo2_critical", interp: "LL" },
    { test: (v) => v < 95, level: "low", code: "spo2_low", interp: "L" },
  ] },
  // Above 40 is read as mg/dL typed into the mmol/L box; 25–40 is possible (e.g. DKA) but also a common mg/dL slip
  // (40 mg/dL = 2.2 mmol/L, a severe low), so it needs a "re-checked" tick (clinical review).
  rbs: { impossible: (v) => (v > 40 && v <= 1000 ? "rbs_mgdl" : v > 40 || v < 1 ? "rbs_impossible" : null), levels: [
    { test: (v) => v >= 25, level: "critical", code: "rbs_check_unit", interp: "HH" },
    { test: (v) => v < 2.8, level: "critical", code: "rbs_critical", interp: "LL" },
    { test: (v) => v < 3.9, level: "low", code: "rbs_low", interp: "L" },
    { test: (v, i) => v >= (i.rbsMode === "fasting" ? 7.0 : 11.1), level: "high", code: (i) => (i.rbsMode === "fasting" ? "rbs_high_fasting" : "rbs_high_random"), interp: "H" },
  ] },
  weight: { impossible: (v) => (v > 300 || v < 1 ? "weight_impossible" : null), levels: [] },
  // Under 8 is feet (5.6) typed into the cm box.
  height: { impossible: (v) => (v < 8 ? "height_feet" : v > 230 || v < 30 ? "height_impossible" : null), levels: [] },
};

function one(field: Exclude<VitalField, "bp">, v: number | null | undefined, i: VitalsInput): VitalAssessment | null {
  if (!given(v)) return null;
  if (bad(v)) return A(field, "impossible", "not_a_number");
  const r = RULES[field];
  const imp = r.impossible(v);
  if (imp) return A(field, "impossible", imp);
  for (const l of r.levels) if (l.test(v, i)) {
    const code = typeof l.code === "function" ? l.code(i) : l.code;
    return { ...A(field, l.level, code, l.interp), ...(code === "rbs_check_unit" ? { confirm: true } : {}) };
  }
  return A(field, "normal", "normal");
}

/** kg / m², one decimal. */
export const bmi = (weightKg: number, heightCm: number): number => Math.round((weightKg / (heightCm / 100) ** 2) * 10) / 10;
/** Asian cut-offs (WHO expert consultation 2004): < 18.5, 18.5–22.9, 23–27.4, ≥ 27.5. */
export const bmiClass = (b: number): BmiClass => (b < 18.5 ? "underweight" : b < 23 ? "normal" : b < 27.5 ? "overweight" : "obese");

/** BMI outside 8–80 means weight or height is in the wrong unit (e.g. height in inches): blocked on height. */
export const BMI_PLAUSIBLE: [number, number] = [8, 80];
export interface VitalsAssessment {
  fields: VitalAssessment[];
  /** Fields whose value needs a "re-checked" tick before saving. */
  needsConfirm: VitalField[];
  /** Nothing measured. */
  empty: boolean;
  /** Any impossible value, or nothing entered: the save is blocked (screen) and refused (API). */
  blocked: boolean;
  outOfRange: number;
  critical: boolean;
  bmi: number | null;
  bmiClass: BmiClass | null;
}
export function assessVitals(i: VitalsInput): VitalsAssessment {
  const fields = [bp(i.bpSys, i.bpDia), ...(["pulse", "temp", "spo2", "rbs", "weight", "height"] as const).map((f) => one(f, i[f], i))]
    .filter((x): x is VitalAssessment => x !== null);
  const ok = (f: VitalField) => fields.some((x) => x.field === f && x.level !== "impossible");
  let b = ok("weight") && ok("height") ? bmi(i.weight!, i.height!) : null;
  if (b !== null && (b < BMI_PLAUSIBLE[0] || b > BMI_PLAUSIBLE[1])) {
    const at = fields.findIndex((x) => x.field === "height");
    fields[at] = A("height", "impossible", "bmi_implausible");
    b = null;
  }
  return {
    fields, empty: fields.length === 0, needsConfirm: fields.filter((f) => f.confirm).map((f) => f.field),
    blocked: fields.length === 0 || fields.some((f) => f.level === "impossible"),
    outOfRange: fields.filter((f) => f.level === "critical" || f.level === "high" || f.level === "low").length,
    critical: fields.some((f) => f.level === "critical"),
    bmi: b, bmiClass: b === null ? null : bmiClass(b),
  };
}
