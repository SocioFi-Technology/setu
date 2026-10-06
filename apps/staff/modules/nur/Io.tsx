"use client";
/* nur/io tabs (ADR 0016, walkthrough B5–B6). Intake & output: quick-add buttons and a free entry (route, mL, device
   time), totals for the shift day (08:00–08:00 Dhaka, sample) and the last 24 hours; entries wait in the outbox when
   offline and say "not yet synced"; a wrong one is marked entered-in-error by its writer. Care plan: tasks written by a
   nurse or a doctor (once, or every N hours), ticked by a nurse; overdue ones stand out. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CareTaskList, IoEntryRequest, IoView } from "@setu/contracts";
import { IO_ROUTES, careTaskTextOk, format, type IoSide } from "@setu/domain";
import { Button, Callout, Card, Pill, SelectField, TextArea, TextField, useToast } from "@setu/ui";
import { ApiFailure, ward } from "../../lib/api";
import { useSession } from "../../lib/session";
import { hhmm, useErr, useN } from "./common";

const QUICK: { side: IoSide; route: string; ml: number; icon: string }[] = [
  { side: "in", route: "oral", ml: 100, icon: "cup-soda" }, { side: "in", route: "oral", ml: 200, icon: "cup-soda" }, { side: "in", route: "iv", ml: 500, icon: "droplet" },
  { side: "out", route: "urine", ml: 200, icon: "beaker" }, { side: "out", route: "urine", ml: 400, icon: "beaker" },
];
const localInput = (d: Date) => { const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

export function IoPanel({ enc }: { enc: string }) {
  const s = useSession(); const N = useN(); const err = useErr(); const toast = useToast();
  const [v, setV] = useState<IoView | null>(null); const [queued, setQueued] = useState<IoEntryRequest[]>([]);
  const [side, setSide] = useState<IoSide>("in"); const [route, setRoute] = useState("oral"); const [ml, setMl] = useState(""); const [note, setNote] = useState(""); const [at, setAt] = useState(localInput(new Date()));
  const [busy, setBusy] = useState(false); const [errOpen, setErrOpen] = useState<string | null>(null); const [reason, setReason] = useState("");
  const load = useCallback(async () => { try { setV(await ward.io(enc)); } catch (e) { toast(err(e), "triangle-alert"); } }, [enc]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  const add = async (body: IoEntryRequest) => {
    if (busy) return; setBusy(true);
    try { const r = await ward.addIo(enc, body, crypto.randomUUID()); if (r.queued) setQueued((q) => [body, ...q]); else await load(); setMl(""); setNote(""); setAt(localInput(new Date())); }
    catch (e) { toast(err(e), "triangle-alert"); } finally { setBusy(false); }
  };
  const n = /^\d+$/.test(format.toEn(ml)) ? Number(format.toEn(ml)) : null;
  const markError = async (id: string) => { try { await ward.ioError(id, reason.trim()); setErrOpen(null); setReason(""); await load(); } catch (e) { toast(err(e), "triangle-alert"); } };
  if (!v) return <div aria-busy="true" className="t-muted">{N("loading")}</div>;
  const bnNum = s.numerals === "bn"; const mlS = (x: number) => N("io_ml_n", { n: x });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="io-panel">
      <Card style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, padding: 14 }} data-testid="io-totals" data-balance={v.totals.balanceMl}>
        <span><span className="t-small t-muted">{N("io_in")}</span><br /><b className="num">{mlS(v.totals.inMl)}</b></span>
        <span><span className="t-small t-muted">{N("io_out")}</span><br /><b className="num">{mlS(v.totals.outMl)}</b></span>
        <span><span className="t-small t-muted">{N("io_balance")}</span><br /><b className="num" style={{ color: v.totals.balanceMl < 0 ? "var(--warning-fg)" : undefined }}>{v.totals.balanceMl > 0 ? "+" : ""}{mlS(v.totals.balanceMl)}</b></span>
        <span className="t-small t-muted" style={{ gridColumn: "1 / -1" }}>{N("io_day", { d: format.date(v.day, bnNum), t: format.digits(`${String(v.dayStartHour).padStart(2, "0")}:00`, bnNum) })} · {N("io_24h", { i: mlS(v.last24h.inMl), o: mlS(v.last24h.outMl), b: mlS(v.last24h.balanceMl) })} · {s.L(v.sample.bn, v.sample.en)}</span>
      </Card>
      <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {QUICK.map((q, i) => <Button key={i} size="sm" icon={q.icon} disabled={busy} onClick={() => void add({ side: q.side, route: q.route, ml: q.ml, effectiveAt: new Date().toISOString() })} data-testid={`io-quick-${q.side}-${q.route}-${q.ml}`}>{N(`r_${q.route}`)} +{mlS(q.ml)}</Button>)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, alignItems: "end" }}>
          <SelectField label={N("io_in") + " / " + N("io_out")} value={side} onChange={(e) => { const x = e.target.value as IoSide; setSide(x); setRoute(IO_ROUTES[x][0]!); }} data-testid="io-side">
            <option value="in">{N("io_in")}</option><option value="out">{N("io_out")}</option>
          </SelectField>
          <SelectField label={N("io_route")} value={route} onChange={(e) => setRoute(e.target.value)} data-testid="io-route">
            {IO_ROUTES[side].map((r) => <option key={r} value={r}>{N(`r_${r}`)}</option>)}
          </SelectField>
          <TextField label={N("io_ml")} value={ml} onChange={(e) => setMl(e.target.value)} inputMode="numeric" data-testid="io-ml" />
          <TextField label={N("given_at")} type="datetime-local" value={at} max={localInput(new Date())} onChange={(e) => setAt(e.target.value)} data-testid="io-at" />
          <TextField label={N("io_note")} value={note} onChange={(e) => setNote(e.target.value)} />
          <Button variant="primary" icon="plus" disabled={busy || n === null || n < 1 || n > 5000} onClick={() => void add({ side, route, ml: n!, effectiveAt: new Date(at).toISOString(), note: note.trim() || undefined })} data-testid="io-add">{N("io_add")}</Button>
        </div>
      </Card>
      {queued.map((q, i) => <span key={`q${i}`} className="t-small" data-io-queued="1">{N(q.side === "in" ? "io_in" : "io_out")} · {N(`r_${q.route}`)} · {mlS(q.ml)} <Pill tone="pend" icon="cloud-off">{N("saved_queued")}</Pill></span>)}
      <Card style={{ display: "flex", flexDirection: "column", gap: 4, padding: 14 }} data-testid="io-entries">
        {v.entries.length === 0 && <span className="t-small t-muted">{N("io_none")}</span>}
        {v.entries.map((e) => (
          <div key={e.id} className="t-small" data-io={e.id} data-io-status={e.status} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ textDecoration: e.status === "entered-in-error" ? "line-through" : undefined }} className="num">{hhmm(e.effectiveAt, bnNum)} · {N(e.side === "in" ? "io_in" : "io_out")} · {N(`r_${e.route}`)} · <b>{mlS(e.ml)}</b>{e.note ? ` · ${e.note}` : ""} · {s.lang === "bn" ? e.writtenBy.nameBn : e.writtenBy.nameEn}</span>
            {e.status === "entered-in-error" && e.error && <span className="t-muted">{N("st_entered-in-error")}: {e.error.reason}</span>}
            {e.status === "active" && e.writtenBy.id === s.me?.userId && errOpen !== e.id && <Button size="sm" icon="x" disabled={!s.online} onClick={() => { setErrOpen(e.id); setReason(""); }}>{N("mark_error")}</Button>}
            {errOpen === e.id && (<span style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
              <TextField label={N("reason")} value={reason} onChange={(x) => setReason(x.target.value)} name="ioErrorReason" />
              <Button size="sm" variant="danger" disabled={reason.trim().length < 5 || !s.online} onClick={() => void markError(e.id)} data-testid="io-error-confirm">{N("mark_error")}</Button>
            </span>)}
          </div>
        ))}
      </Card>
    </div>
  );
}

export function CarePanel({ enc }: { enc: string }) {
  const s = useSession(); const N = useN(); const err = useErr(); const toast = useToast();
  const [l, setL] = useState<CareTaskList | null>(null);
  const [text, setText] = useState(""); const [every, setEvery] = useState(""); const [due, setDue] = useState(localInput(new Date()));
  const [busy, setBusy] = useState(false); const [cancelOpen, setCancelOpen] = useState<string | null>(null); const [reason, setReason] = useState("");
  const [early, setEarly] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const load = useCallback(async () => { try { setL(await ward.tasks(enc)); } catch (e) { toast(err(e), "triangle-alert"); } }, [enc]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  const run = async (f: () => Promise<CareTaskList>) => { setBusy(true); try { setL(await f()); } catch (e) { toast(err(e), "triangle-alert"); } finally { setBusy(false); } };
  const everyN = every.trim() === "" ? null : /^\d+$/.test(format.toEn(every)) ? Number(format.toEn(every)) : NaN;
  const canAdd = careTaskTextOk(text) && (everyN === null || (Number.isInteger(everyN) && everyN >= 1 && everyN <= 24)) && s.online && !busy;
  if (!l) return <div aria-busy="true" className="t-muted">{N("loading")}</div>;
  const bnNum = s.numerals === "bn";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="care-panel">
      <Card style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8, padding: 14, alignItems: "end" }}>
        <TextField label={N("task_text")} value={text} onChange={(e) => setText(e.target.value)} data-testid="task-text" />
        <TextField label={N("task_every")} value={every} onChange={(e) => setEvery(e.target.value)} inputMode="numeric" data-testid="task-every" />
        <TextField label={N("task_due")} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} data-testid="task-due" />
        <Button variant="primary" icon="plus" disabled={!canAdd} onClick={() => void run(async () => {
          try { const r = await ward.addTask(enc, { text: text.trim(), everyHours: everyN, dueAt: new Date(due).toISOString() }, key.current); key.current = crypto.randomUUID(); setText(""); setEvery(""); setDue(localInput(new Date())); return r; }
          catch (e) { if (e instanceof ApiFailure) key.current = crypto.randomUUID(); throw e; }
        })} data-testid="task-add">{N("task_add")}</Button>
      </Card>
      <span className="t-small t-muted">{s.L(l.sample.bn, l.sample.en)} · {N("task_doctor_only_writes")}</span>
      {l.open.length === 0 && <span className="t-small t-muted">{N("task_none")}</span>}
      {l.open.map((t) => (
        <Card key={t.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: 12, flexWrap: "wrap", borderColor: t.overdue ? "var(--danger-border)" : undefined }} data-task={t.text} data-task-overdue={t.overdue ? "1" : "0"}>
          <b style={{ flex: 1, minWidth: 160 }}>{t.text}</b>
          <span className="t-small">{t.everyHours ? N("task_every_n", { n: t.everyHours }) : N("task_once")} · {N("task_due_at", { t: hhmm(t.dueAt, bnNum) })}</span>
          {t.overdue && <Pill tone="bad" icon="clock-alert">{N("task_overdue")}</Pill>}
          {s.me?.role === "nurse" && early !== t.id && <Button size="sm" variant="primary" icon="check" disabled={busy || !s.online}
            onClick={() => { if (new Date(t.dueAt).getTime() - Date.now() > 30 * 60_000) setEarly(t.id); else void run(() => ward.completeTask(t.id, crypto.randomUUID())); }} data-testid="task-done">{N("task_done")}</Button>}
          {early === t.id && (<span style={{ display: "flex", gap: 6, alignItems: "center" }} data-testid="task-early">
            <span className="t-small" style={{ color: "var(--warning-fg)" }}>{N("task_not_due", { t: hhmm(t.dueAt, bnNum) })}</span>
            <Button size="sm" variant="primary" disabled={busy || !s.online} onClick={() => { setEarly(null); void run(() => ward.completeTask(t.id, crypto.randomUUID())); }} data-testid="task-done-anyway">{N("task_done_anyway")}</Button>
            <Button size="sm" onClick={() => setEarly(null)}>{N("cancel")}</Button>
          </span>)}
          {cancelOpen !== t.id ? <Button size="sm" icon="x" disabled={busy || !s.online} onClick={() => { setCancelOpen(t.id); setReason(""); }}>{N("task_cancel")}</Button> : (
            <span style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
              <TextArea label={N("reason")} value={reason} onChange={(e) => setReason(e.target.value)} rows={1} name="taskCancelReason" />
              <Button size="sm" variant="danger" disabled={reason.trim().length < 5 || busy} onClick={() => void run(async () => { const r = await ward.cancelTask(t.id, reason.trim()); setCancelOpen(null); return r; })} data-testid="task-cancel-confirm">{N("task_cancel")}</Button>
            </span>
          )}
        </Card>
      ))}
      {l.done.length > 0 && (
        <Card style={{ display: "flex", flexDirection: "column", gap: 4, padding: 12 }} data-testid="tasks-done">
          {l.done.map((t) => <span key={t.id} className="t-small t-muted" data-task-done={t.status}>{t.text} · {t.status === "completed" && t.completedBy ? N("task_done_by", { name: s.lang === "bn" ? t.completedBy.nameBn : t.completedBy.nameEn, t: hhmm(t.completedAt, bnNum) }) : `${N("task_cancel")}: ${t.cancel?.reason ?? ""}`}</span>)}
        </Card>
      )}
      {!s.online && <Callout tone="warn" icon="cloud-off">{N("needs_connection")}</Callout>}
    </div>
  );
}
