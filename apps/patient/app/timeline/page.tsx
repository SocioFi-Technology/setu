"use client";
/* D3 — the history: every linked facility's finished visits, admissions, signed prescriptions and discharge summaries,
   and released lab reports, newest first, each with its facility, date and source badge. */
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Timeline, TimelineItem } from "@setu/contracts";
import { format } from "@setu/domain";
import { Icon } from "@setu/ui";
import { Shell } from "../../components/Shell";
import { ApiFailure, patient } from "../../lib/api";
import { keep, seen } from "../../lib/cache";
import { errText, useLang } from "../../lib/lang";

const FILTERS = [["all", "f_all"], ["reports", "f_reports"], ["prescriptions", "f_prescriptions"], ["visits", "f_visits"], ["mine", "f_mine"]] as const;
type Filter = (typeof FILTERS)[number][0];
const ICON: Record<TimelineItem["kind"], string> = { visit: "stethoscope", admission: "bed-double", prescription: "pill", report: "test-tube", summary: "file-text" };

export default function TimelinePage() {
  const { lang, T, n } = useLang();
  const [filter, setFilter] = useState<Filter>("all");
  const [data, setData] = useState<Timeline | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toClaim, setToClaim] = useState(0);

  useEffect(() => { patient.me().then((m) => setToClaim(m.counts.toClaim)).catch(() => {}); }, []);
  useEffect(() => {
    let live = true;
    setError(null);
    patient.timeline(filter).then((t) => { if (!live) return; setData(t); setStale(null); keep("timeline:" + filter, t); })
      .catch((e) => {
        if (!live) return;
        const copy = seen<Timeline>("timeline:" + filter);
        if (copy && e instanceof ApiFailure && e.status === 0) { setData(copy.value); setStale(copy.at); } else { setData(null); setError(errText(lang, e, T)); }
      });
    return () => { live = false; };
  }, [filter, lang, T]);

  const title = (i: TimelineItem) => {
    const base = i.kind === "visit" ? T(i.visitClass === "er" ? "k_visit_er" : "k_visit_opd") : T("k_" + i.kind);
    return i.kind === "report" && i.number ? `${base} · ${i.number}` : base;
  };
  const fac = (i: TimelineItem) => (lang === "bn" ? i.facilityBn ?? i.facilityEn : i.facilityEn ?? i.facilityBn) ?? T("facility_unknown");
  const doc = (i: TimelineItem) => (lang === "bn" ? i.doctorBn ?? i.doctorEn : i.doctorEn ?? i.doctorBn);
  /* the source badge in the provenance colours (CLAUDE.md rule 2): provider-verified solid edge, the patient's dashed */
  const src = (i: TimelineItem) => {
    const [cls, icon, key] = i.source === "provider-verified" ? ["ver", "shield-check", "src_verified"] : i.source === "patient-uploaded" ? ["upl", "upload", "src_uploaded"] : ["rep", "user-round", "src_reported"];
    return <span className={`pa-src pa-src-${cls}`}><Icon name={icon} size={13} />{T(key)}</span>;
  };

  return (
    <Shell>
      <h1 className="pa-h2">{T("history_title")}</h1>
      {toClaim > 0 && <Link className="pa-btn" href="/claim"><Icon name="search" size={18} />{T("claim_more", { n: n(toClaim) })}</Link>}
      <div className="pa-chips" role="group" aria-label={T("history_title")}>
        {FILTERS.map(([k, key]) => <button key={k} type="button" className="pa-chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>{T(key)}</button>)}
      </div>
      {stale && <div className="offline-banner" role="status"><Icon name="wifi-off" size={16} />{T("offline_cached", { t: format.dateTime(stale, lang === "bn") })}</div>}
      {error && <span className="pa-err" role="alert"><Icon name="circle-x" size={16} />{error}</span>}
      {data === null && !error && <p className="pa-sub">{T("loading")}</p>}
      {data && data.items.length === 0 && <p className="pa-sub">{filter === "mine" ? T("empty_mine") : data.facilities === 0 ? T("empty_history") : T("empty_filter")}</p>}
      {data?.items.map((i) => {
        const body = (
          <>
            <span className="pa-ic"><Icon name={ICON[i.kind]} size={20} /></span>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="pa-meta">{format.date(i.at, lang === "bn")}{i.unread ? <> · <span className="pa-new">{T("new_badge")}</span></> : null}</span>
              <b>{title(i)}</b>
              <span className="pa-meta">{fac(i)}{doc(i) ? ` · ${doc(i)}` : ""}{i.status === "amended" || i.status === "corrected" ? ` · ${T("amended")}` : ""}</span>
              <span>{src(i)}</span>
            </div>
            {(i.kind === "report" || i.kind === "prescription" || i.kind === "summary") && <Icon name="chevron-right" size={20} style={{ alignSelf: "center", color: "var(--text-muted)" }} />}
          </>
        );
        const attrs = { className: "pa-item", "data-src": i.source === "provider-verified" ? "provider" : "patient", "data-kind": i.kind, "data-unread": i.unread ? "1" : undefined } as const;
        // a report opens its screen; a prescription or a discharge summary opens the patient's copy (their screens: later slices)
        if (i.kind === "report") return <Link key={i.key} href={`/report/${i.claimId}/${i.recordId}`} {...attrs}>{body}</Link>;
        if (i.kind === "prescription" || i.kind === "summary") return <a key={i.key} href={patient.pdfUrl(i.claimId, i.kind === "prescription" ? "rx" : "ds", i.recordId, lang)} target="_blank" rel="noopener" {...attrs}>{body}</a>;
        return <article key={i.key} {...attrs}>{body}</article>;
      })}
    </Shell>
  );
}
