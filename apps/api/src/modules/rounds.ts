/* The doctor's ward round (ADR 0015, walkthrough B7): the worklist by risk, the round note (Composition kind
   progress-note, one thread per round, amend never overwrite — ADR 0003) with inpatient medication orders and lab
   orders, signed with the PIN; the A5 checks run on the lines exactly as in A5; an amendment supersedes v1's orders
   and a line keeps its regimen only when drug, dose, route and frequency are unchanged (decision 9); stop orders. */
import { randomUUID } from "node:crypto";
import type { InpatientLineInput, InpatientOrder, RoundNote, RoundView, RoundWorklist, SaveRoundRequest } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  AMEND_REASON_MIN, DOCUMENT, MEDICATION_ORDER, NEWS2_SAMPLE_NOTE, NEWS2_THRESHOLD_SAMPLE, ORDER, lineProblems, roundNoteBlockers, rxWarnings, sameRegimen, signDocument, stopBlockers, transition,
  type RoundNoteSections, type RxLine, type WardMedicine,
} from "@setu/domain";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { activeAllergyFacts, toAllergyView } from "./consultation.js";
import { getPatient, notFound, toSummary } from "./frontdesk.js";
import { closedVisit, dayOfStay, erPatientOf, inpatientHere, iso, latestNews2, news2OfBatch, peopleOf, stale, type Enc } from "./inpatient.js";
import { isActive, medWire, ordersOf } from "./mar.js";
import { requirePin } from "./pin.js";
import { devHash } from "./users.js";
import { escWire, noteWire } from "./ward.js";

const KIND = "progress-note";
const CURRENT = ["final", "amended"];
const rule = () => ({ threshold: NEWS2_THRESHOLD_SAMPLE, sample: true as const, note: { ...NEWS2_SAMPLE_NOTE } });
type Comp = NonNullable<Awaited<ReturnType<Tx["composition"]["findFirst"]>>>;
type Med = NonNullable<Awaited<ReturnType<Tx["medicine"]["findFirst"]>>>;
const requireDoctor = (s: SessionData) => { if (s.role !== "doctor") throw err(403, "forbidden", "রাউন্ড নোট লেখেন ডাক্তার", "A doctor writes the round note", { reason: "role", canRequest: false }); };
const asWard = (m: Med): WardMedicine => ({ key: m.key, brand: m.brand, brandBn: m.brandBn, generic: m.generic, strength: m.strength, form: m.form, ingredients: m.ingredients, classes: m.classes, issueUnit: m.issueUnit as WardMedicine["issueUnit"], routes: m.routes as WardMedicine["routes"], multiDose: m.multiDose, highAlert: m.highAlert, controlled: m.controlled, inpatientOnly: m.inpatientOnly, mrpPaisa: 0, sample: true });

