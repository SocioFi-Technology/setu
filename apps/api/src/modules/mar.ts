/* The medication administration record (ADR 0015, walkthrough B5). Every dose is against an active inpatient order of
   this patient (never free-typed); the rules are @setu/domain mar.ts doseBlockers, re-checked by the database. The
   witness PIN is verified inside the dose's transaction (a wrong one rolls everything back and counts against the
   witness). A dose given from ward stock takes its issue units (FEFO); a controlled drug writes its register line. */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { DoseRecord, DoseRequest, MarOrder, MarView, WristbandView } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  DOSE_REASON_MIN, DOSE_WINDOW_MIN, PRN_WINDOW_MS, allergyMatches, dhakaDay, doseBlockers, doseConsumption, doseErrorNeedsAnswer, doseErrorReturns, doseTiming, marSlotRange, type StockDrawn, slotState, slotsBetween, wardStockLocation, type DoseOutcome,
  parseBatchLabel, parseWristband, scanBlockers, wristbandCode, wristbandPayload, type BandScan, type MedScan,
} from "@setu/domain";
import type { AuditEntry } from "../command.js";
import { HttpError, err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { activeAllergyFacts, toAllergyView } from "./consultation.js";
import { getPatient, notFound, toSummary } from "./frontdesk.js";
import { closedVisit, erPatientOf, inpatientHere, iso, peopleOf, stale, type Inpatient } from "./inpatient.js";
import { config } from "../config.js";
import { qrSvg } from "../receipts/template.js";
import { requirePin } from "./pin.js";
import { devHash } from "./users.js";

type Med = NonNullable<Awaited<ReturnType<Tx["medicine"]["findFirst"]>>>;
type Order = NonNullable<Awaited<ReturnType<Tx["medicationRequest"]["findFirst"]>>>;
type Admin = NonNullable<Awaited<ReturnType<Tx["medicationAdministration"]["findFirst"]>>>;
const CURRENT = ["final", "amended"];
const DHAKA_MS = 6 * 3600_000;
export const SAMPLE_NOTE = { bn: "ক্লিনিশিয়ানের অনুমোদন বাকি (নমুনা নিয়ম)", en: "Pending clinician sign-off (sample rule)" };
export const medWire = (m: Med) => ({ key: m.key, brand: m.brand, brandBn: m.brandBn, generic: m.generic, strength: m.strength, form: m.form, issueUnit: m.issueUnit, routes: m.routes, highAlert: m.highAlert, controlled: m.controlled, multiDose: m.multiDose, inpatientOnly: m.inpatientOnly, sample: true as const });
export const requireNurse = (s: SessionData) => { if (s.role !== "nurse") throw err(403, "forbidden", "ওষুধ দেওয়া নথিভুক্ত করেন নার্স", "A nurse records doses", { reason: "role", canRequest: false }); };

/** The visit's inpatient orders with their note's state (active = active and the note current). */
export async function ordersOf(tx: Tx, encounterIds: string[]) {
  if (!encounterIds.length) return [];
  const rows = await tx.medicationRequest.findMany({ where: { encounterId: { in: encounterIds }, kind: "inpatient" }, include: { composition: { select: { status: true, signedById: true, authorId: true, id: true } } }, orderBy: [{ startAt: "asc" }, { position: "asc" }] });
  return rows.filter((r) => r.composition.status !== "draft");
}
export const isActive = (o: Order & { composition: { status: string } }) => o.orderStatus === "active" && CURRENT.includes(o.composition.status);
/** Doses due now and overdue (window passed, nothing recorded) per visit, over the last 24 hours. */
export async function doseCounts(tx: Tx, encounterIds: string[], now: Date): Promise<Map<string, { due: number; overdue: number }>> {
  const out = new Map<string, { due: number; overdue: number }>();
  const orders = (await ordersOf(tx, encounterIds)).filter(isActive);
  const recs = orders.length ? await tx.medicationAdministration.findMany({ where: { regimenId: { in: orders.map((o) => o.regimenId!) }, scheduledFor: { not: null }, status: { not: "entered_in_error" } }, select: { regimenId: true, scheduledFor: true } }) : [];
  const done = new Set(recs.map((r) => `${r.regimenId}|${r.scheduledFor!.getTime()}`));
  for (const id of encounterIds) out.set(id, { due: 0, overdue: 0 });
  for (const o of orders) {
    for (const slot of slotsBetween({ times: o.times, prn: o.prn, startAt: o.startAt! }, new Date(now.getTime() - 24 * 3600_000), new Date(now.getTime() + DOSE_WINDOW_MIN * 60_000))) {
      if (done.has(`${o.regimenId}|${slot.getTime()}`)) continue;
      const st = slotState(slot, now), c = out.get(o.encounterId)!;
      if (st === "due") c.due++; else if (st === "overdue") c.overdue++;
    }
  }
  return out;
}

type StockOf = Map<string, { taken: number; returned: number }>;
function recordWire(a: Admin, who: Awaited<ReturnType<typeof peopleOf>>, st: StockOf = new Map()): DoseRecord {
  return {
    id: a.id, status: a.status === "entered_in_error" ? "entered-in-error" : a.status, administeredAt: a.administeredAt.toISOString(), scheduledFor: iso(a.scheduledFor),
    timing: a.timing as DoseRecord["timing"], reason: a.reason, source: a.source as DoseRecord["source"], by: who(a.administeredById), preparedBy: who(a.preparedById),
    witness: a.witnessedById ? who(a.witnessedById) : null, checks: { patient: a.checkPatient, drug: a.checkDrug, dose: a.checkDose, route: a.checkRoute, time: a.checkTime },
    error: a.errorAt ? { reason: a.errorReason ?? "", by: who(a.errorById), at: a.errorAt.toISOString() } : null,
    amountGiven: a.amountGiven,
    stockTaken: st.get(a.id)?.taken ?? 0, returned: st.get(a.id)?.returned ?? 0, errorStockDrawn: (a.errorStockDrawn ?? null) as DoseRecord["errorStockDrawn"],
    scan: { band: a.scanBandAt !== null, medBatchId: a.scanMedBatchId, override: a.scanOverrideReason },
  };
}
async function wardStockOf(tx: Tx, s: SessionData, wardId: string | null, keys: string[], today: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!wardId || !keys.length) return out;
  const rows = await tx.stockBatch.findMany({ where: { organizationId: s.organizationId, location: wardStockLocation(wardId), medicineKey: { in: keys }, qtyOnHand: { gt: 0 }, expiry: { gte: today } }, select: { medicineKey: true, qtyOnHand: true } });
  for (const r of rows) out.set(r.medicineKey, (out.get(r.medicineKey) ?? 0) + r.qtyOnHand);
  return out;
}

