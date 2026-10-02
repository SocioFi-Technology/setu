import type {
  AiDraftResponse, AllergyOptions, AllergyView, CompositionView, ConsultationView, ConsultWorklist, Icd11Search, MedicineSearch, RecordAllergyRequest, SaveDraftRequest, SignRequest, TestList,
  ApiError, Capabilities, VitalsBatchRequest, VitalsBatchResponse, VitalsView, VitalsWorklist, CreateVisitResponse, MatchDecisionResponse, MatchPreviewResponse, Me, PatientMatches, PatientSearchResponse, QueueItem, QueueResponse, RegisterResponse, RegistrationInput, ReviewOutcomeResponse, ReviewQueueResponse,
} from "@setu/contracts";
import { enqueue, flush } from "./outbox";
export class ApiFailure extends Error { constructor(public status: number, public body: ApiError) { super(body.message_en); } }

async function call<T>(method: string, path: string, body?: unknown, idemKey?: string): Promise<T> {
  const r = await fetch("/api" + path, {
    method, credentials: "include",
    // Only a request with a body says it is JSON: an empty JSON body is refused by the API (hands-on test 02/10/2026: sign-out).
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(idemKey ? { "idempotency-key": idemKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) { let e: ApiError = { code: "http_" + r.status, message_bn: "সার্ভারে সমস্যা", message_en: r.statusText }; try { e = await r.json(); } catch {} throw new ApiFailure(r.status, e); }
  return r.json() as Promise<T>;
}
/** A write: online it goes straight to the server; offline (or when the network drops) it waits in the outbox with the
    same Idempotency-Key and the caller gets { queued: true } — never a success. */
export type Write<T> = { queued: false; data: T } | { queued: true };
async function write<T>(method: string, path: string, body: unknown, label: string, key: string = crypto.randomUUID()): Promise<Write<T>> {
  const park = (): Write<T> => {
    if (enqueue({ method, path, body, key, label })) return { queued: true };
    throw new ApiFailure(0, { code: "offline", message_bn: "সংযোগ নেই — সংরক্ষণ হয়নি", message_en: "Offline — not saved" });
  };
  if (typeof navigator !== "undefined" && !navigator.onLine) return park();
  try { void flush(); return { queued: false, data: await call<T>(method, path, body, key) }; }
  catch (e) { if (e instanceof ApiFailure) throw e; return park(); }
}

export const fd = {
  search: (q: string) => call<PatientSearchResponse>("GET", "/v1/patients/search?q=" + encodeURIComponent(q)),
  matches: (id: string) => call<PatientMatches>("GET", `/v1/patients/${encodeURIComponent(id)}/matches`),
  preview: (draft: RegistrationInput) => call<MatchPreviewResponse>("POST", "/v1/patients/match-preview", draft),
  decide: (id: string, body: { decision: "link" | "linkAnyway" | "review" | "different"; candidateId?: string; reason?: string }) =>
    call<MatchDecisionResponse>("POST", `/v1/patients/${encodeURIComponent(id)}/match-decisions`, body, crypto.randomUUID()),
  undo: (id: string, reason?: string) => call<MatchDecisionResponse>("POST", `/v1/patients/${encodeURIComponent(id)}/match-decisions/undo`, reason ? { reason } : {}, crypto.randomUUID()),
  /** `key`: one per filled-in form, so pressing Save twice (or offline, then online) never registers twice. */
  register: (body: RegistrationInput & { createVisit: boolean }, key: string) => write<RegisterResponse>("POST", "/v1/patients", body, "register", key),
  createVisit: (patientId: string) => write<CreateVisitResponse>("POST", "/v1/encounters", { patientId }, "visit"),
  queue: () => call<QueueResponse>("GET", "/v1/queue"),
  reviews: () => call<ReviewQueueResponse>("GET", "/v1/reviews/duplicates"),
  unlink: (id: string, reason: string) => call<ReviewOutcomeResponse>("POST", `/v1/patients/${encodeURIComponent(id)}/unlink`, { reason }, crypto.randomUUID()),
  keep: (taskId: string) => call<ReviewOutcomeResponse>("POST", `/v1/reviews/${encodeURIComponent(taskId)}/keep`, {}, crypto.randomUUID()),
  act: (id: string, action: "next" | "noShow" | "call") => call<QueueItem>("POST", `/v1/encounters/${encodeURIComponent(id)}/actions`, { action }, crypto.randomUUID()),
};

/* Vitals (slice A4). `key`: one per filled-in form, so Save twice (or offline, then online) never stores twice. */
export const vitals = {
  worklist: () => call<VitalsWorklist>("GET", "/v1/vitals/worklist"),
  view: (encounterId: string) => call<VitalsView>("GET", `/v1/encounters/${encodeURIComponent(encounterId)}/vitals`),
  record: (encounterId: string, body: VitalsBatchRequest, key: string) => write<VitalsBatchResponse>("POST", `/v1/encounters/${encodeURIComponent(encounterId)}/vitals`, body, "vitals", key),
};

/* Consultation (slice A5). Every write waits for the server: a note is Signed only when `sign` answers 200 — there is no
   client-side "signed" and no offline signing (decision 25). Draft saves that cannot reach the server are kept by the
   screen as a device draft (outbox.ts `saveDeviceDraft`), never queued as a blind replay. `key`: the caller's
   Idempotency-Key, so a retry (e.g. the right PIN after a wrong one) is the same request. */
const enc = encodeURIComponent;
export const cons = {
  worklist: () => call<ConsultWorklist>("GET", "/v1/consultations/worklist"),
  view: (encounterId: string) => call<ConsultationView>("GET", `/v1/encounters/${enc(encounterId)}/consultation`),
  open: (encounterId: string) => call<ConsultationView>("POST", `/v1/encounters/${enc(encounterId)}/consultation/open`, {}, crypto.randomUUID()),
  save: (compositionId: string, body: SaveDraftRequest, key: string) => call<CompositionView>("PUT", `/v1/compositions/${enc(compositionId)}`, body, key),
  sign: (compositionId: string, body: SignRequest, key: string) => call<ConsultationView>("POST", `/v1/compositions/${enc(compositionId)}/sign`, body, key),
  amend: (compositionId: string, reason: string) => call<ConsultationView>("POST", `/v1/compositions/${enc(compositionId)}/amend`, { reason }, crypto.randomUUID()),
  aiDraft: (compositionId: string, kind: "previsit" | "note") => call<AiDraftResponse>("POST", `/v1/compositions/${enc(compositionId)}/ai-draft`, { kind }, crypto.randomUUID()),
  recordAllergy: (patientId: string, body: RecordAllergyRequest, key: string) => call<AllergyView>("POST", `/v1/patients/${enc(patientId)}/allergies`, body, key),
  markAllergyError: (allergyId: string, encounterId: string, reason: string, key: string) => call<AllergyView>("POST", `/v1/allergies/${enc(allergyId)}/entered-in-error`, { encounterId, reason }, key),
  icd11: (q: string) => call<Icd11Search>("GET", "/v1/catalog/icd11?q=" + enc(q)),
  medicines: (q: string) => call<MedicineSearch>("GET", "/v1/catalog/medicines?q=" + enc(q)),
  tests: () => call<TestList>("GET", "/v1/catalog/tests"),
  allergyOptions: () => call<AllergyOptions>("GET", "/v1/catalog/allergy-options"),
};

export const api = {
  health: () => call<{ ok: true; version: string; db: string }>("GET", "/health"),
  login: (identifier: string, password: string, demoPlan?: string) => call<Me>("POST", "/v1/auth/login", { identifier, password, ...(demoPlan ? { demoPlan } : {}) }),
  logout: () => call<{ ok: true }>("POST", "/v1/auth/logout"),
  me: () => call<Me>("GET", "/v1/me"),
  capabilities: () => call<Capabilities>("GET", "/v1/me/capabilities"),
  pinVerify: (pin: string) => call<{ ok: boolean; triesLeft?: number; lockedUntil?: string }>("POST", "/v1/auth/pin/verify", { pin }),
};
