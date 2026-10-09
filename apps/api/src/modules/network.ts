/* ADR 0021 — the consent-checked read service: the ONLY path from one tenant into another. A doctor at the receiving
   facility reads a patient's shared records: the share is loaded in the reader's own tenant (row-level security: shares
   given to it), @setu/domain shareCovers decides each item, the owner facility's rows are read inside ITS tenant
   (forTenant), and every read is audited in both tenants and recorded as an open the patient sees. Journey E extends
   this service (policy reads, access requests). */
import { randomUUID } from "node:crypto";
import type { AccessRequestCreate, AccessRequestView, NetworkHistory, SharedList, SharedRecords, SharedReportView } from "@setu/contracts";
import {
  ACCESS_REQUEST_WAIT_DAYS, accessRequestProblems, isActiveProblem, isCurrentMedicine, isSensitiveCondition, isSensitiveMedicine, newestPerKey, patientAgeYears,
  shareCovers, shareStatusAt, type ConsentState, type LinkedRecord, type ShareFacts, type ShareItem,
} from "@setu/domain";
import type { Tx } from "@setu/db";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { copyPdf } from "./documents.js";
import { smsPhone, smsText } from "./lab.js";
import { itemFacts, recordsIn, reportCodes, reportIn, trendIn, withTrend } from "./records.js";

type Consent = Awaited<ReturnType<Tx["consent"]["findFirstOrThrow"]>>;
const facts = (c: Consent): ShareFacts => ({
  status: c.status as ConsentState, endsAt: c.endsAt, granteeTenantId: c.granteeTenantId, granteeUserId: c.granteeUserId,
  scope: c.scope === "all" ? { kind: "all" } : c.scope === "visit" ? { kind: "visit", tenantId: c.scopeTenantId!, patientId: c.scopePatientId!, encounterId: c.scopeRecordId! } : { kind: "report", tenantId: c.scopeTenantId!, patientId: c.scopePatientId!, reportId: c.scopeRecordId! },
  kinds: c.kinds as ShareItem["kind"][], hideSensitive: c.basis === "patient-request",
});
/** ADR 0023: the visits of this record carrying a sensitive condition or medicine (sample list) — any note, signed or
    not: everything of such a visit is left out of what another clinic sees by policy or by a request's consent */
export async function sensitiveVisits(tx: Tx, patientId: string): Promise<Set<string>> {
  const [conds, meds] = await Promise.all([
    tx.condition.findMany({ where: { patientId, composition: { status: { not: "entered_in_error" } } }, select: { code: true, encounterId: true } }),
    tx.medicationRequest.findMany({ where: { patientId, composition: { status: { not: "entered_in_error" } } }, select: { classes: true, encounterId: true } }),
  ]);
  return new Set([...conds.filter((c) => isSensitiveCondition(c.code)).map((c) => c.encounterId), ...meds.filter((m) => isSensitiveMedicine(m.classes)).map((m) => m.encounterId)]);
}
const REFUSED: Record<string, [string, string]> = {
  expired: ["এই শেয়ারের মেয়াদ শেষ", "This share has ended"],
  revoked: ["রোগী শেয়ার বন্ধ করেছেন", "The patient stopped sharing"],
  "out-of-scope": ["রোগী এটি শেয়ার করেননি", "The patient did not share this"],
  "not-grantee": ["এই শেয়ার আপনার জন্য নয়", "This share is not for you"],
};
const refused = (reason: string) => err(403, "share_refused", REFUSED[reason]![0], REFUSED[reason]![1], { reason, canRequest: false });

