"use client";
/* ipd/summary — walkthrough B11 (ADR 0018). Ported from docs/prototype/Setu IPD.dc.html (screen "summary"): the
   discharge summary of an inpatient visit — final diagnoses (the ICD picker; at least one confirmed), the course in
   hospital, procedures, the medicines on discharge (the prescription builder and its warnings; taken home through the
   pharmacy as a normal dispense), the follow-up and the red-flag advice (sample ticks + free text). Signed with the
   doctor's PIN; refused while a critical result waits for a doctor or an escalation is open (Kamrul, 12). A signed
   version is read-only: print (A4, QR), amend (a reason, a new version), the take-home lines' state ("not collected"
   after 3 days — Kamrul, 304). The draft is kept on the server only (saved, never "signed" until the server says so). */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { DischargeList, SummaryDoc, SummaryView } from "@setu/contracts";
import { COURSE_MIN, format } from "@setu/domain";
import { Button, Callout, Card, Dialog, PageState, Pill, TextArea, TextField, useToast } from "@setu/ui";
import { PrintPanel } from "../../components/PrintPanel";
import { ApiFailure, discharge, summary } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Diagnoses } from "../cons/Draft";
import { RxBuilder } from "../cons/Rx";
import type { Dx, Line } from "../cons/common";
import { toBanner, useLabels } from "../fd/common";
import { PinSheet } from "../nur/common";
import { useI } from "./BedPicker";
import { useDischargeText } from "./Discharge";

type Sections = SummaryDoc["sections"];
interface Form { sections: Sections; diagnoses: Dx[]; lines: Line[] }
const formOf = (d: SummaryDoc): Form => ({
  sections: { ...d.sections, procedures: d.sections.procedures.map((p) => ({ ...p })), redFlags: [...d.sections.redFlags] },
  diagnoses: d.diagnoses.map((x) => ({ ...x })),
  lines: d.medicines.map((m) => ({ uid: m.id, medicine: { key: m.medicineKey, brand: m.brand, generic: m.generic, strength: m.strength, form: m.form, ingredients: m.ingredients, classes: m.classes },
    dose: m.dose, meal: m.meal, days: m.days, note: m.note ?? "", keepBoth: m.keepBoth, acks: m.acks })),
});
const bodyOf = (f: Form) => ({
  sections: { ...f.sections, procedures: f.sections.procedures.filter((p) => p.name.trim()), redFlags: f.sections.redFlags.map((r) => r.trim()).filter(Boolean) },
  diagnoses: f.diagnoses.map((d) => ({ code: d.code, verificationStatus: d.verificationStatus })),
  medicines: f.lines.map((l) => ({ medicineKey: l.medicine.key, dose: l.dose, meal: l.meal, days: l.days, ...(l.note.trim() ? { note: l.note.trim() } : {}), ...(l.keepBoth ? { keepBoth: true } : {}), ...(l.acks.length ? { acks: l.acks } : {}) })),
});
const TH_TONE = { waiting: "pend", partial: "warn", dispensed: "ok", declined: "neu", "not-collected": "bad" } as const;

export function IpdSummary() {
  const adm = useSearchParams().get("adm");
  return adm ? <SummaryScreen key={adm} admissionId={adm} /> : <SummaryList />;
}

