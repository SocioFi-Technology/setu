/* Emergency department (ADR 0014, walkthrough B1–B2). Runs inside command()/query() under RLS, scoped to the session's
   facility and branch. The triage scale is @setu/domain's sample (pending clinician sign-off); every state change goes
   through ENCOUNTER / BED / DOCUMENT / ORDER; the disposition is signed with the PIN on the ER note (Composition kind
   er-note). ER bays are beds of class ER; a bay is taken straight away (vacant → occupied) and vacated into cleaning. */
import { randomUUID } from "node:crypto";
import type { Disposition, ErArrivalRequest, ErAssignRequest, ErBoard, ErBoardItem, ErDispositionRequest, ErTriageRequest, ErVisitView } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  BED, CARE_ORDERS_SAMPLE, DOCUMENT, ENCOUNTER, ORDER, TRIAGE_SCALE, TRIAGE_SCALE_NOTE, TRIAGE_SCALE_SAMPLE, UNTRIAGED_TARGET_MINUTES, assignTransition, bayTake, bedPickable,
  boardOrder, careOrder, closesOnSign, dhakaDay, dispositionBlockers, erOpen, erToken, erTokenSequenceName, isAdmissionClass, isPaediatric, isTriageLevel, paediatricPrompt,
  patientAgeYears, reserveLeg, signDocument, transition, triageLevel, triageOverdue, triageTransition, unknownPatientName, waitedMinutes, type EncounterState,
} from "@setu/domain";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { toAllergyView } from "./consultation.js";
import { branchOf, getPatient, notFound, toSummary } from "./frontdesk.js";
import { requirePin } from "./pin.js";
import { devHash } from "./users.js";

export const ER_NOTE = "er-note";
const dash = <T extends string>(s: string) => s.replace(/_/g, "-") as T;
const under = <T extends string>(s: string) => s.replace(/-/g, "_") as T;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
type DbEncStatus = "planned" | "arrived" | "triaged" | "in_progress" | "finished" | "cancelled" | "entered_in_error";
type DbBedState = "vacant" | "reserved" | "occupied" | "discharge_pending" | "cleaning" | "blocked";
const stale = () => err(409, "stale", "অন্য কেউ আগেই বদলেছেন — আবার দেখুন", "Someone else changed this first — refresh");
const closed = () => err(409, "encounter_closed", "এই জরুরি ভিজিট বন্ধ", "This ER visit is closed");
const isUnique = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
export interface ErNoteSections { notes: string; careOrders: { key: string; at: string; by: string }[]; disposition: Disposition | null }

