"use client";
/* cons/draft — walkthrough A5. Ported from docs/prototype/Setu Consultation.dc.html.
   Without ?enc the doctor's list for today; with it the note of that visit. Opening it as a doctor moves the visit to
   "With doctor" (server, ENCOUNTER start). Every change autosaves to the server with check-and-set on `rev`; the status
   says "Not yet synced" until the server answers, and offline the draft is kept on this device only (per user, 24 h,
   cleared at sign-out). Nothing on this screen is ever shown as signed: that is the signed screen, after the server. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ConsultationView, TestList, VitalsView } from "@setu/contracts";
import { parseComplaint, signBlockers, type SectionKey } from "@setu/domain";
import { Button, Callout, Card, Dialog, Icon, PageState, Pill, Segmented, useToast } from "@setu/ui";
import { ApiFailure, cons, vitals as vitalsApi } from "../../lib/api";
import { deviceDraft, dropDeviceDraft, flush, saveDeviceDraft, type DeviceDraft } from "../../lib/outbox";
import { useSession } from "../../lib/session";
import { AiPanel, type AiInsert } from "./Ai";
import { AllergyStrip } from "./Allergies";
import { activeAllergies, bodyOf, changedParts, factsOf, formOf, isForm, rxLinesOf, useBanner, useC, useConsNav, useFmt, type Dx, type Form } from "./common";
import { RxBuilder } from "./Rx";
import { SignSheet } from "./SignSheet";
import { PrintPanel } from "../../components/PrintPanel";
import { ConsultWorklist } from "./Worklist";

export function ConsultDraft() {
  const enc = useSearchParams().get("enc");
  return enc ? <DraftLoader key={enc} encounterId={enc} /> : <ConsultWorklist />;
}

/** The note editor for one visit (also the doctor app's quick consult, inside a ConsNavContext). */
export function ConsultEditor({ encounterId }: { encounterId: string }) {
  return <DraftLoader key={encounterId} encounterId={encounterId} />;
}

function DraftLoader({ encounterId }: { encounterId: string }) {
  const s = useSession(); const C = useC(); const router = useRouter(); const banner = useBanner(); const nav = useConsNav();
  const [view, setView] = useState<ConsultationView | null>(null);
  const [failure, setFailure] = useState<ApiFailure | "offline" | "error" | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      // A device copy of this user's drafts goes to the server first, so the note opens on the latest version.
      try { await flush(); const v = await cons.open(encounterId); if (live) setView(v); }
      catch (e) { if (live) setFailure(e instanceof ApiFailure ? e : navigator.onLine ? "error" : "offline"); }
    })();
    return () => { live = false; };
  }, [encounterId]);
  useEffect(() => { if (view) s.setPatient(banner(view)); }, [view, s.lang, s.numerals]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (view && !view.draft && view.current) router.replace(nav.signed(encounterId)); }, [view, encounterId, router]); // eslint-disable-line react-hooks/exhaustive-deps

  if (failure instanceof ApiFailure) return <Callout tone={failure.status === 403 ? "bad" : "warn"} icon={failure.status === 403 ? "lock" : "triangle-alert"} data-testid="cons-denied">{s.L(failure.body.message_bn, failure.body.message_en)}</Callout>;
  if (failure) return <Callout tone="warn" icon={failure === "offline" ? "cloud-off" : "triangle-alert"}>{failure === "offline" ? C("offline_banner") : C("error_generic")}</Callout>;
  if (!view) return <div aria-busy="true" className="t-muted">{C("loading")}</div>;
  if (!view.draft) return view.current ? <div aria-busy="true" className="t-muted">{C("loading")}</div> : <PageState icon="file-question" title={C("no_note")} />;
  return <Editor key={view.draft.id} initial={view} onView={setView} />;
}

type Sync = { st: "saved"; at: string } | { st: "dirty" } | { st: "saving" } | { st: "device" } | { st: "failed"; msg: string };

