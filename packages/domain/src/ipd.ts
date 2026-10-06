/* Admission and beds (ADR 0014, walkthrough B2–B3 and the bed map's rules). Bed state changes go through BED; a bed
   move is two legs with one transfer id, like a stock transfer. Routes and the admission screen import these. */
import { toEn } from "./format.js";
import { BED, ENCOUNTER, transition, type BedState, type EncounterState } from "./machines.js";

export interface BedClass { key: string; nameBn: string; nameEn: string; /** per-day sample price, paisa — the seed for each facility's BedClassRate (ADR 0017) */ perDayPaisa: number }
/** The admin masters hold the real classes; these are the sample defaults the seed and the picker use. */
export const BED_CLASSES_SAMPLE: readonly BedClass[] = [
  { key: "General", nameBn: "সাধারণ ওয়ার্ড", nameEn: "General ward", perDayPaisa: 120_000 },
  { key: "Cabin", nameBn: "কেবিন (এসি)", nameEn: "Cabin (AC)", perDayPaisa: 450_000 },
  { key: "HDU", nameBn: "এইচডিইউ", nameEn: "HDU", perDayPaisa: 800_000 },
  { key: "ICU", nameBn: "আইসিইউ", nameEn: "ICU", perDayPaisa: 1_500_000 },
  { key: "ER", nameBn: "জরুরি বিভাগের বে", nameEn: "ER bay", perDayPaisa: 0 },
];
/** Bed classes a patient is admitted to (an ER bay is never an admission class). */
export const ADMISSION_CLASSES = BED_CLASSES_SAMPLE.filter((c) => c.key !== "ER");
export const isAdmissionClass = (key: string) => ADMISSION_CLASSES.some((c) => c.key === key);

export type BedPickReason = "cleaning" | "blocked" | "occupied" | "discharge-pending" | "reserved-other" | "wrong-class";
export interface PickableBed { state: BedState; bedClass: string | null; reservedForPatientId: string | null }
/** Walkthrough B3: vacant beds and beds reserved for this patient can be picked; cleaning / blocked / occupied never. */
export function bedPickable(b: PickableBed, patientId: string, bedClass?: string | null): { ok: true } | { ok: false; reason: BedPickReason } {
  if (bedClass && b.bedClass !== bedClass) return { ok: false, reason: "wrong-class" };
  if (b.state === "vacant") return { ok: true };
  if (b.state === "reserved") return b.reservedForPatientId === patientId ? { ok: true } : { ok: false, reason: "reserved-other" };
  return { ok: false, reason: b.state };
}

/* ───── consents and the checklist ───── */
export interface ConsentKind { key: string; nameBn: string; nameEn: string; required: boolean }
export const CONSENTS: readonly ConsentKind[] = [
  { key: "general", nameBn: "ভর্তির সাধারণ সম্মতি", nameEn: "General admission consent", required: true },
  { key: "financial", nameBn: "আর্থিক দায় ও প্যাকেজ শর্ত", nameEn: "Financial responsibility", required: true },
  { key: "guardian-id", nameBn: "অভিভাবকের NID কপি", nameEn: "Guardian ID copy", required: true },
  { key: "surgical", nameBn: "অপারেশনের সম্মতি", nameEn: "Surgical consent", required: false },
  { key: "anaesthesia", nameBn: "অ্যানেস্থেশিয়ার সম্মতি", nameEn: "Anaesthesia consent", required: false },
  { key: "blood", nameBn: "রক্ত গ্রহণের সম্মতি", nameEn: "Blood transfusion", required: false },
];
export const isConsentKey = (k: string) => CONSENTS.some((c) => c.key === k);
export interface AdmissionForm { bedId: string | null; diagnosis: string; guardianName: string; guardianPhone: string; consents: string[]; /** ADR 0017: the deposit taken at the desk (shown, never blocking) */ depositPaisa?: number }
export type ChecklistKey = "bed" | "diagnosis" | "guardian" | "consents" | "deposit";
export interface ChecklistItem { key: ChecklistKey; ok: boolean; /** consents: how many required ones are missing */ missing?: number; /** deposit: shown, never blocks (B1–B2 decision) */ blocks: boolean }
/** The prototype's checklist. The deposit shows but never blocks (ADR 0014; ADR 0017 takes it at the desk). */
export function admissionChecklist(f: AdmissionForm): ChecklistItem[] {
  const missing = CONSENTS.filter((c) => c.required && !f.consents.includes(c.key)).length;
  return [
    { key: "bed", ok: Boolean(f.bedId), blocks: true },
    { key: "diagnosis", ok: f.diagnosis.trim().length >= 3, blocks: true },
    // hands-on 05/10/2026: the phone is typed in Bangla or Latin digits (decision 239 applies to phones too)
    { key: "guardian", ok: f.guardianName.trim().length >= 2 && /^(\+?880)?0?1[3-9]\d{8}$/.test(guardianPhoneDigits(f.guardianPhone)), blocks: true },
    { key: "consents", ok: missing === 0, missing, blocks: true },
    { key: "deposit", ok: (f.depositPaisa ?? 0) > 0, blocks: false },
  ];
}
/** The guardian's mobile as the API stores it: Latin digits, no spaces or dashes. */
export const guardianPhoneDigits = (raw: string) => toEn(raw).replace(/[\s-]/g, "");
export const admissionBlockers = (f: AdmissionForm): ChecklistKey[] => admissionChecklist(f).filter((c) => c.blocks && !c.ok).map((c) => c.key);
export const admissionReady = (f: AdmissionForm) => admissionBlockers(f).length === 0;

