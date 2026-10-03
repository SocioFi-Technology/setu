/* Lab contracts (slice A8–A11, ADR 0006). The rules live in @setu/domain lab.ts and the machines; the API re-runs them
   and the database checks them again. Nothing here is "verified", "validated", "released" or "sent" until the server
   answers. Reference ranges and critical thresholds are the prototype's sample, pending clinician sign-off (D1). */
import { z } from "zod";
import { EncounterStatus, PatientSummary } from "./frontdesk.js";
import { OrderStatus } from "./consultation.js";
import { Interpretation } from "./vitals.js";

export const TubeKind = z.enum(["edta", "fluoride", "plain", "urine"]);
export const SpecimenStatus = z.enum(["pending", "collected", "received", "in-process", "done", "rejected"]);
export const CollectionStatus = z.enum(["none", "pending", "partial", "collected", "rejected"]);
/** reasons offered on the reject form */
export const UserRejectReason = z.enum(["haemolysed", "clotted", "insufficient", "label-mismatch", "wrong-container", "other"]);
/** + results-withdrawn: the tube of a test whose results were withdrawn (decision 133) */
export const RejectReason = z.enum(["haemolysed", "clotted", "insufficient", "label-mismatch", "wrong-container", "other", "results-withdrawn"]);
export const ResultStatus = z.enum(["preliminary", "verified", "final", "amended", "entered-in-error"]);
export const LabReportStatus = z.enum(["preliminary", "final", "corrected", "superseded"]);
export const CommunicationStatus = z.enum(["preparation", "in-progress", "completed", "failed"]);
export const CommunicationChannel = z.enum(["sms", "patient-app", "doctor-inbox"]);
export const CommunicationKind = z.enum(["recollect", "report-ready", "report-app", "report-inbox", "correction-notice", "results-withdrawn", "order-cancelled"]);
export const CallbackRecipient = z.enum(["ordering-doctor", "duty-doctor", "patient"]);
export const CallbackVia = z.enum(["phone", "app", "in-person"]);
export const CallbackOutcome = z.enum(["reached", "no-answer"]);
export const LabStage = z.enum(["collect", "accession", "result", "verify", "delivery"]);
/** adult | adult-female | adult-male — always shown next to the range ("adult female range", decision D1) */
export const RangeLabel = z.enum(["adult", "adult-female", "adult-male"]);

const Person = z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() });
const When = z.string().datetime();
const Pin = z.string().regex(/^\d{4}$/);
const Ids = z.array(z.string().min(1).max(64)).min(1).max(60);

export const LabRange = z.object({ low: z.number(), high: z.number(), label: RangeLabel });
export const LabPatient = PatientSummary.pick({ id: true, facilityNo: true, nameBn: true, nameEn: true, sex: true, birthDate: true, approxAgeYears: true, approxAgeMonths: true, approxAgeAt: true, phone: true, identityConfidence: true })
  .extend({ /** at collection (or today when nothing is collected yet); null = unknown */ ageYears: z.number().int().nullable() });

