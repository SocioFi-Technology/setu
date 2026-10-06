/* Ward indents and ward stock (ADR 0015, prototype Setu Pharmacy › Indents). The nurse requests; the pharmacist issues
   from the store (FEFO, not expired) to the ward as a two-leg transfer (`indent-issue`); a controlled drug's issue
   needs the pharmacist's PIN and writes a register line; INDENT moves requested → partially-issued → issued, or the
   balance is cancelled. */
import { randomUUID } from "node:crypto";
import type { BatchLabels, IndentCreate, IndentIssueRequest, IndentView, WardStock } from "@setu/contracts";
import { qrSvg } from "../receipts/template.js";
import type { Tx } from "@setu/db";
import { INDENT, batchLabelCode, dhakaDay, serial10, indentLineProblems, indentNumber, indentStateAfter, transition, wardStockLocation } from "@setu/domain";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { notFound } from "./frontdesk.js";
import { peopleOf, stale } from "./inpatient.js";
import { requirePin } from "./pin.js";
import { batchFor } from "./purchasing.js";
import { devHash } from "./users.js";

type Ind = NonNullable<Awaited<ReturnType<Tx["wardIndent"]["findFirst"]>>> & { lines: NonNullable<Awaited<ReturnType<Tx["wardIndentLine"]["findFirst"]>>>[] };
const wire = (st: string) => st.replace(/_/g, "-") as IndentView["status"];
export async function wardHere(tx: Tx, s: SessionData, wardId: string) {
  const w = await tx.location.findFirst({ where: { id: wardId, organizationId: s.organizationId, kind: "ward" } });
  if (!w) throw notFound();
  return w;
}
async function storeAvailable(tx: Tx, s: SessionData, keys: string[], today: string) {
  const rows = keys.length ? await tx.stockBatch.findMany({ where: { organizationId: s.organizationId, location: "store", medicineKey: { in: keys }, qtyOnHand: { gt: 0 }, expiry: { gte: today } }, select: { medicineKey: true, qtyOnHand: true } }) : [];
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.medicineKey, (m.get(r.medicineKey) ?? 0) + r.qtyOnHand);
  return m;
}
async function views(tx: Tx, s: SessionData, inds: Ind[], now: Date): Promise<IndentView[]> {
  const keys = [...new Set(inds.flatMap((i) => i.lines.map((l) => l.medicineKey)))];
  const [meds, wards, issues, avail] = await Promise.all([
    tx.medicine.findMany({ where: { key: { in: keys } } }), tx.location.findMany({ where: { id: { in: inds.map((i) => i.wardId) } } }),
    tx.wardIndentIssue.findMany({ where: { indentId: { in: inds.map((i) => i.id) } }, orderBy: { at: "asc" } }), storeAvailable(tx, s, keys, dhakaDay(now)),
  ]);
  const M = new Map(meds.map((m) => [m.key, m])), W = new Map(wards.map((w) => [w.id, w]));
  const who = await peopleOf(tx, [...inds.flatMap((i) => [i.requestedById, i.cancelledById]), ...issues.map((x) => x.byId)]);
  const labels = await labelsOf(tx, issues.flatMap((x) => (x.toBatchId ? [x.toBatchId] : [])));
  return inds.map((i) => ({
    id: i.id, number: i.number, status: wire(i.status), ward: { id: i.wardId, name: W.get(i.wardId)?.name ?? "" }, note: i.note, requestedBy: who(i.requestedById), requestedAt: i.requestedAt.toISOString(),
    lines: [...i.lines].sort((a, b) => a.position - b.position).map((l) => { const m = M.get(l.medicineKey); return { id: l.id, medicineKey: l.medicineKey, name: m ? `${m.brand} ${m.strength}` : l.medicineKey, issueUnit: m?.issueUnit ?? "unit", controlled: Boolean(m?.controlled), requested: l.qtyRequested, issued: l.qtyIssued, storeAvailable: avail.get(l.medicineKey) ?? 0 }; }),
    issues: issues.filter((x) => x.indentId === i.id).map((x) => ({ lineId: x.lineId, qty: x.qty, by: who(x.byId), at: x.at.toISOString(), batchId: x.toBatchId ?? null, label: x.toBatchId ? labels.get(x.toBatchId) ?? null : null })),
    cancel: i.cancelledById ? { by: who(i.cancelledById), reason: i.cancelReason ?? "" } : null,
  }));
}
const one = async (tx: Tx, s: SessionData, id: string) => {
  const i = (await tx.wardIndent.findFirst({ where: { id, organizationId: s.organizationId }, include: { lines: true } })) as Ind | null;
  if (!i) throw notFound();
  return i;
};

