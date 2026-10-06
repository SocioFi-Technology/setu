"use client";
/* nur/handover — ADR 0016 (walkthrough B5–B6). The shift handover of the remembered ward: every patient on the ward with
   the latest NEWS2, the open escalation (unacknowledged ones stand out), doses due / overdue, the 24-hour balance and
   open tasks, and the outgoing nurse's SBAR. The outgoing nurse marks each patient reviewed and signs with the PIN; a
   different nurse accepts with hers — and names every open escalation in the acceptance note — or queries it
   back to draft. Accepted is final; the board then shows who holds the ward. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { HandoverPatientView, HandoverView, WardHandover, WardList } from "@setu/contracts";
import { format } from "@setu/domain";
import { Button, Callout, Card, Pill, SelectField, TextArea, useToast } from "@setu/ui";
import { ApiFailure, ward } from "../../lib/api";
import { useSession } from "../../lib/session";
import { News2Pill, PinSheet, hhmm, rememberWard, rememberedWard, useErr, useLabels, useN } from "./common";

export function NurHandover() {
  const s = useSession(); const N = useN(); const err = useErr(); const toast = useToast();
  const [wards, setWards] = useState<WardList | null>(null); const [wardId, setWardId] = useState<string | null>(null);
  const [w, setW] = useState<WardHandover | null>(null); const [failed, setFailed] = useState<string | null>(null);
  const openKey = useRef(crypto.randomUUID());
  useEffect(() => {
    ward.wards().then((x) => { setWards(x); const saved = rememberedWard(); setWardId(x.wards.find((y) => y.id === saved)?.id ?? x.wards.find((y) => y.occupied > 0)?.id ?? x.wards[0]?.id ?? null); }).catch((e) => setFailed(err(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const load = useCallback(async () => { if (!wardId) return; try { setW(await ward.handover(wardId)); setFailed(null); } catch (e) { setFailed(err(e)); } }, [wardId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  if (failed && !w) return <Callout tone="warn" icon="triangle-alert">{failed}</Callout>;
  if (!wards) return <div aria-busy="true" className="t-muted">{N("loading")}</div>;
  const bn = s.lang === "bn"; const bnNum = s.numerals === "bn";
  const start = async () => {
    if (!wardId) return;
    try { const v = await ward.openHandover(wardId, openKey.current); openKey.current = crypto.randomUUID(); setW((x) => (x ? { ...x, handover: v } : x)); }
    catch (e) { if (e instanceof ApiFailure) openKey.current = crypto.randomUUID(); toast(err(e), "triangle-alert"); }
  };
  const h = w?.handover ?? null;
  return (
    <div data-screen="nur/handover" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0, flex: 1 }}>{N("ho_title")}</h1>
        <div style={{ minWidth: 220 }}>
          <SelectField label={N("ward")} value={wardId ?? ""} onChange={(e) => { rememberWard(e.target.value); if (e.target.value !== wardId) { setWardId(e.target.value); setW(null); } }} data-testid="ward-pick">
            {wards.wards.map((x) => <option key={x.id} value={x.id}>{bn ? x.nameBn ?? x.name : x.name}</option>)}
          </SelectField>
        </div>
      </div>
      {!w ? <div aria-busy="true" className="t-muted">{N("loading")}</div> : (<>
        <span className="t-small t-muted" data-testid="ho-shift">{N("ho_shift", { d: format.date(w.shift.day, bnNum), t: hhmm(w.shift.start, bnNum) })}{w.onDuty ? ` · ${N("ho_on_duty", { name: bn ? w.onDuty.nurse.nameBn : w.onDuty.nurse.nameEn, t: hhmm(w.onDuty.since, bnNum) })}` : ""}</span>
        {!h ? (
          <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
            <span>{N("ho_none")}</span>
            {s.me?.role === "nurse" && <div><Button variant="primary" icon="repeat" disabled={!s.online} onClick={() => void start()} data-testid="ho-open">{N("ho_open")}</Button></div>}
          </Card>
        ) : <Sheet key={h.id} h={h} onChanged={(v) => setW((x) => (x ? { ...x, handover: v } : x))} onReload={load} />}
      </>)}
    </div>
  );
}

function Sheet({ h, onChanged, onReload }: { h: HandoverView; onChanged: (v: HandoverView) => void; onReload: () => Promise<void> }) {
  const s = useSession(); const N = useN(); const err = useErr(); const toast = useToast();
  const [sign, setSign] = useState(false); const [accept, setAccept] = useState(false); const [note, setNote] = useState(""); const [query, setQuery] = useState(""); const [queryOpen, setQueryOpen] = useState(false);
  const signKey = useRef(crypto.randomUUID()); const acceptKey = useRef(crypto.randomUUID());
  const bn = s.lang === "bn"; const bnNum = s.numerals === "bn";
  const mine = h.outgoing.id === s.me?.userId;
  const draft = h.status === "draft";
  const save = async (encounterId: string, body: { sbar?: HandoverPatientView["sbar"]; reviewed?: boolean }) => {
    try { onChanged(await ward.handoverPatient(h.id, encounterId, { rev: h.rev, ...body })); }
    catch (e) { toast(err(e), "triangle-alert"); if (e instanceof ApiFailure && e.body.code === "stale") await onReload(); }
  };
  const escNames = h.openEscalations.map((u) => `${u.bed} (${u.name} · NEWS2 ${s.n(u.peakScore)}${u.unacknowledged ? ` · ${N("unacknowledged_short")}` : ""})`).join(", ");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="ho-sheet" data-ho-status={h.status}>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Pill tone={h.status === "accepted" ? "ok" : h.status === "draft" ? "draft" : "pend"}>{N(`hst_${h.status}`)}</Pill>
        {h.signedAt && <span className="t-small">{N("ho_signed_by", { name: bn ? h.outgoing.nameBn : h.outgoing.nameEn, t: hhmm(h.signedAt, bnNum) })}</span>}
        {h.incoming && h.acceptedAt && <span className="t-small">{N("ho_accepted_by", { name: bn ? h.incoming.nameBn : h.incoming.nameEn, t: hhmm(h.acceptedAt, bnNum) })}</span>}
        <span className="t-small t-muted">{s.L(h.sample.bn, h.sample.en)}</span>
      </span>
      {h.query && draft && <Callout tone="warn" icon="message-circle-question" data-testid="ho-query">{N("ho_query_from", { name: bn ? h.query.by.nameBn : h.query.by.nameEn, note: h.query.note })}</Callout>}
      {h.openEscalations.length > 0 && h.status !== "accepted" && <Callout tone="bad" icon="bell-ring" data-testid="ho-escalations">{N("ho_open_esc", { list: escNames })}</Callout>}
      {h.acceptNote && <Callout tone="info" icon="notebook-pen">{N("ho_accept_note")}: {h.acceptNote}</Callout>}
      {h.patients.map((p) => <PatientCard key={p.encounterId} p={p} editable={draft && mine && s.online} onSave={(b) => save(p.encounterId, b)} />)}
      {((draft && mine) || (h.status === "outgoing-signed" && !mine && s.me?.role === "nurse")) && <Card style={{ display: "flex", gap: 10, alignItems: "flex-end", padding: 12, flexWrap: "wrap" }}>
        {draft && mine && (<>
          {h.signBlockers.includes("not_all_reviewed") && <Pill tone="warn" icon="triangle-alert">{N("ho_not_all")}</Pill>}
          <Button variant="primary" icon="pen-line" disabled={h.signBlockers.length > 0 || !s.online} onClick={() => setSign(true)} data-testid="ho-sign">{N("ho_sign")}</Button>
        </>)}
        {h.status === "outgoing-signed" && !mine && s.me?.role === "nurse" && (<>
          <TextArea label={N("ho_accept_note")} value={note} onChange={(e) => setNote(e.target.value)} rows={2} name="acceptNote" data-testid="ho-accept-note" />
          <Button variant="primary" icon="badge-check" disabled={!s.online} onClick={() => setAccept(true)} data-testid="ho-accept">{N("ho_accept")}</Button>
          {!queryOpen ? <Button icon="message-circle-question" onClick={() => setQueryOpen(true)} data-testid="ho-query-open">{N("ho_query")}</Button> : (<>
            <TextArea label={N("ho_query_note")} value={query} onChange={(e) => setQuery(e.target.value)} rows={2} name="queryNote" />
            <Button disabled={query.trim().length < 5 || !s.online} onClick={() => void ward.queryHandover(h.id, { rev: h.rev, note: query.trim() }).then(onChanged).catch((e) => toast(err(e), "triangle-alert"))} data-testid="ho-query-send">{N("ho_query")}</Button>
          </>)}
        </>)}
      </Card>}
      {sign && <PinSheet title={N("ho_sign")} action={N("ho_sign")} onClose={() => setSign(false)} submit={async (pin) => {
        try { onChanged(await ward.signHandover(h.id, { rev: h.rev, pin }, signKey.current)); signKey.current = crypto.randomUUID(); setSign(false); }
        catch (e) { if (e instanceof ApiFailure) signKey.current = crypto.randomUUID(); if (e instanceof ApiFailure && e.body.code === "not_all_reviewed") { setSign(false); toast(err(e), "triangle-alert"); await onReload(); return; } throw e; }
      }} />}
      {accept && <PinSheet title={N("ho_accept")} action={N("ho_accept")} icon="badge-check" onClose={() => setAccept(false)} submit={async (pin) => {
        try { onChanged(await ward.acceptHandover(h.id, { rev: h.rev, pin, note: note.trim() }, acceptKey.current)); acceptKey.current = crypto.randomUUID(); setAccept(false); await onReload(); /* who holds the ward now */ }
        catch (e) { if (e instanceof ApiFailure) acceptKey.current = crypto.randomUUID(); if (e instanceof ApiFailure && (e.body.code === "escalation_not_named" || e.body.code === "sheet_outdated")) { setAccept(false); toast(err(e), "bell-ring"); return; } throw e; }
      }} />}
    </div>
  );
}

