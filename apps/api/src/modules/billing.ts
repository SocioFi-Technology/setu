/* Billing service (slice A6–A7). Runs inside command()/query() (or forTenant for provider callbacks), so RLS scopes every
   read to the tenant; bills are also scoped to the session's facility and branch. All money arithmetic is
   @setu/domain billing.ts — this file never adds, splits or rounds paisa itself. Status changes go through the INVOICE,
   PAYMENT and APPROVAL machines, and the database re-checks both the arithmetic and the transitions
   (migration billing_guards). Kamrul's decisions of 03/10/2026:
   - the bill attaches to a finished visit: the doctor's consultation fee + every active test order; a line with no
     price is shown and blocks issuing, never ৳0;
   - a discount above the cashier's limit is an APPROVAL Task (kind "discount-approval"); nothing is applied, the lines
     are locked and the bill cannot be issued — so cannot be paid — while it is requested;
   - lines change only while no discount is applied or requested ("remove the discount first"), so an approved or
     within-limit discount is never silently stretched over a different bill;
   - only desk lines can be removed or re-counted; the consultation and the doctor's orders stay (cancelling an order is
     ORDER `revoke`, lab slice);
   - receptionists see the bill but do not change it (decision 6);
   - a pending wallet amount is reserved, so confirmations can never overpay;
   - provider callbacks are recorded once; a repeat is a no-op, an out-of-order or backwards one is refused, and money
     reported on a failed or superseded attempt opens a reconciliation Task instead of being applied. */
import type { ApprovalItem, ApprovalList, BillingWorklist, ChargeSourceWire, ChargeDefinitionList, DiscountRequest, InvoiceView, NewPaymentRequest, PaymentView, ProviderCallbackResponse, ReconcileItem, ReconcileList } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  APPROVAL, INVOICE, PAYMENT, approvalBlockers, authorize, billKindsFor, type Plan, type Role, billTotals, checkNewPayment, decideProviderEvent, dhakaDay, discountDecision, discountLimit, discountToPaisa,
  LINK_CODE_ALPHABET, LINK_SMS_MAX, STUCK_MINUTES, smsSafeName, walletAmount, LINK_CODE_LENGTH, answerOutcome, decideReturn, invoiceEventAfterConfirm, isWallet, type ReturnStatus, issueBlockers, notBilledBlockers, paidBy, paymentSummary, reconcileApplyBlockers, syncOrderLines, transition, voidBlockers, type BillingSettings, type DiscountCategory, type InvoiceState,
  type PaymentMethod, type PaymentRow, type PaymentState, type ProviderEventKind,
} from "@setu/domain";
import { randomBytes, randomUUID } from "node:crypto";
import { GatewayError, providerByName, providerFor, type PaymentProvider, type ProviderStatus, type ProviderWebhook } from "../adapters/payments/index.js";
import { config } from "../config.js";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { branchOf, notFound } from "./frontdesk.js";
import { encounterHere, toVitalsEncounter } from "./vitals.js";

const dash = <T extends string>(s: string) => s.replace(/_/g, "-") as T;
const undash = <T extends string>(s: string) => s.replace(/-/g, "_") as T;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const DISCOUNT_TASK = "discount-approval";
export const RECONCILE_TASK = "payment-reconciliation";
/** decision 98: "Not billed here" on an unpriced order line (ADR 0005) */
export const BILL_ELSEWHERE_TASK = "bill-elsewhere";
const APPROVAL_KINDS = [DISCOUNT_TASK, BILL_ELSEWHERE_TASK];
const OPEN_BILL = { notIn: ["cancelled", "entered_in_error"] as ("cancelled" | "entered_in_error")[] };
/** Visits whose orders are billed: placed and not revoked or declined. */
export const BILLED_ORDER_STATES = ["active", "centre_chosen", "accepted", "partially_accepted", "in_progress", "partially_complete", "complete"] as const;
/** the pharmacist writes pharmacy and OTC bills only — invoiceHere hides every other kind from them (ADR 0009) */
const WRITE_ROLES = ["cashier", "owner", "admin", "pharmacist"];

const stale = () => err(409, "stale", "অন্য কোথাও আগেই বদলানো হয়েছে — আবার খুলুন", "This bill was changed somewhere else first — reopen it");
const notDraft = () => err(409, "not_draft", "ইস্যু করা বিল বদলানো যায় না", "An issued bill cannot be changed");
const discountFirst = () => err(409, "discount_present", "আগে ছাড়টি সরান", "Remove the discount first", { field: "discount" });
const approvalPending = () => err(409, "approval_pending", "ছাড় অনুমোদনের অপেক্ষায় — সিদ্ধান্তের আগে বিল বদলানো যায় না", "A discount is waiting for approval — the bill cannot change until it is decided");
export const readOnlyRole = () => err(403, "forbidden", "আপনি বিল দেখতে পারেন, বদলাতে পারেন না", "You can view this bill but not change it", { reason: "role", canRequest: false });

type Inv = NonNullable<Awaited<ReturnType<Tx["invoice"]["findFirst"]>>>;
type Line = NonNullable<Awaited<ReturnType<Tx["chargeItem"]["findFirst"]>>>;
type Pay = NonNullable<Awaited<ReturnType<Tx["payment"]["findFirst"]>>>;
type TaskRow = NonNullable<Awaited<ReturnType<Tx["task"]["findFirst"]>>>;
interface DiscountDetail { amountPaisa: number; category: DiscountCategory; reason: string; subtotalPaisa: number; limitPaisa: number; invoiceRev: number }
interface NotBilledDetail { lineId: string; reason: string; invoiceRev: number }
interface ReconcileDetail { providerRef: string | null; trxId: string | null; amountPaisa: number | null; paymentAmountPaisa: number; invoiceId: string; resolution?: { action: "applied" | "resolved" | "refunded" | "matched"; note: string | null; by: string; at: string; refundId?: string | null } }

/** A wallet payment's own gateway (the one that made its link); 503 when this API no longer runs it. */
export function providerOf(p: { provider: string | null; method: string }): PaymentProvider {
  const pr = p.provider ? providerByName(p.provider) : isWallet(p.method as PaymentMethod) ? providerFor(p.method as "bkash" | "nagad") : null;
  if (!pr) throw err(503, "gateway_off", "এই পেমেন্টের গেটওয়ে এখন চালু নেই", "This payment's gateway is not running on this server");
  return pr;
}
const linkCode = () => Array.from(randomBytes(LINK_CODE_LENGTH), (b) => LINK_CODE_ALPHABET[b % LINK_CODE_ALPHABET.length]).join("");
const PENDING_DB = ["initiated", "link_sent", "waiting_customer"];

/** What the bill asks to be paid: its total less returned medicine credited off it (decision 221). */
/** What the bill's confirmed money is measured against: the total less credits — plus, on an issued IPD bill, the excess
    deposit its deposit-excess refund carries (ADR 0018: net paid = paid − excess). */
export const dueBase = (inv: { totalPaisa: number; creditedPaisa: number; excessPaisa?: number }) => inv.totalPaisa - inv.creditedPaisa + (inv.excessPaisa ?? 0);

/** A line's source as the contracts spell it (the database enum's bed_day is "bed-day", ADR 0017). */
export const wireSource = (x: string) => x.replace(/_/g, "-") as ChargeSourceWire;
export function requireWriter(s: SessionData) { if (!WRITE_ROLES.includes(s.role)) throw readOnlyRole(); }

async function people(tx: Tx, ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const rows = list.length ? await tx.user.findMany({ where: { id: { in: list } }, select: { id: true, nameBn: true, nameEn: true } }) : [];
  const m = new Map(rows.map((r) => [r.id, r]));
  return (id: string) => m.get(id) ?? { id, nameBn: "—", nameEn: "—" };
}
async function orgOf(tx: Tx, s: SessionData) {
  const o = await tx.organization.findFirst({ where: { id: s.organizationId } });
  if (!o) throw notFound();
  return o;
}
const settingsOf = (o: Awaited<ReturnType<typeof orgOf>>): BillingSettings =>
  ({ cashierLimitPaisa: o.cashierDiscountLimitPaisa, cashierLimitBp: o.cashierDiscountLimitBp, approverLimitPaisa: o.approverLimitPaisa });
const toRow = (p: Pay): PaymentRow => ({ id: p.id, method: p.method as PaymentMethod, amountPaisa: p.amountPaisa, status: dash<PaymentState>(p.status), trxId: p.trxId, reference: p.reference });

/** A bill at the session's facility and branch, locked for this transaction (two counters never interleave). `ipd`: the
    route also serves the IPD running bill's deposits (their wallet links, receipts, reconciliation) — never the OPD bill's
    edit, issue, void or discount routes (review, ADR 0017). */