export async function createIndent(tx: Tx, s: SessionData, wardId: string, body: IndentCreate, now: Date) {
  if (s.role !== "nurse") throw err(403, "forbidden", "ইনডেন্ট দেন ওয়ার্ডের নার্স", "A ward nurse requests an indent", { reason: "role", canRequest: false });
  const ward = await wardHere(tx, s, wardId);
  const problems = indentLineProblems(body.lines);
  const meds = new Set((await tx.medicine.findMany({ where: { key: { in: body.lines.map((l) => l.medicineKey) }, active: true }, select: { key: true } })).map((m) => m.key));
  if (body.lines.some((l) => !meds.has(l.medicineKey)) && !problems.includes("unknown_medicine")) problems.push("unknown_medicine");
  if (problems.length) throw err(400, "validation", "ইনডেন্টের লাইন ঠিক করুন", "Fix the indent lines", { field: "lines", fields: problems.map((code) => ({ field: "lines", code })) });
  const seqName = `indent:${s.organizationId}`;
  const seq = await tx.sequence.upsert({ where: { tenantId_name: { tenantId: s.tenantId, name: seqName } }, create: { tenantId: s.tenantId, name: seqName, value: 1 }, update: { value: { increment: 1 } } });
  const i = await tx.wardIndent.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, wardId: ward.id, number: indentNumber(dhakaDay(now).slice(2, 4), seq.value), note: body.note?.trim() || null, requestedById: s.userId, requestedAt: now, statusAt: now,
    lines: { create: body.lines.map((l, n) => ({ tenantId: s.tenantId, position: n, medicineKey: l.medicineKey, qtyRequested: l.qty })) } }, include: { lines: true } });
  return { view: (await views(tx, s, [i as Ind], now))[0]!, audit: [{ action: "create", entity: "WardIndent", entityId: i.id, detail: { number: i.number, ward: ward.name, lines: body.lines } }] as AuditEntry[] };
}

export async function issueIndent(tx: Tx, s: SessionData, id: string, body: IndentIssueRequest, now: Date) {
  if (s.role !== "pharmacist") throw err(403, "forbidden", "ইনডেন্ট দেন ফার্মাসিস্ট", "The pharmacist issues an indent", { reason: "role", canRequest: false });
  const i = await one(tx, s, id);
  if (i.status !== "requested" && i.status !== "partially_issued") throw err(409, "indent_closed", "এই ইনডেন্ট আর খোলা নেই", "This indent is no longer open");
  const meds = new Map((await tx.medicine.findMany({ where: { key: { in: i.lines.map((l) => l.medicineKey) } } })).map((m) => [m.key, m]));
  for (const x of body.lines) {
    const l = i.lines.find((y) => y.id === x.lineId);
    if (!l) throw err(400, "line_unknown", "এই লাইন এই ইনডেন্টে নেই", "That line is not on this indent", { field: "lines" });
    if (l.qtyIssued + x.qty > l.qtyRequested) throw err(409, "over_request", "চাওয়ার চেয়ে বেশি দেওয়া যায় না", "More than was requested", { field: "lines", remaining: l.qtyRequested - l.qtyIssued });
  }
  if (body.lines.some((x) => meds.get(i.lines.find((l) => l.id === x.lineId)!.medicineKey)?.controlled)) {
    if (!body.pin) throw err(422, "pin_required", "নিয়ন্ত্রিত ওষুধ — আপনার পিন দিন", "A controlled drug — enter your PIN", { field: "pin" });
    const u = await tx.user.findFirst({ where: { id: s.userId }, select: { pinHash: true } });
    await requirePin(s.userId, () => Boolean(u?.pinHash) && u!.pinHash === devHash(body.pin!));
  }
  const today = dhakaDay(now), wardLoc = wardStockLocation(i.wardId), audit: AuditEntry[] = [];
  for (const x of body.lines) {
    const l = i.lines.find((y) => y.id === x.lineId)!;
    const m = meds.get(l.medicineKey)!;
    const batches = await tx.stockBatch.findMany({ where: { organizationId: s.organizationId, location: "store", medicineKey: l.medicineKey, qtyOnHand: { gt: 0 }, expiry: { gte: today } }, orderBy: [{ expiry: "asc" }, { id: "asc" }] });
    const have = batches.reduce((a, b) => a + b.qtyOnHand, 0);
    if (have < x.qty) throw err(409, "stock_short", `স্টোরে ${m.brand} যথেষ্ট নেই`, `Not enough ${m.brand} in the store`, { field: "lines", shortfall: x.qty - have });
    let left = x.qty;
    for (const b of batches) {
      if (left <= 0) break;
      const n = Math.min(left, b.qtyOnHand);
      const dest = await batchFor(tx, s, { ...b, location: wardLoc }, b.sample);
      const ref = `ii_${randomUUID()}`;
      const out = await tx.stockMove.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, batchId: b.id, kind: "transfer", qty: -n, refType: "indent-issue", refId: ref, byId: s.userId, at: now } });
      await tx.stockMove.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, batchId: dest.id, kind: "transfer", qty: n, refType: "indent-issue", refId: ref, byId: s.userId, at: now } });
      await tx.wardIndentIssue.create({ data: { id: ref, tenantId: s.tenantId, indentId: i.id, lineId: l.id, medicineKey: l.medicineKey, qty: n, fromBatchId: b.id, toBatchId: dest.id, byId: s.userId, at: now } });
      await ensureLabels(tx, s, [dest.id]); // the ward batch's label, to print with the issue
      if (m.controlled) await tx.controlledDrugRegister.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, medicineKey: l.medicineKey, kind: "issue", stockMoveId: out.id, batchId: b.id, qty: n, location: wardLoc, balanceAfter: b.qtyOnHand - n, indentId: i.id, byId: s.userId, at: now } });
      left -= n;
    }
    await tx.wardIndentLine.update({ where: { id: l.id }, data: { qtyIssued: l.qtyIssued + x.qty } });
    l.qtyIssued += x.qty;
    audit.push({ action: "create", entity: "StockMove", entityId: i.id, detail: { kind: "indent-issue", indent: i.number, medicineKey: l.medicineKey, qty: x.qty, controlled: m.controlled } });
  }
  const st = indentStateAfter(i.lines.map((l) => ({ requested: l.qtyRequested, issued: l.qtyIssued })));
  const to = transition("indent", INDENT, wire(i.status), st === "issued" ? "issueAll" : "issuePart");
  const n = await tx.wardIndent.updateMany({ where: { id: i.id, status: i.status }, data: { status: to === "issued" ? "issued" : "partially_issued", statusAt: now } });
  if (n.count !== 1) throw stale();
  audit.push({ action: "update", entity: "WardIndent", entityId: i.id, detail: { event: "issue", from: wire(i.status), to } });
  return { view: (await views(tx, s, [await one(tx, s, i.id)], now))[0]!, audit };
}

