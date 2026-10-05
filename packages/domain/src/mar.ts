/* Inpatient orders and the medication administration record (ADR 0015, walkthrough B5). The route, the screen and the
   database apply the same rules: an active order of this patient only; never in the future; one record per slot; a
   reason outside the window and for held / refused / missed; the five checks for given; the PRN cap; a witness for
   high-alert drugs; an allergy recorded after the order blocks giving. The window is a SAMPLE pending sign-off. */
import { wardMedicine, type Route, type WardMedicine } from "./catalog.js";
import type { MedOrderState } from "./machines.js";
import { allergyMatches, type AllergyFact } from "./prescription.js";

export const DOSE_WINDOW_MIN = 60;
export const CLOCK_SKEW_MS = 2 * 60_000;
export const DOSE_REASON_MIN = 5;
export const STOP_REASON_MIN = 5;
export const PRN_MAX_LIMIT = 24;
const DHAKA_MS = 6 * 3600_000;

export interface InpatientLineInput { medicineKey: string; route: string; doseText: string; doseQty: number | null; times: string[]; prn: boolean; prnMaxPer24h: number | null; note?: string | null }
export type LineProblem = "unknown_medicine" | "route" | "dose_text" | "dose_qty" | "times" | "prn_max" | "prn_with_times";
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** What an inpatient order line needs before the note can be saved (the A5 interaction checks run at signing). */
export function lineProblems(l: InpatientLineInput, med: WardMedicine | null = wardMedicine(l.medicineKey)): LineProblem[] {
  const out: LineProblem[] = [];
  if (!med) return ["unknown_medicine"];
  if (!med.routes.includes(l.route as Route)) out.push("route");
  if (l.doseText.trim().length < 1 || l.doseText.length > 120) out.push("dose_text");
  if (med.multiDose ? l.doseQty !== null : !(Number.isInteger(l.doseQty) && (l.doseQty as number) >= 1 && (l.doseQty as number) <= 20)) out.push("dose_qty");
  if (l.prn) {
    if (l.times.length) out.push("prn_with_times");
    if (!(Number.isInteger(l.prnMaxPer24h) && (l.prnMaxPer24h as number) >= 1 && (l.prnMaxPer24h as number) <= PRN_MAX_LIMIT)) out.push("prn_max");
  } else {
    const uniq = new Set(l.times);
    if (!l.times.length || l.times.length > 24 || uniq.size !== l.times.length || l.times.some((t) => !TIME_RE.test(t))) out.push("times");
    if (l.prnMaxPer24h !== null) out.push("prn_max");
  }
  return out;
}
/** Decision 9: a line continues another's regimen (PRN cap, slots) only when drug, dose, route and frequency are the same. */
export function sameRegimen(a: InpatientLineInput, b: InpatientLineInput): boolean {
  const t = (x: string[]) => [...x].sort().join(",");
  return a.medicineKey === b.medicineKey && a.route === b.route && a.doseText.trim().toLowerCase() === b.doseText.trim().toLowerCase()
    && a.doseQty === b.doseQty && a.prn === b.prn && (a.prnMaxPer24h ?? null) === (b.prnMaxPer24h ?? null) && t(a.times) === t(b.times);
}

/* ───── slots ───── */
/** Dhaka wall-clock HH:MM on a Dhaka day → UTC instant. */
const atDhaka = (day: string, hhmm: string) => new Date(new Date(`${day}T${hhmm}:00Z`).getTime() - DHAKA_MS);
const dhakaDayOf = (d: Date) => new Date(d.getTime() + DHAKA_MS).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
export interface Schedulable { times: string[]; prn: boolean; startAt: Date | string; endAt?: Date | string | null }
/** The order's slots between `from` and `to` (inclusive), never before it started, never after it ended. */
export function slotsBetween(o: Schedulable, from: Date, to: Date): Date[] {
  if (o.prn || !o.times.length) return [];
  const start = new Date(o.startAt), end = o.endAt ? new Date(o.endAt) : null;
  const out: Date[] = [];
  for (let day = dhakaDayOf(from); day <= dhakaDayOf(to); day = addDays(day, 1))
    for (const t of [...o.times].sort()) {
      const at = atDhaka(day, t);
      if (at < from || at > to || at < start || (end && at >= end)) continue;
      out.push(at);
    }
  return out;
}
export const isSlotOf = (o: Schedulable, slot: Date) => slotsBetween(o, new Date(slot.getTime() - 1), new Date(slot.getTime() + 1)).some((x) => x.getTime() === slot.getTime());
/** The slots a MAR day shows: the Dhaka calendar day, and when that day is today also the last 24 hours before it —
    so just after midnight the night nurse still sees yesterday's 22:00 dose (the ward board counts overdue doses over
    the last 24 hours; the MAR must show every dose the board counts). */
