/* The ward (ADR 0015, slice B3–B4): nursing rounds with NEWS2, escalations, nursing notes, the MAR, the doctor's ward
   round note with inpatient orders, ward indents and ward stock, bed moves. The NEWS2 threshold, the dose window and
   the high-alert list are samples pending clinician sign-off; answers that carry them say so. Doses, signing, issues
   and moves need the server; vitals and notes may wait in the outbox with their device time. */
import { z } from "zod";
import { AllergyView, DocStatus, OrderPriority, OrderStatus } from "./consultation.js";
import { BedStateWire, ErPatient } from "./er.js";
import { PatientSummary } from "./frontdesk.js";
import { VitalsBatch, VitalsValues } from "./vitals.js";

const Person = z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() });
const SampleNote = z.object({ bn: z.string(), en: z.string() });
export const Consciousness = z.enum(["A", "C", "V", "P", "U"]);
export const News2 = z.object({
  total: z.number().int(), red: z.boolean(), complete: z.boolean(), risk: z.enum(["low", "low-medium", "medium", "high"]),
  parts: z.record(z.number().int()), missing: z.array(z.string()), at: z.string(),
});
export type News2 = z.infer<typeof News2>;
export const EscalationStatusWire = z.enum(["raised", "doctor-informed", "resolved"]);
export const Escalation = z.object({
  id: z.string(), status: EscalationStatusWire, score: z.number().int(), peakScore: z.number().int(), red: z.boolean(),
  raisedAt: z.string(), raisedBy: Person, informedAt: z.string().nullable(), informedBy: Person.nullable(), spokeTo: z.string().nullable(), instruction: z.string().nullable(),
  resolvedAt: z.string().nullable(), resolvedBy: Person.nullable(), resolveNote: z.string().nullable(),
});
export type Escalation = z.infer<typeof Escalation>;
export const NursingNoteView = z.object({ id: z.string(), text: z.string(), writtenBy: Person, writtenAt: z.string(), effectiveAt: z.string(), status: z.enum(["active", "entered-in-error"]), error: z.object({ reason: z.string(), by: Person, at: z.string() }).nullable() });
export type NursingNoteView = z.infer<typeof NursingNoteView>;
const Rule = z.object({ threshold: z.number().int(), sample: z.literal(true), note: SampleNote });

/* GET /v1/nursing/wards · /v1/nursing/wards/:wardId/board */
export const WardList = z.object({ wards: z.array(z.object({ id: z.string(), name: z.string(), nameBn: z.string().nullable(), beds: z.number().int(), occupied: z.number().int() })) });
export type WardList = z.infer<typeof WardList>;
export const WardBoardBed = z.object({
  bed: z.object({ id: z.string(), name: z.string(), state: BedStateWire, note: z.string().nullable(), bedClass: z.string() }),
  patient: ErPatient.nullable(), encounterId: z.string().nullable(), admissionId: z.string().nullable(), admissionNumber: z.string().nullable(),
  doctor: Person.nullable(), day: z.number().int().nullable(), allergies: z.array(z.string()).nullable(),
  news2: News2.nullable(), nextObsDueAt: z.string().nullable(), obsOverdue: z.boolean(),
  escalation: Escalation.nullable(),
  doses: z.object({ due: z.number().int(), overdue: z.number().int() }),
  /** a reservation from a move (leg 1) waiting for arrival */
  arriving: z.object({ admissionId: z.string(), patient: ErPatient, fromBed: z.string() }).nullable(),
});
export type WardBoardBed = z.infer<typeof WardBoardBed>;
export const WardBoard = z.object({
  ward: z.object({ id: z.string(), name: z.string(), nameBn: z.string().nullable() }),
  beds: z.array(WardBoardBed),
  /** the banner: open escalations on this ward */
  escalations: z.array(z.object({ encounterId: z.string(), bed: z.string(), patient: ErPatient, escalation: Escalation })),
  rule: Rule,
});
export type WardBoard = z.infer<typeof WardBoard>;

