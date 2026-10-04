"use client";
/* lab/collect — walkthrough A8. Ported from docs/prototype/Setu Lab.dc.html (screen "Sample collection").
   Without ?enc: the collection worklist. With ?enc: the visit's tube guidance (one tube per kind: EDTA for CBC, fluoride
   for RBS, plain for electrolytes — sample list), "Print labels" with an on-screen confirmation (A8 note: the prototype
   gave none), each tube's state, "Collected" (offline: kept on this device, "Not yet synced"), "Reject" with a reason
   (the test needs a new tube; the patient gets the recollection SMS), and "Cancel test" before collection (reason ≥10,
   decision D5). Payment is not required before collection (D7): the bill's status is shown for information. */
import { useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LabVisitView } from "@setu/contracts";
import { REJECT_REASONS, TUBES, type TubeKind } from "@setu/domain";
import { Button, Callout, Card, Dialog, PageState, Pill, useToast } from "@setu/ui";
import { lab } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useLabels } from "../fd/common";
import { COLLECTION_TONE, COMM_TONE, csKey, ReasonDialog, SPECIMEN_TONE, TubeDot, VisitHead, isLabWriter, useErr, useFmt, useLabVisit, useLb } from "./common";
import { LabWorklist } from "./Worklist";

export function LabCollect() {
  const enc = useSearchParams().get("enc");
  return enc ? <CollectVisit encounterId={enc} /> : <LabWorklist stage="collect" />;
}

