/* Emergency department rules (ADR 0014, walkthrough B1–B2). The triage scale here is a SAMPLE pending clinician
   sign-off (known gap 12): the API and the ER screens label it so. Routes and screens both import these. */
import { BED, ENCOUNTER, can, transition, type BedState, type EncounterState } from "./machines.js";

export type TriageLevelNo = 1 | 2 | 3 | 4 | 5;
export interface TriageLevel { level: TriageLevelNo; key: string; nameBn: string; nameEn: string; /** seen by a doctor within */ targetMinutes: number; tone: "crit" | "bad" | "warn" | "info" | "neu"; icon: string }
/** A five-level scale shaped like the prototype's (ESI / Manchester-style); the minutes are the prototype's targets. */
export const TRIAGE_SCALE: readonly TriageLevel[] = [
  { level: 1, key: "resuscitation", nameBn: "স্তর ১ · পুনরুজ্জীবন", nameEn: "Level 1 · Resuscitation", targetMinutes: 0, tone: "crit", icon: "siren" },
  { level: 2, key: "emergent", nameBn: "স্তর ২ · জরুরি", nameEn: "Level 2 · Emergent", targetMinutes: 10, tone: "bad", icon: "triangle-alert" },
  { level: 3, key: "urgent", nameBn: "স্তর ৩ · তাড়াতাড়ি", nameEn: "Level 3 · Urgent", targetMinutes: 30, tone: "warn", icon: "clock" },
  { level: 4, key: "less-urgent", nameBn: "স্তর ৪ · কম জরুরি", nameEn: "Level 4 · Less urgent", targetMinutes: 60, tone: "info", icon: "info" },
  { level: 5, key: "non-urgent", nameBn: "স্তর ৫ · অজরুরি", nameEn: "Level 5 · Non-urgent", targetMinutes: 120, tone: "neu", icon: "minus" },
];
export const TRIAGE_SCALE_SAMPLE = true;
/** Label shown wherever the scale is used, until a clinician signs it off. */
export const TRIAGE_SCALE_NOTE = { bn: "ক্লিনিশিয়ানের অনুমোদন বাকি (নমুনা স্কেল)", en: "Pending clinician sign-off (sample scale)" } as const;
/** An arrival nobody has triaged yet is overdue after this many minutes (sample). */
export const UNTRIAGED_TARGET_MINUTES = 10;
export const triageLevel = (n: number | null | undefined): TriageLevel | null => TRIAGE_SCALE.find((l) => l.level === n) ?? null;
export const isTriageLevel = (n: unknown): n is TriageLevelNo => typeof n === "number" && TRIAGE_SCALE.some((l) => l.level === n);

export const waitedMinutes = (arrivedAt: Date | string, now: Date): number => Math.max(0, Math.floor((now.getTime() - new Date(arrivedAt).getTime()) / 60_000));
/** Overdue (⚠ on the board): waited past the level's target with no doctor assigned; untriaged → past the untriaged target. */
export function triageOverdue(level: number | null, waited: number, assigned: boolean): boolean {
  if (assigned) return false;
  const l = triageLevel(level);
  return waited > (l ? l.targetMinutes : UNTRIAGED_TARGET_MINUTES);
}

export interface BoardRow { level: number | null; waited: number; arrivedAt: string }
/** Board order: untriaged first (they need a level), then level 1 → 5, longest wait first within a level. */
export const boardOrder = <T extends BoardRow>(rows: T[]): T[] =>
  rows.slice().sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || b.waited - a.waited || a.arrivedAt.localeCompare(b.arrivedAt));

/** Walkthrough issue #24: an adult assigned to a paediatrician needs an explicit "continue". */
export const PAEDIATRIC_RE = /paed|pediat|শিশু/i;
export const isPaediatric = (speciality: string | null | undefined): boolean => Boolean(speciality && PAEDIATRIC_RE.test(speciality));
export const paediatricPrompt = (speciality: string | null | undefined, ageYears: number | null): boolean => isPaediatric(speciality) && ageYears !== null && ageYears >= 18;

export type ArrivalMode = "walk-in" | "ambulance" | "police" | "public" | "referral";
export const ARRIVAL_MODES: readonly ArrivalMode[] = ["walk-in", "ambulance", "police", "public", "referral"];
export type UnknownSex = "male" | "female" | "other";
/** A provisional quick registration: the record's name until the desk resolves the identity. */
export const unknownPatientName = (sex: UnknownSex, approxAgeYears: number | null): { bn: string; en: string } => {
  const bn = sex === "male" ? "অজ্ঞাত পুরুষ" : sex === "female" ? "অজ্ঞাত মহিলা" : "অজ্ঞাত ব্যক্তি";
  const en = sex === "male" ? "Unknown male" : sex === "female" ? "Unknown female" : "Unknown person";
  return approxAgeYears === null ? { bn, en } : { bn: `${bn} ~${approxAgeYears}ব`, en: `${en} ~${approxAgeYears}y` };
};

/* ───── protocol orders (decision 243) ───── */
/** A nurse's order on the ER floor is a protocol order: it waits for the doctor's countersignature (the disposition sign). */
export const isProtocolOrder = (role: string): boolean => role === "nurse";
export interface Countersignable { protocol: boolean; countersignedAt: string | null }
/** Orders the disposition sign will countersign (every open protocol order of the visit). */
export const awaitingCountersign = <T extends Countersignable>(orders: T[]): T[] => orders.filter((o) => o.protocol && !o.countersignedAt);
export const PROTOCOL_LABEL = { bn: "প্রটোকল অর্ডার — ডাক্তারের অপেক্ষায়", en: "protocol order — awaiting doctor" } as const;

