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
  /** the facility's "now in the app" notice for it is not yet opened (ADR 0021) */
  unread: z.boolean(),
  /** the visit it belongs to (sharing one visit) */
  encounterId: z.string().nullable(),
});
export type TimelineItem = z.infer<typeof TimelineItem>;
export const Timeline = z.object({ filter: TimelineFilter, items: z.array(TimelineItem), facilities: z.number().int() });
export type Timeline = z.infer<typeof Timeline>;

/* ── D4 (ADR 0021): one report, in plain language ── */
export const LabFlagWire = z.enum(["N", "H", "L", "HH", "LL"]);
/** the plain-language keys (i18n `patientLab`): drafts; none for a critical result (Kamrul 09/10/2026) */
export const LabPlainWire = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("explained"), draft: z.boolean(), what: z.string(), unit: z.string(), direction: z.string().nullable() }),
  z.object({ kind: z.literal("critical") }),
  z.object({ kind: z.literal("none") }),
]);
export const TrendPoint = z.object({ at: z.string(), value: z.number(), facilityEn: z.string().nullable(), facilityBn: z.string().nullable(), current: z.boolean() });
export const PatientResult = z.object({
  observationId: z.string(), code: z.string(), nameEn: z.string(), nameBn: z.string(),
  /** as entered (the analyte's decimals) — the app never re-rounds */
  value: z.number(), decimals: z.number().int(), unit: z.string(),
  refLow: z.number().nullable(), refHigh: z.number().nullable(), refLabel: z.string().nullable(),
  flag: LabFlagWire.nullable(), corrected: z.boolean(), withdrawn: z.boolean(),
  /** 0..1 on the range bar (the range is the middle third); null = no range */
  position: z.number().nullable(),
  plain: LabPlainWire,
  /** this analyte over time at every linked facility, oldest first (this result included, `current`) */
  trend: z.array(TrendPoint),
});
export const PatientReportView = z.object({
  report: z.object({
    id: z.string(), number: z.string(), version: z.number().int(), status: z.string(), releasedAt: z.string(),
    /** a later version replaced this one: open that instead */
    currentId: z.string(),
    facilityEn: z.string().nullable(), facilityBn: z.string().nullable(), facilityPhone: z.string().nullable(),
    pendingCount: z.number().int(), testCount: z.number().int(),
  }),
  tests: z.array(z.object({ nameEn: z.string(), nameBn: z.string(), results: z.array(PatientResult) })),
  claimId: z.string(),
});
export type PatientReportView = z.infer<typeof PatientReportView>;

/* ── D5 (ADR 0021): the network directory and shares ── */
export const DirectoryView = z.object({ facilities: z.array(z.object({
  tenantId: z.string(), organizationId: z.string(), nameEn: z.string(), nameBn: z.string().nullable(),
  doctors: z.array(z.object({ userId: z.string(), nameEn: z.string(), nameBn: z.string() })),
})) });
export type DirectoryView = z.infer<typeof DirectoryView>;
export const SharePeriodWire = z.enum(["24h", "7d", "30d"]);
export const ShareCreate = z.object({
  period: SharePeriodWire.default("30d"),
  /** a visit or a report is named through the claim it came from (the server maps it to the facility and record) */
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("all") }),
    z.object({ kind: z.literal("visit"), claimId: z.string(), encounterId: z.string() }),
    z.object({ kind: z.literal("report"), claimId: z.string(), reportId: z.string() }),
  ]),
  grantee: z.object({ organizationId: z.string(), userId: z.string().nullable() }),
});
export type ShareCreate = z.infer<typeof ShareCreate>;
export const ShareOpen = z.object({ at: z.string(), nameEn: z.string(), nameBn: z.string(), role: z.string(), facilityEn: z.string(), facilityBn: z.string().nullable(), itemKind: z.string() });
export const ShareView = z.object({
  id: z.string(),
  grantee: z.object({ facilityEn: z.string(), facilityBn: z.string().nullable(), doctorEn: z.string().nullable(), doctorBn: z.string().nullable() }),
  scope: z.object({ kind: z.enum(["all", "visit", "report"]), facilityEn: z.string().nullable(), facilityBn: z.string().nullable(), number: z.string().nullable(), at: z.string().nullable() }),
  period: SharePeriodWire, startsAt: z.string(), endsAt: z.string(),
  /** as of now: an active share past its end reads expired */
  status: z.enum(["active", "revoked", "expired"]), revokedAt: z.string().nullable(),
  opens: z.array(ShareOpen),
});
export type ShareView = z.infer<typeof ShareView>;
export const ShareList = z.object({ items: z.array(ShareView) });
export type ShareList = z.infer<typeof ShareList>;

/* ── D6 (ADR 0021): who viewed ── */
export const AccessEntry = z.object({
  at: z.string(),
  /** view | print | reprint | shared (a doctor through the patient's share) | break-glass (emergency access) */
  kind: z.enum(["view", "print", "reprint", "shared", "break-glass"]),
  /** what was seen: record | visit | report | prescription | summary | bill | other */
  what: z.string(),
  nameEn: z.string().nullable(), nameBn: z.string().nullable(), role: z.string().nullable(),
  facilityEn: z.string().nullable(), facilityBn: z.string().nullable(),
  /** break-glass: the reason given and whether the hospital reviewed it */
  reason: z.string().nullable(), reviewed: z.boolean().nullable(),
});
export const AccessLog = z.object({ items: z.array(AccessEntry), next: z.string().nullable() });
export type AccessLog = z.infer<typeof AccessLog>;
