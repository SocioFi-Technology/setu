/* Refund rules (ADR 0013; prototype Setu Billing › Refunds). A refund gives back money confirmed on one bill: its lines
   are credit-note lines against the bill's lines (net, VAT, total), its allocations say which confirmed payments the
   money goes back against and how it is paid out. Routes and screens call these same functions; amounts are paisa.
   Kamrul's decisions of 05/10/2026: performed services are locked; a wallet is refunded through its gateway (cash only
   when the gateway refund failed or the patient has no wallet access); card / bank by hand, or in cash with the owner's
   approval; a controlled drug on a refund needs the owner; the person who took the money is recorded at payout. */
import { APPROVER_ROLES, approvalBlockers, type ApprovalBlocker, type BillingSettings, type PaymentMethod } from "./billing.js";
import type { InvoiceState, OrderState } from "./machines.js";
import { divHalfUp, type Paisa } from "./money.js";
import { normalizePhone } from "./patient.js";

export const REFUND_CATEGORIES = ["cancelled-test", "wrong-dispense", "overpayment", "patient-request", "other"] as const;
export type RefundCategory = (typeof REFUND_CATEGORIES)[number];
export const REFUND_REASON_MIN = 10;
export const RECIPIENT_RELATIONS = ["self", "spouse", "parent", "child", "sibling", "other-relative", "other"] as const;
export type RecipientRelation = (typeof RECIPIENT_RELATIONS)[number];
/** cash = from the payer's drawer; gateway = the wallet's refund API; manual = by hand with a reference (flagged) */
export const PAYOUT_WAYS = ["cash", "gateway", "manual"] as const;
export type PayoutWay = (typeof PAYOUT_WAYS)[number];
/** why a wallet payment is paid back in cash (stored on the allocation) */
export const CASH_REASONS = ["no-wallet-access", "gateway-failed"] as const;
export type CashReason = (typeof CASH_REASONS)[number];
export type LineSource = "consultation" | "order" | "desk" | "dispense" | "sale";
export const isMedicineLine = (s: LineSource) => s === "dispense" || s === "sale";

/* ── lines ── */
export type LineLock = "performed" | "not-billed" | "nothing-left";
/** Performed = locked (design): the consultation of a finished visit (every OPD bill is made from one), a test whose
    specimen was collected. A revoked or uncollected order, a desk item and medicine (returned by units) are not. */
export function lineLock(l: { source: LineSource; notBilled: boolean; leftPaisa: Paisa; order?: { state: OrderState; collected: boolean } | null }): LineLock | null {
  if (l.notBilled) return "not-billed";
  if (l.leftPaisa <= 0) return "nothing-left";
  if (l.source === "consultation") return "performed";
  if (l.source === "order" && l.order && l.order.state !== "revoked" && (l.order.collected || ["in-progress", "partially-complete", "complete"].includes(l.order.state))) return "performed";
  return null;
}

/** What is left of a bill line after earlier refunds (paid or open); `qty` = units not yet returned. */
export interface LineLeft { totalPaisa: Paisa; netPaisa: Paisa; vatPaisa: Paisa; qty: number }
export interface LinePart { netPaisa: Paisa; vatPaisa: Paisa; totalPaisa: Paisa; units: number | null }
/** A part of a line: by amount (services) or by units (medicine). The VAT is the remaining VAT in proportion, half-up,
    never leaving negative net or VAT behind; all that is left is taken exactly. null = not a valid part. */
export function partOfLine(left: LineLeft, ask: { amountPaisa: Paisa } | { units: number }): LinePart | null {
  if ("units" in ask) {
    const u = ask.units;
    if (!Number.isSafeInteger(u) || u < 1 || u > left.qty) return null;
    if (u === left.qty) return { netPaisa: left.netPaisa, vatPaisa: left.vatPaisa, totalPaisa: left.totalPaisa, units: u };
    const netPaisa = divHalfUp(left.netPaisa * u, left.qty), vatPaisa = divHalfUp(left.vatPaisa * u, left.qty);
    return netPaisa + vatPaisa > 0 ? { netPaisa, vatPaisa, totalPaisa: netPaisa + vatPaisa, units: u } : null;
  }
  const a = ask.amountPaisa;
  if (!Number.isSafeInteger(a) || a < 1 || a > left.totalPaisa) return null;
  if (a === left.totalPaisa) return { netPaisa: left.netPaisa, vatPaisa: left.vatPaisa, totalPaisa: a, units: null };
  const share = divHalfUp(left.vatPaisa * a, left.totalPaisa);
  const vatPaisa = Math.min(a, left.vatPaisa, Math.max(share, left.vatPaisa - (left.totalPaisa - a)));
  return { netPaisa: a - vatPaisa, vatPaisa, totalPaisa: a, units: null };
}

