/* Pharmacy routes (phase 2 slice 2, ADR 0009). Screens ph/dispense, ph/otc and ph/stock (pharmacist, owner, admin) from
   the access matrix. One transaction per request under RLS; writes take an Idempotency-Key and replay inside their own
   transaction. Paying a pharmacy / OTC bill and its receipt use the billing routes, which serve the pharmacist for
   those two kinds only. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DeclineRequest, DispenseRequest, OtcCreateRequest, OtcLineRequest, OtcRevRequest, RxPhotoRequest, StockQuery, type DispenseQueue, type DispenseView, type OtcView, type StockList } from "@setu/contracts";
import { authorize } from "@setu/domain";
import { command, query } from "../command.js";
import { forbidden } from "../errors.js";
import { invoiceHere } from "../modules/billing.js";
import { addOtcLine, addRxPhoto, createOtc, decline, dispense, dispenseQueue, dispenseView, issueOtc, otcView, removeOtcLine, rxPhoto, stockList } from "../modules/pharmacy.js";
import { requireSession } from "../plugins/session.js";

function requirePh(req: FastifyRequest, screen: "dispense" | "otc" | "stock") {
  const s = requireSession(req);
  const d = authorize(s.role, s.plan, "ph", screen);
  if (!d.allowed) throw forbidden(d.reason === "plan" ? "plan" : d.reason === "role" ? "role" : "unknown");
  return s;
}
const pid = z.object({ id: z.string().min(1).max(64) });
const pline = z.object({ id: z.string().min(1).max(64), lineId: z.string().min(1).max(64) });

export async function pharmacyRoutes(app: FastifyInstance) {
  /* ── dispense (ph/dispense) ── */
  app.get("/v1/pharmacy/queue", async (req): Promise<DispenseQueue> => {
    requirePh(req, "dispense");
    return query(req, async (tx, s) => {
      const q = await dispenseQueue(tx, s, new Date());
      return { body: q, audit: [{ action: "view", entity: "MedicationDispense", detail: { purpose: "dispense-queue", count: q.items.length, patientIds: q.items.map((i) => i.encounter.patient.id) } }] };
    });
  });
  app.get("/v1/pharmacy/encounters/:id", async (req): Promise<DispenseView> => {
    requirePh(req, "dispense");
    const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => {
      const v = await dispenseView(tx, s, id, new Date());
      return { body: v, audit: [{ action: "view", entity: "MedicationRequest", entityId: v.composition.id, patientId: v.encounter.patient.id, detail: { purpose: "dispense", encounterId: id } }] };
    });
  });
  app.post("/v1/pharmacy/encounters/:id/dispense", { config: { ownTx: true } }, async (req, reply): Promise<DispenseView> => {
    requirePh(req, "dispense");
    const { id } = pid.parse(req.params);
    const body = DispenseRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await dispense(tx, s, id, body, new Date()); return { status: 200, body: r.view, audit: r.audit }; });
  });
  app.post("/v1/pharmacy/encounters/:id/decline", { config: { ownTx: true } }, async (req, reply): Promise<DispenseView> => {
    requirePh(req, "dispense");
    const { id } = pid.parse(req.params);
    const body = DeclineRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await decline(tx, s, id, body, new Date()); return { status: 200, body: r.view, audit: r.audit }; });
  });

  /* ── over the counter (ph/otc) ── */
  app.post("/v1/pharmacy/otc", { config: { ownTx: true } }, async (req, reply): Promise<OtcView> => {
    requirePh(req, "otc");
    const body = OtcCreateRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => {
      const inv = await createOtc(tx, s, body, new Date());
      return { status: 201, body: await otcView(tx, s, inv, new Date()), audit: [{ action: "create", entity: "Invoice", entityId: inv.id, detail: { kind: "otc", buyer: Boolean(body.buyerName || body.buyerPhone) } }] };
    });
  });
  app.get("/v1/pharmacy/otc/:id", async (req): Promise<OtcView> => {
    requirePh(req, "otc");
    const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => ({ body: await otcView(tx, s, await invoiceHere(tx, s, id), new Date()), audit: [{ action: "view", entity: "Invoice", entityId: id, detail: { kind: "otc" } }] }));
  });
  app.post("/v1/pharmacy/otc/:id/lines", { config: { ownTx: true } }, async (req, reply): Promise<OtcView> => {
    requirePh(req, "otc");
    const { id } = pid.parse(req.params);
    const body = OtcLineRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => {
      const inv = await addOtcLine(tx, s, id, body, new Date());
      return { status: 200, body: await otcView(tx, s, inv, new Date()), audit: [{ action: "update", entity: "Invoice", entityId: id, detail: { kind: "otc", event: "add-line", medicineKey: body.medicineKey, qty: body.qty } }] };
    });
  });
  app.post("/v1/pharmacy/otc/:id/lines/:lineId/remove", { config: { ownTx: true } }, async (req, reply): Promise<OtcView> => {
    requirePh(req, "otc");
    const { id, lineId } = pline.parse(req.params);
    const { rev } = OtcRevRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => {
      const inv = await removeOtcLine(tx, s, id, lineId, rev);
      return { status: 200, body: await otcView(tx, s, inv, new Date()), audit: [{ action: "update", entity: "Invoice", entityId: id, detail: { kind: "otc", event: "remove-line", lineId } }] };
    });
  });
  app.post("/v1/pharmacy/otc/:id/rx-photo", { bodyLimit: 4_500_000, config: { ownTx: true } }, async (req, reply): Promise<OtcView> => {
    requirePh(req, "otc");
    const { id } = pid.parse(req.params);
    const body = RxPhotoRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => {
      const inv = await addRxPhoto(tx, s, id, body);
      return { status: 200, body: await otcView(tx, s, inv, new Date()), audit: [{ action: "create", entity: "RxPhoto", entityId: id, detail: { kind: "otc", contentType: body.contentType } }] };
    });
  });
  app.get("/v1/pharmacy/otc/:id/rx-photo", async (req, reply) => {
    requirePh(req, "otc");
    const { id } = pid.parse(req.params);
    const r = await query(req, async (tx, s) => ({ body: await rxPhoto(tx, s, id), audit: [{ action: "view", entity: "RxPhoto", entityId: id }] }));
    return reply.header("content-type", r.contentType).header("cache-control", "no-store").header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'").header("content-disposition", "inline").send(Buffer.from(r.bytes));
  });
  app.post("/v1/pharmacy/otc/:id/issue", { config: { ownTx: true } }, async (req, reply): Promise<OtcView> => {
    requirePh(req, "otc");
    const { id } = pid.parse(req.params);
    const { rev } = OtcRevRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => {
      const inv = await issueOtc(tx, s, id, rev, new Date());
      return { status: 200, body: await otcView(tx, s, inv, new Date()), audit: [{ action: "issue", entity: "Invoice", entityId: id, detail: { kind: "otc", number: inv.number, totalPaisa: inv.totalPaisa } }] };
    });
  });

  /* ── stock (ph/stock, read) ── */
  app.get("/v1/pharmacy/stock", async (req): Promise<StockList> => {
    requirePh(req, "stock");
    const q = StockQuery.parse(req.query);
    return query(req, async (tx, s) => ({ body: await stockList(tx, s, q.q, q.filter, new Date()), audit: [{ action: "view", entity: "StockBatch", detail: { q: q.q, filter: q.filter } }] }));
  });
}