/** the patient's linked records (SECURITY DEFINER: ids and states only) */
async function linkedOf(personId: string): Promise<LinkedRecord[]> {
  const { personClaims } = await import("@setu/db");
  return (await personClaims(personId)).filter((c) => c.status === "linked" && c.patientId).map((c) => ({ tenantId: c.tenantId, patientId: c.patientId! }));
}
/** the share, if it is for this reader at all (named doctor, or a facility share and the reader is a doctor there) */
async function shareFor(tx: Tx, s: SessionData, consentId: string, now: Date) {
  const c = await tx.consent.findFirst({ where: { id: consentId, granteeTenantId: s.tenantId } });
  if (!c || c.granteeOrganizationId !== s.organizationId) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
  if (c.granteeUserId ? c.granteeUserId !== s.userId : s.role !== "doctor") throw refused("not-grantee");
  const st = shareStatusAt({ status: c.status as ConsentState, endsAt: c.endsAt }, now);
  if (st !== "active") throw refused(st === "revoked" ? "revoked" : "expired");
  return c;
}
async function reader(tx: Tx, s: SessionData) {
  const [u, o] = await Promise.all([
    tx.user.findFirst({ where: { id: s.userId }, select: { nameEn: true, nameBn: true } }),
    tx.organization.findFirst({ where: { id: s.organizationId }, select: { name: true, nameBn: true } }),
  ]);
  return { nameEn: u?.nameEn ?? s.nameEn, nameBn: u?.nameBn ?? s.nameBn, role: s.role, facilityEn: o?.name ?? s.organizationName, facilityBn: o?.nameBn ?? null };
}
/** the owner facility's audit row for a read through a share (basis patient-share; the reader's names, who live in another tenant) */
const ownerAudit = (tx: Tx, ownerTenantId: string, s: SessionData, who: Awaited<ReturnType<typeof reader>>, a: { action: string; entity: string; entityId: string; patientId: string; consentId: string; detail?: object }) =>
  tx.auditEvent.create({ data: { tenantId: ownerTenantId, userId: s.userId, role: s.role, action: a.action, entity: a.entity, entityId: a.entityId, patientId: a.patientId, basis: "patient-share",
    detail: { consentId: a.consentId, reader: who, readerTenantId: s.tenantId, ...(a.detail ?? {}) } as object } });
/** the patient's "who opened it and when" */
const recordOpen = (tx: Tx, c: Consent, s: SessionData, who: Awaited<ReturnType<typeof reader>>, ownerTenantId: string, itemKind: string, itemId: string, now: Date) =>
  tx.consentAccess.create({ data: { consentId: c.id, personId: c.personId, granteeTenantId: s.tenantId, userId: s.userId, userNameEn: who.nameEn, userNameBn: who.nameBn, role: s.role, facilityEn: who.facilityEn, facilityBn: who.facilityBn, ownerTenantId, itemKind, itemId, at: now } });

async function patientCard(tx: Tx, patientId: string, now: Date) {
  const p = await tx.patient.findFirst({ where: { id: patientId }, select: { nameEn: true, nameBn: true, sex: true, birthDate: true, approxAgeYears: true, approxAgeAt: true } });
  if (!p) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
  return { nameEn: p.nameEn ?? p.nameBn, nameBn: p.nameBn, sex: p.sex as string, ageYears: patientAgeYears({ birthDate: p.birthDate?.toISOString().slice(0, 10) ?? null, approxAgeYears: p.approxAgeYears, approxAgeAt: p.approxAgeAt?.toISOString() ?? null }, now) };
}
/** whose name the share shows: the record it names, or the first linked one */
const anchorOf = (c: Consent, linked: LinkedRecord[]) => (c.scope === "all" ? linked[0] : { tenantId: c.scopeTenantId!, patientId: c.scopePatientId! });

