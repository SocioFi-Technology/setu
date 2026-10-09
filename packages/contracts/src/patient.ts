/* ADR 0020 — the patient app (slice D1–D3): sign-in with an SMS code, claims on a facility's records, the timeline.
   Every route is /v1/patient/* and needs the patient session (never a staff one). */
import { z } from "zod";

/** 01XXXXXXXXX (Bangla digits and +880 are turned into this by the app) */
export const PatientPhone = z.string().regex(/^01[3-9]\d{8}$/);
export const PatientLang = z.enum(["bn", "en"]);

/* POST /v1/patient/otp — always the same answer, whether the number is known or not */
export const OtpRequest = z.object({ phone: PatientPhone, lang: PatientLang.default("bn") });
export const OtpResponse = z.object({ sent: z.literal(true), expiresInSeconds: z.number().int() });
export type OtpResponse = z.infer<typeof OtpResponse>;

/* POST /v1/patient/sign-in */
export const PatientSignInRequest = z.object({ phone: PatientPhone, code: z.string().regex(/^\d{6}$/) });
export const PatientMe = z.object({
  person: z.object({ id: z.string(), phoneMasked: z.string(), lang: PatientLang, networkSharing: z.boolean() }),
  /** how many facilities' records are linked / waiting to be claimed */
  counts: z.object({ linked: z.number().int(), toClaim: z.number().int() }),
});
export type PatientMe = z.infer<typeof PatientMe>;

/* GET /v1/patient/claims — one per facility with records on the person's phone: the facility and the month only */
export const ClaimStatusWire = z.enum(["candidate", "proof-pending", "linked", "not-mine", "locked"]);
export const ClaimItem = z.object({
  id: z.string(),
  facilityEn: z.string().nullable(), facilityBn: z.string().nullable(),
  /** YYYY-MM of the last visit there */
  lastMonth: z.string(),
  status: ClaimStatusWire,
  method: z.enum(["code", "qr", "desk"]).nullable(),
  triesLeft: z.number().int(),
  lockedUntil: z.string().nullable(),
});
export type ClaimItem = z.infer<typeof ClaimItem>;
export const ClaimList = z.object({ items: z.array(ClaimItem) });
export type ClaimList = z.infer<typeof ClaimList>;

/* POST /v1/patient/claims/:id/proof — code (typed) or qr (scanned: the same code); desk = wait for the front desk */
export const ClaimProofRequest = z.discriminatedUnion("method", [
  z.object({ method: z.literal("code"), code: z.string().max(20) }),
  z.object({ method: z.literal("qr"), code: z.string().max(200) }),
  z.object({ method: z.literal("desk") }),
]);
export type ClaimProofRequest = z.infer<typeof ClaimProofRequest>;
export const ClaimProofResponse = z.object({ claim: ClaimItem, outcome: z.enum(["linked", "wrong-code", "locked", "desk-pending"]) });
export type ClaimProofResponse = z.infer<typeof ClaimProofResponse>;

/* GET /v1/patient/timeline?filter= */
export const TimelineFilter = z.enum(["all", "reports", "prescriptions", "visits", "mine"]);
export const TimelineSource = z.enum(["provider-verified", "patient-uploaded", "patient-reported"]);
export const TimelineItem = z.object({
  /** stable across reads: <kind>:<tenant-local id> */
  key: z.string(),
  kind: z.enum(["visit", "admission", "prescription", "report", "summary"]),
  at: z.string(),
  facilityEn: z.string().nullable(), facilityBn: z.string().nullable(),
  /** facts only — the app words them (i18n): a visit's class, a report's number and status, the doctor; never a value */
  visitClass: z.enum(["opd", "er", "ipd"]).nullable(),
  number: z.string().nullable(),
  status: z.string().nullable(),
  doctorEn: z.string().nullable(), doctorBn: z.string().nullable(),
  source: TimelineSource,
  /** the claim it came through (the facility) and the record — for opening it (slice D4) */
  claimId: z.string(), recordId: z.string(),
});
export type TimelineItem = z.infer<typeof TimelineItem>;
export const Timeline = z.object({ filter: TimelineFilter, items: z.array(TimelineItem), facilities: z.number().int() });
export type Timeline = z.infer<typeof Timeline>;
