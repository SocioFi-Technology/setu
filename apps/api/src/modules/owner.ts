/* The owner dashboard (journey C1–C2, ADR 0008). One facility's metrics per Dhaka day, computed from the source tables;
   past days are kept in DailyRollup (nightly job, last 7 days recomputed), today is always live. Nothing here is a
   sample: tiles whose data comes with a later module say so (@setu/domain KPIS). Every list behind a number is audited
   with the patients it reveals. */
import type { DashboardView, DrillView } from "@setu/contracts";
import type { Tx } from "@setu/db";
import { KPIS, MEDICINES_SAMPLE, NEAR_EXPIRY_DAYS, dhakaDay, kpiChange, periodDays, sumUpToHour, type KpiKey, type OpsKey, type Period } from "@setu/domain";
import type { AuditEntry } from "../command.js";
import { pendingPharmacyApprovals } from "./purchasing.js";
import type { SessionData } from "../plugins/session.js";

/** 2: the cash variance is stored as short and over separately (money-controls review H3); 3: refunds (ADR 0013) —
    older rows are recomputed. */
export const ROLLUP_VERSION = 5;
export interface DayMetrics {
  revenuePaisa: number; revenueByHour: number[]; collectionsPaisa: number; collectionsByHour: number[]; byMethod: Record<string, number>;
  discountsPaisa: number; duesPaisa: number; opdVisits: number; noShows: number; labTests: number; labTatMinutesSum: number;
  cashVariancePaisa: number; cashShortPaisa: number; cashOverPaisa: number; shiftsWithVariance: number; reprints: number;
  discountAbovePolicy: { count: number; paisa: number }; notBilledHere: { count: number; paisa: number }; cashOutsideShift: { count: number; paisa: number };
  /** ADR 0013: money paid back that day (allocations paid), refunds completed that day, wrong-dispense returns that day */
  refundsPaisa: number; refundsPaid: { count: number; paisa: number }; medicationIncident: { count: number; paisa: number };
  /** decision 223: refunds decided by the requester as the facility's only approver (v4) */
  selfApproved: { count: number; paisa: number };
  /** decision 221: returns without refund recorded that day — the due written off, no money (v5) */
  creditReturns: { count: number; paisa: number };
}
/** Dhaka day D runs from D 00:00 +06 to D+1 00:00 +06. */
export const dayBounds = (day: string) => { const from = new Date(Date.parse(`${day}T00:00:00+06:00`)); return { from, to: new Date(from.getTime() + 864e5) }; };
const hours = (rows: { h: number; paisa: bigint | number | null }[]) => { const a = Array<number>(24).fill(0); for (const r of rows) a[Number(r.h)] = Number(r.paisa ?? 0); return a; };
const n = (x: unknown) => Number(x ?? 0);

/** One facility's metrics for one Dhaka day, from the source tables (RLS keeps it to this tenant); `until` cuts the day
    at a moment (today against the same moment last week — money-controls review M3). */
