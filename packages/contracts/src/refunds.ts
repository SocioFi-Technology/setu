/* Refund contracts (ADR 0013). A refund gives back money confirmed on one bill: its lines are credit-note lines against
   the bill's lines (net, VAT), its allocations name the confirmed payments the money goes back against and how each is
   paid out. Every amount is paisa; the rules are @setu/domain refund.ts (the server re-runs them, the database checks
   them again). Refunds need a connection: no outbox, nothing here is ever "pending" on a device. */
import { z } from "zod";
import { Paisa } from "./common.js";
import { ChargeSource, InvoiceKind, InvoiceStatus, PaymentMethod, ReceiptFormat, ReceiptLang, ReprintReason } from "./billing.js";
import { VitalsEncounter } from "./vitals.js";

const Person = z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() });

export const RefundStatus = z.enum(["requested", "approved", "paid", "rejected", "withdrawn"]);
/** refund = money goes back; return = medicine back on an unpaid pharmacy bill, the due goes down (Kamrul, decision 221) */
export const RefundKind = z.enum(["refund", "return"]);
export type RefundStatus = z.infer<typeof RefundStatus>;
export const RefundCategory = z.enum(["cancelled-test", "wrong-dispense", "overpayment", "patient-request", "other"]);
export const PayoutWay = z.enum(["cash", "gateway", "manual"]);
export const CashReason = z.enum(["no-wallet-access", "gateway-failed"]);
/** ADR 0018: what a refund shows — the requests' categories and reasons, plus the excess deposit of an IPD final bill
    (made by the bill's issue, never requested) */
export const RefundCategoryView = z.enum([...RefundCategory.options, "deposit-excess"]);
export const CashReasonView = z.enum([...CashReason.options, "deposit-excess"]);
export const RecipientRelation = z.enum(["self", "spouse", "parent", "child", "sibling", "other-relative", "other"]);
export const LineLock = z.enum(["performed", "not-billed", "nothing-left"]);
export const AllocationStatus = z.enum(["open", "paying", "paid"]);

const BillRef = z.object({
  id: z.string(), number: z.string().nullable(), status: InvoiceStatus, kind: InvoiceKind,
  totalPaisa: Paisa, paidPaisa: Paisa, refundedPaisa: Paisa, encounterId: z.string().nullable(),
});
const Buyer = z.object({ name: z.string().nullable(), phone: z.string().nullable() }).nullable();

/* ── what can be refunded on a bill ── */
export const RefundableView = z.object({
  invoice: BillRef,
  /** null for a walk-in over-the-counter buyer */
  patient: VitalsEncounter.shape.patient.nullable(),
  buyer: Buyer,
  /** confirmed money − refunds paid or open */
  confirmedLeftPaisa: Paisa,
  /** what the bill still asks for (total − credited − paid): a return credits up to this, refunds the rest (decision 233) */
  duePaisa: Paisa,
  lines: z.array(z.object({
    id: z.string(), source: ChargeSource, nameEn: z.string(), nameBn: z.string(), qty: z.number().int(),
    netPaisa: Paisa, vatPaisa: Paisa, totalPaisa: Paisa, vatRateBp: z.number().int(),
    /** what earlier refunds (paid or open) left of it; qty = units not yet returned */
    left: z.object({ netPaisa: Paisa, vatPaisa: Paisa, totalPaisa: Paisa, qty: z.number().int() }),
    /** why it cannot be refunded (performed = locked), or null */
    lock: LineLock.nullable(),
    /** medicine lines: refunded by units; a controlled drug makes the refund the owner's to approve */
    byUnits: z.boolean(), controlled: z.boolean(),
  })),
  payments: z.array(z.object({
    id: z.string(), method: PaymentMethod, amountPaisa: Paisa, trxId: z.string().nullable(), reference: z.string().nullable(), confirmedAt: z.string().nullable(),
    /** amount − what was refunded (or is being refunded) against it */
    leftPaisa: Paisa,
    /** how it can be paid back at the request (decision 2); a wallet: cash only with "no-wallet-access" */
    ways: z.array(PayoutWay),
    /** the wallet's adapter has a refund API */
    gatewayRefunds: z.boolean(),
  })),
  /** the refund open on this bill (requested or approved) — a second one waits for it */
  openRefundId: z.string().nullable(),
  /** decisions 221 / 233: a pharmacy / OTC bill that still has a due — medicine coming back credits the due first */
  canReturn: z.boolean(),
  /** why nothing can be requested now (bill not refundable, a refund open, nothing left, offline is the screen's) */
  blockers: z.array(z.enum(["bill_not_refundable", "refund_open", "nothing_left"])),
});
export type RefundableView = z.infer<typeof RefundableView>;

