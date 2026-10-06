/* Lab service (slice A8–A11, ADR 0006). Runs inside command()/query(), so RLS scopes every read to the tenant; visits
   are also scoped to the session's facility and branch, and only visits with a placed lab order are lab business.
   Every rule is @setu/domain lab.ts (the screens run the same functions) and every status change is a machine
   transition (ORDER, SPECIMEN, RESULT, LAB_REPORT, COMMUNICATION); the database re-checks both (migration lab_guards).
   Kamrul's decisions of 03/10/2026 (D1–D10):
   - a result is never overwritten: a correction marks the old row entered-in-error with a reason and adds a new row
     that is verified and validated again; the ordering doctor is told when the old value had been released (D4);
   - a critical (HH/LL) result is validated only after a call-back that reached someone with the value read back, for
     that exact result; attempts are recorded and do not count (D9); nothing is released automatically;
   - one report per visit, released in versions: validated tests may go early ("PRELIMINARY — n of m"), the report is
     final when every test not cancelled is validated, "Corrected" when it replaces a released result (D3);
   - the same person may not verify and validate unless the facility (or the Clinic plan) allows it;
   - the doctor's inbox is told on every release; SMS and the patient app are sent by the lab (D6); SMS text is a fixed
     template (facility + what to do), sent through the Messenger adapter after the write commits;
   - an order is cancelled (ORDER revoke) only before its first tube is collected, with a reason, and the visit's
     draft bill is refreshed (D5, decision 99). */
import { syncForEncounter } from "./ipdBill.js";
import { SMS_MAYBE_SENT, SMS_QUEUED_MAX_MS, SMS_QUEUED_STUCK_MS, SMS_SENDING_STUCK_MS } from "@setu/domain";
import { randomUUID } from "node:crypto";
import type { CallbackRequest, CommunicationItem, CorrectRequest, LabOrder, LabReportView, LabResult, LabVisitView, LabWorklist, ReleaseRequest, ResultEntryRequest, SpecimenRejectRequest, ValidateRequest, VerifyRequest } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  COMMUNICATION, LAB_REPORT, ORDER, RESULT, SMS_TEMPLATES, SPECIMEN, analytesOf, callbackCheck, correctionCheck, deltaOf, dhakaDay, isCritical, labFlag, labReportNumber,
  labRoleCan, parseLabValue, patientAgeYears, rangeFor, rejectCheck, releasePlan, resultEntryCheck, revokeBlockers, samePersonAllowed, specimenNumber, transition, tubeFor, tubePlan,
  WITHDRAWN_REASON, decimalsOf, returnBlockers, validateBlockers, verifyBlockers, withdrawBlockers, type AnalyteDef, type LabFlag, type OrderState, type RangeDef, type ResultState, type SpecimenState, type TubeKind,
} from "@setu/domain";
import { fill, t } from "@setu/i18n";
import { messenger, type SendResult } from "../adapters/messaging/index.js";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { refreshDraftOrders } from "./billing.js";
import { branchOf, notFound } from "./frontdesk.js";
import { requirePin } from "./pin.js";
import { devHash } from "./users.js";

const dash = <T extends string>(s: string) => s.replace(/_/g, "-") as T;
const undash = <T extends string>(s: string) => s.replace(/-/g, "_") as T;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const LAB = "laboratory";
/** How far a device's "when it happened" may differ from the server clock (offline steps wait up to a day). */
const MAX_FUTURE_MS = 5 * 60_000, MAX_PAST_MS = 24 * 3600_000;
/** The worklists look back this far (older open work: a dues-style list later). */
const WORKLIST_DAYS = 30, WORKLIST_MAX = 200;
const LIVE: SpecimenState[] = ["collected", "received", "in-process", "done"];
const PRE_COLLECT: OrderState[] = ["active", "accepted", "partially-accepted"];

type DbObsStatus = "preliminary" | "verified" | "final" | "amended" | "entered_in_error";
type DbSpecimen = "pending" | "collected" | "received" | "in_process" | "done" | "rejected";
type DbOrder = "draft" | "active" | "centre_chosen" | "accepted" | "partially_accepted" | "declined" | "in_progress" | "partially_complete" | "complete" | "revoked";
type Obs = NonNullable<Awaited<ReturnType<Tx["observation"]["findFirst"]>>>;
type Order = NonNullable<Awaited<ReturnType<Tx["serviceRequest"]["findFirst"]>>>;
type Spec = NonNullable<Awaited<ReturnType<Tx["specimen"]["findFirst"]>>> & { orders: { serviceRequestId: string }[] };
type Report = NonNullable<Awaited<ReturnType<Tx["diagnosticReport"]["findFirst"]>>> & { results: { observationId: string; serviceRequestId: string }[] };
type Comm = NonNullable<Awaited<ReturnType<Tx["communication"]["findFirst"]>>>;
type Callback = NonNullable<Awaited<ReturnType<Tx["criticalCallback"]["findFirst"]>>>;
type EncP = NonNullable<Awaited<ReturnType<Tx["encounter"]["findFirst"]>>> & { patient: NonNullable<Awaited<ReturnType<Tx["patient"]["findFirst"]>>> };

type LabAction = "collect" | "enter" | "correct" | "verify" | "validate" | "return" | "withdraw" | "callback" | "release" | "deliver";
const forbiddenRole = () => err(403, "forbidden", "এই কাজটি আপনার ভূমিকায় নেই", "Your role cannot do this", { reason: "role", canRequest: false });
const stale = () => err(409, "stale", "অন্য কেউ আগেই বদলেছেন — আবার দেখুন", "Someone else changed this first — refresh");
export function requireLabRole(s: SessionData, action: LabAction) { if (!labRoleCan(action, s.role)) throw forbiddenRole(); }
function stepTime(at: string, now: Date): Date {
  const d = new Date(at);
  if (d.getTime() > now.getTime() + MAX_FUTURE_MS || d.getTime() < now.getTime() - MAX_PAST_MS)
    throw err(400, "time_range", "সময় ঠিক নেই — ডিভাইসের ঘড়ি দেখুন", "The time is out of range — check the device clock", { field: "at" });
  return d;
}
const fields = (list: { field: string; code: string }[]) => list;

/* ───── loading ───── */
interface Bundle {
  encounters: EncP[]; orders: Order[]; specimens: Spec[]; obs: Obs[]; callbacks: Callback[]; reports: Report[]; comms: Comm[];
  invoices: { encounterId: string; number: string | null; status: string }[];
  analytes: AnalyteDef[]; ranges: RangeDef[];
  /** the patients' earlier validated results (delta check / "previous"), newest first */
  previous: Obs[];
  people: Map<string, { id: string; nameBn: string; nameEn: string }>;
}

async function loadBundle(tx: Tx, s: SessionData, encounterIds: string[], withPrevious: boolean): Promise<Bundle> {
  const branch = await branchOf(tx, s);
  const encounters = (await tx.encounter.findMany({ where: { id: { in: encounterIds }, organizationId: s.organizationId, branchId: branch.id }, include: { patient: true } })) as EncP[];
  const ids = encounters.map((e) => e.id);
  const [orders, specimens, obs, callbacks, reports, comms, invoices, analyteRows, rangeRows] = await Promise.all([
    tx.serviceRequest.findMany({ where: { encounterId: { in: ids }, group: "lab", status: { not: "draft" } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    tx.specimen.findMany({ where: { encounterId: { in: ids } }, include: { orders: { select: { serviceRequestId: true } } }, orderBy: { createdAt: "asc" } }) as Promise<Spec[]>,
    tx.observation.findMany({ where: { encounterId: { in: ids }, category: LAB }, orderBy: [{ recordedAt: "asc" }, { id: "asc" }] }),
    tx.criticalCallback.findMany({ where: { encounterId: { in: ids } }, orderBy: { recordedAt: "asc" } }),
    tx.diagnosticReport.findMany({ where: { encounterId: { in: ids } }, include: { results: { select: { observationId: true, serviceRequestId: true } } }, orderBy: { version: "asc" } }) as Promise<Report[]>,
    tx.communication.findMany({ where: { encounterId: { in: ids }, kind: { not: "payment-link" } }, orderBy: { createdAt: "asc" } }),
    tx.invoice.findMany({ where: { encounterId: { in: ids }, kind: "opd", status: { notIn: ["cancelled", "entered_in_error"] } }, orderBy: { createdAt: "desc" }, select: { encounterId: true, number: true, status: true } }).then((r) => r.flatMap((i) => (i.encounterId ? [{ ...i, encounterId: i.encounterId }] : []))),
    tx.labAnalyte.findMany({ where: { active: true } }),
    tx.labReferenceRange.findMany(),
  ]);
  const analytes: AnalyteDef[] = analyteRows.map((a) => ({ code: a.code, testCode: a.testCode, nameEn: a.nameEn, nameBn: a.nameBn, unit: a.unit, decimals: a.decimals, critLow: a.critLow, critHigh: a.critHigh, deltaCheck: a.deltaCheck, position: a.position, sample: true }));
  const ranges: RangeDef[] = rangeRows.map((r) => ({ analyteCode: r.analyteCode, sex: r.sex === "other" ? null : r.sex, ageMinYears: r.ageMinYears, ageMaxYears: r.ageMaxYears, low: r.low, high: r.high, label: r.label as RangeDef["label"], sample: true }));
  let previous: Obs[] = [];
  if (withPrevious && encounters.length) {
    // Earlier validated results of these patients anywhere in this tenant (one record per tenant, decision 21), for the
    // delta check and the "previous" column — revealed only by the single-visit view and audited there.
    const codes = [...new Set(orders.flatMap((o) => analytesOf(o.testCode, analytes).map((a) => a.code)))];
    const prevIds = obs.map((o) => o.deltaPrevId).filter((x): x is string => Boolean(x));
    previous = await tx.observation.findMany({
      // this facility only (security review L5; the owner's other facilities need a decision like open question 45)
      where: { category: LAB, organizationId: s.organizationId, OR: [{ patientId: { in: encounters.map((e) => e.patientId) }, code: { in: codes }, status: "final", encounterId: { notIn: ids } }, { id: { in: prevIds } }] },
      orderBy: [{ effectiveAt: "desc" }, { recordedAt: "desc" }],
    });
  }
  const userIds = new Set<string>();
  for (const o of orders) { userIds.add(o.orderedById); if (o.revokedById) userIds.add(o.revokedById); if (o.countersignedById) userIds.add(o.countersignedById); }
  for (const x of specimens) for (const u of [x.collectedById, x.rejectedById]) if (u) userIds.add(u);
  for (const x of obs) for (const u of [x.recordedById, x.verifiedById, x.validatedById, x.errorById, x.returnedById]) if (u) userIds.add(u);
  for (const c of callbacks) userIds.add(c.callerId);
  for (const r of reports) userIds.add(r.releasedById);
  for (const c of comms) if (c.recipientUserId) userIds.add(c.recipientUserId);
  const people = new Map((await tx.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, nameBn: true, nameEn: true } })).map((u) => [u.id, u]));
  return { encounters, orders, specimens, obs, callbacks, reports, comms, invoices, analytes, ranges, previous, people };
}

