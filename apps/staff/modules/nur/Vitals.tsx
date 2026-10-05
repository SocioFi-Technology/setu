"use client";
/* nur/vitals — walkthrough B4 (issue #7). Ported from docs/prototype/Setu Nursing.dc.html (screen "vitals"): the nursing
   round's observations with NEWS2 worked out live on the device (scale 1 only), saved with the device time — offline it
   waits in the outbox and the screen says "call the doctor now — not yet synced" when the score is at or above the
   sample threshold, because the escalation only reaches the doctor's inbox once the server has it. Below: the open
   escalations (log the doctor's contact, resolve) and the last 72 hours. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { WardPatientView, WardVitalsRequest } from "@setu/contracts";
import { CONSCIOUSNESS, format, informBlockers, news2, shouldEscalate, type Consciousness } from "@setu/domain";
import { Button, Callout, Card, Pill, Segmented, TextArea, TextField, useToast } from "@setu/ui";
import { ApiFailure, ward } from "../../lib/api";
import { useSession } from "../../lib/session";
import { News2Pill, WardPatientPicker, hhmm, useErr, useN, useWardBanner } from "./common";

type Form = { rr: string; spo2: string; onOxygen: boolean; sbp: string; dbp: string; pulse: string; temp: string; consciousness: Consciousness | "" };
const EMPTY: Form = { rr: "", spo2: "", onOxygen: false, sbp: "", dbp: "", pulse: "", temp: "", consciousness: "" };
const num = (v: string) => (v.trim() === "" ? undefined : Number(v));

export function NurVitals() {
  const enc = useSearchParams().get("enc"); const N = useN();
  if (!enc) return <WardPatientPicker screen="nur/vitals" title={N("vitals_title")} />;
  return <VitalsFor key={enc} enc={enc} />;
}

function VitalsFor({ enc }: { enc: string }) {
  const s = useSession(); const N = useN(); const err = useErr(); const toast = useToast();
  const [v, setV] = useState<WardPatientView | null>(null); const [failed, setFailed] = useState<string | null>(null);
  const [f, setF] = useState<Form>(EMPTY);
  const [save, setSave] = useState<{ st: "idle" | "saving" | "saved" | "queued"; at?: string; escalated?: boolean; next?: string; score?: number }>({ st: "idle" });
  const [msg, setMsg] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const load = useCallback(async () => { try { setV(await ward.patient(enc)); } catch (e) { setFailed(err(e)); } }, [enc]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  useWardBanner(v?.patient, v?.allergies, v?.bed ? `${v.bed.ward} · ${v.bed.name}` : null);
  if (failed) return <Callout tone="warn" icon="triangle-alert">{failed}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{N("loading")}</div>;
  const bnNum = s.numerals === "bn";
  const live = news2({ rr: num(f.rr), spo2: num(f.spo2), onOxygen: f.onOxygen, sbp: num(f.sbp), pulse: num(f.pulse), tempF: num(f.temp), consciousness: f.consciousness || undefined });
  const anyValue = [f.rr, f.spo2, f.sbp, f.pulse, f.temp].some((x) => x.trim() !== "") || f.consciousness !== "";
  const atThreshold = shouldEscalate(live, v.rule.threshold);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => { setF({ ...f, [k]: format.toEn(e.target.value).replace(/[^\d.]/g, "") }); setSave({ st: "idle" }); };
  const submit = async () => {
    if (!anyValue || save.st === "saving") return;
    setSave({ st: "saving" }); setMsg(null);
    const body: WardVitalsRequest = {
      values: { rr: num(f.rr), spo2: num(f.spo2), onOxygen: f.onOxygen, bpSys: num(f.sbp), bpDia: num(f.dbp), pulse: num(f.pulse), temp: num(f.temp), consciousness: f.consciousness || undefined },
      effectiveAt: new Date().toISOString(), deviceLabel: "ward",
    };
    try {
      const r = await ward.vitals(enc, body, key.current);
      key.current = crypto.randomUUID();
      if (r.queued) { setSave({ st: "queued", score: live.total, escalated: atThreshold }); setF(EMPTY); return; }
      setSave({ st: "saved", at: r.data.batch.recordedAt, escalated: r.data.escalated, next: r.data.nextObsDueAt, score: r.data.news2.total });
      if (r.data.escalated) toast(N("escalated"), "siren");
      setF(EMPTY); await load();
    } catch (e) { if (e instanceof ApiFailure) key.current = crypto.randomUUID(); setSave({ st: "idle" }); setMsg(err(e)); }
  };
  const open = v.escalations.filter((x) => x.status !== "resolved");
  return (
    <div data-screen="nur/vitals" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{N("vitals_title")}</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, alignItems: "start" }}>
        <Card style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }} data-testid="vitals-form">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
            <TextField label={N("rr")} value={f.rr} onChange={set("rr")} inputMode="numeric" name="rr" />
            <TextField label={N("spo2")} value={f.spo2} onChange={set("spo2")} inputMode="numeric" name="spo2" />
            <TextField label={N("sbp")} value={f.sbp} onChange={set("sbp")} inputMode="numeric" name="sbp" />
            <TextField label={N("dbp")} value={f.dbp} onChange={set("dbp")} inputMode="numeric" name="dbp" />
            <TextField label={N("pulse")} value={f.pulse} onChange={set("pulse")} inputMode="numeric" name="pulse" />
            <TextField label={N("temp")} value={f.temp} onChange={set("temp")} inputMode="decimal" name="temp" />
          </div>
          <label className="t-small" style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={f.onOxygen} onChange={(e) => { setF({ ...f, onOxygen: e.target.checked }); setSave({ st: "idle" }); }} name="onOxygen" /> {N("on_oxygen")}</label>
          <Segmented value={f.consciousness} options={CONSCIOUSNESS.map((c) => ({ value: c, label: `${c} · ${N(`cs_${c}`)}` }))} onChange={(c) => { setF({ ...f, consciousness: c as Consciousness }); setSave({ st: "idle" }); }} label={N("consciousness")} />
          <span className="t-small t-muted">{N("scale1")}</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }} data-testid="news2-live" data-news2-live={anyValue ? live.total : ""}>
            {anyValue && <Pill tone={live.risk === "high" ? "crit" : live.risk === "medium" ? "bad" : live.risk === "low-medium" ? "warn" : "ok"} icon="activity">{N("news2_live", { n: live.total, risk: N(`risk_${live.risk}`) })}</Pill>}
            {anyValue && !live.complete && <span className="t-small t-muted">{N("news2_incomplete", { list: live.missing.map((m) => (m === "temp" ? N("temp") : m === "sbp" ? N("sbp") : m === "consciousness" ? N("consciousness") : m === "rr" ? N("rr") : m === "pulse" ? N("pulse") : m)).join(", ") })}</span>}
            <span className="t-small t-muted">{N("sample_rule")}: ≥ {s.n(v.rule.threshold)}</span>
          </div>
          {save.st === "queued" && save.escalated && <Callout tone="bad" icon="phone-call" data-testid="call-doctor-offline">{N("call_doctor_offline")}</Callout>}
          {save.st === "saved" && save.escalated && <Callout tone="bad" icon="siren" data-testid="escalated">{N("escalated")}</Callout>}
          {msg && <Callout tone="warn" icon="triangle-alert" data-testid="vitals-error">{msg}</Callout>}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Button variant="primary" icon="save" disabled={!anyValue || save.st === "saving"} onClick={() => void submit()} data-testid="save-vitals">{N("save_vitals")}</Button>
            <span className="t-small" data-testid="save-state" data-save={save.st}>
              {save.st === "saved" ? `${N("saved_synced", { t: hhmm(save.at, bnNum) })} · ${N("next_obs", { t: hhmm(save.next, bnNum) })}` : save.st === "queued" ? N("saved_queued") : save.st === "saving" ? N("recording") : ""}
            </span>
          </div>
        </Card>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {open.map((x) => <EscalationCard key={x.id} esc={x} onChanged={load} />)}
          <Card style={{ display: "flex", flexDirection: "column", gap: 6, padding: 14 }} data-testid="vitals-history">
            <b>{N("history_72h")}</b>
            {v.nextObsDueAt && <span className="t-small">{N("next_obs", { t: hhmm(v.nextObsDueAt, bnNum) })}</span>}
            {v.vitals.length === 0 && <span className="t-small t-muted">{N("news2_none")}</span>}
            {v.vitals.map((x) => (
              <span key={x.batch.batchId} className="t-small" style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }} data-vitals-row={x.batch.batchId}>
                <span className="num">{hhmm(x.batch.effectiveAt, bnNum)} · {s.lang === "bn" ? x.batch.recordedBy.nameBn : x.batch.recordedBy.nameEn}</span>
                <News2Pill n={x.news2} />
              </span>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

function EscalationCard({ esc, onChanged }: { esc: WardPatientView["escalations"][number]; onChanged: () => Promise<void> }) {
  const s = useSession(); const N = useN(); const err = useErr();
  const [spokeTo, setSpokeTo] = useState(""); const [instruction, setInstruction] = useState(""); const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const bnNum = s.numerals === "bn";
  const run = async (f: () => Promise<unknown>) => { setBusy(true); setMsg(null); try { await f(); await onChanged(); } catch (e) { setMsg(err(e)); } finally { setBusy(false); } };
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14, borderColor: "var(--danger-border)" }} data-testid="escalation" data-escalation-status={esc.status}>
      <b>{N("news2_n", { n: esc.peakScore })} · {hhmm(esc.raisedAt, bnNum)}</b>
      {esc.unacknowledged && <Pill tone="crit" icon="bell-ring">{N("unacknowledged")}</Pill>}
      {esc.acknowledgedBy && <span className="t-small">{N("acknowledged_by", { name: s.lang === "bn" ? esc.acknowledgedBy.nameBn : esc.acknowledgedBy.nameEn, t: hhmm(esc.acknowledgedAt, bnNum) })}</span>}
      <span className="t-small t-muted">{N("sample_rule")}</span>
      {esc.status === "raised" ? (<>
        <TextField label={N("spoke_to")} value={spokeTo} onChange={(e) => setSpokeTo(e.target.value)} name="spokeTo" />
        <TextArea label={N("instruction")} value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={2} name="instruction" />
        <div><Button size="sm" variant="primary" icon="phone" disabled={busy || !s.online || informBlockers({ spokeTo, instruction }).length > 0} onClick={() => void run(() => ward.inform(esc.id, { spokeTo: spokeTo.trim(), instruction: instruction.trim() }))} data-testid="inform-save">{N("log_inform")}</Button></div>
      </>) : (<>
        <span className="t-small">{N("escalation_informed")}: {esc.spokeTo} · {hhmm(esc.informedAt, bnNum)}</span>
        {esc.instruction && <span className="t-small">{esc.instruction}</span>}
        <TextArea label={N("resolve_note")} value={note} onChange={(e) => setNote(e.target.value)} rows={2} name="resolveNote" />
        <div><Button size="sm" icon="circle-check" disabled={busy || !s.online || note.trim().length < 3} onClick={() => void run(() => ward.resolve(esc.id, note.trim()))} data-testid="resolve">{N("resolve")}</Button></div>
      </>)}
      {msg && <Callout tone="warn" icon="triangle-alert">{msg}</Callout>}
    </Card>
  );
}
