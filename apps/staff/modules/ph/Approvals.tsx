"use client";
/* The pharmacy's approvals as cards (Kamrul 03/10/2026: one approval queue). Used by the owner's Approvals screen
   (bill/approvals, every kind with a kind filter) and by the Pharmacy › Purchase approvals tab (pharmacy kinds only):
   purchase orders above the limit (approve = send; reject with a note), goods receipts only the owner / admin may post
   (a batch expiring within 6 months, a price other than the order's), counts with a difference (approve = the
   adjustment; reject with a note). Nobody decides their own request or count — the server refuses it, the buttons say so. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PharmacyApprovals } from "@setu/contracts";
import { Button, Callout, Card, Pill } from "@setu/ui";
import { purch } from "../../lib/api";
import { useSession } from "../../lib/session";
import { renewKey, useErr, useFmt, useP } from "./common";

export type PhApprovalKind = "purchase-order" | "goods-receipt" | "count";
type Status = "requested" | "approved" | "rejected";

export function PharmacyApprovalCards({ status, kinds, onCount }: { status: Status; kinds: PhApprovalKind[]; onCount?: (n: number) => void }) {
  const s = useSession(); const P = useP(); const F = useFmt(); const E = useErr(); const router = useRouter();
  const [a, setA] = useState<PharmacyApprovals | null>(null); const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); const [notes, setNotes] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const keyFor = (id: string) => { if (!keys.current.has(id)) keys.current.set(id, crypto.randomUUID()); return keys.current.get(id)!; };
  const load = useCallback(async () => { try { setA(await purch.approvals(status)); setFailed(false); } catch { setFailed(true); } }, [status]);
  useEffect(() => { setA(null); void load(); }, [load]);
  const shown = a ? { orders: kinds.includes("purchase-order") ? a.orders : [], receipts: kinds.includes("goods-receipt") ? a.receipts : [], counts: kinds.includes("count") ? a.counts : [] } : null;
  useEffect(() => { if (shown) onCount?.(shown.orders.length + shown.receipts.length + shown.counts.length); }); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <Callout tone="warn" icon="triangle-alert">{P("error_generic")}</Callout>;
  if (!shown) return <div aria-busy="true" className="t-muted">{P("loading")}</div>;

  const act = async (id: string, f: (key: string) => Promise<unknown>) => {
    setBusy(id); setMsg(null);
    try { await f(keyFor(id)); keys.current.delete(id); await load(); }
    catch (e) { setMsg(E(e)); if (renewKey(e)) keys.current.delete(id); await load(); }
    finally { setBusy(null); }
  };
  const note = (id: string) => (notes[id] ?? "").trim();
  // a plain render helper, not a component: typing must not remount the box
  const noteBox = (id: string) => (
    <label className="field t-small">{P("reject_note")}
      <textarea className="input" rows={2} value={notes[id] ?? ""} onChange={(e) => setNotes((x) => ({ ...x, [id]: e.target.value }))} data-testid="appr-note" />
    </label>
  );
  return (
    <>
      {msg && <Callout tone="bad" icon="triangle-alert">{msg}</Callout>}
      {shown.orders.map(({ order: o, approval }) => {
        const mine = approval.requestedBy.id === s.me?.userId;
        return (
          <Card key={approval.taskId} data-testid="appr-po" data-kind="purchase-order" data-po={o.id} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
            <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Pill tone="warn" icon="stamp">{P("po_above")}</Pill>
              <b className="num" style={{ fontSize: 18 }}>{F.tk(o.totalPaisa)}</b>
              <span>{o.supplier.name} · {P("lines_n", { n: o.lineCount })}</span>
              <span style={{ marginLeft: "auto" }} />
              <Button size="sm" variant="ghost" icon="external-link" onClick={() => router.push(`/m/ph/purchase?po=${encodeURIComponent(o.id)}`)}>{P("open")}</Button>
            </span>
            <span className="t-small">{P("asked_by", { name: F.name(approval.requestedBy), at: F.dateTime(approval.requestedAt) })}</span>
            {approval.status === "requested" ? (
              <>
                {noteBox(approval.taskId)}
                <span style={{ display: "flex", gap: 8 }}>
                  <Button variant="primary" icon="check" data-testid="appr-po-approve" disabled={!s.online || busy === approval.taskId || mine} title={mine ? P("own_request") : undefined}
                    onClick={() => void act(approval.taskId, (k) => purch.approval(o.id, "approve", note(approval.taskId), k))}>{P("approve_send")}</Button>
                  <Button variant="danger" icon="x" data-testid="appr-po-reject" disabled={!s.online || busy === approval.taskId || mine || note(approval.taskId).length < 10}
                    onClick={() => void act(approval.taskId, (k) => purch.approval(o.id, "reject", note(approval.taskId), k))}>{P("reject")}</Button>
                </span>
              </>
            ) : <span className="t-small">{P(`appr_${approval.status}`, { by: F.name(approval.requestedBy), at: F.dateTime(approval.requestedAt), who: F.name(approval.decidedBy), note: approval.note ?? "" })}</span>}
          </Card>
        );
      })}
      {shown.receipts.map((r) => (
        <Card key={r.id} data-testid="appr-grn" data-kind="goods-receipt" style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
          <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Pill tone="warn" icon="package-check">{P("grn_needs_owner")}</Pill>
            {r.reasons.map((x) => <Pill key={x} tone="warn" icon={x === "short-expiry" ? "hourglass" : "tag"}>{P(`why_${x}`)}</Pill>)}
            <span>{r.supplier} · {P("po")} <span className="num">{r.order.number}</span></span>
            <span style={{ marginLeft: "auto" }} />
            <Button size="sm" variant={r.postedAt ? "ghost" : "primary"} icon="external-link" data-testid="appr-grn-open" onClick={() => router.push(`/m/ph/purchase?grn=${encodeURIComponent(r.id)}`)}>{r.postedAt ? P("open") : P("open_to_post")}</Button>
          </span>
          <span className="t-small">{F.name(r.createdBy)} · {F.dateTime(r.createdAt)}{r.postedBy ? ` · ${P("posted_by", { name: F.name(r.postedBy), at: F.dateTime(r.postedAt) })}` : ""}</span>
        </Card>
      ))}
      {shown.counts.map((c) => {
        const mine = c.createdBy.id === s.me?.userId;
        return (
          <Card key={c.id} data-testid="appr-count" data-kind="count" data-count={c.id} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
            <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Pill tone="warn" icon="clipboard-check">{P("count_waiting")}</Pill>
              <span>{P(`loc_${c.location}`)} · {P("variance_lines_n", { n: c.varianceLines })} · <span className="num">{F.tk(c.varianceValuePaisa)}</span></span>
              <span style={{ marginLeft: "auto" }} />
              <Button size="sm" variant="ghost" icon="external-link" onClick={() => router.push(`/m/ph/count?count=${encodeURIComponent(c.id)}`)}>{P("open")}</Button>
            </span>
            <span className="t-small">{F.name(c.createdBy)} · {F.dateTime(c.createdAt)}</span>
            {c.status === "submitted" ? (
              <>
                {noteBox(c.id)}
                <span style={{ display: "flex", gap: 8 }}>
                  <Button variant="primary" icon="check" data-testid="appr-count-approve" disabled={!s.online || busy === c.id || mine} title={mine ? P("own_count") : undefined}
                    onClick={() => void act(c.id, (k) => purch.decideCount(c.id, "approve", note(c.id), k))}>{P("approve_adjust")}</Button>
                  <Button variant="danger" icon="x" data-testid="appr-count-reject" disabled={!s.online || busy === c.id || mine || note(c.id).length < 10}
                    onClick={() => void act(c.id, (k) => purch.decideCount(c.id, "reject", note(c.id), k))}>{P("reject")}</Button>
                </span>
              </>
            ) : <span className="t-small">{P(`decided_${c.status}`, { name: F.name(c.decidedBy), at: F.dateTime(c.decidedAt), note: c.decisionNote ?? "" })}</span>}
          </Card>
        );
      })}
    </>
  );
}
