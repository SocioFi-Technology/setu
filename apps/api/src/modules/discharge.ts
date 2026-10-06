/* The discharge checklist (ADR 0017, walkthrough B9). The doctor orders the discharge (PIN): the bed goes to
   discharge-pending and the six steps are written, the order done. Each step is done by its owner role with a PIN;
   the steps it unlocks start; the header names who is blocking. Bed release (the nurse, last) discharges the patient:
   ADMISSION discharge, the visit finished, the bed assignment ended, BED leave (→ cleaning), the medication orders
   completed, bed days stopped. Until B10 / B11, the summary, final bill and payment steps are recorded by hand. */
import type { DischargeList, DischargeStepDoneRequest, DischargeStepView, DischargeView } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  ADMISSION, BED, DISCHARGE, DISCHARGE_STEPS, ENCOUNTER, MEDICATION_ORDER, authorize, bedDaysDue, blockingSteps, canDoStep, canRemind, defaultTarget, dischargeOrderBlockers,
  doneCount, finishStep, initialStepStates, isStepKey, overdue, pharmacyClearanceBlockers, stepDef, transition,
  type BedState, type DischargeStepKey, type DischargeStepState, type EncounterState, type Role, type StepStates,
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
const BILL_ROLES = ["cashier", "owner", "admin"];
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
const statesOf = (steps: Step[]) => Object.fromEntries(steps.map((x) => [x.key, x.status])) as StepStates;

