"use client";
/* own/dash — the owner dashboard (journey C1–C2, ADR 0008; prototype Setu Owner Dashboard, desktop 1440 + phone 412).
   Every number is the server's (live today, rollup for past days) with its change against the period before, judged
   by the KPI's own direction (issue #23); tiles whose data comes with a later module say so. Every tile, operations
   count and leakage line opens the list behind it (audited — "viewing is logged"). Revenue vs collected: one taka axis
   with labelled ticks and a labelled time axis, a legend, a hover tooltip and a table view (dataviz checks; series
   colours validated light + dark, collected also dashed). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DashboardView, DrillView } from "@setu/contracts";
import { format } from "@setu/domain";
import { fill } from "@setu/i18n";
import { Button, Callout, Card, Dialog, Icon, PageState, Pill, Segmented } from "@setu/ui";
import { owner } from "../../lib/api";
import { useSession } from "../../lib/session";

type Period = "today" | "7d" | "30d";
function useO() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) =>
    fill(s.t("ownerApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}
function useFmt() {
  const s = useSession(); const bn = s.numerals === "bn";
  return {
    tk: (p: number) => format.takaFromPaisa(p, { bn }),
    num: (n: number | string) => format.digits(n, bn),
    dateTime: (iso: string) => format.dateTime(iso, bn),
    date: (d: string) => format.date(d, bn),
    /** axis ticks: ৳ in thousands or lakh (South Asian grouping), the unit named on the axis */
    short: (paisa: number) => { const t = paisa / 100; return t >= 100_000 ? `${format.digits((t / 100_000).toFixed(t >= 1_000_000 ? 0 : 1), bn)}${s.lang === "bn" ? " লাখ" : "L"}` : t >= 1000 ? `${format.digits(Math.round(t / 1000), bn)}${s.lang === "bn" ? " হা." : "k"}` : format.digits(Math.round(t), bn); },
    name: (p: { nameBn: string; nameEn: string | null } | null | undefined) => (p ? (s.lang === "bn" ? p.nameBn : p.nameEn ?? p.nameBn) : "—"),
  };
}
const MONEY_OPS = new Set(["cashVariance"]);

