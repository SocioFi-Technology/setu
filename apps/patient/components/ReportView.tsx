"use client";
/* D4 (ADR 0021): one lab report for a non-clinician — each result with its flag (text + icon, never colour alone), the
   range bar, the plain-language draft, the trend; a critical result shows only the value, the flag and "contact your
   doctor / the facility now" with the facility's phone (Kamrul 09/10/2026). Used by the patient app; the receiving
   doctor's staff screen shows the same facts its own way. */
import type { PatientReportView } from "@setu/contracts";
import { format } from "@setu/domain";
import { Icon } from "@setu/ui";
import { t, type Lang } from "@setu/i18n";

type Result = PatientReportView["tests"][number]["results"][number];
const FLAG_ICON: Record<string, string> = { N: "check", H: "arrow-up", L: "arrow-down", HH: "triangle-alert", LL: "triangle-alert" };

export function ReportBody({ r, lang }: { r: Omit<PatientReportView, "claimId">; lang: Lang }) {
  const T = (k: string, v?: Record<string, string | number>) => fillT(t(lang, "patientApp", k), v);
  const L = (k: string) => t(lang, "patientLab", k);
  const n = (x: number | string) => format.digits(x, lang === "bn");
  const nm = (en: string, bn: string) => (lang === "bn" ? bn : en);
  return (
    <>
      <div className="pa-why" role="note"><b>{T("not_diagnosis")}</b></div>
      {r.report.pendingCount > 0 && <p className="pa-sub">{T("pending_tests", { n: n(r.report.pendingCount) })}</p>}
      {r.tests.map((test) => (
        <section key={test.nameEn} className="pa-card" aria-label={nm(test.nameEn, test.nameBn)}>
          <b className="pa-label">{nm(test.nameEn, test.nameBn)}</b>
          {test.results.map((x) => <ResultRow key={x.observationId} x={x} lang={lang} T={T} L={L} n={n} phone={r.report.facilityPhone} />)}
        </section>
      ))}
    </>
  );
}

function ResultRow({ x, lang, T, L, n, phone }: { x: Result; lang: Lang; T: (k: string, v?: Record<string, string | number>) => string; L: (k: string) => string; n: (x: number | string) => string; phone: string | null }) {
  const value = n(x.value.toFixed(x.decimals));
  const crit = x.plain.kind === "critical";
  return (
    <div className="pa-result" data-analyte={x.code} data-flag={x.flag ?? "none"}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span className="pa-label">{lang === "bn" ? x.nameBn : x.nameEn}</span>
        {x.flag && <span className={`pa-flag pa-flag-${x.flag}`}><Icon name={FLAG_ICON[x.flag]!} size={13} />{T(`flag_${x.flag}`)}</span>}
      </div>
      <div><span className="pa-value">{value}</span> <span className="pa-meta">{x.unit}</span></div>
      {x.withdrawn && <span className="pa-err">{T("withdrawn")}</span>}
      {x.corrected && !x.withdrawn && <span className="pa-note">{T("corrected")}</span>}
      {crit ? (
        <div className="pa-crit" role="alert">
          <span style={{ display: "flex", gap: 8 }}><Icon name="phone-call" size={18} />{T("critical_now")}</span>
          {phone && <a className="pa-btn pa-btn-primary" href={`tel:${phone.replace(/[^0-9+]/g, "")}`}>{T("call_facility", { phone: n(phone) })}</a>}
        </div>
      ) : (
        <>
          {x.position !== null && x.refLow !== null && x.refHigh !== null ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div className="pa-bar" aria-hidden><i style={{ left: `${x.position * 100}%` }} /></div>
              <span className="pa-note">{T("range", { low: n(x.refLow), high: n(x.refHigh) })}</span>
            </div>
          ) : <span className="pa-note">{T("no_range")}</span>}
          {x.plain.kind === "explained" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="pa-sub">{L(x.plain.what)}{x.plain.direction ? " " + L(x.plain.direction) : ""}</span>
              <span className="pa-note">{L(x.plain.unit)}</span>
              {x.plain.draft && <span className="pa-note" data-draft><Icon name="file-pen" size={12} /> {T("draft_wording")}</span>}
            </div>
          )}
        </>
      )}
      {x.trend.length > 1 && !crit && <Trend x={x} lang={lang} T={T} n={n} />}
    </div>
  );
}

/** the analyte over time (inline SVG, no chart library): oldest → newest, the current one marked */
function Trend({ x, lang, T, n }: { x: Result; lang: Lang; T: (k: string) => string; n: (x: number | string) => string }) {
  const W = 300, H = 70, P = 10;
  const vals = x.trend.map((p) => p.value);
  const lo = Math.min(...vals, x.refLow ?? Infinity), hi = Math.max(...vals, x.refHigh ?? -Infinity);
  const span = hi - lo || 1;
  const px = (i: number) => P + (i * (W - 2 * P)) / Math.max(1, x.trend.length - 1);
  const py = (v: number) => H - P - ((v - lo) / span) * (H - 2 * P);
  return (
    <figure style={{ margin: 0 }} aria-label={T("trend")}>
      <span className="pa-note">{T("trend")}</span>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={x.trend.map((p) => `${format.date(p.at, lang === "bn")}: ${n(p.value)}`).join(", ")}>
        {x.refLow !== null && x.refHigh !== null && <rect x={0} y={py(x.refHigh)} width={W} height={Math.max(1, py(x.refLow) - py(x.refHigh))} fill="var(--success-bg)" />}
        <polyline fill="none" stroke="var(--brand-primary)" strokeWidth={2} points={x.trend.map((p, i) => `${px(i)},${py(p.value)}`).join(" ")} />
        {x.trend.map((p, i) => <circle key={i} cx={px(i)} cy={py(p.value)} r={p.current ? 5 : 3.5} fill={p.current ? "var(--brand-primary)" : "var(--surface-card)"} stroke="var(--brand-primary)" strokeWidth={2} />)}
      </svg>
      <ol className="pa-note" style={{ margin: 0, paddingLeft: 18 }}>
        {x.trend.map((p, i) => <li key={i}>{format.date(p.at, lang === "bn")} · <b>{n(p.value)}</b>{(lang === "bn" ? p.facilityBn ?? p.facilityEn : p.facilityEn ?? p.facilityBn) ? ` · ${lang === "bn" ? p.facilityBn ?? p.facilityEn : p.facilityEn ?? p.facilityBn}` : ""}</li>)}
      </ol>
    </figure>
  );
}

const fillT = (s: string, v?: Record<string, string | number>) => (v ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m)) : s);