/* ───── context ───── */
export async function erDoctors(tx: Tx, s: SessionData) {
  const roles = await tx.practitionerRole.findMany({ where: { organizationId: s.organizationId, role: "doctor", user: { active: true } }, include: { user: { include: { practitioner: true } } }, orderBy: { userId: "asc" } });
  return roles.map((r) => ({ id: r.userId, nameBn: r.user.nameBn, nameEn: r.user.nameEn, speciality: r.user.practitioner?.speciality ?? null, paediatric: isPaediatric(r.user.practitioner?.speciality) }));
}
const scaleView = () => ({ sample: TRIAGE_SCALE_SAMPLE, note: { ...TRIAGE_SCALE_NOTE }, untriagedTargetMinutes: UNTRIAGED_TARGET_MINUTES, levels: TRIAGE_SCALE.map((l) => ({ ...l })) });
type Bed = NonNullable<Awaited<ReturnType<Tx["location"]["findFirst"]>>>;
type Live = NonNullable<Awaited<ReturnType<Tx["bedAssignment"]["findFirst"]>>>;
/** Every live (reserved / occupied) assignment of the facility, by bed. */
async function liveByBed(tx: Tx, s: SessionData): Promise<Map<string, Live>> {
  const rows = await tx.bedAssignment.findMany({ where: { organizationId: s.organizationId, status: { in: ["reserved", "occupied"] } } });
  return new Map(rows.map((r) => [r.bedId, r]));
}
async function baysOf(tx: Tx, s: SessionData, live: Map<string, Live>) {
  const beds = await tx.location.findMany({ where: { organizationId: s.organizationId, kind: "bed", bedClass: "ER" }, orderBy: { name: "asc" } });
  return beds.map((b) => ({ id: b.id, name: b.name, nameBn: b.nameBn, state: dash<"vacant">(b.bedState ?? "vacant"), note: b.bedNote, patientId: live.get(b.id)?.patientId ?? null }));
}
const encInclude = { patient: true, erVisit: true } as const;
type Enc = NonNullable<Awaited<ReturnType<Tx["encounter"]["findFirst"]>>> & { patient: NonNullable<Awaited<ReturnType<Tx["patient"]["findFirst"]>>>; erVisit: NonNullable<Awaited<ReturnType<Tx["erVisit"]["findFirst"]>>> | null };
/** An ER visit at the session's facility and branch, or 404. */
export async function erEncounter(tx: Tx, s: SessionData, id: string): Promise<Enc> {
  const branch = await branchOf(tx, s);
  const e = await tx.encounter.findFirst({ where: { id, class: "er", organizationId: s.organizationId, branchId: branch.id }, include: encInclude });
  if (!e || !e.erVisit) throw notFound();
  return e as Enc;
}
const ageOf = (p: Enc["patient"], now: Date) => patientAgeYears({ birthDate: p.birthDate ? p.birthDate.toISOString().slice(0, 10) : null, approxAgeYears: p.approxAgeYears, approxAgeAt: iso(p.approxAgeAt) }, now);
const erPatient = (p: Enc["patient"]) => ({
  id: p.id, facilityNo: p.facilityNo, nameBn: p.nameBn, nameEn: p.nameEn, sex: p.sex, birthDate: p.birthDate ? p.birthDate.toISOString().slice(0, 10) : null,
  approxAgeYears: p.approxAgeYears, approxAgeMonths: p.approxAgeMonths, approxAgeAt: iso(p.approxAgeAt), identityConfidence: dash<"verified">(p.identityConfidence),
});
/** The latest vitals of each visit in one line (BP · HR · SpO₂ · T), as the triage board shows them. */
async function vitalsLines(tx: Tx, encounterIds: string[]): Promise<Map<string, string>> {
  if (!encounterIds.length) return new Map();
  const rows = await tx.observation.findMany({ where: { encounterId: { in: encounterIds }, category: "vital-signs", status: { not: "entered_in_error" } }, orderBy: [{ effectiveAt: "desc" }], select: { encounterId: true, batchId: true, code: true, value: true } });
  const latestBatch = new Map<string, string>();
  for (const r of rows) if (!latestBatch.has(r.encounterId)) latestBatch.set(r.encounterId, r.batchId);
  const out = new Map<string, string>();
  for (const [enc, batch] of latestBatch) {
    const v = Object.fromEntries(rows.filter((r) => r.batchId === batch).map((r) => [r.code, r.value]));
    const parts: string[] = [];
    if (v["bp-systolic"] !== undefined && v["bp-diastolic"] !== undefined) parts.push(`BP ${v["bp-systolic"]}/${v["bp-diastolic"]}`);
    if (v["pulse"] !== undefined) parts.push(`HR ${v["pulse"]}`);
    if (v["spo2"] !== undefined) parts.push(`SpO₂ ${v["spo2"]}%`);
    if (v["body-temperature"] !== undefined) parts.push(`T ${v["body-temperature"]} °F`);
    if (parts.length) out.set(enc, parts.join(" · "));
  }
  return out;
}
interface Ctx { doctors: Map<string, Awaited<ReturnType<typeof erDoctors>>[number]>; live: Map<string, Live>; beds: Map<string, Bed>; vitals: Map<string, string>; admissions: Map<string, { id: string; status: string; bedId: string }>; provisional: Set<string>; people: Map<string, { id: string; nameBn: string; nameEn: string }> }
async function ctxFor(tx: Tx, s: SessionData, rows: Enc[]): Promise<Ctx> {
  const live = await liveByBed(tx, s);
  const beds = new Map((await tx.location.findMany({ where: { organizationId: s.organizationId, kind: "bed" } })).map((b) => [b.id, b]));
  const ids = rows.map((r) => r.id);
  const adm = await tx.admission.findMany({ where: { sourceEncounterId: { in: ids }, status: { in: ["requested", "admitted"] } }, select: { id: true, status: true, bedId: true, sourceEncounterId: true } });
  const pids = rows.map((r) => r.patientId);
  const reviews = pids.length ? await tx.task.findMany({ where: { kind: "patient-link-review", status: "requested", focusId: { in: pids } }, select: { focusId: true } }) : [];
  const signerIds = [...new Set(rows.map((r) => r.erVisit?.dispositionSignedById).filter((x): x is string => Boolean(x)))];
  const people = signerIds.length ? await tx.user.findMany({ where: { id: { in: signerIds } }, select: { id: true, nameBn: true, nameEn: true } }) : [];
  return {
    doctors: new Map((await erDoctors(tx, s)).map((d) => [d.id, d])), live, beds, vitals: await vitalsLines(tx, ids),
    admissions: new Map(adm.map((a) => [a.sourceEncounterId!, a])), provisional: new Set(reviews.map((t) => t.focusId!)), people: new Map(people.map((p) => [p.id, p])),
  };
}
function toItem(e: Enc, c: Ctx, now: Date): ErBoardItem {
  const v = e.erVisit!;
  const waited = waitedMinutes(e.arrivedAt ?? e.createdAt, now);
  const bayRow = [...c.live.values()].find((a) => a.encounterId === e.id && a.status === "occupied");
  const bay = bayRow ? c.beds.get(bayRow.bedId) : undefined;
  const doctor = e.practitionerId ? c.doctors.get(e.practitionerId) ?? null : null;
  const adm = c.admissions.get(e.id);
  const admBed = adm ? c.beds.get(adm.bedId) : undefined;
  const signer = v.dispositionSignedById ? c.people.get(v.dispositionSignedById) : undefined;
  return {
    id: e.id, token: e.token, day: e.tokenDay, status: dash<EncounterState>(e.status), patient: erPatient(e.patient), ageYears: ageOf(e.patient, now),
    arrivalMode: v.arrivalMode as ErBoardItem["arrivalMode"], broughtBy: v.broughtBy, arrivedAt: (e.arrivedAt ?? e.createdAt).toISOString(), waited, complaint: v.complaint,
    level: (v.triageLevel as ErBoardItem["level"]) ?? null, targetMinutes: v.triageTargetMinutes, triagedAt: iso(v.triagedAt),
    overdue: erOpen(dash<EncounterState>(e.status)) && triageOverdue(v.triageLevel, waited, Boolean(e.practitionerId)),
    doctor, bay: bay ? { id: bay.id, name: bay.name } : null, vitals: c.vitals.get(e.id) ?? null,
    disposition: v.dispositionKind && v.dispositionSignedAt ? { kind: v.dispositionKind as Disposition["kind"], signedAt: v.dispositionSignedAt.toISOString(), by: signer ?? { id: v.dispositionSignedById ?? "", nameBn: "—", nameEn: "—" } } : null,
    admission: adm && admBed ? { id: adm.id, status: adm.status, bed: { id: admBed.id, name: admBed.name, ward: c.beds.get(admBed.parentId ?? "")?.name ?? "" } } : null,
    provisional: e.patient.identityConfidence === "provisional" && c.provisional.has(e.patientId),
  };
}
async function itemOf(tx: Tx, s: SessionData, e: Enc, now: Date): Promise<ErBoardItem> {
  const c = await ctxFor(tx, s, [e]);
  // the ward name of the admission bed needs the wards too
  const wards = await tx.location.findMany({ where: { organizationId: s.organizationId, kind: "ward" } });
  for (const w of wards) c.beds.set(w.id, w);
  return toItem(e, c, now);
}

