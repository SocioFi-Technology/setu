/* Nursing on the ward (ADR 0015, walkthrough B4 / B6): the ward list and board per bed, ward vitals with NEWS2 and the
   escalation rule (sample, pending clinician sign-off), the escalation log, nursing notes, the patient on the ward. */
import { randomUUID } from "node:crypto";
import type { Escalation, NursingNoteView, WardBoard, WardPatientView, WardVitalsRequest, WardVitalsResponse } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  ESCALATION, NEWS2_SAMPLE_NOTE, NEWS2_THRESHOLD_SAMPLE, NURSING_NOTE, assessVitals, consciousnessCode, informBlockers, news2, nextObsMinutes, noteOk, rrPossible, shouldEscalate, transition,
} from "@setu/domain";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { toAllergyView } from "./consultation.js";
import { getPatient, notFound, toSummary } from "./frontdesk.js";
import { closedVisit, dayOfStay, erPatientOf, inpatientHere, iso, latestNews2, news2OfBatch, peopleOf, stale, type Enc } from "./inpatient.js";
import { deliverInApp } from "./lab.js";
import { doseCounts } from "./mar.js";

const rule = () => ({ threshold: NEWS2_THRESHOLD_SAMPLE, sample: true as const, note: { ...NEWS2_SAMPLE_NOTE } });
type Esc = NonNullable<Awaited<ReturnType<Tx["escalationEvent"]["findFirst"]>>>;
type Note = NonNullable<Awaited<ReturnType<Tx["nursingNote"]["findFirst"]>>>;
export const escWire = (e: Esc, who: Awaited<ReturnType<typeof peopleOf>>): Escalation => ({
  id: e.id, status: e.status === "doctor_informed" ? "doctor-informed" : e.status, score: e.score, peakScore: e.peakScore, red: e.red, raisedAt: e.raisedAt.toISOString(), raisedBy: who(e.raisedById),
  informedAt: iso(e.informedAt), informedBy: e.informedById ? who(e.informedById) : null, spokeTo: e.spokeTo, instruction: e.instruction,
  resolvedAt: iso(e.resolvedAt), resolvedBy: e.resolvedById ? who(e.resolvedById) : null, resolveNote: e.resolveNote,
});
export const noteWire = (n: Note, who: Awaited<ReturnType<typeof peopleOf>>): NursingNoteView => ({
  id: n.id, text: n.text, writtenBy: who(n.writtenById), writtenAt: n.writtenAt.toISOString(), effectiveAt: n.effectiveAt.toISOString(),
  status: n.status === "entered_in_error" ? "entered-in-error" : "active", error: n.errorAt ? { reason: n.errorReason ?? "", by: who(n.errorById), at: n.errorAt.toISOString() } : null,
});
const requireWardNurse = (s: SessionData) => { if (s.role !== "nurse") throw err(403, "forbidden", "এই কাজটি ওয়ার্ডের নার্সের", "A ward nurse does this", { reason: "role", canRequest: false }); };

export async function wardList(tx: Tx, s: SessionData) {
  const wards = await tx.location.findMany({ where: { organizationId: s.organizationId, kind: "ward" }, orderBy: { name: "asc" } });
  const beds = await tx.location.findMany({ where: { organizationId: s.organizationId, kind: "bed", parentId: { in: wards.map((w) => w.id) } }, select: { parentId: true, bedState: true, bedClass: true } });
  return { wards: wards.filter((w) => beds.some((b) => b.parentId === w.id && b.bedClass !== "ER")).map((w) => ({ id: w.id, name: w.name, nameBn: w.nameBn, beds: beds.filter((b) => b.parentId === w.id).length, occupied: beds.filter((b) => b.parentId === w.id && (b.bedState === "occupied" || b.bedState === "discharge_pending")).length })) };
}

