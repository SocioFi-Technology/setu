"use client";
/* bill/shift — cashier shift close (journey C4, ADR 0008; prototype Setu Billing › Shift close). The cashier opens a
   shift with a float, sees what the drawer should hold (the server's figure), counts the drawer by note, reads the
   digital settlements and hands over; a variance needs a reason. The owner / admin sees the handed-over shifts:
   approve (a variance needs a note — issue #24) or ask for a recount. Nothing is "handed over" or "approved" until
   the server answers; offline these buttons are off. Fits a phone (the owner reviews on the phone, C4). */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ShiftView } from "@setu/contracts";
import { DENOMINATIONS, countCheck, digitalRows, parseTaka, varianceJudgement } from "@setu/domain";
import { fill } from "@setu/i18n";
import { Button, Callout, Card, PageState, Pill, useToast } from "@setu/ui";
import { ApiFailure, shifts } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useMoney } from "./common";

function useO() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) =>
    fill(s.t("ownerApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}
const errText = (e: unknown, lang: string) => (e instanceof ApiFailure ? (lang === "bn" ? e.body.message_bn : e.body.message_en) : "—");
const VTONE = { short: "bad", over: "warn", matched: "ok" } as const;

export function BillShift() {
  const s = useSession();
  const reviewer = s.me?.role === "owner" || s.me?.role === "admin";
  useEffect(() => { s.setPatient(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div data-screen="bill/shift" style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0, maxWidth: 980 }}>
      {reviewer ? <ReviewList /> : <MyDrawer />}
    </div>
  );
}

/* ───── the cashier ───── */
function MyDrawer() {
  const s = useSession(); const O = useO(); const M = useMoney(); const toast = useToast();
  const [data, setData] = useState<{ shift: ShiftView | null; lastApproved: ShiftView | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => { try { setData(await shifts.mine()); setFailed(false); } catch { setFailed(true); } }, []);
  useEffect(() => { void load(); }, [load]);
  const [float, setFloat] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const open = async () => {
    const p = parseTaka(float || "0");
    if (p === null) return;
    setBusy(true);
    try { await shifts.open(p, key); setKey(crypto.randomUUID()); await load(); } catch (e) { toast(errText(e, s.lang), "triangle-alert"); } finally { setBusy(false); }
  };
  if (failed) return <Callout tone="warn" icon="triangle-alert">{O("error_generic")}</Callout>;
  if (!data) return <div aria-busy="true" className="t-muted">{O("loading")}</div>;
  const sh = data.shift;
  return (
    <>
      <h1 className="t-h2" style={{ margin: 0 }}>{O("sh_title")}</h1>
      {!s.online && <Callout tone="warn" icon="cloud-off">{O("needs_connection")}</Callout>}
      {data.lastApproved?.latestCount && <span className="t-small t-muted" data-testid="last-approved">{O("sh_last", { at: M.dateTime(data.lastApproved.statusAt), variance: M.tk(data.lastApproved.latestCount.variancePaisa) })}</span>}
      {!sh ? (
        <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }} data-testid="shift-none">
          <span>{O("sh_none")}</span>
          <label className="field t-small">{O("sh_float")}
            <input className="input num" name="shift-float" inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} placeholder="2,000" />
          </label>
          <span><Button variant="primary" icon="play" data-testid="shift-open" disabled={busy || !s.online || parseTaka(float || "0") === null} onClick={() => void open()}>{O("sh_open")}</Button></span>
        </Card>
      ) : sh.status === "open" ? <CountForm sh={sh} onDone={load} /> : <ClosedCard sh={sh} />}
    </>
  );
}

