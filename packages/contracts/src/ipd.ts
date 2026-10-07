/* Admission and beds (ADR 0014, slice B1–B2). The desk's Admit is one transaction: IPD encounter, bed occupied (the
   two-leg move completed), ADM/yy/nnnn, the IPD bill draft. Bed state changes only through BED. */
import { z } from "zod";
import { BedStateWire, ErPatient } from "./er.js";
import { PatientSummary } from "./frontdesk.js";
import { AllergyView, DiagnosisView, DocStatus, Meal, MedicationView } from "./consultation.js";
import { Escalation } from "./ward.js";

const Person = z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() });
export const AdmissionSource = z.enum(["opd", "er", "direct"]);
export const AdmissionStatus = z.enum(["requested", "admitted", "cancelled", "discharged"]);
/** ADR 0017: the facility's rate (BedClassRate); `sample` until the owner sets it */
export const BedClassItem = z.object({ key: z.string(), nameBn: z.string(), nameEn: z.string(), perDayPaisa: z.number().int(), sample: z.boolean() });
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
  /** ADR 0017: the packages a patient can be admitted on (price per class) */
  packages: z.array(z.object({ id: z.string(), code: z.string(), nameEn: z.string(), nameBn: z.string(), days: z.number().int(), prices: z.record(z.string(), z.number().int()), sample: z.boolean() })),
  /** the payment methods the facility takes (for the deposit at the desk) */
  paymentMethods: z.array(z.enum(["cash", "card", "bank", "bkash", "nagad"])),
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
  /** ADR 0017: the package (optional) and a deposit taken at the desk (optional, never blocking) */
  packageId: z.string().max(64).optional(),
  deposit: z.object({ method: z.enum(["cash", "card", "bank"]), amountPaisa: z.number().int().min(1).max(50_000_000), tenderedPaisa: z.number().int().min(1).max(100_000_000).optional(), reference: z.string().trim().max(60).optional() }).optional(),
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
  /** the IPD bill draft the admission opened (kind ipd): the running bill (ADR 0017) */
  invoice: z.object({ id: z.string(), kind: z.literal("ipd"), status: z.string(), number: z.string().nullable() }).nullable(),
  requestedAt: z.string(), requestedBy: Person, admittedAt: z.string().nullable(), admittedBy: Person.nullable(),
  /** the move's two legs, oldest first */
  legs: z.array(z.object({ id: z.string(), bed: z.string(), status: z.enum(["reserved", "occupied", "ended"]), transferId: z.string(), at: z.string(), endReason: z.string().nullable() })),
});
export type AdmissionView = z.infer<typeof AdmissionView>;
/* GET /v1/ipd/admissions/:id · POST /v1/ipd/admissions/:id/cancel */
export const AdmissionCancelRequest = z.object({ reason: z.string().trim().min(5).max(300) });