function Editor({ initial, onView }: { initial: ConsultationView; onView: (v: ConsultationView) => void }) {
  const nav = useConsNav();
  const s = useSession(); const C = useC(); const F = useFmt(); const router = useRouter(); const toast = useToast();
  const [view, setViewS] = useState(initial);
  const setView = useCallback((v: ConsultationView) => { setViewS(v); onView(v); }, [onView]);
  const draft = view.draft!;
  const id = draft.id, encounterId = view.encounter.id;
  const editable = !view.readOnly && draft.status === "draft" && draft.author.id === s.me?.userId;
  const [form, setForm] = useState<Form>(() => formOf(draft));
  const [conflict, setConflict] = useState<DeviceDraft | null>(() => { const d = deviceDraft(id); return d?.conflict ? d : null; });
  const [confirmLoad, setConfirmLoad] = useState(false);

  /* ── autosave ── */
  const revRef = useRef(draft.rev);
  const formRef = useRef(form); formRef.current = form;
  const [sync, setSyncS] = useState<Sync>({ st: "saved", at: draft.updatedAt });
  const syncRef = useRef(sync);
  const setSync = (x: Sync) => { syncRef.current = x; setSyncS(x); };
  const timer = useRef<number | undefined>(undefined);
  const saving = useRef(false), again = useRef(false);
  /** what the server holds, as a save body: a render that changes nothing (React dev runs effects twice) saves nothing */
  const lastSaved = useRef(JSON.stringify(bodyOf(form)));
  /** a copy of this note went to the device: the server's rev must be read back before the next save (the outbox may
      have sent the copy in the background meanwhile — clinical review A5, the reconnect race) */
  const deviceKept = useRef(Boolean(deviceDraft(id) && !deviceDraft(id)!.conflict));
  /** the conflict copy the doctor chose to load: dropped only once the server accepts it */
  const pendingDrop = useRef(false);

  /** The server's version replaces the screen's (after a 409 stale, or a device copy that lost a conflict). */
  const adoptServer = useCallback(async () => {
    const v = await cons.view(encounterId);
    if (!v.draft) { router.replace(v.current ? nav.signed(encounterId) : nav.draft(encounterId)); return; }
    const f = formOf(v.draft); lastSaved.current = JSON.stringify(bodyOf(f)); // taking the server's copy is not an edit
    revRef.current = v.draft.rev; setForm(f); setView(v); setSync({ st: "saved", at: v.draft.updatedAt });
  }, [encounterId, router, setView]);

  /** A device copy of this note waits: send it first (with the rev it was based on), then carry on from the server.
      The outbox may already have sent it when the browser came back online — then only the rev is read back. */
  const syncDevice = useCallback(async (): Promise<void> => {
    const before = deviceDraft(id);
    const sending = Boolean(before && !before.conflict);
    if (sending) await flush();
    const after = deviceDraft(id);
    if (after && !after.conflict) { setSync({ st: "device" }); return; } // still offline or the server is down
    deviceKept.current = false;
    if (sending && after?.conflict) { setConflict(after); await adoptServer(); return; }
    const v = await cons.view(encounterId);
    if (!v.draft) { router.replace(nav.signed(encounterId)); return; }
    revRef.current = v.draft.rev; setView(v); lastSaved.current = JSON.stringify(bodyOf(formOf(v.draft)));
    if (JSON.stringify(bodyOf(formRef.current)) === lastSaved.current) setSync({ st: "saved", at: v.draft.updatedAt });
    else void save(); // typed more since the device copy
  }, [id, encounterId, adoptServer, router, setView]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(timer.current); timer.current = undefined;
    if (saving.current) { again.current = true; return false; }
    const f = formRef.current, body = bodyOf(f), snap = JSON.stringify(body), key = crypto.randomUUID();
    const toDevice = (k?: string) => { saveDeviceDraft({ compositionId: id, encounterId, baseRev: revRef.current, body, form: f }, k); deviceKept.current = true; setSync({ st: "device" }); };
    if (!navigator.onLine) { toDevice(); return false; }
    const waiting = deviceDraft(id);
    if (deviceKept.current || (waiting && !waiting.conflict)) { await syncDevice(); return syncRef.current.st === "saved"; }
    saving.current = true; setSync({ st: "saving" });
    try {
      const c = await cons.save(id, { ...body, rev: revRef.current }, key);
      revRef.current = c.rev; lastSaved.current = snap;
      if (pendingDrop.current || !deviceDraft(id)?.conflict) { dropDeviceDraft(id); pendingDrop.current = false; }
      if (JSON.stringify(bodyOf(formRef.current)) === snap) { setSync({ st: "saved", at: c.updatedAt }); return true; }
      again.current = true; return false;
    } catch (e) {
      if (e instanceof ApiFailure) {
        if (e.status === 409 && e.body.code === "stale") {
          // Clinical review A5: what the doctor typed is kept as a device copy before the server's version is shown.
          const mine = formRef.current;
          saveDeviceDraft({ compositionId: id, encounterId, baseRev: revRef.current, body: bodyOf(mine), form: mine, conflict: true });
          pendingDrop.current = false;
          await adoptServer();
          const d = deviceDraft(id);
          if (d && JSON.stringify(d.body) !== lastSaved.current) setConflict(d);
          else { dropDeviceDraft(id); setConflict(null); toast(C("stale_reloaded"), "refresh-cw"); }
        }
        else if (e.status === 409 && e.body.code === "not_draft") { router.replace(nav.signed(encounterId)); }
        else setSync({ st: "failed", msg: s.L(e.body.message_bn, e.body.message_en) });
        return false;
      }
      toDevice(key); return false; // the network dropped: same key, so a replay of this body is the same request
    } finally {
      saving.current = false;
      if (again.current) { again.current = false; void save(); }
    }
  }, [id, encounterId, syncDevice, adoptServer, router, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!editable || (timer.current === undefined && JSON.stringify(bodyOf(form)) === lastSaved.current)) return;
    setSync({ st: "dirty" });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 1200);
  }, [form]); // eslint-disable-line react-hooks/exhaustive-deps
  // Back online with a device copy waiting: send it.
  useEffect(() => { if (s.online && (syncRef.current.st === "device" || deviceKept.current)) void syncDevice(); }, [s.online, syncDevice]);
  // Allergies (or the note) may change elsewhere while the doctor writes (a nurse records one): re-read on return.
  useEffect(() => {
    const back = () => { if (document.visibilityState === "visible" && navigator.onLine) void cons.view(encounterId).then(setView).catch(() => {}); };
    window.addEventListener("focus", back); document.addEventListener("visibilitychange", back);
    return () => { window.removeEventListener("focus", back); document.removeEventListener("visibilitychange", back); };
  }, [encounterId, setView]);
  // Leaving the screen with an unsaved change: save now; closing the tab asks first. A draft already kept on this device
  // does not ask (it is kept until sent; sign-out clears it, as decided).
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (["dirty", "saving", "failed"].includes(syncRef.current.st)) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      // Clinical review A5: leaving with text the server has not confirmed keeps it on the device first, then sends it.
      if (editable && (timer.current !== undefined || syncRef.current.st === "failed")) {
        window.clearTimeout(timer.current);
        const f = formRef.current;
        if (saveDeviceDraft({ compositionId: id, encounterId, baseRev: revRef.current, body: bodyOf(f), form: f })) void flush();
      }
    };
  }, [editable, id, encounterId]);

  const upd = (fn: (f: Form) => Form) => { if (editable) setForm(fn); };
  const setSection = <K extends keyof Form["sections"]>(k: K, v: Form["sections"][K]) => upd((f) => ({ ...f, sections: { ...f.sections, [k]: v } }));

  /** Before signing: the note must be on the server exactly as shown (sign sends the rev the server holds). */
  const ensureSaved = useCallback(async (): Promise<boolean> => {
    if (!navigator.onLine) return false;
    if (timer.current !== undefined || syncRef.current.st !== "saved") await save();
    for (let i = 0; i < 50 && (saving.current || timer.current !== undefined); i++) await new Promise((r) => setTimeout(r, 200));
    return syncRef.current.st === "saved";
  }, [save]);
  const [signing, setSigning] = useState(false);
  const [preview, setPreview] = useState(false);
  const openSign = useCallback(() => { if (editable && navigator.onLine) setSigning(true); }, [editable]);

  /** Text the doctor takes from the AI draft is editable, and its section stays ai-draft until "I reviewed" + sign. */
  const append = (old: string, add: string) => (old.trim() ? `${old.trim()}\n${add}` : add);
  const insertAi = (i: AiInsert) => upd((f) => i.at === "history"
    ? { ...f, sections: { ...f.sections, history: append(f.sections.history, i.text) }, sources: { ...f.sources, history: "ai-draft" } }
    : { ...f, sections: { ...f.sections, exam: { ...f.sections.exam, [i.field]: append(f.sections.exam[i.field], i.text) } }, sources: { ...f.sources, exam: "ai-draft" } });

  /** Allergies changed on the server: re-read the view (the note being typed stays as it is). */
  const refresh = useCallback(async () => { setView(await cons.view(encounterId)); }, [encounterId, setView]);

  /* ── keyboard: Alt+1…9 jumps to a section; "/" focuses the medicine search (issue #9; the shell leaves "/" to cons);
     Ctrl+Enter opens the sign sheet (never signs by itself: the PIN is always asked); Esc closes dialogs. ── */
  const rxSearch = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = Boolean(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable));
      if (document.querySelector("[role=dialog]")) return; // a sheet or dialog is open: its own keys apply
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openSign(); return; }
      if (e.key === "/" && !inField && !e.ctrlKey && !e.altKey && !e.metaKey && rxSearch.current) {
        e.preventDefault(); rxSearch.current.focus(); rxSearch.current.scrollIntoView({ block: "center" }); return;
      }
      if (e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault();
        const el = document.getElementById(`sec-${e.code.slice(5)}`);
        el?.scrollIntoView({ block: "start", behavior: "smooth" });
        (el?.querySelector("input:not([disabled]), textarea:not([disabled]), button:not([disabled])") as HTMLElement | null)?.focus();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [openSign]);

  const isAmendment = Boolean(draft.amendsId);
  const amended = isAmendment ? view.history.find((h) => h.id === draft.amendsId) : undefined;
  const ai = (k: SectionKey) => form.sources[k] === "ai-draft";
  // What blocks the Sign button (the two ticks live on the sign sheet). The sheet and the server re-run the same check.
  const hardBlockers = signBlockers({ sections: form.sections, sources: form.sources, diagnoses: form.diagnoses, lines: rxLinesOf(form.lines), allergies: factsOf(view.allergies), aiReviewed: true, uncodedAllergiesChecked: true, isAmendment, amendReason: draft.amendReason }).length;

  return (
    <div data-screen={nav.phone ? "doc/consult" : "cons/draft"} style={{ display: "flex", flexDirection: "column", gap: nav.phone ? 12 : 16, minWidth: 0, paddingBottom: nav.phone ? 140 : 72 }}>
      {nav.phone && <PhoneHead view={view} />}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className={nav.phone ? "t-h3" : "t-h2"} style={{ margin: 0 }}>{isAmendment ? C("title_amend_draft") : C("title_draft")}</h1>
        <Pill tone="neu" icon="ticket">{C("token", { t: view.encounter.token })}</Pill>
        <Pill tone="draft" icon="pen-line">{C("draft_v", { v: draft.version })}</Pill>
        <SyncPill sync={sync} onRetry={() => void save()} />
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="printer" data-testid="draft-print-preview" onClick={() => setPreview(true)}>{C("print_preview")}</Button>
        <Button size="sm" icon="arrow-left" onClick={() => router.push(nav.list())}>{C("back_to_list")}</Button>
      </div>
      {!s.online && <Callout tone="warn" icon="cloud-off" data-testid="cons-offline">{C("offline_banner")}</Callout>}
      {view.criticalVitals && <Callout tone="bad" icon="siren" role="alert" data-testid="critical-vitals">{C("critical_banner")}</Callout>}
      {!editable && <Callout icon="lock">{C("read_only")}</Callout>}
      {isAmendment && <Callout icon="history" data-testid="amending">{C("amending_info", { from: amended?.version ?? draft.version - 1, reason: draft.amendReason ?? "" })}</Callout>}
      {conflict && (
        <Callout tone="warn" icon="git-compare" data-testid="device-conflict">
          <span style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {C("device_conflict", { at: F.time(conflict.at) })}
            <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {editable && isForm(conflict.form) && <Button size="sm" onClick={() => setConfirmLoad(true)}>{C("device_load")}</Button>}
              <Button size="sm" variant="ghost" onClick={() => { dropDeviceDraft(id); setConflict(null); }}>{C("device_discard")}</Button>
            </span>
          </span>
        </Callout>
      )}

      {confirmLoad && conflict && isForm(conflict.form) && (
        <Dialog open onClose={() => setConfirmLoad(false)} label={C("device_load_title")} width={520}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }} data-testid="device-load-confirm">
            <b className="t-h3">{C("device_load_title")}</b>
            <span>{C("device_load_body", { at: F.time(conflict.at) })}</span>
            <span className="t-small"><b>{C("device_load_parts")}</b> {changedParts(conflict.form, form).map((k) => C(k)).join(", ") || "—"}</span>
            <span style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button onClick={() => setConfirmLoad(false)}>{C("cancel")}</Button>
              <Button variant="danger" onClick={() => { const d = conflict; setConfirmLoad(false); setConflict(null); pendingDrop.current = true; upd(() => d.form as Form); }}>{C("device_load_confirm")}</Button>
            </span>
          </div>
        </Dialog>
      )}

      <AllergyStrip view={view} editable={!view.readOnly} onChanged={refresh} />

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <Section n={1} title={C("sec_complaints")} ai={ai("complaints")}>
            <Complaints value={form.sections.complaints} disabled={!editable} onChange={(v) => setSection("complaints", v)} />
          </Section>
          <Section n={2} title={C("sec_history")} ai={ai("history")}>
            <textarea className="input" aria-label={C("sec_history")} rows={3} disabled={!editable} value={form.sections.history} onChange={(e) => setSection("history", e.target.value)} />
          </Section>
          <Section n={3} title={C("sec_exam")} ai={ai("exam")}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
              {(["general", "cvs", "chest", "abdomen"] as const).map((k) => (
                <label key={k} className="field">
                  <span className="t-small t-secondary">{C(`exam_${k}`)}</span>
                  <textarea className="input" rows={2} name={`exam-${k}`} disabled={!editable} value={form.sections.exam[k]} onChange={(e) => setSection("exam", { ...form.sections.exam, [k]: e.target.value })} />
                </label>
              ))}
            </div>
          </Section>
          <Section n={4} title={C("sec_vitals")}>
            <VitalsReadOnly encounterId={encounterId} />
          </Section>
          <Section n={5} title={C("sec_dx")}>
            <Diagnoses value={form.diagnoses} disabled={!editable} onChange={(v) => upd((f) => ({ ...f, diagnoses: v }))} />
          </Section>
          <Section n={6} title={C("sec_orders")}>
            <Orders value={form.orders} disabled={!editable} onChange={(v) => upd((f) => ({ ...f, orders: v }))} />
          </Section>
          <Section n={7} title={C("sec_rx")}>
            <RxBuilder ref={rxSearch} lines={form.lines} allergies={view.allergies} disabled={!editable} onChange={(v) => upd((f) => ({ ...f, lines: v }))} />
          </Section>
          <Section n={8} title={C("sec_advice")} ai={ai("advice")}>
            <textarea className="input" aria-label={C("sec_advice")} rows={3} disabled={!editable} value={form.sections.advice} onChange={(e) => setSection("advice", e.target.value)} />
          </Section>
          <Section n={9} title={C("sec_followup")} ai={ai("followUp")}>
            <input className="input" aria-label={C("sec_followup")} placeholder={C("followup_ph")} disabled={!editable} value={form.sections.followUp} onChange={(e) => setSection("followUp", e.target.value)} />
          </Section>
        </div>
        <aside style={{ flex: "1 1 260px", maxWidth: 420, minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <AiPanel compositionId={id} editable={editable} onInsert={insertAi} />
          <Context view={view} />
        </aside>
      </div>

      <div className="card" style={{ position: "sticky", bottom: nav.phone ? "var(--doc-tabbar-h, 0px)" : 0, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "10px 16px", zIndex: 2 }}>
        <span style={{ flex: "1 1 160px", display: "flex", flexDirection: "column", gap: 2 }}>
          <SyncText sync={sync} />
          {!nav.phone && <span className="t-small t-muted">{C("keys_hint")}</span>}
        </span>
        {editable && (
          <Button variant="primary" icon="pen-tool" kbd={nav.phone ? undefined : "Ctrl Enter"} data-testid="sign-open" disabled={!s.online} onClick={openSign}>
            {!s.online ? C("sign_offline") : hardBlockers > 0 ? C("resolve_n", { n: hardBlockers }) : isAmendment ? C("sign_amend") : nav.phone ? C("sign_send") : C("sign")}
          </Button>
        )}
      </div>
      {preview && (
        <Dialog open onClose={() => setPreview(false)} label={C("print_preview")} width={760}>
          <div style={{ padding: 16, maxHeight: "80vh", overflow: "auto" }}><PrintPanel kind="rx" id={id} compact /></div>
        </Dialog>
      )}
      {signing && (
        <SignSheet view={view} draft={draft} form={form} rev={() => revRef.current} ensureSaved={ensureSaved} onClose={() => { setSigning(false); void refresh().catch(() => {}); }}
          onSigned={(v) => { dropDeviceDraft(id); lastSaved.current = JSON.stringify(bodyOf(formRef.current)); setSync({ st: "saved", at: v.current?.signedAt ?? new Date().toISOString() }); setView(v); router.push(nav.signed(encounterId)); }} />
      )}
    </div>
  );
}

