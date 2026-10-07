"use client";
/* bill/ipd — walkthrough B8 (ADR 0017). Ported from docs/prototype/Setu Billing.dc.html (screen "IPD running bill"):
   the running bill by date, each line tagged Package / Included / Excluded, bed days posted "Auto 00:01", re-priced lines
   struck through with why, credit lines; the totals panel (package, excluded, patient share, deposits, balance with the
   Low tag); the low-deposit / due alert offering a bKash link to the guardian; deposits with their money receipts; the
   class-change price preview (classes change through a bed move on the ward); the package; a charge from the price
   list; the interim bill (A4, not a final bill); the discharge clearance (the cashier's steps 4–5). Money is integer
   paisa from the server, printed through @setu/domain format. B10 (ADR 0018): the final bill — issued once the discharge
   is recorded, the deposits applied, the excess back by its refund, the shortfall at the counter, the receipt. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ChargeDefinitionList, ClassPreviewView, DepositReceiptView, DischargeView, IpdBillList, IpdBillView, IpdLine, InterimPrintList, PackageList } from "@setu/contracts";
import { parseTaka } from "@setu/domain";
import { Button, Callout, Card, Dialog, PageState, Pill, Segmented, SelectField, TextArea, TextField, useToast, type Tone } from "@setu/ui";
import { ApiFailure, bill, discharge, ipdBill } from "../../lib/api";
import { useSession } from "../../lib/session";
import { toBanner, useLabels } from "../fd/common";
import { DischargeHeader, DischargeSteps } from "../ipd/Discharge";
import { WRITERS, useB, useErr, useMoney } from "./common";

const TAG_TONE: Record<IpdLine["tag"], Tone> = { package: "info", included: "ok", excluded: "warn" };
const TAG_ICON: Record<IpdLine["tag"], string> = { package: "package", included: "circle-check", excluded: "circle-minus" };
const STATE_TONE: Record<string, Tone> = { ok: "ok", low: "warn", due: "bad" };
const REPRINT = ["lost", "jam", "corp", "ins"] as const;
const renew = (e: unknown) => e instanceof ApiFailure && e.status < 500;
const FINAL_TONE: Record<string, Tone> = { issued: "bad", "partially-paid": "warn", balanced: "ok" };

export function BillIpd() {
  const adm = useSearchParams().get("adm");
  return adm ? <IpdBill key={adm} admissionId={adm} /> : <IpdBillListScreen />;
}

function IpdBillListScreen() {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const router = useRouter();
  const [list, setList] = useState<IpdBillList | null>(null); const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => { ipdBill.list().then(setList).catch((e) => setFailed(E(e))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <Callout tone="warn" icon="triangle-alert">{failed}</Callout>;
  if (!list) return <div aria-busy="true" className="t-muted">{B("loading")}</div>;
  const bn = s.lang === "bn";
  return (
    <div data-screen="bill/ipd" data-status="list" style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{B("ib_list_title")}</h1>
      <span className="t-small t-muted">{B("ib_list_hint")}</span>
      {list.items.length === 0 ? <PageState icon="receipt-text" title={B("ib_list_title")} body={B("ib_list_none")} /> : (
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table className="table" style={{ width: "100%", minWidth: 760 }} data-testid="ipd-bill-list">
            <thead><tr><th>{B("ib_col_patient")}</th><th>{B("ib_col_bed")}</th><th>{B("ib_col_day")}</th><th>{B("ib_package")}</th><th className="r">{B("ib_col_total")}</th><th className="r">{B("ib_col_deposits")}</th><th className="r">{B("ib_col_balance")}</th><th>{B("ib_col_bill")}</th><th /></tr></thead>
            <tbody>
              {list.items.map((x) => (
                <tr key={x.admissionId} data-adm={x.number} style={{ cursor: "pointer" }} onClick={() => router.push(`/m/bill/ipd?adm=${encodeURIComponent(x.admissionId)}`)}>
                  <td><b>{bn ? x.patient.nameBn : x.patient.nameEn || x.patient.nameBn}</b><div className="t-small t-muted num">{x.number} · {x.patient.facilityNo}</div></td>
                  <td className="num">{[x.ward, x.bed].filter(Boolean).join(" · ")}<div className="t-small t-muted">{x.bedClass}</div></td>
                  <td className="num">{s.n(x.dayNo)}</td>
                  <td>{x.packageName ? (bn ? x.packageName.nameBn : x.packageName.nameEn) : <span className="t-muted">—</span>}</td>
                  <td className="r num">{M.tk(x.totalPaisa)}</td>
                  <td className="r num">{M.tk(x.depositsPaisa)}</td>
                  <td className="r num" data-state={x.depositState}>
                    {x.balancePaisa < 0 ? `−${M.tk(-x.balancePaisa)}` : M.tk(x.balancePaisa)}{" "}
                    {x.depositState !== "ok" && <Pill tone={STATE_TONE[x.depositState]!}>{x.depositState === "low" ? B("ib_low") : B("ib_t_due")}</Pill>}
                  </td>
                  <td data-bill={x.bill}>{x.bill === "draft" ? <span className="t-small t-muted">{B("ib_bill_running")}</span> : (<span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    <span className="num t-small">{x.invoiceNumber}</span>
                    {x.duePaisa > 0 && <Pill tone="bad">{B("ib_bill_due", { amount: M.tk(x.duePaisa) })}</Pill>}
                    {x.excessOpenPaisa > 0 && <Pill tone="warn">{B("ib_bill_excess", { amount: M.tk(x.excessOpenPaisa) })}</Pill>}
                  </span>)}</td>
                  <td>{x.discharge && <Pill tone={x.discharge.status === "completed" ? "neu" : "pend"} icon="log-out">{x.discharge.status === "completed" ? B("ib_discharged_pill") : `${s.n(x.discharge.done)}`}</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function IpdBill({ admissionId }: { admissionId: string }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const L = useLabels(); const router = useRouter(); const toast = useToast();
  const [v, setV] = useState<IpdBillView | null>(null); const [failed, setFailed] = useState<string | null>(null);
  const [dis, setDis] = useState<DischargeView | null>(null);
  const [showOld, setShowOld] = useState(true);
  const [depositOpen, setDepositOpen] = useState<null | { method: "cash" | "card" | "bank" | "bkash"; amount: string }>(null);
  const load = useCallback(async () => {
    try {
      const x = await ipdBill.view(admissionId); setV(x);
      setDis(x.discharge ? await discharge.view(admissionId).catch(() => null) : null);
    } catch (e) { setFailed(E(e)); }
  }, [admissionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!v) return;
    s.setPatient({ ...toBanner(v.patient, `${L.age(v.patient)} ${L.sex(v.patient.sex)}`), location: v.admission.bed ? `${v.admission.bed.ward} · ${v.admission.bed.name}` : undefined });
  }, [v?.patient.id, s.lang]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <Callout tone="warn" icon="triangle-alert">{failed}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{B("loading")}</div>;
  const bn = s.lang === "bn";
  const writer = WRITERS.includes(s.me?.role ?? "");
  const cls = v.classes.find((c) => c.key === v.admission.bedClass);
  const clsName = cls ? (bn ? cls.nameBn : cls.nameEn) : v.admission.bedClass;
  const rel = (r: string) => { const t = s.t("ipdApp", `rel_${r}`); return t === `rel_${r}` ? r : t; };
  const guardian = v.guardian ? `${v.guardian.name}${v.guardian.relationship ? ` (${rel(v.guardian.relationship)})` : ""}` : "—";
  const className = (k: string | null) => { const c = v.classes.find((x) => x.key === k); return c ? (bn ? c.nameBn : c.nameEn) : k ?? ""; };
  const lineName = (l: IpdLine) => l.source === "bed-day" && l.dayNo !== null && !l.creditOf
    ? `${B("ib_bed_day", { n: l.dayNo, cls: className(l.bedClass) })}${v.package && l.tag === "excluded" ? ` ${B("ib_beyond")}` : ""}` : bn ? l.nameBn : l.nameEn;
  const lines = showOld ? v.lines : v.lines.filter((l) => !l.superseded);
  const days = [...new Set(lines.map((l) => l.serviceDay ?? l.postedAt.slice(0, 10)))].sort();
  const signed = (p: number) => (p < 0 ? `−${M.tk(-p)}` : M.tk(p));
  const reason = (r: string) => B(`ib_reason_${["class-change", "package", "census", "order", "charge"].includes(r) ? r : "other"}`);
  return (
    <div data-screen="bill/ipd" data-status={v.depositState} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{B("ib_title")}</h1>
        <span className="num t-muted">{v.admission.number}</span>
        {v.admission.status === "discharged" && <Pill tone="neu" icon="log-out">{B("ib_discharged", { at: M.dateTime(v.admission.dischargedAt) })}</Pill>}
        <span style={{ flex: 1 }} />
        <Button size="sm" icon="arrow-left" onClick={() => router.push("/m/bill/ipd")}>{B("ib_back")}</Button>
      </div>
      <Card style={{ padding: 12, display: "flex", gap: 18, flexWrap: "wrap" }} data-testid="ipd-strip">
        <span className="t-small"><span className="t-muted">{B("ib_admitted")}:</span> <span className="num">{M.dateTime(v.admission.admittedAt)}</span> · {B("ib_day", { n: v.admission.dayNo })}</span>
        <span className="t-small"><span className="t-muted">{B("ib_bed")}:</span> {v.admission.bed ? `${v.admission.bed.ward} · ${v.admission.bed.name}` : "—"} · {clsName}</span>
        <span className="t-small"><span className="t-muted">{B("ib_package")}:</span> {v.package ? `${bn ? v.package.nameBn : v.package.nameEn} · ${B("ib_package_days", { n: v.package.days })}` : B("ib_no_package")}</span>
        <span className="t-small"><span className="t-muted">{B("ib_doctor")}:</span> {M.name(v.admission.doctor)}</span>
        <span className="t-small"><span className="t-muted">{B("ib_payer")}:</span> {B("ib_self_pay")}</span>
      </Card>
      {v.final && <Callout icon="lock" data-testid="bill-frozen">{B("fb_frozen")}</Callout>}
      {(v.sample.rates || v.sample.package) && <span className="t-small t-muted" data-testid="ipd-sample">{[v.sample.rates && B("ib_sample_rates"), v.sample.package && B("ib_sample_package")].filter(Boolean).join(" · ")}</span>}
      {!writer && <Callout icon="eye">{B("ib_view_only")}</Callout>}
      {v.depositState !== "ok" && !v.final && (
        <div className={`callout${v.depositState === "due" ? " callout-bad" : " callout-warn"}`} data-testid="deposit-alert" data-state={v.depositState} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 240 }}>{B(v.depositState === "due" ? "ib_alert_due" : "ib_alert_low", { amount: M.tk(Math.abs(v.balancePaisa)), guardian })}</span>
          {v.can.deposit && v.paymentMethods.includes("bkash") && v.guardian && (
            <Button size="sm" icon="send" onClick={() => setDepositOpen({ method: "bkash", amount: (v.suggestedTopUpPaisa / 100).toFixed(0) })} data-testid="send-link">{B("ib_send_link")}</Button>
          )}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 340px", gap: 12, alignItems: "start" }} className="ipd-bill-grid">
        <Card style={{ padding: 0, overflowX: "auto", minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px" }}>
            <b>{B("ib_running_total")}: <span className="num" data-testid="running-total">{signed(v.totals.totalPaisa)}</span></b>
            <span style={{ flex: 1 }} />
            <label className="t-small" style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} /> {B("ib_show_old")}</label>
          </div>
          {v.totals.unpriced > 0 && <div style={{ padding: "0 12px 8px" }}><Callout tone="warn" icon="triangle-alert">{B("ib_unpriced", { n: v.totals.unpriced })}</Callout></div>}
          <table className="table" style={{ width: "100%", minWidth: 760 }} data-testid="ipd-lines">
            <thead><tr><th>{B("ib_col_item")}</th><th>{B("ib_col_tag")}</th><th className="r">{B("ib_col_qty")}</th><th className="r">{B("ib_col_rate")}</th><th className="r">{B("ib_col_amount")}</th><th>{B("ib_col_posted")}</th><th /></tr></thead>
            <tbody>
              {days.map((d) => [
                <tr key={`d-${d}`} className="row-group"><td colSpan={7}><b className="num">{M.dateTime(`${d}T00:00:00+06:00`).split(" ")[0]}</b></td></tr>,
                ...lines.filter((l) => (l.serviceDay ?? l.postedAt.slice(0, 10)) === d).map((l) => (
                  <tr key={l.id} data-line={l.key} data-tag={l.tag} data-superseded={l.superseded ? "1" : "0"} data-credit={l.creditOf ? "1" : "0"}
                    style={{ opacity: l.superseded ? 0.55 : 1, background: l.tag === "package" ? "var(--brand-subtle, transparent)" : undefined }}>
                    <td style={{ textDecoration: l.superseded ? "line-through" : undefined }}>
                      {lineName(l)}
                      {l.superseded && <div className="t-small t-muted" style={{ textDecoration: "none" }}>{B("ib_superseded", { reason: reason(l.superseded.reason) })}</div>}
                      {l.creditOf && <div className="t-small t-muted">{B("ib_credit")}</div>}
                    </td>
                    <td><Pill tone={TAG_TONE[l.tag]} icon={TAG_ICON[l.tag]}>{B(`ib_tag_${l.tag}`)}</Pill></td>
                    <td className="r num">{s.n(l.qty)}</td>
                    <td className="r num">{l.tag === "included" ? "—" : l.unitPaisa === null ? "—" : M.tk(l.unitPaisa)}</td>
                    <td className={`r num${l.tag === "included" ? " t-muted" : ""}`}>{signed(l.totalPaisa)}</td>
                    <td className="t-small">{l.auto && !l.postedBy ? <span className="t-muted">{l.source === "bed-day" ? B("ib_auto") : B("ib_auto_sync")}</span> : M.name(l.postedBy)}</td>
                    <td>{writer && v.can.postCharge && l.key.startsWith("manual:") && !l.superseded && !l.credited && <WithdrawButton admissionId={admissionId} line={l} onDone={(x) => { setV(x); toast(B("ib_withdrawn"), "undo-2"); }} />}</td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </Card>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          <FinalCard v={v} writer={writer} onChange={(x) => { setV(x); if (x.discharge) void discharge.view(admissionId).then(setDis).catch(() => undefined); }} />
          {!v.final && <Totals v={v} />}
          <Deposits v={v} writer={writer} open={depositOpen} setOpen={setDepositOpen} onChange={setV} />
          <ClassCard v={v} />
          <PackageCard v={v} writer={writer} onChange={setV} />
          {writer && v.can.postCharge && <ChargeCard admissionId={admissionId} onChange={setV} />}
          <InterimCard admissionId={admissionId} />
          <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }} data-testid="clearance">
            <b>{B("ib_clearance")}</b>
            {dis ? (<><DischargeHeader v={dis} /><DischargeSteps v={dis} onChange={(x) => { setDis(x); void ipdBill.view(admissionId).then(setV); }} only={["final-bill", "payment"]} /></>) : <span className="t-small t-muted">{B("ib_clearance_none")}</span>}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Totals({ v }: { v: IpdBillView }) {
  const B = useB(); const M = useMoney();
  const signed = (p: number) => (p < 0 ? `−${M.tk(-p)}` : M.tk(p));
  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 6 }} data-testid="ipd-totals">
      <b>{B("ib_totals")}</b>
      <Row k={B("ib_t_package")} v={signed(v.totals.packagePaisa)} />
      <Row k={B("ib_t_excluded")} v={signed(v.totals.excludedPaisa)} />
      <Row k={B("ib_t_share")} v={signed(v.totals.totalPaisa)} strong />
      <Row k={`${B("ib_t_deposits")} (−)`} v={M.tk(v.deposits.confirmedPaisa)} />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, borderTop: "1px solid var(--border-subtle)", paddingTop: 6 }} data-testid="ipd-balance" data-state={v.depositState}>
        <b>{v.balancePaisa < 0 ? B("ib_t_due") : B("ib_t_balance")} {v.depositState === "low" && <Pill tone="warn">{B("ib_low")}</Pill>}</b>
        <b className="num" style={{ color: v.balancePaisa < 0 ? "var(--danger-fg)" : undefined }}>{M.tk(Math.abs(v.balancePaisa))}</b>
      </div>
    </Card>
  );
}
const Row = ({ k, v, strong }: { k: string; v: string; strong?: boolean }) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>{strong ? <b>{k}</b> : <span className="t-small">{k}</span>}{strong ? <b className="num">{v}</b> : <span className="num t-small">{v}</span>}</div>
);

function Deposits({ v, writer, open, setOpen, onChange }: { v: IpdBillView; writer: boolean; open: null | { method: "cash" | "card" | "bank" | "bkash"; amount: string }; setOpen: (x: null | { method: "cash" | "card" | "bank" | "bkash"; amount: string }) => void; onChange: (v: IpdBillView) => void }) {
  const s = useSession(); const B = useB(); const M = useMoney();
  const [receiptOf, setReceiptOf] = useState<string | null>(null);
  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }} data-testid="ipd-deposits">
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}><b style={{ flex: 1 }}>{B("ib_deposits")}</b>
        {writer && v.can.deposit && !open && <Button size="sm" icon="plus" onClick={() => setOpen({ method: "cash", amount: "" })} data-testid="take-deposit">{B("ib_take_deposit")}</Button>}</span>
      {v.deposits.items.length === 0 && <span className="t-small t-muted">{B("ib_deposits_none")}</span>}
      {v.deposits.items.map((d) => (
        <div key={d.id} className="t-small" data-deposit={d.method} data-status={d.status} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--border-subtle)", paddingTop: 6 }}>
          <span style={{ flexBasis: "100%" }}><span className="num">{M.dateTime(d.confirmedAt ?? d.createdAt)}</span> · {B(`m_${d.method}`)}{d.atCounter ? ` · ${B("ib_dep_counter")}` : ""}{d.to ? ` → ${d.to === "guardian" ? B("ib_dep_to_guardian", { name: v.guardian?.name ?? "" }) : B("ib_dep_to_patient")}` : ""}{d.phoneLast4 ? ` ··${s.n(Number(d.phoneLast4)).padStart(4, s.numerals === "bn" ? "০" : "0")}` : ""}</span>
          <b className="num">{M.tk(d.amountPaisa)}</b>
          <span style={{ flex: 1 }} />
          <Pill tone={d.status === "confirmed" ? "ok" : d.status === "failed" ? "bad" : "pend"}>{B(d.status === "confirmed" ? "ib_dep_status_confirmed" : d.status === "failed" ? "ib_dep_status_failed" : "ib_dep_status_pending")}</Pill>
          {d.status === "confirmed" && writer && <Button size="sm" icon="receipt-text" onClick={() => setReceiptOf(d.id)} data-testid="deposit-receipt">{d.receipt ? d.receipt.number : B("ib_dep_receipt")}</Button>}
        </div>
      ))}
      {open && <DepositForm v={v} init={open} onClose={() => setOpen(null)} onDone={(x) => { setOpen(null); onChange(x); }} />}
      {receiptOf && <DepositReceiptDialog paymentId={receiptOf} onClose={() => { setReceiptOf(null); void ipdBill.view(v.admission.id).then(onChange); }} />}
      {!s.online && <span className="t-small t-muted">{B("online_needed")}</span>}
    </Card>
  );
}

function DepositForm({ v, init, onClose, onDone }: { v: IpdBillView; init: { method: "cash" | "card" | "bank" | "bkash"; amount: string }; onClose: () => void; onDone: (v: IpdBillView) => void }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const toast = useToast();
  const methods = (["cash", "card", "bank", "bkash"] as const).filter((m) => v.paymentMethods.includes(m));
  const [method, setMethod] = useState(init.method); const [amount, setAmount] = useState(init.amount); const [tendered, setTendered] = useState(""); const [ref, setRef] = useState("");
  const [to, setTo] = useState<"guardian" | "patient">("guardian"); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const paisa = parseTaka(amount); const tend = method === "cash" ? parseTaka(tendered || amount) : null;
  const ok = !!paisa && paisa > 0 && (method !== "cash" || (tend ?? 0) >= paisa) && ((method !== "card" && method !== "bank") || ref.trim().length > 0) && s.online && !busy;
  const go = async () => {
    if (!ok) return; setBusy(true); setMsg(null);
    try {
      const x = await ipdBill.deposit(v.admission.id, { method, amountPaisa: paisa!, ...(method === "cash" ? { tenderedPaisa: tend! } : {}), ...(method === "card" || method === "bank" ? { reference: ref.trim() } : {}), ...(method === "bkash" ? { to } : {}) }, key.current);
      key.current = crypto.randomUUID();
      toast(method === "bkash" ? B("ib_dep_link_sent") : B("ib_dep_taken", { amount: M.tk(paisa!) }), "badge-check");
      onDone(x);
    } catch (e) { if (renew(e)) key.current = crypto.randomUUID(); setMsg(E(e)); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--border-subtle)", paddingTop: 8 }} data-testid="deposit-form">
      <Segmented label={B("ib_dep_method")} value={method} onChange={(m) => setMethod(m as typeof method)} options={methods.map((m) => ({ value: m, label: B(`m_${m}`) }))} />
      <TextField label={B("ib_dep_amount")} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" name="depositAmount" data-testid="deposit-amount" hint={v.suggestedTopUpPaisa > 0 ? B("ib_dep_suggest", { amount: M.tk(v.suggestedTopUpPaisa) }) : undefined} />
      {method === "cash" && <TextField label={B("ib_dep_tendered")} value={tendered} onChange={(e) => setTendered(e.target.value)} inputMode="decimal" name="depositTendered" placeholder={amount} />}
      {(method === "card" || method === "bank") && <TextField label={B("ib_dep_reference")} value={ref} onChange={(e) => setRef(e.target.value)} name="depositReference" data-testid="deposit-reference" />}
      {method === "bkash" && (
        <Segmented label={B("ib_dep_to")} value={to} onChange={(x) => setTo(x as "guardian" | "patient")}
          options={[{ value: "guardian", label: B("ib_dep_to_guardian", { name: v.guardian?.name ?? "—" }) }, { value: "patient", label: B("ib_dep_to_patient") }]} />
      )}
      {msg && <Callout tone="warn" icon="triangle-alert" data-testid="deposit-error">{msg}</Callout>}
      <div style={{ display: "flex", gap: 8 }}>
        <Button onClick={onClose} disabled={busy}>{B("cancel")}</Button>
        <Button variant="primary" icon={method === "bkash" ? "send" : "wallet"} disabled={!ok} onClick={() => void go()} data-testid="deposit-submit">{busy ? B("waiting_server") : method === "bkash" ? B("ib_send_link") : B("ib_take_deposit")}</Button>
      </div>
    </div>
  );
}

/** The money receipt of a confirmed deposit: made on request, printed A5 or 80 mm; a reprint needs a reason. */
function DepositReceiptDialog({ paymentId, onClose }: { paymentId: string; onClose: () => void }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const toast = useToast();
  const [r, setR] = useState<DepositReceiptView | null>(null); const [prints, setPrints] = useState(0);
  const [lang, setLang] = useState<"both" | "bn" | "en">("both"); const [paper, setPaper] = useState<"a5" | "thermal">("thermal");
  const [reason, setReason] = useState<(typeof REPRINT)[number] | "">(""); const [shown, setShown] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const asked = useRef(false); // the receipt is made once (a second request would race the one-receipt-per-payment rule)
  useEffect(() => { if (asked.current) return; asked.current = true; ipdBill.receipt(paymentId).then((x) => { setR(x); setPrints(x.prints); }).catch((e) => toast(E(e), "triangle-alert")); }, [paymentId]); // eslint-disable-line react-hooks/exhaustive-deps
  const print = async () => {
    if (!r || busy || (prints > 0 && !reason)) return; setBusy(true);
    try { const x = await ipdBill.printReceipt(r.id, { format: paper, lang, ...(prints > 0 ? { reason: reason as (typeof REPRINT)[number] } : {}) }, key.current); setShown(x.print.pdfUrl); setPrints(x.view.prints.length); setReason(""); key.current = crypto.randomUUID(); }
    catch (e) { toast(E(e), "triangle-alert"); if (renew(e)) key.current = crypto.randomUUID(); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} label={B("dr_title")} width={720}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 18 }} data-testid="deposit-receipt-dialog">
        {!r ? <span className="t-muted">{B("loading")}</span> : (<>
          <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <b>{B("dr_title")}</b><b className="num" data-testid="deposit-receipt-number">{r.number}</b>
            <span className="num t-muted">{M.tk(r.snapshot.amountPaisa)}</span>
            {prints > 0 && <Pill tone="neu" icon="printer">{s.n(prints)}</Pill>}
          </span>
          <span className="t-small">{B("dr_words")}: {M.words(r.snapshot.amountPaisa)}</span>
          <span className="t-small t-muted">{B("dr_note")}</span>
          <span style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Segmented label={B("rc_lang")} value={lang} onChange={setLang} options={[{ value: "both", label: B("rc_lang_both") }, { value: "bn", label: B("rc_lang_bn") }, { value: "en", label: B("rc_lang_en") }]} />
            <Segmented label={B("rc_format")} value={paper} onChange={setPaper} options={[{ value: "thermal", label: B("rc_format_thermal") }, { value: "a5", label: B("v_format_a5") }]} />
          </span>
          {prints > 0 && (
            <label className="field t-small">{B("rc_reason")}
              <select name="deposit-reprint-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
                <option value="">{B("disc_choose")}</option>
                {REPRINT.map((x) => <option key={x} value={x}>{B(`rr_${x}`)}</option>)}
              </select>
            </label>
          )}
          <span style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" icon="printer" disabled={busy || !s.online || (prints > 0 && !reason)} onClick={() => void print()} data-testid="deposit-receipt-print">{busy ? B("waiting_server") : prints > 0 ? B("ib_dep_reprint") : B("ib_dep_print")}</Button>
            <Button onClick={onClose}>{B("cancel")}</Button>
          </span>
          {shown && <iframe title={r.number} src={`/api${shown}`} style={{ width: "100%", height: 480, border: "1px solid var(--border-subtle)" }} />}
        </>)}
      </div>
    </Dialog>
  );
}

