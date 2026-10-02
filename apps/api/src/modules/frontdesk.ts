/* Front desk service (slice A1–A3). Every function runs inside a command()/query() transaction, so RLS scopes it to
   the session's tenant. State changes go through @setu/domain: ENCOUNTER for visits, APPROVAL for review Tasks. */
import type { MatchCandidate, PatientSummary, PreviewCandidate, QueueItem, RegistrationInput } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  APPROVAL, ENCOUNTER, LINK_REASON_MIN, canLinkDirectly, columnOf, compareRecords, dhakaDay, format, formatToken, frontDeskActions, isCandidate, linkAnywayAllowed, linkBlocked,
  normalizePhone, parseDob, tokenSequenceName, transition, undoReasonOk, undoRule, type DeskActivity, type EncounterState, type MatchRecord,
} from "@setu/domain";
import type { SessionData } from "../plugins/session.js";
import { err } from "../errors.js";

/* ───── enum spelling: Prisma identifiers use _ where the domain uses - ───── */
const dash = <T extends string>(s: string) => s.replace(/_/g, "-") as T;
const under = <T extends string>(s: string) => s.replace(/-/g, "_") as T;
type DbEncounterStatus = "planned" | "arrived" | "triaged" | "in_progress" | "finished" | "cancelled" | "entered_in_error";
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const isoDay = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const digitsOnly = (s: string | null | undefined) => format.toEn(s ?? "").replace(/\D/g, "");

export const notFound = () => err(404, "not_found", "পাওয়া যায়নি", "Not found");

/* ───── patient summaries ───── */
const patientInclude = {
  relatedPersons: { orderBy: { id: "asc" as const }, take: 1 },
  encounters: { orderBy: { createdAt: "desc" as const }, take: 1, select: { createdAt: true } },
};
type PatientRow = NonNullable<Awaited<ReturnType<Tx["patient"]["findFirst"]>>> & {
  relatedPersons: { nameBn: string; relationship: string }[]; encounters: { createdAt: Date }[];
};

export const toSummary = (p: PatientRow): PatientSummary => ({
  id: p.id, facilityNo: p.facilityNo, nameBn: p.nameBn, nameEn: p.nameEn, sex: p.sex,
  birthDate: isoDay(p.birthDate), approxAgeYears: p.approxAgeYears, approxAgeMonths: p.approxAgeMonths, approxAgeAt: iso(p.approxAgeAt),
  phone: p.phone && /^1[3-9]\d{8}$/.test(p.phone) ? p.phone : normalizePhone(p.phone),
  phoneOwner: p.phoneOwner,
  guardian: p.relatedPersons[0] ? { name: p.relatedPersons[0].nameBn, relationship: p.relatedPersons[0].relationship } : null,
  address: { division: p.division, district: p.district, upazila: p.upazila, line: p.addressLine },
  hasNid: Boolean(p.nid || p.birthRegNo),
  identityConfidence: dash(p.identityConfidence),
  linkedToId: p.linkedToId,
  lastVisitAt: iso(p.encounters[0]?.createdAt),
});

export async function getPatient(tx: Tx, id: string): Promise<PatientRow> {
  const p = await tx.patient.findFirst({ where: { id }, include: patientInclude });
  if (!p) throw notFound();
  return p as PatientRow;
}

const toMatchRecord = (p: PatientRow): MatchRecord => ({
  nameBn: p.nameBn, nameEn: p.nameEn, sex: p.sex, birthDate: isoDay(p.birthDate), approxAgeYears: p.approxAgeYears, approxAgeAt: iso(p.approxAgeAt),
  guardianName: p.relatedPersons[0]?.nameBn ?? null, phone: normalizePhone(p.phone), district: p.district, upazila: p.upazila, nid: p.nid, birthRegNo: p.birthRegNo,
});
export const draftToMatchRecord = (i: RegistrationInput, now: Date): MatchRecord => ({
  nameBn: i.nameBn.trim(), nameEn: i.nameEn?.trim() || null, sex: i.sex ?? null,
  birthDate: i.dobMode === "dob" ? parseDob(i.dob) : null,
  approxAgeYears: i.dobMode === "age" && digitsOnly(i.ageYears) ? Number(digitsOnly(i.ageYears)) : null, approxAgeAt: now.toISOString(),
  guardianName: i.guardian?.name?.trim() || null, phone: normalizePhone(i.phone), district: i.district ?? null, upazila: i.upazila ?? null,
  nid: i.idType === "nid" ? digitsOnly(i.idNo) || null : null, birthRegNo: i.idType === "brn" ? digitsOnly(i.idNo) || null : null,
});

