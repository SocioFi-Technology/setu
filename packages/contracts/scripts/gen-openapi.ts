/* Generates openapi.json from the Zod contracts. Routes register themselves here as they are added. */
import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import * as C from "../src/index.js";

extendZodWithOpenApi(z);
const r = new OpenAPIRegistry();
r.registerPath({ method: "get", path: "/health", responses: { 200: { description: "liveness", content: { "application/json": { schema: C.Health } } } } });
r.registerPath({ method: "post", path: "/v1/auth/login", request: { body: { content: { "application/json": { schema: C.LoginRequest } } } }, responses: { 200: { description: "session", content: { "application/json": { schema: C.Me } } }, 401: { description: "bad credentials", content: { "application/json": { schema: C.ApiError } } } } });
r.registerPath({ method: "get", path: "/v1/me", responses: { 200: { description: "current session", content: { "application/json": { schema: C.Me } } } } });
r.registerPath({ method: "get", path: "/v1/me/capabilities", responses: { 200: { description: "nav", content: { "application/json": { schema: C.Capabilities } } } } });
r.registerPath({ method: "post", path: "/v1/auth/pin/verify", request: { body: { content: { "application/json": { schema: C.PinVerifyRequest } } } }, responses: { 200: { description: "result", content: { "application/json": { schema: C.PinVerifyResponse } } } } });
/* Front desk (slice A1–A3). Every POST takes an Idempotency-Key header except match-preview, which is a read. */
const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });
const err = { description: "error", ...json(C.ApiError) };
const idem = z.object({ "idempotency-key": z.string() });
r.registerPath({ method: "get", path: "/v1/patients/search", request: { query: C.PatientSearchQuery }, responses: { 200: { description: "matches", ...json(C.PatientSearchResponse) }, 403: err } });
r.registerPath({ method: "get", path: "/v1/patients/{id}/matches", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "possible matches", ...json(C.PatientMatches) }, 404: err } });
r.registerPath({ method: "post", path: "/v1/patients/match-preview", request: { body: json(C.RegistrationInput) }, responses: { 200: { description: "possible matches for an unsaved form", ...json(C.MatchPreviewResponse) } } });
r.registerPath({ method: "post", path: "/v1/patients/{id}/match-decisions", request: { params: z.object({ id: z.string() }), headers: idem, body: json(C.MatchDecisionRequest) }, responses: { 200: { description: "decision applied", ...json(C.MatchDecisionResponse) }, 400: err, 409: err } });
r.registerPath({ method: "post", path: "/v1/patients/{id}/match-decisions/undo", request: { params: z.object({ id: z.string() }), headers: idem, body: json(C.UndoRequest) }, responses: { 200: { description: "last decision undone", ...json(C.MatchDecisionResponse) }, 400: err, 403: err, 409: err } });
r.registerPath({ method: "post", path: "/v1/patients", request: { headers: idem, body: json(C.RegisterRequest) }, responses: { 201: { description: "registered", ...json(C.RegisterResponse) }, 400: err } });
r.registerPath({ method: "post", path: "/v1/encounters", request: { headers: idem, body: json(C.CreateVisitRequest) }, responses: { 201: { description: "visit with token", ...json(C.CreateVisitResponse) }, 409: err } });
r.registerPath({ method: "get", path: "/v1/queue", request: { query: z.object({ day: z.string().optional() }) }, responses: { 200: { description: "queue board", ...json(C.QueueResponse) } } });
r.registerPath({ method: "post", path: "/v1/encounters/{id}/actions", request: { params: z.object({ id: z.string() }), headers: idem, body: json(C.QueueActionRequest) }, responses: { 200: { description: "token moved", ...json(C.QueueItem) }, 409: err } });
r.registerPath({ method: "get", path: "/v1/reviews/duplicates", responses: { 200: { description: "open reviews and overrides", ...json(C.ReviewQueueResponse) } } });
r.registerPath({ method: "post", path: "/v1/patients/{id}/unlink", request: { params: z.object({ id: z.string() }), headers: idem, body: json(C.UnlinkRequest) }, responses: { 200: { description: "unlinked (admin)", ...json(C.ReviewOutcomeResponse) }, 403: err, 409: err } });
r.registerPath({ method: "post", path: "/v1/reviews/{taskId}/keep", request: { params: z.object({ taskId: z.string() }), headers: idem }, responses: { 200: { description: "override kept (admin)", ...json(C.ReviewOutcomeResponse) }, 403: err, 409: err } });
/* Vitals (slice A4). */
r.registerPath({ method: "get", path: "/v1/vitals/worklist", responses: { 200: { description: "today's waiting visits at the branch", ...json(C.VitalsWorklist) }, 403: err } });
r.registerPath({ method: "get", path: "/v1/encounters/{id}/vitals", request: { params: z.object({ id: z.string() }) }, responses: { 200: { description: "this visit's vitals and the previous values", ...json(C.VitalsView) }, 403: err, 404: err } });
r.registerPath({ method: "post", path: "/v1/encounters/{id}/vitals", request: { params: z.object({ id: z.string() }), headers: idem, body: json(C.VitalsBatchRequest) }, responses: { 201: { description: "stored (final)", ...json(C.VitalsBatchResponse) }, 400: err, 403: err, 404: err, 409: err } });
/* Consultation (slice A5). Catalogues are sample lists. */
const pid = z.object({ id: z.string() });
r.registerPath({ method: "get", path: "/v1/catalog/icd11", request: { query: C.CatalogQuery }, responses: { 200: { description: "sample ICD-11 codes (unverified)", ...json(C.Icd11Search) }, 403: err } });
r.registerPath({ method: "get", path: "/v1/catalog/medicines", request: { query: C.CatalogQuery }, responses: { 200: { description: "sample medicines", ...json(C.MedicineSearch) }, 403: err } });
r.registerPath({ method: "get", path: "/v1/catalog/tests", responses: { 200: { description: "orderable tests", ...json(C.TestList) }, 403: err } });
r.registerPath({ method: "get", path: "/v1/catalog/allergy-options", responses: { 200: { description: "allergy classes and ingredients", ...json(C.AllergyOptions) }, 403: err } });
r.registerPath({ method: "get", path: "/v1/consultations/worklist", responses: { 200: { description: "today's visits this doctor may open", ...json(C.ConsultWorklist) }, 403: err } });
r.registerPath({ method: "get", path: "/v1/encounters/{id}/consultation", request: { params: pid }, responses: { 200: { description: "the visit's note versions and context", ...json(C.ConsultationView) }, 403: err, 404: err } });
r.registerPath({ method: "post", path: "/v1/encounters/{id}/consultation/open", request: { params: pid, headers: idem }, responses: { 200: { description: "opened (visit with doctor, draft ready)", ...json(C.ConsultationView) }, 403: err, 404: err, 409: err } });
r.registerPath({ method: "put", path: "/v1/compositions/{id}", request: { params: pid, headers: idem, body: json(C.SaveDraftRequest) }, responses: { 200: { description: "draft saved", ...json(C.CompositionView) }, 400: err, 403: err, 409: err } });
r.registerPath({ method: "post", path: "/v1/compositions/{id}/sign", request: { params: pid, headers: idem, body: json(C.SignRequest) }, responses: { 200: { description: "signed (final or amended) after the server checked the PIN", ...json(C.ConsultationView) }, 401: err, 403: err, 409: err, 422: err, 423: err } });
r.registerPath({ method: "post", path: "/v1/compositions/{id}/amend", request: { params: pid, headers: idem, body: json(C.AmendRequest) }, responses: { 201: { description: "amendment draft (v+1)", ...json(C.ConsultationView) }, 403: err, 409: err } });
r.registerPath({ method: "post", path: "/v1/compositions/{id}/ai-draft", request: { params: pid, headers: idem, body: json(C.AiDraftRequest) }, responses: { 200: { description: "AI draft — not a diagnosis", ...json(C.AiDraftResponse) }, 403: err } });
r.registerPath({ method: "post", path: "/v1/patients/{id}/allergies", request: { params: pid, headers: idem, body: json(C.RecordAllergyRequest) }, responses: { 201: { description: "recorded", ...json(C.AllergyView) }, 400: err, 403: err } });
r.registerPath({ method: "post", path: "/v1/allergies/{id}/entered-in-error", request: { params: pid, headers: idem, body: json(C.MarkAllergyErrorRequest) }, responses: { 200: { description: "marked entered-in-error", ...json(C.AllergyView) }, 403: err, 409: err } });
const doc = new OpenApiGeneratorV31(r.definitions).generateDocument({ openapi: "3.1.0", info: { title: "Setu Health API", version: "0.0.1" }, servers: [{ url: "/" }] });
writeFileSync(new URL("../openapi.json", import.meta.url), JSON.stringify(doc, null, 2));
console.log("wrote packages/contracts/openapi.json");
