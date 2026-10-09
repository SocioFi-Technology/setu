"use client";
/* net/shared — "Shared with you" (ADR 0021): the records a patient shared from the Setu app with this doctor (by name)
   or with this facility's doctors. Everything here is read through the consent-checked read service; a share that
   ended or was stopped answers "refused" with the reason, and the screen says it. The patient and their facility see
   every look (who, when). */
import { useCallback, useEffect, useState } from "react";
import type { SharedList, SharedRecords, SharedReportView } from "@setu/contracts";
import { format } from "@setu/domain";
import { fill } from "@setu/i18n";
import { Button, Callout, Card, Icon, PageState, Pill } from "@setu/ui";
import { ApiFailure, net } from "../../lib/api";
import { useSession } from "../../lib/session";

function useN() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) => fill(s.t("netApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}

export function NetShared() {
  const s = useSession(); const N = useN();
  const [list, setList] = useState<SharedList | null>(null); const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => { try { setList(await net.shared()); setFailed(false); } catch { setFailed(true); } }, []);
  useEffect(() => { s.setPatient(null); void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const bn = s.numerals === "bn";
  if (failed) return <PageState icon="circle-alert" title={N("error")} />;
  if (!list) return <PageState icon="loader" title="…" />;
  if (open) return <Records consentId={open} onBack={() => { setOpen(null); void load(); }} />;
  return (
    <div className="module-page" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{N("title")}</h1>
      <Callout icon="shield-check">{N("intro")}</Callout>
      {list.items.length === 0 && <PageState icon="inbox" title={N("none")} />}
      {list.items.map((i) => (
        <Card key={i.consentId} style={{ display: "flex", gap: 12, alignItems: "center", padding: 14, flexWrap: "wrap" }} data-testid="shared-item">
          <div style={{ flex: 1, minWidth: 220 }}>
            <b>{s.lang === "bn" ? i.patient.nameBn : i.patient.nameEn}</b>{" "}
            <span className="t-small t-muted">{i.patient.ageYears !== null ? N("age_sex", { age: i.patient.ageYears, sex: N(`sex_${i.patient.sex}`) }) : N(`sex_${i.patient.sex}`)}</span>
            <div className="t-small">{i.scope.kind === "all" ? N("scope_all") : i.scope.kind === "visit" ? N("scope_visit", { t: i.scope.at ? format.date(i.scope.at, bn) : "" }) : N("scope_report", { n: i.scope.number ?? "" })}
              {" · "}{N("ends", { t: format.dateTime(i.endsAt, bn) })}</div>
          </div>
          <Pill tone={i.toMe ? "info" : "neu"} icon={i.toMe ? "user-round" : "building-2"}>{i.toMe ? N("to_me") : N("to_facility")}</Pill>
          <Button variant="primary" icon="folder-open" onClick={() => setOpen(i.consentId)}>{N("open")}</Button>
        </Card>
      ))}
    </div>
  );
}

function Records({ consentId, onBack }: { consentId: string; onBack: () => void }) {
  const s = useSession(); const N = useN();
  const [r, setR] = useState<SharedRecords | null>(null); const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<SharedReportView | null>(null);
  const bn = s.numerals === "bn";
  const refusal = (e: unknown) => (e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : N("error"));
  useEffect(() => { net.records(consentId).then(setR).catch((e) => setError(refusal(e))); }, [consentId]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (en: string | null, b: string | null) => (s.lang === "bn" ? b ?? en : en ?? b) ?? "";
  return (
    <div className="module-page" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <span><Button variant="ghost" icon="arrow-left" onClick={report ? () => setReport(null) : onBack}>{N("back")}</Button></span>
      {error && <Callout tone="bad" icon="shield-x" role="alert">{error}</Callout>}
      {r && !report && <>
        <h1 className="t-h2" style={{ margin: 0 }}>{s.lang === "bn" ? r.patient.nameBn : r.patient.nameEn} · {N("records")}</h1>
        <span className="t-small t-muted">{N("ends", { t: format.dateTime(r.endsAt, bn) })}</span>
        {r.items.length === 0 && <PageState icon="inbox" title={N("no_records")} />}
        {r.items.map((i) => (
          <Card key={i.key} style={{ display: "flex", gap: 12, alignItems: "center", padding: 12, flexWrap: "wrap" }} data-testid="shared-record" data-kind={i.kind}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <b>{N(`k_${i.kind}`)}{i.number ? ` · ${i.number}` : ""}</b>
              <div className="t-small">{format.date(i.at, bn)} · {name(i.facilityEn, i.facilityBn)}{name(i.doctorEn, i.doctorBn) ? ` · ${name(i.doctorEn, i.doctorBn)}` : ""}</div>
            </div>
            {i.kind === "report" && <Button icon="test-tube" onClick={() => net.report(consentId, i.ownerTenantId, i.recordId).then(setReport).catch((e) => setError(refusal(e)))}>{N("view_report")}</Button>}
            {(i.kind === "report" || i.kind === "prescription" || i.kind === "summary") && (
              <a className="btn" href={net.pdfUrl(consentId, i.ownerTenantId, i.kind === "report" ? "lr" : i.kind === "prescription" ? "rx" : "ds", i.recordId, s.lang)} target="_blank" rel="noopener"><Icon name="file-text" size={16} />{N("open_pdf")}</a>
            )}
          </Card>
        ))}
      </>}
      {report && <ReportTable r={report} />}
    </div>
  );
}

function ReportTable({ r }: { r: SharedReportView }) {
  const s = useSession(); const N = useN();
  const bn = s.numerals === "bn";
  return (
    <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }} data-testid="shared-report">
      <b className="t-h3">{r.report.number} · v{s.n(r.report.version)}</b>
      <span className="t-small t-muted">{N("via", { f: (s.lang === "bn" ? r.report.facilityBn ?? r.report.facilityEn : r.report.facilityEn ?? r.report.facilityBn) ?? "" })} · {format.date(r.report.releasedAt, bn)}</span>
      <table className="table">
        <thead><tr><th>{N("col_test")}</th><th>{N("col_value")}</th><th>{N("col_flag")}</th><th>{N("col_range")}</th><th>{N("col_trend")}</th></tr></thead>
        <tbody>
          {r.tests.flatMap((t) => t.results).map((x) => (
            <tr key={x.observationId} data-analyte={x.code}>
              <td>{s.lang === "bn" ? x.nameBn : x.nameEn}</td>
              <td className="num"><b>{s.n(x.value.toFixed(x.decimals))}</b> {x.unit}</td>
              <td>{x.flag && x.flag !== "N" ? <Pill tone={x.flag === "HH" || x.flag === "LL" ? "crit" : "high"}>{x.flag}</Pill> : x.flag ?? "—"}</td>
              <td className="num">{x.refLow !== null && x.refHigh !== null ? `${s.n(x.refLow)}–${s.n(x.refHigh)}` : "—"}</td>
              <td className="num t-small">{x.trend.filter((p) => !p.current).map((p) => `${format.date(p.at, bn)}: ${s.n(p.value)}`).join(" · ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