const personOf = (b: Bundle, id: string | null | undefined) => (id ? b.people.get(id) ?? { id, nameBn: "—", nameEn: "—" } : null);
const sexOf = (p: EncP["patient"]) => p.sex;
function ageOf(e: EncP, specimens: Spec[], now: Date) {
  const first = specimens.filter((x) => x.encounterId === e.id && x.collectedAt).map((x) => x.collectedAt!.getTime()).sort()[0];
  return patientAgeYears({ birthDate: e.patient.birthDate ? e.patient.birthDate.toISOString().slice(0, 10) : null, approxAgeYears: e.patient.approxAgeYears, approxAgeAt: iso(e.patient.approxAgeAt) }, first ? new Date(first) : now);
}

/* ───── one visit, computed ───── */
interface Visit {
  e: EncP; ageYears: number | null; orders: Order[]; specimens: Spec[]; obs: Obs[]; callbacks: Callback[]; reports: Report[]; comms: Comm[];
  current: Report | null; everReleased: Set<string>; plan: ReturnType<typeof releasePlan>; tubes: ReturnType<typeof tubePlan>;
}
const isCurrent = (o: Obs) => o.status !== "entered_in_error";
function visitOf(b: Bundle, e: EncP, now: Date): Visit {
  const orders = b.orders.filter((o) => o.encounterId === e.id);
  const specimens = b.specimens.filter((x) => x.encounterId === e.id);
  const obs = b.obs.filter((o) => o.encounterId === e.id);
  const reports = b.reports.filter((r) => r.encounterId === e.id);
  const current = reports.find((r) => r.status !== "superseded") ?? null;
  const everReleased = new Set(reports.flatMap((r) => r.results.map((x) => x.observationId)));
  const tubes = tubePlan(orders.map((o) => ({ id: o.id, testCode: o.testCode, status: dash<OrderState>(o.status), hasResults: obs.some((x) => x.serviceRequestId === o.id && x.status !== "entered_in_error") })),
    specimens.map((x) => ({ id: x.id, tube: x.tube as TubeKind, status: dash<SpecimenState>(x.status), orderIds: x.orders.map((y) => y.serviceRequestId) })));
  const plan = releasePlan({
    tests: orders.map((o) => ({
      orderId: o.id, revoked: o.status === "revoked", analyteCount: analytesOf(o.testCode, b.analytes).length,
      results: obs.filter((x) => x.serviceRequestId === o.id).map((x) => ({ id: x.id, status: dash<ResultState>(x.status), replacesId: x.replacesId })),
    })),
    lastReleased: current?.results.map((x) => x.observationId) ?? [], everReleased: [...everReleased],
  });
  return { e, ageYears: ageOf(e, specimens, now), orders, specimens, obs, callbacks: b.callbacks.filter((c) => c.encounterId === e.id), reports, comms: b.comms.filter((c) => c.encounterId === e.id), current, everReleased, plan, tubes };
}
const liveSpecimen = (v: Visit, orderId: string) => [...v.specimens].reverse().find((x) => LIVE.includes(dash<SpecimenState>(x.status)) && x.orders.some((y) => y.serviceRequestId === orderId)) ?? null;
function rangeOfPatient(b: Bundle, v: Visit, code: string) {
  return rangeFor(b.ranges, code, { sex: sexOf(v.e.patient), ageYears: v.ageYears });
}
function previousOf(b: Bundle, v: Visit, code: string) {
  return b.previous.find((p) => p.patientId === v.e.patientId && p.code === code && p.status === "final" && p.encounterId !== v.e.id) ?? null;
}

function resultOf(b: Bundle, v: Visit, o: Obs): LabResult {
  const a = b.analytes.find((x) => x.code === o.code);
  // clinical review M6: an earlier result corrected or withdrawn since is no basis for a delta warning
  const prev = o.deltaPrevId ? b.previous.find((p) => p.id === o.deltaPrevId && p.status === "final") ?? null : null;
  const d = prev && a ? deltaOf(o.value, prev.value, a) : null;
  const replacedBy = v.obs.find((x) => x.replacesId === o.id);
  return {
    id: o.id, orderId: o.serviceRequestId ?? "", analyteCode: o.code, nameEn: a?.nameEn ?? o.code, nameBn: a?.nameBn ?? o.code, unit: o.unit, decimals: a?.decimals ?? 2,
    value: o.value, flag: (o.interpretation ?? null) as LabFlag | null,
    range: o.refLow !== null && o.refHigh !== null && o.refLabel ? { low: o.refLow, high: o.refHigh, label: o.refLabel as "adult" } : null,
    critLow: o.critLow, critHigh: o.critHigh, status: dash<LabResult["status"]>(o.status),
    enteredBy: personOf(b, o.recordedById)!, enteredAt: o.recordedAt.toISOString(),
    verifiedBy: personOf(b, o.verifiedById), verifiedAt: iso(o.verifiedAt), validatedBy: personOf(b, o.validatedById), validatedAt: iso(o.validatedAt),
    replacesId: o.replacesId, replacedById: replacedBy?.id ?? null,
    error: o.status === "entered_in_error" && o.errorById ? { reason: o.errorReason ?? "", by: personOf(b, o.errorById)!, at: iso(o.errorAt)! } : null,
    delta: d && prev ? { prevValue: prev.value, prevAt: prev.effectiveAt.toISOString(), pct: d.pct, hit: d.hit } : null,
    callbacks: v.callbacks.filter((c) => c.observationId === o.id).map((c) => ({
      id: c.id, observationId: c.observationId, outcome: dash<"reached">(c.outcome), recipientRole: c.recipientRole as "ordering-doctor", recipientName: c.recipientName,
      via: c.via as "phone", calledAt: c.calledAt.toISOString(), readBack: c.readBack, caller: personOf(b, c.callerId)!, recordedAt: c.recordedAt.toISOString(),
    })),
    released: v.everReleased.has(o.id),
    returned: o.returnedById ? { by: personOf(b, o.returnedById)!, at: iso(o.returnedAt)!, reason: o.returnReason ?? "" } : null,
    withdrawn: o.status === "entered_in_error" && !replacedBy,
  };
}
/** "Returned — <reason>" while the test waits for verification again (decision 119). */
function returnedOf(b: Bundle, v: Visit, orderId: string) {
  const r = v.obs.find((x) => x.serviceRequestId === orderId && x.status === "preliminary" && x.returnedById);
  return r ? { by: personOf(b, r.returnedById)!, at: iso(r.returnedAt)!, reason: r.returnReason ?? "" } : null;
}
/** The test's results were withdrawn and it has none now (decision 133). */
function withdrawnOf(b: Bundle, v: Visit, orderId: string) {
  const rows = v.obs.filter((x) => x.serviceRequestId === orderId);
  if (!rows.length || rows.some(isCurrent)) return null;
  const last = [...rows].reverse().find((x) => !v.obs.some((y) => y.replacesId === x.id) && x.errorById);
  return last ? { by: personOf(b, last.errorById)!, at: iso(last.errorAt)!, reason: last.errorReason ?? "" } : null;
}

function orderOf(b: Bundle, v: Visit, o: Order): LabOrder {
  // the tube it is measured in, else a printed label not yet collected
  const sp = liveSpecimen(v, o.id) ?? [...v.specimens].reverse().find((x) => x.status === "pending" && x.orders.some((y) => y.serviceRequestId === o.id)) ?? null;
  return {
    id: o.id, testCode: o.testCode, nameEn: o.nameEn, nameBn: o.nameBn, priority: o.priority, status: dash<OrderState>(o.status),
    orderedBy: personOf(b, o.orderedById)!, orderedAt: iso(o.orderedAt), tube: tubeFor(o.testCode),
    protocol: o.protocol, countersigned: o.countersignedById && o.countersignedAt ? { by: personOf(b, o.countersignedById) ?? { id: o.countersignedById, nameBn: "—", nameEn: "—" }, at: o.countersignedAt.toISOString() } : null,
    specimen: sp ? { id: sp.id, number: sp.number, status: dash<SpecimenState>(sp.status) } : null,
    template: analytesOf(o.testCode, b.analytes).map((a) => {
      const r = rangeOfPatient(b, v, a.code), p = previousOf(b, v, a.code);
      return { analyteCode: a.code, nameEn: a.nameEn, nameBn: a.nameBn, unit: a.unit, decimals: a.decimals, range: r ? { low: r.low, high: r.high, label: r.label } : null, critLow: a.critLow, critHigh: a.critHigh, deltaCheck: a.deltaCheck, previous: p ? { value: p.value, at: p.effectiveAt.toISOString() } : null };
    }),
    results: v.obs.filter((x) => x.serviceRequestId === o.id).map((x) => resultOf(b, v, x)),
    revoke: o.status === "revoked" && o.revokedById ? { by: personOf(b, o.revokedById)!, at: iso(o.revokedAt)!, reason: o.revokeReason ?? "" } : null,
    returned: returnedOf(b, v, o.id),
    withdrawn: withdrawnOf(b, v, o.id),
  };
}

function commOf(b: Bundle, v: Visit | null, c: Comm): CommunicationItem {
  const r = v?.reports.find((x) => x.id === c.reportId) ?? b.reports.find((x) => x.id === c.reportId);
  return {
    id: c.id, kind: c.kind as CommunicationItem["kind"], channel: dash<CommunicationItem["channel"]>(c.channel), status: dash<CommunicationItem["status"]>(c.status), attempts: c.attempts,
    lastError: c.lastError, toPhone: c.toPhone, recipient: personOf(b, c.recipientUserId), reportId: c.reportId, reportVersion: r?.version ?? null,
    createdAt: c.createdAt.toISOString(), sentAt: iso(c.sentAt), completedAt: iso(c.completedAt), deliveryConfirmed: c.deliveryConfirmed,
  };
}
const reportSummary = (b: Bundle, r: Report) => ({
  id: r.id, number: r.number, version: r.version, status: dash<"preliminary">(r.status), testCount: r.testCount, pendingCount: r.pendingCount,
  releasedAt: r.releasedAt.toISOString(), releasedBy: personOf(b, r.releasedById)!, supersededById: r.supersededById,
});
const encounterOf = (e: EncP) => ({ id: e.id, token: e.token, day: e.tokenDay, status: dash<"finished">(e.status) });
const patientOf = (v: Visit) => ({
  id: v.e.patient.id, facilityNo: v.e.patient.facilityNo, nameBn: v.e.patient.nameBn, nameEn: v.e.patient.nameEn, sex: v.e.patient.sex,
  birthDate: v.e.patient.birthDate ? v.e.patient.birthDate.toISOString().slice(0, 10) : null, approxAgeYears: v.e.patient.approxAgeYears, approxAgeMonths: v.e.patient.approxAgeMonths,
  approxAgeAt: iso(v.e.patient.approxAgeAt), phone: v.e.patient.phone, ageYears: v.ageYears, identityConfidence: dash<"verified">(v.e.patient.identityConfidence),
});

async function samePersonHere(tx: Tx, s: SessionData) {
  const o = await tx.organization.findFirst({ where: { id: s.organizationId }, select: { labSamePersonAllowed: true } });
  return samePersonAllowed(s.plan, o?.labSamePersonAllowed ?? null);
}

/** One visit for the lab screens, plus the earlier results it reveals (for the view audit). 404 unless the visit is at
    this branch and has a placed lab order. */