/** The summaries owed: discharges (not deaths) whose summary step is not done yet. */
function SummaryList() {
  const s = useSession(); const I = useI(); const T = useDischargeText(); const router = useRouter();
  const [list, setList] = useState<DischargeList | null>(null); const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => { discharge.list().then(setList).catch((e) => setFailed(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : I("error_generic"))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <Callout tone="warn" icon="triangle-alert">{failed}</Callout>;
  if (!list) return <div aria-busy="true" className="t-muted">{I("loading")}</div>;
  const owed = list.items.filter((x) => x.kind !== "death" && x.summary !== "done");
  return (
    <div data-screen="ipd/summary" data-status="list" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{I("sm_title")}</h1>
      <span className="t-small t-muted">{I("sm_list_hint")}</span>
      {owed.length === 0 && <PageState icon="file-text" title={I("sm_title")} body={I("sm_list_none")} />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 }} data-testid="summary-list">
        {owed.map((x) => (
          <button key={x.id} type="button" className="card" data-summary-for={x.number} onClick={() => router.push(`/m/ipd/summary?adm=${encodeURIComponent(x.admissionId)}`)}
            style={{ textAlign: "left", padding: 12, display: "flex", flexDirection: "column", gap: 4, cursor: "pointer" }}>
            <b>{s.lang === "bn" ? x.patient.nameBn : x.patient.nameEn || x.patient.nameBn}</b>
            <span className="num t-muted t-small">{[x.ward, x.bed].filter(Boolean).join(" · ")} · {x.number}</span>
            <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {x.kind === "lama" && <Pill tone="warn">{I("ds_kind_lama")}</Pill>}
              <Pill tone="pend" icon="clock">{I("sm_owed_since", { at: T.time(x.orderedAt) })}</Pill>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SummaryScreen({ admissionId }: { admissionId: string }) {
  const s = useSession(); const I = useI(); const L = useLabels(); const router = useRouter(); const toast = useToast();
  const [v, setV] = useState<SummaryView | null>(null); const [failed, setFailed] = useState<string | null>(null);
  const err = (e: unknown) => (e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : I("error_generic"));
  const load = useCallback(async () => { try { setV(await summary.view(admissionId)); } catch (e) { setFailed(err(e)); } }, [admissionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!v) return;
    s.setPatient({ ...toBanner(v.patient, `${L.age(v.patient)} ${L.sex(v.patient.sex)}`), location: [v.admission.ward, v.admission.bed].filter(Boolean).join(" · ") });
  }, [v?.patient.id, s.lang]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <Callout tone="warn" icon="triangle-alert">{failed}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{I("loading")}</div>;
  const doctor = s.me?.role === "doctor";
  const status = v.draft ? "draft" : v.current ? "signed" : "none";
  return (
    <div data-screen="ipd/summary" data-status={status} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{I("sm_title")}</h1>
        <span className="num t-muted">{v.admission.number} · {I("ds_day", { n: v.admission.dayNo })}</span>
        {v.discharge?.kind === "lama" && <Pill tone="warn">{I("ds_kind_lama")}</Pill>}
        {v.current && <span data-testid="summary-signed"><Pill tone="ok" icon="badge-check">{I("sm_signed_v", { n: v.current.version })}</Pill></span>}
        <span style={{ flex: 1 }} />
        <Button size="sm" icon="clipboard-check" onClick={() => router.push(`/m/ipd/discharge?adm=${encodeURIComponent(admissionId)}`)}>{I("sm_checklist")}</Button>
      </div>
      {!v.needed && <Callout icon="info" data-testid="summary-not-needed">{v.discharge ? I("sm_none_death") : I("sm_no_discharge")}</Callout>}
      {v.draft && doctor ? <Editor v={v} draft={v.draft} onView={setV} />
        : v.current ? <SignedView v={v} doc={v.current} onView={setV} />
        : v.can.open ? (
          <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
            <span>{I("sm_start_hint")}</span>
            <span><Button variant="primary" icon="file-plus" disabled={!s.online} onClick={() => summary.open(admissionId).then(setV).catch((e) => toast(err(e), "triangle-alert"))} data-testid="summary-open">{I("sm_start")}</Button></span>
          </Card>
        ) : v.needed ? <PageState icon="file-text" title={I("sm_title")} body={doctor ? I("sm_wait_discharge") : I("sm_doctor_writes")} /> : null}
      {v.history.length > 1 && (
        <Card style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4 }} data-testid="summary-history">
          <b className="t-small">{I("sm_history")}</b>
          {v.history.map((h) => <span key={h.id} className="t-small num">v{s.n(h.version)} · {I(`sm_st_${h.status}`)}{h.signedAt ? ` · ${format.dateTime(h.signedAt, s.numerals === "bn")}` : ""}{h.amendReason ? ` · ${h.amendReason}` : ""}</span>)}
        </Card>
      )}
    </div>
  );
}

/** The draft: saved to the server (Save, and before signing); the sign checks shown as the server reports them. */
function Editor({ v, draft, onView }: { v: SummaryView; draft: SummaryDoc; onView: (v: SummaryView) => void }) {
  const s = useSession(); const I = useI(); const toast = useToast();
  const [f, setF] = useState<Form>(() => formOf(draft)); const [rev, setRev] = useState(draft.rev);
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null); const [pin, setPin] = useState(false);
  const [fields, setFields] = useState<{ field: string; code: string }[]>([]);
  const key = useRef(crypto.randomUUID()); const signKey = useRef(crypto.randomUUID());
  const set = (p: Partial<Form>) => { setF((x) => ({ ...x, ...p })); setDirty(true); };
  const sec = (p: Partial<Sections>) => set({ sections: { ...f.sections, ...p } });
  const err = (e: unknown) => (e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : I("error_generic"));
  const save = async (): Promise<SummaryView | null> => {
    setBusy(true); setMsg(null); setFields([]);
    try {
      const nv = await summary.save(draft.id, { rev, ...bodyOf(f) }, key.current);
      key.current = crypto.randomUUID(); setRev(nv.draft!.rev); setDirty(false); onView(nv); return nv;
    } catch (e) {
      if (e instanceof ApiFailure && e.status < 500) key.current = crypto.randomUUID();
      setMsg(err(e)); if (e instanceof ApiFailure && Array.isArray(e.body.fields)) setFields(e.body.fields as { field: string; code: string }[]);
      return null;
    } finally { setBusy(false); }
  };
  const flags = v.redFlagsSample;
  const ticked = (t: string) => f.sections.redFlags.includes(t);
  const lang = (x: { bn: string; en: string }) => (s.lang === "bn" ? x.bn : x.en);
  const free = f.sections.redFlags.filter((r) => !flags.some((x) => x.bn === r || x.en === r));
  const blockers = v.blockers;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 12, alignItems: "start" }} className="ipd-bill-grid">
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        {draft.amendsId && <Callout tone="warn" icon="pen-line">{I("sm_amending", { n: draft.version, reason: draft.amendReason ?? "" })}</Callout>}
        <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }} data-testid="sm-dx">
          <b>{I("sm_dx")}</b><span className="t-small t-muted">{I("sm_dx_hint")}</span>
          <Diagnoses value={f.diagnoses} disabled={busy} onChange={(d) => set({ diagnoses: d })} />
        </Card>
        <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <TextArea label={I("sm_course")} hint={I("sm_course_hint", { n: COURSE_MIN })} value={f.sections.course} onChange={(e) => sec({ course: e.target.value })} rows={5} name="course" data-testid="sm-course" />
        </Card>
        <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }} data-testid="sm-procedures">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}><b style={{ flex: 1 }}>{I("sm_procedures")}</b>
            <Button size="sm" icon="plus" onClick={() => sec({ procedures: [...f.sections.procedures, { name: "", date: v.admission.admittedAt.slice(0, 10), surgeon: "" }] })} data-testid="sm-proc-add">{I("sm_proc_add")}</Button></span>
          {f.sections.procedures.length === 0 && <span className="t-small t-muted">{I("sm_proc_none")}</span>}
          {f.sections.procedures.map((p, n) => (
            <div key={n} style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) 150px minmax(0, 1fr) auto", gap: 8, alignItems: "end" }}>
              <TextField label={I("sm_proc_name")} value={p.name} onChange={(e) => sec({ procedures: f.sections.procedures.map((x, i) => (i === n ? { ...x, name: e.target.value } : x)) })} name={`proc-${n}`} />
              <TextField label={I("sm_proc_date")} type="date" value={p.date} onChange={(e) => sec({ procedures: f.sections.procedures.map((x, i) => (i === n ? { ...x, date: e.target.value } : x)) })} name={`proc-date-${n}`}
                error={fields.some((x) => x.field === `sections.procedures.${n}.date`) ? I("sm_proc_out_of_stay") : undefined} />
              <TextField label={I("sm_proc_surgeon")} value={p.surgeon} onChange={(e) => sec({ procedures: f.sections.procedures.map((x, i) => (i === n ? { ...x, surgeon: e.target.value } : x)) })} name={`proc-surgeon-${n}`} />
              <Button size="sm" variant="ghost" icon="x" onClick={() => sec({ procedures: f.sections.procedures.filter((_, i) => i !== n) })}>{I("sm_remove")}</Button>
            </div>
          ))}
        </Card>
        <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }} data-testid="sm-meds">
          <b>{I("sm_meds")}</b><span className="t-small t-muted">{I("sm_meds_hint")}</span>
          {fields.some((x) => x.field.startsWith("medicines.") && x.code === "inpatient_only") && <Callout tone="warn" icon="triangle-alert">{I("sm_inpatient_only")}</Callout>}
          <RxBuilder lines={f.lines} allergies={v.allergies} disabled={busy} onChange={(l) => set({ lines: l })} />
        </Card>
        <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <b>{I("sm_follow_up")}</b>
          <div style={{ display: "grid", gridTemplateColumns: "180px minmax(0, 1fr)", gap: 8 }}>
            <TextField label={I("sm_fu_date")} type="date" value={f.sections.followUp.date ?? ""} onChange={(e) => sec({ followUp: { ...f.sections.followUp, date: e.target.value || null } })} name="followUpDate" data-testid="sm-fu-date" />
            <TextField label={I("sm_fu_place")} value={f.sections.followUp.place} onChange={(e) => sec({ followUp: { ...f.sections.followUp, place: e.target.value } })} name="followUpPlace" data-testid="sm-fu-place" />
          </div>
        </Card>
        <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6 }} data-testid="sm-red-flags">
          <b>{I("sm_red_flags")}</b><span className="t-small t-muted">{I("sm_red_hint")}</span>
          {flags.map((x) => (
            <label key={x.key} className="t-small" style={{ display: "flex", gap: 8, alignItems: "center" }} data-flag={x.key}>
              <input type="checkbox" checked={ticked(lang(x))} onChange={(e) => sec({ redFlags: e.target.checked ? [...f.sections.redFlags, lang(x)] : f.sections.redFlags.filter((r) => r !== lang(x)) })} /> {lang(x)}
            </label>
          ))}
          <TextArea label={I("sm_red_other")} value={free.join("\n")} rows={2} name="redOther" data-testid="sm-red-other"
            onChange={(e) => sec({ redFlags: [...f.sections.redFlags.filter((r) => !free.includes(r)), ...e.target.value.split("\n")] })} />
          <span className="t-small t-muted">{I("sm_red_sample")}</span>
        </Card>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0, position: "sticky", top: 0 }}>
        <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }} data-testid="sm-sign-card">
          <b>{I("sm_sign_card")}</b>
          {(v.facts.criticalUnacked > 0 || v.facts.openEscalations > 0) && (
            <Callout tone="bad" icon="octagon-alert" data-testid="sm-safety">
              {v.facts.criticalUnacked > 0 && <div>{I("sm_b_critical_unacked", { n: v.facts.criticalUnacked })}</div>}
              {v.facts.openEscalations > 0 && <div>{I("sm_b_escalation_open", { n: v.facts.openEscalations })}</div>}
            </Callout>
          )}
          {blockers.length > 0 && !dirty && (
            <ul className="t-small" style={{ margin: 0, paddingLeft: 18 }} data-testid="sm-blockers">
              {blockers.filter((b) => b !== "critical_unacked" && b !== "escalation_open").map((b) => <li key={b} data-blocker={b}>{I(`sm_b_${b}`, { n: COURSE_MIN })}</li>)}
            </ul>
          )}
          {dirty && <span className="t-small t-muted">{I("sm_unsaved")}</span>}
          {msg && <Callout tone="warn" icon="triangle-alert" data-testid="sm-error">{msg}</Callout>}
          <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button icon="save" disabled={busy || !s.online || !dirty} onClick={() => void save().then((x) => x && toast(I("sm_saved"), "save"))} data-testid="sm-save">{busy ? I("waiting_server") : I("sm_save")}</Button>
            <Button variant="primary" icon="pen-line" disabled={busy || !s.online} data-testid="sm-sign"
              onClick={async () => { const nv = dirty ? await save() : v; if (nv && nv.blockers.length === 0) setPin(true); else if (nv) toast(I("sm_fix_first"), "triangle-alert"); }}>{I("sm_sign")}</Button>
          </span>
          {!s.online && <span className="t-small t-muted">{I("needs_connection")}</span>}
        </Card>
        <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 6 }}>
          <b className="t-small">{I("sm_context")}</b>
          {v.admission.diagnosis && <span className="t-small"><span className="t-muted">{I("sm_adm_dx")}:</span> {v.admission.diagnosis}</span>}
          {v.facts.lastRoundAssessment && <span className="t-small"><span className="t-muted">{I("sm_last_round")}:</span> {v.facts.lastRoundAssessment}</span>}
          {v.discharge && <span className="t-small"><span className="t-muted">{I(v.discharge.kind === "lama" ? "ds_lama_reason" : "ds_advice_label")}:</span> {v.discharge.advice}</span>}
          {v.facts.activeOrders.length > 0 && <span className="t-small"><span className="t-muted">{I("sm_active_orders")}:</span> {v.facts.activeOrders.map((o) => `${o.brand} ${o.strength} (${o.doseText} ${o.route})`).join(", ")}</span>}
        </Card>
      </div>
      {pin && <PinSheet title={I("sm_sign")} action={I("sm_sign")} icon="pen-line" onClose={() => setPin(false)}
        submit={async (p) => {
          try { const nv = await summary.sign(draft.id, rev, p, signKey.current); setPin(false); onView(nv); toast(I("sm_signed_msg"), "badge-check"); }
          catch (e) { if (e instanceof ApiFailure && e.body.code !== "pin_wrong") signKey.current = crypto.randomUUID(); throw e; }
        }} />}
    </div>
  );
}

