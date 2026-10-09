/* The IPD running bill (ADR 0017, walkthrough B8). The bill is rebuilt from its sources (@setu/domain ipdBill.ts
   `desiredLines`) and reconciled after every event that changes one — admit, a bed arrival, a signed round's orders,
   a lab order's status, a dose or an opened vial drawing ward stock, a dose marked in error, a charge posted by hand,
   a package applied, the bed release — and by the minute sweep for the 00:01 census. Nothing on an IPD bill is edited
   or deleted: a changed line is superseded by a new one, a line no longer wanted gets a credit line (the database
   checks both). Deposits are payments on the draft (IPD only); each confirmed one gets a money receipt DR/yy/nnnn. */
import { randomUUID } from "node:crypto";
import type { ClassPreviewView, DepositReceiptSnapshot, InterimPrintList, InterimPrintRequest, IpdBillList, DepositReceiptView, DepositRequest, IpdBillView, IpdChargeRequest, IpdLine, PackageList, PackageView } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  INVOICE, MAX_DEPOSIT_PAISA, authorize, finalBillOutcome, finalCategories, finalIssueBlockers, keepPostedPrices, transition, holdsShift, type Plan, type Role, bedDaysDue, classPreview, depositState, desiredLines, dhakaDay, ipdLineAmounts, ipdTotals, isWallet, reconcileLines, suggestedTopUp,
  type ClassLeg, type ClassRate, type DesiredLine, type ManualFact, type OrderFact, type PackageSnapshot, type PaymentMethod, type PostedLine, type StayFacts, type StockFact,
} from "@setu/domain";
import { providerFor } from "../adapters/payments/index.js";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { BILLED_ORDER_STATES, confirmIpdDeposit, nextInvoiceNumber, wireSource } from "./billing.js";
import { requestExcessRefund } from "./refunds.js";
import { getPatient, notFound, toSummary } from "./frontdesk.js";
import { dash, erPatientOf, iso, peopleOf, stale, type Adm } from "./inpatient.js";
import { storage } from "../adapters/storage.js";
import { htmlToPdf } from "../receipts/pdf.js";
import { interimBillHtml } from "../receipts/ipd.js";
import { newVerifyCode } from "./receipts.js";

type Inv = NonNullable<Awaited<ReturnType<Tx["invoice"]["findFirst"]>>>;
type Line = NonNullable<Awaited<ReturnType<Tx["chargeItem"]["findFirst"]>>>;
const BILL_WRITERS = ["cashier", "owner", "admin"];
const forbiddenRole = () => err(403, "forbidden", "আইপিডি বিল ক্যাশিয়ার, মালিক বা অ্যাডমিনের", "The IPD bill is the cashier's, the owner's or the admin's", { reason: "role", canRequest: false });
export function requireIpdBill(s: SessionData) {
  const d = authorize(s.role, s.plan, "bill", "ipd");
  if (!d.allowed) throw err(403, "forbidden", "এই পাতা আপনার জন্য নয়", "This page is not for you", { reason: d.reason ?? "role", canRequest: false });
  if (!BILL_WRITERS.includes(s.role)) throw forbiddenRole();
}

/* ───── facts ───── */
export async function classRates(tx: Tx, organizationId: string): Promise<{ rates: Record<string, ClassRate>; rows: { key: string; nameEn: string; nameBn: string; perDayPaisa: number; sample: boolean }[] }> {
  const rows = await tx.bedClassRate.findMany({ where: { organizationId }, orderBy: { perDayPaisa: "asc" } });
  return {
    rates: Object.fromEntries(rows.map((r) => [r.bedClass, { perDayPaisa: r.perDayPaisa, nameEn: r.nameEn, nameBn: r.nameBn }])),
    rows: rows.map((r) => ({ key: r.bedClass, nameEn: r.nameEn, nameBn: r.nameBn, perDayPaisa: r.perDayPaisa, sample: r.sample })),
  };
}
/** The classes the patient occupied: every occupied bed of the inpatient visit, from arrival to leaving. */
async function legsOf(tx: Tx, encounterId: string): Promise<ClassLeg[]> {
  const rows = await tx.bedAssignment.findMany({ where: { encounterId, occupiedAt: { not: null } }, orderBy: { occupiedAt: "asc" } });
  const beds = new Map((await tx.location.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.bedId))] } }, select: { id: true, bedClass: true } })).map((b) => [b.id, b.bedClass]));
  // a row ended "occupied" is a reservation that turned into the occupation row (ADR 0014): not a stay of its own
  return rows.filter((r) => r.status === "occupied" || r.endReason !== "occupied").map((r) => ({ bedClass: beds.get(r.bedId) ?? "", from: r.occupiedAt!, to: r.status === "occupied" ? null : r.endedAt }));
}
const STOCK_REFS = ["administration", "vial-open"];
async function stockFacts(tx: Tx, encounterId: string): Promise<StockFact[]> {
  const [doses, vials] = await Promise.all([
    tx.medicationAdministration.findMany({ where: { encounterId, source: "ward-stock" }, select: { id: true } }),
    tx.multiDoseVial.findMany({ where: { encounterId }, select: { id: true } }),
  ]);
  const refIds = [...doses.map((d) => d.id), ...vials.map((v) => v.id)];
  if (!refIds.length) return [];
  const moves = await tx.stockMove.findMany({ where: { refId: { in: refIds }, refType: { in: [...STOCK_REFS, "dose-error"] } }, include: { batch: true }, orderBy: { at: "asc" } });
  const meds = new Map((await tx.medicine.findMany({ where: { key: { in: [...new Set(moves.map((m) => m.batch.medicineKey))] } } })).map((m) => [m.key, m]));
  const out = new Map<string, StockFact>();
  for (const m of moves) {
    // a dose-error return belongs to the dose it put back
    const refType = m.refType === "dose-error" ? "administration" : m.refType;
    const key = `stock:${refType}:${m.refId}:${m.batchId}`;
    const med = meds.get(m.batch.medicineKey);
    const f = out.get(key) ?? { key, refId: m.refId!, batchId: m.batchId, medicineKey: m.batch.medicineKey, nameEn: med ? `${med.brand} ${med.strength}` : m.batch.medicineKey, nameBn: med ? `${med.brandBn || med.brand} ${med.strength}` : m.batch.medicineKey,
      units: 0, unitPaisa: m.batch.mrpPaisa, vatRateBp: m.batch.vatRateBp, at: m.at };
    f.units -= m.qty; // drawn moves are negative, returns positive
    out.set(key, f);
  }
  return [...out.values()];
}
async function orderFacts(tx: Tx, organizationId: string, encounterId: string): Promise<OrderFact[]> {
  const orders = await tx.serviceRequest.findMany({ where: { encounterId, status: { in: [...BILLED_ORDER_STATES] }, performer: "in-house" }, orderBy: { createdAt: "asc" } });
  if (!orders.length) return [];
  const defs = new Map((await tx.chargeItemDefinition.findMany({ where: { organizationId, code: { in: orders.map((o) => `test:${o.testCode}`) }, active: true } })).map((d) => [d.code, d]));
  return orders.map((o) => { const d = defs.get(`test:${o.testCode}`); return { id: o.id, code: `test:${o.testCode}`, nameEn: d?.nameEn ?? o.nameEn, nameBn: d?.nameBn ?? o.nameBn, unitPaisa: d?.unitPaisa ?? null, vatRateBp: d?.vatRateBp ?? 0, at: o.orderedAt ?? o.createdAt }; });
}
/** Charges posted by hand: each `manual:` key whose line is still live (one withdrawn by its credit line is gone), at the
    price-list price it was first posted at (a later Included line shows ৳0, the price stays the first line's). */