/* ───── views ───── */
type OrderRow = Awaited<ReturnType<typeof ordersOf>>[number];
async function orderWires(tx: Tx, rows: OrderRow[]): Promise<InpatientOrder[]> {
  const meds = new Map((await tx.medicine.findMany({ where: { key: { in: [...new Set(rows.map((r) => r.medicineKey))] } } })).map((m) => [m.key, m]));
  const who = await peopleOf(tx, rows.flatMap((r) => [r.composition.signedById, r.stoppedById]));
  return rows.map((o) => ({
    id: o.id, regimenId: o.regimenId!, noteId: o.compositionId, medicine: medWire(meds.get(o.medicineKey)!), route: o.route!, doseText: o.doseText!, doseQty: o.doseQty, times: o.times, prn: o.prn, prnMaxPer24h: o.prnMaxPer24h,
    startAt: o.startAt!.toISOString(), status: o.orderStatus, orderedBy: who(o.composition.signedById), stop: o.stoppedAt ? { by: who(o.stoppedById), at: o.stoppedAt.toISOString(), reason: o.stopReason ?? "" } : null,
  }));
}
async function noteWires(tx: Tx, comps: Comp[]): Promise<RoundNote[]> {
  if (!comps.length) return [];
  const ids = comps.map((c) => c.id);
  const [lines, orders] = await Promise.all([
    tx.medicationRequest.findMany({ where: { compositionId: { in: ids } }, orderBy: { position: "asc" } }),
    tx.serviceRequest.findMany({ where: { compositionId: { in: ids } }, orderBy: { createdAt: "asc" } }),
  ]);
  const who = await peopleOf(tx, comps.flatMap((c) => [c.authorId, c.signedById]));
  return comps.map((c) => ({
    id: c.id, threadId: c.threadId!, version: c.version, status: c.status.replace(/_/g, "-") as RoundNote["status"], rev: c.rev, sections: c.sections as unknown as RoundNoteSections,
    lines: lines.filter((l) => l.compositionId === c.id).map((l) => ({ id: l.id, medicineKey: l.medicineKey, route: l.route ?? "", doseText: l.doseText ?? "", doseQty: l.doseQty, times: l.times, prn: l.prn, prnMaxPer24h: l.prnMaxPer24h, note: l.note ?? undefined, keepBoth: l.keepBoth, acks: l.acks, status: l.orderStatus, regimenId: l.regimenId, continuesId: l.continuesId })),
    labOrders: orders.filter((o) => o.compositionId === c.id).map((o) => ({ id: o.id, testCode: o.testCode, nameEn: o.nameEn, nameBn: o.nameBn, priority: o.priority, status: o.status.replace(/_/g, "-") as "active" })),
    author: who(c.authorId), signedAt: iso(c.signedAt), signedBy: c.signedById ? who(c.signedById) : null, amendsId: c.amendsId, amendReason: c.amendReason, createdAt: c.createdAt.toISOString(),
  }));
}

export async function roundWorklist(tx: Tx, s: SessionData, now: Date): Promise<{ list: RoundWorklist; patientIds: string[] }> {
  const encs = (await tx.encounter.findMany({ where: { organizationId: s.organizationId, class: "ipd", status: "in_progress" }, include: { patient: true } })) as Enc[];
  const ids = encs.map((e) => e.id);
  const [adms, scores, escs, live, drafts, signed, missed, notes] = await Promise.all([
    tx.admission.findMany({ where: { encounterId: { in: ids }, status: "admitted" } }),
    latestNews2(tx, ids),
    tx.escalationEvent.findMany({ where: { encounterId: { in: ids }, status: { not: "resolved" } } }),
    tx.bedAssignment.findMany({ where: { encounterId: { in: ids }, status: "occupied" }, include: { bed: { include: { parent: true } } } }),
    tx.composition.findMany({ where: { encounterId: { in: ids }, kind: KIND, status: "draft", authorId: s.userId }, select: { id: true, encounterId: true } }),
    tx.composition.findMany({ where: { encounterId: { in: ids }, kind: KIND, status: { in: ["final", "amended"] } }, select: { encounterId: true, signedAt: true }, orderBy: { signedAt: "desc" } }),
    tx.medicationAdministration.groupBy({ by: ["encounterId"], where: { encounterId: { in: ids }, status: { in: ["missed", "held", "refused"] }, administeredAt: { gte: new Date(now.getTime() - 864e5) } }, _count: true }),
    tx.nursingNote.findMany({ where: { encounterId: { in: ids }, status: "active" }, select: { encounterId: true, effectiveAt: true } }),
  ]);
  const who = await peopleOf(tx, escs.flatMap((e) => [e.raisedById, e.informedById, e.resolvedById, e.acknowledgedById]));
  const items = encs.map((e) => {
    const sc = scores.get(e.id), esc = escs.find((x) => x.encounterId === e.id), bed = live.find((x) => x.encounterId === e.id), adm = adms.find((x) => x.encounterId === e.id);
    const last = signed.find((x) => x.encounterId === e.id)?.signedAt ?? null;
    return {
      encounterId: e.id, admissionId: adm?.id ?? "", admissionNumber: adm?.number ?? null, patient: erPatientOf(e.patient), bed: bed?.bed.name ?? null, ward: bed?.bed.parent?.name ?? null, day: dayOfStay(adm?.admittedAt ?? e.arrivedAt, now),
      news2: sc?.news2 ?? null, escalation: esc ? escWire(esc, who) : null, missedLast24h: missed.find((m) => m.encounterId === e.id)?._count ?? 0,
      notesSinceRound: notes.filter((n) => n.encounterId === e.id && (!last || n.effectiveAt > last)).length, lastRoundAt: iso(last), draftId: drafts.find((d) => d.encounterId === e.id)?.id ?? null, mine: e.practitionerId === s.userId,
    };
  });
  // by risk: open escalation, then NEWS2, then missed doses
  items.sort((a, b) => Number(Boolean(b.escalation)) - Number(Boolean(a.escalation)) || (b.news2?.total ?? -1) - (a.news2?.total ?? -1) || b.missedLast24h - a.missedLast24h || (a.bed ?? "").localeCompare(b.bed ?? ""));
  return { list: { items, rule: rule() }, patientIds: encs.map((e) => e.patientId) };
}

