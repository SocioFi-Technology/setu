/* ADR 0021 — the consent-checked read service: the ONLY path from one tenant into another. A doctor at the receiving
   facility reads a patient's shared records: the share is loaded in the reader's own tenant (row-level security: shares
   given to it), @setu/domain shareCovers decides each item, the owner facility's rows are read inside ITS tenant
   (forTenant), and every read is audited in both tenants and recorded as an open the patient sees. Journey E extends
   this service (policy reads, access requests). */
import type { SharedList, SharedRecords, SharedReportView } from "@setu/contracts";
import { patientAgeYears, shareCovers, shareStatusAt, type ConsentState, type LinkedRecord, type ShareFacts, type ShareItem } from "@setu/domain";
import type { Tx } from "@setu/db";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { copyPdf } from "./documents.js";
import { itemFacts, recordsIn, reportCodes, reportIn, trendIn, withTrend } from "./records.js";

type Consent = Awaited<ReturnType<Tx["consent"]["findFirstOrThrow"]>>;
const facts = (c: Consent): ShareFacts => ({
  status: c.status as ConsentState, endsAt: c.endsAt, granteeTenantId: c.granteeTenantId, granteeUserId: c.granteeUserId,
  scope: c.scope === "all" ? { kind: "all" } : c.scope === "visit" ? { kind: "visit", tenantId: c.scopeTenantId!, patientId: c.scopePatientId!, encounterId: c.scopeRecordId! } : { kind: "report", tenantId: c.scopeTenantId!, patientId: c.scopePatientId!, reportId: c.scopeRecordId! },
});
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
    items.push({ consentId: c.id, patient, scope: { kind: c.scope, facilityEn: c.scopeFacilityEn, facilityBn: c.scopeFacilityBn, number: c.scopeNumber, at: c.scopeAt?.toISOString() ?? null }, toMe: c.granteeUserId === s.userId, startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString() });
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
      for (const r of await recordsIn(o, l.patientId)) {
        const item: ShareItem = { tenantId: l.tenantId, patientId: l.patientId, kind: r.kind, id: r.recordId, encounterId: r.encounterId,
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
  const f = await forTenant(ownerTenantId, (o) => itemFacts(o, l.patientId, kind, id));
  if (!f) throw refused("out-of-scope");
  const ok = shareCovers(facts(c), { tenantId: s.tenantId, userId: s.userId }, { tenantId: ownerTenantId, patientId: l.patientId, kind, id, encounterId: f.encounterId, reportChain: f.reportChain }, linked, now);
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
  if (c.scope === "all") for (const x of linked) points.push(...await forTenant(x.tenantId, (o) => trendIn(o, x.patientId, reportCodes(core))));
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
