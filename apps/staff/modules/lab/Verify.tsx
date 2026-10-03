"use client";
/* lab/verify — walkthrough A10 (and release, A10 → A11). Ported from docs/prototype/Setu Lab.dc.html (screen
   "Verification"). Step 1 technical verification (lab technologist or pathologist, PIN; when the delta check warned, the
   "sample identity checked" tick). Step 2 clinical validation (pathologist, PIN) — locked for a critical (HH/LL) result
   until a call-back that reached someone, with the value read back, is logged for it (attempts are logged and do not
   unlock it, decision D9); never by the person who verified on a Hospital plan. The pathologist can send a verified test
   back (reason ≥10, decision 119). Release makes a new report version — "PRELIMINARY — n of m tests pending" while tests
   are still open, final when all are validated (D3); nothing is released automatically. After release the screen
   opens Delivery for this visit, already released (walkthrough issue #2). Nothing here is done until the server says so. */
import { useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LabOrder, LabResult, LabVisitView } from "@setu/contracts";
import { CALLBACK_RECIPIENTS, CALLBACK_VIA, format, isCritical } from "@setu/domain";
import { Button, Callout, Card, PageState, Pill, useToast } from "@setu/ui";
import { ApiFailure, lab } from "../../lib/api";
import { useSession } from "../../lib/session";
import { DeltaBanner, ResultsTable } from "./Result";
import { FlagPill, REPORT_TONE, RangeText, ReasonDialog, VisitHead, isLabWriter, useErr, useFmt, useLabVisit, useLb } from "./common";
import { LabWorklist } from "./Worklist";

export function LabVerify() {
  const enc = useSearchParams().get("enc");
  return enc ? <VerifyVisit encounterId={enc} /> : <LabWorklist stage="verify" />;
}

const cur = (o: LabOrder) => o.results.filter((r) => r.status !== "entered-in-error");
const reached = (r: LabResult) => r.callbacks.some((c) => c.outcome === "reached" && c.readBack);

function usePinError() {
  const T = useLb(); const E = useErr();
  return (e: unknown) => {
    if (!(e instanceof ApiFailure)) return E(e);
    if (e.body.code === "pin_wrong") return T("pin_wrong", { n: e.body.triesLeft ?? 0 });
    if (e.body.code === "pin_locked") return T("pin_locked");
    const codes = [...new Set((e.body.blockers ?? []).map((x) => String(x.code)))];
    return [E(e), ...codes.map((c) => T(`bl_${c}`))].join(" · ");
  };
}

function VerifyVisit({ encounterId }: { encounterId: string }) {
  const s = useSession(); const T = useLb(); const F = useFmt(); const router = useRouter();
  const { v, show, failed } = useLabVisit(encounterId);
  const [sendBack, setSendBack] = useState<LabOrder | null>(null);
  if (failed) return failed === "not_found" ? <PageState icon="search-x" title={T("not_found")} /> : <Callout tone="warn" icon="triangle-alert">{T("error_generic")}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{T("loading")}</div>;
  const live = v.orders.filter((o) => o.status !== "revoked");
  const prelim = live.flatMap(cur).filter((r) => r.status === "preliminary");
  const verified = live.flatMap(cur).filter((r) => r.status === "verified");
  const criticals = live.flatMap(cur).filter((r) => isCritical(r.flag) && (r.status === "preliminary" || r.status === "verified"));

  return (
    <div data-screen="lab/verify" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <VisitHead v={v} title={T("verify_title")} />
      {!s.online && <Callout tone="warn" icon="cloud-off">{T("online_needed")}</Callout>}
      {prelim.some((r) => r.delta?.hit) && <DeltaBanner hits={prelim.filter((r) => r.delta?.hit)} />}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0, flex: "999 1 560px" }}>
          <VerifyStep v={v} results={prelim} show={show} />
          <ValidateStep v={v} results={verified} show={show} onSendBack={setSendBack} />
          {live.filter((o) => o.results.length > 0).map((o) => (
            <Card key={o.id} style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }} data-order={o.testCode}>
              <b>{F.test(o)}</b>
              {o.returned && <Callout tone="warn" icon="undo-2">{T("returned_banner", { reason: o.returned.reason, name: F.name(o.returned.by), at: F.dateTime(o.returned.at) })}</Callout>}
              {o.withdrawn && <Callout tone="bad" icon="circle-slash">{T("withdrawn_banner", { reason: o.withdrawn.reason, name: F.name(o.withdrawn.by), at: F.dateTime(o.withdrawn.at) })}</Callout>}
              <ResultsTable o={o} onCorrect={null} />
              <span className="t-small t-muted">{whoLine(o, T, F)}</span>
            </Card>
          ))}
          <ReleaseCard v={v} show={show} onReleased={(x) => {
            // issue #2: the person who released lands on Delivery for this visit, already released — if their role has the
            // Delivery screen (lab technologist, admin); a pathologist lands on the released report instead.
            const canDeliver = s.caps?.modules.find((m) => m.key === "lab")?.screens.find((sc) => sc.key === "delivery")?.allowed;
            const cur = x.reports.find((r) => r.status !== "superseded");
            router.push(canDeliver || !cur ? `/m/lab/delivery?enc=${encodeURIComponent(x.encounter.id)}` : `/m/lab/report?id=${encodeURIComponent(cur.id)}`);
          }} />
        </div>
        <aside style={{ display: "flex", flexDirection: "column", gap: 12, flex: "1 1 300px", maxWidth: 400 }}>
          {criticals.length === 0 ? <Card style={{ padding: 14 }}><span className="t-small t-muted">{T("no_critical")}</span></Card>
            : criticals.map((r) => <CallbackPanel key={r.id} v={v} r={r} show={show} />)}
        </aside>
      </div>
      <SendBackDialog o={sendBack} onClose={() => setSendBack(null)} onDone={(x) => { setSendBack(null); show(x); }} />
    </div>
  );
}