export async function invoiceHere(tx: Tx, s: SessionData, id: string, lock = false, opts: { ipd?: boolean } = {}): Promise<Inv> {
  if (lock) await tx.$queryRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${id} FOR UPDATE`;
  const branch = await branchOf(tx, s);
  const inv = await tx.invoice.findFirst({ where: { id, organizationId: s.organizationId, branchId: branch.id } });
  const kinds: string[] = billKindsFor(s.role as Role, s.plan as Plan);
  if (opts.ipd && authorize(s.role as Role, s.plan as Plan, "bill", "ipd").allowed) kinds.push("ipd");
  if (!inv || !kinds.includes(inv.kind)) throw notFound();
  return inv;
}
/** Any approval still requested on the bill (discount or "Not billed here"): lines are locked and Issue is refused. */
const requestedTask = (tx: Tx, invoiceId: string) => tx.task.findFirst({ where: { kind: { in: APPROVAL_KINDS }, focusId: invoiceId, status: "requested" } });
/** An open reconciliation case on any payment of this bill: the owner is checking money for it (money review: no void,
    no Cancel link, and the screens warn "do not take money again" until it is decided). */
async function openReconciliation(tx: Tx, invoiceId: string): Promise<boolean> {
  const pays = (await tx.payment.findMany({ where: { invoiceId }, select: { id: true } })).map((p) => p.id);
  return pays.length > 0 && Boolean(await tx.task.findFirst({ where: { kind: RECONCILE_TASK, status: "requested", focusId: { in: pays } }, select: { id: true } }));
}
/** The visit's placed orders that belong on the bill, against the bill's order lines (ADR 0005, decision 99 prep). */
async function ordersDiff(tx: Tx, inv: Inv) {
  // Only the visit's OPD bill carries order lines (ADR 0009); a pharmacy or OTC bill never changes with the orders.
  if (inv.kind !== "opd" || !inv.encounterId) return { orders: [], remove: [] as string[], add: [] as string[] };
  const [orders, lines] = await Promise.all([
    tx.serviceRequest.findMany({ where: { encounterId: inv.encounterId, status: { in: [...BILLED_ORDER_STATES] } }, orderBy: { createdAt: "asc" } }),
    tx.chargeItem.findMany({ where: { invoiceId: inv.id, source: "order" } }),
  ]);
  return { orders, ...syncOrderLines(lines.map((l) => ({ id: l.id, sourceId: l.sourceId })), orders.map((o) => o.id)) };
}

/* ───── views ───── */
export async function invoiceView(tx: Tx, s: SessionData, inv: Inv): Promise<InvoiceView> {
  const [lines, pays, e, org, tasks, lineTasks, chain] = await Promise.all([
    tx.chargeItem.findMany({ where: { invoiceId: inv.id }, orderBy: { position: "asc" } }),
    tx.payment.findMany({ where: { invoiceId: inv.id }, orderBy: { createdAt: "asc" } }),
    inv.encounterId ? encounterHere(tx, s, inv.encounterId) : Promise.resolve(null),
    orgOf(tx, s),
    tx.task.findMany({ where: { kind: DISCOUNT_TASK, focusId: inv.id }, orderBy: { requestedAt: "desc" }, take: 1 }),
    tx.task.findMany({ where: { kind: BILL_ELSEWHERE_TASK, focusId: inv.id }, orderBy: { requestedAt: "desc" } }),
    tx.invoice.findMany({ where: { id: { in: [inv.replacesId, inv.replacedById].filter((x): x is string => Boolean(x)) } }, select: { id: true, number: true } }),
  ]);
  const task = tasks[0] ?? null;
  // ADR 0013: what refunds (paid) and returns (recorded) took back of each line
  const backRows = await tx.refundLine.groupBy({ by: ["chargeItemId"], where: { chargeItemId: { in: lines.map((l) => l.id) }, refund: { status: "paid" } }, _sum: { units: true, totalPaisa: true } });
  const back = new Map(backRows.map((b) => [b.chargeItemId, { units: b._sum.units ?? 0, totalPaisa: b._sum.totalPaisa ?? 0 }]));
  const batches = await tx.stockBatch.findMany({ where: { id: { in: lines.flatMap((l) => (l.batchId ? [l.batchId] : [])) } }, select: { id: true, batchNo: true, expiry: true } });
  const batchById = new Map(batches.map((b) => [b.id, b]));
  // ADR 0010: a draft keeps its prices; a line whose price-list item changed since says so (and what it costs now)
  const defs = inv.status === "draft" ? await tx.chargeItemDefinition.findMany({ where: { id: { in: lines.flatMap((l) => (l.definitionId ? [l.definitionId] : [])) } }, select: { id: true, unitPaisa: true, vatRateBp: true } }) : [];
  const defNow = new Map(defs.map((d) => [d.id, d]));
  const changed = (l: { definitionId: string | null; unitPaisa: number | null; vatRateBp: number }) => {
    const d = l.definitionId ? defNow.get(l.definitionId) : undefined;
    return d && l.unitPaisa !== null && (d.unitPaisa !== l.unitPaisa || d.vatRateBp !== l.vatRateBp) ? d : null;
  };
  const who = await people(tx, [inv.discountAppliedById, inv.issuedById, inv.voidedById, e?.practitionerId, task?.requestedById, task?.decidedById, ...pays.map((p) => p.createdById), ...lineTasks.flatMap((t) => [t.requestedById, t.decidedById])]);
  const lineTaskById = new Map(lineTasks.map((t) => [t.id, t]));
  // Changed orders are worked out for issued bills too (money review: a test added after issue must not go unseen).
  const od = inv.status !== "entered_in_error" && inv.status !== "cancelled" ? await ordersDiff(tx, inv) : null;
  const ordersChanged = Boolean(od && od.remove.length + od.add.length > 0);
  const reconciling = await openReconciliation(tx, inv.id);
  const ref = (id: string | null) => (id ? chain.find((c) => c.id === id) ?? { id, number: null } : null);
  const rows = pays.map(toRow);
  const discountTask = inv.discountTaskId ? (task?.id === inv.discountTaskId ? task : await tx.task.findFirst({ where: { id: inv.discountTaskId } })) : null;
  return {
    invoice: {
      id: inv.id, status: dash<InvoiceState>(inv.status), number: inv.number, rev: inv.rev,
      kind: inv.kind, buyer: inv.kind === "otc" ? { name: inv.buyerName, phone: inv.buyerPhone } : null,
      subtotalPaisa: inv.subtotalPaisa, discountPaisa: inv.discountPaisa, netPaisa: inv.netPaisa, vatPaisa: inv.vatPaisa, totalPaisa: inv.totalPaisa, paidPaisa: inv.paidPaisa,
      refundedPaisa: inv.refundedPaisa, creditedPaisa: inv.creditedPaisa,
      discount: inv.discountPaisa > 0 && inv.discountCategory && inv.discountReason && inv.discountAppliedById && inv.discountAppliedAt
        ? { category: inv.discountCategory as DiscountCategory, reason: inv.discountReason, appliedBy: who(inv.discountAppliedById), appliedAt: inv.discountAppliedAt.toISOString(),
            approvedBy: discountTask?.decidedById ? (await people(tx, [discountTask.decidedById]))(discountTask.decidedById) : null }
        : null,
      createdAt: inv.createdAt.toISOString(), issuedAt: iso(inv.issuedAt), issuedBy: inv.issuedById ? who(inv.issuedById) : null,
      void: inv.status === "entered_in_error" && inv.voidReason && inv.voidedAt && inv.voidedById ? { reason: inv.voidReason, at: inv.voidedAt.toISOString(), by: who(inv.voidedById) } : null,
      replaces: ref(inv.replacesId), replacedBy: ref(inv.replacedById),
    },
    encounter: e ? { ...toVitalsEncounter(e), practitioner: e.practitionerId ? who(e.practitionerId) : null } : null,
    lines: lines.map((l) => ({
      id: l.id, position: l.position, source: wireSource(l.source), sourceId: l.sourceId, code: l.code, nameEn: l.nameEn, nameBn: l.nameBn, unitPaisa: l.unitPaisa,
      qty: l.qty, vatRateBp: l.vatRateBp, grossPaisa: l.grossPaisa, discountPaisa: l.discountPaisa, netPaisa: l.netPaisa, vatPaisa: l.vatPaisa, totalPaisa: l.totalPaisa,
      editable: inv.status === "draft" && l.source === "desk",
      notBilled: l.notBilledTaskId && l.notBilledReason && l.notBilledAt
        ? { reason: l.notBilledReason, at: l.notBilledAt.toISOString(), approvedBy: (() => { const t = lineTaskById.get(l.notBilledTaskId!); return t?.decidedById ? who(t.decidedById) : null; })() }
        : null,
      batch: l.batchId ? batchById.get(l.batchId) ?? null : null,
      back: back.get(l.id) ?? null,
      currentUnitPaisa: changed(l)?.unitPaisa ?? null, currentVatRateBp: changed(l)?.vatRateBp ?? null,
    })),
    approval: task ? toApprovalView(task, who) : null,
    discountLimitPaisa: discountLimit(inv.subtotalPaisa, settingsOf(org)),
    issueBlockers: inv.status === "draft" ? issueBlockers({
      lineCount: lines.length, unpricedCount: lines.filter((l) => l.unitPaisa === null && !l.notBilledTaskId).length,
      pendingApproval: task?.status === "requested" || lineTasks.some((t) => t.status === "requested"), ordersChanged,
    }) : [],
    lineApprovals: lineTasks.map((t) => {
      const d = t.detail as unknown as NotBilledDetail;
      return { taskId: t.id, lineId: d.lineId, status: t.status, reason: d.reason, requestedBy: who(t.requestedById), requestedAt: t.requestedAt.toISOString(),
        decidedBy: t.decidedById ? who(t.decidedById) : null, decidedAt: iso(t.decidedAt), decisionNote: t.decisionNote };
    }),
    ordersChanged,
    reconciling,
    refund: await (async () => {
      // ADR 0013: the refund open on this bill, and whether one can be asked for now
      const rs = await tx.refund.findMany({ where: { invoiceId: inv.id }, select: { id: true, status: true, source: true }, orderBy: { requestedAt: "desc" } });
      const open = rs.find((r) => r.status === "requested" || r.status === "approved") ?? null;
      const refundable = ["issued", "partially_paid", "balanced"].includes(inv.status) && inv.paidPaisa - inv.refundedPaisa > 0;
      return { openId: open?.id ?? null, openStatus: (open?.status ?? null) as "requested" | "approved" | null, canRequest: refundable && !open, count: rs.length };
    })(),
    payments: await (async () => {
      // ADR 0012: the latest link SMS per payment
      const sms = pays.length ? await tx.communication.findMany({ where: { paymentId: { in: pays.map((p) => p.id) }, kind: "payment-link" }, orderBy: { createdAt: "asc" } }) : [];
      const last = new Map(sms.map((c) => [c.paymentId!, c] as const));
      const phone = inv.patientId ? (await tx.patient.findFirst({ where: { id: inv.patientId }, select: { phone: true } }))?.phone ?? null : null;
      return pays.map((p) => toPaymentView(p, who, last.get(p.id) ?? null, !!smsPhone(phone)));
    })(),
    summary: paymentSummary(dueBase(inv), rows),
    paidBy: paidBy(rows),
    seller: { nameEn: org.name, nameBn: org.nameBn, vatBin: org.vatBin, vatBinSample: org.vatBinSample },
  };
}
function toApprovalView(t: TaskRow, who: (id: string) => { id: string; nameBn: string; nameEn: string }) {
  const d = t.detail as unknown as DiscountDetail & NotBilledDetail;
  const discount = t.kind === DISCOUNT_TASK;
  return {
    taskId: t.id, status: t.status, amountPaisa: discount ? d.amountPaisa : 0, category: discount ? d.category : null, reason: d.reason,
    subtotalPaisa: discount ? d.subtotalPaisa : 0, limitPaisa: discount ? d.limitPaisa : 0,
    requestedBy: who(t.requestedById), requestedAt: t.requestedAt.toISOString(),
    decidedBy: t.decidedById ? who(t.decidedById) : null, decidedAt: iso(t.decidedAt), decisionNote: t.decisionNote,
  };
}
type Comm = NonNullable<Awaited<ReturnType<Tx["communication"]["findFirst"]>>>;
function toPaymentView(p: Pay, who: (id: string) => { id: string; nameBn: string; nameEn: string }, sms: Comm | null = null, patientMobile = false): PaymentView {
  return {
    id: p.id, method: p.method as PaymentMethod, status: dash<PaymentState>(p.status), amountPaisa: p.amountPaisa, tenderedPaisa: p.tenderedPaisa, changePaisa: p.changePaisa,
    reference: p.reference, trxId: p.trxId, phoneLast4: p.phone ? p.phone.slice(-4) : null, linkExpiresAt: iso(p.linkExpiresAt), attempt: p.attempt, failReason: p.failReason,
    createdBy: who(p.createdById), createdAt: p.createdAt.toISOString(), confirmedAt: iso(p.confirmedAt),
    payUrl: p.linkCode && PENDING_DB.includes(p.status) ? `${config.publicAppUrl}/p/${p.linkCode}` : null,
    gateway: p.provider ? providerByName(p.provider)?.flow ?? null : null,
    executing: !!p.executeClaimedAt && PENDING_DB.includes(p.status),
    linkSms: sms ? { status: dash(sms.status), deliveryConfirmed: sms.deliveryConfirmed, lastError: sms.lastError, toLast4: sms.toPhone ? sms.toPhone.slice(-4) : null, at: (sms.completedAt ?? sms.statusAt).toISOString() } : null,
    canSms: patientMobile && !!p.linkCode && PENDING_DB.includes(p.status) && !p.executeClaimedAt,
  };
}

/* ───── worklist and price list ───── */
export async function billingWorklist(tx: Tx, s: SessionData, now: Date): Promise<BillingWorklist> {
  const branch = await branchOf(tx, s);
  const rows = await tx.encounter.findMany({ where: { organizationId: s.organizationId, branchId: branch.id, tokenDay: dhakaDay(now), class: { not: "ipd" }, status: "finished" }, include: { patient: true }, orderBy: { tokenNo: "asc" } });
  const invs = await tx.invoice.findMany({ where: { encounterId: { in: rows.map((r) => r.id) }, kind: "opd", status: OPEN_BILL } });
  const pending = new Set((await tx.task.findMany({ where: { kind: { in: APPROVAL_KINDS }, status: "requested", focusId: { in: invs.map((i) => i.id) } }, select: { focusId: true } })).map((t) => t.focusId));
  const byEnc = new Map(invs.map((i) => [i.encounterId, i]));
  const who = await people(tx, rows.map((r) => r.practitionerId));
  // Newest visit first; settled bills go to the end.
  const settled = (id: string) => ["balanced", "cancelled"].includes(byEnc.get(id)?.status ?? "");
  rows.sort((a, b) => Number(settled(a.id)) - Number(settled(b.id)) || b.tokenNo - a.tokenNo);
  return {
    items: rows.map((e) => {
      const i = byEnc.get(e.id);
      return {
        encounter: { ...toVitalsEncounter(e as Parameters<typeof toVitalsEncounter>[0]), practitioner: e.practitionerId ? who(e.practitionerId) : null },
        invoice: i ? { id: i.id, status: dash<InvoiceState>(i.status), number: i.number, totalPaisa: i.totalPaisa, paidPaisa: i.paidPaisa, approvalPending: pending.has(i.id) } : null,
      };
    }),
  };
}

export async function chargeDefinitions(tx: Tx, s: SessionData, q: string): Promise<ChargeDefinitionList> {
  const t = q.trim().toLowerCase();
  // Desk items are services only: a test reaches the bill through the doctor's order, never typed in at the desk (review
  // A6–A7: a second CBC, or a test the lab never receives an order for).
  const rows = await tx.chargeItemDefinition.findMany({ where: { organizationId: s.organizationId, active: true, kind: "service" }, orderBy: { nameEn: "asc" } });
  return { items: rows.filter((r) => !t || `${r.nameEn} ${r.nameBn} ${r.code}`.toLowerCase().includes(t)).slice(0, 20)
    .map((r) => ({ code: r.code, kind: r.kind, nameEn: r.nameEn, nameBn: r.nameBn, unitPaisa: r.unitPaisa, vatRateBp: r.vatRateBp, sample: r.sample })) };
}

/* ───── draft bill ───── */
/** Re-run the line maths (domain billTotals) for the stored lines and discount, and store the result. Unpriced lines
    count as 0 here; they block issuing. */
export async function recompute(tx: Tx, inv: Inv, discountPaisa: number, patch: Partial<Inv> = {}): Promise<Inv> {
  const lines = await tx.chargeItem.findMany({ where: { invoiceId: inv.id }, orderBy: { position: "asc" } });
  const t = billTotals(lines.map((l) => ({ key: l.id, unitPaisa: l.unitPaisa ?? 0, qty: l.qty, vatRateBp: l.vatRateBp })), discountPaisa);
  for (const l of t.lines) {
    await tx.chargeItem.update({ where: { id: l.key }, data: { grossPaisa: l.grossPaisa, discountPaisa: l.discountPaisa, netPaisa: l.netPaisa, vatPaisa: l.vatPaisa, totalPaisa: l.totalPaisa } });
  }
  const n = await tx.invoice.updateMany({
    where: { id: inv.id, rev: inv.rev, status: "draft" },
    data: { ...patch, subtotalPaisa: t.subtotalPaisa, discountPaisa: t.discountPaisa, netPaisa: t.netPaisa, vatPaisa: t.vatPaisa, totalPaisa: t.totalPaisa, rev: inv.rev + 1 },
  });
  if (n.count !== 1) throw stale();
  return (await tx.invoice.findFirst({ where: { id: inv.id } }))!;
}

/** The visit's bill: created as a draft from the finished visit (consultation fee + active orders), or the existing one. */
export async function createInvoice(tx: Tx, s: SessionData, encounterId: string, now: Date): Promise<{ inv: Inv; created: boolean; patientId: string; sync?: OrderSync }> {
  requireWriter(s);
  const e = await encounterHere(tx, s, encounterId);
  // ADR 0014: an inpatient's bill is the IPD running bill the admission opened, never an OPD bill
  if (e.class === "ipd") throw err(409, "inpatient_bill", "ভর্তি রোগীর বিল আইপিডি বিলে", "An inpatient is billed on the IPD bill", { field: "encounter" });
  const existing = await tx.invoice.findFirst({ where: { encounterId: e.id, kind: "opd", status: OPEN_BILL } });
  if (existing) { const r = await refreshIfPossible(tx, s, existing); return { inv: r.inv, created: false, patientId: e.patientId, sync: r.sync }; }
  if (e.status !== "finished") throw err(409, "visit_not_finished", "ডাক্তার নোটে স্বাক্ষর করার পর বিল হবে", "The bill is made after the doctor signs the note", { field: "encounter" });
  const defs = await tx.chargeItemDefinition.findMany({ where: { organizationId: s.organizationId, active: true } });
  const byCode = new Map(defs.map((d) => [d.code, d]));
  const orders = await tx.serviceRequest.findMany({ where: { encounterId: e.id, status: { in: [...BILLED_ORDER_STATES] } }, orderBy: { createdAt: "asc" } });
  const doctor = e.practitionerId ? await tx.user.findFirst({ where: { id: e.practitionerId }, select: { nameBn: true, nameEn: true } }) : null;
  const consult = e.practitionerId ? byCode.get(`consult:${e.practitionerId}`) : undefined;
  const lines = [
    { source: "consultation" as const, sourceId: e.id, definitionId: consult?.id ?? null, code: consult?.code ?? "consult",
      nameEn: consult?.nameEn ?? `Consultation · ${doctor?.nameEn ?? "—"}`, nameBn: consult?.nameBn ?? `পরামর্শ ফি · ${doctor?.nameBn ?? "—"}`,
      unitPaisa: consult?.unitPaisa ?? null, vatRateBp: consult?.vatRateBp ?? 0 },
    ...orders.map((o) => {
      const d = byCode.get(`test:${o.testCode}`);
      return { source: "order" as const, sourceId: o.id, definitionId: d?.id ?? null, code: d?.code ?? `test:${o.testCode}`, nameEn: d?.nameEn ?? o.nameEn, nameBn: d?.nameBn ?? o.nameBn, unitPaisa: d?.unitPaisa ?? null, vatRateBp: d?.vatRateBp ?? 0 };
    }),
  ];
  const t = billTotals(lines.map((l, i) => ({ key: String(i), unitPaisa: l.unitPaisa ?? 0, qty: 1, vatRateBp: l.vatRateBp })), 0);
  // ADR 0005: a bill made after a void records which bill it replaces.
  const replaced = await tx.invoice.findFirst({ where: { encounterId: e.id, kind: "opd", status: "entered_in_error", replacedById: null }, orderBy: { voidedAt: "desc" } });
  const inv = await tx.invoice.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, branchId: e.branchId, patientId: e.patientId, encounterId: e.id, createdById: s.userId, statusAt: now, replacesId: replaced?.id ?? null,
    subtotalPaisa: t.subtotalPaisa, discountPaisa: 0, netPaisa: t.netPaisa, vatPaisa: t.vatPaisa, totalPaisa: t.totalPaisa,
  } });
  for (const [i, l] of lines.entries()) {
    const c = t.lines[i]!;
    await tx.chargeItem.create({ data: { tenantId: s.tenantId, invoiceId: inv.id, position: i + 1, addedById: s.userId, qty: 1, ...l,
      grossPaisa: c.grossPaisa, discountPaisa: 0, netPaisa: c.netPaisa, vatPaisa: c.vatPaisa, totalPaisa: c.totalPaisa } });
  }
  return { inv, created: true, patientId: e.patientId };
}

/** Bring a draft's order lines in line with the visit's placed orders — only when nothing on the bill depends on the
    current lines (no discount applied, no approval requested); otherwise the view says ordersChanged and Issue waits. */
export interface OrderSync { removed: string[]; added: string[] }
const NO_SYNC: OrderSync = { removed: [], added: [] };
/** ADR 0010: a draft made before the doctor had a fee on the price list takes the fee once it exists (the line had no
    price — so "drafts keep their price" is not touched); nothing changes while a discount or an approval holds the lines. */
async function priceUnpricedConsultation(tx: Tx, s: SessionData, inv: Inv): Promise<boolean> {
  if (inv.kind !== "opd" || !inv.encounterId || inv.discountPaisa > 0 || (await requestedTask(tx, inv.id))) return false;
  const line = await tx.chargeItem.findFirst({ where: { invoiceId: inv.id, source: "consultation", unitPaisa: null, notBilledTaskId: null } });
  if (!line) return false;
  const e = await tx.encounter.findFirst({ where: { id: inv.encounterId }, select: { practitionerId: true } });
  const def = e?.practitionerId ? await tx.chargeItemDefinition.findFirst({ where: { organizationId: s.organizationId, kind: "consultation", refCode: e.practitionerId, active: true } }) : null;
  if (!def) return false;
  await tx.chargeItem.update({ where: { id: line.id }, data: { definitionId: def.id, code: def.code, nameEn: def.nameEn, nameBn: def.nameBn, unitPaisa: def.unitPaisa, vatRateBp: def.vatRateBp, ...lineAmounts(def.unitPaisa, line.qty, def.vatRateBp) } });
  return true;
}
async function syncDraft(tx: Tx, s: SessionData, inv0: Inv): Promise<{ inv: Inv; sync: OrderSync }> {
  const inv = (await priceUnpricedConsultation(tx, s, inv0)) ? await recompute(tx, inv0, 0) : inv0;
  const d = await ordersDiff(tx, inv);
  if (!d.remove.length && !d.add.length) return { inv, sync: NO_SYNC };
  if (inv.discountPaisa > 0 || (await requestedTask(tx, inv.id))) return { inv, sync: NO_SYNC };
  const gone = await tx.chargeItem.findMany({ where: { id: { in: d.remove } }, select: { code: true } });
  const sync = { removed: gone.map((g) => g.code), added: d.orders.filter((o) => d.add.includes(o.id)).map((o) => `test:${o.testCode}`) };
  if (d.remove.length) await tx.chargeItem.deleteMany({ where: { id: { in: d.remove }, invoiceId: inv.id } });
  const defs = await tx.chargeItemDefinition.findMany({ where: { organizationId: s.organizationId, active: true, kind: "test" } });
  const byCode = new Map(defs.map((x) => [x.code, x]));
  const last = await tx.chargeItem.findFirst({ where: { invoiceId: inv.id }, orderBy: { position: "desc" }, select: { position: true } });
  let pos = last?.position ?? 0;
  for (const o of d.orders.filter((x) => d.add.includes(x.id))) {
    const def = byCode.get(`test:${o.testCode}`);
    await tx.chargeItem.create({ data: {
      tenantId: s.tenantId, invoiceId: inv.id, position: ++pos, addedById: s.userId, source: "order", sourceId: o.id, definitionId: def?.id ?? null, code: def?.code ?? `test:${o.testCode}`,
      nameEn: def?.nameEn ?? o.nameEn, nameBn: def?.nameBn ?? o.nameBn, unitPaisa: def?.unitPaisa ?? null, vatRateBp: def?.vatRateBp ?? 0,
      ...(def ? lineAmounts(def.unitPaisa, 1, def.vatRateBp) : { qty: 1 }),
    } });
  }
  return { inv: await recompute(tx, inv, 0), sync };
}
async function refreshIfPossible(tx: Tx, s: SessionData, inv: Inv): Promise<{ inv: Inv; sync: OrderSync }> {
  if (inv.status !== "draft" || !WRITE_ROLES.includes(s.role)) return { inv, sync: NO_SYNC };
  await tx.$queryRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${inv.id} FOR UPDATE`;
  return syncDraft(tx, s, (await tx.invoice.findFirst({ where: { id: inv.id } }))!);
}
/** POST /v1/invoices/:id/refresh-orders — the screen calls it when the view says the orders changed. */
export async function refreshOrders(tx: Tx, s: SessionData, id: string, rev: number): Promise<{ inv: Inv; changed: boolean; sync: OrderSync }> {
  const inv = await editableDraft(tx, s, id, rev);
  if (inv.discountPaisa > 0) throw discountFirst();
  const r = await syncDraft(tx, s, inv);
  return { inv: r.inv, changed: r.inv.rev !== inv.rev, sync: r.sync };
}

