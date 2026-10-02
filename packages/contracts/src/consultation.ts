/* Consultation contracts (slice A5). Rules live in @setu/domain (prescription.ts, consultation.ts, documents.ts): the
   screen runs them as the doctor types and the API runs them again on the server's own data before signing. A note is
   Signed only when the sign route answers 200 — until then the screen says "Waiting for server — still a draft".
   Signing offline is not offered (decision 25). Catalogues are SAMPLE lists (pre-pilot: verified ICD-11 codes and a
   licensed medicine database with DGDA numbers). */
import { z } from "zod";
import { VitalsEncounter } from "./vitals.js";

const Text = (max: number) => z.string().max(max);
const Person = z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() });

/* ── note content ── */
export const SectionKey = z.enum(["complaints", "history", "exam", "advice", "followUp"]);
export const SectionSource = z.enum(["provider-verified", "ai-draft"]);
export const Complaint = z.object({
  text: z.string().trim().min(1).max(200),
  duration: z.object({ n: z.number().int().min(1).max(999), unit: z.enum(["d", "w", "m", "y"]) }).nullable(),
});
export const NoteSections = z.object({
  complaints: z.array(Complaint).max(30),
  history: Text(4000),
  exam: z.object({ general: Text(1000), cvs: Text(1000), chest: Text(1000), abdomen: Text(1000) }),
  advice: Text(2000),
  followUp: Text(500),
});
export type NoteSections = z.infer<typeof NoteSections>;
export const SectionSources = z.object({
  complaints: SectionSource.optional(), history: SectionSource.optional(), exam: SectionSource.optional(),
  advice: SectionSource.optional(), followUp: SectionSource.optional(),
});
export const Meal = z.enum(["before", "after", "with", "any"]);
export const DocStatus = z.enum(["draft", "queued", "final", "amended", "superseded", "entered-in-error"]);
export const OrderStatus = z.enum(["draft", "active", "centre-chosen", "accepted", "partially-accepted", "declined", "in-progress", "partially-complete", "complete", "revoked"]);
export const OrderPriority = z.enum(["routine", "urgent", "stat"]);

/* ── catalogues (sample) ── */
export const CatalogQuery = z.object({ q: z.string().trim().min(1).max(60) });
export const Icd11Item = z.object({ code: z.string(), bn: z.string(), en: z.string(), verification: z.string() });
export const MedicineItem = z.object({
  key: z.string(), brand: z.string(), brandBn: z.string(), generic: z.string(), strength: z.string(), form: z.string(), manufacturer: z.string(),
  ingredients: z.array(z.string()), classes: z.array(z.string()), defaults: z.object({ dose: z.string(), meal: Meal, days: z.number().int() }),
  /** always true until a licensed database replaces the sample list */
  sample: z.boolean(),
});
export const TestItem = z.object({ code: z.string(), nameEn: z.string(), nameBn: z.string(), group: z.enum(["lab", "imaging", "other"]) });
export const Icd11Search = z.object({ items: z.array(Icd11Item) });
export const MedicineSearch = z.object({ items: z.array(MedicineItem) });
export const TestList = z.object({ items: z.array(TestItem) });
export type Icd11Search = z.infer<typeof Icd11Search>;
export type MedicineSearch = z.infer<typeof MedicineSearch>;
export type TestList = z.infer<typeof TestList>;
export const AllergyOptions = z.object({
  classes: z.array(z.object({ key: z.string(), bn: z.string(), en: z.string() })),
  /** ingredient keys a substance allergy can name (from the sample medicines) */
  ingredients: z.array(z.string()),
});
export type AllergyOptions = z.infer<typeof AllergyOptions>;

