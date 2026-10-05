/* Emergency department contracts (ADR 0014, slice B1–B2). The triage scale comes from @setu/domain er.ts and is a
   sample pending clinician sign-off: every answer that carries it says so. Writes take an Idempotency-Key; the
   disposition is signed with the PIN and the server's answer is the only "signed". */
import { z } from "zod";
import { AllergyView, DocStatus, OrderPriority, OrderStatus, TestItem } from "./consultation.js";
import { EncounterStatus, PatientSummary, Sex } from "./frontdesk.js";

const Person = z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() });
export const ArrivalMode = z.enum(["walk-in", "ambulance", "police", "public", "referral"]);
export const TriageLevelNo = z.number().int().min(1).max(5);
export const BedStateWire = z.enum(["vacant", "reserved", "occupied", "discharge-pending", "cleaning", "blocked"]);
export const TriageScale = z.object({
  sample: z.boolean(),
  note: z.object({ bn: z.string(), en: z.string() }),
  untriagedTargetMinutes: z.number().int(),
  levels: z.array(z.object({ level: TriageLevelNo, key: z.string(), nameBn: z.string(), nameEn: z.string(), targetMinutes: z.number().int(), tone: z.enum(["crit", "bad", "warn", "info", "neu"]), icon: z.string() })),
});
export const ErPatient = PatientSummary.pick({ id: true, facilityNo: true, nameBn: true, nameEn: true, sex: true, birthDate: true, approxAgeYears: true, approxAgeMonths: true, approxAgeAt: true, identityConfidence: true });
export const ErDoctor = Person.extend({ speciality: z.string().nullable(), paediatric: z.boolean() });
export const ErBay = z.object({ id: z.string(), name: z.string(), nameBn: z.string().nullable(), state: BedStateWire, note: z.string().nullable(), /** who holds it (null when free) */ patientId: z.string().nullable() });
export const DispositionKind = z.enum(["admit", "discharge", "refer", "death"]);
export const Disposition = z.object({
  kind: DispositionKind,
  bedId: z.string().max(64).nullable().optional(), consultantId: z.string().max(64).nullable().optional(), diagnosis: z.string().max(300).nullable().optional(),
  advice: z.string().max(500).nullable().optional(), followUp: z.string().max(200).nullable().optional(),
  referTo: z.string().max(200).nullable().optional(), referReason: z.string().max(300).nullable().optional(), transport: z.string().max(200).nullable().optional(),
  timeOfDeath: z.string().max(40).nullable().optional(), cause: z.string().max(300).nullable().optional(), medicoLegal: z.boolean().optional(), checks: z.array(z.enum(["certificate", "family", "police", "body"])).max(4).optional(),
});
export type Disposition = z.infer<typeof Disposition>;

export const ErBoardItem = z.object({
  id: z.string(), token: z.string(), day: z.string(), status: EncounterStatus,
  patient: ErPatient, ageYears: z.number().int().nullable(),
  arrivalMode: ArrivalMode, broughtBy: z.string().nullable(), arrivedAt: z.string(), waited: z.number().int(),
  complaint: z.string(),
  level: TriageLevelNo.nullable(), targetMinutes: z.number().int().nullable(), triagedAt: z.string().nullable(),
  /** ⚠ on the board: past target with no doctor (domain triageOverdue) */
  overdue: z.boolean(),
  doctor: ErDoctor.nullable(),
  bay: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** latest vitals in one line (BP, pulse, SpO₂ …), when any were taken */
  vitals: z.string().nullable(),
  disposition: z.object({ kind: DispositionKind, signedAt: z.string(), by: Person }).nullable(),
  /** the admission the admit disposition opened (requested until the desk admits) */
  admission: z.object({ id: z.string(), status: z.string(), bed: z.object({ id: z.string(), name: z.string(), ward: z.string() }) }).nullable(),
  /** quick provisional registration still waiting at the desk's review queue */
  provisional: z.boolean(),
});
export type ErBoardItem = z.infer<typeof ErBoardItem>;
/* GET /v1/er/board */
export const ErBoard = z.object({
  day: z.string(),
  items: z.array(ErBoardItem),
  counts: z.object({ byLevel: z.record(z.number().int()), untriaged: z.number().int(), overTarget: z.number().int(), total: z.number().int() }),
  scale: TriageScale,
  doctors: z.array(ErDoctor),
  bays: z.array(ErBay),
});
export type ErBoard = z.infer<typeof ErBoard>;