/* ── pieces ── */
/** Doctor app (issue #8): the patient's name, token and allergies stay on screen while the doctor scrolls to the Rx. */
function PhoneHead({ view }: { view: ConsultationView }) {
  const C = useC(); const F = useFmt();
  const active = activeAllergies(view.allergies);
  return (
    <div data-testid="phone-head" style={{ position: "sticky", top: 0, zIndex: 3, display: "flex", flexDirection: "column", gap: 6, padding: "8px 0", background: "var(--surface-page)" }}>
      <b className="t-body">{F.name(view.encounter.patient)} · <span className="num">{view.encounter.token}</span></b>
      {active.length
        ? <div role="note" className="allergy-strip" data-testid="allergy-strip" style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px", borderRadius: 8, background: "var(--allergy-bg)", color: "var(--allergy-fg)", fontWeight: 700 }}>
            <Icon name="triangle-alert" size={16} />{C("al_strip", { list: active.map((a) => F.name({ nameBn: a.labelBn, nameEn: a.labelEn })).join(", ") })}
          </div>
        : <div role="note" data-testid="allergy-strip" className="t-small" style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 12px", borderRadius: 8, border: "1px solid var(--warning-border)", background: "var(--warning-bg)", color: "var(--warning-fg)" }}>
            <Icon name="circle-help" size={14} />{C("al_none")}
          </div>}
    </div>
  );
}

