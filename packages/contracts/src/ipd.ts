/* Admission and beds (ADR 0014, slice B1–B2). The desk's Admit is one transaction: IPD encounter, bed occupied (the
   two-leg move completed), ADM/yy/nnnn, the IPD bill draft. Bed state changes only through BED. */
import { z } from "zod";
import { BedStateWire, ErPatient } from "./er.js";
import { PatientSummary } from "./frontdesk.js";

const Person = z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() });
export const AdmissionSource = z.enum(["opd", "er", "direct"]);
export const AdmissionStatus = z.enum(["requested", "admitted", "cancelled"]);
export const BedClassItem = z.object({ key: z.string(), nameBn: z.string(), nameEn: z.string(), perDayPaisa: z.number().int(), sample: z.literal(true) });
export const BedView = z.object({
  id: z.string(), name: z.string(), nameBn: z.string().nullable(),
  ward: z.object({ id: z.string(), name: z.string(), nameBn: z.string().nullable() }),
  bedClass: z.string(), state: BedStateWire, note: z.string().nullable(),
  /** the occupant, or who it is reserved for */
  patient: ErPatient.nullable(),
  assignment: z.object({ id: z.string(), status: z.enum(["reserved", "occupied"]), encounterId: z.string(), since: z.string(), /** the admission behind it (bed moves act on it) */ admissionId: z.string().nullable() }).nullable(),
});
export type BedView = z.infer<typeof BedView>;
/* GET /v1/ipd/beds?class= */
export const BedBoard = z.object({
  wards: z.array(z.object({ id: z.string(), name: z.string(), nameBn: z.string().nullable(), beds: z.array(BedView) })),
  classes: z.array(BedClassItem),
  counts: z.object({ vacant: z.number().int(), reserved: z.number().int(), occupied: z.number().int(), dischargePending: z.number().int(), cleaning: z.number().int(), blocked: z.number().int() }),
});
export type BedBoard = z.infer<typeof BedBoard>;
/* POST /v1/ipd/beds/:id/actions — block (reason), unblock, markReady */
export const BedActionRequest = z.object({ action: z.enum(["block", "unblock", "markReady"]), reason: z.string().trim().max(200).optional() });
export type BedActionRequest = z.infer<typeof BedActionRequest>;

export const ChecklistItem = z.object({ key: z.enum(["bed", "diagnosis", "guardian", "consents", "deposit"]), ok: z.boolean(), missing: z.number().int().optional(), blocks: z.boolean() });
export const Guardian = z.object({ name: z.string().trim().max(120), relationship: z.string().trim().max(40), phone: z.string().trim().max(30) });
/* GET /v1/ipd/admissions — requested (from the ER) and today's admitted; plus the form's options */
export const AdmissionItem = z.object({
  id: z.string(), status: AdmissionStatus, source: AdmissionSource, number: z.string().nullable(),
  patient: ErPatient, sourceEncounterId: z.string().nullable(), encounterId: z.string().nullable(),
  diagnosis: z.string(), department: z.string(), bedClass: z.string(),
  bed: z.object({ id: z.string(), name: z.string(), ward: z.string(), state: BedStateWire }),
  admittingDoctor: Person, requestedAt: z.string(), requestedBy: Person, admittedAt: z.string().nullable(),
});
export type AdmissionItem = z.infer<typeof AdmissionItem>;
export const AdmissionOptions = z.object({
  doctors: z.array(Person.extend({ speciality: z.string().nullable() })),
  departments: z.array(z.object({ key: z.string(), nameBn: z.string(), nameEn: z.string() })),
  consents: z.array(z.object({ key: z.string(), nameBn: z.string(), nameEn: z.string(), required: z.boolean() })),
  classes: z.array(BedClassItem),
});
export const AdmissionList = z.object({ requested: z.array(AdmissionItem), admitted: z.array(AdmissionItem), options: AdmissionOptions });
export type AdmissionList = z.infer<typeof AdmissionList>;

/* POST /v1/ipd/admissions — complete a request (admissionId) or admit directly (patientId) */
export const AdmitRequest = z.object({
  admissionId: z.string().max(64).optional(),
  patientId: z.string().max(64).optional(),
  source: AdmissionSource.optional(),
  sourceEncounterId: z.string().max(64).optional(),
  admittingDoctorId: z.string().max(64),
  department: z.string().trim().min(1).max(60),
  diagnosis: z.string().trim().max(300),
  bedClass: z.string().trim().min(1).max(40),
  bedId: z.string().max(64).nullable(),
  guardian: Guardian,
  consents: z.array(z.string().max(30)).max(10),
}).refine((r) => Boolean(r.admissionId) !== Boolean(r.patientId), { message: "request_or_patient", path: ["patientId"] });
export type AdmitRequest = z.infer<typeof AdmitRequest>;
export const AdmissionView = z.object({
  id: z.string(), number: z.string().nullable(), status: AdmissionStatus, source: AdmissionSource,
  patient: PatientSummary,
  encounter: z.object({ id: z.string(), status: z.string(), token: z.string() }).nullable(),
  sourceEncounter: z.object({ id: z.string(), class: z.string(), status: z.string(), token: z.string() }).nullable(),
  bed: BedView,
  admittingDoctor: Person.extend({ speciality: z.string().nullable() }), department: z.string(), diagnosis: z.string(), bedClass: z.string(),
  guardian: Guardian.nullable(), consents: z.array(z.string()),
  checklist: z.array(ChecklistItem),
  /** the IPD bill draft the admission opened (kind ipd); later slices add to it */
  invoice: z.object({ id: z.string(), kind: z.literal("ipd"), status: z.string(), number: z.string().nullable() }).nullable(),
  requestedAt: z.string(), requestedBy: Person, admittedAt: z.string().nullable(), admittedBy: Person.nullable(),
  /** the move's two legs, oldest first */
  legs: z.array(z.object({ id: z.string(), bed: z.string(), status: z.enum(["reserved", "occupied", "ended"]), transferId: z.string(), at: z.string(), endReason: z.string().nullable() })),
});
export type AdmissionView = z.infer<typeof AdmissionView>;
/* GET /v1/ipd/admissions/:id · POST /v1/ipd/admissions/:id/cancel */
export const AdmissionCancelRequest = z.object({ reason: z.string().trim().min(5).max(300) });
