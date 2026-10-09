/* ADR 0021 (D5–D6) — the patient's shares: a Consent (basis patient, network level) with a doctor or a facility from the
   network directory, for 24 h / 7 days / 30 days (default), scoped to one visit, one report or "all"; revocable any
   time; each share lists who opened it and when. The rules are @setu/domain share.ts. Making or stopping a share is
   also written to the audit of each facility whose records it covers (they see that their patient shared them). */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DirectoryView, ShareCreate, ShareList, ShareView } from "@setu/contracts";
import { shareEndsAt, shareRequestProblems, shareRevoke, shareStatusAt, type ConsentState, type ShareScope } from "@setu/domain";
import type { Tx } from "@setu/db";
import { err } from "../errors.js";
import { requirePerson, type PersonSession } from "../plugins/patientSession.js";
import { audit, linkedClaims, personCommand, personQuery } from "./patient.js";

type ConsentRow = Awaited<ReturnType<Tx["consent"]["findFirstOrThrow"]>> & { accesses: Awaited<ReturnType<Tx["consentAccess"]["findMany"]>> };
const under = (s: string) => s.replace(/-/g, "_");
function shareView(c: ConsentRow, now: Date): ShareView {
  const st = shareStatusAt({ status: c.status as ConsentState, endsAt: c.endsAt }, now);
  return {
    id: c.id,
    grantee: { facilityEn: c.granteeFacilityEn, facilityBn: c.granteeFacilityBn, doctorEn: c.granteeDoctorEn, doctorBn: c.granteeDoctorBn },
    scope: { kind: c.scope, facilityEn: c.scopeFacilityEn, facilityBn: c.scopeFacilityBn, number: c.scopeNumber, at: c.scopeAt?.toISOString() ?? null },
    period: c.period as ShareView["period"], startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString(),
    status: st === "revoked" ? "revoked" : st === "active" ? "active" : "expired", revokedAt: c.revokedAt?.toISOString() ?? null,
    opens: c.accesses.sort((a, b) => b.at.getTime() - a.at.getTime()).map((a) => ({ at: a.at.toISOString(), nameEn: a.userNameEn, nameBn: a.userNameBn, role: a.role, facilityEn: a.facilityEn, facilityBn: a.facilityBn, itemKind: a.itemKind })),
  };
}

export async function directory(req: FastifyRequest): Promise<DirectoryView> {
  await personQuery(req, async () => undefined);
  const { networkDirectory } = await import("@setu/db");
  return { facilities: await networkDirectory() };
}

export async function listShares(req: FastifyRequest, now = new Date()): Promise<ShareList> {
  return personQuery(req, async (tx, p) => {
    const rows = await tx.consent.findMany({ where: { personId: p.personId }, include: { accesses: true }, orderBy: { createdAt: "desc" } });
    return { items: rows.map((c) => shareView(c, now)) };
  });
}

/** the facilities whose audit hears of a share: the one it names, or every linked one for "all" */
async function tellFacilities(req: FastifyRequest, p: PersonSession, c: ConsentRow, linked: { tenantId: string; patientId: string | null }[], event: "share" | "revoke") {
  const { forTenant } = await import("@setu/db");
  const to = c.scope === "all" ? linked : linked.filter((l) => l.tenantId === c.scopeTenantId);
  for (const l of to) await forTenant(l.tenantId, (tx) => audit(tx, req, l.tenantId, p, { action: event, entity: "Consent", entityId: c.id, patientId: l.patientId,
    detail: { scope: c.scope, recordId: c.scopeTenantId === l.tenantId ? c.scopeRecordId : null, grantee: { facilityEn: c.granteeFacilityEn, doctorEn: c.granteeDoctorEn }, endsAt: c.endsAt.toISOString() } }));
}

