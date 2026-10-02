/* Front desk routes (slice A1–A3). Each route checks the screen it serves with `authorize` (the same access matrix the
   nav uses), runs in one transaction (command/query) under RLS, and audits what it reveals or changes. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CreateVisitRequest, MatchDecisionRequest, PatientSearchQuery, QueueActionRequest, RegisterRequest, RegistrationInput,
  type CreateVisitResponse, type MatchDecisionResponse, type PatientMatches, type PatientSearchResponse, type QueueItem, type QueueResponse, type RegisterResponse,
} from "@setu/contracts";
import { authorize, dhakaDay, format, validateRegistration } from "@setu/domain";
import type { z } from "zod";
import { command, query } from "../command.js";
import { err, forbidden } from "../errors.js";
import {
  createVisit, decide, draftToMatchRecord, findCandidates, patientMatches, queueAction, queueBoard, registerPatient, searchPatients, toSummary, undoDecision,
} from "../modules/frontdesk.js";
import { requireSession } from "../plugins/session.js";

/** Allowed when the session may use any of the named front desk screens. */
function requireScreen(req: FastifyRequest, ...screens: string[]) {
  const s = requireSession(req);
  const decisions = screens.map((x) => authorize(s.role, s.plan, "fd", x));
  if (decisions.some((d) => d.allowed)) return s;
  throw forbidden(decisions.some((d) => d.reason === "role") ? "role" : (decisions[0]?.reason ?? "unknown"));
}

const validationError = (fields: { field: string; code: string }[]) =>
  err(400, "validation", `${format.toBn(fields.length)}টি ঘর ঠিক করুন`, `${fields.length} field${fields.length === 1 ? "" : "s"} need${fields.length === 1 ? "s" : ""} attention`, { field: fields[0]?.field, fields });