/* ───── the board (B1) ───── */
export async function erBoard(tx: Tx, s: SessionData, now: Date): Promise<ErBoard> {
  const branch = await branchOf(tx, s);
  const day = dhakaDay(now);
  const rows = (await tx.encounter.findMany({
    where: { class: "er", organizationId: s.organizationId, branchId: branch.id, OR: [{ tokenDay: day }, { status: { in: ["arrived", "triaged", "in_progress"] } }] },
    include: encInclude, orderBy: { arrivedAt: "asc" },
  })) as Enc[];
  const c = await ctxFor(tx, s, rows);
  const wards = await tx.location.findMany({ where: { organizationId: s.organizationId, kind: "ward" } });
  for (const w of wards) c.beds.set(w.id, w);
  const items = rows.map((e) => toItem(e, c, now));
  const open = items.filter((i) => erOpen(i.status));
  const byLevel: Record<string, number> = {};
  for (const l of TRIAGE_SCALE) byLevel[String(l.level)] = open.filter((i) => i.level === l.level).length;
  return {
    day, items: boardOrder(open).concat(items.filter((i) => !erOpen(i.status)).sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt))),
    counts: { byLevel, untriaged: open.filter((i) => i.level === null).length, overTarget: open.filter((i) => i.overdue).length, total: open.length },
    scale: scaleView(), doctors: [...c.doctors.values()], bays: await baysOf(tx, s, c.live),
  };
}

/* ───── arrival ───── */
/** Takes a bay for this visit: vacant → occupied (BED), one occupied row. The database refuses a second bed for the patient. */
async function takeBay(tx: Tx, s: SessionData, e: { id: string; patientId: string }, bayId: string, now: Date, transfer?: string): Promise<AuditEntry[]> {
  const transferId: string = transfer ?? randomUUID();
  const bay = await tx.location.findFirst({ where: { id: bayId, organizationId: s.organizationId, kind: "bed", bedClass: "ER" } });
  if (!bay) throw err(404, "bay_not_found", "এই বে পাওয়া যায়নি", "No such ER bay", { field: "bayId" });
  let to: DbBedState;
  try { to = under<DbBedState>(bayTake(dash(bay.bedState ?? "vacant"))); }
  catch { throw err(409, "bay_taken", `${bay.name} খালি নেই`, `${bay.name} is not free`, { field: "bayId" }); }
  const n = await tx.location.updateMany({ where: { id: bay.id, bedState: bay.bedState }, data: { bedState: to, bedNote: null } });
  if (n.count !== 1) throw stale();
  try {
    await tx.bedAssignment.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, encounterId: e.id, patientId: e.patientId, bedId: bay.id, status: "occupied", transferId, occupiedAt: now, occupiedById: s.userId } });
  } catch (x) {
    if (isUnique(x)) throw err(409, "patient_has_bed", "এই রোগী ইতিমধ্যে একটি শয্যায় আছেন", "This patient already holds a bed", { field: "bayId" });
    throw x;
  }
  return [{ action: "update", entity: "Location", entityId: bay.id, patientId: e.patientId, detail: { event: "occupy", bed: bay.name, from: dash(bay.bedState ?? "vacant"), to: dash(to), encounterId: e.id, transferId } }];
}
/** Ends the visit's bay (occupied → cleaning, BED vacate); nothing when the patient has no bay. */
export async function leaveBay(tx: Tx, s: SessionData, encounterId: string, now: Date, reason: "vacated" | "released" = "vacated"): Promise<AuditEntry[]> {
  const a = await tx.bedAssignment.findFirst({ where: { encounterId, status: "occupied" } });
  if (!a) return [];
  const bay = await tx.location.findFirst({ where: { id: a.bedId } });
  if (!bay) throw stale();
  const to = under<DbBedState>(transition("bed", BED, dash(bay.bedState ?? "occupied"), "vacate"));
  const n = await tx.location.updateMany({ where: { id: bay.id, bedState: bay.bedState }, data: { bedState: to } });
  if (n.count !== 1) throw stale();
  await tx.bedAssignment.update({ where: { id: a.id }, data: { status: "ended", endedAt: now, endedById: s.userId, endReason: reason } });
  return [{ action: "update", entity: "Location", entityId: bay.id, patientId: a.patientId, detail: { event: "vacate", bed: bay.name, to: dash(to), encounterId, transferId: a.transferId } }];
}