/* POST /v1/er/arrivals — an existing patient, or an unknown one (quick provisional registration, ADR 0014) */
export const ErArrivalRequest = z.object({
  patientId: z.string().max(64).optional(),
  unknown: z.object({ sex: Sex, approxAgeYears: z.number().int().min(0).max(130).nullable(), features: z.string().max(300).optional() }).optional(),
  arrivalMode: ArrivalMode,
  broughtBy: z.string().max(120).optional(),
  complaint: z.string().trim().min(2).max(300),
  bayId: z.string().max(64).optional(),
}).refine((r) => Boolean(r.patientId) !== Boolean(r.unknown), { message: "patient_or_unknown", path: ["patientId"] });
export type ErArrivalRequest = z.infer<typeof ErArrivalRequest>;
export const ErArrivalResponse = z.object({ item: ErBoardItem, patient: PatientSummary, /** a provisional record was sent to the desk's review queue */ review: z.boolean() });
export type ErArrivalResponse = z.infer<typeof ErArrivalResponse>;

/* POST /v1/er/encounters/:id/triage · /assign */
export const ErTriageRequest = z.object({ level: TriageLevelNo, bayId: z.string().max(64).nullable().optional() });
export type ErTriageRequest = z.infer<typeof ErTriageRequest>;
export const ErAssignRequest = z.object({ doctorId: z.string().max(64), /** walkthrough issue #24: an adult to a paediatrician */ paediatricOk: z.boolean().optional() });
export type ErAssignRequest = z.infer<typeof ErAssignRequest>;

/* GET /v1/er/encounters/:id — orders & disposition */
export const ErOrder = z.object({ id: z.string(), testCode: z.string(), nameEn: z.string(), nameBn: z.string(), priority: OrderPriority, status: OrderStatus, orderedAt: z.string().nullable(), orderedBy: Person });
export const ErCareOrder = z.object({ key: z.string(), nameEn: z.string(), nameBn: z.string(), detail: z.string(), icon: z.string(), on: z.boolean(), at: z.string().nullable() });
export const AdmitBed = z.object({ id: z.string(), name: z.string(), ward: z.string(), wardBn: z.string().nullable(), bedClass: z.string(), state: BedStateWire, pickable: z.boolean(), reason: z.string().nullable() });
export const ErVisitView = z.object({
  item: ErBoardItem,
  patient: PatientSummary,
  allergies: z.array(AllergyView),
  note: z.object({ id: z.string(), status: DocStatus, rev: z.number().int(), version: z.number().int(), signedAt: z.string().nullable(), signedBy: Person.nullable(), notes: z.string() }),
  orders: z.array(ErOrder),
  careOrders: z.array(ErCareOrder),
  tests: z.array(TestItem),
  disposition: Disposition.nullable(),
  /** beds a ward admission may go to (every admission class), with why one cannot be picked */
  beds: z.array(AdmitBed),
  consultants: z.array(ErDoctor),
  scale: TriageScale,
  /** the sample care-order list is labelled sample on screen */
  sample: z.literal(true),
});
export type ErVisitView = z.infer<typeof ErVisitView>;
/* POST /v1/er/encounters/:id/orders (one tap STAT lab order) · /care-orders · /notes */
export const ErOrderRequest = z.object({ testCode: z.string().max(30) });
export const ErCareOrderRequest = z.object({ key: z.string().max(30), on: z.boolean() });
export const ErNotesRequest = z.object({ rev: z.number().int().min(1), notes: z.string().max(4000) });
/* POST /v1/er/encounters/:id/disposition — signs the ER note (PIN) */
export const ErDispositionRequest = z.object({ rev: z.number().int().min(1), pin: z.string().regex(/^\d{4}$/), disposition: Disposition });
export type ErDispositionRequest = z.infer<typeof ErDispositionRequest>;
