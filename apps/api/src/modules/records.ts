/* ADR 0020 / 0021 — reading one facility's records of one patient for someone outside the facility: the patient (their
   history, a report) or a doctor at another facility through the patient's share. Every function here runs inside the
   owning facility's tenant (the caller's forTenant — row-level security unchanged) and returns facts only: signed /
   released documents, never a draft. The caller checks the claim or the share and audits the read. */
import type { PatientReportView, TimelineItem } from "@setu/contracts";
import { ANALYTES_SAMPLE, SUMMARY_KIND, labFlag, labPlain, rangePosition } from "@setu/domain";
import type { Tx } from "@setu/db";
import { err } from "../errors.js";

/** a history item before it is tied to a claim (the patient) or a share (a doctor) */
export type RecordFact = Omit<TimelineItem, "claimId" | "unread">;

export async function recordsIn(tx: Tx, patientId: string): Promise<RecordFact[]> {
  const [encs, notes, reports] = await Promise.all([
    tx.encounter.findMany({ where: { patientId, OR: [{ class: { in: ["opd", "er"] }, status: "finished" }, { class: "ipd", status: { notIn: ["cancelled", "entered_in_error"] } }] }, select: { id: true, class: true, arrivedAt: true, createdAt: true, organizationId: true, token: true, practitionerId: true } }),
    tx.composition.findMany({ where: { patientId, kind: { in: ["consultation-note", SUMMARY_KIND] }, status: { in: ["final", "amended"] }, supersededById: null }, select: { id: true, kind: true, signedAt: true, organizationId: true, signedById: true, encounterId: true } }),
    tx.diagnosticReport.findMany({ where: { patientId, supersededById: null, status: { in: ["preliminary", "final", "corrected"] } }, select: { id: true, number: true, status: true, releasedAt: true, organizationId: true, encounterId: true } }),
  ]);
  const orgIds = [...new Set([...encs, ...notes, ...reports].map((x) => x.organizationId))];
  const userIds = [...new Set([...encs.map((e) => e.practitionerId), ...notes.map((n) => n.signedById)].filter((x): x is string => Boolean(x)))];
  const [orgs, users] = await Promise.all([
    tx.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true, nameBn: true } }),
    tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, nameEn: true, nameBn: true } }),
  ]);
  const org = (id: string) => orgs.find((o) => o.id === id);
  const doc = (id: string | null) => (id ? users.find((u) => u.id === id) : undefined);
  const base = (o: string, d: string | null | undefined) => ({ facilityEn: org(o)?.name ?? null, facilityBn: org(o)?.nameBn ?? null, doctorEn: doc(d ?? null)?.nameEn ?? null, doctorBn: doc(d ?? null)?.nameBn ?? null, source: "provider-verified" as const });
  return [
    ...encs.map((e): RecordFact => ({ key: `${e.class === "ipd" ? "admission" : "visit"}:${e.id}`, kind: e.class === "ipd" ? "admission" : "visit", at: (e.arrivedAt ?? e.createdAt).toISOString(), visitClass: e.class === "home" ? "opd" : e.class, number: e.token ?? null, status: null, recordId: e.id, encounterId: e.id, ...base(e.organizationId, e.practitionerId) })),
    ...notes.map((n): RecordFact => ({ key: `${n.kind === SUMMARY_KIND ? "summary" : "prescription"}:${n.id}`, kind: n.kind === SUMMARY_KIND ? "summary" : "prescription", at: (n.signedAt ?? new Date(0)).toISOString(), visitClass: null, number: null, status: null, recordId: n.id, encounterId: n.encounterId, ...base(n.organizationId, n.signedById) })),
    ...reports.map((r): RecordFact => ({ key: `report:${r.id}`, kind: "report", at: r.releasedAt.toISOString(), visitClass: null, number: r.number, status: r.status, recordId: r.id, encounterId: r.encounterId, ...base(r.organizationId, null) })),
  ];
}

/** the record behind a history item, for a share check: its visit and, for a report, its versions up to it */
export async function itemFacts(tx: Tx, patientId: string, kind: "report" | "prescription" | "summary", id: string): Promise<{ encounterId: string; reportChain: string[] } | null> {
  if (kind === "report") {
    const r = await tx.diagnosticReport.findFirst({ where: { id, patientId }, select: { encounterId: true, replacesId: true } });
    if (!r) return null;
    const chain = [id];
    for (let prev = r.replacesId; prev; ) { chain.unshift(prev); prev = (await tx.diagnosticReport.findFirst({ where: { id: prev }, select: { replacesId: true } }))?.replacesId ?? null; }
    return { encounterId: r.encounterId, reportChain: chain };
  }
  const c = await tx.composition.findFirst({ where: { id, patientId, kind: kind === "summary" ? SUMMARY_KIND : "consultation-note", status: { in: ["final", "amended"] } }, select: { encounterId: true } });
  return c ? { encounterId: c.encounterId, reportChain: [] } : null;
}

/** the patient_app notices still unopened, by the record they point at */
export async function unreadNotices(tx: Tx, patientId: string): Promise<Set<string>> {
  const rows = await tx.communication.findMany({ where: { patientId, channel: "patient_app", readAt: null }, select: { reportId: true, compositionId: true } });
  return new Set(rows.flatMap((r) => [r.reportId, r.compositionId].filter((x): x is string => Boolean(x))));
}
export const markNoticesRead = (tx: Tx, patientId: string, recordId: string, now: Date) =>
  tx.communication.updateMany({ where: { patientId, channel: "patient_app", readAt: null, OR: [{ reportId: recordId }, { compositionId: recordId }] }, data: { readAt: now } });

