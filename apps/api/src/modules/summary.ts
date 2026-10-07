/* The discharge summary (ADR 0018, walkthrough B11): a Composition kind discharge-summary on the inpatient visit — one
   thread, amend never overwrite (ADR 0003) — with the final diagnoses (ICD picker, Condition), the course in hospital,
   the procedures, the medicines on discharge (MedicationRequest kind discharge, written like a prescription and taken
   home through the pharmacy's normal dispense), the follow-up and the red-flag advice. Signed with the doctor's PIN;
   refused while a critical result of this visit waits for a doctor's acknowledgement or an escalation is open (Kamrul,
   12). Signing records the provenance, makes the summary available in the patient app (a Communication naming the
   version) and finishes the checklist's summary step. A death on the ward has no summary (decision 15). */
import { randomUUID } from "node:crypto";
import type { AmendSummaryRequest, SaveSummaryRequest, SignSummaryRequest, SummaryDoc, SummaryView } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  AMEND_REASON_MIN, DOCUMENT, TAKE_HOME_DAYS, authorize, takeHomeStatus, RED_FLAGS_SAMPLE, SUMMARY_KIND, bedDaysDue, dhakaDay, emptySummarySections, isCritical, rxQuantity, rxWarnings, signDocument, summarySignBlockers, transition,
  type LabFlag, type RxLine, type SummarySections,
} from "@setu/domain";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { activeAllergyFacts, toAllergyView } from "./consultation.js";
import { afterEvent } from "./discharge.js";
import { getPatient, notFound, toSummary } from "./frontdesk.js";
import { iso, peopleOf, stale } from "./inpatient.js";
import { deliverInApp } from "./lab.js";
import { isActive, ordersOf } from "./mar.js";
import { progressAll } from "./pharmacy.js";
import { requirePin, requireUserPin } from "./pin.js";

const CURRENT = ["final", "amended"];
type Comp = NonNullable<Awaited<ReturnType<Tx["composition"]["findFirst"]>>>;
type Adm = NonNullable<Awaited<ReturnType<Tx["admission"]["findFirst"]>>>;
const dash = <T extends string>(s: string) => s.replace(/_/g, "-") as T;
/** ipd/summary (doctor, admin) or the discharge screen (nurse, receptionist) reads it; Hospital Lite up. */
function requireReader(s: SessionData) {
  const d = [authorize(s.role, s.plan, "ipd", "summary"), authorize(s.role, s.plan, "ipd", "discharge")];
  if (d.some((x) => x.allowed)) return;
  throw err(403, "forbidden", "এই পাতা আপনার জন্য নয়", "This page is not for you", { reason: d.some((x) => x.reason === "plan") ? "plan" : "role", canRequest: false });
}
const requireDoctor = (s: SessionData) => {
  requireReader(s);
  if (s.role !== "doctor") throw err(403, "forbidden", "ছাড়পত্র সারাংশ লেখেন ডাক্তার", "A doctor writes the discharge summary", { reason: "role", canRequest: false });
};

async function admissionHere(tx: Tx, s: SessionData, admissionId: string): Promise<Adm> {
  const a = await tx.admission.findFirst({ where: { id: admissionId, organizationId: s.organizationId, status: { in: ["admitted", "discharged"] } } });
  if (!a || !a.encounterId || !a.admittedAt) throw notFound();
  return a;
}
const liveDischarge = (tx: Tx, admissionId: string) => tx.discharge.findFirst({ where: { admissionId, status: { in: ["ordered", "completed"] } } });