function whoLine(o: LabOrder, T: ReturnType<typeof useLb>, F: ReturnType<typeof useFmt>) {
  const c = cur(o);
  const ver = [...new Map(c.filter((r) => r.verifiedBy).map((r) => [r.verifiedBy!.id, r])).values()].map((r) => T("verified_by", { name: F.name(r.verifiedBy), at: F.time(r.verifiedAt) }));
  const val = [...new Map(c.filter((r) => r.validatedBy).map((r) => [r.validatedBy!.id, r])).values()].map((r) => T("validated_by", { name: F.name(r.validatedBy), at: F.time(r.validatedAt) }));
  return [...ver, ...val].join(" · ") || T("not_verified_yet");
}

function PinField({ value, onChange, onEnter, disabled, name }: { value: string; onChange: (v: string) => void; onEnter: () => void; disabled?: boolean; name: string }) {
  const T = useLb();
  return (
    <label className="field t-small" style={{ maxWidth: 160 }}>{T("pin")}
      <input className="input num" name={name} type="password" inputMode="numeric" autoComplete="one-time-code" maxLength={4} value={value} disabled={disabled}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9০-৯]/g, ""))} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onEnter(); } }} />
    </label>
  );
}

function VerifyStep({ v, results, show }: { v: LabVisitView; results: LabResult[]; show: (x: LabVisitView) => void }) {
  const s = useSession(); const T = useLb(); const F = useFmt(); const PE = usePinError();
  const [pin, setPin] = useState(""); const [tick, setTick] = useState(false); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const can = isLabWriter(s.me?.role, "verify");
  const hits = results.some((r) => r.delta?.hit);
  const ok = can && s.online && results.length > 0 && /^\d{4}$/.test(format.toEn(pin)) && (!hits || tick);
  const go = async () => {
    if (!ok) return; setBusy(true); setMsg(null);
    try { const x = await lab.verify(v.encounter.id, { pin: format.toEn(pin), observationIds: results.map((r) => r.id), deltaChecked: tick }, key.current); key.current = crypto.randomUUID(); setPin(""); setTick(false); show(x); }
    catch (e) { setPin(""); setMsg(PE(e)); } finally { setBusy(false); }
  };
  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }} data-step="verify">
      <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <b>{T("step_verify")}</b><span className="t-small t-muted">{T("step_verify_hint")}</span>
        <span style={{ marginLeft: "auto" }} />
        <Pill tone={results.length ? "pend" : "ok"}>{results.length ? T("n_waiting", { n: results.length }) : T("nothing_waiting")}</Pill>
      </span>
      {results.length > 0 && <span className="t-small">{[...new Set(results.map((r) => v.orders.find((o) => o.id === r.orderId)?.nameEn))].join(" · ")}</span>}
      {results.length > 0 && can && (
        <>
          {hits && <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" name="delta-checked" checked={tick} onChange={(e) => setTick(e.target.checked)} />{T("delta_tick")}</label>}
          <span style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <PinField name="verify-pin" value={pin} onChange={setPin} onEnter={() => void go()} disabled={busy || !s.online} />
            <Button variant="primary" icon="shield" data-testid="verify" disabled={!ok || busy} onClick={() => void go()}>{busy ? T("waiting_server") : T("verify")}</Button>
          </span>
          <span className="t-small t-muted">{T("verify_as", { name: F.name(s.me ? { nameBn: s.me.nameBn, nameEn: s.me.nameEn } : null) })}</span>
        </>
      )}
      {msg && <Callout tone="warn" icon="circle-alert" data-testid="verify-msg">{msg}</Callout>}
    </Card>
  );
}

