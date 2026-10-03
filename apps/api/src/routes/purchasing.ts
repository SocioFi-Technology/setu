/* Pharmacy purchasing, goods received, supplier ledger, counts and transfers (ADR 0009, pharmacy session 2). Screens
   ph/purchase, ph/count and ph/stock (pharmacist, owner, admin); approvals, supplier payments and count decisions are
   the owner's / admin's (checked in the service). Writes take an Idempotency-Key and replay inside their own transaction. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ApprovalDecision, ApprovalStatusQuery, CountCreate, CountLineRequest, GrnCreate, GrnLineRequest, GrnPostRequest, PoCreate, PoEndRequest, PoLineRequest, PoRev, SupplierCreate, SupplierPaymentRequest, TransferRequest,
  type CountList, type GoodsReceiptView, type PharmacyApprovals, type PurchaseOrderList, type PurchaseOrderView, type StockCountView, type SupplierLedger, type SupplierList,
} from "@setu/contracts";
import { authorize } from "@setu/domain";
import { command, query } from "../command.js";
import { forbidden } from "../errors.js";
import { notFound } from "../modules/frontdesk.js";
import {
  addGrnLine, addPoLine, countList, countView, createCount, createGrn, createPo, createSupplier, decideCount, decidePoApproval, discardGrn, endPo, grnView, paySupplier,
  pharmacyApprovals, poList, poView, postGrn, removeGrnLine, removePoLine, sendPo, setCountLine, submitCount, supplierLedger, supplierList, transfer,
} from "../modules/purchasing.js";
import { requireSession } from "../plugins/session.js";

function requirePh(req: FastifyRequest, screen: "purchase" | "count" | "stock") {
  const s = requireSession(req);
  const d = authorize(s.role, s.plan, "ph", screen);
  if (!d.allowed) throw forbidden(d.reason === "plan" ? "plan" : d.reason === "role" ? "role" : "unknown");
  return s;
}
const pid = z.object({ id: z.string().min(1).max(64) });
const pline = z.object({ id: z.string().min(1).max(64), lineId: z.string().min(1).max(64) });
const PoListQuery = z.object({ status: z.enum(["draft", "sent", "partially-received", "received", "cancelled"]).optional() });
const CountListQuery = z.object({ status: z.enum(["counting", "submitted", "approved", "rejected"]).optional() });

export async function purchasingRoutes(app: FastifyInstance) {
  /* ── suppliers ── */
  app.get("/v1/pharmacy/suppliers", async (req): Promise<SupplierList> => {
    requirePh(req, "purchase");
    return query(req, async (tx, s) => ({ body: await supplierList(tx, s), audit: [{ action: "view", entity: "Supplier", detail: { purpose: "supplier-list" } }] }));
  });
  app.post("/v1/pharmacy/suppliers", { config: { ownTx: true } }, async (req, reply): Promise<SupplierLedger> => {
    requirePh(req, "purchase");
    const body = SupplierCreate.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const x = await createSupplier(tx, s, body); return { status: 201, body: await supplierLedger(tx, s, x.id), audit: [{ action: "create", entity: "Supplier", entityId: x.id, detail: { name: x.name } }] }; });
  });
  app.get("/v1/pharmacy/suppliers/:id", async (req): Promise<SupplierLedger> => {
    requirePh(req, "purchase");
    const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => ({ body: await supplierLedger(tx, s, id), audit: [{ action: "view", entity: "Supplier", entityId: id }] }));
  });
  app.post("/v1/pharmacy/suppliers/:id/payments", { config: { ownTx: true } }, async (req, reply): Promise<SupplierLedger> => {
    requirePh(req, "purchase");
    const { id } = pid.parse(req.params);
    const body = SupplierPaymentRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const e = await paySupplier(tx, s, id, body, new Date()); return { status: 201, body: await supplierLedger(tx, s, id), audit: [{ action: "create", entity: "SupplierEntry", entityId: e.id, detail: { kind: "payment", supplierId: id, amountPaisa: body.amountPaisa, note: body.note } }] }; });
  });

  /* ── purchase orders ── */
  app.get("/v1/pharmacy/purchase-orders", async (req): Promise<PurchaseOrderList> => {
    requirePh(req, "purchase");
    const q = PoListQuery.parse(req.query);
    return query(req, async (tx, s) => ({ body: await poList(tx, s, q.status), audit: [{ action: "view", entity: "PurchaseOrder", detail: { purpose: "list", status: q.status ?? null } }] }));
  });
  app.post("/v1/pharmacy/purchase-orders", { config: { ownTx: true } }, async (req, reply): Promise<PurchaseOrderView> => {
    requirePh(req, "purchase");
    const body = PoCreate.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const po = await createPo(tx, s, body.supplierId, body.note, new Date()); return { status: 201, body: await poView(tx, s, po), audit: [{ action: "create", entity: "PurchaseOrder", entityId: po.id, detail: { supplierId: body.supplierId } }] }; });
  });
  app.get("/v1/pharmacy/purchase-orders/:id", async (req): Promise<PurchaseOrderView> => {
    requirePh(req, "purchase");
    const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => {
      const po = await tx.purchaseOrder.findFirst({ where: { id, organizationId: s.organizationId } });
      if (!po) throw notFound();
      return { body: await poView(tx, s, po), audit: [{ action: "view", entity: "PurchaseOrder", entityId: id }] };
    });
  });
  app.post("/v1/pharmacy/purchase-orders/:id/lines", { config: { ownTx: true } }, async (req, reply): Promise<PurchaseOrderView> => {
    requirePh(req, "purchase");
    const { id } = pid.parse(req.params);
    const body = PoLineRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const po = await addPoLine(tx, s, id, body); return { status: 200, body: await poView(tx, s, po), audit: [{ action: "update", entity: "PurchaseOrder", entityId: id, detail: { event: "add-line", medicineKey: body.medicineKey, qty: body.qty, costPaisa: body.costPaisa } }] }; });
  });
  app.post("/v1/pharmacy/purchase-orders/:id/lines/:lineId/remove", { config: { ownTx: true } }, async (req, reply): Promise<PurchaseOrderView> => {
    requirePh(req, "purchase");
    const { id, lineId } = pline.parse(req.params);
    const { rev } = PoRev.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const po = await removePoLine(tx, s, id, lineId, rev); return { status: 200, body: await poView(tx, s, po), audit: [{ action: "update", entity: "PurchaseOrder", entityId: id, detail: { event: "remove-line", lineId } }] }; });
  });
  app.post("/v1/pharmacy/purchase-orders/:id/send", { config: { ownTx: true } }, async (req, reply): Promise<PurchaseOrderView> => {
    requirePh(req, "purchase");
    const { id } = pid.parse(req.params);
    const { rev } = PoRev.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await sendPo(tx, s, id, rev, new Date()); return { status: r.outcome === "sent" ? 200 : 202, body: await poView(tx, s, r.po), audit: r.audit }; });
  });
  app.post("/v1/pharmacy/purchase-orders/:id/approval", { config: { ownTx: true } }, async (req, reply): Promise<PurchaseOrderView> => {
    requirePh(req, "purchase");
    const { id } = pid.parse(req.params);
    const body = ApprovalDecision.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await decidePoApproval(tx, s, id, body, new Date()); return { status: 200, body: await poView(tx, s, r.po), audit: r.audit }; });
  });
  for (const [path, how] of [["cancel", "cancel"], ["close-short", "closeShort"]] as const) {
    app.post(`/v1/pharmacy/purchase-orders/:id/${path}`, { config: { ownTx: true } }, async (req, reply): Promise<PurchaseOrderView> => {
      requirePh(req, "purchase");
      const { id } = pid.parse(req.params);
      const body = PoEndRequest.parse(req.body ?? {});
      return command(req, reply, async (tx, s) => { const po = await endPo(tx, s, id, how, body.rev, body.reason, new Date()); return { status: 200, body: await poView(tx, s, po), audit: [{ action: "update", entity: "PurchaseOrder", entityId: id, detail: { event: how, reason: body.reason } }] }; });
    });
  }

  /* ── goods received ── */
  app.post("/v1/pharmacy/goods-receipts", { config: { ownTx: true } }, async (req, reply): Promise<GoodsReceiptView> => {
    requirePh(req, "purchase");
    const body = GrnCreate.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const g = await createGrn(tx, s, body.orderId, body.supplierInvoiceNo, new Date()); return { status: 201, body: await grnView(tx, s, g, new Date()), audit: [{ action: "create", entity: "GoodsReceipt", entityId: g.id, detail: { orderId: body.orderId } }] }; });
  });
  app.get("/v1/pharmacy/goods-receipts/:id", async (req): Promise<GoodsReceiptView> => {
    requirePh(req, "purchase");
    const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => {
      const g = await tx.goodsReceipt.findFirst({ where: { id, organizationId: s.organizationId } });
      if (!g) throw notFound();
      return { body: await grnView(tx, s, g, new Date()), audit: [{ action: "view", entity: "GoodsReceipt", entityId: id }] };
    });
  });
  app.post("/v1/pharmacy/goods-receipts/:id/lines", { config: { ownTx: true } }, async (req, reply): Promise<GoodsReceiptView> => {
    requirePh(req, "purchase");
    const { id } = pid.parse(req.params);
    const body = GrnLineRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const g = await addGrnLine(tx, s, id, body, new Date()); return { status: 200, body: await grnView(tx, s, g, new Date()), audit: [{ action: "update", entity: "GoodsReceipt", entityId: id, detail: { event: "add-line", orderLineId: body.orderLineId, batchNo: body.batchNo, expiry: body.expiry, invoicedQty: body.invoicedQty, receivedQty: body.receivedQty } }] }; });
  });
  app.post("/v1/pharmacy/goods-receipts/:id/lines/:lineId/remove", { config: { ownTx: true } }, async (req, reply): Promise<GoodsReceiptView> => {
    requirePh(req, "purchase");
    const { id, lineId } = pline.parse(req.params);
    const { rev } = PoRev.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const g = await removeGrnLine(tx, s, id, lineId, rev); return { status: 200, body: await grnView(tx, s, g, new Date()), audit: [{ action: "update", entity: "GoodsReceipt", entityId: id, detail: { event: "remove-line", lineId } }] }; });
  });
  app.post("/v1/pharmacy/goods-receipts/:id/post", { config: { ownTx: true } }, async (req, reply): Promise<GoodsReceiptView> => {
    requirePh(req, "purchase");
    const { id } = pid.parse(req.params);
    const body = GrnPostRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await postGrn(tx, s, id, body.rev, body.note, new Date()); return { status: 200, body: await grnView(tx, s, r.g, new Date()), audit: r.audit }; });
  });
  app.post("/v1/pharmacy/goods-receipts/:id/discard", { config: { ownTx: true } }, async (req, reply): Promise<GoodsReceiptView> => {
    requirePh(req, "purchase");
    const { id } = pid.parse(req.params);
    const { rev } = PoRev.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const g = await discardGrn(tx, s, id, rev, new Date()); return { status: 200, body: await grnView(tx, s, g, new Date()), audit: [{ action: "update", entity: "GoodsReceipt", entityId: id, detail: { event: "discard" } }] }; });
  });

  /* ── counts ── */
  app.get("/v1/pharmacy/counts", async (req): Promise<CountList> => {
    requirePh(req, "count");
    const q = CountListQuery.parse(req.query);
    return query(req, async (tx, s) => ({ body: await countList(tx, s, q.status), audit: [{ action: "view", entity: "StockCount", detail: { purpose: "list", status: q.status ?? null } }] }));
  });
  app.post("/v1/pharmacy/counts", { config: { ownTx: true } }, async (req, reply): Promise<StockCountView> => {
    requirePh(req, "count");
    const body = CountCreate.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const c = await createCount(tx, s, body.location, new Date()); return { status: 201, body: await countView(tx, s, c, new Date()), audit: [{ action: "create", entity: "StockCount", entityId: c.id, detail: { location: body.location } }] }; });
  });
  app.get("/v1/pharmacy/counts/:id", async (req): Promise<StockCountView> => {
    requirePh(req, "count");
    const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => {
      const c = await tx.stockCount.findFirst({ where: { id, organizationId: s.organizationId } });
      if (!c) throw notFound();
      return { body: await countView(tx, s, c, new Date()), audit: [{ action: "view", entity: "StockCount", entityId: id }] };
    });
  });
  app.post("/v1/pharmacy/counts/:id/lines", { config: { ownTx: true } }, async (req, reply): Promise<StockCountView> => {
    requirePh(req, "count");
    const { id } = pid.parse(req.params);
    const body = CountLineRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const c = await setCountLine(tx, s, id, body); return { status: 200, body: await countView(tx, s, c, new Date()), audit: [{ action: "update", entity: "StockCount", entityId: id, detail: { lineId: body.lineId, countedQty: body.countedQty, reason: body.reason ?? null } }] }; });
  });
  app.post("/v1/pharmacy/counts/:id/submit", { config: { ownTx: true } }, async (req, reply): Promise<StockCountView> => {
    requirePh(req, "count");
    const { id } = pid.parse(req.params);
    const { rev } = PoRev.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const c = await submitCount(tx, s, id, rev, new Date()); return { status: 200, body: await countView(tx, s, c, new Date()), audit: [{ action: "update", entity: "StockCount", entityId: id, detail: { event: "submit" } }] }; });
  });
  app.post("/v1/pharmacy/counts/:id/decision", { config: { ownTx: true } }, async (req, reply): Promise<StockCountView> => {
    requirePh(req, "count");
    const { id } = pid.parse(req.params);
    const body = ApprovalDecision.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await decideCount(tx, s, id, body, new Date()); return { status: 200, body: await countView(tx, s, r.c, new Date()), audit: r.audit }; });
  });

  /* ── store ↔ counter ── */
  app.post("/v1/pharmacy/transfers", { config: { ownTx: true } }, async (req, reply): Promise<{ from: string; to: string }> => {
    requirePh(req, "stock");
    const body = TransferRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await transfer(tx, s, body, new Date()); return { status: 201, body: { from: r.from, to: r.to }, audit: r.audit }; });
  });

  /* ── the owner's / admin's pharmacy approvals ── */
  app.get("/v1/pharmacy/approvals", async (req): Promise<PharmacyApprovals> => {
    requirePh(req, "purchase");
    const { status } = ApprovalStatusQuery.parse(req.query);
    return query(req, async (tx, s) => ({ body: await pharmacyApprovals(tx, s, status, new Date()), audit: [{ action: "view", entity: "Task", detail: { purpose: "pharmacy-approvals", status } }] }));
  });
}