/** Kamrul, 12: critical results of this visit no doctor has acknowledged, and escalations still open. */
export async function safetyFacts(tx: Tx, encounterId: string): Promise<{ criticalUnacked: number; openEscalations: number }> {
  const items = await tx.communication.findMany({ where: { encounterId, channel: "doctor_inbox", kind: { in: ["report-inbox", "critical-vital"] } }, include: { ack: true } });
  // an item counts once per report or reading: any doctor's acknowledgement of it clears it
  const acked = new Set(items.filter((c) => c.ack).map((c) => c.reportId ?? c.observationId ?? c.id));
  const open = items.filter((c) => !c.ack && !acked.has(c.reportId ?? c.observationId ?? c.id));
  const reports = await tx.diagnosticReport.findMany({ where: { id: { in: open.flatMap((c) => (c.reportId ? [c.reportId] : [])) }, supersededById: null }, include: { results: true } });
  const obs = await tx.observation.findMany({ where: { id: { in: reports.flatMap((r) => r.results.map((x) => x.observationId)) }, status: { not: "entered_in_error" } }, select: { id: true, interpretation: true } });
  const critical = new Set(obs.filter((o) => isCritical(o.interpretation as LabFlag)).map((o) => o.id));
  const crit = new Set<string>();
  for (const c of open) {
    if (c.kind === "critical-vital") crit.add(c.observationId ?? c.id);
    else { const r = reports.find((x) => x.id === c.reportId); if (r && r.results.some((x) => critical.has(x.observationId))) crit.add(r.id); }
  }
  const openEscalations = await tx.escalationEvent.count({ where: { encounterId, status: { not: "resolved" } } });
  return { criticalUnacked: crit.size, openEscalations };
}

async function docWires(tx: Tx, comps: Comp[]): Promise<SummaryDoc[]> {
  if (!comps.length) return [];
  const ids = comps.map((c) => c.id);
  const [conds, meds] = await Promise.all([
    tx.condition.findMany({ where: { compositionId: { in: ids } }, orderBy: { position: "asc" } }),
    tx.medicationRequest.findMany({ where: { compositionId: { in: ids } }, orderBy: { position: "asc" } }),
  ]);
  const who = await peopleOf(tx, comps.flatMap((c) => [c.authorId, c.signedById]));
  return comps.map((c) => ({
    id: c.id, threadId: c.threadId!, version: c.version, status: dash(c.status), rev: c.rev, sections: { ...emptySummarySections(), ...(c.sections as object) } as SummarySections,
    diagnoses: conds.filter((d) => d.compositionId === c.id).map((d) => ({ code: d.code, labelBn: d.labelBn, labelEn: d.labelEn, codeVerification: d.codeVerification, verificationStatus: d.verificationStatus })),
    medicines: meds.filter((m) => m.compositionId === c.id).map((m) => ({ id: m.id, position: m.position, medicineKey: m.medicineKey, brand: m.brand, generic: m.generic, strength: m.strength, form: m.form,
      ingredients: m.ingredients, classes: m.classes, sample: m.sample, dose: m.dose, meal: m.meal, days: m.days, quantity: m.quantity, note: m.note, keepBoth: m.keepBoth, acks: m.acks })),
    author: who(c.authorId), signedAt: iso(c.signedAt), signedBy: c.signedById ? who(c.signedById) : null, amendsId: c.amendsId, amendReason: c.amendReason, createdAt: c.createdAt.toISOString(),
  }));
}
const linesOf = (meds: Awaited<ReturnType<Tx["medicationRequest"]["findMany"]>>): RxLine[] =>
  meds.map((m) => ({ uid: m.id, medicine: { id: m.medicineKey, brand: m.brand, generic: m.generic, strength: m.strength, form: m.form, ingredients: m.ingredients, classes: m.classes }, dose: m.dose, meal: m.meal, days: m.days, keepBoth: m.keepBoth, acks: m.acks }));

async function blockersOf(tx: Tx, c: Comp, encounterId: string, patientId: string, now: Date) {
  const [conds, meds, allergies, facts] = await Promise.all([
    tx.condition.findMany({ where: { compositionId: c.id } }),
    tx.medicationRequest.findMany({ where: { compositionId: c.id }, orderBy: { position: "asc" } }),
    activeAllergyFacts(tx, patientId),
    safetyFacts(tx, encounterId),
  ]);
  const warnings = rxWarnings(linesOf(meds), allergies).filter((w) => w.block);
  return {
    blockers: summarySignBlockers({ sections: { ...emptySummarySections(), ...(c.sections as object) } as SummarySections, finalDiagnoses: conds.filter((d) => d.verificationStatus === "confirmed").length,
      today: dhakaDay(now), ...facts, rxBlocking: warnings.length }),
    warnings, facts,
  };
}

/** The current version's medicines on discharge as the pharmacy gave them — the pharmacy's own line assignment
    (progressAll: two lines of the same medicine never count each other's dispenses — review); the 3 days run from the
    first signed version (an amendment does not restart them). */