function ClassCard({ v }: { v: IpdBillView }) {
  const s = useSession(); const B = useB(); const M = useMoney();
  const [to, setTo] = useState(""); const [p, setP] = useState<ClassPreviewView | null>(null);
  useEffect(() => { if (!to) { setP(null); return; } ipdBill.preview(v.admission.id, to).then(setP).catch(() => setP(null)); }, [to, v.admission.id]);
  const name = (k: string) => { const c = v.classes.find((x) => x.key === k); return c ? (s.lang === "bn" ? c.nameBn : c.nameEn) : k; };
  const arrow = (a: number | null, b: number | null) => `${a === null ? "—" : M.tk(a)} → ${b === null ? "—" : M.tk(b)}`;
  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }} data-testid="class-card">
      <b>{B("ib_class_card")}</b>
      <span className="t-small">{B("ib_class_now", { cls: name(v.admission.bedClass), amount: M.tk(v.perDayPaisa) })}</span>
      <SelectField label={B("ib_class_pick")} value={to} onChange={(e) => setTo(e.target.value)} data-testid="class-preview-pick">
        <option value="">—</option>
        {v.classes.filter((c) => c.key !== v.admission.bedClass).map((c) => <option key={c.key} value={c.key}>{s.lang === "bn" ? c.nameBn : c.nameEn} · {M.tk(c.perDayPaisa)}</option>)}
      </SelectField>
      {p && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid="class-preview" data-direction={p.direction}>
          <b className="t-small">{B("ib_class_preview")}</b>
          <Row k={B("ib_pv_day")} v={arrow(p.perDayFromPaisa, p.perDayToPaisa)} />
          {p.packageFromPaisa !== null && <Row k={B("ib_pv_package")} v={arrow(p.packageFromPaisa, p.packageToPaisa)} />}
          <Row k={B("ib_pv_extra", { n: p.estDays })} v={p.extraPaisa < 0 ? `−${M.tk(-p.extraPaisa)}` : `+${M.tk(p.extraPaisa)}`} strong />
          <span className="t-small t-muted">{p.direction === "down" ? B("ib_pv_down") : B("ib_pv_up")}</span>
          <span className="t-small t-muted">{B("ib_pv_how")}</span>
        </div>
      )}
    </Card>
  );
}

