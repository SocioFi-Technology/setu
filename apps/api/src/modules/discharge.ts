/* The discharge checklist (ADR 0017, walkthrough B9; ADR 0018, B10–B12). A discharge is normal (the doctor's order), LAMA
   (the doctor's record: reason, risks explained, the form signed, a witness) or a death on the ward (time, cause, the ER's
   checks); each kind has its step graph (@setu/domain discharge.ts). The summary, final bill and payment steps finish by
   their events — the summary signed, the bill issued, the bill balanced with any excess refund paid — caught up by
   `catchUp` from every event and every view; the pharmacy's clearance and "patient left" / "body moved" are marked done
   with a PIN. Patient left: ADMISSION discharge, the bed assignment ended, BED leave (→ cleaning, with a note), the
   medication orders completed, bed days stopped; the visit finishes once the patient left and the bill is issued. */
import type { DischargeList, DischargeStepDoneRequest, DischargeStepView, DischargeView } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  ADMISSION, BED, DISCHARGE, ENCOUNTER, MEDICATION_ORDER, SUMMARY_KIND, authorize, bedDaysDue, blockingSteps, canDoStep, canRemind, deathRecordBlockers, defaultTarget,
  dischargeOrderBlockers, doneCount, finishStep, format, initialStepStates, isStepKey, lamaBlockers, markable, overdue, pharmacyClearanceBlockers, stepDef, stepsOf, transition, visitFinishes,
  type BedState, type DischargeKind, type DischargeStepKey, type DischargeStepState, type EncounterState, type Role, type StepStates,
} from "@setu/domain";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { endAssignment, under, type DbBedState, type DbEncStatus } from "./er.js";
import { getPatient, notFound, toSummary } from "./frontdesk.js";
import { dash, erPatientOf, iso, peopleOf, stale, type Adm } from "./inpatient.js";
import { syncAdmission } from "./ipdBill.js";
import { deliverInApp } from "./lab.js";
import { requirePin } from "./pin.js";
import { devHash } from "./users.js";

type Dis = NonNullable<Awaited<ReturnType<Tx["discharge"]["findFirst"]>>>;
type Step = NonNullable<Awaited<ReturnType<Tx["dischargeStep"]["findFirst"]>>>;
type DisFull = Dis & { steps: Step[] };
const BILL_ROLES = ["cashier", "owner", "admin"];
/** The steps' names (the screen uses its own strings; these go to prints, lists and audits). */
const STEP_NAMES: Record<DischargeKind, Record<DischargeStepKey, [string, string]>> = {
  normal: { order: ["ডাক্তারের ছাড়পত্র আদেশ", "Doctor discharge order"], summary: ["ছাড়পত্র সারাংশ", "Discharge summary"], pharmacy: ["ফার্মেসি ছাড়পত্র", "Pharmacy clearance"], "final-bill": ["চূড়ান্ত বিল", "Final bill"], payment: ["পরিশোধ ও ছাড়পত্র", "Payment & clearance"], "bed-release": ["রোগী চলে গেছেন", "Patient left"] },
  lama: { order: ["নিজ দায়িত্বে ছুটি (LAMA)", "LAMA record"], summary: ["ছাড়পত্র সারাংশ (২৪ ঘণ্টার মধ্যে)", "Discharge summary (within 24 h)"], pharmacy: ["ফার্মেসি ছাড়পত্র", "Pharmacy clearance"], "final-bill": ["চূড়ান্ত বিল", "Final bill"], payment: ["পরিশোধ", "Payment"], "bed-release": ["রোগী চলে গেছেন", "Patient left"] },
  death: { order: ["মৃত্যুর রেকর্ড", "Death record"], summary: ["", ""], pharmacy: ["", ""], "final-bill": ["চূড়ান্ত বিল", "Final bill"], payment: ["পরিশোধ", "Payment"], "bed-release": ["মরদেহ সরানো হয়েছে", "Body moved"] },
};
/** Who sees the checklist: the discharge screen's roles, the pharmacist (step 3) and the IPD bill's (steps 4–5). */
export function canSeeDischarge(s: SessionData): boolean {
  if (authorize(s.role, s.plan, "ipd", "discharge").allowed) return true;
  if (s.role === "pharmacist" && authorize(s.role, s.plan, "ph", "indent").allowed) return true;
  return BILL_ROLES.includes(s.role) && authorize(s.role, s.plan, "bill", "ipd").allowed;
}
export function requireDischarge(s: SessionData) {
  if (canSeeDischarge(s)) return;
  const plan = authorize(s.role, s.plan, "ipd", "discharge").reason === "plan";
  throw err(403, "forbidden", "এই পাতা আপনার জন্য নয়", "This page is not for you", { reason: plan ? "plan" : "role", canRequest: false });
}
const checkPin = async (tx: Tx, s: SessionData, pin: string) => {
  const u = await tx.user.findFirst({ where: { id: s.userId }, select: { pinHash: true } });
  await requirePin(s.userId, () => Boolean(u?.pinHash) && u!.pinHash === devHash(pin));
};
const statesOf = (steps: Step[]): StepStates => Object.fromEntries(steps.map((x) => [x.key, x.status]));
const kindOf = (d: Dis) => d.kind as DischargeKind;
const live = (d: Dis) => d.status === "ordered" || d.status === "completed";