export async function marView(tx: Tx, s: SessionData, encounterId: string, now: Date, dayParam?: string): Promise<{ view: MarView; patientId: string }> {
  const ip = await inpatientHere(tx, s, encounterId);
  const day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : dhakaDay(now);
  const dayStart = new Date(new Date(`${day}T00:00:00Z`).getTime() - DHAKA_MS), dayEnd = new Date(dayStart.getTime() + 864e5 - 1);
  const orders = await ordersOf(tx, [ip.e.id]);
  const shown = orders.filter((o) => isActive(o) || (o.stoppedAt && o.stoppedAt >= dayStart) || o.orderStatus === "superseded" && o.startAt! >= new Date(now.getTime() - 864e5));
  const meds = new Map((await tx.medicine.findMany({ where: { key: { in: [...new Set(orders.map((o) => o.medicineKey))] } } })).map((m) => [m.key, m]));
  const regimens = [...new Set(orders.map((o) => o.regimenId!))];
  const recs = regimens.length ? await tx.medicationAdministration.findMany({ where: { regimenId: { in: regimens } }, orderBy: { administeredAt: "asc" } }) : [];
  // vials belong to the patient's visit and the medicine, not the regimen: a dose change keeps the open vial
  const vials = await tx.multiDoseVial.findMany({ where: { encounterId: ip.e.id }, orderBy: { openedAt: "desc" } });
  const allergies = await tx.allergyIntolerance.findMany({ where: { patientId: ip.e.patientId }, orderBy: [{ status: "asc" }, { recordedAt: "asc" }] });
  const facts = await activeAllergyFacts(tx, ip.e.patientId);
  const who = await peopleOf(tx, [...recs.flatMap((r) => [r.administeredById, r.preparedById, r.witnessedById, r.errorById]), ...orders.flatMap((o) => [o.composition.signedById, o.stoppedById]), ...vials.map((v) => v.openedById)]);
  const stock = await wardStockOf(tx, s, ip.ward?.id ?? null, [...meds.keys()], dhakaDay(now));
  const live = recs.filter((r) => r.status !== "entered_in_error");
  // units each dose took from the ward, and what an errored one put back ("stock not drawn")
  const st: StockOf = new Map();
  if (recs.length) for (const m of await tx.stockMove.findMany({ where: { organizationId: s.organizationId, refId: { in: recs.map((r) => r.id) }, refType: { in: ["administration", "dose-error"] } }, select: { refId: true, refType: true, qty: true } })) {
    const x = st.get(m.refId!) ?? { taken: 0, returned: 0 };
    if (m.refType === "administration") x.taken += -m.qty; else x.returned += m.qty;
    st.set(m.refId!, x);
  }
  const out: MarOrder[] = shown.map((o) => {
    const m = meds.get(o.medicineKey)!;
    const mine = live.filter((r) => r.regimenId === o.regimenId);
    const active = isActive(o);
    // today's MAR also carries the last 24 hours' slots (the board's overdue count counts them): see marSlotRange
    const range = marSlotRange(dayStart, now);
    const slots = active ? slotsBetween({ times: o.times, prn: o.prn, startAt: o.startAt! }, range.from, range.to).flatMap((at) => {
      const rec = mine.find((r) => r.scheduledFor?.getTime() === at.getTime());
      const errored = recs.filter((r) => r.regimenId === o.regimenId && r.status === "entered_in_error" && r.scheduledFor?.getTime() === at.getTime()).map((r) => recordWire(r, who, st));
      return [{ at: at.toISOString(), state: (rec ? rec.status : slotState(at, now)) as MarOrder["slots"][number]["state"], record: rec ? recordWire(rec, who, st) : null, errored }];
    }) : [];
    const vial = vials.find((v) => v.medicineKey === o.medicineKey);
    return {
      id: o.id, regimenId: o.regimenId!, noteId: o.compositionId, medicine: medWire(m), route: o.route!, doseText: o.doseText!, doseQty: o.doseQty, times: o.times, prn: o.prn, prnMaxPer24h: o.prnMaxPer24h,
      startAt: o.startAt!.toISOString(), status: o.orderStatus, orderedBy: who(o.composition.signedById), stop: o.stoppedAt ? { by: who(o.stoppedById), at: o.stoppedAt.toISOString(), reason: o.stopReason ?? "" } : null,
      slots, prnRecords: o.prn ? mine.filter((r) => r.administeredAt >= dayStart && r.administeredAt <= dayEnd).map((r) => recordWire(r, who, st)) : [],
      givenLast24h: mine.filter((r) => r.status === "given" && r.administeredAt.getTime() > now.getTime() - PRN_WINDOW_MS).length,
      vial: vial ? { openedAt: vial.openedAt.toISOString(), by: who(vial.openedById), source: vial.source as "ward-stock" } : null,
      allergyBlock: active && allergyMatches(m, facts).length > 0, wardStock: stock.get(o.medicineKey) ?? 0,
      earlierRegimenGiven: live.filter((r) => r.medicineKey === o.medicineKey && r.regimenId !== o.regimenId && r.status === "given" && r.administeredAt.getTime() > now.getTime() - PRN_WINDOW_MS).map((r) => ({ at: r.administeredAt.toISOString(), doseText: r.doseText })),
    };
  });
  const names = new Map(orders.map((o) => [o.id, meds.get(o.medicineKey)?.brand ?? o.medicineKey]));
  return {
    patientId: ip.e.patientId,
    view: {
      encounterId: ip.e.id, patient: toSummary(await getPatient(tx, ip.e.patientId)), allergies: await toAllergyView(tx, allergies),
      bed: ip.bed && ip.ward ? { id: ip.bed.id, name: ip.bed.name, ward: ip.ward.name, wardId: ip.ward.id } : null,
      day, now: now.toISOString(), orders: out, windowMin: DOSE_WINDOW_MIN, sample: SAMPLE_NOTE,
      history: recs.filter((r) => r.administeredAt >= dayStart && r.administeredAt <= dayEnd).map((r) => ({ ...recordWire(r, who, st), orderId: r.requestId, medicine: names.get(r.requestId) ?? r.medicineKey })),
    },
  };
}

