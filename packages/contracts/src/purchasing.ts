/* Pharmacy purchasing, goods received, supplier ledger, counts and transfers (ADR 0009, pharmacy session 2; prototype
   Setu Pharmacy › Purchase, Count & adjust). Quantities are tablets / capsules; money is paisa per unit. */
import { z } from "zod";
import { Paisa } from "./common.js";
import { BatchView, MedicineRef } from "./pharmacy.js";

const Person = z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() });
const Id = z.string().min(1).max(64);
const Qty = z.number().int().positive().max(1_000_000);
const Reason = z.string().trim().max(500);
const Rev = z.object({ rev: z.number().int() });

/* ── suppliers ── */
export const SupplierView = z.object({ id: z.string(), name: z.string(), phone: z.string().nullable(), active: z.boolean(), sample: z.boolean(), owedPaisa: z.number().int() });
export const SupplierList = z.object({ items: z.array(SupplierView) });
export type SupplierList = z.infer<typeof SupplierList>;
export const SupplierCreate = z.object({ name: z.string().trim().min(2).max(120), phone: z.string().regex(/^01[3-9]\d{8}$/).optional() });
export type SupplierCreate = z.infer<typeof SupplierCreate>;
export const SupplierEntryView = z.object({ id: z.string(), kind: z.enum(["goods-received", "debit-note", "payment"]), amountPaisa: Paisa, ref: z.string().nullable(), note: z.string().nullable(), by: Person, at: z.string() });
export const SupplierLedger = z.object({ supplier: SupplierView, entries: z.array(SupplierEntryView) });
export type SupplierLedger = z.infer<typeof SupplierLedger>;
/** A payment to the supplier (owner / admin): how it was paid goes in the note (cheque no., bKash TrxID …). */
export const SupplierPaymentRequest = z.object({ amountPaisa: Paisa.refine((x) => x > 0), note: Reason.refine((x) => x.length >= 4, "note_required") });
export type SupplierPaymentRequest = z.infer<typeof SupplierPaymentRequest>;

/* ── purchase orders ── */
export const PurchaseOrderStatus = z.enum(["draft", "sent", "partially-received", "received", "cancelled"]);
export const PoLineView = z.object({ id: z.string(), position: z.number().int(), medicine: MedicineRef, qty: z.number().int(), costPaisa: Paisa, receivedQty: z.number().int() });
export const PoApprovalView = z.object({
  taskId: z.string(), status: z.enum(["requested", "approved", "rejected"]), requestedBy: Person, requestedAt: z.string(),
  decidedBy: Person.nullable(), decidedAt: z.string().nullable(), note: z.string().nullable(),
});
export const PurchaseOrderView = z.object({
  id: z.string(), number: z.string().nullable(), status: PurchaseOrderStatus, rev: z.number().int(),
  supplier: z.object({ id: z.string(), name: z.string() }), totalPaisa: Paisa, note: z.string().nullable(),
  /** cancelled: why; received short: why the rest will not come */
  endReason: z.string().nullable(),
  lines: z.array(PoLineView),
  approval: PoApprovalView.nullable(),
  /** what stops Send now (approval_required: above the threshold — ask the owner / admin) */
  sendBlockers: z.array(z.enum(["no_lines", "approval_required", "approval_pending"])),
  approvalThresholdPaisa: Paisa,
  receipts: z.array(z.object({ id: z.string(), number: z.string().nullable(), status: z.enum(["checking", "posted", "discarded"]), postedAt: z.string().nullable() })),
  createdBy: Person, createdAt: z.string(), sentBy: Person.nullable(), sentAt: z.string().nullable(),
});
export type PurchaseOrderView = z.infer<typeof PurchaseOrderView>;
export const PurchaseOrderList = z.object({ items: z.array(z.object({
  id: z.string(), number: z.string().nullable(), status: PurchaseOrderStatus, supplier: z.object({ id: z.string(), name: z.string() }),
  totalPaisa: Paisa, lineCount: z.number().int(), approvalPending: z.boolean(), createdAt: z.string(),
})) });
export type PurchaseOrderList = z.infer<typeof PurchaseOrderList>;
export const PoCreate = z.object({ supplierId: Id, note: Reason.optional() });
export const PoLineRequest = z.object({ rev: z.number().int(), medicineKey: Id, qty: Qty, costPaisa: Paisa });
export type PoLineRequest = z.infer<typeof PoLineRequest>;
export const PoRev = Rev;
export const PoEndRequest = z.object({ rev: z.number().int(), reason: Reason });
export const ApprovalDecision = z.object({ decision: z.enum(["approve", "reject"]), note: Reason.optional() });
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/* ── goods received ── */
export const GrnLineBlocker = z.enum(["batch_required", "expiry_invalid", "expired", "over_invoice", "over_order", "mrp_below_cost", "nothing_received"]);
export const GrnLineView = z.object({
  id: z.string(), orderLineId: z.string(), medicine: MedicineRef, batchNo: z.string(), expiry: z.string(),
  invoicedQty: z.number().int(), receivedQty: z.number().int(), costPaisa: Paisa, mrpPaisa: Paisa, vatRateBp: z.number().int(),
  location: z.enum(["counter", "store", "fridge"]), shortExpiry: z.boolean(), blockers: z.array(GrnLineBlocker),
});
export const GoodsReceiptView = z.object({
  id: z.string(), number: z.string().nullable(), status: z.enum(["checking", "posted", "discarded"]), rev: z.number().int(),
  order: z.object({ id: z.string(), number: z.string().nullable(), status: PurchaseOrderStatus }),
  supplier: z.object({ id: z.string(), name: z.string() }), supplierInvoiceNo: z.string().nullable(), note: z.string().nullable(),
  lines: z.array(GrnLineView),
  money: z.object({ invoicedPaisa: z.number().int(), debitNotePaisa: z.number().int(), owedPaisa: z.number().int() }),
  /** short_expiry_needs_owner: a batch expiring within 6 months — the owner / admin posts it */
  postBlockers: z.array(z.enum(["no_lines", "line_invalid", "short_expiry_needs_owner"])),
  createdBy: Person, createdAt: z.string(), postedBy: Person.nullable(), postedAt: z.string().nullable(),
});
export type GoodsReceiptView = z.infer<typeof GoodsReceiptView>;
export const GrnCreate = z.object({ orderId: Id, supplierInvoiceNo: z.string().trim().max(60).optional() });
export const GrnLineRequest = z.object({
  rev: z.number().int(), orderLineId: Id, batchNo: z.string().trim().min(1).max(40), expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  invoicedQty: Qty, receivedQty: z.number().int().min(0).max(1_000_000), costPaisa: Paisa, mrpPaisa: Paisa, vatRateBp: z.number().int().min(0).max(10_000).default(0),
  location: z.enum(["counter", "store", "fridge"]).default("store"),
});
export type GrnLineRequest = z.infer<typeof GrnLineRequest>;
export const GrnPostRequest = z.object({ rev: z.number().int(), note: Reason.optional() });