export const CriticalCallbackItem = z.object({
  id: z.string(), observationId: z.string(), outcome: CallbackOutcome, recipientRole: CallbackRecipient, recipientName: z.string(), via: CallbackVia,
  calledAt: z.string(), readBack: z.boolean(), caller: Person, recordedAt: z.string(),
});
export const LabResult = z.object({
  id: z.string(), orderId: z.string(), analyteCode: z.string(), nameEn: z.string(), nameBn: z.string(), unit: z.string(), decimals: z.number().int(),
  value: z.number(), flag: Interpretation.nullable(), range: LabRange.nullable(), critLow: z.number().nullable(), critHigh: z.number().nullable(),
  status: ResultStatus, enteredBy: Person, enteredAt: z.string(),
  verifiedBy: Person.nullable(), verifiedAt: z.string().nullable(), validatedBy: Person.nullable(), validatedAt: z.string().nullable(),
  /** a correction: the result this one replaces, and (on an old row) the one that replaced it */
  replacesId: z.string().nullable(), replacedById: z.string().nullable(),
  error: z.object({ reason: z.string(), by: Person, at: z.string() }).nullable(),
  /** delta check against the patient's previous validated result (sample rule: more than 20% warns) */
  delta: z.object({ prevValue: z.number(), prevAt: z.string(), pct: z.number().int(), hit: z.boolean() }).nullable(),
  callbacks: z.array(CriticalCallbackItem),
  /** in any released report version (a correction then notifies the doctor) */
  released: z.boolean(),
  /** decision 119: sent back by the pathologist (shown while it waits for verification again) */
  returned: z.object({ by: Person, at: z.string(), reason: z.string() }).nullable(),
  /** decision 133: entered-in-error with no replacement value (the test's results were withdrawn) */
  withdrawn: z.boolean(),
});
export type LabResult = z.infer<typeof LabResult>;
export const LabTemplateRow = z.object({
  analyteCode: z.string(), nameEn: z.string(), nameBn: z.string(), unit: z.string(), decimals: z.number().int(),
  range: LabRange.nullable(), critLow: z.number().nullable(), critHigh: z.number().nullable(),
  /** the delta check runs for this analyte (sample rule; WBC is left out) */
  deltaCheck: z.boolean(),
  /** the patient's previous validated result for this analyte (any earlier visit in this organisation's records) */
  previous: z.object({ value: z.number(), at: z.string() }).nullable(),
});
export const LabOrder = z.object({
  id: z.string(), testCode: z.string(), nameEn: z.string(), nameBn: z.string(), priority: z.enum(["routine", "urgent", "stat"]), status: OrderStatus,
  orderedBy: Person, orderedAt: z.string().nullable(), tube: TubeKind.nullable(),
  /** the tube it is being measured in (not rejected), if any */
  specimen: z.object({ id: z.string(), number: z.string(), status: SpecimenStatus }).nullable(),
  template: z.array(LabTemplateRow),
  /** every result row, current and replaced, oldest first */
  results: z.array(LabResult),
  revoke: z.object({ by: Person, at: z.string(), reason: z.string() }).nullable(),
  /** "Returned — <reason>": the test waits for verification again (decision 119) */
  returned: z.object({ by: Person, at: z.string(), reason: z.string() }).nullable(),
  /** the test's results were withdrawn and it has none now (decision 133): a new tube is needed */
  withdrawn: z.object({ by: Person, at: z.string(), reason: z.string() }).nullable(),
});
export type LabOrder = z.infer<typeof LabOrder>;
export const SpecimenItem = z.object({
  id: z.string(), number: z.string(), tube: TubeKind, status: SpecimenStatus, orderIds: z.array(z.string()), labelPrints: z.number().int(),
  labelPrintedAt: z.string(), collectedAt: z.string().nullable(), collectedBy: Person.nullable(), receivedAt: z.string().nullable(), startedAt: z.string().nullable(),
  doneAt: z.string().nullable(), rejectedAt: z.string().nullable(), rejectedBy: Person.nullable(), rejectReason: RejectReason.nullable(), rejectNote: z.string().nullable(),
});
export const TubeNeedItem = z.object({ tube: TubeKind, orderIds: z.array(z.string()), specimenId: z.string().nullable(), recollect: z.boolean() });
export const CommunicationItem = z.object({
  id: z.string(), kind: CommunicationKind, channel: CommunicationChannel, status: CommunicationStatus, attempts: z.number().int(), lastError: z.string().nullable(),
  toPhone: z.string().nullable(), recipient: Person.nullable(), reportId: z.string().nullable(), reportVersion: z.number().int().nullable(),
  createdAt: z.string(), sentAt: z.string().nullable(), completedAt: z.string().nullable(),
});
export type CommunicationItem = z.infer<typeof CommunicationItem>;
export const ReleasePreview = z.object({
  status: z.enum(["preliminary", "final", "corrected"]), pending: z.number().int(), total: z.number().int(),
  orderIds: z.array(z.string()), observationIds: z.array(z.string()), blockers: z.array(z.enum(["nothing_validated", "nothing_new"])),
});
export const LabReportSummary = z.object({
  id: z.string(), number: z.string(), version: z.number().int(), status: LabReportStatus, testCount: z.number().int(), pendingCount: z.number().int(),
  releasedAt: z.string(), releasedBy: Person, supersededById: z.string().nullable(),
});
export const LabEncounter = z.object({ id: z.string(), token: z.string(), day: z.string(), status: EncounterStatus });

/* GET /v1/lab/visits/:encounterId — everything the lab screens show for one visit (audited, incl. the earlier results
   revealed for the delta check). */
export const LabVisitView = z.object({
  encounter: LabEncounter,
  patient: LabPatient,
  /** may the person who verified also validate here (facility setting, else Clinic yes / Hospital no) */
  samePersonAllowed: z.boolean(),
  orders: z.array(LabOrder),
  collection: CollectionStatus,
  tubes: z.array(TubeNeedItem),
  specimens: z.array(SpecimenItem),
  release: ReleasePreview,
  reports: z.array(LabReportSummary),
  communications: z.array(CommunicationItem),
  bill: z.object({ number: z.string().nullable(), status: z.string() }).nullable(),
});
export type LabVisitView = z.infer<typeof LabVisitView>;