export function marSlotRange(dayStart: Date, now: Date): { from: Date; to: Date } {
  const to = new Date(dayStart.getTime() + 864e5 - 1);
  const today = now.getTime() >= dayStart.getTime() && now.getTime() <= to.getTime();
  return { from: today ? new Date(Math.min(dayStart.getTime(), now.getTime() - 864e5)) : dayStart, to };
}
export type SlotView = "scheduled" | "due" | "overdue";
/** A slot nobody has recorded: due inside the window, overdue (missed — reason needed) after it, scheduled before it. */
export function slotState(slot: Date, now: Date, windowMin = DOSE_WINDOW_MIN): SlotView {
  const d = now.getTime() - slot.getTime();
  if (d > windowMin * 60_000) return "overdue";
  if (d >= -windowMin * 60_000) return "due";
  return "scheduled";
}
export type Timing = "on-time" | "early" | "late" | "prn";
export function doseTiming(slot: Date | null, at: Date, windowMin = DOSE_WINDOW_MIN): Timing {
  if (!slot) return "prn";
  const d = at.getTime() - slot.getTime();
  return d > windowMin * 60_000 ? "late" : d < -windowMin * 60_000 ? "early" : "on-time";
}

/* ───── recording a dose ───── */
export type DoseOutcome = "given" | "held" | "refused" | "missed";
export type DoseSource = "ward-stock" | "patient-supplied";
export interface FiveChecks { patient: boolean; drug: boolean; dose: boolean; route: boolean; time: boolean }
export const FIVE_CHECKS: (keyof FiveChecks)[] = ["patient", "drug", "dose", "route", "time"];
export interface OrderFacts {
  status: MedOrderState; noteCurrent: boolean; patientId: string; encounterId: string; encounterOpen: boolean;
  startAt: Date; times: string[]; prn: boolean; prnMaxPer24h: number | null; medicineKey: string; highAlert: boolean;
  /** a controlled drug is witnessed too: its register line records the witness (ADR 0015) */
  controlled?: boolean;
  /** a multi-dose vial (insulin, heparin): given only from an opened vial, with the amount given */
  multiDose?: boolean;
}
export interface DoseFacts {
  patientId: string; encounterId: string; outcome: DoseOutcome; slot: Date | null; administeredAt: Date; now: Date;
  checks: FiveChecks; reason: string | null;
  /** the regimen's slots already recorded (not entered-in-error), as epoch ms */ recordedSlots: number[];
  /** given doses of the regimen in the 24 hours up to administeredAt (not entered-in-error) */ givenLast24h: number;
  nurseId: string; preparedById: string; witnessId: string | null; witnessRole: string | null;
  allergies: AllergyFact[];
  source?: DoseSource;
  /** multi-dose drugs: the amount actually given ("6 IU") — the order may say "sliding scale" */
  amountGiven?: string | null;
  /** a vial of this medicine is open for this patient (any regimen) */
  vialOpen?: boolean;
  /** the same medicine was given under another (earlier) regimen within the window of this dose */
  earlierGivenNear?: boolean;
}
/** How far ahead a slot may be charted (held / refused before due): within the shift. */
export const SLOT_AHEAD_MAX_MS = 12 * 3600_000;
export type DoseBlocker =
  | "order_not_active" | "wrong_patient" | "encounter_closed" | "future_time" | "before_start"
  | "slot_required" | "slot_on_prn" | "not_a_slot" | "slot_recorded" | "missed_too_early" | "prn_outcome"
  | "checks_incomplete" | "reason_required" | "prn_cap"
  | "witness_required" | "witness_self" | "witness_role" | "allergy"
  | "vial_required" | "amount_required" | "recent_dose" | "prn_backdated" | "slot_too_far";
