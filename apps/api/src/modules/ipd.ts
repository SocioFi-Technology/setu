/* Admission and beds (ADR 0014, walkthrough B2–B3). The desk's Admit is one transaction: the IPD encounter, the bed
   move's second leg (or both legs for a direct admission), the source ER visit finished and its bay vacated,
   ADM/yy/nnnn, and the IPD bill draft — created here and nowhere else (the database checks that at commit). */
import { randomUUID } from "node:crypto";
import type { AdmissionItem, AdmissionList, AdmissionView, AdmitRequest, BedActionRequest, BedBoard, BedView } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  ADMISSION, ADMISSION_SEQUENCE, BED, BED_CLASSES_SAMPLE, CONSENTS, DEPARTMENTS_SAMPLE, admissionBlockers, admissionChecklist, admissionEncounterState, admissionNumber, bedPickable, dhakaDay,
  finishSource, guardianPhoneDigits, isAdmissionClass, isConsentKey, occupyLeg, transition, type AdmissionForm, type BedState, type EncounterState,
} from "@setu/domain";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { bedNotFree, dash, endAssignment, erDoctors, erPatient, iso, isUnique, resolvedPatient, stale, under, type DbBedState, type DbEncStatus } from "./er.js";
import { branchOf, getPatient, notFound, toSummary } from "./frontdesk.js";

type Bed = NonNullable<Awaited<ReturnType<Tx["location"]["findFirst"]>>>;
type Live = NonNullable<Awaited<ReturnType<Tx["bedAssignment"]["findFirst"]>>>;
type PatientRow = NonNullable<Awaited<ReturnType<Tx["patient"]["findFirst"]>>>;
const classes = () => BED_CLASSES_SAMPLE.filter((c) => c.key !== "ER").map((c) => ({ ...c, sample: true as const }));
async function people(tx: Tx, ids: (string | null | undefined)[]) {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const rows = want.length ? await tx.user.findMany({ where: { id: { in: want } }, select: { id: true, nameBn: true, nameEn: true } }) : [];
  const m = new Map(rows.map((u) => [u.id, u]));
  return (id: string | null | undefined) => (id && m.get(id)) || { id: id ?? "", nameBn: "—", nameEn: "—" };
}

/* ───── beds ───── */
function bedView(b: Bed, wards: Map<string, Bed>, live: Map<string, Live>, patients: Map<string, PatientRow>): BedView {
  const a = live.get(b.id);
  const w = b.parentId ? wards.get(b.parentId) : undefined;
  const p = a ? patients.get(a.patientId) : undefined;
  return {
    id: b.id, name: b.name, nameBn: b.nameBn, ward: { id: w?.id ?? "", name: w?.name ?? "", nameBn: w?.nameBn ?? null }, bedClass: b.bedClass ?? "", state: dash<"vacant">(b.bedState ?? "vacant"), note: b.bedNote,
    patient: p ? erPatient(p) : null,
    assignment: a ? { id: a.id, status: a.status as "reserved" | "occupied", encounterId: a.encounterId, since: (a.status === "occupied" ? a.occupiedAt : a.reservedAt)?.toISOString() ?? a.createdAt.toISOString() } : null,
  };
}
async function bedContext(tx: Tx, s: SessionData) {
  const [locs, liveRows] = await Promise.all([
    tx.location.findMany({ where: { organizationId: s.organizationId, kind: { in: ["ward", "bed"] } }, orderBy: { name: "asc" } }),
    tx.bedAssignment.findMany({ where: { organizationId: s.organizationId, status: { in: ["reserved", "occupied"] } } }),
  ]);
  const wards = new Map(locs.filter((l) => l.kind === "ward").map((w) => [w.id, w]));
  const live = new Map(liveRows.map((r) => [r.bedId, r]));
  const pids = [...new Set(liveRows.map((r) => r.patientId))];
  const patients = new Map((pids.length ? await tx.patient.findMany({ where: { id: { in: pids } } }) : []).map((p) => [p.id, p]));
  return { beds: locs.filter((l) => l.kind === "bed"), wards, live, patients };
}
export async function bedBoard(tx: Tx, s: SessionData, cls?: string): Promise<{ board: BedBoard; patientIds: string[] }> {
  const c = await bedContext(tx, s);
  const beds = c.beds.filter((b) => !cls || b.bedClass === cls);
  const views = beds.map((b) => bedView(b, c.wards, c.live, c.patients));
  const counts = { vacant: 0, reserved: 0, occupied: 0, dischargePending: 0, cleaning: 0, blocked: 0 };
  for (const v of views) counts[v.state === "discharge-pending" ? "dischargePending" : v.state]++;
  const wards = [...c.wards.values()].map((w) => ({ id: w.id, name: w.name, nameBn: w.nameBn, beds: views.filter((v) => v.ward.id === w.id) })).filter((w) => w.beds.length);
  return { board: { wards, classes: classes(), counts }, patientIds: views.flatMap((v) => (v.patient ? [v.patient.id] : [])) };
}
/** Ward actions through BED: block (reason), unblock, mark ready. Never on a bed somebody holds. */
export async function bedAction(tx: Tx, s: SessionData, bedId: string, req: BedActionRequest, now: Date): Promise<{ bed: BedView; audit: AuditEntry[] }> {
  const b = await tx.location.findFirst({ where: { id: bedId, organizationId: s.organizationId, kind: "bed" } });
  if (!b) throw notFound();
  const from = dash<BedState>(b.bedState ?? "vacant");
  if (req.action === "block" && (req.reason ?? "").trim().length < 3) throw err(400, "reason_required", "কারণ লিখুন", "Give a reason", { field: "reason" });
  let to: BedState;
  try { to = transition("bed", BED, from, req.action); }
  catch { throw err(409, "bed_state", `${b.name}: ${from} থেকে ${req.action} হয় না`, `${b.name}: cannot ${req.action} from ${from}`); }
  const n = await tx.location.updateMany({ where: { id: b.id, bedState: b.bedState }, data: { bedState: under<DbBedState>(to), bedNote: req.action === "block" ? req.reason!.trim() : null } });
  if (n.count !== 1) throw stale();
  const c = await bedContext(tx, s);
  const after = c.beds.find((x) => x.id === b.id)!;
  return { bed: bedView(after, c.wards, c.live, c.patients), audit: [{ action: "update", entity: "Location", entityId: b.id, detail: { event: req.action, bed: b.name, from, to, reason: req.reason ?? null } }] };
}