/* ───── search (A1) ───── */
export type Mode = "patientNo" | "phone" | "bn" | "en";
export function searchMode(q: string): { mode: Mode; term: string } {
  const t = format.toEn(q).trim();
  // Facility prefixes are 2–5 characters starting with a letter (GLC, MGH, E2E), then "-" and digits.
  if (/^[a-z][a-z0-9]{1,4}-\d*$/i.test(t)) return { mode: "patientNo", term: t.toUpperCase() };
  if (/^[+0-9\s-]{3,}$/.test(t) && t.replace(/\D/g, "").length >= 3) return { mode: "phone", term: t.replace(/\D/g, "").replace(/^880/, "").replace(/^0/, "") };
  if (/[ঀ-৿]/.test(q)) return { mode: "bn", term: q.trim().replace(/\s+/g, " ") };
  return { mode: "en", term: t.replace(/\s+/g, " ") };
}

export async function searchPatients(tx: Tx, q: string) {
  const { mode, term } = searchMode(q);
  const where =
    mode === "patientNo" ? { facilityNo: { contains: term, mode: "insensitive" as const } }
    : mode === "phone" ? { phone: { contains: term } }
    : mode === "bn" ? { nameBn: { contains: term } }
    : { nameEn: { contains: term, mode: "insensitive" as const } };
  const rows = (await tx.patient.findMany({ where: { ...where, linkedToId: null }, include: patientInclude, orderBy: [{ nameBn: "asc" }], take: 20 })) as PatientRow[];
  // An exact patient number (or exact phone) comes first, so Enter on "GLC-12" never picks GLC-120 (clinical review).
  const exact = (p: PatientRow) => (mode === "patientNo" ? p.facilityNo.toUpperCase() === term : mode === "phone" ? normalizePhone(p.phone) === term : false);
  const items = [...rows.filter(exact), ...rows.filter((p) => !exact(p))].map(toSummary);
  const phones = new Set(items.map((i) => i.phone));
  const sharedPhone = mode === "phone" && items.length > 1 && phones.size === 1 && items[0]!.phone ? { phone: items[0]!.phone, count: items.length } : null;
  return { mode, items, sharedPhone };
}

/* ───── possible matches (A2) ───── */
export async function findCandidates(tx: Tx, subject: MatchRecord, excludeId: string | null, now: Date): Promise<MatchCandidate[]> {
  const first = (s?: string | null) => (s ?? "").trim().split(/\s+/).find((w) => w.length > 2 && !/^(md|mst|মো|মোঃ)\.?$/i.test(w));
  const base = { linkedToId: null, ...(excludeId ? { id: { not: excludeId } } : {}) };
  // Exact phone / ID matches first and always; name look-alikes after, so a common name can never crowd out the
  // record that shares this person's phone or NID (walkthrough: many patients share a first name).
  const exact: object[] = [];
  if (subject.phone) exact.push({ phone: { in: [subject.phone, "0" + subject.phone] } });
  if (subject.nid) exact.push({ nid: subject.nid });
  if (subject.birthRegNo) exact.push({ birthRegNo: subject.birthRegNo });
  const fuzzy: object[] = [];
  const fb = first(subject.nameBn), fe = first(subject.nameEn);
  if (fb) fuzzy.push({ nameBn: { contains: fb } });
  if (fe) fuzzy.push({ nameEn: { contains: fe, mode: "insensitive" } });
  if (!exact.length && !fuzzy.length) return [];
  const byExact = exact.length ? ((await tx.patient.findMany({ where: { ...base, OR: exact }, include: patientInclude, take: 50 })) as PatientRow[]) : [];
  const byName = fuzzy.length ? ((await tx.patient.findMany({ where: { ...base, OR: fuzzy, id: { notIn: [...byExact.map((p) => p.id), ...(excludeId ? [excludeId] : [])] } }, include: patientInclude, orderBy: { createdAt: "desc" }, take: 50 })) as PatientRow[]) : [];
  const rows = [...byExact, ...byName];
  return rows
    .map((p) => ({ p, c: compareRecords(subject, toMatchRecord(p), now) }))
    .filter(({ c }) => isCandidate(c))
    .sort((a, b) => b.c.score - a.c.score || a.c.conflicts.length - b.c.conflicts.length)
    .slice(0, 3)
    .map(({ p, c }) => ({ patient: toSummary(p), comparison: c, canLink: canLinkDirectly(c), canLinkAnyway: !linkBlocked(c) && !canLinkDirectly(c) }));
}