function PackageCard({ v, writer, onChange }: { v: IpdBillView; writer: boolean; onChange: (v: IpdBillView) => void }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const toast = useToast();
  const [list, setList] = useState<PackageList | null>(null); const [pick, setPick] = useState(""); const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  useEffect(() => { if (v.can.applyPackage && writer) ipdBill.packages().then(setList).catch(() => setList(null)); }, [v.can.applyPackage, writer]);
  const bn = s.lang === "bn";
  const apply = async () => {
    if (!pick || busy) return; setBusy(true);
    try { onChange(await ipdBill.applyPackage(v.admission.id, pick, key.current)); key.current = crypto.randomUUID(); toast(B("ib_package_applied"), "badge-check"); }
    catch (e) { if (renew(e)) key.current = crypto.randomUUID(); toast(E(e), "triangle-alert"); } finally { setBusy(false); }
  };
  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }} data-testid="package-card">
      <b>{B("ib_package_card")}</b>
      {v.package ? (<>
        <span><b>{bn ? v.package.nameBn : v.package.nameEn}</b>{v.package.pricePaisa !== null && <span className="num"> · {M.tk(v.package.pricePaisa)}</span>} · {B("ib_package_days", { n: v.package.days })}</span>
        <span className="t-small"><b>{B("ib_inc_items")}:</b> {v.package.items.filter((i) => i.kind !== "excluded").map((i) => `${bn ? i.nameBn : i.nameEn}${i.limit ? ` (${B("ib_limit", { n: i.limit })})` : ""}`).join(", ")}</span>
        <span className="t-small"><b>{B("ib_exc_items")}:</b> {v.package.items.filter((i) => i.kind === "excluded").map((i) => (bn ? i.nameBn : i.nameEn)).join(", ")}</span>
      </>) : v.can.applyPackage && writer && list ? (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <SelectField label={B("ib_package_pick")} value={pick} onChange={(e) => setPick(e.target.value)} data-testid="package-pick">
            <option value="">—</option>
            {list.items.map((p) => { const price = p.prices[v.admission.bedClass]; return <option key={p.id} value={p.id} disabled={price === undefined}>{bn ? p.nameBn : p.nameEn} · {price === undefined ? B("ib_package_none_for_class") : M.tk(price)}</option>; })}
          </SelectField>
          <Button icon="package" disabled={!pick || busy || !s.online} onClick={() => void apply()} data-testid="package-apply">{B("ib_package_apply")}</Button>
        </div>
      ) : <span className="t-small t-muted">{B("ib_no_package")}</span>}
    </Card>
  );
}

