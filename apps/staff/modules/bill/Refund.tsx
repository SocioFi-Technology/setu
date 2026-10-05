"use client";
/* bill/refund (and ph/refund — the pharmacist's counter, ADR 0013) — refunds and returns. Ported from
   docs/prototype/Setu Billing.dc.html (screen "Refunds & cancellations"): the bill's lines with what can still be
   refunded (performed = locked), the kind and the reason, how the money goes back, request → the owner / admin approves
   in the single Approvals queue → pay out (who takes the money is required) → the voucher RF/yy/nnnn, printed and
   reprinted like a receipt. A return without refund (Kamrul, decision 221) on an unpaid pharmacy bill: the medicine comes
   back, the due goes down, a credit voucher CV/yy/nnnn. One refund goes back one way (decision 220). Refunds need a
   connection: nothing here is queued on this device, and nothing says Paid before the server does.
   ?inv= a bill (its open refund, or a new request) · ?rf= one refund · neither: the list. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { RefundableView, RefundList, RefundVoucherView, RefundView } from "@setu/contracts";
import { PAYOUT_WAYS, RECIPIENT_RELATIONS, REFUND_CATEGORIES, RETURN_CATEGORIES, isWallet, paisaToInput, parseTaka, partOfLine, sum, type CashReason, type PayoutWay, type RefundCategory } from "@setu/domain";
import { Button, Callout, Card, PageState, Pill, Segmented, useToast, type Tone } from "@setu/ui";
import { ApiFailure, refunds as api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { INVOICE_TONE, useB, useErr, useMod, useMoney } from "./common";

const STATUS_TONE: Record<RefundView["refund"]["status"], Tone> = { requested: "pend", approved: "info", paid: "ok", rejected: "bad", withdrawn: "off" };
const REPRINT = ["lost", "jam", "corp", "ins"] as const;
const renew = (e: unknown) => e instanceof ApiFailure && e.status < 500;

export function BillRefund() {
  const sp = useSearchParams();
  const rf = sp.get("rf"), inv = sp.get("inv");
  if (rf) return <RefundScreen id={rf} />;
  if (inv) return <RequestForm invoiceId={inv} />;
  return <RefundListScreen />;
}

function useStatusLabel() {
  const B = useB();
  return (r: { status: RefundView["refund"]["status"]; kind: "refund" | "return" }) => (r.status === "paid" && r.kind === "return" ? B("rf_st_paid_return") : B(`rf_st_${r.status}`));
}

/* ───── the list ───── */
function RefundListScreen() {
  const s = useSession(); const B = useB(); const M = useMoney(); const router = useRouter(); const mod = useMod(); const label = useStatusLabel();
  const [tab, setTab] = useState<"open" | "paid" | "all">("open");
  const [list, setList] = useState<RefundList | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => { s.setPatient(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setList(null); api.list({ status: tab }).then((x) => { setList(x); setFailed(false); }).catch(() => setFailed(true)); }, [tab]);
  return (
    <div data-screen={`${mod}/refund`} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{B("rf_title")}</h1>
      <Segmented label={B("rf_list_title")} value={tab} onChange={setTab} options={(["open", "paid", "all"] as const).map((t) => ({ value: t, label: B(`rf_tab_${t}`) }))} />
      {failed ? <Callout tone="warn" icon="triangle-alert">{B("error_generic")}</Callout>
        : !list ? <div aria-busy="true" className="t-muted">{B("loading")}</div>
        : list.items.length === 0 ? <PageState icon="undo-2" title={B("rf_none")} />
        : list.items.map((r) => (
          <button key={r.id} type="button" className="card" data-refund={r.id} data-status={r.status} onClick={() => router.push(`/m/${mod}/refund?rf=${encodeURIComponent(r.id)}`)}
            style={{ display: "flex", gap: 12, padding: 12, textAlign: "left", cursor: "pointer", flexWrap: "wrap", alignItems: "center" }}>
            <Pill tone={STATUS_TONE[r.status]}>{label(r)}</Pill>
            {r.kind === "return" && <Pill tone="info">{B("rf_kind_return")}</Pill>}
            <b className="num">{M.tk(r.amountPaisa)}</b>
            <span>{B("rf_bill")} <span className="num">{r.invoice.number ?? "—"}</span></span>
            <span>{M.name(r.patient)}</span>
            <span className="t-small t-muted">{B(`rf_cat_${r.category}`)} · {M.dateTime(r.requestedAt)}</span>
            {r.voucher && <span className="num t-small">{r.voucher.number}</span>}
            {r.selfApproved && <Pill tone="warn">{B("rf_self_flag")}</Pill>}
          </button>
        ))}
    </div>
  );
}