function CountForm({ sh, onDone }: { sh: ShiftView; onDone: () => Promise<void> }) {
  const s = useSession(); const O = useO(); const M = useMoney(); const toast = useToast();
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [settle, setSettle] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  /** blind count (money-controls review M1): the variance is unknown until the server reveals it after the count */
  const [revealed, setRevealed] = useState<number | null>(null);
  const live = sh.live!;
  const parsed = useMemo(() => Object.fromEntries(Object.entries(counts).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, Number(v.replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d))))])), [counts]);
  const check = countCheck(parsed as never);
  const counted = check.ok ? check.countedPaisa : 0;
  const settlement = Object.fromEntries(Object.entries(settle).map(([k, v]) => [k, parseTaka(v)]).filter(([, v]) => v !== null)) as Record<string, number>;
  const rows = digitalRows(Object.fromEntries(live.digital.map((d) => [d.method, d.systemPaisa])), settlement);
  const needReason = revealed !== null && revealed !== 0 && reason.trim().length < 10;
  const lastRecount = [...sh.reviews].reverse().find((r) => r.decision === "recount");
  const submit = async () => {
    setBusy(true);
    try {
      await shifts.count(sh.id, { counts: parsed as Record<string, number>, settlement, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(revealed !== null ? { varianceSeenPaisa: revealed } : {}) }, key);
      setKey(crypto.randomUUID()); toast(O("sh_done_handover"), "check"); await onDone();
    } catch (e) {
      // the server revealed a variance (or it changed meanwhile): show it, ask for the reason, send again
      if (e instanceof ApiFailure && (e.body.code === "reason_required" || e.body.code === "variance_changed") && e.body.amountPaisa !== undefined) {
        setRevealed(e.body.amountPaisa); setKey(crypto.randomUUID());
        if (e.body.code === "variance_changed") toast(errText(e, s.lang), "triangle-alert");
      } else { toast(errText(e, s.lang), "triangle-alert"); await onDone(); }
    } finally { setBusy(false); }
  };
  return (
    <>
      {lastRecount && <Callout tone="warn" icon="rotate-ccw" data-testid="recount-banner">{O("sh_recount", { by: M.name(lastRecount.by), note: lastRecount.note ?? "" })}</Callout>}
      <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6 }} data-testid="shift-live">
        <span className="t-small t-muted">{O("sh_opened", { at: M.dateTime(sh.openedAt), float: M.tk(sh.openingFloatPaisa) })}</span>
        <span className="t-small t-muted">{O("sh_payments", { n: live.payments })}</span>
        <span className="t-small">{O("sh_blind")}</span>
      </Card>
      <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <b>{O("sh_count")}</b>
        <div className="denoms">
          {DENOMINATIONS.map((d) => (
            <label key={d} className="field t-small" style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
              <span className="num" style={{ minWidth: 52 }}>{O("sh_note", { d: s.n(d) })} ×</span>
              <input className="input num" name={`note-${d}`} inputMode="numeric" style={{ width: 80 }} value={counts[d] ?? ""} onChange={(e) => setCounts((c) => ({ ...c, [d]: e.target.value }))} />
            </label>
          ))}
        </div>
        {!check.ok && <span className="field-error" role="alert">{O("error_generic")}</span>}
        <span style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }} data-testid="shift-sums">
          <span>{O("sh_counted")}: <b className="num" data-testid="shift-counted">{M.tk(counted)}</b></span>
          {revealed !== null && <span data-testid="shift-variance" data-judgement={varianceJudgement(revealed)}>{O("sh_variance")}: <b className="num">{M.tk(revealed)}</b> <Pill tone={VTONE[varianceJudgement(revealed)]} icon="triangle-alert">{O(`sh_${varianceJudgement(revealed)}`)}</Pill> <span className="t-small t-muted">{O("sh_revealed")}</span></span>}
        </span>
      </Card>
      <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }} data-testid="shift-digital">
        <b>{O("sh_digital")}</b>
        {rows.map((r) => (
          <span key={r.method} data-method={r.method} data-state={r.state} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ minWidth: 64 }}>{O(`m_${r.method}`)}</span>
            <span className="t-small">{O("sh_system")}: <b className="num">{M.tk(r.systemPaisa)}</b></span>
            <input className="input num" name={`settle-${r.method}`} inputMode="decimal" style={{ width: 120 }} aria-label={`${O(`m_${r.method}`)} — ${O("sh_settlement")}`} placeholder={O("sh_settlement")} value={settle[r.method] ?? ""} onChange={(e) => setSettle((x) => ({ ...x, [r.method]: e.target.value }))} />
            <Pill tone={r.state === "matched" ? "ok" : r.state === "pending" ? "pend" : "warn"}>{r.state === "mismatch" ? O("sh_d_mismatch", { diff: M.tk(r.diffPaisa ?? 0) }) : r.state === "matched" && r.systemPaisa === 0 && r.settlementPaisa === null ? O("sh_d_none") : O(`sh_d_${r.state}`)}</Pill>
          </span>
        ))}
        <span className="t-small t-muted">{O("sh_d_hint")}</span>
      </Card>
      <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        {revealed !== null && revealed !== 0 && (
          <label className="field t-small">{O("sh_reason")}
            <textarea className="input" name="shift-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        )}
        {needReason && <span className="t-small" data-testid="reason-needed" style={{ color: "var(--danger-fg)" }}>{O("sh_reason_needed")}</span>}
        <span><Button variant="primary" icon="lock" data-testid="shift-handover" disabled={busy || needReason || !check.ok || !s.online} onClick={() => void submit()}>{busy ? O("sh_waiting") : O("sh_handover")}</Button></span>
      </Card>
    </>
  );
}