function ValidateStep({ v, results, show, onSendBack }: { v: LabVisitView; results: LabResult[]; show: (x: LabVisitView) => void; onSendBack: (o: LabOrder) => void }) {
  const s = useSession(); const T = useLb(); const F = useFmt(); const PE = usePinError();
  const [pin, setPin] = useState(""); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const can = isLabWriter(s.me?.role, "validate");
  const locked = results.filter((r) => isCritical(r.flag) && !reached(r));
  // the tests that can be validated now: none of their results waits for a call-back (a locked test does not hold
  // the others back — clinical review L6)
  const lockedOrders = new Set(locked.map((r) => r.orderId));
  const ready = results.filter((r) => !lockedOrders.has(r.orderId));
  const mine = !v.samePersonAllowed && ready.some((r) => r.verifiedBy?.id === s.me?.userId);
  const ok = can && s.online && ready.length > 0 && /^\d{4}$/.test(format.toEn(pin));
  const go = async () => {
    if (!can || !s.online || !/^\d{4}$/.test(format.toEn(pin))) return; setBusy(true); setMsg(null);
    try { const x = await lab.validate(v.encounter.id, { pin: format.toEn(pin), observationIds: (ready.length ? ready : results).map((r) => r.id) }, key.current); key.current = crypto.randomUUID(); setPin(""); show(x); }
    catch (e) { setPin(""); setMsg(PE(e)); key.current = crypto.randomUUID(); } finally { setBusy(false); }
  };
  const tests = v.orders.filter((o) => cur(o).length > 0 && cur(o).every((r) => r.status === "verified"));
  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10, borderColor: locked.length ? "var(--danger-border)" : undefined }} data-step="validate">
      <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <b>{T("step_validate")}</b><span className="t-small t-muted">{T("step_validate_hint")}</span>
        <span style={{ marginLeft: "auto" }} />
        <Pill tone={results.length ? (locked.length ? "crit" : "pend") : "ok"} icon={locked.length ? "lock" : undefined}>{results.length ? (locked.length ? T("locked") : T("n_waiting", { n: results.length })) : T("nothing_waiting")}</Pill>
      </span>
      {locked.length > 0 && <Callout tone="bad" icon="siren" data-testid="callback-lock">{T("callback_first", { tests: locked.map((r) => `${r.nameEn} ${F.value(r.value, r.decimals)} ${r.unit}`).join(", ") })}</Callout>}
      {mine && can && <Callout tone="warn" icon="users" data-testid="same-person">{T("same_person_note")}</Callout>}
      {tests.map((o) => (
        <span key={o.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }} data-validate-test={o.testCode}>
          <b>{o.nameEn}</b><span className="t-small t-muted">{T("verified_by", { name: F.name(cur(o)[0]?.verifiedBy), at: F.time(cur(o)[0]?.verifiedAt) })}</span>
          <span style={{ marginLeft: "auto" }} />
          {isLabWriter(s.me?.role, "return") && <Button size="sm" variant="ghost" icon="undo-2" data-testid={`send-back-${o.testCode}`} disabled={!s.online} onClick={() => onSendBack(o)}>{T("send_back")}</Button>}
        </span>
      ))}
      {results.length > 0 && can && (
        <span style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <PinField name="validate-pin" value={pin} onChange={setPin} onEnter={() => void go()} disabled={busy || !s.online} />
          <Button variant="primary" icon="shield-check" data-testid="validate" disabled={!can || !s.online || busy || !/^\d{4}$/.test(format.toEn(pin))} onClick={() => void go()}>{busy ? T("waiting_server") : ready.length && ready.length < results.length ? T("validate_ready", { n: new Set(ready.map((r) => r.orderId)).size }) : T("validate")}</Button>
        </span>
      )}
      {msg && <Callout tone="warn" icon="circle-alert" data-testid="validate-msg">{msg}</Callout>}
    </Card>
  );
}

