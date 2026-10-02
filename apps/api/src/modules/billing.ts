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
import type { ApprovalItem, ApprovalList, BillingWorklist, ChargeDefinitionList, DiscountRequest, InvoiceView, NewPaymentRequest, PaymentView, ProviderCallbackResponse, ReconcileItem, ReconcileList } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  APPROVAL, INVOICE, PAYMENT, approvalBlockers, billTotals, checkNewPayment, decideProviderEvent, dhakaDay, discountDecision, discountLimit, discountToPaisa,
  invoiceEventAfterConfirm, isWallet, issueBlockers, notBilledBlockers, paidBy, paymentSummary, reconcileApplyBlockers, syncOrderLines, transition, voidBlockers, type BillingSettings, type DiscountCategory, type InvoiceState,
  type PaymentMethod, type PaymentRow, type PaymentState, type ProviderEventKind,
} from "@setu/domain";
import { payments as provider, type ProviderWebhook } from "../adapters/payments/index.js";
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
const BILLED_ORDER_STATES = ["active", "centre_chosen", "accepted", "partially_accepted", "in_progress", "partially_complete", "complete"] as const;
const WRITE_ROLES = ["cashier", "owner", "admin"];

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
interface ReconcileDetail { providerRef: string | null; trxId: string | null; amountPaisa: number | null; paymentAmountPaisa: number; invoiceId: string; resolution?: { action: "applied" | "resolved"; note: string | null; by: string; at: string } }

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

