"use client";
/* ph/otc — journey P4 (ADR 0009). Ported from docs/prototype/Setu Pharmacy.dc.html ("OTC & walk-in sale"). A sale
   without a visit: an optional walk-in name / phone (the phone only for a bKash / Nagad link), medicines picked FEFO
   by the server from the counter, the sale class on every item — OTC sells, prescription-only needs a photo of the
   prescription, controlled never sells over the counter — then Complete sale (stock moves now) and the payment screen
   (the pharmacist's shift). Every figure is the server's. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { OtcView, StockList } from "@setu/contracts";
import { Button, Callout, Card, PageState, Pill, TextField, useToast } from "@setu/ui";
import { pharm } from "../../lib/api";
import { useSession } from "../../lib/session";
import { ClassPill, NeedsServer, renewKey, toInt, useErr, useFmt, useP } from "./common";

const PHOTO_MAX = 3 * 1024 * 1024;

export function PhOtc() {
  const inv = useSearchParams().get("inv");
  return inv ? <Sale id={inv} /> : <Start />;
}

function Start() {
  const s = useSession(); const P = useP(); const E = useErr(); const router = useRouter(); const toast = useToast();
  const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [busy, setBusy] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const phoneOk = phone.trim() === "" || /^01[3-9]\d{8}$/.test(phone.trim());
  return (
    <div data-screen="ph/otc" style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 560 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{P("otc_title")}</h1>
      <NeedsServer />
      <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14 }}>
        <TextField label={P("buyer_name")} hint={P("optional")} value={name} onChange={(e) => setName(e.target.value)} data-testid="buyer-name" />
        <TextField label={P("buyer_phone")} hint={P("buyer_phone_hint")} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={phoneOk ? undefined : P("phone_invalid")} data-testid="buyer-phone" />
        <Button variant="primary" icon="shopping-cart" data-testid="start-sale" disabled={!s.online || busy || !phoneOk}
          onClick={async () => {
            setBusy(true);
            try { const x = await pharm.otcNew({ ...(name.trim() ? { buyerName: name.trim() } : {}), ...(phone.trim() ? { buyerPhone: phone.trim() } : {}) }, key); router.push(`/m/ph/otc?inv=${encodeURIComponent(x.bill.invoice.id)}`); }
            catch (e) { toast(E(e), "triangle-alert"); setBusy(false); }
          }}>{P("start_sale")}</Button>
      </Card>
    </div>
  );
}

function Sale({ id }: { id: string }) {
  const s = useSession(); const P = useP(); const F = useFmt(); const E = useErr(); const router = useRouter(); const toast = useToast();
  const [v, setV] = useState<OtcView | null>(null); const [failed, setFailed] = useState(false);
  const [q, setQ] = useState(""); const [found, setFound] = useState<StockList["items"]>([]);
  const [pick, setPick] = useState<string | null>(null); const [qty, setQty] = useState("1");
  const [busy, setBusy] = useState(false);
  const [issueKey, setIssueKey] = useState(() => crypto.randomUUID());
  // every change to the sale runs after the one before, on the latest version (its rev) — nothing is dropped while busy
  const latest = useRef<OtcView | null>(null); const chain = useRef<Promise<unknown>>(Promise.resolve()); const lastErr = useRef<unknown>(null);
  const show = (x: OtcView) => { latest.current = x; setV(x); };
  const load = useCallback(async () => { try { show(await pharm.otc(id)); } catch { setFailed(true); } }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    let stale = false; // an older answer never replaces a newer search
    const t = setTimeout(() => { pharm.stock(q.trim(), "all").then((r) => { if (!stale) setFound(r.items.slice(0, 8)); }).catch(() => { if (!stale) setFound([]); }); }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [q]);
  if (failed) return <PageState icon="shopping-cart" title={P("error_generic")} />;
  if (!v) return <div aria-busy="true" className="t-muted">{P("loading")}</div>;
  const inv = v.bill.invoice;
  const draft = inv.status === "draft";
  const run = (f: (rev: number) => Promise<OtcView>) => new Promise<boolean>((done) => {
    chain.current = chain.current.then(async () => {
      setBusy(true);
      try { show(await f(latest.current!.bill.invoice.rev)); done(true); }
      catch (e) { lastErr.current = e; toast(E(e), "triangle-alert"); await load(); done(false); }
      finally { setBusy(false); }
    });
  });
  const picked = found.find((x) => x.medicine.key === pick) ?? null;
  const onPhoto = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > PHOTO_MAX) { toast(P("photo_too_big"), "triangle-alert"); return; }
    const type = file.type === "image/png" ? "image/png" : file.type === "image/jpeg" ? "image/jpeg" : null;
    if (!type) { toast(P("photo_type"), "triangle-alert"); return; }
    const data = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] ?? ""); r.onerror = rej; r.readAsDataURL(file); });
    await run((rev) => pharm.otcPhoto(id, { rev, contentType: type, dataBase64: data }));
  };

  return (
    <div data-screen="ph/otc" data-invoice={id} data-status={inv.status} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{P("otc_title")}</h1>
        <b className="num">{inv.number ?? P("draft")}</b>
        <Pill tone={draft ? "draft" : inv.status === "balanced" ? "ok" : "warn"}>{P(`bs_${inv.status}`)}</Pill>
        <span className="t-small t-secondary">{inv.buyer?.name ?? P("walk_in")}{inv.buyer?.phone ? ` · ${s.n(`0${inv.buyer.phone}`)}` : ""}</span>
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="plus" onClick={() => router.push("/m/ph/otc")}>{P("new_sale")}</Button>
      </div>
      <NeedsServer />

      {draft && (
        <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14 }}>
          <TextField label={P("find_medicine")} value={q} onChange={(e) => { setQ(e.target.value); setPick(null); }} data-testid="otc-search" />
          {found.length > 0 && !picked && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid="otc-results">
              {found.map((x) => (
                <button key={x.medicine.key} type="button" className="card" data-medicine={x.medicine.key} style={{ display: "flex", gap: 10, alignItems: "center", padding: 8, textAlign: "left", cursor: "pointer" }} onClick={() => setPick(x.medicine.key)}>
                  <span style={{ flex: 1 }}><b>{x.medicine.brand} {x.medicine.strength}</b> <span className="t-small t-secondary">{x.medicine.generic}</span></span>
                  <span className="t-small num">{P("at_counter_n", { n: x.counterQty })}</span>
                  <ClassPill c={x.medicine.saleClass} />
                </button>
              ))}
            </div>
          )}
          {picked && (
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
              <span style={{ flex: 1, minWidth: 200 }}><b>{picked.medicine.brand} {picked.medicine.strength}</b> <ClassPill c={picked.medicine.saleClass} /></span>
              <TextField label={P("qty")} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="otc-qty" />
              <Button variant="primary" icon="plus" data-testid="otc-add" disabled={!s.online || busy || !toInt(qty)}
                onClick={async () => { if (await run((rev) => pharm.otcAdd(id, { rev, medicineKey: picked.medicine.key, qty: toInt(qty)! }))) { setQ(""); setPick(null); setQty("1"); } }}>{P("add")}</Button>
            </div>
          )}
          {picked?.medicine.saleClass === "ctrl" && <Callout tone="bad" icon="lock">{P("ctrl_never")}</Callout>}
          {picked?.medicine.saleClass === "rx" && !v.rxPhoto && <Callout tone="warn" icon="camera">{P("rx_needs_photo")}</Callout>}
        </Card>
      )}

      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table className="table" style={{ width: "100%" }} data-testid="otc-lines">
          <thead><tr><th>{P("medicine")}</th><th>{P("batch")}</th><th className="num">{P("qty")}</th><th className="num">{P("mrp")}</th><th className="num">{P("total")}</th><th /></tr></thead>
          <tbody>
            {v.bill.lines.length === 0 && <tr><td colSpan={6} className="t-muted">{P("no_lines")}</td></tr>}
            {v.bill.lines.map((l) => (
              <tr key={l.id} data-line={l.id}>
                <td>{s.lang === "bn" ? l.nameBn : l.nameEn}</td>
                <td className="num">{l.batch ? `${l.batch.batchNo} · ${P("exp")} ${F.day(l.batch.expiry)}` : "—"}</td>
                <td className="num">{F.n(l.qty)}</td><td className="num">{F.tk(l.unitPaisa ?? 0)}</td><td className="num">{F.tk(l.totalPaisa)}</td>
                <td>{draft && <Button size="sm" icon="trash-2" aria-label={P("remove")} disabled={!s.online || busy} onClick={() => void run((rev) => pharm.otcRemove(id, l.id, rev))} />}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={4}><b>{P("total")}</b>{inv.vatPaisa > 0 && <span className="t-small t-muted"> · {P("vat")} {F.tk(inv.vatPaisa)}</span>}</td><td className="num"><b data-testid="otc-total">{F.tk(inv.totalPaisa)}</b></td><td /></tr></tfoot>
        </table>
      </Card>

      <Card style={{ display: "flex", gap: 12, alignItems: "center", padding: 12, flexWrap: "wrap" }} data-testid="rx-photo">
        <b>{P("rx_photo")}</b>
        {v.rxPhoto
          ? <><Pill tone="ok" icon="check">{P("photo_added")}</Pill><a href={pharm.otcPhotoSrc(id)} target="_blank" rel="noreferrer"><img src={pharm.otcPhotoSrc(id)} alt={P("rx_photo")} style={{ height: 64, borderRadius: 4, border: "1px solid var(--border-default)" }} /></a></>
          : draft
            ? <label className="btn" style={{ cursor: "pointer", position: "relative" }}><input type="file" accept="image/jpeg,image/png" capture="environment" style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }} data-testid="photo-input" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void onPhoto(f); }} />{P("add_photo")}</label>
            : <span className="t-small t-muted">{P("no_photo")}</span>}
        <span className="t-small t-secondary">{P("photo_rule")}</span>
      </Card>

      {draft && v.blockers.filter((b) => b.code !== "no_lines").map((b, i) => <Callout key={i} tone={b.code === "stock_short" ? "warn" : "bad"} icon="triangle-alert">{P(`otc_b_${b.code}`)}</Callout>)}

      <Card style={{ display: "flex", gap: 12, alignItems: "center", padding: 12, flexWrap: "wrap" }}>
        {draft && (
          <Button variant="primary" icon="check-check" data-testid="complete-sale" disabled={!s.online || busy || v.blockers.length > 0}
            onClick={async () => { if (await run((rev) => pharm.otcIssue(id, rev, issueKey))) { setIssueKey(crypto.randomUUID()); toast(P("sale_done"), "check"); } else if (renewKey(lastErr.current)) setIssueKey(crypto.randomUUID()); }}>
            {P("complete_sale")}
          </Button>
        )}
        {(inv.status === "issued" || inv.status === "partially-paid") && <Button variant="primary" icon="wallet" data-testid="take-payment" onClick={() => router.push(`/m/ph/pay?inv=${encodeURIComponent(id)}`)}>{P("take_payment")}</Button>}
        {inv.status === "balanced" && <Button icon="receipt" onClick={() => router.push(`/m/ph/receipt?inv=${encodeURIComponent(id)}`)}>{P("receipt")}</Button>}
        <span className="t-small t-muted">{P("otc_no_discount")}</span>
      </Card>
    </div>
  );
}