/** `home`: rendered as the owner's home page — the heading greets the owner (prototype "শুভ সকাল, আনোয়ার"). */
export function OwnerDash({ home = false }: { home?: boolean } = {}) {
  const s = useSession(); const O = useO(); const F = useFmt();
  const first = ((s.lang === "bn" ? s.me?.nameBn : s.me?.nameEn) ?? "").split(" ").slice(-1)[0] ?? "";
  const [period, setPeriod] = useState<Period>("today");
  const [v, setV] = useState<DashboardView | null>(null); const [failed, setFailed] = useState(false);
  const [drill, setDrill] = useState<DrillView["what"] | null>(null);
  const load = useCallback(async (p: Period) => { setV(null); try { setV(await owner.dashboard(p)); setFailed(false); } catch { setFailed(true); } }, []);
  useEffect(() => { s.setPatient(null); void load(period); }, [period]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (pct: number | null, judgement: string | null) => pct === null || judgement === null
    ? <span className="t-small t-muted">{O("no_compare")}</span>
    : <span className="t-small" data-judgement={judgement} style={{ color: judgement === "worse" ? "var(--danger-fg)" : judgement === "better" ? "var(--success-fg)" : "var(--text-secondary)" }}>
        <Icon name={pct > 0 ? "arrow-up" : pct < 0 ? "arrow-down" : "minus"} size={12} /> {F.num(`${pct > 0 ? "+" : ""}${pct}%`)} · {O(`j_${judgement}`)}</span>;
  return (
    <div data-screen="own/dash" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {home ? <span style={{ display: "flex", flexDirection: "column" }}><h1 className="t-h2" style={{ margin: 0 }}>{s.L("শুভ সকাল, ", "Good morning, ") + first}</h1><span className="t-small t-muted">{O("dash_title")}</span></span>
          : <h1 className="t-h2" style={{ margin: 0 }}>{O("dash_title")}</h1>}
        <span style={{ marginLeft: "auto" }} />
        <Segmented label={O("dash_title")} value={period} onChange={(p) => setPeriod(p as Period)} options={(["today", "7d", "30d"] as const).map((p) => ({ value: p, label: O(`p_${p}`) }))} />
      </div>
      {v && <span className="t-small t-muted" data-testid="dash-compare">{v.uptoHour !== null ? O("vs_today", { h: F.num(v.uptoHour + 1) }) : O("vs_period", { n: v.days.length })} · {O("as_of", { at: F.dateTime(v.asOf) })}</span>}
      {!s.online && <Callout tone="warn" icon="cloud-off">{O("needs_connection")}</Callout>}
      {failed && <Callout tone="warn" icon="triangle-alert">{O("error_generic")} <Button size="sm" onClick={() => void load(period)}>↻</Button></Callout>}
      {!failed && !v && <div aria-busy="true" className="t-muted">{O("loading")}</div>}
      {v && (
        <>
          {(v.pending.approvals > 0 || v.pending.shifts > 0 || v.pending.reconcile > 0 || v.pending.staleShifts > 0) && <Pending v={v} />}
          {v.missingDays.length > 0 && <Callout icon="hourglass" data-testid="missing-days">{O("missing_days", { n: v.missingDays.length })}</Callout>}
          <div className="kpi-grid-own" data-testid="kpi-tiles">
            {/* tiles with data first; those that come with a later module after them (they pushed the chart off a phone) */}
            {[...v.kpis.filter((k) => !k.comesWith), ...v.kpis.filter((k) => k.comesWith)].map((k) => (
              <button key={k.key} type="button" className="kpi-tile" data-kpi={k.key} disabled={!!k.comesWith} style={k.comesWith ? { cursor: "default", opacity: 0.75 } : undefined}
                onClick={() => !k.comesWith && setDrill(k.key as DrillView["what"])}>
                <span className="t-small t-secondary">{O(`k_${k.key}`)}</span>
                {k.comesWith ? <span className="t-small t-muted" data-testid="comes-with">{O(`comes_${k.comesWith}`)}</span> : <>
                  <span className="v num">{F.tk(k.value ?? 0)}</span>
                  {change(k.pct, k.judgement)}
                  {k.sub && <span className="t-small t-muted">{O("collected_of", { pct: k.sub })}</span>}
                </>}
              </button>
            ))}
          </div>
          <div className="own-cols">
            <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
              <RevenueChart v={v} />
            </Card>
            <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }} data-testid="by-method">
              <b>{O("by_method")}</b>
              <MethodBars v={v} />
            </Card>
          </div>
          <div className="own-cols">
            <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }} data-testid="leakage">
              <b>{O("leak_title")}</b>
              {v.leakage.map((l) => (
                <button key={l.kind} type="button" className="kpi-tile" data-leak={l.kind} data-count={l.count} onClick={() => setDrill(l.kind)} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <Pill tone={l.count === 0 ? "ok" : l.severity === "high" ? "bad" : "warn"} icon={l.count === 0 ? "check" : l.severity === "high" ? "siren" : "eye"}>{l.count === 0 ? O("leak_none") : O(`sev_${l.severity}`)}</Pill>
                  <span style={{ flex: 1, minWidth: 0 }}>{O(`l_${l.kind}`)}</span>
                  <span className="num t-small">{F.num(l.count)}{l.paisa ? ` · ${F.tk(l.paisa)}` : ""}{l.kind === "shiftVariance" && l.count ? <><br />{O("cash_split", { short: F.tk(v.cash.shortPaisa), over: F.tk(v.cash.overPaisa) })}</> : null}</span>
                  <Icon name="chevron-right" size={14} />
                </button>
              ))}
            </Card>
            <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }} data-testid="ops">
              <b>{O("ops_title")}</b>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {v.ops.map((o) => {
                  const drillable = ["opdVisits", "labTests", "noShows", "reprints"].includes(o.key) || o.key === "cashVariance";
                  return (
                    <button key={o.key} type="button" className="kpi-tile" data-ops={o.key} disabled={!drillable} onClick={() => drillable && setDrill(o.key === "cashVariance" ? "shiftVariance" : (o.key as DrillView["what"]))}>
                      <span className="t-small t-secondary">{O(`o_${o.key}`)}</span>
                      <span className="v num" style={{ fontSize: 18 }}>{o.value === null ? "—" : MONEY_OPS.has(o.key) ? F.tk(o.value) : F.num(o.value)}</span>
                      {change(o.pct, o.judgement)}
                    </button>
                  );
                })}
              </div>
            </Card>
          </div>
        </>
      )}
      {drill && v && <DrillDialog period={period} what={drill} onClose={() => setDrill(null)} />}
    </div>
  );
}

