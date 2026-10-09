"use client";
/* net/lab — the portable lab order (ADR 0022, Journey E1–E2; prototype Setu Connected Care, scenario "lab").
   "From this facility": this facility's portable orders and their tracker; the desk chooses a centre for a patient
   without the app (recorded as for the patient); the doctor re-orders declined tests elsewhere.
   "For this facility": orders a patient chose this facility for — the lab accepts each test or declines it with a
   reason (10+ characters); a test it does not offer is declined for that. Accepted tests become this facility's own
   orders (its lab and bill). The server decides every step; the screen shows its answers. */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { CentreOffers, PortableOrderView } from "@setu/contracts";
import { format } from "@setu/domain";
import { fill } from "@setu/i18n";
import { Button, Callout, Card, PageState, Pill, Segmented, useToast } from "@setu/ui";
import { ApiFailure, portable } from "../../lib/api";
import { ReportTable } from "./Shared";
import { useSession } from "../../lib/session";

function useN() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) => fill(s.t("netApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}
const TONE: Record<string, "pend" | "info" | "ok" | "warn" | "bad" | "neu"> = { active: "pend", "centre-chosen": "info", accepted: "ok", "partially-accepted": "warn", declined: "bad", revoked: "neu" };

export function NetLab() {
  const s = useSession(); const N = useN();
  const [tab, setTab] = useState<"origin" | "centre">("origin");
  // the doctor's inbox links an order here (?order=<id>)
  const [open, setOpen] = useState<string | null>(useSearchParams().get("order"));
  useEffect(() => { s.setPatient(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="module-page" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{N("po_title")}</h1>
      <span className="t-small t-muted">{N("po_intro")}</span>
      {!open && <Segmented label={N("po_title")} value={tab} onChange={setTab} options={[{ value: "origin", label: N("po_tab_origin") }, { value: "centre", label: N("po_tab_centre") }]} />}
      {open ? <Detail id={open} mode={tab} onBack={() => setOpen(null)} /> : <List mode={tab} onOpen={setOpen} />}
    </div>
  );
}

function List({ mode, onOpen }: { mode: "origin" | "centre"; onOpen: (id: string) => void }) {
  const s = useSession(); const N = useN();
  const [items, setItems] = useState<PortableOrderView[] | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => { setItems(null); (mode === "origin" ? portable.list() : portable.queue()).then((r) => setItems(r.items)).catch(() => setFailed(true)); }, [mode]);
  const bn = s.numerals === "bn";
  if (failed) return <PageState icon="circle-alert" title={N("error")} />;
  if (!items) return <PageState icon="loader" title="…" />;
  if (!items.length) return <PageState icon="inbox" title={N(mode === "origin" ? "po_none_origin" : "po_none_centre")} />;
  return <>{items.map((o) => (
    <Card key={o.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: 12, flexWrap: "wrap" }} data-testid="portable-item" data-number={o.number}>
      <div style={{ flex: 1, minWidth: 240 }}>
        <b className="num">{o.number}</b> · {s.lang === "bn" ? o.patient.nameBn : o.patient.nameEn ?? o.patient.nameBn}
        <div className="t-small">{format.dateTime(o.createdAt, bn)} · {o.items.map((i) => (s.lang === "bn" ? i.nameBn : i.nameEn)).join(", ")}
          {o.centre ? ` · ${(s.lang === "bn" ? o.centre.facilityBn ?? o.centre.facilityEn : o.centre.facilityEn) ?? ""}` : ""}</div>
      </div>
      <Pill tone={TONE[o.status] ?? "neu"}>{N(`po_st_${o.status}`)}</Pill>
      <Button variant="primary" icon="folder-open" onClick={() => onOpen(o.id)}>{N("open")}</Button>
    </Card>
  ))}</>;
}

function Detail({ id, mode, onBack }: { id: string; mode: "origin" | "centre"; onBack: () => void }) {
  const s = useSession(); const N = useN(); const toast = useToast();
  const [o, setO] = useState<PortableOrderView | null>(null); const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const msg = (e: unknown) => (e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : N("error"));
  const load = useCallback(() => portable.get(id).then(setO).catch((e) => setError(msg(e))), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  const bn = s.numerals === "bn";
  const name = (en: string | null, b: string | null) => (s.lang === "bn" ? b ?? en : en ?? b) ?? "";
  const run = async (fn: () => Promise<PortableOrderView>, done: string) => { setBusy(true); setError(null); try { setO(await fn()); toast(done, "check"); } catch (e) { setError(msg(e)); } finally { setBusy(false); } };
  if (!o) return <>{error ? <Callout tone="bad" role="alert">{error}</Callout> : <PageState icon="loader" title="…" />}</>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="portable-detail" data-status={o.status}>
      <span><Button variant="ghost" icon="arrow-left" onClick={onBack}>{N("back")}</Button></span>
      <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <b className="t-h3 num">{o.number}</b><Pill tone={TONE[o.status] ?? "neu"}>{N(`po_st_${o.status}`)}</Pill>
        </div>
        <span className="t-small">{N("po_patient", { name: name(o.patient.nameEn, o.patient.nameBn), age: o.patient.ageYears ?? "—", sex: N(`sex_${o.patient.sex}`) })}{o.patient.phone ? ` · ${s.n(o.patient.phone)}` : ""}</span>
        <span className="t-small">{N("po_ordered_by", { doctor: name(o.origin.doctorEn, o.origin.doctorBn), facility: name(o.origin.facilityEn, o.origin.facilityBn) })}</span>
        {o.centre && <span className="t-small">{N("po_centre", { centre: name(o.centre.facilityEn, o.centre.facilityBn), how: N(o.centre.collection === "home" ? "po_home" : "po_at_centre"), by: N(o.chosenBy === "desk" ? "po_by_desk" : "po_by_patient") })}</span>}
        <span className="t-small t-muted">{N("po_visible")}</span>
      </Card>
      <Card style={{ padding: 16 }}>
        <table className="table">
          <thead><tr><th>{N("col_test")}</th><th>{N("po_col_price")}</th><th>{N("po_col_status")}</th></tr></thead>
          <tbody>{o.items.map((i) => (
            <tr key={i.id} data-item={i.testCode} data-status={i.status}>
              <td>{s.lang === "bn" ? i.nameBn : i.nameEn}</td>
              <td className="num">{i.unitPaisa !== null ? format.takaFromPaisa(i.unitPaisa, { bn }) : "—"}</td>
              <td>{i.status === "pending" ? N("po_item_pending") : i.status === "accepted" ? N("po_item_accepted") : i.notOffered ? N("po_item_not_offered") : N("po_item_declined", { reason: i.declineReason ?? "" })}
                {i.reorderedToId ? ` · ${N("po_item_reordered")}` : ""}</td>
            </tr>
          ))}</tbody>
        </table>
      </Card>
      <Card style={{ padding: 16 }}>
        <b>{N("po_tracker")}</b>
        <ol className="t-small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {o.steps.map((x, i) => <li key={i}>{N(`po_step_${x.step}`)} · {format.dateTime(x.at, bn)}{x.by ? ` · ${x.by === "desk" ? N("po_by_desk") : x.by === "patient" ? N("po_by_patient") : x.by}` : ""}</li>)}
        </ol>
      </Card>
      {error && <Callout tone="bad" role="alert">{error}</Callout>}
      {mode === "origin" && o.resultReady && <ResultPanel id={o.id} />}
      {mode === "origin" && o.canChoose && <ChooseForPatient o={o} busy={busy} onChoose={(organizationId, collection) => run(() => portable.choose(o.id, { organizationId, collection }, crypto.randomUUID()), N("po_chosen"))} />}
      {mode === "origin" && o.reorderable.length > 0 && s.me?.role === "doctor" && (
        <span><Button icon="repeat" disabled={busy || !s.online} onClick={() => run(() => portable.reorder(o.id, crypto.randomUUID()), N("po_reordered"))} data-testid="po-reorder">{N("po_reorder", { n: o.reorderable.length })}</Button></span>
      )}
      {mode === "centre" && o.canDecide && <Decide o={o} busy={busy} onDecide={(items) => run(() => portable.decide(o.id, { items }, crypto.randomUUID()), N("po_decided"))} />}
    </div>
  );
}

function ChooseForPatient({ o, busy, onChoose }: { o: PortableOrderView; busy: boolean; onChoose: (organizationId: string, collection: "centre" | "home") => void }) {
  const s = useSession(); const N = useN();
  const [sort, setSort] = useState<"price" | "turnaround">("price");
  const [collection, setCollection] = useState<"centre" | "home">("centre");
  const [offers, setOffers] = useState<CentreOffers | null>(null);
  useEffect(() => { portable.centres(o.id, sort, collection).then(setOffers).catch(() => setOffers({ orderId: o.id, sort, collection, centres: [] })); }, [o.id, sort, collection]);
  const bn = s.numerals === "bn";
  return (
    <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }} data-testid="po-choose">
      <b>{N("po_choose_title")}</b>
      <span className="t-small t-muted">{N("po_choose_hint")}</span>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Segmented label={N("po_sort")} value={sort} onChange={setSort} options={[{ value: "price", label: N("po_sort_price") }, { value: "turnaround", label: N("po_sort_tat") }]} />
        <Segmented label={N("po_collection")} value={collection} onChange={setCollection} options={[{ value: "centre", label: N("po_at_centre") }, { value: "home", label: N("po_home") }]} />
      </div>
      {offers?.centres.length === 0 && <span className="t-small">{N("po_no_centres")}</span>}
      {offers?.centres.map((c) => (
        <div key={c.organizationId} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--border-subtle)", paddingTop: 8 }} data-centre={c.organizationId}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <b>{s.lang === "bn" ? c.nameBn ?? c.nameEn : c.nameEn}</b>{c.area ? <span className="t-small t-muted"> · {c.area}</span> : null}
            <div className="t-small">{N("po_offer", { n: c.offered.length, of: o.items.length, tat: c.turnaroundHours })}{c.notOffered.length ? ` · ${N("po_offer_missing", { tests: c.notOffered.map((iid) => o.items.find((i) => i.id === iid)?.nameEn ?? "").join(", ") })}` : ""}</div>
          </div>
          <b className="num">{format.takaFromPaisa(c.totalPaisa, { bn })}</b>
          <Button disabled={busy || !s.online} onClick={() => onChoose(c.organizationId, collection)}>{N("po_choose")}</Button>
        </div>
      ))}
    </Card>
  );
}

