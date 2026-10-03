"use client";
/* lab/accession — walkthrough A8 → A9. Ported from docs/prototype/Setu Lab.dc.html (screen "Accession & department
   worklists"). A collected tube is received (scan its barcode + Enter, or "Receive") and processing is started; a bad
   tube is rejected with a reason (the test needs a new tube; recollection SMS). Offline these steps wait on this device
   ("Not yet synced", decision D8). */
import { useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Callout, Card, PageState, Pill, useToast } from "@setu/ui";
import { lab } from "../../lib/api";
import { useSession } from "../../lib/session";
import { RejectDialog } from "./Collect";
import { SPECIMEN_TONE, TubeDot, VisitHead, isLabWriter, useErr, useFmt, useLabVisit, useLb } from "./common";
import { LabWorklist } from "./Worklist";

export function LabAccession() {
  const enc = useSearchParams().get("enc");
  return enc ? <AccessionVisit encounterId={enc} /> : <LabWorklist stage="accession" />;
}

function AccessionVisit({ encounterId }: { encounterId: string }) {
  const s = useSession(); const T = useLb(); const F = useFmt(); const E = useErr(); const toast = useToast(); const router = useRouter();
  const { v, show, reload, failed } = useLabVisit(encounterId);
  const [busy, setBusy] = useState(false); const [scan, setScan] = useState(""); const [scanMsg, setScanMsg] = useState<{ tone: "info" | "warn"; t: string } | null>(null);
  const [queued, setQueued] = useState<Record<string, string>>({}); const [reject, setReject] = useState<string | null>(null);
  const keys = useRef<Record<string, string>>({});
  const key = (k: string) => (keys.current[k] ??= crypto.randomUUID());
  const done = (k: string) => { delete keys.current[k]; };
  if (failed) return failed === "not_found" ? <PageState icon="search-x" title={T("not_found")} /> : <Callout tone="warn" icon="triangle-alert">{T("error_generic")}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{T("loading")}</div>;
  const writer = isLabWriter(s.me?.role, "collect");
  const orderName = (id: string) => v.orders.find((o) => o.id === id)?.nameEn ?? "—";

  const step = async (specimenId: string, st: "receive" | "start") => {
    setBusy(true);
    try {
      const r = await lab.step(specimenId, st, key(`${st}:${specimenId}`));
      if (r.queued) setQueued((q) => ({ ...q, [specimenId]: st })); else { done(`${st}:${specimenId}`); show(r.data); }
    } catch (e) { done(`${st}:${specimenId}`); toast(E(e), "triangle-alert"); await reload(); } finally { setBusy(false); }
  };
  const onScan = async () => {
    const code = scan.trim().toUpperCase();
    const sp = v.specimens.find((x) => x.number.toUpperCase() === code);
    if (!sp) { setScanMsg({ tone: "warn", t: T("scan_unknown", { code }) }); return; }
    if (sp.status !== "collected") { setScanMsg({ tone: "warn", t: T("scan_state", { code: sp.number, status: T(`sp_${sp.status}`) }) }); return; }
    setScanMsg({ tone: "info", t: T("scan_received", { code: sp.number }) }); setScan("");
    await step(sp.id, "receive");
  };

  return (
    <div data-screen="lab/accession" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <VisitHead v={v} title={T("accession_title")} />
      {!s.online && <Callout tone="warn" icon="cloud-off">{T("offline_collect")}</Callout>}
      {writer && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 12px", borderRadius: 8, border: "2px solid var(--brand-primary)", background: "var(--surface-card)" }}>
          <label style={{ display: "flex", gap: 10, alignItems: "center", flex: 1 }}>
            <span className="t-small">{T("scan_label")}</span>
            <input className="input num" name="scan" value={scan} onChange={(e) => setScan(e.target.value)} placeholder="S-2610-0001" style={{ flex: 1, fontFamily: "var(--font-mono)" }}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void onScan(); } }} />
          </label>
        </div>
      )}
      <div role="status" aria-live="polite">{scanMsg && <Callout tone={scanMsg.tone} icon="scan-barcode">{scanMsg.t}</Callout>}</div>
      <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14 }}>
        {v.specimens.length === 0 ? <span className="t-muted">{T("no_labels")}</span> : v.specimens.map((sp) => (
          <div key={sp.id} data-specimen={sp.number} data-status={queued[sp.id] ? "pending-sync" : sp.status} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "8px 10px", border: "1px solid var(--border-subtle)", borderRadius: 8 }}>
            <TubeDot tube={sp.tube} />
            <span style={{ display: "flex", flexDirection: "column" }}>
              <b className="num" style={{ fontFamily: "var(--font-mono)" }}>{sp.number}</b>
              <span className="t-small">{T(`tube_${sp.tube}`)} · {sp.orderIds.map(orderName).join(" · ")}</span>
              <span className="t-small t-muted">{[sp.collectedAt && T("step_collected", { at: F.time(sp.collectedAt) }), sp.receivedAt && T("step_received", { at: F.time(sp.receivedAt) }), sp.startedAt && T("step_started", { at: F.time(sp.startedAt) })].filter(Boolean).join(" · ")}</span>
            </span>
            <span style={{ marginLeft: "auto" }} />
            {queued[sp.id] ? <Pill tone="off" icon="cloud-off">{T("not_synced")}</Pill> : <Pill tone={SPECIMEN_TONE[sp.status] ?? "neu"}>{T(`sp_${sp.status}`)}</Pill>}
            {writer && !queued[sp.id] && sp.status === "collected" && <Button size="sm" icon="inbox" data-testid={`receive-${sp.tube}`} disabled={busy} onClick={() => void step(sp.id, "receive")}>{T("receive")}</Button>}
            {writer && !queued[sp.id] && sp.status === "received" && <Button size="sm" variant="primary" icon="play" data-testid={`start-${sp.tube}`} disabled={busy} onClick={() => void step(sp.id, "start")}>{T("start")}</Button>}
            {writer && !queued[sp.id] && ["collected", "received", "in-process"].includes(sp.status) && <Button size="sm" variant="ghost" icon="x" data-testid={`reject-${sp.tube}`} disabled={busy} onClick={() => setReject(sp.id)}>{T("reject")}</Button>}
          </div>
        ))}
      </Card>
      {v.specimens.some((x) => x.status === "in-process") && <span><Button variant="primary" icon="keyboard" onClick={() => router.push(`/m/lab/result?enc=${encodeURIComponent(v.encounter.id)}`)}>{T("next_result")}</Button></span>}
      <RejectDialog open={reject !== null} specimenId={reject} keyFor={key} done={done} onClose={() => setReject(null)}
        onDone={(x, wasQueued, id) => { setReject(null); if (wasQueued) setQueued((q) => ({ ...q, [id]: "reject" })); else if (x) show(x); }} />
    </div>
  );
}