function CountSummary({ sh }: { sh: ShiftView }) {
  const O = useO(); const M = useMoney();
  const c = sh.latestCount!;
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span className="t-small t-muted">{O("sh_count_no", { n: c.countNo })} · {M.dateTime(c.countedAt)}</span>
      <span style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <span>{O("sh_counted")}: <b className="num">{M.tk(c.countedPaisa)}</b></span>
        <span>{O("sh_expected")}: <b className="num">{M.tk(c.expectedCashPaisa)}</b></span>
        <span data-testid="count-variance" data-judgement={c.judgement}>{O("sh_variance")}: <b className="num">{M.tk(c.variancePaisa)}</b> <Pill tone={VTONE[c.judgement]} icon={c.judgement === "matched" ? "check" : "triangle-alert"}>{O(`sh_${c.judgement}`)}</Pill></span>
      </span>
      {c.reason && <span className="t-small">{O("sh_why", { reason: c.reason })}</span>}
      <span className="t-small" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {c.digital.filter((d) => d.systemPaisa || d.settlementPaisa !== null).map((d) => <span key={d.method} data-method={d.method} data-state={d.state}>{O(`m_${d.method}`)} <span className="num">{M.tk(d.systemPaisa)}</span>{d.state === "mismatch" ? ` · ${O("sh_d_mismatch", { diff: M.tk(d.diffPaisa ?? 0) })}` : d.state === "pending" ? ` · ${O("sh_d_pending")}` : ` · ${O("sh_d_matched")}`}</span>)}
      </span>
      {c.digital.some((d) => d.settlementPaisa !== null) && <span className="t-small t-muted">{O("sh_d_unverified")}</span>}
    </span>
  );
}

function ClosedCard({ sh }: { sh: ShiftView }) {
  const O = useO(); const M = useMoney();
  return (
    <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }} data-testid="shift-closed" data-status={sh.status}>
      <Callout icon="hourglass">{O("sh_closed", { at: M.dateTime(sh.statusAt) })}</Callout>
      {sh.latestCount && <CountSummary sh={sh} />}
    </Card>
  );
}

/* ───── the owner / admin (C4 on the phone) ───── */
function ReviewList() {
  const O = useO();
  const [items, setItems] = useState<ShiftView[] | null>(null); const [failed, setFailed] = useState(false);
  const load = useCallback(async () => { try { setItems((await shifts.list("closed")).items); setFailed(false); } catch { setFailed(true); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (failed) return <Callout tone="warn" icon="triangle-alert">{O("error_generic")}</Callout>;
  if (!items) return <div aria-busy="true" className="t-muted">{O("loading")}</div>;
  return (
    <>
      <h1 className="t-h2" style={{ margin: 0 }}>{O("sh_review_title")}</h1>
      {items.length === 0 ? <PageState icon="badge-check" title={O("sh_review_none")} /> : items.map((sh) => <ReviewCard key={sh.id} sh={sh} onDone={load} />)}
    </>
  );
}

function ReviewCard({ sh, onDone }: { sh: ShiftView; onDone: () => Promise<void> }) {
  const s = useSession(); const O = useO(); const M = useMoney(); const toast = useToast();
  const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [key, setKey] = useState(() => crypto.randomUUID());
  const c = sh.latestCount!;
  const hasVariance = c.variancePaisa !== 0;
  const decide = async (d: "approve" | "recount") => {
    setBusy(true);
    try { await shifts.review(sh.id, d, note.trim(), key); setKey(crypto.randomUUID()); toast(O(d === "approve" ? "sh_done_approved" : "sh_done_recount"), "check"); await onDone(); }
    catch (e) { toast(errText(e, s.lang), "triangle-alert"); } finally { setBusy(false); }
  };
  const noteOk = note.trim().length >= 10;
  return (
    <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }} data-shift={sh.id} data-variance={c.variancePaisa}>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <b>{O("sh_cashier", { name: M.name(sh.cashier) })}</b>
        <span className="t-small t-muted">{M.dateTime(sh.openedAt)} → {M.dateTime(c.countedAt)}</span>
      </span>
      <span className="t-small" data-testid="review-float">{O("sh_float_owner", { float: M.tk(sh.openingFloatPaisa) })}</span>
      <CountSummary sh={sh} />
      {sh.reviews.length > 0 && <span className="t-small t-muted">{O("sh_history")}: {sh.reviews.map((r) => `${O("sh_count_no", { n: r.countNo })} — ${r.decision === "recount" ? O("sh_recount_btn") : O("sh_approve")}: ${r.note ?? ""}`).join(" · ")}</span>}
      <label className="field t-small">{O("sh_review_note")}
        <textarea className="input" name="review-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {!sh.canReview && <span className="t-small t-muted">{O("sh_own")}</span>}
      <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="primary" icon="check" data-testid="shift-approve" disabled={busy || !sh.canReview || !s.online || (hasVariance && !noteOk)} onClick={() => void decide("approve")}>{hasVariance ? O("sh_accept") : O("sh_approve")}</Button>
        <Button icon="rotate-ccw" data-testid="shift-recount" disabled={busy || !sh.canReview || !s.online || !noteOk} onClick={() => void decide("recount")}>{O("sh_recount_btn")}</Button>
      </span>
    </Card>
  );
}