function manualFacts(lines: Line[]): ManualFact[] {
  const first = new Map<string, Line>();
  for (const l of [...lines].sort((a, b) => a.position - b.position)) if (l.key?.startsWith("manual:") && !l.creditOfId && !first.has(l.key)) first.set(l.key, l);
  return lines.filter((l) => l.key?.startsWith("manual:") && !l.supersededById && !l.creditedById && !l.creditOfId)
    .map((l) => { const f = first.get(l.key!)!; return { id: l.key!.slice(7), code: f.code, nameEn: f.nameEn, nameBn: f.nameBn, unitPaisa: f.unitPaisa ?? 0, vatRateBp: f.vatRateBp, qty: f.qty, at: f.createdAt }; });
}
async function stayFacts(tx: Tx, adm: Adm, lines: Line[]): Promise<StayFacts> {
  const enc = adm.encounterId!;
  const [rates, legs, orders, stock] = await Promise.all([classRates(tx, adm.organizationId), legsOf(tx, enc), orderFacts(tx, adm.organizationId, enc), stockFacts(tx, enc)]);
  const manual = manualFacts(lines);
  return { admitAt: adm.admittedAt!, releasedAt: adm.dischargedAt, legs, rates: rates.rates, pkg: (adm.packageSnapshot as unknown as PackageSnapshot | null) ?? null, orders, stock, manual };
}