export async function arrive(tx: Tx, s: SessionData, req: ErArrivalRequest, now: Date) {
  const branch = await branchOf(tx, s);
  const audit: AuditEntry[] = [];
  let patientId: string; let review = false;
  if (req.patientId) {
    let p = await getPatient(tx, req.patientId);
    for (let i = 0; i < 3 && p.linkedToId; i++) p = await getPatient(tx, p.linkedToId);
    patientId = p.id;
  } else {
    // Quick provisional registration (ADR 0014): a record the desk resolves later through its review queue.
    const u = req.unknown!;
    const tenant = await tx.tenant.findFirst({ where: { id: s.tenantId } });
    if (!tenant) throw notFound();
    const seq = await tx.sequence.upsert({ where: { tenantId_name: { tenantId: s.tenantId, name: "patient" } }, create: { tenantId: s.tenantId, name: "patient", value: 1 }, update: { value: { increment: 1 } } });
    const name = unknownPatientName(u.sex, u.approxAgeYears);
    const p = await tx.patient.create({ data: {
      tenantId: s.tenantId, facilityNo: `${tenant.patientNoPrefix}-${seq.value}`, nameBn: name.bn, nameEn: name.en, sex: u.sex,
      approxAgeYears: u.approxAgeYears, approxAgeAt: u.approxAgeYears === null ? null : now, identityConfidence: "provisional", identityMethod: "er-quick",
    } });
    await tx.provenance.create({ data: { tenantId: s.tenantId, targetType: "Patient", targetId: p.id, activity: "register-provisional", agentId: s.userId, onBehalfOf: s.organizationId, recorded: now, source: "provider_verified", detail: { arrivalMode: req.arrivalMode, features: u.features ?? null } } });
    const task = await tx.task.create({ data: { tenantId: s.tenantId, kind: "patient-link-review", status: "requested", focusId: p.id, reason: "ER provisional registration — identity to be confirmed at the desk", detail: { provisional: true, features: u.features ?? null, broughtBy: req.broughtBy ?? null }, requestedById: s.userId, requestedAt: now } });
    audit.push({ action: "create", entity: "Patient", entityId: p.id, patientId: p.id, detail: { provisional: true, reviewTaskId: task.id } });
    patientId = p.id; review = true;
  }
  const open = await tx.encounter.findFirst({ where: { patientId, class: "er", organizationId: s.organizationId, status: { in: ["arrived", "triaged", "in_progress"] } } });
  if (open) throw err(409, "er_visit_exists", `এই রোগী ইতিমধ্যে জরুরি বিভাগে আছেন (${open.token})`, `This patient is already in the ER (${open.token})`, { existing: { encounterId: open.id, token: open.token } });
  const day = dhakaDay(now);
  const seqName = erTokenSequenceName(branch.id, day);
  const seq = await tx.sequence.upsert({ where: { tenantId_name: { tenantId: s.tenantId, name: seqName } }, create: { tenantId: s.tenantId, name: seqName, value: 1 }, update: { value: { increment: 1 } } });
  const status = transition("encounter", ENCOUNTER, "planned", "arrive");
  const e = await tx.encounter.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, branchId: branch.id, patientId, class: "er", status: under<DbEncStatus>(status), visitType: "er",
    token: erToken(seq.value), tokenNo: seq.value, tokenDay: day, arrivedAt: now, statusAt: now, createdById: s.userId,
  } });
  const note = await tx.composition.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, branchId: branch.id, patientId, encounterId: e.id, kind: ER_NOTE, version: 1, status: "draft",
    sections: { notes: "", careOrders: [], disposition: null } as object, sectionSources: {}, authorId: s.userId,
  } });
  await tx.erVisit.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, branchId: branch.id, encounterId: e.id, patientId, arrivalMode: req.arrivalMode, broughtBy: req.broughtBy?.trim() || null,
    complaint: req.complaint.trim(), features: req.unknown?.features?.trim() || null, compositionId: note.id, createdById: s.userId,
  } });
  audit.push({ action: "create", entity: "Encounter", entityId: e.id, patientId, detail: { class: "er", token: e.token, arrivalMode: req.arrivalMode, noteId: note.id } });
  if (req.bayId) audit.push(...(await takeBay(tx, s, { id: e.id, patientId }, req.bayId, now)));
  const full = await erEncounter(tx, s, e.id);
  return { item: await itemOf(tx, s, full, now), patient: toSummary(await getPatient(tx, patientId)), review, audit };
}

