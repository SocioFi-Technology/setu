/* Pharmacy purchasing, goods received and stock counts (ADR 0009, pharmacy session 2; prototype Setu Pharmacy ›
   Purchase, Count & adjust). Money is paisa per tablet / capsule; the thresholds are samples pending Kamrul. */
import type { Role } from "./access.js";
import { MAX_PAISA } from "./money.js";
import { isWardLocation } from "./mar.js";

const APPROVERS: Role[] = ["owner", "admin"];
export const isStockApprover = (role: Role) => APPROVERS.includes(role);
/** Kamrul, 06/10/2026: a ward's stock (`ward:<id>`) is counted by the ward nurse and decided by the pharmacist or the
    owner; the counter, store and fridge keep the owner / admin. Same STOCK_COUNT machine and self-approval rule. */
const WARD_COUNT_APPROVERS: Role[] = ["pharmacist", "owner"];
export const isCountApprover = (role: Role, location: string) => (isWardLocation(location) ? WARD_COUNT_APPROVERS : APPROVERS).includes(role);
export const countApproverRoles = (location: string): Role[] => [...(isWardLocation(location) ? WARD_COUNT_APPROVERS : APPROVERS)];

/** A purchase order above this is sent only with the owner's / admin's approval (sample: ৳50,000). */
export const PO_APPROVAL_PAISA_SAMPLE = 5_000_000;
/** A received batch expiring within this many days is accepted only with the owner's / admin's OK. */
export const SHORT_EXPIRY_DAYS = 180;

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5);
export const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
export const shortExpiry = (expiry: string, today: string) => dayDiff(expiry, today) < SHORT_EXPIRY_DAYS;

export interface PoLine { qty: number; costPaisa: number; receivedQty?: number }
export const poTotalPaisa = (lines: readonly PoLine[]) => lines.reduce((a, l) => a + l.qty * l.costPaisa, 0);

export type PoSendBlocker = "no_lines" | "approval_required";
/** Sending: at least one line; above the threshold only the owner / admin sends (others ask for approval). Decision 179
    (external review A6): the threshold is on the day's total to the supplier — what was already sent to the same
    supplier from this facility that Dhaka day without an approver (`supplierDayPaisa`) plus this order — so splitting
    one need into several orders under the limit still needs the approval. */
export function poSendBlockers(x: { lines: readonly PoLine[]; role: Role; approved: boolean; supplierDayPaisa?: number }): PoSendBlocker[] {
  if (!x.lines.length) return ["no_lines"];
  if ((x.supplierDayPaisa ?? 0) + poTotalPaisa(x.lines) > PO_APPROVAL_PAISA_SAMPLE && !isStockApprover(x.role) && !x.approved) return ["approval_required"];
  return [];
}

export interface GrnLine {
  orderedQty: number; alreadyReceivedQty: number; invoicedQty: number; receivedQty: number;
  batchNo: string; expiry: string; costPaisa: number; mrpPaisa: number;
  /** the unit cost on the order — a different cost on the supplier's bill is a price variance */
  orderCostPaisa: number;
}
/** Order totals and receipt money stay inside the paisa range Postgres integers hold (@setu/domain MAX_PAISA). */
export const withinMoneyRange = (paisa: number) => Number.isSafeInteger(paisa) && paisa >= 0 && paisa <= MAX_PAISA;
export type GrnLineBlocker = "batch_required" | "expiry_invalid" | "expired" | "over_invoice" | "over_order" | "mrp_below_cost" | "nothing_received";
/** One line as checked at the counter: a batch number, a real expiry not already past, received ≤ what the supplier
    billed and ≤ what is still open on the order, MRP not below cost. */
export function grnLineBlockers(l: GrnLine, today: string): GrnLineBlocker[] {
  const out: GrnLineBlocker[] = [];
  if (!l.batchNo.trim()) out.push("batch_required");
  if (!isDay(l.expiry)) out.push("expiry_invalid");
  else if (l.expiry < today) out.push("expired");
  if (l.receivedQty > l.invoicedQty) out.push("over_invoice");
  if (l.receivedQty > l.orderedQty - l.alreadyReceivedQty) out.push("over_order");
  if (l.mrpPaisa < l.costPaisa) out.push("mrp_below_cost");
  if (l.invoicedQty <= 0) out.push("nothing_received");
  return out;
}
export type GrnPostBlocker = "no_lines" | "line_invalid" | "short_expiry_needs_owner" | "price_variance_needs_owner";
export const priceVariance = (l: Pick<GrnLine, "costPaisa" | "orderCostPaisa">) => l.costPaisa !== l.orderCostPaisa;
/** Decision 180 (external review A6): how far a supplier bill's line may differ from the order and still be posted by
    the pharmacist — the smaller of a percentage (basis points) of the line at the order's cost and an amount; stored per
    facility (Organization.grnToleranceBp / grnTolerancePaisa). */