function CollectVisit({ encounterId }: { encounterId: string }) {
  const s = useSession(); const T = useLb(); const F = useFmt(); const E = useErr(); const L = useLabels(); const toast = useToast(); const router = useRouter();
  const { v, show, reload, failed } = useLabVisit(encounterId);
  const [busy, setBusy] = useState(false);
  const [printed, setPrinted] = useState<string | null>(null);
  const [queued, setQueued] = useState<Record<string, string>>({});
  const [reject, setReject] = useState<string | null>(null);
  const [cancel, setCancel] = useState<string | null>(null); const [cancelErr, setCancelErr] = useState<string | null>(null);
  const keys = useRef<Record<string, string>>({});
  const key = (k: string) => (keys.current[k] ??= crypto.randomUUID());
  const done = (k: string) => { delete keys.current[k]; };

  if (failed) return failed === "not_found" ? <PageState icon="search-x" title={T("not_found")} /> : <Callout tone="warn" icon="triangle-alert">{T("error_generic")}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{T("loading")}</div>;
  const writer = isLabWriter(s.me?.role, "collect");
  const orderName = (id: string) => v.orders.find((o) => o.id === id)?.nameEn ?? "—";
  // results entered from this tube are withdrawn on the result screen first (clinical review H2)
  const hasResults = (spId: string) => v.orders.some((o) => o.specimen?.id === spId && o.results.some((r) => r.status !== "entered-in-error"));

  const print = async () => {
    setBusy(true);
    try {
      const n = v.tubes.length;
      const x = await lab.labels(v.encounter.id, key("labels")); done("labels"); show(x);
      const msg = T("labels_sent", { n });
      setPrinted(msg); toast(msg, "printer");
    } catch (e) { toast(E(e), "triangle-alert"); await reload(); } finally { setBusy(false); }
  };
  const collect = async (specimenId: string) => {
    setBusy(true);
    try {
      const r = await lab.step(specimenId, "collect", key(`collect:${specimenId}`));
      if (r.queued) setQueued((q) => ({ ...q, [specimenId]: "collect" }));
      else { done(`collect:${specimenId}`); show(r.data); }
    } catch (e) { done(`collect:${specimenId}`); toast(E(e), "triangle-alert"); await reload(); } finally { setBusy(false); }
  };
  const recollectSms = v.communications.filter((c) => c.kind === "recollect");

  return (
    <div data-screen="lab/collect" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <VisitHead v={v} title={T("collect_title")} right={<span data-collection={v.collection}><Pill tone={COLLECTION_TONE[v.collection] ?? "neu"} wrap>{T(`col_${v.collection}`)}</Pill></span>} />
      {!s.online && <Callout tone="warn" icon="cloud-off">{T("offline_collect")}</Callout>}
      <span className="t-small t-muted">{v.bill ? T("bill_status", { status: s.t("billingApp", `st_${v.bill.status}`) }) : T("bill_none")} · {T("bill_not_required")}</span>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0, flex: "999 1 520px" }}>
          <Card style={{ padding: 0, overflowX: "auto" }}>
            <table className="table" data-testid="tests">
              <thead><tr><th>{T("col_test")}</th><th>{T("col_tube")}</th><th>{T("col_status")}</th><th /></tr></thead>
              <tbody>
                {v.orders.map((o) => (
                  <tr key={o.id} data-order={o.testCode}>
                    <td><b>{F.test(o)}</b>{o.priority !== "routine" && <> <Pill tone="warn" icon="zap">{T(`pr_${o.priority}`)}</Pill></>}<div className="t-small t-muted">{T("ordered_by", { name: F.name(o.orderedBy), at: F.dateTime(o.orderedAt) })}</div></td>
                    <td>{o.tube ? <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><TubeDot tube={o.tube} />{T(`tube_${o.tube}`)}</span> : "—"}</td>
                    <td>{o.status === "revoked" ? <Pill tone="off" icon="ban" wrap>{T("cancelled_reason", { reason: o.revoke?.reason ?? "" })}</Pill>
                      : o.specimen ? <Pill tone={SPECIMEN_TONE[o.specimen.status] ?? "neu"}>{o.specimen.number} · {T(`sp_${o.specimen.status}`)}</Pill>
                      : <Pill tone="neu">{T("sp_needed")}</Pill>}</td>
                    <td style={{ textAlign: "right" }}>
                      {["active", "accepted", "partially-accepted"].includes(o.status) && isLabWriter(s.me?.role, "revoke") &&
                        <Button size="sm" variant="ghost" icon="ban" data-testid={`cancel-${o.testCode}`} disabled={!s.online} onClick={() => { setCancelErr(null); setCancel(o.id); }}>{T("cancel_test")}</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <b>{T("tubes_title")}</b><span className="t-small t-muted">{T("sample_list")}</span>
              <span style={{ marginLeft: "auto" }} />
              {writer && v.tubes.length > 0 && <Button variant="primary" icon="printer" data-testid="print-labels" disabled={busy || !s.online} onClick={() => void print()}>{v.tubes.every((t) => t.specimenId) ? T("reprint_labels", { n: v.tubes.length }) : T("print_labels", { n: v.tubes.length })}</Button>}
            </span>
            {v.tubes.length === 0 ? <span className="t-muted">{T("tubes_none")}</span> : v.tubes.map((t) => (
              <div key={t.tube + t.orderIds.join()} data-tube={t.tube} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 10px", border: "1px solid var(--border-subtle)", borderRadius: 8 }}>
                <TubeDot tube={t.tube as TubeKind} />
                <span style={{ display: "flex", flexDirection: "column" }}>
                  <b>{T(`tube_${t.tube}`)} · <span className="num">{s.n(TUBES[t.tube as TubeKind].volumeMl)} mL</span></b>
                  <span className="t-small">{t.orderIds.map(orderName).join(" · ")}</span>
                </span>
                <span style={{ marginLeft: "auto" }} />
                {t.recollect && <Pill tone="warn" icon="rotate-ccw">{T("recollect")}</Pill>}
                {t.specimenId && <Pill tone="neu" icon="tag">{T("label_printed")}</Pill>}
              </div>
            ))}
            <div role="status" aria-live="polite" data-testid="labels-status">{printed && <Callout tone="info" icon="printer">{printed}</Callout>}</div>
          </Card>

          <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14 }}>
            <b>{T("tubes_labelled")}</b>
            {v.specimens.length === 0 ? <span className="t-muted">{T("no_labels")}</span> : v.specimens.map((sp) => (
              <div key={sp.id} data-specimen={sp.number} data-status={queued[sp.id] ? "pending-sync" : sp.status} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "8px 10px", border: "1px solid var(--border-subtle)", borderRadius: 8 }}>
                <TubeDot tube={sp.tube} />
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <b className="num" style={{ fontFamily: "var(--font-mono)" }}>{sp.number}</b>
                  <span className="t-small">{T(`tube_${sp.tube}`)} · {sp.orderIds.map(orderName).join(" · ")}</span>
                  {sp.collectedAt && <span className="t-small t-muted">{T("collected_by", { name: F.name(sp.collectedBy), at: F.dateTime(sp.collectedAt) })}</span>}
                  {sp.rejectedAt && <span className="t-small" style={{ color: "var(--danger-fg, inherit)" }}>{T("rejected_line", { reason: T(`rr_${sp.rejectReason}`), note: sp.rejectNote ?? "", name: F.name(sp.rejectedBy), at: F.dateTime(sp.rejectedAt) })}</span>}
                </span>
                <span style={{ marginLeft: "auto" }} />
                {queued[sp.id] ? <Pill tone="off" icon="cloud-off">{T("not_synced")}</Pill> : <Pill tone={SPECIMEN_TONE[sp.status] ?? "neu"}>{T(`sp_${sp.status}`)}</Pill>}
                {writer && sp.status === "pending" && !queued[sp.id] && <Button size="sm" variant="primary" icon="check" data-testid={`collect-${sp.tube}`} disabled={busy} onClick={() => void collect(sp.id)}>{T("collected")}</Button>}
                {writer && ["pending", "collected", "received", "in-process"].includes(sp.status) && !queued[sp.id] && !hasResults(sp.id) && <Button size="sm" variant="ghost" icon="x" data-testid={`reject-${sp.tube}`} disabled={busy} onClick={() => setReject(sp.id)}>{T("reject")}</Button>}
              </div>
            ))}
            {v.specimens.some((x) => ["collected", "received", "in-process"].includes(x.status)) && <span><Button icon="arrow-right" onClick={() => router.push(`/m/lab/accession?enc=${encodeURIComponent(v.encounter.id)}`)}>{T("next_accession")}</Button></span>}
          </Card>
        </div>

        <aside style={{ display: "flex", flexDirection: "column", gap: 12, flex: "1 1 280px", maxWidth: 380 }}>
          <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }} data-testid="label-preview">
            <b>{T("label_preview")}</b>
            {v.specimens.filter((x) => x.status === "pending").length === 0 ? <span className="t-small t-muted">{T("label_preview_none")}</span>
              : v.specimens.filter((x) => x.status === "pending").map((sp) => (
                <div key={sp.id} style={{ border: "1px dashed var(--border-default)", borderRadius: 6, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 2, fontFamily: "var(--font-mono)" }}>
                  <b style={{ fontFamily: "var(--font-sans)" }}>{v.patient.nameEn ?? v.patient.nameBn} · {L.age(v.patient)} {L.sex(v.patient.sex)}</b>
                  <span aria-hidden style={{ height: 22, background: "repeating-linear-gradient(90deg, var(--text-primary) 0 2px, transparent 2px 4px, var(--text-primary) 4px 5px, transparent 5px 8px)" }} />
                  <b className="num">{sp.number}</b>
                  <span className="t-small">{v.patient.facilityNo} · {sp.orderIds.map(orderName).slice(0, 3).join(", ")}{sp.labelPrints > 1 ? ` · ${T("copy_n", { n: sp.labelPrints })}` : ""}</span>
                </div>
              ))}
          </Card>
          <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }} data-testid="recollect-sms">
            <b>{T("recollect_sms")}</b>
            {recollectSms.length === 0 ? <span className="t-small t-muted">{T("recollect_sms_none")}</span> : recollectSms.map((c) => (
              <span key={c.id} className="t-small" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <Pill tone={COMM_TONE[c.status] ?? "neu"} icon="message-square">{T(csKey(c))}</Pill><span className="num">{c.toPhone ? L.phone(c.toPhone.slice(1)) : "—"} · {F.dateTime(c.completedAt ?? c.createdAt)}</span>
              </span>
            ))}
            {!v.patient.phone && <Callout tone="warn" icon="phone-off">{T("no_mobile_tell")}</Callout>}
            <span className="t-small t-muted">{T("sms_no_results")}</span>
          </Card>
        </aside>
      </div>

      <RejectDialog open={reject !== null} onClose={() => setReject(null)} onDone={(x, wasQueued, id) => { setReject(null); if (wasQueued) setQueued((q) => ({ ...q, [id]: "reject" })); else if (x) show(x); }} specimenId={reject} keyFor={key} done={done} />
      <ReasonDialog open={cancel !== null} title={T("cancel_title")} body={T("cancel_body")} label={T("reason")} confirm={T("cancel_confirm")} busy={busy} error={cancelErr}
        onClose={() => setCancel(null)}
        onConfirm={async (reason) => {
          if (!cancel) return; setBusy(true);
          try { const r = await lab.revoke(cancel, reason, key(`revoke:${cancel}`)); done(`revoke:${cancel}`); setCancel(null); toast(T("cancelled_done", { test: orderName(r.order.id) }), "ban"); await reload(); }
          catch (e) { setCancelErr(E(e)); } finally { setBusy(false); }
        }} />
    </div>
  );
}