export async function roundView(tx: Tx, s: SessionData, encounterId: string, now: Date): Promise<{ view: RoundView; patientId: string }> {
  const ip = await inpatientHere(tx, s, encounterId);
  const since = new Date(now.getTime() - 864e5);
  const [obs, escs, notes, doses, allergies, rows, draft, current] = await Promise.all([
    tx.observation.findMany({ where: { encounterId: ip.e.id, category: "vital-signs", status: { not: "entered_in_error" }, effectiveAt: { gte: since } }, orderBy: { effectiveAt: "desc" } }),
    tx.escalationEvent.findMany({ where: { encounterId: ip.e.id, raisedAt: { gte: since } }, orderBy: { raisedAt: "desc" } }),
    tx.nursingNote.findMany({ where: { encounterId: ip.e.id, effectiveAt: { gte: since } }, orderBy: { effectiveAt: "desc" } }),
    tx.medicationAdministration.findMany({ where: { encounterId: ip.e.id, administeredAt: { gte: since }, OR: [{ status: { in: ["held", "refused", "missed", "entered_in_error"] } }, { timing: { in: ["late", "early"] } }] }, orderBy: { administeredAt: "desc" } }),
    tx.allergyIntolerance.findMany({ where: { patientId: ip.e.patientId }, orderBy: [{ status: "asc" }, { recordedAt: "asc" }] }),
    ordersOf(tx, [ip.e.id]),
    s.role === "doctor" ? tx.composition.findFirst({ where: { encounterId: ip.e.id, kind: KIND, status: "draft", authorId: s.userId }, orderBy: { createdAt: "desc" } }) : null,
    tx.composition.findMany({ where: { encounterId: ip.e.id, kind: KIND, status: { in: ["final", "amended"] } }, orderBy: { signedAt: "desc" }, take: 10 }),
  ]);
  const meds = new Map((await tx.medicine.findMany({ where: { key: { in: doses.map((d) => d.medicineKey) } } })).map((m) => [m.key, m]));
  const who = await peopleOf(tx, [...escs.flatMap((e) => [e.raisedById, e.informedById, e.resolvedById, e.acknowledgedById]), ...notes.flatMap((n) => [n.writtenById, n.errorById])]);
  const batches = [...new Set(obs.map((o) => o.batchId))];
  const summary = (rows2: typeof obs) => {
    const v = Object.fromEntries(rows2.map((r) => [r.code, r.value]));
    return [v["bp-systolic"] !== undefined ? `BP ${v["bp-systolic"]}/${v["bp-diastolic"] ?? "?"}` : null, v["pulse"] !== undefined ? `HR ${v["pulse"]}` : null, v["respiratory-rate"] !== undefined ? `RR ${v["respiratory-rate"]}` : null,
      v["spo2"] !== undefined ? `SpO₂ ${v["spo2"]}%` : null, v["body-temperature"] !== undefined ? `T ${v["body-temperature"]} °F` : null].filter(Boolean).join(" · ");
  };
  return {
    patientId: ip.e.patientId,
    view: {
      encounterId: ip.e.id, admissionId: ip.adm.id, admissionNumber: ip.adm.number, patient: toSummary(await getPatient(tx, ip.e.patientId)), allergies: await toAllergyView(tx, allergies),
      bed: ip.bed && ip.ward ? { name: ip.bed.name, ward: ip.ward.name } : null, day: dayOfStay(ip.adm.admittedAt, now), diagnosis: ip.adm.diagnosis,
      overnight: {
        vitals: batches.map((b) => { const r = obs.filter((o) => o.batchId === b); return { at: r[0]!.effectiveAt.toISOString(), news2: news2OfBatch(r), summary: summary(r) }; }),
        escalations: escs.map((e) => escWire(e, who)), notes: notes.map((n) => noteWire(n, who)),
        doses: doses.map((d) => ({ medicine: meds.get(d.medicineKey)?.brand ?? d.medicineKey, status: d.status.replace(/_/g, "-"), at: d.administeredAt.toISOString(), timing: d.timing, reason: d.reason ?? d.errorReason })),
      },
      activeOrders: await orderWires(tx, rows.filter(isActive)), draft: draft ? (await noteWires(tx, [draft]))[0]! : null, signed: await noteWires(tx, current), rule: rule(),
    },
  };
}