function ChargeCard({ admissionId, onChange }: { admissionId: string; onChange: (v: IpdBillView) => void }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const toast = useToast();
  const [q, setQ] = useState(""); const [hits, setHits] = useState<ChargeDefinitionList["items"]>([]); const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => { bill.definitions(q.trim()).then((x) => setHits(x.items.filter((i) => i.kind !== "consultation").slice(0, 8))).catch(() => setHits([])); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const post = async (code: string) => {
    if (busy) return; setBusy(true);
    try { onChange(await ipdBill.charge(admissionId, code, 1, key.current)); key.current = crypto.randomUUID(); setQ(""); toast(B("ib_charge_posted"), "badge-check"); }
    catch (e) { if (renew(e)) key.current = crypto.randomUUID(); toast(E(e), "triangle-alert"); } finally { setBusy(false); }
  };
  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }} data-testid="charge-card">
      <b>{B("ib_charge")}</b>
      <TextField label={B("ib_charge_search")} value={q} onChange={(e) => setQ(e.target.value)} name="chargeSearch" data-testid="charge-search" />
      {hits.map((h) => (
        <button key={h.code} type="button" className="card" data-charge={h.code} disabled={busy || !s.online} onClick={() => void post(h.code)} style={{ textAlign: "left", padding: "6px 10px", display: "flex", justifyContent: "space-between", gap: 8, cursor: "pointer" }}>
          <span className="t-small">{s.lang === "bn" ? h.nameBn : h.nameEn}</span><span className="num t-small">{M.tk(h.unitPaisa)}</span>
        </button>
      ))}
    </Card>
  );
}