/* ── how the money goes back ── */
/** `stage` payout: a wallet allocation whose gateway refund failed on this refund may be paid in cash ("gateway-failed").
    Card / bank → cash is allowed here; the owner approves it (`refundApprovalBlockers` cardBankCash). */
export function payoutWayAllowed(x: { method: PaymentMethod; way: PayoutWay; gatewayRefunds: boolean; stage: "request" | "payout"; cashReason?: CashReason | null; gatewayFailed?: boolean }): boolean {
  if (x.method === "cash") return x.way === "cash";
  if (x.method === "card" || x.method === "bank") return x.way === "manual" || x.way === "cash";
  if (x.way === "gateway") return x.gatewayRefunds;
  if (x.way === "manual") return !x.gatewayRefunds;
  if (x.cashReason === "no-wallet-access") return true;
  return x.stage === "payout" && x.cashReason === "gateway-failed" && x.gatewayFailed === true;
}
export const isCardBankCash = (method: PaymentMethod, way: PayoutWay) => (method === "card" || method === "bank") && way === "cash";

/* ── request ── */
export interface RequestAllocation { method: PaymentMethod; leftPaisa: Paisa; amountPaisa: Paisa; way: PayoutWay; gatewayRefunds: boolean; cashReason?: CashReason | null }
export interface RequestInput {
  source: "bill" | "reconciliation";
  /** Kamrul, decision 221: "return" = medicine back on an unpaid pharmacy bill — a credit, no money leaves */
  kind?: "refund" | "return";
  /** return: money ever confirmed on the bill, and payments still pending (both must be 0) */
  confirmedPaisa?: Paisa;
  pendingPayments?: number;
  category: RefundCategory;
  reason: string;
  billStatus: InvoiceState;
  /** another refund on this bill is requested or approved */
  openRefund: boolean;
  lines: { source: LineSource; lock: LineLock | null; part: LinePart | null }[];
  /** confirmed money on the bill − refunds paid or open */
  confirmedLeftPaisa: Paisa;
  allocations: RequestAllocation[];
  /** reconciliation: what the gateway reported (and re-confirmed) for the case */
  caseAmountPaisa?: Paisa;
}
export type RequestBlocker =
  | "refund_open" | "bill_not_refundable" | "category_unknown" | "reason_too_short" | "no_lines" | "line_locked" | "line_over"
  | "category_line_mismatch" | "over_confirmed" | "over_case" | "no_allocations" | "allocation_over" | "allocation_mismatch" | "payout_not_allowed"
  | "mixed_ways" | "gateway_one_payment" | "money_on_bill" | "payment_pending" | "return_takes_no_money";
/** Categories a return without refund can carry (medicine came back). */
export const RETURN_CATEGORIES: RefundCategory[] = ["wrong-dispense", "patient-request", "other"];
export function refundRequestBlockers(x: RequestInput): RequestBlocker[] {
  if (x.openRefund) return ["refund_open"];
  if (!["issued", "partially-paid", "balanced"].includes(x.billStatus)) return ["bill_not_refundable"];
  if (x.kind === "return") return returnBlockers(x);
  const out: RequestBlocker[] = [];
  if (!(REFUND_CATEGORIES as readonly string[]).includes(x.category)) out.push("category_unknown");
  if (x.reason.trim().length < REFUND_REASON_MIN) out.push("reason_too_short");
  const recon = x.source === "reconciliation";
  if (!recon) {
    if (!x.lines.length) out.push("no_lines");
    if (x.lines.some((l) => l.lock)) out.push("line_locked");
    if (x.lines.some((l) => !l.lock && !l.part)) out.push("line_over");
  }
  const mismatch = recon ? x.category !== "overpayment" || x.lines.length > 0 || x.allocations.length !== 1
    : x.category === "overpayment"
      || (x.category === "cancelled-test" && x.lines.some((l) => l.source !== "order"))
      || (x.category === "wrong-dispense" && !x.lines.some((l) => isMedicineLine(l.source)));
  if (mismatch) out.push("category_line_mismatch");
  const total = recon ? x.allocations.reduce((a, l) => a + l.amountPaisa, 0) : x.lines.reduce((a, l) => a + (l.part?.totalPaisa ?? 0), 0);
  if (recon ? total > (x.caseAmountPaisa ?? 0) : total > x.confirmedLeftPaisa) out.push(recon ? "over_case" : "over_confirmed");
  if (!x.allocations.length) out.push("no_allocations");
  if (x.allocations.some((a) => !Number.isSafeInteger(a.amountPaisa) || a.amountPaisa < 1 || a.amountPaisa > a.leftPaisa)) out.push("allocation_over");
  if (x.allocations.reduce((a, l) => a + l.amountPaisa, 0) !== total) out.push("allocation_mismatch");
  if (x.allocations.some((a) => !payoutWayAllowed({ method: a.method, way: a.way, gatewayRefunds: a.gatewayRefunds, stage: "request", cashReason: a.cashReason ?? null }))) out.push("payout_not_allowed");
  // Kamrul, decision 220: one refund = one payout method, paid whole in one transaction — so a gateway refund (one call per
  // payment) goes back against one payment; part cash, part bKash is two refunds
  if (new Set(x.allocations.map((a) => `${a.way}:${a.cashReason ?? ""}`)).size > 1) out.push("mixed_ways");
  if (x.allocations.filter((a) => a.way === "gateway").length > 1) out.push("gateway_one_payment");
  return out;
}