export interface GrnTolerance { bp: number; paisa: number }
export const DEFAULT_GRN_TOLERANCE: GrnTolerance = { bp: 200, paisa: 5_000 };
export const toleranceOk = (t: GrnTolerance) => Number.isInteger(t.bp) && t.bp >= 0 && t.bp <= 1000 && Number.isInteger(t.paisa) && t.paisa >= 0 && t.paisa <= 100_000;
/** The line's difference in money: |bill cost − order cost| × billed quantity. */
export const priceVarianceLinePaisa = (l: Pick<GrnLine, "costPaisa" | "orderCostPaisa" | "invoicedQty">) => Math.abs(l.costPaisa - l.orderCostPaisa) * l.invoicedQty;
/** What the line may differ by: min(bp of the line at the order's cost, the amount). */
export const lineTolerancePaisa = (l: Pick<GrnLine, "orderCostPaisa" | "invoicedQty">, t: GrnTolerance) => Math.min(Math.floor((l.orderCostPaisa * l.invoicedQty * t.bp) / 10_000), t.paisa);
/** A price variance beyond the facility's tolerance — only the owner / admin posts it. */
export const priceBeyondTolerance = (l: Pick<GrnLine, "costPaisa" | "orderCostPaisa" | "invoicedQty">, t: GrnTolerance) => priceVariance(l) && priceVarianceLinePaisa(l) > lineTolerancePaisa(l, t);
export function grnPostBlockers(x: { lines: readonly GrnLine[]; role: Role; today: string; tolerance?: GrnTolerance }): GrnPostBlocker[] {
  if (!x.lines.length) return ["no_lines"];
  const out: GrnPostBlocker[] = [];
  if (x.lines.some((l) => grnLineBlockers(l, x.today).length)) out.push("line_invalid");
  if (x.lines.some((l) => isDay(l.expiry) && shortExpiry(l.expiry, x.today)) && !isStockApprover(x.role)) out.push("short_expiry_needs_owner");
  // a supplier bill at another unit cost than the order changes what is owed: beyond the tolerance the owner / admin posts it
  if (x.lines.some((l) => priceBeyondTolerance(l, x.tolerance ?? { bp: 0, paisa: 0 })) && !isStockApprover(x.role)) out.push("price_variance_needs_owner");
  return out;
}
/** What the supplier billed, what arrived short (a debit note against the supplier), and what is owed for it. */
export function grnMoney(lines: readonly Pick<GrnLine, "invoicedQty" | "receivedQty" | "costPaisa">[]) {
  const invoicedPaisa = lines.reduce((a, l) => a + l.invoicedQty * l.costPaisa, 0);
  const debitNotePaisa = lines.reduce((a, l) => a + Math.max(0, l.invoicedQty - l.receivedQty) * l.costPaisa, 0);
  return { invoicedPaisa, debitNotePaisa, owedPaisa: invoicedPaisa - debitNotePaisa };
}
/** After a posting: every line received in full → receiveAll, otherwise receivePart. */
export const poEventAfterReceipt = (lines: readonly { qty: number; receivedQty: number }[]) => (lines.every((l) => l.receivedQty >= l.qty) ? "receiveAll" as const : "receivePart" as const);

export type SupplierEntryKind = "goods-received" | "debit-note" | "payment";
/** What the facility owes the supplier: goods received − debit notes − payments. */
export const supplierOwedPaisa = (entries: readonly { kind: SupplierEntryKind; amountPaisa: number }[]) =>
  entries.reduce((a, e) => a + (e.kind === "goods-received" ? e.amountPaisa : -e.amountPaisa), 0);

export interface CountLine { systemQty: number; countedQty: number | null; reason: string | null }
export type CountSubmitBlocker = "no_lines" | "not_counted" | "reason_required";
/** Every batch counted; any variance carries a reason of at least 10 characters. */
export function countSubmitBlockers(lines: readonly CountLine[]): CountSubmitBlocker[] {
  if (!lines.length) return ["no_lines"];
  const out: CountSubmitBlocker[] = [];
  if (lines.some((l) => l.countedQty === null)) out.push("not_counted");
  if (lines.some((l) => l.countedQty !== null && l.countedQty !== l.systemQty && (l.reason ?? "").trim().length < 10)) out.push("reason_required");
  return out;
}
export type CountDecisionBlocker = "not_approver" | "own_count" | "note_required";
/** Only the owner / admin decides, never on a count they made — unless they are the facility's only approver: then with a
    note, flagged self-approved (Kamrul's one self-approval rule, decisions 234 / 223); a rejection needs a note. */
export function countDecisionBlockers(x: { role: Role; isCounter: boolean; decision: "approve" | "reject"; note: string; onlyApprover?: boolean; location?: string }): CountDecisionBlocker[] {
  const out: CountDecisionBlocker[] = [];
  if (!isCountApprover(x.role, x.location ?? "store")) out.push("not_approver");
  if (x.isCounter && !x.onlyApprover) out.push("own_count");
  if ((x.decision === "reject" || (x.isCounter && x.onlyApprover)) && x.note.trim().length < 10) out.push("note_required");
  return out;
}
/** Counted − system per batch; the adjustment is this difference applied to the batch when approved. */
export const countVariance = (lines: readonly CountLine[]) => lines.map((l) => (l.countedQty ?? l.systemQty) - l.systemQty);
