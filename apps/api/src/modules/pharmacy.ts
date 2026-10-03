/* Pharmacy service (phase 2 slice 2, ADR 0009; prototype Setu Pharmacy). Runs inside command()/query(), so RLS scopes
   every read to the tenant; visits, batches and bills are also scoped to the session's facility (and branch).
   - Dispense works on the visit's signed, current note. Each given quantity is a MedicationDispense row per batch,
     the `dispense` StockMove that took it (FEFO from the counter) and a line on the visit's draft pharmacy bill at the
     batch's MRP — written in that order, and the database checks each step (pharmacy_guards, pharmacy_bill_rules).
     What was already dispensed for the visit counts against the current version's line for the same medicine.
   - A same-generic substitute needs a reason (≥ 10) and is never one the patient is allergic to; the prescribing
     doctor's inbox gets a `substitution-notice`.
   - Over the counter: a bill without a visit; lines are picked FEFO when added; prescription-only items need a
     prescription photo, controlled ones never sell; the stock moves when the bill is issued.
   Medicine names, sale classes and prices are the demo list's (sample, gap 12). */
import { randomUUID } from "node:crypto";
import type { DeclineRequest, DispenseLine, DispenseQueue, DispenseRequest, DispenseView, MedicineRef, OtcCreateRequest, OtcView, RxPhotoRequest, StockList, BatchView } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  MEDICINES_SAMPLE, batchState, sameGeneric, dhakaDay, dispenseStatus, doseLabel, fefoPick, nearExpiry, otcCheck, saleClass, substitutionBlockers, type AllergyFact, type Meal,
} from "@setu/domain";
import { storage } from "../adapters/storage.js";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { editableDraft, invoiceHere, invoiceView, issueInvoice, lineAmounts, recompute } from "./billing.js";
import { toAllergyFact } from "./consultation.js";
import { branchOf, notFound } from "./frontdesk.js";
import { deliverInApp } from "./lab.js";
import { encounterHere, toVitalsEncounter } from "./vitals.js";

type Batch = NonNullable<Awaited<ReturnType<Tx["stockBatch"]["findFirst"]>>>;
type Inv = NonNullable<Awaited<ReturnType<Tx["invoice"]["findFirst"]>>>;
type Req = NonNullable<Awaited<ReturnType<Tx["medicationRequest"]["findFirst"]>>>;
type Disp = NonNullable<Awaited<ReturnType<Tx["medicationDispense"]["findFirst"]>>>;

/** Medicine is picked from the counter (and its fridge); the store is back stock (a transfer comes with session 2). */
const PICK = ["counter", "fridge"];
const MED = new Map(MEDICINES_SAMPLE.map((m) => [m.id, m]));
const CURRENT = ["final", "amended"] as ("final" | "amended")[];
const RX_PHOTO_MAX = 3 * 1024 * 1024;

export function medRef(key: string): MedicineRef {
  const m = MED.get(key);
  return { key, brand: m?.brand ?? key, generic: m?.generic ?? "", strength: m?.strength ?? "", form: m?.form ?? "", saleClass: saleClass(key), sample: Boolean(m) };
}
const reqRef = (r: Req): MedicineRef => ({ key: r.medicineKey, brand: r.brand, generic: r.generic, strength: r.strength, form: r.form, saleClass: saleClass(r.medicineKey), sample: r.sample });
const batchView = (b: Batch, today: string): BatchView => ({
  id: b.id, batchNo: b.batchNo, expiry: b.expiry, location: b.location, qtyOnHand: b.qtyOnHand, mrpPaisa: b.mrpPaisa, vatRateBp: b.vatRateBp,
  state: batchState({ id: b.id, expiry: b.expiry, qty: b.qtyOnHand, location: b.location }, today), nearExpiry: nearExpiry(b.expiry, today), sample: b.sample,
});
const asLike = (b: Batch) => ({ id: b.id, expiry: b.expiry, qty: b.qtyOnHand, location: b.location });
const lineName = (key: string) => {
  const m = MED.get(key);
  return { nameEn: m ? `${m.brand} ${m.strength}` : key, nameBn: m ? `${m.brandBn} ${m.strength}` : key };
};