/** Decision 99 (lab slice): an ORDER revoke refreshes the visit's open bill in the same transaction. A draft drops the
    revoked line at once unless a discount or an approval holds the lines (then it waits and Issue stays blocked, as on
    open); an issued bill is left as it is and flags the change (open question 109). Runs as the person who revoked —
    a doctor or the lab — so it does not check the cashier role; it only ever brings lines in line with placed orders. */
export async function refreshDraftOrders(tx: Tx, s: SessionData, encounterId: string): Promise<{ invoiceId: string; removed: string[]; added: string[]; waits: boolean } | null> {
  const inv0 = await tx.invoice.findFirst({ where: { encounterId, kind: "opd", organizationId: s.organizationId, status: OPEN_BILL }, orderBy: { createdAt: "desc" } });
  if (!inv0) return null;
  if (inv0.status !== "draft") return { invoiceId: inv0.id, removed: [], added: [], waits: true };
  await tx.$queryRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${inv0.id} FOR UPDATE`;
  const r = await syncDraft(tx, s, (await tx.invoice.findFirst({ where: { id: inv0.id } }))!);
  const d = await ordersDiff(tx, r.inv);
  return { invoiceId: inv0.id, removed: r.sync.removed, added: r.sync.added, waits: d.remove.length + d.add.length > 0 };
}

export async function editableDraft(tx: Tx, s: SessionData, id: string, rev: number): Promise<Inv> {
  requireWriter(s);
  const inv = await invoiceHere(tx, s, id, true);
  if (inv.status !== "draft") throw notDraft();
  if (inv.rev !== rev) throw stale();
  if (await requestedTask(tx, inv.id)) throw approvalPending();
  return inv;
}

/** A desk line's amounts before any discount (lines change only while there is none), from the domain line maths. */
export function lineAmounts(unitPaisa: number, qty: number, vatRateBp: number) {
  const l = billTotals([{ key: "line", unitPaisa, qty, vatRateBp }], 0).lines[0]!;
  return { qty, grossPaisa: l.grossPaisa, discountPaisa: 0, netPaisa: l.netPaisa, vatPaisa: l.vatPaisa, totalPaisa: l.totalPaisa };
}

export async function addDeskLine(tx: Tx, s: SessionData, id: string, code: string, qty: number, rev: number): Promise<Inv> {
  const inv = await editableDraft(tx, s, id, rev);
  if (inv.discountPaisa > 0) throw discountFirst();
  const d = await tx.chargeItemDefinition.findFirst({ where: { organizationId: s.organizationId, code, active: true, kind: "service" } });
  if (!d) throw err(404, "no_such_item", "তালিকায় এই সেবা নেই", "This item is not on the price list", { field: "code" });
  // more of the same item joins its line only at the same price; after a price change it is a new line at the new price
  const same = await tx.chargeItem.findFirst({ where: { invoiceId: inv.id, source: "desk", code, unitPaisa: d.unitPaisa, vatRateBp: d.vatRateBp } });
  if (same) {
    if (same.qty + qty > 999) throw err(400, "qty_too_large", "পরিমাণ অনেক বেশি", "Quantity is too large", { field: "qty" });
    await tx.chargeItem.update({ where: { id: same.id }, data: lineAmounts(same.unitPaisa!, same.qty + qty, same.vatRateBp) });
  } else {
    const last = await tx.chargeItem.findFirst({ where: { invoiceId: inv.id }, orderBy: { position: "desc" }, select: { position: true } });
    await tx.chargeItem.create({ data: { tenantId: s.tenantId, invoiceId: inv.id, position: (last?.position ?? 0) + 1, source: "desk", sourceId: null, definitionId: d.id, code: d.code,
      nameEn: d.nameEn, nameBn: d.nameBn, unitPaisa: d.unitPaisa, vatRateBp: d.vatRateBp, addedById: s.userId, ...lineAmounts(d.unitPaisa, qty, d.vatRateBp) } });
  }
  return recompute(tx, inv, 0);
}

async function deskLine(tx: Tx, inv: Inv, lineId: string): Promise<Line> {
  const l = await tx.chargeItem.findFirst({ where: { id: lineId, invoiceId: inv.id } });
  if (!l) throw notFound();
  if (l.source !== "desk") throw err(409, "line_locked", "পরামর্শ ও ডাক্তারের অর্ডার বিল থেকে সরানো যায় না", "The consultation and the doctor's orders stay on the bill", { field: "line" });
  return l;
}
export async function setLineQty(tx: Tx, s: SessionData, id: string, lineId: string, qty: number, rev: number): Promise<Inv> {
  const inv = await editableDraft(tx, s, id, rev);
  if (inv.discountPaisa > 0) throw discountFirst();
  const l = await deskLine(tx, inv, lineId);
  await tx.chargeItem.update({ where: { id: l.id }, data: lineAmounts(l.unitPaisa!, qty, l.vatRateBp) });
  return recompute(tx, inv, 0);
}
export async function removeLine(tx: Tx, s: SessionData, id: string, lineId: string, rev: number): Promise<{ inv: Inv; line: Line }> {
  const inv = await editableDraft(tx, s, id, rev);
  if (inv.discountPaisa > 0) throw discountFirst();
  const line = await deskLine(tx, inv, lineId);
  await tx.chargeItem.delete({ where: { id: line.id } });
  return { inv: await recompute(tx, inv, 0), line };
}

/* ───── discount and approval ───── */
export async function requestDiscount(tx: Tx, s: SessionData, id: string, req: DiscountRequest, now: Date): Promise<{ inv: Inv; outcome: "applied" | "approval-requested"; taskId: string | null; amountPaisa: number }> {
  const inv = await editableDraft(tx, s, id, req.rev);
  // Over-the-counter sales take no discount for now (open question — pharmacy session 1).
  if (inv.kind === "otc") throw err(409, "no_discount_otc", "কাউন্টার বিক্রিতে ছাড় দেওয়া যায় না", "An over-the-counter sale takes no discount");
  if (inv.discountPaisa > 0) throw discountFirst();
  let amountPaisa: number;
  try { amountPaisa = discountToPaisa(req.mode === "amount" ? { mode: "amount", paisa: req.amountPaisa! } : { mode: "percent", bp: req.percentBp! }, inv.subtotalPaisa); }
  catch { throw err(400, "discount_invalid", "ছাড়ের পরিমাণ ঠিক নেই", "The discount amount is not valid", { field: "amountPaisa" }); }
  const settings = settingsOf(await orgOf(tx, s));
  const d = discountDecision({ subtotalPaisa: inv.subtotalPaisa, discountPaisa: amountPaisa, category: req.category, reason: req.reason, settings });
  if (!d.ok) {
    const msg: Record<typeof d.code, [string, string]> = {
      discount_not_positive: ["ছাড়ের পরিমাণ লিখুন", "Enter a discount amount"],
      discount_above_subtotal: ["ছাড় বিলের চেয়ে বেশি হতে পারে না", "A discount cannot be more than the bill"],
      reason_too_short: ["কারণ লিখুন (অন্তত ১০ অক্ষর)", "A reason is required (at least 10 characters)"],
      category_required: ["ছাড়ের ধরন বেছে নিন", "Choose a discount category"],
    };
    throw err(400, d.code, msg[d.code][0], msg[d.code][1], { field: d.code === "reason_too_short" ? "reason" : d.code === "category_required" ? "category" : "amountPaisa" });
  }
  if (d.kind === "within-limit") {
    const next = await recompute(tx, inv, amountPaisa, { discountCategory: req.category, discountReason: req.reason.trim(), discountAppliedById: s.userId, discountAppliedAt: now, discountTaskId: null });
    return { inv: next, outcome: "applied", taskId: null, amountPaisa };
  }
  // Above the limit: an APPROVAL Task, requested. Nothing is applied; the bill (and its rev) stay as they are.
  const detail: DiscountDetail = { amountPaisa, category: req.category, reason: req.reason.trim(), subtotalPaisa: inv.subtotalPaisa, limitPaisa: d.limitPaisa, invoiceRev: inv.rev };
  const task = await tx.task.create({ data: { tenantId: s.tenantId, kind: DISCOUNT_TASK, status: "requested", focusId: inv.id, reason: req.reason.trim(), detail: detail as object, requestedById: s.userId, requestedAt: now } });
  return { inv, outcome: "approval-requested", taskId: task.id, amountPaisa };
}

/** decision 98: ask to leave an unpriced order line out of this bill ("Not billed here") — an APPROVAL Task, nothing
    excluded until the owner or an admin approves; the order stays active. */
export async function requestNotBilled(tx: Tx, s: SessionData, id: string, lineId: string, reason: string, rev: number, now: Date): Promise<{ inv: Inv; taskId: string; line: Line }> {
  const inv = await editableDraft(tx, s, id, rev);
  const line = await tx.chargeItem.findFirst({ where: { id: lineId, invoiceId: inv.id } });
  if (!line) throw notFound();
  const b = notBilledBlockers({ line: { source: line.source === "order" || line.source === "consultation" ? line.source : "desk", unitPaisa: line.unitPaisa, notBilled: Boolean(line.notBilledTaskId) }, reason, invoiceStatus: "draft", requested: false });
  if (b.length) {
    const msg: Record<string, [string, string]> = {
      not_an_order_line: ["শুধু ডাক্তারের অর্ডারের লাইনে চাওয়া যায়", "Only a line from the doctor's order can be left out"],
      line_has_price: ["এই সেবার মূল্য আছে — বিলে থাকবে", "This line has a price — it stays on the bill"],
      already_not_billed: ["এই লাইন আগেই বাদ দেওয়া হয়েছে", "This line is already not billed here"],
      reason_too_short: ["কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write a reason (at least 10 characters)"],
    };
    const [bn, en] = msg[b[0]!] ?? ["অনুরোধ করা যায় না", "Cannot be requested"];
    throw err(b[0] === "reason_too_short" ? 400 : 409, b[0]!, bn, en, { field: b[0] === "reason_too_short" ? "reason" : "line" });
  }
  const detail: NotBilledDetail = { lineId: line.id, reason: reason.trim(), invoiceRev: inv.rev };
  const task = await tx.task.create({ data: { tenantId: s.tenantId, kind: BILL_ELSEWHERE_TASK, status: "requested", focusId: inv.id, candidateId: line.id, reason: reason.trim(), detail: detail as object, requestedById: s.userId, requestedAt: now } });
  return { inv, taskId: task.id, line };
}

export async function removeDiscount(tx: Tx, s: SessionData, id: string, rev: number): Promise<Inv> {
  const inv = await editableDraft(tx, s, id, rev);
  if (inv.discountPaisa === 0) throw err(409, "no_discount", "এই বিলে ছাড় নেই", "This bill has no discount");
  return recompute(tx, inv, 0, { discountCategory: null, discountReason: null, discountAppliedById: null, discountAppliedAt: null, discountTaskId: null });
}

/** `hereIds`: the facility's bill ids, read once by the list (a per-item read crossed the 5 s transaction limit on a
    clinic with thousands of bills — seen in the refunds slice's e2e run). */
async function approvalItem(tx: Tx, s: SessionData, t: TaskRow, now: Date): Promise<ApprovalItem | null> {
  const inv = t.focusId ? await tx.invoice.findFirst({ where: { id: t.focusId, organizationId: s.organizationId } }) : null;
  if (!inv?.patientId) return null;
  const p = await tx.patient.findFirst({ where: { id: inv.patientId } });
  if (!p) return null;
  const day = dhakaDay(now);
  // the requester's discounts today at this facility — a join, never a list of every bill the facility has (it grows)
  const mine = await tx.$queryRaw<{ detail: unknown }[]>`
    SELECT t."detail" FROM "Task" t JOIN "Invoice" i ON i."id" = t."focusId"
    WHERE i."organizationId" = ${s.organizationId} AND t."kind" = ${DISCOUNT_TASK} AND t."requestedById" = ${t.requestedById} AND t."requestedAt" >= ${new Date(`${day}T00:00:00+06:00`)}`;
  const who = await people(tx, [t.requestedById, t.decidedById]);
  const lineId = t.kind === BILL_ELSEWHERE_TASK ? (t.detail as unknown as NotBilledDetail).lineId : null;
  const line = lineId ? await tx.chargeItem.findFirst({ where: { id: lineId }, select: { id: true, nameEn: true, nameBn: true } }) : null;
  return {
    ...toApprovalView(t, who),
    kind: t.kind === BILL_ELSEWHERE_TASK ? "bill-elsewhere" : "discount-approval",
    line,
    refund: null,
    invoice: { id: inv.id, status: dash<InvoiceState>(inv.status), number: inv.number, subtotalPaisa: inv.subtotalPaisa, totalPaisa: inv.totalPaisa, kind: inv.kind, encounterId: inv.encounterId },
    patient: toVitalsEncounter({ id: "", token: "", tokenDay: "", status: "finished", patient: p } as unknown as Parameters<typeof toVitalsEncounter>[0]).patient,
    buyer: null,
    requesterToday: { count: mine.length, totalPaisa: mine.reduce((a, m) => a + ((m.detail as unknown as DiscountDetail)?.amountPaisa ?? 0), 0) },
  };
}

export async function approvalList(tx: Tx, s: SessionData, status: "requested" | "approved" | "rejected", now: Date): Promise<ApprovalList> {
  // Only this facility's bills (security review A6–A7: other facilities' tasks must not crowd the list out).
  // a join on this facility's bills (reading every bill id the facility ever had made the list slow as bills grew)
  const rows = status === "requested"
    ? await tx.$queryRaw<{ id: string }[]>`SELECT t."id" FROM "Task" t JOIN "Invoice" i ON i."id" = t."focusId"
        WHERE i."organizationId" = ${s.organizationId} AND t."kind" = ANY(${APPROVAL_KINDS}::text[]) AND t."status"::text = ${status} ORDER BY t."requestedAt" ASC LIMIT 100`
    : await tx.$queryRaw<{ id: string }[]>`SELECT t."id" FROM "Task" t JOIN "Invoice" i ON i."id" = t."focusId"
        WHERE i."organizationId" = ${s.organizationId} AND t."kind" = ANY(${APPROVAL_KINDS}::text[]) AND t."status"::text = ${status} ORDER BY t."requestedAt" DESC LIMIT 100`;
  const ids = rows.map((r) => r.id);
  const tasks = await tx.task.findMany({ where: { id: { in: ids } }, orderBy: { requestedAt: status === "requested" ? "asc" : "desc" } });
  const items: ApprovalItem[] = [];
  for (const t of tasks) { const i = await approvalItem(tx, s, t, now); if (i) items.push(i); }
  return { items };
}

/** Approve or reject a discount request. Approving re-checks the approver rules and that the bill is still the draft
    the request was made on, then applies the discount; rejecting needs a note and applies nothing. */
export async function decideApproval(tx: Tx, s: SessionData, taskId: string, decision: "approve" | "reject", note: string | undefined, now: Date): Promise<{ task: TaskRow; inv: Inv; item: ApprovalItem }> {
  const t0 = await tx.task.findFirst({ where: { id: taskId, kind: { in: APPROVAL_KINDS } } });
  if (!t0 || !t0.focusId) throw notFound();
  const inv = await invoiceHere(tx, s, t0.focusId, true);
  const t = (await tx.task.findFirst({ where: { id: taskId } }))!; // re-read after the bill's lock: one decision wins
  const d = t.detail as unknown as DiscountDetail;
  const nb = t.detail as unknown as NotBilledDetail;
  const elsewhere = t.kind === BILL_ELSEWHERE_TASK;
  const next = transition("APPROVAL", APPROVAL, t.status, decision);
  if (decision === "approve") {
    const blockers = approvalBlockers({ approverId: s.userId, approverRole: s.role, requestedById: t.requestedById, amountPaisa: elsewhere ? 0 : d.amountPaisa, settings: settingsOf(await orgOf(tx, s)) });
    if (blockers.includes("not_an_approver")) throw err(403, "forbidden", "শুধু মালিক বা অ্যাডমিন অনুমোদন দিতে পারেন", "Only the owner or an admin can approve", { reason: "role", canRequest: false });
    if (blockers.includes("own_request")) throw err(403, "own_request", "নিজের অনুরোধ নিজে অনুমোদন করা যায় না", "You cannot approve your own request", { reason: "own-request", canRequest: false });
    if (blockers.includes("above_approver_limit")) throw err(422, "above_approver_limit", "আপনার অনুমোদন সীমার বেশি", "Above your approval limit");
    if (elsewhere) {
      const l = await tx.chargeItem.findFirst({ where: { id: nb.lineId, invoiceId: inv.id } });
      if (inv.status !== "draft" || !l || l.unitPaisa !== null || l.notBilledTaskId) throw err(409, "bill_changed", "অনুরোধের পর বিল বদলেছে — আবার অনুরোধ করতে হবে", "The bill changed after the request — it must be requested again");
    } else if (inv.status !== "draft" || inv.rev !== d.invoiceRev || inv.subtotalPaisa !== d.subtotalPaisa || inv.discountPaisa !== 0) throw err(409, "bill_changed", "অনুরোধের পর বিল বদলেছে — আবার অনুরোধ করতে হবে", "The bill changed after the request — it must be requested again");
  } else if ((note ?? "").trim().length < 10) {
    throw err(400, "note_required", "প্রত্যাখ্যানের কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write why it is rejected (at least 10 characters)", { field: "note" });
  }
  const upd = await tx.task.updateMany({ where: { id: t.id, status: "requested" }, data: { status: next, decidedById: s.userId, decidedAt: now, decisionNote: note?.trim() || null } });
  if (upd.count !== 1) throw stale();
  let nextInv = inv;
  if (decision === "approve" && elsewhere) {
    await tx.chargeItem.update({ where: { id: nb.lineId }, data: { notBilledReason: nb.reason, notBilledTaskId: t.id, notBilledAt: now } });
    nextInv = await recompute(tx, inv, inv.discountPaisa);
  } else if (decision === "approve") {
    nextInv = await recompute(tx, inv, d.amountPaisa, { discountCategory: d.category, discountReason: d.reason, discountAppliedById: t.requestedById, discountAppliedAt: now, discountTaskId: t.id });
  }
  const task = (await tx.task.findFirst({ where: { id: t.id } }))!;
  return { task, inv: nextInv, item: (await approvalItem(tx, s, task, now))! };
}

/* ───── issue ───── */
/** INV/yy/nnnn from the facility's one series — OPD, pharmacy and the IPD final bill alike (ADR 0018, decision 4; the
    accountant's question on separate series is open). */
export async function nextInvoiceNumber(tx: Tx, s: SessionData, now: Date): Promise<string> {
  const yy = dhakaDay(now).slice(2, 4);
  const name = `invoice:${s.organizationId}:${yy}`;
  const seq = await tx.sequence.upsert({ where: { tenantId_name: { tenantId: s.tenantId, name } }, create: { tenantId: s.tenantId, name, value: 1 }, update: { value: { increment: 1 } } });
  return `INV/${yy}/${String(seq.value).padStart(4, "0")}`;
}
/** `sale`: called by the OTC issue after the stock moves (an OTC bill is never issued from the billing route). */
export async function issueInvoice(tx: Tx, s: SessionData, id: string, rev: number, now: Date, sale = false): Promise<Inv> {
  requireWriter(s);
  const inv = await invoiceHere(tx, s, id, true);
  if (inv.status !== "draft") throw notDraft();
  if (inv.kind === "otc" && !sale) throw err(409, "issue_as_sale", "কাউন্টার বিক্রি ফার্মেসি থেকে সম্পন্ন করুন", "Complete an over-the-counter sale from the pharmacy");
  if (inv.rev !== rev) throw stale();
  const lines = await tx.chargeItem.findMany({ where: { invoiceId: inv.id }, select: { unitPaisa: true, notBilledTaskId: true } });
  const od = await ordersDiff(tx, inv);
  const blockers = issueBlockers({ lineCount: lines.length, unpricedCount: lines.filter((l) => l.unitPaisa === null && !l.notBilledTaskId).length, pendingApproval: Boolean(await requestedTask(tx, inv.id)), ordersChanged: od.remove.length + od.add.length > 0 });
  if (blockers.length) throw err(422, "issue_blocked", "বিল ইস্যু করা যাচ্ছে না", "The bill cannot be issued yet", { blockers: blockers.map((code) => ({ code })) });
  const fresh = await recompute(tx, inv, inv.discountPaisa);
  const status = undash<"issued">(transition("INVOICE", INVOICE, "draft", "issue"));
  const number = await nextInvoiceNumber(tx, s, now);
  const n = await tx.invoice.updateMany({ where: { id: inv.id, rev: fresh.rev, status: "draft" }, data: { status, number, issuedAt: now, issuedById: s.userId, statusAt: now } });
  if (n.count !== 1) throw stale();
  // ADR 0005: the voided bill this one replaces now shows "Replaced by INV/…".
  // Every voided bill of this visit still without a replacement now shows this one (money review: A voided, its
  // replacement B voided too, then C — A must not lose its "Replaced by").
  // only an OPD bill replaces a voided one (a later pharmacy bill holds other medicine, not a re-issue — clinical review)
  if (inv.encounterId && inv.kind === "opd") await tx.invoice.updateMany({ where: { encounterId: inv.encounterId, kind: "opd", status: "entered_in_error", replacedById: null, id: { not: inv.id } }, data: { replacedById: inv.id } });
  return (await tx.invoice.findFirst({ where: { id: inv.id } }))!;
}

/* ───── void (ADR 0005: INVOICE markError) ───── */
export async function voidInvoice(tx: Tx, s: SessionData, id: string, reason: string, now: Date): Promise<Inv> {
  const inv = await invoiceHere(tx, s, id, true);
  /* Medicine off the shelf is never voided off its bill (clinical review) — ADR 0013: until every unit of it came back
     through a paid refund (a dispense line always; a sale line once the sale was issued). */
  const med = await tx.chargeItem.findMany({ where: { invoiceId: inv.id, OR: [{ source: "dispense" }, ...(inv.status !== "draft" ? [{ source: "sale" as const }] : [])] }, select: { id: true, qty: true } });
  const back = med.length ? await tx.refundLine.groupBy({ by: ["chargeItemId"], where: { chargeItemId: { in: med.map((m) => m.id) }, refund: { status: "paid" } }, _sum: { units: true } }) : [];
  const unreturnedMedicine = med.filter((m) => m.qty > (back.find((b) => b.chargeItemId === m.id)?._sum.units ?? 0)).length;
  const openRefunds = await tx.refund.count({ where: { invoiceId: inv.id, status: { in: ["requested", "approved"] } } });
  const pays = await tx.payment.findMany({ where: { invoiceId: inv.id } });
  const b = voidBlockers({ role: s.role, status: dash<InvoiceState>(inv.status), confirmedPaisa: inv.paidPaisa, refundedPaisa: inv.refundedPaisa, openRefunds, unreturnedMedicine,
    pendingPayments: pays.filter((p) => ["initiated", "link_sent", "waiting_customer"].includes(p.status)).length,
    pendingApprovals: (await requestedTask(tx, inv.id)) ? 1 : 0, reason });
  if (!b.length && (await openReconciliation(tx, inv.id)))
    throw err(409, "reconciliation_open", "মালিক এই বিলের একটি পেমেন্ট মিলিয়ে দেখছেন — আগে সেটি সমাধান করুন", "The owner is checking a payment on this bill — resolve the reconciliation first");
  if (b.length) {
    const msg: Record<string, [number, string, string]> = {
      not_an_approver: [403, "শুধু মালিক বা অ্যাডমিন বিল বাতিল করতে পারেন", "Only the owner or an admin can void a bill"],
      has_confirmed_money: [409, "এই বিলে নিশ্চিত টাকা আছে — আগে সব টাকা ফেরত দিন, তারপর বাতিল", "Confirmed money is on this bill — refund all of it first, then void"],
      refund_open: [409, "এই বিলে একটি রিফান্ড খোলা আছে — আগে সেটির সিদ্ধান্ত হোক", "A refund is open on this bill — it must be decided first"],
      medicine_given: [409, "এই বিলের ওষুধ দেওয়া হয়ে গেছে — সব ওষুধ ফেরত না আসা পর্যন্ত বাতিল করা যায় না", "The medicine on this bill has been given — it cannot be voided until all of it is returned"],
      not_voidable: [409, "এই বিল বাতিল করা যায় না", "This bill cannot be voided"],
      link_pending: [409, "পেমেন্ট লিংক অপেক্ষমাণ — আগে লিংক বাতিল করুন", "A payment link is pending — cancel the link first"],
      approval_pending: [409, "এই বিলে অনুমোদন অপেক্ষমাণ — আগে সিদ্ধান্ত দিন", "An approval is waiting on this bill — decide it first"],
      reason_too_short: [400, "কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write a reason (at least 10 characters)"],
    };
    const [status, bn, en] = msg[b[0]!]!;
    throw err(status, b[0]!, bn, en, status === 403 ? { reason: "role", canRequest: false } : { field: "reason" });
  }
  const status = undash<"entered_in_error">(transition("INVOICE", INVOICE, dash<InvoiceState>(inv.status), "markError"));
  await tx.invoice.update({ where: { id: inv.id }, data: { status, voidReason: reason.trim(), voidedById: s.userId, voidedAt: now, statusAt: now } });
  return (await tx.invoice.findFirst({ where: { id: inv.id } }))!;
}

/* ───── payment reconciliation (decisions 89, 101; owner) ───── */
const whyCodeOf = (r: string | null): ReconcileItem["whyCode"] =>
  !r ? "other" : r.startsWith("money reported on a bill that takes no payments") ? "not-payable" : r.startsWith("money reported") ? "late-money" : r.startsWith("amount reported") ? "amount-mismatch" : r.startsWith("a second payment") ? "second-payment" : r.startsWith("TrxID paid on an earlier") ? "earlier-link" : "other";
async function reconcileItem(tx: Tx, s: SessionData, t: TaskRow): Promise<ReconcileItem | null> {
  const d = t.detail as unknown as ReconcileDetail;
  const p = t.focusId ? await tx.payment.findFirst({ where: { id: t.focusId, organizationId: s.organizationId } }) : null;
  if (!p) return null;
  const inv = await tx.invoice.findFirst({ where: { id: p.invoiceId } });
  const pt = inv?.patientId ? await tx.patient.findFirst({ where: { id: inv.patientId } }) : null;
  if (!inv) return null;
  /* The list checks what it can without the gateway (same bill, still pending, same amount); the gateway itself is asked
     only when the owner presses Apply (security review: no gateway call per row inside the read). */
  const applyBlockers = t.status !== "requested" ? [] : reconcileApplyBlockers({
    task: { providerRef: d.providerRef ?? "", trxId: d.trxId, amountPaisa: d.amountPaisa, invoiceId: d.invoiceId },
    payment: { status: dash<PaymentState>(p.status), amountPaisa: p.amountPaisa, invoiceId: p.invoiceId, providerRef: p.providerRef, supersededRefs: p.supersededRefs },
    provider: { status: "confirmed", trxId: d.trxId ?? "pending-check", amountPaisa: d.amountPaisa ?? p.amountPaisa, providerRef: d.providerRef ?? "" },
  });
  const who = await people(tx, [d.resolution?.by]);
  return {
    taskId: t.id, status: t.status, why: t.reason ?? "", createdAt: t.requestedAt.toISOString(), whyCode: whyCodeOf(t.reason),
    reported: { providerRef: d.providerRef, trxId: d.trxId, amountPaisa: d.amountPaisa },
    payment: { id: p.id, method: p.method as PaymentMethod, status: dash<PaymentState>(p.status), amountPaisa: p.amountPaisa, trxId: p.trxId, attempt: p.attempt },
    invoice: { id: inv.id, number: inv.number, status: dash<InvoiceState>(inv.status), totalPaisa: inv.totalPaisa, paidPaisa: inv.paidPaisa },
    patient: pt ? toVitalsEncounter({ id: "", token: "", tokenDay: "", status: "finished", patient: pt } as unknown as Parameters<typeof toVitalsEncounter>[0]).patient : null,
    buyer: inv.kind === "otc" ? { name: inv.buyerName, phone: inv.buyerPhone } : null,
    kind: "payment",
    refund: null,
    // only while that refund is still open: a rejected or withdrawn refund hands the case back to the owner
    pendingRefundId: await (async () => { const id = (t.detail as { pendingRefundId?: string }).pendingRefundId; return id && (await tx.refund.findFirst({ where: { id, status: { in: ["requested", "approved"] } }, select: { id: true } })) ? id : null; })(),
    applyBlockers,
    resolution: d.resolution ? { action: d.resolution.action, note: d.resolution.note, by: who(d.resolution.by), at: d.resolution.at, refundId: d.resolution.refundId ?? null } : null,
  };
}
export async function reconcileList(tx: Tx, s: SessionData, status: "requested" | "approved" | "rejected"): Promise<ReconcileList> {
  const branch = await branchOf(tx, s);
  const here = (await tx.invoice.findMany({ where: { organizationId: s.organizationId, branchId: branch.id }, select: { id: true } })).map((i) => i.id);
  const pays = (await tx.payment.findMany({ where: { invoiceId: { in: here } }, select: { id: true } })).map((p) => p.id);
  const tasks = await tx.task.findMany({ where: { kind: RECONCILE_TASK, status, focusId: { in: pays } }, orderBy: { requestedAt: status === "requested" ? "asc" : "desc" }, take: 100 });
  const items: ReconcileItem[] = [];
  for (const t of tasks) { const i = await reconcileItem(tx, s, t); if (i) items.push(i); }
  return { items };
}
/** Apply = the provider, asked again now, confirms the same amount and TrxID for a pending payment of this bill; the
    payment is confirmed with that TrxID and any newer link is cancelled. Resolve = a note, nothing applied. Owner only
    (decision 89; the route checks bill/reconcile). Never a silent apply. */
export async function decideReconcile(tx: Tx, s: SessionData, taskId: string, action: "apply" | "resolve", note: string | undefined, now: Date): Promise<{ item: ReconcileItem; patientId: string | null; invoiceId: string }> {
  const t0 = await tx.task.findFirst({ where: { id: taskId, kind: RECONCILE_TASK } });
  const p0 = t0?.focusId ? await tx.payment.findFirst({ where: { id: t0.focusId, organizationId: s.organizationId } }) : null;
  if (!t0 || !p0) throw notFound();
  const inv = await invoiceHere(tx, s, p0.invoiceId, true, { ipd: true });
  const t = (await tx.task.findFirst({ where: { id: taskId } }))!;
  const p = (await tx.payment.findFirst({ where: { id: p0.id } }))!;
  const d = t.detail as unknown as ReconcileDetail;
  // ADR 0013 review: a case whose refund to the patient is under way is decided by that refund
  const pending = (t.detail as { pendingRefundId?: string }).pendingRefundId;
  if (pending && (await tx.refund.findFirst({ where: { id: pending, status: { in: ["requested", "approved"] } }, select: { id: true } })))
    throw err(409, "refund_pending", "এই কেসের রিফান্ড চলছে — সেটির সিদ্ধান্ত আগে হোক", "A refund for this case is under way — it decides the case");
  const next = transition("APPROVAL", APPROVAL, t.status, action === "apply" ? "approve" : "reject");
  if (action === "resolve" && (note ?? "").trim().length < 10) throw err(400, "note_required", "নোট লিখুন (অন্তত ১০ অক্ষর)", "Write a note (at least 10 characters)", { field: "note" });
  if (action === "apply") {
    const provider = providerOf(p);
    const live = d.providerRef ? await provider.verify({ providerRef: d.providerRef }) : null;
    const b = reconcileApplyBlockers({
      task: { providerRef: d.providerRef ?? "", trxId: d.trxId, amountPaisa: d.amountPaisa, invoiceId: d.invoiceId },
      payment: { status: dash<PaymentState>(p.status), amountPaisa: p.amountPaisa, invoiceId: p.invoiceId, providerRef: p.providerRef, supersededRefs: p.supersededRefs },
      provider: live,
    });
    if (b.length) throw err(422, "cannot_apply", "এই টাকা এই বিলে মেলানো যায় না — নোটসহ সমাধান করুন", "This money does not match a pending payment on this bill — resolve it with a note", { blockers: b.map((code) => ({ code })) });
    await confirmPayment(tx, p, inv, s.userId, live!.trxId, now);
    if (p.providerRef && p.providerRef !== d.providerRef) await provider.cancel(p.providerRef);
  }
  const resolution = { action: action === "apply" ? "applied" as const : "resolved" as const, note: note?.trim() || null, by: s.userId, at: now.toISOString() };
  const upd = await tx.task.updateMany({ where: { id: t.id, status: "requested" }, data: { status: next, decidedById: s.userId, decidedAt: now, decisionNote: note?.trim() || null, detail: { ...d, resolution } as object } });
  if (upd.count !== 1) throw stale();
  return { item: (await reconcileItem(tx, s, (await tx.task.findFirst({ where: { id: t.id } }))!))!, patientId: inv.patientId, invoiceId: inv.id };
}

/* ───── payments ───── */
/** A bill that takes money: issued or partly paid — or (ADR 0017, IPD only) the running IPD bill's draft, for deposits. */
export const takesPayment = (inv: { status: string; kind: string }) => inv.status === "issued" || inv.status === "partially_paid" || (inv.kind === "ipd" && inv.status === "draft");
/** PAYMENT `confirm`, then the bill's confirmed money and INVOICE payPart / payAll. The database checks that the bill's
    paid amount is the sum of its confirmed payments. */
async function confirmPayment(tx: Tx, p: Pay, inv: Inv, by: string | null, trxId: string | null, now: Date) {
  const status = undash<"confirmed">(transition("PAYMENT", PAYMENT, dash<PaymentState>(p.status), "confirm"));
  const n = await tx.payment.updateMany({ where: { id: p.id, status: p.status }, data: { status, confirmedAt: now, confirmedById: by, trxId: trxId ?? p.trxId, statusAt: now } });
  if (n.count !== 1) throw stale();
  const rows = (await tx.payment.findMany({ where: { invoiceId: inv.id } })).map(toRow);
  const s = paymentSummary(dueBase(inv), rows);
  // ADR 0017: a deposit on the running IPD bill adds to its confirmed money; the bill stays a draft until B10 issues it
  if (inv.kind === "ipd" && inv.status === "draft") { await tx.invoice.update({ where: { id: inv.id }, data: { paidPaisa: s.confirmedPaisa, statusAt: now } }); return; }
  const event = invoiceEventAfterConfirm(dueBase(inv), s.confirmedPaisa);
  const next = undash<"balanced">(transition("INVOICE", INVOICE, dash<InvoiceState>(inv.status), event));
  await tx.invoice.update({ where: { id: inv.id }, data: { paidPaisa: s.confirmedPaisa, status: next, statusAt: now } });
  // ADR 0018: the IPD final bill balanced — the discharge's payment step may finish (an excess refund paid, too)
  if (inv.kind === "ipd" && next === "balanced") await (await import("./discharge.js")).moneySettled(tx, { tenantId: inv.tenantId, organizationId: inv.organizationId }, inv.id, by, now);
}

/** ADR 0017: confirm a cash / card / bank deposit on the running IPD bill (the bill stays a draft). */
export async function confirmIpdDeposit(tx: Tx, paymentId: string, by: string, now: Date) {
  const p = (await tx.payment.findFirst({ where: { id: paymentId } }))!;
  const inv = (await tx.invoice.findFirst({ where: { id: p.invoiceId } }))!;
  if (inv.kind !== "ipd") throw new Error("confirmIpdDeposit: not an IPD bill");
  await confirmPayment(tx, p, inv, by, null, now);
}

/** Review (decision 221): while a return without refund is open on the bill, no money is taken — the due it leaves is not
    known until it is decided (and a return needs a bill on which nothing was ever paid). */
async function refuseWhileReturnOpen(tx: Tx, invoiceId: string) {
  if (await tx.refund.findFirst({ where: { invoiceId, kind: "return", status: { in: ["requested", "approved"] } }, select: { id: true } }))
    throw err(409, "return_open", "এই বিলে একটি ফেরত (টাকা ছাড়া) খোলা আছে — আগে সেটির সিদ্ধান্ত হোক", "A return without refund is open on this bill — decide it first");
}

/** ADR 0011 (open question 90): the wallet link is made after the payment row committed. `attachLink` runs outside any
    transaction: it asks the gateway, then stores the link in its own transaction — or, if the gateway failed, fails the
    payment so its amount is free again. A payment cancelled meanwhile keeps no link (and the new link is cancelled). */
export async function attachLink(tenantId: string, paymentId: string, now: Date, by: string | null = null): Promise<"link-sent" | "gateway-error" | "gone"> {
  const { forTenant } = await import("@setu/db");
  const p0 = await forTenant(tenantId, async (tx) => {
    const p = await tx.payment.findFirst({ where: { id: paymentId } });
    if (!p || p.status !== "initiated" || p.providerRef) return null;
    const inv = await tx.invoice.findFirst({ where: { id: p.invoiceId }, select: { number: true } });
    return { p, number: inv?.number ?? "" };
  });
  if (!p0) return "gone";
  const { p } = p0;
  const provider = providerOf(p);
  let link: Awaited<ReturnType<PaymentProvider["createLink"]>> | null = null, why = "";
  try { link = await provider.createLink({ method: p.method as "bkash" | "nagad", amountPaisa: p.amountPaisa, reference: p.id, invoiceNumber: p0.number, phone: p.phone!, attempt: p.attempt }); }
  catch (e) { if (!(e instanceof GatewayError)) throw e; why = e.message; }
  const out = await forTenant(tenantId, async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${p.invoiceId} FOR UPDATE`;
    const cur = await tx.payment.findFirst({ where: { id: p.id } });
    if (!cur || cur.status !== "initiated" || cur.attempt !== p.attempt || cur.providerRef) return "gone" as const;
    if (!link) {
      await tx.payment.updateMany({ where: { id: p.id, status: "initiated", attempt: p.attempt }, data: { status: "failed", failReason: "gateway-error", statusAt: now } });
      await tx.auditEvent.create({ data: { tenantId, organizationId: cur.organizationId, userId: null, role: null, action: "provider-event", entity: "Payment", entityId: p.id, patientId: cur.patientId, detail: { actor: `provider:${provider.name}`, kind: "create-link", outcome: "gateway-error", error: why.slice(0, 200) } } });
      return "gateway-error" as const;
    }
    const status = undash<"link_sent">(transition("PAYMENT", PAYMENT, "initiated", "sendLink"));
    const code = linkCode();
    await tx.payment.update({ where: { id: p.id }, data: { status, providerRef: link.providerRef, linkUrl: link.url, linkExpiresAt: link.expiresAt, providerSignature: link.signature ?? null, linkCode: code, executeClaimedAt: null, statusAt: now } });
    // ADR 0012: the link goes to the patient by SMS too (queued here, sent after the commit by the route or the sweep)
    if (by) await queueLinkSms(tx, (await tx.payment.findFirst({ where: { id: p.id } }))!, by);
    return "link-sent" as const;
  });
  if (out === "gone" && link) await provider.cancel(link.providerRef).catch(() => undefined);
  return out;
}

