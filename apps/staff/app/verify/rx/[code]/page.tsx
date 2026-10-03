"use client";
/* Public prescription check — what a printed prescription's QR opens (slice A12–A13, decision D2). No login. The API
   answers with the facility, the doctor and registration as stored, the date, the version's status, the patient's
   initials / age / sex and the medicine lines — never the name, phone or diagnosis — and limits how often it is asked. */
import { use, useEffect, useState } from "react";
import type { RxVerifyResponse } from "@setu/contracts";
import { format } from "@setu/domain";
import { t } from "@setu/i18n";
import { Callout, Card, Icon } from "@setu/ui";
import { ApiFailure, docs } from "../../../../lib/api";

const both = (ns: string, key: string, v: Record<string, string> = {}) => {
  const f = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);
  const bn = f(t("bn", ns, key)), en = f(t("en", ns, key)); return bn === en ? en : `${bn} · ${en}`;
};
const P = (key: string, v: Record<string, string> = {}) => both("printApp", key, v);

export default function VerifyPrescription({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const [r, setR] = useState<RxVerifyResponse | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "busy">("loading");
  useEffect(() => {
    docs.verifyRx(code).then((x) => { setR(x); setState("ok"); })
      .catch((e) => setState(e instanceof ApiFailure && e.status === 429 ? "busy" : "missing"));
  }, [code]);
  return (
    <main data-screen="verify-rx" style={{ maxWidth: 560, margin: "32px auto", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{P("v_title_rx")}</h1>
      {state === "loading" && <div aria-busy="true" className="t-muted">{P("v_loading")}</div>}
      {state === "missing" && <Callout tone="bad" icon="circle-x" data-testid="verify-missing">{P("v_not_found_rx")}</Callout>}
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
          <span className="t-small t-muted">{P("v_medicines")}</span>
          <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 4 }} data-testid="verify-medicines">
            {r.medicines.map((m, i) => <li key={i}><b>{m.form} {m.brand} {m.strength}</b> <i>({m.generic})</i> — <span className="num">{m.dose}</span> · {both("consultApp", `meal_${m.meal}`)} · {P("days_n", { n: String(m.days) })}{m.note ? <><br /><b>{m.note}</b></> : null}</li>)}
          </ol>
          {r.medicines.some((m) => m.sample) && <Callout tone="warn" icon="flask-conical" data-testid="verify-sample">{P("v_sample")}</Callout>}
          <span className="t-small t-muted">{P("v_privacy_rx")}</span>
        </Card>
      )}
    </main>
  );
}
