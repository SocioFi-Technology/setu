/* The shift handover (ADR 0016, slice B5–B6): one per ward per shift (shift starts are a facility setting, sample 08:00,
   14:00, 20:00 Dhaka). The sheet lists every patient on the ward with their latest NEWS2, open escalation, due doses,
   the 24-hour fluid balance and open tasks (live while a draft, frozen in the snapshot when signed) and the outgoing
   nurse's SBAR. HANDOVER: draft → outgoing-signed (every patient reviewed, the outgoing nurse's PIN) → accepted (another
   nurse's PIN; every open escalation on the ward must be named in the note); query → draft with a note. */
import { randomUUID } from "node:crypto";
import type { HandoverPatientUpdate, HandoverPatientView, HandoverView, WardHandover } from "@setu/contracts";
import type { Tx } from "@setu/db";
import { HANDOVER, QUERY_NOTE_MIN, currentShift, handoverAcceptBlockers, handoverSignBlockers, taskOverdue, transition } from "@setu/domain";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { io24h } from "./care.js";
import { notFound } from "./frontdesk.js";
import { peopleOf, stale } from "./inpatient.js";
import { requirePin, requireUserPin } from "./pin.js";
import { wardBoard } from "./ward.js";

const SAMPLE = { bn: "শিফটের সময় নমুনা — ক্লিনিশিয়ানের অনুমোদন বাকি", en: "Shift times are a sample — pending clinician sign-off" };
type H = NonNullable<Awaited<ReturnType<Tx["handover"]["findFirst"]>>>;
const requireNurse = (s: SessionData) => { if (s.role !== "nurse") throw err(403, "forbidden", "হ্যান্ডওভার করেন নার্স", "A nurse hands over", { reason: "role", canRequest: false }); };
const dbStatus = (h: H) => (h.status === "outgoing_signed" ? "outgoing-signed" : h.status) as "draft" | "outgoing-signed" | "accepted";
const toDb = (st: "draft" | "outgoing-signed" | "accepted") => (st === "outgoing-signed" ? "outgoing_signed" : st);

async function shiftNow(tx: Tx, s: SessionData, now: Date) {
  const hours = (await tx.organization.findFirst({ where: { id: s.organizationId }, select: { shiftStartHours: true } }))?.shiftStartHours ?? [8, 14, 20];
  return currentShift(now, hours.length ? hours : [8, 14, 20]);
}
const shiftWire = (x: ReturnType<typeof currentShift>) => ({ day: x.day, startHour: x.startHour, start: x.start.toISOString(), end: x.end.toISOString() });
/** The live picture of every patient on the ward (from the board), with I/O and open tasks. */
async function livePatients(tx: Tx, s: SessionData, wardId: string, now: Date) {
  const { board } = await wardBoard(tx, s, wardId, now);
  const rows = board.beds.filter((b) => b.patient && b.encounterId);
  const ids = rows.map((r) => r.encounterId!);
  const [io, tasks] = await Promise.all([io24h(tx, ids, now), tx.careTask.findMany({ where: { encounterId: { in: ids }, status: "requested" }, orderBy: { dueAt: "asc" } })]);
  return rows.map((r) => ({
    encounterId: r.encounterId!, patient: r.patient!, bed: r.bed.name, news2: r.news2, escalation: r.escalation, doses: r.doses,
    ioBalance24hMl: io.get(r.encounterId!)?.balanceMl ?? null,
    openTasks: tasks.filter((t) => t.encounterId === r.encounterId).map((t) => ({ text: t.text, dueAt: t.dueAt.toISOString(), overdue: taskOverdue(t, now) })),
  }));
}
type Live = Awaited<ReturnType<typeof livePatients>>[number];
type Snap = Live & { leftAt?: string | null };
const snapOf = (r: { snapshot: unknown }) => r.snapshot as Snap;
/** Rows for every patient now on the ward. A patient who left is marked left (reviewed: nothing to hand over) in the
    snapshot — never as text in the SBAR; one who comes back is unmarked and must be reviewed again (review). */