/** A bill at the session's facility and branch, locked for this transaction (two counters never interleave). */
export async function invoiceHere(tx: Tx, s: SessionData, id: string, lock = false): Promise<Inv> {
  if (lock) await tx.$queryRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${id} FOR UPDATE`;
  const branch = await branchOf(tx, s);
  const inv = await tx.invoice.findFirst({ where: { id, organizationId: s.organizationId, branchId: branch.id } });
  if (!inv) throw notFound();
  return inv;
}
/** Any approval still requested on the bill (discount or "Not billed here"): lines are locked and Issue is refused. */
const requestedTask = (tx: Tx, invoiceId: string) => tx.task.findFirst({ where: { kind: { in: APPROVAL_KINDS }, focusId: invoiceId, status: "requested" } });
/** The visit's placed orders that belong on the bill, against the bill's order lines (ADR 0005, decision 99 prep). */
async function ordersDiff(tx: Tx, inv: Inv) {
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
    encounterHere(tx, s, inv.encounterId),
    orgOf(tx, s),
    tx.task.findMany({ where: { kind: DISCOUNT_TASK, focusId: inv.id }, orderBy: { requestedAt: "desc" }, take: 1 }),
    tx.task.findMany({ where: { kind: BILL_ELSEWHERE_TASK, focusId: inv.id }, orderBy: { requestedAt: "desc" } }),
    tx.invoice.findMany({ where: { id: { in: [inv.replacesId, inv.replacedById].filter((x): x is string => Boolean(x)) } }, select: { id: true, number: true } }),
  ]);
  const task = tasks[0] ?? null;
  const who = await people(tx, [inv.discountAppliedById, inv.issuedById, inv.voidedById, e.practitionerId, task?.requestedById, task?.decidedById, ...pays.map((p) => p.createdById), ...lineTasks.flatMap((t) => [t.requestedById, t.decidedById])]);
  const lineTaskById = new Map(lineTasks.map((t) => [t.id, t]));
  const od = inv.status === "draft" ? await ordersDiff(tx, inv) : null;
  const ordersChanged = Boolean(od && od.remove.length + od.add.length > 0);
  const ref = (id: string | null) => (id ? chain.find((c) => c.id === id) ?? { id, number: null } : null);
  const rows = pays.map(toRow);
  const discountTask = inv.discountTaskId ? (task?.id === inv.discountTaskId ? task : await tx.task.findFirst({ where: { id: inv.discountTaskId } })) : null;
  return {
    invoice: {
      id: inv.id, status: dash<InvoiceState>(inv.status), number: inv.number, rev: inv.rev,
      subtotalPaisa: inv.subtotalPaisa, discountPaisa: inv.discountPaisa, netPaisa: inv.netPaisa, vatPaisa: inv.vatPaisa, totalPaisa: inv.totalPaisa, paidPaisa: inv.paidPaisa,
      discount: inv.discountPaisa > 0 && inv.discountCategory && inv.discountReason && inv.discountAppliedById && inv.discountAppliedAt
        ? { category: inv.discountCategory as DiscountCategory, reason: inv.discountReason, appliedBy: who(inv.discountAppliedById), appliedAt: inv.discountAppliedAt.toISOString(),
            approvedBy: discountTask?.decidedById ? (await people(tx, [discountTask.decidedById]))(discountTask.decidedById) : null }
        : null,
      createdAt: inv.createdAt.toISOString(), issuedAt: iso(inv.issuedAt), issuedBy: inv.issuedById ? who(inv.issuedById) : null,
      void: inv.status === "entered_in_error" && inv.voidReason && inv.voidedAt && inv.voidedById ? { reason: inv.voidReason, at: inv.voidedAt.toISOString(), by: who(inv.voidedById) } : null,
      replaces: ref(inv.replacesId), replacedBy: ref(inv.replacedById),
    },
    encounter: { ...toVitalsEncounter(e), practitioner: e.practitionerId ? who(e.practitionerId) : null },
    lines: lines.map((l) => ({
      id: l.id, position: l.position, source: l.source, sourceId: l.sourceId, code: l.code, nameEn: l.nameEn, nameBn: l.nameBn, unitPaisa: l.unitPaisa,
      qty: l.qty, vatRateBp: l.vatRateBp, grossPaisa: l.grossPaisa, discountPaisa: l.discountPaisa, netPaisa: l.netPaisa, vatPaisa: l.vatPaisa, totalPaisa: l.totalPaisa,
      editable: inv.status === "draft" && l.source === "desk",
      notBilled: l.notBilledTaskId && l.notBilledReason && l.notBilledAt
        ? { reason: l.notBilledReason, at: l.notBilledAt.toISOString(), approvedBy: (() => { const t = lineTaskById.get(l.notBilledTaskId!); return t?.decidedById ? who(t.decidedById) : null; })() }
        : null,
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
    payments: pays.map((p) => toPaymentView(p, who)),
    summary: paymentSummary(inv.totalPaisa, rows),
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
function toPaymentView(p: Pay, who: (id: string) => { id: string; nameBn: string; nameEn: string }): PaymentView {
  return {
    id: p.id, method: p.method as PaymentMethod, status: dash<PaymentState>(p.status), amountPaisa: p.amountPaisa, tenderedPaisa: p.tenderedPaisa, changePaisa: p.changePaisa,
    reference: p.reference, trxId: p.trxId, phoneLast4: p.phone ? p.phone.slice(-4) : null, linkExpiresAt: iso(p.linkExpiresAt), attempt: p.attempt, failReason: p.failReason,
    createdBy: who(p.createdById), createdAt: p.createdAt.toISOString(), confirmedAt: iso(p.confirmedAt),
  };
}

/* ───── worklist and price list ───── */
export async function billingWorklist(tx: Tx, s: SessionData, now: Date): Promise<BillingWorklist> {
  const branch = await branchOf(tx, s);
  const rows = await tx.encounter.findMany({ where: { organizationId: s.organizationId, branchId: branch.id, tokenDay: dhakaDay(now), status: "finished" }, include: { patient: true }, orderBy: { tokenNo: "asc" } });
  const invs = await tx.invoice.findMany({ where: { encounterId: { in: rows.map((r) => r.id) }, status: OPEN_BILL } });
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
async function recompute(tx: Tx, inv: Inv, discountPaisa: number, patch: Partial<Inv> = {}): Promise<Inv> {
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
export async function createInvoice(tx: Tx, s: SessionData, encounterId: string, now: Date): Promise<{ inv: Inv; created: boolean; patientId: string }> {
  requireWriter(s);
  const e = await encounterHere(tx, s, encounterId);
  const existing = await tx.invoice.findFirst({ where: { encounterId: e.id, status: OPEN_BILL } });
  if (existing) return { inv: await refreshIfPossible(tx, s, existing), created: false, patientId: e.patientId };
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
  const replaced = await tx.invoice.findFirst({ where: { encounterId: e.id, status: "entered_in_error", replacedById: null }, orderBy: { voidedAt: "desc" } });
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
async function syncDraft(tx: Tx, s: SessionData, inv: Inv): Promise<Inv> {
  const d = await ordersDiff(tx, inv);
  if (!d.remove.length && !d.add.length) return inv;
  if (inv.discountPaisa > 0 || (await requestedTask(tx, inv.id))) return inv;
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
  return recompute(tx, inv, 0);
}
async function refreshIfPossible(tx: Tx, s: SessionData, inv: Inv): Promise<Inv> {
  if (inv.status !== "draft" || !WRITE_ROLES.includes(s.role)) return inv;
  await tx.$queryRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${inv.id} FOR UPDATE`;
  return syncDraft(tx, s, (await tx.invoice.findFirst({ where: { id: inv.id } }))!);
}
/** POST /v1/invoices/:id/refresh-orders — the screen calls it when the view says the orders changed. */
export async function refreshOrders(tx: Tx, s: SessionData, id: string, rev: number): Promise<{ inv: Inv; changed: boolean }> {
  const inv = await editableDraft(tx, s, id, rev);
  if (inv.discountPaisa > 0) throw discountFirst();
  const next = await syncDraft(tx, s, inv);
  return { inv: next, changed: next.rev !== inv.rev };
}

