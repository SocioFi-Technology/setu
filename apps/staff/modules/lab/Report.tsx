"use client";
/* lab/report — one released version of the visit's report, exactly as released (decision D3), on screen (the A4 PDF with
   QR comes with A12–A13, decision D10). Ported from docs/prototype/Setu Lab.dc.html (screen "Report"): the version's
   status across the top ("PRELIMINARY — n of m tests pending", "CORRECTED", "FINAL", "Replaced by vN"), each test's
   results with the flag as text + icon and the range with its label, the pending tests, who verified and validated,
   the critical call-backs. A result later corrected or withdrawn is marked "do not act on it" (decisions D4, 133).
   ?id = a version; ?enc = the visit's current version. Without either: the released reports (delivery worklist). */
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LabReportView } from "@setu/contracts";
import { isCritical } from "@setu/domain";
import { Button, Callout, Card, PageState, Pill } from "@setu/ui";
import { ApiFailure, lab } from "../../lib/api";
import { useSession } from "../../lib/session";
import { toBanner, useLabels } from "../fd/common";
import { FlagPill, REPORT_TONE, RangeText, useFmt, useLb } from "./common";
import { LabWorklist } from "./Worklist";

export function LabReport() {
  const sp = useSearchParams();
  const id = sp.get("id"), enc = sp.get("enc");
  if (id) return <ReportVersion id={id} />;
  if (enc) return <CurrentOf encounterId={enc} />;
  return <LabWorklist stage="delivery" />;
}

function CurrentOf({ encounterId }: { encounterId: string }) {
  const T = useLb();
  const [id, setId] = useState<string | null>(null); const [none, setNone] = useState(false);
  useEffect(() => { lab.visit(encounterId).then((v) => { const c = v.reports.find((r) => r.status !== "superseded"); if (c) setId(c.id); else setNone(true); }).catch(() => setNone(true)); }, [encounterId]);
  if (none) return <PageState icon="file-x" title={T("no_report")} />;
  return id ? <ReportVersion id={id} /> : <div aria-busy="true" className="t-muted">{T("loading")}</div>;
}

