/* Front desk contracts (slice A1–A3): patient search, duplicate review, registration, visit + token, queue board.
   Validation rules live in @setu/domain (patient.ts, queue.ts); these schemas only fix the wire shape. */
import { z } from "zod";
import { PhoneDigits } from "./common.js";

export const Sex = z.enum(["female", "male", "other"]);
export const EncounterStatus = z.enum(["planned", "arrived", "triaged", "in-progress", "finished", "cancelled", "entered-in-error"]);
export const IdentityConfidence = z.enum(["verified", "unverified", "possible-duplicate", "provisional"]);
export const FieldStatus = z.enum(["same", "similar", "different", "missing"]);
export const MatchField = z.enum(["nameBn", "nameEn", "sex", "birth", "guardian", "phone", "address", "id"]);

export const PatientSummary = z.object({
  id: z.string(),
  facilityNo: z.string(),
  nameBn: z.string(),
  nameEn: z.string().nullable(),
  sex: Sex,
  /** ISO yyyy-mm-dd, or null when only an approximate age is known. */
  birthDate: z.string().nullable(),
  approxAgeYears: z.number().int().nullable(),
  approxAgeMonths: z.number().int().nullable(),
  approxAgeAt: z.string().nullable(),
  phone: PhoneDigits.nullable(),
  phoneOwner: z.string().nullable(),
  guardian: z.object({ name: z.string(), relationship: z.string() }).nullable(),
  address: z.object({ division: z.string().nullable(), district: z.string().nullable(), upazila: z.string().nullable(), line: z.string().nullable() }),
  hasNid: z.boolean(),
  identityConfidence: IdentityConfidence,
  /** Set when this record was linked into another (replaced-by). */
  linkedToId: z.string().nullable(),
  lastVisitAt: z.string().nullable(),
});
export type PatientSummary = z.infer<typeof PatientSummary>;

/* GET /v1/patients/search?q= */
export const PatientSearchQuery = z.object({ q: z.string().trim().min(1).max(100) });
export const SearchMode = z.enum(["patientNo", "phone", "bn", "en"]);
export const PatientSearchResponse = z.object({
  mode: SearchMode,
  items: z.array(PatientSummary),
  /** Several patients use the searched phone number: choose by name, age and guardian, never merge automatically. */
  sharedPhone: z.object({ phone: PhoneDigits, count: z.number().int() }).nullable(),
});
export type PatientSearchResponse = z.infer<typeof PatientSearchResponse>;

/* Registration form (also the subject of a match preview). Strings as typed: Bangla or Latin digits are fine. */
export const RegistrationInput = z.object({
  nameBn: z.string().max(120),
  nameEn: z.string().max(120).optional(),
  sex: Sex.optional(),
  dobMode: z.enum(["dob", "age"]),
  dob: z.string().max(20).optional(),
  ageYears: z.string().max(5).optional(),
  ageMonths: z.string().max(4).optional(),
  phone: z.string().max(30).optional(),
  /** Whose number it is; not "self" needs the related person's name + relationship (open question 23). */
  phoneOwner: z.enum(["self", "guardian", "family", "other"]).optional(),
  division: z.string().max(60).optional(),
  district: z.string().max(60).optional(),
  upazila: z.string().max(60).optional(),
  addressLine: z.string().max(200).optional(),
  guardian: z.object({ name: z.string().max(120).optional(), relationship: z.string().max(40).optional(), idNo: z.string().max(30).optional() }).optional(),
  idType: z.enum(["none", "nid", "brn", "passport"]).optional(),
  idNo: z.string().max(30).optional(),
});
export type RegistrationInput = z.infer<typeof RegistrationInput>;

export const Comparison = z.object({
  fields: z.record(MatchField, FieldStatus),
  score: z.number().int(),
  strong: z.boolean(),
  conflicts: z.array(MatchField),
  isGuardian: z.boolean(),
});
export const MatchCandidate = z.object({
  patient: PatientSummary,
  comparison: Comparison,
  /** One click "Same person — link": nothing conflicts and the candidate is not the guardian. */
  canLink: z.boolean(),
  /** "Link anyway" with a reason: fields conflict and the candidate is not the guardian. */
  canLinkAnyway: z.boolean(),
});
export type MatchCandidate = z.infer<typeof MatchCandidate>;

/* GET /v1/patients/:id/matches — a saved record against its possible matches. */
/** The decision Undo would reverse (open question 17): only its maker or an admin may undo; a Link anyway needs a
    reason; visits opened on the linked record since are listed (they stay where they are). */
export const LastDecision = z.object({
  activity: z.enum(["link", "link-anyway", "review-requested", "checked-different"]),
  at: z.string(),
  by: z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() }).nullable(),
  canUndo: z.boolean(),
  reasonRequired: z.boolean(),
  reasonMin: z.number().int(),
  visitsSince: z.array(z.object({ encounterId: z.string(), token: z.string(), day: z.string(), status: EncounterStatus })),
});
export type LastDecision = z.infer<typeof LastDecision>;
export const PatientMatches = z.object({
  subject: PatientSummary, linkedTo: PatientSummary.nullable(), candidates: z.array(MatchCandidate),
  openReview: z.object({ taskId: z.string(), candidateId: z.string().nullable() }).nullable(),
  lastDecision: LastDecision.nullable(),
});
export type PatientMatches = z.infer<typeof PatientMatches>;
/* POST /v1/patients/:id/match-decisions/undo */
export const UndoRequest = z.object({ reason: z.string().max(500).optional() });

