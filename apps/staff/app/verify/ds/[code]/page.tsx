"use client";
/* Public discharge summary check — what a printed summary's QR opens (ADR 0018, decision 10). No login. The API answers
   with the facility, the signing doctor and registration as stored, the date, the version and whether it is current, and
   the patient's initials / age / sex — no diagnosis, no medicines, no clinical content — and limits how often it is asked. */
import { use, useEffect, useState } from "react";
import type { DsVerifyResponse } from "@setu/contracts";
import { format } from "@setu/domain";
import { t } from "@setu/i18n";
import { Callout, Card, Icon } from "@setu/ui";
import { ApiFailure, docs } from "../../../../lib/api";

const both = (ns: string, key: string, v: Record<string, string> = {}) => {
  const f = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);
  const bn = f(t("bn", ns, key)), en = f(t("en", ns, key)); return bn === en ? en : `${bn} · ${en}`;
};
const P = (key: string, v: Record<string, string> = {}) => both("printApp", key, v);

export default function VerifySummary({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const [r, setR] = useState<DsVerifyResponse | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "busy">("loading");
  useEffect(() => {
    docs.verifyDs(code).then((x) => { setR(x); setState("ok"); })
      .catch((e) => setState(e instanceof ApiFailure && e.status === 429 ? "busy" : "missing"));
  }, [code]);
  return (
    <main data-screen="verify-ds" style={{ maxWidth: 560, margin: "32px auto", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{P("v_title_ds")}</h1>
      {state === "loading" && <div aria-busy="true" className="t-muted">{P("v_loading")}</div>}
      {state === "missing" && <Callout tone="bad" icon="circle-x" data-testid="verify-missing">{P("v_not_found_ds")}</Callout>}
      {state === "busy" && <Callout tone="warn" icon="hourglass">{P("v_too_many")}</Callout>}
      {state === "ok" && r && (
        <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 20 }} data-testid="verify-ok" data-status={r.status}>
          {r.status === "current"
            ? <span style={{ display: "flex", gap: 8, alignItems: "center" }}><Icon name="badge-check" size={22} /><b data-testid="verify-status">{P("v_current")}</b></span>
            : <Callout tone="bad" icon="triangle-alert"><b data-testid="verify-status">{P(r.status === "superseded" ? "v_superseded" : "v_withdrawn")}</b></Callout>}
          <span><span className="t-small t-muted">{P("v_facility")}</span><br /><b>{r.facilityBn ? `${r.facilityBn} · ${r.facilityEn}` : r.facilityEn}</b></span>
          <span><span className="t-small t-muted">{P("v_doctor")}</span><br /><b>{r.doctorBn && r.doctorEn ? `${r.doctorBn} · ${r.doctorEn}` : r.doctorEn ?? r.doctorBn ?? "—"}</b>
            {r.regNo ? <span className="t-small"> · {r.regBody ?? "BMDC"} {r.regNo}{r.regVerified ? "" : ` (${P("v_not_verified")})`}</span> : null}</span>
          <span><span className="t-small t-muted">{P("v_signed")} · {P("v_version")}</span><br /><span className="num">{r.signedAt ? format.dateTime(r.signedAt) : "—"} · v{r.version}</span></span>
          <span><span className="t-small t-muted">{P("v_patient")}</span><br /><b data-testid="verify-patient">{r.patient.initials} · {r.patient.ageYears ?? "—"} · {P(`sex_${r.patient.sex}`)}</b></span>
          <span className="t-small t-muted">{P("v_privacy_ds")}</span>
        </Card>
      )}
    </main>
  );
}