/* ───── admissions ───── */
type Adm = NonNullable<Awaited<ReturnType<Tx["admission"]["findFirst"]>>>;
async function admissionItems(tx: Tx, s: SessionData, rows: Adm[]): Promise<AdmissionItem[]> {
  const patients = new Map((await tx.patient.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.patientId))] } } })).map((p) => [p.id, p]));
  const beds = new Map((await tx.location.findMany({ where: { organizationId: s.organizationId, kind: { in: ["bed", "ward"] } } })).map((b) => [b.id, b]));
  const who = await people(tx, rows.flatMap((r) => [r.admittingDoctorId, r.requestedById]));
  return rows.flatMap((a) => {
    const p = patients.get(a.patientId); const b = beds.get(a.bedId);
    if (!p || !b) return [];
    return [{
      id: a.id, status: a.status as AdmissionItem["status"], source: a.source as AdmissionItem["source"], number: a.number, patient: erPatient(p), sourceEncounterId: a.sourceEncounterId, encounterId: a.encounterId,
      diagnosis: a.diagnosis, department: a.department, bedClass: a.bedClass, bed: { id: b.id, name: b.name, ward: beds.get(b.parentId ?? "")?.name ?? "", state: dash<"vacant">(b.bedState ?? "vacant") },
      admittingDoctor: who(a.admittingDoctorId), requestedAt: a.requestedAt.toISOString(), requestedBy: who(a.requestedById), admittedAt: iso(a.admittedAt),
    }];
  });
}
export async function admissionList(tx: Tx, s: SessionData, now: Date): Promise<{ list: AdmissionList; patientIds: string[] }> {
  const dayStart = new Date(`${dhakaDay(now)}T00:00:00+06:00`);
  const [requested, admitted, doctors] = await Promise.all([
    tx.admission.findMany({ where: { organizationId: s.organizationId, status: "requested" }, orderBy: { requestedAt: "asc" } }),
    tx.admission.findMany({ where: { organizationId: s.organizationId, status: "admitted", admittedAt: { gte: dayStart } }, orderBy: { admittedAt: "desc" } }),
    erDoctors(tx, s),
  ]);
  const list: AdmissionList = {
    requested: await admissionItems(tx, s, requested), admitted: await admissionItems(tx, s, admitted),
    options: { doctors: doctors.map((d) => ({ id: d.id, nameBn: d.nameBn, nameEn: d.nameEn, speciality: d.speciality })), departments: DEPARTMENTS_SAMPLE.map((d) => ({ ...d })), consents: CONSENTS.map((c) => ({ ...c })), classes: classes() },
  };
  return { list, patientIds: [...requested, ...admitted].map((a) => a.patientId) };
}
export async function admissionView(tx: Tx, s: SessionData, id: string): Promise<AdmissionView> {
  const a = await tx.admission.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!a) throw notFound();
  const c = await bedContext(tx, s);
  const bed = c.beds.find((b) => b.id === a.bedId);
  if (!bed) throw stale();
  const [enc, src, inv, doctor] = await Promise.all([
    a.encounterId ? tx.encounter.findFirst({ where: { id: a.encounterId } }) : null,
    a.sourceEncounterId ? tx.encounter.findFirst({ where: { id: a.sourceEncounterId } }) : null,
    a.invoiceId ? tx.invoice.findFirst({ where: { id: a.invoiceId } }) : null,
    tx.user.findFirst({ where: { id: a.admittingDoctorId }, select: { id: true, nameBn: true, nameEn: true, practitioner: { select: { speciality: true } } } }),
  ]);
  const who = await people(tx, [a.requestedById, a.admittedById]);
  const transferIds = [...new Set((await tx.bedAssignment.findMany({ where: { patientId: a.patientId, OR: [{ encounterId: a.encounterId ?? "" }, { encounterId: a.sourceEncounterId ?? "" }] }, select: { transferId: true } })).map((r) => r.transferId))];
  const legs = transferIds.length ? await tx.bedAssignment.findMany({ where: { transferId: { in: transferIds } }, orderBy: { createdAt: "asc" } }) : [];
  const form: AdmissionForm = { bedId: a.bedId, diagnosis: a.diagnosis, guardianName: a.guardianName ?? "", guardianPhone: a.guardianPhone ?? "", consents: a.consents };
  return {
    id: a.id, number: a.number, status: a.status as AdmissionView["status"], source: a.source as AdmissionView["source"], patient: toSummary(await getPatient(tx, a.patientId)),
    encounter: enc ? { id: enc.id, status: dash(enc.status), token: enc.token } : null,
    sourceEncounter: src ? { id: src.id, class: src.class, status: dash(src.status), token: src.token } : null,
    bed: bedView(bed, c.wards, c.live, c.patients),
    admittingDoctor: { id: a.admittingDoctorId, nameBn: doctor?.nameBn ?? "—", nameEn: doctor?.nameEn ?? "—", speciality: doctor?.practitioner?.speciality ?? null },
    department: a.department, diagnosis: a.diagnosis, bedClass: a.bedClass,
    guardian: a.guardianName ? { name: a.guardianName, relationship: a.guardianRelationship ?? "", phone: a.guardianPhone ?? "" } : null, consents: a.consents,
    checklist: admissionChecklist(form),
    invoice: inv ? { id: inv.id, kind: "ipd", status: dash(inv.status), number: inv.number } : null,
    requestedAt: a.requestedAt.toISOString(), requestedBy: who(a.requestedById), admittedAt: iso(a.admittedAt), admittedBy: a.admittedById ? who(a.admittedById) : null,
    legs: legs.map((l) => ({ id: l.id, bed: c.beds.find((b) => b.id === l.bedId)?.name ?? l.bedId, status: l.status, transferId: l.transferId, at: (l.occupiedAt ?? l.reservedAt ?? l.createdAt).toISOString(), endReason: l.endReason })),
  };
}