/* ───── writing the note ───── */
export async function openRound(tx: Tx, s: SessionData, encounterId: string, now: Date) {
  requireDoctor(s);
  const ip = await inpatientHere(tx, s, encounterId);
  if (!ip.open) throw closedVisit();
  const existing = await tx.composition.findFirst({ where: { encounterId: ip.e.id, kind: KIND, status: "draft", authorId: s.userId } });
  const audit: AuditEntry[] = [];
  if (!existing) {
    const id = `cmp_${randomUUID()}`;
    await tx.composition.create({ data: { id, threadId: id, tenantId: s.tenantId, organizationId: s.organizationId, branchId: ip.e.branchId, patientId: ip.e.patientId, encounterId: ip.e.id, kind: KIND, version: 1, status: "draft", sections: { s: "", o: "", a: "", p: "" } as object, sectionSources: {}, authorId: s.userId } });
    audit.push({ action: "create", entity: "Composition", entityId: id, patientId: ip.e.patientId, detail: { kind: KIND } });
  }
  return { ...(await roundView(tx, s, ip.e.id, now)), audit };
}
async function draftHere(tx: Tx, s: SessionData, id: string) {
  requireDoctor(s);
  const c = await tx.composition.findFirst({ where: { id, kind: KIND, organizationId: s.organizationId } });
  if (!c) throw notFound();
  if (c.status !== "draft") throw err(409, "not_draft", "স্বাক্ষরিত নোট বদলানো যায় না — সংশোধন করুন", "A signed note cannot be changed — amend it");
  if (c.authorId !== s.userId) throw err(403, "forbidden", "এটি অন্য ডাক্তারের খসড়া", "This is another doctor's draft", { reason: "role", canRequest: false });
  const ip = await inpatientHere(tx, s, c.encounterId);
  if (!ip.open) throw closedVisit();
  return { c, ip };
}
type FieldErr = { field: string; code: string };
export async function saveRound(tx: Tx, s: SessionData, id: string, body: SaveRoundRequest, now: Date) {
  const { c, ip } = await draftHere(tx, s, id);
  if (body.rev !== c.rev) throw stale();
  const meds = new Map((await tx.medicine.findMany({ where: { key: { in: body.lines.map((l) => l.medicineKey) }, active: true } })).map((m) => [m.key, m]));
  const fields: FieldErr[] = [];
  body.lines.forEach((l, i) => { const m = meds.get(l.medicineKey); for (const code of lineProblems(l, m ? asWard(m) : null)) fields.push({ field: `lines.${i}`, code }); });
  const tests = new Map((await tx.orderableTest.findMany({ where: { code: { in: body.orders.map((o) => o.testCode) }, active: true } })).map((t) => [t.code, t]));
  body.orders.forEach((o, i) => { if (!tests.has(o.testCode)) fields.push({ field: `orders.${i}`, code: "unknown_test" }); });
  if (fields.length) throw err(400, "validation", "তথ্য ঠিক করুন", `${fields.length} item(s) need attention`, { field: fields[0]!.field, fields });
  const n = await tx.composition.updateMany({ where: { id: c.id, status: "draft", rev: c.rev }, data: { rev: c.rev + 1, sections: body.sections as object } });
  if (n.count !== 1) throw stale();
  await tx.medicationRequest.deleteMany({ where: { compositionId: c.id } });
  await tx.serviceRequest.deleteMany({ where: { compositionId: c.id, status: "draft" } });
  for (const [i, l] of body.lines.entries()) {
    const m = meds.get(l.medicineKey)!;
    await tx.medicationRequest.create({ data: {
      id: `mr_${randomUUID()}`, tenantId: s.tenantId, patientId: ip.e.patientId, encounterId: ip.e.id, compositionId: c.id, position: i, medicineKey: m.key, brand: m.brand, generic: m.generic, strength: m.strength, form: m.form,
      ingredients: m.ingredients, classes: m.classes, sample: m.sample, dose: l.doseText.trim(), meal: "any", days: 1, quantity: 0, note: l.note || null, keepBoth: Boolean(l.keepBoth), acks: l.acks ?? [],
      kind: "inpatient", route: l.route, doseText: l.doseText.trim(), doseQty: l.doseQty, times: l.prn ? [] : [...l.times].sort(), prn: l.prn, prnMaxPer24h: l.prn ? l.prnMaxPer24h : null,
    } });
  }
  if (body.orders.length) await tx.serviceRequest.createMany({ data: body.orders.map((o) => { const t = tests.get(o.testCode)!; return {
    tenantId: s.tenantId, organizationId: s.organizationId, branchId: ip.e.branchId, patientId: ip.e.patientId, encounterId: ip.e.id, compositionId: c.id, testCode: t.code, nameEn: t.nameEn, nameBn: t.nameBn, group: t.group, priority: o.priority, orderedById: s.userId,
  }; }) });
  return { ...(await roundView(tx, s, ip.e.id, now)), audit: [{ action: "update", entity: "Composition", entityId: c.id, patientId: ip.e.patientId, detail: { kind: KIND, lines: body.lines.length, orders: body.orders.length } }] as AuditEntry[] };
}