/* "Shared with you": active shares to this doctor or (for doctors) to this facility */
export async function sharedList(tx: Tx, s: SessionData, now = new Date()): Promise<{ body: SharedList; audit: AuditEntry[] }> {
  const rows = await tx.consent.findMany({ where: { granteeTenantId: s.tenantId, granteeOrganizationId: s.organizationId, status: "active", endsAt: { gt: now },
    ...(s.role === "doctor" ? { OR: [{ granteeUserId: s.userId }, { granteeUserId: null }] } : { granteeUserId: s.userId }) }, orderBy: { createdAt: "desc" } });
  const { forTenant } = await import("@setu/db");
  const who = await reader(tx, s);
  const items: SharedList["items"] = [];
  for (const c of rows) {
    const a = anchorOf(c, await linkedOf(c.personId));
    if (!a) continue;
    const patient = await forTenant(a.tenantId, async (o) => {
      const card = await patientCard(o, a.patientId, now);
      await ownerAudit(o, a.tenantId, s, who, { action: "view", entity: "Patient", entityId: a.patientId, patientId: a.patientId, consentId: c.id, detail: { purpose: "shared-list" } });
      return card;
    });
    items.push({ consentId: c.id, patient, scope: { kind: c.scope, facilityEn: c.scopeFacilityEn, facilityBn: c.scopeFacilityBn, number: c.scopeNumber, at: c.scopeAt?.toISOString() ?? null }, toMe: c.granteeUserId === s.userId, startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString(), kinds: c.kinds });
  }
  return { body: { items }, audit: [{ action: "view", entity: "Consent", basis: "patient-share", detail: { purpose: "shared-list", count: items.length } }] };
}

/* the records a share covers, newest first */
export async function sharedRecords(tx: Tx, s: SessionData, consentId: string, now = new Date()): Promise<{ body: SharedRecords; audit: AuditEntry[] }> {
  const c = await shareFor(tx, s, consentId, now);
  const linked = await linkedOf(c.personId);
  const f = facts(c);
  const tenants = c.scope === "all" ? linked : linked.filter((l) => l.tenantId === c.scopeTenantId && l.patientId === c.scopePatientId);
  const { forTenant } = await import("@setu/db");
  const who = await reader(tx, s);
  const items: SharedRecords["items"] = [];
  for (const l of tenants) {
    const got = await forTenant(l.tenantId, async (o) => {
      const out: SharedRecords["items"] = [];
      const hidden = f.hideSensitive ? await sensitiveVisits(o, l.patientId) : new Set<string>();
      for (const r of await recordsIn(o, l.patientId)) {
        const item: ShareItem = { tenantId: l.tenantId, patientId: l.patientId, kind: r.kind, id: r.recordId, encounterId: r.encounterId, sensitive: r.encounterId !== null && hidden.has(r.encounterId),
          ...(r.kind === "report" ? { reportChain: (await itemFacts(o, l.patientId, "report", r.recordId))?.reportChain ?? [r.recordId] } : {}) };
        if (shareCovers(f, { tenantId: s.tenantId, userId: s.userId }, item, linked, now).ok) out.push({ ...r, ownerTenantId: l.tenantId });
      }
      await ownerAudit(o, l.tenantId, s, who, { action: "view", entity: "Patient", entityId: l.patientId, patientId: l.patientId, consentId: c.id, detail: { purpose: "shared-records", count: out.length } });
      return out;
    });
    items.push(...got);
  }
  await recordOpen(tx, c, s, who, tenants[0]?.tenantId ?? c.granteeTenantId, "records", c.id, now);
  const a = anchorOf(c, linked);
  const patient = a ? await forTenant(a.tenantId, (o) => patientCard(o, a.patientId, now)) : { nameEn: "", nameBn: "", sex: "unknown", ageYears: null };
  items.sort((x, y) => y.at.localeCompare(x.at));
  return { body: { consentId: c.id, patient, endsAt: c.endsAt.toISOString(), items }, audit: [{ action: "view", entity: "Consent", entityId: c.id, basis: "patient-share", detail: { purpose: "shared-records", count: items.length } }] };
}

