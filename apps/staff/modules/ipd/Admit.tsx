"use client";
/* ipd/admit — walkthrough B2 → B3. Ported from docs/prototype/Setu IPD.dc.html (screen "admit"): the ER's admission
   requests on the left (or a direct admission by patient search), the form on the right — source, doctor, department,
   diagnosis, class (sample prices), the bed picker (cleaning / blocked never pickable), guardian, consents (three
   required), the package and a deposit by card or bank (ADR 0017; cash at the counter; never blocking), the checklist,
   and Admit: one server transaction
   (IPD encounter, bed occupied, ADM/yy/nnnn, the IPD bill draft). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AdmissionItem, AdmissionList, AdmissionView, BedBoard, PatientSummary } from "@setu/contracts";
import { admissionChecklist, bedPickable, format, parseTaka } from "@setu/domain";
import { Button, Callout, Card, PageState, Pill, Segmented, SelectField, TextArea, TextField, useToast } from "@setu/ui";
import { ApiFailure, fd, ipd } from "../../lib/api";
import { useSession } from "../../lib/session";
import { bannerOf, useLabels } from "../fd/common";
import { BedPicker, useI, type PickBed } from "./BedPicker";
import { WristbandButton } from "../nur/common";

type Src = "opd" | "er" | "direct";
const RELS = ["husband", "wife", "father", "mother", "son", "daughter", "other"];

export function IpdAdmit() {
  const s = useSession(); const I = useI(); const L = useLabels(); const toast = useToast();
  const [list, setList] = useState<AdmissionList | null>(null); const [board, setBoard] = useState<BedBoard | null>(null); const [failed, setFailed] = useState(false);
  const [req, setReq] = useState<AdmissionItem | null>(null);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [q, setQ] = useState(""); const [hits, setHits] = useState<PatientSummary[]>([]);
  const [done, setDone] = useState<AdmissionView | null>(null);
  const load = useCallback(async () => { try { const [l, b] = await Promise.all([ipd.admissions(), ipd.beds()]); setList(l); setBoard(b); } catch { setFailed(true); } }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => { fd.search(q.trim()).then((r) => setHits(r.items ?? [])).catch(() => setHits([])); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const subject = req?.patient ?? patient;
  useEffect(() => { s.setPatient(subject ? { ...bannerOf(subject as PatientSummary, L), allergies: null } : null); }, [subject?.id, s.lang, s.numerals]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <Callout tone="warn" icon="triangle-alert">{I("error_generic")}</Callout>;
  if (!list || !board) return <div aria-busy="true" className="t-muted">{I("loading")}</div>;
  const name = (p: { nameBn: string; nameEn: string | null }) => (s.lang === "bn" ? p.nameBn : p.nameEn ?? p.nameBn);
  return (
    <div data-screen="ipd/admit" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{I("admit_title")}</h1>
      <div style={{ display: "grid", gridTemplateColumns: "320px minmax(0, 1fr)", gap: 14, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }} data-testid="requested">
            <b>{I("requested")}</b>
            {list.requested.length === 0 && <span className="t-small t-muted">{I("requested_none")}</span>}
            {list.requested.map((a) => (
              <button key={a.id} type="button" className="card" data-request={a.id} data-request-patient={a.patient.facilityNo} aria-pressed={req?.id === a.id} onClick={() => { setReq(a); setPatient(null); setDone(null); }}
                style={{ textAlign: "left", padding: 10, display: "flex", flexDirection: "column", gap: 3, cursor: "pointer", outline: req?.id === a.id ? "2px solid var(--brand-primary)" : undefined }}>
                <b>{name(a.patient)}</b>
                <span className="t-small t-muted num">{a.patient.facilityNo} · {L.age(a.patient)} {L.sex(a.patient.sex)}</span>
                <span className="t-small">{a.diagnosis}</span>
                <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><Pill tone="pend" icon="bed-double">{a.bed.name} · {I(`st_${a.bed.state}`)}</Pill><Pill tone="neu">{name(a.admittingDoctor)}</Pill></span>
                <span className="t-small t-muted">{I("requested_at", { at: format.time(a.requestedAt, s.numerals === "bn"), by: name(a.requestedBy) })}</span>
              </button>
            ))}
          </Card>
          <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
            <b>{I("direct")}</b>
            <TextField label={I("search_patient")} value={q} onChange={(e) => setQ(e.target.value)} hint={I("direct_hint")} data-testid="admit-search" />
            {patient && <Pill tone="ok" icon="user-round">{I("picked")}: {name(patient)} · {patient.facilityNo}</Pill>}
            {hits.length === 0 && q.trim().length >= 2 && !patient && <span className="t-small t-muted">{I("search_none")}</span>}
            {hits.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto" }} role="listbox">
                {hits.slice(0, 8).map((p) => <button key={p.id} type="button" role="option" className="card" data-patient={p.facilityNo} onClick={() => { setPatient(p); setReq(null); setDone(null); setHits([]); setQ(""); }} style={{ textAlign: "left", padding: "8px 10px", cursor: "pointer" }}><b>{name(p)}</b> <span className="t-small t-muted num">{p.facilityNo} · {L.age(p)} {L.sex(p.sex)}</span></button>)}
              </div>
            )}
          </Card>
          <Card style={{ display: "flex", flexDirection: "column", gap: 6, padding: 14 }} data-testid="admitted-today">
            <b>{I("admitted_today")}</b>
            {list.admitted.length === 0 && <span className="t-small t-muted">{I("admitted_none")}</span>}
            {list.admitted.map((a) => <span key={a.id} className="t-small" data-admitted={a.number ?? a.id}><b className="num">{a.number}</b> · {name(a.patient)} · {a.bed.name}</span>)}
          </Card>
        </div>
        {done ? <DoneCard v={done} onNext={() => { setDone(null); setReq(null); setPatient(null); }} /> : subject ? (
          <AdmitForm key={req?.id ?? patient?.id ?? ""} list={list} board={board} req={req} patient={patient} onAdmitted={async (v) => { setDone(v); toast(I("admitted_msg", { number: v.number ?? "", bed: v.bed.name, ward: v.bed.ward.name }), "badge-check"); await load(); }} onCancelled={async () => { setReq(null); toast(I("cancelled_toast"), "undo-2"); await load(); }} />
        ) : <PageState icon="log-in" title={I("admit_title")} body={I("form_none")} />}
      </div>
    </div>
  );
}

function DoneCard({ v, onNext }: { v: AdmissionView; onNext: () => void }) {
  const s = useSession(); const I = useI();
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16 }} data-testid="admitted-card">
      <Callout tone="info" icon="badge-check">{I("admitted_msg", { number: v.number ?? "", bed: v.bed.name, ward: s.lang === "bn" ? v.bed.ward.nameBn ?? v.bed.ward.name : v.bed.ward.name })}</Callout>
      <span className="t-small" data-testid="ipd-bill">{I("ipd_bill")}{v.invoice ? ` · ${v.invoice.status}` : ""}</span>
      <span className="t-small t-muted" data-testid="legs">{I("legs")}: {v.legs.map((l) => `${l.bed} · ${l.status === "ended" ? I(`leg_${l.endReason ?? "ended"}`) : I(`st_${l.status}`)}`).join(" → ")}</span>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        {v.encounter && <WristbandButton encounterId={v.encounter.id} size="md" />}
        <Button variant="primary" icon="plus" onClick={onNext}>{I("admit_title")}</Button>
      </div>
    </Card>
  );
}

function AdmitForm({ list, board, req, patient, onAdmitted, onCancelled }: { list: AdmissionList; board: BedBoard; req: AdmissionItem | null; patient: PatientSummary | null; onAdmitted: (v: AdmissionView) => Promise<void>; onCancelled: () => Promise<void> }) {
  const s = useSession(); const I = useI(); const toast = useToast();
  const subjectId = req?.patient.id ?? patient!.id;
  const [source, setSource] = useState<Src>(req ? (req.source as Src) : "direct");
  const [doctor, setDoctor] = useState(req?.admittingDoctor.id ?? "");
  const [department, setDepartment] = useState(req?.department && list.options.departments.some((d) => d.key === req.department) ? req.department : list.options.departments[0]?.key ?? "medicine");
  const [diagnosis, setDiagnosis] = useState(req?.diagnosis ?? "");
  const [cls, setCls] = useState(req?.bedClass ?? "General");
  const [bedId, setBedId] = useState<string | null>(req?.bed.id ?? null);
  const [g, setG] = useState({ name: "", relationship: "husband", phone: "" });
  const [consents, setConsents] = useState<string[]>([]);
  // ADR 0017: the package (optional) and a deposit at the desk (card or bank; cash at the counter; never blocking)
  const [packageId, setPackageId] = useState(""); const [depMethod, setDepMethod] = useState<"none" | "card" | "bank">("none");
  const [depAmount, setDepAmount] = useState(""); const [depRef, setDepRef] = useState("");
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState(""); const [cancelOpen, setCancelOpen] = useState(false);
  const key = useRef(crypto.randomUUID()); const cancelKey = useRef(crypto.randomUUID());
  const beds: PickBed[] = useMemo(() => board.wards.flatMap((w) => w.beds.filter((b) => b.bedClass !== "ER").map((b) => {
    const pick = bedPickable({ state: b.state, bedClass: b.bedClass, reservedForPatientId: b.assignment?.status === "reserved" ? b.patient?.id ?? null : null }, subjectId);
    return { id: b.id, name: b.name, ward: w.name, wardBn: w.nameBn, bedClass: b.bedClass, state: b.state, pickable: pick.ok, reason: pick.ok ? null : pick.reason };
  })), [board, subjectId]);
  const depPaisa = depMethod === "none" ? null : parseTaka(depAmount);
  const form = { bedId, diagnosis, guardianName: g.name, guardianPhone: g.phone, consents, depositPaisa: depPaisa ?? 0 };
  const checklist = admissionChecklist(form);
  // a deposit started must be complete (amount and reference) — leaving it out never blocks
  const depOk = depMethod === "none" || (!!depPaisa && depRef.trim().length > 0);
  const ready = checklist.every((c) => c.ok || !c.blocks) && depOk;
  const chosen = beds.find((b) => b.id === bedId);
  const clsInfo = list.options.classes.find((c) => c.key === cls);
  const submit = async () => {
    if (!ready || busy || !chosen) return;
    setBusy(true); setMsg(null);
    try {
      const v = await ipd.admit({ ...(req ? { admissionId: req.id } : { patientId: subjectId, source }), admittingDoctorId: doctor, department, diagnosis: diagnosis.trim(), bedClass: chosen.bedClass, bedId: chosen.id, guardian: { name: g.name.trim(), relationship: g.relationship, phone: g.phone.trim() }, consents,
        ...(packageId ? { packageId } : {}), ...(depMethod !== "none" && depPaisa ? { deposit: { method: depMethod, amountPaisa: depPaisa, reference: depRef.trim() } } : {}) }, key.current);
      await onAdmitted(v);
    } catch (e) {
      key.current = crypto.randomUUID();
      if (e instanceof ApiFailure && e.body.code === "stale") toast(I("stale_refresh"), "refresh-cw");
      setMsg(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : I("error_generic"));
    } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!req || cancelReason.trim().length < 5 || busy) return;
    setBusy(true);
    try { await ipd.cancel(req.id, cancelReason.trim(), cancelKey.current); await onCancelled(); }
    catch (e) { setMsg(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : I("error_generic")); }
    finally { setBusy(false); }
  };
  const toggleConsent = (k: string) => setConsents((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]));
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }} data-testid="admit-form">
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Segmented value={source} options={(["opd", "er", "direct"] as Src[]).map((k) => ({ value: k, label: I(`src_${k}`) }))} onChange={(v) => { if (!req) setSource(v); }} label={I("source")} />
        <span className="t-small t-muted" data-testid="source-note">{I(`src_note_${source}`)}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <SelectField label={I("doctor")} value={doctor} onChange={(e) => setDoctor(e.target.value)} data-testid="admit-doctor">
          <option value="">—</option>
          {list.options.doctors.map((d) => <option key={d.id} value={d.id}>{s.lang === "bn" ? d.nameBn : d.nameEn}{d.speciality ? ` · ${d.speciality}` : ""}</option>)}
        </SelectField>
        <SelectField label={I("department")} value={department} onChange={(e) => setDepartment(e.target.value)} data-testid="admit-department">
          {list.options.departments.map((d) => <option key={d.key} value={d.key}>{s.lang === "bn" ? d.nameBn : d.nameEn}</option>)}
        </SelectField>
      </div>
      <TextField label={I("diagnosis")} value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} placeholder={I("diagnosis_ph")} data-testid="admit-diagnosis" />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="t-small t-secondary">{I("bed_class")} <span className="t-muted">· {I("class_sample")}</span></span>
        <Segmented value={cls} options={list.options.classes.map((c) => ({ value: c.key, label: `${s.lang === "bn" ? c.nameBn : c.nameEn} ${I("per_day", { amount: format.takaFromPaisa(c.perDayPaisa, { bn: s.numerals === "bn" }) })}` }))} onChange={(c) => { setCls(c); if (chosen && chosen.bedClass !== c) setBedId(null); }} label={I("bed_class")} />
        {clsInfo && <span className="t-small t-muted num" data-testid="class-rate">{I("per_day", { amount: format.takaFromPaisa(clsInfo.perDayPaisa, { bn: s.numerals === "bn" }) })}</span>}
      </div>
      <BedPicker beds={beds} value={bedId} onPick={(id) => { setBedId(id); const b = beds.find((x) => x.id === id); if (b) setCls(b.bedClass); }} classes={list.options.classes} cls={cls} onClass={setCls} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <b className="t-small">{I("guardian")}</b>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1.4fr", gap: 10 }}>
          <TextField label={I("g_name")} value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} data-testid="guardian-name" />
          <SelectField label={I("g_relationship")} value={g.relationship} onChange={(e) => setG({ ...g, relationship: e.target.value })}>{RELS.map((r) => <option key={r} value={r}>{I(`rel_${r}`)}</option>)}</SelectField>
          <TextField label={I("g_phone")} value={g.phone} onChange={(e) => setG({ ...g, phone: e.target.value })} inputMode="tel" data-testid="guardian-phone" />
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <b className="t-small">{I("consents")}</b>
        {list.options.consents.map((c) => {
          const on = consents.includes(c.key);
          return (
            <label key={c.key} className="t-small" data-consent={c.key} data-consent-on={on ? "1" : "0"} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 8px", borderRadius: 8, border: `1px solid ${c.required && !on ? "var(--danger-border)" : on ? "var(--success-border)" : "var(--border-subtle)"}`, background: on ? "var(--success-bg)" : undefined }}>
              <input type="checkbox" checked={on} onChange={() => toggleConsent(c.key)} /> <span style={{ flex: 1 }}>{s.lang === "bn" ? c.nameBn : c.nameEn}</span>
              <span style={{ color: c.required && !on ? "var(--danger-fg)" : "var(--text-muted)" }}>{on ? I("signed") : c.required ? I("required") : I("optional")}</span>
            </label>
          );
        })}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="admit-package">
        <SelectField label={I("ad_package")} value={packageId} onChange={(e) => setPackageId(e.target.value)} data-testid="admit-package-pick">
          <option value="">{I("ad_no_package")}</option>
          {list.options.packages.map((p) => { const price = p.prices[chosen?.bedClass ?? cls]; return <option key={p.id} value={p.id} disabled={price === undefined}>{s.lang === "bn" ? p.nameBn : p.nameEn} · {price === undefined ? I("ad_package_no_class") : I("ad_package_price", { amount: format.takaFromPaisa(price, { bn: s.numerals === "bn" }), n: p.days })}</option>; })}
        </SelectField>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="admit-deposit">
        <b className="t-small">{I("ad_deposit")}</b>
        <span className="t-small t-muted">{I("ad_deposit_hint")}</span>
        <Segmented value={depMethod} onChange={(x) => setDepMethod(x as typeof depMethod)} label={I("ad_deposit")}
          options={[{ value: "none", label: "—" }, ...(["card", "bank"] as const).filter((m) => list.options.paymentMethods.includes(m)).map((m) => ({ value: m, label: s.t("billingApp", `m_${m}`) }))]} />
        {depMethod !== "none" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <TextField label={I("ad_dep_amount")} value={depAmount} onChange={(e) => setDepAmount(e.target.value)} inputMode="decimal" data-testid="admit-deposit-amount" />
            <TextField label={I("ad_dep_reference")} value={depRef} onChange={(e) => setDepRef(e.target.value)} data-testid="admit-deposit-reference" />
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid="checklist">
        <b className="t-small">{I("checklist")}</b>
        {checklist.map((c) => (
          <span key={c.key} className="t-small" data-check={c.key} data-check-ok={c.ok ? "1" : "0"} style={{ display: "flex", gap: 6, alignItems: "center", color: c.ok ? "var(--success-fg)" : c.blocks ? "var(--warning-fg)" : "var(--text-muted)" }}>
            <Pill tone={c.ok ? "ok" : c.blocks ? "warn" : "neu"} icon={c.ok ? "circle-check" : "circle-dashed"}>{c.key === "consents" && !c.ok && c.missing ? I("c_consents_missing", { n: c.missing }) : I(`c_${c.key}`)}</Pill>
          </span>
        ))}
      </div>
      {msg && <Callout tone="warn" icon="triangle-alert" data-testid="admit-error">{msg}</Callout>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Button variant="primary" icon="log-in" disabled={!ready || busy || !s.online || !doctor} onClick={() => void submit()} data-testid="admit">{busy ? I("admitting") : ready ? I("admit") : I("not_ready")}</Button>
        {req && !cancelOpen && <Button icon="undo-2" disabled={busy} onClick={() => setCancelOpen(true)} data-testid="cancel-request">{I("cancel_request")}</Button>}
        {!s.online && <span className="t-small t-muted">{I("needs_connection")}</span>}
      </div>
      {req && cancelOpen && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <TextArea label={I("cancel_reason")} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={2} name="cancelReason" />
          <Button variant="danger" icon="undo-2" disabled={busy || cancelReason.trim().length < 5} onClick={() => void cancel()} data-testid="cancel-confirm">{I("cancel_request")}</Button>
        </div>
      )}
    </Card>
  );
}