export async function wardBoard(tx: Tx, s: SessionData, wardId: string, now: Date): Promise<{ board: WardBoard; patientIds: string[] }> {
  const ward = await tx.location.findFirst({ where: { id: wardId, organizationId: s.organizationId, kind: "ward" } });
  if (!ward) throw notFound();
  const beds = await tx.location.findMany({ where: { parentId: ward.id, kind: "bed" }, orderBy: { name: "asc" } });
  const live = await tx.bedAssignment.findMany({ where: { bedId: { in: beds.map((b) => b.id) }, status: { in: ["reserved", "occupied"] } } });
  const occ = live.filter((a) => a.status === "occupied");
  const encs = (await tx.encounter.findMany({ where: { id: { in: occ.map((a) => a.encounterId) }, class: "ipd", status: "in_progress" }, include: { patient: true } })) as Enc[];
  const encIds = encs.map((e) => e.id);
  const reservedFor = live.filter((a) => a.status === "reserved");
  const resPatients = (await tx.patient.findMany({ where: { id: { in: reservedFor.map((a) => a.patientId) } } }));
  const [adms, allergies, scores, escs, counts] = await Promise.all([
    tx.admission.findMany({ where: { encounterId: { in: [...encIds, ...reservedFor.map((a) => a.encounterId)] }, status: "admitted" } }),
    tx.allergyIntolerance.findMany({ where: { patientId: { in: encs.map((e) => e.patientId) }, status: "active" } }),
    latestNews2(tx, encIds),
    tx.escalationEvent.findMany({ where: { encounterId: { in: encIds }, status: { not: "resolved" } } }),
    doseCounts(tx, encIds, now),
  ]);
  const srcBeds = new Map((await tx.bedAssignment.findMany({ where: { encounterId: { in: reservedFor.map((a) => a.encounterId) }, status: "occupied" }, include: { bed: true } })).map((a) => [a.encounterId, a.bed.name]));
  const who = await peopleOf(tx, [...encs.map((e) => e.practitionerId), ...escs.flatMap((e) => [e.raisedById, e.informedById, e.resolvedById])]);
  const rows: WardBoard["beds"] = beds.map((b) => {
    const a = occ.find((x) => x.bedId === b.id);
    const e = a ? encs.find((x) => x.id === a.encounterId) : undefined;
    const adm = e ? adms.find((x) => x.encounterId === e.id) : undefined;
    const sc = e ? scores.get(e.id) : undefined;
    const esc = e ? escs.find((x) => x.encounterId === e.id) : undefined;
    const res = reservedFor.find((x) => x.bedId === b.id);
    const resP = res ? resPatients.find((p) => p.id === res.patientId) : undefined;
    const resAdm = res ? adms.find((x) => x.encounterId === res.encounterId) : undefined;
    return {
      bed: { id: b.id, name: b.name, state: (b.bedState ?? "vacant").replace(/_/g, "-") as "vacant", note: b.bedNote, bedClass: b.bedClass ?? "" },
      patient: e ? erPatientOf(e.patient) : null, encounterId: e?.id ?? null, admissionId: adm?.id ?? null, admissionNumber: adm?.number ?? null,
      doctor: e?.practitionerId ? who(e.practitionerId) : null, day: e ? dayOfStay(adm?.admittedAt ?? e.arrivedAt, now) : null,
      allergies: e ? allergies.filter((x) => x.patientId === e.patientId).map((x) => x.labelEn) : null,
      news2: sc?.news2 ?? null, nextObsDueAt: sc?.nextObsDueAt ?? null, obsOverdue: sc ? new Date(sc.nextObsDueAt) < now : false,
      escalation: esc ? escWire(esc, who) : null, doses: e ? counts.get(e.id)! : { due: 0, overdue: 0 },
      arriving: res && resP && resAdm ? { admissionId: resAdm.id, patient: erPatientOf(resP as Enc["patient"]), fromBed: srcBeds.get(res.encounterId) ?? "" } : null,
    };
  });
  const banner = rows.filter((r) => r.escalation && r.patient && r.encounterId).map((r) => ({ encounterId: r.encounterId!, bed: r.bed.name, patient: r.patient!, escalation: r.escalation! }));
  return { board: { ward: { id: ward.id, name: ward.name, nameBn: ward.nameBn }, beds: rows, escalations: banner, rule: rule() }, patientIds: encs.map((e) => e.patientId) };
}

