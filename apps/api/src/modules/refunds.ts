/* Refund service (ADR 0013). Runs inside command()/query() (or forTenant for the gateway's answer and the sweep), so RLS
   scopes every read to the tenant; refunds are scoped to the session's facility and to the bills the role may see
   (invoiceHere: the pharmacist sees pharmacy and OTC bills only). Every rule is @setu/domain refund.ts and the REFUND /
   APPROVAL machines; the database re-checks the machine, the caps, the way back, the voucher and the returns
   (migrations refunds_guards, refunds_payout). Kamrul's decisions of 05/10/2026:
   - a refund belongs to one bill; its lines are credit-note lines against the bill's lines (performed = locked) and its
     allocations name the confirmed payments the money goes back against, and how;
   - approved by the owner / admin in the single Approvals queue, never by the requester; a controlled drug, or card / bank
     money paid back in cash, by the owner only;
   - paid out by cash from the payer's open shift, by hand with a reference (flagged for the owner's check), or through the
     wallet's refund API — claimed and committed first, the gateway called after the commit, never sent twice by itself;
   - who took the money is recorded at payout; the voucher RF/yy/nnnn is made when the last allocation is paid;
   - returned medicine comes back into quarantine when the payout starts (medicine in, money out); "wrong dispense" tells
     the prescribing doctor and is a medication incident on the owner's list. */
import type { ApprovalItem, RefundableView, RefundDecisionRequest, RefundList, RefundPayRequest, RefundRequest, RefundVoucherSnapshot, RefundVoucherView, RefundView, ReconcileItem, ReconcileRefundRequest, ResaleRequest } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  APPROVAL, PAYOUT_WAYS, REFUND, dhakaDay, isCardBankCash, isMedicineLine, isWallet, lineLock, partOfLine, payoutWayAllowed, recipientCheck, refundApprovalBlockers, refundRequestBlockers,
  refundWithdrawBlockers, resaleBlockers, saleClass, transition, type CashReason, type InvoiceState, type LinePart, type LineSource, type OrderState, type PaymentMethod, type PayoutWay, type RefundCategory, type RefundState,
} from "@setu/domain";
import { randomUUID } from "node:crypto";
import { providerByName, providerFor, type PaymentProvider, type RefundAnswer } from "../adapters/payments/index.js";
import { config } from "../config.js";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { invoiceHere, RECONCILE_TASK } from "./billing.js";
import { notFound } from "./frontdesk.js";
import { deliverInApp } from "./lab.js";
import { batchFor } from "./purchasing.js";
import { newVerifyCode } from "./receipts.js";
import { toVitalsEncounter } from "./vitals.js";

export const REFUND_TASK = "refund-approval";
export const REFUND_CHECK_TASK = "refund-reconciliation";
/** A gateway refund claimed this long ago without an answer is asked about again (Refund Status); after this long with
    nothing found at the gateway it is put back to open, so a person may try again (bKash refuses a duplicate in 10 min). */
export const REFUND_STUCK_MINUTES = 2;
export const REFUND_GIVE_UP_MINUTES = 15;
const WRITERS = ["cashier", "pharmacist", "owner", "admin"];
const APPROVERS = ["owner", "admin"];
const LIVE = { notIn: ["rejected", "withdrawn"] as ("rejected" | "withdrawn")[] };

const dash = <T extends string>(s: string) => s.replace(/_/g, "-") as T;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
type Inv = NonNullable<Awaited<ReturnType<Tx["invoice"]["findFirst"]>>>;
type Rf = NonNullable<Awaited<ReturnType<typeof refundRow>>>;
type Alloc = Rf["allocations"][number];
type Org = { tenantId: string; organizationId: string };
const refundRow = (tx: Tx, organizationId: string, id: string) =>
  tx.refund.findFirst({ where: { id, organizationId }, include: { lines: true, allocations: { orderBy: { id: "asc" } }, voucher: { select: { id: true, number: true } } } });

const stale = () => err(409, "stale", "রিফান্ডটি অন্য কোথাও আগেই বদলেছে — আবার খুলুন", "This refund was changed somewhere else first — reopen it");
const notWriter = () => err(403, "forbidden", "আপনি রিফান্ড দেখতে পারেন, চাইতে বা দিতে পারেন না", "You can view refunds but not request or pay them", { reason: "role", canRequest: false });

async function people(tx: Tx, ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const rows = list.length ? await tx.user.findMany({ where: { id: { in: list } }, select: { id: true, nameBn: true, nameEn: true } }) : [];
  const m = new Map(rows.map((r) => [r.id, r]));
  return (id: string) => m.get(id) ?? { id, nameBn: "—", nameEn: "—" };
}
const patientOf = async (tx: Tx, inv: Inv) => {
  const p = inv.patientId ? await tx.patient.findFirst({ where: { id: inv.patientId } }) : null;
  return p ? toVitalsEncounter({ id: "", token: "", tokenDay: "", status: "finished", patient: p } as unknown as Parameters<typeof toVitalsEncounter>[0]).patient : null;
};
const billRef = (inv: Inv) => ({ id: inv.id, number: inv.number, status: dash<InvoiceState>(inv.status), kind: inv.kind, totalPaisa: inv.totalPaisa, paidPaisa: inv.paidPaisa, refundedPaisa: inv.refundedPaisa, encounterId: inv.encounterId });
const buyerOf = (inv: Inv) => (inv.kind === "otc" ? { name: inv.buyerName, phone: inv.buyerPhone } : null);
const providerName = (p: { provider: string | null; method: string }): PaymentProvider | null =>
  p.provider ? providerByName(p.provider) : isWallet(p.method as PaymentMethod) ? providerFor(p.method as "bkash" | "nagad") : null;
/** A wallet payment refunds through its gateway only when that adapter has a refund API (bKash); otherwise by hand. */
const gatewayRefunds = (p: { provider: string | null; method: string }) => isWallet(p.method as PaymentMethod) && providerName(p)?.refundSupport === "gateway";

/* ───── what can be refunded ───── */
async function lineFacts(tx: Tx, inv: Inv) {
  const lines = await tx.chargeItem.findMany({ where: { invoiceId: inv.id }, orderBy: { position: "asc" } });
  const taken = await tx.refundLine.findMany({ where: { chargeItemId: { in: lines.map((l) => l.id) }, refund: { status: LIVE } } });
  const orders = await tx.serviceRequest.findMany({ where: { id: { in: lines.flatMap((l) => (l.source === "order" && l.sourceId ? [l.sourceId] : [])) } }, select: { id: true, status: true } });
  const orderById = new Map(orders.map((o) => [o.id, dash<OrderState>(o.status)]));
  return lines.map((l) => {
    const t = taken.filter((x) => x.chargeItemId === l.id);
    const sum = (k: "netPaisa" | "vatPaisa" | "totalPaisa") => t.reduce((a, x) => a + x[k], 0);
    const left = { netPaisa: l.netPaisa - sum("netPaisa"), vatPaisa: l.vatPaisa - sum("vatPaisa"), totalPaisa: l.totalPaisa - sum("totalPaisa"), qty: l.qty - t.reduce((a, x) => a + (x.units ?? 0), 0) };
    const order = l.source === "order" && l.sourceId && orderById.has(l.sourceId) ? { state: orderById.get(l.sourceId)!, collected: false } : null;
    const lock = lineLock({ source: l.source as LineSource, notBilled: Boolean(l.notBilledTaskId), leftPaisa: left.totalPaisa, order });
    return { l, left, lock, byUnits: isMedicineLine(l.source as LineSource), controlled: Boolean(l.medicineKey && saleClass(l.medicineKey) === "ctrl") };
  });
}
async function paymentFacts(tx: Tx, inv: Inv) {
  const pays = await tx.payment.findMany({ where: { invoiceId: inv.id, status: "confirmed" }, orderBy: { confirmedAt: "asc" } });
  const taken = await tx.refundAllocation.findMany({ where: { paymentId: { in: pays.map((p) => p.id) }, refund: { status: LIVE, source: "bill" } }, select: { paymentId: true, amountPaisa: true } });
  return pays.map((p) => {
    const gw = gatewayRefunds(p);
    const method = p.method as PaymentMethod;
    const ways = PAYOUT_WAYS.filter((w) => payoutWayAllowed({ method, way: w, gatewayRefunds: gw, stage: "request", cashReason: w === "cash" && isWallet(method) ? "no-wallet-access" : null }));
    return { p, method, gw, ways, leftPaisa: p.amountPaisa - taken.filter((x) => x.paymentId === p.id).reduce((a, x) => a + x.amountPaisa, 0) };
  });
}
const openRefundOf = (tx: Tx, invoiceId: string) => tx.refund.findFirst({ where: { invoiceId, status: { in: ["requested", "approved"] } }, select: { id: true, status: true } });
const liveBillRefunds = async (tx: Tx, invoiceId: string) =>
  (await tx.refund.aggregate({ where: { invoiceId, source: "bill", status: LIVE }, _sum: { amountPaisa: true } }))._sum.amountPaisa ?? 0;