/** one shared item, checked: the owner tenant's patient behind it and its share facts */
async function checkedItem(c: Consent, s: SessionData, linked: LinkedRecord[], ownerTenantId: string, kind: "report" | "prescription" | "summary", id: string, now: Date) {
  const { forTenant } = await import("@setu/db");
  const l = linked.find((x) => x.tenantId === ownerTenantId);
  if (!l) throw refused("out-of-scope");
  const sf = facts(c);
  const f = await forTenant(ownerTenantId, async (o) => {
    const x = await itemFacts(o, l.patientId, kind, id);
    return x && { ...x, sensitive: sf.hideSensitive ? (await sensitiveVisits(o, l.patientId)).has(x.encounterId) : false };
  });
  if (!f) throw refused("out-of-scope");
  const ok = shareCovers(sf, { tenantId: s.tenantId, userId: s.userId }, { tenantId: ownerTenantId, patientId: l.patientId, kind, id, encounterId: f.encounterId, reportChain: f.reportChain, sensitive: f.sensitive }, linked, now);
  if (!ok.ok) throw refused(ok.reason);
  return l;
}

export async function sharedReport(tx: Tx, s: SessionData, consentId: string, ownerTenantId: string, reportId: string, now = new Date()): Promise<{ body: SharedReportView; audit: AuditEntry[] }> {
  const c = await shareFor(tx, s, consentId, now);
  const linked = await linkedOf(c.personId);
  const l = await checkedItem(c, s, linked, ownerTenantId, "report", reportId, now);
  const { forTenant } = await import("@setu/db");
  const who = await reader(tx, s);
  const core = await forTenant(ownerTenantId, async (o) => {
    const r = await reportIn(o, l.patientId, reportId);
    await ownerAudit(o, ownerTenantId, s, who, { action: "view", entity: "DiagnosticReport", entityId: reportId, patientId: l.patientId, consentId: c.id, detail: { number: r.report.number, version: r.report.version } });
    return r;
  });
  // the trend reveals earlier results: only a share of "all" shows them; a visit or report share shows this report only
  const points = [];
  // a request's consent: never a point from a sensitive visit
  if (c.scope === "all") for (const x of linked) points.push(...await forTenant(x.tenantId, async (o) => trendIn(o, x.patientId, reportCodes(core), c.basis === "patient-request" ? await sensitiveVisits(o, x.patientId) : undefined)));
  else points.push(...(await forTenant(ownerTenantId, (o) => trendIn(o, l.patientId, reportCodes(core)))).filter((p) => core.tests.some((t) => t.results.some((r) => r.observationId === p.observationId))));
  await recordOpen(tx, c, s, who, ownerTenantId, "report", reportId, now);
  return { body: { ...withTrend(core, points), consentId: c.id }, audit: [{ action: "view", entity: "DiagnosticReport", entityId: reportId, basis: "patient-share", detail: { consentId: c.id, ownerTenantId } }] };
}

export async function sharedPdf(tx: Tx, s: SessionData, consentId: string, ownerTenantId: string, kind: "lr" | "rx" | "ds", id: string, lang: "bn" | "en", now = new Date()): Promise<{ body: Uint8Array; audit: AuditEntry[] }> {
  const c = await shareFor(tx, s, consentId, now);
  const linked = await linkedOf(c.personId);
  const l = await checkedItem(c, s, linked, ownerTenantId, kind === "lr" ? "report" : kind === "rx" ? "prescription" : "summary", id, now);
  const { forTenant } = await import("@setu/db");
  const who = await reader(tx, s);
  const pdf = await forTenant(ownerTenantId, async (o) => {
    const out = await copyPdf(o, ownerTenantId, kind, id, lang, "shared");
    await ownerAudit(o, ownerTenantId, s, who, { action: "print", entity: kind === "lr" ? "DiagnosticReport" : "Composition", entityId: id, patientId: l.patientId, consentId: c.id, detail: { kind, label: out.label } });
    return out.bytes;
  });
  await recordOpen(tx, c, s, who, ownerTenantId, kind === "lr" ? "report" : kind === "rx" ? "prescription" : "summary", id, now);
  return { body: pdf, audit: [{ action: "print", entity: kind === "lr" ? "DiagnosticReport" : "Composition", entityId: id, basis: "patient-share", detail: { consentId: c.id, ownerTenantId, kind } }] };
}