/* ───── a new request ───── */
type Pick = { on: boolean; input: string };
function RequestForm({ invoiceId }: { invoiceId: string }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const router = useRouter(); const toast = useToast(); const mod = useMod();
  const [v, setV] = useState<RefundableView | null>(null); const [failed, setFailed] = useState(false);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [category, setCategory] = useState<RefundCategory | "">("");
  const [reason, setReason] = useState("");
  const [payIds, setPayIds] = useState<string[]>([]);
  const [way, setWay] = useState<PayoutWay | "">("");
  const [cashReason, setCashReason] = useState<CashReason | "">("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  useEffect(() => { s.setPatient(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    api.refundable(invoiceId).then((x) => {
      // a refund already open on this bill: show it (one at a time)
      if (x.openRefundId) { router.replace(`/m/${mod}/refund?rf=${encodeURIComponent(x.openRefundId)}`); return; }
      setV(x);
      setPicks(Object.fromEntries(x.lines.map((l) => [l.id, { on: false, input: l.byUnits ? String(l.left.qty) : paisaToInput(l.left.totalPaisa) }])));
      if (x.payments.length === 1) setPayIds([x.payments[0]!.id]);
    }).catch(() => setFailed(true));
  }, [invoiceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const kind: "refund" | "return" = v?.canReturn ? "return" : "refund";
  const parts = useMemo(() => (v?.lines ?? []).flatMap((l) => {
    const p = picks[l.id];
    if (!p?.on || l.lock) return [];
    const typed = p.input.trim().replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d))); // Bangla digits too
    const units = /^\d+$/.test(typed) ? Number(typed) : NaN;
    const amount = parseTaka(p.input);
    const part = l.byUnits ? (Number.isSafeInteger(units) ? partOfLine(l.left, { units }) : null) : amount === null ? null : partOfLine(l.left, { amountPaisa: amount });
    return [{ l, part }];
  }), [v, picks]);
  const total = sum(parts.map((x) => x.part?.totalPaisa ?? 0));
  const chosenPays = (v?.payments ?? []).filter((p) => payIds.includes(p.id));
  const ways = PAYOUT_WAYS.filter((w) => chosenPays.length > 0 && chosenPays.every((p) => p.ways.includes(w)));
  const wallet = chosenPays.some((p) => isWallet(p.method));
  // the refund spread over the chosen payments in order, never more than each holds (one way for all — decision 220)
  const allocations = useMemo(() => {
    let left = total;
    return chosenPays.map((p) => { const a = Math.min(left, p.leftPaisa); left -= a; return { paymentId: p.id, amountPaisa: a }; }).filter((a) => a.amountPaisa > 0);
  }, [total, payIds, v]); // eslint-disable-line react-hooks/exhaustive-deps
  const covered = sum(allocations.map((a) => a.amountPaisa)) === total;
  const cats = kind === "return" ? RETURN_CATEGORIES : REFUND_CATEGORIES.filter((c) => c !== "overpayment");

  if (failed) return <Callout tone="warn" icon="triangle-alert">{B("error_generic")}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{B("loading")}</div>;
  const blocked = kind === "refund" && v.blockers.length > 0;
  const gatewayOne = way === "gateway" && chosenPays.length > 1;
  const canSend = s.online && !busy && !blocked && parts.length > 0 && parts.every((x) => x.part) && total > 0 && category !== "" && reason.trim().length >= 10
    && (kind === "return" || (way !== "" && covered && !gatewayOne && (!(way === "cash" && wallet) || cashReason !== "")));

  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      const r = await api.request(invoiceId, {
        kind, category: category as RefundCategory, reason: reason.trim(),
        lines: parts.map(({ l, part }) => (l.byUnits ? { chargeItemId: l.id, units: part!.units! } : { chargeItemId: l.id, amountPaisa: part!.totalPaisa })),
        allocations: kind === "return" ? [] : allocations.map((a) => ({ ...a, way: way as PayoutWay, ...(way === "cash" && wallet ? { cashReason: cashReason as CashReason } : {}) })),
      }, key);
      router.push(`/m/${mod}/refund?rf=${encodeURIComponent(r.refund.id)}`);
    } catch (e) { toast(E(e), "triangle-alert"); if (renew(e)) setKey(crypto.randomUUID()); } finally { setBusy(false); }
  };

  return (
    <div data-screen={`${mod}/refund`} data-kind={kind} style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{B("rf_new_for", { number: v.invoice.number ?? "—" })}</h1>
        <Pill tone={INVOICE_TONE[v.invoice.status]}>{B(`st_${v.invoice.status}`)}</Pill>
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="arrow-left" onClick={() => router.push(`/m/${mod}/pay?inv=${encodeURIComponent(invoiceId)}`)}>{B("rf_back_to_pay")}</Button>
      </div>
      <span>{v.patient ? <>{M.name(v.patient)} · <span className="num">{v.patient.facilityNo}</span></> : v.buyer?.name ?? B("walk_in")}</span>
      {!s.online && <Callout tone="warn" icon="cloud-off">{B("rf_online_only")}</Callout>}
      {kind === "return" ? <Callout tone="info" icon="package-open" data-testid="return-hint">{B("rf_kind_return_hint")}</Callout>
        : blocked && <Callout tone="warn" icon="circle-alert" data-testid="rf-blockers">{v.blockers.map((b) => B(`rf_b_${b}`)).join(" ")}</Callout>}

      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table className="table" data-testid="rf-lines" style={{ width: "100%" }}>
          <thead><tr><th /><th>{B("rf_col_line")}</th><th>{B("rf_col_status")}</th><th className="num">{B("rf_col_left")}</th><th className="num">{B("rf_col_amount")}</th></tr></thead>
          <tbody>
            {v.lines.map((l) => {
              const p = picks[l.id] ?? { on: false, input: "" };
              const part = parts.find((x) => x.l.id === l.id)?.part;
              return (
                <tr key={l.id} data-line={l.id} data-lock={l.lock ?? "none"}>
                  <td><input type="checkbox" aria-label={s.lang === "bn" ? l.nameBn : l.nameEn} disabled={Boolean(l.lock) || blocked} checked={p.on} onChange={(e) => { setPicks((x) => ({ ...x, [l.id]: { ...p, on: e.target.checked } })); setKey(crypto.randomUUID()); }} /></td>
                  <td>{s.lang === "bn" ? l.nameBn : l.nameEn}{l.qty > 1 ? <span className="num"> ×{s.n(l.qty)}</span> : null}{l.controlled && <> <Pill tone="crit">{B("rf_controlled")}</Pill></>}</td>
                  <td>{l.lock ? <Pill tone="neu" icon="ban">{B(`rf_lock_${l.lock}`)}</Pill> : <Pill tone="ok" icon="check">{B("rf_refundable")}</Pill>}</td>
                  <td className="num">{l.byUnits ? `${s.n(l.left.qty)} · ${M.tk(l.left.totalPaisa)}` : M.tk(l.left.totalPaisa)}</td>
                  <td className="num">
                    {p.on && !l.lock ? (
                      <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                        <input className="input num" name={`rf-${l.id}`} inputMode={l.byUnits ? "numeric" : "decimal"} style={{ width: 96 }} aria-label={l.byUnits ? B("rf_units") : B("rf_amount_input")}
                          value={p.input} onChange={(e) => { setPicks((x) => ({ ...x, [l.id]: { ...p, input: e.target.value } })); setKey(crypto.randomUUID()); }} />
                        {l.byUnits && <span className="t-small t-muted">{B("rf_units_of", { n: l.left.qty })}</span>}
                        <b>{part ? M.tk(part.totalPaisa) : "—"}</b>
                      </span>
                    ) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label className="field t-small">{B("rf_category")}
            <select name="rf-category" className="input" value={category} onChange={(e) => { setCategory(e.target.value as RefundCategory); setKey(crypto.randomUUID()); }}>
              <option value="">{B("rf_choose")}</option>
              {cats.map((c) => <option key={c} value={c}>{B(`rf_cat_${c}`)}</option>)}
            </select>
          </label>
          <label className="field t-small" style={{ flex: 1, minWidth: 260 }}>{B("rf_reason")}
            <textarea name="rf-reason" className="input" rows={2} value={reason} onChange={(e) => { setReason(e.target.value); setKey(crypto.randomUUID()); }} />
          </label>
        </div>

        {kind === "refund" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="rf-ways">
            <b>{B("rf_way_title")}</b>
            {v.payments.map((p) => (
              <label key={p.id} className="t-small" style={{ display: "flex", gap: 8, alignItems: "center" }} data-payment={p.method}>
                <input type="checkbox" checked={payIds.includes(p.id)} disabled={p.leftPaisa <= 0 || blocked}
                  onChange={(e) => { setPayIds((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id))); setWay(""); setKey(crypto.randomUUID()); }} />
                {B("rf_payment_left", { method: B(`m_${p.method}`), amount: M.tk(p.amountPaisa), left: M.tk(p.leftPaisa) })}{p.trxId ? <span className="num"> · {p.trxId}</span> : null}
              </label>
            ))}
            {chosenPays.length > 0 && (
              <Segmented label={B("rf_way_title")} value={way || ("" as PayoutWay)} onChange={(w) => { setWay(w); setKey(crypto.randomUUID()); }} options={ways.map((w) => ({ value: w, label: B(`rf_way_${w}`) }))} />
            )}
            {way === "cash" && wallet && (
              <label className="field t-small">{B("rf_cash_reason")}
                <select name="rf-cash-reason" className="input" value={cashReason} onChange={(e) => { setCashReason(e.target.value as CashReason); setKey(crypto.randomUUID()); }}>
                  <option value="">{B("rf_choose")}</option>
                  <option value="no-wallet-access">{B("rf_cr_no-wallet-access")}</option>
                </select>
              </label>
            )}
            <span className="t-small t-muted">{B("rf_one_way")}</span>
            {gatewayOne && <Callout tone="warn" icon="circle-alert">{B("rf_one_way")}</Callout>}
            {way === "cash" && <span className="t-small t-muted">{B("rf_no_shift")}</span>}
          </div>
        )}

        <span style={{ display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap" }}>
          {kind === "refund" && <span className="t-small">{B("rf_confirmed_left")}: <span className="num">{M.tk(v.confirmedLeftPaisa)}</span></span>}
          <span>{kind === "return" ? B("rf_credit_total") : B("rf_total")}: <b className="num" style={{ fontSize: 18 }} data-testid="rf-total">{M.tk(total)}</b></span>
        </span>
        <span><Button variant="primary" icon="send" data-testid="rf-request" disabled={!canSend} onClick={() => void send()}>{busy ? B("waiting_server") : B("rf_request")}</Button></span>
        <span className="t-small t-muted">{B("rf_requested_hint")}</span>
      </Card>
    </div>
  );
}

/* ───── one refund ───── */
function RefundScreen({ id }: { id: string }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const router = useRouter(); const toast = useToast(); const mod = useMod(); const label = useStatusLabel();
  const [v, setV] = useState<RefundView | null>(null); const [failed, setFailed] = useState(false);
  const [note, setNote] = useState("");
  const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [relation, setRelation] = useState<(typeof RECIPIENT_RELATIONS)[number] | "">("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const keyFor = (k: string) => keys[k] ?? (() => { const n = crypto.randomUUID(); setKeys((x) => ({ ...x, [k]: n })); return n; })();
  const load = useCallback(async () => { try { setV(await api.view(id)); setFailed(false); } catch { setFailed(true); } }, [id]);
  useEffect(() => { s.setPatient(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  // a gateway refund under way: ask the server again every few seconds
  const paying = v?.allocations.some((a) => a.status === "paying") ?? false;
  useEffect(() => { if (!paying || !s.online) return; const t = setInterval(() => void load(), 4000); return () => clearInterval(t); }, [paying, s.online, load]);

  const act = async (k: string, fn: (key: string) => Promise<RefundView | { view: RefundView }>) => {
    if (busy) return;
    setBusy(true);
    const key = keyFor(k);
    try { const r = await fn(key); setV("view" in r ? r.view : r); setKeys((x) => { const n = { ...x }; delete n[k]; return n; }); setNote(""); }
    catch (e) { toast(E(e), "triangle-alert"); if (renew(e)) setKeys((x) => { const n = { ...x }; delete n[k]; return n; }); await load(); }
    finally { setBusy(false); }
  };

  if (failed) return <Callout tone="warn" icon="triangle-alert">{B("error_generic")}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{B("loading")}</div>;
  const r = v.refund;
  const isReturn = r.kind === "return";
  const mine = r.requestedBy.id === s.me?.userId;
  const failedGw = v.allocations.find((a) => a.status === "open" && a.gatewayFailed);
  const manual = v.allocations.some((a) => a.status === "open" && a.way === "manual");
  const recipientOk = isReturn || (name.trim().length >= 2 && phone.trim().length >= 10 && relation !== "");
  const recipient = name.trim() ? { name: name.trim(), phone: phone.trim(), relation: relation as (typeof RECIPIENT_RELATIONS)[number] } : undefined;

  return (
    <div data-screen={`${mod}/refund`} data-refund-status={r.status} data-kind={r.kind} style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{isReturn ? B("rf_kind_return") : B("rf_list_title")}</h1>
        <b className="num" style={{ fontSize: 20 }} data-testid="rf-amount">{M.tk(r.amountPaisa)}</b>
        <span data-testid="rf-status"><Pill tone={STATUS_TONE[r.status]}>{label(r)}</Pill></span>
        {r.selfApproved && <Pill tone="warn" icon="user-check">{B("rf_self_flag")}</Pill>}
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="arrow-left" onClick={() => router.push(`/m/${mod}/pay?inv=${encodeURIComponent(v.invoice.id)}`)}>{B("rf_bill")} {v.invoice.number ?? "—"}</Button>
      </div>
      <span>{v.patient ? <>{M.name(v.patient)} · <span className="num">{v.patient.facilityNo}</span></> : v.buyer?.name ?? B("walk_in")} · {B(`rf_cat_${r.category}`)} — {r.reason}</span>
      {!s.online && <Callout tone="warn" icon="cloud-off">{B("rf_online_only")}</Callout>}
      {r.needsOwner && r.status === "requested" && <Callout tone="warn" icon="shield-alert" data-testid="rf-needs-owner">{B("rf_needs_owner")}</Callout>}

      <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6 }} data-testid="rf-detail">
        {v.lines.map((l) => (
          <span key={l.id} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <span>{s.lang === "bn" ? l.nameBn : l.nameEn}{l.units ? <span className="num"> ×{s.n(l.units)}</span> : null}</span>
            <span className="num">{M.tk(l.totalPaisa)}{l.vatPaisa > 0 ? <span className="t-small t-muted"> ({B("vat")} {M.tk(l.vatPaisa)})</span> : null}</span>
          </span>
        ))}
        {v.allocations.map((a) => (
          <span key={a.id} className="t-small" data-allocation={a.status} data-way={a.way} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <b>{B(`rf_way_${a.way}`)}</b> · {B(`m_${a.method}`)} <span className="num">{M.tk(a.amountPaisa)}</span>
            {a.cashReason && <span>· {B(`rf_cr_${a.cashReason}`)}</span>}
            {a.refundTrxId && <span className="num">· {B("v_refund_trx")} {a.refundTrxId}</span>}
            {a.reference && <span className="num">· {B("v_ref")} {a.reference}</span>}
            {a.needsReconciliation && <Pill tone={a.reconciled === "matched" ? "ok" : "warn"}>{a.reconciled === "matched" ? B("rf_matched") : B("rf_flagged")}</Pill>}
          </span>
        ))}
      </Card>

      {r.status === "requested" && (
        <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }} data-testid="rf-decide">
          <span className="t-small">{B("rf_requested_hint")}</span>
          {(v.can.approve || v.can.reject) && (
            <>
              {mine && <Callout tone="warn" icon="user-check">{B("rf_self_note")}</Callout>}
              <label className="field t-small">{B("rf_note")}<textarea name="rf-note" className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
              <span style={{ display: "flex", gap: 8 }}>
                <Button variant="primary" icon="check" data-testid="rf-approve" disabled={busy || !s.online || (mine && note.trim().length < 10)} onClick={() => void act("approve", (k) => api.decide(id, { decision: "approve", ...(note.trim() ? { note: note.trim() } : {}) }, k))}>{B("rf_approve")}</Button>
                <Button variant="danger" icon="x" data-testid="rf-reject" disabled={busy || !s.online || note.trim().length < 10} onClick={() => void act("reject", (k) => api.decide(id, { decision: "reject", note: note.trim() }, k))}>{B("rf_reject")}</Button>
              </span>
            </>
          )}
        </Card>
      )}

      {r.status === "approved" && paying && (
        <Callout tone="info" icon="hourglass" data-testid="rf-paying">
          {B("rf_paying")} <Button size="sm" icon="refresh-cw" data-testid="rf-check" disabled={busy || !s.online} onClick={() => void act("check", () => api.check(id))}>{B("rf_check")}</Button>
        </Callout>
      )}
      {r.status === "approved" && failedGw && <Callout tone="bad" icon="circle-x" data-testid="rf-failed">{B("rf_failed", { why: failedGw.failReason ?? "—" })}</Callout>}

      {r.status === "approved" && v.can.pay && (
        <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }} data-testid="rf-pay">
          <b>{isReturn ? B("rf_record_title") : B("rf_pay_title")}</b>
          {!isReturn && (
            <>
              <span className="t-small t-muted">{B("rf_recipient_hint")}</span>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <label className="field t-small">{B("rf_recipient_name")}<input name="rf-recipient-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
                <label className="field t-small">{B("rf_recipient_phone")}<input name="rf-recipient-phone" className="input num" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
                <label className="field t-small">{B("rf_recipient_relation")}
                  <select name="rf-recipient-relation" className="input" value={relation} onChange={(e) => setRelation(e.target.value as typeof relation)}>
                    <option value="">{B("rf_choose")}</option>
                    {RECIPIENT_RELATIONS.map((x) => <option key={x} value={x}>{B(`rf_rel_${x}`)}</option>)}
                  </select>
                </label>
                {manual && <label className="field t-small">{B("rf_reference")}<input name="rf-reference" className="input" value={reference} onChange={(e) => setReference(e.target.value)} /></label>}
              </div>
            </>
          )}
          <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button variant="primary" icon={isReturn ? "package-check" : "undo-2"} data-testid="rf-pay-submit" disabled={busy || !s.online || !recipientOk || (manual && reference.trim().length < 3)}
              onClick={() => void act("pay", (k) => api.pay(id, { rev: r.rev, ...(recipient ? { recipient } : {}), ...(manual ? { reference: reference.trim() } : {}) }, k))}>
              {busy ? B("waiting_server") : isReturn ? B("rf_record_btn", { amount: M.tk(r.amountPaisa) }) : B("rf_pay_btn", { amount: M.tk(r.amountPaisa) })}
            </Button>
            {failedGw && <Button icon="banknote" data-testid="rf-switch-cash" disabled={busy || !s.online || !recipientOk} onClick={() => void act("cash", (k) => api.pay(id, { rev: r.rev, ...(recipient ? { recipient } : {}), switchToCash: true }, k))}>{B("rf_switch_cash")}</Button>}
          </span>
          {v.allocations.some((a) => a.way === "cash") && <span className="t-small t-muted">{B("rf_no_shift")}</span>}
        </Card>
      )}

      {r.status === "approved" && v.can.withdraw && (
        <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }} data-testid="rf-withdraw-card">
          <span className="t-small t-muted">{B("rf_withdraw_hint")}</span>
          <label className="field t-small">{B("rf_note")}<textarea name="rf-withdraw-note" className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <span><Button variant="danger" icon="x" data-testid="rf-withdraw" disabled={busy || !s.online || note.trim().length < 10} onClick={() => void act("withdraw", (k) => api.decide(id, { decision: "withdraw", note: note.trim() }, k))}>{B("rf_withdraw")}</Button></span>
        </Card>
      )}

      {r.status === "paid" && r.voucher && (
        <Callout tone="info" icon="circle-check" data-testid="rf-done">{isReturn ? B("rf_return_line", { amount: M.tk(r.amountPaisa), number: r.voucher.number }) : B("rf_paid_line", { amount: M.tk(r.amountPaisa), number: r.voucher.number })}</Callout>
      )}
      {r.status === "paid" && <VoucherPanel refundId={id} />}

      <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 4 }} data-testid="rf-timeline">
        <b>{B("rf_timeline")}</b>
        {v.timeline.map((e, n) => (
          <span key={n} className="t-small" data-event={e.event}>{B(`rf_ev_${e.event}`)} · {M.dateTime(e.at)}{e.by ? ` · ${M.name(e.by)}` : ""}{e.note ? ` — ${e.note}` : ""}</span>
        ))}
      </Card>
    </div>
  );
}