export function SyncPill({ sync, onRetry }: { sync: Sync; onRetry?: () => void }) {
  const C = useC(); const F = useFmt();
  const p = sync.st === "saved" ? { tone: "ok" as const, icon: "cloud", t: C("sync_saved", { at: F.time(sync.at) }) }
    : sync.st === "device" ? { tone: "warn" as const, icon: "hard-drive", t: C("sync_device") }
    : sync.st === "failed" ? { tone: "bad" as const, icon: "triangle-alert", t: C("sync_failed") }
    : { tone: "pend" as const, icon: "loader", t: sync.st === "saving" ? C("sync_saving") : C("sync_not_synced") };
  return (
    <span role="status" data-testid="sync-status" data-sync={sync.st} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <Pill tone={p.tone} icon={p.icon}>{p.t}</Pill>
      {sync.st === "failed" && onRetry && <Button size="sm" variant="ghost" icon="refresh-cw" onClick={onRetry}>{C("sync_retry")}</Button>}
    </span>
  );
}
function SyncText({ sync }: { sync: Sync }) {
  const C = useC(); const F = useFmt();
  return <b className="t-small">{sync.st === "saved" ? C("sync_saved", { at: F.time(sync.at) }) : sync.st === "device" ? C("sync_device") : sync.st === "failed" ? `${C("sync_failed")} — ${sync.msg}` : sync.st === "saving" ? C("sync_saving") : C("sync_not_synced")}</b>;
}