/* POST /v1/nursing/encounters/:id/vitals — the A4 values plus RR, consciousness and oxygen; NEWS2 on the server too */
export const WardVitalsValues = VitalsValues.extend({ rr: z.number().finite().optional(), consciousness: Consciousness.optional(), onOxygen: z.boolean().optional() });
export const WardVitalsRequest = z.object({
  values: WardVitalsValues, effectiveAt: z.string().datetime(), deviceLabel: z.string().max(60).optional(),
  confirmed: z.array(z.enum(["bp", "pulse", "temp", "spo2", "rbs", "weight", "height"])).max(7).optional(),
});
export type WardVitalsRequest = z.infer<typeof WardVitalsRequest>;
export const WardVitalsResponse = z.object({ batch: VitalsBatch, news2: News2, escalation: Escalation.nullable(), escalated: z.boolean(), nextObsDueAt: z.string(), rule: Rule });
export type WardVitalsResponse = z.infer<typeof WardVitalsResponse>;
export const EscalationInformRequest = z.object({ spokeTo: z.string().trim().max(120), instruction: z.string().trim().max(500) });
export const EscalationResolveRequest = z.object({ note: z.string().trim().max(500) });
export const NursingNoteRequest = z.object({ text: z.string().max(4000), effectiveAt: z.string().datetime() });
export const ReasonRequest = z.object({ reason: z.string().trim().max(500) });

/* GET /v1/nursing/encounters/:id — the patient on the ward: vitals history (72 h), escalations, notes */
export const WardPatientView = z.object({
  encounterId: z.string(), admissionId: z.string(), admissionNumber: z.string().nullable(), patient: PatientSummary, allergies: z.array(AllergyView),
  bed: z.object({ id: z.string(), name: z.string(), ward: z.string() }).nullable(), doctor: Person.nullable(), day: z.number().int(),
  vitals: z.array(z.object({ batch: VitalsBatch, news2: News2.nullable() })), nextObsDueAt: z.string().nullable(),
  escalations: z.array(Escalation), notes: z.array(NursingNoteView), rule: Rule,
});
export type WardPatientView = z.infer<typeof WardPatientView>;