/* ───── the events ───── */
/** What has happened that finishes an event step: the summary signed, the bill issued, the bill balanced with any excess
    refund paid. */
async function eventsOf(tx: Tx, d: Dis): Promise<Partial<Record<DischargeStepKey, boolean>>> {
  const a = (await tx.admission.findFirst({ where: { id: d.admissionId } }))!;
  const inv = a.invoiceId ? await tx.invoice.findFirst({ where: { id: a.invoiceId } }) : null;
  const summary = await tx.composition.findFirst({ where: { encounterId: d.encounterId, kind: SUMMARY_KIND, status: { in: ["final", "amended"] } }, select: { id: true } });
  const excessOpen = inv && inv.excessPaisa > 0 ? await tx.refund.findFirst({ where: { invoiceId: inv.id, source: "deposit-excess", status: { not: "paid" } }, select: { id: true } }) : null;
  return {
    summary: Boolean(summary),
    "final-bill": Boolean(inv && inv.status !== "draft"),
    payment: Boolean(inv && inv.status === "balanced" && !excessOpen),
  };
}
/** Finish every event step whose event has happened (in the graph's order), then the visit if it is due. `by` is the
    person whose action or view caught it up (the database wants a signed-in "done by"); nobody: nothing changes. */
export async function catchUp(tx: Tx, by: string | null, d0: DisFull, now: Date): Promise<AuditEntry[]> {
  if (!by || !live(d0)) return [];
  const kind = kindOf(d0);
  const ev = await eventsOf(tx, d0);
  let states = statesOf(d0.steps);
  const audit: AuditEntry[] = [];
  for (let round = 0; round < 4; round++) {
    let moved = false;
    for (const def of stepsOf(kind)) {
      if (!def.byEvent || def.key === "order" || states[def.key] !== "in-progress" || !ev[def.key]) continue;
      const next = finishStep(kind, states, def.key);
      const x = d0.steps.find((y) => y.key === def.key)!;
      const n = await tx.dischargeStep.updateMany({ where: { id: x.id, status: "in-progress" }, data: { status: "done", doneById: by, doneAt: now } });
      if (n.count !== 1) throw stale();
      for (const y of d0.steps.filter((y) => states[y.key as DischargeStepKey] === "waiting" && next[y.key as DischargeStepKey] === "in-progress"))
        await tx.dischargeStep.update({ where: { id: y.id }, data: { status: "in-progress", startedAt: now } });
      audit.push({ action: "update", entity: "DischargeStep", entityId: x.id, patientId: d0.patientId, detail: { event: "done-by-event", step: def.key } });
      states = next; moved = true;
    }
    if (!moved) break;
  }
  audit.push(...await finishVisitIfDue(tx, d0, states, now));
  return audit;
}
/** ADR 0018: the inpatient visit finishes once the patient has left and the bill is issued, whichever comes second. */
async function finishVisitIfDue(tx: Tx, d: Dis, states: StepStates, now: Date): Promise<AuditEntry[]> {
  if (!visitFinishes(states)) return [];
  const e = await tx.encounter.findFirst({ where: { id: d.encounterId } });
  if (!e || e.status !== "in_progress") return [];
  const fin = transition("encounter", ENCOUNTER, dash<EncounterState>(e.status), "finish");
  const n = await tx.encounter.updateMany({ where: { id: e.id, status: e.status }, data: { status: under<DbEncStatus>(fin), statusAt: now } });
  if (n.count !== 1) throw stale();
  return [{ action: "update", entity: "Encounter", entityId: e.id, patientId: d.patientId, detail: { event: "finish", to: fin, reason: "left-and-billed" } }];
}
const liveOf = (tx: Tx, admissionId: string) => tx.discharge.findFirst({ where: { admissionId, status: { in: ["ordered", "completed"] } }, include: { steps: true } });
/** Hooks: the bill issued (ipdBill), the summary signed (summary), money settled (billing / refunds). */
export async function afterEvent(tx: Tx, by: string | null, admissionId: string, now: Date): Promise<AuditEntry[]> {
  const d = await liveOf(tx, admissionId);
  return d ? catchUp(tx, by, d, now) : [];
}
export async function moneySettled(tx: Tx, o: { tenantId: string; organizationId: string }, invoiceId: string, by: string | null, now: Date): Promise<AuditEntry[]> {
  const a = await tx.admission.findFirst({ where: { invoiceId, organizationId: o.organizationId }, select: { id: true } });
  return a ? afterEvent(tx, by, a.id, now) : [];
}