export async function labVisitView(tx: Tx, s: SessionData, encounterId: string, now = new Date()): Promise<{ view: LabVisitView; previousIds: string[] }> {
  const b = await loadBundle(tx, s, [encounterId], true);
  const e = b.encounters[0];
  if (!e || !b.orders.length) throw notFound();
  const v = visitOf(b, e, now);
  const orders = v.orders.map((o) => orderOf(b, v, o));
  const inv = b.invoices.find((i) => i.encounterId === e.id);
  const view: LabVisitView = {
    encounter: encounterOf(e), patient: patientOf(v), samePersonAllowed: await samePersonHere(tx, s), orders,
    collection: v.tubes.status, tubes: v.tubes.tubes,
    specimens: v.specimens.map((x) => ({
      id: x.id, number: x.number, tube: x.tube as TubeKind, status: dash<SpecimenState>(x.status), orderIds: x.orders.map((y) => y.serviceRequestId), labelPrints: x.labelPrints,
      labelPrintedAt: x.labelPrintedAt.toISOString(), collectedAt: iso(x.collectedAt), collectedBy: personOf(b, x.collectedById), receivedAt: iso(x.receivedAt), startedAt: iso(x.startedAt),
      doneAt: iso(x.doneAt), rejectedAt: iso(x.rejectedAt), rejectedBy: personOf(b, x.rejectedById), rejectReason: (x.rejectReason ?? null) as "haemolysed" | null, rejectNote: x.rejectNote,
    })),
    release: { status: v.plan.status, pending: v.plan.pending, total: v.plan.total, orderIds: v.plan.orderIds, observationIds: v.plan.observationIds, blockers: v.plan.blockers },
    reports: v.reports.map((r) => reportSummary(b, r)),
    communications: v.comms.map((c) => commOf(b, v, c)),
    bill: inv ? { number: inv.number, status: dash(inv.status) } : null,
  };
  const shown = new Set(orders.flatMap((o) => o.template.map((t) => previousOf(b, v, t.analyteCode)?.id ?? null)).concat(v.obs.map((o) => o.deltaPrevId)).filter((x): x is string => Boolean(x)));
  return { view, previousIds: [...shown] };
}
/** The view audit every response with a LabVisitView writes: what it revealed, incl. earlier results (delta check). */
export const viewAudit = (r: { view: LabVisitView; previousIds: string[] }, purpose: string): AuditEntry => ({
  action: "view", entity: "Encounter", entityId: r.view.encounter.id, patientId: r.view.patient.id, basis: "lab",
  detail: { purpose, previousObservations: r.previousIds, deltaHistory: r.previousIds.length > 0 },
});

/* ───── worklists ───── */
const PRIORITY_RANK = { routine: 0, urgent: 1, stat: 2 } as const;
export async function labWorklist(tx: Tx, s: SessionData, stage: LabWorklist["stage"], now = new Date()): Promise<LabWorklist> {
  const branch = await branchOf(tx, s);
  const since = new Date(now.getTime() - WORKLIST_DAYS * 864e5);
  // The most recent visits with lab orders (a busy lab's older open work needs a separate list later).
  const recent = await tx.serviceRequest.findMany({
    where: { organizationId: s.organizationId, branchId: branch.id, group: "lab", status: { not: "draft" }, orderedAt: { gte: since } },
    select: { encounterId: true }, orderBy: { orderedAt: "desc" },
  });
  const encIds = [...new Set(recent.map((x) => x.encounterId))].slice(0, WORKLIST_MAX);
  const b = await loadBundle(tx, s, encIds, false);
  const items: LabWorklist["items"] = [];
  for (const e of b.encounters) {
    const v = visitOf(b, e, now);
    const cur = v.obs.filter(isCurrent);
    const toEnter = v.orders.filter((o) => liveSpecimen(v, o.id)?.status === "in_process" && analytesOf(o.testCode, b.analytes).length > 0 && !cur.some((x) => x.serviceRequestId === o.id)).length;
    const counts = {
      tubesNeeded: v.tubes.tubes.length, toEnter,
      toVerify: cur.filter((x) => x.status === "preliminary").length, toValidate: cur.filter((x) => x.status === "verified").length,
      criticalOpen: cur.filter((x) => isCritical(x.interpretation as LabFlag) && (x.status === "preliminary" || x.status === "verified")).length,
      releasable: v.plan.blockers.length ? 0 : v.plan.orderIds.length,
    };
    const inLab = v.specimens.some((x) => ["collected", "received", "in_process"].includes(x.status));
    const deliveryFailed = v.comms.filter((c) => c.status === "failed").length;
    const returned = v.orders.map((o) => ({ o, r: returnedOf(b, v, o.id) })).filter((x) => x.r).map((x) => ({ orderId: x.o.id, nameEn: x.o.nameEn, reason: x.r!.reason }));
    const want = stage === "collect" ? counts.tubesNeeded > 0 || v.specimens.some((x) => x.status === "pending")
      : stage === "accession" ? inLab
      : stage === "result" ? counts.toEnter > 0 || returned.length > 0
      : stage === "verify" ? counts.toVerify + counts.toValidate + counts.releasable > 0
      : Boolean(v.current);
    if (!want) continue;
    const inv = b.invoices.find((i) => i.encounterId === e.id);
    const priority = v.orders.filter((o) => o.status !== "revoked").reduce<"routine" | "urgent" | "stat">((p, o) => (PRIORITY_RANK[o.priority] > PRIORITY_RANK[p] ? o.priority : p), "routine");
    const { phone: _phone, ...patient } = patientOf(v);
    items.push({
      encounter: encounterOf(e), patient, priority, collection: v.tubes.status, counts, deliveryFailed, returned,
      tests: v.orders.map((o) => ({ orderId: o.id, testCode: o.testCode, nameEn: o.nameEn, status: dash<OrderState>(o.status), awaitingDoctor: o.protocol && !o.countersignedAt })),
      report: v.current ? { id: v.current.id, number: v.current.number, version: v.current.version, status: dash<"preliminary">(v.current.status), pendingCount: v.current.pendingCount, testCount: v.current.testCount } : null,
      bill: inv ? { number: inv.number, status: dash(inv.status) } : null,
    });
  }
  // Critical first, then STAT / urgent, then the oldest visit first.
  items.sort((x, y) => (y.counts.criticalOpen > 0 ? 1 : 0) - (x.counts.criticalOpen > 0 ? 1 : 0) || PRIORITY_RANK[y.priority] - PRIORITY_RANK[x.priority] || x.encounter.day.localeCompare(y.encounter.day) || x.encounter.token.localeCompare(y.encounter.token));
  return { stage, items };
}

/* ───── the visit a write acts on ───── */
async function visitFor(tx: Tx, s: SessionData, encounterId: string, now: Date): Promise<{ b: Bundle; v: Visit }> {
  // Serialise lab writes on one visit (two technologists on the same patient at the same moment).
  await tx.$queryRaw`SELECT 1 FROM "Encounter" WHERE "id" = ${encounterId} FOR UPDATE`;
  const b = await loadBundle(tx, s, [encounterId], true);
  const e = b.encounters[0];
  if (!e || !b.orders.length) throw notFound();
  return { b, v: visitOf(b, e, now) };
}
async function specimenVisit(tx: Tx, s: SessionData, specimenId: string, now: Date) {
  const sp0 = await tx.specimen.findFirst({ where: { id: specimenId, organizationId: s.organizationId }, select: { encounterId: true } });
  if (!sp0) throw notFound();
  const { b, v } = await visitFor(tx, s, sp0.encounterId, now);
  const sp = v.specimens.find((x) => x.id === specimenId);
  if (!sp) throw notFound();
  return { b, v, sp };
}
async function observationVisit(tx: Tx, s: SessionData, observationId: string, now: Date) {
  const o0 = await tx.observation.findFirst({ where: { id: observationId, organizationId: s.organizationId, category: LAB }, select: { encounterId: true } });
  if (!o0) throw notFound();
  const { b, v } = await visitFor(tx, s, o0.encounterId, now);
  const o = v.obs.find((x) => x.id === observationId);
  if (!o) throw notFound();
  return { b, v, o };
}
const provenance = (s: SessionData, targetType: string, targetId: string, activity: string, now: Date, detail: Record<string, unknown> = {}) =>
  ({ tenantId: s.tenantId, targetType, targetId, activity, agentId: s.userId, onBehalfOf: s.organizationId, recorded: now, source: "provider_verified" as const, detail: { role: s.role, ...detail } as object });

/* ───── messages ───── */
async function facilityNames(tx: Tx, s: SessionData) {
  const o = await tx.organization.findFirst({ where: { id: s.organizationId }, select: { name: true, nameBn: true } });
  return { en: o?.name ?? "", bn: o?.nameBn ?? o?.name ?? "" };
}
/** The fixed SMS text (bn, then en): the facility's name is the only thing filled in (CLAUDE.md, ADR 0006). */
export async function smsText(tx: Tx, s: SessionData, kind: keyof typeof SMS_TEMPLATES) {
  const f = await facilityNames(tx, s), key = SMS_TEMPLATES[kind];
  return { templateKey: key, text: `${fill(t("bn", "labApp", key), { facility: f.bn })}\n${fill(t("en", "labApp", key), { facility: f.en })}` };
}
const target = (v: Visit) => ({ patientId: v.e.patientId, encounterId: v.e.id });
export const smsPhone = (phone: string | null | undefined) => (phone && /^1[3-9]\d{8}$/.test(phone) ? `0${phone}` : null);
/** An SMS row in preparation; sent by dispatchSms after the write commits. */
async function queueSms(tx: Tx, s: SessionData, v: Visit, kind: "recollect" | "report-ready", refs: { reportId?: string; specimenId?: string }) {
  const to = smsPhone(v.e.patient.phone);
  if (!to) return null;
  const { templateKey, text } = await smsText(tx, s, kind);
  const c = await tx.communication.create({ data: {
    id: `com_${randomUUID()}`, tenantId: s.tenantId, organizationId: s.organizationId, patientId: v.e.patientId, encounterId: v.e.id, kind, channel: "sms",
    toPhone: to, templateKey, text, reportId: refs.reportId ?? null, specimenId: refs.specimenId ?? null, createdById: s.userId,
  } });
  return c.id;
}
/** An in-app delivery (doctor's inbox, patient app): written and completed at once, through the COMMUNICATION steps. */
export async function deliverInApp(tx: Tx, s: SessionData, to: { patientId: string; encounterId: string }, data: { kind: string; channel: "doctor_inbox" | "patient_app"; recipientUserId?: string | null; reportId?: string | null; serviceRequestId?: string | null; observationId?: string | null; dispenseId?: string | null }, now: Date) {
  const id = `com_${randomUUID()}`;
  await tx.communication.create({ data: {
    id, tenantId: s.tenantId, organizationId: s.organizationId, patientId: to.patientId, encounterId: to.encounterId, kind: data.kind, channel: data.channel,
    recipientUserId: data.recipientUserId ?? null, reportId: data.reportId ?? null, serviceRequestId: data.serviceRequestId ?? null, observationId: data.observationId ?? null, dispenseId: data.dispenseId ?? null, createdById: s.userId,
  } });
  const sending = undash<"in_progress">(transition("COMMUNICATION", COMMUNICATION, "preparation", "send"));
  await tx.communication.update({ where: { id }, data: { status: sending, attempts: 1, sentAt: now, statusAt: now } });
  const done = undash<"completed">(transition("COMMUNICATION", COMMUNICATION, "in-progress", "deliver"));
  await tx.communication.update({ where: { id }, data: { status: done, completedAt: now, deliveryConfirmed: true, statusAt: now } });
  return id;
}