/* POST /v1/patients/match-preview — an unsaved registration against existing records (the register screen's live
   check). Reduced fields only (open question 19): name, patient no., age and sex; phone, address and guardian are shown
   once the candidate is opened on the match screen. */
export const PreviewCandidate = z.object({
  patient: z.object({ id: z.string(), facilityNo: z.string(), nameBn: z.string(), nameEn: z.string().nullable(), sex: Sex, ageYears: z.number().int().nullable(), ageApprox: z.boolean() }),
  score: z.number().int(),
  strong: z.boolean(),
  conflictCount: z.number().int(),
  isGuardian: z.boolean(),
  canLink: z.boolean(),
});
export type PreviewCandidate = z.infer<typeof PreviewCandidate>;
export const MatchPreviewResponse = z.object({ candidates: z.array(PreviewCandidate) });
export type MatchPreviewResponse = z.infer<typeof MatchPreviewResponse>;

/* POST /v1/patients/:id/match-decisions */
export const MatchDecision = z.enum(["link", "linkAnyway", "review", "different"]);
export const MatchDecisionRequest = z.object({
  decision: MatchDecision,
  candidateId: z.string().optional(),
  reason: z.string().max(500).optional(),
});
export const MatchDecisionResponse = z.object({
  decision: z.union([MatchDecision, z.literal("undo")]),
  subject: PatientSummary,
  /** The record the visit continues on (the link target after a link, else the subject). */
  continueWith: PatientSummary,
  taskId: z.string().nullable(),
  conflicts: z.array(MatchField),
});
export type MatchDecisionResponse = z.infer<typeof MatchDecisionResponse>;

/* POST /v1/patients */
export const RegisterRequest = RegistrationInput.extend({ createVisit: z.boolean().default(false), visitType: z.enum(["new", "follow-up", "report"]).default("new") });

export const QueueColumn = z.enum(["waiting", "vitals", "withDoctor", "done", "noShow"]);
export const QueueAction = z.enum(["next", "noShow", "call"]);
export const QueueItem = z.object({
  id: z.string(),
  token: z.string(),
  tokenNo: z.number().int(),
  day: z.string(),
  status: EncounterStatus,
  column: QueueColumn.nullable(),
  visitType: z.string(),
  patient: PatientSummary.pick({ id: true, facilityNo: true, nameBn: true, nameEn: true, sex: true, birthDate: true, approxAgeYears: true, approxAgeMonths: true, approxAgeAt: true, identityConfidence: true }),
  arrivedAt: z.string().nullable(),
  calledAt: z.string().nullable(),
  statusAt: z.string(),
  /** What the board may do next; the server applies these through the ENCOUNTER machine. */
  actions: z.array(QueueAction),
  /** "critical" when any vital sign recorded in this visit was critical (HH/LL) — decision 47 of 02/10/2026. */
  vitalsFlag: z.enum(["critical"]).nullable(),
});
export type QueueItem = z.infer<typeof QueueItem>;

export const RegisterResponse = z.object({ patient: PatientSummary, encounter: QueueItem.nullable() });
export type RegisterResponse = z.infer<typeof RegisterResponse>;

/* POST /v1/encounters — a visit with today's token. */
export const CreateVisitRequest = z.object({ patientId: z.string(), visitType: z.enum(["new", "follow-up", "report"]).default("new") });
export const CreateVisitResponse = z.object({ encounter: QueueItem, patient: PatientSummary });
export type CreateVisitResponse = z.infer<typeof CreateVisitResponse>;

/* GET /v1/queue */
export const QueueResponse = z.object({
  day: z.string(),
  branch: z.object({ id: z.string(), nameBn: z.string().nullable(), name: z.string() }),
  columns: z.array(z.object({ key: QueueColumn, status: EncounterStatus, items: z.array(QueueItem) })),
});
export type QueueResponse = z.infer<typeof QueueResponse>;

/* POST /v1/encounters/:id/actions */
export const QueueActionRequest = z.object({ action: QueueAction });

/* Decision 16 (02/10/2026): "Link anyway" stays immediate; an admin reviews it afterwards and can unlink. */
export const UnlinkRequest = z.object({ reason: z.string().max(500) });
export const ReviewKind = z.enum(["review", "override", "undone"]);
export const ReviewItem = z.object({
  taskId: z.string(),
  /** review = "Send for review" (still open); override = "Link anyway" (linked with override, awaiting admin review);
      undone = a Link anyway the desk has since undone, with its reason (decision 49), awaiting admin review. */
  kind: ReviewKind,
  undo: z.object({ reason: z.string().nullable(), at: z.string(), by: z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() }).nullable() }).nullable(),
  subject: PatientSummary,
  candidate: PatientSummary.nullable(),
  reason: z.string().nullable(),
  conflicts: z.array(MatchField),
  requestedBy: z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() }).nullable(),
  requestedAt: z.string(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;
export const ReviewQueueResponse = z.object({ items: z.array(ReviewItem) });
export type ReviewQueueResponse = z.infer<typeof ReviewQueueResponse>;
export const ReviewOutcomeResponse = z.object({ taskId: z.string().nullable(), subject: PatientSummary, outcome: z.enum(["unlinked", "kept", "reviewed"]) });
export type ReviewOutcomeResponse = z.infer<typeof ReviewOutcomeResponse>;
