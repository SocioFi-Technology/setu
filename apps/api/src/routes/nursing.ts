/* Ward routes (ADR 0015). Nursing: nur/ward (board, stock, indents), nur/vitals (NEWS2 rounds, the escalation log),
   nur/mar (the MAR), nur/io (notes) — nurse / admin; ipd/rounds (doctor / admin): the round worklist, the note, stop
   orders, the ward medicine list; ph/indent (pharmacist / admin / owner): indents to issue; ipd/transfer: bed moves.
   Each route runs in one transaction under RLS and audits what it reveals or changes; every write takes an
   Idempotency-Key; doses and signatures never wait in the outbox (the screens send them online only). */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AmendRoundRequest, BedMoveRequest, DoseRequest, EscalationInformRequest, EscalationResolveRequest, IndentCreate, IndentIssueRequest, NursingNoteRequest, ReasonRequest, SaveRoundRequest, SignRoundRequest,
  StopOrderRequest, VialOpenRequest, WardVitalsRequest,
} from "@setu/contracts";
import { authorize } from "@setu/domain";
import { command, query } from "../command.js";
import { forbidden } from "../errors.js";
import { cancelIndent, createIndent, issueIndent, pharmacyIndents, wardIndents, wardStock } from "../modules/indent.js";
import { arriveBed, cancelMove, moveBed } from "../modules/ipd.js";
import { markDoseError, marView, openVial, recordDose, witnesses } from "../modules/mar.js";
import { amendRound, openRound, roundView, roundWorklist, saveRound, signRound, stopOrder, wardMedicines } from "../modules/rounds.js";
import { addNote, informEscalation, markNoteError, recordWardVitals, resolveEscalation, wardBoard, wardList, wardPatient } from "../modules/ward.js";
import { requireSession } from "../plugins/session.js";

function requireAny(req: FastifyRequest, ...screens: [string, string][]) {
  const s = requireSession(req);
  const d = screens.map(([m, x]) => authorize(s.role, s.plan, m, x));
  if (d.some((x) => x.allowed)) return s;
  throw forbidden(d.some((x) => x.reason === "plan") ? "plan" : d.some((x) => x.reason === "role") ? "role" : "unknown");
}
const pid = z.object({ id: z.string().min(1).max(64) });
const own = { config: { ownTx: true } };