const toInput = (l: { medicineKey: string; route: string | null; doseText: string | null; doseQty: number | null; times: string[]; prn: boolean; prnMaxPer24h: number | null }): InpatientLineInput =>
  ({ medicineKey: l.medicineKey, route: l.route ?? "", doseText: l.doseText ?? "", doseQty: l.doseQty, times: l.times, prn: l.prn, prnMaxPer24h: l.prnMaxPer24h });
export async function signRound(tx: Tx, s: SessionData, id: string, body: { rev: number; pin: string }, now: Date) {
  const { c, ip } = await draftHere(tx, s, id);
  if (body.rev !== c.rev) throw stale();
  const lines = await tx.medicationRequest.findMany({ where: { compositionId: c.id }, orderBy: { position: "asc" } });
  // the A5 checks (allergy, same medicine, same class, interaction) on this note's lines, against the other active orders
  const others = (await ordersOf(tx, [ip.e.id])).filter((o) => isActive(o) && o.composition.id !== c.amendsId && o.composition.id !== c.id);
  const rx = (l: typeof lines[number] | typeof others[number]): RxLine => ({ uid: l.id, medicine: { id: l.medicineKey, brand: l.brand, generic: l.generic, strength: l.strength, form: l.form, ingredients: l.ingredients, classes: l.classes }, dose: "1+0+0", meal: "any", days: 1, keepBoth: l.keepBoth, acks: l.acks });
  const mine = new Set(lines.map((l) => l.id));
  const warnings = rxWarnings([...others.map(rx), ...lines.map(rx)], await activeAllergyFacts(tx, ip.e.patientId)).filter((w) => mine.has(w.line) && w.block && w.kind !== "dose-invalid" && w.kind !== "days-invalid");
  // an amendment's copied line whose source was stopped after the draft opened would restart the drug: the doctor
  // removes it (or writes a changed line on purpose) — never a silent restart (clinical-safety review)
  const stoppedSince = c.amendsId ? await tx.medicationRequest.findMany({ where: { compositionId: c.amendsId, kind: "inpatient", orderStatus: "stopped", stoppedAt: { gte: c.createdAt } } }) : [];
  const restarts = lines.filter((l) => stoppedSince.some((p) => sameRegimen(toInput(p), toInput(l))));
  const blockers = [...roundNoteBlockers(c.sections as unknown as RoundNoteSections).map((code) => ({ code })), ...warnings.map((w) => ({ code: "rx", warning: w })),
    ...restarts.map((l) => ({ code: "line_stopped", line: l.id, drug: l.brand }))];
  if (blockers.length) throw err(422, "sign_blocked", `${blockers.length}টি সতর্কতা ঠিক করুন — স্বাক্ষর হয়নি`, `Resolve ${blockers.length} warning(s) — not signed`, { blockers: blockers as unknown as Record<string, unknown>[] });
  const u = await tx.user.findFirst({ where: { id: s.userId }, select: { pinHash: true } });
  await requirePin(s.userId, () => Boolean(u?.pinHash) && u!.pinHash === devHash(body.pin));
  const audit: AuditEntry[] = [];
  // regimens: a line continues a v1 line of the same thread only when drug, dose, route and frequency are unchanged
  const v1Lines = c.amendsId ? await tx.medicationRequest.findMany({ where: { compositionId: c.amendsId, kind: "inpatient", orderStatus: "active" } }) : [];
  const used = new Set<string>();
  for (const l of lines) {
    const prev = v1Lines.find((p) => !used.has(p.id) && sameRegimen(toInput(p), toInput(l)));
    if (prev) used.add(prev.id);
    await tx.medicationRequest.update({ where: { id: l.id }, data: { startAt: prev ? prev.startAt : now, regimenId: prev ? prev.regimenId : l.id, continuesId: prev ? prev.id : null } });
  }
  if (c.amendsId) {
    const v1 = await tx.composition.findFirst({ where: { id: c.amendsId } });
    if (!v1 || !CURRENT.includes(v1.status) || v1.supersededById) throw stale();
    const sup = transition("document", DOCUMENT, v1.status as "final", "supersede");
    const n = await tx.composition.updateMany({ where: { id: v1.id, status: v1.status, supersededById: null }, data: { status: sup as "superseded", supersededById: c.id } });
    if (n.count !== 1) throw stale();
    for (const p of v1Lines) {
      transition("medication-order", MEDICATION_ORDER, "active", "supersede");
      await tx.medicationRequest.update({ where: { id: p.id }, data: { orderStatus: "superseded" } });
    }
    audit.push({ action: "update", entity: "Composition", entityId: v1.id, patientId: ip.e.patientId, detail: { event: "supersede", by: c.id, ordersSuperseded: v1Lines.length, continued: [...used] } });
  }
  const to = signDocument({ status: "draft", amendsId: c.amendsId, amendReason: c.amendReason });
  const signed = await tx.composition.updateMany({ where: { id: c.id, status: "draft", rev: c.rev }, data: { status: to as "final", signedAt: now, signedById: s.userId } });
  if (signed.count !== 1) throw stale();
  const drafts = await tx.serviceRequest.findMany({ where: { compositionId: c.id, status: "draft" }, select: { id: true } });
  if (drafts.length) { transition("order", ORDER, "draft", "order"); await tx.serviceRequest.updateMany({ where: { compositionId: c.id, status: "draft" }, data: { status: "active", orderedAt: now, statusAt: now } }); }
  await tx.provenance.create({ data: { tenantId: s.tenantId, targetType: "Composition", targetId: c.id, activity: c.amendsId ? "sign-amendment" : "sign", agentId: s.userId, onBehalfOf: s.organizationId, recorded: now, source: "provider_verified", detail: { kind: KIND, version: c.version, lines: lines.length, orders: drafts.length } } });
  audit.push({ action: "sign", entity: "Composition", entityId: c.id, patientId: ip.e.patientId, detail: { kind: KIND, version: c.version, to, amends: c.amendsId, lines: lines.map((l) => l.medicineKey), labOrders: drafts.length } });
  return { ...(await roundView(tx, s, ip.e.id, now)), audit };
}