/* ───── views ───── */
async function viewOf(tx: Tx, s: SessionData, d: Dis & { steps: Step[] }, now: Date): Promise<DischargeView> {
  const a = (await tx.admission.findFirst({ where: { id: d.admissionId } }))!;
  const bed = await tx.location.findFirst({ where: { id: a.bedId } });
  const ward = bed?.parentId ? await tx.location.findFirst({ where: { id: bed.parentId }, select: { name: true } }) : null;
  const who = await peopleOf(tx, [d.orderedById, d.cancelledById, a.admittingDoctorId, ...d.steps.flatMap((x) => [x.takenById, x.doneById, x.remindedById])]);
  const states = statesOf(d.steps);
  const blocking = d.status === "ordered" ? blockingSteps(states) : [];
  const live = d.status === "ordered";
  const person = (x: Step) => (x.takenById ? who(x.takenById) : stepDef(x.key as DischargeStepKey).department === "doctor" ? who(a.admittingDoctorId) : null);
  const steps = DISCHARGE_STEPS.map((def): DischargeStepView => {
    const x = d.steps.find((y) => y.key === def.key)!;
    const mine = canDoStep(def.key, s.role as Role);
    return {
      key: def.key, status: x.status as DischargeStepState, department: def.department, nameEn: def.nameEn, nameBn: def.nameBn, waitsFor: def.waitsFor,
      startedAt: iso(x.startedAt), takenBy: x.takenById ? who(x.takenById) : null, doneBy: x.doneById ? who(x.doneById) : null, doneAt: iso(x.doneAt),
      byHand: x.byHand, byHandStep: def.byHand, note: x.note, reminded: x.remindedById && x.remindedAt ? { by: who(x.remindedById), at: x.remindedAt.toISOString(), count: x.reminders } : null,
      blocking: blocking.includes(def.key),
      can: {
        take: live && mine && x.status !== "done" && x.takenById !== s.userId && def.key !== "order",
        done: live && mine && x.status === "in-progress",
        remind: live && x.status === "in-progress" && canRemind(x.remindedAt, now),
      },
    };
  });
  return {
    discharge: {
      id: d.id, status: d.status as DischargeView["discharge"]["status"], advice: d.advice, targetAt: d.targetAt.toISOString(), overdue: live && overdue(d.targetAt, now),
      orderedBy: who(d.orderedById), orderedAt: d.orderedAt.toISOString(), completedAt: iso(d.completedAt),
      cancel: d.cancelledById && d.cancelledAt ? { by: who(d.cancelledById), at: d.cancelledAt.toISOString(), reason: d.cancelReason ?? "" } : null,
    },
    admission: { id: a.id, number: a.number ?? "", bed: bed?.name ?? null, ward: ward?.name ?? null, dayNo: bedDaysDue(a.admittedAt!, a.dischargedAt, now), doctor: who(a.admittingDoctorId), encounterId: a.encounterId! },
    patient: toSummary(await getPatient(tx, a.patientId)),
    steps,
    header: { done: doneCount(states), total: DISCHARGE_STEPS.length, complete: d.status === "completed",
      blockedBy: blocking.map((k) => { const x = d.steps.find((y) => y.key === k)!; return { key: k, department: stepDef(k).department, person: person(x) }; }) },
    can: { cancel: live && s.role === "doctor" && states["bed-release"] !== "done" },
  };
}
async function dischargeHere(tx: Tx, s: SessionData, id: string, lock = false) {
  if (lock) await tx.$queryRaw`SELECT 1 FROM "Discharge" WHERE "id" = ${id} FOR UPDATE`;
  const d = await tx.discharge.findFirst({ where: { id, organizationId: s.organizationId }, include: { steps: true } });
  if (!d) throw notFound();
  return d;
}
/** The admission's checklist: the live discharge, or the last cancelled one. */
export async function dischargeView(tx: Tx, s: SessionData, admissionId: string, now: Date): Promise<DischargeView> {
  requireDischarge(s);
  const a = await tx.admission.findFirst({ where: { id: admissionId, organizationId: s.organizationId } });
  if (!a) throw notFound();
  const d = (await tx.discharge.findFirst({ where: { admissionId: a.id, status: { in: ["ordered", "completed"] } }, include: { steps: true } }))
    ?? (await tx.discharge.findFirst({ where: { admissionId: a.id }, include: { steps: true }, orderBy: { orderedAt: "desc" } }));
  if (!d) throw err(404, "no_discharge", "ছুটির আদেশ হয়নি", "No discharge is ordered");
  return viewOf(tx, s, d, now);
}
/** The live discharges of this facility (ordered, or completed today) with the steps this user can act on now. */
export async function dischargeList(tx: Tx, s: SessionData, now: Date): Promise<{ list: DischargeList; patientIds: string[] }> {
  requireDischarge(s);
  const since = new Date(now.getTime() - 24 * 3600_000);
  const rows = await tx.discharge.findMany({ where: { organizationId: s.organizationId, OR: [{ status: "ordered" }, { status: "completed", completedAt: { gte: since } }] }, include: { steps: true }, orderBy: { targetAt: "asc" } });
  const adms = new Map((await tx.admission.findMany({ where: { id: { in: rows.map((r) => r.admissionId) } } })).map((a) => [a.id, a]));
  const pats = new Map((await tx.patient.findMany({ where: { id: { in: rows.map((r) => r.patientId) } } })).map((p) => [p.id, p]));
  const beds = new Map((await tx.location.findMany({ where: { organizationId: s.organizationId, kind: { in: ["bed", "ward"] } }, select: { id: true, name: true, parentId: true } })).map((b) => [b.id, b]));
  const who = await peopleOf(tx, [...rows.flatMap((r) => r.steps.map((x) => x.takenById)), ...[...adms.values()].map((a) => a.admittingDoctorId)]);
  return {
    patientIds: rows.map((r) => r.patientId),
    list: { items: rows.flatMap((d) => {
      const a = adms.get(d.admissionId), p = pats.get(d.patientId);
      if (!a || !p) return [];
      const states = statesOf(d.steps);
      const blocking = d.status === "ordered" ? blockingSteps(states) : [];
      const bed = beds.get(a.bedId);
      return [{
        id: d.id, admissionId: a.id, number: a.number ?? "", patient: erPatientOf(p as Parameters<typeof erPatientOf>[0]), bed: bed?.name ?? null, ward: bed?.parentId ? beds.get(bed.parentId)?.name ?? null : null,
        status: d.status as "ordered", done: doneCount(states), targetAt: d.targetAt.toISOString(), overdue: d.status === "ordered" && overdue(d.targetAt, now),
        blockedBy: blocking.map((k) => { const x = d.steps.find((y) => y.key === k)!; return { key: k, department: stepDef(k).department, person: x.takenById ? who(x.takenById) : stepDef(k).department === "doctor" ? who(a.admittingDoctorId) : null }; }),
        mine: d.status === "ordered" ? DISCHARGE_STEPS.filter((def) => states[def.key] === "in-progress" && canDoStep(def.key, s.role as Role)).map((def) => def.key) : [],
        orderedAt: d.orderedAt.toISOString(), completedAt: iso(d.completedAt),
      }];
    }) },
  };
}