/** Age in whole years now from a summary (exact birth date, or an approximate age aged forward). */
function ageNow(p: PatientSummary, now: Date): { years: number | null; approx: boolean } {
  if (p.birthDate) {
    const [y, m, d] = p.birthDate.split("-").map(Number) as [number, number, number];
    let a = now.getUTCFullYear() - y;
    if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) a--;
    return { years: a, approx: false };
  }
  if (p.approxAgeYears != null) {
    const extra = p.approxAgeAt ? Math.floor((now.getTime() - Date.parse(p.approxAgeAt)) / (365.25 * 864e5)) : 0;
    return { years: p.approxAgeYears + Math.max(0, extra), approx: true };
  }
  return { years: null, approx: false };
}
/** The register screen's view of a candidate: name, patient no., age and sex only (open question 19). */
export const toPreviewCandidate = (c: MatchCandidate, now: Date): PreviewCandidate => {
  const a = ageNow(c.patient, now);
  return {
    patient: { id: c.patient.id, facilityNo: c.patient.facilityNo, nameBn: c.patient.nameBn, nameEn: c.patient.nameEn, sex: c.patient.sex, ageYears: a.years, ageApprox: a.approx },
    score: c.comparison.score, strong: c.comparison.strong, conflictCount: c.comparison.conflicts.length, isGuardian: c.comparison.isGuardian, canLink: c.canLink,
  };
};

export async function patientMatches(tx: Tx, s: SessionData, id: string, now: Date) {
  const p = await getPatient(tx, id);
  const candidates = await findCandidates(tx, toMatchRecord(p), p.id, now);
  const open = await tx.task.findFirst({ where: { kind: REVIEW, focusId: p.id, status: "requested" }, orderBy: { requestedAt: "desc" } });
  const linkedTo = p.linkedToId ? toSummary(await getPatient(tx, p.linkedToId)) : null;
  const { view } = await lastDecision(tx, s, p.id);
  return { subject: toSummary(p), linkedTo, candidates, openReview: open ? { taskId: open.id, candidateId: open.candidateId } : null, lastDecision: view };
}

/* ───── decisions: link / link anyway / review / different / undo ───── */
const REVIEW = "patient-link-review";
const DECISION_ACTIVITIES = ["link", "link-anyway", "review-requested", "checked-different"];
/* An admin unlink or review closes the desk's decision: Undo must not reach back past it. */
const BARRIERS = ["undo", "unlink", "link-reviewed"];
type Decision = "link" | "linkAnyway" | "review" | "different";