export async function amendRound(tx: Tx, s: SessionData, id: string, reason: string, now: Date) {
  requireDoctor(s);
  const v1 = await tx.composition.findFirst({ where: { id, kind: KIND, organizationId: s.organizationId } });
  if (!v1) throw notFound();
  if (reason.trim().length < AMEND_REASON_MIN) throw err(400, "amend_reason", "সংশোধনের কারণ লিখুন (অন্তত ৫ অক্ষর)", "Give the reason for the amendment (at least 5 characters)", { field: "reason" });
  if (!CURRENT.includes(v1.status) || v1.supersededById) throw err(409, "not_current", "শুধু বর্তমান স্বাক্ষরিত সংস্করণ সংশোধন হয়", "Only the current signed version is amended");
  const ip = await inpatientHere(tx, s, v1.encounterId);
  if (!ip.open) throw closedVisit();
  if (await tx.composition.findFirst({ where: { threadId: v1.threadId, status: "draft" } })) throw err(409, "draft_exists", "এই নোটের একটি সংশোধন খসড়া আগেই খোলা", "An amendment draft of this note is already open");
  const v2id = `cmp_${randomUUID()}`;
  await tx.composition.create({ data: { id: v2id, threadId: v1.threadId, tenantId: s.tenantId, organizationId: s.organizationId, branchId: v1.branchId, patientId: v1.patientId, encounterId: v1.encounterId, kind: KIND, version: v1.version + 1, status: "draft", amendsId: v1.id, amendReason: reason.trim(), sections: v1.sections as object, sectionSources: {}, authorId: s.userId } });
  const active = await tx.medicationRequest.findMany({ where: { compositionId: v1.id, kind: "inpatient", orderStatus: "active" }, orderBy: { position: "asc" } });
  for (const [i, l] of active.entries()) {
    const { id: _id, compositionId: _c, createdAt: _t, startAt: _s, regimenId: _r, continuesId: _k, orderStatus: _o, stoppedAt: _a, stoppedById: _b, stopReason: _x, position: _p, ...copy } = l;
    await tx.medicationRequest.create({ data: { ...copy, id: `mr_${randomUUID()}`, compositionId: v2id, position: i } });
  }
  return { ...(await roundView(tx, s, v1.encounterId, now)), audit: [{ action: "create", entity: "Composition", entityId: v2id, patientId: v1.patientId, detail: { kind: KIND, amends: v1.id, version: v1.version + 1, reason: reason.trim() } }] as AuditEntry[] };
}

