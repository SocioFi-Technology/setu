"use client";
/* ph/purchase — journey P5 (ADR 0009). Ported from docs/prototype/Setu Pharmacy.dc.html ("Purchase"). Tabs: orders,
   suppliers (what is owed, the ledger, payments — owner / admin), approvals (owner / admin: orders above the threshold,
   counts waiting, receipts with a batch expiring within 6 months or another price than the order). An order: lines →
   Send (or "Ask the owner" above ৳50,000, sample) → Receive goods: each line checked at the counter (batch, expiry,
   billed and received quantity, cost, MRP, where it goes) → Post (stock in; a short delivery becomes a debit note). */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { GoodsReceiptView, PharmacyApprovals, PurchaseOrderList, PurchaseOrderView, SupplierLedger, SupplierList } from "@setu/contracts";
import { MEDICINES_SAMPLE } from "@setu/domain";
import { Button, Callout, Card, Dialog, PageState, Pill, Segmented, SelectField, TextArea, TextField, useToast, type Tone } from "@setu/ui";
import { purch } from "../../lib/api";
import { useSession } from "../../lib/session";
import { PharmacyApprovalCards } from "./Approvals";
import { MedName, NeedsServer, renewKey, takaToPaisa, toInt, useErr, useFmt, useP } from "./common";

const PO_TONE: Record<string, Tone> = { draft: "draft", sent: "pend", "partially-received": "warn", received: "ok", cancelled: "off" };
const APPROVERS = ["owner", "admin"];
type Tab = "orders" | "suppliers" | "approvals";

export function PhPurchase() {
  const sp = useSearchParams();
  const po = sp.get("po"), grn = sp.get("grn"), sup = sp.get("sup");
  if (grn) return <Receipt id={grn} />;
  if (po) return <Order id={po} />;
  if (sup) return <Supplier id={sup} />;
  return <Lists />;
}

function Lists() {
  const s = useSession(); const P = useP();
  const approver = APPROVERS.includes(s.me?.role ?? "");
  const sp = useSearchParams(); const router = useRouter();
  const tab = (sp.get("tab") as Tab | null) ?? (approver ? "approvals" : "orders");
  const tabs: Tab[] = approver ? ["approvals", "orders", "suppliers"] : ["orders", "suppliers"];
  return (
    <div data-screen="ph/purchase" style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{P("purchase_title")}</h1>
        <span style={{ marginLeft: "auto" }} />
        <Segmented label={P("purchase_title")} value={tab} onChange={(t) => router.push(`/m/ph/purchase?tab=${t}`)} options={tabs.map((t) => ({ value: t, label: P(`tab_${t}`) }))} />
      </div>
      <NeedsServer />
      {tab === "orders" && <Orders />}
      {tab === "suppliers" && <Suppliers />}
      {tab === "approvals" && approver && <Approvals />}
    </div>
  );
}