function WithdrawButton({ admissionId, line, onDone }: { admissionId: string; line: IpdLine; onDone: (v: IpdBillView) => void }) {
  const s = useSession(); const B = useB(); const E = useErr();
  const [open, setOpen] = useState(false); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  if (!open) return <Button size="sm" icon="undo-2" onClick={() => setOpen(true)} data-testid="withdraw">{B("ib_withdraw")}</Button>;
  return (
    <Dialog open onClose={() => setOpen(false)} label={B("ib_withdraw")} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 18 }}>
        <b>{B("ib_withdraw")} · {s.lang === "bn" ? line.nameBn : line.nameEn}</b>
        <TextArea label={B("ib_withdraw_reason")} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} name="withdrawReason" data-testid="withdraw-reason" />
        {msg && <Callout tone="warn" icon="triangle-alert">{msg}</Callout>}
        <span style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={() => setOpen(false)}>{B("cancel")}</Button>
          <Button variant="danger" icon="undo-2" disabled={reason.trim().length < 5 || busy || !s.online} data-testid="withdraw-confirm"
            onClick={() => { setBusy(true); ipdBill.withdraw(admissionId, line.id, reason.trim()).then((x) => { setOpen(false); onDone(x); }).catch((e) => setMsg(E(e))).finally(() => setBusy(false)); }}>{B("ib_withdraw")}</Button>
        </span>
      </div>
    </Dialog>
  );
}

