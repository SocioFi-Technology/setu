import type {
  ApiError, Capabilities, CreateVisitResponse, MatchCandidate, MatchDecisionResponse, Me, PatientMatches, PatientSearchResponse, QueueItem, QueueResponse, RegisterResponse, RegistrationInput,
} from "@setu/contracts";
import { enqueue, flush } from "./outbox";
export class ApiFailure extends Error { constructor(public status: number, public body: ApiError) { super(body.message_en); } }

async function call<T>(method: string, path: string, body?: unknown, idemKey?: string): Promise<T> {
  const r = await fetch("/api" + path, {
    method, credentials: "include",
    headers: { "content-type": "application/json", ...(idemKey ? { "idempotency-key": idemKey } : {}) },
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
  preview: (draft: RegistrationInput) => call<{ candidates: MatchCandidate[] }>("POST", "/v1/patients/match-preview", draft),
  decide: (id: string, body: { decision: "link" | "linkAnyway" | "review" | "different"; candidateId?: string; reason?: string }) =>
    call<MatchDecisionResponse>("POST", `/v1/patients/${encodeURIComponent(id)}/match-decisions`, body, crypto.randomUUID()),
  undo: (id: string) => call<MatchDecisionResponse>("POST", `/v1/patients/${encodeURIComponent(id)}/match-decisions/undo`, {}, crypto.randomUUID()),
  /** `key`: one per filled-in form, so pressing Save twice (or offline, then online) never registers twice. */
  register: (body: RegistrationInput & { createVisit: boolean }, key: string) => write<RegisterResponse>("POST", "/v1/patients", body, "register", key),
  createVisit: (patientId: string) => write<CreateVisitResponse>("POST", "/v1/encounters", { patientId }, "visit"),
  queue: () => call<QueueResponse>("GET", "/v1/queue"),
  act: (id: string, action: "next" | "noShow" | "call") => call<QueueItem>("POST", `/v1/encounters/${encodeURIComponent(id)}/actions`, { action }, crypto.randomUUID()),
};

export const api = {
  health: () => call<{ ok: true; version: string; db: string }>("GET", "/health"),
  login: (identifier: string, password: string, demoPlan?: string) => call<Me>("POST", "/v1/auth/login", { identifier, password, ...(demoPlan ? { demoPlan } : {}) }),
  logout: () => call<{ ok: true }>("POST", "/v1/auth/logout"),
  me: () => call<Me>("GET", "/v1/me"),
  capabilities: () => call<Capabilities>("GET", "/v1/me/capabilities"),
  pinVerify: (pin: string) => call<{ ok: boolean; triesLeft?: number; lockedUntil?: string }>("POST", "/v1/auth/pin/verify", { pin }),
};
