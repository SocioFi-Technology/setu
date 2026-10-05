"use client";
/* nur/io — walkthrough B4. Nursing notes: append-only, newest first, written with the device time (offline they wait in
   the outbox and say "not yet synced"); a wrong note is marked entered-in-error with a reason by its writer and stays
   on the list struck through. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { NursingNoteView, WardPatientView } from "@setu/contracts";
import { noteOk } from "@setu/domain";
import { Button, Callout, Card, Pill, TextArea } from "@setu/ui";
import { ward } from "../../lib/api";
import { useSession } from "../../lib/session";
import { WardPatientPicker, hhmm, useErr, useN, useWardBanner } from "./common";

export function NurNotes() {
  const enc = useSearchParams().get("enc"); const N = useN();
  if (!enc) return <WardPatientPicker screen="nur/io" title={N("notes_title")} />;
  return <NotesFor key={enc} enc={enc} />;
}

function NotesFor({ enc }: { enc: string }) {
  const s = useSession(); const N = useN(); const err = useErr();
  const [v, setV] = useState<WardPatientView | null>(null); const [failed, setFailed] = useState<string | null>(null);
  const [text, setText] = useState(""); const [queued, setQueued] = useState<string[]>([]); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const load = useCallback(async () => { try { setV(await ward.patient(enc)); } catch (e) { setFailed(err(e)); } }, [enc]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  useWardBanner(v?.patient, v?.allergies, v?.bed ? `${v.bed.ward} · ${v.bed.name}` : null);
  if (failed) return <Callout tone="warn" icon="triangle-alert">{failed}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{N("loading")}</div>;
  const add = async () => {
    if (!noteOk(text) || busy) return; setBusy(true); setMsg(null);
    try {
      const r = await ward.note(enc, { text: text.trim(), effectiveAt: new Date().toISOString() }, key.current);
      key.current = crypto.randomUUID();
      if (r.queued) setQueued((q) => [text.trim(), ...q]); else await load();
      setText("");
    } catch (e) { key.current = crypto.randomUUID(); setMsg(err(e)); } finally { setBusy(false); }
  };
  return (
    <div data-screen="nur/io" style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 820 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{N("notes_title")}</h1>
      <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
        <TextArea label={N("notes_title")} value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={N("note_ph")} name="note" data-testid="note-text" />
        {msg && <Callout tone="warn" icon="triangle-alert">{msg}</Callout>}
        <div><Button variant="primary" icon="plus" disabled={!noteOk(text) || busy} onClick={() => void add()} data-testid="add-note">{N("add_note")}</Button></div>
      </Card>
      {queued.map((t, i) => <Card key={`q${i}`} style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4 }} data-note-queued="1"><span>{t}</span><Pill tone="pend" icon="cloud-off">{N("saved_queued")}</Pill></Card>)}
      {v.notes.length === 0 && queued.length === 0 && <span className="t-small t-muted">{N("note_none")}</span>}
      {v.notes.map((n) => <NoteCard key={n.id} n={n} mine={n.writtenBy.id === s.me?.userId} onChanged={load} />)}
    </div>
  );
}

function NoteCard({ n, mine, onChanged }: { n: NursingNoteView; mine: boolean; onChanged: () => Promise<void> }) {
  const s = useSession(); const N = useN(); const err = useErr();
  const [open, setOpen] = useState(false); const [reason, setReason] = useState(""); const [msg, setMsg] = useState<string | null>(null);
  const bad = n.status === "entered-in-error";
  const mark = async () => { try { await ward.noteError(n.id, reason.trim()); await onChanged(); } catch (e) { setMsg(err(e)); } };
  return (
    <Card style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4, opacity: bad ? 0.7 : 1 }} data-note={n.id} data-note-status={n.status}>
      <span style={{ textDecoration: bad ? "line-through" : undefined, whiteSpace: "pre-wrap" }}>{n.text}</span>
      <span className="t-small t-muted">{N("note_by", { name: s.lang === "bn" ? n.writtenBy.nameBn : n.writtenBy.nameEn, t: hhmm(n.effectiveAt, s.numerals === "bn") })}</span>
      {bad && n.error && <Pill tone="off">{N("st_entered-in-error")} · {n.error.reason}</Pill>}
      {!bad && mine && !open && <div><Button size="sm" icon="x" onClick={() => setOpen(true)} disabled={!s.online}>{N("mark_error")}</Button></div>}
      {open && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <TextArea label={N("reason")} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} name="reason" />
          <Button size="sm" variant="danger" disabled={reason.trim().length < 5} onClick={() => void mark()} data-testid="note-error">{N("mark_error")}</Button>
        </div>
      )}
      {msg && <Callout tone="warn" icon="triangle-alert">{msg}</Callout>}
    </Card>
  );
}