async function people(tx: Tx, ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const rows = list.length ? await tx.user.findMany({ where: { id: { in: list } }, select: { id: true, nameBn: true, nameEn: true } }) : [];
  const m = new Map(rows.map((r) => [r.id, r]));
  return (id: string) => m.get(id) ?? { id, nameBn: "—", nameEn: "—" };
}
const pickable = (tx: Tx, s: SessionData, keys: string[]) =>
  tx.stockBatch.findMany({ where: { organizationId: s.organizationId, location: { in: PICK }, medicineKey: { in: keys } }, orderBy: [{ expiry: "asc" }, { id: "asc" }] });

/** The visit's signed, current note (final or amended) with its prescription lines, or null. */
async function currentNote(tx: Tx, encounterId: string) {
  return tx.composition.findFirst({
    where: { encounterId, kind: "consultation-note", status: { in: CURRENT } }, orderBy: { version: "desc" },
    include: { medications: { orderBy: { position: "asc" } } },
  });
}

/** One prescription line's progress from the dispense rows assigned to it (progressAll). */
function progress(r: Req, rows: Disp[]) {
  const given = rows.filter((d) => d.action === "dispense");
  const declinedRow = rows.find((d) => d.action === "decline") ?? null;
  const dispensedQty = given.reduce((a, d) => a + d.qty, 0);
  return { given, declinedRow, dispensedQty, remaining: Math.max(0, r.quantity - dispensedQty), status: dispenseStatus({ prescribed: r.quantity, dispensed: dispensedQty, declined: Boolean(declinedRow) }) };
}
/** Which current line each of the visit's dispense / decline rows belongs to. A row of this version: its own line (two
    lines of the same medicine never count each other's). A row of an earlier version: the current line of the same
    medicine — the one prescribed then or the substitute given (the doctor may amend to it) — at the same position if
    there are two. So nothing given is counted twice and nothing is given twice after an amendment (clinical review). */
async function progressAll(tx: Tx, lines: Req[], rows: Disp[]) {
  const here = new Set(lines.map((l) => l.id));
  const oldIds = [...new Set(rows.filter((d) => !here.has(d.requestId)).map((d) => d.requestId))];
  const old = new Map((oldIds.length ? await tx.medicationRequest.findMany({ where: { id: { in: oldIds } } }) : []).map((x) => [x.id, x]));
  const by = new Map<string, Disp[]>(lines.map((l) => [l.id, []]));
  for (const d of rows) {
    let target: string | null = here.has(d.requestId) ? d.requestId : null;
    const o = target ? undefined : old.get(d.requestId);
    if (o) {
      const c = lines.filter((l) => l.medicineKey === o.medicineKey || l.medicineKey === d.medicineKey);
      target = (c.find((l) => l.position === o.position) ?? c[0])?.id ?? null;
    }
    if (target) by.get(target)!.push(d);
  }
  return (r: Req) => progress(r, by.get(r.id) ?? []);
}
const asMed = (r: Req) => ({ id: r.medicineKey, ingredients: r.ingredients, classes: r.classes, strength: r.strength, form: r.form });
const isClosed = (st: string) => st === "dispensed" || st === "declined" || st === "partial-declined";

async function billSummary(tx: Tx, encounterId: string) {
  const b = await tx.invoice.findFirst({ where: { encounterId, kind: "pharmacy", status: { notIn: ["cancelled", "entered_in_error"] } }, orderBy: [{ createdAt: "desc" }] });
  return b ? { id: b.id, status: b.status.replace(/_/g, "-"), number: b.number, totalPaisa: b.totalPaisa, paidPaisa: b.paidPaisa } : null;
}