/* ── allergies (ADR 0004) ── */
export const AllergyKind = z.enum(["class", "substance", "other"]);
export const AllergySeverity = z.enum(["mild", "moderate", "severe", "unknown"]);
export const AllergyView = z.object({
  id: z.string(), kind: AllergyKind, key: z.string().nullable(), labelBn: z.string(), labelEn: z.string(),
  reaction: z.string().nullable(), severity: AllergySeverity, status: z.enum(["active", "entered-in-error"]),
  recordedAt: z.string(), recordedBy: Person, source: z.literal("provider-verified"),
  error: z.object({ reason: z.string(), at: z.string(), by: Person }).nullable(),
});
export type AllergyView = z.infer<typeof AllergyView>;
/* POST /v1/patients/:id/allergies — during a visit the doctor may open (care relationship). */
export const RecordAllergyRequest = z.object({
  encounterId: z.string(),
  kind: AllergyKind,
  /** class key or ingredient key (from GET /v1/catalog/allergy-options); omitted for free text */
  key: z.string().max(60).optional(),
  /** free text (kind = other) */
  text: z.string().trim().min(2).max(100).optional(),
  reaction: z.string().trim().max(200).optional(),
  severity: AllergySeverity,
});
export type RecordAllergyRequest = z.infer<typeof RecordAllergyRequest>;
/* POST /v1/allergies/:id/entered-in-error */
export const MarkAllergyErrorRequest = z.object({ encounterId: z.string(), reason: z.string().trim().min(10).max(500) });
export const AllergyList = z.object({ items: z.array(AllergyView) });