export async function computeDay(tx: Tx, organizationId: string, day: string, until?: Date): Promise<DayMetrics> {
  const b = dayBounds(day);
  const from = b.from, to = until && until < b.to ? until : b.to;
  const org = organizationId;
  const rev = await tx.$queryRaw<{ h: number; paisa: bigint }[]>`
    SELECT floor(extract(epoch from ("issuedAt" - ${from}::timestamptz)) / 3600)::int AS h, sum("totalPaisa") AS paisa
    FROM "Invoice" WHERE "organizationId" = ${org} AND "issuedAt" >= ${from} AND "issuedAt" < ${to} AND "status" <> 'entered-in-error' GROUP BY 1`;
  const col = await tx.$queryRaw<{ h: number; paisa: bigint }[]>`
    SELECT floor(extract(epoch from ("confirmedAt" - ${from}::timestamptz)) / 3600)::int AS h, sum("amountPaisa") AS paisa
    FROM "Payment" WHERE "organizationId" = ${org} AND "status" = 'confirmed' AND "confirmedAt" >= ${from} AND "confirmedAt" < ${to} GROUP BY 1`;
  const methods = await tx.$queryRaw<{ method: string; paisa: bigint }[]>`
    SELECT "method"::text AS method, sum("amountPaisa") AS paisa FROM "Payment"
    WHERE "organizationId" = ${org} AND "status" = 'confirmed' AND "confirmedAt" >= ${from} AND "confirmedAt" < ${to} GROUP BY 1`;
  const [disc] = await tx.$queryRaw<{ all: bigint; above: bigint; abovePaisa: bigint }[]>`
    SELECT coalesce(sum("discountPaisa"), 0) AS all, count(*) FILTER (WHERE "discountTaskId" IS NOT NULL AND "discountPaisa" > 0) AS above,
           coalesce(sum("discountPaisa") FILTER (WHERE "discountTaskId" IS NOT NULL), 0) AS "abovePaisa"
    FROM "Invoice" WHERE "organizationId" = ${org} AND "issuedAt" >= ${from} AND "issuedAt" < ${to} AND "status" <> 'entered-in-error'`;
  const [dues] = await tx.$queryRaw<{ paisa: bigint }[]>`
    SELECT coalesce(sum(i."totalPaisa"), 0) - coalesce((SELECT sum(p."amountPaisa") FROM "Payment" p JOIN "Invoice" j ON j."id" = p."invoiceId"
        WHERE j."organizationId" = ${org} AND j."issuedAt" < ${to} AND j."status" <> 'entered-in-error' AND p."status" = 'confirmed' AND p."confirmedAt" < ${to}), 0)
      -- decision 221: medicine returned without a refund lowers the due from the moment it was recorded
      - coalesce((SELECT sum(r."amountPaisa") FROM "Refund" r JOIN "Invoice" j ON j."id" = r."invoiceId"
        WHERE j."organizationId" = ${org} AND j."issuedAt" < ${to} AND j."status" <> 'entered-in-error' AND r."kind" = 'return' AND r."status" = 'paid' AND r."paidAt" < ${to}), 0) AS paisa
    FROM "Invoice" i WHERE i."organizationId" = ${org} AND i."issuedAt" < ${to} AND i."status" <> 'entered-in-error'`;
  const [visits] = await tx.$queryRaw<{ opd: bigint; noshow: bigint }[]>`
    SELECT count(*) FILTER (WHERE "createdAt" >= ${from} AND "createdAt" < ${to} AND "status" <> 'entered-in-error') AS opd,
           count(*) FILTER (WHERE "cancelReason" = 'no-show' AND "statusAt" >= ${from} AND "statusAt" < ${to}) AS noshow
    FROM "Encounter" WHERE "organizationId" = ${org} AND ("createdAt" >= ${from} - interval '2 days')`;
  const [lab] = await tx.$queryRaw<{ tests: bigint; minutes: number | null }[]>`
    WITH today AS (
      SELECT DISTINCT x."serviceRequestId" AS sr FROM "DiagnosticReportResult" x JOIN "DiagnosticReport" r ON r."id" = x."reportId"
      WHERE r."organizationId" = ${org} AND r."releasedAt" >= ${from} AND r."releasedAt" < ${to}),
    first AS (
      SELECT x."serviceRequestId" AS sr, min(r."releasedAt") AS released FROM "DiagnosticReportResult" x JOIN "DiagnosticReport" r ON r."id" = x."reportId"
      WHERE x."serviceRequestId" IN (SELECT sr FROM today) GROUP BY 1)
    SELECT count(*) AS tests, sum(extract(epoch from (f.released - coalesce(s."orderedAt", s."createdAt"))) / 60)::float AS minutes
    FROM first f JOIN "ServiceRequest" s ON s."id" = f.sr WHERE f.released >= ${from} AND f.released < ${to}`;
  const [shifts] = await tx.$queryRaw<{ paisa: bigint; short: bigint; over: bigint; n: bigint }[]>`
    SELECT coalesce(sum(c."variancePaisa"), 0) AS paisa, count(*) FILTER (WHERE c."variancePaisa" <> 0) AS n,
           coalesce(sum(c."variancePaisa") FILTER (WHERE c."variancePaisa" < 0), 0) AS short, coalesce(sum(c."variancePaisa") FILTER (WHERE c."variancePaisa" > 0), 0) AS over
    FROM "ShiftReview" v JOIN "ShiftCount" c ON c."id" = v."countId" JOIN "Shift" s ON s."id" = v."shiftId"
    WHERE s."organizationId" = ${org} AND v."decision" = 'approve' AND v."at" >= ${from} AND v."at" < ${to}`;
  const [reprints] = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT (SELECT count(*) FROM "ReceiptPrint" rp JOIN "Receipt" r ON r."id" = rp."receiptId" WHERE r."organizationId" = ${org} AND rp."copy" > 0 AND rp."printedAt" >= ${from} AND rp."printedAt" < ${to})
         + (SELECT count(*) FROM "DocumentPrint" dp JOIN "DocumentCode" d ON d."id" = dp."codeId" WHERE d."organizationId" = ${org} AND dp."copy" > 0 AND dp."printedAt" >= ${from} AND dp."printedAt" < ${to}) AS n`;
  const [nb] = await tx.$queryRaw<{ n: bigint; paisa: bigint }[]>`
    SELECT count(*) AS n, coalesce(sum(c."grossPaisa"), 0) AS paisa FROM "ChargeItem" c JOIN "Invoice" i ON i."id" = c."invoiceId"
    WHERE i."organizationId" = ${org} AND c."notBilledAt" >= ${from} AND c."notBilledAt" < ${to}`;
  const [outside] = await tx.$queryRaw<{ n: bigint; paisa: bigint }[]>`
    SELECT count(*) AS n, coalesce(sum(p."amountPaisa"), 0) AS paisa FROM "Payment" p
    WHERE p."organizationId" = ${org} AND p."method" = 'cash' AND p."status" = 'confirmed' AND p."confirmedAt" >= ${from} AND p."confirmedAt" < ${to}
      AND NOT EXISTS (SELECT 1 FROM "Shift" s LEFT JOIN "ShiftCount" c ON c."id" = s."latestCountId"
        WHERE s."organizationId" = p."organizationId" AND s."cashierId" = p."createdById" AND s."openedAt" <= p."confirmedAt"
          AND (s."status" = 'open' OR c."windowTo" >= p."confirmedAt"))`;
  // ADR 0013: refunds — money out by the day it was paid back; refunds completed; wrong-dispense returns (medication incidents)
  const [rf] = await tx.$queryRaw<{ out: bigint; n: bigint; paisa: bigint; cr: bigint; crPaisa: bigint; inc: bigint; incPaisa: bigint; self: bigint; selfPaisa: bigint }[]>`
    SELECT (SELECT coalesce(sum(a."amountPaisa"), 0) FROM "RefundAllocation" a JOIN "Refund" r ON r."id" = a."refundId"
             WHERE r."organizationId" = ${org} AND a."status" = 'paid' AND a."paidAt" >= ${from} AND a."paidAt" < ${to}) AS out,
           (SELECT count(*) FROM "Refund" WHERE "organizationId" = ${org} AND "kind" = 'refund' AND "status" = 'paid' AND "paidAt" >= ${from} AND "paidAt" < ${to}) AS n,
           (SELECT coalesce(sum("amountPaisa"), 0) FROM "Refund" WHERE "organizationId" = ${org} AND "kind" = 'refund' AND "status" = 'paid' AND "paidAt" >= ${from} AND "paidAt" < ${to}) AS paisa,
           (SELECT count(*) FROM "Refund" WHERE "organizationId" = ${org} AND "kind" = 'return' AND "status" = 'paid' AND "paidAt" >= ${from} AND "paidAt" < ${to}) AS cr,
           (SELECT coalesce(sum("amountPaisa"), 0) FROM "Refund" WHERE "organizationId" = ${org} AND "kind" = 'return' AND "status" = 'paid' AND "paidAt" >= ${from} AND "paidAt" < ${to}) AS "crPaisa",
           -- every wrong-dispense medicine line that came back (a dispense or an OTC sale), by the day it came back
           (SELECT count(*) FROM "StockMove" m JOIN "RefundLine" l ON l."id" = m."refId" JOIN "Refund" r ON r."id" = l."refundId"
             WHERE m."organizationId" = ${org} AND m."kind" = 'return' AND m."refType" = 'refund-line' AND r."category" = 'wrong-dispense' AND m."at" >= ${from} AND m."at" < ${to}) AS inc,
           (SELECT coalesce(sum(l."totalPaisa"), 0) FROM "StockMove" m JOIN "RefundLine" l ON l."id" = m."refId" JOIN "Refund" r ON r."id" = l."refundId"
             WHERE m."organizationId" = ${org} AND m."kind" = 'return' AND m."refType" = 'refund-line' AND r."category" = 'wrong-dispense' AND m."at" >= ${from} AND m."at" < ${to}) AS "incPaisa",
           (SELECT count(*) FROM "Refund" WHERE "organizationId" = ${org} AND "selfApproved" AND "decidedAt" >= ${from} AND "decidedAt" < ${to}) AS self,
           (SELECT coalesce(sum("amountPaisa"), 0) FROM "Refund" WHERE "organizationId" = ${org} AND "selfApproved" AND "decidedAt" >= ${from} AND "decidedAt" < ${to}) AS "selfPaisa"`;
  return {
    refundsPaisa: n(rf?.out), refundsPaid: { count: n(rf?.n), paisa: n(rf?.paisa) }, medicationIncident: { count: n(rf?.inc), paisa: n(rf?.incPaisa) }, selfApproved: { count: n(rf?.self), paisa: n(rf?.selfPaisa) }, creditReturns: { count: n(rf?.cr), paisa: n(rf?.crPaisa) },
    revenuePaisa: hours(rev).reduce((a, b) => a + b, 0), revenueByHour: hours(rev),
    collectionsPaisa: hours(col).reduce((a, b) => a + b, 0), collectionsByHour: hours(col),
    byMethod: Object.fromEntries(methods.map((m) => [m.method, n(m.paisa)])),
    discountsPaisa: n(disc?.all), duesPaisa: n(dues?.paisa), opdVisits: n(visits?.opd), noShows: n(visits?.noshow),
    labTests: n(lab?.tests), labTatMinutesSum: Math.round(n(lab?.minutes)),
    cashVariancePaisa: n(shifts?.paisa), cashShortPaisa: -n(shifts?.short), cashOverPaisa: n(shifts?.over), shiftsWithVariance: n(shifts?.n), reprints: n(reprints?.n),
    discountAbovePolicy: { count: n(disc?.above), paisa: n(disc?.abovePaisa) },
    notBilledHere: { count: n(nb?.n), paisa: n(nb?.paisa) },
    cashOutsideShift: { count: n(outside?.n), paisa: n(outside?.paisa) },
  };
}

/** At most this many missing past days are computed inside one request (security review C1–C4 #4); the rest are
    reported as still being prepared and the nightly job (or the next load) fills them. */
export const MAX_COMPUTE_PER_REQUEST = 8;
/** Stored past days (computed when missing, a few per request); today is computed live and never stored. */
export async function metricsFor(tx: Tx, s: SessionData, days: string[], now: Date): Promise<{ m: Map<string, DayMetrics>; missing: string[] }> {
  const today = dhakaDay(now);
  const stored = await tx.dailyRollup.findMany({ where: { organizationId: s.organizationId, day: { in: days.filter((d) => d < today) }, version: ROLLUP_VERSION } });
  const out = new Map(stored.map((r) => [r.day, r.metrics as unknown as DayMetrics]));
  const missing: string[] = [];
  let computed = 0;
  // newest first: the days a manager looks at
  for (const d of [...days].sort().reverse()) {
    if (out.has(d) || d > today) continue;
    if (d < today && computed >= MAX_COMPUTE_PER_REQUEST) { missing.push(d); continue; }
    computed++;
    const m = await computeDay(tx, s.organizationId, d);
    out.set(d, m);
    if (d < today) await upsertRollup(tx, s.tenantId, s.organizationId, d, m, now);
  }
  return { m: out, missing: missing.sort() };
}
export async function upsertRollup(tx: Tx, tenantId: string, organizationId: string, day: string, m: DayMetrics, now: Date) {
  // INSERT … ON CONFLICT: a dashboard load and the nightly job may write the same day at the same moment
  await tx.$executeRaw`INSERT INTO "DailyRollup" ("id", "tenantId", "organizationId", "day", "metrics", "version", "computedAt")
    VALUES (${`dr_${tenantId}_${organizationId}_${day}`}, ${tenantId}, ${organizationId}, ${day}, ${JSON.stringify(m)}::jsonb, ${ROLLUP_VERSION}, ${now})
    ON CONFLICT ("tenantId", "organizationId", "day") DO UPDATE SET "metrics" = EXCLUDED."metrics", "version" = EXCLUDED."version", "computedAt" = EXCLUDED."computedAt"`;
}

/** The nightly job (ADR 0008): every facility, the last `back` finished days, recomputed (late voids and confirmations). */
export async function runNightlyRollup(now = new Date(), back = 35, onlyTenant?: string): Promise<{ facilities: number; days: number; failed: number }> {
  const { prisma, forTenant } = await import("@setu/db");
  const all = await prisma.$queryRaw<{ tenant_id: string; organization_id: string }[]>`SELECT * FROM rollup_targets()`;
  const targets = onlyTenant ? all.filter((t) => t.tenant_id === onlyTenant) : all;
  let failed = 0;
  const today = dhakaDay(now);
  const days = Array.from({ length: back }, (_, i) => new Date(Date.parse(`${today}T00:00:00Z`) - (i + 1) * 864e5).toISOString().slice(0, 10));
  for (const t of targets) {
    // one failing facility never stops the others (security review C1–C4 #7); each day commits on its own
    for (const d of days) {
      try { await forTenant(t.tenant_id, async (tx) => upsertRollup(tx, t.tenant_id, t.organization_id, d, await computeDay(tx, t.organization_id, d), now), { timeoutMs: 30_000 }); }
      catch (e) { failed++; console.error(`nightly rollup ${t.tenant_id}/${t.organization_id}/${d} failed`, e); }
    }
  }
  return { facilities: targets.length, days: days.length, failed };
}

const sumBy = (m: Map<string, DayMetrics>, days: string[], f: (x: DayMetrics) => number) => days.reduce((a, d) => a + (m.has(d) ? f(m.get(d)!) : 0), 0);

/* Pharmacy tiles (ADR 0009): what the stock and supplier ledgers held at a moment — stock value at cost (not expired,
   not quarantined), the part of it expiring within 90 days, and what is owed to suppliers. Point-in-time, live. */
const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
async function stockAt(tx: Tx, org: string, at: Date) {
  const day = dhakaDay(at), near = addDay(day, NEAR_EXPIRY_DAYS);
  const [st] = await tx.$queryRaw<{ value: bigint; near: bigint }[]>`
    WITH q AS (SELECT m."batchId", sum(m."qty") AS qty FROM "StockMove" m WHERE m."organizationId" = ${org} AND m."at" <= ${at} GROUP BY m."batchId")
    SELECT coalesce(sum(q.qty * b."costPaisa") FILTER (WHERE b."expiry" >= ${day} AND b."location" <> 'quarantine'), 0)::bigint AS value,
           coalesce(sum(q.qty * b."costPaisa") FILTER (WHERE b."expiry" >= ${day} AND b."expiry" <= ${near} AND b."location" <> 'quarantine'), 0)::bigint AS near
    FROM q JOIN "StockBatch" b ON b."id" = q."batchId"`;
  const [sd] = await tx.$queryRaw<{ owed: bigint }[]>`
    SELECT coalesce(sum(CASE WHEN "kind" = 'goods-received' THEN "amountPaisa" ELSE -"amountPaisa" END), 0)::bigint AS owed
    FROM "SupplierEntry" WHERE "organizationId" = ${org} AND "at" <= ${at}`;
  return { stockValue: Number(st?.value ?? 0), nearExpiry: Number(st?.near ?? 0), supplierDues: Number(sd?.owed ?? 0) };
}

export async function dashboard(tx: Tx, s: SessionData, period: Period, now: Date): Promise<DashboardView> {
  const p = periodDays(period, now);
  const { m, missing } = await metricsFor(tx, s, period === "today" ? p.days : [...p.days, ...p.previous], now);
  // today: last week's same day cut at exactly the same moment, for every metric (money-controls review M3) — live
  if (period === "today") m.set(p.previous[0]!, await computeDay(tx, s.organizationId, p.previous[0]!, p.previousUntil!));
  const H = p.uptoHour;
  const money = (f: (x: DayMetrics) => number[]) => ({ cur: sumBy(m, p.days, (x) => sumUpToHour(f(x), null)), prev: sumBy(m, p.previous, (x) => sumUpToHour(f(x), null)) });
  const plain = (f: (x: DayMetrics) => number) => ({ cur: sumBy(m, p.days, f), prev: sumBy(m, p.previous, f) });
  const last = (days: string[]) => days[days.length - 1]!;
  const values: Partial<Record<KpiKey, { cur: number; prev: number }>> = {
    revenue: money((x) => x.revenueByHour), collections: money((x) => x.collectionsByHour), discounts: plain((x) => x.discountsPaisa),
    refunds: plain((x) => x.refundsPaisa ?? 0),
    dues: { cur: m.get(last(p.days))?.duesPaisa ?? 0, prev: m.get(last(p.previous))?.duesPaisa ?? 0 },
  };
  // compared with the same moment last week (today) or the start of the period (7 / 30 days)
  const [stNow, stThen] = await Promise.all([stockAt(tx, s.organizationId, now), stockAt(tx, s.organizationId, p.previousUntil ?? new Date(dayBounds(p.days[0]!).from.getTime() - 1))]);
  for (const k of ["stockValue", "nearExpiry", "supplierDues"] as const) values[k] = { cur: stNow[k], prev: stThen[k] };
  const opsVals: Record<OpsKey, { cur: number | null; prev: number | null }> = {
    opdVisits: plain((x) => x.opdVisits), labTests: plain((x) => x.labTests), noShows: plain((x) => x.noShows),
    labTat: (() => { const t = plain((x) => x.labTests), mins = plain((x) => x.labTatMinutesSum); return { cur: t.cur ? Math.round(mins.cur / t.cur) : null, prev: t.prev ? Math.round(mins.prev / t.prev) : null }; })(),
    // short and over never cancel out (money-controls review H3): the size of every variance, added up
    cashVariance: plain((x) => (x.cashShortPaisa ?? 0) + (x.cashOverPaisa ?? 0)), reprints: plain((x) => x.reprints),
  };
  const collected = values.collections!.cur, revenue = values.revenue!.cur;
  const kpis = KPIS.map((k) => {
    const v = values[k.key];
    if (k.comesWith || !v) return { key: k.key, value: null, previous: null, pct: null, judgement: null, comesWith: k.comesWith ?? null, sub: null };
    const c = kpiChange(k.key, v.cur, v.prev);
    return { key: k.key, value: v.cur, previous: v.prev, ...c, comesWith: null, sub: k.key === "collections" && revenue ? `${Math.round((collected / revenue) * 100)}` : null };
  });
  const ops = (Object.keys(opsVals) as OpsKey[]).map((key) => {
    const v = opsVals[key];
    const c = v.cur === null || v.prev === null ? { pct: null, judgement: null } : kpiChange(key, v.cur, v.prev);
    return { key, value: v.cur, previous: v.prev, ...c };
  });
  const series = period === "today"
    ? { unit: "hour" as const, points: Array.from({ length: (H ?? 23) + 1 }, (_, h) => ({ label: String(h).padStart(2, "0"), revenuePaisa: m.get(p.days[0]!)?.revenueByHour[h] ?? 0, collectedPaisa: m.get(p.days[0]!)?.collectionsByHour[h] ?? 0 })) }
    : { unit: "day" as const, points: p.days.map((d) => ({ label: d, revenuePaisa: m.get(d)?.revenuePaisa ?? 0, collectedPaisa: m.get(d)?.collectionsPaisa ?? 0 })) };
  const byMethodTotals = new Map<string, number>();
  for (const d of p.days) for (const [k, v] of Object.entries(m.get(d)?.byMethod ?? {})) byMethodTotals.set(k, (byMethodTotals.get(k) ?? 0) + v);
  const leak = (f: (x: DayMetrics) => { count: number; paisa: number }) => ({ count: sumBy(m, p.days, (x) => f(x).count), paisa: sumBy(m, p.days, (x) => f(x).paisa) });
  const short = sumBy(m, p.days, (x) => x.cashShortPaisa ?? 0), over = sumBy(m, p.days, (x) => x.cashOverPaisa ?? 0);
  const variance = { count: sumBy(m, p.days, (x) => x.shiftsWithVariance), paisa: short + over };
  const leakage = [
    { kind: "cashOutsideShift" as const, ...leak((x) => x.cashOutsideShift), severity: "high" as const },
    { kind: "shiftVariance" as const, ...variance, severity: "high" as const },
    { kind: "discountAbovePolicy" as const, ...leak((x) => x.discountAbovePolicy), severity: "review" as const },
    { kind: "reprints" as const, count: sumBy(m, p.days, (x) => x.reprints), paisa: 0, severity: "review" as const },
    { kind: "notBilledHere" as const, ...leak((x) => x.notBilledHere), severity: "review" as const },
    // ADR 0013: refunds paid (with reason and approver in the list), wrong-dispense returns, and — now — refunds paid by
    // hand that the owner has not matched to a statement yet
    { kind: "refundsPaid" as const, ...leak((x) => x.refundsPaid ?? { count: 0, paisa: 0 }), severity: "review" as const },
    { kind: "medicationIncident" as const, ...leak((x) => x.medicationIncident ?? { count: 0, paisa: 0 }), severity: "high" as const },
    { kind: "creditReturns" as const, ...leak((x) => x.creditReturns ?? { count: 0, paisa: 0 }), severity: "review" as const },
    { kind: "selfApproved" as const, ...leak((x) => x.selfApproved ?? { count: 0, paisa: 0 }), severity: "review" as const },
    { kind: "manualRefundUnchecked" as const, ...(await uncheckedRefunds(tx, s.organizationId)), severity: "high" as const },
  ];
  // approval tasks point at a bill, reconciliation tasks at a payment: counted for this facility only (review #5)
  const [[appr], shiftsClosed, [rec], staleShifts] = await Promise.all([
    tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Task" t JOIN "Invoice" i ON i."id" = t."focusId" WHERE t."kind" IN ('discount-approval', 'bill-elsewhere', 'refund-approval') AND t."status" = 'requested' AND i."organizationId" = ${s.organizationId}`,
    tx.shift.count({ where: { organizationId: s.organizationId, status: "closed" } }),
    tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Task" t JOIN "Payment" p ON p."id" = t."focusId" WHERE t."kind" = 'payment-reconciliation' AND t."status" = 'requested' AND p."organizationId" = ${s.organizationId}`,
    // never handed over: open for more than 12 hours (money-controls review M5)
    tx.shift.count({ where: { organizationId: s.organizationId, status: "open", openedAt: { lt: new Date(now.getTime() - 12 * 3600_000) } } }),
  ]);
  // one approval queue (Kamrul 03/10/2026): the pharmacy's orders above the limit, owner-only receipts and counts too
  const approvals = Number(appr?.n ?? 0) + await pendingPharmacyApprovals(tx, s, now), reconcile = Number(rec?.n ?? 0) + (await uncheckedRefunds(tx, s.organizationId)).count;
  return {
    period, days: p.days, previousDays: p.previous, uptoHour: H, asOf: now.toISOString(), kpis, ops, series,
    byMethod: (["cash", "bkash", "nagad", "card", "bank"] as const).map((method) => ({ method, paisa: byMethodTotals.get(method) ?? 0 })),
    leakage, pending: { approvals, shifts: shiftsClosed, reconcile, staleShifts }, missingDays: missing,
    cash: { shortPaisa: short, overPaisa: over, shiftsWithVariance: variance.count },
  };
}

