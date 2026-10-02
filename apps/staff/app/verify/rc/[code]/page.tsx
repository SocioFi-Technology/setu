"use client";
/* Public receipt check — what a receipt's QR opens (slice A6–A7). No login. The API answers with the facility, the
   receipt number, the date and the amount only — never the patient — and limits how often it can be asked. */
import { use, useEffect, useState } from "react";
import type { VerifyResponse } from "@setu/contracts";
import { format } from "@setu/domain";
import { t } from "@setu/i18n";
import { Callout, Card, Icon } from "@setu/ui";
import { ApiFailure, bill } from "../../../../lib/api";

const both = (key: string) => { const bn = t("bn", "billingApp", key), en = t("en", "billingApp", key); return bn === en ? en : `${bn} · ${en}`; };

export default function VerifyReceipt({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const [r, setR] = useState<VerifyResponse | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "busy">("loading");
  useEffect(() => {
    bill.verify(code).then((x) => { setR(x); setState("ok"); })
      .catch((e) => setState(e instanceof ApiFailure && e.status === 429 ? "busy" : "missing"));
  }, [code]);
  return (
    <main data-screen="verify" style={{ maxWidth: 520, margin: "40px auto", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{both("ver_title")}</h1>
      {state === "loading" && <div aria-busy="true" className="t-muted">{both("loading")}</div>}
      {state === "missing" && <Callout tone="bad" icon="circle-x" data-testid="verify-missing">{both("ver_not_found")}</Callout>}
      {state === "busy" && <Callout tone="warn" icon="hourglass">{both("ver_too_many")}</Callout>}
      {state === "ok" && r && (
        <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 20 }} data-testid="verify-ok">
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}><Icon name="badge-check" size={22} /><b>{both("ver_ok")}</b></span>
          <span><span className="t-small t-muted">{both("ver_facility")}</span><br /><b>{r.facilityBn ? `${r.facilityBn} · ${r.facilityEn}` : r.facilityEn}</b></span>
          <span><span className="t-small t-muted">{both("ver_number")}</span><br /><b className="num" data-testid="verify-number">{r.number}</b></span>
          <span><span className="t-small t-muted">{both("ver_date")}</span><br /><span className="num">{format.dateTime(r.date)}</span></span>
          <span><span className="t-small t-muted">{both("ver_amount")}</span><br /><b className="num" data-testid="verify-amount">{format.takaFromPaisa(r.amountPaisa)}</b></span>
          <span className="t-small t-muted">{both("ver_privacy")}</span>
        </Card>
      )}
    </main>
  );
}
