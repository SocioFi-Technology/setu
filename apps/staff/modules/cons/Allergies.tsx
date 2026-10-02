"use client";
/* The allergy strip (ADR 0004): always visible above the note, never "no known allergies" by default (open question 52).
   Record allergy and Mark entered in error both wait for the server — the strip changes only after it answers — and
   an allergy is never deleted: entered-in-error keeps it on the record with who, when and why. */
import { useEffect, useRef, useState } from "react";
import type { AllergyOptions, AllergyView, ConsultationView, RecordAllergyRequest } from "@setu/contracts";
import { Button, Dialog, Icon, Segmented, useToast } from "@setu/ui";
import { ApiFailure, cons } from "../../lib/api";
import { useSession } from "../../lib/session";
import { activeAllergies, useC, useFmt } from "./common";

const SEVERITIES = ["mild", "moderate", "severe", "unknown"] as const;

export function AllergyStrip({ view, editable, onChanged }: { view: ConsultationView; editable: boolean; onChanged: () => Promise<void> }) {
  const s = useSession(); const C = useC(); const F = useFmt();
  const [recording, setRecording] = useState(false);
  const [marking, setMarking] = useState<AllergyView | null>(null);
  const active = activeAllergies(view.allergies);
  const errored = view.allergies.filter((a) => a.status === "entered-in-error");
  const label = (a: AllergyView) => s.L(a.labelBn, a.labelEn);
  return (
    <div role="region" aria-label={C("al_title")} data-testid="allergy-strip" className="card" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "10px 14px" }}>
      <b>{C("al_title")}</b>
      {active.length === 0 ? (
        <span className="allergy unknown" data-testid="allergy-none"><Icon name="circle-help" size={13} />{C("al_none")}</span>
      ) : active.map((a) => (
        <span key={a.id} style={{ display: "inline-flex", gap: 4, alignItems: "center" }} data-allergy={a.key ?? a.labelEn}>
          <span className="allergy" title={C("al_recorded", { name: F.name(a.recordedBy), at: F.dateTime(a.recordedAt) })}>
            <Icon name="triangle-alert" size={13} />{label(a)}{a.reaction ? ` · ${a.reaction}` : ""}{a.severity !== "unknown" ? ` · ${C(`sev_${a.severity}`)}` : ""}
          </span>
          {editable && (
            <Button size="sm" variant="ghost" icon="eraser" disabled={!s.online} title={s.online ? undefined : C("needs_connection")} aria-label={`${C("al_mark_error")}: ${label(a)}`} onClick={() => setMarking(a)}>
              {C("al_mark_error")}
            </Button>
          )}
        </span>
      ))}
      <span style={{ marginLeft: "auto" }} />
      {errored.length > 0 && <span className="t-small t-muted" data-testid="allergy-errored">{C("al_errors", { list: errored.map(label).join(", ") })}</span>}
      {editable && (
        <Button size="sm" icon="plus" disabled={!s.online} title={s.online ? undefined : C("needs_connection")} onClick={() => setRecording(true)}>{C("al_record")}</Button>
      )}
      {recording && <RecordAllergy view={view} onClose={() => setRecording(false)} onSaved={onChanged} />}
      {marking && <MarkError allergy={marking} encounterId={view.encounter.id} onClose={() => setMarking(null)} onSaved={onChanged} />}
    </div>
  );
}

