"use client";
/* er/orders — walkthrough B2. Ported from docs/prototype/Setu ER and OT.dc.html (screen "orders"): the patient strip,
   one-tap STAT lab orders (active the moment the server answers), the sample care-order list, the ER note, and the
   disposition (admit / discharge / refer / death) signed with the PIN. Admit reserves the ward bed and opens an
   admission request for the desk; the others close the visit. Signed = the server's answer, never a local state. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Disposition, ErBoard, ErVisitView } from "@setu/contracts";
import { ADMISSION_CLASSES, DEATH_CHECKS, DISPOSITIONS, dispositionBlockers, format, type DispositionKind } from "@setu/domain";
import { Button, Callout, Card, Dialog, PageState, Pill, TextArea, TextField, SelectField, useToast } from "@setu/ui";
import { ApiFailure, er } from "../../lib/api";
import { useSession } from "../../lib/session";
import { BedPicker } from "../ipd/BedPicker";
import { LevelPill, erBanner, hhmm, useE, useErr, useLabels } from "./common";

export function ErOrders() {
  const enc = useSearchParams().get("enc");
  return enc ? <OrdersScreen encounterId={enc} /> : <PickVisit />;
}
function PickVisit() {
  const s = useSession(); const E = useE(); const L = useLabels(); const router = useRouter();
  const [b, setB] = useState<ErBoard | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => { s.setPatient(null); er.board().then(setB).catch(() => setFailed(true)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <Callout tone="warn" icon="triangle-alert">{E("error_generic")}</Callout>;
  if (!b) return <div aria-busy="true" className="t-muted">{E("loading")}</div>;
  const open = b.items.filter((i) => ["arrived", "triaged", "in-progress"].includes(i.status));
  return (
    <div data-screen="er/orders" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{E("orders_title")}</h1>
      <span className="t-muted">{E("orders_pick_hint")}</span>
      {open.length === 0 ? <PageState icon="clipboard-list" title={E("orders_none")} actions={<Button icon="siren" onClick={() => router.push("/m/er/triage")}>{E("back_board")}</Button>} /> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
          {open.map((i) => (
            <button key={i.id} type="button" className="card" data-er-pick={i.token} onClick={() => router.push(`/m/er/orders?enc=${encodeURIComponent(i.id)}`)} style={{ display: "flex", flexDirection: "column", gap: 4, padding: 14, textAlign: "left", cursor: "pointer" }}>
              <span style={{ display: "flex", gap: 8, alignItems: "center" }}><b className="num" style={{ fontSize: 18 }}>{i.token}</b><LevelPill level={i.level} scale={b.scale} /></span>
              <b>{s.lang === "bn" ? i.patient.nameBn : i.patient.nameEn ?? i.patient.nameBn}</b>
              <span className="t-small t-muted num">{i.patient.facilityNo} · {L.age(i.patient)} {L.sex(i.patient.sex)}</span>
              <span className="t-small t-secondary">{i.complaint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const EMPTY: Disposition = { kind: "admit" };
function OrdersScreen({ encounterId }: { encounterId: string }) {
  const s = useSession(); const E = useE(); const L = useLabels(); const errOf = useErr(); const toast = useToast(); const router = useRouter();
  const [v, setV] = useState<ErVisitView | null>(null); const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState(""); const [notesDirty, setNotesDirtyS] = useState(false); const dirtyRef = useRef(false);
  const setNotesDirty = (v: boolean) => { dirtyRef.current = v; setNotesDirtyS(v); };
  const [d, setD] = useState<Disposition>(EMPTY);
  const [cls, setCls] = useState("");
  const [pin, setPin] = useState<null | "open">(null);
  // unsaved note text survives a reload (review): the dirty flag is read from a ref, never from a stale closure
  const load = useCallback(async () => { try { const x = await er.visit(encounterId); setV(x); setNotes((n) => (dirtyRef.current ? n : x.note.notes)); if (x.disposition && !x.canRedispose) setD(x.disposition); } catch { setFailed(true); } }, [encounterId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (v) s.setPatient(erBanner(v.item, L, v.allergies, s.lang)); }, [v?.item.id, v?.item.bay?.id, v?.allergies.length, s.lang, s.numerals]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <Callout tone="warn" icon="triangle-alert">{E("error_generic")}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{E("loading")}</div>;
  const signed = v.note.status !== "draft";
  // the desk cancelled the admit request: the disposition is open again (signed as an amendment, v2)
  const dispLocked = signed && !v.canRedispose;
  const open = ["arrived", "triaged", "in-progress"].includes(v.item.status);
  const canWrite = (s.me?.role === "doctor" || s.me?.role === "nurse") && !signed && open && s.online;
  const run = async (f: () => Promise<ErVisitView>) => {
    if (busy) return;
    setBusy(true);
    try { setV(await f()); }
    catch (e) { if (e instanceof ApiFailure && e.body.code === "stale") { toast(E("stale_refresh"), "refresh-cw"); await load(); } else toast(errOf(e), "triangle-alert"); }
    finally { setBusy(false); }
  };
  const blockers = dispositionBlockers(d);
  const fieldLabel = (f: string) => E(`f_${{ bedId: "bed", consultantId: "consultant", diagnosis: "diagnosis", advice: "advice", referTo: "refer_to", referReason: "refer_reason", timeOfDeath: "time_of_death", cause: "cause" }[f] ?? f}`);
  const set = (patch: Partial<Disposition>) => setD((x) => ({ ...x, ...patch }));
  const classes = ADMISSION_CLASSES.map((c) => ({ key: c.key, nameBn: c.nameBn, nameEn: c.nameEn }));
  // datetime-local is local time (review): local components out, local parse back in
  const dateTimeLocal = (iso: string | null | undefined) => { if (!iso) return ""; const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  return (
    <div data-screen="er/orders" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{E("orders_title")}</h1>
        <span style={{ marginLeft: "auto" }} />
        <Button icon="siren" onClick={() => router.push("/m/er/triage")}>{E("back_board")}</Button>
      </div>
      <Card style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 14px" }} data-testid="er-strip">
        <b className="num">{v.item.token}</b>
        <b>{s.lang === "bn" ? v.patient.nameBn : v.patient.nameEn ?? v.patient.nameBn}</b>
        <span className="t-small t-muted num">{v.patient.facilityNo} · {L.age(v.patient)} {L.sex(v.patient.sex)}</span>
        <LevelPill level={v.item.level} scale={v.scale} />
        {v.item.provisional && <Pill tone="warn" icon="user-search">{E("identity_provisional")}</Pill>}
        <Pill tone={v.allergies.some((a) => a.status === "active") ? "bad" : "ok"} icon="shield-alert">{v.allergies.filter((a) => a.status === "active").map((a) => (s.lang === "bn" ? a.labelBn : a.labelEn)).join(", ") || E("allergies_none")}</Pill>
        <span className="t-small">{v.item.doctor ? (s.lang === "bn" ? v.item.doctor.nameBn : v.item.doctor.nameEn) : <span style={{ color: "var(--warning-fg)" }}>{E("unassigned")}</span>}</span>
        {!open && <Pill tone="off">{E("status_closed")}</Pill>}
      </Card>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 14, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
            <b>{E("quick_orders")}</b><span className="t-small t-muted">{E("quick_orders_hint")}</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {v.tests.map((t) => {
                const o = v.orders.find((x) => x.testCode === t.code && x.status !== "revoked");
                return (
                  <button key={t.code} type="button" className="card" data-order={t.code} data-order-status={o ? o.status : "none"} disabled={!canWrite || Boolean(o) || busy} onClick={() => void run(() => er.order(v.item.id, t.code))}
                    style={{ padding: "6px 10px", display: "flex", gap: 6, alignItems: "center", cursor: o || !canWrite ? "default" : "pointer", background: o ? "var(--surface-selected)" : undefined, borderColor: o ? "var(--brand-primary)" : undefined }}>
                    <span>{s.lang === "bn" ? t.nameBn : t.nameEn}</span>
                    {o ? <Pill tone="crit" icon="zap">{E("ordered")}</Pill> : <Pill tone="neu" icon="plus">{E("add")}</Pill>}
                    {o?.protocol && !o.countersigned && <span data-protocol={t.code}><Pill tone="warn" icon="user-round-check" wrap>{E("protocol_awaiting")}</Pill></span>}
                    {o?.countersigned && <span data-countersigned={t.code}><Pill tone="ok" icon="user-round-check" wrap>{E("countersigned_by", { name: s.lang === "bn" ? o.countersigned.by.nameBn : o.countersigned.by.nameEn })}</Pill></span>}
                  </button>
                );
              })}
            </div>
          </Card>
          <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
            <b>{E("care_orders")}</b><span className="t-small t-muted" data-testid="care-sample">{E("care_sample")}</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {v.careOrders.map((c) => (
                <button key={c.key} type="button" className="card" data-care={c.key} data-care-on={c.on ? "1" : "0"} disabled={!canWrite || busy} onClick={() => void run(() => er.careOrder(v.item.id, c.key, !c.on))}
                  style={{ padding: "6px 10px", display: "flex", gap: 6, alignItems: "center", cursor: canWrite ? "pointer" : "default", background: c.on ? "var(--surface-selected)" : undefined, borderColor: c.on ? "var(--brand-primary)" : undefined }}>
                  <span>{s.lang === "bn" ? c.nameBn : c.nameEn}</span><span className="t-small t-muted">{c.detail}</span>
                  {c.on && <Pill tone="pend" icon="clock">{E("on")}</Pill>}
                  {c.on && c.protocol && !c.countersigned && <Pill tone="warn" icon="user-round-check" wrap>{E("protocol_awaiting")}</Pill>}
                  {c.countersigned && <Pill tone="ok" icon="user-round-check" wrap>{E("countersigned_by", { name: s.lang === "bn" ? c.countersigned.by.nameBn : c.countersigned.by.nameEn })}</Pill>}
                </button>
              ))}
            </div>
          </Card>
          <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }}>
            <TextArea label={E("notes")} value={notes} onChange={(e) => { setNotes(e.target.value); setNotesDirty(true); }} rows={4} placeholder={E("notes_ph")} disabled={!canWrite} data-testid="er-notes" />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Button icon="save" disabled={!canWrite || !notesDirty || busy} onClick={() => void run(async () => { const x = await er.notes(v.item.id, v.note.rev, notes); setNotesDirty(false); toast(E("notes_saved"), "check"); return x; })}>{E("save_notes")}</Button>
              {signed && <span className="t-small t-muted">{E("signed_by", { name: s.lang === "bn" ? v.note.signedBy?.nameBn ?? "—" : v.note.signedBy?.nameEn ?? "—", at: hhmm(v.note.signedAt, s.numerals === "bn") })}</span>}
            </div>
          </Card>
        </div>
        <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14 }} data-testid="disposition">
          <b>{E("disposition")}</b>
          {v.awaitingCountersign > 0 && !dispLocked && <Callout tone="warn" icon="user-round-check" data-testid="countersign-note">{E("countersign_note", { n: v.awaitingCountersign })}</Callout>}
          {v.canRedispose && <Callout tone="warn" icon="undo-2" data-testid="redispose">{E("redispose")}</Callout>}
          {dispLocked && v.disposition && <Callout tone="info" icon="badge-check" data-testid="disposition-signed">{E(`d_${v.disposition.kind}`)} · {E("signed_by", { name: s.lang === "bn" ? v.note.signedBy?.nameBn ?? "—" : v.note.signedBy?.nameEn ?? "—", at: hhmm(v.note.signedAt, s.numerals === "bn") })}{v.item.admission ? ` · ${E("admission_status", { status: E(`adm_${v.item.admission.status}`) })} · ${v.item.admission.bed.name}` : ""}</Callout>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
            {DISPOSITIONS.map((k) => (
              <button key={k} type="button" className="card" data-disposition={k} aria-pressed={d.kind === k} disabled={dispLocked} onClick={() => setD({ kind: k as DispositionKind })}
                style={{ padding: 10, textAlign: "center", cursor: dispLocked ? "default" : "pointer", borderWidth: d.kind === k ? 2 : 1, borderColor: d.kind === k ? (k === "death" ? "var(--neutral-800)" : "var(--brand-primary)") : undefined, background: d.kind === k ? "var(--surface-selected)" : undefined }}>
                <b>{E(`d_${k}`)}</b>
              </button>
            ))}
          </div>
          {d.kind === "admit" && (
            <>
              <SelectField label={E("f_consultant")} value={d.consultantId ?? ""} onChange={(e) => set({ consultantId: e.target.value || null })} disabled={dispLocked} data-testid="consultant-select">
                <option value="">—</option>
                {v.consultants.map((c) => <option key={c.id} value={c.id}>{s.lang === "bn" ? c.nameBn : c.nameEn}{c.speciality ? ` · ${c.speciality}` : ""}</option>)}
              </SelectField>
              <TextField label={E("f_diagnosis")} value={d.diagnosis ?? ""} onChange={(e) => set({ diagnosis: e.target.value })} disabled={dispLocked} data-testid="admit-diagnosis" />
              <span className="t-small t-secondary">{E("f_bed")}</span>
              <BedPicker beds={v.beds.map((b) => ({ ...b, mine: b.state === "reserved" && b.pickable }))} value={d.bedId ?? null} onPick={(id) => set({ bedId: id })} classes={classes} cls={cls} onClass={setCls} disabled={dispLocked} />
            </>
          )}
          {d.kind === "discharge" && (
            <>
              <TextArea label={E("f_advice")} value={d.advice ?? ""} onChange={(e) => set({ advice: e.target.value })} rows={2} disabled={dispLocked} data-testid="advice" />
              <TextField label={E("f_follow_up")} value={d.followUp ?? ""} onChange={(e) => set({ followUp: e.target.value })} disabled={dispLocked} />
            </>
          )}
          {d.kind === "refer" && (
            <>
              <TextField label={E("f_refer_to")} value={d.referTo ?? ""} onChange={(e) => set({ referTo: e.target.value })} disabled={dispLocked} data-testid="refer-to" />
              <TextField label={E("f_refer_reason")} value={d.referReason ?? ""} onChange={(e) => set({ referReason: e.target.value })} disabled={dispLocked} />
              <TextField label={E("f_transport")} value={d.transport ?? ""} onChange={(e) => set({ transport: e.target.value })} disabled={dispLocked} />
            </>
          )}
          {d.kind === "death" && (
            <>
              <TextField label={E("f_time_of_death")} type="datetime-local" value={dateTimeLocal(d.timeOfDeath)} onChange={(e) => set({ timeOfDeath: e.target.value ? new Date(e.target.value).toISOString() : null })} disabled={dispLocked} data-testid="time-of-death" />
              <TextField label={E("f_cause")} value={d.cause ?? ""} onChange={(e) => set({ cause: e.target.value })} disabled={dispLocked} data-testid="cause" />
              <label className="t-small" style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={Boolean(d.medicoLegal)} onChange={(e) => set({ medicoLegal: e.target.checked })} disabled={dispLocked} data-testid="medico-legal" /> {E("medico_legal")}</label>
              {DEATH_CHECKS.map((c) => (
                <label key={c} className="t-small" style={{ display: "flex", gap: 8, alignItems: "center" }} data-check={c}>
                  <input type="checkbox" checked={(d.checks ?? []).includes(c)} disabled={dispLocked} onChange={(e) => set({ checks: e.target.checked ? [...(d.checks ?? []), c] : (d.checks ?? []).filter((x) => x !== c) })} /> {E(`chk_${c}`)}
                </label>
              ))}
              {d.medicoLegal && !(d.checks ?? []).includes("police") && <Callout tone="warn" icon="shield-alert" data-testid="police-required">{E("police_required")}</Callout>}
            </>
          )}
          {!dispLocked && blockers.length > 0 && (
            <ul className="t-small t-secondary" style={{ margin: 0, paddingLeft: 18 }} data-testid="disposition-blockers">
              {blockers.map((b) => <li key={b.field}>{b.code === "police_required" ? E("police_required") : E("blocker_required", { field: b.field.startsWith("checks.") ? E(`chk_${b.field.slice(7)}`) : fieldLabel(b.field) })}</li>)}
            </ul>
          )}
          {!dispLocked && s.me?.role !== "doctor" && <span className="t-small t-muted">{E("sign_doctor_only")}</span>}
          <Button variant="primary" icon="pen-line" disabled={dispLocked || !open || s.me?.role !== "doctor" || blockers.length > 0 || !s.online || busy} onClick={() => setPin("open")} data-testid="sign-disposition">{dispLocked ? E("signed") : E("sign_disposition", { kind: E(`d_${d.kind}`) })}</Button>
          {!s.online && <span className="t-small t-muted">{E("needs_connection")}</span>}
        </Card>
      </div>
      {pin && <PinSheet view={v} disposition={d} onClose={() => setPin(null)} onSigned={(x) => { setPin(null); setV(x); const bed = x.item.admission?.bed.name ?? ""; toast(E(`msg_${d.kind}`, { bed }), "badge-check"); }} />}
    </div>
  );
}

function PinSheet({ view, disposition, onClose, onSigned }: { view: ErVisitView; disposition: Disposition; onClose: () => void; onSigned: (v: ErVisitView) => void }) {
  const s = useSession(); const E = useE();
  const [pin, setPin] = useState(""); const [waiting, setWaiting] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const ok = /^\d{4}$/.test(format.toEn(pin)) && s.online && !waiting;
  const submit = async () => {
    if (!ok) return;
    setWaiting(true); setMsg(null);
    try { onSigned(await er.sign(view.item.id, { rev: view.note.rev, pin: format.toEn(pin), disposition }, key.current)); }
    catch (e) {
      setPin("");
      if (e instanceof ApiFailure) {
        const b = e.body as typeof e.body & { triesLeft?: number; lockedUntil?: string };
        if (e.body.code === "pin_wrong") setMsg(E("pin_wrong", { n: b.triesLeft ?? 0 }));
        else if (e.body.code === "pin_locked") setMsg(E("pin_locked", { t: b.lockedUntil ? format.time(b.lockedUntil, s.numerals === "bn") : "—" }));
        else setMsg(s.L(e.body.message_bn, e.body.message_en));
      } else setMsg(E("error_generic"));
      setWaiting(false);
    }
  };
  return (
    <Dialog open onClose={() => { if (!waiting) onClose(); }} label={E("pin_title")} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }} data-testid="pin-sheet">
        <b className="t-h3">{E("sign_disposition", { kind: E(`d_${disposition.kind}`) })}</b>
        <TextField label={E("pin_label")} value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" type="password" maxLength={4} autoFocus name="pin" data-testid="pin" onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
        {waiting && <span className="t-small t-muted" aria-busy="true">{E("waiting_server")}</span>}
        {msg && <Callout tone="warn" icon="triangle-alert">{msg}</Callout>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onClose} disabled={waiting}>{E("cancel")}</Button>
          <Button variant="primary" icon="pen-line" disabled={!ok} onClick={() => void submit()} data-testid="pin-sign">{E("sign")}</Button>
        </div>
      </div>
    </Dialog>
  );
}