/** A signed version: read-only, the take-home medicines' state, print (A4), amend. */
function SignedView({ v, doc, onView }: { v: SummaryView; doc: SummaryDoc; onView: (v: SummaryView) => void }) {
  const s = useSession(); const I = useI(); const T = useDischargeText();
  const [amend, setAmend] = useState(false);
  const bn = s.lang === "bn";
  const meal = (m: string) => s.t("consultApp", `meal_${m}`);
  const th = v.takeHome;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 420px)", gap: 12, alignItems: "start" }} className="ipd-bill-grid">
      <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }} data-testid="summary-doc">
        <span className="t-small t-muted">{I("sm_signed_by", { name: T.who(doc.signedBy), at: doc.signedAt ? T.dateTime(doc.signedAt) : "" })}</span>
        <div><b>{I("sm_dx")}</b><ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{doc.diagnoses.map((d) => <li key={d.code}><span className="num">{d.code}</span> {bn ? d.labelBn : d.labelEn}{d.verificationStatus === "provisional" ? ` (${s.t("consultApp", "dx_provisional")})` : ""}</li>)}</ul></div>
        <div><b>{I("sm_course")}</b><div style={{ whiteSpace: "pre-wrap" }}>{doc.sections.course}</div></div>
        {doc.sections.procedures.length > 0 && <div><b>{I("sm_procedures")}</b><ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{doc.sections.procedures.map((p, n) => <li key={n}>{p.name} · <span className="num">{format.date(`${p.date}T12:00:00+06:00`, s.numerals === "bn")}</span>{p.surgeon ? ` · ${p.surgeon}` : ""}</li>)}</ul></div>}
        <div data-testid="summary-meds"><b>{I("sm_meds")}</b>
          {doc.medicines.length === 0 ? <div className="t-small t-muted">{I("sm_meds_none")}</div> : doc.medicines.map((m) => {
            const line = th.lines.find((x) => x.requestId === m.id);
            return (
              <div key={m.id} className="t-small" data-take-home={m.medicineKey} data-status={line?.status ?? ""} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "3px 0" }}>
                <span style={{ flex: 1 }}><b>{m.form} {m.brand} {m.strength}</b> · <span className="num">{s.n(m.dose)}</span> · {meal(m.meal)} · {I("sm_days", { n: m.days })}{m.note ? ` · ${m.note}` : ""}</span>
                {line && <Pill tone={TH_TONE[line.status]}>{I(`sm_th_${line.status}`)}{line.status === "partial" || line.status === "not-collected" ? ` · ${s.n(line.givenQty)}/${s.n(line.quantity)}` : ""}</Pill>}
              </div>
            );
          })}
          {th.notCollected > 0 && <Callout tone="warn" icon="package-x" data-testid="not-collected">{I("sm_not_collected", { n: th.notCollected })}</Callout>}
          {th.until && th.notCollected === 0 && !th.dispensed && doc.medicines.length > 0 && <span className="t-small t-muted">{I("sm_th_until", { at: T.dateTime(th.until) })}</span>}
        </div>
        <div><b>{I("sm_follow_up")}</b><div>{doc.sections.followUp.date ? format.date(`${doc.sections.followUp.date}T12:00:00+06:00`, s.numerals === "bn") : "—"}{doc.sections.followUp.place ? ` · ${doc.sections.followUp.place}` : ""}</div></div>
        <div><b>{I("sm_red_flags")}</b><ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{doc.sections.redFlags.map((r, n) => <li key={n}>{r}</li>)}</ul></div>
        {v.can.amend && <span><Button icon="pen-line" onClick={() => setAmend(true)} data-testid="summary-amend">{I("sm_amend")}</Button></span>}
      </Card>
      <PrintPanel kind="ds" id={doc.id} />
      {amend && <AmendDialog doc={doc} onClose={() => setAmend(false)} onDone={(nv) => { setAmend(false); onView(nv); }} />}
    </div>
  );
}

function AmendDialog({ doc, onClose, onDone }: { doc: SummaryDoc; onClose: () => void; onDone: (v: SummaryView) => void }) {
  const s = useSession(); const I = useI();
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  return (
    <Dialog open onClose={onClose} label={I("sm_amend")} width={460}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 18 }}>
        <b>{I("sm_amend")} · v{s.n(doc.version)}</b>
        <span className="t-small t-muted">{I("sm_amend_hint")}</span>
        <TextArea label={I("sm_amend_reason")} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} name="amendReason" data-testid="summary-amend-reason" />
        {msg && <Callout tone="warn" icon="triangle-alert">{msg}</Callout>}
        <span style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onClose}>{I("cancel")}</Button>
          <Button variant="primary" icon="pen-line" disabled={reason.trim().length < 5 || busy || !s.online} data-testid="summary-amend-go"
            onClick={() => { setBusy(true); summary.amend(doc.id, reason.trim()).then(onDone).catch((e) => setMsg(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : I("error_generic"))).finally(() => setBusy(false)); }}>{I("sm_amend_open")}</Button>
        </span>
      </div>
    </Dialog>
  );
}
