/* Ward routes (ADR 0015). Nursing: nur/ward (board, stock, indents), nur/vitals (NEWS2 rounds, the escalation log),
   nur/mar (the MAR), nur/io (notes) — nurse / admin; ipd/rounds (doctor / admin): the round worklist, the note, stop
   orders, the ward medicine list; ph/indent (pharmacist / admin / owner): indents to issue; ipd/transfer: bed moves.
   Each route runs in one transaction under RLS and audits what it reveals or changes; every write takes an
   Idempotency-Key; doses and signatures never wait in the outbox (the screens send them online only). */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AmendRoundRequest, BedMoveRequest, DoseErrorRequest, DoseRequest, EscalationInformRequest, EscalationResolveRequest, IndentCreate, IndentIssueRequest, NursingNoteRequest, ReasonRequest, SaveRoundRequest, SignRoundRequest,
  StopOrderRequest, VialOpenRequest, WardVitalsRequest, WristbandRequest, IoEntryRequest, CareTaskCreate, HandoverPatientUpdate, HandoverSignRequest, HandoverAcceptRequest, HandoverQueryRequest, CountLineRequest, PoRev, type CountList, type StockCountView,
} from "@setu/contracts";
import { authorize } from "@setu/domain";
import { command, query } from "../command.js";
import { err, forbidden } from "../errors.js";
import { batchLabels, cancelIndent, createIndent, issueIndent, pharmacyIndents, wardHere, wardIndents, wardStock } from "../modules/indent.js";
import { countList, countView, createCount, setCountLine, submitCount } from "../modules/purchasing.js";
import { arriveBed, cancelMove, moveBed } from "../modules/ipd.js";
import { markDoseError, marView, openVial, printWristband, recordDose, witnesses } from "../modules/mar.js";
import { addIo, cancelTask, completeTask, createTask, ioView, markIoError, taskList } from "../modules/care.js";
import { acceptHandover, openHandover, queryHandover, signHandover, updateHandoverPatient, wardHandover } from "../modules/handover.js";
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
    requireAny(req, ["nur", "mar"]); const { id } = pid.parse(req.params); const body = DoseErrorRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await markDoseError(tx, s, id, body.reason, new Date(), body.stockDrawn ?? null); return { body: r.view, audit: r.audit }; });
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
  /* ── ward stock counts (Kamrul, 06/10/2026): the ward nurse counts; the pharmacist or the owner decides on
     /v1/pharmacy/counts/:id/decision. Same STOCK_COUNT machine and rules as the counter, store and fridge. ── */
  const wardCount = async (tx: Parameters<Parameters<typeof query>[1]>[0], s: Parameters<Parameters<typeof query>[1]>[1], id: string) => {
    const c = await tx.stockCount.findFirst({ where: { id, organizationId: s.organizationId } });
    if (!c || !c.location.startsWith("ward:")) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
    return c;
  };
  app.get("/v1/nursing/wards/:id/counts", async (req): Promise<CountList> => {
    requireAny(req, ["nur", "ward"]); const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => { await wardHere(tx, s, id); return { body: await countList(tx, s, undefined, `ward:${id}`), audit: [{ action: "view", entity: "StockCount", detail: { purpose: "list", location: `ward:${id}` } }] }; });
  });
  app.post("/v1/nursing/wards/:id/counts", own, async (req, reply): Promise<StockCountView> => {
    const sess = requireAny(req, ["nur", "ward"]); const { id } = pid.parse(req.params);
    if (sess.role !== "nurse") throw forbidden("role");
    return command(req, reply, async (tx, s) => { await wardHere(tx, s, id); const c = await createCount(tx, s, `ward:${id}`, new Date()); return { status: 201, body: await countView(tx, s, c, new Date()), audit: [{ action: "create", entity: "StockCount", entityId: c.id, detail: { location: `ward:${id}` } }] }; });
  });
  app.get("/v1/nursing/counts/:id", async (req): Promise<StockCountView> => {
    requireAny(req, ["nur", "ward"]); const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => ({ body: await countView(tx, s, await wardCount(tx, s, id), new Date()), audit: [{ action: "view", entity: "StockCount", entityId: id }] }));
  });
  app.post("/v1/nursing/counts/:id/lines", own, async (req, reply): Promise<StockCountView> => {
    requireAny(req, ["nur", "ward"]); const { id } = pid.parse(req.params); const body = CountLineRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { await wardCount(tx, s, id); const c = await setCountLine(tx, s, id, body); return { status: 200, body: await countView(tx, s, c, new Date()), audit: [{ action: "update", entity: "StockCount", entityId: id, detail: { lineId: body.lineId, countedQty: body.countedQty, reason: body.reason ?? null } }] }; });
  });
  app.post("/v1/nursing/counts/:id/submit", own, async (req, reply): Promise<StockCountView> => {
    requireAny(req, ["nur", "ward"]); const { id } = pid.parse(req.params); const { rev } = PoRev.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { await wardCount(tx, s, id); const c = await submitCount(tx, s, id, rev, new Date()); return { status: 200, body: await countView(tx, s, c, new Date()), audit: [{ action: "update", entity: "StockCount", entityId: id, detail: { event: "submit" } }] }; });
  });
  /* ── ADR 0016: the wristband, intake / output, care tasks, the shift handover ── */
  app.post("/v1/nursing/encounters/:id/wristband", own, async (req, reply) => {
    requireAny(req, ["nur", "ward"], ["nur", "mar"], ["ipd", "admit"]); const { id } = pid.parse(req.params); const body = WristbandRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await printWristband(tx, s, id, body.reason, new Date()); return { status: 201, body: r.view, audit: r.audit }; });
  });
  app.get("/v1/nursing/labels", async (req) => {
    requireAny(req, ["nur", "ward"], ["ph", "indent"]); const { batches } = z.object({ batches: z.string().max(2000) }).parse(req.query ?? {});
    return query(req, async (tx, s) => ({ body: await batchLabels(tx, s, batches.split(",").filter(Boolean)), audit: [] }));
  });
  app.get("/v1/nursing/encounters/:id/io", async (req) => {
    requireAny(req, ["nur", "io"], ["ipd", "rounds"]); const { id } = pid.parse(req.params); const { day } = z.object({ day: z.string().max(10).optional() }).parse(req.query ?? {});
    return query(req, async (tx, s) => { const v = await ioView(tx, s, id, new Date(), day); return { body: v, audit: [{ action: "view", entity: "IntakeOutputEntry", detail: { encounterId: id, day: v.day } }] }; });
  });
  app.post("/v1/nursing/encounters/:id/io", own, async (req, reply) => {
    requireAny(req, ["nur", "io"]); const { id } = pid.parse(req.params); const body = IoEntryRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await addIo(tx, s, id, body, new Date()); return { status: 201, body: r.entry, audit: r.audit }; });
  });
  app.post("/v1/nursing/io/:id/entered-in-error", own, async (req, reply) => {
    requireAny(req, ["nur", "io"]); const { id } = pid.parse(req.params); const body = ReasonRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await markIoError(tx, s, id, body.reason, new Date()); return { body: r.entry, audit: r.audit }; });
  });
  app.get("/v1/nursing/encounters/:id/tasks", async (req) => {
    requireAny(req, ["nur", "io"], ["ipd", "rounds"]); const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => ({ body: await taskList(tx, s, id, new Date()), audit: [{ action: "view", entity: "CareTask", detail: { encounterId: id } }] }));
  });
  app.post("/v1/nursing/encounters/:id/tasks", own, async (req, reply) => {
    requireAny(req, ["nur", "io"], ["ipd", "rounds"]); const { id } = pid.parse(req.params); const body = CareTaskCreate.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await createTask(tx, s, id, body, new Date()); return { status: 201, body: r.list, audit: r.audit }; });
  });
  app.post("/v1/nursing/tasks/:id/complete", own, async (req, reply) => {
    requireAny(req, ["nur", "io"]); const { id } = pid.parse(req.params);
    return command(req, reply, async (tx, s) => { const r = await completeTask(tx, s, id, new Date()); return { body: r.list, audit: r.audit }; });
  });
  app.post("/v1/nursing/tasks/:id/cancel", own, async (req, reply) => {
    requireAny(req, ["nur", "io"], ["ipd", "rounds"]); const { id } = pid.parse(req.params); const body = ReasonRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await cancelTask(tx, s, id, body.reason, new Date()); return { body: r.list, audit: r.audit }; });
  });
  app.get("/v1/nursing/wards/:id/handover", async (req) => {
    requireAny(req, ["nur", "handover"]); const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => ({ body: await wardHandover(tx, s, id, new Date()), audit: [{ action: "view", entity: "Handover", detail: { wardId: id } }] }));
  });
  app.post("/v1/nursing/wards/:id/handover", own, async (req, reply) => {
    requireAny(req, ["nur", "handover"]); const { id } = pid.parse(req.params);
    return command(req, reply, async (tx, s) => { const r = await openHandover(tx, s, id, new Date()); return { status: 201, body: r.view, audit: r.audit }; });
  });
  app.put("/v1/nursing/handovers/:id/patients/:encounterId", own, async (req, reply) => {
    requireAny(req, ["nur", "handover"]); const p = z.object({ id: z.string().min(1).max(64), encounterId: z.string().min(1).max(64) }).parse(req.params); const body = HandoverPatientUpdate.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await updateHandoverPatient(tx, s, p.id, p.encounterId, body, new Date()); return { body: r.view, audit: r.audit }; });
  });
  app.post("/v1/nursing/handovers/:id/sign", own, async (req, reply) => {
    requireAny(req, ["nur", "handover"]); const { id } = pid.parse(req.params); const body = HandoverSignRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await signHandover(tx, s, id, body, new Date()); return { body: r.view, audit: r.audit }; }, { hashOmit: ["pin"] });
  });
  app.post("/v1/nursing/handovers/:id/accept", own, async (req, reply) => {
    requireAny(req, ["nur", "handover"]); const { id } = pid.parse(req.params); const body = HandoverAcceptRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await acceptHandover(tx, s, id, body, new Date()); return { body: r.view, audit: r.audit }; }, { hashOmit: ["pin"] });
  });
  app.post("/v1/nursing/handovers/:id/query", own, async (req, reply) => {
    requireAny(req, ["nur", "handover"]); const { id } = pid.parse(req.params); const body = HandoverQueryRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await queryHandover(tx, s, id, body, new Date()); return { body: r.view, audit: r.audit }; });
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
