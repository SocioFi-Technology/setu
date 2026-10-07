"use client";
/* ipd/discharge — walkthrough B9 (ADR 0017). Ported from docs/prototype/Setu IPD.dc.html (screen "discharge"): the six
   steps with owner and waiting time, the header naming who is blocking ("Blocked by Pharmacy · Md. Jewel Rana"), Mark
   done (PIN), I'll take it, Remind. The doctor orders the discharge here (advice, target time, PIN) and may cancel it
   before the bed is released. `DischargeSteps` is shared: the IPD bill shows the clearance (steps 4–5 for the cashier)
   and the pharmacist's indent screen shows step 3. Steps 2, 4 and 5 are recorded by hand until B10 / B11. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { DischargeList, DischargeStepView, DischargeView } from "@setu/contracts";
import { format } from "@setu/domain";
import { Button, Callout, Card, Dialog, PageState, Pill, Segmented, TextArea, TextField, useToast, type Tone } from "@setu/ui";
import { ApiFailure, discharge } from "../../lib/api";
import { useSession } from "../../lib/session";
import { toBanner, useLabels } from "../fd/common";
import { PinSheet } from "../nur/common";
import { useI } from "./BedPicker";

const STEP_TONE: Record<string, Tone> = { done: "ok", "in-progress": "pend", blocking: "bad", waiting: "neu" };
type Person = { id: string; nameBn: string; nameEn: string };

export function useDischargeText() {
  const s = useSession(); const I = useI();
  const who = (p: Person | null | undefined) => (p ? (s.lang === "bn" ? p.nameBn : p.nameEn || p.nameBn) : "");
  const dur = (fromIso: string | null, to: Date = new Date()) => {
    if (!fromIso) return "";
    const m = Math.max(0, Math.round((to.getTime() - new Date(fromIso).getTime()) / 60_000));
    return m >= 60 ? I("d_hm", { h: Math.floor(m / 60), m: m % 60 }) : I("d_m", { m });
  };
  const blocker = (b: { department: string; person: Person | null }) => `${I(`ds_dept_${b.department}`)}${b.person ? ` · ${who(b.person)}` : ""}`;
  return { who, dur, blocker, time: (iso: string) => format.time(iso, s.numerals === "bn"), dateTime: (iso: string) => format.dateTime(iso, s.numerals === "bn") };
}
const errOf = (s: ReturnType<typeof useSession>, I: ReturnType<typeof useI>) => (e: unknown) => (e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : I("error_generic"));

/** The six steps with their actions; `only` limits the actions to some steps (the bill: 4–5, the pharmacy: 3). */
export function DischargeSteps({ v, onChange, only }: { v: DischargeView; onChange: (v: DischargeView) => void; only?: DischargeStepView["key"][] }) {
  const s = useSession(); const I = useI(); const T = useDischargeText(); const toast = useToast(); const err = errOf(s, I);
  const [doing, setDoing] = useState<DischargeStepView | null>(null); const [busy, setBusy] = useState(false);
  const act = async (f: () => Promise<DischargeView>, msg: string) => {
    if (busy) return; setBusy(true);
    try { onChange(await f()); toast(msg, "badge-check"); } catch (e) { toast(err(e), "triangle-alert"); } finally { setBusy(false); }
  };
  const id = v.discharge.id;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="discharge-steps">
      {v.steps.map((x, n) => {
        const state = x.blocking ? "blocking" : x.status;
        const mine = !only || only.includes(x.key);
        const label = x.status === "done" ? I("ds_done_by") : x.blocking ? I("ds_blocked_by") : I("ds_owner");
        const person = x.status === "done" ? T.who(x.doneBy) : x.takenBy ? T.who(x.takenBy) : x.department === "doctor" && x.key !== "order" ? T.who(v.admission.doctor) : "";
        return (
          <div key={x.key} className="card" data-step={x.key} data-step-status={state}
            style={{ display: "grid", gridTemplateColumns: "28px minmax(0, 1fr) auto", gap: 10, padding: "10px 12px", alignItems: "start", borderColor: x.blocking ? "var(--danger-fg)" : undefined }}>
            <span className="num" style={{ fontWeight: 700, paddingTop: 2 }}>{s.n(n + 1)}</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
              <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <b>{I(`ds_step_${x.key}`)}</b>
                <Pill tone={STEP_TONE[state]!} icon={state === "done" ? "circle-check" : state === "blocking" ? "octagon-alert" : state === "in-progress" ? "loader" : "circle-dashed"}>{I(`ds_st_${state}`)}</Pill>
                {x.byHand && <Pill tone="warn" icon="pen-line">{I("ds_by_hand")}</Pill>}
              </span>
              <span className="t-small" style={{ color: x.blocking ? "var(--danger-fg)" : undefined }}>
                {label}: {I(`ds_dept_${x.department}`)}{person ? ` · ${person}` : ""}
                {x.status === "done" && x.doneAt ? ` · ${T.time(x.doneAt)}` : ""}
              </span>
              {x.status === "in-progress" && <span className="t-small t-muted num" data-testid="step-waited">{I("ds_waited", { d: T.dur(x.startedAt) })}</span>}
              {x.status === "waiting" && <span className="t-small t-muted">{I("ds_waiting_for")}</span>}
              {x.note && <span className="t-small">{x.note}</span>}
              {x.reminded && <span className="t-small t-muted">{I("ds_reminded", { name: T.who(x.reminded.by), at: T.time(x.reminded.at), n: x.reminded.count })}</span>}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {mine && x.can.take && <Button size="sm" icon="hand" disabled={busy || !s.online} onClick={() => void act(() => discharge.take(id, x.key), I("ds_taken_msg"))} data-testid={`take-${x.key}`}>{I("ds_take")}</Button>}
              {mine && x.can.done && <Button size="sm" variant="primary" icon="check" disabled={busy || !s.online} onClick={() => setDoing(x)} data-testid={`done-${x.key}`}>{I("ds_mark_done")}</Button>}
              {x.can.remind && !x.can.done && (x.blocking || x.department === "doctor") && <Button size="sm" icon="bell" disabled={busy || !s.online} onClick={() => void act(() => discharge.remind(id, x.key), I("ds_reminded_msg"))} data-testid={`remind-${x.key}`}>{I("ds_remind")}</Button>}
            </div>
          </div>
        );
      })}
      {doing && <StepDone v={v} step={doing} onClose={() => setDoing(null)} onDone={(nv) => { setDoing(null); onChange(nv); toast(nv.discharge.status === "completed" ? I("ds_released") : I("ds_done_msg"), "badge-check"); }} />}
    </div>
  );
}