/* ───── the MAR ───── */
export const DoseOutcome = z.enum(["given", "held", "refused", "missed"]);
export const DoseSource = z.enum(["ward-stock", "patient-supplied"]);
export const FiveChecks = z.object({ patient: z.boolean(), drug: z.boolean(), dose: z.boolean(), route: z.boolean(), time: z.boolean() });
export const DoseRecord = z.object({
  id: z.string(), status: z.enum(["given", "held", "refused", "missed", "entered-in-error"]), administeredAt: z.string(), scheduledFor: z.string().nullable(),
  timing: z.enum(["on-time", "early", "late", "prn"]), reason: z.string().nullable(), source: DoseSource, by: Person, preparedBy: Person, witness: Person.nullable(),
  checks: FiveChecks, error: z.object({ reason: z.string(), by: Person, at: z.string() }).nullable(),
});
export type DoseRecord = z.infer<typeof DoseRecord>;
export const WardMedicineWire = z.object({ key: z.string(), brand: z.string(), brandBn: z.string(), generic: z.string(), strength: z.string(), form: z.string(), issueUnit: z.string(), routes: z.array(z.string()), highAlert: z.boolean(), controlled: z.boolean(), multiDose: z.boolean(), inpatientOnly: z.boolean(), sample: z.literal(true) });
export const MedOrderStatus = z.enum(["active", "stopped", "superseded", "completed"]);
export const InpatientOrder = z.object({
  id: z.string(), regimenId: z.string(), noteId: z.string(), medicine: WardMedicineWire, route: z.string(), doseText: z.string(), doseQty: z.number().int().nullable(),
  times: z.array(z.string()), prn: z.boolean(), prnMaxPer24h: z.number().int().nullable(), startAt: z.string(), status: MedOrderStatus, orderedBy: Person,
  stop: z.object({ by: Person, at: z.string(), reason: z.string() }).nullable(),
});
export type InpatientOrder = z.infer<typeof InpatientOrder>;
export const MarSlot = z.object({ at: z.string(), state: z.enum(["scheduled", "due", "overdue", "given", "held", "refused", "missed"]), record: DoseRecord.nullable() });
export const MarOrder = InpatientOrder.extend({
  slots: z.array(MarSlot), prnRecords: z.array(DoseRecord), givenLast24h: z.number().int(),
  vial: z.object({ openedAt: z.string(), by: Person, source: DoseSource }).nullable(),
  /** an active allergy now matches the drug: giving is blocked until the doctor reviews */
  allergyBlock: z.boolean(), wardStock: z.number().int(),
  /** doses of this drug recorded under an earlier regimen in the last 24 h (context when a change started a new one) */
  earlierRegimenGiven: z.array(z.object({ at: z.string(), doseText: z.string() })),
});
export type MarOrder = z.infer<typeof MarOrder>;
export const MarView = z.object({
  encounterId: z.string(), patient: PatientSummary, allergies: z.array(AllergyView), bed: z.object({ id: z.string(), name: z.string(), ward: z.string(), wardId: z.string() }).nullable(),
  day: z.string(), now: z.string(), orders: z.array(MarOrder), windowMin: z.number().int(), sample: SampleNote,
  /** errored and earlier records of the day, for the history list */
  history: z.array(DoseRecord.extend({ orderId: z.string(), medicine: z.string() })),
});
export type MarView = z.infer<typeof MarView>;
export const DoseRequest = z.object({
  requestId: z.string().max(64), scheduledFor: z.string().datetime().nullable(), outcome: DoseOutcome, administeredAt: z.string().datetime(),
  checks: FiveChecks, reason: z.string().trim().max(500).optional(), source: DoseSource.default("ward-stock"), preparedById: z.string().max(64).optional(),
  /** high-alert drugs: a second nurse or a doctor, never the giver or the preparer; the PIN is checked in the dose's transaction and never stored */
  witness: z.object({ userId: z.string().max(64), pin: z.string().regex(/^\d{4}$/) }).optional(),
});
export type DoseRequest = z.infer<typeof DoseRequest>;
export const VialOpenRequest = z.object({ requestId: z.string().max(64), openedAt: z.string().datetime(), source: DoseSource.default("ward-stock") });
export const WitnessList = z.object({ items: z.array(Person.extend({ role: z.enum(["nurse", "doctor"]) })) });
export type WitnessList = z.infer<typeof WitnessList>;

/* ───── the doctor's ward round ───── */
export const RoundSections = z.object({ s: z.string().max(4000), o: z.string().max(4000), a: z.string().max(4000), p: z.string().max(4000) });
export const InpatientLineInput = z.object({
  medicineKey: z.string().max(60), route: z.string().max(10), doseText: z.string().trim().max(120), doseQty: z.number().int().nullable(),
  times: z.array(z.string().max(5)).max(24), prn: z.boolean(), prnMaxPer24h: z.number().int().nullable(),
  note: z.string().trim().max(200).optional(), keepBoth: z.boolean().optional(), acks: z.array(z.string().max(60)).max(10).optional(),
});
export type InpatientLineInput = z.infer<typeof InpatientLineInput>;
export const RoundNote = z.object({
  id: z.string(), threadId: z.string(), version: z.number().int(), status: DocStatus, rev: z.number().int(), sections: RoundSections,
  lines: z.array(InpatientLineInput.extend({ id: z.string(), status: MedOrderStatus, regimenId: z.string().nullable(), continuesId: z.string().nullable() })),
  labOrders: z.array(z.object({ id: z.string(), testCode: z.string(), nameEn: z.string(), nameBn: z.string(), priority: OrderPriority, status: OrderStatus })),
  author: Person, signedAt: z.string().nullable(), signedBy: Person.nullable(), amendsId: z.string().nullable(), amendReason: z.string().nullable(), createdAt: z.string(),
});
export type RoundNote = z.infer<typeof RoundNote>;
export const RoundWorklistItem = z.object({
  encounterId: z.string(), admissionId: z.string(), admissionNumber: z.string().nullable(), patient: ErPatient, bed: z.string().nullable(), ward: z.string().nullable(), day: z.number().int(),
  news2: News2.nullable(), escalation: Escalation.nullable(), missedLast24h: z.number().int(), notesSinceRound: z.number().int(),
  lastRoundAt: z.string().nullable(), draftId: z.string().nullable(), mine: z.boolean(),
});
export const RoundWorklist = z.object({ items: z.array(RoundWorklistItem), rule: Rule });
export type RoundWorklist = z.infer<typeof RoundWorklist>;
export const RoundView = z.object({
  encounterId: z.string(), admissionId: z.string(), admissionNumber: z.string().nullable(), patient: PatientSummary, allergies: z.array(AllergyView),
  bed: z.object({ name: z.string(), ward: z.string() }).nullable(), day: z.number().int(), diagnosis: z.string(),
  overnight: z.object({
    vitals: z.array(z.object({ at: z.string(), news2: News2.nullable(), summary: z.string() })), escalations: z.array(Escalation), notes: z.array(NursingNoteView),
    doses: z.array(z.object({ medicine: z.string(), status: z.string(), at: z.string(), timing: z.string(), reason: z.string().nullable() })),
  }),
  activeOrders: z.array(InpatientOrder), draft: RoundNote.nullable(), signed: z.array(RoundNote), rule: Rule,
});
export type RoundView = z.infer<typeof RoundView>;
export const SaveRoundRequest = z.object({ rev: z.number().int().min(1), sections: RoundSections, lines: z.array(InpatientLineInput).max(30), orders: z.array(z.object({ testCode: z.string().max(30), priority: OrderPriority })).max(30) });
export type SaveRoundRequest = z.infer<typeof SaveRoundRequest>;
export const SignRoundRequest = z.object({ rev: z.number().int().min(1), pin: z.string().regex(/^\d{4}$/) });
export const AmendRoundRequest = z.object({ reason: z.string().trim().max(300) });
export const StopOrderRequest = z.object({ reason: z.string().trim().max(300), pin: z.string().regex(/^\d{4}$/) });
export const WardMedicineList = z.object({ items: z.array(WardMedicineWire) });