/* ───── triage and assignment (B1) ───── */
export async function triage(tx: Tx, s: SessionData, id: string, req: ErTriageRequest, now: Date) {
  const e = await erEncounter(tx, s, id);
  if (!isTriageLevel(req.level)) throw err(400, "triage_level", "স্তর ১–৫", "Level 1–5", { field: "level" });
  const from = dash<EncounterState>(e.status);
  let to: EncounterState;
  try { to = triageTransition(from); } catch { throw closed(); }
  const n = await tx.encounter.updateMany({ where: { id: e.id, status: e.status }, data: { status: under<DbEncStatus>(to), statusAt: from === to ? e.statusAt : now } });
  if (n.count !== 1) throw stale();
  const level = triageLevel(req.level)!;
  await tx.erVisit.update({ where: { encounterId: e.id }, data: { triageLevel: level.level, triageTargetMinutes: level.targetMinutes, triagedAt: now, triagedById: s.userId } });
  const audit: AuditEntry[] = [{ action: "update", entity: "Encounter", entityId: e.id, patientId: e.patientId, detail: { event: "triage", from, to, level: level.level, previousLevel: e.erVisit!.triageLevel, scaleSample: TRIAGE_SCALE_SAMPLE } }];
  if (req.bayId !== undefined) {
    const current = await tx.bedAssignment.findFirst({ where: { encounterId: e.id, status: "occupied" } });
    if (req.bayId === null) { if (current) audit.push(...(await leaveBay(tx, s, e.id, now))); }
    else if (current?.bedId !== req.bayId) {
      // a bay-to-bay move inside the ER: the new bay is taken, the old one vacated into cleaning, one transfer id
      const transferId = current?.transferId ?? randomUUID();
      if (current) audit.push(...(await leaveBay(tx, s, e.id, now)));
      audit.push(...(await takeBay(tx, s, { id: e.id, patientId: e.patientId }, req.bayId, now, transferId)));
    }
  }
  return { item: await itemOf(tx, s, await erEncounter(tx, s, e.id), now), audit };
}

export async function assign(tx: Tx, s: SessionData, id: string, req: ErAssignRequest, now: Date) {
  const e = await erEncounter(tx, s, id);
  const doctors = await erDoctors(tx, s);
  const d = doctors.find((x) => x.id === req.doctorId);
  if (!d) throw err(400, "doctor_unknown", "এই ডাক্তার এই প্রতিষ্ঠানে নেই", "No such doctor at this facility", { field: "doctorId" });
  const age = ageOf(e.patient, now);
  if (paediatricPrompt(d.speciality, age) && !req.paediatricOk)
    throw err(422, "paediatric_confirm", `শিশু বিশেষজ্ঞ — রোগীর বয়স ${age}। চালিয়ে যাবেন?`, `Paediatrician — the patient is ${age}y. Continue?`, { field: "doctorId" });
  const from = dash<EncounterState>(e.status);
  let to: EncounterState;
  try { to = assignTransition(from); } catch { throw closed(); }
  const n = await tx.encounter.updateMany({ where: { id: e.id, status: e.status }, data: { status: under<DbEncStatus>(to), practitionerId: d.id, statusAt: from === to ? e.statusAt : now } });
  if (n.count !== 1) throw stale();
  const audit: AuditEntry[] = [{ action: "update", entity: "Encounter", entityId: e.id, patientId: e.patientId, detail: { event: from === to ? "assign" : "start", from, to, doctorId: d.id, previousDoctorId: e.practitionerId, paediatricOk: Boolean(req.paediatricOk) } }];
  return { item: await itemOf(tx, s, await erEncounter(tx, s, e.id), now), audit };
}