/* ───── views ───── */
async function viewOf(tx: Tx, s: SessionData, d: DisFull, now: Date): Promise<DischargeView> {
  const kind = kindOf(d);
  const a = (await tx.admission.findFirst({ where: { id: d.admissionId } }))!;
  const bed = await tx.location.findFirst({ where: { id: a.bedId } });
  const ward = bed?.parentId ? await tx.location.findFirst({ where: { id: bed.parentId }, select: { name: true } }) : null;
  const detail = (d.detail ?? null) as { witnessId?: string } | null;
  const who = await peopleOf(tx, [d.orderedById, d.cancelledById, a.admittingDoctorId, detail?.witnessId, ...d.steps.flatMap((x) => [x.takenById, x.doneById, x.remindedById])]);
  const states = statesOf(d.steps);
  const blocking = live(d) ? blockingSteps(kind, states) : [];
  const person = (x: Step) => (x.takenById ? who(x.takenById) : stepDef(kind, x.key as DischargeStepKey).department === "doctor" ? who(a.admittingDoctorId) : null);
  const steps = stepsOf(kind).map((def): DischargeStepView => {
    const x = d.steps.find((y) => y.key === def.key)!;
    const mine = canDoStep(kind, def.key, s.role as Role);
    const [nameBn, nameEn] = STEP_NAMES[kind][def.key];
    return {
      key: def.key, status: x.status as DischargeStepState, department: def.department, nameEn, nameBn, waitsFor: def.waitsFor,
      startedAt: iso(x.startedAt), takenBy: x.takenById ? who(x.takenById) : null, doneBy: x.doneById ? who(x.doneById) : null, doneAt: iso(x.doneAt),
      byHand: x.byHand, byEvent: def.byEvent, note: x.note, reminded: x.remindedById && x.remindedAt ? { by: who(x.remindedById), at: x.remindedAt.toISOString(), count: x.reminders } : null,
      blocking: blocking.includes(def.key),
      can: {
        take: live(d) && mine && x.status !== "done" && x.takenById !== s.userId && def.key !== "order",
        done: live(d) && mine && x.status === "in-progress" && markable(kind, def.key),
        remind: live(d) && x.status === "in-progress" && canRemind(x.remindedAt, now),
      },
    };
  });
  const enc = await tx.encounter.findFirst({ where: { id: d.encounterId }, select: { status: true, outcome: true } });
  return {
    discharge: {
      id: d.id, kind, status: d.status as DischargeView["discharge"]["status"], advice: d.advice, targetAt: d.targetAt.toISOString(), overdue: d.status === "ordered" && overdue(d.targetAt, now),
      orderedBy: who(d.orderedById), orderedAt: d.orderedAt.toISOString(), completedAt: iso(d.completedAt),
      cancel: d.cancelledById && d.cancelledAt ? { by: who(d.cancelledById), at: d.cancelledAt.toISOString(), reason: d.cancelReason ?? "" } : null,
      record: d.detail ? { ...(d.detail as Record<string, unknown>), ...(detail?.witnessId ? { witness: who(detail.witnessId) } : {}) } : null,
    },
    admission: { id: a.id, number: a.number ?? "", bed: bed?.name ?? null, ward: ward?.name ?? null, dayNo: bedDaysDue(a.admittedAt!, a.dischargedAt, now), doctor: who(a.admittingDoctorId), encounterId: a.encounterId!, visitFinished: enc?.status === "finished", outcome: (enc?.outcome ?? null) as "lama" | "deceased" | null },
    patient: toSummary(await getPatient(tx, a.patientId)),
    steps,
    header: { done: doneCount(states), total: steps.length, complete: d.status === "completed",
      blockedBy: blocking.map((k) => { const x = d.steps.find((y) => y.key === k)!; return { key: k, department: stepDef(kind, k).department, person: person(x) }; }) },
    can: { cancel: d.status === "ordered" && s.role === "doctor" && kind !== "death" && states["final-bill"] !== "done" && states["bed-release"] !== "done" },
  };
}
async function dischargeHere(tx: Tx, s: SessionData, id: string, lock = false): Promise<DisFull> {
  if (lock) await tx.$queryRaw`SELECT 1 FROM "Discharge" WHERE "id" = ${id} FOR UPDATE`;
  const d = await tx.discharge.findFirst({ where: { id, organizationId: s.organizationId }, include: { steps: true } });
  if (!d) throw notFound();
  return d;
}
/** The admission's checklist: the live discharge, or the last cancelled one. Opening it catches the event steps up. */
export async function dischargeView(tx: Tx, s: SessionData, admissionId: string, now: Date): Promise<{ view: DischargeView; audit: AuditEntry[] }> {
  requireDischarge(s);
  const a = await tx.admission.findFirst({ where: { id: admissionId, organizationId: s.organizationId } });
  if (!a) throw notFound();
  let d = (await liveOf(tx, a.id)) ?? (await tx.discharge.findFirst({ where: { admissionId: a.id }, include: { steps: true }, orderBy: { orderedAt: "desc" } }));
  if (!d) throw err(404, "no_discharge", "ছুটির আদেশ হয়নি", "No discharge is ordered");
  const audit = await catchUp(tx, s.userId, d, now);
  if (audit.length) d = await dischargeHere(tx, s, d.id);
  return { view: await viewOf(tx, s, d, now), audit };
}
/** The live discharges of this facility (ordered, completed today or still owing a step) with the steps this user can act on. */
export async function dischargeList(tx: Tx, s: SessionData, now: Date): Promise<{ list: DischargeList; patientIds: string[] }> {
  requireDischarge(s);
  const since = new Date(now.getTime() - 24 * 3600_000);
  // a discharge on a voided visit (an e2e reset, a visit entered in error) is not on anyone's list
  const voided = new Set((await tx.encounter.findMany({ where: { organizationId: s.organizationId, class: "ipd", status: { in: ["entered_in_error", "cancelled"] } }, select: { id: true } })).map((e) => e.id));
  const rows0 = await tx.discharge.findMany({ where: { organizationId: s.organizationId, OR: [{ status: "ordered" }, { status: "completed", completedAt: { gte: since } }, { status: "completed", steps: { some: { status: { not: "done" } } } }] }, include: { steps: true }, orderBy: { targetAt: "asc" } });
  const rows = rows0.filter((d) => !voided.has(d.encounterId));
  const adms = new Map((await tx.admission.findMany({ where: { id: { in: rows.map((r) => r.admissionId) } } })).map((a) => [a.id, a]));
  const pats = new Map((await tx.patient.findMany({ where: { id: { in: rows.map((r) => r.patientId) } } })).map((p) => [p.id, p]));
  const beds = new Map((await tx.location.findMany({ where: { organizationId: s.organizationId, kind: { in: ["bed", "ward"] } }, select: { id: true, name: true, parentId: true } })).map((b) => [b.id, b]));
  const who = await peopleOf(tx, [...rows.flatMap((r) => r.steps.map((x) => x.takenById)), ...[...adms.values()].map((a) => a.admittingDoctorId)]);
  const candidates = s.role === "doctor" || s.role === "admin" ? await (async () => {
    const taken = new Set((await tx.discharge.findMany({ where: { organizationId: s.organizationId, status: { in: ["ordered", "completed"] } }, select: { admissionId: true } })).map((x) => x.admissionId));
    const open = (await tx.admission.findMany({ where: { organizationId: s.organizationId, status: "admitted" }, orderBy: { admittedAt: "asc" } })).filter((a) => !taken.has(a.id) && a.encounterId);
    const ps = new Map((await tx.patient.findMany({ where: { id: { in: open.map((a) => a.patientId) } } })).map((p) => [p.id, p]));
    const docs = await peopleOf(tx, open.map((a) => a.admittingDoctorId));
    return open.flatMap((a) => { const p = ps.get(a.patientId); const bed = beds.get(a.bedId); return p ? [{
      admissionId: a.id, number: a.number ?? "", patient: erPatientOf(p as Parameters<typeof erPatientOf>[0]), bed: bed?.name ?? null, ward: bed?.parentId ? beds.get(bed.parentId)?.name ?? null : null,
      dayNo: bedDaysDue(a.admittedAt!, null, now), doctor: docs(a.admittingDoctorId) }] : []; });
  })() : [];
  return {
    patientIds: [...rows.map((r) => r.patientId), ...candidates.map((c) => c.patient.id)],
    list: { candidates, items: rows.flatMap((d) => {
      const a = adms.get(d.admissionId), p = pats.get(d.patientId);
      if (!a || !p) return [];
      const kind = kindOf(d);
      const states = statesOf(d.steps);
      const blocking = blockingSteps(kind, states);
      const bed = beds.get(a.bedId);
      return [{
        id: d.id, kind, admissionId: a.id, number: a.number ?? "", patient: erPatientOf(p as Parameters<typeof erPatientOf>[0]), bed: bed?.name ?? null, ward: bed?.parentId ? beds.get(bed.parentId)?.name ?? null : null,
        status: d.status as "ordered", done: doneCount(states), total: d.steps.length, targetAt: d.targetAt.toISOString(), overdue: d.status === "ordered" && overdue(d.targetAt, now),
        blockedBy: blocking.map((k) => { const x = d.steps.find((y) => y.key === k)!; return { key: k, department: stepDef(kind, k).department, person: x.takenById ? who(x.takenById) : stepDef(kind, k).department === "doctor" ? who(a.admittingDoctorId) : null }; }),
        mine: stepsOf(kind).filter((def) => states[def.key] === "in-progress" && markable(kind, def.key) && canDoStep(kind, def.key, s.role as Role)).map((def) => def.key),
        orderedAt: d.orderedAt.toISOString(), completedAt: iso(d.completedAt),
      }];
    }) },
  };
}

