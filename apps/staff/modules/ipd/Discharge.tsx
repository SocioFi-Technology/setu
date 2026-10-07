"use client";
/* ipd/discharge — walkthrough B9 (ADR 0017). Ported from docs/prototype/Setu IPD.dc.html (screen "discharge"): the six
   steps with owner and waiting time, the header naming who is blocking ("Blocked by Pharmacy · Md. Jewel Rana"), Mark
   done (PIN), I'll take it, Remind. The doctor orders the discharge here (advice, target time, PIN) and may cancel it
   before the bed is released. `DischargeSteps` is shared: the IPD bill shows the clearance (steps 4–5 for the cashier)
   and the pharmacist's indent screen shows step 3. ADR 0018 (B10–B12): the doctor records a normal discharge, a LAMA (reason,
   risks, the form, a witness) or a death on the ward (the ER's checks); the summary, the final bill and the payment finish
   by their events (links to the summary and the bill); the pharmacy and "patient left" / "body moved" (with the time) are
   marked with a PIN; the visit's outcome and "visit finished" show in the header. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { DischargeList, DischargeStepView, DischargeView, WitnessList } from "@setu/contracts";
import { DEATH_CHECKS, format } from "@setu/domain";
import { Button, Callout, Card, Dialog, PageState, Pill, Segmented, TextArea, TextField, useToast, type Tone } from "@setu/ui";
import { ApiFailure, discharge, ward } from "../../lib/api";
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
/** A step's name for its kind (LAMA record, death record, body moved), else the normal one. */
export const stepName = (I: ReturnType<typeof useI>, kind: string, key: string) => { const k = `ds_step_${kind}_${key}`; const t = I(k); return t === k ? I(`ds_step_${key}`) : t; };
/** Dhaka wall time for a datetime-local input, and back. */
const local = (d: Date) => new Date(d.getTime() + 6 * 3600_000).toISOString().slice(0, 16);
const fromLocal = (x: string) => new Date(`${x}:00+06:00`).toISOString();
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
                <b>{stepName(I, v.discharge.kind, x.key)}</b>
                <Pill tone={STEP_TONE[state]!} icon={state === "done" ? "circle-check" : state === "blocking" ? "octagon-alert" : state === "in-progress" ? "loader" : "circle-dashed"}>{I(`ds_st_${state}`)}</Pill>
                {x.byHand && <Pill tone="warn" icon="pen-line">{I("ds_by_hand")}</Pill>}
              </span>
              <span className="t-small" style={{ color: x.blocking ? "var(--danger-fg)" : undefined }}>
                {label}: {I(`ds_dept_${x.department}`)}{person ? ` · ${person}` : ""}
                {x.status === "done" && x.doneAt ? ` · ${T.time(x.doneAt)}` : ""}
              </span>
              {x.status === "in-progress" && <span className="t-small t-muted num" data-testid="step-waited">{I("ds_waited", { d: T.dur(x.startedAt) })}</span>}
              {x.status === "waiting" && <span className="t-small t-muted">{I("ds_waiting_for")}</span>}
              {x.byEvent && x.status === "in-progress" && x.key !== "order" && (
                <span className="t-small t-muted" data-testid={`event-${x.key}`}>{I(`ds_event_${x.key}`)}{" "}
                  {x.key === "summary" && <a href={`/m/ipd/summary?adm=${encodeURIComponent(v.admission.id)}`} data-testid="open-summary">{I("ds_open_summary")}</a>}
                  {(x.key === "final-bill" || x.key === "payment") && <a href={`/m/bill/ipd?adm=${encodeURIComponent(v.admission.id)}`} data-testid="open-bill">{I("ds_open_bill")}</a>}
                </span>
              )}
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
  const [at, setAt] = useState(local(new Date()));
  const key = useRef(crypto.randomUUID());
  const left = step.key === "bed-release";
  const ready = (step.key !== "pharmacy" || own !== "") && (!left || at !== "");
  const name = stepName(I, v.discharge.kind, step.key);
  if (pin) return <PinSheet title={name} action={I("ds_mark_done")} icon="check" onClose={onClose}
    submit={async (p) => { try { onDone(await discharge.done(v.discharge.id, step.key, { pin: p, ...(note.trim() ? { note: note.trim() } : {}), ...(own ? { ownMedicines: own } : {}), ...(left ? { at: fromLocal(at) } : {}) }, key.current)); } catch (e) { if (e instanceof ApiFailure && e.body.code !== "pin_wrong") key.current = crypto.randomUUID(); throw e; } }} />;
  return (
    <Dialog open onClose={onClose} label={name} width={460}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }} data-testid="step-done">
        <b>{name}</b>
        {left && <TextField label={I(v.discharge.kind === "death" ? "ds_body_at" : "ds_left_at")} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} name="leftAt" data-testid="left-at" />}
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
        {v.admission.outcome && <span data-testid="outcome"><Pill tone={v.admission.outcome === "deceased" ? "neu" : "warn"}>{I(`ds_outcome_${v.admission.outcome}`)}</Pill></span>}
        {v.admission.visitFinished && <span data-testid="visit-finished"><Pill tone="ok" icon="circle-check">{I("ds_visit_finished")}</Pill></span>}
        <span style={{ flex: 1 }} />
        {v.discharge.kind !== "death" && <Button size="sm" icon="file-text" onClick={() => router.push(`/m/ipd/summary?adm=${encodeURIComponent(v.admission.id)}`)} data-testid="go-summary">{I("ds_open_summary")}</Button>}
        <Button size="sm" icon="arrow-left" onClick={() => router.push("/m/ipd/discharge")}>{I("ds_back")}</Button>
      </div>
      <DischargeHeader v={v} />
      <Card style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4 }}>
        <span className="t-small"><b>{I(v.discharge.kind === "lama" ? "ds_lama_reason" : v.discharge.kind === "death" ? "ds_death_cause" : "ds_advice_label")}:</b> {v.discharge.advice}</span>
        <RecordLine v={v} />
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
              {x.kind !== "normal" && <Pill tone={x.kind === "death" ? "neu" : "warn"}>{I(`ds_kind_${x.kind}`)}</Pill>}
              {x.overdue && <Pill tone="bad" icon="clock">{I("ds_overdue")}</Pill>}
              {x.mine.map((k) => <Pill key={k} tone="info" icon="user-check">{I("ds_mine")}: {stepName(I, x.kind, k)}</Pill>)}
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