/* ───── orders & disposition (B2) ───── */
type Note = NonNullable<Awaited<ReturnType<Tx["composition"]["findFirst"]>>>;
async function noteOf(tx: Tx, e: Enc): Promise<Note> {
  const c = await tx.composition.findFirst({ where: { encounterId: e.id, kind: ER_NOTE }, orderBy: { version: "desc" } });
  if (!c) throw stale();
  return c;
}
const requireDraft = (c: Note) => { if (c.status !== "draft") throw err(409, "note_signed", "সিদ্ধান্ত স্বাক্ষরিত — নোট আর বদলানো যায় না", "The disposition is signed — the note cannot change"); };
export async function erVisitView(tx: Tx, s: SessionData, id: string, now: Date): Promise<{ view: ErVisitView; revealed: { allergyIds: string[]; noteId: string } }> {
  const e = await erEncounter(tx, s, id);
  const c = await noteOf(tx, e);
  const sec = c.sections as unknown as ErNoteSections;
  const [orders, allergies, tests, doctors, live] = await Promise.all([
    tx.serviceRequest.findMany({ where: { encounterId: e.id, compositionId: c.id }, orderBy: { createdAt: "asc" } }),
    tx.allergyIntolerance.findMany({ where: { patientId: e.patientId }, orderBy: [{ status: "asc" }, { recordedAt: "asc" }] }),
    tx.orderableTest.findMany({ where: { active: true, group: "lab" }, orderBy: { nameEn: "asc" } }),
    erDoctors(tx, s), liveByBed(tx, s),
  ]);
  const people = new Map((await tx.user.findMany({ where: { id: { in: [...new Set([...orders.map((o) => o.orderedById), c.signedById].filter((x): x is string => Boolean(x)))] } }, select: { id: true, nameBn: true, nameEn: true } })).map((u) => [u.id, u]));
  const person = (uid: string | null) => (uid && people.get(uid)) || { id: uid ?? "", nameBn: "—", nameEn: "—" };
  const wards = new Map((await tx.location.findMany({ where: { organizationId: s.organizationId, kind: "ward" } })).map((w) => [w.id, w]));
  const beds = await tx.location.findMany({ where: { organizationId: s.organizationId, kind: "bed", bedClass: { not: "ER" } }, orderBy: { name: "asc" } });
  return {
    view: {
      item: await itemOf(tx, s, e, now), patient: toSummary(await getPatient(tx, e.patientId)), allergies: await toAllergyView(tx, allergies),
      note: { id: c.id, status: dash<"draft">(c.status), rev: c.rev, version: c.version, signedAt: iso(c.signedAt), signedBy: c.signedById ? person(c.signedById) : null, notes: sec.notes ?? "" },
      orders: orders.map((o) => ({ id: o.id, testCode: o.testCode, nameEn: o.nameEn, nameBn: o.nameBn, priority: o.priority, status: dash<"active">(o.status), orderedAt: iso(o.orderedAt), orderedBy: person(o.orderedById) })),
      careOrders: CARE_ORDERS_SAMPLE.map((o) => { const on = (sec.careOrders ?? []).find((x) => x.key === o.key); return { ...o, on: Boolean(on), at: on?.at ?? null }; }),
      tests: tests.map((t) => ({ code: t.code, nameEn: t.nameEn, nameBn: t.nameBn, group: t.group as "lab" })),
      disposition: sec.disposition ?? null,
      beds: beds.filter((b) => isAdmissionClass(b.bedClass ?? "")).map((b) => {
        const a = live.get(b.id);
        const pick = bedPickable({ state: dash(b.bedState ?? "vacant"), bedClass: b.bedClass, reservedForPatientId: a?.status === "reserved" ? a.patientId : null }, e.patientId);
        const w = b.parentId ? wards.get(b.parentId) : undefined;
        return { id: b.id, name: b.name, ward: w?.name ?? "", wardBn: w?.nameBn ?? null, bedClass: b.bedClass ?? "", state: dash<"vacant">(b.bedState ?? "vacant"), pickable: pick.ok, reason: pick.ok ? null : pick.reason };
      }),
      consultants: doctors, scale: scaleView(), sample: true,
    },
    revealed: { allergyIds: allergies.map((a) => a.id), noteId: c.id },
  };
}