function PatientCard({ p, editable, onSave }: { p: HandoverPatientView; editable: boolean; onSave: (b: { sbar?: HandoverPatientView["sbar"]; reviewed?: boolean }) => Promise<void> }) {
  const s = useSession(); const N = useN(); const L = useLabels();
  const [sbar, setSbar] = useState(p.sbar);
  useEffect(() => { setSbar(p.sbar); }, [p.sbar.s, p.sbar.b, p.sbar.a, p.sbar.r]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = sbar.s !== p.sbar.s || sbar.b !== p.sbar.b || sbar.a !== p.sbar.a || sbar.r !== p.sbar.r;
  const bn = s.lang === "bn"; const bnNum = s.numerals === "bn";
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14, borderColor: p.escalation ? "var(--danger-border)" : undefined, opacity: p.onWard ? 1 : 0.6 }} data-ho-patient={p.patient.facilityNo} data-ho-reviewed={p.reviewed ? "1" : "0"}>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <b className="num">{p.bed}</b><b>{bn ? p.patient.nameBn : p.patient.nameEn || p.patient.nameBn}</b>
        <span className="t-small t-muted num">{p.patient.facilityNo} · {L.age(p.patient)} {L.sex(p.patient.sex)}</span>
        <News2Pill n={p.news2} />
        {p.escalation && <Pill tone="crit" icon="siren">{N("news2_n", { n: p.escalation.peakScore })}{p.escalation.unacknowledged ? ` · ${N("unacknowledged_short")}` : ""}</Pill>}
        {(p.doses.due > 0 || p.doses.overdue > 0) && <Pill tone={p.doses.overdue > 0 ? "bad" : "warn"} icon="pill">{N("ho_due", { due: p.doses.due, overdue: p.doses.overdue })}</Pill>}
        {p.ioBalance24hMl !== null && <Pill tone="neu" icon="droplet">{N("io_balance_card", { n: p.ioBalance24hMl })}</Pill>}
        {!p.onWard && <Pill tone="off">{N("ho_left")}</Pill>}
      </span>
      {p.openTasks.length > 0 && <span className="t-small">{p.openTasks.map((t) => `${t.text} (${hhmm(t.dueAt, bnNum)}${t.overdue ? ` · ${N("task_overdue")}` : ""})`).join(" · ")}</span>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
        {(["s", "b", "a", "r"] as const).map((k) => editable
          ? <TextArea key={k} label={N(`ho_${k}`)} value={sbar[k]} onChange={(e) => setSbar({ ...sbar, [k]: e.target.value })} rows={2} name={`sbar-${k}`} data-testid={`sbar-${k}`} />
          : <span key={k} className="t-small"><b>{N(`ho_${k}`)}</b><br />{p.sbar[k] || "—"}</span>)}
      </div>
      {editable && (
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {dirty && <Button size="sm" icon="save" onClick={() => void onSave({ sbar })} data-testid="sbar-save">{N("save")}</Button>}
          <label className="t-small" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={p.reviewed} onChange={(e) => void onSave({ ...(dirty ? { sbar } : {}), reviewed: e.target.checked })} data-testid="ho-reviewed" /> {N("ho_reviewed")}
          </label>
        </span>
      )}
      {!editable && p.reviewed && <span className="t-small t-muted">✓ {N("ho_reviewed")}</span>}
    </Card>
  );
}
