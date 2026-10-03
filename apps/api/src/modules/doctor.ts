/* The doctor's inbox (walkthrough A12, ADR 0007): doctor-inbox Communication rows sent to the signed-in doctor at this
   facility — released lab reports, the lab's notices (correction, results withdrawn, test cancelled) and critical vital
   signs — ordered critical first (@setu/domain sortInbox). Acknowledging writes an append-only InboxAck (INBOX_ITEM
   unread → acknowledged); "Seen + tell patient" queues the report-reviewed SMS in the same transaction and the route
   sends it after the commit (decision D1). */
import { randomUUID } from "node:crypto";
import type { AckRequest, InboxItem, InboxView } from "@setu/contracts";
import type { Tx } from "@setu/db";
import { INBOX_ITEM, ackBlockers, inboxSeverity, patientAgeYears, sortInbox, transition, type InboxKind, type Interpretation } from "@setu/domain";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { notFound } from "./frontdesk.js";
import { smsPhone, smsText } from "./lab.js";

const dash = <T extends string>(s: string) => s.replace(/_/g, "-") as T;
type RangeLabel = "adult" | "adult-female" | "adult-male";
const INBOX_KINDS: InboxKind[] = ["report-inbox", "correction-notice", "results-withdrawn", "order-cancelled", "critical-vital"];
const MAX_ITEMS = 200;

function requireDoctor(s: SessionData) {
  if (s.role !== "doctor") throw err(403, "forbidden", "এই কাজটি আপনার ভূমিকায় নেই", "Your role cannot do this", { reason: "role", canRequest: false });
}

type Row = Awaited<ReturnType<typeof loadRows>>[number];
async function loadRows(tx: Tx, s: SessionData, where: { id?: string; since?: Date }) {
  return tx.communication.findMany({
    where: { channel: "doctor_inbox", recipientUserId: s.userId, organizationId: s.organizationId, kind: { in: INBOX_KINDS }, ...(where.id ? { id: where.id } : {}), ...(where.since ? { createdAt: { gte: where.since } } : {}) },
    include: { ack: true }, orderBy: { createdAt: "desc" }, take: MAX_ITEMS,
  });
}

/** Builds the items with one query per related table (no per-row round trips). */
async function toItems(tx: Tx, s: SessionData, rows: Row[], now: Date): Promise<InboxItem[]> {
  const ids = <K extends keyof Row>(k: K) => [...new Set(rows.map((r) => r[k]).filter((x): x is NonNullable<Row[K]> => x != null))] as string[];
  const [patients, encounters, reports, orders, obs, org] = await Promise.all([
    tx.patient.findMany({ where: { id: { in: ids("patientId") } } }),
    tx.encounter.findMany({ where: { id: { in: ids("encounterId") } }, select: { id: true, token: true } }),
    tx.diagnosticReport.findMany({ where: { id: { in: ids("reportId") } }, include: { results: true } }),
    tx.serviceRequest.findMany({ where: { id: { in: ids("serviceRequestId") } }, select: { id: true, nameEn: true, nameBn: true } }),
    tx.observation.findMany({ where: { id: { in: ids("observationId") } } }),
    tx.organization.findFirst({ where: { id: s.organizationId }, select: { name: true } }),
  ]);
  const reportObsIds = reports.flatMap((r) => r.results.map((x) => x.observationId));
  const [reportObs, analytes, smsRows] = await Promise.all([
    tx.observation.findMany({ where: { id: { in: reportObsIds } } }),
    tx.labAnalyte.findMany({ select: { code: true, nameEn: true, nameBn: true, decimals: true } }),
    tx.communication.findMany({ where: { id: { in: rows.map((r) => r.ack?.notifyCommunicationId).filter((x): x is string => !!x) } }, select: { id: true, status: true, lastError: true } }),
  ]);
  const P = new Map(patients.map((p) => [p.id, p])), E = new Map(encounters.map((e) => [e.id, e])), R = new Map(reports.map((r) => [r.id, r]));
  const O = new Map(orders.map((o) => [o.id, o])), V = new Map([...obs, ...reportObs].map((o) => [o.id, o])), A = new Map(analytes.map((a) => [a.code, a])), S = new Map(smsRows.map((m) => [m.id, m]));

  return rows.map((c): InboxItem => {
    const kind = c.kind as InboxKind;
    const p = P.get(c.patientId)!;
    const r = c.reportId ? R.get(c.reportId) ?? null : null;
    const results = r ? r.results.map((x) => V.get(x.observationId)).filter((o): o is NonNullable<typeof o> => !!o).map((o) => {
      const a = A.get(o.code);
      return { code: o.code, nameEn: a?.nameEn ?? o.code, nameBn: a?.nameBn ?? o.code, value: o.value, unit: o.unit, decimals: a?.decimals ?? 1,
        flag: (o.interpretation ?? null) as Interpretation | null, refLow: o.refLow, refHigh: o.refHigh, refLabel: (o.refLabel ?? null) as RangeLabel | null,
        underCorrection: o.status === "entered_in_error" };
    }) : [];
    const vObs = kind === "critical-vital" && c.observationId ? V.get(c.observationId) ?? null : null;
    const order = c.serviceRequestId ? O.get(c.serviceRequestId) ?? null : null;
    const hasMobile = smsPhone(p.phone) !== null;
    const superseded = !!r?.supersededById;
    const sms = c.ack?.notifyCommunicationId ? S.get(c.ack.notifyCommunicationId) ?? null : null;
    return {
      id: c.id, kind, at: c.createdAt.toISOString(),
      // a report is graded by the results it released that still stand (a value under correction does not count)
      severity: inboxSeverity(kind, results.filter((x) => !x.underCorrection).map((x) => x.flag)),
      patient: { id: p.id, facilityNo: p.facilityNo, nameBn: p.nameBn, nameEn: p.nameEn, sex: p.sex,
        ageYears: patientAgeYears({ birthDate: p.birthDate ? p.birthDate.toISOString().slice(0, 10) : null, approxAgeYears: p.approxAgeYears, approxAgeAt: p.approxAgeAt?.toISOString() ?? null }, now), hasMobile },
      encounter: { id: c.encounterId ?? "", token: c.encounterId ? E.get(c.encounterId)?.token ?? null : null, facilityEn: org?.name ?? "" },
      report: r ? { id: r.id, number: r.number, version: r.version, status: r.status, superseded, testCount: r.testCount, pendingCount: r.pendingCount, results } : null,
      test: order ? { nameEn: order.nameEn, nameBn: order.nameBn } : null,
      vital: vObs ? { code: vObs.code, value: vObs.value, unit: vObs.unit, flag: (vObs.interpretation ?? null) as Interpretation | null } : null,
      acknowledged: c.ack ? { at: c.ack.ackedAt.toISOString(), notifyPatient: c.ack.notifyPatient, sms: sms ? { id: sms.id, status: dash(sms.status), lastError: sms.lastError } : null } : null,
      canNotify: kind === "report-inbox" && !superseded && hasMobile && !c.ack,
    };
  });
}