/** Takes `qty` issue units of a medicine from the ward (FEFO, not expired): one move per batch; 409 when short. */
async function takeFromWard(tx: Tx, s: SessionData, wardId: string, medicineKey: string, qty: number, ref: { type: string; id: string }, now: Date, preferBatchId: string | null = null) {
  const found = await tx.stockBatch.findMany({ where: { organizationId: s.organizationId, location: wardStockLocation(wardId), medicineKey, qtyOnHand: { gt: 0 }, expiry: { gte: dhakaDay(now) } }, orderBy: [{ expiry: "asc" }, { id: "asc" }] });
  // the batch whose label was scanned goes first (ADR 0016), then first-expiry
  const batches = [...found.filter((b) => b.id === preferBatchId), ...found.filter((b) => b.id !== preferBatchId)];
  const have = batches.reduce((a, b) => a + b.qtyOnHand, 0);
  if (have < qty) throw err(409, "stock_short", "ওয়ার্ডে স্টক নেই — ইনডেন্ট দিন", "Not enough ward stock — raise an indent", { shortfall: qty - have });
  const moves: { moveId: string; batchId: string; qty: number; after: number }[] = [];
  let left = qty;
  for (const b of batches) {
    if (left <= 0) break;
    const n = Math.min(left, b.qtyOnHand);
    const mv = await tx.stockMove.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, batchId: b.id, kind: "administer", qty: -n, refType: ref.type, refId: ref.id, byId: s.userId, at: now } });
    moves.push({ moveId: mv.id, batchId: b.id, qty: n, after: b.qtyOnHand - n });
    left -= n;
  }
  return moves;
}
/** The witness: a nurse or a doctor of this facility; their PIN is checked here, inside the dose's transaction. */
async function witnessRole(tx: Tx, s: SessionData, userId: string): Promise<"nurse" | "doctor" | null> {
  const roles = await tx.practitionerRole.findMany({ where: { userId, organizationId: s.organizationId, role: { in: ["nurse", "doctor"] }, user: { active: true } }, select: { role: true } });
  return roles.some((r) => r.role === "nurse") ? "nurse" : roles.some((r) => r.role === "doctor") ? "doctor" : null;
}
async function verifyWitnessPin(tx: Tx, userId: string, pin: string) {
  const u = await tx.user.findFirst({ where: { id: userId }, select: { pinHash: true } });
  try { await requirePin(userId, () => Boolean(u?.pinHash) && u!.pinHash === devHash(pin)); }
  catch (e) {
    if (e instanceof HttpError && e.body.code === "pin_wrong") throw err(401, "witness_pin_wrong", "সাক্ষীর পিন ভুল", "The witness's PIN is wrong", { field: "witness.pin", triesLeft: e.body.triesLeft });
    if (e instanceof HttpError && e.body.code === "pin_locked") throw err(423, "witness_pin_locked", "সাক্ষীর পিন ১৫ মিনিটের জন্য বন্ধ", "The witness's PIN is locked for 15 minutes", { lockedUntil: e.body.lockedUntil });
    throw e;
  }
}

