/* Intake / output and care plan tasks (ADR 0016, slice B5–B6). I/O entries are append-only with the device time (they
   may wait in the outbox); totals run per shift day (the facility's I/O day start, sample 08:00 Dhaka). A nurse or a
   doctor writes a care task — once, or every N hours; only a nurse ticks it, and a recurring one comes back N hours
   after it was done (CARE_TASK). */
import { randomUUID } from "node:crypto";
import type { CareTaskCreate, CareTaskList, CareTaskView, IoEntryRequest, IoEntryView, IoView } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  CARE_EVERY_RANGE, CARE_TASK, CARE_TASK_GRACE_MIN_SAMPLE, careTaskTextOk, ioBlockers, ioTotals, nextCareDue, shiftDay, shiftDayBounds, taskOverdue, transition, type IoSide,
} from "@setu/domain";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { notFound } from "./frontdesk.js";
import { closedVisit, inpatientHere, peopleOf, stale } from "./inpatient.js";

const SAMPLE = { bn: "ক্লিনিশিয়ানের অনুমোদন বাকি (নমুনা নিয়ম)", en: "Pending clinician sign-off (sample rule)" };
const requireNurse = (s: SessionData) => { if (s.role !== "nurse") throw err(403, "forbidden", "এই কাজটি নার্সের", "A nurse does this", { reason: "role", canRequest: false }); };
const requireClinician = (s: SessionData) => { if (s.role !== "nurse" && s.role !== "doctor") throw err(403, "forbidden", "এই কাজটি নার্স বা ডাক্তারের", "A nurse or a doctor does this", { reason: "role", canRequest: false }); };
type Io = NonNullable<Awaited<ReturnType<Tx["intakeOutputEntry"]["findFirst"]>>>;
type Task = NonNullable<Awaited<ReturnType<Tx["careTask"]["findFirst"]>>>;
const ioWire = (e: Io, who: Awaited<ReturnType<typeof peopleOf>>): IoEntryView => ({
  id: e.id, side: e.side as IoSide, route: e.route, ml: e.ml, note: e.note, effectiveAt: e.effectiveAt.toISOString(), writtenBy: who(e.writtenById),
  status: e.status === "entered_in_error" ? "entered-in-error" : "active", error: e.errorAt ? { reason: e.errorReason ?? "", by: who(e.errorById), at: e.errorAt.toISOString() } : null,
});
async function ioDayStart(tx: Tx, s: SessionData) {
  return (await tx.organization.findFirst({ where: { id: s.organizationId }, select: { ioDayStartHour: true } }))?.ioDayStartHour ?? 8;
}
/** The last 24 hours' totals per visit (the ward card, the round, the handover). */
export async function io24h(tx: Tx, encounterIds: string[], now: Date): Promise<Map<string, { inMl: number; outMl: number; balanceMl: number }>> {
  const out = new Map<string, { inMl: number; outMl: number; balanceMl: number }>();
  if (!encounterIds.length) return out;
  const rows = await tx.intakeOutputEntry.findMany({ where: { encounterId: { in: encounterIds }, status: "active", effectiveAt: { gt: new Date(now.getTime() - 864e5), lte: now } }, select: { encounterId: true, side: true, ml: true } });
  for (const id of encounterIds) { const mine = rows.filter((r) => r.encounterId === id); if (mine.length) out.set(id, ioTotals(mine.map((r) => ({ side: r.side as IoSide, ml: r.ml })))); }
  return out;
}