/* ── request ── */
export const RefundRequestLine = z.union([
  z.object({ chargeItemId: z.string().min(1).max(80), amountPaisa: Paisa }),
  z.object({ chargeItemId: z.string().min(1).max(80), units: z.number().int().min(1).max(999) }),
]);
export const RefundRequestAllocation = z.object({
  paymentId: z.string().min(1).max(80), amountPaisa: Paisa, way: PayoutWay, cashReason: CashReason.optional(),
});
export const RefundRequest = z.object({
  kind: RefundKind.default("refund"),
  category: RefundCategory,
  reason: z.string().trim().min(10).max(300),
  lines: z.array(RefundRequestLine).min(1).max(100),
  /** one payout method for the whole refund (decision 220); none for a return without refund */
  allocations: z.array(RefundRequestAllocation).max(20).default([]),
});
export type RefundRequest = z.infer<typeof RefundRequest>;

/* ── one refund ── */
export const RefundTimelineEvent = z.enum(["requested", "approved", "rejected", "withdrawn", "payout-started", "gateway-failed", "allocation-paid", "paid"]);
export const RefundView = z.object({
  refund: z.object({
    id: z.string(), status: RefundStatus, kind: RefundKind, source: z.enum(["bill", "reconciliation", "deposit-excess"]), caseTaskId: z.string().nullable(),
    /** decision 223: decided by the requester as the facility's only approver (with a note) */
    selfApproved: z.boolean(),
    category: RefundCategoryView, reason: z.string(), amountPaisa: Paisa, netPaisa: Paisa, vatPaisa: Paisa, rev: z.number().int(),
    /** decision 233: of a return's value, what lowers the due and what is refunded (a refund: 0 and all) */
    creditPaisa: Paisa, refundPaisa: Paisa,
    /** a controlled drug, or card / bank money paid back in cash: the owner approves */
    needsOwner: z.boolean(),
    requestedBy: Person, requestedAt: z.string(),
    decidedBy: Person.nullable(), decidedAt: z.string().nullable(), decisionNote: z.string().nullable(),
    withdrawnBy: Person.nullable(), withdrawnAt: z.string().nullable(), withdrawNote: z.string().nullable(),
    paidAt: z.string().nullable(),
    recipient: z.object({ name: z.string(), phone: z.string(), relation: RecipientRelation }).nullable(),
    voucher: z.object({ id: z.string(), number: z.string() }).nullable(),
  }),
  invoice: BillRef,
  patient: VitalsEncounter.shape.patient.nullable(),
  buyer: Buyer,
  lines: z.array(z.object({
    id: z.string(), chargeItemId: z.string(), source: ChargeSource, nameEn: z.string(), nameBn: z.string(), vatRateBp: z.number().int(),
    units: z.number().int().nullable(), netPaisa: Paisa, vatPaisa: Paisa, totalPaisa: Paisa,
  })),
  allocations: z.array(z.object({
    id: z.string(), paymentId: z.string(), method: PaymentMethod, amountPaisa: Paisa, way: PayoutWay, cashReason: CashReasonView.nullable(),
    status: AllocationStatus,
    /** the gateway refused or failed this allocation's refund (cash is then allowed, reason gateway-failed) */
    gatewayFailed: z.boolean(), failReason: z.string().nullable(),
    refundTrxId: z.string().nullable(), reference: z.string().nullable(),
    paidBy: Person.nullable(), paidAt: z.string().nullable(),
    /** by hand (or card / bank paid in cash): the owner checks it against the statement */
    needsReconciliation: z.boolean(), reconciled: z.enum(["waiting", "matched", "resolved"]).nullable(),
    payment: z.object({ trxId: z.string().nullable(), reference: z.string().nullable(), confirmedAt: z.string().nullable() }),
  })),
  timeline: z.array(z.object({ event: RefundTimelineEvent, at: z.string(), by: Person.nullable(), note: z.string().nullable() })),
  /** what the signed-in user may do now; release (decision 235): the owner settles a gateway refund stuck "processing"
      after the sweep has tried for at least 30 minutes */
  can: z.object({ approve: z.boolean(), reject: z.boolean(), withdraw: z.boolean(), pay: z.boolean(), check: z.boolean(), release: z.boolean() }),
  /** a gateway refund under way: since when; the owner's release is offered from `releaseAt` */
  paying: z.object({ claimedAt: z.string(), releaseAt: z.string() }).nullable(),
});
export type RefundView = z.infer<typeof RefundView>;