async function takeHomeOf(tx: Tx, current: Comp | null, now: Date): Promise<SummaryView["takeHome"]> {
  if (!current || !current.signedAt) return { dispensed: false, at: null, until: null, notCollected: 0, lines: [] };
  const first = await tx.composition.findFirst({ where: { threadId: current.threadId, version: 1 }, select: { signedAt: true } });
  const since = first?.signedAt ?? current.signedAt;
  const [reqs, rows] = await Promise.all([
    tx.medicationRequest.findMany({ where: { compositionId: current.id }, orderBy: { position: "asc" } }),
    tx.medicationDispense.findMany({ where: { encounterId: current.encounterId }, orderBy: { at: "asc" } }),
  ]);
  const P = await progressAll(tx, reqs, rows);
  const out = reqs.map((r) => {
    const p = P(r);
    const given = p.dispensedQty - p.returnedQty;
    const status = takeHomeStatus({ prescribed: r.quantity, given, declined: Boolean(p.declinedRow), signedAt: since, now });
    return { requestId: r.id, medicineKey: r.medicineKey, brand: r.brand, quantity: r.quantity, givenQty: Math.max(0, given), status };
  });
  const first0 = rows.find((r) => r.action === "dispense");
  return { dispensed: out.length > 0 && out.every((l) => l.status === "dispensed" || l.status === "declined"), at: iso(first0?.at ?? null),
    until: new Date(since.getTime() + TAKE_HOME_DAYS * 864e5).toISOString(), notCollected: out.filter((l) => l.status === "not-collected").length, lines: out };
}

export async function summaryView(tx: Tx, s: SessionData, admissionId: string, now: Date): Promise<{ view: SummaryView; patientId: string }> {
  requireReader(s);
  const a = await admissionHere(tx, s, admissionId);
  const e = a.encounterId!;
  const [d, draft, current, history, bed, allergies, orders, round, facts] = await Promise.all([
    liveDischarge(tx, a.id),
    tx.composition.findFirst({ where: { encounterId: e, kind: SUMMARY_KIND, status: "draft" } }),
    tx.composition.findFirst({ where: { encounterId: e, kind: SUMMARY_KIND, status: { in: ["final", "amended"] } } }),
    tx.composition.findMany({ where: { encounterId: e, kind: SUMMARY_KIND, status: { not: "draft" } }, orderBy: { version: "desc" } }),
    tx.location.findFirst({ where: { id: a.bedId }, include: { parent: { select: { name: true } } } }),
    tx.allergyIntolerance.findMany({ where: { patientId: a.patientId }, orderBy: [{ status: "asc" }, { recordedAt: "asc" }] }),
    ordersOf(tx, [e]),
    tx.composition.findFirst({ where: { encounterId: e, kind: "progress-note", status: { in: ["final", "amended"] } }, orderBy: { signedAt: "desc" } }),
    safetyFacts(tx, e),
  ]);
  const who = await peopleOf(tx, [a.admittingDoctorId, draft?.authorId]);
  const needed = Boolean(d && d.kind !== "death");
  const mineDraft = draft && draft.authorId === s.userId ? draft : null;
  const [draftW] = mineDraft ? await docWires(tx, [mineDraft]) : [null];
  const stale = Boolean(d && current?.signedAt && current.signedAt < d.orderedAt);
  const [curW] = current ? await docWires(tx, [current]) : [null];
  const takeHome = await takeHomeOf(tx, current, now);
  return {
    patientId: a.patientId,
    view: {
      admission: { id: a.id, number: a.number ?? "", encounterId: e, admittedAt: a.admittedAt!.toISOString(), dischargedAt: iso(a.dischargedAt), diagnosis: a.diagnosis, doctor: who(a.admittingDoctorId),
        bed: bed?.name ?? null, ward: bed?.parent?.name ?? null, dayNo: bedDaysDue(a.admittedAt!, a.dischargedAt, now) },
      patient: toSummary(await getPatient(tx, a.patientId)), allergies: await toAllergyView(tx, allergies),
      discharge: d ? { id: d.id, kind: d.kind as "normal", status: d.status as "ordered", advice: d.advice, orderedAt: d.orderedAt.toISOString() } : null,
      needed, draft: draftW ?? null, current: curW ?? null, stale, draftBy: draft && !mineDraft ? who(draft.authorId) : null,
      history: history.map((c) => ({ id: c.id, version: c.version, status: dash(c.status), signedAt: iso(c.signedAt), amendReason: c.amendReason })),
      blockers: mineDraft ? (await blockersOf(tx, mineDraft, e, a.patientId, now)).blockers : [],
      facts: { ...facts,
        activeOrders: orders.filter(isActive).map((o) => ({ medicineKey: o.medicineKey, brand: o.brand, generic: o.generic, strength: o.strength, form: o.form, doseText: o.doseText ?? "", route: o.route ?? "" })),
        lastRoundAssessment: round ? ((round.sections as { a?: string }).a ?? null) : null },
      redFlagsSample: RED_FLAGS_SAMPLE.map((x) => ({ ...x })),
      takeHome,
      can: { open: s.role === "doctor" && needed && !draft && !current, amend: s.role === "doctor" && Boolean(current) && !draft, print: Boolean(current) },
    },
  };
}