export async function addPayment(tx: Tx, s: SessionData, invoiceId: string, req: NewPaymentRequest, now: Date, opts: { ipd?: boolean } = {}): Promise<{ inv: Inv; payment: Pay }> {
  requireWriter(s);
  const inv = await invoiceHere(tx, s, invoiceId, true, opts);
  // ADR 0018: an issued IPD final bill's shortfall is paid like any bill; its running draft takes deposits only
  if (inv.kind === "ipd" && inv.status === "draft") throw err(409, "ipd_deposit", "ভর্তি রোগীর টাকা আইপিডি বিলে জমা হিসেবে নিন", "Take an inpatient's money as a deposit on the IPD bill");
  if (inv.status !== "issued" && inv.status !== "partially_paid")
    throw err(409, "not_payable", inv.status === "draft" ? "আগে বিল ইস্যু করুন" : "এই বিলে আর টাকা নেওয়া যায় না", inv.status === "draft" ? "Issue the bill first" : "This bill takes no more payments");
  await refuseWhileReturnOpen(tx, inv.id);
  // ADR 0010: only the payment methods this facility takes
  const methods = (await tx.organization.findFirst({ where: { id: s.organizationId }, select: { paymentMethods: true } }))?.paymentMethods ?? [];
  if (!methods.includes(req.method)) throw err(422, "method_off", "এই প্রতিষ্ঠানে এই পেমেন্ট মাধ্যম চালু নেই", "This facility does not take this payment method", { field: "method" });
  const rows = (await tx.payment.findMany({ where: { invoiceId: inv.id } })).map(toRow);
  const check = checkNewPayment(paymentSummary(dueBase(inv), rows), { method: req.method, amountPaisa: req.amountPaisa, tenderedPaisa: req.tenderedPaisa, reference: req.reference });
  if (!check.ok) {
    const msg: Record<typeof check.code, [string, string, string]> = {
      amount_not_positive: ["টাকার পরিমাণ লিখুন", "Enter an amount", "amountPaisa"],
      amount_over_open: ["বকেয়ার চেয়ে বেশি (অপেক্ষমাণ পেমেন্টসহ)", "More than is still due (counting pending payments)", "amountPaisa"],
      tendered_short: ["দেওয়া টাকা পরিমাণের চেয়ে কম", "Tendered is less than the amount", "tenderedPaisa"],
      reference_required: ["রেফারেন্স লিখুন", "Enter the reference", "reference"],
    };
    const [bn, en, field] = msg[check.code];
    throw err(check.code === "amount_over_open" ? 409 : 400, check.code, bn, en, { field });
  }
  const wallet = isWallet(req.method);
  const gateway = wallet ? providerFor(req.method as "bkash" | "nagad") : null;
  if (wallet && !gateway) throw err(422, "method_unavailable", "এই পেমেন্ট মাধ্যম এখনো চালু করা হয়নি — নগদ বা কার্ডে নিন", "This payment method is not connected yet — take cash or card", { field: "method" });
  let phone: string | null = null;
  if (wallet) {
    // A walk-in OTC buyer has no patient record — the phone they gave at the counter.
    phone = inv.patientId ? (await tx.patient.findFirst({ where: { id: inv.patientId }, select: { phone: true } }))?.phone ?? null : inv.buyerPhone;
    if (!phone || !/^1[3-9]\d{8}$/.test(phone)) throw err(422, "no_phone", "রোগীর মোবাইল নম্বর নেই — নগদ বা কার্ডে নিন", "The patient has no mobile number — take cash or card", { field: "method" });
  }
  const created = await tx.payment.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, invoiceId: inv.id, patientId: inv.patientId, method: req.method, status: "initiated", amountPaisa: req.amountPaisa,
    tenderedPaisa: req.method === "cash" ? req.tenderedPaisa! : null, changePaisa: req.method === "cash" ? check.changePaisa : null,
    reference: req.method === "card" || req.method === "bank" ? req.reference!.trim() : null, provider: gateway?.name ?? null,
    phone: wallet ? phone : null, createdById: s.userId, createdAt: now, statusAt: now,
  } });
  // a wallet payment stays `initiated` here; the route makes its link after this transaction commits (attachLink)
  if (!wallet) await confirmPayment(tx, created, inv, s.userId, null, now);
  return { inv: (await tx.invoice.findFirst({ where: { id: inv.id } }))!, payment: (await tx.payment.findFirst({ where: { id: created.id } }))! };
}