/* ───── the order and its cancellation (the doctor, PIN) ───── */
async function setBed(tx: Tx, bedId: string, event: "startDischarge" | "cancelDischarge" | "leave") {
  const b = (await tx.location.findFirst({ where: { id: bedId } }))!;
  const to = transition("bed", BED, dash<BedState>(b.bedState ?? "occupied"), event);
  const n = await tx.location.updateMany({ where: { id: b.id, bedState: b.bedState }, data: { bedState: under<DbBedState>(to) } });
  if (n.count !== 1) throw stale();
  return { name: b.name, to };
}
export async function orderDischarge(tx: Tx, s: SessionData, admissionId: string, body: { advice: string; targetAt?: string; pin: string }, now: Date): Promise<{ view: DischargeView; audit: AuditEntry[] }> {
  requireDischarge(s);
  if (s.role !== "doctor") throw err(403, "forbidden", "ছুটির আদেশ দেন ডাক্তার", "A doctor orders the discharge", { reason: "role", canRequest: false });
  const a = await tx.admission.findFirst({ where: { id: admissionId, organizationId: s.organizationId } });
  if (!a || !a.encounterId) throw notFound();
  if (a.status !== "admitted") throw err(409, "not_admitted", "রোগী ভর্তি নেই", "The patient is not admitted");
  if (await tx.discharge.findFirst({ where: { admissionId: a.id, status: { in: ["ordered", "completed"] } }, select: { id: true } })) throw err(409, "discharge_exists", "ছুটির আদেশ আগেই হয়েছে", "A discharge is already ordered");
  if (await tx.bedAssignment.findFirst({ where: { encounterId: a.encounterId, status: "reserved" }, select: { id: true } })) throw err(409, "move_pending", "একটি শয্যা বদল অপেক্ষায় — আগে শেষ বা বাতিল করুন", "A bed move is waiting — finish or cancel it first");
  const targetAt = body.targetAt ? new Date(body.targetAt) : defaultTarget(now);
  const b = dischargeOrderBlockers({ advice: body.advice, targetAt, now });
  if (b.length) throw err(400, b[0]!, b[0] === "advice" ? "ছুটির পরামর্শ লিখুন (অন্তত ১০ অক্ষর)" : "লক্ষ্য সময় এখন থেকে ২৪ ঘণ্টার মধ্যে দিন", b[0] === "advice" ? "Write the discharge advice (at least 10 characters)" : "Set a target time within the next 24 hours", { field: b[0] === "advice" ? "advice" : "targetAt" });
  await checkPin(tx, s, body.pin);
  const states = initialStepStates();
  const d = await tx.discharge.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, admissionId: a.id, encounterId: a.encounterId, patientId: a.patientId, status: "ordered", advice: body.advice.trim(), targetAt, orderedById: s.userId, orderedAt: now,
  } });
  // the order first (the steps that wait for it check it is done)
  await tx.dischargeStep.create({ data: { tenantId: s.tenantId, dischargeId: d.id, key: "order", status: "done", startedAt: now, doneById: s.userId, doneAt: now, takenById: s.userId, takenAt: now } });
  for (const def of DISCHARGE_STEPS.filter((x) => x.key !== "order")) {
    await tx.dischargeStep.create({ data: { tenantId: s.tenantId, dischargeId: d.id, key: def.key, status: states[def.key], startedAt: states[def.key] === "in-progress" ? now : null } });
  }
  const bed = await setBed(tx, a.bedId, "startDischarge");
  const audit: AuditEntry[] = [
    { action: "sign", entity: "Discharge", entityId: d.id, patientId: a.patientId, detail: { event: "order", admissionId: a.id, targetAt: targetAt.toISOString() } },
    { action: "update", entity: "Location", entityId: a.bedId, patientId: a.patientId, detail: { event: "startDischarge", bed: bed.name, to: bed.to } },
  ];
  return { view: await viewOf(tx, s, (await dischargeHere(tx, s, d.id))!, now), audit };
}
export async function cancelDischarge(tx: Tx, s: SessionData, id: string, body: { reason: string; pin: string }, now: Date): Promise<{ view: DischargeView; audit: AuditEntry[] }> {
  requireDischarge(s);
  if (s.role !== "doctor") throw err(403, "forbidden", "ছুটির আদেশ বাতিল করেন ডাক্তার", "A doctor cancels the discharge", { reason: "role", canRequest: false });
  const d = await dischargeHere(tx, s, id, true);
  if (d.status !== "ordered") throw err(409, "discharge_closed", "এই ছুটি আর খোলা নেই", "This discharge is no longer open");
  if (statesOf(d.steps)["bed-release"] === "done") throw err(409, "bed_released", "শয্যা ছেড়ে দেওয়া হয়েছে", "The bed was released");
  if (body.reason.trim().length < 10) throw err(400, "reason_required", "কারণ লিখুন (অন্তত ১০ অক্ষর)", "Give the reason (at least 10 characters)", { field: "reason" });
  await checkPin(tx, s, body.pin);
  const to = transition("discharge", DISCHARGE, "ordered", "cancel");
  const n = await tx.discharge.updateMany({ where: { id: d.id, status: "ordered" }, data: { status: to, cancelledById: s.userId, cancelledAt: now, cancelReason: body.reason.trim() } });
  if (n.count !== 1) throw stale();
  const a = (await tx.admission.findFirst({ where: { id: d.admissionId } }))!;
  const bed = await setBed(tx, a.bedId, "cancelDischarge");
  return {
    view: await viewOf(tx, s, await dischargeHere(tx, s, d.id), now),
    audit: [{ action: "update", entity: "Discharge", entityId: d.id, patientId: d.patientId, detail: { event: "cancel", reason: body.reason.trim() } },
      { action: "update", entity: "Location", entityId: a.bedId, patientId: d.patientId, detail: { event: "cancelDischarge", bed: bed.name, to: bed.to } }],
  };
}