/* ───── writing it ───── */
export async function openSummary(tx: Tx, s: SessionData, admissionId: string, now: Date): Promise<{ view: SummaryView; audit: AuditEntry[] }> {
  requireDoctor(s);
  const a = await admissionHere(tx, s, admissionId);
  const d = await liveDischarge(tx, a.id);
  if (!d) throw err(409, "no_discharge", "আগে ছুটির আদেশ (বা LAMA রেকর্ড) দিন", "Record the discharge (or LAMA) first");
  if (d.kind === "death") throw err(409, "no_summary_death", "মৃত্যুতে ছাড়পত্র সারাংশ হয় না", "A death on the ward has no discharge summary");
  const audit: AuditEntry[] = [];
  const have = await tx.composition.findFirst({ where: { encounterId: a.encounterId!, kind: SUMMARY_KIND } });
  if (!have) {
    const id = `cmp_${randomUUID()}`;
    const e = (await tx.encounter.findFirst({ where: { id: a.encounterId! }, select: { branchId: true } }))!;
    await tx.composition.create({ data: { id, threadId: id, tenantId: s.tenantId, organizationId: s.organizationId, branchId: e.branchId, patientId: a.patientId, encounterId: a.encounterId!, kind: SUMMARY_KIND,
      version: 1, status: "draft", sections: emptySummarySections() as object, sectionSources: {}, authorId: s.userId } });
    audit.push({ action: "create", entity: "Composition", entityId: id, patientId: a.patientId, detail: { kind: SUMMARY_KIND } });
  }
  return { view: (await summaryView(tx, s, a.id, now)).view, audit };
}
async function draftHere(tx: Tx, s: SessionData, id: string) {
  requireDoctor(s);
  const c = await tx.composition.findFirst({ where: { id, kind: SUMMARY_KIND, organizationId: s.organizationId } });
  if (!c) throw notFound();
  if (c.status !== "draft") throw err(409, "not_draft", "স্বাক্ষরিত সারাংশ বদলানো যায় না — সংশোধন করুন", "A signed summary cannot be changed — amend it");
  // the draft is its author's (review: another doctor neither rewrites nor signs it — they amend once it is signed)
  if (c.authorId !== s.userId) throw err(403, "forbidden", "এটি অন্য ডাক্তারের খসড়া", "This is another doctor's draft", { reason: "role", canRequest: false });
  const a = await tx.admission.findFirst({ where: { encounterId: c.encounterId, organizationId: s.organizationId } });
  if (!a) throw notFound();
  return { c, a };
}
type FieldErr = { field: string; code: string };
export async function saveSummary(tx: Tx, s: SessionData, id: string, body: SaveSummaryRequest, now: Date): Promise<{ view: SummaryView; audit: AuditEntry[] }> {
  const { c, a } = await draftHere(tx, s, id);
  if (body.rev !== c.rev) throw stale();
  const fields: FieldErr[] = [];
  const codes = body.diagnoses.map((d) => d.code);
  const icd = new Map((await tx.icd11Code.findMany({ where: { code: { in: codes } } })).map((x) => [x.code, x]));
  body.diagnoses.forEach((d, i) => { if (!icd.has(d.code)) fields.push({ field: `diagnoses.${i}`, code: "unknown_code" }); if (codes.indexOf(d.code) !== i) fields.push({ field: `diagnoses.${i}`, code: "duplicate" }); });
  const meds = new Map((await tx.medicine.findMany({ where: { key: { in: body.medicines.map((m) => m.medicineKey) }, active: true } })).map((m) => [m.key, m]));
  body.medicines.forEach((m, i) => {
    const x = meds.get(m.medicineKey);
    if (!x) fields.push({ field: `medicines.${i}`, code: "unknown_medicine" });
    // a ward-only medicine (an injection, an infusion) is not taken home
    else if (x.inpatientOnly) fields.push({ field: `medicines.${i}`, code: "inpatient_only" });
    else if (rxQuantity(m.dose, m.days) <= 0) fields.push({ field: `medicines.${i}`, code: "dose_invalid" });
  });
  body.sections.procedures.forEach((p, i) => { if (p.date < dhakaDay(a.admittedAt!) || p.date > dhakaDay(now)) fields.push({ field: `sections.procedures.${i}.date`, code: "out_of_stay" }); });
  if (fields.length) throw err(400, "validation", "তথ্য ঠিক করুন", `${fields.length} item(s) need attention`, { field: fields[0]!.field, fields });
  const n = await tx.composition.updateMany({ where: { id: c.id, status: "draft", rev: c.rev }, data: { rev: c.rev + 1, sections: body.sections as object } });
  if (n.count !== 1) throw stale();
  const base = { tenantId: s.tenantId, patientId: c.patientId, encounterId: c.encounterId, compositionId: c.id };
  await tx.condition.deleteMany({ where: { compositionId: c.id } });
  await tx.medicationRequest.deleteMany({ where: { compositionId: c.id } });
  await tx.condition.createMany({ data: body.diagnoses.map((d, i) => { const x = icd.get(d.code)!; return { ...base, position: i, code: x.code, codeVerification: x.verification, labelBn: x.bn, labelEn: x.en, verificationStatus: d.verificationStatus }; }) });
  await tx.medicationRequest.createMany({ data: body.medicines.map((m, i) => {
    const x = meds.get(m.medicineKey)!;
    return { ...base, id: `mr_${randomUUID()}`, position: i, medicineKey: x.key, brand: x.brand, generic: x.generic, strength: x.strength, form: x.form, ingredients: x.ingredients, classes: x.classes, sample: x.sample,
      dose: m.dose, meal: m.meal, days: m.days, quantity: rxQuantity(m.dose, m.days), note: m.note || null, keepBoth: Boolean(m.keepBoth), acks: m.acks ?? [], kind: "discharge" };
  }) });
  return { view: (await summaryView(tx, s, a.id, now)).view,
    audit: [{ action: "update", entity: "Composition", entityId: c.id, patientId: c.patientId, detail: { kind: SUMMARY_KIND, diagnoses: codes, medicines: body.medicines.length } }] };
}

