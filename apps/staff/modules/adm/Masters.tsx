"use client";
/* adm/masters — journey G3 (ADR 0010). Ported from docs/prototype/Setu Admin.dc.html ("Masters"): the price list
   (consultation fees per doctor, tests, desk services) — add, change a price with a reason (bills already made keep
   theirs; a draft shows "price changed since"), switch an item off with a reason, see its history — and the settings:
   approval limits (a change needs a reason and is flagged in the audit log) and the dose-label page. The medicine and
   diagnosis lists stay read-only samples here. Writes keep their Idempotency-Key until they succeed. */
import { useCallback, useEffect, useState } from "react";
import type { FacilityView, PriceHistory, PriceItem, PriceList } from "@setu/contracts";
import { Button, Callout, Card, Dialog, PageState, Pill, Segmented, SelectField, TextArea, TextField, useToast } from "@setu/ui";
import { adm } from "../../lib/api";
import { useSession } from "../../lib/session";
import { paisaToInput, takaToPaisa, useA, useErr, useFmt } from "./common";

type Tab = "prices" | "limits";
type KindFilter = "all" | "consultation" | "test" | "service";

export function AdmMasters() {
  const s = useSession(); const A = useA();
  const [tab, setTab] = useState<Tab>("prices");
  useEffect(() => { s.setPatient(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div data-screen="adm/masters" style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{A("masters_title")}</h1>
        <span style={{ marginLeft: "auto" }} />
        <Segmented label={A("masters_title")} value={tab} onChange={setTab} options={[{ value: "prices", label: A("tab_prices") }, { value: "limits", label: A("tab_limits") }]} />
      </div>
      {tab === "prices" ? <Prices /> : <Limits />}
    </div>
  );
}

function Prices() {
  const s = useSession(); const A = useA(); const F = useFmt(); const E = useErr(); const toast = useToast();
  const [list, setList] = useState<PriceList | null>(null); const [failed, setFailed] = useState(false);
  const [kind, setKind] = useState<KindFilter>("all");
  const [editing, setEditing] = useState<PriceItem | null>(null); const [history, setHistory] = useState<PriceItem | null>(null); const [adding, setAdding] = useState(false);
  const load = useCallback(async () => { try { setList(await adm.prices()); } catch { setFailed(true); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (failed) return <PageState icon="tag" title={A("error_generic")} />;
  if (!list) return <div aria-busy="true" className="t-muted">{A("loading")}</div>;
  const rows = list.items.filter((i) => kind === "all" || i.kind === kind);
  return (
    <>
      {list.doctorsWithoutFee.length > 0 && <Callout tone="warn" icon="user-round" data-testid="no-fee">{A("no_fee", { names: list.doctorsWithoutFee.map((d) => F.name(d)).join(", ") })}</Callout>}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Segmented label={A("kind")} value={kind} onChange={setKind} options={(["all", "consultation", "test", "service"] as const).map((k) => ({ value: k, label: A(`kind_${k}`) }))} />
        <span style={{ marginLeft: "auto" }} />
        <Button variant="primary" icon="plus" data-testid="add-price" disabled={!s.online} onClick={() => setAdding(true)}>{A("add_price")}</Button>
      </div>
      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table className="table" style={{ width: "100%" }} data-testid="price-list">
          <thead><tr><th>{A("item")}</th><th>{A("kind")}</th><th className="num">{A("price")}</th><th className="num">{A("vat")}</th><th>{A("status")}</th><th>{A("last_change")}</th><th /></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id} data-code={i.code} data-active={i.active ? "1" : "0"}>
                <td><b>{s.lang === "bn" ? i.nameBn : i.nameEn}</b>{i.sample && <span className="t-small t-muted"> · {A("sample")}</span>}</td>
                <td>{A(`kind_${i.kind}`)}</td>
                <td className="num">{F.tk(i.unitPaisa)}</td>
                <td className="num">{F.n(`${i.vatRateBp / 100}%`)}</td>
                <td>{i.active ? <Pill tone="ok" icon="check">{A("on")}</Pill> : <Pill tone="off" icon="minus">{A("off")}</Pill>}</td>
                <td className="t-small">{i.lastChange ? `${F.dateTime(i.lastChange.at)} · ${F.name(i.lastChange.by)}${i.lastChange.oldUnitPaisa !== null ? ` · ${F.tk(i.lastChange.oldUnitPaisa)} →` : ""}` : "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <Button size="sm" icon="pencil" data-testid="change-price" disabled={!s.online} onClick={() => setEditing(i)}>{A("change")}</Button>{" "}
                  <Button size="sm" variant="ghost" icon="history" data-testid="price-history" onClick={() => setHistory(i)}>{A("history")}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Dialog open={!!editing} onClose={() => setEditing(null)} label={A("change_price")} width={520}>
        {editing && <ChangePrice i={editing} onDone={async (l) => { setList(l); setEditing(null); toast(A("saved"), "check"); }} onError={(e) => toast(E(e), "triangle-alert")} />}
      </Dialog>
      <Dialog open={!!history} onClose={() => setHistory(null)} label={A("history")} width={560}>
        {history && <History i={history} />}
      </Dialog>
      <Dialog open={adding} onClose={() => setAdding(false)} label={A("add_price")} width={520}>
        {adding && <AddPrice list={list} onDone={async (l) => { setList(l); setAdding(false); toast(A("saved"), "check"); }} onError={(e) => toast(E(e), "triangle-alert")} />}
      </Dialog>
    </>
  );
}

function ChangePrice({ i, onDone, onError }: { i: PriceItem; onDone: (l: PriceList) => Promise<void>; onError: (e: unknown) => void }) {
  const s = useSession(); const A = useA(); const F = useFmt();
  const [price, setPrice] = useState(paisaToInput(i.unitPaisa)); const [vat, setVat] = useState(String(i.vatRateBp / 100)); const [reason, setReason] = useState(""); const [offReason, setOffReason] = useState("");
  const [busy, setBusy] = useState(false); const [keys] = useState(() => ({ price: crypto.randomUUID(), active: crypto.randomUUID() }));
  const p = takaToPaisa(price); const v = /^\d+(\.\d{1,2})?$/.test(vat.trim()) ? Math.round(Number(vat) * 100) : null;
  const changed = p !== null && v !== null && (p !== i.unitPaisa || v !== i.vatRateBp);
  const go = async (f: () => Promise<PriceList>, renew: "price" | "active") => { setBusy(true); try { const l = await f(); keys[renew] = crypto.randomUUID(); await onDone(l); } catch (e) { onError(e); } finally { setBusy(false); } };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }} data-testid="change-dialog" data-code={i.code}>
      <b>{s.lang === "bn" ? i.nameBn : i.nameEn}</b>
      <span className="t-small">{A("now_price", { price: F.tk(i.unitPaisa) })}</span>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <TextField label={A("new_price_tk")} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} data-testid="new-price" />
        <TextField label={A("vat_pct")} inputMode="decimal" value={vat} onChange={(e) => setVat(e.target.value)} data-testid="new-vat" />
      </div>
      <TextArea label={A("why_change")} hint={A("reason_hint")} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="price-reason" />
      <Callout tone="info" icon="info">{A("price_rule")}</Callout>
      <span><Button variant="primary" icon="save" data-testid="price-save" disabled={busy || !s.online || !changed || reason.trim().length < 10}
        onClick={() => void go(() => adm.changePrice(i.id, { unitPaisa: p!, vatRateBp: v!, reason: reason.trim() }, keys.price), "price")}>{A("save_price")}</Button></span>
      <hr style={{ border: 0, borderTop: "1px solid var(--border-default)", width: "100%" }} />
      <b>{i.active ? A("switch_item_off") : A("switch_item_on")}</b>
      <TextField label={A("reason")} hint={A("reason_hint")} value={offReason} onChange={(e) => setOffReason(e.target.value)} data-testid="active-reason" />
      <span><Button icon={i.active ? "eye-off" : "eye"} data-testid="price-active" disabled={busy || !s.online || offReason.trim().length < 10}
        onClick={() => void go(() => adm.priceActive(i.id, !i.active, offReason.trim(), keys.active), "active")}>{i.active ? A("switch_item_off") : A("switch_item_on")}</Button></span>
    </div>
  );
}

function History({ i }: { i: PriceItem }) {
  const A = useA(); const F = useFmt();
  const [h, setH] = useState<PriceHistory | null>(null);
  useEffect(() => { adm.priceHistory(i.id).then(setH).catch(() => setH({ items: [] })); }, [i.id]);
  if (!h) return <div aria-busy="true" className="t-muted">{A("loading")}</div>;
  return (
    <table className="table" style={{ width: "100%" }} data-testid="history-table">
      <thead><tr><th>{A("when")}</th><th>{A("by")}</th><th className="num">{A("from")}</th><th className="num">{A("to")}</th><th>{A("reason")}</th></tr></thead>
      <tbody>
        {h.items.map((x) => (
          <tr key={x.id}>
            <td className="num t-small">{F.dateTime(x.at)}</td><td>{F.name(x.by)}</td>
            <td className="num">{x.oldUnitPaisa === null ? A("added") : F.tk(x.oldUnitPaisa)}</td><td className="num">{F.tk(x.newUnitPaisa)}</td>
            <td className="t-small">{x.reason ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AddPrice({ list, onDone, onError }: { list: PriceList; onDone: (l: PriceList) => Promise<void>; onError: (e: unknown) => void }) {
  const s = useSession(); const A = useA(); const F = useFmt();
  const [kind, setKind] = useState<"consultation" | "test" | "service">(list.doctorsWithoutFee.length ? "consultation" : "service");
  const unpricedTests = list.tests.filter((t) => !t.priced);
  const [ref, setRef] = useState(""); const [nameEn, setNameEn] = useState(""); const [nameBn, setNameBn] = useState(""); const [price, setPrice] = useState(""); const [vat, setVat] = useState("0");
  const [busy, setBusy] = useState(false); const [key, setKey] = useState(() => crypto.randomUUID());
  useEffect(() => { setRef(kind === "consultation" ? list.doctorsWithoutFee[0]?.id ?? "" : kind === "test" ? unpricedTests[0]?.code ?? "" : ""); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const p = takaToPaisa(price); const v = /^\d+(\.\d{1,2})?$/.test(vat.trim()) ? Math.round(Number(vat) * 100) : null;
  const ok = p !== null && v !== null && (kind === "service" ? nameEn.trim().length >= 2 && nameBn.trim().length >= 1 : Boolean(ref));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <SelectField label={A("kind")} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} data-testid="add-kind">
        <option value="consultation">{A("kind_consultation")}</option><option value="test">{A("kind_test")}</option><option value="service">{A("kind_service")}</option>
      </SelectField>
      {kind === "consultation" && (list.doctorsWithoutFee.length
        ? <SelectField label={A("doctor")} value={ref} onChange={(e) => setRef(e.target.value)} data-testid="add-doctor">{list.doctorsWithoutFee.map((d) => <option key={d.id} value={d.id}>{F.name(d)}</option>)}</SelectField>
        : <span className="t-small t-muted">{A("all_doctors_priced")}</span>)}
      {kind === "test" && (unpricedTests.length
        ? <SelectField label={A("test")} value={ref} onChange={(e) => setRef(e.target.value)} data-testid="add-test">{unpricedTests.map((t) => <option key={t.code} value={t.code}>{s.lang === "bn" ? t.nameBn : t.nameEn}</option>)}</SelectField>
        : <span className="t-small t-muted">{A("all_tests_priced")}</span>)}
      {kind === "service" && (
        <>
          <TextField label={A("name_en")} value={nameEn} onChange={(e) => setNameEn(e.target.value)} data-testid="add-name-en" />
          <TextField label={A("name_bn")} value={nameBn} onChange={(e) => setNameBn(e.target.value)} data-testid="add-name-bn" />
        </>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <TextField label={A("price_tk")} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} data-testid="add-price-tk" />
        <TextField label={A("vat_pct")} inputMode="decimal" value={vat} onChange={(e) => setVat(e.target.value)} />
      </div>
      <span><Button variant="primary" icon="plus" data-testid="add-price-save" disabled={busy || !s.online || !ok}
        onClick={async () => { setBusy(true); try { const l = await adm.addPrice({ kind, ...(kind !== "service" ? { ref } : { nameEn: nameEn.trim(), nameBn: nameBn.trim() }), unitPaisa: p!, vatRateBp: v! }, key); setKey(crypto.randomUUID()); await onDone(l); } catch (e) { onError(e); } finally { setBusy(false); } }}>{A("add")}</Button></span>
    </div>
  );
}

function Limits() {
  const s = useSession(); const A = useA(); const F = useFmt(); const E = useErr(); const toast = useToast();
  const [f, setF] = useState<FacilityView | null>(null);
  const [v, setV] = useState({ cashier: "", pct: "", approver: "", w: "", h: "", reason: "" });
  const [busy, setBusy] = useState(false); const [key, setKey] = useState(() => crypto.randomUUID());
  const show = (x: FacilityView) => { setF(x); setV({ cashier: paisaToInput(x.settings.cashierLimitPaisa), pct: String(x.settings.cashierLimitBp / 100), approver: paisaToInput(x.settings.approverLimitPaisa), w: String(x.settings.labelWidthMm), h: String(x.settings.labelHeightMm), reason: "" }); };
  // a re-run effect (React runs it twice in development) ignores the earlier answer — it must never reset what was typed
  useEffect(() => { let stale = false; adm.facility().then((x) => { if (!stale) show(x); }).catch(() => undefined); return () => { stale = true; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!f) return <div aria-busy="true" className="t-muted">{A("loading")}</div>;
  const cashier = takaToPaisa(v.cashier), approver = takaToPaisa(v.approver), pct = /^\d+(\.\d{1,2})?$/.test(v.pct.trim()) ? Math.round(Number(v.pct) * 100) : null;
  const w = /^\d+$/.test(v.w) ? Number(v.w) : null, h = /^\d+$/.test(v.h) ? Number(v.h) : null;
  const limitsChanged = cashier !== f.settings.cashierLimitPaisa || pct !== f.settings.cashierLimitBp || approver !== f.settings.approverLimitPaisa;
  const ok = cashier !== null && approver !== null && pct !== null && w !== null && h !== null && (!limitsChanged || v.reason.trim().length >= 10);
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16, maxWidth: 720 }} data-testid="limits">
      <b>{A("approval_limits")}</b>
      <span className="t-small t-secondary">{A("limits_note")}</span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
        <TextField label={A("cashier_limit_tk")} inputMode="decimal" value={v.cashier} onChange={(e) => setV({ ...v, cashier: e.target.value })} data-testid="cashier-limit" />
        <TextField label={A("cashier_limit_pct")} inputMode="decimal" value={v.pct} onChange={(e) => setV({ ...v, pct: e.target.value })} data-testid="cashier-pct" />
        <TextField label={A("approver_limit_tk")} inputMode="decimal" value={v.approver} onChange={(e) => setV({ ...v, approver: e.target.value })} data-testid="approver-limit" />
      </div>
      {limitsChanged && <TextArea label={A("why_limits")} hint={A("reason_hint")} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} data-testid="limits-reason" />}
      <b>{A("label_page")}</b>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <TextField label={A("label_w")} inputMode="numeric" value={v.w} onChange={(e) => setV({ ...v, w: e.target.value })} data-testid="label-w" />
        <TextField label={A("label_h")} inputMode="numeric" value={v.h} onChange={(e) => setV({ ...v, h: e.target.value })} data-testid="label-h" />
      </div>
      <span className="t-small t-muted">{A("label_note", { w: F.n(f.settings.labelWidthMm), h: F.n(f.settings.labelHeightMm) })}</span>
      <span><Button variant="primary" icon="save" data-testid="limits-save" disabled={busy || !s.online || !ok}
        onClick={async () => {
          setBusy(true);
          try { show(await adm.settings({ cashierLimitPaisa: cashier!, cashierLimitBp: pct!, approverLimitPaisa: approver!, labelWidthMm: w!, labelHeightMm: h!, receiptFormat: f.settings.receiptFormat ?? "a5", rxFormat: f.settings.rxFormat ?? "a5", paymentMethods: f.settings.paymentMethods, ...(limitsChanged ? { reason: v.reason.trim() } : {}) }, key)); setKey(crypto.randomUUID()); toast(A("saved"), "check"); }
          catch (e) { toast(E(e), "triangle-alert"); } finally { setBusy(false); }
        }}>{A("save")}</Button></span>
    </Card>
  );
}