/* ───── the record: the order, LAMA, a death (the doctor, PIN) ───── */
async function setBed(tx: Tx, bedId: string, event: "startDischarge" | "cancelDischarge" | "leave", note?: string) {
  const b = (await tx.location.findFirst({ where: { id: bedId } }))!;
  const to = transition("bed", BED, dash<BedState>(b.bedState ?? "occupied"), event);
  const n = await tx.location.updateMany({ where: { id: b.id, bedState: b.bedState }, data: { bedState: under<DbBedState>(to), ...(note !== undefined ? { bedNote: note } : {}) } });
  if (n.count !== 1) throw stale();
  return { name: b.name, to };
}
async function admittedHere(tx: Tx, s: SessionData, admissionId: string) {
  requireDischarge(s);
  if (s.role !== "doctor") throw err(403, "forbidden", "ছুটি / LAMA / মৃত্যুর রেকর্ড দেন ডাক্তার", "A doctor records the discharge, LAMA or a death", { reason: "role", canRequest: false });
  const a = await tx.admission.findFirst({ where: { id: admissionId, organizationId: s.organizationId } });
  if (!a || !a.encounterId) throw notFound();
  if (a.status !== "admitted") throw err(409, "not_admitted", "রোগী ভর্তি নেই", "The patient is not admitted");
  if (await tx.discharge.findFirst({ where: { admissionId: a.id, status: { in: ["ordered", "completed"] } }, select: { id: true } })) throw err(409, "discharge_exists", "ছুটির আদেশ আগেই হয়েছে", "A discharge is already recorded");
  if (await tx.bedAssignment.findFirst({ where: { encounterId: a.encounterId, status: "reserved" }, select: { id: true } })) throw err(409, "move_pending", "একটি শয্যা বদল অপেক্ষায় — আগে শেষ বা বাতিল করুন", "A bed move is waiting — finish or cancel it first");
  return a;
}
async function createDischarge(tx: Tx, s: SessionData, a: Adm, kind: DischargeKind, advice: string, targetAt: Date, detail: object | null, now: Date): Promise<{ view: DischargeView; audit: AuditEntry[] }> {
  const states = initialStepStates(kind);
  const d = await tx.discharge.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, admissionId: a.id, encounterId: a.encounterId!, patientId: a.patientId, kind, status: "ordered", advice: advice.trim(), targetAt,
    ...(detail ? { detail } : {}), orderedById: s.userId, orderedAt: now,
  } });
  // the record first (the steps that wait for it check it is done)
  await tx.dischargeStep.create({ data: { tenantId: s.tenantId, dischargeId: d.id, key: "order", status: "done", startedAt: now, doneById: s.userId, doneAt: now, takenById: s.userId, takenAt: now } });
  for (const def of stepsOf(kind).filter((x) => x.key !== "order")) {
    await tx.dischargeStep.create({ data: { tenantId: s.tenantId, dischargeId: d.id, key: def.key, status: states[def.key]!, startedAt: states[def.key] === "in-progress" ? now : null } });
  }
  const bed = await setBed(tx, a.bedId, "startDischarge");
  const audit: AuditEntry[] = [
    { action: "sign", entity: "Discharge", entityId: d.id, patientId: a.patientId, detail: { event: kind === "normal" ? "order" : kind, admissionId: a.id, targetAt: targetAt.toISOString() } },
    { action: "update", entity: "Location", entityId: a.bedId, patientId: a.patientId, detail: { event: "startDischarge", bed: bed.name, to: bed.to } },
  ];
  // the visit's outcome (LAMA, deceased) — ADR 0018, decision 15
  if (kind !== "normal") {
    await tx.encounter.update({ where: { id: a.encounterId! }, data: { outcome: kind === "death" ? "deceased" : "lama" } });
    audit.push({ action: "update", entity: "Encounter", entityId: a.encounterId!, patientId: a.patientId, detail: { event: "outcome", outcome: kind === "death" ? "deceased" : "lama" } });
  }
  // a death: the medication orders stop now (no dose is due on a deceased patient)
  if (kind === "death") audit.push(...await completeOrders(tx, a.encounterId!, a.patientId));
  return { view: await viewOf(tx, s, await dischargeHere(tx, s, d.id), now), audit };
}
export async function orderDischarge(tx: Tx, s: SessionData, admissionId: string, body: { advice: string; targetAt?: string; pin: string }, now: Date) {
  const a = await admittedHere(tx, s, admissionId);
  const targetAt = body.targetAt ? new Date(body.targetAt) : defaultTarget(now);
  const b = dischargeOrderBlockers({ advice: body.advice, targetAt, now });
  if (b.length) throw err(400, b[0]!, b[0] === "advice" ? "ছুটির পরামর্শ লিখুন (অন্তত ১০ অক্ষর)" : "লক্ষ্য সময় এখন থেকে ২৪ ঘণ্টার মধ্যে দিন", b[0] === "advice" ? "Write the discharge advice (at least 10 characters)" : "Set a target time within the next 24 hours", { field: b[0] === "advice" ? "advice" : "targetAt" });
  await checkPin(tx, s, body.pin);
  return createDischarge(tx, s, a, "normal", body.advice, targetAt, null, now);
}
/** LAMA (decision 14): reason, risks explained, the form signed by the patient or guardian, a witness (nurse / doctor). */
export async function recordLama(tx: Tx, s: SessionData, admissionId: string, body: { reason: string; risksExplained: boolean; formSigned: boolean; witnessId: string | null; pin: string }, now: Date) {
  const a = await admittedHere(tx, s, admissionId);
  const b = lamaBlockers({ reason: body.reason, risksExplained: body.risksExplained, formSigned: body.formSigned, witnessId: body.witnessId }, s.userId);
  const MSG: Record<string, [string, string, string]> = {
    reason: ["কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write the reason (at least 10 characters)", "reason"],
    risks: ["ঝুঁকি বুঝিয়ে বলা হয়েছে — নিশ্চিত করুন", "Confirm the risks were explained", "risksExplained"],
    form: ["রোগী বা অভিভাবক LAMA ফর্মে স্বাক্ষর করেছেন — নিশ্চিত করুন", "Confirm the LAMA form is signed by the patient or guardian", "formSigned"],
    witness: ["সাক্ষী বাছুন (নার্স বা ডাক্তার)", "Choose a witness (a nurse or doctor)", "witnessId"],
    witness_self: ["সাক্ষী আপনি নিজে হতে পারেন না", "The witness cannot be you", "witnessId"],
  };
  if (b.length) { const [bn, en, field] = MSG[b[0]!]!; throw err(400, `lama_${b[0]}`, bn, en, { field }); }
  const witness = await tx.practitionerRole.findFirst({ where: { userId: body.witnessId!, organizationId: s.organizationId, role: { in: ["nurse", "doctor"] }, user: { active: true } }, select: { userId: true } });
  if (!witness) throw err(400, "lama_witness", "সাক্ষী এই প্রতিষ্ঠানের নার্স বা ডাক্তার নন", "The witness is not a nurse or doctor of this facility", { field: "witnessId" });
  await checkPin(tx, s, body.pin);
  return createDischarge(tx, s, a, "lama", body.reason, now, { risksExplained: true, formSigned: true, witnessId: body.witnessId }, now);
}
/** A death on the ward (decision 15): the ER's checks; the visit's outcome "deceased"; no summary. */
export async function recordDeath(tx: Tx, s: SessionData, admissionId: string, body: { timeOfDeath: string; cause: string; medicoLegal: boolean; checks: string[]; pin: string }, now: Date) {
  const a = await admittedHere(tx, s, admissionId);
  const b = deathRecordBlockers({ timeOfDeath: body.timeOfDeath, cause: body.cause, medicoLegal: body.medicoLegal, checks: body.checks }, a.admittedAt!, now);
  if (b.length) throw err(400, `death_${b[0]!.code}`, "মৃত্যুর রেকর্ডে যা লাগে তা পূরণ করুন", "Complete the death record", { field: b[0]!.field, blockers: b as unknown as Record<string, unknown>[] });
  await checkPin(tx, s, body.pin);
  return createDischarge(tx, s, a, "death", body.cause, new Date(body.timeOfDeath), { timeOfDeath: new Date(body.timeOfDeath).toISOString(), medicoLegal: body.medicoLegal, checks: body.checks }, now);
}
export async function cancelDischarge(tx: Tx, s: SessionData, id: string, body: { reason: string; pin: string }, now: Date): Promise<{ view: DischargeView; audit: AuditEntry[] }> {
  requireDischarge(s);
  if (s.role !== "doctor") throw err(403, "forbidden", "ছুটির আদেশ বাতিল করেন ডাক্তার", "A doctor cancels the discharge", { reason: "role", canRequest: false });
  const d = await dischargeHere(tx, s, id, true);
  if (d.status !== "ordered") throw err(409, "discharge_closed", "এই ছুটি আর খোলা নেই", "This discharge is no longer open");
  if (kindOf(d) === "death") throw err(409, "death_record", "মৃত্যুর রেকর্ড বাতিল হয় না", "A death record is never cancelled");
  const st = statesOf(d.steps);
  if (st["bed-release"] === "done") throw err(409, "bed_released", "রোগী চলে গেছেন", "The patient has left");
  if (st["final-bill"] === "done") throw err(409, "bill_issued", "চূড়ান্ত বিল হয়ে গেছে — ছুটি বাতিল হয় না", "The final bill is issued — the discharge cannot be cancelled");
  if (body.reason.trim().length < 10) throw err(400, "reason_required", "কারণ লিখুন (অন্তত ১০ অক্ষর)", "Give the reason (at least 10 characters)", { field: "reason" });
  await checkPin(tx, s, body.pin);
  const to = transition("discharge", DISCHARGE, "ordered", "cancel");
  const n = await tx.discharge.updateMany({ where: { id: d.id, status: "ordered" }, data: { status: to, cancelledById: s.userId, cancelledAt: now, cancelReason: body.reason.trim() } });
  if (n.count !== 1) throw stale();
  const a = (await tx.admission.findFirst({ where: { id: d.admissionId } }))!;
  const bed = await setBed(tx, a.bedId, "cancelDischarge");
  if (kindOf(d) === "lama") await tx.encounter.update({ where: { id: d.encounterId }, data: { outcome: null } });
  return {
    view: await viewOf(tx, s, await dischargeHere(tx, s, d.id), now),
    audit: [{ action: "update", entity: "Discharge", entityId: d.id, patientId: d.patientId, detail: { event: "cancel", kind: d.kind, reason: body.reason.trim() } },
      { action: "update", entity: "Location", entityId: a.bedId, patientId: d.patientId, detail: { event: "cancelDischarge", bed: bed.name, to: bed.to } }],
  };
}