export async function ioView(tx: Tx, s: SessionData, encounterId: string, now: Date, dayParam?: string): Promise<IoView> {
  const ip = await inpatientHere(tx, s, encounterId);
  const start = await ioDayStart(tx, s);
  const day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : shiftDay(now, start);
  const { from, to } = shiftDayBounds(day, start);
  const rows = await tx.intakeOutputEntry.findMany({ where: { encounterId: ip.e.id, effectiveAt: { gte: from, lt: to } }, orderBy: { effectiveAt: "desc" } });
  const who = await peopleOf(tx, rows.flatMap((r) => [r.writtenById, r.errorById]));
  const live = rows.filter((r) => r.status === "active").map((r) => ({ side: r.side as IoSide, ml: r.ml }));
  return { encounterId: ip.e.id, day, dayStartHour: start, entries: rows.map((r) => ioWire(r, who)), totals: ioTotals(live), last24h: (await io24h(tx, [ip.e.id], now)).get(ip.e.id) ?? { inMl: 0, outMl: 0, balanceMl: 0 }, sample: SAMPLE };
}
export async function addIo(tx: Tx, s: SessionData, encounterId: string, req: IoEntryRequest, now: Date): Promise<{ entry: IoEntryView; audit: AuditEntry[] }> {
  requireNurse(s);
  const ip = await inpatientHere(tx, s, encounterId);
  if (!ip.open) throw closedVisit();
  const at = new Date(req.effectiveAt);
  // offline entries keep their device time, at most a day old (as vitals)
  if (now.getTime() - at.getTime() > 864e5) throw err(400, "too_old", "২৪ ঘণ্টার বেশি পুরোনো সময় নয়", "Not more than 24 hours ago", { field: "effectiveAt" });
  const b = ioBlockers({ side: req.side, route: req.route, ml: req.ml, at, now });
  if (b.length) throw err(400, b[0]!, "পথ, পরিমাণ (১–৫০০০ মি.লি.) ও সময় ঠিক করুন", "Check the route, the amount (1–5000 mL) and the time", { field: b[0] === "route" ? "route" : b[0] === "ml" ? "ml" : "effectiveAt", fields: b.map((code) => ({ field: code === "future" ? "effectiveAt" : code, code })) });
  const e = await tx.intakeOutputEntry.create({ data: { id: `io_${randomUUID()}`, tenantId: s.tenantId, organizationId: s.organizationId, encounterId: ip.e.id, patientId: ip.e.patientId, side: req.side, route: req.route, ml: req.ml, note: req.note?.trim() || null, effectiveAt: at, writtenById: s.userId, writtenAt: now } });
  return { entry: ioWire(e, await peopleOf(tx, [s.userId])), audit: [{ action: "create", entity: "IntakeOutputEntry", entityId: e.id, patientId: ip.e.patientId, detail: { side: req.side, route: req.route, ml: req.ml } }] };
}
export async function markIoError(tx: Tx, s: SessionData, id: string, reason: string, now: Date): Promise<{ entry: IoEntryView; audit: AuditEntry[] }> {
  requireNurse(s);
  const e = await tx.intakeOutputEntry.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!e) throw notFound();
  if (e.writtenById !== s.userId) throw err(403, "forbidden", "যিনি লিখেছেন শুধু তিনিই ভুল চিহ্নিত করেন", "Only the nurse who wrote it marks it entered-in-error", { reason: "role", canRequest: false });
  if (reason.trim().length < 5) throw err(400, "reason_required", "কারণ লিখুন (অন্তত ৫ অক্ষর)", "Give a reason (at least 5 characters)", { field: "reason" });
  const n = await tx.intakeOutputEntry.updateMany({ where: { id: e.id, status: "active" }, data: { status: "entered_in_error", errorReason: reason.trim(), errorById: s.userId, errorAt: now } });
  if (n.count !== 1) throw stale();
  const after = (await tx.intakeOutputEntry.findFirst({ where: { id: e.id } }))!;
  return { entry: ioWire(after, await peopleOf(tx, [after.writtenById, after.errorById])), audit: [{ action: "update", entity: "IntakeOutputEntry", entityId: e.id, patientId: e.patientId, detail: { event: "markError", reason: reason.trim() } }] };
}