/** Sends queued SMS through the Messenger after the write that queued them committed (security review M3): one short
    transaction claims the message (preparation → in-progress, one attempt), the gateway is called outside any
    transaction, a second one records the outcome: completed (delivered — or only "sent" when the gateway cannot confirm
    delivery, ADR 0012: `deliveryConfirmed` false) | failed. A message whose send was interrupted stays in-progress; the
    sweep marks it failed after a while ("it may have been sent") and a person retries it. `by`: the session that queued
    it, or the system (the sweep). Returns each message's new state (the route merges them into its answer). */
type Sent = Pick<CommunicationItem, "status" | "attempts" | "lastError" | "sentAt" | "completedAt" | "deliveryConfirmed">;
export interface SmsActor { tenantId: string; userId: string | null; role: SessionData["role"] | null }
export async function dispatchSms(by: SmsActor, ids: string[], meta: { ip: string | null; route: string }) {
  const out = new Map<string, Sent>();
  if (!ids.length) return out;
  const { forTenant } = await import("@setu/db");
  for (const id of ids) {
    try {
      const now = new Date();
      const claimed = await forTenant(by.tenantId, async (tx) => {
        const c = await tx.communication.findFirst({ where: { id, channel: "sms", status: "preparation" } });
        if (!c || !c.toPhone || !c.text) return null;
        const sending = undash<"in_progress">(transition("COMMUNICATION", COMMUNICATION, "preparation", "send"));
        const n = await tx.communication.updateMany({ where: { id, status: "preparation" }, data: { status: sending, attempts: c.attempts + 1, sentAt: now, statusAt: now } });
        return n.count === 1 ? c : null;
      });
      if (!claimed) continue;
      const r = await messenger.sendSms({ messageId: claimed.id, to: claimed.toPhone!, text: claimed.text!, tenantId: by.tenantId })
        .catch((e: unknown): SendResult => ({ status: "failed", error: e instanceof Error ? e.message.slice(0, 120) : "gateway error", providerRef: null, reason: "gateway" }));
      const done = new Date();
      const ok = r.status !== "failed";
      const next = undash<"completed" | "failed">(transition("COMMUNICATION", COMMUNICATION, "in-progress", ok ? "deliver" : "fail"));
      await forTenant(by.tenantId, async (tx) => {
        // only onto this attempt: the sweep may have given up on it meanwhile (and someone retried) — review, SMS slice
        const n = await tx.communication.updateMany({ where: { id, status: "in_progress", attempts: claimed.attempts + 1 }, data: { status: next, providerRef: r.providerRef ?? claimed.providerRef, lastError: r.status === "failed" ? r.error : null,
          completedAt: ok ? done : null, deliveryConfirmed: r.status === "delivered", statusAt: done } });
        await tx.auditEvent.create({ data: { tenantId: by.tenantId, organizationId: claimed.organizationId, userId: by.userId, role: by.role, action: "send", entity: "Communication", entityId: id, patientId: claimed.patientId, ip: meta.ip,
          detail: { route: meta.route, channel: "sms", kind: claimed.kind, outcome: r.status, ...(r.status === "failed" && r.reason ? { reason: r.reason } : {}), attempt: claimed.attempts + 1, provider: messenger.name, ...(by.userId ? {} : { actor: "system:sms-sweep" }), ...(n.count ? {} : { late: true }) } } });
      });
      out.set(id, { status: dash(next), attempts: claimed.attempts + 1, lastError: r.status === "failed" ? r.error : null, sentAt: now.toISOString(), completedAt: ok ? done.toISOString() : null, deliveryConfirmed: r.status === "delivered" });
    } catch { /* left queued or in progress: the sweep and Retry pick it up */ }
  }
  return out;
}

/** A queued SMS that is no longer worth sending: failed with the reason (COMMUNICATION allows failing only from
    in-progress, so the row passes through it — the attempt is counted and the reason says it never reached the gateway). */
async function giveUp(tenantId: string, id: string, why: string, now: Date) {
  const { forTenant } = await import("@setu/db");
  await forTenant(tenantId, async (tx) => {
    const c = await tx.communication.findFirst({ where: { id, status: "preparation" } });
    if (!c) return;
    const n = await tx.communication.updateMany({ where: { id, status: "preparation" }, data: { status: "in_progress", attempts: c.attempts + 1, statusAt: now } });
    if (!n.count) return;
    await tx.communication.update({ where: { id }, data: { status: "failed", lastError: why, statusAt: now } });
    await tx.auditEvent.create({ data: { tenantId, organizationId: c.organizationId, userId: null, role: null, action: "update", entity: "Communication", entityId: id, patientId: c.patientId, detail: { actor: "system:sms-sweep", kind: c.kind, outcome: "not-sent", reason: why } } });
  });
}

/** Every minute (ADR 0012, open question 124): an SMS queued for more than a minute is sent; one "sending" for more than
    two (the API stopped mid-send) becomes failed — "it may have been sent" — for a person to retry. Never resent here. */
export async function sweepSms(now: Date): Promise<{ sent: number; interrupted: number }> {
  const { forTenant, smsSweepTargets } = await import("@setu/db");
  let sent = 0, interrupted = 0;
  for (const t of await smsSweepTargets(new Date(now.getTime() - SMS_QUEUED_STUCK_MS), new Date(now.getTime() - SMS_SENDING_STUCK_MS))) {
    try {
      if (t.status === "preparation") {
        // never send what no longer makes sense (review): too old, or a payment link that is no longer the payment's
        const why = await forTenant(t.tenantId, async (tx) => {
          const c = await tx.communication.findFirst({ where: { id: t.communicationId, status: "preparation" } });
          if (!c) return "gone";
          if (now.getTime() - c.createdAt.getTime() > SMS_QUEUED_MAX_MS) return "not sent — too old";
          if (c.kind === "payment-link" && c.paymentId) {
            const p = await tx.payment.findFirst({ where: { id: c.paymentId }, select: { status: true, linkCode: true, executeClaimedAt: true } });
            if (!p || !["link_sent", "waiting_customer"].includes(p.status) || p.executeClaimedAt || !p.linkCode || !(c.text ?? "").endsWith(`/p/${p.linkCode}`)) return "not sent — the payment link has changed";
          }
          return null;
        });
        if (why === "gone") continue;
        if (why) { await giveUp(t.tenantId, t.communicationId, why, now); continue; }
        sent += (await dispatchSms({ tenantId: t.tenantId, userId: null, role: null }, [t.communicationId], { ip: null, route: "sweep" })).size;
        continue;
      }
      await forTenant(t.tenantId, async (tx) => {
        const c = await tx.communication.findFirst({ where: { id: t.communicationId, status: "in_progress" } });
        if (!c) return;
        const failed = undash<"failed">(transition("COMMUNICATION", COMMUNICATION, "in-progress", "fail"));
        const n = await tx.communication.updateMany({ where: { id: c.id, status: "in_progress", attempts: c.attempts }, data: { status: failed, lastError: SMS_MAYBE_SENT, statusAt: now } });
        if (n.count) { interrupted++; await tx.auditEvent.create({ data: { tenantId: t.tenantId, organizationId: c.organizationId, userId: null, role: null, action: "update", entity: "Communication", entityId: c.id, patientId: c.patientId, detail: { actor: "system:sms-sweep", kind: c.kind, outcome: "interrupted" } } }); }
      });
    } catch (e) { console.error(`sms sweep ${t.tenantId}/${t.communicationId} failed`, e); }
  }
  return { sent, interrupted };
}
/** How long a message may sit queued or in progress before Retry may pick it up again (security review M3). */
export const STUCK_QUEUED_MS = 60_000, STUCK_SENDING_MS = 120_000;

/* ───── A8: labels, collection, accession, rejection ───── */
async function nextNumber(tx: Tx, s: SessionData, name: string) {
  const seq = await tx.sequence.upsert({ where: { tenantId_name: { tenantId: s.tenantId, name } }, create: { tenantId: s.tenantId, name, value: 1 }, update: { value: { increment: 1 } } });
  return seq.value;
}
/** Tube numbers run per tenant and month (the barcode is unique per tenant — security review L4). A month's counter
    that does not exist yet starts after the highest number already issued that month. */
async function nextSpecimenNo(tx: Tx, s: SessionData, yymm: string) {
  const name = `specimen:${yymm}`;
  if (!(await tx.sequence.findUnique({ where: { tenantId_name: { tenantId: s.tenantId, name } } }))) {
    const prefix = `S-${yymm}-`;
    const used = await tx.specimen.findMany({ where: { number: { startsWith: prefix } }, select: { number: true } });
    const max = used.reduce((m, x) => Math.max(m, Number(x.number.slice(prefix.length)) || 0), 0);
    await tx.sequence.upsert({ where: { tenantId_name: { tenantId: s.tenantId, name } }, create: { tenantId: s.tenantId, name, value: max }, update: {} });
  }
  return nextNumber(tx, s, name);
}
/** Print labels for the tubes the visit still needs: a new pending tube per need, or a reprint of its label. */
export async function printLabels(tx: Tx, s: SessionData, encounterId: string, tubes: TubeKind[] | undefined, now: Date) {
  requireLabRole(s, "collect");
  const { v } = await visitFor(tx, s, encounterId, now);
  const needs = v.tubes.tubes.filter((n) => !tubes || tubes.includes(n.tube));
  if (!needs.length) throw err(409, "nothing_to_label", "এই ভিজিটে আর কোনো টিউব লাগবে না", "No tube is needed for this visit");
  const audit: AuditEntry[] = [];
  const day = dhakaDay(now), yymm = `${day.slice(2, 4)}${day.slice(5, 7)}`;
  for (const n of needs) {
    if (n.specimenId) {
      const sp = v.specimens.find((x) => x.id === n.specimenId)!;
      const u = await tx.specimen.updateMany({ where: { id: sp.id, status: "pending", labelPrints: sp.labelPrints }, data: { labelPrints: sp.labelPrints + 1 } });
      if (u.count !== 1) throw stale();
      audit.push({ action: "reprint", entity: "Specimen", entityId: sp.id, patientId: v.e.patientId, detail: { number: sp.number, tube: n.tube, copy: sp.labelPrints + 1 } });
      continue;
    }
    const number = specimenNumber(yymm, await nextSpecimenNo(tx, s, yymm));
    const sp = await tx.specimen.create({ data: {
      tenantId: s.tenantId, organizationId: s.organizationId, branchId: v.e.branchId, patientId: v.e.patientId, encounterId: v.e.id, number, tube: n.tube,
      labelPrintedById: s.userId, labelPrintedAt: now, statusAt: now,
    } });
    await tx.specimenOrder.createMany({ data: n.orderIds.map((serviceRequestId) => ({ tenantId: s.tenantId, specimenId: sp.id, serviceRequestId })) });
    audit.push({ action: "print", entity: "Specimen", entityId: sp.id, patientId: v.e.patientId, detail: { number, tube: n.tube, orders: n.orderIds, recollect: n.recollect } });
  }
  return { encounterId: v.e.id, audit, printed: needs.length };
}

