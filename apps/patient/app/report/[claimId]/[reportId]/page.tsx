"use client";
/* D4 (ADR 0021): a lab report — "Results & explanation" and "Original PDF" (the facility's copy with its verify QR,
   loaded only on tap: it can be slow). The last report seen stays readable offline. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { PatientReportView } from "@setu/contracts";
import { format } from "@setu/domain";
import { Icon } from "@setu/ui";
import { Shell } from "../../../../components/Shell";
import { ReportBody } from "../../../../components/ReportView";
import { ApiFailure, patient } from "../../../../lib/api";
import { keep, seen } from "../../../../lib/cache";
import { errText, useLang } from "../../../../lib/lang";

export default function ReportPage() {
  const { claimId, reportId } = useParams<{ claimId: string; reportId: string }>();
  const router = useRouter();
  const { lang, T } = useLang();
  const [r, setR] = useState<PatientReportView | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"results" | "pdf">("results");

  useEffect(() => {
    patient.report(claimId, reportId).then((x) => { setR(x); setStale(null); keep(`report:${reportId}`, x); })
      .catch((e) => {
        const copy = seen<PatientReportView>(`report:${reportId}`);
        if (copy && e instanceof ApiFailure && e.status === 0) { setR(copy.value); setStale(copy.at); } else setError(errText(lang, e, T));
      });
  }, [claimId, reportId, lang, T]);

  const fac = r ? (lang === "bn" ? r.report.facilityBn ?? r.report.facilityEn : r.report.facilityEn ?? r.report.facilityBn) : null;
  return (
    <Shell>
      <button type="button" className="pa-btn pa-btn-link" style={{ alignSelf: "flex-start" }} onClick={() => router.back()}><Icon name="arrow-left" size={18} />{T("back")}</button>
      <h1 className="pa-h2">{T("report_title")}{r ? ` · ${r.report.number}` : ""}</h1>
      {r && <p className="pa-meta">{fac} · {format.date(r.report.releasedAt, lang === "bn")}</p>}
      {stale && <div className="offline-banner" role="status"><Icon name="wifi-off" size={16} />{T("offline_cached", { t: format.dateTime(stale, lang === "bn") })}</div>}
      {error && <span className="pa-err" role="alert"><Icon name="circle-x" size={16} />{error}</span>}
      {r && r.report.currentId !== r.report.id && (
        <div className="pa-why" role="status"><b>{T("newer_version")}</b><Link href={`/report/${claimId}/${r.report.currentId}`}>{T("open_newer")}</Link></div>
      )}
      {r && <>
        <div className="pa-tabsbar" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "results"} onClick={() => setTab("results")}>{T("tab_results")}</button>
          <button type="button" role="tab" aria-selected={tab === "pdf"} onClick={() => setTab("pdf")}>{T("tab_pdf")}</button>
        </div>
        {tab === "results" ? <ReportBody r={r} lang={lang} /> : (
          <div className="pa-card">
            <span className="pa-sub">{T("pdf_hint")}</span>
            <a className="pa-btn pa-btn-primary" href={patient.pdfUrl(claimId, "lr", r.report.id, lang)} target="_blank" rel="noopener"><Icon name="file-text" size={18} />{T("open_pdf")}</a>
          </div>
        )}
        <Link className="pa-btn" href={`/share?claim=${encodeURIComponent(claimId)}&report=${encodeURIComponent(r.report.id)}`}><Icon name="share-2" size={18} />{T("share")}</Link>
      </>}
      {!r && !error && <p className="pa-sub">{T("loading")}</p>}
    </Shell>
  );
}