/* ───── reconcile ───── */
const posted = (l: Line): PostedLine => ({ id: l.id, key: l.key, tag: l.tag as PostedLine["tag"], unitPaisa: l.unitPaisa, qty: l.qty, vatRateBp: l.vatRateBp, superseded: Boolean(l.supersededById), credited: Boolean(l.creditedById), creditOfId: l.creditOfId });
const SOURCE_DB = { package: "package", "bed-day": "bed_day", order: "order", stock: "stock", desk: "desk" } as const;
/** `admissionId`: a bed day's source (every line but a desk charge names one — charge_item_source) */
function lineData(d: DesiredLine, tenantId: string, invoiceId: string, position: number, by: string | null, admissionId: string) {
  return {
    tenantId, invoiceId, position, source: SOURCE_DB[d.source], sourceId: d.source === "desk" ? null : d.source === "bed-day" ? admissionId : d.sourceId, batchId: d.batchId, medicineKey: d.medicineKey,
    code: d.code, nameEn: d.nameEn, nameBn: d.nameBn, unitPaisa: d.unitPaisa, qty: d.qty, vatRateBp: d.vatRateBp, ...ipdLineAmounts(d.unitPaisa, d.qty, d.vatRateBp),
    key: d.key, tag: d.tag, serviceDay: d.serviceDay, dayNo: d.dayNo, bedClass: d.bedClass, auto: d.source !== "desk", addedById: by,
  };
}
export interface SyncResult { added: string[]; superseded: { key: string; from: number | null; to: number | null }[]; credited: string[] }
/** Bring the bill to what its sources say now. `by` = the person whose action triggered it (null: the census, a view). */
export async function syncBill(tx: Tx, adm0: Adm, by: string | null, now: Date, reason: string): Promise<SyncResult> {
  const out: SyncResult = { added: [], superseded: [], credited: [] };
  if (!adm0.invoiceId || !adm0.encounterId || !adm0.admittedAt) return out;
  await tx.$queryRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${adm0.invoiceId} FOR UPDATE`;
  // the admission as it is now, under the bill's lock (review: a release or a package committed meanwhile)
  const adm = (await tx.admission.findFirst({ where: { id: adm0.id } }))!;
  const inv = await tx.invoice.findFirst({ where: { id: adm0.invoiceId } });
  if (!inv || inv.status !== "draft") return out; // B10 issues the bill: nothing posts after that
  const lines = await tx.chargeItem.findMany({ where: { invoiceId: inv.id }, orderBy: { position: "asc" } });
  const facts = await stayFacts(tx, adm, lines);
  // a price is the one its line was first posted at (review): a later price-list or rate change never re-prices the bill
  const r = reconcileLines(lines.map(posted), keepPostedPrices(desiredLines(facts, now), lines.map((l) => ({ key: l.key, code: l.code, tag: l.tag as PostedLine["tag"], unitPaisa: l.unitPaisa, position: l.position, creditOfId: l.creditOfId }))));
  if (!r.add.length && !r.supersede.length && !r.credit.length) return out;
  let pos = lines.reduce((m, l) => Math.max(m, l.position), 0);
  for (const x of r.supersede) {
    const old = lines.find((l) => l.id === x.oldId)!;
    const id = `ci_${randomUUID()}`;
    // the old line first (one live line per key), pointing at its replacement — checked at commit
    await tx.chargeItem.update({ where: { id: old.id }, data: { supersededById: id, supersededAt: now, supersededReason: reason } });
    await tx.chargeItem.create({ data: { id, ...lineData(x.line, adm.tenantId, inv.id, ++pos, by, adm.id) } });
    out.superseded.push({ key: x.line.key, from: old.unitPaisa, to: x.line.unitPaisa });
  }
  for (const d of r.add) { await tx.chargeItem.create({ data: lineData(d, adm.tenantId, inv.id, ++pos, by, adm.id) }); out.added.push(d.key); }
  for (const oldId of r.credit) {
    const old = lines.find((l) => l.id === oldId)!;
    const id = `ci_${randomUUID()}`;
    await tx.chargeItem.create({ data: {
      id, tenantId: adm.tenantId, invoiceId: inv.id, position: ++pos, source: old.source, sourceId: old.sourceId, batchId: old.batchId, medicineKey: old.medicineKey, code: old.code,
      nameEn: `Credit · ${old.nameEn}`, nameBn: `ফেরত · ${old.nameBn}`, unitPaisa: old.unitPaisa, qty: -old.qty, vatRateBp: old.vatRateBp, ...ipdLineAmounts(old.unitPaisa, -old.qty, old.vatRateBp),
      key: `credit:${old.key}`, tag: old.tag, serviceDay: old.serviceDay, dayNo: old.dayNo, bedClass: old.bedClass, auto: true, creditOfId: old.id, addedById: by,
    } });
    await tx.chargeItem.update({ where: { id: old.id }, data: { creditedById: id } });
    out.credited.push(old.key!);
  }
  await recomputeTotals(tx, inv);
  return out;
}
async function recomputeTotals(tx: Tx, inv: Inv) {
  const all = await tx.chargeItem.findMany({ where: { invoiceId: inv.id, supersededById: null } });
  const sum = (k: "grossPaisa" | "netPaisa" | "vatPaisa" | "totalPaisa") => all.reduce((a, l) => a + l[k], 0);
  await tx.invoice.update({ where: { id: inv.id }, data: { subtotalPaisa: sum("grossPaisa"), discountPaisa: 0, netPaisa: sum("netPaisa"), vatPaisa: sum("vatPaisa"), totalPaisa: sum("totalPaisa"), rev: { increment: 1 } } });
}
/** ADR 0018: what the sources say changed since the bill was issued — listed, never posted (Kamrul, 2: an errored dose
    after issue is settled by refund). */
async function afterIssueOf(tx: Tx, adm: Adm, inv: Inv, lines: Line[], now: Date): Promise<NonNullable<IpdBillView["final"]>["afterIssue"]> {
  if (inv.status === "draft" || !adm.admittedAt || !adm.encounterId) return [];
  const facts = await stayFacts(tx, adm, lines);
  const r = reconcileLines(lines.map(posted), keepPostedPrices(desiredLines(facts, now), lines.map((l) => ({ key: l.key, code: l.code, tag: l.tag as PostedLine["tag"], unitPaisa: l.unitPaisa, position: l.position, creditOfId: l.creditOfId }))));
  const amt = (unit: number | null, qty: number, bp: number) => ipdLineAmounts(unit, qty, bp).totalPaisa;
  return [
    ...r.credit.map((id) => { const l = lines.find((x) => x.id === id)!; return { kind: "credit" as const, key: l.key ?? "", nameEn: l.nameEn, nameBn: l.nameBn, amountPaisa: -l.totalPaisa }; }),
    ...r.add.map((d) => ({ kind: "add" as const, key: d.key, nameEn: d.nameEn, nameBn: d.nameBn, amountPaisa: amt(d.unitPaisa, d.qty, d.vatRateBp) })),
    ...r.supersede.map((x) => { const l = lines.find((y) => y.id === x.oldId)!; return { kind: "change" as const, key: x.line.key, nameEn: x.line.nameEn, nameBn: x.line.nameBn, amountPaisa: amt(x.line.unitPaisa, x.line.qty, x.line.vatRateBp) - l.totalPaisa }; }),
  ];
}
const syncAudit = (adm: Adm, r: SyncResult, reason: string): AuditEntry[] =>
  r.added.length || r.superseded.length || r.credited.length
    ? [{ action: "update", entity: "Invoice", entityId: adm.invoiceId!, patientId: adm.patientId, detail: { event: "ipd-sync", reason, added: r.added, superseded: r.superseded, credited: r.credited } }]
    : [];
/** The hook every source calls: sync the running bill of the admission behind this inpatient visit (none: no-op). */
export async function syncForEncounter(tx: Tx, s: SessionData, encounterId: string, now: Date, reason: string): Promise<AuditEntry[]> {
  const adm = await tx.admission.findFirst({ where: { encounterId, status: { in: ["admitted", "discharged"] } } });
  if (!adm) return [];
  return syncAudit(adm, await syncBill(tx, adm, s.userId, now, reason), reason);
}
export async function syncAdmission(tx: Tx, adm: Adm, by: string | null, now: Date, reason: string): Promise<AuditEntry[]> {
  return syncAudit(adm, await syncBill(tx, adm, by, now, reason), reason);
}

/** The census of one admission at `now` (its own transaction): posts the bed days due, audited as the census. */
export async function censusOf(tenantId: string, admissionId: string, now: Date): Promise<number> {
  const { forTenant } = await import("@setu/db");
  return forTenant(tenantId, async (tx) => {
    const adm = await tx.admission.findFirst({ where: { id: admissionId, status: "admitted" } });
    if (!adm) return 0;
    const r = await syncBill(tx, adm, null, now, "census");
    for (const a of syncAudit(adm, r, "census"))
      await tx.auditEvent.create({ data: { tenantId, organizationId: adm.organizationId, userId: null, role: null, action: a.action, entity: a.entity, entityId: a.entityId ?? null, patientId: a.patientId ?? null, detail: { ...a.detail, actor: "census" } as object } });
    return r.added.length;
  }, { system: true });
}
/** The census (ADR 0017): every minute, the admissions whose bill lacks a bed day that is due. */
export async function sweepBedDays(now: Date): Promise<{ posted: number }> {
  const { bedDaySweepTargets } = await import("@setu/db");
  let posted = 0;
  for (const t of await bedDaySweepTargets(now)) {
    try { posted += await censusOf(t.tenantId, t.admissionId, now); } catch (e) { console.error(`bed-day sweep ${t.tenantId}/${t.admissionId} failed`, e); }
  }
  return { posted };
}

/* ───── the view ───── */
async function admissionHere(tx: Tx, s: SessionData, admissionId: string): Promise<Adm> {
  const a = await tx.admission.findFirst({ where: { id: admissionId, organizationId: s.organizationId, status: { in: ["admitted", "discharged"] } } });
  if (!a || !a.invoiceId || !a.encounterId) throw notFound();
  return a;
}
const lastFour = (p: string | null) => (p ? p.slice(-4) : null);
/** A guardian's mobile as a wallet number (10 digits, 1XXXXXXXXX) or null. */
export const walletPhone = (raw: string | null | undefined) => { const d = (raw ?? "").replace(/\D/g, "").replace(/^(880|0)+/, ""); return /^1[3-9]\d{8}$/.test(d) ? d : null; };
function snapshotView(p: PackageSnapshot, sample: boolean): PackageView {
  return { id: p.packageId, code: p.code, nameEn: p.nameEn, nameBn: p.nameBn, days: p.days, prices: p.prices, sample,
    items: [...p.services.map((x) => ({ kind: "service" as const, code: x.code, limit: x.limit, nameEn: x.nameEn ?? x.code, nameBn: x.nameBn ?? x.code })),
      ...p.medicines.map((m) => ({ kind: "medicine" as const, code: m, limit: null, nameEn: p.medicineNames?.[m]?.nameEn ?? m, nameBn: p.medicineNames?.[m]?.nameBn ?? m })), ...p.excluded.map((x) => ({ kind: "excluded" as const, code: null, limit: null, ...x }))] };
}
export async function ipdBillView(tx: Tx, s: SessionData, admissionId: string, now: Date): Promise<IpdBillView> {
  const a = await admissionHere(tx, s, admissionId);
  const inv = (await tx.invoice.findFirst({ where: { id: a.invoiceId! } }))!;
  const [lines, pays, receipts, rates, org, bed, discharge, doctor] = await Promise.all([
    tx.chargeItem.findMany({ where: { invoiceId: inv.id }, orderBy: { position: "asc" } }),
    tx.payment.findMany({ where: { invoiceId: inv.id }, orderBy: { createdAt: "asc" } }),
    tx.receipt.findMany({ where: { invoiceId: inv.id, kind: "deposit" }, select: { id: true, number: true, paymentId: true } }),
    classRates(tx, s.organizationId),
    tx.organization.findFirst({ where: { id: s.organizationId }, select: { paymentMethods: true } }),
    tx.location.findFirst({ where: { id: a.bedId } }),
    tx.discharge.findFirst({ where: { admissionId: a.id, status: { in: ["ordered", "completed"] } }, include: { steps: { select: { status: true } } } }),
    tx.user.findFirst({ where: { id: a.admittingDoctorId }, select: { id: true, nameBn: true, nameEn: true } }),
  ]);
  const ward = bed?.parentId ? await tx.location.findFirst({ where: { id: bed.parentId }, select: { name: true } }) : null;
  const who = await peopleOf(tx, [...lines.map((l) => l.addedById), ...pays.map((p) => p.createdById), a.packageAppliedById, inv.issuedById]);
  const issued = inv.status !== "draft";
  const t = ipdTotals(lines.map((l) => ({ tag: l.tag as IpdLine["tag"], unitPaisa: l.unitPaisa, qty: l.qty, vatRateBp: l.vatRateBp, superseded: Boolean(l.supersededById), credit: Boolean(l.creditedById || l.creditOfId) })));
  const confirmed = pays.filter((p) => p.status === "confirmed").reduce((x, p) => x + p.amountPaisa, 0);
  const pending = pays.filter((p) => ["initiated", "link_sent", "waiting_customer"].includes(p.status)).reduce((x, p) => x + p.amountPaisa, 0);
  const balance = confirmed - t.totalPaisa;
  const perDay = rates.rates[a.bedClass]?.perDayPaisa ?? 0;
  const pkg = (a.packageSnapshot as unknown as PackageSnapshot | null) ?? null;
  const pkgLine = lines.find((l) => l.key === "pkg" && !l.supersededById && !l.creditedById);
  const pkgRow = pkg ? await tx.package.findFirst({ where: { id: pkg.packageId }, select: { sample: true } }) : null;
  const guardianWallet = walletPhone(a.guardianPhone);
  const writer = BILL_WRITERS.includes(s.role);
  const rc = new Map(receipts.map((r) => [r.paymentId, r]));
  return {
    admission: {
      id: a.id, number: a.number ?? "", status: a.status as IpdBillView["admission"]["status"], admittedAt: a.admittedAt!.toISOString(), dayNo: bedDaysDue(a.admittedAt!, a.dischargedAt, now), bedClass: a.bedClass,
      bed: bed ? { name: bed.name, ward: ward?.name ?? "", state: dash<"occupied">(bed.bedState ?? "occupied") } : null, department: a.department,
      doctor: { id: a.admittingDoctorId, nameBn: doctor?.nameBn ?? "—", nameEn: doctor?.nameEn ?? "—" }, dischargedAt: iso(a.dischargedAt),
    },
    patient: toSummary(await getPatient(tx, a.patientId)),
    guardian: a.guardianName ? { name: a.guardianName, relationship: a.guardianRelationship ?? "", phone: a.guardianPhone ?? "" } : null,
    invoice: { id: inv.id, status: dash(inv.status), number: inv.number },
    package: pkg ? { ...snapshotView(pkg, pkgRow?.sample ?? true), bedClass: pkgLine?.bedClass ?? null, pricePaisa: pkgLine?.unitPaisa ?? null, appliedBy: who(a.packageAppliedById), appliedAt: a.packageAppliedAt!.toISOString() } : null,
    lines: lines.map((l): IpdLine => ({
      id: l.id, key: l.key ?? "", source: wireSource(l.source) as IpdLine["source"], tag: (l.tag ?? "excluded") as IpdLine["tag"], code: l.code, nameEn: l.nameEn, nameBn: l.nameBn, qty: l.qty, unitPaisa: l.unitPaisa, vatRateBp: l.vatRateBp, totalPaisa: l.totalPaisa,
      serviceDay: l.serviceDay, dayNo: l.dayNo, bedClass: l.bedClass, auto: l.auto, postedBy: l.addedById ? who(l.addedById) : null, postedAt: l.createdAt.toISOString(),
      superseded: l.supersededAt && l.supersededReason ? { at: l.supersededAt.toISOString(), reason: l.supersededReason } : null, creditOf: l.creditOfId, credited: Boolean(l.creditedById),
    })),
    totals: t,
    deposits: {
      items: pays.map((p) => ({
        id: p.id, method: p.method as PaymentMethod, status: dash(p.status), amountPaisa: p.amountPaisa, trxId: p.trxId, reference: p.reference,
        to: p.phone ? (guardianWallet && p.phone === guardianWallet ? "guardian" as const : "patient" as const) : null, phoneLast4: lastFour(p.phone), payUrl: p.linkCode && ["link_sent", "waiting_customer"].includes(p.status) ? `/p/${p.linkCode}` : null,
        createdBy: who(p.createdById), createdAt: p.createdAt.toISOString(), confirmedAt: iso(p.confirmedAt), failReason: p.failReason, receipt: rc.get(p.id) ? { id: rc.get(p.id)!.id, number: rc.get(p.id)!.number } : null,
        atCounter: Boolean(inv.issuedAt && p.createdAt.getTime() >= inv.issuedAt.getTime()),
      })),
      confirmedPaisa: confirmed, pendingPaisa: pending,
    },
    balancePaisa: balance, depositState: depositState(balance, perDay), perDayPaisa: perDay, suggestedTopUpPaisa: suggestedTopUp(balance, perDay),
    classes: rates.rows.filter((c) => c.key !== "ER"),
    paymentMethods: (org?.paymentMethods ?? []) as IpdBillView["paymentMethods"],
    discharge: discharge ? { id: discharge.id, status: discharge.status as "ordered", done: discharge.steps.filter((x) => x.status === "done").length, total: discharge.steps.length } : null,
    issueBlockers: issued ? [] : await issueBlockersOf(tx, a, inv, lines, pays),
    final: issued ? await finalOf(tx, a, inv, lines, who, now) : null,
    can: { deposit: writer && !issued, postCharge: writer && !issued, applyPackage: writer && !issued && a.status === "admitted" && !pkg,
      issue: writer && !issued && Boolean(discharge),
      pay: writer && (inv.status === "issued" || inv.status === "partially_paid"),
      receipt: writer && issued && inv.paidPaisa - inv.excessPaisa > 0 && inv.status !== "issued" },
    sample: { rates: rates.rows.some((r) => r.key === a.bedClass && r.sample), package: pkgRow?.sample ?? false },
  };
}
const LINK_OPEN = ["initiated", "link_sent", "waiting_customer"];
const unpricedLive = (lines: Line[]) => lines.filter((l) => !l.supersededById && l.unitPaisa === null && !l.creditOfId && !l.creditedById).length;
async function issueBlockersOf(tx: Tx, a: Adm, inv: Inv, lines: Line[], pays: { status: string }[]) {
  const d = await tx.discharge.findFirst({ where: { admissionId: a.id, status: { in: ["ordered", "completed"] } }, select: { id: true } });
  return finalIssueBlockers({ draft: inv.status === "draft", dischargeOrdered: Boolean(d), unpricedLive: unpricedLive(lines), pendingLinks: pays.filter((p) => LINK_OPEN.includes(p.status)).length });
}
async function finalOf(tx: Tx, a: Adm, inv: Inv, lines: Line[], who: Awaited<ReturnType<typeof peopleOf>>, now: Date): Promise<IpdBillView["final"]> {
  const [refund, receipts] = await Promise.all([
    tx.refund.findFirst({ where: { invoiceId: inv.id, source: "deposit-excess" }, include: { allocations: { select: { amountPaisa: true, status: true } } } }),
    tx.receipt.findMany({ where: { invoiceId: inv.id, kind: "bill" }, orderBy: { createdAt: "asc" } }),
  ]);
  const deposits = (await tx.payment.aggregate({ where: { invoiceId: inv.id, status: "confirmed", createdAt: { lt: inv.issuedAt! } }, _sum: { amountPaisa: true } }))._sum.amountPaisa ?? 0;
  const net = inv.paidPaisa - inv.excessPaisa;
  return {
    number: inv.number!, issuedAt: inv.issuedAt!.toISOString(), issuedBy: who(inv.issuedById), status: dash(inv.status) as "issued",
    depositsPaisa: deposits, excessPaisa: inv.excessPaisa, netPaidPaisa: net, duePaisa: inv.totalPaisa - inv.creditedPaisa - net,
    categories: finalCategories(lines.map((l) => ({ source: wireSource(l.source) as IpdLine["source"], unitPaisa: l.unitPaisa, qty: l.qty, vatRateBp: l.vatRateBp, superseded: Boolean(l.supersededById) }))),
    excessRefund: refund ? { id: refund.id, status: refund.status as "approved", amountPaisa: refund.amountPaisa, paidPaisa: refund.allocations.filter((x) => x.status === "paid").reduce((t, x) => t + x.amountPaisa, 0) } : null,
    receipts: receipts.map((r) => ({ id: r.id, number: r.number, createdAt: r.createdAt.toISOString(), paidPaisa: r.paidPaisa, duePaisa: r.duePaisa })),
    afterIssue: await afterIssueOf(tx, a, inv, lines, now),
  };
}

/** Opening the bill posts what is due (a census the sweep has not reached yet) — attributed to nobody. */
export async function openBill(tx: Tx, s: SessionData, admissionId: string, now: Date): Promise<{ view: IpdBillView; audit: AuditEntry[] }> {
  requireIpdBill(s);
  const a = await admissionHere(tx, s, admissionId);
  const audit = await syncAdmission(tx, a, null, now, "view");
  const view = await ipdBillView(tx, s, admissionId, now);
  return { view, audit: [...audit, { action: "view", entity: "Invoice", entityId: a.invoiceId!, patientId: a.patientId, detail: { purpose: "ipd-bill" } }] };
}

export async function previewClass(tx: Tx, s: SessionData, admissionId: string, to: string, now: Date): Promise<ClassPreviewView> {
  requireIpdBill(s);
  const a = await admissionHere(tx, s, admissionId);
  const { rates } = await classRates(tx, s.organizationId);
  if (!rates[to] || to === "ER") throw err(400, "bed_class", "এই শ্রেণি নেই", "No such class", { field: "to" });
  const pkgLine = await tx.chargeItem.findFirst({ where: { invoiceId: a.invoiceId!, key: "pkg", supersededById: null, creditedById: null } });
  const p = classPreview({ from: a.bedClass, to, rates, dayNo: bedDaysDue(a.admittedAt!, a.dischargedAt, now), pkg: (a.packageSnapshot as unknown as PackageSnapshot | null) ?? null, packageNowPaisa: pkgLine?.unitPaisa ?? null });
  return { from: a.bedClass, to, ...p };
}

/* ───── writes ───── */
async function draftBill(tx: Tx, s: SessionData, admissionId: string) {
  requireIpdBill(s);
  const a = await admissionHere(tx, s, admissionId);
  await tx.$queryRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${a.invoiceId} FOR UPDATE`;
  const inv = (await tx.invoice.findFirst({ where: { id: a.invoiceId! } }))!;
  if (inv.status !== "draft") throw err(409, "bill_final", "চূড়ান্ত বিল হয়ে গেছে — চলমান বিলে আর যোগ হয় না", "The final bill is made — the running bill takes nothing more");
  return { a, inv };
}
/** A charge from the price list (procedures, transfusion, consults): tagged by the package like any other line. */
export async function postCharge(tx: Tx, s: SessionData, admissionId: string, body: IpdChargeRequest, now: Date): Promise<{ view: IpdBillView; audit: AuditEntry[] }> {
  const { a, inv } = await draftBill(tx, s, admissionId);
  // services only, as at the OPD desk (review A6–A7): a test reaches the bill through the doctor's order, a medicine
  // through the ward stock drawn — never typed in by hand
  const d = await tx.chargeItemDefinition.findFirst({ where: { organizationId: s.organizationId, code: body.code, active: true, kind: "service" } });
  if (!d) throw err(422, "code_unknown", "মূল্যতালিকায় এই সেবা নেই", "Not on the price list", { field: "code" });
  if (d.unitPaisa === null) throw err(422, "unpriced", "এই সেবার দাম ঠিক করা নেই", "This service has no price", { field: "code" });
  const id = randomUUID();
  // posted as the price list says; the sync re-tags it against the package (a supersession when it is Included)
  const pos = ((await tx.chargeItem.aggregate({ where: { invoiceId: inv.id }, _max: { position: true } }))._max.position ?? 0) + 1;
  await tx.chargeItem.create({ data: {
    id: `ci_${id}`, tenantId: s.tenantId, invoiceId: inv.id, position: pos, source: "desk", sourceId: null, definitionId: d.id, code: d.code, nameEn: d.nameEn, nameBn: d.nameBn,
    unitPaisa: d.unitPaisa, qty: body.qty, vatRateBp: d.vatRateBp, ...ipdLineAmounts(d.unitPaisa, body.qty, d.vatRateBp), key: `manual:${id}`, tag: "excluded", auto: false, addedById: s.userId,
  } });
  const r = await syncBill(tx, a, s.userId, now, "charge");
  if (!r.superseded.length) await recomputeTotals(tx, inv);
  return { view: await ipdBillView(tx, s, admissionId, now), audit: [{ action: "create", entity: "ChargeItem", entityId: `ci_${id}`, patientId: a.patientId, detail: { event: "ipd-charge", code: d.code, qty: body.qty, unitPaisa: d.unitPaisa } }, ...syncAudit(a, r, "charge")] };
}
/** A charge posted by hand in error: withdrawn by a credit line (reason in the audit); only charges posted by hand. */
export async function withdrawCharge(tx: Tx, s: SessionData, admissionId: string, lineId: string, reason: string, now: Date): Promise<{ view: IpdBillView; audit: AuditEntry[] }> {
  const { a, inv } = await draftBill(tx, s, admissionId);
  if (reason.trim().length < 5) throw err(400, "reason_required", "কারণ লিখুন (অন্তত ৫ অক্ষর)", "Give the reason (at least 5 characters)", { field: "reason" });
  const l = await tx.chargeItem.findFirst({ where: { id: lineId, invoiceId: inv.id } });
  if (!l || !l.key?.startsWith("manual:")) throw err(409, "not_manual", "শুধু হাতে যোগ করা চার্জ তোলা যায় — বাকিগুলো উৎস থেকে আসে", "Only a charge posted by hand is withdrawn — the rest follow their source");
  if (l.supersededById || l.creditedById || l.creditOfId) throw err(409, "line_not_live", "এই লাইন আর চালু নেই", "This line is no longer live");
  const id = `ci_${randomUUID()}`;
  const pos = ((await tx.chargeItem.aggregate({ where: { invoiceId: inv.id }, _max: { position: true } }))._max.position ?? 0) + 1;
  await tx.chargeItem.create({ data: {
    id, tenantId: s.tenantId, invoiceId: inv.id, position: pos, source: l.source, sourceId: null, definitionId: l.definitionId, code: l.code, nameEn: `Credit · ${l.nameEn}`, nameBn: `ফেরত · ${l.nameBn}`,
    unitPaisa: l.unitPaisa, qty: -l.qty, vatRateBp: l.vatRateBp, ...ipdLineAmounts(l.unitPaisa, -l.qty, l.vatRateBp), key: `credit:${l.key}`, tag: l.tag, auto: false, creditOfId: l.id, addedById: s.userId,
  } });
  await tx.chargeItem.update({ where: { id: l.id }, data: { creditedById: id } });
  // another charge of the same code may now fall inside the package's limit
  const r = await syncBill(tx, a, s.userId, now, "charge-withdrawn");
  if (!r.added.length && !r.superseded.length && !r.credited.length) await recomputeTotals(tx, inv);
  return { view: await ipdBillView(tx, s, admissionId, now), audit: [{ action: "update", entity: "ChargeItem", entityId: l.id, patientId: a.patientId, detail: { event: "ipd-charge-withdrawn", reason: reason.trim(), credit: id } }, ...syncAudit(a, r, "charge-withdrawn")] };
}

