"use client";
/* E1 (ADR 0022): "Where will you have your tests?" — the doctor's portable orders; for one waiting for a centre, the
   network centres that offer its tests (sorted by price or turnaround; at the centre or home collection), each with
   what it does not offer, its turnaround and the total at its own prices; the choice; then the order's tracker (only
   the doctor, the patient and the chosen centre see it). Choosing needs the network and says so. */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { CentreOffers, PortableOrderView } from "@setu/contracts";
import { format } from "@setu/domain";
import { Icon, Pill, Segmented } from "@setu/ui";
import { Shell } from "../../components/Shell";
import { patient } from "../../lib/api";
import { errText, useLang } from "../../lib/lang";

export default function TestsPage() {
  const { lang, T } = useLang();
  const [orders, setOrders] = useState<PortableOrderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => patient.portableOrders().then((r) => setOrders(r.items)).catch((e) => setError(errText(lang, e, T))), [lang, T]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Shell>
      <h1 className="pa-h2">{T("tests_title")}</h1>
      {error && <span className="pa-err" role="alert"><Icon name="circle-x" size={16} />{error}</span>}
      {orders === null && !error && <p className="pa-sub">{T("loading")}</p>}
      {orders?.length === 0 && <p className="pa-sub">{T("tests_none")}</p>}
      {orders?.map((o) => <OrderCard key={o.id} o={o} onChange={(v) => setOrders((xs) => xs?.map((x) => (x.id === v.id ? v : x)) ?? null)} />)}
    </Shell>
  );
}

function OrderCard({ o, onChange }: { o: PortableOrderView; onChange: (v: PortableOrderView) => void }) {
  const { lang, T } = useLang();
  const bn = lang === "bn";
  const nm = (en: string | null, b: string | null) => (bn ? b ?? en : en ?? b) ?? "";
  const tone = o.status === "active" ? "pend" : o.status === "accepted" ? "ok" : o.status === "declined" ? "bad" : o.status === "partially-accepted" ? "warn" : "info";
  return (
    <section className="pa-card" data-portable={o.status} aria-label={o.number}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <b style={{ display: "block" }}>{T("tests_from", { doctor: nm(o.origin.doctorEn, o.origin.doctorBn) })}</b>
          <span className="pa-meta">{nm(o.origin.facilityEn, o.origin.facilityBn)} · {format.date(o.createdAt, bn)} · <span className="num" style={{ whiteSpace: "nowrap" }}>{o.number}</span></span>
        </div>
        <Pill tone={tone}>{T(`po_${o.status}`)}</Pill>
      </div>
      <ul className="pa-meta" style={{ margin: 0, paddingLeft: 18 }}>
        {o.items.map((i) => (
          <li key={i.id} data-item={i.testCode} data-status={i.status}>
            <b>{bn ? i.nameBn : i.nameEn}</b>{i.unitPaisa !== null ? ` · ${format.takaFromPaisa(i.unitPaisa, { bn })}` : ""}
            {i.status === "accepted" ? ` · ${T("po_item_accepted")}` : i.status === "declined" ? ` · ${i.notOffered ? T("po_item_not_offered") : T("po_item_declined", { reason: i.declineReason ?? "" })}` : ""}
          </li>
        ))}
      </ul>
      {o.centre && <span className="pa-sub">{T("tests_centre", { centre: nm(o.centre.facilityEn, o.centre.facilityBn), how: T(o.centre.collection === "home" ? "tests_home" : "tests_at_centre") })}</span>}
      {/* E3 (ADR 0023): the centre's bill — paid by the bKash link the centre sent, or at the centre */}
      {o.bill && (
        <div className="pa-why" data-bill={o.bill.status}>
          {o.bill.status === "not-billed" ? T("tests_bill_pending", { total: format.takaFromPaisa(o.bill.totalPaisa, { bn }) })
            : T("tests_bill", { total: format.takaFromPaisa(o.bill.totalPaisa, { bn }), paid: format.takaFromPaisa(o.bill.paidPaisa, { bn }) })}
          {o.bill.paidPaisa >= o.bill.totalPaisa && o.bill.totalPaisa > 0 && o.bill.status !== "not-billed" ? <><br /><b>{T("tests_paid")}</b></>
            : o.bill.payUrl ? <><br /><a className="pa-btn pa-btn-primary" href={o.bill.payUrl}>{T("tests_pay_bkash")}</a></>
            : <><br /><span className="pa-note">{T("tests_pay_centre")}</span></>}
        </div>
      )}
      {o.resultReady && <Link className="pa-btn" href="/timeline" data-result-ready><Icon name="test-tube" size={18} />{T("tests_result_ready")}</Link>}
      {o.canChoose && <Choose o={o} onChosen={onChange} />}
      {o.status === "partially-accepted" || o.status === "declined" ? <span className="pa-note">{T("tests_declined_note")}</span> : null}
      <details>
        <summary className="pa-label" style={{ cursor: "pointer" }}>{T("tests_tracker")}</summary>
        <ol className="pa-meta" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {o.steps.map((x, i) => <li key={i}>{T(`po_step_${x.step}`)} · {format.dateTime(x.at, bn)}</li>)}
        </ol>
        <span className="pa-note">{T("tests_visible")}</span>
      </details>
    </section>
  );
}