export async function refundableView(tx: Tx, s: SessionData, invoiceId: string): Promise<RefundableView> {
  const inv = await invoiceHere(tx, s, invoiceId);
  const [lines, pays, open, live] = await Promise.all([lineFacts(tx, inv), paymentFacts(tx, inv), openRefundOf(tx, inv.id), liveBillRefunds(tx, inv.id)]);
  const confirmedLeftPaisa = inv.paidPaisa - live;
  const blockers: RefundableView["blockers"] = [];
  if (!["issued", "partially_paid", "balanced"].includes(inv.status)) blockers.push("bill_not_refundable");
  if (open) blockers.push("refund_open");
  if (confirmedLeftPaisa <= 0 && !blockers.length) blockers.push("nothing_left");
  return {
    invoice: billRef(inv), patient: await patientOf(tx, inv), buyer: buyerOf(inv), confirmedLeftPaisa,
    lines: lines.map(({ l, left, lock, byUnits, controlled }) => ({
      id: l.id, source: l.source, nameEn: l.nameEn, nameBn: l.nameBn, qty: l.qty, netPaisa: l.netPaisa, vatPaisa: l.vatPaisa, totalPaisa: l.totalPaisa, vatRateBp: l.vatRateBp,
      left, lock, byUnits, controlled,
    })),
    payments: pays.map(({ p, method, gw, ways, leftPaisa }) => ({ id: p.id, method, amountPaisa: p.amountPaisa, trxId: p.trxId, reference: p.reference, confirmedAt: iso(p.confirmedAt), leftPaisa, ways, gatewayRefunds: gw })),
    openRefundId: open?.id ?? null,
    blockers,
  };
}

/* ───── request ───── */
const REQUEST_MSG: Record<string, [number, string, string]> = {
  refund_open: [409, "এই বিলে একটি রিফান্ড আগেই খোলা আছে — আগে সেটির সিদ্ধান্ত হোক", "A refund is already open on this bill — it must be decided first"],
  bill_not_refundable: [409, "এই বিলে রিফান্ড হয় না (ইস্যু হয়নি বা বাতিল)", "This bill cannot be refunded (not issued, or voided)"],
  category_unknown: [400, "রিফান্ডের ধরন বেছে নিন", "Choose what kind of refund this is"],
  reason_too_short: [400, "কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write a reason (at least 10 characters)"],
  no_lines: [400, "কোন সেবা বা ওষুধ ফেরত হচ্ছে বেছে নিন", "Choose what is being refunded"],
  line_locked: [409, "যে সেবা দেওয়া হয়ে গেছে তা ফেরত হয় না", "A service already given cannot be refunded"],
  line_over: [422, "লাইনের বাকি অংশের চেয়ে বেশি", "More than is left of the line"],
  category_line_mismatch: [422, "এই ধরনের রিফান্ড এই লাইনে হয় না", "This kind of refund does not fit these lines"],
  over_confirmed: [422, "বিলে নিশ্চিত টাকার চেয়ে বেশি ফেরত হয় না", "More than the confirmed money on the bill"],
  over_case: [422, "গেটওয়ে যত টাকা জানিয়েছে তার বেশি ফেরত হয় না", "More than the gateway reported for this case"],
  no_allocations: [400, "কোন পেমেন্ট থেকে ফেরত যাবে বেছে নিন", "Choose which payment the money goes back against"],
  allocation_over: [422, "পেমেন্টে যত টাকা ছিল তার বেশি ফেরত হয় না", "More than the payment held"],
  allocation_mismatch: [422, "পেমেন্ট ভাগের যোগফল রিফান্ডের সমান নয়", "The payments do not add up to the refund"],
  payout_not_allowed: [422, "এই পেমেন্ট এভাবে ফেরত দেওয়া যায় না", "This payment cannot be paid back that way"],
};
function refuse(code: string, field?: string): never {
  const [status, bn, en] = REQUEST_MSG[code] ?? [422, "রিফান্ড করা যাচ্ছে না", "The refund cannot be made"];
  throw err(status, code, bn, en, field ? { field } : undefined);
}

export async function requestRefund(tx: Tx, s: SessionData, invoiceId: string, req: RefundRequest, now: Date): Promise<{ r: Rf; audit: AuditEntry[] }> {
  if (!WRITERS.includes(s.role)) throw notWriter();
  const inv = await invoiceHere(tx, s, invoiceId, true);
  const [lines, pays, open, live] = await Promise.all([lineFacts(tx, inv), paymentFacts(tx, inv), openRefundOf(tx, inv.id), liveBillRefunds(tx, inv.id)]);
  if (new Set(req.lines.map((l) => l.chargeItemId)).size !== req.lines.length) refuse("line_over", "lines");
  if (new Set(req.allocations.map((a) => a.paymentId)).size !== req.allocations.length) refuse("allocation_mismatch", "allocations");
  const chosen = req.lines.map((x, i) => {
    const f = lines.find((l) => l.l.id === x.chargeItemId);
    if (!f) throw err(404, "line_not_found", "এই লাইন বিলে নেই", "This line is not on the bill", { field: `lines.${i}.chargeItemId` });
    if (f.byUnits !== ("units" in x)) refuse("line_over", `lines.${i}`);
    const part: LinePart | null = f.lock ? null : partOfLine(f.left, "units" in x ? { units: x.units } : { amountPaisa: x.amountPaisa });
    return { f, part };
  });
  const allocs = req.allocations.map((a, i) => {
    const p = pays.find((x) => x.p.id === a.paymentId);
    if (!p) throw err(404, "payment_not_found", "এই বিলে এমন নিশ্চিত পেমেন্ট নেই", "No such confirmed payment on this bill", { field: `allocations.${i}.paymentId` });
    return { p, a };
  });
  const blockers = refundRequestBlockers({
    source: "bill", category: req.category, reason: req.reason, billStatus: dash<InvoiceState>(inv.status), openRefund: Boolean(open),
    lines: chosen.map(({ f, part }) => ({ source: f.l.source as LineSource, lock: f.lock, part })),
    confirmedLeftPaisa: inv.paidPaisa - live,
    allocations: allocs.map(({ p, a }) => ({ method: p.method, leftPaisa: p.leftPaisa, amountPaisa: a.amountPaisa, way: a.way, gatewayRefunds: p.gw, cashReason: a.cashReason ?? null })),
  });
  if (blockers.length) refuse(blockers[0]!);
  const parts = chosen.map((c) => c.part!);
  const sum = (k: "netPaisa" | "vatPaisa" | "totalPaisa") => parts.reduce((x, p) => x + p[k], 0);
  const controlled = chosen.some(({ f }) => f.controlled);
  const cardBankCash = allocs.some(({ p, a }) => isCardBankCash(p.method, a.way));
  const id = `rf_${randomUUID()}`, taskId = `task_${randomUUID()}`;
  await tx.task.create({ data: { id: taskId, tenantId: s.tenantId, kind: REFUND_TASK, status: "requested", focusId: inv.id, reason: req.reason.trim(), requestedById: s.userId, requestedAt: now,
    detail: { refundId: id, amountPaisa: sum("totalPaisa"), category: req.category } } });
  await tx.refund.create({ data: {
    id, tenantId: s.tenantId, organizationId: s.organizationId, invoiceId: inv.id, patientId: inv.patientId, source: "bill", category: req.category, reason: req.reason.trim(),
    amountPaisa: sum("totalPaisa"), netPaisa: sum("netPaisa"), vatPaisa: sum("vatPaisa"), needsOwner: controlled || cardBankCash, approvalTaskId: taskId,
    requestedById: s.userId, requestedAt: now, statusAt: now,
    lines: { create: chosen.map(({ f, part }) => ({ tenantId: s.tenantId, chargeItemId: f.l.id, units: part!.units, netPaisa: part!.netPaisa, vatPaisa: part!.vatPaisa, totalPaisa: part!.totalPaisa })) },
    allocations: { create: allocs.map(({ p, a }) => ({ tenantId: s.tenantId, paymentId: p.p.id, method: p.method, amountPaisa: a.amountPaisa, way: a.way, cashReason: a.way === "cash" && isWallet(p.method) ? a.cashReason ?? null : null })) },
  } });
  const r = (await refundRow(tx, s.organizationId, id))!;
  return { r, audit: [
    { action: "create", entity: "Refund", entityId: id, patientId: inv.patientId, detail: { invoiceId: inv.id, number: inv.number, category: req.category, amountPaisa: r.amountPaisa, lines: r.lines.length, ways: r.allocations.map((a) => `${a.method}:${a.way}`), needsOwner: r.needsOwner, taskId } },
  ] };
}