/** The interim bill (decision 10): A4, not a final bill, no QR; a reprint needs a reason. */
function InterimCard({ admissionId }: { admissionId: string }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const toast = useToast();
  const [list, setList] = useState<InterimPrintList | null>(null); const [lang, setLang] = useState<"both" | "bn" | "en">("both");
  const [reason, setReason] = useState<(typeof REPRINT)[number] | "">(""); const [shown, setShown] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  useEffect(() => { ipdBill.interimPrints(admissionId).then(setList).catch(() => setList({ items: [] })); }, [admissionId]);
  const printed = (list?.items.length ?? 0) > 0;
  const print = async () => {
    if (busy || (printed && !reason)) return; setBusy(true);
    try { const x = await ipdBill.printInterim(admissionId, { lang, ...(printed ? { reason: reason as (typeof REPRINT)[number] } : {}) }, key.current); setList(x); setShown(x.items[x.items.length - 1]!.pdfUrl); setReason(""); key.current = crypto.randomUUID(); }
    catch (e) { toast(E(e), "triangle-alert"); if (renew(e)) key.current = crypto.randomUUID(); } finally { setBusy(false); }
  };
  const last = useMemo(() => list?.items[list.items.length - 1], [list]);
  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }} data-testid="interim-card">
      <b>{B("ib_interim")}</b>
      <Segmented label={B("rc_lang")} value={lang} onChange={setLang} options={[{ value: "both", label: B("rc_lang_both") }, { value: "bn", label: B("rc_lang_bn") }, { value: "en", label: B("rc_lang_en") }]} />
      {printed && (
        <label className="field t-small">{B("rc_reason")}
          <select name="interim-reprint-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
            <option value="">{B("disc_choose")}</option>
            {REPRINT.map((x) => <option key={x} value={x}>{B(`rr_${x}`)}</option>)}
          </select>
        </label>
      )}
      <span><Button icon="printer" disabled={busy || !s.online || (printed && !reason)} onClick={() => void print()} data-testid="interim-print">{busy ? B("waiting_server") : printed ? B("ib_interim_reprint") : B("ib_interim_print")}</Button></span>
      {last && <span className="t-small t-muted">{last.copy === 0 ? B("rc_audit_original", { name: M.name(last.printedBy), at: M.dateTime(last.printedAt) }) : B("rc_audit_dup", { n: last.copy, reason: B(`rr_${last.reason}`), name: M.name(last.printedBy), at: M.dateTime(last.printedAt) })} · <a href={`/api${last.pdfUrl}`} target="_blank" rel="noreferrer">{B("rc_pdf")}</a></span>}
      {shown && <iframe title="interim" src={`/api${shown}`} style={{ width: "100%", height: 360, border: "1px solid var(--border-subtle)" }} />}
    </Card>
  );
}

/** B10 (ADR 0018): the final bill. Draft — what stops it, and Issue with the outcome shown first (the deposits against
    the total: due at the counter, or the excess going back by refund). Issued — the categories, the deposits applied,
    the excess refund's state, the shortfall taken at the counter, the receipt (Mushak-6.3 on the settling one). */