/** What the record says beyond the advice: the LAMA witness, the time of death and the checks. */
function RecordLine({ v }: { v: DischargeView }) {
  const I = useI(); const T = useDischargeText(); const s = useSession();
  const r = v.discharge.record as null | { witness?: { id: string; nameBn: string; nameEn: string }; timeOfDeath?: string; medicoLegal?: boolean; checks?: string[] };
  if (!r) return null;
  if (v.discharge.kind === "lama") return <span className="t-small" data-testid="record-line">{I("ds_lama_witnessed", { name: T.who(r.witness) })} · {I("ds_lama_summary_due")}</span>;
  return <span className="t-small" data-testid="record-line">{I("ds_death_at", { at: r.timeOfDeath ? T.dateTime(r.timeOfDeath) : "" })}{r.medicoLegal ? ` · ${I("ds_death_ml")}` : ""} · {(r.checks ?? []).map((c) => s.t("erApp", `chk_${c}`)).join(", ")}</span>;
}

/** The doctor's record: a normal discharge (advice, target time — default 3 h), a LAMA (reason, the risks explained, the
    form signed, a witness) or a death on the ward (time, cause, medico-legal, the ER's checks) — each with the PIN. */
function OrderForm({ admissionId, label, onDone }: { admissionId: string; label: string; onDone: (v: DischargeView) => void }) {
  const s = useSession(); const I = useI();
  const [kind, setKind] = useState<"normal" | "lama" | "death">("normal");
  const [advice, setAdvice] = useState(""); const [target, setTarget] = useState(local(new Date(Date.now() + 3 * 3600_000))); const [pin, setPin] = useState(false);
  const [risks, setRisks] = useState(false); const [form, setForm] = useState(false); const [witness, setWitness] = useState(""); const [people, setPeople] = useState<WitnessList["items"]>([]);
  const [tod, setTod] = useState(local(new Date())); const [ml, setMl] = useState(false); const [checks, setChecks] = useState<string[]>([]);
  const key = useRef(crypto.randomUUID());
  useEffect(() => { if (kind === "lama" && !people.length) ward.witnesses().then((x) => setPeople(x.items)).catch(() => setPeople([])); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const ok = s.online && (kind === "normal" ? advice.trim().length >= 10
    : kind === "lama" ? advice.trim().length >= 10 && risks && form && witness !== ""
    : advice.trim().length >= 3 && tod !== "" && checks.includes("certificate") && checks.includes("family") && (!ml || checks.includes("police")));
  const title = I(kind === "normal" ? "ds_order" : kind === "lama" ? "ds_lama_record" : "ds_death_record");
  return (
    <div data-screen="ipd/discharge" data-status="order" style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{I("ds_order_title")}</h1>
      <span>{label}</span>
      <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        <Segmented label={I("ds_kind")} value={kind} onChange={(x) => { setKind(x as typeof kind); key.current = crypto.randomUUID(); }}
          options={[{ value: "normal", label: I("ds_kind_normal") }, { value: "lama", label: I("ds_kind_lama") }, { value: "death", label: I("ds_kind_death") }]} />
        {kind === "normal" && (<>
          <TextArea label={I("ds_advice")} value={advice} onChange={(e) => setAdvice(e.target.value)} rows={3} name="advice" data-testid="discharge-advice" />
          <TextField label={I("ds_target")} hint={I("ds_target_hint")} type="datetime-local" value={target} onChange={(e) => setTarget(e.target.value)} name="target" data-testid="discharge-target" />
        </>)}
        {kind === "lama" && (<>
          <TextArea label={I("ds_lama_reason")} value={advice} onChange={(e) => setAdvice(e.target.value)} rows={3} name="lamaReason" data-testid="lama-reason" />
          <label className="t-small" style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={risks} onChange={(e) => setRisks(e.target.checked)} data-testid="lama-risks" /> {I("ds_lama_risks")}</label>
          <label className="t-small" style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={form} onChange={(e) => setForm(e.target.checked)} data-testid="lama-form" /> {I("ds_lama_form")}</label>
          <label className="field t-small">{I("ds_lama_witness")}
            <select className="input" name="lamaWitness" value={witness} onChange={(e) => setWitness(e.target.value)} data-testid="lama-witness">
              <option value="">—</option>
              {people.map((p) => <option key={p.id} value={p.id}>{s.lang === "bn" ? p.nameBn : p.nameEn || p.nameBn} · {s.t("nurApp", `role_${p.role}`)}</option>)}
            </select>
          </label>
        </>)}
        {kind === "death" && (<>
          <TextField label={I("ds_death_time")} type="datetime-local" value={tod} onChange={(e) => setTod(e.target.value)} name="timeOfDeath" data-testid="death-time" />
          <TextField label={I("ds_death_cause")} value={advice} onChange={(e) => setAdvice(e.target.value)} name="cause" data-testid="death-cause" />
          <label className="t-small" style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={ml} onChange={(e) => setMl(e.target.checked)} data-testid="death-ml" /> {I("ds_death_ml")}</label>
          {DEATH_CHECKS.map((c) => (
            <label key={c} className="t-small" style={{ display: "flex", gap: 8, alignItems: "center" }} data-check={c}>
              <input type="checkbox" checked={checks.includes(c)} onChange={(e) => setChecks(e.target.checked ? [...checks, c] : checks.filter((x) => x !== c))} /> {s.t("erApp", `chk_${c}`)}
            </label>
          ))}
          <Callout tone="warn" icon="triangle-alert">{I("ds_death_warn")}</Callout>
        </>)}
        <div><Button variant={kind === "normal" ? "primary" : "danger"} icon={kind === "death" ? "file-x" : "log-out"} disabled={!ok} onClick={() => setPin(true)} data-testid="discharge-order">{title}</Button>
          {!s.online && <span className="t-small t-muted"> {I("needs_connection")}</span>}</div>
      </Card>
      {pin && <PinSheet title={title} action={title} icon="log-out" onClose={() => setPin(false)}
        submit={async (p) => {
          try {
            const v = kind === "normal" ? await discharge.order(admissionId, { advice: advice.trim(), targetAt: target ? fromLocal(target) : undefined, pin: p }, key.current)
              : kind === "lama" ? await discharge.lama(admissionId, { reason: advice.trim(), risksExplained: risks, formSigned: form, witnessId: witness || null, pin: p }, key.current)
              : await discharge.death(admissionId, { timeOfDeath: fromLocal(tod), cause: advice.trim(), medicoLegal: ml, checks, pin: p }, key.current);
            setPin(false); onDone(v);
          } catch (e) { if (e instanceof ApiFailure && e.body.code !== "pin_wrong") { key.current = crypto.randomUUID(); } throw e; }
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
