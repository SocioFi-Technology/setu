/* The owner dashboard (journey C1–C2, ADR 0008). One facility's metrics per Dhaka day, computed from the source tables;
   past days are kept in DailyRollup (nightly job, last 7 days recomputed), today is always live. Nothing here is a
   sample: tiles whose data comes with a later module say so (@setu/domain KPIS). Every list behind a number is audited
   with the patients it reveals. */
import type { DashboardView, DrillView } from "@setu/contracts";
import type { Tx } from "@setu/db";
import { KPIS, dhakaDay, kpiChange, periodDays, sumUpToHour, type KpiKey, type OpsKey, type Period } from "@setu/domain";
import type { AuditEntry } from "../command.js";
import type { SessionData } from "../plugins/session.js";

export const ROLLUP_VERSION = 1;
export interface DayMetrics {
  revenuePaisa: number; revenueByHour: number[]; collectionsPaisa: number; collectionsByHour: number[]; byMethod: Record<string, number>;
  discountsPaisa: number; duesPaisa: number; opdVisits: number; noShows: number; labTests: number; labTatMinutesSum: number;
  cashVariancePaisa: number; shiftsWithVariance: number; reprints: number;
  discountAbovePolicy: { count: number; paisa: number }; notBilledHere: { count: number; paisa: number }; cashOutsideShift: { count: number; paisa: number };
}
/** Dhaka day D runs from D 00:00 +06 to D+1 00:00 +06. */
export const dayBounds = (day: string) => { const from = new Date(Date.parse(`${day}T00:00:00+06:00`)); return { from, to: new Date(from.getTime() + 864e5) }; };
const hours = (rows: { h: number; paisa: bigint | number | null }[]) => { const a = Array<number>(24).fill(0); for (const r of rows) a[Number(r.h)] = Number(r.paisa ?? 0); return a; };
const n = (x: unknown) => Number(x ?? 0);

/** One facility's metrics for one Dhaka day, from the source tables (RLS keeps it to this tenant). */
export async function computeDay(tx: Tx, organizationId: string, day: string): Promise<DayMetrics> {
  const { from, to } = dayBounds(day);
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
        WHERE j."organizationId" = ${org} AND j."issuedAt" < ${to} AND j."status" <> 'entered-in-error' AND p."status" = 'confirmed' AND p."confirmedAt" < ${to}), 0) AS paisa
    FROM "Invoice" i WHERE i."organizationId" = ${org} AND i."issuedAt" < ${to} AND i."status" <> 'entered-in-error'`;
  const [visits] = await tx.$queryRaw<{ opd: bigint; noshow: bigint }[]>`
    SELECT count(*) FILTER (WHERE "createdAt" >= ${from} AND "createdAt" < ${to} AND "status" <> 'entered-in-error') AS opd,
           count(*) FILTER (WHERE "cancelReason" = 'no-show' AND "statusAt" >= ${from} AND "statusAt" < ${to}) AS noshow
    FROM "Encounter" WHERE "organizationId" = ${org} AND ("createdAt" >= ${from} - interval '2 days')`;
  const [lab] = await tx.$queryRaw<{ tests: bigint; minutes: number | null }[]>`
    WITH first AS (
      SELECT x."serviceRequestId" AS sr, min(r."releasedAt") AS released FROM "DiagnosticReportResult" x JOIN "DiagnosticReport" r ON r."id" = x."reportId"
      WHERE r."organizationId" = ${org} GROUP BY 1)
    SELECT count(*) AS tests, sum(extract(epoch from (f.released - coalesce(s."orderedAt", s."createdAt"))) / 60)::float AS minutes
    FROM first f JOIN "ServiceRequest" s ON s."id" = f.sr WHERE f.released >= ${from} AND f.released < ${to}`;
  const [shifts] = await tx.$queryRaw<{ paisa: bigint; n: bigint }[]>`
    SELECT coalesce(sum(c."variancePaisa"), 0) AS paisa, count(*) FILTER (WHERE c."variancePaisa" <> 0) AS n
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
  return {
    revenuePaisa: hours(rev).reduce((a, b) => a + b, 0), revenueByHour: hours(rev),
    collectionsPaisa: hours(col).reduce((a, b) => a + b, 0), collectionsByHour: hours(col),
    byMethod: Object.fromEntries(methods.map((m) => [m.method, n(m.paisa)])),
    discountsPaisa: n(disc?.all), duesPaisa: n(dues?.paisa), opdVisits: n(visits?.opd), noShows: n(visits?.noshow),
    labTests: n(lab?.tests), labTatMinutesSum: Math.round(n(lab?.minutes)),
    cashVariancePaisa: n(shifts?.paisa), shiftsWithVariance: n(shifts?.n), reprints: n(reprints?.n),
    discountAbovePolicy: { count: n(disc?.above), paisa: n(disc?.abovePaisa) },
    notBilledHere: { count: n(nb?.n), paisa: n(nb?.paisa) },
    cashOutsideShift: { count: n(outside?.n), paisa: n(outside?.paisa) },
  };
}

