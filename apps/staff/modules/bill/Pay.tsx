"use client";
/* bill/pay — walkthrough A7. Ported from docs/prototype/Setu Billing.dc.html (screen "Payment").
   Cash (tendered and change), card / bank (reference), bKash / Nagad (a link through the payment gateway; pending until
   the gateway confirms — the screen polls). "Paid" and the "Paid by" line show only money the server has confirmed;
   pending wallet amounts are marked pending (issue #10). Offline, cash is "recorded on this device · not synced" and
   a link "will send when online"; a provisional receipt can be printed for queued cash: no receipt number, no QR,
   "PROVISIONAL — not synced" on every page. The real receipt (RCPT number, QR) comes only from the server. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { InvoiceView, NewPaymentRequest } from "@setu/contracts";
import { PAYMENT_METHODS, isWallet, parseTaka, type PaymentMethod } from "@setu/domain";
import { Button, Callout, Card, PageState, Pill, Segmented, useToast } from "@setu/ui";
import { bill as api } from "../../lib/api";
import { onOutbox, outboxItems } from "../../lib/outbox";
import { useSession } from "../../lib/session";
import { INVOICE_TONE, PAY_TONE, useB, useBanner, useErr, useMoney } from "./common";

const FAKE_GATEWAY = process.env.NODE_ENV !== "production";
const KEYS: Partial<Record<string, PaymentMethod>> = { F5: "cash", F6: "card", F7: "bkash", F8: "nagad" };

export function BillPay() {
  const id = useSearchParams().get("inv");
  const B = useB();
  return id ? <PayView id={id} /> : <PageState icon="wallet" title={B("pay_title")} body={B("pay_not_issued")} />;
}

function PayView({ id }: { id: string }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const router = useRouter(); const toast = useToast(); const banner = useBanner();
  const [v, setV] = useState<InvoiceView | null>(null); const [failed, setFailed] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [amount, setAmount] = useState(""); const [tendered, setTendered] = useState(""); const [ref, setRef] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [trx, setTrx] = useState<Record<string, string>>({});
  const [lostTrx, setLostTrx] = useState<Record<string, string>>({});
  const [queued, setQueued] = useState(() => [] as ReturnType<typeof outboxItems>);
  const [rcKey] = useState(() => crypto.randomUUID());

  // A refresh that fails (offline, server away) keeps the last bill on screen; only a first load that fails shows the error.
  const have = useRef(false);
  const load = useCallback(async () => { try { const x = await api.view(id); have.current = true; setV(x); return x; } catch { if (!have.current) setFailed(true); return null; } }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { banner(v); }, [v?.encounter.patient.id, s.lang, s.numerals]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  // Writes for this bill still waiting on this device (offline cash or links): listed, never counted as paid.
  const readQueue = useCallback(() => setQueued(outboxItems().filter((i) => i.path === `/v1/invoices/${encodeURIComponent(id)}/payments` && !i.error)), [id]);
  useEffect(() => { readQueue(); return onOutbox(() => { readQueue(); void load(); }); }, [readQueue, load]);
  const pending = v?.payments.some((p) => ["initiated", "link-sent", "waiting-customer"].includes(p.status));
  useEffect(() => { if (!pending) return; const t = setInterval(() => void load(), 3000); return () => clearInterval(t); }, [pending, load]);
  // The amount box starts at what can still be taken.
  useEffect(() => { if (v && amount === "") setAmount(String(v.summary.openPaisa / 100)); }, [v?.summary.openPaisa]); // eslint-disable-line react-hooks/exhaustive-deps

  const amountPaisa = parseTaka(amount);
  const tenderedPaisa = parseTaka(tendered);
  const change = method === "cash" && amountPaisa !== null && tenderedPaisa !== null ? tenderedPaisa - amountPaisa : null;
  const quick = useMemo(() => {
    if (amountPaisa === null || amountPaisa <= 0) return [];
    const up = (step: number) => Math.ceil(amountPaisa / step) * step;
    return [...new Set([amountPaisa, up(50_000), up(100_000)])];
  }, [amountPaisa]);

  const submit = async () => {
    if (!v || busy || amountPaisa === null || amountPaisa <= 0) return;
    const body: NewPaymentRequest = { method, amountPaisa, ...(method === "cash" ? { tenderedPaisa: tenderedPaisa ?? undefined } : {}), ...(method === "card" || method === "bank" ? { reference: ref.trim() } : {}) };
    setBusy(true);
    try {
      const r = await api.pay(id, body, key);
      setKey(crypto.randomUUID()); setTendered(""); setRef(""); setAmount("");
      if (r.queued) { readQueue(); toast(isWallet(method) ? B("pay_queued_link") : B("pay_queued_cash"), "cloud-off"); return; }
      setV(r.data.view);
    } catch (e) { toast(E(e), "triangle-alert"); await load(); } finally { setBusy(false); }
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const m = KEYS[e.key];
      if (m) { e.preventDefault(); setMethod(m); setKey(crypto.randomUUID()); }
      if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); void submit(); }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  });
  const act = async (f: () => Promise<{ view: InvoiceView } | unknown>) => {
    setBusy(true);
    try { const r = await f(); if (r && typeof r === "object" && "view" in r) setV((r as { view: InvoiceView }).view); else await load(); }
    catch (e) { toast(E(e), "triangle-alert"); await load(); } finally { setBusy(false); }
  };
  const makeReceipt = async () => {
    setBusy(true);
    try { const r = await api.makeReceipt(id, rcKey); router.push(`/m/bill/receipt?rc=${encodeURIComponent(r.receipt.id)}`); }
    catch (e) { toast(E(e), "triangle-alert"); } finally { setBusy(false); }
  };

  if (failed) return <Callout tone="warn" icon="triangle-alert">{B("error_generic")}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{B("loading")}</div>;
  const inv = v.invoice;
  const sum = v.summary;
  const open = inv.status === "issued" || inv.status === "partially-paid";
  const methodLabel = (m: string) => B(`m_${m}`);
  const queuedCash = queued.filter((q) => (q.body as NewPaymentRequest | null)?.method === "cash");
  const canSubmit = open && !busy && amountPaisa !== null && amountPaisa > 0 && amountPaisa <= sum.openPaisa
    && (method !== "cash" || (change !== null && change >= 0)) && ((method !== "card" && method !== "bank") || ref.trim().length > 0)
    && (s.online || method === "cash" || isWallet(method));

  return (
    <div data-screen="bill/pay" data-invoice-status={inv.status} style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{B("pay_title")}</h1>
        <b className="num">{inv.number ?? B("bill_draft")}</b>
        <Pill tone={INVOICE_TONE[inv.status]}>{B(`st_${inv.status}`)}</Pill>
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="arrow-left" onClick={() => router.push(`/m/bill/opd?inv=${encodeURIComponent(id)}`)}>{B("bill_title")}</Button>
      </div>
      {!s.online && <Callout tone="warn" icon="cloud-off">{B("offline_banner")}</Callout>}
      {inv.status === "draft" && <Callout tone="warn" icon="file-warning">{B("pay_not_issued")}</Callout>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }} data-testid="pay-summary">
        {([["pay_due", sum.duePaisa, "due"], ["pay_confirmed", sum.confirmedPaisa, "confirmed"], ["pay_pending", sum.pendingPaisa, "pending"], ["pay_open", sum.openPaisa, "open"]] as const).map(([k, p, t]) => (
          <Card key={k} style={{ padding: 12, display: "flex", flexDirection: "column", gap: 2 }} data-sum={t}><span className="t-small t-muted">{B(k)}</span><b className="num" style={{ fontSize: 20 }}>{M.tk(p)}</b></Card>
        ))}
      </div>

      {v.payments.length > 0 && (
        <Card style={{ padding: 0 }}>
          {v.payments.map((p) => {
            const waiting = ["initiated", "link-sent", "waiting-customer"].includes(p.status);
            return (
              <div key={p.id} data-payment={p.method} data-status={p.status} style={{ display: "flex", flexDirection: "column", gap: 6, padding: 14, borderBottom: "1px solid var(--border-subtle)" }}>
                <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <b>{methodLabel(p.method)}</b><b className="num">{M.tk(p.amountPaisa)}</b>
                  <Pill tone={PAY_TONE[p.status] ?? "neu"}>{B(`pst_${p.status}`)}</Pill>
                  <span className="t-small t-muted">{B("pay_by", { name: M.name(p.createdBy), at: M.time(p.createdAt) })}</span>
                </span>
                {p.method === "cash" && p.changePaisa !== null && <span className="t-small">{B("pay_tendered")}: <span className="num">{M.tk(p.tenderedPaisa ?? 0)}</span> · {B("pay_change")}: <b className="num">{M.tk(p.changePaisa)}</b></span>}
                {p.reference && <span className="t-small">{B("pay_ref", { ref: p.reference })}</span>}
                {p.status === "confirmed" && p.trxId && <span className="t-small" data-testid="trx">{B("pay_confirmed_by", { trx: p.trxId })}</span>}
                {waiting && <span className="t-small" role="status">{B("pay_waiting", { last4: p.phoneLast4 ?? "—", at: M.time(p.linkExpiresAt) })}</span>}
                {p.status === "failed" && (
                  <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="t-small">{B("pay_failed")}</span>
                    <Button size="sm" icon="send" disabled={busy || !s.online} onClick={() => act(() => api.retry(p.id))}>{B("pay_retry")}</Button>
                  </span>
                )}
                {waiting && (
                  <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <label className="field t-small">{B("pay_trx")}{" "}
                      <input className="input num" name={`trx-${p.id}`} style={{ width: 200 }} value={trx[p.id] ?? ""} onChange={(e) => setTrx((x) => ({ ...x, [p.id]: e.target.value.toUpperCase() }))} />
                    </label>
                    <Button size="sm" disabled={busy || !s.online || !(trx[p.id] ?? "").trim()} onClick={() => act(() => api.verifyTrx(p.id, (trx[p.id] ?? "").trim()))}>{B("pay_trx_verify")}</Button>
                  </span>
                )}
                {waiting && FAKE_GATEWAY && (
                  <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: 8, border: "1px dashed var(--border-subtle)", borderRadius: 8 }} data-testid="fake-gateway">
                    <span className="t-small t-muted">{B("fake_title")}</span>
                    <Button size="sm" onClick={() => act(() => api.fake(p.id, "confirmed"))}>{B("fake_pay")}</Button>
                    <Button size="sm" onClick={() => act(() => api.fake(p.id, "failed"))}>{B("fake_fail")}</Button>
                    <Button size="sm" onClick={() => act(async () => { const r = await api.fake(p.id, "confirmed", false); setLostTrx((x) => ({ ...x, [p.id]: r.trxId ?? "" })); return r; })}>{B("fake_lost")}</Button>
                    {lostTrx[p.id] && <span className="t-small" data-testid="lost-trx">{B("fake_lost_trx", { trx: lostTrx[p.id]! })}</span>}
                  </span>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {queued.length > 0 && (
        <Callout tone="warn" icon="cloud-off" data-testid="pay-queued">
          {queued.map((q) => { const b = q.body as NewPaymentRequest | null; return <div key={q.id}>{b ? `${methodLabel(b.method)} ${M.tk(b.amountPaisa)} — ${isWallet(b.method) ? B("pay_queued_link") : B("pay_queued_cash")}` : q.label}</div>; })}
        </Callout>
      )}

      {open && (
        <Card style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }} data-testid="pay-form">
          <b>{B("pay_add")}</b>
          <Segmented label={B("pay_add")} value={method} onChange={(m) => { setMethod(m); setKey(crypto.randomUUID()); }}
            options={PAYMENT_METHODS.map((m) => ({ value: m, label: methodLabel(m) }))} />
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="field t-small">{B("pay_amount")}
              <input name="pay-amount" className="input num" inputMode="decimal" style={{ width: 160 }} value={amount} onChange={(e) => { setAmount(e.target.value); setKey(crypto.randomUUID()); }} />
            </label>
            {method === "cash" && (
              <>
                <label className="field t-small">{B("pay_tendered")}
                  <input name="pay-tendered" className="input num" inputMode="decimal" style={{ width: 160 }} value={tendered} onChange={(e) => { setTendered(e.target.value); setKey(crypto.randomUUID()); }} />
                </label>
                {quick.map((p) => <Button key={p} size="sm" onClick={() => { setTendered(String(p / 100)); setKey(crypto.randomUUID()); }}>{M.tk(p)}</Button>)}
                <span data-testid="pay-change">{change === null ? `${B("pay_change")}: —` : change >= 0 ? <>{B("pay_change")}: <b className="num">{M.tk(change)}</b></> : <span style={{ color: "var(--status-bad-fg)" }}>{B("pay_short", { amount: M.tk(-change) })}</span>}</span>
              </>
            )}
            {(method === "card" || method === "bank") && (
              <label className="field t-small">{method === "card" ? B("pay_reference_card") : B("pay_reference_bank")}
                <input name="pay-reference" className="input" style={{ width: 200 }} value={ref} onChange={(e) => { setRef(e.target.value); setKey(crypto.randomUUID()); }} />
              </label>
            )}
            {isWallet(method) && <span className="t-small t-muted">{B("pay_link_to")}</span>}
          </div>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button variant="primary" icon={isWallet(method) ? "send" : "banknote"} kbd="Ctrl ↵" data-testid="pay-submit" disabled={!canSubmit} onClick={() => void submit()}>
              {busy ? B("waiting_server") : isWallet(method) ? B("pay_send_link") : method === "cash" ? B("pay_take_cash") : method === "card" ? B("pay_take_card") : B("pay_take_bank")}
            </Button>
            <span className="t-small t-muted">{B("pay_wallet_rule")}</span>
          </span>
        </Card>
      )}

      <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }} data-testid="paid-by">
        <span><b>{B("paid_by")}:</b>{" "}
          <span data-testid="paid-line">{v.paidBy.paid.length ? v.paidBy.paid.map((p) => `${methodLabel(p.method)} ${M.tk(p.amountPaisa)}${p.trxId ? ` (TrxID ${p.trxId})` : p.reference ? ` (${p.reference})` : ""}`).join(" + ") : "—"}</span>
          {v.paidBy.pending.length > 0 && <span data-testid="pending-line"> · {v.paidBy.pending.map((p) => `${methodLabel(p.method)} ${M.tk(p.amountPaisa)} ${B("pending_word")}`).join(" · ")}</span>}
        </span>
        {sum.pendingPaisa > 0 && <span className="t-small t-muted">{B("pay_partial_rule")}</span>}
        <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button variant="primary" icon="receipt" data-testid="make-receipt" disabled={busy || !s.online || sum.confirmedPaisa <= 0} onClick={() => void makeReceipt()}>
            {sum.confirmedPaisa <= 0 ? B("pay_nothing") : sum.duePaisa === 0 ? B("pay_receipt_full") : B("pay_receipt_partial", { amount: M.tk(sum.confirmedPaisa) })}
          </Button>
        </span>
      </Card>

      {queuedCash.length > 0 && <ProvisionalReceipt v={v} cash={queuedCash.map((q) => (q.body as NewPaymentRequest).amountPaisa)} />}
    </div>
  );
}

/** Offline cash only: printed from this device, with no receipt number and no QR, "PROVISIONAL — not synced" repeated on
    every printed page (a fixed element repeats on each page). Amounts are the server's last bill and the queued cash. */