/* ───── queue ───── */
export async function dispenseQueue(tx: Tx, s: SessionData, now: Date): Promise<DispenseQueue> {
  const branch = await branchOf(tx, s);
  const encs = await tx.encounter.findMany({ where: { organizationId: s.organizationId, branchId: branch.id, tokenDay: dhakaDay(now) }, include: { patient: true }, orderBy: { tokenNo: "asc" } });
  const notes = await tx.composition.findMany({
    where: { encounterId: { in: encs.map((e) => e.id) }, kind: "consultation-note", status: { in: CURRENT } }, orderBy: { version: "desc" },
    include: { medications: true },
  });
  const latest = new Map<string, (typeof notes)[number]>();
  for (const n of notes) if (!latest.has(n.encounterId)) latest.set(n.encounterId, n);
  const rows = await tx.medicationDispense.findMany({ where: { encounterId: { in: [...latest.keys()] } } });
  const who = await people(tx, encs.map((e) => e.practitionerId));
  const items: DispenseQueue["items"] = [];
  for (const e of encs) {
    const n = latest.get(e.id);
    if (!n || !n.medications.length) continue;
    const mine = rows.filter((r) => r.encounterId === e.id);
    const P = await progressAll(tx, n.medications, mine);
    const st = n.medications.map((m) => P(m).status);
    const status = st.every(isClosed) ? "done" : mine.length === 0 ? "to-dispense" : "partial";
    items.push({
      encounter: { ...toVitalsEncounter(e as Parameters<typeof toVitalsEncounter>[0]), practitioner: e.practitionerId ? who(e.practitionerId) : null },
      signedAt: (n.signedAt ?? n.updatedAt).toISOString(), lineCount: n.medications.length, status, bill: await billSummary(tx, e.id),
    });
  }
  // what still needs the pharmacist first, then by token
  const rank = { "to-dispense": 0, partial: 1, done: 2 } as const;
  items.sort((a, b) => rank[a.status] - rank[b.status]);
  return { items };
}

/* ───── one visit ───── */
export async function dispenseView(tx: Tx, s: SessionData, encounterId: string, now: Date): Promise<DispenseView> {
  const e = await encounterHere(tx, s, encounterId);
  const note = await currentNote(tx, e.id);
  if (!note || !note.medications.length) throw err(404, "no_prescription", "এই ভিজিটে স্বাক্ষরিত প্রেসক্রিপশন নেই", "This visit has no signed prescription");
  const today = dhakaDay(now);
  const [rows, allergyRows] = await Promise.all([
    tx.medicationDispense.findMany({ where: { encounterId: e.id }, orderBy: { at: "asc" } }),
    tx.allergyIntolerance.findMany({ where: { patientId: e.patientId, status: "active" } }),
  ]);
  const allergies = allergyRows.map(toAllergyFact);
  // same-generic brands for every line (substitutes), and every batch they could come from
  const generic = (r: Req) => MEDICINES_SAMPLE.filter((m) => m.id !== r.medicineKey && sameGeneric(asMed(r), m));
  const keys = new Set<string>([...note.medications.map((m) => m.medicineKey), ...note.medications.flatMap((m) => generic(m).map((g) => g.id)), ...rows.map((d) => d.medicineKey)]);
  const batches = await pickable(tx, s, [...keys]);
  const moves = await tx.stockMove.findMany({ where: { refType: "dispense", refId: { in: rows.map((d) => d.id) } } });
  const batchById = new Map((await tx.stockBatch.findMany({ where: { id: { in: moves.map((m) => m.batchId) } } })).map((b) => [b.id, b]));
  const who = await people(tx, [e.practitionerId, ...rows.map((d) => d.byId)]);
  const P = await progressAll(tx, note.medications, rows);
  const lines: DispenseLine[] = note.medications.map((r) => {
    const p = P(r);
    const own = batches.filter((b) => b.medicineKey === r.medicineKey);
    const pick = fefoPick(own.map(asLike), p.declinedRow ? 0 : p.remaining, today);
    const byId = new Map(own.map((b) => [b.id, b]));
    return {
      requestId: r.id, position: r.position, prescribed: reqRef(r),
      dose: r.dose, meal: r.meal as Meal, days: r.days, quantity: r.quantity, note: r.note,
      dispensedQty: p.dispensedQty, remaining: p.declinedRow ? 0 : p.remaining,
      declined: p.declinedRow ? { reason: p.declinedRow.reason ?? "", by: who(p.declinedRow.byId), at: p.declinedRow.at.toISOString() } : null,
      status: p.status,
      given: p.given.map((d) => {
        const mv = moves.find((m) => m.refId === d.id);
        const b = mv ? batchById.get(mv.batchId) : undefined;
        return { id: d.id, medicine: medRef(d.medicineKey), qty: d.qty, batchNo: b?.batchNo ?? "", expiry: b?.expiry ?? "", substitute: d.medicineKey !== d.prescribedKey, reason: d.reason, by: who(d.byId), at: d.at.toISOString() };
      }),
      proposal: { allocations: pick.allocations.map((a) => ({ batch: batchView(byId.get(a.batchId)!, today), qty: a.qty })), shortfall: pick.shortfall },
      batches: own.map((b) => batchView(b, today)),
      substitutes: generic(r).map((g) => ({
        medicine: medRef(g.id),
        available: batches.filter((b) => b.medicineKey === g.id && batchState(asLike(b), today) === "usable").reduce((a, b) => a + b.qtyOnHand, 0),
        allergy: substitutionBlockers({ prescribed: asMed(r), substitute: g, reason: "x".repeat(10), allergies }).includes("allergy"),
      })),
      label: (() => { const bn = doseLabel(r.dose, r.meal as Meal, r.days, "bn"), en = doseLabel(r.dose, r.meal as Meal, r.days, "en"); return bn && en ? { bn, en } : null; })(),
    };
  });
  return {
    encounter: { ...toVitalsEncounter(e), practitioner: e.practitionerId ? who(e.practitionerId) : null },
    composition: { id: note.id, version: note.version, status: note.status as "final" | "amended", signedAt: (note.signedAt ?? note.updatedAt).toISOString() },
    allergies: allergies.map((a) => ({ labelBn: a.labelBn, labelEn: a.labelEn, severity: a.severity ?? "unknown" })),
    lines,
    bill: await billSummary(tx, e.id),
  };
}