/* ── ADR 0023 (E4): another clinic's view of a linked patient's history ── */
const requestState = (r: { state: string; createdAt: Date }, now: Date): AccessRequestView["state"] =>
  r.state === "sent" && now.getTime() - r.createdAt.getTime() > ACCESS_REQUEST_WAIT_DAYS * 864e5 ? "expired" : (r.state as AccessRequestView["state"]);
type RequestRow = Awaited<ReturnType<Tx["accessRequest"]["findFirstOrThrow"]>>;
const requestView = (r: RequestRow, now: Date): AccessRequestView => ({
  id: r.id, kinds: r.kinds as AccessRequestView["kinds"], period: r.period as AccessRequestView["period"], reason: r.reason, state: requestState(r, now),
  createdAt: r.createdAt.toISOString(), answeredAt: r.answeredAt?.toISOString() ?? null, doctorEn: r.doctorEn, doctorBn: r.doctorBn, consentId: r.consentId,
});
const doctorsOnly = (s: SessionData) => { if (s.role !== "doctor") throw err(403, "doctors_only", "শুধু ডাক্তার রোগীর নেটওয়ার্ক ইতিহাস দেখতে পারেন", "Only a doctor can see a patient's network history"); };

/** one other facility's policy rows of its record (inside ITS tenant): sensitive visits dropped before anything is read out */
async function policyIn(o: Tx, patientId: string, now: Date) {
  const hidden = await sensitiveVisits(o, patientId);
  const signed = { status: { in: ["final", "amended"] as ("final" | "amended")[] }, supersededById: null };
  const [allergies, meds, conds, rec] = await Promise.all([
    o.allergyIntolerance.findMany({ where: { patientId, status: "active" } }),
    o.medicationRequest.findMany({ where: { patientId, composition: signed }, include: { composition: { select: { signedAt: true, signedById: true, organizationId: true } } } }),
    o.condition.findMany({ where: { patientId, composition: signed }, include: { composition: { select: { signedAt: true, signedById: true, organizationId: true } } } }),
    o.patient.findFirst({ where: { id: patientId }, select: { bloodGroup: true, bloodGroupAt: true, bloodGroupById: true, tenantId: true } }),
  ]);
  const keepA = allergies.filter((a) => !(a.encounterId && hidden.has(a.encounterId)));
  const keepM = meds.filter((m) => !hidden.has(m.encounterId) && !isSensitiveMedicine(m.classes)
    && isCurrentMedicine({ kind: m.kind, days: m.days, orderStatus: m.orderStatus, signedAt: m.composition.signedAt }, now));
  const keepC = conds.filter((c) => !hidden.has(c.encounterId) && !isSensitiveCondition(c.code) && isActiveProblem(c.composition.signedAt, now));
  const userIds = [...new Set([...keepA.map((a) => a.recordedById), ...keepM.map((m) => m.composition.signedById), ...keepC.map((c) => c.composition.signedById), rec?.bloodGroupById].filter((x): x is string => Boolean(x)))];
  const [users, orgs] = await Promise.all([
    o.user.findMany({ where: { id: { in: userIds } }, select: { id: true, nameEn: true, nameBn: true } }),
    o.organization.findMany({ where: rec ? { tenantId: rec.tenantId } : { id: "-" }, select: { id: true, name: true, nameBn: true } }),
  ]);
  const src = (orgId: string | null, userId: string | null | undefined, at: Date) => {
    const g = orgs.find((x) => x.id === orgId) ?? orgs[0]; const u = users.find((x) => x.id === userId);
    return { facilityEn: g?.name ?? null, facilityBn: g?.nameBn ?? null, authorEn: u?.nameEn ?? null, authorBn: u?.nameBn ?? null, at: at.toISOString(), source: "provider-verified" as const };
  };
  return {
    allergies: keepA.map((a) => ({ ...src(a.organizationId, a.recordedById, a.recordedAt), labelEn: a.labelEn, labelBn: a.labelBn, kind: a.kind as string, severity: a.severity as string, reaction: a.reaction })),
    medicines: newestPerKey(keepM, (m) => m.medicineKey, (m) => m.composition.signedAt!).map((m) => ({ ...src(m.composition.organizationId, m.composition.signedById, m.composition.signedAt!), brand: m.brand, generic: m.generic, strength: m.strength, form: m.form, dose: m.doseText ?? m.dose, days: m.days, inpatient: m.kind === "inpatient" })),
    problems: newestPerKey(keepC, (c) => c.code, (c) => c.composition.signedAt!).map((c) => ({ ...src(c.composition.organizationId, c.composition.signedById, c.composition.signedAt!), code: c.code, labelEn: c.labelEn, labelBn: c.labelBn })),
    bloodGroups: rec?.bloodGroup && rec.bloodGroupAt ? [{ ...src(null, rec.bloodGroupById, rec.bloodGroupAt), value: rec.bloodGroup }] : [],
  };
}

