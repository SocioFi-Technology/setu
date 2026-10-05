"use client";
/* er/triage — walkthrough B1. Ported from docs/prototype/Setu ER and OT.dc.html (screen "triage"): the board by level
   with waiting minutes and ⚠ past target, the legend with counts, the right panel to triage (level 1–5 on the sample
   scale), assign a doctor (paediatric prompt, issue #24) and pick a bay; "New arrival" for a registered or an unknown
   patient. Everything comes from the server; the board refreshes every 15 s. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ErArrivalRequest, ErBoard, ErBoardItem, PatientSummary } from "@setu/contracts";
import { format, paediatricPrompt, triageOverdue } from "@setu/domain";
import { Button, Callout, Card, Dialog, PageState, Pill, Segmented, SelectField, TextArea, TextField, useToast } from "@setu/ui";
import { ApiFailure, er } from "../../lib/api";
import { useSession } from "../../lib/session";
import { LEVEL_TONE, erBanner, useE, useErr, useLabels, waitedNow } from "./common";

export function ErTriage() {
  const s = useSession(); const E = useE(); const L = useLabels(); const errOf = useErr(); const router = useRouter(); const toast = useToast();
  const [b, setB] = useState<ErBoard | null>(null); const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [arrival, setArrival] = useState(false);
  const [tick, setTick] = useState(0);
  const load = useCallback(async () => { try { setB(await er.board()); setFailed(false); } catch { setFailed(true); } }, []);
  useEffect(() => { void load(); const t = setInterval(() => { void load(); setTick((x) => x + 1); }, 15000); return () => clearInterval(t); }, [load]);
  const picked = b?.items.find((i) => i.id === sel) ?? null;
  useEffect(() => { s.setPatient(picked ? erBanner(picked, L, undefined, s.lang) : null); }, [picked?.id, picked?.bay?.id, s.lang, s.numerals]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const open = useMemo(() => (b?.items ?? []).filter((i) => ["arrived", "triaged", "in-progress"].includes(i.status)), [b]);
  const closedRows = useMemo(() => (b?.items ?? []).filter((i) => !["arrived", "triaged", "in-progress"].includes(i.status)), [b]);
  const name = (i: ErBoardItem) => (s.lang === "bn" ? i.patient.nameBn : i.patient.nameEn ?? i.patient.nameBn);
  const modeLabel = (m: ErBoardItem["arrivalMode"]) => E(`arr_${m}`);
  const levelOf = (n: number | null) => b?.scale.levels.find((l) => l.level === n);

  if (failed && !b) return <Callout tone="warn" icon="triangle-alert">{E("error_generic")}</Callout>;
  if (!b) return <div aria-busy="true" className="t-muted">{E("loading")}</div>;
  return (
    <div data-screen="er/triage" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{E("board_title")}</h1>
        <span className="t-small t-muted" data-testid="er-summary">{E("board_summary", { n: b.counts.total, over: b.counts.overTarget })}</span>
        <span style={{ marginLeft: "auto" }} />
        <Button variant="primary" icon="plus" onClick={() => setArrival(true)} data-testid="new-arrival">{E("new_arrival")}</Button>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }} aria-label={E("col_level")}>
        {b.scale.levels.map((l) => (
          <span key={l.level} data-legend={l.level}><Pill tone={LEVEL_TONE[l.tone] ?? "neu"} icon={l.icon} wrap>{s.lang === "bn" ? l.nameBn : l.nameEn} · {l.targetMinutes ? E("legend_within", { n: l.targetMinutes }) : E("legend_immediate")} {E("legend_count", { n: b.counts.byLevel[String(l.level)] ?? 0 })}</Pill></span>
        ))}
        <span data-legend="untriaged"><Pill tone="neu" icon="circle-dashed" wrap>{E("untriaged")} {E("legend_count", { n: b.counts.untriaged })}</Pill></span>
        {b.scale.sample && <span data-testid="scale-sample"><Pill tone="draft" icon="flask-conical" wrap>{E("scale_sample")}</Pill></span>}
      </div>
      {open.length === 0 && closedRows.length === 0 && <PageState icon="siren" title={E("board_empty")} body={E("board_empty_body")} actions={<Button variant="primary" icon="plus" onClick={() => setArrival(true)}>{E("new_arrival")}</Button>} />}
      {(open.length > 0 || closedRows.length > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 360px", gap: 14, alignItems: "start" }}>
          <Card style={{ padding: 0, overflowX: "auto" }}>
            <table className="table" data-testid="er-board" style={{ width: "100%" }}>
              <thead><tr><th>{E("col_no")}</th><th>{E("col_patient")}</th><th>{E("col_level")}</th><th>{E("col_complaint")}</th><th>{E("col_waiting")}</th><th>{E("col_doctor")}</th><th>{E("col_bay")}</th></tr></thead>
              <tbody>
                {open.map((i) => {
                  const w = waitedNow(i) + 0 * tick;
                  const over = triageOverdue(i.level, w, Boolean(i.doctor));
                  const on = i.id === sel;
                  return (
                    <tr key={i.id} data-er-row={i.id} data-token={i.token} data-level={i.level ?? "none"} data-overdue={over ? "1" : "0"} aria-selected={on} onClick={() => setSel(i.id)}
                      style={{ cursor: "pointer", background: on ? "var(--surface-selected)" : i.level === 1 ? "var(--result-critical-row)" : undefined, boxShadow: on ? "inset 3px 0 0 var(--brand-primary)" : (i.level ?? 9) <= 2 ? "inset 3px 0 0 var(--danger-solid)" : undefined }}>
                      <td className="num t-muted">{i.token}</td>
                      <td><b>{name(i)}</b><div className="t-small t-muted num">{i.patient.facilityNo} · {L.age(i.patient)} {L.sex(i.patient.sex)} · {modeLabel(i.arrivalMode)} {format.time(i.arrivedAt, s.numerals === "bn")}</div>{i.provisional && <Pill tone="warn" icon="user-search">{E("identity_provisional")}</Pill>}</td>
                      <td>{levelOf(i.level) ? <Pill tone={LEVEL_TONE[levelOf(i.level)!.tone] ?? "neu"} icon={levelOf(i.level)!.icon} wrap>{s.lang === "bn" ? levelOf(i.level)!.nameBn : levelOf(i.level)!.nameEn}</Pill> : <Pill tone="neu" icon="circle-dashed">{E("untriaged")}</Pill>}</td>
                      <td className="t-secondary">{i.complaint}</td>
                      <td className="num" style={{ color: over ? "var(--danger-fg)" : undefined, fontWeight: over ? 600 : 400, whiteSpace: "nowrap" }}>{over ? "⚠ " : ""}{E("waiting_min", { n: w })}</td>
                      <td style={{ color: i.doctor ? undefined : "var(--warning-fg)" }}>{i.doctor ? (s.lang === "bn" ? i.doctor.nameBn : i.doctor.nameEn) : E("unassigned")}</td>
                      <td>{i.bay ? i.bay.name : "—"}</td>
                    </tr>
                  );
                })}
                {closedRows.length > 0 && <tr><td colSpan={7} className="t-small t-muted">{E("closed_rows")}</td></tr>}
                {closedRows.map((i) => (
                  <tr key={i.id} data-er-row={i.id} data-token={i.token} data-closed="1" onClick={() => setSel(i.id)} style={{ cursor: "pointer", opacity: 0.7, background: i.id === sel ? "var(--surface-selected)" : undefined }}>
                    <td className="num t-muted">{i.token}</td><td><b>{name(i)}</b></td><td colSpan={2}>{i.disposition ? <Pill tone="final" icon="badge-check">{E(`d_${i.disposition.kind}`)}</Pill> : <Pill tone="off">{E("status_closed")}</Pill>}</td><td className="num">{format.time(i.arrivedAt, s.numerals === "bn")}</td><td>{i.doctor ? (s.lang === "bn" ? i.doctor.nameBn : i.doctor.nameEn) : "—"}</td><td>—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <TriagePanel key={picked?.id ?? "none"} b={b} item={picked} onChanged={load} onOpen={(id) => router.push(`/m/er/orders?enc=${encodeURIComponent(id)}`)} />
        </div>
      )}
      {arrival && <ArrivalDialog b={b} onClose={() => setArrival(false)} onDone={async (r) => { setArrival(false); toast(E("arrived_toast", { token: r.item.token }), "siren"); if (r.review) toast(E("review_toast"), "user-search"); await load(); setSel(r.item.id); }} />}
    </div>
  );
}

function TriagePanel({ b, item, onChanged, onOpen }: { b: ErBoard; item: ErBoardItem | null; onChanged: () => Promise<void>; onOpen: (id: string) => void }) {
  const s = useSession(); const E = useE(); const L = useLabels(); const errOf = useErr(); const toast = useToast(); const router = useRouter();
  const [level, setLevel] = useState<string>(item?.level ? String(item.level) : "");
  const [bay, setBay] = useState<string>(item?.bay?.id ?? "");
  const [doctor, setDoctor] = useState<string>(item?.doctor?.id ?? "");
  const [paedOk, setPaedOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!item) return <Card style={{ padding: 16 }}><span className="t-muted">{E("panel_pick")}</span></Card>;
  const openVisit = ["arrived", "triaged", "in-progress"].includes(item.status);
  const d = b.doctors.find((x) => x.id === doctor);
  const needPaed = Boolean(d && paediatricPrompt(d.speciality, item.ageYears) && !paedOk);
  const canVitals = Boolean(s.caps?.modules.find((m) => m.key === "fd")?.screens.find((x) => x.key === "vitals")?.allowed);
  // what Save would send (review: a bay change needs a level; nothing to send = nothing enabled)
  const lv = Number(format.toEn(level));
  const bayChanged = bay !== (item.bay?.id ?? ""), levelChanged = Boolean(lv) && lv !== item.level, doctorChanged = Boolean(doctor) && doctor !== (item.doctor?.id ?? "");
  const triageSend = Boolean(lv) && (levelChanged || bayChanged);
  const nothing = !triageSend && !doctorChanged;
  const bayNeedsLevel = bayChanged && !lv;
  const save = async () => {
    if (busy || !openVisit || nothing) return;
    setBusy(true); setMsg(null);
    try {
      if (triageSend) {
        const r = await er.triage(item.id, { level: lv as 1, bayId: bay ? bay : null });
        toast(E("triaged_toast", { token: r.token, level: lv }), "siren");
      }
      if (doctorChanged) {
        const r = await er.assign(item.id, { doctorId: doctor, paediatricOk: paedOk });
        toast(E("assigned_toast", { token: r.token, doctor: s.lang === "bn" ? r.doctor?.nameBn ?? "" : r.doctor?.nameEn ?? "" }), "stethoscope");
      }
      await onChanged();
    } catch (e) {
      if (e instanceof ApiFailure && e.body.code === "paediatric_confirm") setMsg(E("paed_prompt", { age: item.ageYears ?? 0 }));
      else if (e instanceof ApiFailure && e.body.code === "stale") { toast(E("stale_refresh"), "refresh-cw"); await onChanged(); }
      else setMsg(errOf(e));
    } finally { setBusy(false); }
  };
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }} data-testid="triage-panel">
      <div>
        <b style={{ fontSize: 16 }}>{s.lang === "bn" ? item.patient.nameBn : item.patient.nameEn ?? item.patient.nameBn}</b>
        <div className="t-small t-muted num">{item.patient.facilityNo} · {E("waiting_since", { token: item.token, n: waitedNow(item), mode: E(`arr_${item.arrivalMode}`) })}</div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {item.provisional ? <Pill tone="warn" icon="user-search">{E("identity_provisional")}</Pill> : <Pill tone={item.patient.identityConfidence === "verified" ? "ok" : "neu"} icon="shield-check">{s.t("frontDeskApp", `flag_${item.patient.identityConfidence === "verified" ? "verified" : "unverified"}`)}</Pill>}
        {item.disposition && <Pill tone="final" icon="badge-check">{E(`d_${item.disposition.kind}`)}</Pill>}
        {item.admission && <Pill tone="info" icon="bed-double">{E("admission_status", { status: E(`adm_${item.admission.status}`) })} · {item.admission.bed.name}</Pill>}
      </div>
      <span className="t-small num" data-testid="panel-vitals">{item.vitals ? s.n(item.vitals) : E("vitals_none")}</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="t-small t-secondary">{E("triage_level")} <span className="t-muted">· {E("scale_sample")}</span></span>
        <Segmented value={level} options={b.scale.levels.map((l) => ({ value: String(l.level), label: s.n(l.level) }))} onChange={setLevel} label={E("triage_level")} rawDigits />
      </div>
      <SelectField label={E("bay")} value={bay} onChange={(e) => setBay(e.target.value)} data-testid="bay-select" disabled={!openVisit}>
        <option value="">{E("bay_none")}</option>
        {b.bays.filter((x) => x.state === "vacant" || x.id === item.bay?.id).map((x) => <option key={x.id} value={x.id}>{x.name}{x.id === item.bay?.id ? "" : ` · ${E("st_vacant")}`}</option>)}
      </SelectField>
      <SelectField label={E("assign_doctor")} value={doctor} onChange={(e) => { setDoctor(e.target.value); setPaedOk(false); setMsg(null); }} data-testid="doctor-select" disabled={!openVisit}>
        <option value="">{E("doctor_none")}</option>
        {b.doctors.map((x) => <option key={x.id} value={x.id}>{s.lang === "bn" ? x.nameBn : x.nameEn}{x.speciality ? ` · ${x.speciality}` : ""}</option>)}
      </SelectField>
      {needPaed && (
        <Callout tone="warn" icon="baby" data-testid="paed-prompt">{E("paed_prompt", { age: item.ageYears ?? 0 })} <Button size="sm" onClick={() => { setPaedOk(true); setMsg(null); }} data-testid="paed-continue">{E("paed_continue")}</Button></Callout>
      )}
      {msg && !needPaed && <Callout tone="warn" icon="triangle-alert">{msg}</Callout>}
      {bayNeedsLevel && <span className="t-small t-secondary" data-testid="bay-needs-level">{E("bay_needs_level")}</span>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="primary" icon="check" disabled={busy || !openVisit || !s.online || needPaed || nothing} onClick={() => void save()} data-testid="save-triage">{E("save_triage")}</Button>
        {canVitals && openVisit && <Button icon="heart-pulse" onClick={() => router.push(`/m/fd/vitals?enc=${encodeURIComponent(item.id)}`)}>{E("record_vitals")}</Button>}
        <Button icon="clipboard-list" onClick={() => onOpen(item.id)} data-testid="open-orders">{E("open_orders")}</Button>
      </div>
      {!s.online && <span className="t-small t-muted">{E("needs_connection")}</span>}
    </Card>
  );
}

function ArrivalDialog({ b, onClose, onDone }: { b: ErBoard; onClose: () => void; onDone: (r: { item: ErBoardItem; review: boolean }) => Promise<void> }) {
  const s = useSession(); const E = useE(); const L = useLabels(); const errOf = useErr();
  const [mode, setMode] = useState<"registered" | "unknown">("registered");
  const [q, setQ] = useState(""); const [hits, setHits] = useState<PatientSummary[]>([]); const [picked, setPicked] = useState<PatientSummary | null>(null);
  const [sex, setSex] = useState<"male" | "female" | "other">("male"); const [age, setAge] = useState(""); const [features, setFeatures] = useState("");
  const [arrivalMode, setArrivalMode] = useState<ErArrivalRequest["arrivalMode"]>("walk-in"); const [broughtBy, setBroughtBy] = useState(""); const [complaint, setComplaint] = useState(""); const [bay, setBay] = useState("");
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => { er.search(q.trim()).then((r) => setHits(r.items ?? [])).catch(() => setHits([])); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const ready = complaint.trim().length >= 2 && (mode === "registered" ? Boolean(picked) : true);
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setMsg(null);
    try {
      const body: ErArrivalRequest = { arrivalMode, complaint: complaint.trim(), ...(broughtBy.trim() ? { broughtBy: broughtBy.trim() } : {}), ...(bay ? { bayId: bay } : {}),
        ...(mode === "registered" ? { patientId: picked!.id } : { unknown: { sex, approxAgeYears: format.toEn(age).trim() ? Number(format.toEn(age)) : null, ...(features.trim() ? { features: features.trim() } : {}) } }) };
      const r = await er.arrive(body, key.current);
      await onDone({ item: r.item, review: r.review });
    } catch (e) { setMsg(errOf(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={() => { if (!busy) onClose(); }} label={E("arrival_title")} width={640}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20, maxHeight: "85vh", overflowY: "auto" }} data-testid="arrival-dialog">
        <b className="t-h3">{E("arrival_title")}</b>
        <Segmented value={mode} options={[{ value: "registered", label: E("mode_registered") }, { value: "unknown", label: E("mode_unknown") }]} onChange={setMode} label={E("who")} />
        {mode === "registered" ? (
          <>
            <TextField label={E("search_patient")} value={q} onChange={(e) => setQ(e.target.value)} hint={E("search_hint")} data-testid="arrival-search" autoFocus />
            {picked ? <Pill tone="ok" icon="user-round">{E("picked")}: {s.lang === "bn" ? picked.nameBn : picked.nameEn ?? picked.nameBn} · {picked.facilityNo}</Pill> : hits.length === 0 && q.trim().length >= 2 ? <span className="t-small t-muted">{E("search_none")}</span> : null}
            {!picked && hits.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 180, overflowY: "auto" }} role="listbox">
                {hits.slice(0, 8).map((p) => <button key={p.id} type="button" role="option" className="card" data-patient={p.facilityNo} onClick={() => setPicked(p)} style={{ textAlign: "left", padding: "8px 10px", cursor: "pointer" }}><b>{s.lang === "bn" ? p.nameBn : p.nameEn ?? p.nameBn}</b> <span className="t-small t-muted num">{p.facilityNo} · {L.age(p)} {L.sex(p.sex)}</span></button>)}
              </div>
            )}
          </>
        ) : (
          <>
            <Callout tone="info" icon="user-search">{E("unknown_note")}</Callout>
            <Segmented value={sex} options={[{ value: "male", label: E("sex_male") }, { value: "female", label: E("sex_female") }, { value: "other", label: E("sex_other") }]} onChange={setSex} label={E("sex")} />
            <TextField label={E("approx_age")} value={age} onChange={(e) => setAge(e.target.value)} inputMode="numeric" data-testid="unknown-age" />
            <TextField label={E("features")} value={features} onChange={(e) => setFeatures(e.target.value)} placeholder={E("features_ph")} data-testid="unknown-features" />
          </>
        )}
        <Segmented value={arrivalMode} options={(["walk-in", "ambulance", "police", "public", "referral"] as const).map((m) => ({ value: m, label: E(`arr_${m}`) }))} onChange={setArrivalMode} label={E("arrival_mode")} />
        <TextField label={E("brought_by")} value={broughtBy} onChange={(e) => setBroughtBy(e.target.value)} />
        <TextArea label={E("complaint")} value={complaint} onChange={(e) => setComplaint(e.target.value)} placeholder={E("complaint_ph")} rows={2} data-testid="arrival-complaint" />
        <SelectField label={E("bay")} value={bay} onChange={(e) => setBay(e.target.value)} data-testid="arrival-bay">
          <option value="">{E("bay_none")}</option>
          {b.bays.filter((x) => x.state === "vacant").map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </SelectField>
        {msg && <Callout tone="warn" icon="triangle-alert">{msg}</Callout>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onClose} disabled={busy}>{E("cancel")}</Button>
          <Button variant="primary" icon="siren" disabled={!ready || busy || !s.online} onClick={() => void submit()} data-testid="arrival-submit">{E("register_arrival")}</Button>
        </div>
      </div>
    </Dialog>
  );
}