function hhmm(d: Date) { return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
function CallbackPanel({ v, r, show }: { v: LabVisitView; r: LabResult; show: (x: LabVisitView) => void }) {
  const s = useSession(); const T = useLb(); const F = useFmt(); const E = useErr();
  const order = v.orders.find((o) => o.id === r.orderId);
  const [outcome, setOutcome] = useState<"reached" | "no-answer">("reached");
  const [role, setRole] = useState<(typeof CALLBACK_RECIPIENTS)[number]>("ordering-doctor");
  const [name, setName] = useState("");
  const [time, setTime] = useState(hhmm(new Date()));
  const [via, setVia] = useState<(typeof CALLBACK_VIA)[number]>("phone");
  const [readBack, setReadBack] = useState(false);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const can = isLabWriter(s.me?.role, "callback");
  const at = (() => { const [h, m] = time.split(":").map(Number); const d = new Date(); d.setHours(h ?? 0, m ?? 0, 0, 0); return d; })();
  const ok = can && s.online && name.trim().length >= 2 && /^\d{2}:\d{2}$/.test(time) && (outcome === "no-answer" || readBack);
  const log = async () => {
    if (!ok) return; setBusy(true); setMsg(null);
    try {
      const x = await lab.callback(r.id, { outcome, recipientRole: role, recipientName: name.trim(), via, calledAt: at.toISOString(), readBack: outcome === "reached" && readBack }, key.current);
      key.current = crypto.randomUUID(); setReadBack(false); setTime(hhmm(new Date())); show(x);
    } catch (e) { setMsg(E(e)); } finally { setBusy(false); }
  };
  return (
    <Card style={{ padding: 0, overflow: "hidden", borderColor: "var(--danger-border)" }} data-callback={r.analyteCode}>
      <div style={{ padding: "10px 14px", background: "var(--danger-solid)", color: "var(--danger-on-solid)", display: "flex", gap: 8, alignItems: "center" }}>
        <b>{T("callback_title")}</b><span style={{ marginLeft: "auto" }} /><FlagPill flag={r.flag} />
      </div>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <b className="num">{r.nameEn} {F.value(r.value, r.decimals)} {r.unit}</b>
        <RangeText range={r.range} unit={r.unit} decimals={r.decimals} />
        {order && <span className="t-small t-muted">{T("cb_ordering", { name: F.name(order.orderedBy) })}</span>}
        {r.callbacks.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid="callback-log">
            {r.callbacks.map((c) => (
              <span key={c.id} className="t-small" data-outcome={c.outcome}>
                {c.outcome === "reached" ? <Pill tone="ok" icon="phone-call">{T("cb_reached")}</Pill> : <Pill tone="warn" icon="phone-missed">{T("cb_attempt")}</Pill>}{" "}
                {T("cb_line", { name: c.recipientName, role: T(`cr_${c.recipientRole}`), at: F.time(c.calledAt), via: T(`via_${c.via}`), rb: c.readBack ? T("rb_yes") : T("rb_no"), by: F.name(c.caller) })}
              </span>
            ))}
          </div>
        )}
        {can && (
          <>
            <div role="radiogroup" aria-label={T("cb_outcome")} style={{ display: "flex", gap: 12 }}>
              {(["reached", "no-answer"] as const).map((o) => <label key={o} className="t-small" style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="radio" name={`outcome-${r.id}`} value={o} checked={outcome === o} onChange={() => { setOutcome(o); if (o === "no-answer") setReadBack(false); }} />{T(`cbo_${o}`)}</label>)}
            </div>
            <label className="field t-small">{T("cb_informed")}
              <select className="input" name="cb-role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>{CALLBACK_RECIPIENTS.map((x) => <option key={x} value={x}>{T(`cr_${x}`)}</option>)}</select>
            </label>
            <label className="field t-small">{T("cb_name")}<input className="input" name="cb-name" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <span style={{ display: "flex", gap: 10 }}>
              <label className="field t-small" style={{ flex: 1 }}>{T("cb_time")}<input className="input num" type="time" name="cb-time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
              <label className="field t-small" style={{ flex: 1 }}>{T("cb_via")}
                <select className="input" name="cb-via" value={via} onChange={(e) => setVia(e.target.value as typeof via)}>{CALLBACK_VIA.map((x) => <option key={x} value={x}>{T(`via_${x}`)}</option>)}</select>
              </label>
            </span>
            {outcome === "reached" && <label style={{ display: "flex", gap: 8, alignItems: "center" }} className="t-small"><input type="checkbox" name="cb-readback" checked={readBack} onChange={(e) => setReadBack(e.target.checked)} />{T("cb_readback")}</label>}
            <Button variant={outcome === "reached" ? "primary" : "default"} icon="phone" data-testid="log-call" disabled={!ok || busy} onClick={() => void log()}>{outcome === "reached" ? T("cb_log") : T("cb_log_attempt")}</Button>
            {outcome === "no-answer" && <span className="t-small t-muted">{T("cb_attempt_note")}</span>}
          </>
        )}
        {msg && <Callout tone="warn" icon="circle-alert">{msg}</Callout>}
      </div>
    </Card>
  );
}