export async function stopOrder(tx: Tx, s: SessionData, id: string, body: { reason: string; pin: string }, now: Date) {
  const o = await tx.medicationRequest.findFirst({ where: { id, kind: "inpatient" }, include: { composition: { select: { status: true, organizationId: true } } } });
  if (!o || o.composition.organizationId !== s.organizationId) throw notFound();
  const bl = stopBlockers({ status: isActive(o) ? "active" : o.orderStatus === "active" ? "superseded" : o.orderStatus, role: s.role, reason: body.reason });
  if (bl.includes("doctor_only")) throw err(403, "forbidden", "অর্ডার বন্ধ করেন ডাক্তার", "A doctor stops an order", { reason: "role", canRequest: false });
  if (bl.includes("reason")) throw err(400, "reason_required", "বন্ধের কারণ লিখুন (অন্তত ৫ অক্ষর)", "Give the reason (at least 5 characters)", { field: "reason" });
  if (bl.includes("not_active")) throw err(409, "not_active", "অর্ডারটি সক্রিয় নয়", "The order is not active");
  const u = await tx.user.findFirst({ where: { id: s.userId }, select: { pinHash: true } });
  await requirePin(s.userId, () => Boolean(u?.pinHash) && u!.pinHash === devHash(body.pin));
  transition("medication-order", MEDICATION_ORDER, "active", "stop");
  const n = await tx.medicationRequest.updateMany({ where: { id: o.id, orderStatus: "active" }, data: { orderStatus: "stopped", stoppedAt: now, stoppedById: s.userId, stopReason: body.reason.trim() } });
  if (n.count !== 1) throw stale();
  return { ...(await roundView(tx, s, o.encounterId, now)), audit: [{ action: "update", entity: "MedicationRequest", entityId: o.id, patientId: o.patientId, detail: { event: "stop", medicineKey: o.medicineKey, reason: body.reason.trim() } }] as AuditEntry[] };
}

export async function wardMedicines(tx: Tx, q: string) {
  const term = q.trim().toLowerCase();
  const rows = await tx.medicine.findMany({ where: { active: true }, orderBy: [{ inpatientOnly: "desc" }, { brand: "asc" }] });
  return { items: rows.filter((m) => !term || [m.key, m.brand, m.brandBn, m.generic].some((x) => x.toLowerCase().includes(term))).slice(0, 20).map(medWire) };
}