export async function decide(tx: Tx, s: SessionData, subjectId: string, decision: Decision, candidateId: string | undefined, reasonRaw: string | undefined, now: Date) {
  const subject = await getPatient(tx, subjectId);
  if (subject.linkedToId) throw err(409, "already_linked", "এই রেকর্ড আগেই লিংক করা হয়েছে", "This record is already linked to another");
  const reason = reasonRaw?.trim() || null;
  const previous = { identityConfidence: subject.identityConfidence, linkedToId: subject.linkedToId };
  const prov = (activity: string, detail: object) => tx.provenance.create({ data: {
    tenantId: s.tenantId, targetType: "Patient", targetId: subject.id, activity, agentId: s.userId, onBehalfOf: s.organizationId,
    source: "desk_decision", reason, detail: { previous, ...detail } as object,
  } });

  if (decision === "different") {
    const hasOpen = await tx.task.count({ where: { kind: REVIEW, focusId: subject.id, status: "requested" } });
    const next = subject.identityConfidence === "possible_duplicate" && !hasOpen ? "unverified" : subject.identityConfidence;
    await tx.patient.update({ where: { id: subject.id }, data: { identityConfidence: next } });
    // Every candidate on screen was checked and found different, not just the first one.
    const checked = candidateId ? [candidateId] : (await findCandidates(tx, toMatchRecord(subject), subject.id, now)).map((c) => c.patient.id);
    await prov("checked-different", { candidateIds: checked });
    return { subject: await getPatient(tx, subject.id), continueWith: null, taskId: null, conflicts: [] as string[] };
  }

  if (!candidateId) throw err(400, "candidate_required", "কোন রেকর্ডের সাথে, তা বাছুন", "Choose the record to compare with", { field: "candidateId" });
  const candidate = await getPatient(tx, candidateId);
  if (candidate.id === subject.id || candidate.linkedToId) throw err(409, "candidate_unavailable", "এই রেকর্ডটি বাছা যাবে না", "That record cannot be chosen");
  const c = compareRecords(toMatchRecord(subject), toMatchRecord(candidate), now);

  if (decision === "review") {
    if (await tx.task.count({ where: { kind: REVIEW, focusId: subject.id, status: "requested" } }))
      throw err(409, "review_open", "রিভিউ আগেই পাঠানো হয়েছে", "A review is already open for this record");
    const task = await tx.task.create({ data: { tenantId: s.tenantId, kind: REVIEW, status: "requested", focusId: subject.id, candidateId: candidate.id, reason, detail: { conflicts: c.conflicts, fields: c.fields }, requestedById: s.userId } });
    await tx.patient.update({ where: { id: subject.id }, data: { identityConfidence: "possible_duplicate" } });
    await prov("review-requested", { candidateId: candidate.id, taskId: task.id, conflicts: c.conflicts });
    return { subject: await getPatient(tx, subject.id), continueWith: null, taskId: task.id, conflicts: c.conflicts };
  }

  if (c.isGuardian) throw err(409, "link_blocked_guardian", "অভিভাবকের রেকর্ডের সাথে লিংক করা যাবে না", "Cannot link to the guardian's record: choose \"Different person\"");
  if (linkBlocked(c)) throw err(409, "link_blocked_sex", "লিঙ্গ মেলেনি — লিংক করা যাবে না", "Sex does not match: these cannot be linked");
  if (decision === "link") {
    // Walkthrough issue #4: never a one-click link when any field conflicts.
    if (!canLinkDirectly(c)) throw c.conflicts.length
      ? err(409, "link_has_conflicts", `${format.toBn(c.conflicts.length)}টি অমিল তথ্য — রিভিউতে পাঠান বা কারণসহ লিংক করুন`, `${c.conflicts.length} conflicting field(s): send for review or link with a reason`, { fields: c.conflicts.map((f) => ({ field: f, code: "different" })) })
      : err(409, "link_not_strong", "এক ক্লিকে লিংকের মতো যথেষ্ট মিল নেই — রিভিউতে পাঠান বা কারণসহ লিংক করুন", "Not enough evidence for a one-click link: send for review or link with a reason");
    await tx.patient.update({ where: { id: subject.id }, data: { linkedToId: candidate.id } });
    await prov("link", { candidateId: candidate.id });
    return { subject: await getPatient(tx, subject.id), continueWith: candidate, taskId: null, conflicts: [] as string[] };
  }

  // linkAnyway: conflicts, a reason of ≥10 characters, a review Task created and approved in this transaction.
  if (canLinkDirectly(c)) throw err(409, "no_conflicts", "সব মিলেছে — সাধারণ লিংক ব্যবহার করুন", "This is a clean strong match: use the normal link");
  if (!linkAnywayAllowed(c, reason)) throw err(400, "reason_too_short", "কমপক্ষে ১০ অক্ষরের কারণ লিখুন", "Give a reason of at least 10 characters", { field: "reason", fields: [{ field: "reason", code: "reason_too_short" }] });
  const status = transition("approval", APPROVAL, "requested", "approve");
  const task = await tx.task.create({ data: {
    tenantId: s.tenantId, kind: REVIEW, status, focusId: subject.id, candidateId: candidate.id, reason, detail: { conflicts: c.conflicts, fields: c.fields },
    requestedById: s.userId, decidedById: s.userId, decidedAt: now, decisionNote: "link-anyway",
  } });
  // Withdraw any open review on this record: the link-anyway decision replaces it.
  for (const t of await tx.task.findMany({ where: { kind: REVIEW, focusId: subject.id, status: "requested" } }))
    await tx.task.update({ where: { id: t.id }, data: { status: transition("approval", APPROVAL, "requested", "reject"), decidedById: s.userId, decidedAt: now, decisionNote: "superseded by link-anyway" } });
  await tx.patient.update({ where: { id: subject.id }, data: { linkedToId: candidate.id, identityConfidence: "possible_duplicate" } });
  await prov("link-anyway", { candidateId: candidate.id, taskId: task.id, conflicts: c.conflicts });
  return { subject: await getPatient(tx, subject.id), continueWith: candidate, taskId: task.id, conflicts: c.conflicts };
}

/** The last desk decision on a record that Undo would reverse, who made it, whether this user may undo it, and the
    visits opened on the linked record since (open question 17). Null when there is nothing to undo. */