export function doseBlockers(o: OrderFacts, d: DoseFacts, windowMin = DOSE_WINDOW_MIN): DoseBlocker[] {
  const out: DoseBlocker[] = [];
  if (o.status !== "active" || !o.noteCurrent) out.push("order_not_active");
  if (o.patientId !== d.patientId || o.encounterId !== d.encounterId) out.push("wrong_patient");
  if (!o.encounterOpen) out.push("encounter_closed");
  if (d.administeredAt.getTime() > d.now.getTime() + CLOCK_SKEW_MS) out.push("future_time");
  if (d.administeredAt.getTime() < o.startAt.getTime() - CLOCK_SKEW_MS) out.push("before_start");
  if (o.prn) {
    if (d.slot) out.push("slot_on_prn");
    if (d.outcome === "missed" || d.outcome === "held") out.push("prn_outcome");
  } else if (!d.slot) out.push("slot_required");
  else {
    if (!isSlotOf({ times: o.times, prn: false, startAt: o.startAt }, d.slot)) out.push("not_a_slot");
    if (d.recordedSlots.includes(d.slot.getTime())) out.push("slot_recorded");
    if (d.outcome === "missed" && d.now.getTime() - d.slot.getTime() <= windowMin * 60_000) out.push("missed_too_early");
    if (d.slot.getTime() - d.now.getTime() > SLOT_AHEAD_MAX_MS) out.push("slot_too_far");
  }
  // a PRN dose is charted when it is given: backdating beyond the window would slip past the 24-hour cap
  if (o.prn && d.now.getTime() - d.administeredAt.getTime() > windowMin * 60_000) out.push("prn_backdated");
  const reasonOk = (d.reason ?? "").trim().length >= DOSE_REASON_MIN;
  if (d.outcome === "given") {
    if (!FIVE_CHECKS.every((k) => d.checks[k])) out.push("checks_incomplete");
    const t = doseTiming(d.slot, d.administeredAt, windowMin);
    if ((t === "late" || t === "early") && !reasonOk) out.push("reason_required");
    if (o.prn && o.prnMaxPer24h !== null && d.givenLast24h + 1 > o.prnMaxPer24h) out.push("prn_cap");
    if (o.highAlert || o.controlled) {
      if (!d.witnessId) out.push("witness_required");
      else {
        if (d.witnessId === d.nurseId || d.witnessId === d.preparedById) out.push("witness_self");
        if (d.witnessRole !== "nurse" && d.witnessRole !== "doctor") out.push("witness_role");
      }
    }
    const med = wardMedicine(o.medicineKey);
    if (med && allergyMatches(med, d.allergies).length) out.push("allergy");
    if (o.multiDose) {
      if (!(d.amountGiven ?? "").trim()) out.push("amount_required");
      if ((d.source ?? "ward-stock") === "ward-stock" && d.vialOpen === false) out.push("vial_required");
    }
    if (d.earlierGivenNear && !reasonOk) out.push("recent_dose");
  } else if (!reasonOk) out.push("reason_required");
  return out;
}
/** Issue units a given dose takes from ward stock: the order's dose for a unit-dose drug, none for a multi-dose vial
    (consumed when it is opened) and none from the patient's own supply. */
export function doseConsumption(med: Pick<WardMedicine, "multiDose">, doseQty: number | null, source: DoseSource): number {
  if (source === "patient-supplied" || med.multiDose) return 0;
  return doseQty ?? 0;
}
export const PRN_WINDOW_MS = 24 * 3600_000;

/* ───── stopping an order ───── */
export const stopBlockers = (x: { status: MedOrderState; role: string; reason: string }): ("not_active" | "doctor_only" | "reason")[] => {
  const out: ("not_active" | "doctor_only" | "reason")[] = [];
  if (x.status !== "active") out.push("not_active");
  if (x.role !== "doctor") out.push("doctor_only");
  if (x.reason.trim().length < STOP_REASON_MIN) out.push("reason");
  return out;
};

/* ───── ward indents ───── */
export const INDENT_QTY_MAX = 500;
export const indentNumber = (yy: string, n: number) => `IND/${yy}/${String(n).padStart(4, "0")}`;
export const wardStockLocation = (wardId: string) => `ward:${wardId}`;
export const isWardLocation = (loc: string) => loc.startsWith("ward:");
export function indentLineProblems(lines: { medicineKey: string; qty: number }[]): ("empty" | "unknown_medicine" | "qty" | "duplicate")[] {
  const out = new Set<"empty" | "unknown_medicine" | "qty" | "duplicate">();
  if (!lines.length) out.add("empty");
  const keys = lines.map((l) => l.medicineKey);
  lines.forEach((l, i) => {
    if (!wardMedicine(l.medicineKey)) out.add("unknown_medicine");
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > INDENT_QTY_MAX) out.add("qty");
    if (keys.indexOf(l.medicineKey) !== i) out.add("duplicate");
  });
  return [...out];
}
/** After an issue: every line issued in full → issued; something issued → partially-issued. */
export const indentStateAfter = (lines: { requested: number; issued: number }[]): "issued" | "partially-issued" | "requested" =>
  lines.every((l) => l.issued >= l.requested) ? "issued" : lines.some((l) => l.issued > 0) ? "partially-issued" : "requested";