/** Mark done: the pharmacist answers about the patient's own medicines; a step recorded by hand takes a note; then the PIN. */
function StepDone({ v, step, onClose, onDone }: { v: DischargeView; step: DischargeStepView; onClose: () => void; onDone: (v: DischargeView) => void }) {
  const I = useI();
  const [own, setOwn] = useState<"handed-back" | "none" | "">(""); const [note, setNote] = useState(""); const [pin, setPin] = useState(false);
  const key = useRef(crypto.randomUUID());
  const ready = step.key !== "pharmacy" || own !== "";
  if (pin) return <PinSheet title={I(`ds_step_${step.key}`)} action={I("ds_mark_done")} icon="check" onClose={onClose}
    submit={async (p) => { try { onDone(await discharge.done(v.discharge.id, step.key, { pin: p, ...(note.trim() ? { note: note.trim() } : {}), ...(own ? { ownMedicines: own } : {}) }, key.current)); } catch (e) { if (e instanceof ApiFailure && e.body.code !== "pin_wrong") key.current = crypto.randomUUID(); throw e; } }} />;
  return (
    <Dialog open onClose={onClose} label={I(`ds_step_${step.key}`)} width={460}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }} data-testid="step-done">
        <b>{I(`ds_step_${step.key}`)}</b>
        {step.key === "pharmacy" && (
          <Segmented label={I("ds_own_meds")} value={own} onChange={(x) => setOwn(x as "handed-back" | "none")}
            options={[{ value: "handed-back", label: I("ds_own_handed-back") }, { value: "none", label: I("ds_own_none") }]} />
        )}
        <TextArea label={I("ds_note")} value={note} onChange={(e) => setNote(e.target.value)} rows={2} name="stepNote" data-testid="step-note" />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onClose}>{I("cancel")}</Button>
          <Button variant="primary" icon="check" disabled={!ready} onClick={() => setPin(true)} data-testid="step-continue">{I("ds_mark_done")}</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** The header: blocked by whom, or in progress, or discharged with the total time. */