export async function lastDecision(tx: Tx, s: SessionData, subjectId: string) {
  const subject = await getPatient(tx, subjectId);
  const last = await tx.provenance.findFirst({ where: { targetType: "Patient", targetId: subject.id, activity: { in: [...DECISION_ACTIVITIES, ...BARRIERS] } }, orderBy: { recorded: "desc" } });
  if (!last || BARRIERS.includes(last.activity) || !(last.detail as { previous?: unknown } | null)?.previous) return { subject, last: null, view: null };
  const activity = last.activity as DeskActivity;
  const rule = undoRule(activity, last.agentId, s.userId, s.role);
  const by = await tx.user.findFirst({ where: { id: last.agentId }, select: { id: true, nameBn: true, nameEn: true } });
  const target = (last.detail as { candidateId?: string }).candidateId;
  // Only to someone who may undo, and only this facility's visits (security review M2).
  const visits = rule.allowed && rule.warnsVisits && target
    ? await tx.encounter.findMany({ where: { patientId: target, organizationId: s.organizationId, createdAt: { gte: last.recorded } }, orderBy: { createdAt: "asc" }, take: 20 })
    : [];
  return {
    subject, last,
    view: {
      activity, at: last.recorded.toISOString(), by: by ?? null, canUndo: rule.allowed, reasonRequired: rule.reasonRequired, reasonMin: LINK_REASON_MIN,
      visitsSince: visits.map((e) => ({ encounterId: e.id, token: e.token, day: e.tokenDay, status: dash<EncounterState>(e.status) })),
    },
  };
}

export async function undoDecision(tx: Tx, s: SessionData, subjectId: string, reasonRaw: string | undefined, now: Date) {
  const { subject, last, view } = await lastDecision(tx, s, subjectId);
  if (!last || !view) throw err(409, "nothing_to_undo", "ফিরিয়ে নেওয়ার মতো কিছু নেই", "There is no decision to undo");
  if (!view.canUndo) throw err(403, "not_decider", "যিনি সিদ্ধান্ত নিয়েছেন তিনি বা অ্যাডমিন ফিরিয়ে নিতে পারবেন", "Only the person who made this decision, or an admin, can undo it", { reason: "role", canRequest: false });
  const reason = reasonRaw?.trim() || null;
  if (!undoReasonOk(view.activity, reason))
    throw err(400, "reason_too_short", "কমপক্ষে ১০ অক্ষরের কারণ লিখুন", "Give a reason of at least 10 characters", { field: "reason", fields: [{ field: "reason", code: "reason_too_short" }] });
  const d = last.detail as { previous: { identityConfidence: typeof subject.identityConfidence; linkedToId: string | null }; taskId?: string };
  // Check-and-set: only if nobody changed the record since we read the decision (security review L3).
  const n = await tx.patient.updateMany({ where: { id: subject.id, identityConfidence: subject.identityConfidence, linkedToId: subject.linkedToId }, data: { identityConfidence: d.previous.identityConfidence, linkedToId: d.previous.linkedToId } });
  if (n.count !== 1) throw err(409, "stale", "অন্য কেউ আগেই বদলেছেন — আবার দেখুন", "Someone else changed this record first — refresh");
  if (d.taskId) {
    const t = await tx.task.findFirst({ where: { id: d.taskId } });
    if (t?.status === "requested")
      await tx.task.update({ where: { id: t.id }, data: { status: transition("approval", APPROVAL, "requested", "reject"), decidedById: s.userId, decidedAt: now, decisionNote: "withdrawn" } });
    // An approved link-anyway Task stays approved (APPROVAL has no way back); this undo row records the unlink.
  }
  // Visits opened on the linked record in between stay where they are (open question 17); the undo records them.
  const visitsSince = view.visitsSince.map((v) => v.encounterId);
  await tx.provenance.create({ data: {
    tenantId: s.tenantId, targetType: "Patient", targetId: subject.id, activity: "undo", agentId: s.userId, onBehalfOf: s.organizationId,
    source: "desk_decision", reason, detail: { undoes: last.id, undoneActivity: last.activity, restored: d.previous, decidedBy: last.agentId, visitsSince } as object,
  } });
  return { subject: await getPatient(tx, subject.id), undone: last.activity, reason, visitsSince };
}