/** Reconciliation → refund (ADR 0013): money a callback gateway reported that never became confirmed money on the bill.
    The gateway is asked again; the refund is for exactly what it confirms for the case's reference. Owner only (the
    reconciliation queue); approved by someone else (an admin, or another owner). */
export async function requestCaseRefund(tx: Tx, s: SessionData, taskId: string, req: ReconcileRefundRequest, now: Date): Promise<{ r: Rf; audit: AuditEntry[] }> {
  const t0 = await tx.task.findFirst({ where: { id: taskId, kind: RECONCILE_TASK } });
  const p = t0?.focusId ? await tx.payment.findFirst({ where: { id: t0.focusId, organizationId: s.organizationId } }) : null;
  if (!t0 || !p) throw notFound();
  const inv = await invoiceHere(tx, s, p.invoiceId, true);
  const t = (await tx.task.findFirst({ where: { id: taskId } }))!;
  if (t.status !== "requested") throw err(409, "case_decided", "এই কেসের সিদ্ধান্ত আগেই হয়েছে", "This case was already decided");
  const d = t.detail as { providerRef: string | null; trxId: string | null; amountPaisa: number | null; resolution?: unknown };
  const provider = providerName(p);
  const live = d.providerRef && provider ? await provider.verify({ providerRef: d.providerRef }).catch(() => null) : null;
  if (!live || live.status !== "confirmed" || !live.trxId || (d.amountPaisa !== null && live.amountPaisa !== d.amountPaisa) || (d.trxId && live.trxId !== d.trxId))
    throw err(422, "not_confirmed_by_provider", "গেটওয়ে এখন এই টাকা নিশ্চিত করছে না — নোটসহ সমাধান করুন", "The gateway does not confirm this money now — resolve the case with a note");
  const gw = gatewayRefunds(p);
  const blockers = refundRequestBlockers({
    source: "reconciliation", category: "overpayment", reason: req.reason, billStatus: dash<InvoiceState>(inv.status), openRefund: Boolean(await openRefundOf(tx, inv.id)), lines: [],
    confirmedLeftPaisa: 0, caseAmountPaisa: live.amountPaisa,
    allocations: [{ method: p.method as PaymentMethod, leftPaisa: live.amountPaisa, amountPaisa: live.amountPaisa, way: req.way, gatewayRefunds: gw, cashReason: req.cashReason ?? null }],
  });
  if (blockers.length) refuse(blockers[0]!);
  const id = `rf_${randomUUID()}`, approvalId = `task_${randomUUID()}`;
  await tx.task.create({ data: { id: approvalId, tenantId: s.tenantId, kind: REFUND_TASK, status: "requested", focusId: inv.id, reason: req.reason.trim(), requestedById: s.userId, requestedAt: now,
    detail: { refundId: id, amountPaisa: live.amountPaisa, category: "overpayment", caseTaskId: taskId } } });
  await tx.refund.create({ data: {
    id, tenantId: s.tenantId, organizationId: s.organizationId, invoiceId: inv.id, patientId: inv.patientId, source: "reconciliation", caseTaskId: taskId, category: "overpayment", reason: req.reason.trim(),
    amountPaisa: live.amountPaisa, netPaisa: live.amountPaisa, vatPaisa: 0, needsOwner: false, approvalTaskId: approvalId, requestedById: s.userId, requestedAt: now, statusAt: now,
    allocations: { create: [{ tenantId: s.tenantId, paymentId: p.id, method: p.method, amountPaisa: live.amountPaisa, way: req.way, cashReason: req.way === "cash" ? req.cashReason ?? null : null }] },
  } });
  const status = transition("APPROVAL", APPROVAL, t.status, "reject"); // APPROVAL reject = resolved (ADR 0005); the outcome says how
  const resolution = { action: "refunded" as const, note: req.reason.trim(), by: s.userId, at: now.toISOString(), refundId: id };
  const upd = await tx.task.updateMany({ where: { id: t.id, status: "requested" }, data: { status, decidedById: s.userId, decidedAt: now, decisionNote: req.reason.trim(), detail: { ...(t.detail as object), resolution } } });
  if (upd.count !== 1) throw stale();
  const r = (await refundRow(tx, s.organizationId, id))!;
  return { r, audit: [
    { action: "update", entity: "Task", entityId: taskId, patientId: inv.patientId, detail: { kind: RECONCILE_TASK, event: "refund-to-patient", refundId: id, amountPaisa: live.amountPaisa, trxId: live.trxId } },
    { action: "create", entity: "Refund", entityId: id, patientId: inv.patientId, detail: { source: "reconciliation", invoiceId: inv.id, caseTaskId: taskId, amountPaisa: live.amountPaisa, way: req.way } },
  ] };
}

/* ───── approve / reject / withdraw ───── */
const DECIDE_MSG: Record<string, [number, string, string, object?]> = {
  not_an_approver: [403, "শুধু মালিক বা অ্যাডমিন সিদ্ধান্ত দিতে পারেন", "Only the owner or an admin can decide", { reason: "role", canRequest: false }],
  own_request: [403, "নিজের অনুরোধ নিজে অনুমোদন করা যায় না", "You cannot approve your own request", { reason: "own-request", canRequest: false }],
  above_approver_limit: [422, "আপনার অনুমোদন সীমার বেশি", "Above your approval limit"],
  owner_only: [403, "এই রিফান্ড (নিয়ন্ত্রিত ওষুধ, বা কার্ড / ব্যাংকের টাকা নগদে) শুধু মালিক অনুমোদন করেন", "Only the owner approves this refund (a controlled drug, or card / bank money paid back in cash)", { reason: "owner-only", canRequest: false }],
  note_too_short: [400, "নোট লিখুন (অন্তত ১০ অক্ষর)", "Write a note (at least 10 characters)", { field: "note" }],
  part_paid: [409, "ফেরত দেওয়া শুরু হয়ে গেছে — আর প্রত্যাহার করা যায় না", "The payout has started — it can no longer be withdrawn"],
};
function refuseDecision(code: string): never {
  const [status, bn, en, extra] = DECIDE_MSG[code]!;
  throw err(status, code, bn, en, extra as Record<string, unknown> | undefined);
}
/** Anything moved for this refund (an allocation claimed or paid, a gateway failure, medicine back on the shelf). */
async function payoutStarted(tx: Tx, r: Rf) {
  return r.allocations.some((a) => a.status !== "open" || a.gatewayFailedAt) || Boolean(await tx.stockMove.findFirst({ where: { refType: "refund-line", refId: { in: r.lines.map((l) => l.id) } }, select: { id: true } }));
}

export async function decideRefund(tx: Tx, s: SessionData, refundId: string, d: RefundDecisionRequest, now: Date): Promise<{ r: Rf; audit: AuditEntry[] }> {
  const r0 = await refundRow(tx, s.organizationId, refundId);
  if (!r0) throw notFound();
  await invoiceHere(tx, s, r0.invoiceId, true);
  const r = (await refundRow(tx, s.organizationId, refundId))!; // re-read under the bill's lock: one decision wins
  const note = d.note?.trim() ?? "";
  const from = r.status as RefundState;
  if (d.decision === "withdraw") {
    if (from !== "approved") throw err(409, "not_approved", "শুধু অনুমোদিত রিফান্ড প্রত্যাহার করা যায়", "Only an approved refund can be withdrawn");
    const b = refundWithdrawBlockers({ role: s.role, note, anyPaid: await payoutStarted(tx, r) });
    if (b.length) refuseDecision(b[0]!);
    const to = transition("REFUND", REFUND, from, "withdraw");
    const n = await tx.refund.updateMany({ where: { id: r.id, status: "approved", rev: r.rev }, data: { status: to, withdrawnById: s.userId, withdrawnAt: now, withdrawNote: note, statusAt: now, rev: { increment: 1 } } });
    if (n.count !== 1) throw stale();
    return { r: (await refundRow(tx, s.organizationId, r.id))!, audit: [{ action: "update", entity: "Refund", entityId: r.id, patientId: r.patientId, detail: { event: "withdraw", note, amountPaisa: r.amountPaisa } }] };
  }
  if (from !== "requested") throw err(409, "already_decided", "এই রিফান্ডের সিদ্ধান্ত আগেই হয়েছে", "This refund was already decided");
  const task = await tx.task.findFirst({ where: { id: r.approvalTaskId!, kind: REFUND_TASK } });
  if (!task) throw notFound();
  if (d.decision === "approve") {
    const org = await tx.organization.findFirst({ where: { id: s.organizationId } });
    const items = await tx.chargeItem.findMany({ where: { id: { in: r.lines.map((l) => l.chargeItemId) } }, select: { medicineKey: true } });
    const b = refundApprovalBlockers({
      approverId: s.userId, approverRole: s.role, requestedById: r.requestedById, amountPaisa: r.amountPaisa,
      settings: { cashierLimitPaisa: org!.cashierDiscountLimitPaisa, cashierLimitBp: org!.cashierDiscountLimitBp, approverLimitPaisa: org!.approverLimitPaisa },
      controlled: items.some((i) => i.medicineKey && saleClass(i.medicineKey) === "ctrl"),
      cardBankCash: r.allocations.some((a) => isCardBankCash(a.method as PaymentMethod, a.way as PayoutWay)),
    });
    if (b.length) refuseDecision(b[0]!);
  } else {
    if (!APPROVERS.includes(s.role)) refuseDecision("not_an_approver");
    if (s.userId === r.requestedById) refuseDecision("own_request");
    if (note.length < 10) throw err(400, "note_required", "প্রত্যাখ্যানের কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write why it is rejected (at least 10 characters)", { field: "note" });
  }
  const tStatus = transition("APPROVAL", APPROVAL, task.status, d.decision);
  const u = await tx.task.updateMany({ where: { id: task.id, status: "requested" }, data: { status: tStatus, decidedById: s.userId, decidedAt: now, decisionNote: note || null } });
  if (u.count !== 1) throw stale();
  const to = transition("REFUND", REFUND, from, d.decision);
  const n = await tx.refund.updateMany({ where: { id: r.id, status: "requested", rev: r.rev }, data: { status: to, decidedById: s.userId, decidedAt: now, decisionNote: note || null, statusAt: now, rev: { increment: 1 } } });
  if (n.count !== 1) throw stale();
  return { r: (await refundRow(tx, s.organizationId, r.id))!, audit: [
    { action: "update", entity: "Task", entityId: task.id, patientId: r.patientId, detail: { kind: REFUND_TASK, event: d.decision, refundId: r.id, amountPaisa: r.amountPaisa, note: note || null } },
    { action: "update", entity: "Refund", entityId: r.id, patientId: r.patientId, detail: { event: d.decision, note: note || null } },
  ] };
}
/** The single Approvals queue decides a refund by its task id. */
export async function refundIdOfTask(tx: Tx, taskId: string): Promise<string | null> {
  const t = await tx.task.findFirst({ where: { id: taskId, kind: REFUND_TASK }, select: { detail: true } });
  return t ? (t.detail as { refundId?: string }).refundId ?? null : null;
}

