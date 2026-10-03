"use client";
/* Public lab report check — what a printed lab report's QR opens (slice A12–A13). No login. The API answers with the
   facility, the report number and version, its status (a replaced version says so), the patient's initials / age / sex
   and the released values with their flags and ranges; a value corrected since is marked "do not act on it". */
import { use, useEffect, useState } from "react";
import type { LrVerifyResponse } from "@setu/contracts";
import { format } from "@setu/domain";
import { t } from "@setu/i18n";
import { Callout, Card, Icon } from "@setu/ui";
import { ApiFailure, docs } from "../../../../lib/api";

const both = (ns: string, key: string, v: Record<string, string> = {}) => {
  const f = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);
  const bn = f(t("bn", ns, key)), en = f(t("en", ns, key)); return bn === en ? en : `${bn} · ${en}`;
};
const P = (key: string, v: Record<string, string> = {}) => both("printApp", key, v);
const LB = (key: string, v: Record<string, string> = {}) => both("labApp", key, v);

export default function VerifyLabReport({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const [r, setR] = useState<LrVerifyResponse | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "busy">("loading");
  useEffect(() => {
    docs.verifyLr(code).then((x) => { setR(x); setState("ok"); })
      .catch((e) => setState(e instanceof ApiFailure && e.status === 429 ? "busy" : "missing"));
  }, [code]);
  const val = (v: number, d: number) => v.toFixed(d);
  return (
    <main data-screen="verify-lr" style={{ maxWidth: 640, margin: "32px auto", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{P("v_title_lr")}</h1>
      {state === "loading" && <div aria-busy="true" className="t-muted">{P("v_loading")}</div>}
      {state === "missing" && <Callout tone="bad" icon="circle-x" data-testid="verify-missing">{P("v_not_found_lr")}</Callout>}
      {state === "busy" && <Callout tone="warn" icon="hourglass">{P("v_too_many")}</Callout>}
      {state === "ok" && r && (
        <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 20 }} data-testid="verify-ok" data-status={r.status}>
          {r.status === "current"
            ? <span style={{ display: "flex", gap: 8, alignItems: "center" }}><Icon name="badge-check" size={22} /><b data-testid="verify-status">{P("v_current")}</b></span>
            : <Callout tone="bad" icon="triangle-alert"><b data-testid="verify-status">{P("v_superseded")}</b></Callout>}
          <span><span className="t-small t-muted">{P("v_facility")}</span><br /><b>{r.facilityBn ? `${r.facilityBn} · ${r.facilityEn}` : r.facilityEn}</b></span>
          <span><span className="t-small t-muted">{P("report_no")}</span><br /><b className="num">{r.number} · v{r.version}</b> · {r.reportStatus === "preliminary" ? LB("wm_preliminary", { n: String(r.pendingCount), m: String(r.testCount) }) : LB(`rep_${r.reportStatus}`)}</span>
          <span><span className="t-small t-muted">{P("v_released")}</span><br /><span className="num">{format.dateTime(r.releasedAt)}</span></span>
          <span><span className="t-small t-muted">{P("v_patient")}</span><br /><b data-testid="verify-patient">{r.patient.initials} · {r.patient.ageYears ?? "—"} · {P(`sex_${r.patient.sex}`)}</b></span>
          <span className="t-small t-muted">{P("v_results")}</span>
          <table className="table" data-testid="verify-results">
            <tbody>
              {r.results.map((x, i) => (
                <tr key={i} data-result={x.code}>
                  <td>{x.nameEn}<br /><span className="t-small t-muted">{x.test}</span></td>
                  <td className="num"><b style={x.underCorrection || x.withdrawn ? { textDecoration: "line-through" } : undefined}>{val(x.value, x.decimals)}</b> {x.unit}</td>
                  <td><span style={x.underCorrection || x.withdrawn ? { textDecoration: "line-through" } : undefined}>{x.flag ? LB(`flag_${x.flag}`) : "—"}</span>
                    {x.underCorrection && <><br /><b className="t-small" data-testid="verify-under-correction">{LB("under_correction_dna")}</b></>}
                    {x.withdrawn && <><br /><b className="t-small" data-testid="verify-withdrawn">{P("v_withdrawn_value")}</b></>}</td>
                  <td className="t-small num">{x.refLow != null && x.refHigh != null ? `${val(x.refLow, x.decimals)}–${val(x.refHigh, x.decimals)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <span className="t-small t-muted">{LB("sample_ranges_note")} · {P("v_privacy_lr")}</span>
        </Card>
      )}
    </main>
  );
}