/* ───── registration (A3) ───── */
export async function registerPatient(tx: Tx, s: SessionData, i: RegistrationInput, now: Date) {
  const tenant = await tx.tenant.findFirst({ where: { id: s.tenantId } });
  if (!tenant) throw notFound();
  const seq = await tx.sequence.upsert({ where: { tenantId_name: { tenantId: s.tenantId, name: "patient" } }, create: { tenantId: s.tenantId, name: "patient", value: 1 }, update: { value: { increment: 1 } } });
  const dob = i.dobMode === "dob" ? parseDob(i.dob) : null;
  const years = i.dobMode === "age" ? Number(digitsOnly(i.ageYears)) : null;
  const months = i.dobMode === "age" && digitsOnly(i.ageMonths) ? Number(digitsOnly(i.ageMonths)) : null;
  const idDigits = digitsOnly(i.idNo) || null;
  // Registered although a strong match exists (offline, or the desk chose to): flag it for review, never silently.
  const strong = (await findCandidates(tx, draftToMatchRecord(i, now), null, now)).some((c) => c.comparison.strong || c.canLink);
  const p = await tx.patient.create({ data: {
    tenantId: s.tenantId, facilityNo: `${tenant.patientNoPrefix}-${seq.value}`,
    nameBn: i.nameBn.trim(), nameEn: i.nameEn?.trim() || null, sex: i.sex!,
    birthDate: dob ? new Date(dob + "T00:00:00Z") : null, approxAgeYears: years, approxAgeMonths: months, approxAgeAt: years !== null ? now : null,
    phone: normalizePhone(i.phone), phoneOwner: i.phoneOwner ?? null,
    division: i.division ?? null, district: i.district ?? null, upazila: i.upazila ?? null, addressLine: i.addressLine?.trim() || null,
    nid: i.idType === "nid" ? idDigits : null, birthRegNo: i.idType === "brn" ? idDigits : null,
    identityConfidence: strong ? "possible_duplicate" : "unverified", identityMethod: "desk",
  } });
  if (i.guardian?.name?.trim())
    // The phone is stored on the related person only when it is theirs, not the patient's own (open question 23).
    await tx.relatedPerson.create({ data: { tenantId: s.tenantId, patientId: p.id, relationship: i.guardian.relationship?.trim() || "guardian", nameBn: i.guardian.name.trim(), phone: i.phoneOwner && i.phoneOwner !== "self" ? normalizePhone(i.phone) : null, guardianProof: digitsOnly(i.guardian.idNo) || null } });
  await tx.provenance.create({ data: { tenantId: s.tenantId, targetType: "Patient", targetId: p.id, activity: "register", agentId: s.userId, onBehalfOf: s.organizationId, source: "patient_reported" } });
  return getPatient(tx, p.id);
}

/* ───── visits, tokens and the queue ───── */
const ACTIVE: ("arrived" | "triaged" | "in_progress")[] = ["arrived", "triaged", "in_progress"];

export async function branchOf(tx: Tx, s: SessionData) {
  const b = await tx.location.findFirst({ where: { organizationId: s.organizationId, kind: "branch" }, orderBy: { id: "asc" } });
  if (!b) throw err(409, "no_branch", "এই প্রতিষ্ঠানে কোনো শাখা নেই", "This facility has no branch set up");
  return b;
}

type EncounterRow = NonNullable<Awaited<ReturnType<Tx["encounter"]["findFirst"]>>> & { patient: PatientRow };
export const toQueueItem = (e: EncounterRow): QueueItem => {
  const status = dash<EncounterState>(e.status);
  const p = toSummary(e.patient);
  return {
    id: e.id, token: e.token, tokenNo: e.tokenNo, day: e.tokenDay, status, column: columnOf(status), visitType: e.visitType,
    patient: { id: p.id, facilityNo: p.facilityNo, nameBn: p.nameBn, nameEn: p.nameEn, sex: p.sex, birthDate: p.birthDate, approxAgeYears: p.approxAgeYears, approxAgeMonths: p.approxAgeMonths, approxAgeAt: p.approxAgeAt, identityConfidence: p.identityConfidence },
    arrivedAt: iso(e.arrivedAt), calledAt: iso(e.calledAt), statusAt: e.statusAt.toISOString(),
    actions: [...(status === "arrived" || status === "triaged" ? (["call"] as const) : []), ...frontDeskActions(status).map((a) => a.key)],
  };
};
const encounterInclude = { patient: { include: patientInclude } };