export function ReportVersion({ id }: { id: string }) {
  const s = useSession(); const T = useLb(); const F = useFmt(); const L = useLabels(); const router = useRouter();
  const [r, setR] = useState<LabReportView | null>(null); const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    setR(null);
    lab.report(id).then((x) => { setR(x); s.setPatient(toBanner(x.patient, `${L.age(x.patient)} ${L.sex(x.patient.sex)}`)); })
      .catch((e) => setFailed(e instanceof ApiFailure && e.status === 404 ? "not_found" : "error"));
    return () => s.setPatient(null);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return failed === "not_found" ? <PageState icon="search-x" title={T("not_found")} /> : <Callout tone="warn" icon="triangle-alert">{T("error_generic")}</Callout>;
  if (!r) return <div aria-busy="true" className="t-muted">{T("loading")}</div>;
  const rep = r.report;
  const status = rep.status === "superseded" ? T("rep_superseded") : rep.status === "preliminary" ? T("wm_preliminary", { n: rep.pendingCount, m: rep.testCount })
    : rep.status === "corrected" ? (rep.pendingCount ? `${T("wm_corrected")} · ${T("wm_preliminary", { n: rep.pendingCount, m: rep.testCount })}` : T("wm_corrected")) : T("wm_final");
  const criticalCalls = r.tests.flatMap((t) => t.results).filter((x) => isCritical(x.flag)).flatMap((x) => x.callbacks.filter((c) => c.outcome === "reached").map((c) => ({ x, c })));
  return (
    <div data-screen="lab/report" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{T("report_title")}</h1>
        <span className="num t-muted">{rep.number} · v{s.n(rep.version)}</span>
        <Pill tone={REPORT_TONE[rep.status] ?? "neu"} icon="file-text">{T(`rep_${rep.status}`)}</Pill>
        <span style={{ marginLeft: "auto" }} />
        <Button icon="send" onClick={() => router.push(`/m/lab/delivery?enc=${encodeURIComponent(r.encounter.id)}`)}>{T("go_delivery")}</Button>
      </div>
      <Card style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12, position: "relative", maxWidth: 860 }} data-report-status={rep.status}>
        <div data-testid="report-banner" style={{ border: "2px solid currentColor", borderRadius: 8, padding: "6px 10px", fontWeight: 700, color: rep.status === "final" ? "var(--text-primary)" : rep.status === "superseded" ? "var(--text-muted)" : "var(--danger-fg, #b91c1c)" }}>
          {status}{rep.supersededById ? ` · ${T("replaced_by_newer")}` : ""}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "6px 18px" }} className="t-small">
          <span>{T("r_patient")}<br /><b>{F.name(r.patient)}</b></span>
          <span>{T("r_age_sex")}<br /><b>{L.age(r.patient)} {L.sex(r.patient.sex)}</b></span>
          <span>{T("r_patient_no")}<br /><b className="num">{r.patient.facilityNo}</b></span>
          <span>{T("r_released")}<br /><b>{F.dateTime(rep.releasedAt)} · {F.name(rep.releasedBy)}</b></span>
          <span>{T("r_visit")}<br /><b className="num">{r.encounter.token} · {F.date(r.encounter.day)}</b></span>
          <span>{T("r_version")}<br /><b className="num">v{s.n(rep.version)}</b></span>
        </div>
        {r.tests.map((t) => (
          <div key={t.orderId} data-report-test={t.testCode} data-withdrawn={t.withdrawn ? "yes" : "no"} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <b style={{ borderBottom: "1px solid var(--border-default)", paddingBottom: 2 }}>{F.test(t)}</b>
            {t.withdrawn && <Callout tone="bad" icon="circle-slash" data-testid="withdrawn-marker">{T("withdrawn_marker")}</Callout>}
            <table className="table">
              <thead><tr><th>{T("col_test")}</th><th>{T("col_result")}</th><th>{T("col_flag")}</th><th>{T("col_unit")}</th><th>{T("col_ref")}</th></tr></thead>
              <tbody>
                {t.results.map((x) => (
                  <tr key={x.id} data-result={x.analyteCode} style={x.underCorrection ? { opacity: 0.7 } : isCritical(x.flag) ? { background: "var(--danger-bg)", boxShadow: "inset 3px 0 0 var(--danger-border)" } : undefined}>
                    <td>{x.nameEn}{x.underCorrection && <div data-testid="do-not-act"><Pill tone="bad" icon="octagon-alert" wrap>{x.withdrawn ? T("withdrawn_dna") : T("under_correction_dna")}</Pill></div>}</td>
                    <td className="num"><b style={x.underCorrection ? { textDecoration: "line-through" } : undefined}>{F.value(x.value, x.decimals)}</b></td>
                    <td><FlagPill flag={x.flag} /></td>
                    <td className="t-small">{x.unit}</td>
                    <td><RangeText range={x.range} decimals={x.decimals} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <span className="t-small t-muted">{[...new Set(t.results.map((x) => [x.verifiedBy && T("verified_by", { name: F.name(x.verifiedBy), at: F.time(x.verifiedAt) }), x.validatedBy && T("validated_by", { name: F.name(x.validatedBy), at: F.time(x.validatedAt) })].filter(Boolean).join(" · ")))].join(" · ")}</span>
          </div>
        ))}
        {r.pendingTests.length > 0 && <span data-testid="pending-tests"><b>{T("pending_tests")}</b> {r.pendingTests.map((p) => p.nameEn).join(" · ")}</span>}
        <span className="t-small t-muted">
          {T("legend")}
          {criticalCalls.map(({ x, c }) => ` · ${T("legend_call", { test: x.nameEn, name: c.recipientName, at: F.time(c.calledAt) })}`).join("")}
        </span>
        <span className="t-small t-muted">{T("sample_ranges_note")} · {T("print_later")}</span>
      </Card>
    </div>
  );
}