export function DischargeHeader({ v }: { v: DischargeView }) {
  const I = useI(); const T = useDischargeText();
  const d = v.discharge;
  if (d.status === "cancelled") return <Callout tone="warn" icon="undo-2" data-testid="discharge-header">{I("ds_cancelled", { reason: d.cancel?.reason ?? "" })}</Callout>;
  if (d.status === "completed") return (
    <Callout tone="info" icon="circle-check" data-testid="discharge-header">
      <b>{I("ds_complete", { at: T.time(d.completedAt!) })}</b> · {I("ds_total_time", { d: T.dur(d.orderedAt, new Date(d.completedAt!)) })}
    </Callout>
  );
  const blocked = v.header.blockedBy;
  return (
    <div className={`callout${blocked.length ? " callout-bad" : ""}`} data-testid="discharge-header" data-blocked={blocked.length ? "1" : "0"} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <b>{blocked.length ? I("ds_blocked", { who: blocked.map(T.blocker).join(" · ") }) : I("ds_progress", { n: v.header.done })}</b>
      <span className="t-small">{I("ds_sub", { n: v.header.done, at: T.time(d.orderedAt), target: T.time(d.targetAt) })}{d.overdue ? ` · ${I("ds_overdue")}` : ""}</span>
    </div>
  );
}