/* ───── ADR 0017: the IPD running bill (bill/ipd) ───── */
export const IpdTag = z.enum(["package", "included", "excluded"]);
export const DepositStateWire = z.enum(["ok", "low", "due"]);
const PackageItemView = z.object({ kind: z.enum(["service", "medicine", "excluded"]), code: z.string().nullable(), limit: z.number().int().nullable(), nameEn: z.string(), nameBn: z.string() });
export const PackageView = z.object({ id: z.string(), code: z.string(), nameEn: z.string(), nameBn: z.string(), days: z.number().int(), prices: z.record(z.string(), z.number().int()), items: z.array(PackageItemView), sample: z.boolean() });
export type PackageView = z.infer<typeof PackageView>;
/* GET /v1/ipd/packages — read-only in this slice (bill/pkg) */
export const PackageList = z.object({ items: z.array(PackageView) });
export type PackageList = z.infer<typeof PackageList>;
export const IpdLine = z.object({
  id: z.string(), key: z.string(), source: z.enum(["package", "bed-day", "order", "stock", "desk"]), tag: IpdTag, code: z.string(),
  nameEn: z.string(), nameBn: z.string(), qty: z.number().int(), unitPaisa: z.number().int().nullable(), vatRateBp: z.number().int(), totalPaisa: z.number().int(),
  serviceDay: z.string().nullable(), dayNo: z.number().int().nullable(), bedClass: z.string().nullable(),
  /** posted by the census or a sync (shown "Auto"), or by a person */ auto: z.boolean(), postedBy: Person.nullable(), postedAt: z.string(),
  /** a re-priced line stays, struck through, with why */ superseded: z.object({ at: z.string(), reason: z.string() }).nullable(),
  /** a credit line (negative) and the line it reverses */ creditOf: z.string().nullable(), credited: z.boolean(),
});
export type IpdLine = z.infer<typeof IpdLine>;
export const DepositView = z.object({
  id: z.string(), method: z.enum(["cash", "card", "bank", "bkash", "nagad"]), status: z.enum(["initiated", "link-sent", "waiting-customer", "confirmed", "failed"]),
  amountPaisa: z.number().int(), trxId: z.string().nullable(), reference: z.string().nullable(),
  /** a link: who it went to and the last four digits */ to: z.enum(["patient", "guardian"]).nullable(), phoneLast4: z.string().nullable(), payUrl: z.string().nullable(),
  createdBy: Person, createdAt: z.string(), confirmedAt: z.string().nullable(), failReason: z.string().nullable(),
  receipt: z.object({ id: z.string(), number: z.string() }).nullable(),
  /** ADR 0018: taken at the counter against the issued final bill (not a deposit) */ atCounter: z.boolean(),
});
export type DepositView = z.infer<typeof DepositView>;
export const IpdBillView = z.object({
  admission: z.object({
    id: z.string(), number: z.string(), status: AdmissionStatus, admittedAt: z.string(), dayNo: z.number().int(), bedClass: z.string(),
    bed: z.object({ name: z.string(), ward: z.string(), state: BedStateWire }).nullable(), department: z.string(), doctor: Person, dischargedAt: z.string().nullable(),
  }),
  patient: PatientSummary, guardian: Guardian.nullable(),
  invoice: z.object({ id: z.string(), status: z.string(), number: z.string().nullable() }),
  package: PackageView.extend({ bedClass: z.string().nullable(), pricePaisa: z.number().int().nullable(), appliedBy: Person, appliedAt: z.string() }).nullable(),
  lines: z.array(IpdLine),
  totals: z.object({ packagePaisa: z.number().int(), excludedPaisa: z.number().int(), includedLines: z.number().int(), subtotalPaisa: z.number().int(), vatPaisa: z.number().int(), totalPaisa: z.number().int(), unpriced: z.number().int() }),
  deposits: z.object({ items: z.array(DepositView), confirmedPaisa: z.number().int(), pendingPaisa: z.number().int() }),
  /** deposits confirmed − the patient's share; low / due against the current class's daily rate */
  balancePaisa: z.number().int(), depositState: DepositStateWire, perDayPaisa: z.number().int(), suggestedTopUpPaisa: z.number().int(),
  classes: z.array(BedClassItem),
  paymentMethods: z.array(z.enum(["cash", "card", "bank", "bkash", "nagad"])),
  discharge: z.object({ id: z.string(), status: z.enum(["ordered", "completed", "cancelled"]), done: z.number().int(), total: z.number().int() }).nullable(),
  /** ADR 0018: what still stops the final bill (draft only): no discharge recorded, an unpriced line, a payment link pending */
  issueBlockers: z.array(z.enum(["already_issued", "not_ordered", "unpriced", "link_pending"])),
  /** the issued final bill: deposits applied, the excess refunded, the shortfall due, by category */
  final: z.object({
    number: z.string(), issuedAt: z.string(), issuedBy: Person, status: z.enum(["issued", "partially-paid", "balanced"]),
    depositsPaisa: z.number().int(), excessPaisa: z.number().int(), netPaidPaisa: z.number().int(), duePaisa: z.number().int(),
    categories: z.array(z.object({ category: z.enum(["package", "bed", "tests", "medicines", "services"]), lines: z.number().int(), netPaisa: z.number().int(), vatPaisa: z.number().int(), totalPaisa: z.number().int() })),
    excessRefund: z.object({ id: z.string(), status: z.enum(["requested", "approved", "paid"]), amountPaisa: z.number().int(), paidPaisa: z.number().int() }).nullable(),
    receipts: z.array(z.object({ id: z.string(), number: z.string(), createdAt: z.string(), paidPaisa: z.number().int(), duePaisa: z.number().int() })),
    /** what the sources say changed after the bill was issued (a dose marked in error, a bed day past the bill): settled by
        refund or by the owner, never by editing the bill (Kamrul, 2) */
    afterIssue: z.array(z.object({ kind: z.enum(["credit", "add", "change"]), key: z.string(), nameEn: z.string(), nameBn: z.string(), amountPaisa: z.number().int() })),
  }).nullable(),
  can: z.object({ deposit: z.boolean(), postCharge: z.boolean(), applyPackage: z.boolean(), issue: z.boolean(), pay: z.boolean(), receipt: z.boolean() }),
  sample: z.object({ rates: z.boolean(), package: z.boolean() }),
});
export type IpdBillView = z.infer<typeof IpdBillView>;
/* GET /v1/ipd/bills — the running bills of this facility (admitted, or discharged with the bill still a draft) */
export const IpdBillList = z.object({ items: z.array(z.object({
  admissionId: z.string(), number: z.string(), patient: ErPatient, bed: z.string().nullable(), ward: z.string().nullable(), bedClass: z.string(), dayNo: z.number().int(),
  status: AdmissionStatus, packageName: z.object({ nameEn: z.string(), nameBn: z.string() }).nullable(),
  totalPaisa: z.number().int(), depositsPaisa: z.number().int(), balancePaisa: z.number().int(), depositState: DepositStateWire,
  discharge: z.object({ status: z.enum(["ordered", "completed"]), done: z.number().int() }).nullable(),
  /** ADR 0018: the final bill once issued (still listed while money is due or the excess deposit is unpaid) */
  bill: z.enum(["draft", "issued", "partially-paid", "balanced"]), invoiceNumber: z.string().nullable(), duePaisa: z.number().int(), excessOpenPaisa: z.number().int(),
})) });
export type IpdBillList = z.infer<typeof IpdBillList>;
/* POST /v1/ipd/bills/:admissionId/interim-prints — the interim bill (A4, "not a final bill", no QR); a reprint needs a reason */
export const InterimPrintRequest = z.object({ lang: z.enum(["both", "bn", "en"]).default("both"), reason: z.enum(["lost", "jam", "ins", "corp"]).optional() });
export type InterimPrintRequest = z.infer<typeof InterimPrintRequest>;
export const InterimPrintView = z.object({ id: z.string(), copy: z.number().int(), reason: z.string().nullable(), lang: z.string(), printedBy: Person, printedAt: z.string(), pdfUrl: z.string(), totalPaisa: z.number().int() });
export type InterimPrintView = z.infer<typeof InterimPrintView>;
export const InterimPrintList = z.object({ items: z.array(InterimPrintView) });
export type InterimPrintList = z.infer<typeof InterimPrintList>;
/* GET /v1/ipd/bills/:admissionId/preview?to=<class> — read-only arithmetic (classes change only through the bed move) */
export const ClassPreviewView = z.object({
  from: z.string(), to: z.string(), direction: z.enum(["up", "down", "same"]), appliesFrom: z.enum(["today", "tomorrow"]),
  perDayFromPaisa: z.number().int(), perDayToPaisa: z.number().int(), packageFromPaisa: z.number().int().nullable(), packageToPaisa: z.number().int().nullable(),
  extraPaisa: z.number().int(), estDays: z.number().int(),
});
export type ClassPreviewView = z.infer<typeof ClassPreviewView>;
/* POST /v1/ipd/bills/:admissionId/charges — a charge from the price list (procedures, transfusion, consults) */
export const IpdChargeRequest = z.object({ code: z.string().trim().min(1).max(80), qty: z.number().int().min(1).max(99) });
export type IpdChargeRequest = z.infer<typeof IpdChargeRequest>;
/* POST /v1/ipd/bills/:admissionId/package — while the bill has none */
export const IpdPackageRequest = z.object({ packageId: z.string().max(64) });
export type IpdPackageRequest = z.infer<typeof IpdPackageRequest>;
/* POST /v1/ipd/bills/:admissionId/deposits — cash / card / bank, or a bKash link to the guardian or the patient */
export const DepositRequest = z.object({
  method: z.enum(["cash", "card", "bank", "bkash", "nagad"]), amountPaisa: z.number().int().min(1).max(50_000_000),
  tenderedPaisa: z.number().int().min(1).max(100_000_000).optional(), reference: z.string().trim().max(60).optional(),
  /** a wallet link: whose phone (default the guardian on the admission) */ to: z.enum(["patient", "guardian"]).optional(),
});
export type DepositRequest = z.infer<typeof DepositRequest>;
/* POST /v1/ipd/deposits/:paymentId/receipt — the money receipt for a confirmed deposit (the same one again if it exists) */
export const DepositReceiptSnapshot = z.object({
  seller: z.object({ nameEn: z.string(), nameBn: z.string().nullable(), address: z.string().nullable() }),
  patient: z.object({ nameBn: z.string(), nameEn: z.string(), facilityNo: z.string() }),
  admission: z.object({ number: z.string(), bed: z.string().nullable() }),
  amountPaisa: z.number().int(), method: z.string(), trxId: z.string().nullable(), reference: z.string().nullable(), paidAt: z.string(),
  depositsToDatePaisa: z.number().int(), cashier: z.object({ nameBn: z.string(), nameEn: z.string() }),
});
export type DepositReceiptSnapshot = z.infer<typeof DepositReceiptSnapshot>;
export const DepositReceiptView = z.object({ id: z.string(), number: z.string(), verifyCode: z.string(), createdAt: z.string(), snapshot: DepositReceiptSnapshot, prints: z.number().int() });
export type DepositReceiptView = z.infer<typeof DepositReceiptView>;

