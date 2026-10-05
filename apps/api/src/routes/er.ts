/* ER routes (ADR 0014, walkthrough B1–B2). er/triage (doctor, nurse, admin): the board, arrivals, triage, assign;
   er/orders: the visit's note, STAT lab orders, care orders, the signed disposition (doctor). Each route runs in one
   transaction under RLS and audits what it reveals or changes. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ErArrivalRequest, ErAssignRequest, ErCareOrderRequest, ErDispositionRequest, ErNotesRequest, ErOrderRequest, ErTriageRequest, type ErArrivalResponse, type ErBoard, type ErBoardItem, type ErVisitView } from "@setu/contracts";
import { authorize } from "@setu/domain";
import { command, query } from "../command.js";
import { err, forbidden } from "../errors.js";
import { arrive, assign, erBoard, erVisitView, placeOrder, saveNotes, signDisposition, toggleCareOrder, triage } from "../modules/er.js";
import { requireSession } from "../plugins/session.js";

function requireEr(req: FastifyRequest, screen: "triage" | "orders") {
  const s = requireSession(req);
  const d = authorize(s.role, s.plan, "er", screen);
  if (!d.allowed) throw forbidden(d.reason ?? "unknown");
  return s;
}
/** Writes on the ER floor are the clinical team's (doctor, nurse); an admin may look. */
const requireClinical = (s: ReturnType<typeof requireSession>) => { if (s.role !== "doctor" && s.role !== "nurse") throw err(403, "forbidden", "এই কাজটি জরুরি বিভাগের ডাক্তার বা নার্সের", "Only the ER doctor or nurse does this", { reason: "role", canRequest: false }); };
const pid = z.object({ id: z.string().min(1).max(64) });
const viewAudit = (v: Awaited<ReturnType<typeof erVisitView>>, purpose: string) => [{ action: "view", entity: "Composition", entityId: v.revealed.noteId, patientId: v.view.patient.id, detail: { purpose, encounterId: v.view.item.id, allergyIds: v.revealed.allergyIds } }];

export async function erRoutes(app: FastifyInstance) {
  app.get("/v1/er/board", async (req): Promise<ErBoard> => {
    requireEr(req, "triage");
    return query(req, async (tx, s) => {
      const b = await erBoard(tx, s, new Date());
      return { body: b, audit: [{ action: "view", entity: "Encounter", detail: { purpose: "er-board", count: b.items.length, patientIds: b.items.map((i) => i.patient.id) } }] };
    });
  });
  app.post("/v1/er/arrivals", { config: { ownTx: true } }, async (req, reply): Promise<ErArrivalResponse> => {
    requireClinical(requireEr(req, "triage"));
    const body = ErArrivalRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await arrive(tx, s, body, new Date()); return { status: 201, body: { item: r.item, patient: r.patient, review: r.review }, audit: r.audit }; });
  });
  app.post("/v1/er/encounters/:id/triage", { config: { ownTx: true } }, async (req, reply): Promise<ErBoardItem> => {
    requireClinical(requireEr(req, "triage"));
    const { id } = pid.parse(req.params); const body = ErTriageRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await triage(tx, s, id, body, new Date()); return { body: r.item, audit: r.audit }; });
  });
  app.post("/v1/er/encounters/:id/assign", { config: { ownTx: true } }, async (req, reply): Promise<ErBoardItem> => {
    requireClinical(requireEr(req, "triage"));
    const { id } = pid.parse(req.params); const body = ErAssignRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await assign(tx, s, id, body, new Date()); return { body: r.item, audit: r.audit }; });
  });
  app.get("/v1/er/encounters/:id", async (req): Promise<ErVisitView> => {
    requireEr(req, "orders");
    const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => { const v = await erVisitView(tx, s, id, new Date()); return { body: v.view, audit: viewAudit(v, "er-orders") }; });
  });
  app.post("/v1/er/encounters/:id/orders", { config: { ownTx: true } }, async (req, reply): Promise<ErVisitView> => {
    requireClinical(requireEr(req, "orders"));
    const { id } = pid.parse(req.params); const body = ErOrderRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await placeOrder(tx, s, id, body.testCode, new Date()); return { status: 201, body: r.view, audit: r.audit }; });
  });
  app.post("/v1/er/encounters/:id/care-orders", { config: { ownTx: true } }, async (req, reply): Promise<ErVisitView> => {
    requireClinical(requireEr(req, "orders"));
    const { id } = pid.parse(req.params); const body = ErCareOrderRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await toggleCareOrder(tx, s, id, body.key, body.on, new Date()); return { body: r.view, audit: r.audit }; });
  });
  app.put("/v1/er/encounters/:id/notes", { config: { ownTx: true } }, async (req, reply): Promise<ErVisitView> => {
    requireClinical(requireEr(req, "orders"));
    const { id } = pid.parse(req.params); const body = ErNotesRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await saveNotes(tx, s, id, body.rev, body.notes, new Date()); return { body: r.view, audit: r.audit }; });
  });
  app.post("/v1/er/encounters/:id/disposition", { config: { ownTx: true } }, async (req, reply): Promise<ErVisitView> => {
    requireEr(req, "orders");
    const { id } = pid.parse(req.params); const body = ErDispositionRequest.parse(req.body ?? {});
    // the PIN is never stored, not even hashed into the idempotency record
    return command(req, reply, async (tx, s) => { const r = await signDisposition(tx, s, id, body, new Date()); return { body: r.view, audit: r.audit }; }, { hashOmit: ["pin"] });
  });
}