export async function signSummary(tx: Tx, s: SessionData, id: string, body: SignSummaryRequest, now: Date): Promise<{ view: SummaryView; audit: AuditEntry[] }> {
  const { c, a } = await draftHere(tx, s, id);
  await requireUserPin(tx, s.userId, body.pin);
  if (body.rev !== c.rev) throw stale();
  const d = await liveDischarge(tx, a.id);
  if (!d || d.kind === "death") throw err(409, "no_discharge", "ছুটির আদেশ (বা LAMA রেকর্ড) নেই", "No discharge (or LAMA) is recorded");
  const { blockers, warnings } = await blockersOf(tx, c, c.encounterId, c.patientId, now);
  if (blockers.length) throw err(422, "sign_blocked", `${blockers.length}টি বিষয় ঠিক করুন — স্বাক্ষর হয়নি`, `Resolve ${blockers.length} item(s) — not signed`,
    { blockers: [...blockers.map((code) => ({ code })), ...warnings.map((w) => ({ code: "rx", warning: w }))] as unknown as Record<string, unknown>[] });
  const audit: AuditEntry[] = [];
  if (c.amendsId) {
    const v1 = await tx.composition.findFirst({ where: { id: c.amendsId } });
    if (!v1 || !CURRENT.includes(v1.status) || v1.supersededById) throw stale();
    const sup = transition("document", DOCUMENT, v1.status as "final", "supersede");
    const n = await tx.composition.updateMany({ where: { id: v1.id, status: v1.status, supersededById: null }, data: { status: sup as "superseded", supersededById: c.id } });
    if (n.count !== 1) throw stale();
    audit.push({ action: "update", entity: "Composition", entityId: v1.id, patientId: c.patientId, detail: { event: "supersede", by: c.id } });
  }
  const to = signDocument({ status: "draft", amendsId: c.amendsId, amendReason: c.amendReason });
  const n = await tx.composition.updateMany({ where: { id: c.id, status: "draft", rev: c.rev }, data: { status: to as "final", signedAt: now, signedById: s.userId } });
  if (n.count !== 1) throw stale();
  const meds = await tx.medicationRequest.findMany({ where: { compositionId: c.id }, select: { medicineKey: true } });
  await tx.provenance.create({ data: { tenantId: s.tenantId, targetType: "Composition", targetId: c.id, activity: c.amendsId ? "sign-amendment" : "sign", agentId: s.userId, onBehalfOf: s.organizationId, recorded: now,
    source: "provider_verified", detail: { kind: SUMMARY_KIND, version: c.version, medicines: meds.length } } });
  audit.push({ action: "sign", entity: "Composition", entityId: c.id, patientId: c.patientId, detail: { kind: SUMMARY_KIND, version: c.version, to, amends: c.amendsId, medicines: meds.map((m) => m.medicineKey) } });
  // the patient app records the summary as available, like a lab report (decision 11)
  const cid = await deliverInApp(tx, s, { patientId: c.patientId, encounterId: c.encounterId }, { kind: "summary-available", channel: "patient_app", compositionId: c.id }, now);
  audit.push({ action: "create", entity: "Communication", entityId: cid, patientId: c.patientId, detail: { kind: "summary-available", channel: "patient_app", compositionId: c.id, version: c.version } });
  // the checklist's summary step finishes by this event
  audit.push(...await afterEvent(tx, s.userId, a.id, now));
  return { view: (await summaryView(tx, s, a.id, now)).view, audit };
}