function RecordAllergy({ view, onClose, onSaved }: { view: ConsultationView; onClose: () => void; onSaved: () => Promise<void> }) {
  const s = useSession(); const C = useC(); const toast = useToast();
  const [opts, setOpts] = useState<AllergyOptions | null>(null);
  const [kind, setKind] = useState<RecordAllergyRequest["kind"]>("class");
  const [key, setKey] = useState(""); const [text, setText] = useState(""); const [reaction, setReaction] = useState("");
  const [severity, setSeverity] = useState<RecordAllergyRequest["severity"]>("unknown");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  // One Idempotency-Key per filled-in form: pressing Save twice records once; a changed form is a new request.
  const idem = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => { cons.allergyOptions().then(setOpts).catch(() => setError(C("error_generic"))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = kind === "other" ? text.trim().length >= 2 : Boolean(key);
  const submit = async () => {
    if (!ready || busy) return;
    const body: RecordAllergyRequest = { encounterId: view.encounter.id, kind, severity, ...(kind === "other" ? { text: text.trim() } : { key }), ...(reaction.trim() ? { reaction: reaction.trim() } : {}) };
    const json = JSON.stringify(body);
    if (idem.current?.body !== json) idem.current = { body: json, key: crypto.randomUUID() };
    setBusy(true); setError(null);
    try {
      await cons.recordAllergy(view.encounter.patient.id, body, idem.current.key);
      toast(C("al_saved"), "check");
      await onSaved(); onClose();
    } catch (e) { setError(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : C("error_generic")); }
    finally { setBusy(false); }
  };
  const cap = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);
  return (
    <Dialog open onClose={onClose} label={C("al_record")} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="record-allergy">
        <b className="t-h3">{C("al_record")}</b>
        <Segmented label={C("al_kind")} value={kind} onChange={(v) => { setKind(v); setKey(""); }}
          options={[{ value: "class", label: C("al_kind_class") }, { value: "substance", label: C("al_kind_substance") }, { value: "other", label: C("al_kind_other") }]} />
        {kind === "other" ? (
          <>
            <label className="field"><span>{C("al_text")}</span><input className="input" name="allergy-text" value={text} onChange={(e) => setText(e.target.value)} maxLength={100} /></label>
            <span className="t-small t-muted">{C("al_other_note")}</span>
          </>
        ) : (
          <label className="field">
            <span>{kind === "class" ? C("al_class") : C("al_substance")}</span>
            <select className="input" name="allergy-key" value={key} onChange={(e) => setKey(e.target.value)}>
              <option value="">{C("al_choose")}</option>
              {kind === "class" ? opts?.classes.map((c) => <option key={c.key} value={c.key}>{s.L(c.bn, c.en)}</option>)
                : opts?.ingredients.map((i) => <option key={i} value={i}>{cap(i)}</option>)}
            </select>
          </label>
        )}
        <label className="field"><span>{C("al_reaction")}</span><input className="input" name="allergy-reaction" placeholder={C("al_reaction_ph")} value={reaction} onChange={(e) => setReaction(e.target.value)} maxLength={200} /></label>
        <span className="field"><span>{C("al_severity")}</span>
          <Segmented label={C("al_severity")} value={severity} onChange={setSeverity} options={SEVERITIES.map((v) => ({ value: v, label: C(`sev_${v}`) }))} />
        </span>
        {error && <span className="field-error" role="alert">{error}</span>}
        <span role="status" className="t-small t-muted">{busy ? C("sync_saving") : ""}</span>
        <span style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onClose}>{C("cancel")}</Button>
          <Button variant="primary" icon="save" disabled={!ready || busy || !s.online} onClick={() => void submit()}>{C("al_save")}</Button>
        </span>
      </div>
    </Dialog>
  );
}

function MarkError({ allergy, encounterId, onClose, onSaved }: { allergy: AllergyView; encounterId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const s = useSession(); const C = useC(); const toast = useToast();
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const idem = useRef<{ body: string; key: string } | null>(null);
  const ok = reason.trim().length >= 10;
  const submit = async () => {
    if (!ok || busy) return;
    if (idem.current?.body !== reason.trim()) idem.current = { body: reason.trim(), key: crypto.randomUUID() };
    setBusy(true); setError(null);
    try {
      await cons.markAllergyError(allergy.id, encounterId, reason.trim(), idem.current.key);
      toast(C("al_error_done"), "check");
      await onSaved(); onClose();
    } catch (e) { setError(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : C("error_generic")); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} label={C("al_error_title")} width={520}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="mark-allergy-error">
        <b className="t-h3">{C("al_error_title")}</b>
        <span className="allergy" style={{ alignSelf: "flex-start" }}><Icon name="triangle-alert" size={13} />{s.L(allergy.labelBn, allergy.labelEn)}</span>
        <span className="t-small">{C("al_error_body")}</span>
        <label className="field">
          <span>{C("al_error_reason")}</span>
          <textarea className="input" name="allergy-error-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          <span className="t-small t-muted num">{s.n(reason.trim().length)}/10</span>
        </label>
        {error && <span className="field-error" role="alert">{error}</span>}
        <span role="status" className="t-small t-muted">{busy ? C("sync_saving") : ""}</span>
        <span style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onClose}>{C("cancel")}</Button>
          <Button variant="danger" disabled={!ok || busy || !s.online} onClick={() => void submit()}>{C("al_error_confirm")}</Button>
        </span>
      </div>
    </Dialog>
  );
}