export async function recordDose(tx: Tx, s: SessionData, encounterId: string, req: DoseRequest, now: Date): Promise<{ view: MarView; audit: AuditEntry[] }> {
  requireNurse(s);
  const ip = await inpatientHere(tx, s, encounterId);
  const o = await tx.medicationRequest.findFirst({ where: { id: req.requestId, kind: "inpatient" }, include: { composition: { select: { status: true, organizationId: true } } } });
  if (!o || o.composition.organizationId !== s.organizationId) throw notFound();
  const m = (await tx.medicine.findFirst({ where: { key: o.medicineKey } }))!;
  const recorded = await tx.medicationAdministration.findMany({ where: { regimenId: o.regimenId!, status: { not: "entered_in_error" } }, select: { scheduledFor: true, status: true, administeredAt: true } });
  const administeredAt = new Date(req.administeredAt), slot = req.scheduledFor ? new Date(req.scheduledFor) : null;
  const preparedById = req.preparedById ?? s.userId;
  const wRole = req.witness ? await witnessRole(tx, s, req.witness.userId) : null;
  // the same medicine given under an earlier regimen near this dose (a changed order starts a new regimen and its slots)
  const windowMs = DOSE_WINDOW_MIN * 60_000;
  const earlierGivenNear = req.outcome === "given" && (await tx.medicationAdministration.count({ where: {
    encounterId: ip.e.id, medicineKey: o.medicineKey, regimenId: { not: o.regimenId! }, status: "given",
    administeredAt: { gte: new Date(administeredAt.getTime() - windowMs), lte: new Date(administeredAt.getTime() + windowMs) } } })) > 0;
  const vialOpen = m.multiDose ? (await tx.multiDoseVial.count({ where: { encounterId: ip.e.id, medicineKey: o.medicineKey, source: "ward-stock", openedAt: { lte: new Date(administeredAt.getTime() + 120_000) } } })) > 0 : undefined;
  const blockers = doseBlockers(
    { status: o.orderStatus, noteCurrent: CURRENT.includes(o.composition.status), patientId: o.patientId, encounterId: o.encounterId, encounterOpen: ip.open, startAt: o.startAt ?? now,
      times: o.times, prn: o.prn, prnMaxPer24h: o.prnMaxPer24h, medicineKey: o.medicineKey, highAlert: m.highAlert, controlled: m.controlled, multiDose: m.multiDose },
    { patientId: ip.e.patientId, encounterId: ip.e.id, outcome: req.outcome as DoseOutcome, slot, administeredAt, now, checks: req.checks, reason: req.reason ?? null,
      recordedSlots: recorded.filter((r) => r.scheduledFor).map((r) => r.scheduledFor!.getTime()),
      givenLast24h: recorded.filter((r) => r.status === "given" && r.administeredAt.getTime() > administeredAt.getTime() - PRN_WINDOW_MS && r.administeredAt <= administeredAt).length,
      nurseId: s.userId, preparedById, witnessId: req.witness?.userId ?? null, witnessRole: wRole, allergies: await activeAllergyFacts(tx, ip.e.patientId),
      source: req.source, amountGiven: req.amountGiven ?? null, vialOpen, earlierGivenNear },
  );
  // ADR 0016 scan-to-verify: the wristband (signed, this admission) and, from ward stock, the medicine label (a ward batch of
  // this medicine on this patient's ward, in date); "scanner not working" with a reason, never for high-alert / controlled
  const scan = await verifyScans(tx, s, ip, o.medicineKey, m.multiDose, req.scan, now);
  const scanB = scanBlockers({ outcome: req.outcome as DoseOutcome, source: req.source, highAlert: m.highAlert, controlled: m.controlled, band: scan.band, med: scan.med, overrideReason: req.scan?.overrideReason ?? null });
  if (scanB.some((b) => b.endsWith("_mismatch") || b === "med_expired" || b === "med_not_on_ward")) {
    // a wrong scan is audited even though the dose is refused (its own transaction — the refusal rolls this one back)
    const { forTenant } = await import("@setu/db");
    await forTenant(s.tenantId, (t2) => t2.auditEvent.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, userId: s.userId, role: s.role, action: "update", entity: "MedicationAdministration", entityId: o.id, patientId: ip.e.patientId, detail: { event: "scan-mismatch", blockers: scanB, band: scan.band, med: scan.med, scannedBand: scan.bandSeen, scannedBatch: scan.batchSeen } } }), { userId: s.userId }).catch((e: unknown) => { console.error("scan-mismatch audit failed", e); });
  }
  blockers.push(...(scanB as unknown as typeof blockers));
  if (blockers.length) throw err(422, "dose_blocked", "নথিভুক্ত হয়নি — নিচের বিষয়গুলো ঠিক করুন", "Not recorded — resolve the items below", { blockers: blockers as unknown as Record<string, unknown>[] });
  if (preparedById !== s.userId && !(await witnessRole(tx, s, preparedById))) throw err(400, "preparer_unknown", "প্রস্তুতকারী এই প্রতিষ্ঠানের নার্স বা ডাক্তার নন", "The preparer is not a nurse or doctor of this facility", { field: "preparedById" });
  const witnessed = req.outcome === "given" && (m.highAlert || m.controlled);
  if (witnessed) await verifyWitnessPin(tx, req.witness!.userId, req.witness!.pin);
  const id = `ma_${randomUUID()}`;
  const audit: AuditEntry[] = [];
  // stock first (its moves reference the dose), then the dose, then the register lines
  let moves: Awaited<ReturnType<typeof takeFromWard>> = [];
  const units = req.outcome === "given" ? doseConsumption(m, o.doseQty, req.source) : 0;
  if (units > 0) {
    if (!ip.ward) throw err(409, "no_ward", "রোগী কোনো ওয়ার্ডের শয্যায় নেই", "The patient is not on a ward bed");
    moves = await takeFromWard(tx, s, ip.ward.id, o.medicineKey, units, { type: "administration", id }, now, scan.batchId);
  }
  const timing = doseTiming(slot, administeredAt);
  try {
    await tx.medicationAdministration.create({ data: {
      id, tenantId: s.tenantId, organizationId: s.organizationId, encounterId: ip.e.id, patientId: ip.e.patientId, requestId: o.id, regimenId: o.regimenId!, medicineKey: o.medicineKey,
      scheduledFor: slot, status: req.outcome, administeredAt, administeredById: s.userId, preparedById,
      checkPatient: req.checks.patient, checkDrug: req.checks.drug, checkDose: req.checks.dose, checkRoute: req.checks.route, checkTime: req.checks.time,
      timing, reason: req.reason?.trim() || null, route: o.route!, doseText: o.doseText!, doseQty: o.doseQty, amountGiven: m.multiDose && req.outcome === "given" ? req.amountGiven?.trim() || null : null, source: req.source, stockRef: moves.length ? id : null,
      highAlert: m.highAlert, controlled: m.controlled, witnessedById: witnessed ? req.witness!.userId : null, witnessedAt: witnessed ? now : null,
      ...(req.outcome === "given" ? { scanBandAt: scan.band === "match" ? now : null, scanMedBatchId: scan.med === "match" ? scan.batchId : null,
        scanOverrideReason: scan.band === "match" && (req.source !== "ward-stock" || scan.med === "match") ? null : req.scan?.overrideReason?.trim() || null } : {}),
    } });
  } catch (x) {
    if (typeof x === "object" && x !== null && (x as { code?: string }).code === "P2002") throw err(422, "dose_blocked", "এই সময়ের ডোজ আগেই নথিভুক্ত", "This slot is already recorded", { blockers: ["slot_recorded"] as unknown as Record<string, unknown>[] });
    throw x;
  }
  if (m.controlled) for (const mv of moves) await tx.controlledDrugRegister.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, medicineKey: o.medicineKey, kind: "administer", stockMoveId: mv.moveId, batchId: mv.batchId, qty: -mv.qty, location: wardStockLocation(ip.ward!.id),
    balanceAfter: mv.after, encounterId: ip.e.id, patientId: ip.e.patientId, administrationId: id, byId: s.userId, witnessId: req.witness?.userId ?? null, at: now } });
  audit.push({ action: "create", entity: "MedicationAdministration", entityId: id, patientId: ip.e.patientId, detail: { requestId: o.id, medicineKey: o.medicineKey, outcome: req.outcome, slot: iso(slot), timing, source: req.source, units, witness: witnessed ? req.witness!.userId : null, highAlert: m.highAlert, controlled: m.controlled, amountGiven: req.amountGiven ?? null, earlierGivenNear, scan: { band: scan.band, med: scan.med, override: Boolean(req.scan?.overrideReason) && !(scan.band === "match" && (req.source !== "ward-stock" || scan.med === "match")) } } });
  return { view: (await marView(tx, s, ip.e.id, now)).view, audit };
}