async function walletPaymentHere(tx: Tx, s: SessionData, paymentId: string) {
  requireWriter(s);
  const p0 = await tx.payment.findFirst({ where: { id: paymentId, organizationId: s.organizationId } });
  if (!p0) throw notFound();
  const inv = await invoiceHere(tx, s, p0.invoiceId, true, { ipd: true });
  const p = (await tx.payment.findFirst({ where: { id: paymentId } }))!;
  if (!isWallet(p.method as PaymentMethod)) throw err(409, "not_wallet", "এটি ওয়ালেট পেমেন্ট নয়", "This is not a wallet payment");
  return { p, inv };
}

/** A failed wallet payment: cancel the old link, PAYMENT `retry` (attempt + 1, old reference kept as superseded), new link. */
export async function retryPayment(tx: Tx, s: SessionData, paymentId: string, now: Date): Promise<{ inv: Inv; payment: Pay }> {
  const { p, inv } = await walletPaymentHere(tx, s, paymentId);
  if (!takesPayment(inv)) throw err(409, "not_payable", "এই বিলে আর টাকা নেওয়া যায় না", "This bill takes no more payments");
  await refuseWhileReturnOpen(tx, inv.id);
  // a new link only for a method the facility still takes (controls review); checking or cancelling a pending one still works
  const methods = (await tx.organization.findFirst({ where: { id: s.organizationId }, select: { paymentMethods: true } }))?.paymentMethods ?? [];
  if (!methods.includes(p.method)) throw err(422, "method_off", "এই প্রতিষ্ঠানে এই পেমেন্ট মাধ্যম চালু নেই", "This facility does not take this payment method", { field: "method" });
  const status = undash<"initiated">(transition("PAYMENT", PAYMENT, dash<PaymentState>(p.status), "retry"));
  const others = (await tx.payment.findMany({ where: { invoiceId: inv.id, id: { not: p.id } } })).map(toRow);
  // a deposit on the running IPD bill has no "due" to stay under (review M4)
  if (!(inv.kind === "ipd" && inv.status === "draft") && p.amountPaisa > paymentSummary(dueBase(inv), others).openPaisa) throw err(409, "amount_over_open", "বকেয়ার চেয়ে বেশি (অপেক্ষমাণ পেমেন্টসহ)", "More than is still due (counting pending payments)", { field: "amountPaisa" });
  if (p.providerRef) await providerOf(p).cancel(p.providerRef);
  await tx.payment.update({ where: { id: p.id }, data: { status, attempt: p.attempt + 1, providerRef: null, linkUrl: null, linkExpiresAt: null, failReason: null,
    linkCode: null, providerSignature: null, executeClaimedAt: null, supersededLinkCodes: p.linkCode ? [...p.supersededLinkCodes, p.linkCode] : p.supersededLinkCodes,
    supersededRefs: p.providerRef ? [...p.supersededRefs, p.providerRef] : p.supersededRefs, statusAt: now } });
  // the new link is made after this transaction commits (attachLink)
  return { inv: (await tx.invoice.findFirst({ where: { id: inv.id } }))!, payment: (await tx.payment.findFirst({ where: { id: p.id } }))! };
}

