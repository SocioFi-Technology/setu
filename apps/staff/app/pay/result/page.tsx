"use client";
/* The patient's payment result (ADR 0011) — where bKash's return and an ended short link land, on the patient's own
   phone. No login, both languages. Only an outcome word and our link code come in the URL; what is shown (facility,
   amount, TrxID) is asked from the server by the code, so a forged URL cannot put words on this page. While the
   payment is being completed the page asks again every few seconds. */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PayResultOutcome, type PayResultView } from "@setu/contracts";
import { format, isLinkCode } from "@setu/domain";
import { t } from "@setu/i18n";
import { Callout, Card, Icon } from "@setu/ui";
import { bill } from "../../../lib/api";

const both = (key: string) => { const bn = t("bn", "billingApp", key), en = t("en", "billingApp", key); return bn === en ? en : `${bn} · ${en}`; };
const TONE = { paid: ["info", "badge-check"], "not-paid": ["bad", "circle-x"], ended: ["warn", "link-2-off"], expired: ["warn", "clock"], pending: ["info", "hourglass"], unknown: ["warn", "circle-help"] } as const;
const TITLE = { paid: "pr_paid", "not-paid": "pr_not_paid", ended: "pr_ended", expired: "pr_expired", pending: "pr_pending", unknown: "pr_unknown" } as const;
const NOTE: Partial<Record<PayResultOutcome, string>> = { paid: "pr_paid_note", "not-paid": "pr_not_paid_note", ended: "pr_ended_note", expired: "pr_ended_note", pending: "pr_pending_note", unknown: "pr_ended_note" };

function Result() {
  const q = useSearchParams();
  const code = (q.get("c") ?? "").toUpperCase();
  const fromUrl = PayResultOutcome.safeParse(q.get("o")).data ?? "unknown";
  const [r, setR] = useState<PayResultView | null>(null);
  useEffect(() => {
    if (!isLinkCode(code)) return;
    let stop = false, timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => bill.payResult(code).then((x) => { if (stop) return; setR(x); if (x.outcome === "pending") timer = setTimeout(ask, 3000); }).catch(() => { if (!stop) timer = setTimeout(ask, 5000); });
    void ask();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [code]);
  // with a code, only the server's answer is shown; without one, the outcome word alone (no amounts, no names)
  const outcome: PayResultOutcome = isLinkCode(code) ? r?.outcome ?? "pending" : fromUrl;
  const [tone, icon] = TONE[outcome];
  return (
    <main data-screen="pay-result" data-outcome={outcome} style={{ maxWidth: 480, margin: "32px auto", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{both("pr_title")}</h1>
      <Callout tone={tone} icon={icon} data-testid="pay-result">
        <b>{both(TITLE[outcome])}</b>{NOTE[outcome] ? <><br /><span className="t-small">{both(NOTE[outcome]!)}</span></> : null}
      </Callout>
      {r && (r.facilityEn || r.amountPaisa) && (
        <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 20 }}>
          {r.facilityEn && <span><span className="t-small t-muted">{both("pr_facility")}</span><br /><b>{r.facilityBn ? `${r.facilityBn} · ${r.facilityEn}` : r.facilityEn}</b></span>}
          {r.amountPaisa !== null && <span><span className="t-small t-muted">{both("pr_amount")}</span><br /><b className="num" data-testid="pay-result-amount">{format.takaFromPaisa(r.amountPaisa)}</b></span>}
          {r.outcome === "paid" && r.trxId && <span><span className="t-small t-muted">{both("pr_trx")}</span><br /><b className="num" data-testid="pay-result-trx">{r.trxId}</b></span>}
        </Card>
      )}
      <span className="t-small t-muted" style={{ display: "flex", gap: 6, alignItems: "center" }}><Icon name="shield-check" size={14} />{both("pr_privacy")}</span>
    </main>
  );
}

export default function PayResult() {
  return <Suspense fallback={null}><Result /></Suspense>;
}