/* ───── care plan tasks ───── */
const taskWire = (t: Task, who: Awaited<ReturnType<typeof peopleOf>>, now: Date): CareTaskView => ({
  id: t.id, seriesId: t.seriesId, text: t.text, everyHours: t.everyHours, dueAt: t.dueAt.toISOString(), status: t.status, overdue: taskOverdue(t, now),
  createdBy: who(t.createdById), createdAt: t.createdAt.toISOString(), completedBy: t.completedById ? who(t.completedById) : null, completedAt: t.completedAt?.toISOString() ?? null,
  cancel: t.cancelledAt ? { by: who(t.cancelledById), at: t.cancelledAt.toISOString(), reason: t.cancelReason ?? "" } : null,
});
export async function taskList(tx: Tx, s: SessionData, encounterId: string, now: Date): Promise<CareTaskList> {
  const ip = await inpatientHere(tx, s, encounterId);
  const open = await tx.careTask.findMany({ where: { encounterId: ip.e.id, status: "requested" }, orderBy: { dueAt: "asc" } });
  const done = await tx.careTask.findMany({ where: { encounterId: ip.e.id, status: { not: "requested" }, OR: [{ completedAt: { gt: new Date(now.getTime() - 864e5) } }, { cancelledAt: { gt: new Date(now.getTime() - 864e5) } }] }, orderBy: { createdAt: "desc" }, take: 50 });
  const who = await peopleOf(tx, [...open, ...done].flatMap((t) => [t.createdById, t.completedById, t.cancelledById]));
  return { open: open.map((t) => taskWire(t, who, now)), done: done.map((t) => taskWire(t, who, now)), graceMin: CARE_TASK_GRACE_MIN_SAMPLE, sample: SAMPLE };
}
/** Open tasks overdue per visit (the ward card). */
export async function overdueTasks(tx: Tx, encounterIds: string[], now: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!encounterIds.length) return out;
  for (const t of await tx.careTask.findMany({ where: { encounterId: { in: encounterIds }, status: "requested", dueAt: { lt: new Date(now.getTime() - CARE_TASK_GRACE_MIN_SAMPLE * 60_000) } }, select: { encounterId: true } }))
    out.set(t.encounterId, (out.get(t.encounterId) ?? 0) + 1);
  return out;
}
export async function createTask(tx: Tx, s: SessionData, encounterId: string, req: CareTaskCreate, now: Date): Promise<{ list: CareTaskList; audit: AuditEntry[] }> {
  requireClinician(s);
  const ip = await inpatientHere(tx, s, encounterId);
  if (!ip.open) throw closedVisit();
  const problems: { field: string; code: string }[] = [];
  if (!careTaskTextOk(req.text)) problems.push({ field: "text", code: "text" });
  if (req.everyHours !== null && (!Number.isInteger(req.everyHours) || req.everyHours < CARE_EVERY_RANGE[0] || req.everyHours > CARE_EVERY_RANGE[1])) problems.push({ field: "everyHours", code: "every" });
  const due = new Date(req.dueAt);
  if (due.getTime() < now.getTime() - 864e5 || due.getTime() > now.getTime() + 7 * 864e5) problems.push({ field: "dueAt", code: "due" });
  if (problems.length) throw err(400, "validation", "কাজ, সময় (প্রতি ১–২৪ ঘণ্টা) ও প্রথম সময় ঠিক করুন", "Check the task, how often (every 1–24 hours) and when it is first due", { field: problems[0]!.field, fields: problems });
  const id = `ct_${randomUUID()}`;
  await tx.careTask.create({ data: { id, seriesId: id, tenantId: s.tenantId, organizationId: s.organizationId, encounterId: ip.e.id, patientId: ip.e.patientId, text: req.text.trim(), everyHours: req.everyHours, dueAt: due, createdById: s.userId, createdAt: now } });
  return { list: await taskList(tx, s, ip.e.id, now), audit: [{ action: "create", entity: "CareTask", entityId: id, patientId: ip.e.patientId, detail: { text: req.text.trim(), everyHours: req.everyHours } }] };
}
async function openTask(tx: Tx, s: SessionData, id: string) {
  const t = await tx.careTask.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!t) throw notFound();
  if (t.status !== "requested") throw err(409, "not_open", "কাজটি আগেই শেষ বা বাতিল", "The task is already done or cancelled");
  return t;
}
export async function completeTask(tx: Tx, s: SessionData, id: string, now: Date): Promise<{ list: CareTaskList; audit: AuditEntry[] }> {
  requireNurse(s);
  const t = await openTask(tx, s, id);
  // the visit is still open (a discharged patient's task is not ticked — review)
  if (!(await inpatientHere(tx, s, t.encounterId)).open) throw closedVisit();
  const to = transition("care-task", CARE_TASK, "requested", "complete");
  const n = await tx.careTask.updateMany({ where: { id: t.id, status: "requested" }, data: { status: to, completedById: s.userId, completedAt: now } });
  if (n.count !== 1) throw stale();
  const next = nextCareDue(now, t.everyHours);
  let nextId: string | null = null;
  if (next) {
    nextId = `ct_${randomUUID()}`;
    await tx.careTask.create({ data: { id: nextId, seriesId: t.seriesId, previousId: t.id, tenantId: t.tenantId, organizationId: t.organizationId, encounterId: t.encounterId, patientId: t.patientId, text: t.text, everyHours: t.everyHours, dueAt: next, createdById: s.userId, createdAt: now } });
  }
  return { list: await taskList(tx, s, t.encounterId, now), audit: [{ action: "update", entity: "CareTask", entityId: t.id, patientId: t.patientId, detail: { event: "complete", overdue: taskOverdue(t, now), next: nextId } }] };
}
export async function cancelTask(tx: Tx, s: SessionData, id: string, reason: string, now: Date): Promise<{ list: CareTaskList; audit: AuditEntry[] }> {
  requireClinician(s);
  const t = await openTask(tx, s, id);
  if (reason.trim().length < 5) throw err(400, "reason_required", "কারণ লিখুন (অন্তত ৫ অক্ষর)", "Give a reason (at least 5 characters)", { field: "reason" });
  const to = transition("care-task", CARE_TASK, "requested", "cancel");
  const n = await tx.careTask.updateMany({ where: { id: t.id, status: "requested" }, data: { status: to, cancelledById: s.userId, cancelledAt: now, cancelReason: reason.trim() } });
  if (n.count !== 1) throw stale();
  return { list: await taskList(tx, s, t.encounterId, now), audit: [{ action: "update", entity: "CareTask", entityId: t.id, patientId: t.patientId, detail: { event: "cancel", reason: reason.trim() } }] };
}
