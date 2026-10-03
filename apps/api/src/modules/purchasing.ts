/* Pharmacy purchasing, goods received, supplier ledger, counts and transfers (ADR 0009, pharmacy session 2). Runs inside
   command()/query(), so RLS scopes every read to the tenant; every row here is also scoped to the session's facility.
   - Purchase order: draft → sent (above the sample threshold the pharmacist asks; the owner / admin approves and sends)
     → received in goods receipts → received (or closed short); cancelled only before anything arrives.
   - Goods receipt: lines checked at the counter (@setu/domain grnLineBlockers); posting writes each batch's `receive`
     move, grows the order's received quantities, and the supplier ledger (goods received; a short delivery = debit
     note). A batch expiring within 6 months is posted only by the owner / admin.
   - Count: the system quantity of every batch at a location is fixed when the count starts; counted − system needs a
     reason; stock changes only when the owner / admin (not the counter) approves — `adjust` moves by the difference.
   - Transfer: store → counter (or back) as a pair of `transfer` moves on the same batch number, expiry and prices.
   The database re-checks the machines, the ledger and who did what (migration pharmacy_purchasing). */
import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision, CountLineRequest, CountList, GoodsReceiptView, GrnLineRequest, PharmacyApprovals, PoLineRequest, PurchaseOrderList, PurchaseOrderView,
  StockCountView, SupplierCreate, SupplierLedger, SupplierList, SupplierPaymentRequest, TransferRequest,
} from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  APPROVAL, GOODS_RECEIPT, PO_APPROVAL_PAISA_SAMPLE, PURCHASE_ORDER, STOCK_COUNT, MEDICINES_SAMPLE, batchState, countDecisionBlockers, countSubmitBlockers, dhakaDay,
  grnLineBlockers, grnMoney, grnPostBlockers, isStockApprover, poEventAfterReceipt, poSendBlockers, poTotalPaisa, priceVariance, shortExpiry, supplierOwedPaisa, transition, withinMoneyRange,
  type GrnLine, type PurchaseOrderState, type Role, type SupplierEntryKind,
} from "@setu/domain";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { notFound } from "./frontdesk.js";
import { medRef } from "./pharmacy.js";

export const PO_APPROVAL_TASK = "purchase-approval";
const dash = <T extends string>(s: string) => s.replace(/_/g, "-") as T;
const undash = <T extends string>(s: string) => s.replace(/-/g, "_") as T;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const MED = new Set(MEDICINES_SAMPLE.map((m) => m.id));
const stale = () => err(409, "stale", "অন্য কোথাও আগেই বদলানো হয়েছে — আবার খুলুন", "This was changed somewhere else first — reopen it");
const tooLarge = () => err(422, "too_large", "পরিমাণ খুব বড়", "The amount is too large", { field: "qty" });
const notApprover = () => err(403, "forbidden", "শুধু মালিক বা অ্যাডমিন", "Only the owner or an admin can do this", { reason: "role", canRequest: false });

type Po = NonNullable<Awaited<ReturnType<Tx["purchaseOrder"]["findFirst"]>>>;
type Grn = NonNullable<Awaited<ReturnType<Tx["goodsReceipt"]["findFirst"]>>>;
type Count = NonNullable<Awaited<ReturnType<Tx["stockCount"]["findFirst"]>>>;

async function people(tx: Tx, ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const rows = list.length ? await tx.user.findMany({ where: { id: { in: list } }, select: { id: true, nameBn: true, nameEn: true } }) : [];
  const m = new Map(rows.map((r) => [r.id, r]));
  return (id: string) => m.get(id) ?? { id, nameBn: "—", nameEn: "—" };
}
async function nextNumber(tx: Tx, s: SessionData, prefix: "PO" | "GRN", now: Date) {
  const yy = dhakaDay(now).slice(2, 4);
  const name = `${prefix.toLowerCase()}:${s.organizationId}:${yy}`;
  const seq = await tx.sequence.upsert({ where: { tenantId_name: { tenantId: s.tenantId, name } }, create: { tenantId: s.tenantId, name, value: 1 }, update: { value: { increment: 1 } } });
  return `${prefix}/${yy}/${String(seq.value).padStart(4, "0")}`;
}
const lock = (tx: Tx, table: "PurchaseOrder" | "GoodsReceipt" | "StockCount", id: string) =>
  table === "PurchaseOrder" ? tx.$queryRaw`SELECT 1 FROM "PurchaseOrder" WHERE "id" = ${id} FOR UPDATE`
  : table === "GoodsReceipt" ? tx.$queryRaw`SELECT 1 FROM "GoodsReceipt" WHERE "id" = ${id} FOR UPDATE`
  : tx.$queryRaw`SELECT 1 FROM "StockCount" WHERE "id" = ${id} FOR UPDATE`;