/* ───── steps ───── */
async function stepHere(tx: Tx, s: SessionData, id: string, key: string) {
  requireDischarge(s);
  if (!isStepKey(key)) throw notFound();
  const d = await dischargeHere(tx, s, id, true);
  if (d.status !== "ordered") throw err(409, "discharge_closed", "এই ছুটি আর খোলা নেই", "This discharge is no longer open");
  const x = d.steps.find((y) => y.key === key)!;
  return { d, x, key };
}
const notYours = (key: DischargeStepKey) => err(403, "forbidden", "এই ধাপ আপনার বিভাগের নয়", `This step is ${stepDef(key).department}'s`, { reason: "role", canRequest: false });
/** "I'll take it": the header names this person while the step blocks. */
export async function takeStep(tx: Tx, s: SessionData, id: string, key: string, now: Date): Promise<{ view: DischargeView; audit: AuditEntry[] }> {
  const { d, x } = await stepHere(tx, s, id, key);
  if (!canDoStep(x.key as DischargeStepKey, s.role as Role) || x.key === "order") throw notYours(x.key as DischargeStepKey);
  if (x.status === "done") throw err(409, "step_done", "এই ধাপ শেষ", "This step is done");
  await tx.dischargeStep.update({ where: { id: x.id }, data: { takenById: s.userId, takenAt: now } });
  return { view: await viewOf(tx, s, await dischargeHere(tx, s, d.id), now), audit: [{ action: "update", entity: "DischargeStep", entityId: x.id, patientId: d.patientId, detail: { event: "take", step: x.key } }] };
}
export async function remindStep(tx: Tx, s: SessionData, id: string, key: string, now: Date): Promise<{ view: DischargeView; audit: AuditEntry[] }> {
  const { d, x } = await stepHere(tx, s, id, key);
  if (x.status !== "in-progress") throw err(409, "step_not_open", "এই ধাপ এখন চলছে না", "This step is not in progress");
  if (!canRemind(x.remindedAt, now)) throw err(409, "reminded_recently", "১০ মিনিটের মধ্যে আবার মনে করানো যায় না", "Reminded less than 10 minutes ago");
  await tx.dischargeStep.update({ where: { id: x.id }, data: { remindedById: s.userId, remindedAt: now, reminders: { increment: 1 } } });
  const audit: AuditEntry[] = [{ action: "update", entity: "DischargeStep", entityId: x.id, patientId: d.patientId, detail: { event: "remind", step: x.key } }];
  // the doctor's steps reach the doctor's inbox (the one who took it, else the admitting doctor)
  if (stepDef(x.key as DischargeStepKey).department === "doctor") {
    const a = (await tx.admission.findFirst({ where: { id: d.admissionId } }))!;
    const to = x.takenById ?? a.admittingDoctorId;
    const cid = await deliverInApp(tx, s, { patientId: d.patientId, encounterId: d.encounterId }, { kind: "discharge-remind", channel: "doctor_inbox", recipientUserId: to }, now);
    audit.push({ action: "create", entity: "Communication", entityId: cid, patientId: d.patientId, detail: { kind: "discharge-remind", to, step: x.key } });
  }
  return { view: await viewOf(tx, s, await dischargeHere(tx, s, d.id), now), audit };
}
export async function doneStep(tx: Tx, s: SessionData, id: string, key: string, body: DischargeStepDoneRequest, now: Date): Promise<{ view: DischargeView; audit: AuditEntry[] }> {
  const { d, x } = await stepHere(tx, s, id, key);
  const k = x.key as DischargeStepKey;
  if (!canDoStep(k, s.role as Role) || k === "order") throw notYours(k);
  if (x.status !== "in-progress") throw err(409, "step_waiting", "এই ধাপের আগের ধাপগুলো শেষ হয়নি", "The steps before this one are not done");
  if (k === "pharmacy" && pharmacyClearanceBlockers({ ownMedicines: body.ownMedicines ?? null }).length)
    throw err(400, "own_medicines", "রোগীর নিজের ওষুধ ফেরত দেওয়া হয়েছে কি না বাছুন", "Say whether the patient's own medicines were handed back", { field: "ownMedicines" });
  await checkPin(tx, s, body.pin);
  const next = finishStep(statesOf(d.steps), k);
  const n = await tx.dischargeStep.updateMany({ where: { id: x.id, status: "in-progress" }, data: {
    status: "done", doneById: s.userId, doneAt: now, byHand: stepDef(k).byHand, note: body.note?.trim() || null,
    detail: k === "pharmacy" ? { ownMedicines: body.ownMedicines } : undefined,
  } });
  if (n.count !== 1) throw stale();
  for (const y of d.steps.filter((y) => y.status === "waiting" && next[y.key as DischargeStepKey] === "in-progress"))
    await tx.dischargeStep.update({ where: { id: y.id }, data: { status: "in-progress", startedAt: now } });
  const audit: AuditEntry[] = [{ action: "sign", entity: "DischargeStep", entityId: x.id, patientId: d.patientId, detail: { event: "done", step: k, byHand: stepDef(k).byHand, note: body.note?.trim() || null, ownMedicines: body.ownMedicines ?? null } }];
  if (k === "bed-release") audit.push(...await releaseBed(tx, s, d, now));
  return { view: await viewOf(tx, s, await dischargeHere(tx, s, d.id), now), audit };
}
/** The last step: the patient leaves. */
async function releaseBed(tx: Tx, s: SessionData, d: Dis, now: Date): Promise<AuditEntry[]> {
  const audit: AuditEntry[] = [];
  const c = await tx.discharge.updateMany({ where: { id: d.id, status: "ordered" }, data: { status: transition("discharge", DISCHARGE, "ordered", "complete"), completedAt: now } });
  if (c.count !== 1) throw stale();
  const a = (await tx.admission.findFirst({ where: { id: d.admissionId } }))!;
  const adm: Adm = await tx.admission.update({ where: { id: a.id }, data: { status: transition("admission", ADMISSION, "admitted", "discharge"), dischargedAt: now, dischargedById: s.userId } });
  const e = (await tx.encounter.findFirst({ where: { id: d.encounterId } }))!;
  const fin = transition("encounter", ENCOUNTER, dash<EncounterState>(e.status), "finish");
  const ne = await tx.encounter.updateMany({ where: { id: e.id, status: e.status }, data: { status: under<DbEncStatus>(fin), statusAt: now } });
  if (ne.count !== 1) throw stale();
  const live = await tx.bedAssignment.findFirst({ where: { encounterId: e.id, status: "occupied" } });
  if (live) await endAssignment(tx, s, live, now, "discharged");
  const bed = await setBed(tx, a.bedId, "leave");
  const orders = await tx.medicationRequest.findMany({ where: { encounterId: e.id, kind: "inpatient", orderStatus: "active" }, select: { id: true } });
  if (orders.length) {
    transition("medication-order", MEDICATION_ORDER, "active", "complete");
    await tx.medicationRequest.updateMany({ where: { id: { in: orders.map((o) => o.id) }, orderStatus: "active" }, data: { orderStatus: "completed" } });
  }
  audit.push(
    { action: "update", entity: "Discharge", entityId: d.id, patientId: d.patientId, detail: { event: "complete" } },
    { action: "update", entity: "Admission", entityId: a.id, patientId: a.patientId, detail: { event: "discharge" } },
    { action: "update", entity: "Encounter", entityId: e.id, patientId: a.patientId, detail: { event: "finish", to: fin } },
    { action: "update", entity: "Location", entityId: a.bedId, patientId: a.patientId, detail: { event: "leave", bed: bed.name, to: bed.to, ordersCompleted: orders.length } },
  );
  // bed days stop at the release: the running bill is brought up to date (it stays a draft for B10)
  audit.push(...await syncAdmission(tx, adm, s.userId, now, "discharge"));
  return audit;
}