function Choose({ o, onChosen }: { o: PortableOrderView; onChosen: (v: PortableOrderView) => void }) {
  const { lang, T, n } = useLang();
  const bn = lang === "bn";
  const [sort, setSort] = useState<"price" | "turnaround">("price");
  const [collection, setCollection] = useState<"centre" | "home">("centre");
  const [offers, setOffers] = useState<CentreOffers | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine); on();
    addEventListener("online", on); addEventListener("offline", on);
    return () => { removeEventListener("online", on); removeEventListener("offline", on); };
  }, []);
  useEffect(() => { setOffers(null); patient.centres(o.id, sort, collection).then(setOffers).catch((e) => setError(errText(lang, e, T))); }, [o.id, sort, collection, lang, T]);
  const pick = async (organizationId: string) => {
    setBusy(true); setError(null);
    try { onChosen(await patient.choose(o.id, { organizationId, collection }, crypto.randomUUID())); } catch (e) { setError(errText(lang, e, T)); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }} data-choose>
      <span className="pa-label">{T("tests_where")}</span>
      <Segmented label={T("tests_sort")} value={sort} onChange={setSort} options={[{ value: "price", label: T("tests_sort_price") }, { value: "turnaround", label: T("tests_sort_tat") }]} />
      <Segmented label={T("tests_collection")} value={collection} onChange={setCollection} options={[{ value: "centre", label: T("tests_at_centre") }, { value: "home", label: T("tests_home") }]} />
      {offers?.centres.length === 0 && <span className="pa-sub">{T("tests_no_centres")}</span>}
      {offers?.centres.map((c) => (
        <div key={c.organizationId} className="pa-card" style={{ padding: 12 }} data-centre={c.organizationId}>
          <b>{bn ? c.nameBn ?? c.nameEn : c.nameEn}</b>
          {c.area && <span className="pa-meta">{c.area}</span>}
          <span className="pa-meta">{T("tests_offer", { n: n(c.offered.length), of: n(o.items.length), tat: n(c.turnaroundHours) })}</span>
          {c.notOffered.length > 0 && <span className="pa-meta">{T("tests_missing", { tests: c.notOffered.map((id) => { const i = o.items.find((x) => x.id === id); return i ? (bn ? i.nameBn : i.nameEn) : ""; }).join(", ") })}</span>}
          <span className="pa-label">{format.takaFromPaisa(c.totalPaisa, { bn })}{c.homeFeePaisa ? ` · ${T("tests_home_fee", { fee: format.takaFromPaisa(c.homeFeePaisa, { bn }) })}` : ""}</span>
          <button type="button" className="pa-btn pa-btn-primary" disabled={busy || !online} onClick={() => pick(c.organizationId)}>{online ? T("tests_choose") : T("offline_need_net")}</button>
        </div>
      ))}
      {error && <span className="pa-err" role="alert"><Icon name="circle-x" size={16} />{error}</span>}
    </div>
  );
}