export async function cancelIndent(tx: Tx, s: SessionData, id: string, reason: string, now: Date) {
  if (s.role !== "nurse" && s.role !== "pharmacist") throw err(403, "forbidden", "নার্স বা ফার্মাসিস্ট", "A nurse or the pharmacist cancels it", { reason: "role", canRequest: false });
  const i = await one(tx, s, id);
  if (reason.trim().length < 5) throw err(400, "reason_required", "কারণ লিখুন (অন্তত ৫ অক্ষর)", "Give a reason (at least 5 characters)", { field: "reason" });
  let to: string;
  try { to = transition("indent", INDENT, wire(i.status), "cancel"); } catch { throw err(409, "indent_closed", "এই ইনডেন্ট আর খোলা নেই", "This indent is no longer open"); }
  const n = await tx.wardIndent.updateMany({ where: { id: i.id, status: i.status }, data: { status: "cancelled", cancelledById: s.userId, cancelReason: reason.trim(), statusAt: now } });
  if (n.count !== 1) throw stale();
  return { view: (await views(tx, s, [await one(tx, s, i.id)], now))[0]!, audit: [{ action: "update", entity: "WardIndent", entityId: i.id, detail: { event: "cancel", to, reason: reason.trim() } }] as AuditEntry[] };
}
export async function wardIndents(tx: Tx, s: SessionData, wardId: string, now: Date) {
  await wardHere(tx, s, wardId);
  const inds = (await tx.wardIndent.findMany({ where: { organizationId: s.organizationId, wardId }, include: { lines: true }, orderBy: { requestedAt: "desc" }, take: 50 })) as Ind[];
  return { items: await views(tx, s, inds, now) };
}
export async function pharmacyIndents(tx: Tx, s: SessionData, status: string | undefined, now: Date) {
  const st = status ? status.replace(/-/g, "_") : undefined;
  const where = st && ["requested", "partially_issued", "issued", "cancelled"].includes(st) ? { status: st as "requested" } : { status: { in: ["requested", "partially_issued"] as ("requested" | "partially_issued")[] } };
  // open indents oldest first (the queue); issued and cancelled newest first — the latest 100, not the first 100 ever
  const done = st === "issued" || st === "cancelled";
  const inds = (await tx.wardIndent.findMany({ where: { organizationId: s.organizationId, ...where }, include: { lines: true }, orderBy: { requestedAt: done ? "desc" : "asc" }, take: 100 })) as Ind[];
  return { items: await views(tx, s, inds, now) };
}
export async function wardStock(tx: Tx, s: SessionData, wardId: string): Promise<WardStock> {
  const ward = await wardHere(tx, s, wardId);
  const rows = await tx.stockBatch.findMany({ where: { organizationId: s.organizationId, location: wardStockLocation(ward.id), qtyOnHand: { gt: 0 }, expiry: { gte: dhakaDay(new Date()) } }, orderBy: [{ medicineKey: "asc" }, { expiry: "asc" }] });
  const meds = new Map((await tx.medicine.findMany({ where: { key: { in: [...new Set(rows.map((r) => r.medicineKey))] } } })).map((m) => [m.key, m]));
  const keys = [...new Set(rows.map((r) => r.medicineKey))];
  // units put back from errored doses ("stock not drawn"), last 7 days — the next count checks them
  const rets = await tx.stockMove.findMany({ where: { organizationId: s.organizationId, kind: "ward-return", batch: { location: wardStockLocation(ward.id) }, at: { gte: new Date(Date.now() - 7 * 864e5) } }, include: { batch: true }, orderBy: { at: "desc" }, take: 50 });
  const rmeds = new Map((await tx.medicine.findMany({ where: { key: { in: [...new Set(rets.map((r) => r.batch.medicineKey))] } } })).map((m) => [m.key, m]));
  const rwho = await peopleOf(tx, rets.map((r) => r.byId));
  const returns = rets.map((r) => { const m = rmeds.get(r.batch.medicineKey); return { medicine: m ? `${m.brand} ${m.strength}` : r.batch.medicineKey, batchNo: r.batch.batchNo, qty: r.qty, reason: r.reason ?? "", by: rwho(r.byId), at: r.at.toISOString() }; });
  const labels = await labelsOf(tx, rows.map((r) => r.id));
  return { ward: { id: ward.id, name: ward.name }, returns, items: keys.map((k) => { const b = rows.filter((r) => r.medicineKey === k), m = meds.get(k); return { medicineKey: k, name: m ? `${m.brand} ${m.strength}` : k, issueUnit: m?.issueUnit ?? "unit", controlled: Boolean(m?.controlled), qty: b.reduce((a, x) => a + x.qtyOnHand, 0), batches: b.map((x) => ({ id: x.id, batchNo: x.batchNo, expiry: x.expiry, qty: x.qtyOnHand, label: labels.get(x.id) ?? null })) }; }) };
}