/* ───── suppliers ───── */
async function owedBySupplier(tx: Tx, s: SessionData, ids?: string[]) {
  const rows = await tx.supplierEntry.groupBy({ by: ["supplierId", "kind"], where: { organizationId: s.organizationId, ...(ids ? { supplierId: { in: ids } } : {}) }, _sum: { amountPaisa: true } });
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.supplierId, (out.get(r.supplierId) ?? 0) + supplierOwedPaisa([{ kind: r.kind as SupplierEntryKind, amountPaisa: r._sum.amountPaisa ?? 0 }]));
  return out;
}
async function supplierHere(tx: Tx, s: SessionData, id: string) {
  const x = await tx.supplier.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!x) throw notFound();
  return x;
}
export async function supplierList(tx: Tx, s: SessionData): Promise<SupplierList> {
  const rows = await tx.supplier.findMany({ where: { organizationId: s.organizationId }, orderBy: { name: "asc" } });
  const owed = await owedBySupplier(tx, s);
  return { items: rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone ? `0${r.phone}` : null, active: r.active, sample: r.sample, owedPaisa: owed.get(r.id) ?? 0 })) };
}
export async function createSupplier(tx: Tx, s: SessionData, req: SupplierCreate) {
  return tx.supplier.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, name: req.name.trim(), phone: req.phone ? req.phone.slice(1) : null } });
}
export async function supplierLedger(tx: Tx, s: SessionData, id: string): Promise<SupplierLedger> {
  const x = await supplierHere(tx, s, id);
  const entries = await tx.supplierEntry.findMany({ where: { supplierId: x.id, organizationId: s.organizationId }, orderBy: { at: "desc" }, take: 200 });
  const grns = await tx.goodsReceipt.findMany({ where: { id: { in: entries.filter((e) => e.refType === "grn").map((e) => e.refId!) } }, select: { id: true, number: true } });
  const who = await people(tx, entries.map((e) => e.byId));
  return {
    supplier: { id: x.id, name: x.name, phone: x.phone ? `0${x.phone}` : null, active: x.active, sample: x.sample, owedPaisa: (await owedBySupplier(tx, s, [x.id])).get(x.id) ?? 0 },
    entries: entries.map((e) => ({ id: e.id, kind: e.kind as SupplierEntryKind, amountPaisa: e.amountPaisa, ref: e.refType === "grn" ? grns.find((g) => g.id === e.refId)?.number ?? null : null, note: e.note, by: who(e.byId), at: e.at.toISOString() })),
  };
}
/** A payment to the supplier — owner / admin only, never more than is owed. */
export async function paySupplier(tx: Tx, s: SessionData, id: string, req: SupplierPaymentRequest, now: Date) {
  if (!isStockApprover(s.role as Role)) throw notApprover();
  const x = await supplierHere(tx, s, id);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7010, hashtext(${x.id}))`;
  const owed = (await owedBySupplier(tx, s, [x.id])).get(x.id) ?? 0;
  if (req.amountPaisa > owed) throw err(409, "over_owed", "বকেয়ার চেয়ে বেশি", "More than is owed to this supplier", { field: "amountPaisa", amountPaisa: owed });
  return tx.supplierEntry.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, supplierId: x.id, kind: "payment", amountPaisa: req.amountPaisa, refType: "payment", note: req.note.trim(), byId: s.userId, at: now } });
}

/* ───── purchase orders ───── */
async function poHere(tx: Tx, s: SessionData, id: string, locked = false): Promise<Po> {
  if (locked) await lock(tx, "PurchaseOrder", id);
  const po = await tx.purchaseOrder.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!po) throw notFound();
  return po;
}
async function draftPo(tx: Tx, s: SessionData, id: string, rev: number): Promise<Po> {
  const po = await poHere(tx, s, id, true);
  if (po.status !== "draft") throw err(409, "not_draft", "পাঠানো অর্ডার বদলানো যায় না", "A sent order cannot be changed");
  if (po.rev !== rev) throw stale();
  if (await openApproval(tx, po.id)) throw err(409, "approval_pending", "মালিকের অনুমোদনের অপেক্ষায় — এখন বদলানো যায় না", "Waiting for the owner's approval — it cannot be changed now");
  return po;
}
const openApproval = (tx: Tx, id: string) => tx.task.findFirst({ where: { kind: PO_APPROVAL_TASK, focusId: id, status: "requested" } });
/** The approval that lets this exact order (its rev) be sent. */
async function approvalFor(tx: Tx, po: Po) {
  return tx.task.findFirst({ where: { kind: PO_APPROVAL_TASK, focusId: po.id }, orderBy: { requestedAt: "desc" } });
}

export async function poView(tx: Tx, s: SessionData, po: Po): Promise<PurchaseOrderView> {
  const [lines, supplier, task, receipts] = await Promise.all([
    tx.purchaseOrderLine.findMany({ where: { orderId: po.id }, orderBy: { position: "asc" } }),
    tx.supplier.findFirst({ where: { id: po.supplierId } }),
    approvalFor(tx, po),
    tx.goodsReceipt.findMany({ where: { orderId: po.id }, orderBy: { createdAt: "asc" } }),
  ]);
  const who = await people(tx, [po.createdById, po.sentById, task?.requestedById, task?.decidedById]);
  const approvedForRev = task?.status === "approved" && (task.detail as { rev?: number } | null)?.rev === po.rev;
  const sendBlockers = po.status !== "draft" ? [] : task?.status === "requested" ? ["approval_pending" as const]
    : poSendBlockers({ lines, role: s.role as Role, approved: approvedForRev });
  return {
    id: po.id, number: po.number, status: dash<PurchaseOrderState>(po.status), rev: po.rev,
    supplier: { id: po.supplierId, name: supplier?.name ?? "—" }, totalPaisa: po.totalPaisa, note: po.note, endReason: po.cancelReason,
    lines: lines.map((l) => ({ id: l.id, position: l.position, medicine: medRef(l.medicineKey), qty: l.qty, costPaisa: l.costPaisa, receivedQty: l.receivedQty })),
    approval: task ? { taskId: task.id, status: task.status as "requested" | "approved" | "rejected", requestedBy: who(task.requestedById), requestedAt: task.requestedAt.toISOString(),
      decidedBy: task.decidedById ? who(task.decidedById) : null, decidedAt: iso(task.decidedAt), note: task.decisionNote } : null,
    sendBlockers, approvalThresholdPaisa: PO_APPROVAL_PAISA_SAMPLE,
    receipts: receipts.map((r) => ({ id: r.id, number: r.number, status: r.status, postedAt: iso(r.postedAt) })),
    createdBy: who(po.createdById), createdAt: po.createdAt.toISOString(), sentBy: po.sentById ? who(po.sentById) : null, sentAt: iso(po.sentAt),
  };
}
export async function poList(tx: Tx, s: SessionData, status?: PurchaseOrderState): Promise<PurchaseOrderList> {
  const rows = await tx.purchaseOrder.findMany({ where: { organizationId: s.organizationId, ...(status ? { status: undash<"draft">(status) } : {}) }, orderBy: { createdAt: "desc" }, take: 100, include: { _count: { select: { lines: true } } } });
  const sup = new Map((await tx.supplier.findMany({ where: { id: { in: rows.map((r) => r.supplierId) } } })).map((x) => [x.id, x.name]));
  const pending = new Set((await tx.task.findMany({ where: { kind: PO_APPROVAL_TASK, status: "requested", focusId: { in: rows.map((r) => r.id) } }, select: { focusId: true } })).map((t) => t.focusId));
  return { items: rows.map((r) => ({ id: r.id, number: r.number, status: dash<PurchaseOrderState>(r.status), supplier: { id: r.supplierId, name: sup.get(r.supplierId) ?? "—" }, totalPaisa: r.totalPaisa, lineCount: r._count.lines, approvalPending: pending.has(r.id), createdAt: r.createdAt.toISOString() })) };
}
export async function createPo(tx: Tx, s: SessionData, supplierId: string, note: string | undefined, now: Date): Promise<Po> {
  const x = await supplierHere(tx, s, supplierId);
  if (!x.active) throw err(409, "supplier_inactive", "এই সরবরাহকারী সক্রিয় নয়", "This supplier is not active");
  return tx.purchaseOrder.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, supplierId: x.id, note: note?.trim() || null, createdById: s.userId, createdAt: now, statusAt: now } });
}
async function retotal(tx: Tx, po: Po): Promise<Po> {
  const lines = await tx.purchaseOrderLine.findMany({ where: { orderId: po.id } });
  const n = await tx.purchaseOrder.updateMany({ where: { id: po.id, rev: po.rev, status: "draft" }, data: { totalPaisa: poTotalPaisa(lines), rev: po.rev + 1 } });
  if (n.count !== 1) throw stale();
  return (await tx.purchaseOrder.findFirst({ where: { id: po.id } }))!;
}
export async function addPoLine(tx: Tx, s: SessionData, id: string, req: PoLineRequest): Promise<Po> {
  const po = await draftPo(tx, s, id, req.rev);
  if (!MED.has(req.medicineKey)) throw err(404, "unknown_medicine", "এই ওষুধ তালিকায় নেই", "This medicine is not on the list", { field: "medicineKey" });
  const lines = await tx.purchaseOrderLine.findMany({ where: { orderId: po.id } });
  if (lines.some((l) => l.medicineKey === req.medicineKey)) throw err(409, "already_on_order", "এই ওষুধ অর্ডারে আছে — পরিমাণ বদলাতে লাইনটি সরিয়ে আবার দিন", "This medicine is already on the order", { field: "medicineKey" });
  if (!withinMoneyRange(poTotalPaisa([...lines, req]))) throw tooLarge();
  await tx.purchaseOrderLine.create({ data: { tenantId: s.tenantId, orderId: po.id, position: lines.reduce((a, l) => Math.max(a, l.position), 0) + 1, medicineKey: req.medicineKey, qty: req.qty, costPaisa: req.costPaisa } });
  return retotal(tx, po);
}
export async function removePoLine(tx: Tx, s: SessionData, id: string, lineId: string, rev: number): Promise<Po> {
  const po = await draftPo(tx, s, id, rev);
  const n = await tx.purchaseOrderLine.deleteMany({ where: { id: lineId, orderId: po.id } });
  if (n.count !== 1) throw notFound();
  return retotal(tx, po);
}
async function doSend(tx: Tx, s: SessionData, po: Po, now: Date) {
  const status = undash<"sent">(transition("PURCHASE_ORDER", PURCHASE_ORDER, "draft", "send"));
  const n = await tx.purchaseOrder.updateMany({ where: { id: po.id, rev: po.rev, status: "draft" }, data: { status, number: await nextNumber(tx, s, "PO", now), sentById: s.userId, sentAt: now, statusAt: now } });
  if (n.count !== 1) throw stale();
}
/** Send, or — above the threshold, for the pharmacist — ask the owner / admin (an APPROVAL Task; the order waits). */
export async function sendPo(tx: Tx, s: SessionData, id: string, rev: number, now: Date): Promise<{ po: Po; outcome: "sent" | "approval-requested"; audit: AuditEntry[] }> {
  const po = await draftPo(tx, s, id, rev);
  const lines = await tx.purchaseOrderLine.findMany({ where: { orderId: po.id } });
  const task = await approvalFor(tx, po);
  const approved = task?.status === "approved" && (task.detail as { rev?: number } | null)?.rev === po.rev;
  const b = poSendBlockers({ lines, role: s.role as Role, approved });
  if (b.includes("no_lines")) throw err(422, "no_lines", "অর্ডারে কোনো লাইন নেই", "The order has no lines");
  if (b.includes("approval_required")) {
    const t = await tx.task.create({ data: { tenantId: s.tenantId, kind: PO_APPROVAL_TASK, status: "requested", focusId: po.id, reason: `Purchase order ${po.totalPaisa} paisa above ${PO_APPROVAL_PAISA_SAMPLE}`, detail: { rev: po.rev, totalPaisa: po.totalPaisa } as object, requestedById: s.userId, requestedAt: now } });
    return { po, outcome: "approval-requested", audit: [{ action: "create", entity: "Task", entityId: t.id, detail: { kind: PO_APPROVAL_TASK, orderId: po.id, totalPaisa: po.totalPaisa } }] };
  }
  await doSend(tx, s, po, now);
  return { po: (await tx.purchaseOrder.findFirst({ where: { id: po.id } }))!, outcome: "sent", audit: [{ action: "update", entity: "PurchaseOrder", entityId: po.id, detail: { event: "send", totalPaisa: po.totalPaisa, approvedBy: approved ? task!.decidedById : null } }] };
}
/** The owner / admin decides; approving sends the order at once (as the approver). Never one's own request. */
export async function decidePoApproval(tx: Tx, s: SessionData, id: string, req: ApprovalDecision, now: Date): Promise<{ po: Po; audit: AuditEntry[] }> {
  if (!isStockApprover(s.role as Role)) throw notApprover();
  const po = await poHere(tx, s, id, true);
  const task = await openApproval(tx, po.id);
  if (!task) throw err(409, "no_request", "অনুমোদনের অনুরোধ নেই", "There is no approval request on this order");
  if (task.requestedById === s.userId) throw err(403, "own_request", "নিজের অনুরোধ নিজে অনুমোদন করা যায় না", "You cannot decide your own request", { reason: "role", canRequest: false });
  const note = req.note?.trim() ?? "";
  if (req.decision === "reject" && note.length < 10) throw err(400, "note_required", "কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write why (at least 10 characters)", { field: "note" });
  if ((task.detail as { rev?: number } | null)?.rev !== po.rev) throw stale();
  const status = transition("APPROVAL", APPROVAL, "requested", req.decision);
  const n = await tx.task.updateMany({ where: { id: task.id, status: "requested" }, data: { status, decidedById: s.userId, decidedAt: now, decisionNote: note || null } });
  if (n.count !== 1) throw stale();
  if (req.decision === "approve") await doSend(tx, s, po, now);
  return { po: (await tx.purchaseOrder.findFirst({ where: { id: po.id } }))!, audit: [
    { action: req.decision, entity: "Task", entityId: task.id, detail: { kind: PO_APPROVAL_TASK, orderId: po.id, totalPaisa: po.totalPaisa, note: note || null } },
    ...(req.decision === "approve" ? [{ action: "update", entity: "PurchaseOrder", entityId: po.id, detail: { event: "send" } }] : []),
  ] };
}
export async function endPo(tx: Tx, s: SessionData, id: string, how: "cancel" | "closeShort", rev: number, reason: string, now: Date): Promise<Po> {
  const po = await poHere(tx, s, id, true);
  if (po.rev !== rev) throw stale();
  if (reason.trim().length < 10) throw err(400, "reason_required", "কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write a reason (at least 10 characters)", { field: "reason" });
  if (how === "cancel" && (await tx.purchaseOrderLine.findFirst({ where: { orderId: po.id, receivedQty: { gt: 0 } } })))
    throw err(409, "goods_arrived", "মাল এসেছে — বাতিল নয়, বাকিটা বন্ধ করুন", "Goods already arrived — close the rest short instead");
  if (await tx.goodsReceipt.findFirst({ where: { orderId: po.id, status: "checking" } }))
    throw err(409, "receipt_open", "একটি মাল গ্রহণ যাচাই চলছে — আগে সেটি পোস্ট বা বাদ দিন", "A goods receipt is still being checked — post or discard it first");
  const to = undash<"cancelled" | "received">(transition("PURCHASE_ORDER", PURCHASE_ORDER, dash<PurchaseOrderState>(po.status), how));
  const n = await tx.purchaseOrder.updateMany({ where: { id: po.id, rev: po.rev, status: po.status }, data: { status: to, cancelReason: reason.trim(), rev: po.rev + 1, statusAt: now } });
  if (n.count !== 1) throw stale();
  // a cancelled order's open approval request is closed with it (audited by the route with the cancel)
  await tx.task.updateMany({ where: { kind: PO_APPROVAL_TASK, focusId: po.id, status: "requested" }, data: { status: "rejected", decidedById: s.userId, decidedAt: now, decisionNote: "order cancelled" } });
  return (await tx.purchaseOrder.findFirst({ where: { id: po.id } }))!;
}

/* ───── goods received ───── */
async function grnHere(tx: Tx, s: SessionData, id: string, locked = false): Promise<Grn> {
  if (locked) await lock(tx, "GoodsReceipt", id);
  const g = await tx.goodsReceipt.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!g) throw notFound();
  return g;
}
async function checkingGrn(tx: Tx, s: SessionData, id: string, rev: number): Promise<Grn> {
  const g = await grnHere(tx, s, id, true);
  if (g.status !== "checking") throw err(409, "not_checking", "পোস্ট করা মাল গ্রহণ বদলানো যায় না", "A posted goods receipt cannot be changed");
  if (g.rev !== rev) throw stale();
  return g;
}
/** The domain view of a receipt's lines: what was ordered and what earlier postings (and other lines here) took. */
async function grnLines(tx: Tx, g: Grn) {
  const lines = await tx.goodsReceiptLine.findMany({ where: { receiptId: g.id }, orderBy: { id: "asc" } });
  const orderLines = new Map((await tx.purchaseOrderLine.findMany({ where: { orderId: g.orderId } })).map((l) => [l.id, l]));
  return lines.map((l) => {
    const ol = orderLines.get(l.orderLineId)!;
    const before = g.status === "posted" ? ol.receivedQty - l.receivedQty : ol.receivedQty;
    const sameHere = lines.filter((x) => x.orderLineId === l.orderLineId && x.id < l.id).reduce((a, x) => a + x.receivedQty, 0);
    const d: GrnLine = { orderedQty: ol.qty, alreadyReceivedQty: before + sameHere, invoicedQty: l.invoicedQty, receivedQty: l.receivedQty, batchNo: l.batchNo, expiry: l.expiry, costPaisa: l.costPaisa, mrpPaisa: l.mrpPaisa, orderCostPaisa: ol.costPaisa };
    return { row: l, d };
  });
}
export async function grnView(tx: Tx, s: SessionData, g: Grn, now: Date): Promise<GoodsReceiptView> {
  const today = dhakaDay(now);
  const [lines, po, supplier] = await Promise.all([grnLines(tx, g), tx.purchaseOrder.findFirst({ where: { id: g.orderId } }), tx.supplier.findFirst({ where: { id: g.supplierId } })]);
  const who = await people(tx, [g.createdById, g.postedById]);
  return {
    id: g.id, number: g.number, status: g.status, rev: g.rev,
    order: { id: g.orderId, number: po?.number ?? null, status: dash<PurchaseOrderState>(po?.status ?? "sent") },
    supplier: { id: g.supplierId, name: supplier?.name ?? "—" }, supplierInvoiceNo: g.supplierInvoiceNo, note: g.note,
    lines: lines.map(({ row: l, d }) => ({
      id: l.id, orderLineId: l.orderLineId, medicine: medRef(l.medicineKey), batchNo: l.batchNo, expiry: l.expiry, invoicedQty: l.invoicedQty, receivedQty: l.receivedQty,
      costPaisa: l.costPaisa, mrpPaisa: l.mrpPaisa, vatRateBp: l.vatRateBp, location: l.location as "counter" | "store" | "fridge",
      shortExpiry: shortExpiry(l.expiry, today), blockers: g.status === "checking" ? grnLineBlockers(d, today) : [],
      orderCostPaisa: d.orderCostPaisa, priceVariance: priceVariance(d),
    })),
    money: g.status === "posted" ? { invoicedPaisa: g.invoicedPaisa, debitNotePaisa: g.debitNotePaisa, owedPaisa: g.invoicedPaisa - g.debitNotePaisa } : grnMoney(lines.map((x) => x.d)),
    postBlockers: g.status === "checking" ? grnPostBlockers({ lines: lines.map((x) => x.d), role: s.role as Role, today }) : [],
    createdBy: who(g.createdById), createdAt: g.createdAt.toISOString(), postedBy: g.postedById ? who(g.postedById) : null, postedAt: iso(g.postedAt),
  };
}
export async function createGrn(tx: Tx, s: SessionData, orderId: string, supplierInvoiceNo: string | undefined, now: Date): Promise<Grn> {
  const po = await poHere(tx, s, orderId, true);
  if (po.status !== "sent" && po.status !== "partially_received") throw err(409, "order_not_open", "এই অর্ডারে মাল গ্রহণ করা যায় না", "This order is not open for goods");
  return tx.goodsReceipt.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, orderId: po.id, supplierId: po.supplierId, supplierInvoiceNo: supplierInvoiceNo?.trim() || null, createdById: s.userId, createdAt: now, statusAt: now } });
}
const GRN_MSG: Record<string, [string, string]> = {
  batch_required: ["ব্যাচ নম্বর লিখুন", "Enter the batch number"], expiry_invalid: ["মেয়াদের তারিখ ঠিক নেই", "The expiry date is not valid"],
  expired: ["মেয়াদোত্তীর্ণ ব্যাচ গ্রহণ করা যায় না", "An expired batch is never received"], over_invoice: ["চালানের চেয়ে বেশি পাওয়া যায় না", "Received cannot be more than the supplier billed"],
  over_order: ["অর্ডারের বাকি পরিমাণের বেশি", "More than is still open on the order"], mrp_below_cost: ["MRP ক্রয়মূল্যের কম", "The MRP is below the cost"],
  nothing_received: ["পরিমাণ লিখুন", "Enter the quantity"],
};
export async function addGrnLine(tx: Tx, s: SessionData, id: string, req: GrnLineRequest, now: Date): Promise<Grn> {
  const g = await checkingGrn(tx, s, id, req.rev);
  const ol = await tx.purchaseOrderLine.findFirst({ where: { id: req.orderLineId, orderId: g.orderId } });
  if (!ol) throw err(404, "line_not_found", "এই লাইন অর্ডারে নেই", "This line is not on the order", { field: "orderLineId" });
  const here = (await tx.goodsReceiptLine.findMany({ where: { receiptId: g.id, orderLineId: ol.id } })).reduce((a, l) => a + l.receivedQty, 0);
  const b = grnLineBlockers({ orderedQty: ol.qty, alreadyReceivedQty: ol.receivedQty + here, invoicedQty: req.invoicedQty, receivedQty: req.receivedQty, batchNo: req.batchNo, expiry: req.expiry, costPaisa: req.costPaisa, mrpPaisa: req.mrpPaisa, orderCostPaisa: ol.costPaisa }, dhakaDay(now));
  if (b.length) { const [bn, en] = GRN_MSG[b[0]!]!; throw err(422, b[0]!, bn, en, { blockers: b.map((code) => ({ code })) }); }
  const all = [...(await tx.goodsReceiptLine.findMany({ where: { receiptId: g.id } })), req];
  if (!withinMoneyRange(grnMoney(all).invoicedPaisa)) throw tooLarge();
  await tx.goodsReceiptLine.create({ data: {
    tenantId: s.tenantId, receiptId: g.id, orderLineId: ol.id, medicineKey: ol.medicineKey, batchNo: req.batchNo.trim().toUpperCase(), expiry: req.expiry,
    invoicedQty: req.invoicedQty, receivedQty: req.receivedQty, costPaisa: req.costPaisa, mrpPaisa: req.mrpPaisa, vatRateBp: req.vatRateBp, location: req.location,
  } });
  return bumpGrn(tx, g);
}
async function bumpGrn(tx: Tx, g: Grn, data: Record<string, unknown> = {}): Promise<Grn> {
  const n = await tx.goodsReceipt.updateMany({ where: { id: g.id, rev: g.rev, status: "checking" }, data: { ...data, rev: g.rev + 1 } });
  if (n.count !== 1) throw stale();
  return (await tx.goodsReceipt.findFirst({ where: { id: g.id } }))!;
}
export async function removeGrnLine(tx: Tx, s: SessionData, id: string, lineId: string, rev: number): Promise<Grn> {
  const g = await checkingGrn(tx, s, id, rev);
  const n = await tx.goodsReceiptLine.deleteMany({ where: { id: lineId, receiptId: g.id } });
  if (n.count !== 1) throw notFound();
  return bumpGrn(tx, g);
}
export async function discardGrn(tx: Tx, s: SessionData, id: string, rev: number, now: Date): Promise<Grn> {
  const g = await checkingGrn(tx, s, id, rev);
  return bumpGrn(tx, g, { status: transition("GOODS_RECEIPT", GOODS_RECEIPT, "checking", "discard"), statusAt: now });
}
/** The batch a received line goes into: the existing one (same batch number at that location) when it is the same
    expiry and prices, else a new one. A same-number batch with another expiry or price is refused. */
async function batchFor(tx: Tx, s: SessionData, l: { medicineKey: string; batchNo: string; expiry: string; costPaisa: number; mrpPaisa: number; vatRateBp: number; location: string }, sample = false) {
  const b = await tx.stockBatch.findFirst({ where: { organizationId: s.organizationId, medicineKey: l.medicineKey, batchNo: l.batchNo, location: l.location } });
  if (b) {
    if (b.expiry !== l.expiry || b.costPaisa !== l.costPaisa || b.mrpPaisa !== l.mrpPaisa || b.vatRateBp !== l.vatRateBp)
      throw err(409, "batch_conflict", `ব্যাচ ${l.batchNo} আগে অন্য মেয়াদ/মূল্যে আছে`, `Batch ${l.batchNo} is already held with another expiry or price`, { field: "batchNo" });
    return b;
  }
  return tx.stockBatch.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, medicineKey: l.medicineKey, batchNo: l.batchNo, expiry: l.expiry, location: l.location, costPaisa: l.costPaisa, mrpPaisa: l.mrpPaisa, vatRateBp: l.vatRateBp, sample } });
}
export async function postGrn(tx: Tx, s: SessionData, id: string, rev: number, note: string | undefined, now: Date): Promise<{ g: Grn; audit: AuditEntry[] }> {
  const g = await checkingGrn(tx, s, id, rev);
  const po = await poHere(tx, s, g.orderId, true);
  if (po.status !== "sent" && po.status !== "partially_received") throw err(409, "order_not_open", "এই অর্ডারে মাল গ্রহণ করা যায় না", "This order is not open for goods");
  const today = dhakaDay(now);
  const lines = await grnLines(tx, g);
  const b = grnPostBlockers({ lines: lines.map((x) => x.d), role: s.role as Role, today });
  if (b.length) {
    const owner = b.find((x) => x === "short_expiry_needs_owner" || x === "price_variance_needs_owner");
    const [bn, en] = owner === "short_expiry_needs_owner" ? ["৬ মাসের মধ্যে মেয়াদ শেষ — মালিক বা অ্যাডমিন পোস্ট করবেন", "A batch expires within 6 months — the owner or an admin posts it"]
      : owner ? ["চালানের দাম অর্ডারের দাম থেকে আলাদা — মালিক বা অ্যাডমিন পোস্ট করবেন", "The bill's unit cost differs from the order — the owner or an admin posts it"]
      : ["মাল গ্রহণ পোস্ট করা যাচ্ছে না", "The goods receipt cannot be posted yet"];
    throw err(owner && !b.includes("line_invalid") && !b.includes("no_lines") ? 403 : 422, owner && !b.includes("line_invalid") && !b.includes("no_lines") ? owner : "post_blocked", bn, en, { blockers: b.map((code) => ({ code })) });
  }
  for (const { row: l } of lines) {
    if (l.receivedQty === 0) continue;
    const batch = await batchFor(tx, s, l);
    await tx.stockMove.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, batchId: batch.id, kind: "receive", qty: l.receivedQty, refType: "grn-line", refId: l.id, byId: s.userId, at: now } });
    await tx.goodsReceiptLine.update({ where: { id: l.id }, data: { batchId: batch.id } });
    await tx.purchaseOrderLine.update({ where: { id: l.orderLineId }, data: { receivedQty: { increment: l.receivedQty } } });
  }
  const money = grnMoney(lines.map((x) => x.d));
  const posted = await bumpGrn(tx, g, { status: transition("GOODS_RECEIPT", GOODS_RECEIPT, "checking", "post"), number: await nextNumber(tx, s, "GRN", now), postedById: s.userId, postedAt: now, statusAt: now, invoicedPaisa: money.invoicedPaisa, debitNotePaisa: money.debitNotePaisa, note: note?.trim() || null });
  const entry = (kind: SupplierEntryKind, amountPaisa: number) => tx.supplierEntry.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, supplierId: g.supplierId, kind, amountPaisa, refType: "grn", refId: g.id, note: kind === "debit-note" ? "short delivery" : g.supplierInvoiceNo, byId: s.userId, at: now } });
  if (money.invoicedPaisa > 0) await entry("goods-received", money.invoicedPaisa);
  if (money.debitNotePaisa > 0) await entry("debit-note", money.debitNotePaisa);
  const olines = await tx.purchaseOrderLine.findMany({ where: { orderId: po.id } });
  const to = undash<"received">(transition("PURCHASE_ORDER", PURCHASE_ORDER, dash<PurchaseOrderState>(po.status), poEventAfterReceipt(olines)));
  await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: to, statusAt: now, rev: { increment: 1 } } });
  return { g: posted, audit: [{ action: "update", entity: "GoodsReceipt", entityId: g.id, detail: {
    event: "post", number: posted.number, orderId: po.id, ...money, lines: lines.map(({ row: l, d }) => ({ medicineKey: l.medicineKey, batchNo: l.batchNo, expiry: l.expiry, receivedQty: l.receivedQty, shortExpiry: shortExpiry(l.expiry, today), costPaisa: l.costPaisa, orderCostPaisa: d.orderCostPaisa })),
  } }] };
}

/* ───── counts ───── */
async function countHere(tx: Tx, s: SessionData, id: string, locked = false): Promise<Count> {
  if (locked) await lock(tx, "StockCount", id);
  const c = await tx.stockCount.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!c) throw notFound();
  return c;
}
type CountLineRow = Awaited<ReturnType<Tx["stockCountLine"]["findMany"]>>[number];
/** What should have been on the shelf when each batch was counted (or now, if not yet): the system quantity at the start
    plus the stock that moved since (sales, dispensing, transfers). The variance and the adjustment are against this. */
async function expectedQty(tx: Tx, c: Count, lines: CountLineRow[], now: Date) {
  const out = new Map<string, number>();
  for (const l of lines) {
    const until = l.countedAt ?? now;
    const moved = (await tx.stockMove.aggregate({ where: { batchId: l.batchId, at: { gt: c.createdAt, lte: until } }, _sum: { qty: true } }))._sum.qty ?? 0;
    out.set(l.id, l.systemQty + moved);
  }
  return out;
}
const asCountLines = (lines: CountLineRow[], exp: Map<string, number>) => lines.map((l) => ({ systemQty: exp.get(l.id) ?? l.systemQty, countedQty: l.countedQty, reason: l.reason }));

export async function countView(tx: Tx, s: SessionData, c: Count, now: Date): Promise<StockCountView> {
  const today = dhakaDay(now);
  const lines = await tx.stockCountLine.findMany({ where: { countId: c.id } });
  const batches = new Map((await tx.stockBatch.findMany({ where: { id: { in: lines.map((l) => l.batchId) } } })).map((b) => [b.id, b]));
  const who = await people(tx, [c.createdById, c.decidedById]);
  const exp = await expectedQty(tx, c, lines, c.decidedAt ?? now);
  const rows = lines.map((l) => ({ l, b: batches.get(l.batchId)! })).sort((a, b) => a.b.medicineKey.localeCompare(b.b.medicineKey) || a.b.expiry.localeCompare(b.b.expiry));
  return {
    id: c.id, location: c.location as "counter" | "store" | "fridge", status: c.status, rev: c.rev,
    lines: rows.map(({ l, b }) => ({
      id: l.id, medicine: medRef(b.medicineKey), systemQty: exp.get(l.id)!, countedQty: l.countedQty, variance: l.countedQty === null ? null : l.countedQty - exp.get(l.id)!, reason: l.reason,
      batch: { id: b.id, batchNo: b.batchNo, expiry: b.expiry, location: b.location, qtyOnHand: b.qtyOnHand, mrpPaisa: b.mrpPaisa, vatRateBp: b.vatRateBp,
        state: batchState({ id: b.id, expiry: b.expiry, qty: b.qtyOnHand, location: b.location }, today), nearExpiry: false, sample: b.sample },
    })),
    submitBlockers: c.status === "counting" ? countSubmitBlockers(asCountLines(lines, exp)) : [],
    varianceValuePaisa: rows.reduce((a, { l, b }) => a + Math.abs(l.countedQty === null ? 0 : l.countedQty - exp.get(l.id)!) * b.costPaisa, 0),
    createdBy: who(c.createdById), createdAt: c.createdAt.toISOString(), submittedAt: iso(c.submittedAt),
    decidedBy: c.decidedById ? who(c.decidedById) : null, decidedAt: iso(c.decidedAt), decisionNote: c.decisionNote,
    canDecide: c.status === "submitted" && isStockApprover(s.role as Role) && c.createdById !== s.userId,
  };
}
export async function countList(tx: Tx, s: SessionData, status?: "counting" | "submitted" | "approved" | "rejected"): Promise<CountList> {
  const rows = await tx.stockCount.findMany({ where: { organizationId: s.organizationId, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" }, take: 50, include: { lines: { select: { systemQty: true, countedQty: true } } } });
  const who = await people(tx, rows.map((r) => r.createdById));
  return { items: rows.map((r) => ({ id: r.id, location: r.location, status: r.status, lineCount: r.lines.length, varianceLines: r.lines.filter((l) => l.countedQty !== null && l.countedQty !== l.systemQty).length, createdBy: who(r.createdById), createdAt: r.createdAt.toISOString() })) };
}
/** A count of every batch with stock at one location; the system quantities are fixed now. One open count per location. */
export async function createCount(tx: Tx, s: SessionData, location: "counter" | "store" | "fridge", now: Date): Promise<Count> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7011, hashtext(${`${s.organizationId}:${location}`}))`;
  if (await tx.stockCount.findFirst({ where: { organizationId: s.organizationId, location, status: { in: ["counting", "submitted"] } } }))
    throw err(409, "count_open", "এই জায়গার একটি গণনা আগেই চলছে", "A count of this location is already open");
  const batches = await tx.stockBatch.findMany({ where: { organizationId: s.organizationId, location, qtyOnHand: { gt: 0 } } });
  if (!batches.length) throw err(422, "nothing_to_count", "এই জায়গায় কোনো স্টক নেই", "There is no stock at this location");
  const c = await tx.stockCount.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, location, createdById: s.userId, createdAt: now, statusAt: now } });
  await tx.stockCountLine.createMany({ data: batches.map((b) => ({ tenantId: s.tenantId, countId: c.id, batchId: b.id, systemQty: b.qtyOnHand })) });
  return c;
}
async function countingCount(tx: Tx, s: SessionData, id: string, rev: number): Promise<Count> {
  const c = await countHere(tx, s, id, true);
  if (c.status !== "counting") throw err(409, "not_counting", "জমা দেওয়া গণনা বদলানো যায় না", "A submitted count cannot be changed");
  if (c.createdById !== s.userId) throw err(403, "forbidden", "যিনি গণনা শুরু করেছেন তিনিই লিখবেন", "Only the person who started the count enters it", { reason: "role", canRequest: false });
  if (c.rev !== rev) throw stale();
  return c;
}
async function bumpCount(tx: Tx, c: Count, data: Record<string, unknown> = {}): Promise<Count> {
  const n = await tx.stockCount.updateMany({ where: { id: c.id, rev: c.rev, status: c.status }, data: { ...data, rev: c.rev + 1 } });
  if (n.count !== 1) throw stale();
  return (await tx.stockCount.findFirst({ where: { id: c.id } }))!;
}
export async function setCountLine(tx: Tx, s: SessionData, id: string, req: CountLineRequest): Promise<Count> {
  const c = await countingCount(tx, s, id, req.rev);
  const n = await tx.stockCountLine.updateMany({ where: { id: req.lineId, countId: c.id }, data: { countedQty: req.countedQty, reason: req.reason?.trim() || null, countedAt: new Date() } });
  if (n.count !== 1) throw notFound();
  return bumpCount(tx, c);
}
export async function submitCount(tx: Tx, s: SessionData, id: string, rev: number, now: Date): Promise<Count> {
  const c = await countingCount(tx, s, id, rev);
  const lines = await tx.stockCountLine.findMany({ where: { countId: c.id } });
  const b = countSubmitBlockers(asCountLines(lines, await expectedQty(tx, c, lines, now)));
  if (b.length) throw err(422, b[0]!, b.includes("not_counted") ? "সব ব্যাচ গণনা করুন" : "পার্থক্যের কারণ লিখুন (অন্তত ১০ অক্ষর)", b.includes("not_counted") ? "Count every batch" : "Write why each difference happened (at least 10 characters)", { blockers: b.map((code) => ({ code })) });
  return bumpCount(tx, c, { status: transition("STOCK_COUNT", STOCK_COUNT, "counting", "submit"), submittedAt: now, statusAt: now });
}
/** Approve = `adjust` moves by counted − system for every batch with a difference; reject = a note, nothing moves. */
export async function decideCount(tx: Tx, s: SessionData, id: string, req: ApprovalDecision, now: Date): Promise<{ c: Count; audit: AuditEntry[] }> {
  const c = await countHere(tx, s, id, true);
  const note = req.note?.trim() ?? "";
  const b = countDecisionBlockers({ role: s.role as Role, isCounter: c.createdById === s.userId, decision: req.decision, note });
  if (b.includes("not_approver")) throw notApprover();
  if (b.includes("own_count")) throw err(403, "own_count", "নিজের গণনা নিজে অনুমোদন করা যায় না", "You cannot decide a count you made", { reason: "role", canRequest: false });
  if (b.includes("note_required")) throw err(400, "note_required", "কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write why (at least 10 characters)", { field: "note" });
  const status = transition("STOCK_COUNT", STOCK_COUNT, c.status, req.decision);
  const moves: { batchId: string; qty: number }[] = [];
  if (req.decision === "approve") {
    const lines = await tx.stockCountLine.findMany({ where: { countId: c.id } });
    const exp = await expectedQty(tx, c, lines, now);
    for (const l of lines) {
      // Stock keeps moving while a count is open (the counter keeps selling): the adjustment is counted − what should
      // have been there when this batch was counted (reviews: a sale during the count must not be taken off twice).
      const delta = l.countedQty === null ? 0 : l.countedQty - exp.get(l.id)!;
      if (delta === 0) continue;
      const batch = (await tx.stockBatch.findFirst({ where: { id: l.batchId } }))!;
      if (batch.qtyOnHand + delta < 0) throw err(409, "stock_changed", "গণনার পর স্টক বদলেছে — আবার গণনা করুন", "Stock changed since the count — count again", { field: l.id });
      await tx.stockMove.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, batchId: l.batchId, kind: "adjust", qty: delta, refType: "count", refId: c.id, reason: `count: ${l.reason ?? ""}`.slice(0, 500), byId: s.userId, at: now } });
      moves.push({ batchId: l.batchId, qty: delta });
    }
  }
  const done = await bumpCount(tx, c, { status, decidedById: s.userId, decidedAt: now, decisionNote: note || null, statusAt: now });
  return { c: done, audit: [{ action: req.decision, entity: "StockCount", entityId: c.id, detail: { note: note || null, adjustments: moves } }] };
}

