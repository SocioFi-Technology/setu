"use client";
/* ph/count — journey P6 (ADR 0009). Ported from docs/prototype/Setu Pharmacy.dc.html ("Physical count & adjustment").
   Start a count of one location (the counter, the store or the fridge): every batch with stock is listed with what
   should be on the shelf (the system quantity at the start plus anything sold or moved since — the counter keeps
   working); type what is there; any difference needs a reason; submit. Stock changes only when the owner / admin
   (never the person who counted) approves — the adjustment is then posted; a rejection needs a note. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { CountList, StockCountView } from "@setu/contracts";
import { Button, Callout, Card, Dialog, PageState, Pill, SelectField, TextArea, TextField, useToast, type Tone } from "@setu/ui";
import { purch } from "../../lib/api";
import { useSession } from "../../lib/session";
import { MedName, NeedsServer, renewKey, toInt, useErr, useFmt, useP } from "./common";

const C_TONE: Record<string, Tone> = { counting: "pend", submitted: "warn", approved: "ok", rejected: "off" };

export function PhCount() {
  const id = useSearchParams().get("count");
  return id ? <CountView id={id} /> : <Counts />;
}

function Counts() {
  const s = useSession(); const P = useP(); const F = useFmt(); const E = useErr(); const router = useRouter(); const toast = useToast();
  const [list, setList] = useState<CountList | null>(null); const [loc, setLoc] = useState<"counter" | "store" | "fridge">("counter");
  const [busy, setBusy] = useState(false); const [key, setKey] = useState(() => crypto.randomUUID());
  useEffect(() => { purch.counts().then(setList).catch(() => setList({ items: [] })); }, []);
  return (
    <div data-screen="ph/count" style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{P("count_title")}</h1>
      <NeedsServer />
      <Card style={{ display: "flex", gap: 10, alignItems: "flex-end", padding: 12, flexWrap: "wrap" }}>
        <SelectField label={P("location")} value={loc} onChange={(e) => setLoc(e.target.value as typeof loc)} data-testid="count-location">
          {(["counter", "store", "fridge"] as const).map((x) => <option key={x} value={x}>{P(`loc_${x}`)}</option>)}
        </SelectField>
        <Button variant="primary" icon="clipboard-list" data-testid="start-count" disabled={!s.online || busy}
          onClick={async () => { setBusy(true); try { const c = await purch.newCount(loc, key); router.push(`/m/ph/count?count=${encodeURIComponent(c.id)}`); } catch (e) { toast(E(e), "triangle-alert"); if (renewKey(e)) setKey(crypto.randomUUID()); setBusy(false); } }}>{P("start_count")}</Button>
        <span className="t-small t-secondary">{P("count_rule")}</span>
      </Card>
      {!list ? <div aria-busy="true" className="t-muted">{P("loading")}</div> : list.items.length === 0 ? <PageState icon="clipboard-check" title={P("no_counts")} /> : (
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table className="table" style={{ width: "100%" }} data-testid="count-list">
            <thead><tr><th>{P("location")}</th><th>{P("status")}</th><th className="num">{P("batches")}</th><th className="num">{P("differences")}</th><th>{P("by")}</th><th>{P("created")}</th></tr></thead>
            <tbody>
              {list.items.map((c) => (
                <tr key={c.id} data-count={c.id} style={{ cursor: "pointer" }} tabIndex={0} role="link" onClick={() => router.push(`/m/ph/count?count=${encodeURIComponent(c.id)}`)} onKeyDown={(ev) => { if (ev.key === "Enter") router.push(`/m/ph/count?count=${encodeURIComponent(c.id)}`); }}>
                  <td>{(c.wardName ?? P(`loc_${c.location}`))}</td><td><Pill tone={C_TONE[c.status] ?? "neu"}>{P(`cs_${c.status}`)}</Pill></td><td className="num">{F.n(c.lineCount)}</td><td className="num">{F.n(c.varianceLines)}</td>
                  <td>{F.name(c.createdBy)}</td><td className="num">{F.dateTime(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function CountView({ id }: { id: string }) {
  const s = useSession(); const P = useP(); const F = useFmt(); const E = useErr(); const router = useRouter(); const toast = useToast();
  const [c, setC] = useState<StockCountView | null>(null); const [failed, setFailed] = useState(false); const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Record<string, { qty: string; reason: string }>>({});
  const [key, setKey] = useState(() => crypto.randomUUID()); const [rejecting, setRejecting] = useState(false);
  // decision 234: the counter deciding their own count as the only approver writes why
  const [selfNote, setSelfNote] = useState("");
  // line saves run one after another on the latest version (each bumps the count's rev) — none is dropped while busy
  const latest = useRef<StockCountView | null>(null); const chain = useRef<Promise<unknown>>(Promise.resolve());
  const show = useCallback((x: StockCountView) => { latest.current = x; setC(x); setEdit((old) => Object.fromEntries(x.lines.map((l) => [l.id, old[l.id] ?? { qty: l.countedQty === null ? "" : String(l.countedQty), reason: l.reason ?? "" }]))); }, []);
  const load = useCallback(async () => { try { show(await purch.count(id)); } catch { setFailed(true); } }, [id, show]);
  useEffect(() => { void load(); }, [load]);
  if (failed) return <PageState icon="clipboard-check" title={P("error_generic")} />;
  if (!c) return <div aria-busy="true" className="t-muted">{P("loading")}</div>;
  const mine = c.createdBy.id === s.me?.userId;
  const counting = c.status === "counting" && mine;
  const run = async (f: () => Promise<StockCountView>) => { if (busy) return false; setBusy(true); try { show(await f()); setKey(crypto.randomUUID()); return true; } catch (e) { toast(E(e), "triangle-alert"); if (renewKey(e)) setKey(crypto.randomUUID()); await load(); return false; } finally { setBusy(false); } };
  const save = (lineId: string) => {
    const e = edit[lineId]; const n = e ? toInt(e.qty) : null;
    if (n === null) return;
    chain.current = chain.current.then(async () => {
      const cur = latest.current!; const l = cur.lines.find((x) => x.id === lineId)!;
      if (n === l.countedQty && (e!.reason.trim() || null) === l.reason) return;
      try { show(await purch.countLine(cur.id, { rev: cur.rev, lineId, countedQty: n, ...(e!.reason.trim() ? { reason: e!.reason.trim() } : {}) })); }
      catch (err) { toast(E(err), "triangle-alert"); await load(); }
    });
  };
  return (
    <div data-screen="ph/count" data-count={c.id} data-status={c.status} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{P("count_of", { loc: (c.wardName ?? P(`loc_${c.location}`)) })}</h1>
        <Pill tone={C_TONE[c.status] ?? "neu"}>{P(`cs_${c.status}`)}</Pill>
        <span className="t-small t-secondary">{F.name(c.createdBy)} · {F.dateTime(c.createdAt)}</span>
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="arrow-left" onClick={() => router.push("/m/ph/count")}>{P("count_title")}</Button>
      </div>
      <NeedsServer />
      <Callout tone="info" icon="info">{P("expected_rule")}</Callout>
      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table className="table" style={{ width: "100%" }} data-testid="count-lines">
          <thead><tr><th>{P("medicine")}</th><th>{P("batch")}</th><th>{P("exp")}</th><th className="num">{P("expected")}</th><th className="num">{P("counted")}</th><th className="num">{P("difference")}</th><th>{P("reason")}</th></tr></thead>
          <tbody>
            {c.lines.map((l) => {
              const e = edit[l.id] ?? { qty: "", reason: "" };
              const set = (p: Partial<typeof e>) => setEdit((x) => ({ ...x, [l.id]: { ...(x[l.id] ?? e), ...p } }));
              return (
                <tr key={l.id} data-batch={l.batch.batchNo} data-variance={l.variance ?? ""}>
                  <td><MedName m={l.medicine} strong={false} />{l.returns.map((r, i) => <div key={i} className="t-small t-secondary" data-count-return={r.qty}>{P("returns_since", { n: F.n(r.qty), reason: r.reason })}</div>)}</td><td className="num">{l.batch.batchNo}</td><td className="num">{F.day(l.batch.expiry)}</td>
                  <td className="num">{F.n(l.systemQty)}</td>
                  <td className="num">{counting
                    ? <input className="input num" style={{ width: 90 }} inputMode="numeric" aria-label={P("counted")} value={e.qty} onChange={(ev) => set({ qty: ev.target.value })} onBlur={() => save(l.id)} onKeyDown={(ev) => { if (ev.key === "Enter") save(l.id); }} data-testid="count-qty" />
                    : l.countedQty === null ? "—" : F.n(l.countedQty)}</td>
                  <td className="num">{l.variance === null ? "—" : l.variance === 0 ? <Pill tone="ok" icon="check">{F.n(0)}</Pill> : <Pill tone="warn" icon={l.variance < 0 ? "arrow-down" : "arrow-up"}>{l.variance > 0 ? "+" : "−"}{F.n(Math.abs(l.variance))}</Pill>}</td>
                  <td>{counting && l.variance !== null && l.variance !== 0
                    ? <input className="input" style={{ minWidth: 200 }} aria-label={P("reason")} placeholder={P("reason_hint")} value={e.reason} onChange={(ev) => set({ reason: ev.target.value })} onBlur={() => save(l.id)} data-testid="count-reason" />
                    : <span className="t-small">{l.reason ?? ""}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <Card style={{ display: "flex", gap: 16, alignItems: "center", padding: 12, flexWrap: "wrap" }}>
        <span>{P("variance_value")}: <b className="num" data-testid="variance-value">{F.tk(c.varianceValuePaisa)}</b></span>
        {counting && c.submitBlockers.map((b) => <Pill key={b} tone="warn" icon="triangle-alert">{P(`cb_${b}`)}</Pill>)}
        <span style={{ marginLeft: "auto" }} />
        {counting && <Button variant="primary" icon="send" data-testid="submit-count" disabled={!s.online || busy || c.submitBlockers.length > 0} onClick={() => { chain.current = chain.current.then(() => run(() => purch.submitCount(latest.current!.id, latest.current!.rev, key))); }}>{P("submit_count")}</Button>}
        {c.status === "submitted" && !c.canDecide && <span className="t-small t-secondary">{P(mine ? "waiting_owner" : "owner_decides")}</span>}
        {c.canDecide && (
          <>
            {/* decision 234: the counter deciding as the only approver writes why; the count is flagged self-approved */}
            {mine && <label className="field t-small" style={{ flexBasis: "100%" }}>{P("self_note")}<span className="t-small t-muted"> — {P("self_count_hint")}</span>
              <textarea className="input" name="self-note" rows={2} value={selfNote} onChange={(e) => setSelfNote(e.target.value)} data-testid="self-note" /></label>}
            <Button variant="primary" icon="check" data-testid="approve-count" disabled={!s.online || busy || (mine && selfNote.trim().length < 10)} onClick={() => void run(() => purch.decideCount(c.id, "approve", mine ? selfNote.trim() : "", key))}>{P("approve_adjust")}</Button>
            <Button icon="x" data-testid="reject-count" disabled={!s.online || busy} onClick={() => setRejecting(true)}>{P("reject")}</Button>
          </>
        )}
      </Card>
      {c.status === "abandoned" && <Callout tone="warn" icon="hourglass" data-testid="count-abandoned">{P("decided_abandoned", { name: F.name(c.createdBy), at: F.dateTime(c.decidedAt) })}</Callout>}
      {(c.status === "approved" || c.status === "rejected") && <Callout tone={c.status === "approved" ? "info" : "warn"} icon="stamp">{P(`decided_${c.status}`, { name: F.name(c.decidedBy), at: F.dateTime(c.decidedAt), note: c.decisionNote ?? "" })}{c.selfApproved && <> <Pill tone="warn" icon="user-check">{P("self_approved")}</Pill></>}</Callout>}
      <Dialog open={rejecting} onClose={() => setRejecting(false)} label={P("reject")}>
        <RejectForm onSubmit={async (note) => { if (await run(() => purch.decideCount(c.id, "reject", note, key))) setRejecting(false); }} />
      </Dialog>
    </div>
  );
}

function RejectForm({ onSubmit }: { onSubmit: (note: string) => Promise<void> }) {
  const P = useP(); const s = useSession();
  const [n, setN] = useState(""); const [busy, setBusy] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <TextArea label={P("reject_note")} hint={P("reason_hint")} value={n} onChange={(e) => setN(e.target.value)} data-testid="reason" />
      <Button variant="primary" disabled={n.trim().length < 10 || busy || !s.online} data-testid="reason-confirm" onClick={async () => { setBusy(true); try { await onSubmit(n.trim()); } finally { setBusy(false); } }}>{P("reject")}</Button>
    </div>
  );
}