/** Decision 221: a return without refund — the medicine comes back into quarantine and the due goes down; no money moves.
    Only on an issued bill on which no money was ever confirmed and nothing is pending. */
function returnBlockers(x: RequestInput): RequestBlocker[] {
  if ((x.confirmedPaisa ?? 0) > 0) return ["money_on_bill"];
  if ((x.pendingPayments ?? 0) > 0) return ["payment_pending"];
  const out: RequestBlocker[] = [];
  if (!(REFUND_CATEGORIES as readonly string[]).includes(x.category)) out.push("category_unknown");
  if (x.reason.trim().length < REFUND_REASON_MIN) out.push("reason_too_short");
  if (!x.lines.length) out.push("no_lines");
  if (x.lines.some((l) => l.lock)) out.push("line_locked");
  if (x.lines.some((l) => !l.lock && !l.part)) out.push("line_over");
  if (!RETURN_CATEGORIES.includes(x.category) || x.lines.some((l) => !isMedicineLine(l.source))) out.push("category_line_mismatch");
  if (x.allocations.length) out.push("return_takes_no_money");
  return out;
}

/* ── approve / reject / withdraw ── */
export type RefundApprovalBlocker = ApprovalBlocker | "owner_only" | "note_required";
export const isSelfApproval = (a: { approverId: string; requestedById: string }) => a.approverId === a.requestedById;
/** The discount rules (owner / admin, never their own, within the approver's limit); a controlled drug on the refund, or
    card / bank money paid back in cash, needs an owner. Kamrul, decision 223: the requester may approve their own request
    only when they are the facility's only approver — with a note (≥ 10), and the refund is flagged "self-approved". */
export function refundApprovalBlockers(a: { approverId: string; approverRole: string; requestedById: string; amountPaisa: Paisa; settings: BillingSettings; controlled: boolean; cardBankCash: boolean; onlyApprover?: boolean; note?: string }): RefundApprovalBlocker[] {
  const self = isSelfApproval(a) && a.onlyApprover === true && (APPROVER_ROLES as readonly string[]).includes(a.approverRole);
  if (self && (a.note ?? "").trim().length < REFUND_REASON_MIN) return ["note_required"];
  const b = approvalBlockers(self ? { ...a, requestedById: `${a.requestedById}#self` } : a);
  if (b.length) return b;
  if ((a.controlled || a.cardBankCash) && a.approverRole !== "owner") return ["owner_only"];
  return [];
}
export type WithdrawBlocker = "not_an_approver" | "note_too_short" | "part_paid";
export function refundWithdrawBlockers(a: { role: string; note: string; anyPaid: boolean }): WithdrawBlocker[] {
  if (!(APPROVER_ROLES as readonly string[]).includes(a.role)) return ["not_an_approver"];
  if (a.note.trim().length < REFUND_REASON_MIN) return ["note_too_short"];
  if (a.anyPaid) return ["part_paid"];
  return [];
}

/* ── payout ── */
/** The person who took the money (often a relative): name, Bangladesh mobile (stored as the 10 digits after +880, like
    a patient's), relationship to the patient. */
export function recipientCheck(r: { name: string; phone: string; relation: RecipientRelation }): { ok: true; phone: string } | { ok: false; field: "name" | "phone" | "relation" } {
  const name = (r.name ?? "").trim();
  if (name.length < 2 || name.length > 80) return { ok: false, field: "name" };
  const phone = normalizePhone(r.phone);
  if (!phone) return { ok: false, field: "phone" };
  if (!(RECIPIENT_RELATIONS as readonly string[]).includes(r.relation)) return { ok: false, field: "relation" };
  return { ok: true, phone };
}

/* ── the bill ── */
export function refundSummary(x: { confirmedPaisa: Paisa; paidRefundsPaisa: Paisa; openRefundsPaisa: Paisa }) {
  return { refundedPaisa: x.paidRefundsPaisa, refundablePaisa: x.confirmedPaisa - x.paidRefundsPaisa - x.openRefundsPaisa, netPaisa: x.confirmedPaisa - x.paidRefundsPaisa };
}