/* ───── ward stock and indents ───── */
export const IndentStatusWire = z.enum(["requested", "partially-issued", "issued", "cancelled"]);
export const IndentCreate = z.object({ lines: z.array(z.object({ medicineKey: z.string().max(60), qty: z.number().int() })).max(30), note: z.string().trim().max(300).optional() });
export type IndentCreate = z.infer<typeof IndentCreate>;
export const IndentView = z.object({
  id: z.string(), number: z.string(), status: IndentStatusWire, ward: z.object({ id: z.string(), name: z.string() }), note: z.string().nullable(), requestedBy: Person, requestedAt: z.string(),
  lines: z.array(z.object({ id: z.string(), medicineKey: z.string(), name: z.string(), issueUnit: z.string(), controlled: z.boolean(), requested: z.number().int(), issued: z.number().int(), storeAvailable: z.number().int() })),
  issues: z.array(z.object({ lineId: z.string(), qty: z.number().int(), by: Person, at: z.string() })),
  cancel: z.object({ by: Person, reason: z.string() }).nullable(),
});
export type IndentView = z.infer<typeof IndentView>;
export const IndentList = z.object({ items: z.array(IndentView) });
export type IndentList = z.infer<typeof IndentList>;
export const IndentIssueRequest = z.object({ lines: z.array(z.object({ lineId: z.string().max(64), qty: z.number().int().min(1).max(500) })).min(1).max(30), pin: z.string().regex(/^\d{4}$/).optional() });
export type IndentIssueRequest = z.infer<typeof IndentIssueRequest>;
export const WardStock = z.object({ ward: z.object({ id: z.string(), name: z.string() }), items: z.array(z.object({ medicineKey: z.string(), name: z.string(), issueUnit: z.string(), controlled: z.boolean(), qty: z.number().int(), batches: z.array(z.object({ batchNo: z.string(), expiry: z.string(), qty: z.number().int() })) })) });
export type WardStock = z.infer<typeof WardStock>;

/* ───── bed moves ───── */
export const BedMoveRequest = z.object({ bedId: z.string().max(64), reason: z.string().trim().max(300), handoverNote: z.string().trim().max(1000).optional(), mode: z.enum(["now", "reserve"]) });
export type BedMoveRequest = z.infer<typeof BedMoveRequest>;