/* ───── pay out ───── */
/** The open shift of the person paying cash at this facility (cash leaves their drawer). */
const openShiftOf = (tx: Tx, s: SessionData) => tx.shift.findFirst({ where: { organizationId: s.organizationId, cashierId: s.userId, status: "open" }, select: { id: true } });

/** Medicine on the refund comes back into quarantine when the payout starts — once (ADR 0009 addendum). A dispensed line
    also gets its `return` dispense row (the original is never edited); "wrong dispense" tells the prescribing doctor. */
async function writeReturns(tx: Tx, s: SessionData, r: Rf, now: Date, audit: AuditEntry[]) {
  const med = r.lines.filter((l) => l.units !== null);
  if (!med.length) return;
  if (await tx.stockMove.findFirst({ where: { refType: "refund-line", refId: { in: med.map((l) => l.id) } }, select: { id: true } })) return;
  const items = await tx.chargeItem.findMany({ where: { id: { in: med.map((l) => l.chargeItemId) } } });
  const inv = await tx.invoice.findFirst({ where: { id: r.invoiceId }, select: { encounterId: true, patientId: true } });
  const enc = inv?.encounterId ? await tx.encounter.findFirst({ where: { id: inv.encounterId }, select: { id: true, practitionerId: true, patientId: true } }) : null;
  for (const l of med) {
    const c = items.find((i) => i.id === l.chargeItemId)!;
    const src = c.batchId ? await tx.stockBatch.findFirst({ where: { id: c.batchId } }) : null;
    if (!src) throw err(409, "batch_unknown", "এই ওষুধের ব্যাচ পাওয়া যায়নি", "The batch of this medicine is not known");
    const q = await batchFor(tx, s, { ...src, location: "quarantine" }, src.sample);
    await tx.stockMove.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, batchId: q.id, kind: "return", qty: l.units!, refType: "refund-line", refId: l.id, reason: r.reason, byId: s.userId, at: now } });
    audit.push({ action: "create", entity: "StockMove", entityId: q.id, patientId: r.patientId, detail: { kind: "return", into: "quarantine", medicineKey: src.medicineKey, batchNo: src.batchNo, qty: l.units, refundLineId: l.id } });
    if (c.source !== "dispense" || !c.sourceId) continue;
    const o = await tx.medicationDispense.findFirst({ where: { id: c.sourceId } });
    if (!o) continue;
    const id = `md_${randomUUID()}`;
    await tx.medicationDispense.create({ data: {
      id, tenantId: s.tenantId, organizationId: o.organizationId, encounterId: o.encounterId, patientId: o.patientId, compositionId: o.compositionId, requestId: o.requestId,
      prescribedKey: o.prescribedKey, medicineKey: o.medicineKey, action: "return", qty: l.units!, reason: r.reason, returnOfId: o.id, refundLineId: l.id, byId: s.userId, at: now,
    } });
    audit.push({ action: "create", entity: "MedicationDispense", entityId: id, patientId: o.patientId, detail: { action: "return", returnOf: o.id, qty: l.units, category: r.category } });
    // ADR 0013: every wrong-dispense return tells the doctor who prescribed it (a medication incident)
    if (r.category === "wrong-dispense" && enc?.practitionerId) {
      const cid = await deliverInApp(tx, s, { patientId: o.patientId, encounterId: o.encounterId }, { kind: "return-notice", channel: "doctor_inbox", recipientUserId: enc.practitionerId, dispenseId: id }, now);
      audit.push({ action: "create", entity: "Communication", entityId: cid, patientId: o.patientId, detail: { kind: "return-notice", dispenseId: id } });
    }
  }
}

/** The bill's refunded money = what its bill refunds paid out (the database checks it). */
async function syncRefunded(tx: Tx, invoiceId: string) {
  const paid = (await tx.refundAllocation.aggregate({ where: { status: "paid", refund: { invoiceId, source: "bill" } }, _sum: { amountPaisa: true } }))._sum.amountPaisa ?? 0;
  await tx.invoice.update({ where: { id: invoiceId }, data: { refundedPaisa: paid } });
}

/** The last allocation was paid: the voucher RF/yy/nnnn and REFUND pay, in the same transaction. */
async function finishIfPaid(tx: Tx, o: Org, refundId: string, by: string, now: Date, audit: AuditEntry[]) {
  const r = (await refundRow(tx, o.organizationId, refundId))!;
  if (r.status !== "approved" || r.allocations.some((a) => a.status !== "paid")) return r;
  const inv = (await tx.invoice.findFirst({ where: { id: r.invoiceId } }))!;
  const org = (await tx.organization.findFirst({ where: { id: o.organizationId } }))!;
  const p = inv.patientId ? await tx.patient.findFirst({ where: { id: inv.patientId }, select: { nameBn: true, nameEn: true, facilityNo: true } }) : null;
  const items = await tx.chargeItem.findMany({ where: { id: { in: r.lines.map((l) => l.chargeItemId) } } });
  const pays = await tx.payment.findMany({ where: { id: { in: r.allocations.map((a) => a.paymentId) } }, select: { id: true, trxId: true } });
  const who = await people(tx, [r.requestedById, r.decidedById, by]);
  const rates = new Map<number, { netPaisa: number; vatPaisa: number }>();
  const lines = r.lines.map((l) => {
    const c = items.find((i) => i.id === l.chargeItemId)!;
    const x = rates.get(c.vatRateBp) ?? { netPaisa: 0, vatPaisa: 0 }; x.netPaisa += l.netPaisa; x.vatPaisa += l.vatPaisa; rates.set(c.vatRateBp, x);
    return { nameBn: c.nameBn, nameEn: c.nameEn, units: l.units, vatRateBp: c.vatRateBp, netPaisa: l.netPaisa, vatPaisa: l.vatPaisa, totalPaisa: l.totalPaisa };
  });
  const nm = (id: string) => ({ nameBn: who(id).nameBn, nameEn: who(id).nameEn });
  const snapshot: RefundVoucherSnapshot = {
    seller: { nameEn: org.name, nameBn: org.nameBn, address: org.address, vatBin: org.vatBin, vatBinSample: org.vatBinSample },
    invoice: { id: inv.id, number: inv.number, issuedAt: iso(inv.issuedAt), totalPaisa: inv.totalPaisa },
    patient: p ? { nameBn: p.nameBn, nameEn: p.nameEn, facilityNo: p.facilityNo } : null, buyer: buyerOf(inv),
    category: r.category as RefundCategory, reason: r.reason, lines, netPaisa: r.netPaisa, vatPaisa: r.vatPaisa, amountPaisa: r.amountPaisa,
    vatByRate: [...rates.entries()].sort((a, b) => a[0] - b[0]).map(([rateBp, x]) => ({ rateBp, ...x })),
    paidBack: r.allocations.map((a) => ({ method: a.method as PaymentMethod, way: a.way as PayoutWay, amountPaisa: a.amountPaisa, refundTrxId: a.refundTrxId, reference: a.reference, originalTrxId: pays.find((x) => x.id === a.paymentId)?.trxId ?? null })),
    recipient: { name: r.recipientName!, phone: r.recipientPhone!, relation: r.recipientRelation as RefundVoucherSnapshot["recipient"]["relation"] },
    requestedBy: nm(r.requestedById), approvedBy: nm(r.decidedById!), paidBy: nm(by),
  };
  const yy = dhakaDay(now).slice(2, 4);
  const name = `refund:${o.organizationId}:${yy}`;
  const seq = await tx.sequence.upsert({ where: { tenantId_name: { tenantId: o.tenantId, name } }, create: { tenantId: o.tenantId, name, value: 1 }, update: { value: { increment: 1 } } });
  const number = `RF/${yy}/${String(seq.value).padStart(4, "0")}`;
  const v = await tx.refundVoucher.create({ data: { tenantId: o.tenantId, organizationId: o.organizationId, refundId: r.id, invoiceId: inv.id, patientId: inv.patientId, number, verifyCode: newVerifyCode(), amountPaisa: r.amountPaisa, snapshot: snapshot as object, createdById: by, createdAt: now } });
  const to = transition("REFUND", REFUND, "approved", "pay");
  const n = await tx.refund.updateMany({ where: { id: r.id, status: "approved" }, data: { status: to, paidAt: now, statusAt: now, rev: { increment: 1 } } });
  if (n.count !== 1) throw stale();
  audit.push({ action: "create", entity: "RefundVoucher", entityId: v.id, patientId: r.patientId, detail: { refundId: r.id, number, amountPaisa: r.amountPaisa } });
  audit.push({ action: "update", entity: "Refund", entityId: r.id, patientId: r.patientId, detail: { event: "pay", number } });
  return (await refundRow(tx, o.organizationId, r.id))!;
}