async function specimenStep(tx: Tx, s: SessionData, specimenId: string, event: "collect" | "receive" | "process", at: string, now: Date) {
  requireLabRole(s, "collect");
  const when = stepTime(at, now);
  const { v, sp } = await specimenVisit(tx, s, specimenId, now);
  const from = dash<SpecimenState>(sp.status);
  const to = transition("SPECIMEN", SPECIMEN, from, event);
  const orderIds = sp.orders.map((o) => o.serviceRequestId);
  const live = v.orders.filter((o) => orderIds.includes(o.id) && o.status !== "revoked");
  if (event === "collect" && !live.length) throw err(409, "orders_cancelled", "এই টিউবের সব পরীক্ষা বাতিল — লেবেলটি ফেলে দিন", "Every test on this tube was cancelled — discard the label");
  const before = event === "collect" ? new Date(sp.labelPrintedAt.getTime() - 5 * 60_000) : event === "receive" ? sp.collectedAt : sp.receivedAt;
  if (before && when.getTime() < before.getTime() - 60_000)
    throw err(400, "time_order", "এই ধাপের সময় আগের ধাপের আগে হতে পারে না", "This step cannot be before the step before it", { field: "at" });
  const data = event === "collect" ? { collectedById: s.userId, collectedAt: when } : event === "receive" ? { receivedById: s.userId, receivedAt: when } : { startedById: s.userId, startedAt: when };
  const u = await tx.specimen.updateMany({ where: { id: sp.id, status: sp.status }, data: { status: undash<DbSpecimen>(to), statusAt: now, ...data } });
  if (u.count !== 1) throw stale();
  const audit: AuditEntry[] = [{ action: "update", entity: "Specimen", entityId: sp.id, patientId: v.e.patientId, detail: { event, from, to, number: sp.number, at: when.toISOString() } }];
  if (event === "collect") {
    // ORDER collect: placed → in-progress for the tests on this tube (a recollected test is already in progress).
    for (const o of live.filter((x) => PRE_COLLECT.includes(dash<OrderState>(x.status)))) {
      const oto = transition("ORDER", ORDER, dash<OrderState>(o.status), "collect");
      const n = await tx.serviceRequest.updateMany({ where: { id: o.id, status: o.status }, data: { status: undash<DbOrder>(oto), statusAt: now } });
      if (n.count !== 1) throw stale();
      audit.push({ action: "update", entity: "ServiceRequest", entityId: o.id, patientId: v.e.patientId, detail: { event: "collect", from: dash(o.status), to: oto, specimen: sp.number } });
    }
    await tx.provenance.create({ data: provenance(s, "Specimen", sp.id, "collect", now, { number: sp.number, at: when.toISOString() }) });
  }
  return { encounterId: v.e.id, audit };
}
export const collectSpecimen = (tx: Tx, s: SessionData, id: string, at: string, now: Date) => specimenStep(tx, s, id, "collect", at, now);
export const receiveSpecimen = (tx: Tx, s: SessionData, id: string, at: string, now: Date) => specimenStep(tx, s, id, "receive", at, now);
export const startSpecimen = (tx: Tx, s: SessionData, id: string, at: string, now: Date) => specimenStep(tx, s, id, "process", at, now);

/** Reject a tube (SPECIMEN reject) with a reason; its tests need a new tube; the patient gets the recollection SMS. */
export async function rejectSpecimen(tx: Tx, s: SessionData, specimenId: string, body: SpecimenRejectRequest, now: Date) {
  requireLabRole(s, "collect");
  const when = stepTime(body.at, now);
  const bad = rejectCheck({ reason: body.reason, note: body.note });
  if (bad.length) throw err(400, "reject_reason", "কারণ লিখুন (অন্য কারণ হলে অন্তত ১০ অক্ষর)", "Give a reason (for 'other', at least 10 characters)", { field: bad[0] === "note_required" ? "note" : "reason" });
  const { v, sp } = await specimenVisit(tx, s, specimenId, now);
  // clinical review H2: results entered from this tube must be withdrawn first (so none stays current from a bad tube)
  if (v.obs.some((x) => x.specimenId === sp.id && isCurrent(x)))
    throw err(409, "results_entered", "এই টিউবের ফলাফল লেখা হয়ে গেছে — আগে পরীক্ষার ফলাফল প্রত্যাহার করুন", "Results from this tube are already entered — withdraw the test's results first");
  const from = dash<SpecimenState>(sp.status);
  const to = transition("SPECIMEN", SPECIMEN, from, "reject");
  const u = await tx.specimen.updateMany({ where: { id: sp.id, status: sp.status }, data: { status: undash<DbSpecimen>(to), statusAt: now, rejectedById: s.userId, rejectedAt: when, rejectReason: body.reason, rejectNote: body.note?.trim() || null } });
  if (u.count !== 1) throw stale();
  await tx.provenance.create({ data: provenance(s, "Specimen", sp.id, "reject", now, { number: sp.number, reason: body.reason }) });
  // a tube never collected (e.g. the sample could not be drawn) needs no "come back" SMS: the patient is at the desk
  const smsId = from === "pending" ? null : await queueSms(tx, s, v, "recollect", { specimenId: sp.id });
  return {
    encounterId: v.e.id, dispatch: smsId ? [smsId] : [],
    audit: [{ action: "update", entity: "Specimen", entityId: sp.id, patientId: v.e.patientId, detail: { event: "reject", from, to, reason: body.reason, number: sp.number, recollectionSms: Boolean(smsId) } }] as AuditEntry[],
  };
}

/* ───── A9: result entry and corrections ───── */
async function finishSpecimenIfDone(tx: Tx, v: Visit, sp: Spec, enteredOrderId: string, now: Date) {
  if (sp.status !== "in_process") return null;
  const orderIds = sp.orders.map((o) => o.serviceRequestId);
  const open = v.orders.filter((o) => orderIds.includes(o.id) && o.status !== "revoked" && o.id !== enteredOrderId && !v.obs.some((x) => x.serviceRequestId === o.id && isCurrent(x)));
  if (open.length) return null;
  const to = transition("SPECIMEN", SPECIMEN, "in-process", "finish");
  const u = await tx.specimen.updateMany({ where: { id: sp.id, status: "in_process" }, data: { status: undash<DbSpecimen>(to), doneAt: now, statusAt: now } });
  if (u.count !== 1) throw stale();
  return { from: "in-process", to };
}

/** "Send for verification" for one test: every analyte, flagged against the patient's range, delta against the
    previous validated result; a critical value typed twice (D2). RESULT enter → preliminary. */
export async function enterResults(tx: Tx, s: SessionData, orderId: string, body: ResultEntryRequest, now: Date) {
  requireLabRole(s, "enter");
  const o0 = await tx.serviceRequest.findFirst({ where: { id: orderId, organizationId: s.organizationId, group: "lab" }, select: { encounterId: true } });
  if (!o0) throw notFound();
  const { b, v } = await visitFor(tx, s, o0.encounterId, now);
  const o = v.orders.find((x) => x.id === orderId);
  if (!o) throw notFound();
  if (o.status === "revoked") throw err(409, "order_revoked", "এই পরীক্ষা বাতিল হয়েছে", "This test was cancelled");
  if (v.obs.some((x) => x.serviceRequestId === o.id && isCurrent(x)))
    throw err(409, "already_entered", "এই পরীক্ষার ফলাফল আগেই পাঠানো হয়েছে — বদলাতে হলে সংশোধন করুন", "Results for this test were already sent — correct a value instead");
  const sp = liveSpecimen(v, o.id);
  if (!sp || sp.status !== "in_process")
    throw err(409, "specimen_not_in_process", "নমুনা গ্রহণ করে প্রক্রিয়া শুরু করুন, তারপর ফলাফল লিখুন", "Receive the sample and start processing before entering results");
  const analytes = analytesOf(o.testCode, b.analytes);
  if (!analytes.length) throw err(422, "no_template", "নমুনা তালিকায় এই পরীক্ষার ফলাফল-ছক নেই", "The sample list has no result template for this test");
  const check = resultEntryCheck(analytes, body.entries.map((x) => ({ analyteCode: x.analyteCode, raw: x.value, confirm: x.confirm ?? null })), (code) => rangeOfPatient(b, v, code));
  if (check.errors.length)
    throw err(400, "result_entry", `${check.errors.length}টি ঘর ঠিক করুন`, `${check.errors.length} field(s) need attention`, { field: check.errors[0]!.field, fields: fields(check.errors) });
  const enter = transition("RESULT", RESULT, "registered", "enter");
  const batchId = `lb_${randomUUID()}`;
  for (const val of check.values) {
    const a = analytes.find((x) => x.code === val.analyteCode)!;
    const r = rangeOfPatient(b, v, a.code), prev = previousOf(b, v, a.code), d = prev ? deltaOf(val.value, prev.value, a) : null;
    await tx.observation.create({ data: {
      tenantId: s.tenantId, organizationId: s.organizationId, branchId: v.e.branchId, patientId: v.e.patientId, encounterId: v.e.id, batchId, category: LAB, code: a.code,
      value: val.value, unit: a.unit, method: "manual", interpretation: val.flag, status: undash<DbObsStatus>(enter) as "preliminary", recordedById: s.userId,
      effectiveAt: sp.collectedAt ?? now, serviceRequestId: o.id, specimenId: sp.id, refLow: r?.low ?? null, refHigh: r?.high ?? null, refLabel: r?.label ?? null,
      critLow: a.critLow, critHigh: a.critHigh, deltaPrevId: d ? prev!.id : null, deltaPct: d?.pct ?? null, statusAt: now,
    } });
  }
  await tx.provenance.create({ data: provenance(s, "Observation", batchId, "lab-enter", now, { orderId: o.id, specimen: sp.number, critical: check.values.filter((x) => isCritical(x.flag)).map((x) => x.analyteCode) }) });
  const fin = await finishSpecimenIfDone(tx, v, sp, o.id, now);
  return {
    encounterId: v.e.id,
    audit: [
      { action: "create", entity: "Observation", entityId: batchId, patientId: v.e.patientId, detail: { orderId: o.id, testCode: o.testCode, count: check.values.length, flags: Object.fromEntries(check.values.map((x) => [x.analyteCode, x.flag])) } },
      ...(fin ? [{ action: "update", entity: "Specimen", entityId: sp.id, patientId: v.e.patientId, detail: { event: "finish", ...fin } }] : []),
    ] as AuditEntry[],
  };
}

/** A correction (D4): the old row → entered-in-error with the reason; a new row (replacesId) starts at preliminary and
    needs verify + validate again (and a new call-back if still critical). Released before → the doctor is told. */