/* ───── the ER note ───── */
export interface CareOrder { key: string; nameEn: string; nameBn: string; detail: string; icon: string }
/** Non-lab STAT items (ADR 0014): care-order lines in the note until an imaging catalogue and the MAR exist. Sample. */
export const CARE_ORDERS_SAMPLE: readonly CareOrder[] = [
  { key: "ivf", nameEn: "IV NS 0.9% 1 L stat", nameBn: "IV স্যালাইন ১ লিটার", detail: "Fluid resuscitation", icon: "droplet" },
  { key: "o2", nameEn: "Oxygen 4 L/min", nameBn: "অক্সিজেন ৪ লি/মি", detail: "Nasal cannula", icon: "wind" },
  { key: "ecg", nameEn: "ECG 12-lead", nameBn: "ইসিজি", detail: "Cardiology", icon: "activity" },
  { key: "ct", nameEn: "CT head (non-contrast)", nameBn: "সিটি হেড", detail: "Imaging · STAT", icon: "scan-line" },
  { key: "xr", nameEn: "X-ray C-spine, chest", nameBn: "এক্স-রে", detail: "Imaging", icon: "scan" },
  { key: "tt", nameEn: "Inj. Tetanus toxoid 0.5 mL", nameBn: "টিটি ইনজেকশন", detail: "IM", icon: "syringe" },
  { key: "anal", nameEn: "Inj. Ketorolac 30 mg IV", nameBn: "ব্যথানাশক ইনজেকশন", detail: "Analgesic", icon: "syringe" },
  { key: "abx", nameEn: "Inj. Ceftriaxone 1 g IV", nameBn: "অ্যান্টিবায়োটিক ইনজেকশন", detail: "Antibiotic", icon: "pill" },
];
export const careOrder = (key: string): CareOrder | null => CARE_ORDERS_SAMPLE.find((c) => c.key === key) ?? null;

export type DispositionKind = "admit" | "discharge" | "refer" | "death";
export const DISPOSITIONS: readonly DispositionKind[] = ["admit", "discharge", "refer", "death"];
export interface Disposition {
  kind: DispositionKind;
  /** admit */ bedId?: string | null; consultantId?: string | null; diagnosis?: string | null;
  /** discharge */ advice?: string | null; followUp?: string | null;
  /** refer */ referTo?: string | null; referReason?: string | null; transport?: string | null;
  /** death */ timeOfDeath?: string | null; cause?: string | null; medicoLegal?: boolean; checks?: string[];
}
export const DEATH_CHECKS = ["certificate", "family", "police", "body"] as const;
export interface DispositionBlocker { field: string; code: string }
/** What stops "Sign disposition" (the screen and the route run the same list). */
export function dispositionBlockers(d: Disposition): DispositionBlocker[] {
  const out: DispositionBlocker[] = [];
  const need = (field: string, v: string | null | undefined, min = 1) => { if (!v || v.trim().length < min) out.push({ field, code: "required" }); };
  if (d.kind === "admit") { need("bedId", d.bedId); need("consultantId", d.consultantId); need("diagnosis", d.diagnosis, 3); }
  if (d.kind === "discharge") need("advice", d.advice, 3);
  if (d.kind === "refer") { need("referTo", d.referTo, 3); need("referReason", d.referReason, 3); }
  if (d.kind === "death") {
    need("timeOfDeath", d.timeOfDeath); need("cause", d.cause, 3);
    const c = d.checks ?? [];
    if (!c.includes("certificate")) out.push({ field: "checks.certificate", code: "required" });
    if (!c.includes("family")) out.push({ field: "checks.family", code: "required" });
    // medico-legal (RTA, assault, poisoning…): police before signing (prototype)
    if (d.medicoLegal && !c.includes("police")) out.push({ field: "checks.police", code: "police_required" });
  }
  return out;
}
/** Which dispositions close the ER encounter when signed (admit closes it when the desk completes the admission). */
export const closesOnSign = (kind: DispositionKind): boolean => kind !== "admit";

/* ───── ENCOUNTER events the ER uses ───── */
export const erToken = (n: number): string => `E-${String(n).padStart(3, "0")}`;
export const erTokenSequenceName = (branchId: string, day: string) => `er-token:${branchId}:${day}`;
/** ER visits are open while the patient is in the department. */
export const ER_OPEN: readonly EncounterState[] = ["arrived", "triaged", "in-progress"];
export const erOpen = (s: EncounterState) => ER_OPEN.includes(s);
/** Triage (and re-triage): the first triage moves arrived → triaged; later ones keep the state. */
export function triageTransition(from: EncounterState): EncounterState {
  if (from === "arrived") return transition("encounter", ENCOUNTER, from, "triage");
  if (erOpen(from)) return from;
  throw Object.assign(new Error("er: visit closed"), { code: "encounter_closed" });
}
/** Assigning a doctor starts the visit (arrived or triaged → in-progress); re-assigning keeps it. */
export function assignTransition(from: EncounterState): EncounterState {
  if (can(ENCOUNTER, from, "start")) return transition("encounter", ENCOUNTER, from, "start");
  if (from === "in-progress") return from;
  throw Object.assign(new Error("er: visit closed"), { code: "encounter_closed" });
}
/** A bay (an ER bed) is taken straight away: vacant → occupied in one step (no reservation in the ER). */
export const bayTake = (state: BedState): BedState => transition("bed", BED, state, "occupy");
