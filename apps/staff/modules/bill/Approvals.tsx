"use client";
/* bill/approvals — owner / admin. Ported from docs/prototype/Setu Billing.dc.html (screen "Approvals inbox").
   Discount requests above the cashier's limit: approve (A) applies the discount to the bill; reject (R) needs a note
   and applies nothing. Nobody approves their own request (the server refuses it; the button says so). */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ApprovalList } from "@setu/contracts";
import { Button, Callout, Card, PageState, Pill, Segmented, useToast } from "@setu/ui";
import { bill as api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useB, useErr, useMoney } from "./common";

type Tab = "requested" | "approved" | "rejected";

export function BillApprovals() {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const router = useRouter(); const toast = useToast();
  const [tab, setTab] = useState<Tab>("requested");
  const [list, setList] = useState<ApprovalList | null>(null); const [failed, setFailed] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const load = useCallback(async () => { try { setList(await api.approvals(tab)); setFailed(false); } catch { setFailed(true); } }, [tab]);
  useEffect(() => { s.setPatient(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setList(null); void load(); }, [load]);

  const decide = async (taskId: string, d: "approve" | "reject") => {
    const note = (notes[taskId] ?? "").trim();
    if (d === "reject" && note.length < 10) return;
    setBusy(taskId);
    const k = keys[`${taskId}:${d}`] ?? crypto.randomUUID();
    setKeys((x) => ({ ...x, [`${taskId}:${d}`]: k }));
    try { await api.decide(taskId, d, note, k); await load(); }
    catch (e) { toast(E(e), "triangle-alert"); await load(); } finally { setBusy(null); }
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!focus || busy || tab !== "requested" || (e.target as HTMLElement).tagName === "TEXTAREA" || (e.target as HTMLElement).tagName === "INPUT") return;
      if (list?.items.find((x) => x.taskId === focus)?.requestedBy.id === s.me?.userId) return; // never your own request
      if (e.key === "a" || e.key === "A") { e.preventDefault(); void decide(focus, "approve"); }
      if (e.key === "r" || e.key === "R") { e.preventDefault(); void decide(focus, "reject"); }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });

  return (
    <div data-screen="bill/approvals" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{B("appr_title")}</h1>
      <Segmented label={B("appr_title")} value={tab} onChange={setTab} options={(["requested", "approved", "rejected"] as const).map((t) => ({ value: t, label: B(`appr_tab_${t}`) }))} />
      {!s.online && <Callout tone="warn" icon="cloud-off">{B("online_needed")}</Callout>}
      {failed ? <Callout tone="warn" icon="triangle-alert">{B("error_generic")}</Callout>
        : !list ? <div aria-busy="true" className="t-muted">{B("loading")}</div>
        : list.items.length === 0 ? <PageState icon="badge-check" title={B("appr_empty")} />
        : list.items.map((a) => {
          const pct = a.subtotalPaisa > 0 ? Math.round((a.amountPaisa * 1000) / a.subtotalPaisa) / 10 : 0;
          const mine = a.requestedBy.id === s.me?.userId;
          const note = notes[a.taskId] ?? "";
          return (
            <Card key={a.taskId} data-approval={a.taskId} tabIndex={0} onFocus={() => setFocus(a.taskId)} onClick={() => setFocus(a.taskId)}
              style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16, outline: focus === a.taskId ? "2px solid var(--focus-ring, #4c8bf5)" : undefined }}>
              <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <Pill tone="warn">{B("appr_discount")}</Pill>
                <b className="num" style={{ fontSize: 18 }}>{M.tk(a.amountPaisa)}</b>
                <span className="t-small t-muted">{B("appr_of_subtotal", { pct })}</span>
                <span className="t-small">· {B("appr_limit")}: <span className="num">{M.tk(a.limitPaisa)}</span></span>
                <span style={{ marginLeft: "auto" }} />
                <Button size="sm" variant="ghost" icon="external-link" onClick={() => router.push(`/m/bill/opd?inv=${encodeURIComponent(a.invoice.id)}`)}>{B("appr_bill")} {a.invoice.number ?? B("bill_draft")}</Button>
              </span>
              <span>{M.name(a.patient)} · <span className="num">{a.patient.facilityNo}</span> · {B("total")} <span className="num">{M.tk(a.invoice.totalPaisa)}</span></span>
              <span className="t-small">{B("appr_by")}: {M.name(a.requestedBy)} · {M.dateTime(a.requestedAt)}</span>
              <span className="t-small">{B("appr_reason")}: {B(`cat_${a.category}`)} — {a.reason}</span>
              <span className="t-small t-muted">{B("appr_today", { name: M.name(a.requestedBy), n: a.requesterToday.count, amount: M.tk(a.requesterToday.totalPaisa) })}</span>
              {a.status === "requested" ? (
                <>
                  <label className="field t-small">{B("appr_note")}
                    <textarea className="input" name={`note-${a.taskId}`} rows={2} value={note} onChange={(e) => setNotes((x) => ({ ...x, [a.taskId]: e.target.value }))} />
                  </label>
                  <span style={{ display: "flex", gap: 8 }}>
                    <Button variant="primary" icon="check" data-testid="approve" disabled={busy === a.taskId || !s.online || mine} title={mine ? B("appr_own") : undefined} onClick={() => void decide(a.taskId, "approve")}>{B("appr_approve")}</Button>
                    <Button variant="danger" icon="x" data-testid="reject" disabled={busy === a.taskId || !s.online || note.trim().length < 10} onClick={() => void decide(a.taskId, "reject")}>{B("appr_reject")}</Button>
                  </span>
                </>
              ) : (
                <span className="t-small">{B("appr_decided", { status: B(`appr_tab_${a.status}`), by: M.name(a.decidedBy), at: M.dateTime(a.decidedAt) })}{a.decisionNote ? ` — ${a.decisionNote}` : ""}</span>
              )}
            </Card>
          );
        })}
    </div>
  );
}