export const admissionNumber = (yy: string, n: number) => `ADM/${yy}/${String(n).padStart(4, "0")}`;
export const ADMISSION_SEQUENCE = "admission";
export type AdmissionSource = "opd" | "er" | "direct";
export const ADMISSION_SOURCES: readonly AdmissionSource[] = ["opd", "er", "direct"];
/** The department key an ER admit request starts with, from the consultant's speciality (review: the desk's form takes keys). */
export function departmentForSpeciality(speciality: string | null | undefined): string {
  const s = speciality ?? "";
  if (/surg/i.test(s)) return "surgery";
  if (/gyn|obs/i.test(s)) return "gynae";
  if (/paed|pediat|শিশু/i.test(s)) return "paediatrics";
  if (/cardio/i.test(s)) return "cardiology";
  if (/ortho/i.test(s)) return "orthopaedics";
  return "medicine";
}
export const DEPARTMENTS_SAMPLE = [
  { key: "medicine", nameBn: "মেডিসিন", nameEn: "Medicine" }, { key: "surgery", nameBn: "সার্জারি", nameEn: "Surgery" },
  { key: "gynae", nameBn: "স্ত্রীরোগ ও প্রসূতি", nameEn: "Obs & Gynae" }, { key: "paediatrics", nameBn: "শিশু", nameEn: "Paediatrics" },
  { key: "cardiology", nameBn: "কার্ডিওলজি", nameEn: "Cardiology" }, { key: "orthopaedics", nameBn: "অর্থোপেডিক্স", nameEn: "Orthopaedics" },
] as const;

/* ───── two-leg bed moves (like a stock transfer: two rows, one transfer id) ───── */
export type AssignmentStatus = "reserved" | "occupied" | "ended";
export interface MoveLeg1 { destination: BedState }
export interface MoveLeg2 { destination: BedState; source: BedState | null; sourceEvent: "vacate" | "release" | null }
/** Leg 1: reserve the destination (vacant → reserved). */
export const reserveLeg = (destination: BedState): MoveLeg1 => ({ destination: transition("bed", BED, destination, "reserve") });
/** Leg 2: occupy the destination (reserved or vacant → occupied) and free the source: an occupied source goes to
    cleaning (`vacate`), a reserved one is given back (`release`); no source for a direct admission. */
export function occupyLeg(destination: BedState, source: BedState | null, sourceStatus: AssignmentStatus | null): MoveLeg2 {
  const dest = transition("bed", BED, destination, "occupy");
  if (source === null || sourceStatus === null) return { destination: dest, source: null, sourceEvent: null };
  const ev = sourceStatus === "occupied" ? "vacate" : "release";
  return { destination: dest, source: transition("bed", BED, source, ev), sourceEvent: ev };
}
/** The IPD encounter is created open in one step: planned → arrived → in-progress (two ENCOUNTER transitions). */
export function admissionEncounterState(): EncounterState {
  const arrived = transition("encounter", ENCOUNTER, "planned", "arrive");
  return transition("encounter", ENCOUNTER, arrived, "start");
}
/** The source ER visit ends when the desk completes the admission. */
export const finishSource = (from: EncounterState): EncounterState => transition("encounter", ENCOUNTER, from, "finish");
export const IPD_OPEN: readonly EncounterState[] = ["planned", "arrived", "triaged", "in-progress"];
