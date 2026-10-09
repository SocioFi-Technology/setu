/* Doctor's inbox and printed clinical documents (slice A12–A13, ADR 0007). The rules live in @setu/domain inbox.ts and
   printing.ts; the API re-runs them and the database checks them again. An acknowledgement is not "Seen" on screen
   until the server answers; "Seen + tell patient" sends the SMS only after the server stored the acknowledgement. */
import { z } from "zod";
import { Sex } from "./frontdesk.js";
import { CommunicationStatus, LabReportStatus, RangeLabel } from "./lab.js";
import { ReceiptLang } from "./billing.js";
import { Interpretation } from "./vitals.js";

const Person = z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() });

export const InboxKind = z.enum(["report-inbox", "correction-notice", "results-withdrawn", "order-cancelled", "critical-vital", "substitution-notice", "return-notice", "news2-escalation", "discharge-remind", "portable-declined"]);
export const InboxSeverity = z.enum(["critical", "abnormal", "normal", "notice"]);
export const InboxResult = z.object({
  code: z.string(), nameEn: z.string(), nameBn: z.string(), value: z.number(), unit: z.string(), decimals: z.number().int(),
  flag: Interpretation.nullable(), refLow: z.number().nullable(), refHigh: z.number().nullable(), refLabel: RangeLabel.nullable(),
  /** marked entered-in-error since this version was released and a corrected value exists: "do not act on it" */
  underCorrection: z.boolean(),
  /** external review B3: withdrawn with no replacement (decision 133) — "withdrawn — no result"; never blocks the acknowledgement */
  withdrawn: z.boolean(),
});
export const InboxItem = z.object({
  /** the doctor-inbox Communication id */
  id: z.string(),
  kind: InboxKind,
  severity: InboxSeverity,
  at: z.string(),
  patient: z.object({ id: z.string(), facilityNo: z.string(), nameBn: z.string(), nameEn: z.string().nullable(), sex: Sex, ageYears: z.number().int().nullable(), hasMobile: z.boolean() }),
  encounter: z.object({ id: z.string(), token: z.string().nullable(), facilityEn: z.string() }),
  /** report-inbox: the released version; notices: the version they refer to, when there is one */
  report: z.object({
    id: z.string(), number: z.string(), version: z.number().int(), status: LabReportStatus, superseded: z.boolean(),
    testCount: z.number().int(), pendingCount: z.number().int(), results: z.array(InboxResult),
  }).nullable(),
  /** correction / withdrawal / cancellation: the test it is about */
  test: z.object({ nameEn: z.string(), nameBn: z.string() }).nullable(),
  /** ADR 0022: a network centre declined this test of a portable order (the reason; re-order it elsewhere) */
  portable: z.object({ orderId: z.string(), number: z.string(), centreEn: z.string().nullable(), centreBn: z.string().nullable(), reason: z.string().nullable(), notOffered: z.boolean(), reorderable: z.boolean() }).nullable(),
  /** critical-vital: the reading */
  vital: z.object({ code: z.string(), value: z.number(), unit: z.string(), flag: Interpretation.nullable() }).nullable(),
  /** substitution-notice (ADR 0009): what was prescribed, what the pharmacist gave instead and why */
  substitution: z.object({
    prescribed: z.object({ brand: z.string(), generic: z.string(), strength: z.string() }),
    given: z.object({ brand: z.string(), generic: z.string(), strength: z.string() }),
    qty: z.number().int(), reason: z.string(), by: Person, at: z.string(),
  }).nullable(),
  /** return-notice (ADR 0013): medicine given for the doctor's line came back as a wrong dispense (a medication incident) */
  returned: z.object({
    medicine: z.object({ brand: z.string(), generic: z.string(), strength: z.string() }),
    qty: z.number().int(), reason: z.string(), by: Person, at: z.string(),
  }).nullable(),
  acknowledged: z.object({
    at: z.string(), notifyPatient: z.boolean(),
    /** the "report reviewed" SMS: its delivery status ("Not yet synced" never appears here — this is the server's record) */
    sms: z.object({ id: z.string(), status: CommunicationStatus, lastError: z.string().nullable(), deliveryConfirmed: z.boolean() }).nullable(),
  }).nullable(),
  /** "Seen + tell patient" is offered (a released, current report, nothing under correction, a mobile on record) */
  canNotify: z.boolean(),
  /** a report with a value under correction: wait for the corrected version (no acknowledgement yet — clinical review M1) */
  correctionPending: z.boolean(),
  /** a report version replaced by a newer one: the newer item is the one to review (not counted as unread — M3) */
  resolved: z.boolean(),
});
export type InboxItem = z.infer<typeof InboxItem>;
export const InboxView = z.object({
  items: z.array(InboxItem),
  counts: z.object({ unread: z.number().int(), critical: z.number().int() }),
});
export type InboxView = z.infer<typeof InboxView>;
export const InboxQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) });