/** The desk's Admit — one transaction (ADR 0014). */
export async function admit(tx: Tx, s: SessionData, req: AdmitRequest, now: Date): Promise<{ view: AdmissionView; audit: AuditEntry[] }> {
  const branch = await branchOf(tx, s);
  const audit: AuditEntry[] = [];
  let request: Adm | null = null;
  let patientId: string; let source: AdmitRequest["source"]; let sourceEncounterId: string | null;
  if (req.admissionId) {
    request = await tx.admission.findFirst({ where: { id: req.admissionId, organizationId: s.organizationId } });
    if (!request) throw notFound();
    if (request.status !== "requested") throw err(409, "admission_not_open", "এই ভর্তি অনুরোধ আর খোলা নেই", "This admission request is no longer open");
    patientId = request.patientId; source = request.source as AdmitRequest["source"]; sourceEncounterId = request.sourceEncounterId;
  } else {
    patientId = (await resolvedPatient(tx, req.patientId!)).id; source = req.source ?? "direct"; sourceEncounterId = req.sourceEncounterId ?? null;
    // review: a direct admission of a patient who is in the ER right now comes from that visit (its bay is vacated, the visit ends)
    if (!sourceEncounterId) {
      const inEr = await tx.encounter.findFirst({ where: { patientId, class: "er", organizationId: s.organizationId, status: { in: ["arrived", "triaged", "in_progress"] } }, select: { id: true } });
      if (inEr) { sourceEncounterId = inEr.id; source = "er"; }
    }
  }
  // the checklist (the screen runs the same list); refused as one answer so the desk sees everything at once
  const form: AdmissionForm = { bedId: req.bedId, diagnosis: req.diagnosis, guardianName: req.guardian.name, guardianPhone: req.guardian.phone, consents: req.consents };
  const blockers = admissionBlockers(form);
  const badConsent = req.consents.find((k) => !isConsentKey(k));
  if (badConsent) throw err(400, "unknown_consent", "অজানা সম্মতিপত্র", "Unknown consent", { field: "consents" });
  if (blockers.length) throw err(422, "admission_blocked", `${blockers.length}টি ধাপ বাকি — ভর্তি হয়নি`, `${blockers.length} step(s) left — not admitted`, { blockers: admissionChecklist(form).filter((c) => c.blocks && !c.ok) as unknown as Record<string, unknown>[] });
  if (!isAdmissionClass(req.bedClass)) throw err(400, "bed_class", "এই শ্রেণিতে ভর্তি হয় না", "Not an admission class", { field: "bedClass" });
  const doctor = (await erDoctors(tx, s)).find((d) => d.id === req.admittingDoctorId);
  if (!doctor) throw err(400, "doctor_unknown", "এই ডাক্তার এই প্রতিষ্ঠানে নেই", "No such doctor at this facility", { field: "admittingDoctorId" });
  const bed = await tx.location.findFirst({ where: { id: req.bedId!, organizationId: s.organizationId, kind: "bed" } });
  if (!bed || bed.bedClass !== req.bedClass) throw err(400, "bed_unknown", "এই শ্রেণিতে এই শয্যা নেই", "No such bed in this class", { field: "bedId" });
  const liveOnBed = await tx.bedAssignment.findFirst({ where: { bedId: bed.id, status: { in: ["reserved", "occupied"] } } });
  const pick = bedPickable({ state: dash(bed.bedState ?? "vacant"), bedClass: bed.bedClass, reservedForPatientId: liveOnBed?.status === "reserved" ? liveOnBed.patientId : null }, patientId);
  if (!pick.ok) throw bedNotFree(bed.name, pick.reason);
  // the source visit (ER): the patient's, still open; its bay is the move's source
  const src = sourceEncounterId ? await tx.encounter.findFirst({ where: { id: sourceEncounterId, organizationId: s.organizationId } }) : null;
  if (sourceEncounterId && (!src || src.patientId !== patientId)) throw err(400, "source_unknown", "উৎস ভিজিট পাওয়া যায়নি", "The source visit was not found", { field: "sourceEncounterId" });
  const sourceBay = src ? await tx.bedAssignment.findFirst({ where: { encounterId: src.id, status: "occupied" } }) : null;
  const sourceBed = sourceBay ? await tx.location.findFirst({ where: { id: sourceBay.bedId } }) : null;
  // a reservation held for this patient elsewhere (the ER chose another bed) is released first
  const otherReservation = await tx.bedAssignment.findFirst({ where: { patientId, status: "reserved", bedId: { not: bed.id } } });
  if (otherReservation) {
    const ob = await tx.location.findFirst({ where: { id: otherReservation.bedId } });
    if (!ob) throw stale();
    const to = under<DbBedState>(transition("bed", BED, dash(ob.bedState ?? "reserved"), "release"));
    const n = await tx.location.updateMany({ where: { id: ob.id, bedState: ob.bedState }, data: { bedState: to } });
    if (n.count !== 1) throw stale();
    await endAssignment(tx, s, otherReservation, now, "released");
    audit.push({ action: "update", entity: "Location", entityId: ob.id, patientId, detail: { event: "release", bed: ob.name, to: dash(to), transferId: otherReservation.transferId } });
  }
  // the IPD encounter: planned → arrived → in-progress in one step; ADM/yy/nnnn from the facility's sequence
  const seqName = `${ADMISSION_SEQUENCE}:${s.organizationId}`;
  const seq = await tx.sequence.upsert({ where: { tenantId_name: { tenantId: s.tenantId, name: seqName } }, create: { tenantId: s.tenantId, name: seqName, value: 1 }, update: { value: { increment: 1 } } });
  const day = dhakaDay(now);
  const number = admissionNumber(day.slice(2, 4), seq.value);
  let enc: NonNullable<Awaited<ReturnType<Tx["encounter"]["findFirst"]>>>;
  try {
    enc = await tx.encounter.create({ data: {
      tenantId: s.tenantId, organizationId: s.organizationId, branchId: branch.id, patientId, class: "ipd", status: under<DbEncStatus>(admissionEncounterState()), visitType: "admission",
      practitionerId: doctor.id, token: number, tokenNo: seq.value, tokenDay: day, arrivedAt: now, statusAt: now, createdById: s.userId,
    } });
  } catch (x) {
    if (isUnique(x)) throw err(409, "patient_admitted", "এই রোগী ইতিমধ্যে ভর্তি আছেন", "This patient is already an inpatient");
    throw x;
  }
  audit.push({ action: "create", entity: "Encounter", entityId: enc.id, patientId, detail: { class: "ipd", number, source, sourceEncounterId, doctorId: doctor.id } });
  // the move: leg 2 (destination occupied, the source bay vacated into cleaning); both legs for a direct admission
  const leg = occupyLeg(dash<BedState>(bed.bedState ?? "vacant"), sourceBed ? dash<BedState>(sourceBed.bedState ?? "occupied") : null, sourceBay ? "occupied" : null);
  const transferId = liveOnBed?.status === "reserved" && liveOnBed.patientId === patientId ? liveOnBed.transferId : sourceBay?.transferId ?? randomUUID();
  if (liveOnBed?.status === "reserved" && liveOnBed.patientId === patientId) {
    // leg 1 was the ER's reservation: it is closed as "occupied" and the occupation is the IPD encounter's row
    await endAssignment(tx, s, liveOnBed, now, "occupied");
  }
  // the source bed first (one occupied bed per patient, enforced by the database): the domain's leg says where it goes
  if (sourceBed && sourceBay && leg.source && leg.sourceEvent) {
    const ns = await tx.location.updateMany({ where: { id: sourceBed.id, bedState: sourceBed.bedState }, data: { bedState: under<DbBedState>(leg.source) } });
    if (ns.count !== 1) throw stale();
    await endAssignment(tx, s, sourceBay, now, leg.sourceEvent === "vacate" ? "vacated" : "released");
    audit.push({ action: "update", entity: "Location", entityId: sourceBed.id, patientId, detail: { event: leg.sourceEvent, bed: sourceBed.name, to: leg.source, encounterId: src!.id, transferId } });
  }
  const nb = await tx.location.updateMany({ where: { id: bed.id, bedState: bed.bedState }, data: { bedState: under<DbBedState>(leg.destination), bedNote: null } });
  if (nb.count !== 1) throw stale();
  try {
    await tx.bedAssignment.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, encounterId: enc.id, patientId, bedId: bed.id, status: "occupied", transferId, occupiedAt: now, occupiedById: s.userId } });
  } catch (x) {
    if (isUnique(x)) throw err(409, "patient_has_bed", "এই রোগী ইতিমধ্যে একটি শয্যায় আছেন", "This patient already holds a bed", { field: "bedId" });
    throw x;
  }
  audit.push({ action: "update", entity: "Location", entityId: bed.id, patientId, detail: { event: "occupy", bed: bed.name, from: dash(bed.bedState ?? "vacant"), to: leg.destination, encounterId: enc.id, transferId, leg: 2 } });
  // the source ER visit ends with the admission
  if (src && src.class === "er") {
    const from = dash<EncounterState>(src.status);
    if (["arrived", "triaged", "in_progress"].includes(src.status)) {
      let fin: EncounterState;
      try { fin = finishSource(from); } catch { throw err(409, "source_not_seen", "জরুরি ভিজিটে কোনো ডাক্তার নেই — ভর্তির আগে ডাক্তার দিন", "No doctor on the ER visit — assign one before admitting"); }
      const n = await tx.encounter.updateMany({ where: { id: src.id, status: src.status }, data: { status: under<DbEncStatus>(fin), statusAt: now } });
      if (n.count !== 1) throw stale();
      audit.push({ action: "update", entity: "Encounter", entityId: src.id, patientId, detail: { event: "finish", from, to: fin, admittedAs: enc.id } });
    }
  }
  // the admission row (updated request, or new for a direct admission)
  const data = {
    status: transition("admission", ADMISSION, "requested", "admit"), encounterId: enc.id, number, admittingDoctorId: doctor.id, department: req.department.trim(), diagnosis: req.diagnosis.trim(), bedClass: req.bedClass, bedId: bed.id,
    guardianName: req.guardian.name.trim(), guardianRelationship: req.guardian.relationship.trim() || null, guardianPhone: guardianPhoneDigits(req.guardian.phone), consents: req.consents, admittedById: s.userId, admittedAt: now,
  };
  let adm: Adm;
  try {
    adm = request
      ? await tx.admission.update({ where: { id: request.id }, data })
      : await tx.admission.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, branchId: branch.id, patientId, sourceEncounterId, source: source!, requestedById: s.userId, requestedAt: now, ...data } });
  } catch (x) {
    if (isUnique(x)) throw err(409, "admission_requested", "এই রোগীর একটি ভর্তি অনুরোধ ইতিমধ্যে খোলা", "An admission is already requested for this patient");
    throw x;
  }
  // the IPD bill draft — opened here and nowhere else (later slices add bed days, deposits, packages, pharmacy)
  const inv = await tx.invoice.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, branchId: branch.id, patientId, encounterId: enc.id, kind: "ipd", status: "draft", createdById: s.userId, statusAt: now } });
  await tx.admission.update({ where: { id: adm.id }, data: { invoiceId: inv.id } });
  audit.push({ action: request ? "update" : "create", entity: "Admission", entityId: adm.id, patientId, detail: { event: "admit", number, bed: bed.name, bedClass: req.bedClass, doctorId: doctor.id, invoiceId: inv.id, consents: req.consents } });
  audit.push({ action: "create", entity: "Invoice", entityId: inv.id, patientId, detail: { kind: "ipd", encounterId: enc.id, admissionId: adm.id } });
  return { view: await admissionView(tx, s, adm.id), audit };
}