async function syncPatients(tx: Tx, h: H, live: Live[], now: Date) {
  const rows = await tx.handoverPatient.findMany({ where: { handoverId: h.id } });
  for (const p of live) {
    const r = rows.find((x) => x.encounterId === p.encounterId);
    if (!r) await tx.handoverPatient.create({ data: { id: `hp_${randomUUID()}`, tenantId: h.tenantId, handoverId: h.id, encounterId: p.encounterId, patientId: p.patient.id, bed: p.bed, snapshot: p as object } });
    else if (snapOf(r).leftAt) await tx.handoverPatient.update({ where: { id: r.id }, data: { bed: p.bed, reviewed: false, reviewedAt: null, snapshot: p as object } });
    else if (r.bed !== p.bed) await tx.handoverPatient.update({ where: { id: r.id }, data: { bed: p.bed } });
  }
  for (const r of rows.filter((x) => !live.some((p) => p.encounterId === x.encounterId) && !snapOf(x).leftAt))
    await tx.handoverPatient.update({ where: { id: r.id }, data: { reviewed: true, reviewedAt: now, snapshot: { ...snapOf(r), leftAt: now.toISOString() } as object } });
}

async function view(tx: Tx, s: SessionData, h: H, now: Date, liveIn?: Live[]): Promise<HandoverView> {
  const ward = (await tx.location.findFirst({ where: { id: h.wardId }, select: { id: true, name: true } }))!;
  const status = dbStatus(h);
  // one board build per request (review): the caller's live list when it has one
  const live = status === "accepted" ? [] : liveIn ?? await livePatients(tx, s, h.wardId, now);
  const rows = await tx.handoverPatient.findMany({ where: { handoverId: h.id }, orderBy: { bed: "asc" } });
  const who = await peopleOf(tx, [h.outgoingId, h.incomingId, h.queriedById]);
  const patients: HandoverPatientView[] = rows.map((r) => {
    const l = live.find((x) => x.encounterId === r.encounterId);
    // a draft shows the live picture; a signed sheet shows what was handed over (the snapshot frozen at signing)
    const snap = status === "draft" ? (l ?? snapOf(r)) : snapOf(r);
    return {
      encounterId: r.encounterId, patient: snap.patient, bed: r.bed, onWard: status === "draft" ? Boolean(l) : !snapOf(r).leftAt,
      news2: snap.news2 ?? null, escalation: snap.escalation ?? null, doses: snap.doses ?? { due: 0, overdue: 0 }, ioBalance24hMl: snap.ioBalance24hMl ?? null, openTasks: snap.openTasks ?? [],
      sbar: { s: r.situation, b: r.background, a: r.assessment, r: r.recommendation }, reviewed: r.reviewed,
    };
  });
  // a draft also shows patients who arrived since it was opened: on the sheet as soon as the nurse touches them (review)
  if (status === "draft") for (const l of live.filter((x) => !rows.some((r) => r.encounterId === x.encounterId)))
    patients.push({ encounterId: l.encounterId, patient: l.patient, bed: l.bed, onWard: true, news2: l.news2, escalation: l.escalation, doses: l.doses, ioBalance24hMl: l.ioBalance24hMl, openTasks: l.openTasks, sbar: { s: "", b: "", a: "", r: "" }, reviewed: false });
  // the acceptance rule looks at the ward now, whatever the sheet says
  // every open escalation on the ward now (acknowledged or not, however recent — Kamrul, 06/10/2026)
  const openEscalations = live.filter((p) => p.escalation && p.escalation.status !== "resolved").map((p) => ({ bed: p.bed, facilityNo: p.patient.facilityNo, name: p.patient.nameEn || p.patient.nameBn, peakScore: p.escalation!.peakScore, unacknowledged: p.escalation!.unacknowledged }));
  const start = currentShift(new Date(Date.parse(`${h.shiftDay}T00:00:00Z`) - 6 * 3600_000 + h.shiftStartHour * 3600_000 + 60_000), [h.shiftStartHour, ...((await tx.organization.findFirst({ where: { id: h.organizationId }, select: { shiftStartHours: true } }))?.shiftStartHours ?? [])]);
  return {
    id: h.id, ward, shift: shiftWire(start), status, rev: h.rev, outgoing: who(h.outgoingId), signedAt: h.signedAt?.toISOString() ?? null,
    incoming: h.incomingId ? who(h.incomingId) : null, acceptedAt: h.acceptedAt?.toISOString() ?? null, acceptNote: h.acceptNote,
    query: h.queriedAt ? { note: h.queryNote ?? "", by: who(h.queriedById), at: h.queriedAt.toISOString() } : null,
    patients, openEscalations, signBlockers: status === "draft" ? handoverSignBlockers({ patients }) : [], sample: SAMPLE,
  };
}
async function wardOf(tx: Tx, s: SessionData, wardId: string) {
  const w = await tx.location.findFirst({ where: { id: wardId, organizationId: s.organizationId, kind: "ward" } });
  if (!w) throw notFound();
  return w;
}
/** The ward's handover in hand: one signed and waiting for acceptance, whatever shift it was opened in (signed at 13:50,
    accepted at 14:05 — review), else this shift's. A draft never signed in an earlier shift is left behind (its nurse
    has gone; the new shift starts its own). */
