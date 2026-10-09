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
});
export const SharedList = z.object({ items: z.array(SharedItem) });
export type SharedList = z.infer<typeof SharedList>;

/** the records a share covers, newest first — the history items with the owner facility instead of the claim */
export const SharedRecord = TimelineItem.omit({ claimId: true, unread: true }).extend({ ownerTenantId: z.string() });
export const SharedRecords = z.object({ consentId: z.string(), patient: SharedPatient, endsAt: z.string(), items: z.array(SharedRecord) });
export type SharedRecords = z.infer<typeof SharedRecords>;
export const SharedReportView = PatientReportView.omit({ claimId: true }).extend({ consentId: z.string() });
export type SharedReportView = z.infer<typeof SharedReportView>;