function FinalCard({ v, writer, onChange }: { v: IpdBillView; writer: boolean; onChange: (v: IpdBillView) => void }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const toast = useToast(); const router = useRouter();
  const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [pay, setPay] = useState(false); const [receipt, setReceipt] = useState(false);
  const key = useRef(crypto.randomUUID());
  const f = v.final;
  if (!f) {
    const deposits = v.deposits.confirmedPaisa, total = v.totals.totalPaisa;
    const issue = async () => {
      if (busy) return; setBusy(true); setMsg(null);
      try { const x = await ipdBill.issue(v.admission.id, key.current); key.current = crypto.randomUUID(); setConfirm(false); onChange(x); toast(B("fb_issued_msg", { number: x.final?.number ?? "" }), "badge-check"); }
      catch (e) { if (renew(e)) key.current = crypto.randomUUID(); setMsg(E(e)); } finally { setBusy(false); }
    };
    return (
      <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }} data-testid="final-card" data-status="draft">
        <b>{B("fb_title")}</b>
        {v.issueBlockers.length > 0 && (
          <div className="t-small" data-testid="final-blockers"><b>{B("fb_blockers")}</b>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{v.issueBlockers.map((b) => <li key={b} data-blocker={b}>{B(`fb_b_${b}`)}</li>)}</ul>
          </div>
        )}
        {writer && v.can.issue && !confirm && <span><Button variant="primary" icon="file-check-2" disabled={v.issueBlockers.length > 0 || !s.online} onClick={() => setConfirm(true)} data-testid="final-issue">{B("fb_issue")}</Button></span>}
        {confirm && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid var(--border-subtle)", paddingTop: 8 }} data-testid="final-confirm">
            <Row k={B("fb_pv_total")} v={M.tk(total)} strong />
            <Row k={B("fb_pv_deposits")} v={M.tk(deposits)} />
            <span className="t-small" data-testid="final-preview">{deposits > total ? B("fb_pv_excess", { amount: M.tk(deposits - total) }) : deposits === total ? B("fb_pv_even") : B("fb_pv_due", { amount: M.tk(total - deposits) })}</span>
            <span className="t-small t-muted">{B("fb_pv_census")}</span>
            <Callout tone="warn" icon="lock">{B("fb_issue_warn")}</Callout>
            {msg && <Callout tone="warn" icon="triangle-alert" data-testid="final-error">{msg}</Callout>}
            <span style={{ display: "flex", gap: 8 }}>
              <Button onClick={() => setConfirm(false)} disabled={busy}>{B("cancel")}</Button>
              <Button variant="primary" icon="file-check-2" disabled={busy || !s.online} onClick={() => void issue()} data-testid="final-issue-confirm">{busy ? B("waiting_server") : B("fb_issue")}</Button>
            </span>
          </div>
        )}
      </Card>
    );
  }
  const ex = f.excessRefund;
  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 6 }} data-testid="final-card" data-status={f.status}>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <b style={{ flex: 1 }}>{B("fb_title")}</b>
        <Pill tone={FINAL_TONE[f.status]!} icon={f.status === "balanced" ? "badge-check" : "clock"}>{B(`fb_st_${f.status}`)}</Pill>
      </span>
      <span className="t-small num" data-testid="final-number">{B("fb_issued", { number: f.number, at: M.dateTime(f.issuedAt), name: M.name(f.issuedBy) })}</span>
      <table className="table" style={{ width: "100%" }} data-testid="final-categories">
        <tbody>
          {f.categories.map((c) => (
            <tr key={c.category} data-category={c.category}><td className="t-small">{B(`fb_cat_${c.category}`)} <span className="t-muted">· {B("fb_cat_lines", { n: c.lines })}</span></td>
              <td className="r num t-small">{c.vatPaisa ? `${B("fb_vat")} ${M.tk(c.vatPaisa)}` : ""}</td><td className="r num t-small">{M.tk(c.totalPaisa)}</td></tr>
          ))}
        </tbody>
      </table>
      <Row k={B("fb_total")} v={M.tk(v.totals.totalPaisa)} strong />
      <Row k={B("fb_deposits")} v={M.tk(f.depositsPaisa)} />
      {f.excessPaisa > 0 && <Row k={B("fb_excess")} v={`− ${M.tk(f.excessPaisa)}`} />}
      <Row k={B("fb_net_paid")} v={M.tk(f.netPaidPaisa)} />
      <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border-subtle)", paddingTop: 6 }} data-testid="final-due">
        <b>{B("fb_due")}</b><b className="num" style={{ color: f.duePaisa > 0 ? "var(--danger-fg)" : undefined }}>{M.tk(f.duePaisa)}</b>
      </div>
      {ex && (
        <div className={`callout ${ex.status === "paid" ? "" : "callout-warn"}`} data-testid="final-excess" data-status={ex.status} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span><b className="num">{M.tk(ex.amountPaisa)}</b> · {B(`fb_ex_${ex.status}`)}</span>
          {ex.status !== "paid" && <span className="t-small t-muted">{B("fb_ex_never")}</span>}
          <span><Button size="sm" icon="undo-2" onClick={() => router.push(`/m/bill/refund?rf=${encodeURIComponent(ex.id)}`)} data-testid="final-excess-open">{B("fb_ex_open")}</Button></span>
        </div>
      )}
      {f.afterIssue.length > 0 && (
        <Callout tone="warn" icon="triangle-alert" data-testid="final-after">
          <b>{B("fb_after")}</b>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{f.afterIssue.map((a) => <li key={`${a.kind}-${a.key}`} className="t-small">{s.lang === "bn" ? a.nameBn : a.nameEn} · {B(`fb_after_${a.kind}`)} <span className="num">{a.amountPaisa < 0 ? `−${M.tk(-a.amountPaisa)}` : M.tk(a.amountPaisa)}</span></li>)}</ul>
        </Callout>
      )}
      <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {writer && v.can.pay && !pay && <Button variant="primary" icon="wallet" onClick={() => setPay(true)} disabled={!s.online} data-testid="final-pay">{B("fb_pay")}</Button>}
        {writer && v.can.receipt && <Button icon="receipt-text" onClick={() => setReceipt(true)} disabled={!s.online} data-testid="final-receipt">{B("fb_receipt_make")}</Button>}
        {/* Kamrul, 2: a charge found wrong after the bill (an errored dose) is settled by a refund, never by editing the bill */}
        {writer && f.netPaidPaisa > 0 && <Button icon="undo-2" onClick={() => router.push(`/m/bill/refund?inv=${encodeURIComponent(v.invoice.id)}`)} data-testid="final-refund">{B("fb_refund")}</Button>}
      </span>
      {f.receipts.length > 0 && <span className="t-small t-muted" data-testid="final-receipts">{B("fb_receipts")}: {f.receipts.map((r) => `${r.number} (${M.tk(r.paidPaisa)})`).join(" · ")}</span>}
      {f.duePaisa > 0 && <span className="t-small t-muted">{B("fb_receipt_mushak")}</span>}
      {pay && <FinalPayForm v={v} onClose={() => setPay(false)} onDone={(x) => { setPay(false); onChange(x); }} />}
      {receipt && <FinalReceiptDialog admissionId={v.admission.id} onClose={() => { setReceipt(false); void ipdBill.view(v.admission.id).then(onChange); }} />}
    </Card>
  );
}