/* ───── ADR 0017: the discharge checklist (ipd/discharge) ───── */
export const DischargeStepKey = z.enum(["order", "summary", "pharmacy", "final-bill", "payment", "bed-release"]);
/** ADR 0018: normal (the doctor's order), LAMA (the doctor's record), death on the ward */
export const DischargeKind = z.enum(["normal", "lama", "death"]);
export const DischargeStepView = z.object({
  key: DischargeStepKey, status: z.enum(["waiting", "in-progress", "done"]), department: z.enum(["doctor", "pharmacy", "billing", "ward"]),
  nameEn: z.string(), nameBn: z.string(), waitsFor: z.array(DischargeStepKey),
  startedAt: z.string().nullable(), takenBy: Person.nullable(), doneBy: Person.nullable(), doneAt: z.string().nullable(),
  /** done by hand with a PIN before B10 (history only) */ byHand: z.boolean(), /** finishes by its event (summary signed, bill issued, bill settled) */ byEvent: z.boolean(), note: z.string().nullable(),
  reminded: z.object({ by: Person, at: z.string(), count: z.number().int() }).nullable(),
  blocking: z.boolean(),
  can: z.object({ take: z.boolean(), done: z.boolean(), remind: z.boolean() }),
});
export type DischargeStepView = z.infer<typeof DischargeStepView>;
export const DischargeView = z.object({
  discharge: z.object({
    id: z.string(), kind: DischargeKind, status: z.enum(["ordered", "completed", "cancelled"]), advice: z.string(), targetAt: z.string(), overdue: z.boolean(),
    orderedBy: Person, orderedAt: z.string(), completedAt: z.string().nullable(),
    cancel: z.object({ by: Person, at: z.string(), reason: z.string() }).nullable(),
    /** LAMA: risks explained, form signed, the witness; death: time, medico-legal, checks */ record: z.record(z.unknown()).nullable(),
  }),
  admission: z.object({ id: z.string(), number: z.string(), bed: z.string().nullable(), ward: z.string().nullable(), dayNo: z.number().int(), doctor: Person, encounterId: z.string(),
    visitFinished: z.boolean(), outcome: z.enum(["lama", "deceased"]).nullable() }),
  patient: PatientSummary,
  steps: z.array(DischargeStepView),
  header: z.object({ done: z.number().int(), total: z.number().int(), blockedBy: z.array(z.object({ key: DischargeStepKey, department: z.enum(["doctor", "pharmacy", "billing", "ward"]), person: Person.nullable() })), complete: z.boolean() }),
  can: z.object({ cancel: z.boolean() }),
  /** review (B10–B12): the visit's escalations still open — they stop the summary's signature and a normal "patient left";
      shown here so the ward can close them even after a LAMA patient or a body has left */
  escalations: z.array(Escalation),
});
export type DischargeView = z.infer<typeof DischargeView>;
/* GET /v1/ipd/discharges — the live discharges of this facility (each department's list) */
export const DischargeList = z.object({ items: z.array(z.object({
  id: z.string(), kind: DischargeKind, admissionId: z.string(), number: z.string(), patient: ErPatient, bed: z.string().nullable(), ward: z.string().nullable(),
  status: z.enum(["ordered", "completed", "cancelled"]), done: z.number().int(), total: z.number().int(), targetAt: z.string(), overdue: z.boolean(),
  blockedBy: z.array(z.object({ key: DischargeStepKey, department: z.enum(["doctor", "pharmacy", "billing", "ward"]), person: Person.nullable() })),
  /** the steps this user can act on now */ mine: z.array(DischargeStepKey), orderedAt: z.string(), completedAt: z.string().nullable(),
  /** ADR 0018: the summary step (null for a death — it has none) */ summary: z.enum(["waiting", "in-progress", "done"]).nullable(),
})),
  /** a doctor's list: admitted patients with no discharge ordered (to order one) */
  candidates: z.array(z.object({ admissionId: z.string(), number: z.string(), patient: ErPatient, bed: z.string().nullable(), ward: z.string().nullable(), dayNo: z.number().int(), doctor: Person })),
});
export type DischargeList = z.infer<typeof DischargeList>;
/* POST /v1/ipd/admissions/:id/discharge — the doctor's order (PIN) */
export const DischargeOrderRequest = z.object({ advice: z.string().trim().min(10).max(1000), targetAt: z.string().datetime({ offset: true }).optional(), pin: z.string().regex(/^\d{4}$/) });
export type DischargeOrderRequest = z.infer<typeof DischargeOrderRequest>;
/* POST /v1/ipd/discharges/:id/cancel — the doctor, before the bed is released */
export const DischargeCancelRequest = z.object({ reason: z.string().trim().min(10).max(300), pin: z.string().regex(/^\d{4}$/) });
export type DischargeCancelRequest = z.infer<typeof DischargeCancelRequest>;
/* POST /v1/ipd/discharges/:id/steps/:key/done — PIN; pharmacy: the patient's own medicines; patient left / body moved: the time */
export const DischargeStepDoneRequest = z.object({ pin: z.string().regex(/^\d{4}$/), note: z.string().trim().max(300).optional(), ownMedicines: z.enum(["handed-back", "none"]).optional(),
  at: z.string().datetime({ offset: true }).optional() });