/* a linked patient's history from the OTHER linked facilities, by policy (no request), and this doctor's requests */
export async function networkHistory(tx: Tx, s: SessionData, patientId: string, now = new Date()): Promise<{ body: NetworkHistory; audit: AuditEntry[] }> {
  doctorsOnly(s);
  const p = await tx.patient.findFirst({ where: { id: patientId }, select: { id: true, bloodGroup: true, bloodGroupAt: true } });
  if (!p) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
  const { forTenant, personNetworkSharing, personOfRecord } = await import("@setu/db");
  const own = { bloodGroup: p.bloodGroup, bloodGroupAt: p.bloodGroupAt?.toISOString() ?? null };
  const empty = { allergies: [], medicines: [], problems: [], bloodGroups: [] };
  const personId = await personOfRecord(s.tenantId, patientId);
  // never a match by name or phone: only a record linked to a person
  if (!personId) return { body: { patientId, linked: false, sharing: false, facilities: 0, ...empty, own, requests: [] }, audit: [] };
  const requests = (await tx.accessRequest.findMany({ where: { requesterPatientId: patientId }, orderBy: { createdAt: "desc" }, take: 20 })).map((r) => requestView(r, now));
  if (!(await personNetworkSharing(personId))) return { body: { patientId, linked: true, sharing: false, facilities: 0, ...empty, own, requests }, audit: [{ action: "view", entity: "Patient", entityId: patientId, patientId, basis: "network-policy", detail: { sharing: false } }] };
  const others = (await linkedOf(personId)).filter((l) => l.tenantId !== s.tenantId);
  const who = await reader(tx, s);
  const out: Omit<NetworkHistory, "patientId" | "linked" | "sharing" | "facilities" | "own" | "requests"> = { allergies: [], medicines: [], problems: [], bloodGroups: [] };
  for (const l of others) {
    const got = await forTenant(l.tenantId, async (o) => {
      const r = await policyIn(o, l.patientId, now);
      // the owner facility's audit: who read what, by policy (the patient's "who viewed" shows it)
      await o.auditEvent.create({ data: { tenantId: l.tenantId, userId: s.userId, role: s.role, action: "view", entity: "Patient", entityId: l.patientId, patientId: l.patientId, basis: "network-policy",
        detail: { purpose: "network-policy", reader: who, readerTenantId: s.tenantId, counts: { allergies: r.allergies.length, medicines: r.medicines.length, problems: r.problems.length, bloodGroups: r.bloodGroups.length } } as object } });
      return r;
    });
    out.allergies.push(...got.allergies); out.medicines.push(...got.medicines); out.problems.push(...got.problems); out.bloodGroups.push(...got.bloodGroups);
  }
  const newest = <T extends { at: string }>(xs: T[]) => xs.sort((a, b) => b.at.localeCompare(a.at));
  return {
    body: { patientId, linked: true, sharing: true, facilities: others.length, allergies: newest(out.allergies), medicines: newest(out.medicines), problems: newest(out.problems), bloodGroups: newest(out.bloodGroups), own, requests },
    audit: [{ action: "view", entity: "Patient", entityId: patientId, patientId, basis: "network-policy", detail: { facilities: others.length } }],
  };
}