/* ───── ward vitals with NEWS2 ───── */
const CODE = { bpSys: ["bp-systolic", "mmHg"], bpDia: ["bp-diastolic", "mmHg"], pulse: ["pulse", "/min"], temp: ["body-temperature", "[degF]"], spo2: ["spo2", "%"], rbs: ["blood-glucose", "mmol/L"], weight: ["body-weight", "kg"], height: ["body-height", "cm"] } as const;
const MAX_FUTURE_MS = 5 * 60_000, MAX_PAST_MS = 24 * 3600_000;
export async function recordWardVitals(tx: Tx, s: SessionData, encounterId: string, req: WardVitalsRequest, now: Date): Promise<{ res: WardVitalsResponse; audit: AuditEntry[] }> {
  requireWardNurse(s);
  const { rr, consciousness, onOxygen, ...a4 } = req.values;
  const a = assessVitals(a4);
  const unconfirmed = a.needsConfirm.filter((f) => !(req.confirmed ?? []).includes(f));
  const rrBad = rr !== undefined && !rrPossible(rr);
  if (a.blocked || rrBad) {
    const bad = a.fields.filter((f) => f.level === "impossible").map((f) => ({ field: f.field as string, code: f.code }));
    if (rrBad) bad.push({ field: "rr", code: "rr_impossible" });
    if (!bad.length && rr === undefined) throw err(400, "vitals_empty", "অন্তত একটি মান লিখুন", "Enter at least one value");
    if (bad.length) throw err(400, "vitals_impossible", `${bad.length}টি মান সম্ভব নয় — আবার মাপুন`, `${bad.length} value(s) not possible — re-measure`, { field: bad[0]!.field, fields: bad });
  }
  if (unconfirmed.length) throw err(400, "vitals_confirm", "মানটি আবার দেখে নিশ্চিত করুন", "Re-check this value and confirm it", { field: unconfirmed[0], fields: unconfirmed.map((f) => ({ field: f, code: "confirm_required" })) });
  const effectiveAt = new Date(req.effectiveAt);
  if (effectiveAt.getTime() > now.getTime() + MAX_FUTURE_MS || effectiveAt.getTime() < now.getTime() - MAX_PAST_MS)
    throw err(400, "effective_at_range", "মাপার সময় ঠিক নেই — ডিভাইসের ঘড়ি দেখুন", "The measurement time is out of range — check the device clock", { field: "effectiveAt" });
  const ip = await inpatientHere(tx, s, encounterId);
  if (!ip.open) throw closedVisit();
  const n = news2({ rr, spo2: a4.spo2, onOxygen, sbp: a4.bpSys, pulse: a4.pulse, consciousness, tempF: a4.temp });
  const batchId = `vb_${randomUUID()}`;
  const base = { tenantId: s.tenantId, organizationId: s.organizationId, branchId: ip.e.branchId, patientId: ip.e.patientId, encounterId: ip.e.id, batchId, recordedById: s.userId, effectiveAt, deviceLabel: req.deviceLabel ?? null };
  const level = (f: string) => a.fields.find((x) => x.field === f)?.interpretation ?? null;
  const FIELD: Record<string, string> = { bpSys: "bp", bpDia: "bp", pulse: "pulse", temp: "temp", spo2: "spo2", rbs: "rbs", weight: "weight", height: "height" };
  type Row = typeof base & { code: string; unit: string; value: number; method: string | null; interpretation: ReturnType<typeof level> };
  const rows: Row[] = (Object.keys(CODE) as (keyof typeof CODE)[]).flatMap((k): Row[] => (a4[k] === undefined ? [] : [{ ...base, code: CODE[k][0], unit: CODE[k][1], value: a4[k] as number, method: k === "rbs" ? (a4.rbsMode ?? "random") : null, interpretation: level(FIELD[k]!) }]));
  if (rr !== undefined) rows.push({ ...base, code: "respiratory-rate", unit: "/min", value: rr, method: null, interpretation: null });
  if (consciousness !== undefined) rows.push({ ...base, code: "consciousness", unit: "{acvpu}", value: consciousnessCode(consciousness), method: "acvpu", interpretation: null });
  rows.push({ ...base, code: "supplemental-oxygen", unit: "{yes-no}", value: onOxygen ? 1 : 0, method: null, interpretation: null });
  if (a.bmi !== null) rows.push({ ...base, code: "bmi", unit: "kg/m2", value: a.bmi, method: "calculated", interpretation: null });
  const news2Id = `ob_${randomUUID()}`;
  await tx.observation.createMany({ data: rows });
  await tx.observation.create({ data: { ...base, id: news2Id, code: "news2", unit: "{score}", value: n.total, method: "calculated", interpretation: shouldEscalate(n) ? "HH" : null } });
  await tx.provenance.create({ data: { tenantId: s.tenantId, targetType: "Observation", targetId: batchId, activity: "record-vitals", agentId: s.userId, onBehalfOf: s.organizationId, source: "provider_verified", recorded: now, detail: { encounterId: ip.e.id, news2: n.total, parts: n.parts, red: n.red, complete: n.complete, threshold: NEWS2_THRESHOLD_SAMPLE, sample: true } as object } });
  const audit: AuditEntry[] = [{ action: "create", entity: "Observation", entityId: batchId, patientId: ip.e.patientId, detail: { encounterId: ip.e.id, news2: n.total, red: n.red } }];
  // the escalation rule: one open per visit; a worse score while it is open tells the doctor once more
  let esc: Esc | null = await tx.escalationEvent.findFirst({ where: { encounterId: ip.e.id, status: { not: "resolved" } } });
  let escalated = false;
  if (shouldEscalate(n)) {
    if (!esc) {
      esc = await tx.escalationEvent.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, encounterId: ip.e.id, patientId: ip.e.patientId, status: "raised", score: n.total, peakScore: n.total, red: n.red, peakRed: n.red, observationId: news2Id, raisedAt: now, raisedById: s.userId } });
      escalated = true;
      audit.push({ action: "create", entity: "EscalationEvent", entityId: esc.id, patientId: ip.e.patientId, detail: { score: n.total, red: n.red, doctorId: ip.e.practitionerId } });
      if (ip.e.practitionerId) await deliverInApp(tx, s, { patientId: ip.e.patientId, encounterId: ip.e.id }, { kind: "news2-escalation", channel: "doctor_inbox", recipientUserId: ip.e.practitionerId, observationId: news2Id }, now);
    } else if (n.total > esc.peakScore || (n.red && !esc.peakRed)) {
      // worse: a higher score, or a first red parameter at any total — the doctor is told again; after a logged
      // contact the escalation goes back to raised so the nurse logs a new one (ESCALATION worsen)
      const status = esc.status === "doctor_informed" ? (transition("escalation", ESCALATION, "doctor-informed", "worsen") as "raised") : esc.status;
      esc = await tx.escalationEvent.update({ where: { id: esc.id }, data: { peakScore: Math.max(n.total, esc.peakScore), peakRed: esc.peakRed || n.red, status } });
      escalated = true;
      audit.push({ action: "update", entity: "EscalationEvent", entityId: esc.id, patientId: ip.e.patientId, detail: { event: "worse", score: n.total, red: n.red, status } });
      if (ip.e.practitionerId) await deliverInApp(tx, s, { patientId: ip.e.patientId, encounterId: ip.e.id }, { kind: "news2-escalation", channel: "doctor_inbox", recipientUserId: ip.e.practitionerId, observationId: news2Id }, now);
    }
  }
  const stored = await tx.observation.findMany({ where: { batchId }, orderBy: { code: "asc" } });
  const u = await tx.user.findFirst({ where: { id: s.userId }, select: { nameBn: true, nameEn: true } });
  const who = await peopleOf(tx, esc ? [esc.raisedById, esc.informedById, esc.resolvedById] : []);
  const wire = news2OfBatch([...stored, { code: "news2", value: n.total, effectiveAt, batchId }].filter((x, i, arr) => arr.findIndex((y) => y.code === x.code) === i))!;
  return {
    res: {
      batch: { batchId, effectiveAt: effectiveAt.toISOString(), recordedAt: now.toISOString(), recordedBy: { id: s.userId, nameBn: u?.nameBn ?? "—", nameEn: u?.nameEn ?? "—", role: s.role }, source: "provider-verified",
        observations: stored.map((o) => ({ code: o.code, value: o.value, unit: o.unit, method: o.method, interpretation: o.interpretation })) },
      news2: wire, escalation: esc ? escWire(esc, who) : null, escalated,
      nextObsDueAt: new Date(effectiveAt.getTime() + nextObsMinutes(n) * 60_000).toISOString(), rule: rule(),
    },
    audit,
  };
}