function ReleaseCard({ v, show, onReleased }: { v: LabVisitView; show: (x: LabVisitView) => void; onReleased: (x: LabVisitView) => void }) {
  const s = useSession(); const T = useLb(); const F = useFmt(); const E = useErr(); const toast = useToast();
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const p = v.release;
  const can = isLabWriter(s.me?.role, "release");
  const label = p.status === "preliminary" ? T("rel_preliminary", { n: p.pending, m: p.total }) : p.status === "corrected" ? (p.pending ? `${T("rel_corrected")} · ${T("rel_preliminary", { n: p.pending, m: p.total })}` : T("rel_corrected")) : T("rel_final");
  const go = async () => {
    setBusy(true); setMsg(null);
    try { const x = await lab.release(v.encounter.id, p.observationIds, key.current); key.current = crypto.randomUUID(); show(x); toast(T("released_toast"), "send"); onReleased(x); }
    catch (e) { setMsg(E(e)); key.current = crypto.randomUUID(); } finally { setBusy(false); }
  };
  const cur = v.reports.find((r) => r.status !== "superseded");
  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }} data-testid="release">
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <b>{T("release_title")}</b>
        {cur && <Pill tone={REPORT_TONE[cur.status] ?? "neu"} icon="file-text">{cur.number} v{s.n(cur.version)} · {T(`rep_${cur.status}`)}</Pill>}
      </span>
      {p.blockers.length ? <span className="t-small t-muted" data-release-blocker={p.blockers[0]}>{T(`relb_${p.blockers[0]}`)}</span> : (
        <>
          <span data-release-preview={p.status}><b>{T("rel_next")}</b> {label}</span>
          <span className="t-small">{p.orderIds.map((id) => v.orders.find((o) => o.id === id)?.nameEn).join(" · ")}</span>
          <span className="t-small t-muted">{T("release_note")}</span>
          {can && <span><Button variant="primary" icon="send" data-testid="release-btn" disabled={busy || !s.online} onClick={() => void go()}>{T("release")}</Button></span>}
        </>
      )}
      {v.reports.length > 0 && (
        <span className="t-small" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[...v.reports].reverse().map((r) => <a key={r.id} href={`/m/lab/report?id=${encodeURIComponent(r.id)}`} data-version={r.version}>v{s.n(r.version)} · {T(`rep_${r.status}`)} · {F.dateTime(r.releasedAt)}</a>)}
        </span>
      )}
      {msg && <Callout tone="warn" icon="circle-alert">{msg}</Callout>}
    </Card>
  );
}

function SendBackDialog({ o, onClose, onDone }: { o: LabOrder | null; onClose: () => void; onDone: (v: LabVisitView) => void }) {
  const T = useLb(); const E = useErr();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  if (!o) return null;
  return (
    <ReasonDialog open title={T("send_back_title", { test: o.nameEn })} body={T("send_back_body")} label={T("reason")} confirm={T("send_back_confirm")} busy={busy} error={error} tone="primary"
      onClose={() => { setError(null); onClose(); }}
      onConfirm={async (reason) => {
        setBusy(true); setError(null);
        try { const x = await lab.sendBack(o.id, reason, key.current); key.current = crypto.randomUUID(); onDone(x); }
        catch (e) { setError(E(e)); } finally { setBusy(false); }
      }} />
  );
}