export function Section({ n, title, ai, children, right }: { n: number; title: string; ai?: boolean; children: ReactNode; right?: ReactNode }) {
  const C = useC();
  return (
    <Card id={`sec-${n}`} data-section={n} style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14, scrollMarginTop: 72 }}>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <b className="t-h3">{title}</b>
        <kbd className="kbd">Alt {n}</kbd>
        {ai && <Pill tone="warn" icon="sparkles">{C("ai_section")}</Pill>}
        <span style={{ marginLeft: "auto" }} />
        {right}
      </span>
      {children}
    </Card>
  );
}

function Complaints({ value, disabled, onChange }: { value: Form["sections"]["complaints"]; disabled: boolean; onChange: (v: Form["sections"]["complaints"]) => void }) {
  const s = useSession(); const C = useC();
  const [q, setQ] = useState("");
  const add = () => { const c = parseComplaint(q); if (c) { onChange([...value, c]); setQ(""); } };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }} data-testid="complaints">
        {value.length === 0 && <span className="t-small t-muted">{C("complaints_none")}</span>}
        {value.map((c, i) => (
          <span key={i} className="pill" style={{ gap: 6 }}>
            {c.text}{c.duration && <span className="t-muted">· {C(`dur_${c.duration.unit}`, { n: c.duration.n })}</span>}
            {!disabled && <button type="button" className="btn-icon" style={{ width: 20, height: 20 }} aria-label={`${C("remove")} ${c.text}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>}
          </span>
        ))}
      </span>
      {!disabled && (
        <span style={{ display: "flex", gap: 8 }}>
          <input className="input" name="complaint" style={{ flex: 1 }} placeholder={C("complaint_ph")} aria-label={C("sec_complaints")} value={q}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} lang={s.lang} />
          <Button size="sm" icon="plus" onClick={add} disabled={!q.trim()}>{C("complaint_add")}</Button>
        </span>
      )}
    </div>
  );
}

function Diagnoses({ value, disabled, onChange }: { value: Dx[]; disabled: boolean; onChange: (v: Dx[]) => void }) {
  const s = useSession(); const C = useC();
  const [q, setQ] = useState(""); const [hits, setHits] = useState<{ code: string; bn: string; en: string; verification: string }[] | null>(null);
  useEffect(() => {
    if (!q.trim()) { setHits(null); return; }
    const t = window.setTimeout(() => { cons.icd11(q.trim()).then((r) => setHits(r.items)).catch(() => setHits([])); }, 200);
    return () => window.clearTimeout(t);
  }, [q]);
  const add = (h: { code: string; bn: string; en: string; verification: string }) => {
    if (!value.some((d) => d.code === h.code)) onChange([...value, { code: h.code, labelBn: h.bn, labelEn: h.en, codeVerification: h.verification, verificationStatus: "provisional" }]);
    setQ(""); setHits(null);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {value.length === 0 ? <span className="t-small t-muted">{C("dx_none")}</span> : value.map((d) => (
        <div key={d.code} data-dx={d.code} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <b className="num">{d.code}</b>
          <span>{s.lang === "bn" ? d.labelBn : d.labelEn}</span>
          <Pill tone={d.verificationStatus === "confirmed" ? "ok" : "warn"}>{d.verificationStatus === "confirmed" ? C("dx_confirmed") : C("dx_provisional")}</Pill>
          {d.codeVerification !== "verified" && <span className="t-small t-muted">{C("dx_unverified")}</span>}
          <span style={{ marginLeft: "auto" }} />
          <label className="t-small" style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" disabled={disabled} checked={d.verificationStatus === "confirmed"} onChange={(e) => onChange(value.map((x) => (x.code === d.code ? { ...x, verificationStatus: e.target.checked ? "confirmed" : "provisional" } : x)))} />
            {C("dx_confirmed")}
          </label>
          {!disabled && <Button size="sm" variant="ghost" icon="x" onClick={() => onChange(value.filter((x) => x.code !== d.code))}>{C("remove")}</Button>}
        </div>
      ))}
      {value.some((d) => d.verificationStatus === "provisional") && <span className="t-small t-muted">{C("dx_prov_note")}</span>}
      {!disabled && (
        <div style={{ position: "relative" }}>
          <input className="input" name="dx-search" style={{ width: "100%" }} placeholder={C("dx_ph")} aria-label={C("dx_ph")} value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setQ(""); setHits(null); } if (e.key === "Enter" && hits?.[0]) { e.preventDefault(); add(hits[0]); } }} />
          {hits && (
            <div role="listbox" aria-label={C("sec_dx")} className="card" style={{ display: "flex", flexDirection: "column", marginTop: 4, padding: 4 }}>
              {hits.length === 0 ? <span className="t-small t-muted" style={{ padding: 8 }}>{C("dx_no_match")}</span> : hits.map((h) => (
                <button key={h.code} type="button" role="option" aria-selected="false" className="btn btn-ghost" style={{ justifyContent: "flex-start", height: "auto", padding: "6px 8px", textAlign: "left" }} onClick={() => add(h)}>
                  <b className="num">{h.code}</b>&nbsp;{h.bn} · {h.en}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Orders({ value, disabled, onChange }: { value: Form["orders"]; disabled: boolean; onChange: (v: Form["orders"]) => void }) {
  const s = useSession(); const C = useC();
  const [tests, setTests] = useState<TestList["items"] | null>(null);
  useEffect(() => { cons.tests().then((r) => setTests(r.items)).catch(() => setTests([])); }, []);
  const groups = useMemo(() => (["lab", "imaging", "other"] as const).map((g) => ({ g, items: (tests ?? []).filter((t) => t.group === g) })).filter((x) => x.items.length), [tests]);
  const toggle = (t: TestList["items"][number]) => {
    const o = value.find((x) => x.testCode === t.code);
    if (o?.placed) return;
    onChange(o ? value.filter((x) => x.testCode !== t.code) : [...value, { testCode: t.code, nameEn: t.nameEn, nameBn: t.nameBn, group: t.group, priority: "routine", note: "", placed: false, placedInVersion: 0 }]);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {groups.map(({ g, items }) => (
        <div key={g} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span className="t-small t-secondary" style={{ minWidth: 64 }}>{C(`ord_${g}`)}</span>
          {items.map((t) => {
            const o = value.find((x) => x.testCode === t.code);
            return (
              <button key={t.code} type="button" className={`btn btn-sm${o ? " btn-primary" : ""}`} aria-pressed={o ? "true" : "false"} data-test={t.code} disabled={disabled || o?.placed} onClick={() => toggle(t)}>
                {s.lang === "bn" ? t.nameBn : t.nameEn}
              </button>
            );
          })}
        </div>
      ))}
      {value.length === 0 ? <span className="t-small t-muted">{C("ord_none")}</span> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {value.map((o) => (
            <div key={o.testCode} data-order={o.testCode} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <b>{s.lang === "bn" ? o.nameBn : o.nameEn}</b>
              {o.placed ? <Pill tone="final" icon="check">{C("ord_placed", { v: o.placedInVersion })}</Pill> : (
                <Segmented label={C("sec_orders")} value={o.priority} onChange={(v) => !disabled && onChange(value.map((x) => (x.testCode === o.testCode ? { ...x, priority: v } : x)))}
                  options={(["routine", "urgent", "stat"] as const).map((p) => ({ value: p, label: C(`pr_${p}`) }))} />
              )}
            </div>
          ))}
          {value.some((o) => !o.placed) && <span className="t-small t-muted">{C("ord_on_sign")}</span>}
        </div>
      )}
    </div>
  );
}

const VITAL_ROWS: { f: string; codes: string[] }[] = [
  { f: "bp", codes: ["bp-systolic", "bp-diastolic"] }, { f: "pulse", codes: ["pulse"] }, { f: "temp", codes: ["body-temperature"] },
  { f: "spo2", codes: ["spo2"] }, { f: "rbs", codes: ["blood-glucose"] }, { f: "weight", codes: ["body-weight"] }, { f: "height", codes: ["body-height"] },
];
const FLAG_TONE = { H: "warn", L: "warn", HH: "crit", LL: "crit", N: "ok" } as const;
function VitalsReadOnly({ encounterId }: { encounterId: string }) {
  const s = useSession(); const C = useC(); const F = useFmt();
  const [v, setV] = useState<VitalsView | null | "failed">(null);
  useEffect(() => { vitalsApi.view(encounterId).then(setV).catch(() => setV("failed")); }, [encounterId]);
  if (v === "failed") return <span className="t-small t-muted">{C("error_generic")}</span>;
  if (!v) return <span className="t-small t-muted">{C("loading")}</span>;
  if (!v.current) return <span className="t-small t-muted" data-testid="vitals-none">{C("vitals_none")}</span>;
  const obs = (code: string) => v.current!.observations.find((o) => o.code === code);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="vitals-readonly">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {VITAL_ROWS.map((r) => {
          const o = r.codes.map(obs);
          if (!o[0]) return null;
          const flags = o.map((x) => x?.interpretation).filter((x): x is NonNullable<typeof x> => Boolean(x) && x !== "N");
          const worst = flags.find((x) => x === "HH" || x === "LL") ?? flags[0];
          return (
            <span key={r.f} className="pill" data-vital={r.f} style={{ gap: 6, height: "auto", padding: "4px 10px" }}>
              <span className="t-small t-secondary">{s.t("vitalsApp", `f_${r.f}`)}</span>
              <b className="num">{o.map((x) => (x ? s.n(x.value) : "—")).join("/")}</b>
              <span className="t-small t-muted">{s.t("vitalsApp", `u_${r.f}`)}</span>
              {worst && <Pill tone={FLAG_TONE[worst]} icon={worst.startsWith("H") ? "arrow-up" : "arrow-down"}>{C(`flag_${worst}`)}</Pill>}
            </span>
          );
        })}
      </div>
      <span className="t-small t-muted">{C("vitals_by", { name: F.name(v.current.recordedBy), at: F.dateTime(v.current.effectiveAt) })}</span>
    </div>
  );
}

function Context({ view }: { view: ConsultationView }) {
  const s = useSession(); const C = useC(); const F = useFmt();
  return (
    <>
      <Card style={{ display: "flex", flexDirection: "column", gap: 6, padding: 14 }} data-testid="current-meds">
        <b>{C("ctx_current_meds")}</b>
        {view.currentMedicines.length === 0 ? <span className="t-small t-muted">{C("ctx_none")}</span> : view.currentMedicines.map((m, i) => (
          <span key={i} className="t-small"><b>{m.form} {m.brand} {m.strength}</b> · {s.n(m.dose)} · {F.date(m.prescribedAt)}</span>
        ))}
      </Card>
      <Card style={{ display: "flex", flexDirection: "column", gap: 6, padding: 14 }}>
        <b>{C("ctx_past_dx")}</b>
        {view.pastDiagnoses.length === 0 ? <span className="t-small t-muted">{C("ctx_none")}</span> : view.pastDiagnoses.map((d) => (
          <span key={d.code} className="t-small"><b className="num">{d.code}</b> {s.lang === "bn" ? d.labelBn : d.labelEn} · {F.date(d.at)}</span>
        ))}
      </Card>
    </>
  );
}