/** Owner's check of money paid back by hand (and card / bank paid back in cash): a Task in the reconciliation queue. */
async function openRefundCheck(tx: Tx, s: SessionData, r: Rf, a: Alloc, now: Date) {
  const id = `task_${randomUUID()}`;
  await tx.task.create({ data: { id, tenantId: s.tenantId, kind: REFUND_CHECK_TASK, status: "requested", focusId: a.id, requestedById: s.userId, requestedAt: now,
    reason: a.way === "manual" ? "refund paid by hand — check it against the statement" : "card / bank money paid back in cash — check it against the statement",
    detail: { refundId: r.id, invoiceId: r.invoiceId, paymentId: a.paymentId, amountPaisa: a.amountPaisa, reference: a.reference } } });
  return id;
}

export interface PayOutcome { r: Rf; claimed: string[]; audit: AuditEntry[] }
export async function payRefund(tx: Tx, s: SessionData, refundId: string, req: RefundPayRequest, now: Date): Promise<PayOutcome> {
  if (!WRITERS.includes(s.role)) throw notWriter();
  const r0 = await refundRow(tx, s.organizationId, refundId);
  if (!r0) throw notFound();
  await invoiceHere(tx, s, r0.invoiceId, true);
  const r = (await refundRow(tx, s.organizationId, refundId))!;
  if (r.status !== "approved") throw err(409, "not_approved", r.status === "requested" ? "অনুমোদনের আগে টাকা ফেরত দেওয়া যায় না" : "এই রিফান্ড আর দেওয়ার মতো নেই", r.status === "requested" ? "Nothing is paid before approval" : "This refund can no longer be paid");
  if (r.rev !== req.rev) throw stale();
  const rc = recipientCheck(req.recipient);
  if (!rc.ok) throw err(400, `recipient_${rc.field}`, rc.field === "phone" ? "যিনি টাকা নিচ্ছেন তাঁর সঠিক মোবাইল নম্বর লিখুন" : rc.field === "name" ? "যিনি টাকা নিচ্ছেন তাঁর নাম লিখুন" : "রোগীর সঙ্গে সম্পর্ক বেছে নিন",
    rc.field === "phone" ? "Write the mobile number of the person taking the money" : rc.field === "name" ? "Write the name of the person taking the money" : "Choose their relationship to the patient", { field: `recipient.${rc.field}` });
  if (r.recipientName && (r.recipientName !== req.recipient.name.trim() || r.recipientPhone !== rc.phone || r.recipientRelation !== req.recipient.relation))
    throw err(409, "recipient_recorded", "যিনি টাকা নিচ্ছেন তাঁর তথ্য আগেই লেখা হয়েছে", "Who takes the money was already recorded for this refund", { field: "recipient" });
  const audit: AuditEntry[] = [];
  const open = r.allocations.filter((a) => a.status === "open");
  if (!open.length) throw err(409, r.allocations.some((a) => a.status === "paying") ? "being_paid" : "nothing_to_pay", "গেটওয়েতে ফেরত চলছে — একটু পরে দেখুন", "A gateway refund is under way — check again shortly");
  const pays = await tx.payment.findMany({ where: { id: { in: open.map((a) => a.paymentId) } } });
  const shift = open.some((a) => a.way === "cash" || req.allocations.some((x) => x.id === a.id && x.switchToCash)) ? await openShiftOf(tx, s) : null;
  if (!r.recipientName) await tx.refund.update({ where: { id: r.id }, data: { recipientName: req.recipient.name.trim(), recipientPhone: rc.phone, recipientRelation: req.recipient.relation, rev: { increment: 1 }, statusAt: now } });
  await writeReturns(tx, s, r, now, audit);
  const claimed: string[] = [];
  for (const a of open) {
    const ask = req.allocations.find((x) => x.id === a.id);
    const p = pays.find((x) => x.id === a.paymentId)!;
    let way = a.way as PayoutWay, cashReason = a.cashReason as CashReason | null;
    if (ask?.switchToCash && way !== "cash") {
      if (!payoutWayAllowed({ method: a.method as PaymentMethod, way: "cash", gatewayRefunds: true, stage: "payout", cashReason: "gateway-failed", gatewayFailed: Boolean(a.gatewayFailedAt) }))
        throw err(409, "cash_not_allowed", "গেটওয়েতে ফেরত ব্যর্থ না হলে নগদে দেওয়া যায় না", "Cash is allowed only after the gateway refund failed", { field: "allocations" });
      way = "cash"; cashReason = "gateway-failed";
    }
    if (way === "cash") {
      if (!shift) throw err(409, "no_open_shift", "নগদ ফেরতের জন্য আপনার শিফট খোলা থাকতে হবে", "Open your shift first — cash refunds leave your drawer", { field: "shift" });
      const flag = isCardBankCash(a.method as PaymentMethod, "cash");
      await tx.refundAllocation.update({ where: { id: a.id }, data: { way, cashReason, status: "paid", shiftId: shift.id, paidById: s.userId, paidAt: now, needsReconciliation: flag } });
      if (flag) await tx.refundAllocation.update({ where: { id: a.id }, data: { reconcileTaskId: await openRefundCheck(tx, s, r, { ...a, way: "cash" }, now) } });
      audit.push({ action: "update", entity: "RefundAllocation", entityId: a.id, patientId: r.patientId, detail: { event: "paid", way, cashReason, amountPaisa: a.amountPaisa, shiftId: shift.id } });
    } else if (way === "manual") {
      if (!ask?.reference) throw err(400, "reference_required", "হাতে ফেরতের রেফারেন্স লিখুন", "Write the reference of the refund made by hand", { field: "allocations" });
      await tx.refundAllocation.update({ where: { id: a.id }, data: { status: "paid", reference: ask.reference, paidById: s.userId, paidAt: now, needsReconciliation: true } });
      await tx.refundAllocation.update({ where: { id: a.id }, data: { reconcileTaskId: await openRefundCheck(tx, s, r, { ...a, reference: ask.reference }, now) } });
      audit.push({ action: "update", entity: "RefundAllocation", entityId: a.id, patientId: r.patientId, detail: { event: "paid", way, reference: ask.reference, amountPaisa: a.amountPaisa } });
    } else {
      if (!gatewayRefunds(p) || !p.providerRef || !p.trxId) throw err(503, "gateway_off", "এই পেমেন্টের গেটওয়ে এখন ফেরত দিতে পারছে না", "This payment's gateway cannot refund right now");
      const n = await tx.refundAllocation.updateMany({ where: { id: a.id, status: "open" }, data: { status: "paying", claimedById: s.userId, claimedAt: now } });
      if (n.count !== 1) throw stale();
      claimed.push(a.id);
      audit.push({ action: "update", entity: "RefundAllocation", entityId: a.id, patientId: r.patientId, detail: { event: "gateway-claimed", amountPaisa: a.amountPaisa, provider: p.provider } });
    }
  }
  await syncRefunded(tx, r.invoiceId);
  const done = await finishIfPaid(tx, s, r.id, s.userId, now, audit);
  return { r: done, claimed, audit };
}

