/* Billing rules (slice A6–A7). The screen and the API call these same functions; routes never do money arithmetic of
   their own. Kamrul's decisions of 03/10/2026:
   - Every amount is integer paisa. A line is gross = unit × qty → its share of the bill discount → net → VAT on the
     net, half-up to the paisa (money.ts `vatOn`) → total = net + VAT. Bill totals are sums of the line fields.
   - A bill-level discount is split across lines in proportion to their gross, by largest remainder, so the line
     discounts add up to the discount exactly (ties go to the earlier line).
   - A discount above the cashier's limit is an APPROVAL Task; nothing is applied, and the bill cannot be issued or
     paid, while it is requested. A discount larger than the subtotal is refused, never capped.
   - A pending wallet amount is reserved: a new payment can take at most total − confirmed − pending.
   - Provider callbacks: a repeat is a no-op, an out-of-order or backwards one is refused; money reported on a payment
     that already failed goes to reconciliation, never applied silently. */
import { PAYMENT, transition, type InvoiceEvent, type PaymentEvent, type PaymentState } from "./machines.js";
import { assertPaisa, divHalfUp, MAX_PAISA, vatOn, type Paisa } from "./money.js";

export { divHalfUp };

/* ── lines and totals ── */
export interface BillLineInput { key: string; unitPaisa: Paisa; qty: number; vatRateBp: number }
export interface BillLine extends BillLineInput { grossPaisa: Paisa; discountPaisa: Paisa; netPaisa: Paisa; vatPaisa: Paisa; totalPaisa: Paisa }
export interface BillTotals { lines: BillLine[]; subtotalPaisa: Paisa; discountPaisa: Paisa; netPaisa: Paisa; vatPaisa: Paisa; totalPaisa: Paisa }
export const MAX_QTY = 999;

/** Split `discount` across lines in proportion to `grosses`; floors first, then the leftover paisa one each to the
    largest remainders (earlier line first on a tie). BigInt because gross × discount can pass 2^53. */
export function allocateDiscount(grosses: Paisa[], discount: Paisa): Paisa[] {
  grosses.forEach((g) => assertPaisa(g, "line gross"));
  assertPaisa(discount, "discount");
  const total = grosses.reduce((a, b) => a + b, 0);
  if (discount > total) throw new RangeError(`discount ${discount} is more than the subtotal ${total}`);
  if (discount === 0 || total === 0) return grosses.map(() => 0);
  const T = BigInt(total), D = BigInt(discount);
  const parts = grosses.map((g, i) => { const p = BigInt(g) * D; return { i, floor: Number(p / T), rem: p % T }; });
  let left = discount - parts.reduce((a, p) => a + p.floor, 0);
  const order = [...parts].sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  const out = parts.map((p) => p.floor);
  for (const p of order) { if (left <= 0) break; out[p.i]! += 1; left -= 1; }
  return out;
}

export function billTotals(inputs: BillLineInput[], discountPaisa: Paisa): BillTotals {
  const grosses = inputs.map((l) => {
    assertPaisa(l.unitPaisa, `unit price of ${l.key}`);
    if (!Number.isSafeInteger(l.qty) || l.qty < 1 || l.qty > MAX_QTY) throw new RangeError(`quantity of ${l.key} must be 1–${MAX_QTY}`);
    return assertPaisa(l.unitPaisa * l.qty, `gross of ${l.key}`);
  });
  const shares = allocateDiscount(grosses, discountPaisa);
  const lines = inputs.map((l, i): BillLine => {
    const grossPaisa = grosses[i]!, discountPaisa = shares[i]!;
    const netPaisa = grossPaisa - discountPaisa;
    const vatPaisa = vatOn(netPaisa, l.vatRateBp);
    return { ...l, grossPaisa, discountPaisa, netPaisa, vatPaisa, totalPaisa: netPaisa + vatPaisa };
  });
  const s = (k: "grossPaisa" | "discountPaisa" | "netPaisa" | "vatPaisa" | "totalPaisa") => lines.reduce((a, l) => a + l[k], 0);
  const out = { lines, subtotalPaisa: s("grossPaisa"), discountPaisa: s("discountPaisa"), netPaisa: s("netPaisa"), vatPaisa: s("vatPaisa"), totalPaisa: s("totalPaisa") };
  if (out.totalPaisa > MAX_PAISA) throw new RangeError("bill total is above the supported maximum");
  return out;
}

