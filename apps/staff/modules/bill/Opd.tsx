"use client";
/* bill/opd — walkthrough A6. Ported from docs/prototype/Setu Billing.dc.html (screen "OPD bill").
   Without ?inv: today's finished visits. With ?enc: opens (or makes) the visit's bill. With ?inv: the bill — lines
   from the consultation and the doctor's orders, desk items, the discount (within the cashier's limit it applies; above
   it an approval request, and nothing changes until the owner or an admin decides), totals, and Issue. Every number
   comes from the server in paisa; the discount preview uses the same @setu/domain rule the server applies. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { BillingWorklist, ChargeDefinitionList, InvoiceView } from "@setu/contracts";
import { DISCOUNT_CATEGORIES, discountToPaisa, parsePercentBp, parseTaka } from "@setu/domain";
import { Button, Callout, Card, PageState, Pill, Segmented, useToast } from "@setu/ui";
import { bill as api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useLabels } from "../fd/common";
import { INVOICE_TONE, WRITERS, useB, useBanner, useErr, useMoney } from "./common";

export function BillOpd() {
  const sp = useSearchParams();
  const inv = sp.get("inv"), enc = sp.get("enc");
  if (inv) return <BillView id={inv} />;
  if (enc) return <OpenBill encounterId={enc} />;
  return <Worklist />;
}

function Worklist() {
  const s = useSession(); const B = useB(); const M = useMoney(); const L = useLabels(); const router = useRouter();
  const [w, setW] = useState<BillingWorklist | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => { s.setPatient(null); api.worklist().then(setW).catch(() => setFailed(true)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <Callout tone="warn" icon="triangle-alert">{B("error_generic")}</Callout>;
  if (!w) return <div aria-busy="true" className="t-muted">{B("loading")}</div>;
  const writer = WRITERS.includes(s.me?.role ?? "");
  return (
    <div data-screen="bill/opd" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{B("wl_title")}</h1>
      <span className="t-muted">{B("wl_hint")}</span>
      {w.items.length === 0 ? <PageState icon="receipt" title={B("wl_empty")} /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {w.items.map((i) => {
            const go = i.invoice ? `/m/bill/opd?inv=${encodeURIComponent(i.invoice.id)}` : writer ? `/m/bill/opd?enc=${encodeURIComponent(i.encounter.id)}` : null;
            return (
              <button key={i.encounter.id} type="button" className="card" data-bill-token={i.encounter.token} disabled={!go} onClick={() => go && router.push(go)}
                style={{ display: "flex", flexDirection: "column", gap: 4, padding: 14, textAlign: "left", cursor: go ? "pointer" : "default" }}>
                <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <b className="num" style={{ fontSize: 18 }}>{i.encounter.token}</b>
                  {i.invoice ? <Pill tone={INVOICE_TONE[i.invoice.status]}>{B(`st_${i.invoice.status}`)}</Pill> : <Pill tone="neu" icon="clock">{B("wl_no_bill")}</Pill>}
                  {i.invoice?.approvalPending && <Pill tone="warn" icon="hourglass">{B("wl_approval")}</Pill>}
                </span>
                <b>{M.name(i.encounter.patient)}</b>
                <span className="t-small t-muted num">{i.encounter.patient.facilityNo} · {L.age(i.encounter.patient)} {L.sex(i.encounter.patient.sex)}</span>
                <span className="t-small t-muted">{M.name(i.encounter.practitioner)}</span>
                {i.invoice && <span className="num">{i.invoice.number ?? B("bill_draft")} · {M.tk(i.invoice.totalPaisa)}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function OpenBill({ encounterId }: { encounterId: string }) {
  const s = useSession(); const B = useB(); const E = useErr(); const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!s.online) { setError(B("online_needed")); return; }
    api.open(encounterId).then((v) => router.replace(`/m/bill/opd?inv=${encodeURIComponent(v.invoice.id)}`)).catch((e) => setError(E(e)));
  }, [encounterId]); // eslint-disable-line react-hooks/exhaustive-deps
  return error
    ? <div style={{ display: "flex", flexDirection: "column", gap: 12 }}><Callout tone="warn" icon="triangle-alert">{error}</Callout><Button icon="arrow-left" onClick={() => router.push("/m/bill/opd")}>{B("back_to_list")}</Button></div>
    : <div aria-busy="true" className="t-muted">{B("loading")}</div>;
}

type Disc = { mode: "amount" | "percent"; value: string; category: string; reason: string };
const NO_DISC: Disc = { mode: "amount", value: "", category: "", reason: "" };

function BillView({ id }: { id: string }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const router = useRouter(); const toast = useToast(); const banner = useBanner();
  const [v, setV] = useState<InvoiceView | null>(null); const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState(""); const [found, setFound] = useState<ChargeDefinitionList["items"]>([]);
  const [d, setD] = useState<Disc>(NO_DISC); const [dKey, setDKey] = useState(() => crypto.randomUUID());
  const [issueKey] = useState(() => crypto.randomUUID());
  // ADR 0005: "Not billed here" request on one line, and the void panel
  const [nb, setNb] = useState<{ lineId: string; reason: string; key: string } | null>(null);
  const [voiding, setVoiding] = useState<{ reason: string; key: string } | null>(null);
  const refreshing = useRef(false);
  const search = useRef<HTMLInputElement>(null);

  // A refresh that fails (offline, server away) keeps the last bill on screen; only a first load that fails shows the error.
  const have = useRef(false);
  const [stale, setStale] = useState(false); const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setV(await api.view(id)); have.current = true; setStale(false); setUpdatedAt(new Date().toISOString()); }
    catch { if (!have.current) setFailed(true); else setStale(true); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { banner(v); }, [v?.encounter.patient.id, s.lang, s.numerals]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  // While a discount waits for the owner or an admin, the bill refreshes itself so the decision shows here.
  const waiting = v?.approval?.status === "requested";
  useEffect(() => { if (!waiting) return; const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, [waiting, load]);
  const lineWaiting = Boolean(v?.lineApprovals.some((x) => x.status === "requested"));
  useEffect(() => { if (!lineWaiting) return; const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, [lineWaiting, load]);
  /* Decision 99 prep: the doctor's orders changed since the draft was made — bring the bill in line when nothing on it
     depends on the old lines; otherwise the banner asks to remove the discount first and Issue waits. */
  useEffect(() => {
    if (!v?.ordersChanged || refreshing.current || v.invoice.status !== "draft" || !WRITERS.includes(s.me?.role ?? "") || !s.online) return;
    if (v.invoice.discountPaisa > 0 || v.approval?.status === "requested" || v.lineApprovals.some((x) => x.status === "requested")) return;
    refreshing.current = true;
    api.refreshOrders(id, v.invoice.rev).then((x) => { setV(x); toast(B("orders_refreshed"), "refresh-cw"); }).catch(() => undefined).finally(() => { refreshing.current = false; });
  }, [v?.ordersChanged, v?.invoice.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = q.trim() ? setTimeout(() => { api.definitions(q).then((r) => setFound(r.items)).catch(() => setFound([])); }, 200) : undefined;
    if (!q.trim()) setFound([]);
    return () => clearTimeout(t);
  }, [q]);

  const writer = WRITERS.includes(s.me?.role ?? "");
  const draft = v?.invoice.status === "draft";
  const editable = Boolean(v && writer && draft && s.online && !waiting && v.invoice.discountPaisa === 0);
  const payable = v && (v.invoice.status === "issued" || v.invoice.status === "partially-paid");
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "F3") { e.preventDefault(); search.current?.focus(); }
      if (e.key === "F9" && payable) { e.preventDefault(); router.push(`/m/bill/pay?inv=${encodeURIComponent(id)}`); }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [payable, id, router]);

  const run = async (f: () => Promise<InvoiceView | void>) => {
    if (busy) return;
    setBusy(true);
    try { const r = await f(); if (r) setV(r); } catch (e) { toast(E(e), "triangle-alert"); await load(); } finally { setBusy(false); }
  };

  const discPaisa = useMemo(() => {
    if (!v) return null;
    if (d.mode === "amount") return parseTaka(d.value);
    const bp = parsePercentBp(d.value);
    return bp === null ? null : discountToPaisa({ mode: "percent", bp }, v.invoice.subtotalPaisa);
  }, [d.mode, d.value, v]);

  if (failed) return <Callout tone="warn" icon="triangle-alert">{B("error_generic")}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{B("loading")}</div>;
  const inv = v.invoice;
  const reasonOk = d.reason.trim().length >= 10 && Boolean(d.category);
  const overBill = discPaisa !== null && discPaisa > inv.subtotalPaisa;
  const within = discPaisa !== null && discPaisa > 0 && discPaisa <= v.discountLimitPaisa;
  const discMsg = discPaisa === null || discPaisa <= 0 ? null : overBill ? { tone: "bad" as const, text: B("disc_over_bill") }
    : !reasonOk ? { tone: "warn" as const, text: B("disc_need_reason") }
    : within ? { tone: "info" as const, text: B("disc_within") } : { tone: "warn" as const, text: B("disc_above", { amount: M.tk(discPaisa), limit: M.tk(v.discountLimitPaisa) }) };
  const submitDiscount = () => run(async () => {
    if (discPaisa === null || overBill || !reasonOk) return;
    const body = d.mode === "amount"
      ? { mode: "amount" as const, amountPaisa: discPaisa, category: d.category as (typeof DISCOUNT_CATEGORIES)[number], reason: d.reason.trim(), rev: inv.rev }
      : { mode: "percent" as const, percentBp: parsePercentBp(d.value)!, category: d.category as (typeof DISCOUNT_CATEGORIES)[number], reason: d.reason.trim(), rev: inv.rev };
    const r = await api.discount(id, body, dKey);
    setD(NO_DISC); setDKey(crypto.randomUUID());
    return r.view;
  });
  const a = v.approval;
  const approver = ["owner", "admin"].includes(s.me?.role ?? "");
  const voided = inv.status === "entered-in-error";
  const lineReq = (lineId: string) => v.lineApprovals.find((x) => x.lineId === lineId);

  return (
    <div data-screen="bill/opd" data-invoice-status={inv.status} style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{B("bill_title")}</h1>
        {inv.number && <b className="num" data-testid="invoice-number">{inv.number}</b>}
        <Pill tone={INVOICE_TONE[inv.status]}>{B(`st_${inv.status}`)}</Pill>
        <span className="t-small t-muted">{B("visit_line", { doctor: M.name(v.encounter.practitioner), token: v.encounter.token })}</span>
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="arrow-left" onClick={() => router.push("/m/bill/opd")}>{B("back_to_list")}</Button>
      </div>
      {!s.online && <Callout tone="warn" icon="cloud-off">{B("offline_banner")}</Callout>}
      {!writer && <Callout icon="eye">{B("view_only")}</Callout>}
      {voided && inv.void && (
        <Callout tone="bad" icon="ban" data-testid="void-banner">
          <b>{B("void_banner", { reason: inv.void.reason, by: M.name(inv.void.by), at: M.dateTime(inv.void.at) })}</b>
          {inv.replacedBy ? <> · <a href={`/m/bill/opd?inv=${encodeURIComponent(inv.replacedBy.id)}`} data-testid="replaced-by">{B("replaced_by", { number: inv.replacedBy.number ?? B("draft_word") })}</a></> : null}
          {!inv.replacedBy && writer && <> · <Button size="sm" icon="file-plus" data-testid="new-bill" onClick={() => router.push(`/m/bill/opd?enc=${encodeURIComponent(v.encounter.id)}`)}>{B("new_bill")}</Button></>}
        </Callout>
      )}
      {inv.replaces && <Callout icon="history" data-testid="replaces">{B("replaces", { number: inv.replaces.number ?? B("draft_word") })}</Callout>}
      {v.ordersChanged && draft && (inv.discountPaisa > 0 || waiting) && <Callout tone="warn" icon="refresh-cw" data-testid="orders-changed">{B("orders_changed")}</Callout>}
      {stale && s.online && <Callout tone="warn" icon="refresh-cw" data-testid="bill-stale">{B("bill_stale", { at: M.time(updatedAt) })}</Callout>}
      <span className="t-small t-muted">{B("sample_prices")}</span>

      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table className="table" data-testid="bill-lines">
          <thead><tr>
            <th>{B("col_no")}</th><th>{B("col_service")}</th><th>{B("col_qty")}</th><th style={{ textAlign: "right" }}>{B("col_price")}</th>
            <th>{B("col_vat")}</th>{inv.discountPaisa > 0 && <th style={{ textAlign: "right" }}>{B("col_discount")}</th>}<th style={{ textAlign: "right" }}>{B("col_amount")}</th><th />
          </tr></thead>
          <tbody>
            {v.lines.map((l, n) => (
              <tr key={l.id} data-line={l.code} data-source={l.source}>
                <td className="num">{s.n(n + 1)}</td>
                <td>
                  <div>{s.lang === "bn" ? l.nameBn : l.nameEn}</div><span className="t-small t-muted">{B(`src_${l.source}`)}</span>
                  {l.notBilled && <div className="t-small" data-testid="not-billed"><Pill tone="neu" icon="arrow-right-left">{B("nb_line", { reason: l.notBilled.reason })}</Pill></div>}
                  {!l.notBilled && lineReq(l.id)?.status === "requested" && <div className="t-small" data-testid="nb-pending"><Pill tone="warn" icon="hourglass">{B("nb_pending", { by: M.name(lineReq(l.id)!.requestedBy), at: M.time(lineReq(l.id)!.requestedAt) })}</Pill></div>}
                  {!l.notBilled && lineReq(l.id)?.status === "rejected" && <div className="t-small">{B("nb_rejected", { by: M.name(lineReq(l.id)!.decidedBy), note: lineReq(l.id)!.decisionNote ?? "" })}</div>}
                  {draft && writer && s.online && l.source === "order" && l.unitPaisa === null && !l.notBilled && lineReq(l.id)?.status !== "requested" && !waiting && (
                    nb?.lineId === l.id ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6, maxWidth: 420 }} data-testid="nb-panel">
                        <span className="t-small t-muted">{B("nb_hint")}</span>
                        <label className="field t-small">{B("nb_reason")}
                          <input className="input" name="nb-reason" value={nb.reason} placeholder={B("nb_reason_ph")} onChange={(e) => setNb({ ...nb, reason: e.target.value, key: crypto.randomUUID() })} />
                        </label>
                        <span style={{ display: "flex", gap: 6 }}>
                          <Button size="sm" variant="primary" icon="send" data-testid="nb-send" disabled={busy || nb.reason.trim().length < 10} onClick={() => run(async () => { const x = await api.notBilled(id, l.id, nb.reason.trim(), inv.rev, nb.key); setNb(null); return x; })}>{B("nb_send")}</Button>
                          <Button size="sm" onClick={() => setNb(null)}>{B("rc_cancel")}</Button>
                        </span>
                      </div>
                    ) : <Button size="sm" variant="ghost" icon="arrow-right-left" data-testid="nb-open" onClick={() => setNb({ lineId: l.id, reason: "", key: crypto.randomUUID() })}>{B("nb_request")}</Button>
                  )}
                </td>
                <td className="num">
                  {l.editable && editable ? (
                    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                      <Button size="sm" aria-label={B("qty_less")} disabled={busy || l.qty <= 1} onClick={() => run(() => api.setQty(id, l.id, l.qty - 1, inv.rev))}>−</Button>
                      <span>{s.n(l.qty)}</span>
                      <Button size="sm" aria-label={B("qty_more")} disabled={busy} onClick={() => run(() => api.setQty(id, l.id, l.qty + 1, inv.rev))}>+</Button>
                    </span>
                  ) : s.n(l.qty)}
                </td>
                <td className="num" style={{ textAlign: "right" }}>{l.notBilled ? "—" : l.unitPaisa === null ? <Pill tone="bad" icon="circle-alert">{B("no_price")}</Pill> : M.tk(l.unitPaisa)}</td>
                <td>{l.vatRateBp === 0 ? B("vat_exempt") : `${s.n(l.vatRateBp / 100)}%`}</td>
                {inv.discountPaisa > 0 && <td className="num" style={{ textAlign: "right" }}>{l.discountPaisa ? `− ${M.tk(l.discountPaisa)}` : "—"}</td>}
                <td className="num" style={{ textAlign: "right" }}><b>{l.notBilled ? "—" : M.tk(l.totalPaisa)}</b></td>
                <td>{l.editable && editable && <Button size="sm" variant="ghost" icon="trash-2" disabled={busy} onClick={() => run(() => api.removeLine(id, l.id, inv.rev))}>{B("remove")}</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {draft && writer && (
        <div style={{ position: "relative", maxWidth: 520, display: "flex", flexDirection: "column", gap: 4 }}>
          <label className="t-small" htmlFor="add-service">{B("add_service")}</label>
          <input id="add-service" ref={search} className="input" value={q} placeholder={B("add_placeholder")} disabled={!editable} onChange={(e) => setQ(e.target.value)} />
          {!editable && v.invoice.discountPaisa > 0 && <span className="t-small t-muted">{B("disc_locked")}</span>}
          {q.trim() && editable && (
            <div className="card" role="listbox" style={{ position: "absolute", zIndex: 5, left: 0, right: 0, padding: 4 }}>
              {found.length === 0 ? <div className="t-muted" style={{ padding: 8 }}>{B("add_none")}</div> : found.slice(0, 6).map((f) => (
                <button key={f.code} type="button" role="option" aria-selected="false" data-add={f.code} className="btn btn-ghost" style={{ display: "flex", width: "100%", justifyContent: "space-between" }}
                  onClick={() => { setQ(""); void run(() => api.addLine(id, f.code, inv.rev)); }}>
                  <span>{s.lang === "bn" ? f.nameBn : f.nameEn}</span><span className="num">{M.tk(f.unitPaisa)}{f.vatRateBp ? ` + ${s.n(f.vatRateBp / 100)}%` : ""}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, alignItems: "start" }}>
        <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16 }} data-testid="discount-panel">
          <b>{B("disc_title")}</b>
          {inv.discount ? (
            <>
              <span data-testid="discount-applied">{B("disc_applied", { amount: M.tk(inv.discountPaisa), category: B(`cat_${inv.discount.category}`), reason: inv.discount.reason })}</span>
              {a?.status === "approved" && <Callout icon="badge-check">{B("disc_approved", { by: M.name(a.decidedBy), at: M.time(a.decidedAt) })}</Callout>}
              {draft && writer && <Button size="sm" icon="x" disabled={busy || !s.online} onClick={() => run(() => api.removeDiscount(id, inv.rev))}>{B("disc_remove")}</Button>}
            </>
          ) : a?.status === "requested" ? (
            <Callout tone="warn" icon="hourglass" data-testid="discount-pending">
              <b>{B("disc_pending_pill")}</b> · {M.tk(a.amountPaisa)} · {B(`cat_${a.category}`)}<br />
              {B("disc_pending", { by: M.name(a.requestedBy), at: M.time(a.requestedAt), amount: M.tk(a.amountPaisa) })}
            </Callout>
          ) : draft && writer ? (
            <>
              {a?.status === "rejected" && <Callout tone="bad" icon="circle-x" data-testid="discount-rejected">{B("disc_rejected", { by: M.name(a.decidedBy), note: a.decisionNote ?? "" })}</Callout>}
              <Segmented label={B("disc_title")} value={d.mode} onChange={(mode) => { setD((x) => ({ ...x, mode, value: "" })); setDKey(crypto.randomUUID()); }}
                options={[{ value: "amount", label: B("disc_amount") }, { value: "percent", label: B("disc_percent") }]} />
              <label className="field t-small">{d.mode === "amount" ? B("disc_value_amount") : B("disc_value_percent")}
                <input name="discount-value" className="input num" inputMode="decimal" value={d.value} disabled={!s.online} onChange={(e) => { setD((x) => ({ ...x, value: e.target.value })); setDKey(crypto.randomUUID()); }} />
              </label>
              <label className="field t-small">{B("disc_category")}
                <select name="discount-category" className="input" value={d.category} disabled={!s.online} onChange={(e) => { setD((x) => ({ ...x, category: e.target.value })); setDKey(crypto.randomUUID()); }}>
                  <option value="">{B("disc_choose")}</option>
                  {DISCOUNT_CATEGORIES.map((c) => <option key={c} value={c}>{B(`cat_${c}`)}</option>)}
                </select>
              </label>
              <label className="field t-small">{B("disc_reason")}
                <input name="discount-reason" className="input" value={d.reason} placeholder={B("disc_reason_ph")} disabled={!s.online} onChange={(e) => { setD((x) => ({ ...x, reason: e.target.value })); setDKey(crypto.randomUUID()); }} />
              </label>
              <span className="t-small t-muted" data-testid="discount-limit">{B("disc_limit", { limit: M.tk(v.discountLimitPaisa) })}</span>
              {discMsg && <Callout tone={discMsg.tone} icon={discMsg.tone === "info" ? "check" : "triangle-alert"} data-testid="discount-message">{discMsg.text}</Callout>}
              <Button variant={within ? "primary" : "default"} icon={within ? "check" : "send"} data-testid="discount-submit"
                disabled={busy || !s.online || discPaisa === null || discPaisa <= 0 || overBill || !reasonOk} onClick={() => void submitDiscount()}>
                {within || discPaisa === null ? B("disc_apply") : B("disc_request")}
              </Button>
            </>
          ) : <span className="t-muted" data-testid="discount-none">{B("disc_none")}</span>}
        </Card>

        <Card style={{ display: "flex", flexDirection: "column", gap: 6, padding: 16 }} data-testid="bill-totals">
          {[
            ["subtotal", inv.subtotalPaisa],
            ["discount", inv.discountPaisa],
            ["vat", inv.vatPaisa],
          ].map(([k, p]) => (
            <span key={k as string} style={{ display: "flex", justifyContent: "space-between" }} data-total={k}>
              <span>{B(k as string)}{k === "discount" && waiting && a ? <span className="t-muted"> ({M.tk(a.amountPaisa)} — {B("disc_pending_pill")})</span> : null}</span>
              <span className="num">{k === "discount" && (p as number) > 0 ? `− ${M.tk(p as number)}` : M.tk(p as number)}</span>
            </span>
          ))}
          <span style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border-subtle)", paddingTop: 6, fontSize: 18 }} data-total="total">
            <b>{B("total")}</b><b className="num" data-testid="bill-total">{M.tk(inv.totalPaisa)}</b>
          </span>
          <span style={{ display: "flex", justifyContent: "space-between" }} data-total="paid"><span>{B("paid")}</span><span className="num">{M.tk(inv.paidPaisa)}</span></span>
          <span style={{ display: "flex", justifyContent: "space-between" }} data-total="due"><span>{B("due")}</span><b className="num">{M.tk(inv.totalPaisa - inv.paidPaisa)}</b></span>
          <span className="t-small t-muted">{B("in_words")}: {M.words(inv.totalPaisa)}</span>
          {draft && writer && (
            <>
              {v.issueBlockers.map((b) => <Callout key={b} tone="warn" icon="circle-alert">{B(`blocker_${b}`)}</Callout>)}
              <span className="t-small t-muted">{B("issue_hint")}</span>
              <Button variant="primary" icon="file-check" data-testid="issue" disabled={busy || !s.online || v.issueBlockers.length > 0} onClick={() => run(() => api.issue(id, inv.rev, issueKey))}>
                {busy ? B("waiting_server") : B("issue")}
              </Button>
            </>
          )}
          {payable && WRITERS.includes(s.me?.role ?? "") && s.me?.role !== "receptionist" && (
            <Button variant="primary" icon="wallet" kbd="F9" data-testid="take-payment" onClick={() => router.push(`/m/bill/pay?inv=${encodeURIComponent(id)}`)}>{B("take_payment")}</Button>
          )}
          {approver && (inv.status === "draft" || inv.status === "issued") && inv.paidPaisa === 0 && (
            voiding ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid var(--border-subtle)", paddingTop: 8 }} data-testid="void-panel">
                <b>{B("void_title")}</b>
                <span className="t-small t-muted">{B("void_hint")}</span>
                <label className="field t-small">{B("void_reason")}
                  <input className="input" name="void-reason" value={voiding.reason} onChange={(e) => setVoiding({ reason: e.target.value, key: crypto.randomUUID() })} />
                </label>
                <span style={{ display: "flex", gap: 6 }}>
                  <Button variant="danger" icon="ban" data-testid="void-confirm" disabled={busy || !s.online || voiding.reason.trim().length < 10} onClick={() => run(async () => { const x = await api.void(id, voiding.reason.trim(), voiding.key); setVoiding(null); return x; })}>{B("void_confirm")}</Button>
                  <Button onClick={() => setVoiding(null)}>{B("rc_cancel")}</Button>
                </span>
              </div>
            ) : <Button variant="ghost" icon="ban" data-testid="void-open" disabled={!s.online} onClick={() => setVoiding({ reason: "", key: crypto.randomUUID() })}>{B("void_open")}</Button>
          )}
          {inv.paidPaisa > 0 && WRITERS.includes(s.me?.role ?? "") && <Button icon="printer" onClick={() => router.push(`/m/bill/receipt?inv=${encodeURIComponent(id)}`)}>{B("receipts")}</Button>}
        </Card>
      </div>
    </div>
  );
}