/* "Request access": scope, period, a reason the patient sees → the patient app and an SMS of a fixed template */
export async function createAccessRequest(tx: Tx, s: SessionData, b: AccessRequestCreate, now = new Date()): Promise<{ body: AccessRequestView; audit: AuditEntry[] }> {
  doctorsOnly(s);
  const bad = accessRequestProblems(b);
  if (bad.length) throw err(400, "validation", "অনুরোধটি ঠিক নয়", "This request is not valid", { field: bad[0]! });
  const p = await tx.patient.findFirst({ where: { id: b.patientId }, select: { id: true, phone: true } });
  if (!p) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
  const { personOfRecord } = await import("@setu/db");
  const personId = await personOfRecord(s.tenantId, p.id);
  if (!personId) throw err(409, "not_linked", "রোগী সেতুতে যুক্ত নন", "This patient is not linked to Setu");
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7023, hashtext(${`areq:${p.id}:${s.userId}`}))`;
  const waiting = await tx.accessRequest.findFirst({ where: { requesterPatientId: p.id, requesterUserId: s.userId, state: "sent", createdAt: { gt: new Date(now.getTime() - ACCESS_REQUEST_WAIT_DAYS * 864e5) } } });
  if (waiting) throw err(409, "request_waiting", "আগের অনুরোধের উত্তর এখনো আসেনি", "Your earlier request is still waiting for the patient");
  const [org, doc] = await Promise.all([
    tx.organization.findFirstOrThrow({ where: { id: s.organizationId }, select: { name: true, nameBn: true } }),
    tx.user.findFirstOrThrow({ where: { id: s.userId }, select: { nameEn: true, nameBn: true } }),
  ]);
  const r = await tx.accessRequest.create({ data: {
    id: `areq_${randomUUID().replace(/-/g, "")}`, personId, requesterTenantId: s.tenantId, requesterOrganizationId: s.organizationId, requesterUserId: s.userId, requesterPatientId: p.id,
    facilityEn: org.name, facilityBn: org.nameBn, doctorEn: doc.nameEn, doctorBn: doc.nameBn, kinds: b.kinds, period: b.period, reason: b.reason.trim(), createdAt: now,
  } });
  const audit: AuditEntry[] = [{ action: "create", entity: "AccessRequest", entityId: r.id, patientId: p.id, detail: { kinds: b.kinds, period: b.period } }];
  // the SMS: the fixed template (the facility's name only — no doctor, no reason, nothing clinical)
  const to = smsPhone(p.phone);
  if (to) {
    const { templateKey, text } = await smsText(tx, s, "access-request");
    const id = `com_${randomUUID()}`;
    await tx.communication.create({ data: { id, tenantId: s.tenantId, organizationId: s.organizationId, patientId: p.id, kind: "access-request", channel: "sms", toPhone: to, templateKey, text, createdById: s.userId } });
    audit.push({ action: "create", entity: "Communication", entityId: id, patientId: p.id, detail: { kind: "access-request", channel: "sms" } });
  }
  return { body: requestView(r, now), audit };
}

/* decision 4: the blood group on this facility's record (who and when) */
export async function setBloodGroup(tx: Tx, s: SessionData, patientId: string, bloodGroup: string, now = new Date()) {
  if (!["doctor", "nurse", "labTech"].includes(s.role)) throw err(403, "role", "এই কাজ আপনার ভূমিকায় নেই", "Your role cannot do this");
  const p = await tx.patient.findFirst({ where: { id: patientId }, select: { id: true, bloodGroup: true } });
  if (!p) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
  await tx.patient.update({ where: { id: p.id }, data: { bloodGroup, bloodGroupAt: now, bloodGroupById: s.userId } });
  return { body: { bloodGroup, bloodGroupAt: now.toISOString() }, audit: [{ action: "update", entity: "Patient", entityId: p.id, patientId: p.id, detail: { bloodGroup: { from: p.bloodGroup, to: bloodGroup } } }] as AuditEntry[] };
}