export const RefundDecisionRequest = z.object({ decision: z.enum(["approve", "reject", "withdraw"]), note: z.string().trim().max(300).optional() });
export type RefundDecisionRequest = z.infer<typeof RefundDecisionRequest>;

/** Decision 235: the owner checked the bKash merchant portal — the refund stuck "processing" is settled by hand, both ways
    audited and both opening a refund-reconciliation case so the statement check still happens. */
export const RefundReleaseRequest = z.object({
  outcome: z.enum(["not-refunded", "refunded"]),
  note: z.string().trim().min(10).max(300),
  /** refunded: the refund TrxID read on the portal */
  refundTrxId: z.string().trim().regex(/^[A-Z0-9]{6,20}$/i, "invalid_trx_id").optional(),
});
export type RefundReleaseRequest = z.infer<typeof RefundReleaseRequest>;

/** Pay the whole refund out in one go (decision 220): cash from the payer's open shift, by hand with its reference, or the
    gateway (claimed now, answered after the commit). A gateway refund that failed may be paid in cash (gateway-failed).
    A return without refund is recorded the same way — no money moves, so no recipient is needed. */
export const RefundPayRequest = z.object({
  rev: z.number().int().min(1),
  recipient: z.object({ name: z.string().trim().min(2).max(80), phone: z.string().trim().min(10).max(20), relation: RecipientRelation }).optional(),
  reference: z.string().trim().min(3).max(80).optional(),
  switchToCash: z.boolean().optional(),
});
export type RefundPayRequest = z.infer<typeof RefundPayRequest>;
/** paying = the gateway has not answered yet; failed = the gateway refused (nothing moved — try again, or cash) */
export const RefundPayResponse = z.object({ outcome: z.enum(["paid", "paying", "failed"]), view: RefundView });
export type RefundPayResponse = z.infer<typeof RefundPayResponse>;

export const RefundListQuery = z.object({
  status: z.enum(["requested", "approved", "paid", "rejected", "withdrawn", "open", "all"]).default("open"),
  invoiceId: z.string().max(80).optional(),
  days: z.coerce.number().int().min(1).max(90).default(30),
});
export const RefundListItem = z.object({
  id: z.string(), status: RefundStatus, kind: RefundKind, selfApproved: z.boolean(), category: RefundCategoryView, reason: z.string(), amountPaisa: Paisa, requestedAt: z.string(), paidAt: z.string().nullable(),
  requestedBy: Person, decidedBy: Person.nullable(),
  invoice: z.object({ id: z.string(), number: z.string().nullable(), kind: InvoiceKind }),
  patient: z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string().nullable(), facilityNo: z.string() }).nullable(),
  voucher: z.object({ id: z.string(), number: z.string() }).nullable(),
  /** some allocation is waiting / paying at the gateway */
  paying: z.boolean(),
});
export const RefundList = z.object({ items: z.array(RefundListItem) });
export type RefundList = z.infer<typeof RefundList>;