export async function informEscalation(tx: Tx, s: SessionData, id: string, body: { spokeTo: string; instruction: string }, now: Date) {
  requireWardNurse(s);
  const e = await tx.escalationEvent.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!e) throw notFound();
  const bl = informBlockers(body);
  if (bl.length) throw err(400, "validation", "কার সাথে কথা হয়েছে ও নির্দেশনা লিখুন", "Write whom you spoke to and the instruction", { field: bl[0] === "spoke_to" ? "spokeTo" : "instruction", fields: bl.map((b) => ({ field: b === "spoke_to" ? "spokeTo" : "instruction", code: "required" })) });
  let to: string;
  try { to = transition("escalation", ESCALATION, e.status === "doctor_informed" ? "doctor-informed" : e.status, "inform"); }
  catch { throw err(409, "escalation_state", "এই অবস্থা থেকে হয় না", "Not from this state"); }
  const n = await tx.escalationEvent.updateMany({ where: { id: e.id, status: e.status }, data: { status: to === "doctor-informed" ? "doctor_informed" : "raised", informedAt: now, informedById: s.userId, spokeTo: body.spokeTo.trim(), instruction: body.instruction.trim() } });
  if (n.count !== 1) throw stale();
  const after = (await tx.escalationEvent.findFirst({ where: { id: e.id } }))!;
  return { esc: escWire(after, await peopleOf(tx, [after.raisedById, after.informedById, after.resolvedById])), audit: [{ action: "update", entity: "EscalationEvent", entityId: e.id, patientId: e.patientId, detail: { event: "inform", spokeTo: body.spokeTo.trim() } }] as AuditEntry[] };
}
export async function resolveEscalation(tx: Tx, s: SessionData, id: string, note: string, now: Date) {
  if (s.role !== "nurse" && s.role !== "doctor") throw err(403, "forbidden", "নার্স বা ডাক্তার", "A nurse or a doctor resolves it", { reason: "role", canRequest: false });
  const e = await tx.escalationEvent.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!e) throw notFound();
  if (e.status !== "doctor_informed") throw err(409, "escalation_state", "আগে ডাক্তারকে জানানোর তথ্য লিখুন", "Log the doctor's contact first");
  if (note.trim().length < 3) throw err(400, "validation", "একটি নোট লিখুন", "Write a note", { field: "note" });
  transition("escalation", ESCALATION, "doctor-informed", "resolve");
  const n = await tx.escalationEvent.updateMany({ where: { id: e.id, status: "doctor_informed" }, data: { status: "resolved", resolvedAt: now, resolvedById: s.userId, resolveNote: note.trim() } });
  if (n.count !== 1) throw stale();
  const after = (await tx.escalationEvent.findFirst({ where: { id: e.id } }))!;
  return { esc: escWire(after, await peopleOf(tx, [after.raisedById, after.informedById, after.resolvedById])), audit: [{ action: "update", entity: "EscalationEvent", entityId: e.id, patientId: e.patientId, detail: { event: "resolve" } }] as AuditEntry[] };
}