export async function markDoseError(tx: Tx, s: SessionData, id: string, reason: string, now: Date, stockDrawn: StockDrawn | null = null): Promise<{ view: MarView; audit: AuditEntry[] }> {
  requireNurse(s);
  const a = await tx.medicationAdministration.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!a) throw notFound();
  if (reason.trim().length < DOSE_REASON_MIN) throw err(400, "reason_required", "কারণ লিখুন (অন্তত ৫ অক্ষর)", "Give a reason (at least 5 characters)", { field: "reason" });
  if (a.status === "entered_in_error") throw err(409, "already_in_error", "আগেই ভুল হিসেবে চিহ্নিত", "Already marked entered-in-error");
  if (a.administeredById !== s.userId) throw err(403, "forbidden", "যিনি নথিভুক্ত করেছেন শুধু তিনিই ভুল চিহ্নিত করেন", "Only the nurse who recorded it marks it entered-in-error", { reason: "role", canRequest: false });
  const ip = await inpatientHere(tx, s, a.encounterId);
  if (!ip.open) throw err(409, "closed_visit", "ভর্তি বন্ধ — নথি বদলানো যায় না", "The admission is closed — the record cannot change");
  // Kamrul, 06/10/2026: a dose that took ward stock asks "was the stock drawn?" — "no" puts the units back
  const taken = await tx.stockMove.findMany({ where: { organizationId: s.organizationId, refType: "administration", refId: a.id }, include: { batch: true } });
  const units = taken.reduce((x, m) => x - m.qty, 0);
  if (doseErrorNeedsAnswer(units) && !stockDrawn) throw err(400, "stock_answer_required", "স্টক কি তোলা হয়েছিল? — হ্যাঁ, না বা নিশ্চিত নই বাছুন", "Was the stock drawn? — answer yes, no or not sure", { field: "stockDrawn" });
  const answer = doseErrorNeedsAnswer(units) ? stockDrawn : null;
  const n = await tx.medicationAdministration.updateMany({ where: { id: a.id, status: a.status }, data: { status: "entered_in_error", errorReason: reason.trim(), errorById: s.userId, errorAt: now, errorStockDrawn: answer } });
  if (n.count !== 1) throw stale();
  const back = doseErrorReturns(answer, taken.map((m) => ({ batchId: m.batchId, qty: -m.qty })));
  const note = `${reason.trim()} — stock drawn: ${answer ?? "n/a"}`;
  const returnedMoves: { moveId: string; batchId: string; qty: number; after: number; location: string }[] = [];
  for (const r of back) {
    const b = taken.find((m) => m.batchId === r.batchId)!.batch;
    const mv = await tx.stockMove.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, batchId: r.batchId, kind: "ward-return", qty: r.qty, refType: "dose-error", refId: a.id, reason: reason.trim(), byId: s.userId, at: now } });
    const after = (await tx.stockBatch.findFirst({ where: { id: r.batchId }, select: { qtyOnHand: true } }))!.qtyOnHand;
    returnedMoves.push({ moveId: mv.id, batchId: r.batchId, qty: r.qty, after, location: b.location });
  }
  // the controlled register is never changed: a linked dose-error line notes the error (and adds back any return)
  if (a.controlled && units > 0) {
    const base = { tenantId: s.tenantId, organizationId: s.organizationId, medicineKey: a.medicineKey, kind: "dose-error", encounterId: a.encounterId, patientId: a.patientId, administrationId: a.id, byId: s.userId, note, at: now };
    if (returnedMoves.length) for (const m of returnedMoves) await tx.controlledDrugRegister.create({ data: { ...base, stockMoveId: m.moveId, batchId: m.batchId, qty: m.qty, location: m.location, balanceAfter: m.after } });
    else {
      const b0 = taken[0]!.batch; const now0 = (await tx.stockBatch.findFirst({ where: { id: b0.id }, select: { qtyOnHand: true } }))!.qtyOnHand;
      await tx.controlledDrugRegister.create({ data: { ...base, batchId: b0.id, qty: 0, location: b0.location, balanceAfter: now0 } });
    }
  }
  return { view: (await marView(tx, s, a.encounterId, now)).view, audit: [{ action: "update", entity: "MedicationAdministration", entityId: a.id, patientId: a.patientId, detail: { event: "markError", from: a.status, reason: reason.trim(), stockDrawn: answer, unitsTaken: units, returned: returnedMoves.reduce((x, m) => x + m.qty, 0) } }] };
}