function ProvisionalReceipt({ v, cash }: { v: InvoiceView; cash: number[] }) {
  const s = useSession(); const B = useB(); const M = useMoney();
  return (
    <Card className="provisional-print" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6, border: "2px dashed var(--status-warn-fg, #a60)" }} data-testid="provisional-receipt">
      <style>{`@media print { body * { visibility: hidden !important; } .provisional-print, .provisional-print * { visibility: visible !important; }
        .provisional-print { position: absolute; left: 0; top: 0; width: 100%; border: 0 !important; } .prov-banner { position: fixed; top: 0; left: 0; right: 0; text-align: center; font-weight: 700; }
        .prov-actions { display: none !important; } }`}</style>
      <div className="prov-banner" data-testid="provisional-banner">{B("rc_provisional_banner")}</div>
      <b style={{ marginTop: 18 }}>{s.lang === "bn" ? v.seller.nameBn ?? v.seller.nameEn : v.seller.nameEn}</b>
      <span className="t-small">{B("r_bill_no")}: <span className="num">{v.invoice.number}</span> · {M.name(v.encounter.patient)} · <span className="num">{v.encounter.patient.facilityNo}</span></span>
      {v.lines.map((l) => <span key={l.id} style={{ display: "flex", justifyContent: "space-between" }}><span>{s.lang === "bn" ? l.nameBn : l.nameEn}</span><span className="num">{M.tk(l.totalPaisa)}</span></span>)}
      <span style={{ display: "flex", justifyContent: "space-between" }}><b>{B("total")}</b><b className="num">{M.tk(v.invoice.totalPaisa)}</b></span>
      {cash.map((c, n) => <span key={n}>{B("m_cash")} {M.tk(c)} — {B("pay_queued_cash")}</span>)}
      <span className="t-small t-muted">{B("rc_provisional_hint")}</span>
      <span className="prov-actions"><Button size="sm" icon="printer" onClick={() => window.print()}>{B("rc_print")}</Button></span>
    </Card>
  );
}