/* ── counts ── */
export const StockCountView = z.object({
  id: z.string(), location: z.enum(["counter", "store", "fridge"]), status: z.enum(["counting", "submitted", "approved", "rejected"]), rev: z.number().int(),
  lines: z.array(z.object({ id: z.string(), batch: BatchView, medicine: MedicineRef, systemQty: z.number().int(), countedQty: z.number().int().nullable(), variance: z.number().int().nullable(), reason: z.string().nullable() })),
  submitBlockers: z.array(z.enum(["no_lines", "not_counted", "reason_required"])),
  /** Σ |variance| × unit cost — what the adjustment moves, in money */
  varianceValuePaisa: z.number().int(),
  createdBy: Person, createdAt: z.string(), submittedAt: z.string().nullable(),
  decidedBy: Person.nullable(), decidedAt: z.string().nullable(), decisionNote: z.string().nullable(),
  /** the owner / admin, not the person who counted, on a submitted count */
  canDecide: z.boolean(),
});
export type StockCountView = z.infer<typeof StockCountView>;
export const CountCreate = z.object({ location: z.enum(["counter", "store", "fridge"]) });
export const CountLineRequest = z.object({ rev: z.number().int(), lineId: Id, countedQty: z.number().int().min(0).max(1_000_000), reason: Reason.optional() });
export type CountLineRequest = z.infer<typeof CountLineRequest>;
export const CountList = z.object({ items: z.array(z.object({ id: z.string(), location: z.string(), status: z.string(), lineCount: z.number().int(), varianceLines: z.number().int(), createdBy: Person, createdAt: z.string() })) });
export type CountList = z.infer<typeof CountList>;

/* ── store → counter ── */
export const TransferRequest = z.object({ batchId: Id, qty: Qty, to: z.enum(["counter", "fridge", "store"]) });
export type TransferRequest = z.infer<typeof TransferRequest>;

/* ── the owner's pharmacy approvals ── */
export const PharmacyApprovals = z.object({
  orders: z.array(z.object({ order: PurchaseOrderList.shape.items.element, approval: PoApprovalView })),
  counts: CountList.shape.items,
  receipts: z.array(z.object({ id: z.string(), order: z.object({ id: z.string(), number: z.string().nullable() }), supplier: z.string(), createdAt: z.string() })),
});
export type PharmacyApprovals = z.infer<typeof PharmacyApprovals>;
