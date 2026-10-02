"use client";
/* bill/reconcile — the owner's payment-reconciliation queue (decisions 89, 101; ADR 0005). A screen beyond the design
   handoff: the prototype gets it in the next design round. Each case shows what the gateway reported next to the
   payment and the bill. "Apply to this bill" is offered only when the server's live check finds the same amount and
   TrxID for a payment of this bill that is still pending; otherwise the owner resolves it with a note. Nothing is
   applied on its own. */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ReconcileList } from "@setu/contracts";
import { Button, Callout, Card, PageState, Pill, Segmented, useToast } from "@setu/ui";
import { bill as api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { INVOICE_TONE, PAY_TONE, useB, useErr, useMoney } from "./common";

type Tab = "requested" | "approved" | "rejected";

export function BillReconcile() {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const router = useRouter(); const toast = useToast();
  const [tab, setTab] = useState<Tab>("requested");
  const [list, setList] = useState<ReconcileList | null>(null); const [failed, setFailed] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => { try { setList(await api.reconciliation(tab)); setFailed(false); } catch { setFailed(true); } }, [tab]);
  useEffect(() => { s.setPatient(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setList(null); void load(); }, [load]);

  const decide = async (taskId: string, action: "apply" | "resolve") => {
    const note = (notes[taskId] ?? "").trim();
    if (action === "resolve" && note.length < 10) return;
    const k = keys[`${taskId}:${action}`] ?? crypto.randomUUID();
    setKeys((x) => ({ ...x, [`${taskId}:${action}`]: k }));
    setBusy(taskId);
    try { await api.reconcile(taskId, action, note, k); await load(); }
    catch (e) { toast(E(e), "triangle-alert"); await load(); } finally { setBusy(null); }
  };

  return (
    <div data-screen="bill/reconcile" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{B("rec_title")}</h1>
      <span className="t-muted">{B("rec_hint")}</span>
      <Segmented label={B("rec_title")} value={tab} onChange={setTab} options={(["requested", "approved", "rejected"] as const).map((t) => ({ value: t, label: B(`rec_tab_${t}`) }))} />
      {!s.online && <Callout tone="warn" icon="cloud-off">{B("online_needed")}</Callout>}
      {failed ? <Callout tone="warn" icon="triangle-alert">{B("error_generic")}</Callout>
        : !list ? <div aria-busy="true" className="t-muted">{B("loading")}</div>
        : list.items.length === 0 ? <PageState icon="scale" title={B("rec_empty")} />
        : list.items.map((i) => {
          const note = notes[i.taskId] ?? "";
          return (
            <Card key={i.taskId} data-reconcile={i.taskId} style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16 }}>
              <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <b data-why={i.whyCode}>{B(`rw_${i.whyCode}`)}</b>
                <span className="t-small t-muted">{M.dateTime(i.createdAt)}</span>
                <span style={{ marginLeft: "auto" }} />
                <Button size="sm" variant="ghost" icon="external-link" onClick={() => router.push(`/m/bill/pay?inv=${encodeURIComponent(i.invoice.id)}`)}>{B("rec_bill")} {i.invoice.number ?? B("bill_draft")}</Button>
              </span>
              <span>{M.name(i.patient)} · <span className="num">{i.patient.facilityNo}</span></span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                <Card style={{ padding: 10 }} data-testid="rec-reported">
                  <span className="t-small t-muted">{B("rec_reported")}</span><br />
                  <b className="num">{i.reported.amountPaisa === null ? "—" : M.tk(i.reported.amountPaisa)}</b>
                  {i.reported.trxId && <div className="t-small num">{B("r_trx")} {i.reported.trxId}</div>}
                </Card>
                <Card style={{ padding: 10 }} data-testid="rec-payment">
                  <span className="t-small t-muted">{B("rec_payment")}</span><br />
                  <b>{B(`m_${i.payment.method}`)} <span className="num">{M.tk(i.payment.amountPaisa)}</span></b> <Pill tone={PAY_TONE[i.payment.status] ?? "neu"}>{B(`pst_${i.payment.status}`)}</Pill>
                  {i.payment.trxId && <div className="t-small num">{B("r_trx")} {i.payment.trxId}</div>}
                </Card>
                <Card style={{ padding: 10 }}>
                  <span className="t-small t-muted">{B("rec_bill")}</span><br />
                  <b className="num">{i.invoice.number ?? B("bill_draft")}</b> <Pill tone={INVOICE_TONE[i.invoice.status]}>{B(`st_${i.invoice.status}`)}</Pill>
                  <div className="t-small">{B("total")} <span className="num">{M.tk(i.invoice.totalPaisa)}</span> · {B("paid")} <span className="num">{M.tk(i.invoice.paidPaisa)}</span></div>
                </Card>
              </div>
              {i.status === "requested" ? (
                <>
                  {i.applyBlockers.length > 0 && <Callout tone="warn" icon="circle-alert" data-testid="rec-blockers">{i.applyBlockers.map((b) => B(`rb_${b}`)).join(" · ")}</Callout>}
                  <label className="field t-small">{B("rec_note")}
                    <textarea className="input" name={`rec-note-${i.taskId}`} rows={2} value={note} onChange={(e) => setNotes((x) => ({ ...x, [i.taskId]: e.target.value }))} />
                  </label>
                  <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button variant="primary" icon="check" data-testid="rec-apply" disabled={busy === i.taskId || !s.online || i.applyBlockers.length > 0} onClick={() => void decide(i.taskId, "apply")}>{B("rec_apply")}</Button>
                    <Button icon="file-check" data-testid="rec-resolve" disabled={busy === i.taskId || !s.online || note.trim().length < 10} onClick={() => void decide(i.taskId, "resolve")}>{B("rec_resolve")}</Button>
                  </span>
                </>
              ) : i.resolution && (
                <span className="t-small" data-testid="rec-outcome">
                  {i.resolution.action === "applied" ? B("rec_applied", { by: M.name(i.resolution.by), at: M.dateTime(i.resolution.at) }) : B("rec_resolved", { by: M.name(i.resolution.by), at: M.dateTime(i.resolution.at), note: i.resolution.note ?? "" })}
                </span>
              )}
            </Card>
          );
        })}
    </div>
  );
}