/* ── discounts ── */
export const DISCOUNT_CATEGORIES = ["poor", "staff", "doctor", "ff", "corp"] as const;
export type DiscountCategory = (typeof DISCOUNT_CATEGORIES)[number];
export const DISCOUNT_REASON_MIN = 10;
export type DiscountInput = { mode: "amount"; paisa: Paisa } | { mode: "percent"; bp: number };
export interface BillingSettings { cashierLimitPaisa: Paisa; cashierLimitBp: number; approverLimitPaisa: Paisa }
/** Prototype values (cashier ৳500 or 5%, whichever is lower; approver ৳10,000 per request). Stored per facility. */
export const DEFAULT_BILLING_SETTINGS: BillingSettings = { cashierLimitPaisa: 50_000, cashierLimitBp: 500, approverLimitPaisa: 1_000_000 };
export const APPROVER_ROLES = ["owner", "admin"] as const;

export function discountToPaisa(d: DiscountInput, subtotalPaisa: Paisa): Paisa {
  assertPaisa(subtotalPaisa, "subtotal");
  if (d.mode === "amount") return assertPaisa(d.paisa, "discount");
  if (!Number.isSafeInteger(d.bp) || d.bp < 0 || d.bp > 10_000) throw new RangeError(`discount percent ${d.bp} bp`);
  return divHalfUp(subtotalPaisa * d.bp, 10_000);
}

export const discountLimit = (subtotalPaisa: Paisa, s: BillingSettings): Paisa =>
  Math.min(s.cashierLimitPaisa, divHalfUp(assertPaisa(subtotalPaisa, "subtotal") * s.cashierLimitBp, 10_000));

export type DiscountDecision =
  | { ok: true; kind: "within-limit" | "needs-approval"; limitPaisa: Paisa }
  | { ok: false; code: "discount_not_positive" | "discount_above_subtotal" | "reason_too_short" | "category_required" };
export function discountDecision(a: { subtotalPaisa: Paisa; discountPaisa: Paisa; category: string | null | undefined; reason: string | null | undefined; settings: BillingSettings }): DiscountDecision {
  if (!Number.isSafeInteger(a.discountPaisa) || a.discountPaisa <= 0) return { ok: false, code: "discount_not_positive" };
  if (a.discountPaisa > a.subtotalPaisa) return { ok: false, code: "discount_above_subtotal" };
  if (!a.category || !(DISCOUNT_CATEGORIES as readonly string[]).includes(a.category)) return { ok: false, code: "category_required" };
  if ((a.reason ?? "").trim().length < DISCOUNT_REASON_MIN) return { ok: false, code: "reason_too_short" };
  const limitPaisa = discountLimit(a.subtotalPaisa, a.settings);
  return { ok: true, kind: a.discountPaisa <= limitPaisa ? "within-limit" : "needs-approval", limitPaisa };
}

export type ApprovalBlocker = "not_an_approver" | "own_request" | "above_approver_limit";
export function approvalBlockers(a: { approverId: string; approverRole: string; requestedById: string; amountPaisa: Paisa; settings: BillingSettings }): ApprovalBlocker[] {
  if (!(APPROVER_ROLES as readonly string[]).includes(a.approverRole)) return ["not_an_approver"];
  if (a.approverId === a.requestedById) return ["own_request"];
  if (a.amountPaisa > a.settings.approverLimitPaisa) return ["above_approver_limit"];
  return [];
}

export type IssueBlocker = "no_lines" | "unpriced_lines" | "approval_pending";
export function issueBlockers(a: { lineCount: number; unpricedCount: number; pendingApproval: boolean }): IssueBlocker[] {
  const out: IssueBlocker[] = [];
  if (a.lineCount === 0) out.push("no_lines");
  if (a.unpricedCount > 0) out.push("unpriced_lines");
  if (a.pendingApproval) out.push("approval_pending");
  return out;
}