/* ───── the voucher: printed and reprinted like a receipt ───── */
function VoucherPanel({ refundId }: { refundId: string }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const toast = useToast();
  const [v, setV] = useState<RefundVoucherView | null>(null);
  const [lang, setLang] = useState<"both" | "bn" | "en">("both");
  const [paper, setPaper] = useState<"a5" | "thermal">("a5");
  const [reason, setReason] = useState<(typeof REPRINT)[number] | "">("");
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  useEffect(() => { api.voucher(refundId).then(setV).catch(() => setV(null)); }, [refundId]);
  if (!v) return null;
  const printed = v.prints.length > 0;
  const print = async () => {
    if (busy || (printed && !reason)) return;
    setBusy(true);
    try { const r = await api.print(refundId, { format: paper, lang, ...(printed ? { reason: reason as (typeof REPRINT)[number] } : {}) }, key); setV(r.view); setShown(r.print.pdfUrl); setReason(""); setKey(crypto.randomUUID()); }
    catch (e) { toast(E(e), "triangle-alert"); if (renew(e)) setKey(crypto.randomUUID()); } finally { setBusy(false); }
  };
  return (
    <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }} data-testid="voucher">
      <span style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <b>{v.voucher.snapshot.kind === "return" ? B("v_credit_title") : B("v_refund_title")}</b>
        <b className="num" data-testid="voucher-number">{v.voucher.number}</b>
        <span className="num t-muted">{M.dateTime(v.voucher.createdAt)}</span>
        {printed && <Pill tone="neu" icon="printer">{s.n(v.prints.length)}</Pill>}
      </span>
      <span className="t-small">{v.voucher.snapshot.kind === "return" ? B("v_credit_words") : B("v_in_words")}: {M.words(v.voucher.amountPaisa)}</span>
      {v.voucher.snapshot.recipient && <span className="t-small">{B("v_received_by")}: {v.voucher.snapshot.recipient.name} · {B(`rf_rel_${v.voucher.snapshot.recipient.relation}`)}</span>}
      <span className="t-small t-muted">{B("rc_verify_url")}: <a href={v.voucher.verifyUrl} target="_blank" rel="noreferrer" data-testid="voucher-verify-url">{v.voucher.verifyUrl}</a></span>
      <span style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        <Segmented label={B("rc_lang")} value={lang} onChange={setLang} options={[{ value: "both", label: B("rc_lang_both") }, { value: "bn", label: B("rc_lang_bn") }, { value: "en", label: B("rc_lang_en") }]} />
        <Segmented label={B("rc_format")} value={paper} onChange={setPaper} options={[{ value: "a5", label: B("v_format_a5") }, { value: "thermal", label: B("rc_format_thermal") }]} />
      </span>
      {printed && (
        <label className="field t-small">{B("rc_reason")}
          <select name="voucher-reprint-reason" className="input" value={reason} onChange={(e) => { setReason(e.target.value as typeof reason); setKey(crypto.randomUUID()); }}>
            <option value="">{B("disc_choose")}</option>
            {REPRINT.map((x) => <option key={x} value={x}>{B(`rr_${x}`)}</option>)}
          </select>
        </label>
      )}
      <span><Button variant={printed ? "default" : "primary"} icon="printer" data-testid={printed ? "voucher-reprint" : "voucher-print"} disabled={busy || !s.online || (printed && !reason)} onClick={() => void print()}>{busy ? B("waiting_server") : printed ? B("rc_print_duplicate") : B("rc_print")}</Button></span>
      {shown && <iframe title={v.voucher.number} src={`/api${shown}`} style={{ width: "100%", height: 600, border: "1px solid var(--border-subtle)" }} />}
      {printed && v.prints.map((p) => (
        <span key={p.id} className="t-small" data-copy={p.copy}>
          {p.copy === 0 ? B("rc_audit_original", { name: M.name(p.printedBy), at: M.dateTime(p.printedAt) }) : B("rc_audit_dup", { n: p.copy, reason: B(`rr_${p.reason}`), name: M.name(p.printedBy), at: M.dateTime(p.printedAt) })}
          {" · "}<a href={`/api${p.pdfUrl}`} target="_blank" rel="noreferrer">{B("rc_pdf")}</a>
        </span>
      ))}
    </Card>
  );
}