/** One dispense / decline at a time per visit (two pharmacists on the same visit must not both give the rest). */
const lockVisit = (tx: Tx, encounterId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(7009, hashtext(${`dispense:${encounterId}`}))`;
async function noteFor(tx: Tx, encounterId: string, compositionId: string) {
  const note = await currentNote(tx, encounterId);
  if (!note) throw err(404, "no_prescription", "এই ভিজিটে স্বাক্ষরিত প্রেসক্রিপশন নেই", "This visit has no signed prescription");
  if (note.id !== compositionId) throw err(409, "prescription_changed", "ডাক্তার প্রেসক্রিপশন সংশোধন করেছেন — নতুন সংস্করণ দেখে দিন", "The doctor amended the prescription — dispense from the new version", { field: "compositionId" });
  return note;
}

/** The visit's draft pharmacy bill (created on the first dispense; a new one once the last was issued). */
async function pharmacyDraft(tx: Tx, s: SessionData, e: { id: string; patientId: string; branchId: string }, now: Date): Promise<Inv> {
  const d = await tx.invoice.findFirst({ where: { encounterId: e.id, kind: "pharmacy", status: "draft" } });
  if (d) {
    if (d.discountPaisa > 0 || (await tx.task.findFirst({ where: { focusId: d.id, status: "requested" }, select: { id: true } })))
      throw err(409, "discount_present", "ফার্মেসি বিলে ছাড় আছে বা অনুমোদন চাওয়া আছে — আগে তা মিটিয়ে নিন", "The pharmacy bill has a discount or a pending approval — settle it first");
    return d;
  }
  return tx.invoice.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, branchId: e.branchId, patientId: e.patientId, encounterId: e.id, kind: "pharmacy", createdById: s.userId, statusAt: now } });
}

export async function dispense(tx: Tx, s: SessionData, encounterId: string, req: DispenseRequest, now: Date): Promise<{ view: DispenseView; audit: AuditEntry[] }> {
  const e = await encounterHere(tx, s, encounterId);
  await lockVisit(tx, e.id);
  const note = await noteFor(tx, e.id, req.compositionId);
  const today = dhakaDay(now);
  const rows = await tx.medicationDispense.findMany({ where: { encounterId: e.id } });
  const allergies: AllergyFact[] = (await tx.allergyIntolerance.findMany({ where: { patientId: e.patientId, status: "active" } })).map(toAllergyFact);
  const audit: AuditEntry[] = [];
  let inv: Inv | null = null;
  const pending: Disp[] = [];
  for (const [i, l] of req.lines.entries()) {
    const r = note.medications.find((m) => m.id === l.requestId);
    if (!r) throw err(404, "line_not_found", "এই লাইন প্রেসক্রিপশনে নেই", "This line is not on the prescription", { field: `lines.${i}.requestId` });
    const p = (await progressAll(tx, note.medications, [...rows, ...pending]))(r);
    if (p.declinedRow) throw err(409, "line_declined", "এই লাইন আগেই ফেরত/বাদ দেওয়া হয়েছে", "This line was declined", { field: `lines.${i}.requestId` });
    if (l.qty > p.remaining) throw err(422, "qty_over_remaining", "প্রেসক্রিপশনের বাকি পরিমাণের বেশি", "More than is left on the prescription", { field: `lines.${i}.qty`, remaining: p.remaining });
    const substitute = l.medicineKey !== r.medicineKey;
    const reason = l.reason?.trim() ?? "";
    if (substitute) {
      const sub = MED.get(l.medicineKey);
      if (!sub) throw err(404, "unknown_medicine", "এই ওষুধ তালিকায় নেই", "This medicine is not on the list", { field: `lines.${i}.medicineKey` });
      const b = substitutionBlockers({ prescribed: asMed(r), substitute: sub, reason, allergies });
      if (b.length) {
        const [bn, en] = b.includes("allergy") ? ["রোগীর এই ওষুধে অ্যালার্জি আছে — বদলানো যাবে না", "The patient is allergic to this medicine — it cannot be given"]
          : b.includes("not_same_generic") ? ["একই জেনেরিক নয় — বদলানো যায় না (ডাক্তার সিদ্ধান্ত নেবেন)", "Not the same generic — the doctor decides that"]
          : ["বদলানোর কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write why it is substituted (at least 10 characters)"];
        throw err(b.includes("reason_required") && b.length === 1 ? 400 : 422, b[0]!, bn, en, { field: `lines.${i}.${b.includes("reason_required") && b.length === 1 ? "reason" : "medicineKey"}`, blockers: b.map((code) => ({ code })) });
      }
    }
    const own = await pickable(tx, s, [l.medicineKey]);
    const pick = fefoPick(own.map(asLike), l.qty, today);
    if (pick.shortfall > 0) throw err(409, "stock_short", "কাউন্টারে যথেষ্ট স্টক নেই (মেয়াদোত্তীর্ণ ব্যাচ বাদে)", "Not enough usable stock at the counter (expired batches are never given)", { field: `lines.${i}.qty`, shortfall: pick.shortfall });
    inv ??= await pharmacyDraft(tx, s, e, now);
    let pos = (await tx.chargeItem.findFirst({ where: { invoiceId: inv.id }, orderBy: { position: "desc" }, select: { position: true } }))?.position ?? 0;
    let firstId: string | null = null;
    for (const a of pick.allocations) {
      const b = own.find((x) => x.id === a.batchId)!;
      const id = `md_${randomUUID()}`, lineId = `ci_${randomUUID()}`;
      const d = await tx.medicationDispense.create({ data: {
        id, tenantId: s.tenantId, organizationId: s.organizationId, encounterId: e.id, patientId: e.patientId, compositionId: note.id, requestId: r.id,
        prescribedKey: r.medicineKey, medicineKey: l.medicineKey, action: "dispense", qty: a.qty, reason: substitute ? reason : null, invoiceId: inv.id, chargeItemId: lineId, byId: s.userId, at: now,
      } });
      await tx.stockMove.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, batchId: b.id, kind: "dispense", qty: -a.qty, refType: "dispense", refId: id, byId: s.userId, at: now } });
      await tx.chargeItem.create({ data: {
        id: lineId, tenantId: s.tenantId, invoiceId: inv.id, position: ++pos, addedById: s.userId, source: "dispense", sourceId: id, code: `med:${l.medicineKey}`, ...lineName(l.medicineKey),
        unitPaisa: b.mrpPaisa, vatRateBp: b.vatRateBp, batchId: b.id, medicineKey: l.medicineKey, ...lineAmounts(b.mrpPaisa, a.qty, b.vatRateBp),
      } });
      pending.push(d);
      firstId ??= id;
      audit.push({ action: "create", entity: "MedicationDispense", entityId: id, patientId: e.patientId, detail: { requestId: r.id, medicineKey: l.medicineKey, prescribedKey: r.medicineKey, qty: a.qty, batchId: b.id, invoiceId: inv.id, substitute } });
    }
    // ADR 0009: the prescribing doctor is told about a substitute (one notice per line given)
    if (substitute && e.practitionerId && firstId) {
      const cid = await deliverInApp(tx, s, { patientId: e.patientId, encounterId: e.id }, { kind: "substitution-notice", channel: "doctor_inbox", recipientUserId: e.practitionerId, dispenseId: firstId }, now);
      audit.push({ action: "create", entity: "Communication", entityId: cid, patientId: e.patientId, detail: { kind: "substitution-notice", dispenseId: firstId } });
    }
  }
  if (inv) {
    const fresh = (await tx.invoice.findFirst({ where: { id: inv.id } }))!;
    await recompute(tx, fresh, fresh.discountPaisa);
    audit.push({ action: "update", entity: "Invoice", entityId: inv.id, patientId: e.patientId, detail: { kind: "pharmacy", event: "dispense-lines" } });
  }
  return { view: await dispenseView(tx, s, e.id, now), audit };
}

export async function decline(tx: Tx, s: SessionData, encounterId: string, req: DeclineRequest, now: Date): Promise<{ view: DispenseView; audit: AuditEntry[] }> {
  const e = await encounterHere(tx, s, encounterId);
  await lockVisit(tx, e.id);
  const note = await noteFor(tx, e.id, req.compositionId);
  const r = note.medications.find((m) => m.id === req.requestId);
  if (!r) throw err(404, "line_not_found", "এই লাইন প্রেসক্রিপশনে নেই", "This line is not on the prescription", { field: "requestId" });
  const p = (await progressAll(tx, note.medications, await tx.medicationDispense.findMany({ where: { encounterId: e.id } })))(r);
  if (isClosed(p.status)) throw err(409, "line_closed", "এই লাইন আর খোলা নেই", "This line is no longer open", { field: "requestId" });
  const reason = req.reason.trim();
  if (reason.length < 10) throw err(400, "reason_required", "কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write a reason (at least 10 characters)", { field: "reason" });
  const id = `md_${randomUUID()}`;
  await tx.medicationDispense.create({ data: {
    id, tenantId: s.tenantId, organizationId: s.organizationId, encounterId: e.id, patientId: e.patientId, compositionId: note.id, requestId: r.id,
    prescribedKey: r.medicineKey, medicineKey: r.medicineKey, action: "decline", qty: 0, reason, byId: s.userId, at: now,
  } });
  return { view: await dispenseView(tx, s, e.id, now), audit: [{ action: "create", entity: "MedicationDispense", entityId: id, patientId: e.patientId, detail: { action: "decline", requestId: r.id, dispensedBefore: p.dispensedQty } }] };
}

/* ───── over the counter ───── */
type Blocker = OtcView["blockers"][number];
async function otcBlockers(tx: Tx, inv: Inv, today: string): Promise<Blocker[]> {
  const lines = await tx.chargeItem.findMany({ where: { invoiceId: inv.id }, orderBy: { position: "asc" } });
  if (!lines.length) return [{ code: "no_lines", lineId: null }];
  const out: Blocker[] = [];
  const batches = new Map((await tx.stockBatch.findMany({ where: { id: { in: lines.map((l) => l.batchId!).filter(Boolean) } } })).map((b) => [b.id, b]));
  const want = new Map<string, number>();
  for (const l of lines) want.set(l.batchId!, (want.get(l.batchId!) ?? 0) + l.qty);
  for (const l of lines) {
    for (const code of otcCheck(saleClass(l.medicineKey!), Boolean(inv.rxPhotoKey))) out.push({ code, lineId: l.id });
    const b = batches.get(l.batchId!);
    if (!b || batchState(asLike(b), today) === "expired" || b.location === "quarantine" || b.qtyOnHand < (want.get(l.batchId!) ?? 0)) out.push({ code: "stock_short", lineId: l.id });
  }
  return out;
}
export async function otcView(tx: Tx, s: SessionData, inv: Inv, now: Date): Promise<OtcView> {
  if (inv.kind !== "otc") throw notFound();
  return { bill: await invoiceView(tx, s, inv), rxPhoto: Boolean(inv.rxPhotoKey), blockers: inv.status === "draft" ? await otcBlockers(tx, inv, dhakaDay(now)) : [] };
}
async function otcDraft(tx: Tx, s: SessionData, id: string, rev: number): Promise<Inv> {
  const inv = await editableDraft(tx, s, id, rev);
  if (inv.kind !== "otc") throw notFound();
  return inv;
}

export async function createOtc(tx: Tx, s: SessionData, req: OtcCreateRequest, now: Date): Promise<Inv> {
  const branch = await branchOf(tx, s);
  // phones are stored without the leading 0, as on Patient (the wallet link reads it)
  return tx.invoice.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, branchId: branch.id, patientId: null, encounterId: null, kind: "otc",
    buyerName: req.buyerName?.trim() || null, buyerPhone: req.buyerPhone ? req.buyerPhone.slice(1) : null, createdById: s.userId, statusAt: now,
  } });
}

export async function addOtcLine(tx: Tx, s: SessionData, id: string, req: { rev: number; medicineKey: string; qty: number }, now: Date): Promise<Inv> {
  const inv = await otcDraft(tx, s, id, req.rev);
  if (!MED.has(req.medicineKey)) throw err(404, "unknown_medicine", "এই ওষুধ তালিকায় নেই", "This medicine is not on the list", { field: "medicineKey" });
  const b0 = otcCheck(saleClass(req.medicineKey), Boolean(inv.rxPhotoKey));
  if (b0.includes("controlled")) throw err(422, "controlled", "নিয়ন্ত্রিত ওষুধ কাউন্টারে বিক্রি হয় না — প্রেসক্রিপশনে ডিসপেন্স করুন", "A controlled medicine is never sold over the counter — dispense it against a prescription", { field: "medicineKey" });
  if (b0.includes("rx_photo_required")) throw err(422, "rx_photo_required", "প্রেসক্রিপশন-ওষুধ — আগে প্রেসক্রিপশনের ছবি তুলুন", "Prescription-only — add a photo of the prescription first", { field: "medicineKey" });
  const own = await pickable(tx, s, [req.medicineKey]);
  // what this draft already holds of each batch is not available twice
  const held = await tx.chargeItem.groupBy({ by: ["batchId"], where: { invoiceId: inv.id }, _sum: { qty: true } });
  const left = own.map((b) => ({ ...asLike(b), qty: b.qtyOnHand - (held.find((h) => h.batchId === b.id)?._sum.qty ?? 0) }));
  const pick = fefoPick(left, req.qty, dhakaDay(now));
  if (pick.shortfall > 0) throw err(409, "stock_short", "কাউন্টারে যথেষ্ট স্টক নেই (মেয়াদোত্তীর্ণ ব্যাচ বাদে)", "Not enough usable stock at the counter (expired batches are never sold)", { field: "qty", shortfall: pick.shortfall });
  let pos = (await tx.chargeItem.findFirst({ where: { invoiceId: inv.id }, orderBy: { position: "desc" }, select: { position: true } }))?.position ?? 0;
  for (const a of pick.allocations) {
    const b = own.find((x) => x.id === a.batchId)!;
    const lineId = `ci_${randomUUID()}`; // a sale line is its own source (only desk lines have none)
    await tx.chargeItem.create({ data: {
      id: lineId, tenantId: s.tenantId, invoiceId: inv.id, position: ++pos, addedById: s.userId, source: "sale", sourceId: lineId, code: `med:${req.medicineKey}`, ...lineName(req.medicineKey),
      unitPaisa: b.mrpPaisa, vatRateBp: b.vatRateBp, batchId: b.id, medicineKey: req.medicineKey, ...lineAmounts(b.mrpPaisa, a.qty, b.vatRateBp),
    } });
  }
  return recompute(tx, inv, 0);
}

export async function removeOtcLine(tx: Tx, s: SessionData, id: string, lineId: string, rev: number): Promise<Inv> {
  const inv = await otcDraft(tx, s, id, rev);
  const n = await tx.chargeItem.deleteMany({ where: { id: lineId, invoiceId: inv.id, source: "sale" } });
  if (n.count !== 1) throw notFound();
  return recompute(tx, inv, 0);
}

const MAGIC: Record<RxPhotoRequest["contentType"], number[]> = { "image/jpeg": [0xff, 0xd8, 0xff], "image/png": [0x89, 0x50, 0x4e, 0x47] };
export async function addRxPhoto(tx: Tx, s: SessionData, id: string, req: RxPhotoRequest): Promise<Inv> {
  const inv = await otcDraft(tx, s, id, req.rev);
  if (inv.rxPhotoKey) throw err(409, "rx_photo_present", "প্রেসক্রিপশনের ছবি আগেই আছে", "This sale already has a prescription photo");
  const bytes = Buffer.from(req.dataBase64, "base64");
  if (bytes.length > RX_PHOTO_MAX) throw err(413, "too_large", "ছবি ৩ MB-এর বেশি", "The photo is over 3 MB", { field: "dataBase64" });
  if (!MAGIC[req.contentType].every((x, i) => bytes[i] === x)) throw err(400, "not_an_image", "ছবিটি JPEG বা PNG নয়", "The photo is not a JPEG or PNG", { field: "dataBase64" });
  const key = `tenants/${s.tenantId}/rx-photos/${inv.id}/${randomUUID()}.${req.contentType === "image/png" ? "png" : "jpg"}`;
  const n = await tx.invoice.updateMany({ where: { id: inv.id, rev: inv.rev, status: "draft", rxPhotoKey: null }, data: { rxPhotoKey: key, rev: inv.rev + 1 } });
  if (n.count !== 1) throw err(409, "stale", "অন্য কোথাও আগেই বদলানো হয়েছে — আবার খুলুন", "This bill was changed somewhere else first — reopen it");
  // the file is written last: a refused or stale request stores nothing (security review: no orphan prescription photos)
  await storage.put(key, bytes, req.contentType);
  return (await tx.invoice.findFirst({ where: { id: inv.id } }))!;
}
export async function rxPhoto(tx: Tx, s: SessionData, id: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const inv = await invoiceHere(tx, s, id);
  if (inv.kind !== "otc" || !inv.rxPhotoKey) throw notFound();
  const bytes = await storage.get(inv.rxPhotoKey);
  if (!bytes) throw notFound();
  return { bytes, contentType: inv.rxPhotoKey.endsWith(".png") ? "image/png" : "image/jpeg" };
}

/** Issue: the blockers again (class, photo, stock), then one `sale` move per line, then INVOICE issue. */
export async function issueOtc(tx: Tx, s: SessionData, id: string, rev: number, now: Date): Promise<Inv> {
  const inv = await otcDraft(tx, s, id, rev);
  const b = await otcBlockers(tx, inv, dhakaDay(now));
  if (b.length) throw err(422, "issue_blocked", "বিক্রি সম্পন্ন করা যাচ্ছে না", "The sale cannot be completed yet", { blockers: b });
  for (const l of await tx.chargeItem.findMany({ where: { invoiceId: inv.id }, orderBy: { position: "asc" } })) {
    await tx.stockMove.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, batchId: l.batchId!, kind: "sale", qty: -l.qty, refType: "sale", refId: l.id, byId: s.userId, at: now } });
  }
  return issueInvoice(tx, s, inv.id, rev, now, true);
}

/* ───── stock (read) ───── */
export async function stockList(tx: Tx, s: SessionData, q: string, filter: "all" | "near-expiry" | "expired" | "low", now: Date): Promise<StockList> {
  const today = dhakaDay(now);
  const t = q.toLowerCase();
  const meds = MEDICINES_SAMPLE.filter((m) => !t || `${m.brand} ${m.brandBn} ${m.generic} ${m.id}`.toLowerCase().includes(t));
  const batches = await tx.stockBatch.findMany({ where: { organizationId: s.organizationId, medicineKey: { in: meds.map((m) => m.id) } }, orderBy: [{ expiry: "asc" }, { id: "asc" }] });
  const items = meds.map((m) => {
    const own = batches.filter((b) => b.medicineKey === m.id);
    const usable = (loc: string[]) => own.filter((b) => loc.includes(b.location) && batchState(asLike(b), today) === "usable").reduce((a, b) => a + b.qtyOnHand, 0);
    return {
      medicine: medRef(m.id), counterQty: usable(PICK), storeQty: usable(["store"]),
      nearExpiryQty: own.filter((b) => b.location !== "quarantine" && nearExpiry(b.expiry, today)).reduce((a, b) => a + b.qtyOnHand, 0),
      expiredQty: own.filter((b) => batchState(asLike(b), today) === "expired").reduce((a, b) => a + b.qtyOnHand, 0),
      batches: own.map((b) => batchView(b, today)),
    };
  }).filter((x) => filter === "all" ? true : filter === "near-expiry" ? x.nearExpiryQty > 0 : filter === "expired" ? x.expiredQty > 0 : x.counterQty < LOW_STOCK);
  return { items, today };
}
/** "Low" on the stock list: fewer than this many usable at the counter (sample threshold; a per-item reorder level comes with purchasing). */
const LOW_STOCK = 100;