/* ───── transfers ───── */
export async function transfer(tx: Tx, s: SessionData, req: TransferRequest, now: Date): Promise<{ from: string; to: string; audit: AuditEntry[] }> {
  const src = await tx.stockBatch.findFirst({ where: { id: req.batchId, organizationId: s.organizationId } });
  if (!src) throw notFound();
  if (src.location === req.to) throw err(422, "same_location", "একই জায়গা", "It is already there", { field: "to" });
  if (src.location === "quarantine") throw err(409, "quarantine", "কোয়ারেন্টাইনের ব্যাচ সরানো যায় না", "A quarantined batch is not moved");
  if (req.to !== "store" && src.expiry < dhakaDay(now)) throw err(409, "expired", "মেয়াদোত্তীর্ণ ব্যাচ কাউন্টারে নেওয়া যায় না", "An expired batch never goes to the counter");
  if (src.qtyOnHand < req.qty) throw err(409, "stock_short", "ব্যাচে এত নেই", "The batch does not hold that many", { field: "qty", shortfall: req.qty - src.qtyOnHand });
  const dest = await batchFor(tx, s, { ...src, location: req.to }, src.sample);
  const ref = `tr_${randomUUID()}`;
  await tx.stockMove.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, batchId: src.id, kind: "transfer", qty: -req.qty, refType: "transfer", refId: ref, byId: s.userId, at: now } });
  await tx.stockMove.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, batchId: dest.id, kind: "transfer", qty: req.qty, refType: "transfer", refId: ref, byId: s.userId, at: now } });
  return { from: src.id, to: dest.id, audit: [{ action: "create", entity: "StockMove", entityId: ref, detail: { kind: "transfer", medicineKey: src.medicineKey, batchNo: src.batchNo, qty: req.qty, from: src.location, to: req.to } }] };
}