/* ── payments ── */
export const PAYMENT_METHODS = ["cash", "card", "bank", "bkash", "nagad"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const WALLETS = ["bkash", "nagad"] as const;
export const isWallet = (m: PaymentMethod): boolean => (WALLETS as readonly string[]).includes(m);
/** Wallet states that still hold money that may arrive. */
export const PENDING_STATES: PaymentState[] = ["initiated", "link-sent", "waiting-customer"];

export interface PaymentRow { id: string; method: PaymentMethod; amountPaisa: Paisa; status: PaymentState; trxId?: string | null; reference?: string | null }
export interface PaymentSummary { totalPaisa: Paisa; confirmedPaisa: Paisa; pendingPaisa: Paisa; duePaisa: Paisa; openPaisa: Paisa }

export function paymentSummary(totalPaisa: Paisa, rows: PaymentRow[]): PaymentSummary {
  const confirmedPaisa = rows.filter((r) => r.status === "confirmed").reduce((a, r) => a + r.amountPaisa, 0);
  const pendingPaisa = rows.filter((r) => isWallet(r.method) && PENDING_STATES.includes(r.status)).reduce((a, r) => a + r.amountPaisa, 0);
  return { totalPaisa, confirmedPaisa, pendingPaisa, duePaisa: totalPaisa - confirmedPaisa, openPaisa: totalPaisa - confirmedPaisa - pendingPaisa };
}

export type NewPaymentCheck =
  | { ok: true; changePaisa: Paisa }
  | { ok: false; code: "amount_not_positive" | "amount_over_open" | "tendered_short" | "reference_required" };
export function checkNewPayment(s: PaymentSummary, p: { method: PaymentMethod; amountPaisa: Paisa; tenderedPaisa?: Paisa | null; reference?: string | null }): NewPaymentCheck {
  if (!Number.isSafeInteger(p.amountPaisa) || p.amountPaisa <= 0) return { ok: false, code: "amount_not_positive" };
  if (p.amountPaisa > s.openPaisa) return { ok: false, code: "amount_over_open" };
  if (p.method === "cash") {
    const t = p.tenderedPaisa;
    if (t == null || !Number.isSafeInteger(t) || t < p.amountPaisa) return { ok: false, code: "tendered_short" };
    return { ok: true, changePaisa: t - p.amountPaisa };
  }
  if ((p.method === "card" || p.method === "bank") && !(p.reference ?? "").trim()) return { ok: false, code: "reference_required" };
  return { ok: true, changePaisa: 0 };
}

/** The receipt's "Paid by" line: confirmed money only; wallet amounts still waiting are listed as pending (issue #10). */
export interface PaidBy { paid: { method: PaymentMethod; amountPaisa: Paisa; trxId?: string; reference?: string }[]; pending: { method: PaymentMethod; amountPaisa: Paisa }[] }
export function paidBy(rows: PaymentRow[]): PaidBy {
  return {
    paid: rows.filter((r) => r.status === "confirmed").map((r) => ({
      method: r.method, amountPaisa: r.amountPaisa, ...(r.trxId ? { trxId: r.trxId } : {}), ...(r.reference ? { reference: r.reference } : {}),
    })),
    pending: rows.filter((r) => isWallet(r.method) && PENDING_STATES.includes(r.status)).map((r) => ({ method: r.method, amountPaisa: r.amountPaisa })),
  };
}

/** INVOICE event after a payment confirms. Confirmed money above the total cannot happen (amounts are reserved); if it
    ever does, refuse rather than balance silently. */
export function invoiceEventAfterConfirm(totalPaisa: Paisa, confirmedPaisa: Paisa): Extract<InvoiceEvent, "payPart" | "payAll"> {
  if (confirmedPaisa > totalPaisa) throw new RangeError(`confirmed ${confirmedPaisa} is more than the total ${totalPaisa}`);
  return confirmedPaisa === totalPaisa ? "payAll" : "payPart";
}

/* ── provider callbacks ── */
export type ProviderEventKind = "opened" | "confirmed" | "failed";
export type ProviderDecision =
  | { outcome: "apply"; event: PaymentEvent; next: PaymentState }
  | { outcome: "noop" }
  | { outcome: "refused"; reason: "backwards" | "late-confirm" | "out-of-order" };
const EVENT_OF: Record<ProviderEventKind, PaymentEvent> = { opened: "customerOpened", confirmed: "confirm", failed: "fail" };
const STATE_OF: Record<ProviderEventKind, PaymentState> = { opened: "waiting-customer", confirmed: "confirmed", failed: "failed" };
/** The step each state has reached (higher = further on); `failed` and `confirmed` are both ends. */
const STEP: Record<PaymentState, number> = { initiated: 0, "link-sent": 1, "waiting-customer": 2, confirmed: 3, failed: 3 };

export function decideProviderEvent(current: PaymentState, kind: ProviderEventKind): ProviderDecision {
  if (current === STATE_OF[kind]) return { outcome: "noop" };
  if (current === "failed" && kind === "confirmed") return { outcome: "refused", reason: "late-confirm" };
  const event = EVENT_OF[kind];
  try {
    return { outcome: "apply", event, next: transition("PAYMENT", PAYMENT, current, event) };
  } catch {
    return { outcome: "refused", reason: STEP[current] >= STEP[STATE_OF[kind]] ? "backwards" : "out-of-order" };
  }
}