/* ── a note version ── */
export const DiagnosisView = z.object({
  code: z.string(), labelBn: z.string(), labelEn: z.string(), codeVerification: z.string(), verificationStatus: z.enum(["provisional", "confirmed"]),
});
export const MedicationView = z.object({
  id: z.string(), position: z.number().int(), medicineKey: z.string(), brand: z.string(), generic: z.string(), strength: z.string(), form: z.string(),
  ingredients: z.array(z.string()), classes: z.array(z.string()), sample: z.boolean(),
  dose: z.string(), meal: Meal, days: z.number().int(), quantity: z.number().int(), note: z.string().nullable(), keepBoth: z.boolean(), acks: z.array(z.string()),
});
export const OrderView = z.object({
  id: z.string(), testCode: z.string(), nameEn: z.string(), nameBn: z.string(), group: z.string(), priority: OrderPriority, status: OrderStatus,
  note: z.string().nullable(),
  /** the note version that placed it; an amendment can add orders, never remove one already placed */
  placedInVersion: z.number().int(), placed: z.boolean(),
});
export const CompositionView = z.object({
  id: z.string(), version: z.number().int(), status: DocStatus, rev: z.number().int(),
  amendsId: z.string().nullable(), supersededById: z.string().nullable(), amendReason: z.string().nullable(),
  sections: NoteSections, sectionSources: SectionSources,
  diagnoses: z.array(DiagnosisView), medications: z.array(MedicationView), orders: z.array(OrderView),
  author: Person,
  signedAt: z.string().nullable(),
  /** registration shown only when stored, with its verification (decision 35) — never invented */
  signedBy: Person.extend({ regBody: z.string().nullable(), regNo: z.string().nullable(), regVerified: z.boolean() }).nullable(),
  aiReviewed: z.boolean(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type CompositionView = z.infer<typeof CompositionView>;

/* GET /v1/encounters/:id/consultation  ·  POST /v1/encounters/:id/consultation/open */
export const ConsultationView = z.object({
  encounter: VitalsEncounter.extend({ practitionerId: z.string().nullable() }),
  /** true when this session may not edit (visit finished, or not a doctor) */
  readOnly: z.boolean(),
  /** the signed version that is current (final or amended), if any */
  current: CompositionView.nullable(),
  /** the open draft (v1, or an amendment of `current`), if any */
  draft: CompositionView.nullable(),
  history: z.array(z.object({ id: z.string(), version: z.number().int(), status: DocStatus, signedAt: z.string().nullable(), amendReason: z.string().nullable(), supersededById: z.string().nullable() })),
  allergies: z.array(AllergyView),
  /** from the latest signed note of an earlier visit (the prototype's "current medicines") */
  currentMedicines: z.array(z.object({ brand: z.string(), generic: z.string(), strength: z.string(), form: z.string(), dose: z.string(), meal: Meal, days: z.number().int(), prescribedAt: z.string() })),
  pastDiagnoses: z.array(DiagnosisView.extend({ at: z.string() })),
  /** a vital in this visit was critical (decision 47; a calmer re-measure does not clear it) */
  criticalVitals: z.boolean(),
});
export type ConsultationView = z.infer<typeof ConsultationView>;

/* GET /v1/consultations/worklist — today's visits at the branch that this doctor may open (decision 28). */
export const ConsultWorklist = z.object({
  day: z.string(),
  items: z.array(VitalsEncounter.extend({ practitionerId: z.string().nullable(), mine: z.boolean(), critical: z.boolean(), hasDraft: z.boolean(), signed: z.boolean() })),
});
export type ConsultWorklist = z.infer<typeof ConsultWorklist>;

/* PUT /v1/compositions/:id — save a draft (check-and-set on `rev`; 409 stale). The server copies labels and medicine
   data from its catalogues: the screen sends keys only. */
export const SaveDraftRequest = z.object({
  rev: z.number().int().min(1),
  sections: NoteSections,
  sectionSources: SectionSources,
  diagnoses: z.array(z.object({ code: z.string().max(20), verificationStatus: z.enum(["provisional", "confirmed"]) })).max(20),
  medications: z.array(z.object({
    medicineKey: z.string().max(60), dose: z.string().max(20), meal: Meal, days: z.number().int().min(1).max(365),
    note: z.string().trim().max(200).optional(), keepBoth: z.boolean().optional(), acks: z.array(z.string().max(60)).max(10).optional(),
  })).max(30),
  /** this version's new orders only; orders placed by an earlier version are kept as they are */
  orders: z.array(z.object({ testCode: z.string().max(30), priority: OrderPriority, note: z.string().trim().max(200).optional() })).max(30),
});
export type SaveDraftRequest = z.infer<typeof SaveDraftRequest>;

/* POST /v1/compositions/:id/sign — PIN checked in the same transaction. 422 sign_blocked {blockers}; 401 pin_wrong
   {triesLeft}; 423 pin_locked {lockedUntil}; 409 stale. */
export const SignRequest = z.object({
  rev: z.number().int().min(1),
  pin: z.string().regex(/^\d{4}$/),
  /** "I reviewed the text inserted from the AI draft" */
  aiReviewed: z.boolean(),
  /** "I checked the medicines against the allergies that are not coded" */
  uncodedAllergiesChecked: z.boolean(),
});
export type SignRequest = z.infer<typeof SignRequest>;

/* POST /v1/compositions/:id/amend — opens v+1 as a draft copy (reason ≥ 5). */
export const AmendRequest = z.object({ reason: z.string().trim().min(5).max(500) });

/* POST /v1/compositions/:id/ai-draft — FakeAi in dev and tests. Always a draft, never a diagnosis; text inserted into the
   note keeps source ai-draft until the doctor ticks "I reviewed" and signs (rule 2). No audio is recorded. */
export const AiDraftRequest = z.object({ kind: z.enum(["previsit", "note"]) });
export const AiDraftResponse = z.object({
  kind: z.enum(["previsit", "note"]),
  label: z.literal("draft-not-a-diagnosis"),
  model: z.string(),
  /** pre-visit summary lines, each naming where it came from */
  summary: z.array(z.object({ textBn: z.string(), textEn: z.string(), source: z.string() })),
  /** suggested note text the doctor may insert */
  proposals: z.object({ history: z.string().optional(), exam: z.object({ general: z.string().optional(), abdomen: z.string().optional() }).optional() }),
});
export type AiDraftResponse = z.infer<typeof AiDraftResponse>;