/* ───── the owner's pharmacy approvals (one queue with billing's — Kamrul 03/10/2026) ───── */
type ApprStatus = "requested" | "approved" | "rejected";
/** Receipts only the owner / admin may post, with why: a batch expiring within 6 months, a price other than the order's. */
async function ownerOnlyReceipts(tx: Tx, s: SessionData, status: ApprStatus, now: Date) {
  if (status === "rejected") return [];
  const today = dhakaDay(now);
  const rows = await tx.goodsReceipt.findMany({
    where: { organizationId: s.organizationId, ...(status === "requested" ? { status: "checking" as const } : { status: "posted" as const, postedAt: { gte: new Date(now.getTime() - 30 * 864e5) } }) },
    include: { lines: { select: { expiry: true, costPaisa: true, orderLineId: true } } }, orderBy: { createdAt: "desc" }, take: 100,
  });
  const orderCost = new Map((await tx.purchaseOrderLine.findMany({ where: { id: { in: rows.flatMap((g) => g.lines.map((l) => l.orderLineId)) } }, select: { id: true, costPaisa: true } })).map((l) => [l.id, l.costPaisa]));
  // a posted receipt's short expiry is judged on the day it was posted
  return rows.map((g) => {
    const on = g.postedAt ? dhakaDay(g.postedAt) : today;
    const reasons: ("short-expiry" | "price-variance")[] = [];
    if (g.lines.some((l) => shortExpiry(l.expiry, on))) reasons.push("short-expiry");
    if (g.lines.some((l) => orderCost.get(l.orderLineId) !== l.costPaisa)) reasons.push("price-variance");
    return { g, reasons };
  }).filter((x) => x.reasons.length > 0);
}
export async function pendingPharmacyApprovals(tx: Tx, s: SessionData, now: Date): Promise<number> {
  const drafts = (await tx.purchaseOrder.findMany({ where: { organizationId: s.organizationId, status: "draft" }, select: { id: true } })).map((x) => x.id);
  const [orders, counts, receipts] = await Promise.all([
    tx.task.count({ where: { kind: PO_APPROVAL_TASK, status: "requested", focusId: { in: drafts } } }),
    tx.stockCount.count({ where: { organizationId: s.organizationId, status: "submitted" } }),
    ownerOnlyReceipts(tx, s, "requested", now),
  ]);
  return orders + counts + receipts.length;
}
export async function pharmacyApprovals(tx: Tx, s: SessionData, status: ApprStatus, now: Date): Promise<PharmacyApprovals> {
  if (!isStockApprover(s.role as Role)) throw notApprover();
  const pos = await tx.purchaseOrder.findMany({ where: { organizationId: s.organizationId, ...(status === "requested" ? { status: "draft" as const } : {}) }, select: { id: true } });
  const tasks = await tx.task.findMany({ where: { kind: PO_APPROVAL_TASK, status, focusId: { in: pos.map((x) => x.id) } }, orderBy: { requestedAt: status === "requested" ? "asc" : "desc" }, take: 100 });
  const list = (await poList(tx, s)).items;
  const counts = await tx.stockCount.findMany({ where: { organizationId: s.organizationId, status: status === "requested" ? "submitted" : status }, orderBy: { createdAt: "desc" }, take: 50, include: { lines: true } });
  const batches = new Map((await tx.stockBatch.findMany({ where: { id: { in: counts.flatMap((c) => c.lines.map((l) => l.batchId)) } }, select: { id: true, costPaisa: true } })).map((b) => [b.id, b.costPaisa]));
  const rec = await ownerOnlyReceipts(tx, s, status, now);
  const [orderNo, sups] = await Promise.all([
    tx.purchaseOrder.findMany({ where: { id: { in: rec.map((r) => r.g.orderId) } }, select: { id: true, number: true } }),
    tx.supplier.findMany({ where: { id: { in: rec.map((r) => r.g.supplierId) } }, select: { id: true, name: true } }),
  ]);
  const who = await people(tx, [...tasks.flatMap((t) => [t.requestedById, t.decidedById]), ...counts.flatMap((c) => [c.createdById, c.decidedById]), ...rec.flatMap((r) => [r.g.createdById, r.g.postedById])]);
  return {
    orders: tasks.flatMap((t) => {
      const order = list.find((o) => o.id === t.focusId);
      return order ? [{ order, approval: { taskId: t.id, status: t.status as ApprStatus, requestedBy: who(t.requestedById), requestedAt: t.requestedAt.toISOString(), decidedBy: t.decidedById ? who(t.decidedById) : null, decidedAt: iso(t.decidedAt), note: t.decisionNote } }] : [];
    }),
    counts: counts.map((c) => {
      // the difference as counted against the start (what was on the shelf then); the view on the count adds later moves
      const diffs = c.lines.filter((l) => l.countedQty !== null && l.countedQty !== l.systemQty);
      return { id: c.id, location: c.location, status: c.status, lineCount: c.lines.length, varianceLines: diffs.length,
        varianceValuePaisa: diffs.reduce((a, l) => a + Math.abs(l.countedQty! - l.systemQty) * (batches.get(l.batchId) ?? 0), 0),
        createdBy: who(c.createdById), createdAt: c.createdAt.toISOString(), decidedBy: c.decidedById ? who(c.decidedById) : null, decidedAt: iso(c.decidedAt), decisionNote: c.decisionNote };
    }),
    receipts: rec.map(({ g, reasons }) => ({
      id: g.id, order: { id: g.orderId, number: orderNo.find((p) => p.id === g.orderId)?.number ?? null }, supplier: sups.find((x) => x.id === g.supplierId)?.name ?? "—",
      createdBy: who(g.createdById), createdAt: g.createdAt.toISOString(), reasons, invoicedPaisa: g.invoicedPaisa, postedBy: g.postedById ? who(g.postedById) : null, postedAt: iso(g.postedAt),
    })),
  };
}