/** A multi-dose vial opened (insulin, heparin): one unit out of the ward (or the patient's own), opened-at kept. */
export async function openVial(tx: Tx, s: SessionData, encounterId: string, req: { requestId: string; openedAt: string; source: "ward-stock" | "patient-supplied" }, now: Date): Promise<{ view: MarView; audit: AuditEntry[] }> {
  requireNurse(s);
  const ip: Inpatient = await inpatientHere(tx, s, encounterId);
  if (!ip.open) throw closedVisit();
  const o = await tx.medicationRequest.findFirst({ where: { id: req.requestId, kind: "inpatient", encounterId: ip.e.id }, include: { composition: { select: { status: true } } } });
  if (!o) throw notFound();
  if (!isActive(o)) throw err(422, "order_not_active", "অর্ডারটি সক্রিয় নয়", "The order is not active");
  const m = (await tx.medicine.findFirst({ where: { key: o.medicineKey } }))!;
  if (!m.multiDose) throw err(422, "not_multi_dose", "এটি বহু-ডোজের ভায়াল নয়", "Not a multi-dose vial");
  const openedAt = new Date(req.openedAt);
  if (openedAt.getTime() > now.getTime() + 2 * 60_000) throw err(400, "future_time", "ভবিষ্যতের সময় নয়", "Not a future time", { field: "openedAt" });
  const id = `vial_${randomUUID()}`;
  let moves: Awaited<ReturnType<typeof takeFromWard>> = [];
  if (req.source === "ward-stock") {
    if (!ip.ward) throw err(409, "no_ward", "রোগী কোনো ওয়ার্ডের শয্যায় নেই", "The patient is not on a ward bed");
    moves = await takeFromWard(tx, s, ip.ward.id, o.medicineKey, 1, { type: "vial-open", id }, now);
  }
  await tx.multiDoseVial.create({ data: { id, tenantId: s.tenantId, organizationId: s.organizationId, encounterId: ip.e.id, patientId: ip.e.patientId, requestId: o.id, regimenId: o.regimenId!, medicineKey: o.medicineKey, source: req.source, stockRef: moves.length ? id : null, openedAt, openedById: s.userId } });
  return { view: (await marView(tx, s, ip.e.id, now)).view, audit: [{ action: "create", entity: "MultiDoseVial", entityId: id, patientId: ip.e.patientId, detail: { requestId: o.id, medicineKey: o.medicineKey, source: req.source, openedAt: openedAt.toISOString() } }] };
}