export async function correctResult(tx: Tx, s: SessionData, observationId: string, body: CorrectRequest, now: Date) {
  requireLabRole(s, "correct");
  const { b, v, o } = await observationVisit(tx, s, observationId, now);
  const a = b.analytes.find((x) => x.code === o.code);
  const parsed = parseLabValue(body.value);
  if (!parsed.ok) throw err(400, "result_entry", "মানটি ঠিক করুন", "Check the value", { field: "value", fields: fields([{ field: "value", code: parsed.code }]) });
  if (a && decimalsOf(body.value) > a.decimals) throw err(400, "result_entry", "এই পরীক্ষায় এত দশমিক ঘর হয় না", "Too many decimal places for this test", { field: "value", fields: fields([{ field: "value", code: "too_many_decimals" }]) });
  const bad = correctionCheck({ status: dash<ResultState>(o.status), oldValue: o.value, newValue: parsed.value, reason: body.reason });
  if (bad.includes("not_current")) throw err(409, "not_current", "এই ফলাফল আগেই সংশোধিত হয়েছে", "This result was already corrected");
  if (bad.length) throw err(400, bad[0]!, bad[0] === "reason_required" ? "কারণ লিখুন (অন্তত ১০ অক্ষর)" : "নতুন মান আগের মানের মতোই", bad[0] === "reason_required" ? "Give a reason (at least 10 characters)" : "The new value is the same as the old one", { field: bad[0] === "reason_required" ? "reason" : "value" });
  // The range and thresholds of the original entry (a snapshot), so the corrected value is flagged the same way.
  const range = o.refLow !== null && o.refHigh !== null ? { low: o.refLow, high: o.refHigh } : null;
  const flag = labFlag(parsed.value, range, { critLow: o.critLow, critHigh: o.critHigh });
  if (isCritical(flag)) {
    const c = body.confirm ? parseLabValue(body.confirm) : null;
    if (!c) throw err(400, "result_entry", "জরুরি মান — আবার লিখে নিশ্চিত করুন", "Critical value — type it again to confirm", { field: "confirm", fields: fields([{ field: "confirm", code: "confirm_required" }]) });
    if (!c.ok || c.value !== parsed.value) throw err(400, "result_entry", "দুইবার লেখা মান মেলেনি", "The two values do not match", { field: "confirm", fields: fields([{ field: "confirm", code: "confirm_mismatch" }]) });
  }
  const errTo = transition("RESULT", RESULT, dash<ResultState>(o.status), "markError");
  const u = await tx.observation.updateMany({ where: { id: o.id, status: o.status }, data: { status: undash<DbObsStatus>(errTo) as "entered_in_error", errorReason: body.reason.trim(), errorById: s.userId, errorAt: now, statusAt: now } });
  if (u.count !== 1) throw stale();
  const prev = o.deltaPrevId ? b.previous.find((p) => p.id === o.deltaPrevId) ?? null : null;
  const d = prev && a ? deltaOf(parsed.value, prev.value, a) : null;
  const enter = transition("RESULT", RESULT, "registered", "enter");
  const n = await tx.observation.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, branchId: o.branchId, patientId: o.patientId, encounterId: o.encounterId, batchId: `lb_${randomUUID()}`, category: LAB, code: o.code,
    value: parsed.value, unit: o.unit, method: "manual", interpretation: flag, status: undash<DbObsStatus>(enter) as "preliminary", recordedById: s.userId, effectiveAt: o.effectiveAt,
    serviceRequestId: o.serviceRequestId, specimenId: o.specimenId, refLow: o.refLow, refHigh: o.refHigh, refLabel: o.refLabel, critLow: o.critLow, critHigh: o.critHigh,
    deltaPrevId: d ? prev!.id : null, deltaPct: d?.pct ?? null, replacesId: o.id, statusAt: now,
  } });
  await tx.provenance.create({ data: provenance(s, "Observation", n.id, "lab-correct", now, { replaces: o.id, reason: body.reason.trim() }) });
  const audit: AuditEntry[] = [
    { action: "update", entity: "Observation", entityId: o.id, patientId: o.patientId, detail: { event: "markError", from: dash(o.status), to: errTo, reason: body.reason.trim(), replacedBy: n.id } },
    { action: "create", entity: "Observation", entityId: n.id, patientId: o.patientId, detail: { replaces: o.id, analyte: o.code, flag } },
  ];
  const phoned = v.callbacks.some((c) => c.observationId === o.id && c.outcome === "reached");
  if (v.everReleased.has(o.id) || phoned) {
    const order = v.orders.find((x) => x.id === o.serviceRequestId);
    if (order) {
      const cid = await deliverInApp(tx, s, target(v), { kind: "correction-notice", channel: "doctor_inbox", recipientUserId: order.orderedById, serviceRequestId: order.id, observationId: o.id, reportId: v.current?.id ?? null }, now);
      audit.push({ action: "create", entity: "Communication", entityId: cid, patientId: o.patientId, detail: { kind: "correction-notice", to: order.orderedById } });
    }
  }
  return { encounterId: v.e.id, audit };
}

/* ───── send-back (decision 119) and withdrawal (decision 133), ADR 0006 addendum ───── */
async function orderVisit(tx: Tx, s: SessionData, orderId: string, now: Date) {
  const o0 = await tx.serviceRequest.findFirst({ where: { id: orderId, organizationId: s.organizationId, group: "lab" }, select: { encounterId: true } });
  if (!o0) throw notFound();
  const { b, v } = await visitFor(tx, s, o0.encounterId, now);
  const o = v.orders.find((x) => x.id === orderId);
  if (!o) throw notFound();
  return { b, v, o };
}
const reasonErr = () => err(400, "reason_required", "কারণ লিখুন (অন্তত ১০ অক্ষর)", "Give a reason (at least 10 characters)", { field: "reason" });

/** The pathologist sends a verified test back to the technologist: RESULT return (verified → preliminary) for every
    current result of the test; the verification is cleared, the return recorded; it must be verified again. */
export async function returnTest(tx: Tx, s: SessionData, orderId: string, reason: string, now: Date) {
  requireLabRole(s, "return");
  const { v, o } = await orderVisit(tx, s, orderId, now);
  const rows = v.obs.filter((x) => x.serviceRequestId === o.id && isCurrent(x));
  const bad = returnBlockers({ role: s.role, results: rows.map((x) => ({ status: dash<ResultState>(x.status) })), reason });
  if (bad.includes("not_verified")) throw err(409, "not_verified", "শুধু যাচাই করা (অনুমোদন বাকি) পরীক্ষা ফেরত পাঠানো যায়", "Only a verified test that is not yet validated can be sent back");
  if (bad.includes("reason_required")) throw reasonErr();
  for (const x of rows) {
    const to = transition("RESULT", RESULT, dash<ResultState>(x.status), "return");
    const u = await tx.observation.updateMany({ where: { id: x.id, status: x.status }, data: { status: undash<DbObsStatus>(to) as "preliminary", verifiedById: null, verifiedAt: null, returnedById: s.userId, returnedAt: now, returnReason: reason.trim(), statusAt: now } });
    if (u.count !== 1) throw stale();
  }
  await tx.provenance.create({ data: provenance(s, "ServiceRequest", o.id, "lab-return", now, { reason: reason.trim(), observations: rows.map((x) => x.id), verifiedBy: [...new Set(rows.map((x) => x.verifiedById))] }) });
  return { encounterId: v.e.id, audit: [{ action: "update", entity: "Observation", entityId: rows[0]!.id, patientId: v.e.patientId, detail: { event: "return", orderId: o.id, testCode: o.testCode, reason: reason.trim(), observations: rows.map((x) => x.id), verifiedBy: [...new Set(rows.map((x) => x.verifiedById))] } }] as AuditEntry[] };
}

/** Withdraw a test's results (no replacement value): every current result → entered-in-error with the reason; the tube
    it was measured in is rejected (results-withdrawn) so a new tube is needed and the patient gets the recollection
    SMS; the ordering doctor gets a notice if any of them had been released. */
export async function withdrawTest(tx: Tx, s: SessionData, orderId: string, reason: string, now: Date) {
  requireLabRole(s, "withdraw");
  const { v, o } = await orderVisit(tx, s, orderId, now);
  const rows = v.obs.filter((x) => x.serviceRequestId === o.id && isCurrent(x));
  const bad = withdrawBlockers({ role: s.role, results: rows.map((x) => ({ status: dash<ResultState>(x.status) })), reason });
  if (bad.includes("nothing_to_withdraw")) throw err(409, "nothing_to_withdraw", "এই পরীক্ষার কোনো ফলাফল নেই", "This test has no results to withdraw");
  if (bad.includes("reason_required")) throw reasonErr();
  const audit: AuditEntry[] = [];
  for (const x of rows) {
    const to = transition("RESULT", RESULT, dash<ResultState>(x.status), "markError");
    const u = await tx.observation.updateMany({ where: { id: x.id, status: x.status }, data: { status: undash<DbObsStatus>(to) as "entered_in_error", errorReason: reason.trim(), errorById: s.userId, errorAt: now, statusAt: now } });
    if (u.count !== 1) throw stale();
  }
  audit.push({ action: "update", entity: "Observation", entityId: rows[0]!.id, patientId: v.e.patientId, detail: { event: "withdraw", orderId: o.id, testCode: o.testCode, reason: reason.trim(), observations: rows.map((x) => x.id) } });
  const dispatch: string[] = [];
  // clinical review M1: the tube these results were measured in (not merely the newest tube of the test)
  const tubeId = rows.find((x) => x.specimenId)?.specimenId ?? null;
  const sp = v.specimens.find((x) => x.id === tubeId && LIVE.includes(dash<SpecimenState>(x.status))) ?? null;
  if (sp) {
    const from = dash<SpecimenState>(sp.status);
    const to = transition("SPECIMEN", SPECIMEN, from, "reject");
    const u = await tx.specimen.updateMany({ where: { id: sp.id, status: sp.status }, data: { status: undash<DbSpecimen>(to), statusAt: now, rejectedById: s.userId, rejectedAt: now, rejectReason: WITHDRAWN_REASON, rejectNote: reason.trim() } });
    if (u.count !== 1) throw stale();
    audit.push({ action: "update", entity: "Specimen", entityId: sp.id, patientId: v.e.patientId, detail: { event: "reject", from, to, reason: WITHDRAWN_REASON, number: sp.number } });
    const smsId = await queueSms(tx, s, v, "recollect", { specimenId: sp.id });
    if (smsId) dispatch.push(smsId);
  }
  await tx.provenance.create({ data: provenance(s, "ServiceRequest", o.id, "lab-withdraw", now, { reason: reason.trim(), observations: rows.map((x) => x.id), specimen: sp?.number ?? null }) });
  if (rows.some((x) => v.everReleased.has(x.id) || v.callbacks.some((c) => c.observationId === x.id && c.outcome === "reached"))) {
    const cid = await deliverInApp(tx, s, target(v), { kind: "results-withdrawn", channel: "doctor_inbox", recipientUserId: o.orderedById, serviceRequestId: o.id, reportId: v.current?.id ?? null }, now);
    audit.push({ action: "create", entity: "Communication", entityId: cid, patientId: v.e.patientId, detail: { kind: "results-withdrawn", to: o.orderedById } });
  }
  return { encounterId: v.e.id, audit, dispatch };
}

/* ───── A10: verify, call-back, validate ───── */
async function checkPin(tx: Tx, s: SessionData, pin: string) {
  const u = await tx.user.findFirst({ where: { id: s.userId }, select: { pinHash: true } });
  await requirePin(s.userId, () => Boolean(u?.pinHash) && u!.pinHash === devHash(pin));
}
const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));
/** The rows to act on: exactly the ids given, all current lab results of this visit, and whole tests (every result of
    a test in the step's `from` state is included). */
function pick(v: Visit, ids: string[], from: DbObsStatus) {
  const rows = ids.map((id) => v.obs.find((x) => x.id === id));
  if (rows.some((x) => !x) || new Set(ids).size !== ids.length) throw stale();
  const orders = new Set(rows.map((x) => x!.serviceRequestId));
  if (v.obs.some((x) => orders.has(x.serviceRequestId) && x.status === from && !ids.includes(x.id)))
    throw err(409, "whole_test", "একটি পরীক্ষার সব ফলাফল একসাথে যাচাই করুন", "Verify or validate all results of a test together");
  return rows as Obs[];
}