function Pending({ v }: { v: DashboardView }) {
  const O = useO(); const router = useRouter();
  return (
    <Card style={{ padding: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }} data-testid="pending">
      <b className="t-small">{O("pending_title")}</b>
      {v.pending.approvals > 0 && <Button size="sm" icon="badge-check" data-testid="pending-approvals" onClick={() => router.push("/m/bill/approvals")}>{O("pending_approvals", { n: v.pending.approvals })}</Button>}
      {v.pending.shifts > 0 && <Button size="sm" icon="lock" data-testid="pending-shifts" onClick={() => router.push("/m/bill/shift")}>{O("pending_shifts", { n: v.pending.shifts })}</Button>}
      {v.pending.reconcile > 0 && <Button size="sm" icon="scale" onClick={() => router.push("/m/bill/reconcile")}>{O("pending_reconcile", { n: v.pending.reconcile })}</Button>}
      {v.pending.staleShifts > 0 && <Button size="sm" icon="clock" data-testid="pending-stale" onClick={() => router.push("/m/bill/shift")}>{O("pending_stale", { n: v.pending.staleShifts })}</Button>}
    </Card>
  );
}

function MethodBars({ v }: { v: DashboardView }) {
  const O = useO(); const F = useFmt();
  const total = v.byMethod.reduce((a, m) => a + m.paisa, 0);
  const max = Math.max(1, ...v.byMethod.map((m) => m.paisa));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {v.byMethod.map((m) => (
        <span key={m.method} data-method={m.method} title={`${O(`m_${m.method}`)} ${F.tk(m.paisa)}`} style={{ display: "grid", gridTemplateColumns: "64px 1fr auto", gap: 8, alignItems: "center" }}>
          <span className="t-small">{O(`m_${m.method}`)}</span>
          <span style={{ height: 10, background: "var(--surface-sunken)", borderRadius: 4 }}>
            <span style={{ display: "block", height: 10, width: `${(m.paisa / max) * 100}%`, background: "var(--chart-revenue)", borderRadius: 4 }} />
          </span>
          <span className="num t-small">{F.tk(m.paisa)} · {F.num(total ? Math.round((m.paisa / total) * 100) : 0)}%</span>
        </span>
      ))}
    </div>
  );
}