/* ───── nursing notes ───── */
export async function addNote(tx: Tx, s: SessionData, encounterId: string, body: { text: string; effectiveAt: string }, now: Date) {
  requireWardNurse(s);
  if (!noteOk(body.text)) throw err(400, "validation", "নোট লিখুন (অন্তত ৩ অক্ষর)", "Write the note (at least 3 characters)", { field: "text" });
  const effectiveAt = new Date(body.effectiveAt);
  if (effectiveAt.getTime() > now.getTime() + MAX_FUTURE_MS || effectiveAt.getTime() < now.getTime() - MAX_PAST_MS) throw err(400, "effective_at_range", "সময় ঠিক নেই — ডিভাইসের ঘড়ি দেখুন", "The time is out of range — check the device clock", { field: "effectiveAt" });
  const ip = await inpatientHere(tx, s, encounterId);
  if (!ip.open) throw closedVisit();
  const n = await tx.nursingNote.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, encounterId: ip.e.id, patientId: ip.e.patientId, text: body.text.trim(), writtenById: s.userId, writtenAt: now, effectiveAt } });
  return { note: noteWire(n, await peopleOf(tx, [s.userId])), audit: [{ action: "create", entity: "NursingNote", entityId: n.id, patientId: ip.e.patientId, detail: { encounterId: ip.e.id } }] as AuditEntry[] };
}
export async function markNoteError(tx: Tx, s: SessionData, id: string, reason: string, now: Date) {
  requireWardNurse(s);
  const n0 = await tx.nursingNote.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!n0) throw notFound();
  if (reason.trim().length < 5) throw err(400, "reason_required", "কারণ লিখুন (অন্তত ৫ অক্ষর)", "Give a reason (at least 5 characters)", { field: "reason" });
  if (n0.status !== "active") throw err(409, "already_in_error", "আগেই ভুল হিসেবে চিহ্নিত", "Already marked entered-in-error");
  transition("nursing-note", NURSING_NOTE, "active", "markError");
  await tx.nursingNote.update({ where: { id: n0.id }, data: { status: "entered_in_error", errorReason: reason.trim(), errorById: s.userId, errorAt: now } });
  const after = (await tx.nursingNote.findFirst({ where: { id: n0.id } }))!;
  return { note: noteWire(after, await peopleOf(tx, [after.writtenById, after.errorById])), audit: [{ action: "update", entity: "NursingNote", entityId: n0.id, patientId: n0.patientId, detail: { event: "markError" } }] as AuditEntry[] };
}