/** The cashier typed the TrxID from the patient's phone: confirm only if the provider says that TrxID paid this link,
    in full. */
export async function verifyTrx(tx: Tx, s: SessionData, paymentId: string, trxId: string, now: Date): Promise<{ inv: Inv; payment: Pay; outcome: "confirmed" | "already" | "earlier-link" }> {
  const { p, inv } = await walletPaymentHere(tx, s, paymentId);
  if (p.status === "confirmed") return { inv, payment: p, outcome: "already" };
  // ADR 0011: ask about this payment's own links (current first) and compare the TrxID the gateway reports — a TrxID
  // search alone does not say which payment it paid (bKash).
  const provider = providerOf(p);
  let st: ProviderStatus | null = null;
  for (const ref of [p.providerRef, ...[...p.supersededRefs].reverse()].filter((r): r is string => !!r)) {
    const x = await provider.verify({ providerRef: ref });
    if (x?.trxId && x.trxId.toUpperCase() === trxId) { st = x; break; }
  }
  // Paid on a link that was replaced (review A6–A7): never applied here and never "does not match" either — the owner
  // reconciles it, and the cashier must not ask the patient to pay again.
  if (st && st.status === "confirmed" && p.supersededRefs.includes(st.providerRef)) {
    const open = await tx.task.findFirst({ where: { kind: RECONCILE_TASK, focusId: p.id, status: "requested" } });
    if (open && (open.detail as unknown as ReconcileDetail).providerRef === st.providerRef) return { inv, payment: p, outcome: "earlier-link" };
    await tx.task.create({ data: {
      tenantId: s.tenantId, kind: RECONCILE_TASK, status: "requested", focusId: p.id, reason: "TrxID paid on an earlier, replaced payment link", requestedById: s.userId, requestedAt: now,
      detail: { providerRef: st.providerRef, trxId: st.trxId, amountPaisa: st.amountPaisa, paymentAmountPaisa: p.amountPaisa, invoiceId: inv.id } as object,
    } });
    return { inv, payment: p, outcome: "earlier-link" };
  }
  // money review H2: the gateway completed this payment's own link after we had failed it — never lost, never applied
  // silently: the owner reconciles it (the cashier must not take the money again)
  if (st && st.status === "confirmed" && p.status === "failed" && st.providerRef === p.providerRef) {
    const open = await tx.task.findFirst({ where: { kind: RECONCILE_TASK, focusId: p.id, status: "requested" } });
    if (!open) await tx.task.create({ data: {
      tenantId: s.tenantId, kind: RECONCILE_TASK, status: "requested", focusId: p.id, reason: "TrxID paid on a payment marked failed", requestedById: s.userId, requestedAt: now,
      detail: { providerRef: st.providerRef, trxId: st.trxId, amountPaisa: st.amountPaisa, paymentAmountPaisa: p.amountPaisa, invoiceId: inv.id } as object,
    } });
    return { inv, payment: p, outcome: "earlier-link" };
  }
  if (!st || st.providerRef !== p.providerRef || st.status !== "confirmed" || st.amountPaisa !== p.amountPaisa || !st.trxId)
    throw err(422, "trx_not_matched", "এই TrxID এই পেমেন্টের সাথে মেলেনি", "This TrxID does not match this payment", { field: "trxId" });
  await confirmPayment(tx, p, inv, s.userId, st.trxId, now);
  return { inv: (await tx.invoice.findFirst({ where: { id: inv.id } }))!, payment: (await tx.payment.findFirst({ where: { id: p.id } }))!, outcome: "confirmed" };
}