function Orders() {
  const s = useSession(); const P = useP(); const F = useFmt(); const E = useErr(); const router = useRouter(); const toast = useToast();
  const [list, setList] = useState<PurchaseOrderList | null>(null); const [sups, setSups] = useState<SupplierList | null>(null);
  const [supplierId, setSupplierId] = useState(""); const [key] = useState(() => crypto.randomUUID()); const [busy, setBusy] = useState(false);
  useEffect(() => { purch.orders().then(setList).catch(() => setList({ items: [] })); purch.suppliers().then((x) => { setSups(x); setSupplierId(x.items.find((i) => i.active)?.id ?? ""); }).catch(() => undefined); }, []);
  return (
    <>
      <Card style={{ display: "flex", gap: 10, alignItems: "flex-end", padding: 12, flexWrap: "wrap" }}>
        <SelectField label={P("supplier")} value={supplierId} onChange={(e) => setSupplierId(e.target.value)} data-testid="po-supplier">
          {sups?.items.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </SelectField>
        <Button variant="primary" icon="file-plus" data-testid="new-po" disabled={!s.online || busy || !supplierId}
          onClick={async () => { setBusy(true); try { const po = await purch.newOrder(supplierId, key); router.push(`/m/ph/purchase?po=${encodeURIComponent(po.id)}`); } catch (e) { toast(E(e), "triangle-alert"); setBusy(false); } }}>{P("new_po")}</Button>
      </Card>
      {!list ? <div aria-busy="true" className="t-muted">{P("loading")}</div> : list.items.length === 0 ? <PageState icon="clipboard-list" title={P("no_orders")} /> : (
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table className="table" style={{ width: "100%" }} data-testid="po-list">
            <thead><tr><th>{P("po_no")}</th><th>{P("supplier")}</th><th>{P("status")}</th><th className="num">{P("lines")}</th><th className="num">{P("total")}</th><th>{P("created")}</th></tr></thead>
            <tbody>
              {list.items.map((o) => (
                <tr key={o.id} data-po={o.id} style={{ cursor: "pointer" }} tabIndex={0} role="link" onClick={() => router.push(`/m/ph/purchase?po=${encodeURIComponent(o.id)}`)} onKeyDown={(e) => { if (e.key === "Enter") router.push(`/m/ph/purchase?po=${encodeURIComponent(o.id)}`); }}>
                  <td className="num">{o.number ?? P("draft")}</td><td>{o.supplier.name}</td>
                  <td><Pill tone={PO_TONE[o.status]}>{P(`po_${o.status}`)}</Pill>{o.approvalPending && <> <Pill tone="warn" icon="hourglass">{P("awaiting_approval")}</Pill></>}</td>
                  <td className="num">{F.n(o.lineCount)}</td><td className="num">{F.tk(o.totalPaisa)}</td><td className="num">{F.dateTime(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function Order({ id }: { id: string }) {
  const s = useSession(); const P = useP(); const F = useFmt(); const E = useErr(); const router = useRouter(); const toast = useToast();
  const [o, setO] = useState<PurchaseOrderView | null>(null); const [failed, setFailed] = useState(false); const [busy, setBusy] = useState(false);
  const [med, setMed] = useState(MEDICINES_SAMPLE[0]!.id); const [qty, setQty] = useState(""); const [cost, setCost] = useState("");
  const [ending, setEnding] = useState<"cancel" | "close-short" | null>(null); const [deciding, setDeciding] = useState<"approve" | "reject" | null>(null);
  const [inv, setInv] = useState(""); const [key, setKey] = useState(() => crypto.randomUUID());
  const load = useCallback(async () => { try { setO(await purch.order(id)); } catch { setFailed(true); } }, [id]);
  useEffect(() => { void load(); }, [load]);
  if (failed) return <PageState icon="clipboard-list" title={P("error_generic")} />;
  if (!o) return <div aria-busy="true" className="t-muted">{P("loading")}</div>;
  const approver = APPROVERS.includes(s.me?.role ?? "");
  const run = async (f: () => Promise<PurchaseOrderView>) => { if (busy) return false; setBusy(true); try { setO(await f()); setKey(crypto.randomUUID()); return true; } catch (e) { toast(E(e), "triangle-alert"); if (renewKey(e)) setKey(crypto.randomUUID()); await load(); return false; } finally { setBusy(false); } };
  const draft = o.status === "draft";
  const asking = o.sendBlockers.includes("approval_required");
  const openForGoods = o.status === "sent" || o.status === "partially-received";
  return (
    <div data-screen="ph/purchase" data-po={o.id} data-status={o.status} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{P("po")}</h1>
        <b className="num" data-testid="po-number">{o.number ?? P("draft")}</b>
        <Pill tone={PO_TONE[o.status]}>{P(`po_${o.status}`)}</Pill>
        <span>{o.supplier.name}</span>
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="arrow-left" onClick={() => router.push("/m/ph/purchase?tab=orders")}>{P("tab_orders")}</Button>
      </div>
      <NeedsServer />
      {o.endReason && <Callout tone="info" icon="info">{P(o.status === "cancelled" ? "cancelled_why" : "closed_short_why", { reason: o.endReason })}</Callout>}

      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table className="table" style={{ width: "100%" }} data-testid="po-lines">
          <thead><tr><th>{P("medicine")}</th><th className="num">{P("qty")}</th><th className="num">{P("unit_cost")}</th><th className="num">{P("total")}</th><th className="num">{P("received")}</th><th /></tr></thead>
          <tbody>
            {o.lines.length === 0 && <tr><td colSpan={6} className="t-muted">{P("no_lines")}</td></tr>}
            {o.lines.map((l) => (
              <tr key={l.id} data-line={l.medicine.key}>
                <td><MedName m={l.medicine} /></td><td className="num">{F.n(l.qty)}</td><td className="num">{F.tk(l.costPaisa)}</td><td className="num">{F.tk(l.qty * l.costPaisa)}</td>
                <td className="num">{F.n(l.receivedQty)}</td>
                <td>{draft && !o.approval?.status.startsWith("req") && <Button size="sm" icon="trash-2" disabled={!s.online || busy} onClick={() => void run(() => purch.removeLine(o.id, l.id, o.rev))}>{P("remove")}</Button>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={3}><b>{P("total")}</b> <span className="t-small t-muted">· {P("threshold", { t: F.tk(o.approvalThresholdPaisa) })}</span></td><td className="num"><b data-testid="po-total">{F.tk(o.totalPaisa)}</b></td><td colSpan={2} /></tr></tfoot>
        </table>
      </Card>

      {draft && o.approval?.status !== "requested" && (
        <Card style={{ display: "flex", gap: 10, alignItems: "flex-end", padding: 12, flexWrap: "wrap" }}>
          <SelectField label={P("medicine")} value={med} onChange={(e) => setMed(e.target.value)} data-testid="po-medicine">
            {MEDICINES_SAMPLE.map((m) => <option key={m.id} value={m.id}>{m.brand} {m.strength} · {m.generic}</option>)}
          </SelectField>
          <TextField label={P("qty")} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="po-qty" />
          <TextField label={P("unit_cost_tk")} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} data-testid="po-cost" />
          <Button icon="plus" data-testid="po-add" disabled={!s.online || busy || !toInt(qty) || takaToPaisa(cost) === null}
            onClick={async () => { if (await run(() => purch.addLine(o.id, { rev: o.rev, medicineKey: med, qty: toInt(qty)!, costPaisa: takaToPaisa(cost)! }))) { setQty(""); setCost(""); } }}>{P("add")}</Button>
        </Card>
      )}

      {o.approval && (
        <Callout tone={o.approval.status === "approved" ? "info" : o.approval.status === "rejected" ? "bad" : "warn"} icon="stamp" data-testid="po-approval">
          {P(`appr_${o.approval.status}`, { by: F.name(o.approval.requestedBy), at: F.dateTime(o.approval.requestedAt), who: F.name(o.approval.decidedBy), note: o.approval.note ?? "" })}
        </Callout>
      )}

      <Card style={{ display: "flex", gap: 10, alignItems: "center", padding: 12, flexWrap: "wrap" }}>
        {draft && o.approval?.status !== "requested" && (
          <Button variant="primary" icon={asking ? "stamp" : "send"} data-testid="po-send" disabled={!s.online || busy || o.sendBlockers.includes("no_lines")}
            onClick={async () => { await run(() => purch.send(o.id, o.rev, key)); }}>{asking ? P("ask_approval") : P("send_po")}</Button>
        )}
        {draft && o.approval?.status === "requested" && approver && o.approval.requestedBy.id !== s.me?.userId && (
          <>
            <Button variant="primary" icon="check" data-testid="po-approve" disabled={!s.online || busy} onClick={() => void run(() => purch.approval(o.id, "approve", "", key))}>{P("approve_send")}</Button>
            <Button icon="x" data-testid="po-reject" disabled={!s.online || busy} onClick={() => setDeciding("reject")}>{P("reject")}</Button>
          </>
        )}
        {(draft || o.status === "sent") && <Button icon="ban" data-testid="po-cancel" disabled={!s.online || busy} onClick={() => setEnding("cancel")}>{P("cancel_po")}</Button>}
        {o.status === "partially-received" && <Button icon="flag" data-testid="po-close" disabled={!s.online || busy} onClick={() => setEnding("close-short")}>{P("close_short")}</Button>}
        {openForGoods && (
          <span style={{ display: "inline-flex", gap: 8, alignItems: "flex-end", marginLeft: "auto" }}>
            <TextField label={P("supplier_invoice")} hint={P("optional")} value={inv} onChange={(e) => setInv(e.target.value)} data-testid="grn-invoice" />
            <Button variant="primary" icon="package-plus" data-testid="receive" disabled={!s.online || busy}
              onClick={async () => { setBusy(true); try { const g = await purch.newReceipt(o.id, inv.trim(), key); router.push(`/m/ph/purchase?grn=${encodeURIComponent(g.id)}`); } catch (e) { toast(E(e), "triangle-alert"); if (renewKey(e)) setKey(crypto.randomUUID()); setBusy(false); } }}>{P("receive_goods")}</Button>
          </span>
        )}
      </Card>

      {o.receipts.length > 0 && (
        <Card style={{ display: "flex", flexDirection: "column", gap: 6, padding: 12 }}>
          <b>{P("receipts")}</b>
          {o.receipts.map((r) => (
            <button key={r.id} type="button" className="card" style={{ display: "flex", gap: 10, padding: 8, textAlign: "left", cursor: "pointer" }} onClick={() => router.push(`/m/ph/purchase?grn=${encodeURIComponent(r.id)}`)}>
              <b className="num">{r.number ?? P("checking")}</b><Pill tone={r.status === "posted" ? "ok" : r.status === "checking" ? "pend" : "off"}>{P(`grn_${r.status}`)}</Pill><span className="num t-small">{F.dateTime(r.postedAt)}</span>
            </button>
          ))}
        </Card>
      )}

      <Dialog open={!!ending} onClose={() => setEnding(null)} label={ending === "cancel" ? P("cancel_po") : P("close_short")}>
        {ending && <ReasonForm label={P("reason")} confirm={ending === "cancel" ? P("cancel_po") : P("close_short")} onSubmit={async (r) => { if (await run(() => purch.end(o.id, ending, o.rev, r, key))) setEnding(null); }} />}
      </Dialog>
      <Dialog open={deciding === "reject"} onClose={() => setDeciding(null)} label={P("reject")}>
        <ReasonForm label={P("reject_note")} confirm={P("reject")} onSubmit={async (r) => { if (await run(() => purch.approval(o.id, "reject", r, key))) setDeciding(null); }} />
      </Dialog>
    </div>
  );
}

function ReasonForm({ label, confirm, onSubmit }: { label: string; confirm: string; onSubmit: (reason: string) => Promise<void> }) {
  const P = useP(); const s = useSession();
  const [r, setR] = useState(""); const [busy, setBusy] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <TextArea label={label} hint={P("reason_hint")} value={r} onChange={(e) => setR(e.target.value)} data-testid="reason" />
      <Button variant="primary" disabled={r.trim().length < 10 || busy || !s.online} data-testid="reason-confirm" onClick={async () => { setBusy(true); try { await onSubmit(r.trim()); } finally { setBusy(false); } }}>{confirm}</Button>
    </div>
  );
}

const plusDays = (n: number) => new Date(Date.now() + 6 * 3600_000 + n * 864e5).toISOString().slice(0, 10);
function Receipt({ id }: { id: string }) {
  const s = useSession(); const P = useP(); const F = useFmt(); const E = useErr(); const router = useRouter(); const toast = useToast();
  const [g, setG] = useState<GoodsReceiptView | null>(null); const [po, setPo] = useState<PurchaseOrderView | null>(null); const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false); const [key, setKey] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState<Record<string, { batchNo: string; expiry: string; invoiced: string; received: string; cost: string; mrp: string; location: "store" | "counter" | "fridge" }>>({});
  const [note, setNote] = useState("");
  const load = useCallback(async () => {
    try { const x = await purch.receipt(id); setG(x); const o = await purch.order(x.order.id); setPo(o); return o; } catch { setFailed(true); return null; }
  }, [id]);
  useEffect(() => { void load().then((o) => { if (!o) return; setForm(Object.fromEntries(o.lines.map((l) => { const left = l.qty - l.receivedQty; return [l.id, { batchNo: "", expiry: plusDays(730), invoiced: String(left), received: String(left), cost: String(l.costPaisa / 100), mrp: "", location: "store" as const }]; }))); }); }, [load]);
  if (failed) return <PageState icon="package" title={P("error_generic")} />;
  if (!g || !po) return <div aria-busy="true" className="t-muted">{P("loading")}</div>;
  const checking = g.status === "checking";
  const approver = APPROVERS.includes(s.me?.role ?? "");
  const run = async (f: () => Promise<GoodsReceiptView>) => { if (busy) return false; setBusy(true); try { setG(await f()); setKey(crypto.randomUUID()); return true; } catch (e) { toast(E(e), "triangle-alert"); if (renewKey(e)) setKey(crypto.randomUUID()); await load(); return false; } finally { setBusy(false); } };
  const here = (lineId: string) => g.lines.filter((x) => x.orderLineId === lineId).reduce((a, x) => a + x.receivedQty, 0);
  const ownerOnly = g.postBlockers.filter((b) => b.endsWith("needs_owner"));
  return (
    <div data-screen="ph/purchase" data-grn={g.id} data-status={g.status} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{P("grn")}</h1>
        <b className="num" data-testid="grn-number">{g.number ?? P("checking")}</b>
        <Pill tone={g.status === "posted" ? "ok" : g.status === "checking" ? "pend" : "off"}>{P(`grn_${g.status}`)}</Pill>
        <span>{g.supplier.name} · {P("po")} <span className="num">{g.order.number}</span>{g.supplierInvoiceNo ? <> · {P("supplier_invoice")} <span className="num">{g.supplierInvoiceNo}</span></> : null}</span>
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="arrow-left" onClick={() => router.push(`/m/ph/purchase?po=${encodeURIComponent(g.order.id)}`)}>{P("po")}</Button>
      </div>
      <NeedsServer />

      {checking && po.lines.filter((l) => l.qty - l.receivedQty - here(l.id) > 0).map((l) => {
        const f = form[l.id]; if (!f) return null;
        const set = (p: Partial<typeof f>) => setForm((x) => ({ ...x, [l.id]: { ...x[l.id]!, ...p } }));
        const ok = f.batchNo.trim() && f.expiry && toInt(f.invoiced) && toInt(f.received) !== null && takaToPaisa(f.cost) !== null && takaToPaisa(f.mrp) !== null;
        return (
          <Card key={l.id} data-testid="grn-form" data-line={l.medicine.key} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12 }}>
            <span><MedName m={l.medicine} /> · <span className="t-small">{P("open_qty", { n: l.qty - l.receivedQty - here(l.id), c: F.tk(l.costPaisa) })}</span></span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8, alignItems: "end" }}>
              <TextField label={P("batch")} value={f.batchNo} onChange={(e) => set({ batchNo: e.target.value })} data-testid="grn-batch" />
              <TextField label={P("exp")} type="date" value={f.expiry} onChange={(e) => set({ expiry: e.target.value })} data-testid="grn-expiry" />
              <TextField label={P("billed_qty")} inputMode="numeric" value={f.invoiced} onChange={(e) => set({ invoiced: e.target.value })} data-testid="grn-invoiced" />
              <TextField label={P("received_qty")} inputMode="numeric" value={f.received} onChange={(e) => set({ received: e.target.value })} data-testid="grn-received" />
              <TextField label={P("unit_cost_tk")} inputMode="decimal" value={f.cost} onChange={(e) => set({ cost: e.target.value })} data-testid="grn-cost" />
              <TextField label={P("mrp_tk")} inputMode="decimal" value={f.mrp} onChange={(e) => set({ mrp: e.target.value })} data-testid="grn-mrp" />
              <SelectField label={P("location")} value={f.location} onChange={(e) => set({ location: e.target.value as typeof f.location })} data-testid="grn-location">
                {(["store", "counter", "fridge"] as const).map((x) => <option key={x} value={x}>{P(`loc_${x}`)}</option>)}
              </SelectField>
              <Button icon="plus" data-testid="grn-add" disabled={!s.online || busy || !ok}
                onClick={async () => { if (await run(() => purch.receiptLine(g.id, { rev: g.rev, orderLineId: l.id, batchNo: f.batchNo.trim(), expiry: f.expiry, invoicedQty: toInt(f.invoiced)!, receivedQty: toInt(f.received)!, costPaisa: takaToPaisa(f.cost)!, mrpPaisa: takaToPaisa(f.mrp)!, vatRateBp: 0, location: f.location }))) set({ batchNo: "", invoiced: "", received: "" }); }}>{P("add")}</Button>
            </div>
          </Card>
        );
      })}

      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table className="table" style={{ width: "100%" }} data-testid="grn-lines">
          <thead><tr><th>{P("medicine")}</th><th>{P("batch")}</th><th>{P("exp")}</th><th className="num">{P("billed_qty")}</th><th className="num">{P("received_qty")}</th><th className="num">{P("unit_cost")}</th><th className="num">{P("mrp")}</th><th>{P("location")}</th><th>{P("checks")}</th><th /></tr></thead>
          <tbody>
            {g.lines.length === 0 && <tr><td colSpan={10} className="t-muted">{P("no_lines")}</td></tr>}
            {g.lines.map((l) => (
              <tr key={l.id} data-batch={l.batchNo}>
                <td><MedName m={l.medicine} strong={false} /></td><td className="num">{l.batchNo}</td><td className="num">{F.day(l.expiry)}</td>
                <td className="num">{F.n(l.invoicedQty)}</td><td className="num">{F.n(l.receivedQty)}</td><td className="num">{F.tk(l.costPaisa)}</td><td className="num">{F.tk(l.mrpPaisa)}</td><td>{P(`loc_${l.location}`)}</td>
                <td><div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {l.shortExpiry && <Pill tone="warn" icon="hourglass">{P("short_expiry")}</Pill>}
                  {l.priceVariance && <Pill tone="warn" icon="tag">{P("price_variance", { c: F.tk(l.orderCostPaisa) })}</Pill>}
                  {l.receivedQty < l.invoicedQty && <Pill tone="info" icon="file-minus">{P("short_delivery")}</Pill>}
                  {l.blockers.map((b) => <Pill key={b} tone="bad" icon="ban">{P(`grn_b_${b}`)}</Pill>)}
                </div></td>
                <td>{checking && <Button size="sm" icon="trash-2" disabled={!s.online || busy} onClick={() => void run(() => purch.receiptRemove(g.id, l.id, g.rev))}>{P("remove")}</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card style={{ display: "flex", gap: 16, padding: 12, flexWrap: "wrap" }} data-testid="grn-money">
        <span>{P("billed")}: <b className="num">{F.tk(g.money.invoicedPaisa)}</b></span>
        <span>{P("debit_note")}: <b className="num">{F.tk(g.money.debitNotePaisa)}</b></span>
        <span>{P("owed_for_this")}: <b className="num">{F.tk(g.money.owedPaisa)}</b></span>
      </Card>

      {checking && ownerOnly.map((b) => <Callout key={b} tone="warn" icon="stamp">{P(`post_b_${b}`)}</Callout>)}
      {checking && (
        <Card style={{ display: "flex", gap: 10, alignItems: "flex-end", padding: 12, flexWrap: "wrap" }}>
          <TextField label={P("post_note")} hint={P("optional")} value={note} onChange={(e) => setNote(e.target.value)} data-testid="grn-note" />
          <Button variant="primary" icon="package-check" data-testid="grn-post" disabled={!s.online || busy || g.postBlockers.length > 0} onClick={() => void run(() => purch.post(g.id, g.rev, note.trim(), key))}>{P("post_grn")}</Button>
          <Button icon="trash" data-testid="grn-discard" disabled={!s.online || busy} onClick={() => void run(() => purch.discard(g.id, g.rev, key))}>{P("discard")}</Button>
        </Card>
      )}
      {g.status === "posted" && <Callout tone="info" icon="check">{P("posted_by", { name: F.name(g.postedBy), at: F.dateTime(g.postedAt) })}</Callout>}
    </div>
  );
}

function Suppliers() {
  const s = useSession(); const P = useP(); const F = useFmt(); const E = useErr(); const router = useRouter(); const toast = useToast();
  const [list, setList] = useState<SupplierList | null>(null); const [name, setName] = useState(""); const [busy, setBusy] = useState(false);
  const load = useCallback(() => purch.suppliers().then(setList).catch(() => setList({ items: [] })), []);
  useEffect(() => { void load(); }, [load]);
  return (
    <>
      <Card style={{ display: "flex", gap: 10, alignItems: "flex-end", padding: 12, flexWrap: "wrap" }}>
        <TextField label={P("new_supplier")} value={name} onChange={(e) => setName(e.target.value)} data-testid="supplier-name" />
        <Button icon="plus" disabled={!s.online || busy || name.trim().length < 2} onClick={async () => { setBusy(true); try { await purch.newSupplier({ name: name.trim() }); setName(""); await load(); } catch (e) { toast(E(e), "triangle-alert"); } finally { setBusy(false); } }}>{P("add")}</Button>
      </Card>
      {!list ? <div aria-busy="true" className="t-muted">{P("loading")}</div> : (
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table className="table" style={{ width: "100%" }} data-testid="supplier-list">
            <thead><tr><th>{P("supplier")}</th><th className="num">{P("owed")}</th></tr></thead>
            <tbody>
              {list.items.map((x) => (
                <tr key={x.id} data-supplier={x.name} style={{ cursor: "pointer" }} tabIndex={0} role="link" onClick={() => router.push(`/m/ph/purchase?sup=${encodeURIComponent(x.id)}`)} onKeyDown={(e) => { if (e.key === "Enter") router.push(`/m/ph/purchase?sup=${encodeURIComponent(x.id)}`); }}>
                  <td>{x.name}{x.sample ? <span className="t-small t-muted"> · {P("sample")}</span> : null}</td><td className="num">{F.tk(x.owedPaisa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function Supplier({ id }: { id: string }) {
  const s = useSession(); const P = useP(); const F = useFmt(); const E = useErr(); const router = useRouter(); const toast = useToast();
  const [l, setL] = useState<SupplierLedger | null>(null); const [lFailed, setLFailed] = useState(false); const [amt, setAmt] = useState(""); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [key, setKey] = useState(() => crypto.randomUUID());
  useEffect(() => { purch.supplier(id).then(setL).catch(() => setLFailed(true)); }, [id]);
  if (lFailed) return <PageState icon="truck" title={P("error_generic")} />;
  if (!l) return <div aria-busy="true" className="t-muted">{P("loading")}</div>;
  const approver = APPROVERS.includes(s.me?.role ?? "");
  const p = takaToPaisa(amt);
  return (
    <div data-screen="ph/purchase" data-supplier={l.supplier.id} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{l.supplier.name}</h1>
        <span>{P("owed")}: <b className="num" data-testid="supplier-owed">{F.tk(l.supplier.owedPaisa)}</b></span>
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="arrow-left" onClick={() => router.push("/m/ph/purchase?tab=suppliers")}>{P("tab_suppliers")}</Button>
      </div>
      <NeedsServer />
      {approver && (
        <Card style={{ display: "flex", gap: 10, alignItems: "flex-end", padding: 12, flexWrap: "wrap" }}>
          <TextField label={P("pay_amount_tk")} inputMode="decimal" value={amt} onChange={(e) => { setAmt(e.target.value); setKey(crypto.randomUUID()); }} data-testid="sup-pay-amount" error={p !== null && p > l.supplier.owedPaisa ? P("over_owed") : undefined} />
          <TextField label={P("pay_note")} hint={P("pay_note_hint")} value={note} onChange={(e) => { setNote(e.target.value); setKey(crypto.randomUUID()); }} data-testid="sup-pay-note" />
          <Button variant="primary" icon="banknote" data-testid="sup-pay" disabled={!s.online || busy || !p || p > l.supplier.owedPaisa || note.trim().length < 4}
            onClick={async () => { setBusy(true); try { setL(await purch.pay(id, { amountPaisa: p!, note: note.trim() }, key)); setAmt(""); setNote(""); setKey(crypto.randomUUID()); } catch (e) { toast(E(e), "triangle-alert"); if (renewKey(e)) setKey(crypto.randomUUID()); } finally { setBusy(false); } }}>{P("record_payment")}</Button>
        </Card>
      )}
      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table className="table" style={{ width: "100%" }} data-testid="supplier-ledger">
          <thead><tr><th>{P("when")}</th><th>{P("entry")}</th><th>{P("ref")}</th><th className="num">{P("amount")}</th><th>{P("by")}</th></tr></thead>
          <tbody>
            {l.entries.length === 0 && <tr><td colSpan={5} className="t-muted">{P("nothing_here")}</td></tr>}
            {l.entries.map((e) => (
              <tr key={e.id} data-kind={e.kind}>
                <td className="num">{F.dateTime(e.at)}</td><td>{P(`se_${e.kind}`)}</td><td className="num">{e.ref ?? e.note ?? "—"}</td>
                <td className="num">{e.kind === "goods-received" ? "+" : "−"}{F.tk(e.amountPaisa)}</td><td>{F.name(e.by)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function Approvals() {
  const P = useP();
  const [status, setStatus] = useState<"requested" | "approved" | "rejected">("requested"); const [n, setN] = useState<number | null>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }} data-testid="ph-approvals">
      <Segmented label={P("tab_approvals")} value={status} onChange={setStatus} options={(["requested", "approved", "rejected"] as const).map((x) => ({ value: x, label: P(`as_${x}`) }))} />
      {n === 0 && <PageState icon="check-check" title={P("nothing_waiting")} />}
      <PharmacyApprovalCards status={status} kinds={["purchase-order", "goods-receipt", "count"]} onCount={setN} />
    </div>
  );
}