function RevenueChart({ v }: { v: DashboardView }) {
  const O = useO(); const F = useFmt(); const s = useSession();
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const pts = v.series.points;
  const W = 640, H = 240, L = 56, R = 12, T = 12, B = 34;
  const max = Math.max(1, ...pts.flatMap((p) => [p.revenuePaisa, p.collectedPaisa]));
  const step = useMemo(() => { const raw = max / 4; const mag = 10 ** Math.floor(Math.log10(raw)); const n = [1, 2, 2.5, 5, 10].find((k) => k * mag >= raw)! * mag; return n; }, [max]);
  const top = step * Math.ceil(max / step);
  const x = (i: number) => L + (pts.length <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (pts.length - 1));
  const y = (p: number) => T + (H - T - B) * (1 - p / top);
  const line = (f: (p: (typeof pts)[number]) => number) => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(f(p)).toFixed(1)}`).join(" ");
  const label = (l: string) => (v.series.unit === "hour" ? F.num(l) : F.date(l).slice(0, 5));
  const every = Math.max(1, Math.ceil(pts.length / 8));
  const empty = pts.every((p) => !p.revenuePaisa && !p.collectedPaisa);
  const onMove = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0; for (let i = 1; i < pts.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    setHover(best);
  };
  return (
    <div data-testid="revenue-chart" style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <b>{O("chart_title")}</b>
        <span className="t-small" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><svg width="22" height="8" aria-hidden><line x1="0" y1="4" x2="22" y2="4" stroke="var(--chart-revenue)" strokeWidth="2" /></svg>{O("chart_revenue")}</span>
        <span className="t-small" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><svg width="22" height="8" aria-hidden><line x1="0" y1="4" x2="22" y2="4" stroke="var(--chart-collected)" strokeWidth="2" strokeDasharray="5 3" /></svg>{O("chart_collected")}</span>
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" variant="ghost" icon={table ? "chart-line" : "table"} onClick={() => setTable((t) => !t)}>{table ? O("chart_chart") : O("chart_table")}</Button>
      </span>
      {empty ? <span className="t-small t-muted">{O("chart_empty")}</span> : table ? (
        <table className="table" data-testid="chart-table">
          <thead><tr><th>{v.series.unit === "hour" ? O("chart_x_hour") : O("chart_x_day")}</th><th>{O("chart_revenue")}</th><th>{O("chart_collected")}</th></tr></thead>
          <tbody>{pts.map((p) => <tr key={p.label}><td className="num">{label(p.label)}</td><td className="num">{F.tk(p.revenuePaisa)}</td><td className="num">{F.tk(p.collectedPaisa)}</td></tr>)}</tbody>
        </table>
      ) : (
        <div style={{ position: "relative" }}>
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${O("chart_title")} — ${O("chart_y")}, ${v.series.unit === "hour" ? O("chart_x_hour") : O("chart_x_day")}`}
            onPointerMove={onMove} onPointerLeave={() => setHover(null)} style={{ display: "block", touchAction: "pan-y" }}>
            {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((t) => (
              <g key={t}>
                <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--border-subtle)" strokeWidth="1" />
                <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)" className="num">{F.short(t)}</text>
              </g>
            ))}
            {pts.map((p, i) => (i % every === 0 || i === pts.length - 1) && <text key={p.label} x={x(i)} y={H - B + 16} textAnchor="middle" fontSize="11" fill="var(--text-muted)">{label(p.label)}</text>)}
            <text x={L} y={H - 4} fontSize="10" fill="var(--text-muted)">{v.series.unit === "hour" ? O("chart_x_hour") : O("chart_x_day")} · {O("chart_y")}</text>
            <path d={line((p) => p.revenuePaisa)} fill="none" stroke="var(--chart-revenue)" strokeWidth="2" strokeLinejoin="round" />
            <path d={line((p) => p.collectedPaisa)} fill="none" stroke="var(--chart-collected)" strokeWidth="2" strokeDasharray="6 4" strokeLinejoin="round" />
            {hover !== null && <>
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="var(--border-default)" strokeWidth="1" />
              <circle cx={x(hover)} cy={y(pts[hover]!.revenuePaisa)} r="4" fill="var(--chart-revenue)" stroke="var(--surface-card)" strokeWidth="2" />
              <circle cx={x(hover)} cy={y(pts[hover]!.collectedPaisa)} r="4" fill="var(--chart-collected)" stroke="var(--surface-card)" strokeWidth="2" />
            </>}
          </svg>
          {hover !== null && (
            <div role="status" className="card t-small" style={{ position: "absolute", top: 4, left: `${Math.min(70, (x(hover) / W) * 100)}%`, padding: "6px 8px", pointerEvents: "none", boxShadow: "var(--shadow-2)", whiteSpace: "nowrap" }}>
              <b className="num">{label(pts[hover]!.label)}{v.series.unit === "hour" ? (s.lang === "bn" ? "টা" : ":00") : ""}</b><br />
              {O("chart_revenue")}: <span className="num">{F.tk(pts[hover]!.revenuePaisa)}</span><br />
              {O("chart_collected")}: <span className="num">{F.tk(pts[hover]!.collectedPaisa)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DrillDialog({ period, what, onClose }: { period: Period; what: DrillView["what"]; onClose: () => void }) {
  const O = useO(); const F = useFmt(); const router = useRouter();
  const [d, setD] = useState<DrillView | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => { owner.drill(period, what).then(setD).catch(() => setFailed(true)); }, [period, what]);
  const title = (["revenue", "collections", "dues", "discounts", "stockValue", "nearExpiry", "supplierDues"].includes(what) ? O(`k_${what}`) : ["opdVisits", "labTests", "noShows"].includes(what) ? O(`o_${what}`) : O(`l_${what}`));
  const href = (l: NonNullable<DrillView["rows"][number]["link"]>) => l.kind === "invoice" ? `/m/bill/opd?inv=${encodeURIComponent(l.id)}` : l.kind === "receipt" ? `/m/bill/receipt?id=${encodeURIComponent(l.id)}` : l.kind === "shift" ? "/m/bill/shift" : l.kind === "refund" ? `/m/bill/refund?rf=${encodeURIComponent(l.id)}` : null;
  return (
    <Dialog open onClose={onClose} label={title} width={760}>
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, maxHeight: "80vh", overflow: "auto" }} data-testid="drill" data-what={what}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}><b className="t-h3">{title}</b><span style={{ marginLeft: "auto" }} /><Button size="sm" onClick={onClose}>{O("close")}</Button></span>
        <span className="t-small t-muted"><Icon name="eye" size={12} /> {O("drill_logged")}</span>
        {failed && <Callout tone="warn" icon="triangle-alert">{O("error_generic")}</Callout>}
        {!d && !failed && <div aria-busy="true" className="t-muted">{O("loading")}</div>}
        {d && (d.rows.length === 0 ? <PageState icon="inbox" title={O("drill_empty")} /> : (
          <>
            <span className="t-small" data-testid="drill-total">{O("drill_total", { total: d.totalPaisa === null ? "—" : F.tk(d.totalPaisa), n: d.count })}</span>
            {d.truncated && <span className="t-small t-muted" data-testid="drill-truncated">{O("drill_truncated", { n: d.rows.length })}</span>}
            {d.rows.map((r) => {
              const to = r.link ? href(r.link) : null;
              return (
                <div key={r.id} data-drill-row={r.id} className="card" style={{ padding: "8px 10px", display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: "1 1 220px", minWidth: 0 }}>
                    <b style={{ overflowWrap: "anywhere" }}>{r.patient ? `${F.name(r.patient)} · ${r.patient.facilityNo}` : r.by ? F.name({ nameBn: r.by.nameBn, nameEn: r.by.nameEn }) : "—"}</b>
                    <span className="t-small t-muted num">{F.dateTime(r.at)}{r.number ? ` · ${r.number}` : ""}</span>
                    {r.detail && <span className="t-small">{r.detail}</span>}
                    {(r.by && r.patient) || r.approvedBy ? <span className="t-small t-muted">{r.by && r.patient ? O("drill_by", { name: F.name({ nameBn: r.by.nameBn, nameEn: r.by.nameEn }) }) : ""}{r.approvedBy ? ` · ${O("drill_approved", { name: F.name({ nameBn: r.approvedBy.nameBn, nameEn: r.approvedBy.nameEn }) })}` : ""}</span> : null}
                  </span>
                  {/* ADR 0013: a refund's state — withdrawn is its own state, never shown as rejected */}
                  {r.status && <span data-refund-status={r.status}><Pill tone={r.status === "paid" ? "ok" : r.status === "rejected" ? "bad" : r.status === "withdrawn" ? "off" : "pend"}>{O(`rs_${r.status}`)}</Pill></span>}
                  {r.amountPaisa !== null && <b className="num">{F.tk(r.amountPaisa)}</b>}
                  {to && <Button size="sm" variant="ghost" icon="external-link" onClick={() => router.push(to)}>{O("drill_open")}</Button>}
                </div>
              );
            })}
          </>
        ))}
      </div>
    </Dialog>
  );
}