/** After the commit: ask the gateway to refund each claimed allocation, then store its answer in a transaction of its
    own (ADR 0011 pattern). Completed → paid (and the voucher once all are); refused → open again with why; unknown →
    stays claimed for the sweep. */
export async function settleClaimed(tenantId: string, organizationId: string, allocationIds: string[], now: Date, userId: string | null): Promise<void> {
  const { forTenant } = await import("@setu/db");
  for (const id of allocationIds) {
    const job = await forTenant(tenantId, async (tx) => {
      const a = await tx.refundAllocation.findFirst({ where: { id, status: "paying" }, include: { refund: true } });
      if (!a) return null;
      const p = (await tx.payment.findFirst({ where: { id: a.paymentId } }))!;
      const known = (await tx.refundAllocation.findMany({ where: { paymentId: p.id, status: "paid", refundTrxId: { not: null } }, select: { refundTrxId: true } })).map((x) => x.refundTrxId!);
      return { a, p, known };
    }, { userId: userId ?? undefined });
    if (!job) continue;
    const provider = providerName(job.p);
    let answer: RefundAnswer = { status: "unknown", refundTrxId: null, code: "gateway-off" };
    if (provider?.refundSupport === "gateway") {
      try {
        // a retry after an earlier attempt failed or went unanswered: ask Refund Status first — bKash may have made it
        const earlier = job.a.gatewayFailedAt ? (await provider.refundStatus({ providerRef: job.p.providerRef!, trxId: job.p.trxId! }))?.find((x) => x.completed && x.amountPaisa === job.a.amountPaisa && !job.known.includes(x.refundTrxId)) : undefined;
        answer = earlier ? { status: "completed", refundTrxId: earlier.refundTrxId, code: null }
          : await provider.refund({ providerRef: job.p.providerRef!, trxId: job.p.trxId!, amountPaisa: job.a.amountPaisa, sku: job.a.id, reason: job.a.refund.category, known: job.known });
      } catch (e) { answer = { status: "unknown", refundTrxId: null, code: (e as Error).message.slice(0, 60) }; }
    }
    await applyRefundAnswer(tenantId, organizationId, id, answer, now, userId);
  }
}