/** ADR 0013: refunds paid by hand (or card / bank paid back in cash) the owner has not checked against a statement yet. */
async function uncheckedRefunds(tx: Tx, organizationId: string) {
  const [x] = await tx.$queryRaw<{ n: bigint; paisa: bigint }[]>`
    SELECT count(*) AS n, coalesce(sum(a."amountPaisa"), 0) AS paisa FROM "Task" t JOIN "RefundAllocation" a ON a."id" = t."focusId" JOIN "Refund" r ON r."id" = a."refundId"
    WHERE t."kind" = 'refund-reconciliation' AND t."status" = 'requested' AND r."organizationId" = ${organizationId}`;
  return { count: n(x?.n), paisa: n(x?.paisa) };
}

/* ───── the list behind a number (C1, C2): live from the source tables, audited ───── */
type Row = DrillView["rows"][number];
/** Rows listed per drill; the total and the count are always over every matching row (money-controls review M4). */
export const DRILL_ROWS = 200;
export async function drill(tx: Tx, s: SessionData, period: Period, what: DrillView["what"], now: Date): Promise<{ view: DrillView; audit: AuditEntry[] }> {
  const p = periodDays(period, now);
  const from = dayBounds(p.days[0]!).from;
  const to = period === "today" ? now : dayBounds(p.days[p.days.length - 1]!).to;
  const org = s.organizationId;
  const ids = new Set<string>();
  const people = async (list: (string | null | undefined)[]) => {
    const uniq = [...new Set(list.filter((x): x is string => !!x))];
    const rows = uniq.length ? await tx.user.findMany({ where: { id: { in: uniq } }, select: { id: true, nameBn: true, nameEn: true } }) : [];
    const mp = new Map(rows.map((r) => [r.id, r]));
    return (id: string | null | undefined) => (id ? mp.get(id) ?? { id, nameBn: "—", nameEn: "—" } : null);
  };
  // an over-the-counter sale may have no patient (ADR 0009) — its row shows none
  const patients = async (all: (string | null)[]) => {
    const list = all.filter((x): x is string => Boolean(x));
    const rows = list.length ? await tx.patient.findMany({ where: { id: { in: [...new Set(list)] } }, select: { id: true, nameBn: true, nameEn: true, facilityNo: true } }) : [];
    for (const r of rows) ids.add(r.id);
    const mp = new Map(rows.map((r) => [r.id, r]));
    return (id: string | null) => (id ? mp.get(id) ?? null : null);
  };
  let rows: Row[] = [];
  let count = 0;
  let totalPaisa: number | null = null;
  const invoiceWhere = { organizationId: org, issuedAt: { gte: from, lt: to }, status: { not: "entered_in_error" as const } };
  if (what === "revenue" || what === "discounts" || what === "discountAbovePolicy" || what === "dues") {
    const where = what === "dues" ? { organizationId: org, issuedAt: { lt: to }, status: { in: ["issued" as const, "partially_paid" as const] } }
      : what === "discounts" ? { ...invoiceWhere, discountPaisa: { gt: 0 } } : what === "discountAbovePolicy" ? { ...invoiceWhere, discountPaisa: { gt: 0 }, discountTaskId: { not: null } } : invoiceWhere;
    const [inv, agg] = await Promise.all([
      tx.invoice.findMany({ where, orderBy: { issuedAt: "desc" }, take: DRILL_ROWS }),
      tx.invoice.aggregate({ where, _count: { _all: true }, _sum: { totalPaisa: true, discountPaisa: true, paidPaisa: true, creditedPaisa: true } }),
    ]);
    count = agg._count._all;
    totalPaisa = what === "revenue" ? agg._sum.totalPaisa ?? 0 : what === "dues" ? (agg._sum.totalPaisa ?? 0) - (agg._sum.paidPaisa ?? 0) - (agg._sum.creditedPaisa ?? 0) : agg._sum.discountPaisa ?? 0;
    const tasks = await tx.task.findMany({ where: { id: { in: inv.map((i) => i.discountTaskId!).filter(Boolean) } } });
    const T = new Map(tasks.map((t) => [t.id, t]));
    const P = await patients(inv.map((i) => i.patientId));
    const W = await people([...inv.flatMap((i) => [i.issuedById, i.discountAppliedById]), ...tasks.flatMap((t) => [t.requestedById, t.decidedById])]);
    rows = inv.map((i) => {
      const t = i.discountTaskId ? T.get(i.discountTaskId) : undefined;
      const amount = what === "revenue" ? i.totalPaisa : what === "dues" ? i.totalPaisa - i.creditedPaisa - i.paidPaisa : i.discountPaisa;
      // a discount: who asked (above the limit) or who applied it (within the limit) — money-controls review L4
      const by = what === "discounts" || what === "discountAbovePolicy" ? (t ? W(t.requestedById) : W(i.discountAppliedById ?? i.issuedById)) : W(i.issuedById);
      return { id: i.id, at: (i.issuedAt ?? i.createdAt).toISOString(), number: i.number, patient: P(i.patientId), amountPaisa: amount, by, approvedBy: t ? W(t.decidedById) : null,
        detail: i.discountReason ?? null, link: { kind: "invoice" as const, id: i.id } };
    });
  } else if (what === "collections" || what === "cashOutsideShift") {
    let payIds: string[];
    if (what === "cashOutsideShift") {
      // the same rule as the dashboard's count, in SQL (money-controls review M4)
      const list = await tx.$queryRaw<{ id: string }[]>`
        SELECT p."id" FROM "Payment" p WHERE p."organizationId" = ${org} AND p."method" = 'cash' AND p."status" = 'confirmed' AND p."confirmedAt" >= ${from} AND p."confirmedAt" < ${to}
          AND NOT EXISTS (SELECT 1 FROM "Shift" s LEFT JOIN "ShiftCount" c ON c."id" = s."latestCountId" WHERE s."organizationId" = p."organizationId" AND s."cashierId" = p."createdById" AND s."openedAt" <= p."confirmedAt" AND (s."status" = 'open' OR c."windowTo" >= p."confirmedAt"))
        ORDER BY p."confirmedAt" DESC`;
      payIds = list.map((x) => x.id);
    } else {
      payIds = (await tx.payment.findMany({ where: { organizationId: org, status: "confirmed", confirmedAt: { gte: from, lt: to } }, select: { id: true }, orderBy: { confirmedAt: "desc" } })).map((x) => x.id);
    }
    const agg = await tx.payment.aggregate({ where: { id: { in: payIds } }, _sum: { amountPaisa: true } });
    count = payIds.length; totalPaisa = agg._sum.amountPaisa ?? 0;
    const list = await tx.payment.findMany({ where: { id: { in: payIds.slice(0, DRILL_ROWS) } }, orderBy: { confirmedAt: "desc" }, include: { invoice: { select: { number: true, patientId: true } } } });
    const P = await patients(list.map((x) => x.invoice.patientId));
    const W = await people(list.map((x) => x.createdById));
    rows = list.map((x) => ({ id: x.id, at: x.confirmedAt!.toISOString(), number: x.invoice.number, patient: P(x.invoice.patientId), amountPaisa: x.amountPaisa, by: W(x.createdById), approvedBy: null, detail: x.method, link: { kind: "invoice" as const, id: x.invoiceId } }));
  } else if (what === "opdVisits" || what === "noShows") {
    const where = what === "opdVisits" ? { organizationId: org, createdAt: { gte: from, lt: to }, status: { not: "entered_in_error" as const } } : { organizationId: org, cancelReason: "no-show", statusAt: { gte: from, lt: to } };
    const [enc, n] = await Promise.all([tx.encounter.findMany({ where, orderBy: { createdAt: "desc" }, take: DRILL_ROWS }), tx.encounter.count({ where })]);
    count = n;
    const P = await patients(enc.map((e) => e.patientId));
    rows = enc.map((e) => ({ id: e.id, at: (what === "noShows" ? e.statusAt : e.createdAt).toISOString(), number: e.token, patient: P(e.patientId), amountPaisa: null, by: null, approvedBy: null, detail: e.status.replace(/_/g, "-"), link: { kind: "visit" as const, id: e.id } }));
  } else if (what === "reprints") {
    const where = { copy: { gt: 0 }, printedAt: { gte: from, lt: to }, receipt: { organizationId: org } };
    const [rp, n] = await Promise.all([tx.receiptPrint.findMany({ where, include: { receipt: { select: { number: true, patientId: true, id: true } } }, orderBy: { printedAt: "desc" }, take: DRILL_ROWS }), tx.receiptPrint.count({ where })]);
    count = n;
    const P = await patients(rp.map((x) => x.receipt.patientId));
    const W = await people(rp.map((x) => x.printedById));
    rows = rp.map((x) => ({ id: x.id, at: x.printedAt.toISOString(), number: x.receipt.number, patient: P(x.receipt.patientId), amountPaisa: null, by: W(x.printedById), approvedBy: null, detail: `DUPLICATE #${x.copy} · ${x.reason ?? ""}`, link: { kind: "receipt" as const, id: x.receipt.id } }));
  } else if (what === "shiftVariance") {
    const rv = await tx.shiftReview.findMany({ where: { decision: "approve", at: { gte: from, lt: to }, shift: { organizationId: org } }, include: { shift: true }, orderBy: { at: "desc" } });
    const counts = await tx.shiftCount.findMany({ where: { id: { in: rv.map((r) => r.countId) } } });
    const C = new Map(counts.map((c) => [c.id, c]));
    const withVar = rv.filter((r) => (C.get(r.countId)?.variancePaisa ?? 0) !== 0);
    count = withVar.length;
    // the size of every variance, added up: short and over never cancel out (money-controls review H3)
    totalPaisa = withVar.reduce((a, r) => a + Math.abs(C.get(r.countId)!.variancePaisa), 0);
    const shown = withVar.slice(0, DRILL_ROWS);
    const W = await people([...shown.map((r) => r.byId), ...shown.map((r) => r.shift.cashierId)]);
    rows = shown.map((r) => ({ id: r.shiftId, at: r.at.toISOString(), number: null, patient: null, amountPaisa: C.get(r.countId)!.variancePaisa, by: W(r.shift.cashierId), approvedBy: W(r.byId), detail: `${C.get(r.countId)!.reason ?? ""} — ${r.note ?? ""}`, link: { kind: "shift" as const, id: r.shiftId } }));
  } else if (what === "notBilledHere") {
    const where = { notBilledAt: { gte: from, lt: to }, invoice: { organizationId: org } };
    const [ci, agg] = await Promise.all([tx.chargeItem.findMany({ where, include: { invoice: { select: { number: true, patientId: true } } }, orderBy: { notBilledAt: "desc" }, take: DRILL_ROWS }), tx.chargeItem.aggregate({ where, _count: { _all: true }, _sum: { grossPaisa: true } })]);
    count = agg._count._all; totalPaisa = agg._sum.grossPaisa ?? 0;
    const P = await patients(ci.map((x) => x.invoice.patientId));
    rows = ci.map((x) => ({ id: x.id, at: x.notBilledAt!.toISOString(), number: x.invoice.number, patient: P(x.invoice.patientId), amountPaisa: x.grossPaisa, by: null, approvedBy: null, detail: `${x.nameEn} — ${x.notBilledReason ?? ""}`, link: { kind: "invoice" as const, id: x.invoiceId } }));
  } else if (what === "stockValue" || what === "nearExpiry") {
    // the batches behind the tile, now (point-in-time — the period does not apply), by value
    const today = dhakaDay(now), near = addDay(today, NEAR_EXPIRY_DAYS);
    const batches = await tx.stockBatch.findMany({ where: { organizationId: org, qtyOnHand: { gt: 0 }, location: { not: "quarantine" }, expiry: what === "nearExpiry" ? { gte: today, lte: near } : { gte: today } } });
    const valued = batches.map((b) => ({ b, v: b.qtyOnHand * b.costPaisa })).sort((a, b) => b.v - a.v || a.b.expiry.localeCompare(b.b.expiry));
    count = valued.length; totalPaisa = valued.reduce((a, x) => a + x.v, 0);
    const name = (k: string) => { const md = MEDICINES_SAMPLE.find((x) => x.id === k); return md ? `${md.brand} ${md.strength}` : k; };
    rows = valued.slice(0, DRILL_ROWS).map(({ b, v }) => ({ id: b.id, at: b.createdAt.toISOString(), number: b.batchNo, patient: null, amountPaisa: v, by: null, approvedBy: null, detail: `${name(b.medicineKey)} · ${b.location} · exp ${b.expiry} · ${b.qtyOnHand}`, link: null }));
  } else if (what === "supplierDues") {
    const owed = await tx.$queryRaw<{ id: string; name: string; owed: bigint; last: Date }[]>`
      SELECT s."id", s."name", sum(CASE WHEN e."kind" = 'goods-received' THEN e."amountPaisa" ELSE -e."amountPaisa" END)::bigint AS owed, max(e."at") AS last
      FROM "SupplierEntry" e JOIN "Supplier" s ON s."id" = e."supplierId" WHERE e."organizationId" = ${org} GROUP BY s."id", s."name"
      HAVING sum(CASE WHEN e."kind" = 'goods-received' THEN e."amountPaisa" ELSE -e."amountPaisa" END) <> 0 ORDER BY 3 DESC`;
    count = owed.length; totalPaisa = owed.reduce((a, x) => a + Number(x.owed), 0);
    rows = owed.slice(0, DRILL_ROWS).map((x) => ({ id: x.id, at: x.last.toISOString(), number: x.name, patient: null, amountPaisa: Number(x.owed), by: null, approvedBy: null, detail: null, link: null }));
  } else if (what === "selfApproved") {
    const list = await tx.refund.findMany({ where: { organizationId: org, selfApproved: true, decidedAt: { gte: from, lt: to } }, include: { invoice: { select: { number: true } } }, orderBy: { decidedAt: "desc" } });
    count = list.length; totalPaisa = list.reduce((x, r) => x + r.amountPaisa, 0);
    const shown = list.slice(0, DRILL_ROWS);
    const P = await patients(shown.map((r) => r.patientId));
    const W = await people(shown.flatMap((r) => [r.requestedById, r.decidedById]));
    rows = shown.map((r) => ({ id: r.id, at: r.decidedAt!.toISOString(), number: r.invoice.number, patient: P(r.patientId), amountPaisa: r.amountPaisa, by: W(r.requestedById), approvedBy: W(r.decidedById),
      detail: `${r.category} — ${r.reason} · ${r.decisionNote ?? ""}`, link: { kind: "refund" as const, id: r.id }, status: r.status }));
  } else if (what === "refunds" || what === "refundsPaid" || what === "creditReturns") {
    // ADR 0013: refunds — money paid back in the period (by the day each part was paid) / refunds completed in the period;
    // every row with its reason, who asked and who approved; withdrawn is its own state, never "rejected"
    const allocs = what === "refunds" ? await tx.refundAllocation.findMany({ where: { status: "paid", paidAt: { gte: from, lt: to }, refund: { organizationId: org } }, select: { refundId: true, amountPaisa: true } }) : [];
    // money out (refunds) by allocation; refunds paid and returns without refund (decision 221) by the day they completed
    const where = what === "refunds" ? { id: { in: [...new Set(allocs.map((a) => a.refundId))] } } : { organizationId: org, kind: what === "creditReturns" ? "return" : "refund", status: "paid" as const, paidAt: { gte: from, lt: to } };
    const list = await tx.refund.findMany({ where, include: { invoice: { select: { number: true, id: true } }, voucher: { select: { number: true } } }, orderBy: { requestedAt: "desc" } });
    const amount = (r: (typeof list)[number]) => (what === "refunds" ? allocs.filter((a) => a.refundId === r.id).reduce((x, a) => x + a.amountPaisa, 0) : r.amountPaisa);
    count = list.length; totalPaisa = list.reduce((x, r) => x + amount(r), 0);
    const shown = list.slice(0, DRILL_ROWS);
    const P = await patients(shown.map((r) => r.patientId));
    const W = await people(shown.flatMap((r) => [r.requestedById, r.decidedById]));
    rows = shown.map((r) => ({ id: r.id, at: (r.paidAt ?? r.requestedAt).toISOString(), number: r.voucher?.number ?? r.invoice.number, patient: P(r.patientId), amountPaisa: amount(r), by: W(r.requestedById), approvedBy: W(r.decidedById),
      detail: `${r.category} — ${r.reason}`, link: { kind: "refund" as const, id: r.id }, status: r.status }));
  } else if (what === "manualRefundUnchecked") {
    const tasks = await tx.task.findMany({ where: { kind: "refund-reconciliation", status: "requested" }, orderBy: { requestedAt: "desc" } });
    const allocs = await tx.refundAllocation.findMany({ where: { id: { in: tasks.flatMap((t) => (t.focusId ? [t.focusId] : [])) }, refund: { organizationId: org } }, include: { refund: { include: { voucher: { select: { number: true } } } } } });
    count = allocs.length; totalPaisa = allocs.reduce((x, a) => x + a.amountPaisa, 0);
    const shown = allocs.slice(0, DRILL_ROWS);
    const P = await patients(shown.map((a) => a.refund.patientId));
    const W = await people(shown.flatMap((a) => [a.paidById, a.refund.decidedById]));
    rows = shown.map((a) => ({ id: a.id, at: (a.paidAt ?? a.refund.requestedAt).toISOString(), number: a.refund.voucher?.number ?? null, patient: P(a.refund.patientId), amountPaisa: a.amountPaisa, by: W(a.paidById), approvedBy: W(a.refund.decidedById),
      detail: `${a.method} → ${a.way} · ${a.reference ?? ""}`, link: { kind: "refund" as const, id: a.refundId }, status: a.refund.status }));
  } else if (what === "medicationIncident") {
    // every wrong-dispense medicine line that came back — a dispense or an OTC sale (review)
    const moves = await tx.stockMove.findMany({ where: { organizationId: org, kind: "return", refType: "refund-line", at: { gte: from, lt: to } }, include: { batch: { select: { medicineKey: true } } }, orderBy: { at: "desc" } });
    const lines = await tx.refundLine.findMany({ where: { id: { in: moves.flatMap((m) => (m.refId ? [m.refId] : [])) }, refund: { category: "wrong-dispense" } }, include: { refund: true } });
    const wrong = moves.filter((m) => lines.some((l) => l.id === m.refId));
    count = wrong.length; totalPaisa = wrong.reduce((x, m) => x + (lines.find((l) => l.id === m.refId)?.totalPaisa ?? 0), 0);
    const shown = wrong.slice(0, DRILL_ROWS);
    const P = await patients(shown.map((m) => lines.find((l) => l.id === m.refId)!.refund.patientId));
    const W = await people(shown.flatMap((m) => [m.byId, lines.find((l) => l.id === m.refId)!.refund.decidedById]));
    const name = (k: string) => { const md = MEDICINES_SAMPLE.find((x) => x.id === k); return md ? `${md.brand} ${md.strength}` : k; };
    rows = shown.map((m) => { const l = lines.find((x) => x.id === m.refId)!; return { id: m.id, at: m.at.toISOString(), number: null, patient: P(l.refund.patientId), amountPaisa: l.totalPaisa, by: W(m.byId), approvedBy: W(l.refund.decidedById),
      detail: `${name(m.batch.medicineKey)} × ${m.qty} — ${l.refund.reason}`, link: { kind: "refund" as const, id: l.refundId }, status: l.refund.status }; });
  } else if (what === "labTests") {
    const rel = await tx.$queryRaw<{ sr: string; released: Date }[]>`
      WITH day AS (SELECT DISTINCT x."serviceRequestId" AS sr FROM "DiagnosticReportResult" x JOIN "DiagnosticReport" r ON r."id" = x."reportId"
                   WHERE r."organizationId" = ${org} AND r."releasedAt" >= ${from} AND r."releasedAt" < ${to})
      SELECT x."serviceRequestId" AS sr, min(r."releasedAt") AS released FROM "DiagnosticReportResult" x JOIN "DiagnosticReport" r ON r."id" = x."reportId"
      WHERE x."serviceRequestId" IN (SELECT sr FROM day) GROUP BY 1 HAVING min(r."releasedAt") >= ${from} AND min(r."releasedAt") < ${to} ORDER BY 2 DESC`;
    count = rel.length;
    const shown = rel.slice(0, DRILL_ROWS);
    const srs = await tx.serviceRequest.findMany({ where: { id: { in: shown.map((r) => r.sr) } } });
    const S = new Map(srs.map((x) => [x.id, x]));
    const P = await patients(srs.map((x) => x.patientId));
    rows = shown.map((r) => { const x = S.get(r.sr)!; const mins = Math.round((r.released.getTime() - (x.orderedAt ?? x.createdAt).getTime()) / 60000); return { id: x.id, at: r.released.toISOString(), number: null, patient: P(x.patientId), amountPaisa: null, by: null, approvedBy: null, detail: `${x.nameEn} · ${mins} min`, link: { kind: "visit" as const, id: x.encounterId } }; });
  }
  return {
    view: { what, period, totalPaisa, count, truncated: count > rows.length, rows },
    audit: [{ action: "view", entity: "OwnerDrill", detail: { purpose: `owner-drill-${what}`, period, count, listed: rows.length, patientIds: [...ids] } }],
  };
}