/** ADR 0016: the medicine labels (QR) of ward batches — printed with an issue, reprinted on the ward. */
/** The digit-only label codes of these batches (those that have one). */
export async function labelsOf(tx: Tx, batchIds: string[]): Promise<Map<string, string>> {
  if (!batchIds.length) return new Map();
  return new Map((await tx.batchLabel.findMany({ where: { batchId: { in: batchIds } } })).map((l) => [l.batchId, batchLabelCode(l.serial)]));
}
/** A label for each ward batch that has none yet (at an issue, or when the ward prints labels). */
export async function ensureLabels(tx: Tx, s: SessionData, batchIds: string[]): Promise<Map<string, string>> {
  const have = await labelsOf(tx, batchIds);
  for (const id of [...new Set(batchIds)].filter((x) => !have.has(x))) {
    const seq = await tx.sequence.upsert({ where: { tenantId_name: { tenantId: s.tenantId, name: "batch-label" } }, create: { tenantId: s.tenantId, name: "batch-label", value: 1 }, update: { value: { increment: 1 } } });
    const serial = serial10(seq.value);
    await tx.batchLabel.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, batchId: id, serial, createdById: s.userId } });
    have.set(id, batchLabelCode(serial));
  }
  return have;
}
export async function batchLabels(tx: Tx, s: SessionData, ids: string[]): Promise<BatchLabels> {
  const rows = await tx.stockBatch.findMany({ where: { id: { in: ids.slice(0, 50) }, organizationId: s.organizationId, location: { startsWith: "ward:" } } });
  const codes = await ensureLabels(tx, s, rows.map((r) => r.id));
  const meds = new Map((await tx.medicine.findMany({ where: { key: { in: [...new Set(rows.map((r) => r.medicineKey))] } } })).map((m) => [m.key, m]));
  const wards = new Map((await tx.location.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.location.slice(5)))] } }, select: { id: true, name: true } })).map((w) => [w.id, w.name]));
  return { items: rows.map((b) => { const m = meds.get(b.medicineKey); const code = codes.get(b.id)!; return { batchId: b.id, code, medicine: m ? `${m.brand} ${m.strength}` : b.medicineKey, batchNo: b.batchNo, expiry: b.expiry, ward: wards.get(b.location.slice(5)) ?? "", qrSvg: qrSvg(code) }; }) };
}