export async function createShare(req: FastifyRequest, reply: FastifyReply, b: ShareCreate, now = new Date()): Promise<ShareView> {
  const p = requirePerson(req);
  const linked = await linkedClaims(req);
  const { forTenant, networkDirectory } = await import("@setu/db");
  // the grantee: a facility of the directory, and if named, one of its doctors (names only — ADR 0021)
  const fac = (await networkDirectory()).find((f) => f.organizationId === b.grantee.organizationId);
  const doc = b.grantee.userId ? fac?.doctors.find((d) => d.userId === b.grantee.userId) : null;
  if (!fac || (b.grantee.userId && !doc)) throw err(400, "grantee", "এই ডাক্তার বা প্রতিষ্ঠান সেতু নেটওয়ার্কে নেই", "This doctor or facility is not in the Setu network", { field: "grantee" });
  // the scope: a visit or a report of a linked record, checked in its own facility
  let scope: ShareScope = { kind: "all" };
  let label: { facilityEn: string | null; facilityBn: string | null; number: string | null; at: Date | null } = { facilityEn: null, facilityBn: null, number: null, at: null };
  if (b.scope.kind !== "all") {
    const sc = b.scope;
    const claim = linked.find((c) => c.id === sc.claimId);
    if (!claim) throw err(400, "not_linked", "এই রেকর্ড আপনার প্রোফাইলে যুক্ত নয়", "This record is not linked to your profile", { field: "scope" });
    const found = await forTenant(claim.tenantId, async (tx) => {
      if (sc.kind === "visit") {
        const e = await tx.encounter.findFirst({ where: { id: sc.encounterId, patientId: claim.patientId! }, select: { id: true, arrivedAt: true, createdAt: true, organizationId: true } });
        if (!e) return null;
        const o = await tx.organization.findFirst({ where: { id: e.organizationId }, select: { name: true, nameBn: true } });
        return { id: e.id, facilityEn: o?.name ?? null, facilityBn: o?.nameBn ?? null, number: null, at: e.arrivedAt ?? e.createdAt };
      }
      const r = await tx.diagnosticReport.findFirst({ where: { id: sc.reportId, patientId: claim.patientId! }, select: { id: true, number: true, releasedAt: true, organizationId: true } });
      if (!r) return null;
      const o = await tx.organization.findFirst({ where: { id: r.organizationId }, select: { name: true, nameBn: true } });
      return { id: r.id, facilityEn: o?.name ?? null, facilityBn: o?.nameBn ?? null, number: r.number, at: r.releasedAt };
    });
    if (!found) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
    scope = sc.kind === "visit" ? { kind: "visit", tenantId: claim.tenantId, patientId: claim.patientId!, encounterId: found.id } : { kind: "report", tenantId: claim.tenantId, patientId: claim.patientId!, reportId: found.id };
    label = found;
  }
  const bad = shareRequestProblems({ period: b.period, scope, grantee: { tenantId: fac.tenantId, organizationId: fac.organizationId, userId: b.grantee.userId } }, linked.map((l) => ({ tenantId: l.tenantId, patientId: l.patientId! })));
  if (bad.length) throw err(400, bad[0]!, bad[0] === "nothing_linked" ? "আগে আপনার রেকর্ড যুক্ত করুন" : "শেয়ারটি ঠিক নয়", bad[0] === "nothing_linked" ? "Link your records first" : "This share is not valid", { field: bad[0] === "period" ? "period" : "scope" });
  let made: ConsentRow | null = null;
  const view = await personCommand(req, reply, null, async (tx) => {
    const c = await tx.consent.create({
      data: {
        personId: p.personId, basis: "patient", granteeTenantId: fac.tenantId, granteeOrganizationId: fac.organizationId, granteeUserId: b.grantee.userId,
        granteeFacilityEn: fac.nameEn, granteeFacilityBn: fac.nameBn, granteeDoctorEn: doc?.nameEn ?? null, granteeDoctorBn: doc?.nameBn ?? null,
        scope: scope.kind, scopeTenantId: scope.kind === "all" ? null : scope.tenantId, scopePatientId: scope.kind === "all" ? null : scope.patientId,
        scopeRecordId: scope.kind === "visit" ? scope.encounterId : scope.kind === "report" ? scope.reportId : null,
        scopeFacilityEn: label.facilityEn, scopeFacilityBn: label.facilityBn, scopeNumber: label.number, scopeAt: label.at,
        period: b.period, startsAt: now, endsAt: shareEndsAt(now, b.period), status: "active", statusAt: now,
      },
      include: { accesses: true },
    });
    made = c;
    return { status: 201, body: shareView(c, now) };
  });
  if (made) await tellFacilities(req, p, made, linked, "share");
  return view;
}

export async function revokeShare(req: FastifyRequest, reply: FastifyReply, id: string, now = new Date()): Promise<ShareView> {
  const p = requirePerson(req);
  let stopped: ConsentRow | null = null;
  const view = await personCommand(req, reply, null, async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Consent" WHERE "id" = ${id} FOR UPDATE`;
    const c = await tx.consent.findFirst({ where: { id, personId: p.personId }, include: { accesses: true } });
    if (!c) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
    const r = shareRevoke({ status: c.status as ConsentState, endsAt: c.endsAt }, now);
    if (r.refused) throw err(409, "share_ended", "এই শেয়ারের মেয়াদ আগেই শেষ", "This share has already ended");
    if (!r.changed) return { body: shareView(c, now) };
    const u = await tx.consent.update({ where: { id }, data: { status: under(r.status) as "revoked", statusAt: now, revokedAt: now }, include: { accesses: true } });
    stopped = u;
    return { body: shareView(u, now) };
  });
  if (stopped) await tellFacilities(req, p, stopped, await linkedClaims(req), "revoke");
  return view;
}