async function editableDraft(tx: Tx, s: SessionData, id: string, rev: number): Promise<Inv> {
  requireWriter(s);
  const inv = await invoiceHere(tx, s, id, true);
  if (inv.status !== "draft") throw notDraft();
  if (inv.rev !== rev) throw stale();
  if (await requestedTask(tx, inv.id)) throw approvalPending();
  return inv;
}

/** A desk line's amounts before any discount (lines change only while there is none), from the domain line maths. */
function lineAmounts(unitPaisa: number, qty: number, vatRateBp: number) {
  const l = billTotals([{ key: "line", unitPaisa, qty, vatRateBp }], 0).lines[0]!;
  return { qty, grossPaisa: l.grossPaisa, discountPaisa: 0, netPaisa: l.netPaisa, vatPaisa: l.vatPaisa, totalPaisa: l.totalPaisa };
}

export async function addDeskLine(tx: Tx, s: SessionData, id: string, code: string, qty: number, rev: number): Promise<Inv> {
  const inv = await editableDraft(tx, s, id, rev);
  if (inv.discountPaisa > 0) throw discountFirst();
  const d = await tx.chargeItemDefinition.findFirst({ where: { organizationId: s.organizationId, code, active: true, kind: "service" } });
  if (!d) throw err(404, "no_such_item", "তালিকায় এই সেবা নেই", "This item is not on the price list", { field: "code" });
  const same = await tx.chargeItem.findFirst({ where: { invoiceId: inv.id, source: "desk", code } });
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
  const b = notBilledBlockers({ line: { source: line.source, unitPaisa: line.unitPaisa, notBilled: Boolean(line.notBilledTaskId) }, reason, invoiceStatus: "draft", requested: false });
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

async function approvalItem(tx: Tx, s: SessionData, t: TaskRow, now: Date): Promise<ApprovalItem | null> {
  const inv = t.focusId ? await tx.invoice.findFirst({ where: { id: t.focusId, organizationId: s.organizationId } }) : null;
  if (!inv) return null;
  const p = await tx.patient.findFirst({ where: { id: inv.patientId } });
  if (!p) return null;
  const day = dhakaDay(now);
  const here = (await tx.invoice.findMany({ where: { organizationId: s.organizationId }, select: { id: true } })).map((i) => i.id);
  const mine = await tx.task.findMany({ where: { kind: DISCOUNT_TASK, requestedById: t.requestedById, focusId: { in: here }, requestedAt: { gte: new Date(`${day}T00:00:00+06:00`) } }, select: { detail: true } });
  const who = await people(tx, [t.requestedById, t.decidedById]);
  const lineId = t.kind === BILL_ELSEWHERE_TASK ? (t.detail as unknown as NotBilledDetail).lineId : null;
  const line = lineId ? await tx.chargeItem.findFirst({ where: { id: lineId }, select: { id: true, nameEn: true, nameBn: true } }) : null;
  return {
    ...toApprovalView(t, who),
    kind: t.kind === BILL_ELSEWHERE_TASK ? "bill-elsewhere" : "discount-approval",
    line,
    invoice: { id: inv.id, status: dash<InvoiceState>(inv.status), number: inv.number, subtotalPaisa: inv.subtotalPaisa, totalPaisa: inv.totalPaisa },
    patient: toVitalsEncounter({ id: "", token: "", tokenDay: "", status: "finished", patient: p } as unknown as Parameters<typeof toVitalsEncounter>[0]).patient,
    requesterToday: { count: mine.length, totalPaisa: mine.reduce((a, m) => a + ((m.detail as unknown as DiscountDetail)?.amountPaisa ?? 0), 0) },
  };
}

export async function approvalList(tx: Tx, s: SessionData, status: "requested" | "approved" | "rejected", now: Date): Promise<ApprovalList> {
  // Only this facility's bills (security review A6–A7: other facilities' tasks must not crowd the list out).
  const here = (await tx.invoice.findMany({ where: { organizationId: s.organizationId }, select: { id: true } })).map((i) => i.id);
  const tasks = await tx.task.findMany({ where: { kind: { in: APPROVAL_KINDS }, status, focusId: { in: here } }, orderBy: { requestedAt: status === "requested" ? "asc" : "desc" }, take: 100 });
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
export async function issueInvoice(tx: Tx, s: SessionData, id: string, rev: number, now: Date): Promise<Inv> {
  requireWriter(s);
  const inv = await invoiceHere(tx, s, id, true);
  if (inv.status !== "draft") throw notDraft();
  if (inv.rev !== rev) throw stale();
  const lines = await tx.chargeItem.findMany({ where: { invoiceId: inv.id }, select: { unitPaisa: true, notBilledTaskId: true } });
  const od = await ordersDiff(tx, inv);
  const blockers = issueBlockers({ lineCount: lines.length, unpricedCount: lines.filter((l) => l.unitPaisa === null && !l.notBilledTaskId).length, pendingApproval: Boolean(await requestedTask(tx, inv.id)), ordersChanged: od.remove.length + od.add.length > 0 });
  if (blockers.length) throw err(422, "issue_blocked", "বিল ইস্যু করা যাচ্ছে না", "The bill cannot be issued yet", { blockers: blockers.map((code) => ({ code })) });
  const fresh = await recompute(tx, inv, inv.discountPaisa);
  const status = undash<"issued">(transition("INVOICE", INVOICE, "draft", "issue"));
  const yy = dhakaDay(now).slice(2, 4);
  const name = `invoice:${s.organizationId}:${yy}`;
  const seq = await tx.sequence.upsert({ where: { tenantId_name: { tenantId: s.tenantId, name } }, create: { tenantId: s.tenantId, name, value: 1 }, update: { value: { increment: 1 } } });
  const number = `INV/${yy}/${String(seq.value).padStart(4, "0")}`;
  const n = await tx.invoice.updateMany({ where: { id: inv.id, rev: fresh.rev, status: "draft" }, data: { status, number, issuedAt: now, issuedById: s.userId, statusAt: now } });
  if (n.count !== 1) throw stale();
  // ADR 0005: the voided bill this one replaces now shows "Replaced by INV/…".
  if (inv.replacesId) await tx.invoice.updateMany({ where: { id: inv.replacesId, status: "entered_in_error", replacedById: null }, data: { replacedById: inv.id } });
  return (await tx.invoice.findFirst({ where: { id: inv.id } }))!;
}

/* ───── void (ADR 0005: INVOICE markError) ───── */
export async function voidInvoice(tx: Tx, s: SessionData, id: string, reason: string, now: Date): Promise<Inv> {
  const inv = await invoiceHere(tx, s, id, true);
  const pays = await tx.payment.findMany({ where: { invoiceId: inv.id } });
  const b = voidBlockers({ role: s.role, status: dash<InvoiceState>(inv.status), confirmedPaisa: inv.paidPaisa,
    pendingPayments: pays.filter((p) => ["initiated", "link_sent", "waiting_customer"].includes(p.status)).length, reason });
  if (b.length) {
    const msg: Record<string, [number, string, string]> = {
      not_an_approver: [403, "শুধু মালিক বা অ্যাডমিন বিল বাতিল করতে পারেন", "Only the owner or an admin can void a bill"],
      has_confirmed_money: [409, "এই বিলে নিশ্চিত টাকা আছে — বাতিল করা যায় না (ফেরত পরের ধাপে)", "Confirmed money is on this bill — it cannot be voided (refunds come later)"],
      not_voidable: [409, "এই বিল বাতিল করা যায় না", "This bill cannot be voided"],
      link_pending: [409, "পেমেন্ট লিংক অপেক্ষমাণ — আগে লিংক বাতিল করুন", "A payment link is pending — cancel the link first"],
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
  !r ? "other" : r.startsWith("money reported") ? "late-money" : r.startsWith("amount reported") ? "amount-mismatch" : r.startsWith("a second payment") ? "second-payment" : r.startsWith("TrxID paid on an earlier") ? "earlier-link" : "other";
async function reconcileItem(tx: Tx, s: SessionData, t: TaskRow): Promise<ReconcileItem | null> {
  const d = t.detail as unknown as ReconcileDetail;
  const p = t.focusId ? await tx.payment.findFirst({ where: { id: t.focusId, organizationId: s.organizationId } }) : null;
  if (!p) return null;
  const inv = await tx.invoice.findFirst({ where: { id: p.invoiceId } });
  const pt = inv ? await tx.patient.findFirst({ where: { id: inv.patientId } }) : null;
  if (!inv || !pt) return null;
  const live = t.status === "requested" && d.providerRef ? await provider.verify({ providerRef: d.providerRef }) : null;
  const applyBlockers = t.status !== "requested" ? [] : reconcileApplyBlockers({
    task: { providerRef: d.providerRef ?? "", trxId: d.trxId, amountPaisa: d.amountPaisa, invoiceId: d.invoiceId },
    payment: { status: dash<PaymentState>(p.status), amountPaisa: p.amountPaisa, invoiceId: p.invoiceId, providerRef: p.providerRef, supersededRefs: p.supersededRefs },
    provider: live,
  });
  const who = await people(tx, [d.resolution?.by]);
  return {
    taskId: t.id, status: t.status, why: t.reason ?? "", createdAt: t.requestedAt.toISOString(), whyCode: whyCodeOf(t.reason),
    reported: { providerRef: d.providerRef, trxId: d.trxId, amountPaisa: d.amountPaisa },
    payment: { id: p.id, method: p.method as PaymentMethod, status: dash<PaymentState>(p.status), amountPaisa: p.amountPaisa, trxId: p.trxId, attempt: p.attempt },
    invoice: { id: inv.id, number: inv.number, status: dash<InvoiceState>(inv.status), totalPaisa: inv.totalPaisa, paidPaisa: inv.paidPaisa },
    patient: toVitalsEncounter({ id: "", token: "", tokenDay: "", status: "finished", patient: pt } as unknown as Parameters<typeof toVitalsEncounter>[0]).patient,
    applyBlockers,
    resolution: d.resolution ? { action: d.resolution.action, note: d.resolution.note, by: who(d.resolution.by), at: d.resolution.at } : null,
  };
}
export async function reconcileList(tx: Tx, s: SessionData, status: "requested" | "approved" | "rejected"): Promise<ReconcileList> {
  const pays = (await tx.payment.findMany({ where: { organizationId: s.organizationId }, select: { id: true } })).map((p) => p.id);
  const tasks = await tx.task.findMany({ where: { kind: RECONCILE_TASK, status, focusId: { in: pays } }, orderBy: { requestedAt: status === "requested" ? "asc" : "desc" }, take: 100 });
  const items: ReconcileItem[] = [];
  for (const t of tasks) { const i = await reconcileItem(tx, s, t); if (i) items.push(i); }
  return { items };
}
/** Apply = the provider, asked again now, confirms the same amount and TrxID for a pending payment of this bill; the
    payment is confirmed with that TrxID and any newer link is cancelled. Resolve = a note, nothing applied. Owner only
    (decision 89; the route checks bill/reconcile). Never a silent apply. */
export async function decideReconcile(tx: Tx, s: SessionData, taskId: string, action: "apply" | "resolve", note: string | undefined, now: Date): Promise<{ item: ReconcileItem; patientId: string; invoiceId: string }> {
  const t0 = await tx.task.findFirst({ where: { id: taskId, kind: RECONCILE_TASK } });
  const p0 = t0?.focusId ? await tx.payment.findFirst({ where: { id: t0.focusId, organizationId: s.organizationId } }) : null;
  if (!t0 || !p0) throw notFound();
  const inv = await invoiceHere(tx, s, p0.invoiceId, true);
  const t = (await tx.task.findFirst({ where: { id: taskId } }))!;
  const p = (await tx.payment.findFirst({ where: { id: p0.id } }))!;
  const d = t.detail as unknown as ReconcileDetail;
  const next = transition("APPROVAL", APPROVAL, t.status, action === "apply" ? "approve" : "reject");
  if (action === "resolve" && (note ?? "").trim().length < 10) throw err(400, "note_required", "নোট লিখুন (অন্তত ১০ অক্ষর)", "Write a note (at least 10 characters)", { field: "note" });
  if (action === "apply") {
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
/** PAYMENT `confirm`, then the bill's confirmed money and INVOICE payPart / payAll. The database checks that the bill's
    paid amount is the sum of its confirmed payments. */
async function confirmPayment(tx: Tx, p: Pay, inv: Inv, by: string | null, trxId: string | null, now: Date) {
  const status = undash<"confirmed">(transition("PAYMENT", PAYMENT, dash<PaymentState>(p.status), "confirm"));
  const n = await tx.payment.updateMany({ where: { id: p.id, status: p.status }, data: { status, confirmedAt: now, confirmedById: by, trxId: trxId ?? p.trxId, statusAt: now } });
  if (n.count !== 1) throw stale();
  const rows = (await tx.payment.findMany({ where: { invoiceId: inv.id } })).map(toRow);
  const s = paymentSummary(inv.totalPaisa, rows);
  const event = invoiceEventAfterConfirm(inv.totalPaisa, s.confirmedPaisa);
  const next = undash<"balanced">(transition("INVOICE", INVOICE, dash<InvoiceState>(inv.status), event));
  await tx.invoice.update({ where: { id: inv.id }, data: { paidPaisa: s.confirmedPaisa, status: next, statusAt: now } });
}

async function sendLink(tx: Tx, p: Pay, inv: Inv, phone: string) {
  const link = await provider.createLink({ method: p.method as "bkash" | "nagad", amountPaisa: p.amountPaisa, reference: p.id, invoiceNumber: inv.number ?? "", phone });
  const status = undash<"link_sent">(transition("PAYMENT", PAYMENT, dash<PaymentState>(p.status), "sendLink"));
  await tx.payment.update({ where: { id: p.id }, data: { status, providerRef: link.providerRef, linkUrl: link.url, linkExpiresAt: link.expiresAt, phone, statusAt: new Date() } });
}

export async function addPayment(tx: Tx, s: SessionData, invoiceId: string, req: NewPaymentRequest, now: Date): Promise<{ inv: Inv; payment: Pay }> {
  requireWriter(s);
  const inv = await invoiceHere(tx, s, invoiceId, true);
  if (inv.status !== "issued" && inv.status !== "partially_paid")
    throw err(409, "not_payable", inv.status === "draft" ? "আগে বিল ইস্যু করুন" : "এই বিলে আর টাকা নেওয়া যায় না", inv.status === "draft" ? "Issue the bill first" : "This bill takes no more payments");
  const rows = (await tx.payment.findMany({ where: { invoiceId: inv.id } })).map(toRow);
  const check = checkNewPayment(paymentSummary(inv.totalPaisa, rows), { method: req.method, amountPaisa: req.amountPaisa, tenderedPaisa: req.tenderedPaisa, reference: req.reference });
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
  let phone: string | null = null;
  if (wallet) {
    phone = (await tx.patient.findFirst({ where: { id: inv.patientId }, select: { phone: true } }))?.phone ?? null;
    if (!phone || !/^1[3-9]\d{8}$/.test(phone)) throw err(422, "no_phone", "রোগীর মোবাইল নম্বর নেই — নগদ বা কার্ডে নিন", "The patient has no mobile number — take cash or card", { field: "method" });
  }
  const created = await tx.payment.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, invoiceId: inv.id, patientId: inv.patientId, method: req.method, status: "initiated", amountPaisa: req.amountPaisa,
    tenderedPaisa: req.method === "cash" ? req.tenderedPaisa! : null, changePaisa: req.method === "cash" ? check.changePaisa : null,
    reference: req.method === "card" || req.method === "bank" ? req.reference!.trim() : null, provider: wallet ? provider.name : null, createdById: s.userId, createdAt: now, statusAt: now,
  } });
  if (wallet) await sendLink(tx, created, inv, phone!);
  else await confirmPayment(tx, created, inv, s.userId, null, now);
  return { inv: (await tx.invoice.findFirst({ where: { id: inv.id } }))!, payment: (await tx.payment.findFirst({ where: { id: created.id } }))! };
}

async function walletPaymentHere(tx: Tx, s: SessionData, paymentId: string) {
  requireWriter(s);
  const p0 = await tx.payment.findFirst({ where: { id: paymentId, organizationId: s.organizationId } });
  if (!p0) throw notFound();
  const inv = await invoiceHere(tx, s, p0.invoiceId, true);
  const p = (await tx.payment.findFirst({ where: { id: paymentId } }))!;
  if (!isWallet(p.method as PaymentMethod)) throw err(409, "not_wallet", "এটি ওয়ালেট পেমেন্ট নয়", "This is not a wallet payment");
  return { p, inv };
}

/** A failed wallet payment: cancel the old link, PAYMENT `retry` (attempt + 1, old reference kept as superseded), new link. */
export async function retryPayment(tx: Tx, s: SessionData, paymentId: string, now: Date): Promise<{ inv: Inv; payment: Pay }> {
  const { p, inv } = await walletPaymentHere(tx, s, paymentId);
  const status = undash<"initiated">(transition("PAYMENT", PAYMENT, dash<PaymentState>(p.status), "retry"));
  const others = (await tx.payment.findMany({ where: { invoiceId: inv.id, id: { not: p.id } } })).map(toRow);
  if (p.amountPaisa > paymentSummary(inv.totalPaisa, others).openPaisa) throw err(409, "amount_over_open", "বকেয়ার চেয়ে বেশি (অপেক্ষমাণ পেমেন্টসহ)", "More than is still due (counting pending payments)", { field: "amountPaisa" });
  if (p.providerRef) await provider.cancel(p.providerRef);
  await tx.payment.update({ where: { id: p.id }, data: { status, attempt: p.attempt + 1, providerRef: null, linkUrl: null, linkExpiresAt: null, failReason: null,
    supersededRefs: p.providerRef ? [...p.supersededRefs, p.providerRef] : p.supersededRefs, statusAt: now } });
  await sendLink(tx, (await tx.payment.findFirst({ where: { id: p.id } }))!, inv, p.phone!);
  return { inv: (await tx.invoice.findFirst({ where: { id: inv.id } }))!, payment: (await tx.payment.findFirst({ where: { id: p.id } }))! };
}

/** The cashier typed the TrxID from the patient's phone: confirm only if the provider says that TrxID paid this link,
    in full. */
export async function verifyTrx(tx: Tx, s: SessionData, paymentId: string, trxId: string, now: Date): Promise<{ inv: Inv; payment: Pay; outcome: "confirmed" | "already" | "earlier-link" }> {
  const { p, inv } = await walletPaymentHere(tx, s, paymentId);
  if (p.status === "confirmed") return { inv, payment: p, outcome: "already" };
  const st = await provider.verify({ trxId });
  // Paid on a link that was replaced (review A6–A7): never applied here and never "does not match" either — the owner
  // reconciles it, and the cashier must not ask the patient to pay again.
  if (st && st.status === "confirmed" && p.supersededRefs.includes(st.providerRef)) {
    await tx.task.create({ data: {
      tenantId: s.tenantId, kind: RECONCILE_TASK, status: "requested", focusId: p.id, reason: "TrxID paid on an earlier, replaced payment link", requestedById: s.userId, requestedAt: now,
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
  if (!["initiated", "link_sent", "waiting_customer"].includes(p.status)) throw err(409, "not_pending", "এই পেমেন্ট আর অপেক্ষমাণ নয়", "This payment is no longer pending");
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
export async function handleProviderEvent(tx: Tx, tenantId: string, paymentId: string, supersededAtLookup: boolean, ev: ProviderWebhook, now: Date): Promise<CallbackResult> {
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
    await confirmPayment(tx, p, inv, null, st.trxId, now);
  } else {
    const status = undash<"waiting_customer" | "failed">(decision.next);
    await tx.payment.update({ where: { id: p.id }, data: { status, statusAt: now, ...(decision.event === "fail" ? { failReason: "provider-reported" } : {}) } });
  }
  await record("applied");
  return { body: { outcome: "applied" }, audit: audit("applied", undefined, { to: decision.next }) };
}