export function RejectDialog({ open, specimenId, onClose, onDone, keyFor, done }: { open: boolean; specimenId: string | null; onClose: () => void; onDone: (v: LabVisitView | null, queued: boolean, id: string) => void; keyFor: (k: string) => string; done: (k: string) => void }) {
  const T = useLb(); const E = useErr();
  const [reason, setReason] = useState<(typeof REJECT_REASONS)[number] | "">(""); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const ok = reason !== "" && (reason !== "other" || note.trim().length >= 10);
  const submit = async () => {
    if (!specimenId || !reason) return;
    setBusy(true); setError(null);
    try {
      const r = await lab.reject(specimenId, { reason, ...(note.trim() ? { note: note.trim() } : {}) }, keyFor(`reject:${specimenId}`));
      done(`reject:${specimenId}`); setReason(""); setNote("");
      onDone(r.queued ? null : r.data, r.queued, specimenId);
    } catch (e) { setError(E(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} label={T("reject_title")} width={480}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
        <h2 className="t-h3" style={{ margin: 0 }}>{T("reject_title")}</h2>
        <span className="t-small">{T("reject_body")}</span>
        <label className="field t-small">{T("reject_reason")}
          <select className="input" name="reject-reason" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
            <option value="">{T("choose")}</option>
            {REJECT_REASONS.map((r) => <option key={r} value={r}>{T(`rr_${r}`)}</option>)}
          </select>
        </label>
        {reason === "other" && <label className="field t-small">{T("reject_note")}<textarea className="input" name="reject-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /><span className="t-small t-muted">{T("reason_min", { n: 10 })}</span></label>}
        {error && <span className="field-error" role="alert">{error}</span>}
        <span style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onClose}>{T("cancel")}</Button>
          <Button variant="danger" icon="x" data-testid="reject-confirm" disabled={!ok || busy} onClick={() => void submit()}>{T("reject_confirm")}</Button>
        </span>
      </div>
    </Dialog>
  );
}