/* ───── steps ───── */
async function stepHere(tx: Tx, s: SessionData, id: string, key: string) {
  requireDischarge(s);
  if (!isStepKey(key)) throw notFound();
  const d = await dischargeHere(tx, s, id, true);
  if (!live(d)) throw err(409, "discharge_closed", "এই ছুটি আর খোলা নেই", "This discharge is no longer open");
  const x = d.steps.find((y) => y.key === key);
  if (!x) throw notFound();
  return { d, x, key: key as DischargeStepKey };
}
const notYours = (kind: DischargeKind, key: DischargeStepKey) => err(403, "forbidden", "এই ধাপ আপনার বিভাগের নয়", `This step is ${stepDef(kind, key).department}'s`, { reason: "role", canRequest: false });
/** "I'll take it": the header names this person while the step blocks. */
export async function takeStep(tx: Tx, s: SessionData, id: string, key: string, now: Date): Promise<{ view: DischargeView; audit: AuditEntry[] }> {
  const { d, x, key: k } = await stepHere(tx, s, id, key);
  if (!canDoStep(kindOf(d), k, s.role as Role) || k === "order") throw notYours(kindOf(d), k);
  if (x.status === "done") throw err(409, "step_done", "এই ধাপ শেষ", "This step is done");
  await tx.dischargeStep.update({ where: { id: x.id }, data: { takenById: s.userId, takenAt: now } });
  return { view: await viewOf(tx, s, await dischargeHere(tx, s, d.id), now), audit: [{ action: "update", entity: "DischargeStep", entityId: x.id, patientId: d.patientId, detail: { event: "take", step: k } }] };
}
export async function remindStep(tx: Tx, s: SessionData, id: string, key: string, now: Date): Promise<{ view: DischargeView; audit: AuditEntry[] }> {
  const { d, x, key: k } = await stepHere(tx, s, id, key);
  if (x.status !== "in-progress") throw err(409, "step_not_open", "এই ধাপ এখন চলছে না", "This step is not in progress");
  if (!canRemind(x.remindedAt, now)) throw err(409, "reminded_recently", "১০ মিনিটের মধ্যে আবার মনে করানো যায় না", "Reminded less than 10 minutes ago");
  await tx.dischargeStep.update({ where: { id: x.id }, data: { remindedById: s.userId, remindedAt: now, reminders: { increment: 1 } } });
  const audit: AuditEntry[] = [{ action: "update", entity: "DischargeStep", entityId: x.id, patientId: d.patientId, detail: { event: "remind", step: k } }];
  if (stepDef(kindOf(d), k).department === "doctor") {
    const a = (await tx.admission.findFirst({ where: { id: d.admissionId } }))!;
    const to = x.takenById ?? a.admittingDoctorId;
    const cid = await deliverInApp(tx, s, { patientId: d.patientId, encounterId: d.encounterId }, { kind: "discharge-remind", channel: "doctor_inbox", recipientUserId: to }, now);
    audit.push({ action: "create", entity: "Communication", entityId: cid, patientId: d.patientId, detail: { kind: "discharge-remind", to, step: k } });
  }
  return { view: await viewOf(tx, s, await dischargeHere(tx, s, d.id), now), audit };
}
/** Mark done (PIN): the pharmacy's clearance, or the patient left / the body moved. Every other step finishes by its event. */
export async function doneStep(tx: Tx, s: SessionData, id: string, key: string, body: DischargeStepDoneRequest, now: Date): Promise<{ view: DischargeView; audit: AuditEntry[] }> {
  const { d: d0 } = await stepHere(tx, s, id, key);
  // events first: a summary signed or a bill settled meanwhile may have unlocked this step
  const pre = await catchUp(tx, s.userId, d0, now);
  const d = pre.length ? await dischargeHere(tx, s, d0.id) : d0;
  const kind = kindOf(d);
  const k = key as DischargeStepKey;
  const x = d.steps.find((y) => y.key === k)!;
  if (!canDoStep(kind, k, s.role as Role) || k === "order") throw notYours(kind, k);
  if (!markable(kind, k)) throw err(409, "step_by_event", "এই ধাপ নিজে থেকে শেষ হয় (সারাংশ স্বাক্ষর, বিল, পরিশোধ)", "This step finishes by its event (the summary signed, the bill issued, the bill settled)");
  if (x.status !== "in-progress") throw err(409, "step_waiting", "এই ধাপের আগের ধাপগুলো শেষ হয়নি", "The steps before this one are not done");
  if (k === "pharmacy" && pharmacyClearanceBlockers({ ownMedicines: body.ownMedicines ?? null }).length)
    throw err(400, "own_medicines", "রোগীর নিজের ওষুধ ফেরত দেওয়া হয়েছে কি না বাছুন", "Say whether the patient's own medicines were handed back", { field: "ownMedicines" });
  const leftAt = k === "bed-release" && body.at ? new Date(body.at) : now;
  if (k === "bed-release" && (Number.isNaN(leftAt.getTime()) || leftAt.getTime() > now.getTime() + 60_000 || leftAt.getTime() < d.orderedAt.getTime()))
    throw err(400, "left_at", "সময় ছুটির আদেশ আর এখনের মধ্যে দিন", "The time is between the order and now", { field: "at" });
  await checkPin(tx, s, body.pin);
  const next = finishStep(kind, statesOf(d.steps), k);
  const n = await tx.dischargeStep.updateMany({ where: { id: x.id, status: "in-progress" }, data: {
    status: "done", doneById: s.userId, doneAt: k === "bed-release" ? leftAt : now, note: body.note?.trim() || null,
    detail: k === "pharmacy" ? { ownMedicines: body.ownMedicines } : undefined,
  } });
  if (n.count !== 1) throw stale();
  for (const y of d.steps.filter((y) => y.status === "waiting" && next[y.key as DischargeStepKey] === "in-progress"))
    await tx.dischargeStep.update({ where: { id: y.id }, data: { status: "in-progress", startedAt: now } });
  const audit: AuditEntry[] = [...pre, { action: "sign", entity: "DischargeStep", entityId: x.id, patientId: d.patientId, detail: { event: "done", step: k, note: body.note?.trim() || null, ownMedicines: body.ownMedicines ?? null } }];
  if (k === "bed-release") audit.push(...await patientLeft(tx, s, d, leftAt, now));
  const after = await dischargeHere(tx, s, d.id);
  audit.push(...await finishVisitIfDue(tx, after, statesOf(after.steps), now));
  return { view: await viewOf(tx, s, after, now), audit };
}
async function completeOrders(tx: Tx, encounterId: string, patientId: string): Promise<AuditEntry[]> {
  const orders = await tx.medicationRequest.findMany({ where: { encounterId, kind: "inpatient", orderStatus: "active" }, select: { id: true } });
  if (!orders.length) return [];
  transition("medication-order", MEDICATION_ORDER, "active", "complete");
  await tx.medicationRequest.updateMany({ where: { id: { in: orders.map((o) => o.id) }, orderStatus: "active" }, data: { orderStatus: "completed" } });
  return [{ action: "update", entity: "MedicationRequest", patientId, detail: { event: "complete", orders: orders.length } }];
}
/** The patient left (or the body moved): the discharge completed, the admission discharged, the bed to cleaning with a note. */
async function patientLeft(tx: Tx, s: SessionData, d: Dis, at: Date, now: Date): Promise<AuditEntry[]> {
  const audit: AuditEntry[] = [];
  const kind = kindOf(d);
  const c = await tx.discharge.updateMany({ where: { id: d.id, status: "ordered" }, data: { status: transition("discharge", DISCHARGE, "ordered", "complete"), completedAt: at } });
  if (c.count !== 1) throw stale();
  const a = (await tx.admission.findFirst({ where: { id: d.admissionId } }))!;
  const adm: Adm = await tx.admission.update({ where: { id: a.id }, data: { status: transition("admission", ADMISSION, "admitted", "discharge"), dischargedAt: at, dischargedById: s.userId } });
  const live = await tx.bedAssignment.findFirst({ where: { encounterId: d.encounterId, status: "occupied" } });
  const why = kind === "death" ? "deceased" : kind === "lama" ? "lama" : "discharged";
  if (live) await endAssignment(tx, s, live, at, why);
  const p = await tx.patient.findFirst({ where: { id: d.patientId }, select: { nameBn: true, nameEn: true } });
  const hhmm = format.time(at.toISOString(), false);
  const label = kind === "death" ? "Body moved" : kind === "lama" ? "LAMA" : "Discharged";
  const bed = await setBed(tx, a.bedId, "leave", `${label} ${hhmm} · ${p?.nameEn || p?.nameBn || ""}`.slice(0, 120));
  audit.push(
    { action: "update", entity: "Discharge", entityId: d.id, patientId: d.patientId, detail: { event: "complete", kind, at: at.toISOString() } },
    { action: "update", entity: "Admission", entityId: a.id, patientId: a.patientId, detail: { event: "discharge", kind } },
    { action: "update", entity: "Location", entityId: a.bedId, patientId: a.patientId, detail: { event: "leave", bed: bed.name, to: bed.to } },
    ...await completeOrders(tx, d.encounterId, d.patientId),
  );
  // bed days stop at the time the patient left (the bill, if still running, is brought up to date)
  audit.push(...await syncAdmission(tx, adm, s.userId, now, "left"));
  return audit;
}