/* ── the voucher (RF/yy/nnnn; printed and reprinted like a receipt) ── */
export const RefundVoucherSnapshot = z.object({
  /** refund voucher (RF/…) or credit voucher (CV/…, a return without refund: no money left) */
  kind: RefundKind.default("refund"),
  selfApproved: z.boolean().default(false),
  seller: z.object({ nameEn: z.string(), nameBn: z.string().nullable(), address: z.string().nullable(), vatBin: z.string().nullable(), vatBinSample: z.boolean() }),
  invoice: z.object({ id: z.string(), number: z.string().nullable(), issuedAt: z.string().nullable(), totalPaisa: Paisa }),
  patient: z.object({ nameBn: z.string(), nameEn: z.string().nullable(), facilityNo: z.string() }).nullable(),
  buyer: Buyer,
  category: RefundCategoryView, reason: z.string(),
  /** credit-note lines (none for a reconciliation refund) */
  lines: z.array(z.object({ nameBn: z.string(), nameEn: z.string(), units: z.number().int().nullable(), vatRateBp: z.number().int(), netPaisa: Paisa, vatPaisa: Paisa, totalPaisa: Paisa })),
  netPaisa: Paisa, vatPaisa: Paisa, amountPaisa: Paisa,
  /** decision 233: of the value, what lowered the due and what was paid back */
  creditPaisa: Paisa.default(0), refundPaisa: Paisa.optional(),
  vatByRate: z.array(z.object({ rateBp: z.number().int(), netPaisa: Paisa, vatPaisa: Paisa })),
  paidBack: z.array(z.object({ method: PaymentMethod, way: PayoutWay, amountPaisa: Paisa, refundTrxId: z.string().nullable(), reference: z.string().nullable(), originalTrxId: z.string().nullable() })),
  recipient: z.object({ name: z.string(), phone: z.string(), relation: RecipientRelation }).nullable(),
  requestedBy: z.object({ nameBn: z.string(), nameEn: z.string() }),
  approvedBy: z.object({ nameBn: z.string(), nameEn: z.string() }),
  paidBy: z.object({ nameBn: z.string(), nameEn: z.string() }),
});
export type RefundVoucherSnapshot = z.infer<typeof RefundVoucherSnapshot>;
export const RefundVoucherPrintView = z.object({
  id: z.string(), copy: z.number().int(), reason: ReprintReason.nullable(), format: ReceiptFormat, lang: ReceiptLang,
  printedBy: Person, printedAt: z.string(), pdfUrl: z.string(),
});
export const RefundVoucherView = z.object({
  voucher: z.object({ id: z.string(), number: z.string(), refundId: z.string(), invoiceId: z.string(), createdAt: z.string(), amountPaisa: Paisa, verifyUrl: z.string(), snapshot: RefundVoucherSnapshot }),
  prints: z.array(RefundVoucherPrintView),
});
export type RefundVoucherView = z.infer<typeof RefundVoucherView>;
export const RefundVoucherPrintResponse = z.object({ print: RefundVoucherPrintView, view: RefundVoucherView });
export type RefundVoucherPrintResponse = z.infer<typeof RefundVoucherPrintResponse>;

/* ── pharmacy: quarantine → counter (ADR 0009 addendum) ── */
export const ResaleRequest = z.object({
  batchId: z.string().min(1).max(80), qty: z.number().int().min(1).max(100_000),
  /** the pharmacist's "unopened, resaleable" */
  unopened: z.literal(true),
  reason: z.string().trim().min(10).max(300),
});
export type ResaleRequest = z.infer<typeof ResaleRequest>;
export const ResaleResponse = z.object({ resaleId: z.string(), fromBatchId: z.string(), toBatchId: z.string(), qty: z.number().int() });

/* ── reconciliation → refund ── */
export const ReconcileRefundRequest = z.object({
  reason: z.string().trim().min(10).max(300),
  way: PayoutWay, cashReason: CashReason.optional(),
});
export type ReconcileRefundRequest = z.infer<typeof ReconcileRefundRequest>;