async function inHand(tx: Tx, s: SessionData, wardId: string, sh: { day: string; startHour: number }) {
  return (await tx.handover.findFirst({ where: { organizationId: s.organizationId, wardId, status: "outgoing_signed" }, orderBy: { createdAt: "desc" } }))
    ?? (await tx.handover.findFirst({ where: { organizationId: s.organizationId, wardId, shiftDay: sh.day, shiftStartHour: sh.startHour } }));
}
export async function wardHandover(tx: Tx, s: SessionData, wardId: string, now: Date): Promise<WardHandover> {
  await wardOf(tx, s, wardId);
  const sh = await shiftNow(tx, s, now);
  const h = await inHand(tx, s, wardId, sh);
  const last = await tx.handover.findFirst({ where: { organizationId: s.organizationId, wardId, status: "accepted" }, orderBy: { acceptedAt: "desc" } });
  const who = await peopleOf(tx, [last?.incomingId]);
  return { handover: h ? await view(tx, s, h, now) : null, shift: shiftWire(sh), onDuty: last?.incomingId && last.acceptedAt ? { nurse: who(last.incomingId), since: last.acceptedAt.toISOString() } : null };
}
/** The outgoing nurse opens this shift's handover (one per ward per shift; opening again returns it). */
export async function openHandover(tx: Tx, s: SessionData, wardId: string, now: Date): Promise<{ view: HandoverView; audit: AuditEntry[] }> {
  requireNurse(s);
  await wardOf(tx, s, wardId);
  const sh = await shiftNow(tx, s, now);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7016, hashtext(${`${s.organizationId}:${wardId}`}))`;
  // an earlier handover not yet accepted is the one to finish — never a second sheet beside it
  let h = await inHand(tx, s, wardId, sh);
  const audit: AuditEntry[] = [];
  if (!h) {
    h = await tx.handover.create({ data: { id: `ho_${randomUUID()}`, tenantId: s.tenantId, organizationId: s.organizationId, wardId, shiftDay: sh.day, shiftStartHour: sh.startHour, outgoingId: s.userId, createdAt: now } });
    audit.push({ action: "create", entity: "Handover", entityId: h.id, detail: { wardId, shift: `${sh.day} ${sh.startHour}:00` } });
  }
  const live = await livePatients(tx, s, wardId, now);
  if (dbStatus(h) === "draft") await syncPatients(tx, h, live, now);
  return { view: await view(tx, s, h, now, live), audit };
}
async function handoverHere(tx: Tx, s: SessionData, id: string) {
  const h = await tx.handover.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!h) throw notFound();
  return h;
}
async function bump(tx: Tx, h: H, data: Record<string, unknown>) {
  const n = await tx.handover.updateMany({ where: { id: h.id, rev: h.rev, status: h.status }, data: { ...data, rev: h.rev + 1 } });
  if (n.count !== 1) throw stale();
  return (await tx.handover.findFirst({ where: { id: h.id } }))!;
}
export async function updateHandoverPatient(tx: Tx, s: SessionData, id: string, encounterId: string, req: HandoverPatientUpdate, now: Date): Promise<{ view: HandoverView; audit: AuditEntry[] }> {
  requireNurse(s);
  let h = await handoverHere(tx, s, id);
  if (dbStatus(h) !== "draft") throw err(409, "not_draft", "স্বাক্ষরিত হ্যান্ডওভার বদলানো যায় না", "A signed handover cannot be changed");
  if (h.outgoingId !== s.userId) throw err(403, "forbidden", "যিনি হ্যান্ডওভার দিচ্ছেন তিনিই লিখবেন", "The outgoing nurse writes the handover", { reason: "role", canRequest: false });
  if (req.rev !== h.rev) throw stale();
  // a patient who arrived since the sheet opened joins it now (committed with this save)
  const live = await livePatients(tx, s, h.wardId, now);
  await syncPatients(tx, h, live, now);
  const r = await tx.handoverPatient.findFirst({ where: { handoverId: h.id, encounterId } });
  if (!r) throw notFound();
  await tx.handoverPatient.update({ where: { id: r.id }, data: {
    ...(req.sbar ? { situation: req.sbar.s, background: req.sbar.b, assessment: req.sbar.a, recommendation: req.sbar.r } : {}),
    ...(req.reviewed !== undefined ? { reviewed: req.reviewed, reviewedAt: req.reviewed ? now : null } : {}),
  } });
  h = await bump(tx, h, {});
  return { view: await view(tx, s, h, now, live), audit: [{ action: "update", entity: "Handover", entityId: h.id, patientId: r.patientId, detail: { encounterId, sbar: Boolean(req.sbar), reviewed: req.reviewed ?? null } }] };
}
async function pinOk(tx: Tx, s: SessionData, pin: string) {
  await requireUserPin(tx, s.userId, pin);
}
export async function signHandover(tx: Tx, s: SessionData, id: string, body: { rev: number; pin: string }, now: Date): Promise<{ view: HandoverView; audit: AuditEntry[] }> {
  requireNurse(s);
  let h = await handoverHere(tx, s, id);
  if (h.outgoingId !== s.userId) throw err(403, "forbidden", "যিনি হ্যান্ডওভার দিচ্ছেন তিনিই স্বাক্ষর করেন", "The outgoing nurse signs the handover", { reason: "role", canRequest: false });
  if (body.rev !== h.rev) throw stale();
  const to = transition("handover", HANDOVER, dbStatus(h), "sign");
  // a patient admitted since the last save joins the sheet now — and must be reviewed before signing
  const live = await livePatients(tx, s, h.wardId, now);
  await syncPatients(tx, h, live, now);
  const rows = await tx.handoverPatient.findMany({ where: { handoverId: h.id } });
  if (handoverSignBlockers({ patients: rows }).length) throw err(422, "not_all_reviewed", "সব রোগী দেখা হয়নি — স্বাক্ষর হয়নি", "Not every patient is reviewed — not signed", { blockers: [{ code: "not_all_reviewed" }] });
  await pinOk(tx, s, body.pin);
  // freeze what was handed over
  for (const r of rows) { const l = live.find((x) => x.encounterId === r.encounterId); if (l) await tx.handoverPatient.update({ where: { id: r.id }, data: { snapshot: l as object } }); }
  h = await bump(tx, h, { status: toDb(to), signedAt: now });
  return { view: await view(tx, s, h, now, live), audit: [{ action: "sign", entity: "Handover", entityId: h.id, detail: { patients: rows.length } }] };
}
export async function acceptHandover(tx: Tx, s: SessionData, id: string, body: { rev: number; pin: string; note: string }, now: Date): Promise<{ view: HandoverView; audit: AuditEntry[] }> {
  requireNurse(s);
  let h = await handoverHere(tx, s, id);
  if (body.rev !== h.rev) throw stale();
  const to = transition("handover", HANDOVER, dbStatus(h), "accept");
  const live = await livePatients(tx, s, h.wardId, now);
  // a patient who arrived after signing is not on the sheet: the sheet goes back (query) before anyone takes the ward
  const onSheet = new Set((await tx.handoverPatient.findMany({ where: { handoverId: h.id }, select: { encounterId: true } })).map((r) => r.encounterId));
  const missing = live.filter((p) => !onSheet.has(p.encounterId));
  if (missing.length) throw err(409, "sheet_outdated", `হস্তান্তরের পর নতুন রোগী: ${missing.map((p) => p.bed).join(", ")} — প্রশ্ন করে খসড়ায় ফেরত দিন`, `New patient(s) since it was signed: ${missing.map((p) => p.bed).join(", ")} — query it back to the outgoing nurse`, { blockers: missing.map((p) => ({ code: "not_on_sheet", bed: p.bed })) as unknown as Record<string, unknown>[] });
  const unack = live.filter((p) => p.escalation && p.escalation.status !== "resolved").map((p) => ({ bed: p.bed, facilityNo: p.patient.facilityNo }));
  const b = handoverAcceptBlockers({ outgoingId: h.outgoingId, incomingId: s.userId, note: body.note, open: unack });
  if (b.includes("same_nurse")) throw err(403, "same_nurse", "নিজের হ্যান্ডওভার নিজে গ্রহণ করা যায় না", "You cannot accept your own handover", { reason: "role", canRequest: false });
  if (b.includes("escalation_not_named")) throw err(422, "escalation_not_named", `চলমান এস্কেলেশন: ${unack.map((u) => u.bed).join(", ")} — গ্রহণের নোটে প্রতিটির নাম লিখুন`, `Open escalation(s): ${unack.map((u) => u.bed).join(", ")} — name each in the acceptance note`, { field: "note", blockers: unack.map((u) => ({ code: "escalation_not_named", bed: u.bed, facilityNo: u.facilityNo })) as unknown as Record<string, unknown>[] });
  await pinOk(tx, s, body.pin);
  h = await bump(tx, h, { status: toDb(to), incomingId: s.userId, acceptedAt: now, acceptNote: body.note.trim() || null });
  return { view: await view(tx, s, h, now, live), audit: [{ action: "update", entity: "Handover", entityId: h.id, detail: { event: "accept", escalationsNamed: unack.map((u) => u.bed) } }] };
}
export async function queryHandover(tx: Tx, s: SessionData, id: string, body: { rev: number; note: string }, now: Date): Promise<{ view: HandoverView; audit: AuditEntry[] }> {
  requireNurse(s);
  let h = await handoverHere(tx, s, id);
  if (body.rev !== h.rev) throw stale();
  if (h.outgoingId === s.userId) throw err(403, "forbidden", "গ্রহণকারী নার্স প্রশ্ন করেন", "The incoming nurse queries the handover", { reason: "role", canRequest: false });
  if (body.note.trim().length < QUERY_NOTE_MIN) throw err(400, "note_required", "প্রশ্নটি লিখুন (অন্তত ৫ অক্ষর)", "Write the query (at least 5 characters)", { field: "note" });
  const to = transition("handover", HANDOVER, dbStatus(h), "query");
  h = await bump(tx, h, { status: toDb(to), queryNote: body.note.trim(), queriedById: s.userId, queriedAt: now, signedAt: null });
  return { view: await view(tx, s, h, now), audit: [{ action: "update", entity: "Handover", entityId: h.id, detail: { event: "query", note: body.note.trim() } }] };
}