/** One tap: a STAT lab order, active the moment it is placed (ADR 0014). */
export async function placeOrder(tx: Tx, s: SessionData, id: string, testCode: string, now: Date) {
  const e = await erEncounter(tx, s, id);
  if (!erOpen(dash<EncounterState>(e.status))) throw closed();
  const c = await noteOf(tx, e); requireDraft(c);
  const t = await tx.orderableTest.findFirst({ where: { code: testCode, active: true, group: "lab" } });
  if (!t) throw err(400, "unknown_test", "এই টেস্ট তালিকায় নেই", "No such lab test", { field: "testCode" });
  if (await tx.serviceRequest.findFirst({ where: { encounterId: e.id, testCode, status: { not: "revoked" } }, select: { id: true } }))
    throw err(409, "already_ordered", "এই টেস্ট ইতিমধ্যে অর্ডার হয়েছে", "This test is already ordered", { field: "testCode" });
  // ORDER draft → order → active in one transaction (the database lets an order start only as a draft of a draft note)
  const status = transition("order", ORDER, "draft", "order");
  const o = await tx.serviceRequest.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, branchId: e.branchId, patientId: e.patientId, encounterId: e.id, compositionId: c.id,
    testCode: t.code, nameEn: t.nameEn, nameBn: t.nameBn, group: t.group, priority: "stat", status: "draft", orderedById: s.userId, orderedAt: now, statusAt: now,
  } });
  await tx.serviceRequest.update({ where: { id: o.id }, data: { status: under<"active">(status), statusAt: now } });
  await tx.provenance.create({ data: { tenantId: s.tenantId, targetType: "ServiceRequest", targetId: o.id, activity: "er-order", agentId: s.userId, onBehalfOf: s.organizationId, recorded: now, source: "provider_verified", detail: { encounterId: e.id, priority: "stat" } } });
  const audit: AuditEntry[] = [{ action: "create", entity: "ServiceRequest", entityId: o.id, patientId: e.patientId, detail: { encounterId: e.id, testCode: t.code, priority: "stat", status } }];
  return { ...(await erVisitView(tx, s, e.id, now)), audit };
}
export async function toggleCareOrder(tx: Tx, s: SessionData, id: string, key: string, on: boolean, now: Date) {
  const e = await erEncounter(tx, s, id);
  if (!erOpen(dash<EncounterState>(e.status))) throw closed();
  const c = await noteOf(tx, e); requireDraft(c);
  const o = careOrder(key);
  if (!o) throw err(400, "unknown_care_order", "এই অর্ডার তালিকায় নেই", "No such care order", { field: "key" });
  const sec = c.sections as unknown as ErNoteSections;
  const list = (sec.careOrders ?? []).filter((x) => x.key !== key);
  if (on) list.push({ key, at: now.toISOString(), by: s.userId });
  const n = await tx.composition.updateMany({ where: { id: c.id, status: "draft", rev: c.rev }, data: { rev: c.rev + 1, sections: { ...sec, careOrders: list } as object } });
  if (n.count !== 1) throw stale();
  const audit: AuditEntry[] = [{ action: "update", entity: "Composition", entityId: c.id, patientId: e.patientId, detail: { event: on ? "care-order-on" : "care-order-off", key, sample: true } }];
  return { ...(await erVisitView(tx, s, e.id, now)), audit };
}
export async function saveNotes(tx: Tx, s: SessionData, id: string, rev: number, notes: string, now: Date) {
  const e = await erEncounter(tx, s, id);
  if (!erOpen(dash<EncounterState>(e.status))) throw closed();
  const c = await noteOf(tx, e); requireDraft(c);
  if (rev !== c.rev) throw stale();
  const sec = c.sections as unknown as ErNoteSections;
  const n = await tx.composition.updateMany({ where: { id: c.id, status: "draft", rev: c.rev }, data: { rev: c.rev + 1, sections: { ...sec, notes } as object } });
  if (n.count !== 1) throw stale();
  return { ...(await erVisitView(tx, s, e.id, now)), audit: [{ action: "update", entity: "Composition", entityId: c.id, patientId: e.patientId, detail: { event: "notes" } }] as AuditEntry[] };
}

/** Sign the disposition (doctor, PIN): the ER note goes draft → final. Admit reserves the ward bed (leg 1) and opens
    an admission request; discharge / refer / death close the visit (ENCOUNTER finish) and vacate the bay. */