type ReportCore = Omit<PatientReportView, "claimId">;
/** One released lab report in plain language (ADR 0021), without the trend (read across facilities by the caller). A
    report replaced by a later version answers that version's id (`currentId`). */
export async function reportIn(tx: Tx, patientId: string, reportId: string): Promise<ReportCore> {
  const r = await tx.diagnosticReport.findFirst({ where: { id: reportId, patientId }, include: { results: true } });
  if (!r) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
  let currentId = r.id;
  for (let next = r.supersededById; next; ) { currentId = next; next = (await tx.diagnosticReport.findFirst({ where: { id: next }, select: { supersededById: true } }))?.supersededById ?? null; }
  const [obs, orders, org] = await Promise.all([
    tx.observation.findMany({ where: { id: { in: r.results.map((x) => x.observationId) } } }),
    tx.serviceRequest.findMany({ where: { id: { in: [...new Set(r.results.map((x) => x.serviceRequestId))] } }, select: { id: true, testCode: true, nameEn: true, nameBn: true }, orderBy: { createdAt: "asc" } }),
    tx.organization.findFirst({ where: { id: r.organizationId }, select: { name: true, nameBn: true, phone: true } }),
  ]);
  const tests = orders.map((o) => ({
    nameEn: o.nameEn, nameBn: o.nameBn,
    results: r.results.filter((x) => x.serviceRequestId === o.id).map((x) => obs.find((b) => b.id === x.observationId)!).filter(Boolean)
      .map((b) => {
        const a = ANALYTES_SAMPLE.find((d) => d.code === b.code);
        const range = b.refLow !== null && b.refHigh !== null ? { low: b.refLow, high: b.refHigh } : null;
        const flag = labFlag(b.value, range, { critLow: b.critLow, critHigh: b.critHigh });
        return {
          observationId: b.id, code: b.code, nameEn: a?.nameEn ?? b.code, nameBn: a?.nameBn ?? b.code, value: b.value, decimals: a?.decimals ?? 2, unit: b.unit,
          refLow: b.refLow, refHigh: b.refHigh, refLabel: b.refLabel, flag, corrected: b.replacesId !== null, withdrawn: b.status === "entered_in_error",
          position: rangePosition(b.value, b.refLow, b.refHigh), plain: labPlain(b.code, flag),
          trend: [] as PatientReportView["tests"][number]["results"][number]["trend"],
        };
      }).sort((x, y) => (ANALYTES_SAMPLE.find((d) => d.code === x.code)?.position ?? 99) - (ANALYTES_SAMPLE.find((d) => d.code === y.code)?.position ?? 99)),
  }));
  return {
    report: { id: r.id, number: r.number, version: r.version, status: r.status, releasedAt: r.releasedAt.toISOString(), currentId, facilityEn: org?.name ?? null, facilityBn: org?.nameBn ?? null, facilityPhone: org?.phone ?? null, pendingCount: r.pendingCount, testCount: r.testCount },
    tests,
  };
}

/** this patient's released results for these analytes at one facility (validated or corrected, never a withdrawn one) */
export async function trendIn(tx: Tx, patientId: string, codes: string[], leaveOutVisits?: Set<string>): Promise<{ code: string; at: string; value: number; facilityEn: string | null; facilityBn: string | null; observationId: string }[]> {
  if (!codes.length) return [];
  const released = await tx.diagnosticReportResult.findMany({ where: { report: { patientId } }, select: { observationId: true } });
  const ids = [...new Set(released.map((x) => x.observationId))];
  const obs = await tx.observation.findMany({ where: { id: { in: ids }, code: { in: codes }, category: "laboratory", status: { in: ["final", "amended"] } }, select: { id: true, code: true, value: true, effectiveAt: true, organizationId: true, encounterId: true } })
    .then((rows) => rows.filter((o) => !leaveOutVisits?.has(o.encounterId)));
  const orgs = await tx.organization.findMany({ where: { id: { in: [...new Set(obs.map((o) => o.organizationId))] } }, select: { id: true, name: true, nameBn: true } });
  return obs.map((o) => ({ code: o.code, at: o.effectiveAt.toISOString(), value: o.value, facilityEn: orgs.find((g) => g.id === o.organizationId)?.name ?? null, facilityBn: orgs.find((g) => g.id === o.organizationId)?.nameBn ?? null, observationId: o.id }));
}
const TREND_POINTS = 6;
/** puts each result's trend together: points from every linked facility, oldest first, the newest 6 */
export function withTrend<T extends ReportCore>(core: T, points: Awaited<ReturnType<typeof trendIn>>): T {
  for (const t of core.tests) for (const x of t.results) {
    x.trend = points.filter((p) => p.code === x.code).sort((a, b) => a.at.localeCompare(b.at)).slice(-TREND_POINTS)
      .map((p) => ({ at: p.at, value: p.value, facilityEn: p.facilityEn, facilityBn: p.facilityBn, current: p.observationId === x.observationId }));
  }
  return core;
}
export const reportCodes = (core: ReportCore) => [...new Set(core.tests.flatMap((t) => t.results.map((x) => x.code)))];