export const AckRequest = z.object({ notifyPatient: z.boolean().default(false) });
export type AckRequest = z.infer<typeof AckRequest>;
export const AckResponse = z.object({ item: InboxItem });
export type AckResponse = z.infer<typeof AckResponse>;

/* ───── printed clinical documents ───── */
/** rx prescription · lr lab report · ds discharge summary (ADR 0018) */
export const DocKind = z.enum(["rx", "lr", "ds"]);
export const DocFormat = z.enum(["a5", "a4"]);
export const DocReprintReason = z.enum(["lost", "jam", "copy"]);
export const PrintBlocker = z.enum(["draft_not_printable", "superseded_not_printable", "withdrawn_not_printable"]);
export const DocPrintRequest = z.object({ format: DocFormat.default("a5"), lang: ReceiptLang.default("both"), reason: DocReprintReason.optional() });
export type DocPrintRequest = z.infer<typeof DocPrintRequest>;
export const DocPrintItem = z.object({
  id: z.string(), copy: z.number().int(), reason: DocReprintReason.nullable(), format: DocFormat, lang: ReceiptLang,
  printedAt: z.string(), printedBy: Person, pdfUrl: z.string(),
});
export const DocPrintView = z.object({
  kind: DocKind, documentId: z.string(),
  /** empty = printable now */
  blockers: z.array(PrintBlocker),
  /** set once the first print made the code; the QR opens it */
  verifyCode: z.string().nullable(), verifyUrl: z.string().nullable(),
  prints: z.array(DocPrintItem),
  /** the server-rendered preview (no QR, no print logged) */
  previewUrl: z.string(),
});
export type DocPrintView = z.infer<typeof DocPrintView>;
export const DocPrintResponse = DocPrintView.extend({ print: DocPrintItem });
export type DocPrintResponse = z.infer<typeof DocPrintResponse>;

/* ───── public verify pages (no login; decision D2) ───── */
export const DocVerifyStatus = z.enum(["current", "superseded", "withdrawn"]);
const VerifyPatient = z.object({ initials: z.string(), sex: Sex, ageYears: z.number().int().nullable() });
export const RxVerifyResponse = z.object({
  facilityEn: z.string(), facilityBn: z.string().nullable(),
  doctorEn: z.string().nullable(), doctorBn: z.string().nullable(), regBody: z.string().nullable(), regNo: z.string().nullable(), regVerified: z.boolean(),
  signedAt: z.string().nullable(), version: z.number().int(), status: DocVerifyStatus,
  patient: VerifyPatient,
  medicines: z.array(z.object({ brand: z.string(), generic: z.string(), strength: z.string(), form: z.string(), dose: z.string(), meal: z.string(), days: z.number().int(), quantity: z.number().int(),
    /** the doctor's instruction under the medicine (clinical review H1) */
    note: z.string().nullable(),
    /** from the prototype's sample list — not for real prescribing (L2) */
    sample: z.boolean() })),
});
export type RxVerifyResponse = z.infer<typeof RxVerifyResponse>;
export const LrVerifyResponse = z.object({
  facilityEn: z.string(), facilityBn: z.string().nullable(),
  number: z.string(), version: z.number().int(), reportStatus: LabReportStatus, status: DocVerifyStatus, releasedAt: z.string(),
  testCount: z.number().int(), pendingCount: z.number().int(),
  patient: VerifyPatient,
  /** `withdrawn`: entered-in-error with no replacement value (decision 133); `underCorrection`: a corrected value exists */
  results: z.array(InboxResult.extend({ test: z.string(), withdrawn: z.boolean() })),
});
export type LrVerifyResponse = z.infer<typeof LrVerifyResponse>;
/** ADR 0018 (decision 10): the discharge summary's check names the facility, the doctor, the date, the version and
    whether it is current — no clinical content */
export const DsVerifyResponse = RxVerifyResponse.omit({ medicines: true });
export type DsVerifyResponse = z.infer<typeof DsVerifyResponse>;