export async function verifyResults(tx: Tx, s: SessionData, encounterId: string, body: VerifyRequest, now: Date) {
  requireLabRole(s, "verify");
  await checkPin(tx, s, body.pin); // a wrong PIN refuses everything (and counts as a try)
  const { b, v } = await visitFor(tx, s, encounterId, now);
  const rows = pick(v, body.observationIds, "preliminary");
  const facts = rows.map((o) => ({ id: o.id, status: dash<ResultState>(o.status), flag: o.interpretation as LabFlag | null, verifiedById: o.verifiedById, deltaHit: Boolean(resultOf(b, v, o).delta?.hit) }));
  const blockers = verifyBlockers({ role: s.role, results: facts, deltaChecked: body.deltaChecked });
  if (blockers.length) throw err(422, "verify_blocked", "যাচাই করা যাচ্ছে না", "Cannot verify yet", { blockers: blockers as unknown as Record<string, unknown>[] });
  for (const o of rows) {
    const to = transition("RESULT", RESULT, dash<ResultState>(o.status), "verify");
    const u = await tx.observation.updateMany({ where: { id: o.id, status: o.status }, data: { status: undash<DbObsStatus>(to) as "verified", verifiedById: s.userId, verifiedAt: now, statusAt: now } });
    if (u.count !== 1) throw stale();
  }
  await tx.provenance.create({ data: provenance(s, "Observation", rows[0]!.batchId, "lab-verify", now, { observations: rows.map((x) => x.id), deltaChecked: body.deltaChecked }) });
  return { encounterId: v.e.id, audit: [{ action: "verify", entity: "Observation", entityId: rows[0]!.id, patientId: v.e.patientId, detail: { observations: rows.map((x) => x.id), deltaChecked: body.deltaChecked } }] as AuditEntry[] };
}

export async function logCallback(tx: Tx, s: SessionData, observationId: string, body: CallbackRequest, now: Date) {
  requireLabRole(s, "callback");
  const { v, o } = await observationVisit(tx, s, observationId, now);
  if (!isCritical(o.interpretation as LabFlag)) throw err(409, "not_critical", "এটি জরুরি মান নয়", "This is not a critical result");
  if (o.status !== "preliminary" && o.status !== "verified") throw err(409, "not_open", "এই ফলাফল আর খোলা নেই", "This result is no longer open");
  const at = new Date(body.calledAt);
  const bad = callbackCheck({ outcome: body.outcome, recipientRole: body.recipientRole, recipientName: body.recipientName, at, via: body.via, readBack: body.readBack, now, enteredAt: o.recordedAt });
  if (bad.length) {
    const msg: Record<string, [string, string]> = {
      name_required: ["কাকে জানিয়েছেন তাঁর নাম লিখুন", "Write the name of the person informed"], time_future: ["সময় ভবিষ্যতে হতে পারে না", "The time cannot be in the future"],
      time_before_result: ["ফলাফল লেখার আগের সময় হতে পারে না", "The time cannot be before the result was entered"], read_back_required: ["মানটি পড়ে শোনানো নিশ্চিত করুন", "Confirm the value was read back"],
      read_back_without_answer: ["কাউকে না পেলে পড়ে শোনানো হয়নি", "No read-back when no one was reached"], recipient_role_invalid: ["কাকে জানিয়েছেন বেছে নিন", "Choose who was informed"], via_invalid: ["মাধ্যম বেছে নিন", "Choose how"],
    };
    const [bn, en] = msg[bad[0]!] ?? ["তথ্য ঠিক করুন", "Check the details"];
    throw err(400, bad[0]!, bn, en, { field: bad[0] === "name_required" ? "recipientName" : bad[0]!.startsWith("time") ? "calledAt" : bad[0]!.startsWith("read_back") ? "readBack" : "recipientRole" });
  }
  const c = await tx.criticalCallback.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, patientId: o.patientId, encounterId: o.encounterId, observationId: o.id, outcome: undash(body.outcome) as "reached" | "no_answer",
    recipientRole: body.recipientRole, recipientName: body.recipientName.trim(), via: body.via, calledAt: at, readBack: body.readBack, callerId: s.userId, recordedAt: now,
  } });
  return { encounterId: v.e.id, audit: [{ action: "create", entity: "CriticalCallback", entityId: c.id, patientId: o.patientId, detail: { observationId: o.id, outcome: body.outcome, recipientRole: body.recipientRole, via: body.via, readBack: body.readBack } }] as AuditEntry[] };
}

export async function validateResults(tx: Tx, s: SessionData, encounterId: string, body: ValidateRequest, now: Date) {
  requireLabRole(s, "validate");
  await checkPin(tx, s, body.pin);
  const { v } = await visitFor(tx, s, encounterId, now);
  const rows = pick(v, body.observationIds, "verified");
  const blockers = validateBlockers({
    role: s.role, userId: s.userId, samePersonAllowed: await samePersonHere(tx, s),
    results: rows.map((o) => ({ id: o.id, status: dash<ResultState>(o.status), flag: o.interpretation as LabFlag | null, verifiedById: o.verifiedById, deltaHit: false })),
    callbacks: v.callbacks.map((c) => ({ observationId: c.observationId, outcome: dash<"reached">(c.outcome), readBack: c.readBack })),
  });
  if (blockers.length) {
    const cb = blockers.some((x) => x.code === "callback_missing"), same = blockers.some((x) => x.code === "same_person");
    throw err(422, "validate_blocked",
      cb ? "জরুরি মান — আগে কল-ব্যাক লগ করুন" : same ? "যিনি যাচাই করেছেন তিনি এখানে অনুমোদন করতে পারেন না" : "অনুমোদন করা যাচ্ছে না",
      cb ? "Critical value: log the call-back first" : same ? "The person who verified cannot also validate here" : "Cannot validate yet",
      { blockers: blockers as unknown as Record<string, unknown>[] });
  }
  for (const o of rows) {
    const to = transition("RESULT", RESULT, dash<ResultState>(o.status), "validate");
    const u = await tx.observation.updateMany({ where: { id: o.id, status: o.status }, data: { status: undash<DbObsStatus>(to) as "final", validatedById: s.userId, validatedAt: now, statusAt: now } });
    if (u.count !== 1) throw stale();
  }
  await tx.provenance.create({ data: provenance(s, "Observation", rows[0]!.batchId, "lab-validate", now, { observations: rows.map((x) => x.id) }) });
  return { encounterId: v.e.id, audit: [{ action: "sign", entity: "Observation", entityId: rows[0]!.id, patientId: v.e.patientId, detail: { event: "validate", observations: rows.map((x) => x.id) } }] as AuditEntry[] };
}

/* ───── A10–A11: release (D3) ───── */
export async function releaseReport(tx: Tx, s: SessionData, encounterId: string, body: ReleaseRequest, now: Date) {
  requireLabRole(s, "release");
  const { v } = await visitFor(tx, s, encounterId, now);
  const p = v.plan;
  if (p.blockers.length)
    throw err(422, "release_blocked", p.blockers[0] === "nothing_new" ? "শেষ সংস্করণের পর নতুন কিছু অনুমোদিত হয়নি" : "প্রকাশের মতো অনুমোদিত কোনো পরীক্ষা নেই", p.blockers[0] === "nothing_new" ? "Nothing new has been validated since the last version" : "No validated test to release yet", { blockers: p.blockers.map((code) => ({ code })) });
  if (!sameSet(body.observationIds, p.observationIds)) throw stale(); // release exactly what the person saw
  const prev = v.current;
  const id = `rpt_${randomUUID()}`;
  const yy = dhakaDay(now).slice(2, 4);
  const number = prev?.number ?? v.reports[0]?.number ?? labReportNumber(yy, await nextNumber(tx, s, `labreport:${s.organizationId}:${yy}`));
  const audit: AuditEntry[] = [];
  if (prev) {
    const to = transition("LAB_REPORT", LAB_REPORT, dash<"final">(prev.status), "supersede");
    const u = await tx.diagnosticReport.updateMany({ where: { id: prev.id, status: prev.status }, data: { status: undash(to) as "superseded", supersededById: id } });
    if (u.count !== 1) throw stale();
    audit.push({ action: "update", entity: "DiagnosticReport", entityId: prev.id, patientId: v.e.patientId, detail: { event: "supersede", version: prev.version, by: id } });
  }
  await tx.diagnosticReport.create({ data: {
    id, tenantId: s.tenantId, organizationId: s.organizationId, branchId: v.e.branchId, patientId: v.e.patientId, encounterId: v.e.id, number, version: (prev?.version ?? 0) + 1,
    status: p.status, testCount: p.total, pendingCount: p.pending, replacesId: prev?.id ?? null, releasedById: s.userId, releasedAt: now,
  } });
  await tx.diagnosticReportResult.createMany({ data: p.observationIds.map((observationId) => ({ tenantId: s.tenantId, reportId: id, observationId, serviceRequestId: v.obs.find((x) => x.id === observationId)!.serviceRequestId! })) });
  // ORDER allFinal the first time a release includes the test (in progress → complete).
  for (const o of v.orders.filter((x) => p.orderIds.includes(x.id) && (x.status === "in_progress" || x.status === "partially_complete"))) {
    const to = transition("ORDER", ORDER, dash<OrderState>(o.status), "allFinal");
    const u = await tx.serviceRequest.updateMany({ where: { id: o.id, status: o.status }, data: { status: undash<DbOrder>(to), statusAt: now } });
    if (u.count !== 1) throw stale();
    audit.push({ action: "update", entity: "ServiceRequest", entityId: o.id, patientId: v.e.patientId, detail: { event: "allFinal", to } });
  }
  await tx.provenance.create({ data: provenance(s, "DiagnosticReport", id, "lab-release", now, { number, version: (prev?.version ?? 0) + 1, status: p.status, pending: p.pending, total: p.total }) });
  audit.push({ action: "create", entity: "DiagnosticReport", entityId: id, patientId: v.e.patientId, detail: { number, version: (prev?.version ?? 0) + 1, status: p.status, pending: p.pending, total: p.total, observations: p.observationIds } });
  // D6: the ordering doctor's inbox is told on every release (never waits for someone to press Send).
  const doctors = [...new Set(v.orders.filter((o) => o.status !== "revoked").map((o) => o.orderedById))];
  for (const d of doctors) {
    const cid = await deliverInApp(tx, s, target(v), { kind: "report-inbox", channel: "doctor_inbox", recipientUserId: d, reportId: id }, now);
    audit.push({ action: "create", entity: "Communication", entityId: cid, patientId: v.e.patientId, detail: { kind: "report-inbox", to: d, reportId: id } });
  }
  return { encounterId: v.e.id, reportId: id, audit };
}