/** A requested admission is cancelled (reason): the reserved bed is released. The ER note stays signed. */
export async function cancelAdmission(tx: Tx, s: SessionData, id: string, reason: string, now: Date): Promise<{ view: AdmissionView; audit: AuditEntry[] }> {
  const a = await tx.admission.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!a) throw notFound();
  if (a.status !== "requested") throw err(409, "admission_not_open", "এই ভর্তি অনুরোধ আর খোলা নেই", "This admission request is no longer open");
  const audit: AuditEntry[] = [];
  const res = await tx.bedAssignment.findFirst({ where: { patientId: a.patientId, bedId: a.bedId, status: "reserved" } });
  if (res) {
    const b = await tx.location.findFirst({ where: { id: res.bedId } });
    if (!b) throw stale();
    const to = under<DbBedState>(transition("bed", BED, dash(b.bedState ?? "reserved"), "release"));
    const n = await tx.location.updateMany({ where: { id: b.id, bedState: b.bedState }, data: { bedState: to } });
    if (n.count !== 1) throw stale();
    await endAssignment(tx, s, res, now, "released");
    audit.push({ action: "update", entity: "Location", entityId: b.id, patientId: a.patientId, detail: { event: "release", bed: b.name, to: dash(to), transferId: res.transferId } });
  }
  await tx.admission.update({ where: { id: a.id }, data: { status: transition("admission", ADMISSION, "requested", "cancel"), cancelledAt: now, cancelledById: s.userId, cancelReason: reason.trim() } });
  // review: the ER visit must not stay open with nowhere to go — the signed admit disposition is cleared from the visit
  // (the signed note stays as history); the doctor signs a new disposition as an amendment
  if (a.sourceEncounterId) {
    const v = await tx.erVisit.findFirst({ where: { encounterId: a.sourceEncounterId, dispositionKind: "admit" } });
    if (v) {
      await tx.erVisit.update({ where: { id: v.id }, data: { dispositionKind: null, dispositionDetail: { cancelledAdmission: a.id, previous: v.dispositionDetail } as object, dispositionSignedAt: null, dispositionSignedById: null } });
      audit.push({ action: "update", entity: "ErVisit", entityId: v.id, patientId: a.patientId, detail: { event: "disposition-cleared", admissionId: a.id } });
    }
  }
  audit.push({ action: "update", entity: "Admission", entityId: a.id, patientId: a.patientId, detail: { event: "cancel", reason: reason.trim() } });
  return { view: await admissionView(tx, s, a.id), audit };
}