async function applyRefundAnswer(tenantId: string, organizationId: string, allocationId: string, answer: RefundAnswer, now: Date, userId: string | null, giveUp = false) {
  const { forTenant } = await import("@setu/db");
  await forTenant(tenantId, async (tx) => {
    const a = await tx.refundAllocation.findFirst({ where: { id: allocationId, status: "paying" }, include: { refund: true } });
    if (!a) return;
    await tx.$queryRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${a.refund.invoiceId} FOR UPDATE`;
    const audit: AuditEntry[] = [];
    if (answer.status === "completed") {
      await tx.refundAllocation.update({ where: { id: a.id }, data: { status: "paid", refundTrxId: answer.refundTrxId, paidById: a.claimedById, paidAt: now } });
      await syncRefunded(tx, a.refund.invoiceId);
      audit.push({ action: "update", entity: "RefundAllocation", entityId: a.id, patientId: a.refund.patientId, detail: { event: "gateway-completed", refundTrxId: answer.refundTrxId, amountPaisa: a.amountPaisa } });
      await finishIfPaid(tx, { tenantId, organizationId }, a.refundId, a.claimedById!, now, audit);
    } else if (answer.status === "refused" || giveUp) {
      const why = answer.status === "refused" ? `gateway refused (${answer.code})` : "no refund found at the gateway";
      await tx.refundAllocation.update({ where: { id: a.id }, data: { status: "open", gatewayFailedAt: now, failReason: why } });
      audit.push({ action: "update", entity: "RefundAllocation", entityId: a.id, patientId: a.refund.patientId, detail: { event: "gateway-failed", code: answer.code, why } });
    } else return;
    for (const e of audit) await tx.auditEvent.create({ data: {
      tenantId, organizationId, userId, role: null, action: e.action, entity: e.entity, entityId: e.entityId, patientId: e.patientId ?? null, detail: { route: "refund-gateway-answer", ...(e.detail ?? {}) } as object,
    } });
  }, { userId: userId ?? undefined });
}

/** A person asks the gateway again about a claimed allocation ("check"): found → paid; nothing found after the give-up
    time → open again (they may try the gateway again, or pay cash with gateway-failed). */
export async function checkRefund(tx: Tx, s: SessionData, refundId: string): Promise<{ allocations: { id: string; claimedAt: Date }[] }> {
  const r = await refundRow(tx, s.organizationId, refundId);
  if (!r) throw notFound();
  await invoiceHere(tx, s, r.invoiceId);
  const paying = r.allocations.filter((a) => a.status === "paying");
  if (!paying.length) throw err(409, "nothing_to_check", "গেটওয়েতে কোনো ফেরত চলছে না", "No gateway refund is under way");
  return { allocations: paying.map((a) => ({ id: a.id, claimedAt: a.claimedAt! })) };
}
export async function askGateway(tenantId: string, organizationId: string, allocationId: string, now: Date, userId: string | null): Promise<void> {
  const { forTenant } = await import("@setu/db");
  const job = await forTenant(tenantId, async (tx) => {
    const a = await tx.refundAllocation.findFirst({ where: { id: allocationId, status: "paying" } });
    if (!a) return null;
    const p = (await tx.payment.findFirst({ where: { id: a.paymentId } }))!;
    const known = (await tx.refundAllocation.findMany({ where: { paymentId: p.id, status: "paid", refundTrxId: { not: null } }, select: { refundTrxId: true } })).map((x) => x.refundTrxId!);
    return { a, p, known };
  }, { userId: userId ?? undefined });
  if (!job) return;
  const provider = providerName(job.p);
  let list: Awaited<ReturnType<PaymentProvider["refundStatus"]>> = null;
  try { list = provider ? await provider.refundStatus({ providerRef: job.p.providerRef!, trxId: job.p.trxId! }) : null; } catch { /* still unknown */ }
  const hit = list?.find((x) => x.completed && x.amountPaisa === job.a.amountPaisa && !job.known.includes(x.refundTrxId));
  const giveUp = !hit && list !== null && now.getTime() - job.a.claimedAt!.getTime() > REFUND_GIVE_UP_MINUTES * 60_000;
  await applyRefundAnswer(tenantId, organizationId, allocationId, hit ? { status: "completed", refundTrxId: hit.refundTrxId, code: null } : { status: "unknown", refundTrxId: null, code: "status" }, now, userId, giveUp);
}
/** The sweep (with the payments sweep, every minute): claimed gateway refunds never answered. Never refunds again. */
export async function sweepRefunds(now: Date): Promise<{ checked: number }> {
  const { refundSweepTargets, forTenant } = await import("@setu/db");
  const rows = await refundSweepTargets(new Date(now.getTime() - REFUND_STUCK_MINUTES * 60_000));
  for (const t of rows) {
    const org = await forTenant(t.tenantId, (tx) => tx.refundAllocation.findFirst({ where: { id: t.allocationId }, select: { refund: { select: { organizationId: true } } } }));
    if (org) await askGateway(t.tenantId, org.refund.organizationId, t.allocationId, now, null).catch(() => undefined);
  }
  return { checked: rows.length };
}

/* ───── views ───── */
export async function refundView(tx: Tx, s: SessionData, r: Rf): Promise<RefundView> {
  const inv = await invoiceHere(tx, s, r.invoiceId);
  const items = await tx.chargeItem.findMany({ where: { id: { in: r.lines.map((l) => l.chargeItemId) } } });
  const pays = await tx.payment.findMany({ where: { id: { in: r.allocations.map((a) => a.paymentId) } }, select: { id: true, trxId: true, reference: true, confirmedAt: true } });
  const checks = await tx.task.findMany({ where: { id: { in: r.allocations.flatMap((a) => (a.reconcileTaskId ? [a.reconcileTaskId] : [])) } }, select: { id: true, status: true } });
  const who = await people(tx, [r.requestedById, r.decidedById, r.withdrawnById, ...r.allocations.flatMap((a) => [a.paidById, a.claimedById])]);
  const started = await payoutStarted(tx, r);
  const approver = APPROVERS.includes(s.role) && s.userId !== r.requestedById;
  const timeline: RefundView["timeline"] = [{ event: "requested", at: r.requestedAt.toISOString(), by: who(r.requestedById), note: r.reason }];
  if (r.decidedAt && r.decidedById) timeline.push({ event: r.status === "rejected" ? "rejected" : "approved", at: r.decidedAt.toISOString(), by: who(r.decidedById), note: r.decisionNote });
  for (const a of r.allocations) {
    if (a.claimedAt) timeline.push({ event: "payout-started", at: a.claimedAt.toISOString(), by: a.claimedById ? who(a.claimedById) : null, note: null });
    if (a.gatewayFailedAt) timeline.push({ event: "gateway-failed", at: a.gatewayFailedAt.toISOString(), by: null, note: a.failReason });
    if (a.paidAt) timeline.push({ event: "allocation-paid", at: a.paidAt.toISOString(), by: a.paidById ? who(a.paidById) : null, note: a.refundTrxId ?? a.reference });
  }
  if (r.withdrawnAt && r.withdrawnById) timeline.push({ event: "withdrawn", at: r.withdrawnAt.toISOString(), by: who(r.withdrawnById), note: r.withdrawNote });
  if (r.paidAt) timeline.push({ event: "paid", at: r.paidAt.toISOString(), by: null, note: r.voucher?.number ?? null });
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  return {
    refund: {
      id: r.id, status: r.status as RefundState, source: r.source as "bill" | "reconciliation", caseTaskId: r.caseTaskId, category: r.category as RefundCategory, reason: r.reason,
      amountPaisa: r.amountPaisa, netPaisa: r.netPaisa, vatPaisa: r.vatPaisa, rev: r.rev, needsOwner: r.needsOwner,
      requestedBy: who(r.requestedById), requestedAt: r.requestedAt.toISOString(),
      decidedBy: r.decidedById ? who(r.decidedById) : null, decidedAt: iso(r.decidedAt), decisionNote: r.decisionNote,
      withdrawnBy: r.withdrawnById ? who(r.withdrawnById) : null, withdrawnAt: iso(r.withdrawnAt), withdrawNote: r.withdrawNote,
      paidAt: iso(r.paidAt),
      recipient: r.recipientName && r.recipientPhone && r.recipientRelation ? { name: r.recipientName, phone: r.recipientPhone, relation: r.recipientRelation as NonNullable<RefundView["refund"]["recipient"]>["relation"] } : null,
      voucher: r.voucher,
    },
    invoice: billRef(inv), patient: await patientOf(tx, inv), buyer: buyerOf(inv),
    lines: r.lines.map((l) => {
      const c = items.find((i) => i.id === l.chargeItemId)!;
      return { id: l.id, chargeItemId: l.chargeItemId, source: c.source, nameEn: c.nameEn, nameBn: c.nameBn, vatRateBp: c.vatRateBp, units: l.units, netPaisa: l.netPaisa, vatPaisa: l.vatPaisa, totalPaisa: l.totalPaisa };
    }),
    allocations: r.allocations.map((a) => {
      const p = pays.find((x) => x.id === a.paymentId);
      const t = checks.find((x) => x.id === a.reconcileTaskId);
      return {
        id: a.id, paymentId: a.paymentId, method: a.method as PaymentMethod, amountPaisa: a.amountPaisa, way: a.way as PayoutWay, cashReason: a.cashReason as CashReason | null,
        status: a.status as "open" | "paying" | "paid", gatewayFailed: Boolean(a.gatewayFailedAt), failReason: a.failReason, refundTrxId: a.refundTrxId, reference: a.reference,
        paidBy: a.paidById ? who(a.paidById) : null, paidAt: iso(a.paidAt), needsReconciliation: a.needsReconciliation,
        reconciled: !a.needsReconciliation ? null : !t || t.status === "requested" ? "waiting" : t.status === "approved" ? "matched" : "resolved",
        payment: { trxId: p?.trxId ?? null, reference: p?.reference ?? null, confirmedAt: iso(p?.confirmedAt) },
      };
    }),
    timeline,
    can: {
      approve: r.status === "requested" && approver, reject: r.status === "requested" && approver,
      withdraw: r.status === "approved" && APPROVERS.includes(s.role) && !started,
      pay: r.status === "approved" && WRITERS.includes(s.role) && r.allocations.some((a) => a.status === "open"),
      check: r.allocations.some((a) => a.status === "paying"),
    },
  };
}
export async function refundHere(tx: Tx, s: SessionData, id: string): Promise<Rf> {
  const r = await refundRow(tx, s.organizationId, id);
  if (!r) throw notFound();
  await invoiceHere(tx, s, r.invoiceId); // hides bills the role may not see
  return r;
}

export async function refundList(tx: Tx, s: SessionData, q: { status: string; invoiceId?: string; days: number }, now: Date): Promise<RefundList> {
  const since = new Date(now.getTime() - q.days * 864e5);
  const status = q.status === "all" ? undefined : q.status === "open" ? { in: ["requested", "approved"] as ("requested" | "approved")[] } : (q.status as RefundState);
  const rows = await tx.refund.findMany({
    where: { organizationId: s.organizationId, ...(status ? { status } : {}), ...(q.invoiceId ? { invoiceId: q.invoiceId } : {}), requestedAt: { gte: since }, invoice: { kind: { in: billKindsOf(s) } } },
    include: { invoice: { select: { id: true, number: true, kind: true } }, voucher: { select: { id: true, number: true } }, allocations: { select: { status: true } } },
    orderBy: { requestedAt: "desc" }, take: 200,
  });
  const pts = await tx.patient.findMany({ where: { id: { in: rows.flatMap((r) => (r.patientId ? [r.patientId] : [])) } }, select: { id: true, nameBn: true, nameEn: true, facilityNo: true } });
  const who = await people(tx, rows.flatMap((r) => [r.requestedById, r.decidedById]));
  const items: RefundList["items"] = rows.map((r) => ({
    id: r.id, status: r.status as RefundState, category: r.category as RefundCategory, reason: r.reason, amountPaisa: r.amountPaisa, requestedAt: r.requestedAt.toISOString(), paidAt: iso(r.paidAt),
    requestedBy: who(r.requestedById), decidedBy: r.decidedById ? who(r.decidedById) : null, invoice: r.invoice,
    patient: pts.find((p) => p.id === r.patientId) ?? null, voucher: r.voucher, paying: r.allocations.some((a) => a.status === "paying"),
  }));
  return { items };
}
const billKindsOf = (s: SessionData): ("opd" | "pharmacy" | "otc")[] => (["cashier", "owner", "admin"].includes(s.role) ? ["opd", "pharmacy", "otc"] : ["pharmacy", "otc"]);

export const refundVerifyUrl = (code: string) => `${config.verifyBaseUrl.replace(/\/rc$/, "/rf")}/${code}`;
export async function voucherView(tx: Tx, s: SessionData, refundId: string): Promise<RefundVoucherView> {
  const r = await refundHere(tx, s, refundId);
  const v = await tx.refundVoucher.findFirst({ where: { refundId: r.id }, include: { prints: { orderBy: { copy: "asc" } } } });
  if (!v) throw err(404, "no_voucher", "এই রিফান্ড এখনও দেওয়া হয়নি — ভাউচার নেই", "This refund is not paid yet — there is no voucher");
  const who = await people(tx, v.prints.map((p) => p.printedById));
  return {
    voucher: { id: v.id, number: v.number, refundId: r.id, invoiceId: v.invoiceId, createdAt: v.createdAt.toISOString(), amountPaisa: v.amountPaisa, verifyUrl: refundVerifyUrl(v.verifyCode), snapshot: v.snapshot as unknown as RefundVoucherSnapshot },
    prints: v.prints.map((p) => ({ id: p.id, copy: p.copy, reason: p.reason as RefundVoucherView["prints"][number]["reason"], format: p.format as "a5" | "thermal", lang: p.lang as "both" | "bn" | "en", printedBy: who(p.printedById), printedAt: p.printedAt.toISOString(), pdfUrl: `/api/v1/refunds/${r.id}/voucher/prints/${p.id}/pdf` })),
  };
}

/* ───── the single Approvals queue: refund items ───── */
export async function refundApprovalItems(tx: Tx, s: SessionData, status: "requested" | "approved" | "rejected"): Promise<ApprovalItem[]> {
  const here = (await tx.invoice.findMany({ where: { organizationId: s.organizationId }, select: { id: true } })).map((i) => i.id);
  const tasks = await tx.task.findMany({ where: { kind: REFUND_TASK, status, focusId: { in: here } }, orderBy: { requestedAt: status === "requested" ? "asc" : "desc" }, take: 100 });
  const out: ApprovalItem[] = [];
  for (const t of tasks) {
    const rid = (t.detail as { refundId?: string }).refundId;
    const r = rid ? await refundRow(tx, s.organizationId, rid) : null;
    const inv = r ? await tx.invoice.findFirst({ where: { id: r.invoiceId } }) : null;
    if (!r || !inv) continue;
    const items = await tx.chargeItem.findMany({ where: { id: { in: r.lines.map((l) => l.chargeItemId) } } });
    const who = await people(tx, [t.requestedById, t.decidedById]);
    const since = new Date(`${dhakaDay(t.requestedAt)}T00:00:00+06:00`);
    const mine = await tx.refund.findMany({ where: { organizationId: s.organizationId, requestedById: t.requestedById, requestedAt: { gte: since } }, select: { amountPaisa: true } });
    out.push({
      taskId: t.id, status: t.status, amountPaisa: r.amountPaisa, category: null, reason: r.reason, subtotalPaisa: inv.subtotalPaisa, limitPaisa: 0,
      requestedBy: who(t.requestedById), requestedAt: t.requestedAt.toISOString(),
      decidedBy: t.decidedById ? who(t.decidedById) : null, decidedAt: iso(t.decidedAt), decisionNote: t.decisionNote,
      kind: "refund-approval", line: null,
      refund: {
        id: r.id, category: r.category as RefundCategory, needsOwner: r.needsOwner,
        ways: r.allocations.map((a) => ({ method: a.method as PaymentMethod, way: a.way as PayoutWay, amountPaisa: a.amountPaisa })),
        lines: r.lines.map((l) => { const c = items.find((i) => i.id === l.chargeItemId)!; return { nameEn: c.nameEn, nameBn: c.nameBn, units: l.units, totalPaisa: l.totalPaisa }; }),
        controlled: items.some((i) => i.medicineKey && saleClass(i.medicineKey) === "ctrl"),
      },
      invoice: { id: inv.id, status: dash<InvoiceState>(inv.status), number: inv.number, subtotalPaisa: inv.subtotalPaisa, totalPaisa: inv.totalPaisa, kind: inv.kind, encounterId: inv.encounterId },
      patient: await patientOf(tx, inv), buyer: buyerOf(inv),
      requesterToday: { count: mine.length, totalPaisa: mine.reduce((a, m) => a + m.amountPaisa, 0) },
    });
  }
  return out;
}

/* ───── the owner's check of refunds paid by hand (reconciliation queue) ───── */
export async function refundCheckItems(tx: Tx, s: SessionData, status: "requested" | "approved" | "rejected"): Promise<ReconcileItem[]> {
  const tasks = await tx.task.findMany({ where: { kind: REFUND_CHECK_TASK, status }, orderBy: { requestedAt: status === "requested" ? "asc" : "desc" }, take: 100 });
  const out: ReconcileItem[] = [];
  for (const t of tasks) {
    const a = t.focusId ? await tx.refundAllocation.findFirst({ where: { id: t.focusId }, include: { refund: { include: { voucher: { select: { number: true } } } } } }) : null;
    if (!a || a.refund.organizationId !== s.organizationId) continue;
    const p = (await tx.payment.findFirst({ where: { id: a.paymentId } }))!;
    const inv = (await tx.invoice.findFirst({ where: { id: a.refund.invoiceId } }))!;
    const who = await people(tx, [a.paidById, t.decidedById]);
    out.push({
      taskId: t.id, status: t.status, why: t.reason ?? "", createdAt: t.requestedAt.toISOString(), whyCode: "manual-refund",
      reported: { providerRef: null, trxId: null, amountPaisa: a.amountPaisa },
      payment: { id: p.id, method: p.method as PaymentMethod, status: dash<ReconcileItem["payment"]["status"]>(p.status), amountPaisa: p.amountPaisa, trxId: p.trxId, attempt: p.attempt },
      invoice: { id: inv.id, number: inv.number, status: dash<InvoiceState>(inv.status), totalPaisa: inv.totalPaisa, paidPaisa: inv.paidPaisa },
      patient: await patientOf(tx, inv), buyer: buyerOf(inv),
      kind: "refund",
      refund: { id: a.refundId, allocationId: a.id, way: a.way as "cash" | "manual", amountPaisa: a.amountPaisa, reference: a.reference, paidBy: a.paidById ? who(a.paidById) : null, paidAt: iso(a.paidAt), voucherNumber: a.refund.voucher?.number ?? null },
      applyBlockers: [],
      resolution: t.decidedById && t.decidedAt ? { action: t.status === "approved" ? "matched" : "resolved", note: t.decisionNote, by: who(t.decidedById), at: t.decidedAt.toISOString(), refundId: a.refundId } : null,
    });
  }
  return out;
}
/** "Matches the statement" (APPROVAL approve) or resolved with a note (reject) — owner only, never the person who paid it. */
export async function decideRefundCheck(tx: Tx, s: SessionData, taskId: string, action: "apply" | "resolve", note: string | undefined, now: Date): Promise<{ item: ReconcileItem; patientId: string | null; invoiceId: string }> {
  const t = await tx.task.findFirst({ where: { id: taskId, kind: REFUND_CHECK_TASK } });
  const a = t?.focusId ? await tx.refundAllocation.findFirst({ where: { id: t.focusId }, include: { refund: true } }) : null;
  if (!t || !a || a.refund.organizationId !== s.organizationId) throw notFound();
  if (a.paidById === s.userId) throw err(403, "own_request", "নিজের দেওয়া ফেরত নিজে মেলানো যায় না", "You cannot check a refund you paid yourself", { reason: "own-request", canRequest: false });
  if (action === "resolve" && (note ?? "").trim().length < 10) throw err(400, "note_required", "নোট লিখুন (অন্তত ১০ অক্ষর)", "Write a note (at least 10 characters)", { field: "note" });
  const status = transition("APPROVAL", APPROVAL, t.status, action === "apply" ? "approve" : "reject");
  const u = await tx.task.updateMany({ where: { id: t.id, status: "requested" }, data: { status, decidedById: s.userId, decidedAt: now, decisionNote: note?.trim() || null } });
  if (u.count !== 1) throw stale();
  const item = (await refundCheckItems(tx, s, status)).find((i) => i.taskId === t.id)!;
  return { item, patientId: a.refund.patientId, invoiceId: a.refund.invoiceId };
}

/* ───── quarantine → counter (ADR 0009 addendum) ───── */
export async function resale(tx: Tx, s: SessionData, req: ResaleRequest, now: Date): Promise<{ body: { resaleId: string; fromBatchId: string; toBatchId: string; qty: number }; audit: AuditEntry[] }> {
  const b = await tx.stockBatch.findFirst({ where: { id: req.batchId, organizationId: s.organizationId } });
  if (!b) throw notFound();
  if (b.location !== "quarantine") throw err(409, "not_quarantine", "এই ব্যাচ কোয়ারেন্টাইনে নেই", "This batch is not in quarantine");
  const block = resaleBlockers({ role: s.role, unopened: req.unopened, reason: req.reason, expired: b.expiry < dhakaDay(now), controlled: saleClass(b.medicineKey) === "ctrl", inQuarantine: b.qtyOnHand, qty: req.qty });
  if (block.length) {
    const msg: Record<string, [number, string, string]> = {
      not_a_pharmacist: [403, "শুধু ফার্মাসিস্ট ফেরত ওষুধ আবার বিক্রির জন্য ছাড়তে পারেন", "Only a pharmacist releases returned medicine for sale"],
      owner_only: [403, "নিয়ন্ত্রিত ওষুধ শুধু মালিক কাউন্টারে ফেরত দিতে পারেন", "Only the owner returns a controlled drug to the counter"],
      not_unopened: [400, "খোলা হয়নি ও বিক্রয়যোগ্য — নিশ্চিত করুন", "Confirm it is unopened and resaleable"],
      reason_too_short: [400, "কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write a reason (at least 10 characters)"],
      expired: [409, "মেয়াদোত্তীর্ণ ব্যাচ কাউন্টারে যায় না", "An expired batch never goes back to the counter"],
      over_quarantine: [409, "কোয়ারেন্টাইনে এত নেই", "Quarantine does not hold that many"],
    };
    const [status, bn, en] = msg[block[0]!]!;
    throw err(status, block[0]!, bn, en, status === 403 ? { reason: "role", canRequest: false } : undefined);
  }
  const dest = await batchFor(tx, s, { ...b, location: "counter" }, b.sample);
  const ref = `tr_${randomUUID()}`, id = `rs_${randomUUID()}`;
  await tx.stockResale.create({ data: { id, tenantId: s.tenantId, organizationId: s.organizationId, fromBatchId: b.id, toBatchId: dest.id, qty: req.qty, unopened: true, reason: req.reason.trim(), transferRef: ref, byId: s.userId, at: now } });
  await tx.stockMove.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, batchId: b.id, kind: "transfer", qty: -req.qty, refType: "transfer", refId: ref, reason: req.reason.trim(), byId: s.userId, at: now } });
  await tx.stockMove.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, batchId: dest.id, kind: "transfer", qty: req.qty, refType: "transfer", refId: ref, reason: req.reason.trim(), byId: s.userId, at: now } });
  return { body: { resaleId: id, fromBatchId: b.id, toBatchId: dest.id, qty: req.qty }, audit: [{ action: "create", entity: "StockResale", entityId: id, detail: { medicineKey: b.medicineKey, batchNo: b.batchNo, qty: req.qty, reason: req.reason.trim(), from: "quarantine", to: "counter" } }] };
}