export async function createVisit(tx: Tx, s: SessionData, patientId: string, visitType: string, now: Date) {
  // A linked record continues on the record it was linked to.
  let p = await getPatient(tx, patientId);
  for (let i = 0; i < 3 && p.linkedToId; i++) p = await getPatient(tx, p.linkedToId);
  if (p.linkedToId) throw err(409, "link_chain", "লিংক করা রেকর্ডের শেষ পাওয়া যায়নি", "Linked record chain is too long");
  const branch = await branchOf(tx, s);
  const day = dhakaDay(now);
  const open = await tx.encounter.findFirst({ where: { patientId: p.id, branchId: branch.id, tokenDay: day, status: { in: ACTIVE } }, include: encounterInclude });
  if (open) throw err(409, "visit_exists", `আজ এই রোগীর টোকেন ${open.token} আছে`, `This patient already has token ${open.token} today`, { existing: { encounterId: open.id, token: open.token } });
  const seq = await tx.sequence.upsert({ where: { tenantId_name: { tenantId: s.tenantId, name: tokenSequenceName(branch.id, day) } }, create: { tenantId: s.tenantId, name: tokenSequenceName(branch.id, day), value: 1 }, update: { value: { increment: 1 } } });
  const status = transition("encounter", ENCOUNTER, "planned", "arrive");
  const e = await tx.encounter.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, branchId: branch.id, patientId: p.id, class: "opd", status: under<DbEncounterStatus>(status), visitType,
    token: formatToken(seq.value), tokenNo: seq.value, tokenDay: day, arrivedAt: now, statusAt: now, createdById: s.userId,
  }, include: encounterInclude });
  return { encounter: toQueueItem(e as EncounterRow), patient: p };
}

export async function queueBoard(tx: Tx, s: SessionData, day: string) {
  const branch = await branchOf(tx, s);
  const rows = (await tx.encounter.findMany({ where: { branchId: branch.id, tokenDay: day }, include: encounterInclude, orderBy: { tokenNo: "asc" } })) as EncounterRow[];
  const items = rows.map(toQueueItem);
  const { QUEUE_COLUMNS } = await import("@setu/domain");
  return {
    day, branch: { id: branch.id, name: branch.name, nameBn: branch.nameBn },
    columns: QUEUE_COLUMNS.map((c) => ({ key: c.key, status: c.state, items: items.filter((i) => i.column === c.key) })),
  };
}

export async function queueAction(tx: Tx, s: SessionData, encounterId: string, action: "next" | "noShow" | "call", now: Date) {
  // RLS scopes to the tenant; the queue is also scoped to the session's facility and branch (security review A1–A3).
  const branch = await branchOf(tx, s);
  const e = (await tx.encounter.findFirst({ where: { id: encounterId, organizationId: s.organizationId, branchId: branch.id }, include: encounterInclude })) as EncounterRow | null;
  if (!e) throw notFound();
  const from = dash<EncounterState>(e.status);
  if (action === "call") {
    if (from !== "arrived" && from !== "triaged") throw err(409, "invalid_transition", "এই অবস্থায় ডাকা যায় না", "Cannot call a patient in this state");
    const u = await tx.encounter.update({ where: { id: e.id }, data: { calledAt: now }, include: encounterInclude });
    return { item: toQueueItem(u as EncounterRow), from, event: "call" };
  }
  const a = frontDeskActions(from).find((x) => x.key === action);
  if (!a) throw err(409, "invalid_transition", "এই অবস্থায় এটি করা যায় না", "That step is not allowed from this state");
  const to = transition("encounter", ENCOUNTER, from, a.event);
  // Optimistic: only move it if nobody else moved it first.
  const n = await tx.encounter.updateMany({ where: { id: e.id, status: e.status }, data: { status: under<DbEncounterStatus>(to), statusAt: now, ...(action === "noShow" ? { cancelReason: "no-show" } : {}) } });
  if (n.count !== 1) throw err(409, "stale", "অন্য কেউ আগেই বদলেছেন — আবার দেখুন", "Someone else changed this token first — refresh");
  const u = await tx.encounter.findFirst({ where: { id: e.id }, include: encounterInclude });
  return { item: toQueueItem(u as EncounterRow), from, event: a.event };
}

/* ───── admin after-the-fact review (decision 16, 02/10/2026) ───── */
type ReviewDetail = { conflicts?: string[]; fields?: unknown; review?: { by: string; at: string; outcome: "unlinked" | "kept"; reason?: string | null } };
const isOpenOverride = (t: { status: string; decisionNote: string | null; detail: unknown }) =>
  t.status === "approved" && t.decisionNote === "link-anyway" && !(t.detail as ReviewDetail | null)?.review;