export async function signDisposition(tx: Tx, s: SessionData, id: string, body: ErDispositionRequest, now: Date) {
  if (s.role !== "doctor") throw err(403, "forbidden", "সিদ্ধান্ত স্বাক্ষর করেন ডাক্তার", "A doctor signs the disposition", { reason: "role", canRequest: false });
  const e = await erEncounter(tx, s, id);
  if (!erOpen(dash<EncounterState>(e.status))) throw closed();
  const c = await noteOf(tx, e); requireDraft(c);
  const u = await tx.user.findFirst({ where: { id: s.userId }, select: { pinHash: true } });
  await requirePin(s.userId, () => Boolean(u?.pinHash) && u!.pinHash === devHash(body.pin));
  if (body.rev !== c.rev) throw stale();
  const d = body.disposition;
  const blockers = dispositionBlockers(d);
  if (blockers.length) throw err(422, "sign_blocked", `${blockers.length}টি ঘর ঠিক করুন — স্বাক্ষর হয়নি`, `Resolve ${blockers.length} item(s) — not signed`, { blockers: blockers as unknown as Record<string, unknown>[] });
  const audit: AuditEntry[] = [];
  // the signing doctor takes the visit when nobody has (so it can finish / be admitted)
  let from = dash<EncounterState>(e.status);
  if (from !== "in-progress") {
    const to = assignTransition(from);
    const n = await tx.encounter.updateMany({ where: { id: e.id, status: e.status }, data: { status: under<DbEncStatus>(to), practitionerId: e.practitionerId ?? s.userId, statusAt: now } });
    if (n.count !== 1) throw stale();
    audit.push({ action: "update", entity: "Encounter", entityId: e.id, patientId: e.patientId, detail: { event: "start", from, to, doctorId: e.practitionerId ?? s.userId, bySigning: true } });
    from = to;
  }
  if (d.kind === "admit") {
    const bed = await tx.location.findFirst({ where: { id: d.bedId!, organizationId: s.organizationId, kind: "bed" } });
    if (!bed || !isAdmissionClass(bed.bedClass ?? "")) throw err(400, "bed_unknown", "এই শয্যা পাওয়া যায়নি", "No such ward bed", { field: "bedId" });
    const live = await tx.bedAssignment.findFirst({ where: { bedId: bed.id, status: { in: ["reserved", "occupied"] } } });
    const pick = bedPickable({ state: dash(bed.bedState ?? "vacant"), bedClass: bed.bedClass, reservedForPatientId: live?.status === "reserved" ? live.patientId : null }, e.patientId);
    if (!pick.ok) throw err(409, "bed_not_free", `${bed.name} বাছাই করা যাবে না (${pick.reason})`, `${bed.name} cannot be picked (${pick.reason})`, { field: "bedId" });
    const consultant = (await erDoctors(tx, s)).find((x) => x.id === d.consultantId);
    if (!consultant) throw err(400, "doctor_unknown", "এই কনসালট্যান্ট এই প্রতিষ্ঠানে নেই", "No such consultant at this facility", { field: "consultantId" });
    if (live?.patientId !== e.patientId) {
      // leg 1: reserve the ward bed for this patient
      const to = under<DbBedState>(reserveLeg(dash(bed.bedState ?? "vacant")).destination);
      const n = await tx.location.updateMany({ where: { id: bed.id, bedState: bed.bedState }, data: { bedState: to } });
      if (n.count !== 1) throw stale();
      const transferId = randomUUID();
      try {
        await tx.bedAssignment.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, encounterId: e.id, patientId: e.patientId, bedId: bed.id, status: "reserved", transferId, reservedAt: now, reservedById: s.userId } });
      } catch (x) {
        if (isUnique(x)) throw err(409, "patient_has_reservation", "এই রোগীর জন্য ইতিমধ্যে একটি শয্যা সংরক্ষিত", "A bed is already reserved for this patient", { field: "bedId" });
        throw x;
      }
      audit.push({ action: "update", entity: "Location", entityId: bed.id, patientId: e.patientId, detail: { event: "reserve", bed: bed.name, to: dash(to), encounterId: e.id, transferId, leg: 1 } });
    }
    try {
      const adm = await tx.admission.create({ data: {
        tenantId: s.tenantId, organizationId: s.organizationId, branchId: e.branchId, patientId: e.patientId, sourceEncounterId: e.id, source: "er", status: "requested",
        admittingDoctorId: consultant.id, department: consultant.speciality ?? "", diagnosis: d.diagnosis!.trim(), bedClass: bed.bedClass ?? "", bedId: bed.id, requestedById: s.userId, requestedAt: now,
      } });
      audit.push({ action: "create", entity: "Admission", entityId: adm.id, patientId: e.patientId, detail: { source: "er", sourceEncounterId: e.id, bedId: bed.id, bed: bed.name, consultantId: consultant.id } });
    } catch (x) {
      if (isUnique(x)) throw err(409, "admission_requested", "এই রোগীর একটি ভর্তি অনুরোধ ইতিমধ্যে খোলা", "An admission is already requested for this patient");
      throw x;
    }
  }
  const to = signDocument({ status: dash(c.status), amendsId: c.amendsId, amendReason: c.amendReason });
  transition("document", DOCUMENT, "draft", "sign");
  const sec = c.sections as unknown as ErNoteSections;
  const signed = await tx.composition.updateMany({ where: { id: c.id, status: "draft", rev: c.rev }, data: { status: under<"final">(to), signedAt: now, signedById: s.userId, sections: { ...sec, disposition: d } as object } });
  if (signed.count !== 1) throw stale();
  await tx.erVisit.update({ where: { encounterId: e.id }, data: { dispositionKind: d.kind, dispositionDetail: d as object, dispositionSignedAt: now, dispositionSignedById: s.userId } });
  await tx.provenance.create({ data: { tenantId: s.tenantId, targetType: "Composition", targetId: c.id, activity: "sign", agentId: s.userId, onBehalfOf: s.organizationId, recorded: now, source: "provider_verified", detail: { kind: ER_NOTE, disposition: d.kind, version: c.version } } });
  audit.push({ action: "sign", entity: "Composition", entityId: c.id, patientId: e.patientId, detail: { kind: ER_NOTE, disposition: d.kind, version: c.version, from: "draft", to } });
  if (closesOnSign(d.kind)) {
    const fin = transition("encounter", ENCOUNTER, from, "finish");
    const n = await tx.encounter.updateMany({ where: { id: e.id, status: under<DbEncStatus>(from) }, data: { status: under<DbEncStatus>(fin), statusAt: now } });
    if (n.count !== 1) throw stale();
    audit.push({ action: "update", entity: "Encounter", entityId: e.id, patientId: e.patientId, detail: { event: "finish", from, to: fin, disposition: d.kind } });
    audit.push(...(await leaveBay(tx, s, e.id, now)));
  }
  return { ...(await erVisitView(tx, s, e.id, now)), audit };
}
