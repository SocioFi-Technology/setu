"use client";
/* nur/mar — walkthrough B5 (issues #1, #24). Ported from docs/prototype/Setu Nursing.dc.html (screen "mar"): today's
   active inpatient orders, one row per order with its dose slots (scheduled / due / overdue / given / held / refused /
   missed), PRN doses with the 24-hour cap, the multi-dose vial's opened-at, the allergy block, stopped and superseded
   orders struck through. A slot opens the dose dialog: outcome, the five checks, the time given (never in the future),
   the source (ward stock or the patient's own supply, shown distinctly), a reason when late / early / not given, and
   for high-alert or controlled drugs a witness (a second nurse or a doctor, never the giver) with their PIN, checked in
   the dose's own transaction. Doses need the server: nothing here waits in the outbox, and the slot turns Given only
   when the server answers. A wrong record is marked entered-in-error, never deleted. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { DoseRecord, MarOrder, MarView, WitnessList } from "@setu/contracts";
import { FIVE_CHECKS, SLOT_AHEAD_MAX_MS, dhakaDay, doseBlockers, doseTiming, format, type DoseOutcome, type FiveChecks } from "@setu/domain";
import { Button, Callout, Card, Dialog, Pill, Segmented, SelectField, TextArea, TextField, useToast, type Tone } from "@setu/ui";
import { ApiFailure, ward } from "../../lib/api";
import { useSession } from "../../lib/session";
import { WardPatientPicker, hhmm, useErr, useN, useWardBanner } from "./common";

const SLOT_TONE: Record<string, Tone> = { scheduled: "neu", due: "warn", overdue: "bad", given: "ok", held: "off", refused: "off", missed: "bad" };
const SLOT_ICON: Record<string, string> = { scheduled: "clock", due: "bell", overdue: "clock-alert", given: "circle-check", held: "pause", refused: "ban", missed: "circle-x" };

export function NurMar() {
  const enc = useSearchParams().get("enc"); const N = useN();
  if (!enc) return <WardPatientPicker screen="nur/mar" title={N("mar_title")} />;
  return <MarFor key={enc} enc={enc} />;
}

type Pick = { order: MarOrder; slot: string | null };

function MarFor({ enc }: { enc: string }) {
  const s = useSession(); const N = useN(); const err = useErr(); const toast = useToast();
  const [v, setV] = useState<MarView | null>(null); const [failed, setFailed] = useState<string | null>(null);
  const [pick, setPick] = useState<Pick | null>(null); const [vialFor, setVialFor] = useState<MarOrder | null>(null);
  const load = useCallback(async () => { try { setV(await ward.mar(enc)); setFailed(null); } catch (e) { setFailed(err(e)); } }, [enc]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); const t = setInterval(() => void load(), 60_000); return () => clearInterval(t); }, [load]);
  useWardBanner(v?.patient, v?.allergies, v?.bed ? `${v.bed.ward} · ${v.bed.name}` : null);
  if (failed && !v) return <Callout tone="warn" icon="triangle-alert">{failed}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{N("loading")}</div>;
  const active = v.orders.filter((o) => o.status === "active");
  const ended = v.orders.filter((o) => o.status !== "active");
  return (
    <div data-screen="nur/mar" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{N("mar_title")}</h1>
        <span className="t-small t-muted">{format.date(v.day, s.numerals === "bn")} · {N("mar_window", { n: v.windowMin })} · {s.L(v.sample.bn, v.sample.en)}</span>
      </div>
      {!s.online && <Callout tone="warn" icon="cloud-off" data-testid="mar-offline">{N("needs_connection")}</Callout>}
      {active.map((o) => <OrderRow key={o.id} o={o} day={v.day} onPick={(slot) => setPick({ order: o, slot })} onVial={() => setVialFor(o)} />)}
      {ended.map((o) => <OrderRow key={o.id} o={o} day={v.day} onPick={() => undefined} onVial={() => undefined} />)}
      <History v={v} onChanged={setV} />
      {vialFor && <VialDialog enc={enc} o={vialFor} onClose={() => setVialFor(null)} onDone={(nv, at) => { setV(nv); setVialFor(null); toast(N("vial_opened_toast", { t: hhmm(at, s.numerals === "bn") }), "flask-conical"); }} />}
      {pick && <DoseDialog v={v} pick={pick} onClose={() => setPick(null)} onDone={(nv) => { setV(nv); setPick(null); toast(N("recorded"), "badge-check"); }} onStale={load} />}
    </div>
  );
}

function OrderRow({ o, day, onPick, onVial }: { o: MarOrder; day: string; onPick: (slot: string | null) => void; onVial: () => void }) {
  const s = useSession(); const N = useN(); const bnNum = s.numerals === "bn";
  const ended = o.status !== "active";
  const capReached = o.prn && o.prnMaxPer24h !== null && o.givenLast24h >= o.prnMaxPer24h;
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14, opacity: ended ? 0.65 : 1, borderColor: o.allergyBlock ? "var(--danger-border)" : undefined }} data-order={o.medicine.key} data-order-id={o.id} data-order-status={o.status}>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <b style={{ textDecoration: ended ? "line-through" : undefined }}>{s.lang === "bn" ? o.medicine.brandBn : o.medicine.brand} {o.medicine.strength}</b>
        <span className="t-small">{o.doseText} · {o.route} · {o.prn ? N("prn") : o.times.join(", ")}</span>
        {o.medicine.highAlert && <Pill tone="crit" icon="triangle-alert">{N("high_alert")}</Pill>}
        {o.medicine.controlled && <Pill tone="crit" icon="lock">{N("controlled")}</Pill>}
        {o.medicine.multiDose && <Pill tone="info" icon="flask-conical">{N("multi_dose")}</Pill>}
        {!ended && !o.medicine.multiDose && <span className="t-small t-muted" data-ward-stock={o.wardStock}>{N("ward_stock_n", { n: o.wardStock })}</span>}
      </span>
      {o.status === "stopped" && o.stop && <span className="t-small" data-testid="order-stopped">{N("order_stopped", { name: s.lang === "bn" ? o.stop.by.nameBn : o.stop.by.nameEn, reason: o.stop.reason })} · {hhmm(o.stop.at, bnNum)}</span>}
      {o.status === "superseded" && <span className="t-small">{N("order_superseded")}</span>}
      {o.allergyBlock && <Callout tone="bad" icon="triangle-alert" data-testid="allergy-block">{N("allergy_block")}</Callout>}
      {o.earlierRegimenGiven.map((x, i) => <span key={i} className="t-small t-muted">{N("earlier_regimen", { t: hhmm(x.at, bnNum), dose: x.doseText })}</span>)}
      {o.medicine.multiDose && !ended && (
        <span className="t-small" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }} data-testid="vial">
          {o.vial ? <Pill tone={o.vial.source === "patient-supplied" ? "pend" : "neu"} icon="flask-conical">{N("vial_opened", { t: hhmm(o.vial.openedAt, bnNum), name: s.lang === "bn" ? o.vial.by.nameBn : o.vial.by.nameEn })}{o.vial.source === "patient-supplied" ? ` · ${N("source_patient")}` : ""}</Pill> : null}
          <Button size="sm" icon="flask-conical" onClick={onVial} disabled={!s.online} data-testid="open-vial">{N("open_vial")}</Button>
          <span className="t-muted">{N("ward_stock_n", { n: o.wardStock })}</span>
        </span>
      )}
      {!o.prn && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {o.slots.map((sl) => {
            const recorded = sl.record !== null;
            const actionable = !ended && !recorded && (sl.state === "due" || sl.state === "overdue" || sl.state === "scheduled") && new Date(sl.at).getTime() - Date.now() <= SLOT_AHEAD_MAX_MS;
            return (
              <button key={sl.at} type="button" className="card" data-slot={hhmm(sl.at, false)} data-slot-at={sl.at} data-slot-state={sl.state} data-slot-source={sl.record?.source ?? ""} disabled={!actionable || !s.online} onClick={() => onPick(sl.at)}
                style={{ padding: "6px 10px", display: "flex", flexDirection: "column", gap: 2, cursor: actionable && s.online ? "pointer" : "default", minWidth: 96 }}>
                <b className="num">{dhakaDay(new Date(sl.at)) !== day ? `${format.digits(dhakaDay(new Date(sl.at)).slice(8, 10) + "/" + dhakaDay(new Date(sl.at)).slice(5, 7), bnNum)} ` : ""}{hhmm(sl.at, bnNum)}</b>
                <Pill tone={SLOT_TONE[sl.state] ?? "neu"} icon={SLOT_ICON[sl.state]}>{N(`st_${sl.state}`)}</Pill>
                {sl.record && <span className="t-small t-muted">{s.lang === "bn" ? sl.record.by.nameBn : sl.record.by.nameEn}{sl.record.administeredAt ? ` · ${hhmm(sl.record.administeredAt, bnNum)}` : ""}</span>}
                {sl.record?.source === "patient-supplied" && <Pill tone="pend" icon="user-round">{N("source_patient")}</Pill>}
                {sl.record?.witness && <span className="t-small t-muted">✓ {s.lang === "bn" ? sl.record.witness.nameBn : sl.record.witness.nameEn}</span>}
                {sl.record?.amountGiven && <span className="t-small num">{sl.record.amountGiven}</span>}
                {sl.errored.map((x) => <span key={x.id} className="t-small" data-slot-errored={x.id} style={{ color: "var(--warning-fg)", maxWidth: 160 }}>{N("errored_before", { t: hhmm(x.administeredAt, bnNum), name: s.lang === "bn" ? x.by.nameBn : x.by.nameEn })}</span>)}
              </button>
            );
          })}
        </div>
      )}
      {o.prn && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {o.prnMaxPer24h !== null && <span data-prn-count={o.givenLast24h}><Pill tone={capReached ? "bad" : "neu"}>{N("prn_cap", { n: o.givenLast24h, max: o.prnMaxPer24h })}</Pill></span>}
          {!ended && <Button size="sm" icon="pill" disabled={capReached || !s.online} onClick={() => onPick(null)} data-testid="give-prn">{N("give_prn")}</Button>}
          {o.prnRecords.map((r) => <span key={r.id} className="t-small t-muted">{hhmm(r.administeredAt, bnNum)} · {N(`st_${r.status}`)}{r.source === "patient-supplied" ? ` · ${N("source_patient")}` : ""}</span>)}
        </div>
      )}
    </Card>
  );
}

const localInput = (d: Date) => { const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

function DoseDialog({ v, pick, onClose, onDone, onStale }: { v: MarView; pick: Pick; onClose: () => void; onDone: (v: MarView) => void; onStale: () => Promise<void> }) {
  const s = useSession(); const N = useN(); const err = useErr();
  const o = pick.order;
  const [outcome, setOutcome] = useState<DoseOutcome>("given");
  const [checks, setChecks] = useState<FiveChecks>({ patient: false, drug: false, dose: false, route: false, time: false });
  const [at, setAt] = useState(localInput(new Date()));
  const [source, setSource] = useState<"ward-stock" | "patient-supplied">("ward-stock");
  const [reason, setReason] = useState(""); const [amount, setAmount] = useState("");
  const [witnesses, setWitnesses] = useState<WitnessList["items"]>([]); const [witnessId, setWitnessId] = useState(""); const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [serverBlockers, setServerBlockers] = useState<string[]>([]);
  const key = useRef(crypto.randomUUID()); const inFlight = useRef(false);
  const needsWitness = o.medicine.highAlert || o.medicine.controlled;
  useEffect(() => { if (needsWitness) ward.witnesses().then((r) => setWitnesses(r.items.filter((w) => w.id !== s.me?.userId))).catch(() => setWitnesses([])); }, [needsWitness]); // eslint-disable-line react-hooks/exhaustive-deps
  const now = new Date(); const administeredAt = new Date(at);
  const slot = pick.slot ? new Date(pick.slot) : null;
  const w = witnesses.find((x) => x.id === witnessId);
  const recorded = o.slots.filter((x) => x.record).map((x) => new Date(x.at).getTime());
  const given = Number.isNaN(administeredAt.getTime()) ? now : administeredAt;
  const near = o.earlierRegimenGiven.find((x) => Math.abs(new Date(x.at).getTime() - given.getTime()) <= v.windowMin * 60_000) ?? null;
  const vialOpen = o.vial !== null && o.vial.source === "ward-stock";
  const blockers = doseBlockers(
    { status: o.status, noteCurrent: true, patientId: v.patient.id, encounterId: v.encounterId, encounterOpen: true, startAt: new Date(o.startAt), times: o.times, prn: o.prn, prnMaxPer24h: o.prnMaxPer24h, medicineKey: o.medicine.key, highAlert: o.medicine.highAlert, controlled: o.medicine.controlled, multiDose: o.medicine.multiDose },
    { patientId: v.patient.id, encounterId: v.encounterId, outcome, slot, administeredAt: Number.isNaN(administeredAt.getTime()) ? now : administeredAt, now, checks, reason, recordedSlots: recorded, givenLast24h: o.givenLast24h,
      nurseId: s.me?.userId ?? "", preparedById: s.me?.userId ?? "", witnessId: needsWitness && outcome === "given" ? witnessId || null : null, witnessRole: w?.role ?? null, allergies: [],
      source, amountGiven: amount, vialOpen, earlierGivenNear: near !== null },
    v.windowMin,
  ).concat(o.allergyBlock && outcome === "given" ? ["allergy"] : []);
  const pinOk = !(needsWitness && outcome === "given") || /^\d{4}$/.test(pin);
  const timing = doseTiming(slot, Number.isNaN(administeredAt.getTime()) ? now : administeredAt, v.windowMin);
  const reasonNeeded = outcome !== "given" || timing === "late" || timing === "early" || near !== null;
  const ok = blockers.length === 0 && pinOk && s.online && !busy;
  const submit = async () => {
    if (!ok || inFlight.current) return;
    inFlight.current = true; setBusy(true); setMsg(null); setServerBlockers([]);
    try {
      const nv = await ward.dose(v.encounterId, {
        requestId: o.id, scheduledFor: pick.slot, outcome, administeredAt: administeredAt.toISOString(), checks, reason: reason.trim() || undefined, source,
        ...(o.medicine.multiDose && outcome === "given" ? { amountGiven: format.toEn(amount).trim() } : {}),
        ...(needsWitness && outcome === "given" ? { witness: { userId: witnessId, pin } } : {}),
      }, key.current);
      onDone(nv);
    } catch (e) {
      // a refused dose gets a fresh key; a lost answer keeps it, so pressing Record again replays, never doubles
      if (e instanceof ApiFailure) key.current = crypto.randomUUID();
      setPin("");
      if (e instanceof ApiFailure) {
        const b = e.body as { code: string; triesLeft?: number; blockers?: string[] };
        if (b.code === "witness_pin_wrong") setMsg(N("pin_wrong", { n: b.triesLeft ?? 0 }));
        else { setMsg(err(e)); if (b.code === "dose_blocked" && Array.isArray(b.blockers)) setServerBlockers(b.blockers); }
        if (b.code === "stale" || b.code === "dose_blocked") await onStale();
      } else setMsg(err(e));
    } finally { inFlight.current = false; setBusy(false); }
  };
  const outcomes: DoseOutcome[] = o.prn ? ["given", "refused"] : ["given", "held", "refused", "missed"];
  const shownBlockers = [...new Set([...blockers.filter((b) => b !== "witness_required" || witnessId === "" ), ...serverBlockers])];
  return (
    <Dialog open onClose={() => { if (!busy) onClose(); }} label={N("rec_title")} width={560}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20, maxHeight: "86vh", overflowY: "auto" }} data-testid="dose-dialog">
        <b>{N("rec_title")} · {o.medicine.brand} {o.medicine.strength} · {o.doseText} · {o.route}{pick.slot ? ` · ${hhmm(pick.slot, s.numerals === "bn")}` : ` · ${N("prn")}`}</b>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {o.medicine.highAlert && <Pill tone="crit" icon="triangle-alert">{N("high_alert")}</Pill>}
          {o.medicine.controlled && <Pill tone="crit" icon="lock">{N("controlled")}</Pill>}
          {needsWitness && <span className="t-small t-muted">{N("sample_rule")}</span>}
        </span>
        <Segmented value={outcome} options={outcomes.map((x) => ({ value: x, label: N(`oc_${x}`) }))} onChange={(x) => setOutcome(x as DoseOutcome)} label={N("outcome")} />
        {outcome === "given" && (<>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid="five-checks">
            <b className="t-small">{N("five_checks")}</b>
            {FIVE_CHECKS.map((c) => (
              <label key={c} className="t-small" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={checks[c]} onChange={(e) => setChecks({ ...checks, [c]: e.target.checked })} name={`check-${c}`} data-check={c} /> {N(`ck_${c}`)}
              </label>
            ))}
          </div>
          <Segmented value={source} options={(["ward-stock", "patient-supplied"] as const).map((x) => ({ value: x, label: N(`src_${x}`) }))} onChange={(x) => setSource(x as typeof source)} label={N("source")} />
          {source === "patient-supplied" && <Pill tone="pend" icon="user-round">{N("source_patient")}</Pill>}
          {o.medicine.multiDose && <TextField label={N("amount_given")} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={N("amount_ph")} name="amountGiven" data-testid="amount-given" />}
        </>)}
        {near && outcome === "given" && <Callout tone="warn" icon="triangle-alert" data-testid="recent-dose">{N("recent_dose_warn", { t: hhmm(near.at, s.numerals === "bn"), dose: near.doseText })}</Callout>}
        <TextField label={N("given_at")} type="datetime-local" value={at} max={localInput(new Date())} onChange={(e) => setAt(e.target.value)} name="administeredAt" data-testid="given-at" />
        {reasonNeeded && <TextArea label={N("reason")} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} name="reason" data-testid="dose-reason" />}
        {needsWitness && outcome === "given" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: 8 }} data-testid="witness">
            <SelectField label={N("witness")} value={witnessId} onChange={(e) => setWitnessId(e.target.value)} name="witness" data-testid="witness-pick">
              <option value="">{N("witness_pick")}</option>
              {witnesses.map((x) => <option key={x.id} value={x.id}>{s.lang === "bn" ? x.nameBn : x.nameEn} · {N(`role_${x.role}`)}</option>)}
            </SelectField>
            <TextField label={N("witness_pin")} value={pin} onChange={(e) => setPin(format.toEn(e.target.value).replace(/\D/g, ""))} type="password" inputMode="numeric" maxLength={4} name="witnessPin" data-testid="witness-pin" autoComplete="off" />
          </div>
        )}
        {shownBlockers.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }} data-testid="dose-blockers">
            {shownBlockers.map((b) => <span key={b} className="t-small" data-blocker={b} style={{ color: "var(--warning-fg)" }}>• {N(`b_${b}`)}</span>)}
          </div>
        )}
        {msg && <Callout tone="warn" icon="triangle-alert" data-testid="dose-error">{msg}</Callout>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
          {busy && <span className="t-small t-muted">{N("recording")}</span>}
          <Button onClick={onClose} disabled={busy}>{N("cancel")}</Button>
          <Button variant="primary" icon="badge-check" disabled={!ok} onClick={() => void submit()} data-testid="dose-record">{N("record")}</Button>
        </div>
      </div>
    </Dialog>
  );
}

function History({ v, onChanged }: { v: MarView; onChanged: (v: MarView) => void }) {
  const s = useSession(); const N = useN(); const err = useErr();
  const [open, setOpen] = useState<string | null>(null); const [reason, setReason] = useState(""); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const bnNum = s.numerals === "bn";
  const mark = async (r: DoseRecord) => { if (busy) return; setBusy(true); try { onChanged(await ward.doseError(r.id, reason.trim())); setOpen(null); setReason(""); } catch (e) { setMsg(err(e)); } finally { setBusy(false); } };
  if (v.history.length === 0) return null;
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 6, padding: 14 }} data-testid="mar-history">
      <b>{N("history")}</b>
      {v.history.map((r) => (
        <div key={r.id} className="t-small" style={{ display: "flex", flexDirection: "column", gap: 4 }} data-dose={r.id} data-dose-status={r.status}>
          <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", textDecoration: r.status === "entered-in-error" ? "line-through" : undefined }}>
            <b>{r.medicine}</b> · {N(`st_${r.status}`)} · <span className="num">{hhmm(r.administeredAt, bnNum)}</span>{r.scheduledFor ? ` (${hhmm(r.scheduledFor, bnNum)})` : ""}
            · {s.lang === "bn" ? r.by.nameBn : r.by.nameEn}{r.witness ? ` · ✓ ${s.lang === "bn" ? r.witness.nameBn : r.witness.nameEn}` : ""}
            {r.source === "patient-supplied" && <Pill tone="pend" icon="user-round">{N("source_patient")}</Pill>}
            {r.reason && <span className="t-muted">· {r.reason}</span>}
          </span>
          {r.status === "entered-in-error" && r.error && <span className="t-muted">{N("st_entered-in-error")}: {r.error.reason}</span>}
          {r.status !== "entered-in-error" && r.by.id === s.me?.userId && open !== r.id && <div><Button size="sm" icon="x" disabled={!s.online} onClick={() => { setOpen(r.id); setReason(""); }}>{N("mark_error")}</Button></div>}
          {open === r.id && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <TextArea label={N("reason")} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} name="errorReason" />
              <Button size="sm" variant="danger" disabled={reason.trim().length < 5 || busy || !s.online} onClick={() => void mark(r)} data-testid="dose-error-confirm">{N("mark_error")}</Button>
            </div>
          )}
        </div>
      ))}
      {msg && <Callout tone="warn" icon="triangle-alert">{msg}</Callout>}
    </Card>
  );
}

/** Opening a multi-dose vial takes one vial from the ward (or records the patient's own): confirmed, once. */
function VialDialog({ enc, o, onClose, onDone }: { enc: string; o: MarOrder; onClose: () => void; onDone: (v: MarView, at: string) => void }) {
  const s = useSession(); const N = useN(); const err = useErr();
  const [source, setSource] = useState<"ward-stock" | "patient-supplied">("ward-stock");
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID()); const at = useRef(new Date().toISOString());
  const go = async () => {
    if (busy) return; setBusy(true); setMsg(null);
    try { onDone(await ward.vial(enc, { requestId: o.id, openedAt: at.current, source }, key.current), at.current); }
    catch (e) { if (e instanceof ApiFailure) { key.current = crypto.randomUUID(); at.current = new Date().toISOString(); } setMsg(err(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={() => { if (!busy) onClose(); }} label={N("vial_title")} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }} data-testid="vial-dialog">
        <b>{N("vial_title")} · {o.medicine.brand} {o.medicine.strength}</b>
        {o.vial && <Callout tone="warn" icon="flask-conical">{N("vial_open_now", { t: hhmm(o.vial.openedAt, s.numerals === "bn"), name: s.lang === "bn" ? o.vial.by.nameBn : o.vial.by.nameEn })}</Callout>}
        <Segmented value={source} options={(["ward-stock", "patient-supplied"] as const).map((x) => ({ value: x, label: N(`src_${x}`) }))} onChange={(x) => setSource(x as typeof source)} label={N("source")} />
        <span className="t-small t-muted">{N("ward_stock_n", { n: o.wardStock })}</span>
        {msg && <Callout tone="warn" icon="triangle-alert">{msg}</Callout>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onClose} disabled={busy}>{N("cancel")}</Button>
          <Button variant="primary" icon="flask-conical" disabled={busy || !s.online} onClick={() => void go()} data-testid="vial-confirm">{N("vial_confirm")}</Button>
        </div>
      </div>
    </Dialog>
  );
}