export type DischargeStepDoneRequest = z.infer<typeof DischargeStepDoneRequest>;
/* POST /v1/ipd/admissions/:id/lama — the doctor's LAMA record (PIN; decision 14) */
export const LamaRequest = z.object({ reason: z.string().trim().min(10).max(1000), risksExplained: z.boolean(), formSigned: z.boolean(), witnessId: z.string().nullable(),
  /** review (B10–B12): the witness confirms with their own PIN, never stored */ witnessPin: z.string().regex(/^\d{4}$/), pin: z.string().regex(/^\d{4}$/) });
export type LamaRequest = z.infer<typeof LamaRequest>;
/* POST /v1/ipd/admissions/:id/death — a death on the ward (PIN; decision 15; the ER's checks) */
export const DeathRecordRequest = z.object({ timeOfDeath: z.string().datetime({ offset: true }), cause: z.string().trim().min(3).max(500), medicoLegal: z.boolean(),
  checks: z.array(z.string().max(40)).max(10), pin: z.string().regex(/^\d{4}$/) });
export type DeathRecordRequest = z.infer<typeof DeathRecordRequest>;

/* ───── ADR 0018 (B11): the discharge summary (Composition kind discharge-summary; amend, never overwrite) ───── */
export const SummarySections = z.object({
  course: z.string().max(4000),
  procedures: z.array(z.object({ name: z.string().trim().min(2).max(200), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), surgeon: z.string().trim().max(120) })).max(10),
  followUp: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), place: z.string().trim().max(200) }),
  redFlags: z.array(z.string().trim().min(2).max(200)).max(12),
});
export type SummarySections = z.infer<typeof SummarySections>;
export const SummaryDoc = z.object({
  id: z.string(), threadId: z.string(), version: z.number().int(), status: DocStatus, rev: z.number().int(),
  sections: SummarySections, diagnoses: z.array(DiagnosisView), medicines: z.array(MedicationView),
  author: Person, signedAt: z.string().nullable(), signedBy: Person.nullable(), amendsId: z.string().nullable(), amendReason: z.string().nullable(), createdAt: z.string(),
});
export type SummaryDoc = z.infer<typeof SummaryDoc>;
export const SummaryBlocker = z.enum(["diagnosis_final", "course", "follow_up", "red_flags", "critical_unacked", "escalation_open", "rx_warnings"]);
/* GET /v1/ipd/admissions/:id/summary · POST …/summary/open */
export const SummaryView = z.object({
  admission: z.object({ id: z.string(), number: z.string(), encounterId: z.string(), admittedAt: z.string(), dischargedAt: z.string().nullable(), diagnosis: z.string().nullable(), doctor: Person,
    bed: z.string().nullable(), ward: z.string().nullable(), dayNo: z.number().int() }),
  patient: PatientSummary, allergies: z.array(AllergyView),
  discharge: z.object({ id: z.string(), kind: DischargeKind, status: z.enum(["ordered", "completed", "cancelled"]), advice: z.string(), orderedAt: z.string() }).nullable(),
  /** a death on the ward has no summary (decision 15) */
  needed: z.boolean(),
  draft: SummaryDoc.nullable(), current: SummaryDoc.nullable(),
  /** review: the current version was signed before this discharge (an earlier one was cancelled) — amend it to confirm */
  stale: z.boolean(),
  /** another doctor's draft is open (only its author edits and signs it) */
  draftBy: Person.nullable(),
  history: z.array(z.object({ id: z.string(), version: z.number().int(), status: DocStatus, signedAt: z.string().nullable(), amendReason: z.string().nullable() })),
  /** what stops signing the draft now (Kamrul, 12: a critical result unacknowledged, an escalation open) */
  blockers: z.array(SummaryBlocker),
  facts: z.object({ criticalUnacked: z.number().int(), openEscalations: z.number().int(),
    /** the active inpatient orders, a starting point for the medicines on discharge */
    activeOrders: z.array(z.object({ medicineKey: z.string(), brand: z.string(), generic: z.string(), strength: z.string(), form: z.string(), doseText: z.string(), route: z.string() })),
    /** signed round notes' diagnoses and the admission's for the picker */
    lastRoundAssessment: z.string().nullable() }),
  redFlagsSample: z.array(z.object({ key: z.string(), bn: z.string(), en: z.string() })),
  /** the take-home medicines from the pharmacy against the current version (Kamrul, 304: after 3 days a line not given is
      "not collected" — shown, never dropped) */
  takeHome: z.object({ dispensed: z.boolean(), at: z.string().nullable(), until: z.string().nullable(), notCollected: z.number().int(),
    lines: z.array(z.object({ requestId: z.string(), medicineKey: z.string(), brand: z.string(), quantity: z.number().int(), givenQty: z.number().int(),
      status: z.enum(["waiting", "partial", "dispensed", "declined", "not-collected"]) })) }),
  can: z.object({ open: z.boolean(), amend: z.boolean(), print: z.boolean() }),
});
export type SummaryView = z.infer<typeof SummaryView>;
/* PUT /v1/ipd/summaries/:id — the draft (rev check-and-set); the server copies labels and medicine data */
export const SaveSummaryRequest = z.object({
  rev: z.number().int().min(1), sections: SummarySections,
  diagnoses: z.array(z.object({ code: z.string().max(20), verificationStatus: z.enum(["provisional", "confirmed"]) })).max(20),
  medicines: z.array(z.object({
    medicineKey: z.string().max(60), dose: z.string().max(20), meal: Meal, days: z.number().int().min(1).max(365),
    note: z.string().trim().max(200).optional(), keepBoth: z.boolean().optional(), acks: z.array(z.string().max(60)).max(10).optional(),
  })).max(30),
});
export type SaveSummaryRequest = z.infer<typeof SaveSummaryRequest>;
export const SignSummaryRequest = z.object({ rev: z.number().int().min(1), pin: z.string().regex(/^\d{4}$/) });
export type SignSummaryRequest = z.infer<typeof SignSummaryRequest>;
export const AmendSummaryRequest = z.object({ reason: z.string().trim().min(5).max(300) });
export type AmendSummaryRequest = z.infer<typeof AmendSummaryRequest>;