/** Open "Send for review" Tasks and "Link anyway" overrides nobody has reviewed yet, newest first. */
export async function reviewQueue(tx: Tx) {
  const tasks = await tx.task.findMany({ where: { kind: REVIEW, status: { in: ["requested", "approved"] } }, orderBy: { requestedAt: "desc" }, take: 200 });
  const live = tasks.filter((t) => t.status === "requested" || isOpenOverride(t));
  const ids = [...new Set(live.flatMap((t) => [t.focusId, t.candidateId]).filter((x): x is string => Boolean(x)))];
  const patients = new Map(((await tx.patient.findMany({ where: { id: { in: ids } }, include: patientInclude })) as PatientRow[]).map((p) => [p.id, p]));
  const users = new Map((await tx.user.findMany({ where: { id: { in: [...new Set(live.map((t) => t.requestedById))] } }, select: { id: true, nameBn: true, nameEn: true } })).map((u) => [u.id, u]));
  return live.flatMap((t) => {
    const subject = t.focusId ? patients.get(t.focusId) : undefined;
    if (!subject) return [];
    // An override whose link was undone since is no longer an override.
    if (t.status === "approved" && subject.linkedToId !== t.candidateId) return [];
    const candidate = t.candidateId ? patients.get(t.candidateId) : undefined;
    return [{
      taskId: t.id, kind: (t.status === "requested" ? "review" : "override") as "review" | "override",
      subject: toSummary(subject), candidate: candidate ? toSummary(candidate) : null, reason: t.reason,
      conflicts: ((t.detail as ReviewDetail | null)?.conflicts ?? []) as never[], requestedBy: users.get(t.requestedById) ?? null, requestedAt: t.requestedAt.toISOString(),
    }];
  });
}

const markReviewed = async (tx: Tx, s: SessionData, taskId: string, outcome: "unlinked" | "kept", reason: string | null, now: Date) => {
  const t = await tx.task.findFirst({ where: { id: taskId } });
  if (!t) return;
  const detail = { ...((t.detail ?? {}) as ReviewDetail), review: { by: s.userId, at: now.toISOString(), outcome, reason } };
  // The Task stays `approved` (APPROVAL has no way back); the review outcome is recorded beside it.
  await tx.task.update({ where: { id: t.id }, data: { detail: detail as object } });
};

/** Admin: split a linked record from the record it was linked to. Reason ≥10 characters; recorded in Provenance. */
export async function unlinkPatient(tx: Tx, s: SessionData, subjectId: string, reasonRaw: string, now: Date) {
  const reason = reasonRaw.trim();
  if (reason.length < 10) throw err(400, "reason_too_short", "কমপক্ষে ১০ অক্ষরের কারণ লিখুন", "Give a reason of at least 10 characters", { field: "reason", fields: [{ field: "reason", code: "reason_too_short" }] });
  const subject = await getPatient(tx, subjectId);
  if (!subject.linkedToId) throw err(409, "not_linked", "এই রেকর্ড কোনো রেকর্ডের সাথে লিংক করা নেই", "This record is not linked to another");
  const from = subject.linkedToId;
  // Two people again: neither record has been verified as this person at the desk.
  await tx.patient.update({ where: { id: subject.id }, data: { linkedToId: null, identityConfidence: "unverified" } });
  const open = (await tx.task.findMany({ where: { kind: REVIEW, focusId: subject.id, candidateId: from, status: "approved", decisionNote: "link-anyway" } })).filter(isOpenOverride);
  for (const t of open) await markReviewed(tx, s, t.id, "unlinked", reason, now);
  await tx.provenance.create({ data: {
    tenantId: s.tenantId, targetType: "Patient", targetId: subject.id, activity: "unlink", agentId: s.userId, onBehalfOf: s.organizationId,
    source: "desk_decision", reason, detail: { previous: { identityConfidence: subject.identityConfidence, linkedToId: from }, taskIds: open.map((t) => t.id) } as object,
  } });
  return { subject: await getPatient(tx, subject.id), taskId: open[0]?.id ?? null, unlinkedFrom: from };
}

/** Admin: the override was right — keep the link and take it off the review queue. */
export async function keepOverride(tx: Tx, s: SessionData, taskId: string, now: Date) {
  const t = await tx.task.findFirst({ where: { id: taskId, kind: REVIEW } });
  if (!t || !isOpenOverride(t) || !t.focusId) throw err(409, "not_an_open_override", "এটি রিভিউয়ের অপেক্ষায় থাকা লিংক নয়", "This is not a link awaiting review");
  const subject = await getPatient(tx, t.focusId);
  if (subject.linkedToId !== t.candidateId) throw err(409, "not_an_open_override", "এটি রিভিউয়ের অপেক্ষায় থাকা লিংক নয়", "This is not a link awaiting review");
  await markReviewed(tx, s, t.id, "kept", null, now);
  await tx.provenance.create({ data: { tenantId: s.tenantId, targetType: "Patient", targetId: subject.id, activity: "link-reviewed", agentId: s.userId, onBehalfOf: s.organizationId, source: "desk_decision", detail: { taskId: t.id, outcome: "kept" } as object } });
  return { subject, taskId: t.id };
}