export async function nursingRoutes(app: FastifyInstance) {
  /* ── the ward ── */
  app.get("/v1/nursing/wards", async (req) => { requireAny(req, ["nur", "ward"], ["nur", "mar"]); return query(req, async (tx, s) => ({ body: await wardList(tx, s), audit: [] })); });
  app.get("/v1/nursing/wards/:id/board", async (req) => {
    requireAny(req, ["nur", "ward"]); const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => { const r = await wardBoard(tx, s, id, new Date()); return { body: r.board, audit: [{ action: "view", entity: "Encounter", detail: { purpose: "ward-board", wardId: id, patientIds: r.patientIds } }] }; });
  });
  app.get("/v1/nursing/encounters/:id", async (req) => {
    requireAny(req, ["nur", "ward"], ["nur", "vitals"], ["nur", "io"], ["nur", "mar"]); const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => { const v = await wardPatient(tx, s, id, new Date()); return { body: v, audit: [{ action: "view", entity: "Observation", patientId: v.patient.id, detail: { purpose: "ward-patient", encounterId: id } }] }; });
  });
  app.post("/v1/nursing/encounters/:id/vitals", own, async (req, reply) => {
    requireAny(req, ["nur", "vitals"]); const { id } = pid.parse(req.params); const body = WardVitalsRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await recordWardVitals(tx, s, id, body, new Date()); return { status: 201, body: r.res, audit: r.audit }; });
  });
  app.post("/v1/nursing/escalations/:id/inform", own, async (req, reply) => {
    requireAny(req, ["nur", "vitals"]); const { id } = pid.parse(req.params); const body = EscalationInformRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await informEscalation(tx, s, id, body, new Date()); return { body: r.esc, audit: r.audit }; });
  });
  app.post("/v1/nursing/escalations/:id/resolve", own, async (req, reply) => {
    requireAny(req, ["nur", "vitals"], ["ipd", "rounds"]); const { id } = pid.parse(req.params); const body = EscalationResolveRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await resolveEscalation(tx, s, id, body.note, new Date()); return { body: r.esc, audit: r.audit }; });
  });
  app.post("/v1/nursing/encounters/:id/notes", own, async (req, reply) => {
    requireAny(req, ["nur", "io"], ["nur", "ward"]); const { id } = pid.parse(req.params); const body = NursingNoteRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await addNote(tx, s, id, body, new Date()); return { status: 201, body: r.note, audit: r.audit }; });
  });
  app.post("/v1/nursing/notes/:id/entered-in-error", own, async (req, reply) => {
    requireAny(req, ["nur", "io"], ["nur", "ward"]); const { id } = pid.parse(req.params); const body = ReasonRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await markNoteError(tx, s, id, body.reason, new Date()); return { body: r.note, audit: r.audit }; });
  });
  /* ── the MAR ── */
  app.get("/v1/nursing/encounters/:id/mar", async (req) => {
    requireAny(req, ["nur", "mar"]); const { id } = pid.parse(req.params); const { day } = z.object({ day: z.string().max(10).optional() }).parse(req.query ?? {});
    return query(req, async (tx, s) => { const r = await marView(tx, s, id, new Date(), day); return { body: r.view, audit: [{ action: "view", entity: "MedicationAdministration", patientId: r.patientId, detail: { purpose: "mar", encounterId: id, day: r.view.day } }] }; });
  });
  app.post("/v1/nursing/encounters/:id/doses", own, async (req, reply) => {
    requireAny(req, ["nur", "mar"]); const { id } = pid.parse(req.params); const body = DoseRequest.parse(req.body ?? {});
    // the witness's PIN is never stored, not even hashed into the idempotency record
    return command(req, reply, async (tx, s) => { const r = await recordDose(tx, s, id, body, new Date()); return { status: 201, body: r.view, audit: r.audit }; }, { hashOmit: ["witness"] });
  });
  app.post("/v1/nursing/doses/:id/entered-in-error", own, async (req, reply) => {
    requireAny(req, ["nur", "mar"]); const { id } = pid.parse(req.params); const body = ReasonRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await markDoseError(tx, s, id, body.reason, new Date()); return { body: r.view, audit: r.audit }; });
  });
  app.post("/v1/nursing/encounters/:id/vials", own, async (req, reply) => {
    requireAny(req, ["nur", "mar"]); const { id } = pid.parse(req.params); const body = VialOpenRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await openVial(tx, s, id, body, new Date()); return { status: 201, body: r.view, audit: r.audit }; });
  });
  app.get("/v1/nursing/witnesses", async (req) => { requireAny(req, ["nur", "mar"]); return query(req, async (tx, s) => ({ body: await witnesses(tx, s), audit: [] })); });
  /* ── ward stock and indents ── */
  app.get("/v1/nursing/wards/:id/stock", async (req) => { requireAny(req, ["nur", "ward"], ["nur", "mar"]); const { id } = pid.parse(req.params); return query(req, async (tx, s) => ({ body: await wardStock(tx, s, id), audit: [] })); });
  app.get("/v1/nursing/wards/:id/indents", async (req) => { requireAny(req, ["nur", "ward"]); const { id } = pid.parse(req.params); return query(req, async (tx, s) => ({ body: await wardIndents(tx, s, id, new Date()), audit: [] })); });
  app.post("/v1/nursing/wards/:id/indents", own, async (req, reply) => {
    requireAny(req, ["nur", "ward"]); const { id } = pid.parse(req.params); const body = IndentCreate.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await createIndent(tx, s, id, body, new Date()); return { status: 201, body: r.view, audit: r.audit }; });
  });
  app.post("/v1/indents/:id/cancel", own, async (req, reply) => {
    requireAny(req, ["nur", "ward"], ["ph", "indent"]); const { id } = pid.parse(req.params); const body = ReasonRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await cancelIndent(tx, s, id, body.reason, new Date()); return { body: r.view, audit: r.audit }; });
  });
  app.get("/v1/pharmacy/indents", async (req) => {
    requireAny(req, ["ph", "indent"]); const { status } = z.object({ status: z.string().max(20).optional() }).parse(req.query ?? {});
    return query(req, async (tx, s) => ({ body: await pharmacyIndents(tx, s, status, new Date()), audit: [] }));
  });
  app.post("/v1/pharmacy/indents/:id/issue", own, async (req, reply) => {
    requireAny(req, ["ph", "indent"]); const { id } = pid.parse(req.params); const body = IndentIssueRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await issueIndent(tx, s, id, body, new Date()); return { body: r.view, audit: r.audit }; }, { hashOmit: ["pin"] });
  });
  /* ── the doctor's round ── */
  app.get("/v1/ipd/rounds", async (req) => {
    requireAny(req, ["ipd", "rounds"]);
    return query(req, async (tx, s) => { const r = await roundWorklist(tx, s, new Date()); return { body: r.list, audit: [{ action: "view", entity: "Encounter", detail: { purpose: "round-worklist", patientIds: r.patientIds } }] }; });
  });
  app.get("/v1/ipd/encounters/:id/round", async (req) => {
    requireAny(req, ["ipd", "rounds"]); const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => { const r = await roundView(tx, s, id, new Date()); return { body: r.view, audit: [{ action: "view", entity: "Composition", patientId: r.patientId, detail: { purpose: "round", encounterId: id } }] }; });
  });
  app.post("/v1/ipd/encounters/:id/round/open", own, async (req, reply) => {
    requireAny(req, ["ipd", "rounds"]); const { id } = pid.parse(req.params);
    return command(req, reply, async (tx, s) => { const r = await openRound(tx, s, id, new Date()); return { body: r.view, audit: r.audit }; });
  });
  app.put("/v1/ipd/round-notes/:id", own, async (req, reply) => {
    requireAny(req, ["ipd", "rounds"]); const { id } = pid.parse(req.params); const body = SaveRoundRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await saveRound(tx, s, id, body, new Date()); return { body: r.view, audit: r.audit }; });
  });
  app.post("/v1/ipd/round-notes/:id/sign", own, async (req, reply) => {
    requireAny(req, ["ipd", "rounds"]); const { id } = pid.parse(req.params); const body = SignRoundRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await signRound(tx, s, id, body, new Date()); return { body: r.view, audit: r.audit }; }, { hashOmit: ["pin"] });
  });
  app.post("/v1/ipd/round-notes/:id/amend", own, async (req, reply) => {
    requireAny(req, ["ipd", "rounds"]); const { id } = pid.parse(req.params); const body = AmendRoundRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await amendRound(tx, s, id, body.reason, new Date()); return { status: 201, body: r.view, audit: r.audit }; });
  });
  app.post("/v1/ipd/orders/:id/stop", own, async (req, reply) => {
    requireAny(req, ["ipd", "rounds"]); const { id } = pid.parse(req.params); const body = StopOrderRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await stopOrder(tx, s, id, body, new Date()); return { body: r.view, audit: r.audit }; }, { hashOmit: ["pin"] });
  });
  app.get("/v1/ipd/medicines", async (req) => { /* the nurse's indent picks from the same list */
    requireAny(req, ["ipd", "rounds"], ["nur", "ward"]); const { q } = z.object({ q: z.string().max(60).optional() }).parse(req.query ?? {});
    return query(req, async (tx) => ({ body: await wardMedicines(tx, q ?? ""), audit: [] }));
  });
  /* ── bed moves ── */
  app.post("/v1/ipd/admissions/:id/transfer", own, async (req, reply) => {
    requireAny(req, ["ipd", "transfer"]); const { id } = pid.parse(req.params); const body = BedMoveRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await moveBed(tx, s, id, body, new Date()); return { body: r.view, audit: r.audit }; });
  });
  app.post("/v1/ipd/admissions/:id/transfer/arrive", own, async (req, reply) => {
    requireAny(req, ["ipd", "transfer"], ["nur", "ward"]); const { id } = pid.parse(req.params);
    return command(req, reply, async (tx, s) => { const r = await arriveBed(tx, s, id, new Date()); return { body: r.view, audit: r.audit }; });
  });
  app.post("/v1/ipd/admissions/:id/transfer/cancel", own, async (req, reply) => {
    requireAny(req, ["ipd", "transfer"]); const { id } = pid.parse(req.params); const body = ReasonRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await cancelMove(tx, s, id, body.reason, new Date()); return { body: r.view, audit: r.audit }; });
  });
}