export async function wardPatient(tx: Tx, s: SessionData, encounterId: string, now: Date): Promise<WardPatientView> {
  const ip = await inpatientHere(tx, s, encounterId);
  const since = new Date(now.getTime() - 72 * 3600_000);
  const [obs, escs, notes, allergies] = await Promise.all([
    tx.observation.findMany({ where: { encounterId: ip.e.id, category: "vital-signs", status: { not: "entered_in_error" }, effectiveAt: { gte: since } }, orderBy: [{ effectiveAt: "desc" }] }),
    tx.escalationEvent.findMany({ where: { encounterId: ip.e.id }, orderBy: { raisedAt: "desc" } }),
    tx.nursingNote.findMany({ where: { encounterId: ip.e.id }, orderBy: { effectiveAt: "desc" }, take: 100 }),
    tx.allergyIntolerance.findMany({ where: { patientId: ip.e.patientId }, orderBy: [{ status: "asc" }, { recordedAt: "asc" }] }),
  ]);
  const batches = [...new Set(obs.map((o) => o.batchId))];
  const who = await peopleOf(tx, [ip.e.practitionerId, ...obs.map((o) => o.recordedById), ...escs.flatMap((e) => [e.raisedById, e.informedById, e.resolvedById]), ...notes.flatMap((n) => [n.writtenById, n.errorById])]);
  const vitals = batches.map((b) => {
    const rows = obs.filter((o) => o.batchId === b);
    const first = rows[0]!;
    return { batch: { batchId: b, effectiveAt: first.effectiveAt.toISOString(), recordedAt: first.recordedAt.toISOString(), recordedBy: { ...who(first.recordedById), role: null }, source: "provider-verified" as const, observations: rows.map((o) => ({ code: o.code, value: o.value, unit: o.unit, method: o.method, interpretation: o.interpretation })) }, news2: news2OfBatch(rows) };
  });
  const latest = (await latestNews2(tx, [ip.e.id])).get(ip.e.id);
  return {
    encounterId: ip.e.id, admissionId: ip.adm.id, admissionNumber: ip.adm.number, patient: toSummary(await getPatient(tx, ip.e.patientId)), allergies: await toAllergyView(tx, allergies),
    bed: ip.bed && ip.ward ? { id: ip.bed.id, name: ip.bed.name, ward: ip.ward.name } : null, doctor: ip.e.practitionerId ? who(ip.e.practitionerId) : null, day: dayOfStay(ip.adm.admittedAt, now),
    vitals, nextObsDueAt: latest?.nextObsDueAt ?? null, escalations: escs.map((e) => escWire(e, who)), notes: notes.map((n) => noteWire(n, who)), rule: rule(),
  };
}
