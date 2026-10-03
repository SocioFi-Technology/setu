"use client";
/* The lab worklists (one per stage: collection, accession, result entry, verification, delivery). Critical results come
   first, then STAT / urgent, then the oldest visit (the server's order). A card opens the visit on the stage's screen. */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { LabWorklist as Worklist } from "@setu/contracts";
import { Callout, PageState, Pill } from "@setu/ui";
import { lab } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useLabels } from "../fd/common";
import { COLLECTION_TONE, REPORT_TONE, useFmt, useLb } from "./common";

const SCREEN: Record<Worklist["stage"], string> = { collect: "collect", accession: "accession", result: "result", verify: "verify", delivery: "delivery" };

export function LabWorklist({ stage }: { stage: Worklist["stage"] }) {
  const s = useSession(); const T = useLb(); const F = useFmt(); const L = useLabels(); const router = useRouter();
  const [w, setW] = useState<Worklist | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => { s.setPatient(null); setW(null); lab.worklist(stage).then(setW).catch(() => setFailed(true)); }, [stage]); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <Callout tone="warn" icon="triangle-alert">{T("error_generic")}</Callout>;
  if (!w) return <div aria-busy="true" className="t-muted">{T("loading")}</div>;
  return (
    <div data-screen={`lab/${SCREEN[stage]}`} data-worklist={stage} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{T(`wl_${stage}`)}</h1>
      <span className="t-muted">{T(`wl_${stage}_hint`)}</span>
      {w.items.length === 0 ? <PageState icon="test-tube" title={T("wl_empty")} /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
          {w.items.map((i) => (
            <button key={i.encounter.id} type="button" className="card" data-lab-token={i.encounter.token} data-encounter={i.encounter.id}
              onClick={() => router.push(`/m/lab/${SCREEN[stage]}?enc=${encodeURIComponent(i.encounter.id)}`)}
              style={{ display: "flex", flexDirection: "column", gap: 6, padding: 14, textAlign: "left", cursor: "pointer", borderColor: i.counts.criticalOpen ? "var(--danger-border)" : undefined }}>
              <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <b className="num" style={{ fontSize: 18 }}>{i.encounter.token}</b>
                {i.counts.criticalOpen > 0 && <Pill tone="crit" icon="siren">{T("wl_critical", { n: i.counts.criticalOpen })}</Pill>}
                {i.priority !== "routine" && <Pill tone={i.priority === "stat" ? "crit" : "warn"} icon="zap">{T(`pr_${i.priority}`)}</Pill>}
                <Pill tone={COLLECTION_TONE[i.collection] ?? "neu"} wrap>{T(`col_${i.collection}`)}</Pill>
              </span>
              <b>{F.name(i.patient)}</b>
              <span className="t-small t-muted num">{i.patient.facilityNo} · {L.age(i.patient)} {L.sex(i.patient.sex)} · {F.date(i.encounter.day)}</span>
              <span className="t-small">{i.tests.map((t) => t.status === "revoked" ? `${t.nameEn} (${T("cancelled")})` : t.nameEn).join(" · ")}</span>
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {i.counts.tubesNeeded > 0 && <Pill tone="neu" icon="test-tube">{T("wl_tubes", { n: i.counts.tubesNeeded })}</Pill>}
                {i.counts.toEnter > 0 && <Pill tone="pend" icon="keyboard">{T("wl_to_enter", { n: i.counts.toEnter })}</Pill>}
                {i.counts.toVerify > 0 && <Pill tone="draft" icon="shield">{T("wl_to_verify", { n: i.counts.toVerify })}</Pill>}
                {i.counts.toValidate > 0 && <Pill tone="pend" icon="shield-check">{T("wl_to_validate", { n: i.counts.toValidate })}</Pill>}
                {i.counts.releasable > 0 && <Pill tone="info" icon="send">{T("wl_releasable", { n: i.counts.releasable })}</Pill>}
                {i.report && <Pill tone={REPORT_TONE[i.report.status] ?? "neu"} icon="file-text">{i.report.number} v{s.n(i.report.version)} · {T(`rep_${i.report.status}`)}</Pill>}
                {i.deliveryFailed > 0 && <Pill tone="bad" icon="triangle-alert">{T("wl_failed", { n: i.deliveryFailed })}</Pill>}
                {i.bill && <Pill tone="neu" icon="receipt">{T("bill_status", { status: s.t("billingApp", `st_${i.bill.status}`) })}</Pill>}
              </span>
              {i.returned.map((r) => <span key={r.orderId} className="t-small" data-returned={r.orderId}><Pill tone="warn" icon="undo-2" wrap>{T("returned_line", { test: r.nameEn, reason: r.reason })}</Pill></span>)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