/** The shortfall at the counter — cash (from the drawer's shift), card, bank or a bKash link; never more than is due. */
function FinalPayForm({ v, onClose, onDone }: { v: IpdBillView; onClose: () => void; onDone: (v: IpdBillView) => void }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const toast = useToast();
  const due = v.final?.duePaisa ?? 0;
  const methods = (["cash", "card", "bank", "bkash"] as const).filter((m) => v.paymentMethods.includes(m));
  const [method, setMethod] = useState<(typeof methods)[number]>(methods[0] ?? "cash"); const [amount, setAmount] = useState((due / 100).toFixed(2).replace(/\.00$/, ""));
  const [tendered, setTendered] = useState(""); const [ref, setRef] = useState(""); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const paisa = parseTaka(amount); const tend = method === "cash" ? parseTaka(tendered || amount) : null;
  const ok = !!paisa && paisa > 0 && paisa <= due && (method !== "cash" || (tend ?? 0) >= paisa) && ((method !== "card" && method !== "bank") || ref.trim().length > 0) && s.online && !busy;
  const go = async () => {
    if (!ok) return; setBusy(true); setMsg(null);
    try {
      const x = await ipdBill.pay(v.admission.id, { method, amountPaisa: paisa!, ...(method === "cash" ? { tenderedPaisa: tend! } : {}), ...(method === "card" || method === "bank" ? { reference: ref.trim() } : {}) }, key.current);
      key.current = crypto.randomUUID();
      toast(method === "bkash" ? B("ib_dep_link_sent") : B("fb_pay_taken", { amount: M.tk(paisa!) }), "badge-check");
      onDone(x);
    } catch (e) { if (renew(e)) key.current = crypto.randomUUID(); setMsg(E(e)); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--border-subtle)", paddingTop: 8 }} data-testid="final-pay-form">
      <Segmented label={B("ib_dep_method")} value={method} onChange={(m) => setMethod(m as typeof method)} options={methods.map((m) => ({ value: m, label: B(`m_${m}`) }))} />
      <TextField label={B("ib_dep_amount")} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" name="finalAmount" data-testid="final-pay-amount" hint={B("fb_pv_due", { amount: M.tk(due) })} />
      {method === "cash" && <TextField label={B("ib_dep_tendered")} value={tendered} onChange={(e) => setTendered(e.target.value)} inputMode="decimal" name="finalTendered" placeholder={amount} />}
      {(method === "card" || method === "bank") && <TextField label={B("ib_dep_reference")} value={ref} onChange={(e) => setRef(e.target.value)} name="finalReference" data-testid="final-pay-reference" />}
      {msg && <Callout tone="warn" icon="triangle-alert" data-testid="final-pay-error">{msg}</Callout>}
      <div style={{ display: "flex", gap: 8 }}>
        <Button onClick={onClose} disabled={busy}>{B("cancel")}</Button>
        <Button variant="primary" icon={method === "bkash" ? "send" : "wallet"} disabled={!ok} onClick={() => void go()} data-testid="final-pay-submit">{busy ? B("waiting_server") : method === "bkash" ? B("ib_send_link") : B("fb_pay")}</Button>
      </div>
    </div>
  );
}

/** The final bill's receipt as it stands (the same one again if nothing changed), printed A5 or 80 mm; a reprint needs a reason. */
function FinalReceiptDialog({ admissionId, onClose }: { admissionId: string; onClose: () => void }) {
  const s = useSession(); const B = useB(); const M = useMoney(); const E = useErr(); const toast = useToast();
  const [r, setR] = useState<{ id: string; number: string; paidPaisa: number; duePaisa: number } | null>(null); const [prints, setPrints] = useState(0);
  const [lang, setLang] = useState<"both" | "bn" | "en">("both"); const [paper, setPaper] = useState<"a5" | "thermal">("a5");
  const [reason, setReason] = useState<(typeof REPRINT)[number] | "">(""); const [shown, setShown] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const asked = useRef(false);
  useEffect(() => { if (asked.current) return; asked.current = true; ipdBill.finalReceipt(admissionId).then((x) => { setR(x.receipt); setPrints(x.prints.length); }).catch((e) => toast(E(e), "triangle-alert")); }, [admissionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const print = async () => {
    if (!r || busy || (prints > 0 && !reason)) return; setBusy(true);
    try { const x = await ipdBill.printReceipt(r.id, { format: paper, lang, ...(prints > 0 ? { reason: reason as (typeof REPRINT)[number] } : {}) }, key.current); setShown(x.print.pdfUrl); setPrints(x.view.prints.length); setReason(""); key.current = crypto.randomUUID(); }
    catch (e) { toast(E(e), "triangle-alert"); if (renew(e)) key.current = crypto.randomUUID(); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} label={B("fb_receipt")} width={720}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 18 }} data-testid="final-receipt-dialog">
        {!r ? <span className="t-muted">{B("loading")}</span> : (<>
          <span style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <b>{B("fb_receipt")}</b><b className="num" data-testid="final-receipt-number">{r.number}</b>
            <span className="num t-muted">{M.tk(r.paidPaisa)}</span>{r.duePaisa > 0 && <span className="num t-small">{B("fb_due")} {M.tk(r.duePaisa)}</span>}
            {prints > 0 && <Pill tone="neu" icon="printer">{s.n(prints)}</Pill>}
          </span>
          <span style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Segmented label={B("rc_lang")} value={lang} onChange={setLang} options={[{ value: "both", label: B("rc_lang_both") }, { value: "bn", label: B("rc_lang_bn") }, { value: "en", label: B("rc_lang_en") }]} />
            <Segmented label={B("rc_format")} value={paper} onChange={setPaper} options={[{ value: "a5", label: B("v_format_a5") }, { value: "thermal", label: B("rc_format_thermal") }]} />
          </span>
          {prints > 0 && (
            <label className="field t-small">{B("rc_reason")}
              <select name="final-reprint-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
                <option value="">{B("disc_choose")}</option>
                {REPRINT.map((x) => <option key={x} value={x}>{B(`rr_${x}`)}</option>)}
              </select>
            </label>
          )}
          <span style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" icon="printer" disabled={busy || !s.online || (prints > 0 && !reason)} onClick={() => void print()} data-testid="final-receipt-print">{busy ? B("waiting_server") : prints > 0 ? B("ib_dep_reprint") : B("ib_dep_print")}</Button>
            <Button onClick={onClose}>{B("cancel")}</Button>
          </span>
          {shown && <iframe title={r.number} src={`/api${shown}`} style={{ width: "100%", height: 520, border: "1px solid var(--border-subtle)" }} />}
        </>)}
      </div>
    </Dialog>
  );
}