/** Stored past days (computed when missing); today is computed live and never stored. */
export async function metricsFor(tx: Tx, s: SessionData, days: string[], now: Date): Promise<Map<string, DayMetrics>> {
  const today = dhakaDay(now);
  const stored = await tx.dailyRollup.findMany({ where: { organizationId: s.organizationId, day: { in: days.filter((d) => d < today) }, version: ROLLUP_VERSION } });
  const out = new Map(stored.map((r) => [r.day, r.metrics as unknown as DayMetrics]));
  for (const d of days) {
    if (out.has(d) || d > today) continue;
    const m = await computeDay(tx, s.organizationId, d);
    out.set(d, m);
    if (d < today) await upsertRollup(tx, s.tenantId, s.organizationId, d, m, now);
  }
  return out;
}
export async function upsertRollup(tx: Tx, tenantId: string, organizationId: string, day: string, m: DayMetrics, now: Date) {
  await tx.dailyRollup.upsert({
    where: { tenantId_organizationId_day: { tenantId, organizationId, day } },
    create: { tenantId, organizationId, day, metrics: m as object, version: ROLLUP_VERSION, computedAt: now },
    update: { metrics: m as object, version: ROLLUP_VERSION, computedAt: now },
  });
}

/** The nightly job (ADR 0008): every facility, the last `back` finished days, recomputed (late voids and confirmations). */
export async function runNightlyRollup(now = new Date(), back = 7): Promise<{ facilities: number; days: number }> {
  const { prisma, forTenant } = await import("@setu/db");
  const targets = await prisma.$queryRaw<{ tenant_id: string; organization_id: string }[]>`SELECT * FROM rollup_targets()`;
  const today = dhakaDay(now);
  const days = Array.from({ length: back }, (_, i) => new Date(Date.parse(`${today}T00:00:00Z`) - (i + 1) * 864e5).toISOString().slice(0, 10));
  for (const t of targets) {
    await forTenant(t.tenant_id, async (tx) => { for (const d of days) await upsertRollup(tx, t.tenant_id, t.organization_id, d, await computeDay(tx, t.organization_id, d), now); }, { timeoutMs: 60_000 });
  }
  return { facilities: targets.length, days: days.length };
}

const sumBy = (m: Map<string, DayMetrics>, days: string[], f: (x: DayMetrics) => number) => days.reduce((a, d) => a + (m.has(d) ? f(m.get(d)!) : 0), 0);