/** The cashier gives up on a wallet link (patient never paid, link expired): ask the provider first — money that did
    arrive is confirmed, never thrown away; otherwise cancel the link and PAYMENT `fail`, which frees the amount for
    another method (review A6–A7: a link with no callback must not block the bill forever). */
export async function cancelPayment(tx: Tx, s: SessionData, paymentId: string, now: Date): Promise<{ inv: Inv; payment: Pay; outcome: "cancelled" | "confirmed" }> {
  const { p, inv } = await walletPaymentHere(tx, s, paymentId);
  if (await openReconciliation(tx, inv.id)) throw err(409, "reconciliation_open", "মালিক এই বিলের একটি পেমেন্ট মিলিয়ে দেখছেন — লিংক বাতিল করা যাবে না", "The owner is checking a payment on this bill — the link cannot be cancelled now");
  if (!["initiated", "link_sent", "waiting_customer"].includes(p.status)) throw err(409, "not_pending", "এই পেমেন্ট আর অপেক্ষমাণ নয়", "This payment is no longer pending");
  if (p.executeClaimedAt) throw err(409, "executing", "রোগী টাকা দিয়ে ফিরেছেন — পেমেন্ট সম্পন্ন হচ্ছে, একটু পরে আবার দেখুন", "The patient has paid and the payment is being completed — check again in a moment");
  const provider = providerOf(p);
  const st = p.providerRef ? await provider.verify({ providerRef: p.providerRef }) : null;
  if (st?.status === "confirmed" && st.trxId && st.amountPaisa === p.amountPaisa) {
    await confirmPayment(tx, p, inv, s.userId, st.trxId, now);
    return { inv: (await tx.invoice.findFirst({ where: { id: inv.id } }))!, payment: (await tx.payment.findFirst({ where: { id: p.id } }))!, outcome: "confirmed" };
  }
  if (st?.status === "confirmed") throw err(409, "paid_differently", "গেটওয়ে অন্য পরিমাণ জানাচ্ছে — মালিককে জানান", "The gateway reports a different amount — tell the owner");
  if (p.providerRef) await provider.cancel(p.providerRef);
  const status = undash<"failed">(transition("PAYMENT", PAYMENT, dash<PaymentState>(p.status), "fail"));
  await tx.payment.update({ where: { id: p.id }, data: { status, failReason: "cancelled-by-cashier", statusAt: now } });
  return { inv: (await tx.invoice.findFirst({ where: { id: inv.id } }))!, payment: (await tx.payment.findFirst({ where: { id: p.id } }))!, outcome: "cancelled" };
}

/* ───── provider callbacks (no session: forTenant with the tenant from payment_ref_lookup) ───── */
export interface CallbackResult { body: ProviderCallbackResponse; audit: AuditEntry[] }
export async function handleProviderEvent(tx: Tx, provider: PaymentProvider, tenantId: string, paymentId: string, supersededAtLookup: boolean, ev: ProviderWebhook, now: Date): Promise<CallbackResult> {
  let superseded = supersededAtLookup;
  const prior = await tx.providerEvent.findUnique({ where: { provider_eventId: { provider: provider.name, eventId: ev.eventId } } });
  if (prior) return { body: { outcome: "noop", reason: "repeat" }, audit: [] };
  const p0 = await tx.payment.findFirst({ where: { id: paymentId } });
  if (!p0) throw err(404, "unknown_reference", "অজানা রেফারেন্স", "Unknown reference");
  await tx.$queryRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${p0.invoiceId} FOR UPDATE`;
  const p = (await tx.payment.findFirst({ where: { id: paymentId } }))!;
  const inv = (await tx.invoice.findFirst({ where: { id: p.invoiceId } }))!;
  const record = (outcome: "applied" | "noop" | "refused", reason?: string) => tx.providerEvent.create({ data: {
    tenantId, provider: provider.name, eventId: ev.eventId, providerRef: ev.providerRef, kind: ev.kind, paymentId: p.id, outcome, reason: reason ?? null, trxId: ev.trxId, amountPaisa: ev.amountPaisa, receivedAt: now,
  } });
  const reconcile = (why: string) => tx.task.create({ data: {
    tenantId, kind: RECONCILE_TASK, status: "requested", focusId: p.id, reason: why, requestedById: `provider:${provider.name}`, requestedAt: now,
    detail: { providerRef: ev.providerRef, trxId: ev.trxId, amountPaisa: ev.amountPaisa, paymentAmountPaisa: p.amountPaisa, invoiceId: inv.id } as object,
  } });
  const audit = (outcome: string, reason?: string, extra: Record<string, unknown> = {}): AuditEntry[] =>
    [{ action: outcome === "applied" ? "update" : "provider-event", entity: "Payment", entityId: p.id, patientId: p.patientId, detail: { actor: `provider:${provider.name}`, kind: ev.kind, outcome, reason, eventId: ev.eventId, ...extra } }];

  // Decided again after the lock (security review A6–A7): a Retry may have replaced the link since the lookup.
  if (p.providerRef !== ev.providerRef) superseded = true;
  // Money already applied from this link (owner reconciliation) arriving again is a repeat, not new money.
  if (p.status === "confirmed" && ev.kind === "confirmed" && ev.trxId && p.trxId === ev.trxId) {
    await record("noop", "already-applied");
    return { body: { outcome: "noop", reason: "already-applied" }, audit: audit("noop", "already-applied") };
  }
  let decision = decideProviderEvent(dash<PaymentState>(p.status), ev.kind as ProviderEventKind);
  if (decision.outcome === "noop" && p.status === "confirmed" && ev.kind === "confirmed" && ev.trxId && p.trxId && ev.trxId !== p.trxId) {
    await reconcile("a second payment reported on a payment already confirmed");
    await record("refused", "second-payment");
    return { body: { outcome: "refused", reason: "second-payment" }, audit: audit("refused", "second-payment") };
  }
  if (superseded) decision = ev.kind === "confirmed" ? { outcome: "refused", reason: "late-confirm" } : { outcome: "refused", reason: "out-of-order" };
  if (decision.outcome !== "apply") {
    const reason = decision.outcome === "refused" ? decision.reason : "same-state";
    if (decision.outcome === "refused" && decision.reason === "late-confirm") await reconcile("money reported on a failed or superseded payment link");
    await record(decision.outcome, reason);
    return { body: { outcome: decision.outcome, reason }, audit: audit(decision.outcome, reason) };
  }
  if (decision.event === "confirm") {
    // Never trust the callback alone: ask the provider, and confirm only the full amount with a TrxID.
    const st = await provider.verify({ providerRef: ev.providerRef });
    if (!st || st.status !== "confirmed" || !st.trxId) { await record("refused", "unverified"); return { body: { outcome: "refused", reason: "unverified" }, audit: audit("refused", "unverified") }; }
    if (st.amountPaisa !== p.amountPaisa || (ev.amountPaisa !== null && ev.amountPaisa !== p.amountPaisa)) {
      await reconcile("amount reported by the provider differs from the payment");
      await record("refused", "amount-mismatch");
      return { body: { outcome: "refused", reason: "amount-mismatch" }, audit: audit("refused", "amount-mismatch") };
    }
    if (!takesPayment(inv)) {
      await reconcile("money reported on a bill that takes no payments");
      await record("refused", "bill-not-payable");
      return { body: { outcome: "refused", reason: "bill-not-payable" }, audit: audit("refused", "bill-not-payable") };
    }
    await confirmPayment(tx, p, inv, null, st.trxId, now);
  } else {
    const status = undash<"waiting_customer" | "failed">(decision.next);
    await tx.payment.update({ where: { id: p.id }, data: { status, statusAt: now, ...(decision.event === "fail" ? { failReason: "provider-reported" } : {}) } });
  }
  await record("applied");
  return { body: { outcome: "applied" }, audit: audit("applied", undefined, { to: decision.next }) };
}

/* ───── ADR 0011: execute gateways (bKash) — the patient's return, the short link, the sweep ───── */
type Outcome = import("@setu/contracts").PayResultOutcome;
export interface ReturnResult { outcome: Outcome; trxId: string | null; amountPaisa: number | null; facilityEn: string | null; facilityBn: string | null; code?: string | null }

async function facilityOf(tx: Tx, organizationId: string) {
  const o = await tx.organization.findFirst({ where: { id: organizationId }, select: { name: true, nameBn: true } });
  return { facilityEn: o?.name ?? null, facilityBn: o?.nameBn ?? null };
}
function audit(tx: Tx, tenantId: string, p: Pay, provider: PaymentProvider, detail: Record<string, unknown>, ip: string | null, action = "provider-event") {
  return tx.auditEvent.create({ data: { tenantId, organizationId: p.organizationId, userId: null, role: null, action, entity: "Payment", entityId: p.id, patientId: p.patientId, ip, detail: { actor: `provider:${provider.name}`, ...detail } as object } });
}

/** Apply what the gateway said to a claimed payment, once (ProviderEvent `execute:<ref>`). `settled`: the answer decides
    it — anything but Completed fails the payment; unsettled (a timeout, no answer), only Completed is applied and the
    claim stays for the sweep (money review: never fail a payment the gateway may have completed). */
async function applyAnswer(tenantId: string, provider: PaymentProvider, paymentId: string, ref: string, st: ProviderStatus | null, settled: boolean, now: Date, ip: string | null): Promise<ReturnResult> {
  const { forTenant } = await import("@setu/db");
  return forTenant(tenantId, async (tx) => {
    const p0 = (await tx.payment.findFirst({ where: { id: paymentId } }))!;
    await tx.$queryRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${p0.invoiceId} FOR UPDATE`;
    const p = (await tx.payment.findFirst({ where: { id: paymentId } }))!;
    const inv = (await tx.invoice.findFirst({ where: { id: p.invoiceId } }))!;
    const fac = await facilityOf(tx, p.organizationId);
    const result = (outcome: Outcome, trxId: string | null = null): ReturnResult => ({ outcome, trxId, amountPaisa: p.amountPaisa, ...fac, code: p.linkCode });
    if (p.status === "confirmed" && p.providerRef === ref) return result("paid", p.trxId);
    if (p.providerRef !== ref || !PENDING_DB.includes(p.status)) {
      // security review: bKash completed money on a payment we no longer wait for — never lost: the owner reconciles it
      if (st?.status === "confirmed" && st.trxId && !(await tx.providerEvent.findUnique({ where: { provider_eventId: { provider: provider.name, eventId: `execute:${ref}` } } }))) {
        await tx.task.create({ data: { tenantId, kind: RECONCILE_TASK, status: "requested", focusId: p.id, reason: "money completed by the provider on a payment no longer waiting", requestedById: `provider:${provider.name}`, requestedAt: now,
          detail: { providerRef: ref, trxId: st.trxId, amountPaisa: st.amountPaisa, paymentAmountPaisa: p.amountPaisa, invoiceId: inv.id } as object } });
        await tx.providerEvent.create({ data: { tenantId, provider: provider.name, eventId: `execute:${ref}`, providerRef: ref, kind: "confirmed", paymentId: p.id, outcome: "refused", reason: "late-confirm", trxId: st.trxId, amountPaisa: st.amountPaisa, receivedAt: now } });
        await audit(tx, tenantId, p, provider, { kind: "confirmed", outcome: "refused", reason: "late-confirm", trxId: st.trxId }, ip);
        return result("paid", st.trxId);
      }
      return result(p.status === "confirmed" ? "paid" : "ended", p.status === "confirmed" ? p.trxId : null);
    }
    // decided once: a later return or sweep finds the event and changes nothing (money review M2)
    if (await tx.providerEvent.findUnique({ where: { provider_eventId: { provider: provider.name, eventId: `execute:${ref}` } } })) return result("pending");
    const a = answerOutcome(st ? { transactionStatus: st.status === "confirmed" ? "Completed" : "Initiated", amountPaisa: st.amountPaisa, trxId: st.trxId } : null, p.amountPaisa, settled);
    if (a.outcome === "pending") return result("pending");
    const kind = a.outcome === "confirm" ? "confirmed" : "failed";
    const event = { tenantId, provider: provider.name, eventId: `execute:${ref}`, providerRef: ref, kind, paymentId: p.id, trxId: st?.trxId ?? null, amountPaisa: st?.amountPaisa ?? null, receivedAt: now };
    if (a.outcome === "confirm" && !takesPayment(inv)) {
      // money taken on a bill that no longer takes payments (voided meanwhile): never lost — the owner reconciles it
      await tx.task.create({ data: { tenantId, kind: RECONCILE_TASK, status: "requested", focusId: p.id, reason: "money taken on a bill that takes no payments", requestedById: `provider:${provider.name}`, requestedAt: now,
        detail: { providerRef: ref, trxId: a.trxId, amountPaisa: st!.amountPaisa, paymentAmountPaisa: p.amountPaisa, invoiceId: inv.id } as object } });
      await tx.providerEvent.create({ data: { ...event, outcome: "refused", reason: "bill-not-payable" } });
      await tx.payment.update({ where: { id: p.id }, data: { executeClaimedAt: null } });
      await audit(tx, tenantId, p, provider, { kind, outcome: "refused", reason: "bill-not-payable", trxId: a.trxId }, ip);
      return result("paid", a.trxId);
    }
    if (a.outcome === "confirm") {
      await confirmPayment(tx, p, inv, null, a.trxId, now);
      await tx.providerEvent.create({ data: { ...event, outcome: "applied" } });
      await audit(tx, tenantId, p, provider, { kind, outcome: "applied", trxId: a.trxId, to: "confirmed" }, ip, "update");
      return result("paid", a.trxId);
    }
    if (a.outcome === "mismatch") {
      // money moved, but not the amount asked: the payment stays pending (its amount reserved) and the owner reconciles
      await tx.task.create({ data: { tenantId, kind: RECONCILE_TASK, status: "requested", focusId: p.id, reason: "amount reported by the provider differs from the payment", requestedById: `provider:${provider.name}`, requestedAt: now,
        detail: { providerRef: ref, trxId: st?.trxId ?? null, amountPaisa: st?.amountPaisa ?? null, paymentAmountPaisa: p.amountPaisa, invoiceId: inv.id } as object } });
      await tx.payment.update({ where: { id: p.id }, data: { executeClaimedAt: null } });
      await tx.providerEvent.create({ data: { ...event, outcome: "refused", reason: "amount-mismatch" } });
      await audit(tx, tenantId, p, provider, { kind, outcome: "refused", reason: "amount-mismatch", trxId: st?.trxId ?? null }, ip);
      return result("pending");
    }
    const status = undash<"failed">(transition("PAYMENT", PAYMENT, dash<PaymentState>(p.status), "fail"));
    await tx.payment.update({ where: { id: p.id }, data: { status, failReason: "not-paid", statusAt: now } });
    await tx.providerEvent.create({ data: { ...event, outcome: "applied", reason: a.outcome } });
    await audit(tx, tenantId, p, provider, { kind, outcome: "applied", reason: a.outcome, to: "failed" }, ip, "update");
    return result("not-paid");
  });
}