export async function witnesses(tx: Tx, s: SessionData) {
  const rows = await tx.practitionerRole.findMany({ where: { organizationId: s.organizationId, role: { in: ["nurse", "doctor"] }, user: { active: true }, userId: { not: s.userId } }, include: { user: { select: { id: true, nameBn: true, nameEn: true } } }, orderBy: [{ role: "desc" }, { userId: "asc" }] });
  const seen = new Set<string>();
  return { items: rows.filter((r) => !seen.has(r.userId) && seen.add(r.userId)).map((r) => ({ id: r.user.id, nameBn: r.user.nameBn, nameEn: r.user.nameEn, role: r.role as "nurse" | "doctor" })) };
}
export { stale };

/* ───── ADR 0016: scans and the wristband ───── */
const wristbandSig = (admissionId: string, facilityNo: string, printNo: number) => createHmac("sha256", config.wristbandSecret).update(`wristband:${wristbandPayload(admissionId, facilityNo, printNo)}`).digest("base64url").slice(0, 22);
export const wristbandOf = (admissionId: string, facilityNo: string, printNo: number) => wristbandCode(admissionId, facilityNo, printNo, wristbandSig(admissionId, facilityNo, printNo));
async function verifyScans(tx: Tx, s: SessionData, ip: Awaited<ReturnType<typeof inpatientHere>>, medicineKey: string, multiDose: boolean, scan: DoseRequest["scan"], now: Date): Promise<{ band: BandScan; med: MedScan; batchId: string | null; bandSeen: string | null; batchSeen: string | null }> {
  let band: BandScan = "none";
  if (scan?.band) {
    const w = parseWristband(scan.band);
    const sigOk = w ? timingSafeEq(w.sig, wristbandSig(w.admissionId, w.facilityNo, w.printNo)) : false;
    // only the latest print verifies: a reprint retires every earlier band (review)
    const latest = await tx.wristbandPrint.count({ where: { admissionId: ip.adm.id } });
    band = w && sigOk && w.admissionId === ip.adm.id && w.facilityNo === ip.e.patient.facilityNo && w.printNo === latest ? "match" : "mismatch";
  }
  let med: MedScan = "none"; let batchId: string | null = null;
  if (scan?.med) {
    const id = parseBatchLabel(scan.med);
    const b = id ? await tx.stockBatch.findFirst({ where: { id, organizationId: s.organizationId } }) : null;
    if (!b || b.medicineKey !== medicineKey) med = "mismatch";
    else if (!ip.ward || b.location !== wardStockLocation(ip.ward.id)) med = "not-on-ward";
    else if (b.expiry < dhakaDay(now)) med = "expired";
    else if (!multiDose && b.qtyOnHand <= 0) med = "empty";
    else { med = "match"; batchId = b.id; }
  }
  const w0 = scan?.band ? parseWristband(scan.band) : null;
  return { band, med, batchId, bandSeen: w0 ? `${w0.admissionId}/${w0.facilityNo}/#${w0.printNo}` : scan?.band ? "unreadable" : null, batchSeen: scan?.med ? parseBatchLabel(scan.med) ?? "unreadable" : null };
}
const timingSafeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Print the wristband: the first at admission; a reprint needs a reason (≥5). Returns what the band carries. */
export async function printWristband(tx: Tx, s: SessionData, encounterId: string, reason: string | undefined, now: Date): Promise<{ view: WristbandView; audit: AuditEntry[] }> {
  const ip = await inpatientHere(tx, s, encounterId);
  const before = await tx.wristbandPrint.count({ where: { admissionId: ip.adm.id } });
  if (before > 0 && (reason ?? "").trim().length < 5) throw err(400, "reason_required", "আবার ছাপার কারণ লিখুন (অন্তত ৫ অক্ষর)", "Give the reason for the reprint (at least 5 characters)", { field: "reason" });
  await tx.wristbandPrint.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, admissionId: ip.adm.id, encounterId: ip.e.id, patientId: ip.e.patientId, reason: before > 0 ? reason!.trim() : null, printedById: s.userId, printedAt: now } });
  const facts = await activeAllergyFacts(tx, ip.e.patientId);
  return {
    view: { code: wristbandOf(ip.adm.id, ip.e.patient.facilityNo, before + 1), qrSvg: qrSvg(wristbandOf(ip.adm.id, ip.e.patient.facilityNo, before + 1)), patient: erPatientOf(ip.e.patient), admissionNumber: ip.adm.number, bed: ip.bed?.name ?? null, ward: ip.ward?.name ?? null, printedBefore: before, allergies: facts.map((f) => f.labelEn) },
    audit: [{ action: before > 0 ? "reprint" : "print", entity: "Wristband", entityId: ip.adm.id, patientId: ip.e.patientId, detail: { reason: before > 0 ? reason!.trim() : null } }],
  };
}