/** The package as the admission keeps it (decision 5: a later catalogue change never re-prices a patient). */
/** ADR 0018 (B10): the final bill. Once the discharge is recorded (Kamrul, 2: never waiting for the pharmacy); the final
    census runs first; the charges freeze (the database refuses a line after issue); the deposits apply — a shortfall
    is paid at the counter, an excess becomes the deposit-excess refund in this same transaction (decision 297). */
export async function issueFinal(tx: Tx, s: SessionData, admissionId: string, now: Date): Promise<{ view: IpdBillView; audit: AuditEntry[] }> {
  requireIpdBill(s);
  if (!BILL_WRITERS.includes(s.role)) throw forbiddenRole();
  const a0 = await admissionHere(tx, s, admissionId);
  // the discharge first (review: a cancel committing beside the issue would leave a frozen bill on a cancelled discharge)
  await tx.$queryRaw`SELECT 1 FROM "Discharge" WHERE "admissionId" = ${a0.id} AND "status" IN ('ordered', 'completed') FOR UPDATE`;
  const audit: AuditEntry[] = [...await syncAdmission(tx, a0, s.userId, now, "final")];
  await tx.$queryRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${a0.invoiceId} FOR UPDATE`;
  const a = (await tx.admission.findFirst({ where: { id: a0.id } }))!;
  const inv = (await tx.invoice.findFirst({ where: { id: a.invoiceId! } }))!;
  const lines = await tx.chargeItem.findMany({ where: { invoiceId: inv.id } });
  const pays = await tx.payment.findMany({ where: { invoiceId: inv.id }, select: { status: true } });
  const b = await issueBlockersOf(tx, a, inv, lines, pays);
  if (b.length) {
    const MSG: Record<string, [number, string, string]> = {
      already_issued: [409, "চূড়ান্ত বিল আগেই হয়ে গেছে", "The final bill is already issued"],
      not_ordered: [409, "ডাক্তারের ছুটির আদেশ (বা LAMA / মৃত্যুর রেকর্ড) হয়নি", "The doctor has not recorded the discharge (or LAMA / death) yet"],
      unpriced: [422, "একটি লাইনের দাম নেই — আগে দাম ঠিক করুন", "A line has no price — price it first"],
      link_pending: [409, "একটি জমার লিংক অপেক্ষায় — আগে নিশ্চিত বা বাতিল করুন", "A deposit link is pending — confirm or cancel it first"],
    };
    const [st, bn, en] = MSG[b[0]!]!;
    throw err(st, b[0] === "already_issued" ? "bill_final" : `final_${b[0]}`, bn, en, { blockers: b.map((code) => ({ code })) });
  }
  const o = finalBillOutcome(inv.totalPaisa, inv.paidPaisa);
  // INVOICE: draft → issued, then the deposits already on it (payPart / payAll)
  let st = transition("INVOICE", INVOICE, "draft", "issue");
  if (o.status !== "issued") st = transition("INVOICE", INVOICE, st, o.status === "balanced" ? "payAll" : "payPart");
  const number = await nextInvoiceNumber(tx, s, now);
  const n = await tx.invoice.updateMany({ where: { id: inv.id, status: "draft", rev: inv.rev }, data: {
    status: st.replace(/-/g, "_") as "issued", number, issuedAt: now, issuedById: s.userId, statusAt: now, excessPaisa: o.excessPaisa, rev: { increment: 1 },
  } });
  if (n.count !== 1) throw stale();
  audit.push({ action: "sign", entity: "Invoice", entityId: inv.id, patientId: a.patientId, detail: { event: "issue-final", number, totalPaisa: inv.totalPaisa, depositsPaisa: inv.paidPaisa, excessPaisa: o.excessPaisa, duePaisa: o.duePaisa, status: st } });
  if (o.excessPaisa > 0) {
    const r = await requestExcessRefund(tx, s, (await tx.invoice.findFirst({ where: { id: inv.id } }))!, a.number ?? "", now);
    audit.push(...r.audit);
  }
  // the discharge's final-bill step (and the payment step, when the deposits covered the bill) finish by this event
  const { afterEvent } = await import("./discharge.js");
  audit.push(...await afterEvent(tx, s.userId, a.id, now));
  return { view: await ipdBillView(tx, s, a.id, now), audit };
}

export async function packageSnapshot(tx: Tx, organizationId: string, packageId: string, today: string): Promise<{ snap: PackageSnapshot; row: { id: string } } | null> {
  const p = await tx.package.findFirst({ where: { id: packageId, organizationId, active: true }, include: { prices: true, items: { orderBy: { position: "asc" } } } });
  if (!p || p.validFrom > today || (p.validTo && p.validTo < today)) return null;
  return { row: p, snap: {
    packageId: p.id, code: p.code, nameEn: p.nameEn, nameBn: p.nameBn, days: p.days, prices: Object.fromEntries(p.prices.map((x) => [x.bedClass, x.pricePaisa])),
    services: p.items.filter((i) => i.kind === "service").map((i) => ({ code: i.code!, limit: i.limitQty, nameEn: i.nameEn, nameBn: i.nameBn })),
    medicines: p.items.filter((i) => i.kind === "medicine").map((i) => i.code!),
    medicineNames: Object.fromEntries(p.items.filter((i) => i.kind === "medicine").map((i) => [i.code!, { nameEn: i.nameEn, nameBn: i.nameBn }])),
    excluded: p.items.filter((i) => i.kind === "excluded").map((i) => ({ nameEn: i.nameEn, nameBn: i.nameBn })),
  } };
}
export async function applyPackage(tx: Tx, s: SessionData, admissionId: string, packageId: string, now: Date): Promise<{ view: IpdBillView; audit: AuditEntry[] }> {
  const { a } = await draftBill(tx, s, admissionId);
  if (a.status !== "admitted") throw err(409, "not_admitted", "রোগী আর ভর্তি নেই", "The patient is no longer admitted");
  if (a.packageSnapshot) throw err(409, "package_set", "এই ভর্তিতে প্যাকেজ আগেই দেওয়া আছে", "This admission already has a package");
  const p = await packageSnapshot(tx, s.organizationId, packageId, dhakaDay(now));
  if (!p) throw err(422, "package_unknown", "এই প্যাকেজ চালু নেই", "This package is not available", { field: "packageId" });
  if (p.snap.prices[a.bedClass] === undefined) throw err(422, "package_class", "এই শ্রেণির জন্য প্যাকেজের দাম নেই", "The package has no price for this class", { field: "packageId" });
  // the bill row is locked (draftBill): two counters never both apply one; the database sets it once
  const n = await tx.admission.updateMany({ where: { id: a.id }, data: { packageId: p.row.id, packageSnapshot: p.snap as object, packageAppliedById: s.userId, packageAppliedAt: now } });
  if (n.count !== 1) throw stale();
  const a2 = (await tx.admission.findFirst({ where: { id: a.id } }))!;
  const r = await syncBill(tx, a2, s.userId, now, "package");
  return { view: await ipdBillView(tx, s, admissionId, now), audit: [{ action: "update", entity: "Admission", entityId: a.id, patientId: a.patientId, detail: { event: "package", code: p.snap.code, prices: p.snap.prices, days: p.snap.days } }, ...syncAudit(a2, r, "package")] };
}

/* ───── deposits ───── */
export async function addDeposit(tx: Tx, s: SessionData, admissionId: string, body: DepositRequest, now: Date): Promise<{ view: IpdBillView; paymentId: string; wallet: boolean; audit: AuditEntry[] }> {
  const { a } = await draftBill(tx, s, admissionId);
  const r = await takeDeposit(tx, s, a, body, now);
  return { view: await ipdBillView(tx, s, admissionId, now), ...r };
}
/** A deposit on the running bill (the cashier's screen, or the desk at admit): cash / card / bank confirmed now; a wallet
    payment waits for its link (made by the route after the commit) to the guardian's or the patient's phone. */
export async function takeDeposit(tx: Tx, s: SessionData, a: Adm, body: DepositRequest, now: Date): Promise<{ paymentId: string; wallet: boolean; audit: AuditEntry[] }> {
  const inv = (await tx.invoice.findFirst({ where: { id: a.invoiceId! } }))!;
  if (inv.status !== "draft") throw err(409, "bill_final", "চূড়ান্ত বিল হয়ে গেছে — চলমান বিলে আর যোগ হয় না", "The final bill is made — the running bill takes nothing more");
  const methods = (await tx.organization.findFirst({ where: { id: s.organizationId }, select: { paymentMethods: true } }))?.paymentMethods ?? [];
  if (!methods.includes(body.method)) throw err(422, "method_off", "এই প্রতিষ্ঠানে এই পেমেন্ট মাধ্যম চালু নেই", "This facility does not take this payment method", { field: "method" });
  if (body.amountPaisa < 1 || body.amountPaisa > MAX_DEPOSIT_PAISA) throw err(400, "amount_range", "জমার পরিমাণ ঠিক নয়", "The deposit amount is out of range", { field: "amountPaisa" });
  // cash is counted in the shift of whoever took it (shift close): only someone who holds a drawer shift takes cash
  if (body.method === "cash" && !holdsShift(s.role as Role, s.plan as Plan)) throw err(422, "cash_at_counter", "নগদ জমা ক্যাশ কাউন্টারে নিন (কার্ড বা ব্যাংক এখানে চলবে)", "Take a cash deposit at the cash counter (card or bank works here)", { field: "method" });
  if (body.method === "cash" && (body.tenderedPaisa ?? 0) < body.amountPaisa) throw err(400, "tendered_short", "দেওয়া টাকা পরিমাণের চেয়ে কম", "Tendered is less than the amount", { field: "tenderedPaisa" });
  if ((body.method === "card" || body.method === "bank") && !body.reference?.trim()) throw err(400, "reference_required", "রেফারেন্স লিখুন", "Enter the reference", { field: "reference" });
  const wallet = isWallet(body.method);
  const gateway = wallet ? providerFor(body.method as "bkash" | "nagad") : null;
  if (wallet && !gateway) throw err(422, "method_unavailable", "এই পেমেন্ট মাধ্যম এখনো চালু করা হয়নি — নগদ বা কার্ডে নিন", "This payment method is not connected yet — take cash or card", { field: "method" });
  let phone: string | null = null; const to = body.to ?? "guardian";
  if (wallet) {
    phone = to === "guardian" ? walletPhone(a.guardianPhone) : walletPhone((await tx.patient.findFirst({ where: { id: a.patientId }, select: { phone: true } }))?.phone);
    if (!phone) throw err(422, "no_phone", to === "guardian" ? "অভিভাবকের মোবাইল নম্বর নেই" : "রোগীর মোবাইল নম্বর নেই", to === "guardian" ? "The guardian has no mobile number" : "The patient has no mobile number", { field: "to" });
  }
  const created = await tx.payment.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, invoiceId: inv.id, patientId: a.patientId, method: body.method, status: "initiated", amountPaisa: body.amountPaisa,
    tenderedPaisa: body.method === "cash" ? body.tenderedPaisa! : null, changePaisa: body.method === "cash" ? body.tenderedPaisa! - body.amountPaisa : null,
    reference: body.method === "card" || body.method === "bank" ? body.reference!.trim() : null, provider: gateway?.name ?? null, phone, createdById: s.userId, createdAt: now, statusAt: now,
  } });
  // a wallet deposit stays `initiated`; the route makes its link (and the SMS to that phone) after this commits
  if (!wallet) await confirmIpdDeposit(tx, created.id, s.userId, now);
  return {
    paymentId: created.id, wallet,
    audit: [{ action: "create", entity: "Payment", entityId: created.id, patientId: a.patientId, detail: { event: "deposit", method: body.method, amountPaisa: body.amountPaisa, invoiceId: inv.id, to: wallet ? to : null, phoneLast4: lastFour(phone) } }],
  };
}

/** The money receipt of one confirmed deposit (not a tax invoice): DR/yy/nnnn, the same receipt again if it exists. */
export async function depositReceipt(tx: Tx, s: SessionData, paymentId: string, now: Date): Promise<{ view: DepositReceiptView; created: boolean; patientId: string }> {
  requireIpdBill(s);
  const p = await tx.payment.findFirst({ where: { id: paymentId, organizationId: s.organizationId } });
  if (!p) throw notFound();
  const a = await tx.admission.findFirst({ where: { invoiceId: p.invoiceId } });
  if (!a) throw notFound();
  if (p.status !== "confirmed") throw err(409, "not_confirmed", "টাকা নিশ্চিত হয়নি — রসিদ হয় না", "The money is not confirmed — no receipt");
  const have = await tx.receipt.findFirst({ where: { paymentId: p.id }, include: { _count: { select: { prints: true } } } });
  const toView = (r: { id: string; number: string; verifyCode: string; createdAt: Date; snapshot: unknown }, prints: number): DepositReceiptView => ({ id: r.id, number: r.number, verifyCode: r.verifyCode, createdAt: r.createdAt.toISOString(), snapshot: r.snapshot as DepositReceiptSnapshot, prints });
  if (have) return { view: toView(have, have._count.prints), created: false, patientId: a.patientId };
  const [org, patient, me, bed, before] = await Promise.all([
    tx.organization.findFirst({ where: { id: s.organizationId }, select: { name: true, nameBn: true, address: true } }),
    tx.patient.findFirst({ where: { id: a.patientId }, select: { nameBn: true, nameEn: true, facilityNo: true } }),
    // the cashier on a money receipt is who took the money, not who prints it (review M2)
    tx.user.findFirst({ where: { id: p.createdById }, select: { nameBn: true, nameEn: true } }),
    tx.location.findFirst({ where: { id: a.bedId }, select: { name: true } }),
    tx.payment.aggregate({ where: { invoiceId: p.invoiceId, status: "confirmed", confirmedAt: { lte: p.confirmedAt! } }, _sum: { amountPaisa: true } }),
  ]);
  const snapshot: DepositReceiptSnapshot = {
    seller: { nameEn: org!.name, nameBn: org!.nameBn, address: org!.address }, patient: { nameBn: patient!.nameBn ?? patient!.nameEn ?? "", nameEn: patient!.nameEn ?? patient!.nameBn ?? "", facilityNo: patient!.facilityNo },
    admission: { number: a.number ?? "", bed: bed?.name ?? null }, amountPaisa: p.amountPaisa, method: p.method, trxId: p.trxId, reference: p.reference, paidAt: p.confirmedAt!.toISOString(),
    depositsToDatePaisa: before._sum.amountPaisa ?? p.amountPaisa, cashier: { nameBn: me?.nameBn ?? "—", nameEn: me?.nameEn ?? "—" },
  };
  const yy = dhakaDay(p.confirmedAt!).slice(2, 4); // the year the money came in (review)
  const name = `deposit-receipt:${s.organizationId}:${yy}`;
  const seq = await tx.sequence.upsert({ where: { tenantId_name: { tenantId: s.tenantId, name } }, create: { tenantId: s.tenantId, name, value: 1 }, update: { value: { increment: 1 } } });
  const r = await tx.receipt.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, invoiceId: p.invoiceId, patientId: a.patientId, kind: "deposit", paymentId: p.id, number: `DR/${yy}/${String(seq.value).padStart(4, "0")}`,
    verifyCode: newVerifyCode(), paidPaisa: p.amountPaisa, totalPaisa: p.amountPaisa, duePaisa: 0, creditedPaisa: 0, snapshot: snapshot as object, createdById: s.userId, createdAt: now,
  } });
  return { view: toView(r, 0), created: true, patientId: a.patientId };
}

export async function packageList(tx: Tx, s: SessionData): Promise<PackageList> {
  const d = authorize(s.role, s.plan, "bill", "ipd"), d2 = authorize(s.role, s.plan, "bill", "pkg"), d3 = authorize(s.role, s.plan, "ipd", "admit");
  if (!d.allowed && !d2.allowed && !d3.allowed) throw err(403, "forbidden", "এই পাতা আপনার জন্য নয়", "This page is not for you", { reason: [d, d2, d3].some((x) => x.reason === "plan") ? "plan" : "role", canRequest: false });
  const rows = await tx.package.findMany({ where: { organizationId: s.organizationId, active: true }, include: { prices: true, items: { orderBy: { position: "asc" } } }, orderBy: { code: "asc" } });
  return { items: rows.map((p) => ({ id: p.id, code: p.code, nameEn: p.nameEn, nameBn: p.nameBn, days: p.days, sample: p.sample, prices: Object.fromEntries(p.prices.map((x) => [x.bedClass, x.pricePaisa])),
    items: p.items.map((i) => ({ kind: i.kind as "service", code: i.code, limit: i.limitQty, nameEn: i.nameEn, nameBn: i.nameBn })) })) };
}

/* ───── the list of running bills ───── */
export async function billList(tx: Tx, s: SessionData, now: Date): Promise<{ list: IpdBillList; patientIds: string[] }> {
  requireIpdBill(s);
  // the running drafts, and the issued final bills still owing money either way (a shortfall, the excess deposit unpaid) —
  // chosen from the open bills themselves, however old (review: not the latest 300 admissions)
  const [owing, drafts] = await Promise.all([
    tx.invoice.findMany({ where: { organizationId: s.organizationId, kind: "ipd", OR: [{ status: { in: ["issued", "partially_paid"] } }, { status: "balanced", excessPaisa: { gt: 0 } }] }, orderBy: { issuedAt: "asc" }, take: 500 }),
    tx.invoice.findMany({ where: { organizationId: s.organizationId, kind: "ipd", status: "draft" }, orderBy: { createdAt: "desc" }, take: 300 }),
  ]);
  const all = [...owing, ...drafts];
  const adms = await tx.admission.findMany({ where: { organizationId: s.organizationId, status: { in: ["admitted", "discharged"] }, invoiceId: { in: all.map((i) => i.id) } }, orderBy: { admittedAt: "desc" } });
  const excessOpen = new Map((await tx.refund.findMany({ where: { invoiceId: { in: all.filter((i) => i.excessPaisa > 0).map((i) => i.id) }, source: "deposit-excess", status: { not: "paid" } }, include: { allocations: { select: { amountPaisa: true, status: true } } } }))
    .map((r) => [r.invoiceId, r.amountPaisa - r.allocations.filter((x) => x.status === "paid").reduce((t, x) => t + x.amountPaisa, 0)]));
  const invs = new Map(all.filter((i) => i.status === "draft" || i.status !== "balanced" || excessOpen.has(i.id)).map((i) => [i.id, i]));
  const open = adms.filter((a) => invs.has(a.invoiceId!));
  const [pats, beds, rates, dis] = await Promise.all([
    tx.patient.findMany({ where: { id: { in: open.map((a) => a.patientId) } } }),
    tx.location.findMany({ where: { organizationId: s.organizationId, kind: { in: ["bed", "ward"] } }, select: { id: true, name: true, parentId: true } }),
    classRates(tx, s.organizationId),
    tx.discharge.findMany({ where: { admissionId: { in: open.map((a) => a.id) }, status: { in: ["ordered", "completed"] } }, include: { steps: { select: { status: true } } } }),
  ]);
  const P = new Map(pats.map((p) => [p.id, p])), B = new Map(beds.map((b) => [b.id, b])), D = new Map(dis.map((d) => [d.admissionId, d]));
  const items = open.flatMap((a) => {
    const p = P.get(a.patientId); const inv = invs.get(a.invoiceId!)!;
    if (!p) return [];
    const bed = B.get(a.bedId); const d = D.get(a.id);
    const pkg = (a.packageSnapshot as unknown as PackageSnapshot | null) ?? null;
    const balance = inv.paidPaisa - inv.totalPaisa;
    return [{
      admissionId: a.id, number: a.number ?? "", patient: erPatientOf(p as Parameters<typeof erPatientOf>[0]), bed: bed?.name ?? null, ward: bed?.parentId ? B.get(bed.parentId)?.name ?? null : null,
      bedClass: a.bedClass, dayNo: bedDaysDue(a.admittedAt!, a.dischargedAt, now), status: a.status as IpdBillList["items"][number]["status"], packageName: pkg ? { nameEn: pkg.nameEn, nameBn: pkg.nameBn } : null,
      totalPaisa: inv.totalPaisa, depositsPaisa: inv.paidPaisa, balancePaisa: balance, depositState: depositState(balance, rates.rates[a.bedClass]?.perDayPaisa ?? 0),
      discharge: d ? { status: d.status as "ordered" | "completed", done: d.steps.filter((x) => x.status === "done").length } : null,
      bill: dash(inv.status) as "draft", invoiceNumber: inv.number, duePaisa: inv.status === "draft" ? 0 : inv.totalPaisa - inv.creditedPaisa - (inv.paidPaisa - inv.excessPaisa), excessOpenPaisa: excessOpen.get(inv.id) ?? 0,
    }];
  });
  return { list: { items }, patientIds: items.map((x) => x.patient.id) };
}

/* ───── the interim bill (decision 10): A4, not a final bill, no QR; a reprint needs a reason ───── */
const interimUrl = (admissionId: string, printId: string) => `/v1/ipd/bills/${admissionId}/interim-prints/${printId}/pdf`;
export async function interimPrints(tx: Tx, s: SessionData, admissionId: string): Promise<InterimPrintList> {
  requireIpdBill(s);
  const a = await admissionHere(tx, s, admissionId);
  const rows = await tx.interimBillPrint.findMany({ where: { invoiceId: a.invoiceId! }, orderBy: { copy: "asc" } });
  const who = await peopleOf(tx, rows.map((r) => r.printedById));
  return { items: rows.map((r) => ({ id: r.id, copy: r.copy, reason: r.reason, lang: r.lang, printedBy: who(r.printedById), printedAt: r.printedAt.toISOString(), pdfUrl: interimUrl(a.id, r.id), totalPaisa: r.totalPaisa })) };
}
export async function printInterim(tx: Tx, s: SessionData, admissionId: string, req: InterimPrintRequest, now: Date): Promise<{ list: InterimPrintList; copy: number; patientId: string; invoiceId: string; synced: AuditEntry[] }> {
  requireIpdBill(s);
  const a = await admissionHere(tx, s, admissionId);
  await tx.$queryRaw`SELECT 1 FROM "Invoice" WHERE "id" = ${a.invoiceId} FOR UPDATE`;
  const copy = await tx.interimBillPrint.count({ where: { invoiceId: a.invoiceId! } });
  if (copy > 0 && !req.reason) throw err(409, "reprint_needs_reason", "আবার প্রিন্টের কারণ বেছে নিন", "Choose a reason to reprint", { field: "reason" });
  if (copy === 0 && req.reason) throw err(409, "not_printed_yet", "মূল বিল এখনও প্রিন্ট হয়নি", "The original has not been printed yet", { field: "reason" });
  const synced = await syncAdmission(tx, a, s.userId, now, "interim-print");
  const v = await ipdBillView(tx, s, admissionId, now);
  const [org, me] = await Promise.all([
    tx.organization.findFirst({ where: { id: s.organizationId }, select: { name: true, nameBn: true, address: true } }),
    tx.user.findFirst({ where: { id: s.userId }, select: { nameBn: true, nameEn: true } }),
  ]);
  const live = v.lines.filter((l) => !l.superseded);
  const html = interimBillHtml({
    seller: { nameEn: org!.name, nameBn: org!.nameBn, address: org!.address },
    patient: { nameBn: v.patient.nameBn ?? v.patient.nameEn ?? "", nameEn: v.patient.nameEn ?? v.patient.nameBn ?? "", facilityNo: v.patient.facilityNo },
    admission: { number: v.admission.number, admittedAt: new Date(v.admission.admittedAt), bed: v.admission.bed ? `${v.admission.bed.ward} · ${v.admission.bed.name}` : null, bedClass: v.admission.bedClass, dayNo: v.admission.dayNo, doctor: v.admission.doctor },
    packageName: v.package ? { nameEn: v.package.nameEn, nameBn: v.package.nameBn } : null,
    lines: live.map((l) => { const c = v.classes.find((x) => x.key === l.bedClass); return { serviceDay: l.serviceDay ?? dhakaDay(new Date(l.postedAt)), nameEn: l.nameEn, nameBn: l.nameBn, tag: l.tag, qty: l.qty, unitPaisa: l.unitPaisa, totalPaisa: l.totalPaisa, credit: Boolean(l.creditOf),
      ...(l.source === "bed-day" && l.dayNo !== null && !l.creditOf ? { bedDay: { n: l.dayNo, clsEn: c?.nameEn ?? l.bedClass ?? "", clsBn: c?.nameBn ?? l.bedClass ?? "", beyond: Boolean(v.package) && l.tag === "excluded" } } : {}) }; }),
    totals: v.totals, deposits: v.deposits.items.filter((d) => d.status === "confirmed").map((d) => ({ method: d.method, amountPaisa: d.amountPaisa, at: new Date(d.confirmedAt ?? d.createdAt), trxId: d.trxId })),
    depositsPaisa: v.deposits.confirmedPaisa, balancePaisa: v.balancePaisa, asOf: now, lang: req.lang,
    print: { copy, reason: req.reason ?? null, printedAt: now, printedBy: { nameBn: me?.nameBn ?? "—", nameEn: me?.nameEn ?? "—" } },
  });
  const pdf = await htmlToPdf(html, "a4");
  const storageKey = `tenants/${s.tenantId}/interim-bills/${a.invoiceId}/${copy}-${req.lang}-${randomUUID().slice(0, 8)}.pdf`;
  await tx.interimBillPrint.create({ data: { tenantId: s.tenantId, invoiceId: a.invoiceId!, copy, reason: req.reason ?? null, lang: req.lang, totalPaisa: v.totals.totalPaisa, storageKey, printedById: s.userId, printedAt: now } });
  await storage.put(storageKey, pdf, "application/pdf");
  return { list: await interimPrints(tx, s, admissionId), copy, patientId: a.patientId, invoiceId: a.invoiceId!, synced };
}
export async function interimPdf(tx: Tx, s: SessionData, admissionId: string, printId: string) {
  requireIpdBill(s);
  const a = await admissionHere(tx, s, admissionId);
  const p = await tx.interimBillPrint.findFirst({ where: { id: printId, invoiceId: a.invoiceId! } });
  if (!p) throw notFound();
  const bytes = await storage.get(p.storageKey);
  if (!bytes) throw err(410, "file_missing", "ফাইলটি পাওয়া যায়নি", "The stored file is missing");
  return { bytes, copy: p.copy, number: a.number ?? "ADM", patientId: a.patientId };
}