export async function inboxView(tx: Tx, s: SessionData, days: number, now: Date): Promise<{ view: InboxView; audit: AuditEntry[] }> {
  requireDoctor(s);
  const rows = await loadRows(tx, s, { since: new Date(now.getTime() - days * 864e5) });
  const built = await toItems(tx, s, rows, now);
  const items = sortInbox(built.map((x) => ({ x, severity: x.severity, at: x.at, acknowledged: !!x.acknowledged }))).map((w) => w.x);
  const unread = items.filter((x) => !x.acknowledged);
  return {
    view: { items, counts: { unread: unread.length, critical: unread.filter((x) => x.severity === "critical").length } },
    audit: [{ action: "view", entity: "Communication", detail: { purpose: "doctor-inbox", count: items.length, patientIds: [...new Set(items.map((x) => x.patient.id))] } }],
  };
}

export async function acknowledge(tx: Tx, s: SessionData, id: string, req: AckRequest, now: Date): Promise<{ item: InboxItem; dispatch: string[]; audit: AuditEntry[] }> {
  requireDoctor(s);
  // Lock the item's row: two acknowledgements at the same moment are serialised (the unique InboxAck is the backstop).
  await tx.$executeRaw`SELECT 1 FROM "Communication" WHERE "id" = ${id} FOR UPDATE`;
  const [c] = await loadRows(tx, s, { id });
  if (!c) {
    // not this doctor's (or not at this facility): never reveal whether it exists
    throw notFound();
  }
  const [before] = await toItems(tx, s, [c], now);
  const blockers = ackBlockers({ isRecipient: c.recipientUserId === s.userId, acknowledged: !!c.ack, superseded: !!before!.report?.superseded, kind: c.kind as InboxKind, notifyPatient: req.notifyPatient, patientHasMobile: before!.patient.hasMobile });
  if (blockers.includes("already_acknowledged")) throw err(409, "already_acknowledged", "আগেই দেখা হয়েছে", "Already acknowledged");
  if (blockers.includes("superseded")) throw err(409, "superseded", "এই রিপোর্টের নতুন সংস্করণ আছে — সেটি দেখুন", "A newer version of this report exists — open that one");
  if (blockers.includes("notify_not_for_kind")) throw err(422, "notify_not_for_kind", "শুধু প্রকাশিত রিপোর্টের জন্য রোগীকে জানানো যায়", "Only a released report can be sent to the patient", { field: "notifyPatient" });
  if (blockers.includes("no_mobile")) throw err(422, "no_mobile", "রোগীর মোবাইল নম্বর নেই", "The patient has no mobile number on record", { field: "notifyPatient" });
  transition("INBOX_ITEM", INBOX_ITEM, "unread", "acknowledge");

  let smsId: string | null = null;
  if (req.notifyPatient) {
    const p = await tx.patient.findFirst({ where: { id: c.patientId }, select: { phone: true } });
    const { templateKey, text } = await smsText(tx, s, "report-reviewed");
    smsId = `com_${randomUUID()}`;
    await tx.communication.create({ data: {
      id: smsId, tenantId: s.tenantId, organizationId: s.organizationId, patientId: c.patientId, encounterId: c.encounterId, kind: "report-reviewed", channel: "sms",
      toPhone: smsPhone(p?.phone)!, templateKey, text, reportId: c.reportId, createdById: s.userId,
    } });
  }
  await tx.inboxAck.create({ data: { tenantId: s.tenantId, communicationId: c.id, ackedById: s.userId, ackedAt: now, notifyPatient: req.notifyPatient, notifyCommunicationId: smsId } });
  const [after] = await loadRows(tx, s, { id });
  const [item] = await toItems(tx, s, [after!], now);
  return {
    item: item!, dispatch: smsId ? [smsId] : [],
    audit: [{ action: "acknowledge", entity: "Communication", entityId: c.id, patientId: c.patientId, detail: { kind: c.kind, reportId: c.reportId, notifyPatient: req.notifyPatient, sms: smsId } }],
  };
}