export function IpdDischarge() {
  const s = useSession(); const I = useI(); const L = useLabels(); const router = useRouter(); const toast = useToast(); const T = useDischargeText(); const err = errOf(s, I);
  const adm = useSearchParams().get("adm");
  const [list, setList] = useState<DischargeList | null>(null); const [v, setV] = useState<DischargeView | null>(null);
  const [none, setNone] = useState(false); const [failed, setFailed] = useState<string | null>(null);
  const load = useCallback(async () => {
    setFailed(null);
    try {
      if (!adm) { setList(await discharge.list()); return; }
      try { setV(await discharge.view(adm)); setNone(false); }
      catch (e) { if (e instanceof ApiFailure && e.body.code === "no_discharge") { setV(null); setNone(true); setList(await discharge.list()); } else throw e; }
    } catch (e) { setFailed(err(e)); }
  }, [adm]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!v) { s.setPatient(null); return; }
    s.setPatient({ ...toBanner(v.patient, `${L.age(v.patient)} ${L.sex(v.patient.sex)}`), location: [v.admission.ward, v.admission.bed].filter(Boolean).join(" · ") });
  }, [v?.patient.id, s.lang]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const bn = s.lang === "bn";
  if (failed) return <Callout tone="warn" icon="triangle-alert">{failed}</Callout>;
  // a doctor ordering a discharge for a patient who has none
  if (adm && none) {
    const c = list?.candidates.find((x) => x.admissionId === adm);
    return c ? <OrderForm admissionId={adm} label={`${bn ? c.patient.nameBn : c.patient.nameEn || c.patient.nameBn} · ${c.number}${c.bed ? ` · ${c.bed}` : ""}`} onDone={(nv) => { setNone(false); setV(nv); toast(I("ds_ordered"), "badge-check"); }} />
      : <PageState icon="clipboard-check" title={I("ds_title")} body={I("ds_list_none")} />;
  }
  if (adm && v) return (
    <div data-screen="ipd/discharge" data-status={v.discharge.status} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{I("ds_title")}</h1>
        <span className="num t-muted">{v.admission.number} · {I("ds_day", { n: v.admission.dayNo })}</span>
        <span style={{ flex: 1 }} />
        <Button size="sm" icon="arrow-left" onClick={() => router.push("/m/ipd/discharge")}>{I("ds_back")}</Button>
      </div>
      <DischargeHeader v={v} />
      <Card style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="t-small"><b>{I("ds_advice_label")}:</b> {v.discharge.advice}</span>
        <span className="t-small t-muted">{I("ds_ordered_by", { name: T.who(v.discharge.orderedBy), at: T.dateTime(v.discharge.orderedAt) })}</span>
      </Card>
      <DischargeSteps v={v} onChange={setV} />
      {v.can.cancel && <CancelDischarge v={v} onDone={(nv) => { setV(nv); toast(I("ds_cancelled_msg"), "undo-2"); }} />}
    </div>
  );
  if (!list) return <div aria-busy="true" className="t-muted">{I("loading")}</div>;
  return (
    <div data-screen="ipd/discharge" data-status="list" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{I("ds_title")}</h1>
      <span className="t-small t-muted">{I("ds_list_hint")}</span>
      {list.items.length === 0 && <PageState icon="clipboard-check" title={I("ds_title")} body={I("ds_list_none")} />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 }} data-testid="discharge-list">
        {list.items.map((x) => (
          <button key={x.id} type="button" className="card" data-discharge={x.number} data-status={x.status} onClick={() => router.push(`/m/ipd/discharge?adm=${encodeURIComponent(x.admissionId)}`)}
            style={{ textAlign: "left", padding: 12, display: "flex", flexDirection: "column", gap: 4, cursor: "pointer", borderColor: x.blockedBy.length ? "var(--danger-fg)" : undefined }}>
            <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <b>{bn ? x.patient.nameBn : x.patient.nameEn || x.patient.nameBn}</b>
              <span className="num t-muted t-small">{[x.ward, x.bed].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="t-small">{x.status === "completed" ? I("ds_complete", { at: T.time(x.completedAt!) }) : x.blockedBy.length ? I("ds_blocked", { who: x.blockedBy.map(T.blocker).join(" · ") }) : I("ds_progress", { n: x.done })}</span>
            <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {x.overdue && <Pill tone="bad" icon="clock">{I("ds_overdue")}</Pill>}
              {x.mine.map((k) => <Pill key={k} tone="info" icon="user-check">{I("ds_mine")}: {I(`ds_step_${k}`)}</Pill>)}
            </span>
          </button>
        ))}
      </div>
      {list.candidates.length > 0 && (
        <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }} data-testid="discharge-candidates">
          <b>{I("ds_order_title")}</b>
          <span className="t-small t-muted">{I("ds_order_pick")}</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
            {list.candidates.map((c) => (
              <button key={c.admissionId} type="button" className="card" data-candidate={c.number} onClick={() => router.push(`/m/ipd/discharge?adm=${encodeURIComponent(c.admissionId)}`)}
                style={{ textAlign: "left", padding: 10, display: "flex", flexDirection: "column", gap: 2, cursor: "pointer" }}>
                <b>{bn ? c.patient.nameBn : c.patient.nameEn || c.patient.nameBn}</b>
                <span className="t-small t-muted num">{[c.ward, c.bed].filter(Boolean).join(" · ")} · {c.number}</span>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

/** The doctor's order: advice, target time (default 3 h), PIN. */
function OrderForm({ admissionId, label, onDone }: { admissionId: string; label: string; onDone: (v: DischargeView) => void }) {
  const s = useSession(); const I = useI();
  const def = new Date(Date.now() + 3 * 3600_000);
  const local = (d: Date) => new Date(d.getTime() + 6 * 3600_000).toISOString().slice(0, 16); // Dhaka wall time for the input
  const [advice, setAdvice] = useState(""); const [target, setTarget] = useState(local(def)); const [pin, setPin] = useState(false);
  const key = useRef(crypto.randomUUID());
  const ok = advice.trim().length >= 10 && s.online;
  return (
    <div data-screen="ipd/discharge" data-status="order" style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{I("ds_order_title")}</h1>
      <span>{label}</span>
      <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <TextArea label={I("ds_advice")} value={advice} onChange={(e) => setAdvice(e.target.value)} rows={3} name="advice" data-testid="discharge-advice" />
        <TextField label={I("ds_target")} hint={I("ds_target_hint")} type="datetime-local" value={target} onChange={(e) => setTarget(e.target.value)} name="target" data-testid="discharge-target" />
        <div><Button variant="primary" icon="log-out" disabled={!ok} onClick={() => setPin(true)} data-testid="discharge-order">{I("ds_order")}</Button>
          {!s.online && <span className="t-small t-muted"> {I("needs_connection")}</span>}</div>
      </Card>
      {pin && <PinSheet title={I("ds_order")} action={I("ds_order")} icon="log-out" onClose={() => setPin(false)}
        submit={async (p) => {
          const at = target ? new Date(`${target}:00+06:00`).toISOString() : undefined;
          try { const v = await discharge.order(admissionId, { advice: advice.trim(), targetAt: at, pin: p }, key.current); setPin(false); onDone(v); }
          catch (e) { if (e instanceof ApiFailure && e.body.code !== "pin_wrong") { key.current = crypto.randomUUID(); } throw e; }
        }} />}
    </div>
  );
}

function CancelDischarge({ v, onDone }: { v: DischargeView; onDone: (v: DischargeView) => void }) {
  const s = useSession(); const I = useI();
  const [reason, setReason] = useState(""); const [pin, setPin] = useState(false); const [open, setOpen] = useState(false);
  if (!open) return <div><Button icon="undo-2" onClick={() => setOpen(true)} data-testid="discharge-cancel-open">{I("ds_cancel")}</Button></div>;
  return (
    <Card style={{ padding: 14, display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
      <TextArea label={I("ds_cancel_reason")} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} name="cancelReason" data-testid="discharge-cancel-reason" />
      <Button variant="danger" icon="undo-2" disabled={reason.trim().length < 10 || !s.online} onClick={() => setPin(true)} data-testid="discharge-cancel">{I("ds_cancel")}</Button>
      {pin && <PinSheet title={I("ds_cancel")} action={I("ds_cancel")} icon="undo-2" onClose={() => setPin(false)} submit={async (p) => { const nv = await discharge.cancel(v.discharge.id, reason.trim(), p); setPin(false); onDone(nv); }} />}
    </Card>
  );
}