/* ───── A11: delivery ───── */
async function reportHere(tx: Tx, s: SessionData, reportId: string, now: Date) {
  const r0 = await tx.diagnosticReport.findFirst({ where: { id: reportId, organizationId: s.organizationId }, select: { encounterId: true } });
  if (!r0) throw notFound();
  const { b, v } = await visitFor(tx, s, r0.encounterId, now);
  const r = v.reports.find((x) => x.id === reportId);
  if (!r) throw notFound();
  return { b, v, r };
}
export async function sendReport(tx: Tx, s: SessionData, reportId: string, channel: "sms" | "patient-app", now: Date) {
  requireLabRole(s, "deliver");
  const { v, r } = await reportHere(tx, s, reportId, now);
  if (r.status === "superseded") throw err(409, "superseded", "এই সংস্করণ বদলে গেছে — নতুন সংস্করণ পাঠান", "This version was replaced — send the new version");
  const kind = channel === "sms" ? "report-ready" : "report-app";
  if (v.comms.some((c) => c.reportId === r.id && c.kind === kind && c.status !== "failed"))
    throw err(409, "already_sent", "এই সংস্করণ এই মাধ্যমে আগেই পাঠানো হয়েছে", "This version was already sent this way");
  if (v.comms.some((c) => c.reportId === r.id && c.kind === kind && c.status === "failed"))
    throw err(409, "retry_instead", "পাঠানো ব্যর্থ হয়েছিল — আবার চেষ্টা করুন", "That send failed — retry it");
  if (channel === "sms") {
    const id = await queueSms(tx, s, v, "report-ready", { reportId: r.id });
    if (!id) throw err(422, "no_mobile", "রোগীর সঠিক মোবাইল নম্বর নেই — কাউন্টারে জানান", "The patient has no valid mobile number — tell them at the counter");
    return { encounterId: v.e.id, dispatch: [id], audit: [{ action: "create", entity: "Communication", entityId: id, patientId: v.e.patientId, detail: { kind, channel, reportId: r.id, version: r.version } }] as AuditEntry[] };
  }
  const id = await deliverInApp(tx, s, target(v), { kind, channel: "patient_app", reportId: r.id }, now);
  return { encounterId: v.e.id, dispatch: [] as string[], audit: [{ action: "create", entity: "Communication", entityId: id, patientId: v.e.patientId, detail: { kind, channel, reportId: r.id, version: r.version } }] as AuditEntry[] };
}
export async function retryMessage(tx: Tx, s: SessionData, communicationId: string, now: Date, acceptDuplicate = false) {
  requireLabRole(s, "deliver");
  const c0 = await tx.communication.findFirst({ where: { id: communicationId, organizationId: s.organizationId } });
  if (!c0 || !c0.encounterId) throw notFound();
  const { v } = await visitFor(tx, s, c0.encounterId, now);
  const c = v.comms.find((x) => x.id === communicationId);
  if (!c) throw notFound();
  if (c.reportId && v.reports.find((x) => x.id === c.reportId)?.status === "superseded")
    throw err(409, "superseded", "এই সংস্করণ বদলে গেছে — নতুন সংস্করণ পাঠান", "This version was replaced — send the new version");
  if (c.channel !== "sms") throw err(409, "not_retryable", "এই মাধ্যম আবার পাঠানো যায় না", "This channel cannot be retried");
  // ADR 0012: the patient may already have it — never sent again without the person saying so
  const mayHaveIt = (c.status === "completed" && !c.deliveryConfirmed) || c.status === "in_progress" || (c.status === "failed" && c.lastError === SMS_MAYBE_SENT);
  if (mayHaveIt && !acceptDuplicate) throw err(409, "confirm_duplicate", "রোগী হয়তো এই SMS আগেই পেয়েছেন — আবার পাঠালে দুবার পেতে পারেন", "The patient may already have this SMS — sending again may give it twice");
  const audit = (event: string, id: string) => [{ action: "update", entity: "Communication", entityId: id, patientId: v.e.patientId, detail: { event, kind: c.kind, attempts: c.attempts, ...(mayHaveIt ? { duplicateRiskAccepted: true } : {}) } }] as AuditEntry[];
  if (c.status === "completed") {
    // "Sent" without a delivery report: a new message with the same words (a gateway cannot recognise a resend)
    if (c.deliveryConfirmed) throw err(409, "invalid_transition", "এই SMS পৌঁছেছে", "This SMS was delivered");
    const to = smsPhone(v.e.patient.phone);
    if (!to) throw err(422, "no_phone", "রোগীর মোবাইল নম্বর নেই", "The patient has no mobile number");
    const id = `com_${randomUUID()}`;
    await tx.communication.create({ data: { id, tenantId: s.tenantId, organizationId: s.organizationId, patientId: c.patientId, encounterId: c.encounterId, kind: c.kind, channel: "sms",
      toPhone: to, templateKey: c.templateKey, text: c.text, reportId: c.reportId, specimenId: c.specimenId, createdById: s.userId } });
    return { encounterId: v.e.id, dispatch: [id], audit: audit("send-again", id) };
  }
  // A failed message is re-queued (same id). One that was queued or in progress for too long (the send was
  // interrupted) is sent again too: in progress → failed ("it may have been sent") → re-queued.
  const age = now.getTime() - (c.sentAt ?? c.createdAt).getTime();
  if (c.status === "preparation") { if (age < STUCK_QUEUED_MS) throw err(409, "still_sending", "পাঠানো হচ্ছে — একটু পরে দেখুন", "Still sending — check again shortly"); }
  else {
    let from = dash<"failed" | "in-progress">(c.status);
    if (from === "in-progress") {
      if (age < STUCK_SENDING_MS) throw err(409, "still_sending", "পাঠানো হচ্ছে — একটু পরে দেখুন", "Still sending — check again shortly");
      const failed = transition("COMMUNICATION", COMMUNICATION, "in-progress", "fail");
      const f = await tx.communication.updateMany({ where: { id: c.id, status: c.status }, data: { status: undash(failed) as "failed", lastError: SMS_MAYBE_SENT, statusAt: now } });
      if (f.count !== 1) throw stale();
      from = "failed";
    }
    const to = transition("COMMUNICATION", COMMUNICATION, from as "failed", "retry");
    const u = await tx.communication.updateMany({ where: { id: c.id, status: undash(from) as "failed" }, data: { status: undash(to) as "preparation", statusAt: now } });
    if (u.count !== 1) throw stale();
  }
  return { encounterId: v.e.id, dispatch: [c.id], audit: audit("retry", c.id) };
}

/** One released version as released (D3), with results later put under correction marked. */
export async function labReportView(tx: Tx, s: SessionData, reportId: string, now = new Date()): Promise<LabReportView> {
  const r0 = await tx.diagnosticReport.findFirst({ where: { id: reportId, organizationId: s.organizationId }, select: { encounterId: true } });
  if (!r0) throw notFound();
  // no earlier results here (no delta on a released version), so the report view reveals nothing beyond the visit
  const b = await loadBundle(tx, s, [r0.encounterId], false);
  const e = b.encounters[0];
  if (!e) throw notFound();
  const v = visitOf(b, e, now);
  const r = v.reports.find((x) => x.id === reportId)!;
  const inThis = new Set(r.results.map((x) => x.observationId));
  const tests = v.orders.filter((o) => r.results.some((x) => x.serviceRequestId === o.id)).map((o) => {
    const results = v.obs.filter((x) => inThis.has(x.id) && x.serviceRequestId === o.id).map((x) => ({ ...resultOf(b, v, x), underCorrection: x.status === "entered_in_error" }));
    return { orderId: o.id, testCode: o.testCode, nameEn: o.nameEn, nameBn: o.nameBn, withdrawn: results.length > 0 && results.every((x) => x.withdrawn), results };
  });
  const pendingTests = v.orders.filter((o) => o.status !== "revoked" && !r.results.some((x) => x.serviceRequestId === o.id)).map((o) => ({ orderId: o.id, nameEn: o.nameEn, nameBn: o.nameBn }));
  const { phone: _p, ...patient } = patientOf(v);
  return { report: reportSummary(b, r), encounter: encounterOf(e), patient, tests, pendingTests, deliveries: v.comms.filter((c) => c.reportId === r.id).map((c) => commOf(b, v, c)) };
}

/* ───── ORDER revoke (D5, decision 99) ───── */
export async function revokeOrder(tx: Tx, s: SessionData, orderId: string, reason: string, now: Date) {
  const o0 = await tx.serviceRequest.findFirst({ where: { id: orderId, organizationId: s.organizationId } });
  if (!o0) throw notFound();
  // security review M1: the lab cancels lab tests only (imaging and other orders are the doctor's)
  if (s.role !== "doctor" && o0.group !== "lab") throw err(403, "forbidden", "ল্যাব শুধু ল্যাবের পরীক্ষা বাতিল করতে পারে", "The lab can cancel lab tests only", { reason: "role", canRequest: false });
  const branch = await branchOf(tx, s);
  if (o0.branchId !== branch.id) throw notFound();
  await tx.$queryRaw`SELECT 1 FROM "Encounter" WHERE "id" = ${o0.encounterId} FOR UPDATE`;
  const o = (await tx.serviceRequest.findFirst({ where: { id: orderId } }))!;
  // A placed tube that was collected moved the order to in-progress (ORDER collect): revoke is refused from there.
  const bad = revokeBlockers({ orderStatus: dash<OrderState>(o.status), role: s.role, userId: s.userId, orderedById: o.orderedById, reason });
  if (bad.includes("role") || bad.includes("not_ordering_doctor"))
    throw err(403, "forbidden", bad.includes("role") ? "এই কাজটি আপনার ভূমিকায় নেই" : "শুধু যিনি অর্ডার দিয়েছেন সেই ডাক্তার বাতিল করতে পারেন", bad.includes("role") ? "Your role cannot do this" : "Only the doctor who ordered it can cancel it", { reason: "role", canRequest: false });
  if (bad.includes("collected")) throw err(409, "collected", "নমুনা নেওয়া হয়ে গেছে — বাতিল নয়, নমুনা বাতিল করুন", "A sample was already collected — reject the sample instead of cancelling");
  if (bad.includes("already_revoked")) throw err(409, "already_revoked", "এই অর্ডার আগেই বাতিল", "This order is already cancelled");
  if (bad.includes("not_placed") || bad.includes("not_cancellable")) throw err(409, "not_cancellable", "এই অর্ডার বাতিল করা যায় না", "This order cannot be cancelled");
  if (bad.includes("reason_required")) throw err(400, "reason_required", "কারণ লিখুন (অন্তত ১০ অক্ষর)", "Give a reason (at least 10 characters)", { field: "reason" });
  const to = transition("ORDER", ORDER, dash<OrderState>(o.status), "revoke");
  const u = await tx.serviceRequest.updateMany({ where: { id: o.id, status: o.status }, data: { status: undash(to) as "revoked", statusAt: now, revokedById: s.userId, revokedAt: now, revokeReason: reason.trim() } });
  if (u.count !== 1) throw stale();
  await tx.provenance.create({ data: provenance(s, "ServiceRequest", o.id, "order-revoke", now, { reason: reason.trim() }) });
  const audit: AuditEntry[] = [{ action: "update", entity: "ServiceRequest", entityId: o.id, patientId: o.patientId, detail: { event: "revoke", from: dash(o.status), to, reason: reason.trim(), testCode: o.testCode } }];
  // ADR 0017: an inpatient's revoked order leaves the running bill by a credit line
  if (o.encounterId) audit.push(...await syncForEncounter(tx, s, o.encounterId, now, "order-revoked"));
  // A cancellation by the lab tells the ordering doctor (their inbox).
  if (s.role !== "doctor" && o.group === "lab") {
    const cid = await deliverInApp(tx, s, { patientId: o.patientId, encounterId: o.encounterId }, { kind: "order-cancelled", channel: "doctor_inbox", recipientUserId: o.orderedById, serviceRequestId: o.id }, now);
    audit.push({ action: "create", entity: "Communication", entityId: cid, patientId: o.patientId, detail: { kind: "order-cancelled", to: o.orderedById } });
  }
  const bill = await refreshDraftOrders(tx, s, o.encounterId);
  if (bill && (bill.removed.length || bill.added.length))
    audit.push({ action: "update", entity: "Invoice", entityId: bill.invoiceId, patientId: o.patientId, detail: { event: "refresh-orders", removed: bill.removed, added: bill.added, by: "order-revoke" } });
  const by = await tx.user.findFirst({ where: { id: s.userId }, select: { id: true, nameBn: true, nameEn: true } });
  return {
    body: { order: { id: o.id, status: to, revoke: { by: by ?? { id: s.userId, nameBn: s.nameBn, nameEn: s.nameEn }, at: now.toISOString(), reason: reason.trim() } }, bill },
    patientId: o.patientId, audit,
  };
}