/* GET /v1/lab/worklist?stage= */
export const LabWorklistQuery = z.object({ stage: LabStage });
export const LabWorklistItem = z.object({
  encounter: LabEncounter,
  patient: LabPatient.omit({ phone: true }),
  priority: z.enum(["routine", "urgent", "stat"]),
  tests: z.array(z.object({ orderId: z.string(), testCode: z.string(), nameEn: z.string(), status: OrderStatus })),
  collection: CollectionStatus,
  counts: z.object({ tubesNeeded: z.number().int(), toEnter: z.number().int(), toVerify: z.number().int(), toValidate: z.number().int(), criticalOpen: z.number().int(), releasable: z.number().int() }),
  report: LabReportSummary.pick({ id: true, number: true, version: true, status: true, pendingCount: true, testCount: true }).nullable(),
  deliveryFailed: z.number().int(),
  returned: z.array(z.object({ orderId: z.string(), nameEn: z.string(), reason: z.string() })),
  bill: z.object({ number: z.string().nullable(), status: z.string() }).nullable(),
});
export const LabWorklist = z.object({ stage: LabStage, items: z.array(LabWorklistItem) });
export type LabWorklist = z.infer<typeof LabWorklist>;

/* GET /v1/lab/reports/:id — one released version, as released (a snapshot). */
export const LabReportView = z.object({
  report: LabReportSummary,
  encounter: LabEncounter,
  patient: LabPatient.omit({ phone: true }),
  tests: z.array(z.object({
    orderId: z.string(), testCode: z.string(), nameEn: z.string(), nameBn: z.string(),
    /** every result of this test in this version was withdrawn later: "withdrawn — do not act on it" (decision 133) */
    withdrawn: z.boolean(),
    /** results as released; `underCorrection` = later marked entered-in-error (do not act on it) */
    results: z.array(LabResult.extend({ underCorrection: z.boolean() })),
  })),
  pendingTests: z.array(z.object({ orderId: z.string(), nameEn: z.string(), nameBn: z.string() })),
  deliveries: z.array(CommunicationItem),
});
export type LabReportView = z.infer<typeof LabReportView>;

/* ───── writes (every one takes Idempotency-Key) ───── */
export const LabelsRequest = z.object({ tubes: z.array(TubeKind).min(1).max(4).optional() });
export type LabelsRequest = z.infer<typeof LabelsRequest>;
/** collect / receive / start: when it happened on the device (offline steps keep their real time; decision D8) */
export const SpecimenStepRequest = z.object({ at: When });
export type SpecimenStepRequest = z.infer<typeof SpecimenStepRequest>;
export const SpecimenRejectRequest = z.object({ reason: UserRejectReason, note: z.string().max(300).optional(), at: When });
export type SpecimenRejectRequest = z.infer<typeof SpecimenRejectRequest>;
export const ResultEntryRequest = z.object({
  entries: z.array(z.object({ analyteCode: z.string().min(1).max(40), value: z.string().max(20), confirm: z.string().max(20).optional() })).min(1).max(30),
});
export type ResultEntryRequest = z.infer<typeof ResultEntryRequest>;
export const CorrectRequest = z.object({ value: z.string().max(20), confirm: z.string().max(20).optional(), reason: z.string().max(300) });
export type CorrectRequest = z.infer<typeof CorrectRequest>;
export const VerifyRequest = z.object({ pin: Pin, observationIds: Ids, /** "sample identity checked" when the delta check warned */ deltaChecked: z.boolean() });
export type VerifyRequest = z.infer<typeof VerifyRequest>;
export const ValidateRequest = z.object({ pin: Pin, observationIds: Ids });
export type ValidateRequest = z.infer<typeof ValidateRequest>;
export const CallbackRequest = z.object({
  outcome: CallbackOutcome, recipientRole: CallbackRecipient, recipientName: z.string().max(80), via: CallbackVia, calledAt: When, readBack: z.boolean(),
});
export type CallbackRequest = z.infer<typeof CallbackRequest>;
/** exactly the results the person saw in the preview (a change since then refuses with 409 stale) */
export const ReleaseRequest = z.object({ observationIds: Ids });
export type ReleaseRequest = z.infer<typeof ReleaseRequest>;
export const SendRequest = z.object({ channel: z.enum(["sms", "patient-app"]) });
export type SendRequest = z.infer<typeof SendRequest>;
export const RetryRequest = z.object({}).strict();
export const RevokeRequest = z.object({ reason: z.string().max(300) });
/** decision 119 (pathologist) and decision 133 (lab technologist or pathologist): a reason of at least 10 characters */
export const ReturnRequest = z.object({ reason: z.string().max(300) });
export type ReturnRequest = z.infer<typeof ReturnRequest>;
export const WithdrawRequest = z.object({ reason: z.string().max(300) });
export type WithdrawRequest = z.infer<typeof WithdrawRequest>;
export type RevokeRequest = z.infer<typeof RevokeRequest>;
export const RevokeResponse = z.object({
  order: z.object({ id: z.string(), status: OrderStatus, revoke: z.object({ by: Person, at: z.string(), reason: z.string() }) }),
  /** decision 99: what billing's order refresh did to the visit's draft bill (null = no draft bill, or it waits) */
  bill: z.object({ invoiceId: z.string(), removed: z.array(z.string()), added: z.array(z.string()), waits: z.boolean() }).nullable(),
});
export type RevokeResponse = z.infer<typeof RevokeResponse>;
export const DevFailNextRequest = z.object({ n: z.number().int().min(1).max(10).optional() });