/** bKash sends the patient's browser back here (`GET /v1/payments/return/bkash`). Decide under the bill's lock, claim
    the one execute, commit, then execute (or query) and apply the answer. Nothing here trusts the redirect itself. */
export async function returnFromGateway(provider: PaymentProvider, q: { ref: string; status: ReturnStatus; signature: string | null }, now: Date, ip: string | null): Promise<ReturnResult> {
  const { forTenant, paymentRefLookup } = await import("@setu/db");
  const none: ReturnResult = { outcome: "unknown", trxId: null, amountPaisa: null, facilityEn: null, facilityBn: null };
  const hit = await paymentRefLookup(provider.name, q.ref);
  if (!hit) return none;
  const step = await forTenant(hit.tenantId, async (tx) => {
    const p0 = await tx.payment.findFirst({ where: { id: hit.paymentId } });
    if (!p0) return null;
    await tx.$queryRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${p0.invoiceId} FOR UPDATE`;
    const p = (await tx.payment.findFirst({ where: { id: hit.paymentId } }))!;
    const fac = await facilityOf(tx, p.organizationId);
    const d = decideReturn({
      status: q.status, payment: dash<PaymentState>(p.status), current: p.providerRef === q.ref,
      expired: !!p.linkExpiresAt && p.linkExpiresAt.getTime() < now.getTime(), claimed: !!p.executeClaimedAt,
      signatureOk: !!p.providerSignature && q.signature === p.providerSignature,
    });
    await audit(tx, hit.tenantId, p, provider, { kind: "return", status: q.status, decision: d.action, ...(d.action === "refuse" ? { reason: d.reason } : {}), current: p.providerRef === q.ref }, ip);
    if (d.action === "execute") {
      const n = await tx.payment.updateMany({ where: { id: p.id, providerRef: q.ref, executeClaimedAt: null, status: { in: ["link_sent", "waiting_customer"] } }, data: { executeClaimedAt: now } });
      if (n.count !== 1) return { action: "query" as const, p, fac };
    }
    return { action: d.action, reason: d.action === "refuse" ? d.reason : null, p, fac };
  });
  if (!step) return none;
  const base = { trxId: null, amountPaisa: step.p.amountPaisa, ...step.fac, code: step.p.providerRef === q.ref ? step.p.linkCode : null };
  if (step.action === "refuse") {
    const outcome: Outcome = step.reason === "already-paid" ? "paid" : step.reason === "expired" ? "expired" : step.reason === "signature" ? "unknown" : "ended";
    return { ...base, outcome, trxId: step.reason === "already-paid" ? step.p.trxId : null };
  }
  if (step.action === "execute") {
    let ans: Awaited<ReturnType<PaymentProvider["execute"]>>;
    try { ans = await provider.execute(q.ref); }
    catch { return { ...base, outcome: "pending" }; } // e.g. the token: the claim stays, the sweep asks again
    return applyAnswer(hit.tenantId, provider, step.p.id, q.ref, ans.status, ans.settled, now, ip);
  }
  // query: a failure / cancel, or a repeat while an execute is claimed
  let st: ProviderStatus | null = null;
  try { st = await provider.verify({ providerRef: q.ref }); } catch { return { ...base, outcome: "pending" }; }
  if (step.p.executeClaimedAt || q.status === "success") {
    // an execute is under way elsewhere: report, do not decide (the sweep does if it never finishes)
    return st?.status === "confirmed" ? applyAnswer(hit.tenantId, provider, step.p.id, q.ref, st, false, now, ip) : { ...base, outcome: "pending" };
  }
  // failure / cancel: the patient did not pay on this link → PAYMENT fail (Completed would be applied)
  return applyAnswer(hit.tenantId, provider, step.p.id, q.ref, st, true, now, ip);
}

/** `GET /v1/pay/:code/result`: what the patient's result page shows — from the server, never from the URL. */
export async function payResult(code: string, now: Date): Promise<{ outcome: Outcome; trxId: string | null; amountPaisa: number | null; facilityEn: string | null; facilityBn: string | null }> {
  const { forTenant, paymentLinkLookup } = await import("@setu/db");
  const hit = await paymentLinkLookup(code);
  if (!hit) return { outcome: "unknown", trxId: null, amountPaisa: null, facilityEn: null, facilityBn: null };
  return forTenant(hit.tenantId, async (tx) => {
    const p = (await tx.payment.findFirst({ where: { id: hit.paymentId } }))!;
    const base = { trxId: null, amountPaisa: p.amountPaisa, ...(await facilityOf(tx, p.organizationId)) };
    if (hit.superseded) return { ...base, outcome: "ended" as const }; // an earlier attempt's link (review): ended, not "not found"
    if (p.status === "confirmed") return { ...base, outcome: "paid" as const, trxId: p.trxId };
    if (p.status === "failed") return { ...base, outcome: "not-paid" as const };
    if (p.executeClaimedAt) return { ...base, outcome: "pending" as const };
    if (p.linkExpiresAt && p.linkExpiresAt.getTime() < now.getTime()) return { ...base, outcome: "expired" as const };
    return { ...base, outcome: "pending" as const };
  });
}

/** `GET /v1/pay/:code`: where the short link goes — the gateway's page while the payment waits on this link, else
    nothing (the page says to ask at the counter). */
export async function payLinkTarget(code: string, now: Date): Promise<{ url: string | null; facilityEn: string | null; facilityBn: string | null; outcome: Outcome }> {
  const { forTenant, paymentLinkLookup } = await import("@setu/db");
  const hit = await paymentLinkLookup(code);
  if (!hit) return { url: null, facilityEn: null, facilityBn: null, outcome: "unknown" };
  return forTenant(hit.tenantId, async (tx) => {
    const p = (await tx.payment.findFirst({ where: { id: hit.paymentId } }))!;
    const fac = await facilityOf(tx, p.organizationId);
    if (hit.superseded) return { url: null, ...fac, outcome: "ended" as const };
    if (p.status === "confirmed") return { url: null, ...fac, outcome: "paid" as const };
    if (!["link_sent", "waiting_customer"].includes(p.status) || !p.linkUrl || p.executeClaimedAt) return { url: null, ...fac, outcome: p.executeClaimedAt ? "pending" as const : "ended" as const };
    if (p.linkExpiresAt && p.linkExpiresAt.getTime() < now.getTime()) return { url: null, ...fac, outcome: "expired" as const };
    return { url: p.linkUrl, ...fac, outcome: "pending" as const };
  });
}

/** Every minute (ADR 0011): a wallet payment left `initiated` without a link (the API stopped between the commit and
    the gateway) is failed; an execute claimed and never answered is settled by asking the gateway. */
export async function sweepPayments(now: Date, stuckMinutes = STUCK_MINUTES): Promise<{ failed: number; settled: number }> {
  const { forTenant, paymentSweepTargets } = await import("@setu/db");
  let failed = 0, settled = 0;
  for (const t of await paymentSweepTargets(new Date(now.getTime() - stuckMinutes * 60_000))) {
    try {
      const p = await forTenant(t.tenantId, async (tx) => {
        const p0 = await tx.payment.findFirst({ where: { id: t.paymentId } });
        if (!p0) return null;
        if (p0.status === "initiated" && !p0.providerRef) {
          const n = await tx.payment.updateMany({ where: { id: p0.id, status: "initiated", providerRef: null, attempt: p0.attempt }, data: { status: "failed", failReason: "gateway-error", statusAt: now } });
          if (n.count) { failed++; await audit(tx, t.tenantId, p0, providerOf(p0), { kind: "sweep", outcome: "no-link", to: "failed" }, null, "update"); }
          return null;
        }
        return p0;
      });
      if (!p?.executeClaimedAt || !p.providerRef) continue;
      const provider = providerOf(p);
      // past the worst case of one execute: Completed confirms; bKash's Initiated means it was never executed (docs);
      // no answer decides nothing
      const st = await provider.verify({ providerRef: p.providerRef }).catch(() => null);
      const r = await applyAnswer(t.tenantId, provider, p.id, p.providerRef, st, st !== null, now, null);
      if (r.outcome === "paid" || r.outcome === "not-paid") settled++;
    } catch (e) { console.error(`payments sweep ${t.tenantId}/${t.paymentId} failed`, e); }
  }
  return { failed, settled };
}

/* ───── ADR 0012: the payment link by SMS ───── */
const smsPhone = (phone: string | null | undefined) => (phone && /^1[3-9]\d{8}$/.test(phone) ? `0${phone}` : null);
/** Queue a payment-link SMS for this payment's current link: facility, bill number, amount and our short link only.
    Null when there is no patient mobile number (a walk-in buyer gets the QR). */
export async function queueLinkSms(tx: Tx, p: Pay, by: string): Promise<string | null> {
  // bKash only: the words say bKash (Nagad has no gateway of its own yet)
  if (!p.linkCode || !p.patientId || p.method !== "bkash") return null;
  const inv = (await tx.invoice.findFirst({ where: { id: p.invoiceId }, select: { number: true, encounterId: true, kind: true } }))!;
  // ADR 0017: the number the link was made for (a deposit link may go to the guardian); an IPD bill is named by its admission
  const to = smsPhone(p.phone ?? (await tx.patient.findFirst({ where: { id: p.patientId }, select: { phone: true } }))?.phone);
  const number = inv.number ?? (inv.kind === "ipd" ? (await tx.admission.findFirst({ where: { invoiceId: p.invoiceId }, select: { number: true } }))?.number ?? "" : "");
  if (!to) return null;
  const o = await tx.organization.findFirst({ where: { id: p.organizationId }, select: { name: true, nameBn: true } });
  const { t, fill } = await import("@setu/i18n");
  const amount = walletAmount(p.amountPaisa).replace(/\.00$/, "");
  const vars = (facility: string) => ({ facility, number, amount });
  // both languages, then the link once (a bilingual SMS is Unicode: every character costs)
  const text = `${fill(t("bn", "billingApp", "sms_payment_link"), vars(smsSafeName(o?.nameBn ?? o?.name ?? "")))}\n${fill(t("en", "billingApp", "sms_payment_link"), vars(smsSafeName(o?.name ?? "")))}\n${config.publicAppUrl}/p/${p.linkCode}`;
  const c = await tx.communication.create({ data: {
    id: `com_${randomUUID()}`, tenantId: p.tenantId, organizationId: p.organizationId, patientId: p.patientId, encounterId: inv.encounterId ?? null, kind: "payment-link", channel: "sms",
    toPhone: to, templateKey: "sms_payment_link", text, paymentId: p.id, createdById: by,
  } });
  return c.id;
}
/** "Send SMS again" for a waiting link: a new message (the gateway cannot recognise a resend of the old one). */
export async function resendLinkSms(tx: Tx, s: SessionData, paymentId: string): Promise<{ inv: Inv; payment: Pay; smsId: string }> {
  const { p, inv } = await walletPaymentHere(tx, s, paymentId);
  if (!PENDING_DB.includes(p.status) || !p.linkCode || p.executeClaimedAt) throw err(409, "not_pending", "এই পেমেন্টের কোনো চালু লিংক নেই", "This payment has no open link");
  // cost and the patient's phone (security review): at most LINK_SMS_MAX per payment, a minute apart
  const sent = await tx.communication.findMany({ where: { paymentId: p.id, kind: "payment-link" }, select: { createdAt: true }, orderBy: { createdAt: "desc" } });
  if (sent.length >= LINK_SMS_MAX) throw err(429, "sms_limit", "এই পেমেন্টের জন্য আর SMS পাঠানো যাবে না — QR দেখান", "No more SMS for this payment — show the QR");
  if (sent[0] && Date.now() - sent[0].createdAt.getTime() < config.linkSmsGapMs) throw err(429, "sms_too_soon", "এক মিনিট পরে আবার পাঠান", "Send again in a minute");
  const id = await queueLinkSms(tx, p, s.userId);
  if (!id) throw err(422, "no_phone", "রোগীর মোবাইল নম্বর নেই — QR দেখান", "The patient has no mobile number — show the QR");
  return { inv, payment: p, smsId: id };
}