export async function frontDeskRoutes(app: FastifyInstance) {
  /* A1 — search by patient no., phone, Bangla or English name. */
  app.get("/v1/patients/search", async (req): Promise<PatientSearchResponse> => {
    requireScreen(req, "search");
    const { q } = PatientSearchQuery.parse(req.query);
    return query(req, async (tx) => {
      const r = await searchPatients(tx, q);
      return { body: r, audit: [{ action: "view", entity: "Patient", detail: { purpose: "search", mode: r.mode, count: r.items.length } }] };
    });
  });

  /* A2 — a saved record against its possible matches. */
  app.get("/v1/patients/:id/matches", async (req): Promise<z.infer<typeof PatientMatches>> => {
    requireScreen(req, "match");
    const { id } = req.params as { id: string };
    return query(req, async (tx) => {
      const r = await patientMatches(tx, id, new Date());
      return { body: r, audit: [{ action: "view", entity: "Patient", entityId: id, patientId: id, detail: { purpose: "match", candidates: r.candidates.map((c) => c.patient.id) } }] };
    });
  });

  /* A3 — the register screen's live duplicate check for an unsaved form. A read: nothing is stored. */
  app.post("/v1/patients/match-preview", async (req) => {
    requireScreen(req, "register", "match");
    const draft = RegistrationInput.parse(req.body);
    return query(req, async (tx) => {
      const candidates = await findCandidates(tx, draftToMatchRecord(draft, new Date()), null, new Date());
      return { body: { candidates }, audit: candidates.length ? [{ action: "view", entity: "Patient", detail: { purpose: "duplicate-check", candidates: candidates.map((c) => c.patient.id) } }] : [] };
    });
  });

  /* A2 — link / link anyway (reason ≥10) / send for review / different person. */
  app.post("/v1/patients/:id/match-decisions", async (req, reply): Promise<MatchDecisionResponse> => {
    requireScreen(req, "match");
    const { id } = req.params as { id: string };
    const body = MatchDecisionRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await decide(tx, s, id, body.decision, body.candidateId, body.reason, new Date());
      const subject = toSummary(r.subject);
      return {
        body: { decision: body.decision, subject, continueWith: r.continueWith ? toSummary(r.continueWith) : subject, taskId: r.taskId, conflicts: r.conflicts as MatchDecisionResponse["conflicts"] },
        audit: [{ action: "update", entity: "Patient", entityId: id, patientId: id, detail: { decision: body.decision, candidateId: body.candidateId ?? null, taskId: r.taskId, conflicts: r.conflicts, reason: body.reason?.trim() || null } }],
      };
    });
  });

  app.post("/v1/patients/:id/match-decisions/undo", async (req, reply): Promise<MatchDecisionResponse> => {
    requireScreen(req, "match");
    const { id } = req.params as { id: string };
    return command(req, reply, async (tx, s) => {
      const r = await undoDecision(tx, s, id, new Date());
      const subject = toSummary(r.subject);
      return { body: { decision: "undo", subject, continueWith: subject, taskId: null, conflicts: [] }, audit: [{ action: "update", entity: "Patient", entityId: id, patientId: id, detail: { decision: "undo", undone: r.undone } }] };
    });
  });

  /* A3 — register; optionally create the visit and token in the same transaction. */
  app.post("/v1/patients", async (req, reply): Promise<RegisterResponse> => {
    requireScreen(req, "register");
    const body = RegisterRequest.parse(req.body);
    const now = new Date();
    const errors = validateRegistration(body, now);
    if (errors.length) throw validationError(errors);
    return command(req, reply, async (tx, s) => {
      const p = await registerPatient(tx, s, body, now);
      const v = body.createVisit ? await createVisit(tx, s, p.id, body.visitType, now) : null;
      return {
        status: 201, body: { patient: toSummary(p), encounter: v?.encounter ?? null },
        audit: [
          { action: "create", entity: "Patient", entityId: p.id, patientId: p.id, basis: "patient" },
          ...(v ? [{ action: "create", entity: "Encounter", entityId: v.encounter.id, patientId: p.id, detail: { token: v.encounter.token } }] : []),
        ],
      };
    });
  });

  /* Create visit + token for an existing patient (search → Create visit). */
  app.post("/v1/encounters", async (req, reply): Promise<CreateVisitResponse> => {
    requireScreen(req, "search", "register");
    const body = CreateVisitRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const v = await createVisit(tx, s, body.patientId, body.visitType, new Date());
      return { status: 201, body: { encounter: v.encounter, patient: toSummary(v.patient) }, audit: [{ action: "create", entity: "Encounter", entityId: v.encounter.id, patientId: v.patient.id, detail: { token: v.encounter.token } }] };
    });
  });

  /* Queue board for today (or ?day=yyyy-mm-dd) at the session's branch. */
  app.get("/v1/queue", async (req): Promise<QueueResponse> => {
    requireScreen(req, "queue");
    const raw = (req.query as { day?: string }).day;
    if (raw !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw validationError([{ field: "day", code: "day_format" }]);
    const day = raw ?? dhakaDay(new Date());
    return query(req, async (tx, s) => {
      const b = await queueBoard(tx, s, day);
      return { body: b as QueueResponse, audit: [{ action: "view", entity: "Encounter", detail: { purpose: "queue", day, count: b.columns.reduce((n, c) => n + c.items.length, 0) } }] };
    });
  });

  /* Queue: call / next / no-show — next and no-show are ENCOUNTER transitions. */
  app.post("/v1/encounters/:id/actions", async (req, reply): Promise<QueueItem> => {
    requireScreen(req, "queue");
    const { id } = req.params as { id: string };
    const { action } = QueueActionRequest.parse(req.body);
    return command(req, reply, async (tx) => {
      const r = await queueAction(tx, id, action, new Date());
      return { body: r.item, audit: [{ action: "update", entity: "Encounter", entityId: id, patientId: r.item.patient.id, detail: { queueAction: action, event: r.event, from: r.from, to: r.item.status } }] };
    });
  });
}