function Decide({ o, busy, onDecide }: { o: PortableOrderView; busy: boolean; onDecide: (items: { itemId: string; accept: boolean; reason?: string }[]) => void }) {
  const s = useSession(); const N = useN();
  const offered = o.items.filter((i) => i.unitPaisa !== null);
  const [d, setD] = useState<Record<string, { accept: boolean; reason: string }>>(() => Object.fromEntries(offered.map((i) => [i.id, { accept: true, reason: "" }])));
  const short = offered.some((i) => !d[i.id]!.accept && d[i.id]!.reason.trim().length < 10);
  return (
    <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }} data-testid="po-decide">
      <b>{N("po_decide_title")}</b>
      {offered.map((i) => (
        <div key={i.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }} data-decide={i.testCode}>
          <span style={{ minWidth: 160 }}>{s.lang === "bn" ? i.nameBn : i.nameEn}</span>
          <Segmented label={i.nameEn} value={d[i.id]!.accept ? "accept" : "decline"} onChange={(v) => setD({ ...d, [i.id]: { ...d[i.id]!, accept: v === "accept" } })}
            options={[{ value: "accept", label: N("po_accept") }, { value: "decline", label: N("po_decline") }]} />
          {!d[i.id]!.accept && <input className="input" style={{ flex: 1, minWidth: 220 }} placeholder={N("po_reason_ph")} aria-label={N("po_reason_ph")} value={d[i.id]!.reason} onChange={(e) => setD({ ...d, [i.id]: { ...d[i.id]!, reason: e.target.value } })} />}
        </div>
      ))}
      {o.items.some((i) => i.unitPaisa === null) && <span className="t-small t-muted">{N("po_not_offered_note", { tests: o.items.filter((i) => i.unitPaisa === null).map((i) => i.nameEn).join(", ") })}</span>}
      <span><Button variant="primary" icon="check" disabled={busy || !s.online || short} onClick={() => onDecide(offered.map((i) => ({ itemId: i.id, accept: d[i.id]!.accept, ...(d[i.id]!.accept ? {} : { reason: d[i.id]!.reason.trim() }) })))}>{N("po_send_decision")}</Button></span>
      {short && <span className="t-small t-muted">{N("po_reason_rule")}</span>}
    </Card>
  );
}

/** E3 (ADR 0023): the centre's report, read through the order (only that report) */
function ResultPanel({ id }: { id: string }) {
  const s = useSession(); const N = useN();
  const [r, setR] = useState<Awaited<ReturnType<typeof portable.report>> | null>(null); const [open, setOpen] = useState(false); const [error, setError] = useState<string | null>(null);
  const show = () => { setOpen(true); portable.report(id).then(setR).catch((e) => setError(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : N("error"))); };
  if (!open) return <span><Button variant="primary" icon="test-tube" onClick={show} data-testid="po-result">{N("po_view_result")}</Button></span>;
  if (error) return <Callout tone="bad" role="alert">{error}</Callout>;
  return r ? <ReportTable r={{ ...r, consentId: "" }} /> : <PageState icon="loader" title="…" />;
}
