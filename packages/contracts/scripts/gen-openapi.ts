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
r.registerPath({ method: "post", path: "/v1/patients/{id}/match-decisions/undo", request: { params: z.object({ id: z.string() }), headers: idem }, responses: { 200: { description: "last decision undone", ...json(C.MatchDecisionResponse) }, 409: err } });
r.registerPath({ method: "post", path: "/v1/patients", request: { headers: idem, body: json(C.RegisterRequest) }, responses: { 201: { description: "registered", ...json(C.RegisterResponse) }, 400: err } });
r.registerPath({ method: "post", path: "/v1/encounters", request: { headers: idem, body: json(C.CreateVisitRequest) }, responses: { 201: { description: "visit with token", ...json(C.CreateVisitResponse) }, 409: err } });
r.registerPath({ method: "get", path: "/v1/queue", request: { query: z.object({ day: z.string().optional() }) }, responses: { 200: { description: "queue board", ...json(C.QueueResponse) } } });
r.registerPath({ method: "post", path: "/v1/encounters/{id}/actions", request: { params: z.object({ id: z.string() }), headers: idem, body: json(C.QueueActionRequest) }, responses: { 200: { description: "token moved", ...json(C.QueueItem) }, 409: err } });
r.registerPath({ method: "get", path: "/v1/reviews/duplicates", responses: { 200: { description: "open reviews and overrides", ...json(C.ReviewQueueResponse) } } });
r.registerPath({ method: "post", path: "/v1/patients/{id}/unlink", request: { params: z.object({ id: z.string() }), headers: idem, body: json(C.UnlinkRequest) }, responses: { 200: { description: "unlinked (admin)", ...json(C.ReviewOutcomeResponse) }, 403: err, 409: err } });
r.registerPath({ method: "post", path: "/v1/reviews/{taskId}/keep", request: { params: z.object({ taskId: z.string() }), headers: idem }, responses: { 200: { description: "override kept (admin)", ...json(C.ReviewOutcomeResponse) }, 403: err, 409: err } });
const doc = new OpenApiGeneratorV31(r.definitions).generateDocument({ openapi: "3.1.0", info: { title: "Setu Health API", version: "0.0.1" }, servers: [{ url: "/" }] });
writeFileSync(new URL("../openapi.json", import.meta.url), JSON.stringify(doc, null, 2));
console.log("wrote packages/contracts/openapi.json");
