/* ADR 0021 — the receiving doctor's side of a patient's share (staff app): "Shared with you". Every read goes through
   the consent-checked read service; a refused read is 403 { reason: expired | revoked | out-of-scope | not-grantee }. */
import { z } from "zod";
import { PatientReportView, TimelineItem } from "./patient.js";

export const SharedPatient = z.object({ nameEn: z.string(), nameBn: z.string(), sex: z.string(), ageYears: z.number().int().nullable() });
export const SharedItem = z.object({
  consentId: z.string(),
  patient: SharedPatient,
  scope: z.object({ kind: z.enum(["all", "visit", "report"]), facilityEn: z.string().nullable(), facilityBn: z.string().nullable(), number: z.string().nullable(), at: z.string().nullable() }),
  /** shared with this doctor by name, or with the facility's doctors */
  toMe: z.boolean(),
  startsAt: z.string(), endsAt: z.string(),
  /** ADR 0023: a consent from this doctor's access request opens only these item kinds (empty = every kind) */
  kinds: z.array(z.string()).default([]),
});
export const SharedList = z.object({ items: z.array(SharedItem) });
export type SharedList = z.infer<typeof SharedList>;

/** the records a share covers, newest first — the history items with the owner facility instead of the claim */
export const SharedRecord = TimelineItem.omit({ claimId: true, unread: true }).extend({ ownerTenantId: z.string() });
export const SharedRecords = z.object({ consentId: z.string(), patient: SharedPatient, endsAt: z.string(), items: z.array(SharedRecord) });
export type SharedRecords = z.infer<typeof SharedRecords>;
export const SharedReportView = PatientReportView.omit({ claimId: true }).extend({ consentId: z.string() });
export type SharedReportView = z.infer<typeof SharedReportView>;

/* ── ADR 0023 (E4): another clinic's view of a linked patient's history ── */
export const HistorySource = z.object({ facilityEn: z.string().nullable(), facilityBn: z.string().nullable(), authorEn: z.string().nullable(), authorBn: z.string().nullable(), at: z.string(), source: z.literal("provider-verified") });
/** by policy (no request): active allergies, current medicines, active problems, blood group — from every OTHER linked
    facility, sensitive rows dropped before anything is counted */
export const PolicyAllergy = HistorySource.extend({ labelEn: z.string(), labelBn: z.string(), kind: z.string(), severity: z.string(), reaction: z.string().nullable() });
export const PolicyMedicine = HistorySource.extend({ brand: z.string(), generic: z.string(), strength: z.string(), form: z.string(), dose: z.string(), days: z.number().int(), inpatient: z.boolean() });
export const PolicyProblem = HistorySource.extend({ code: z.string(), labelEn: z.string(), labelBn: z.string() });
export const PolicyBloodGroup = HistorySource.extend({ value: z.string() });
export const AccessKindWire = z.enum(["reports", "summaries", "prescriptions", "visits"]);
export const AccessPeriodWire = z.enum(["24h", "30d"]);
export const AccessRequestView = z.object({
  id: z.string(), kinds: z.array(AccessKindWire), period: AccessPeriodWire, reason: z.string(),
  /** as of now: a request unanswered for 7 days reads expired */
  state: z.enum(["sent", "granted", "denied", "expired"]),
  createdAt: z.string(), answeredAt: z.string().nullable(),
  doctorEn: z.string(), doctorBn: z.string().nullable(),
  /** granted: the consent to open in "Shared with you" (the requesting doctor only) */
  consentId: z.string().nullable(),
});
export type AccessRequestView = z.infer<typeof AccessRequestView>;
export const NetworkHistory = z.object({
  patientId: z.string(),
  /** this record is linked to a Setu person (an app claim or a network order); never matched by name or phone */
  linked: z.boolean(),
  /** the person's "network sharing" setting: off → nothing by policy (requests still reach them) */
  sharing: z.boolean(),
  /** the other facilities read */
  facilities: z.number().int(),
  allergies: z.array(PolicyAllergy), medicines: z.array(PolicyMedicine), problems: z.array(PolicyProblem), bloodGroups: z.array(PolicyBloodGroup),
  /** this facility's own record: its blood group (recorded here) */
  own: z.object({ bloodGroup: z.string().nullable(), bloodGroupAt: z.string().nullable() }),
  requests: z.array(AccessRequestView),
});
export type NetworkHistory = z.infer<typeof NetworkHistory>;
export const AccessRequestCreate = z.object({
  patientId: z.string().min(1).max(64),
  kinds: z.array(AccessKindWire).min(1).max(4),
  period: AccessPeriodWire,
  reason: z.string().trim().min(10).max(300),
});
export type AccessRequestCreate = z.infer<typeof AccessRequestCreate>;
export const BloodGroupSet = z.object({ bloodGroup: z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]) });
export type BloodGroupSet = z.infer<typeof BloodGroupSet>;