export async function dashboard(tx: Tx, s: SessionData, period: Period, now: Date): Promise<DashboardView> {
  const p = periodDays(period, now);
  const m = await metricsFor(tx, s, [...p.days, ...p.previous], now);
  const H = p.uptoHour;
  // today is compared with the same weekday last week up to the same hour; a count without hours compares whole days
  const money = (f: (x: DayMetrics) => number[]) => ({ cur: sumBy(m, p.days, (x) => sumUpToHour(f(x), H)), prev: sumBy(m, p.previous, (x) => sumUpToHour(f(x), H)) });
  const plain = (f: (x: DayMetrics) => number) => ({ cur: sumBy(m, p.days, f), prev: sumBy(m, p.previous, f) });
  const last = (days: string[]) => days[days.length - 1]!;
  const values: Partial<Record<KpiKey, { cur: number; prev: number }>> = {
    revenue: money((x) => x.revenueByHour), collections: money((x) => x.collectionsByHour), discounts: plain((x) => x.discountsPaisa),
    dues: { cur: m.get(last(p.days))?.duesPaisa ?? 0, prev: m.get(last(p.previous))?.duesPaisa ?? 0 },
  };
  const opsVals: Record<OpsKey, { cur: number | null; prev: number | null }> = {
    opdVisits: plain((x) => x.opdVisits), labTests: plain((x) => x.labTests), noShows: plain((x) => x.noShows),
    labTat: (() => { const t = plain((x) => x.labTests), mins = plain((x) => x.labTatMinutesSum); return { cur: t.cur ? Math.round(mins.cur / t.cur) : null, prev: t.prev ? Math.round(mins.prev / t.prev) : null }; })(),
    cashVariance: plain((x) => x.cashVariancePaisa), reprints: plain((x) => x.reprints),
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
  const variance = { count: sumBy(m, p.days, (x) => x.shiftsWithVariance), paisa: sumBy(m, p.days, (x) => x.cashVariancePaisa) };
  const leakage = [
    { kind: "cashOutsideShift" as const, ...leak((x) => x.cashOutsideShift), severity: "high" as const },
    { kind: "shiftVariance" as const, ...variance, severity: "high" as const },
    { kind: "discountAbovePolicy" as const, ...leak((x) => x.discountAbovePolicy), severity: "review" as const },
    { kind: "reprints" as const, count: sumBy(m, p.days, (x) => x.reprints), paisa: 0, severity: "review" as const },
    { kind: "notBilledHere" as const, ...leak((x) => x.notBilledHere), severity: "review" as const },
  ];
  const [approvals, shiftsClosed, reconcile] = await Promise.all([
    tx.task.count({ where: { kind: { in: ["discount-approval", "bill-elsewhere"] }, status: "requested" } }),
    tx.shift.count({ where: { organizationId: s.organizationId, status: "closed" } }),
    tx.task.count({ where: { kind: "payment-reconciliation", status: "requested" } }),
  ]);
  return {
    period, days: p.days, previousDays: p.previous, uptoHour: H, asOf: now.toISOString(), kpis, ops, series,
    byMethod: (["cash", "bkash", "nagad", "card", "bank"] as const).map((method) => ({ method, paisa: byMethodTotals.get(method) ?? 0 })),
    leakage, pending: { approvals, shifts: shiftsClosed, reconcile },
  };
}

/* ───── the list behind a number (C1, C2): live from the source tables, audited ───── */
type Row = DrillView["rows"][number];
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
  const patients = async (list: string[]) => {
    const rows = list.length ? await tx.patient.findMany({ where: { id: { in: [...new Set(list)] } }, select: { id: true, nameBn: true, nameEn: true, facilityNo: true } }) : [];
    for (const r of rows) ids.add(r.id);
    const mp = new Map(rows.map((r) => [r.id, r]));
    return (id: string) => mp.get(id) ?? null;
  };
  let rows: Row[] = [];
  const invoiceWhere = { organizationId: org, issuedAt: { gte: from, lt: to }, status: { not: "entered_in_error" as const } };
  if (what === "revenue" || what === "discounts" || what === "discountAbovePolicy" || what === "dues") {
    const inv = await tx.invoice.findMany({
      where: what === "dues" ? { organizationId: org, issuedAt: { lt: to }, status: { in: ["issued", "partially_paid"] } }
        : what === "discounts" ? { ...invoiceWhere, discountPaisa: { gt: 0 } } : what === "discountAbovePolicy" ? { ...invoiceWhere, discountPaisa: { gt: 0 }, discountTaskId: { not: null } } : invoiceWhere,
      orderBy: { issuedAt: "desc" }, take: 200,
    });
    const tasks = what === "discountAbovePolicy" ? await tx.task.findMany({ where: { id: { in: inv.map((i) => i.discountTaskId!).filter(Boolean) } } }) : [];
    const T = new Map(tasks.map((t) => [t.id, t]));
    const P = await patients(inv.map((i) => i.patientId));
    const W = await people([...inv.map((i) => i.issuedById), ...tasks.flatMap((t) => [t.requestedById, t.decidedById])]);
    rows = inv.map((i) => {
      const t = i.discountTaskId ? T.get(i.discountTaskId) : undefined;
      const amount = what === "revenue" ? i.totalPaisa : what === "dues" ? i.totalPaisa - i.paidPaisa : i.discountPaisa;
      return { id: i.id, at: (i.issuedAt ?? i.createdAt).toISOString(), number: i.number, patient: P(i.patientId), amountPaisa: amount,
        by: what === "discountAbovePolicy" && t ? W(t.requestedById) : W(i.issuedById), approvedBy: t ? W(t.decidedById) : null,
        detail: i.discountReason ?? null, link: { kind: "invoice" as const, id: i.id } };
    });
  } else if (what === "collections" || what === "cashOutsideShift") {
    const pay = await tx.payment.findMany({ where: { organizationId: org, status: "confirmed", confirmedAt: { gte: from, lt: to }, ...(what === "cashOutsideShift" ? { method: "cash" } : {}) }, orderBy: { confirmedAt: "desc" }, take: 300, include: { invoice: { select: { number: true, patientId: true } } } });
    let list = pay;
    if (what === "cashOutsideShift") {
      const shifts = await tx.shift.findMany({ where: { organizationId: org, cashierId: { in: [...new Set(pay.map((x) => x.createdById))] } }, include: { counts: true } });
      list = pay.filter((x) => !shifts.some((sh) => sh.cashierId === x.createdById && sh.openedAt <= x.confirmedAt! && (sh.status === "open" || sh.counts.some((c) => c.id === sh.latestCountId && c.windowTo >= x.confirmedAt!))));
    }
    const P = await patients(list.map((x) => x.invoice.patientId));
    const W = await people(list.map((x) => x.createdById));
    rows = list.map((x) => ({ id: x.id, at: x.confirmedAt!.toISOString(), number: x.invoice.number, patient: P(x.invoice.patientId), amountPaisa: x.amountPaisa, by: W(x.createdById), approvedBy: null, detail: x.method, link: { kind: "invoice" as const, id: x.invoiceId } }));
  } else if (what === "opdVisits" || what === "noShows") {
    const enc = await tx.encounter.findMany({ where: what === "opdVisits" ? { organizationId: org, createdAt: { gte: from, lt: to }, status: { not: "entered_in_error" } } : { organizationId: org, cancelReason: "no-show", statusAt: { gte: from, lt: to } }, orderBy: { createdAt: "desc" }, take: 300 });
    const P = await patients(enc.map((e) => e.patientId));
    rows = enc.map((e) => ({ id: e.id, at: (what === "noShows" ? e.statusAt : e.createdAt).toISOString(), number: e.token, patient: P(e.patientId), amountPaisa: null, by: null, approvedBy: null, detail: e.status.replace(/_/g, "-"), link: { kind: "visit" as const, id: e.id } }));
  } else if (what === "reprints") {
    const rp = await tx.receiptPrint.findMany({ where: { copy: { gt: 0 }, printedAt: { gte: from, lt: to }, receipt: { organizationId: org } }, include: { receipt: { select: { number: true, patientId: true, id: true } } }, orderBy: { printedAt: "desc" }, take: 200 });
    const P = await patients(rp.map((x) => x.receipt.patientId));
    const W = await people(rp.map((x) => x.printedById));
    rows = rp.map((x) => ({ id: x.id, at: x.printedAt.toISOString(), number: x.receipt.number, patient: P(x.receipt.patientId), amountPaisa: null, by: W(x.printedById), approvedBy: null, detail: `DUPLICATE #${x.copy} · ${x.reason ?? ""}`, link: { kind: "receipt" as const, id: x.receipt.id } }));
  } else if (what === "shiftVariance") {
    const rv = await tx.shiftReview.findMany({ where: { decision: "approve", at: { gte: from, lt: to }, shift: { organizationId: org } }, include: { shift: true }, orderBy: { at: "desc" }, take: 200 });
    const counts = await tx.shiftCount.findMany({ where: { id: { in: rv.map((r) => r.countId) } } });
    const C = new Map(counts.map((c) => [c.id, c]));
    const W = await people([...rv.map((r) => r.byId), ...rv.map((r) => r.shift.cashierId)]);
    rows = rv.filter((r) => (C.get(r.countId)?.variancePaisa ?? 0) !== 0).map((r) => ({ id: r.shiftId, at: r.at.toISOString(), number: null, patient: null, amountPaisa: C.get(r.countId)!.variancePaisa, by: W(r.shift.cashierId), approvedBy: W(r.byId), detail: `${C.get(r.countId)!.reason ?? ""} — ${r.note ?? ""}`, link: { kind: "shift" as const, id: r.shiftId } }));
  } else if (what === "notBilledHere") {
    const ci = await tx.chargeItem.findMany({ where: { notBilledAt: { gte: from, lt: to }, invoice: { organizationId: org } }, include: { invoice: { select: { number: true, patientId: true } } }, orderBy: { notBilledAt: "desc" }, take: 200 });
    const P = await patients(ci.map((x) => x.invoice.patientId));
    rows = ci.map((x) => ({ id: x.id, at: x.notBilledAt!.toISOString(), number: x.invoice.number, patient: P(x.invoice.patientId), amountPaisa: x.grossPaisa, by: null, approvedBy: null, detail: `${x.nameEn} — ${x.notBilledReason ?? ""}`, link: { kind: "invoice" as const, id: x.invoiceId } }));
  } else if (what === "labTests") {
    const rel = await tx.$queryRaw<{ sr: string; released: Date }[]>`
      SELECT x."serviceRequestId" AS sr, min(r."releasedAt") AS released FROM "DiagnosticReportResult" x JOIN "DiagnosticReport" r ON r."id" = x."reportId"
      WHERE r."organizationId" = ${org} GROUP BY 1 HAVING min(r."releasedAt") >= ${from} AND min(r."releasedAt") < ${to} ORDER BY 2 DESC LIMIT 300`;
    const srs = await tx.serviceRequest.findMany({ where: { id: { in: rel.map((r) => r.sr) } } });
    const S = new Map(srs.map((x) => [x.id, x]));
    const P = await patients(srs.map((x) => x.patientId));
    rows = rel.map((r) => { const x = S.get(r.sr)!; const mins = Math.round((r.released.getTime() - (x.orderedAt ?? x.createdAt).getTime()) / 60000); return { id: x.id, at: r.released.toISOString(), number: null, patient: P(x.patientId), amountPaisa: null, by: null, approvedBy: null, detail: `${x.nameEn} · ${mins} min`, link: { kind: "visit" as const, id: x.encounterId } }; });
  }
  const totalPaisa = rows.some((r) => r.amountPaisa !== null) ? rows.reduce((a, r) => a + (r.amountPaisa ?? 0), 0) : null;
  return {
    view: { what, period, totalPaisa, count: rows.length, rows },
    audit: [{ action: "view", entity: "OwnerDrill", detail: { purpose: `owner-drill-${what}`, period, count: rows.length, patientIds: [...ids] } }],
  };
}