export async function amendSummary(tx: Tx, s: SessionData, id: string, body: AmendSummaryRequest, now: Date): Promise<{ view: SummaryView; audit: AuditEntry[] }> {
  requireDoctor(s);
  const v1 = await tx.composition.findFirst({ where: { id, kind: SUMMARY_KIND, organizationId: s.organizationId } });
  if (!v1) throw notFound();
  if (body.reason.trim().length < AMEND_REASON_MIN) throw err(400, "amend_reason", "সংশোধনের কারণ লিখুন (অন্তত ৫ অক্ষর)", "Give the reason for the amendment (at least 5 characters)", { field: "reason" });
  if (!CURRENT.includes(v1.status) || v1.supersededById) throw err(409, "not_current", "শুধু বর্তমান স্বাক্ষরিত সংস্করণ সংশোধন হয়", "Only the current signed version is amended");
  if (await tx.composition.findFirst({ where: { threadId: v1.threadId, status: "draft" } })) throw err(409, "draft_exists", "এই সারাংশের একটি সংশোধন খসড়া আগেই খোলা", "An amendment draft of this summary is already open");
  const a = await tx.admission.findFirst({ where: { encounterId: v1.encounterId, organizationId: s.organizationId } });
  if (!a) throw notFound();
  const v2id = `cmp_${randomUUID()}`;
  await tx.composition.create({ data: { id: v2id, threadId: v1.threadId, tenantId: s.tenantId, organizationId: s.organizationId, branchId: v1.branchId, patientId: v1.patientId, encounterId: v1.encounterId, kind: SUMMARY_KIND,
    version: v1.version + 1, status: "draft", amendsId: v1.id, amendReason: body.reason.trim(), sections: v1.sections as object, sectionSources: {}, authorId: s.userId } });
  const [conds, meds] = await Promise.all([
    tx.condition.findMany({ where: { compositionId: v1.id }, orderBy: { position: "asc" } }),
    tx.medicationRequest.findMany({ where: { compositionId: v1.id }, orderBy: { position: "asc" } }),
  ]);
  if (conds.length) await tx.condition.createMany({ data: conds.map(({ id: _i, createdAt: _c, compositionId: _p, ...x }) => ({ ...x, compositionId: v2id })) });
  for (const { id: _i, createdAt: _c, compositionId: _p, ...m } of meds) await tx.medicationRequest.create({ data: { ...m, id: `mr_${randomUUID()}`, compositionId: v2id } });
  return { view: (await summaryView(tx, s, a.id, now)).view,
    audit: [{ action: "create", entity: "Composition", entityId: v2id, patientId: v1.patientId, detail: { kind: SUMMARY_KIND, amends: v1.id, version: v1.version + 1, reason: body.reason.trim() } }] };
}
