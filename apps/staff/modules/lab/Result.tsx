"use client";
/* lab/result — walkthrough A9. Ported from docs/prototype/Setu Lab.dc.html (screen "Result entry").
   Without ?enc: tests waiting for results (and tests the pathologist sent back). With ?enc: for each test whose tube is
   in process, every analyte of the sample template — Enter or ↓ moves to the next field, ↑ back; the flag (H / L / HH /
   LL, text + icon) and the delta against the patient's previous validated result update as you type (the same
   @setu/domain functions the server runs); a critical value asks to be typed again; "Send for verification" stores all
   values at once (decision D4). After that a value changes only by "Correct" (new version, reason ≥10) and a test's
   results can be withdrawn (reason ≥10; a new tube is needed — decision 133). */
import { useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LabOrder, LabResult, LabVisitView } from "@setu/contracts";
import { deltaOf, isCritical, labFlag, parseLabValue } from "@setu/domain";
import { Button, Callout, Card, PageState, Pill, useToast } from "@setu/ui";
import { ApiFailure, lab } from "../../lib/api";
import { useSession } from "../../lib/session";
import { FlagPill, RESULT_TONE, RangeText, ReasonDialog, VisitHead, isLabWriter, useErr, useFmt, useLabVisit, useLb } from "./common";
import { LabWorklist } from "./Worklist";

export function LabResultEntry() {
  const enc = useSearchParams().get("enc");
  return enc ? <ResultVisit encounterId={enc} /> : <LabWorklist stage="result" />;
}

const current = (o: LabOrder) => o.results.filter((r) => r.status !== "entered-in-error");

function ResultVisit({ encounterId }: { encounterId: string }) {
  const s = useSession(); const T = useLb(); const router = useRouter();
  const { v, show, reload, failed } = useLabVisit(encounterId);
  const [correct, setCorrect] = useState<LabResult | null>(null);
  const [withdraw, setWithdraw] = useState<LabOrder | null>(null);
  if (failed) return failed === "not_found" ? <PageState icon="search-x" title={T("not_found")} /> : <Callout tone="warn" icon="triangle-alert">{T("error_generic")}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{T("loading")}</div>;
  const writer = isLabWriter(s.me?.role, "enter");
  const deltaHits = v.orders.flatMap((o) => current(o)).filter((r) => r.status === "preliminary" && r.delta?.hit);

  return (
    <div data-screen="lab/result" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <VisitHead v={v} title={T("result_title")} right={<span className="t-small t-muted">{T("enter_hint")}</span>} />
      {!s.online && <Callout tone="warn" icon="cloud-off">{T("online_needed")}</Callout>}
      {deltaHits.length > 0 && <DeltaBanner hits={deltaHits} />}
      {v.orders.filter((o) => o.status !== "revoked").map((o) => (
        <OrderBlock key={o.id} v={v} o={o} writer={writer} show={show} reload={reload} onCorrect={setCorrect} onWithdraw={setWithdraw} />
      ))}
      <span style={{ display: "flex", gap: 8 }}>
        <Button icon="arrow-left" onClick={() => router.push("/m/lab/result")}>{T("back_to_list")}</Button>
        {v.orders.some((o) => current(o).some((r) => r.status === "preliminary")) && <Button variant="primary" icon="shield-check" onClick={() => router.push(`/m/lab/verify?enc=${encodeURIComponent(v.encounter.id)}`)}>{T("go_verify")}</Button>}
      </span>
      <CorrectDialog r={correct} onClose={() => setCorrect(null)} onDone={(x) => { setCorrect(null); show(x); }} />
      <WithdrawDialog o={withdraw} others={withdraw ? v.orders.filter((x) => x.id !== withdraw.id && x.specimen && x.specimen.id === withdraw.specimen?.id && current(x).length > 0) : []} onClose={() => setWithdraw(null)} onDone={(x) => { setWithdraw(null); show(x); }} />
    </div>
  );
}

export function DeltaBanner({ hits }: { hits: LabResult[] }) {
  const T = useLb(); const F = useFmt();
  const parts = hits.map((r) => `${r.nameEn} ${F.pct(r.delta!.pct)}`).join(" · ");
  const when = hits[0]?.delta ? F.date(hits[0].delta.prevAt) : "—";
  return <Callout tone="warn" icon="git-compare" data-testid="delta-banner">{T("delta_banner", { parts, date: when })}</Callout>;
}

function OrderBlock({ v, o, writer, show, reload, onCorrect, onWithdraw }: { v: LabVisitView; o: LabOrder; writer: boolean; show: (x: LabVisitView) => void; reload: () => Promise<void>; onCorrect: (r: LabResult) => void; onWithdraw: (o: LabOrder) => void }) {
  const s = useSession(); const T = useLb(); const F = useFmt();
  const cur = current(o);
  const canEnter = writer && o.specimen?.status === "in-process" && cur.length === 0 && o.template.length > 0;
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14 }} data-order={o.testCode}>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <b style={{ fontSize: 16 }}>{F.test(o)}</b>
        {o.specimen && <Pill tone="neu" icon="test-tube">{o.specimen.number} · {T(`sp_${o.specimen.status}`)}</Pill>}
        <span style={{ marginLeft: "auto" }} />
        {cur.length > 0 && isLabWriter(s.me?.role, "withdraw") && <Button size="sm" variant="ghost" icon="circle-slash" data-testid={`withdraw-${o.testCode}`} disabled={!s.online} onClick={() => onWithdraw(o)}>{T("withdraw")}</Button>}
      </span>
      {o.returned && <Callout tone="warn" icon="undo-2" data-testid="returned">{T("returned_banner", { reason: o.returned.reason, name: F.name(o.returned.by), at: F.dateTime(o.returned.at) })}</Callout>}
      {o.withdrawn && <Callout tone="bad" icon="circle-slash" data-testid="withdrawn">{T("withdrawn_banner", { reason: o.withdrawn.reason, name: F.name(o.withdrawn.by), at: F.dateTime(o.withdrawn.at) })}</Callout>}
      {o.template.length === 0 && <Callout tone="info" icon="info">{T("no_template")}</Callout>}
      {canEnter ? <EntryTable v={v} o={o} show={show} reload={reload} />
        : cur.length === 0 && o.template.length > 0 && !o.withdrawn && <span className="t-small t-muted">{o.specimen ? T("wait_in_process") : T("wait_tube")}</span>}
      {o.results.length > 0 && <ResultsTable o={o} onCorrect={writer && s.online ? onCorrect : null} />}
    </Card>
  );
}

function EntryTable({ v, o, show, reload }: { v: LabVisitView; o: LabOrder; show: (x: LabVisitView) => void; reload: () => Promise<void> }) {
  const s = useSession(); const T = useLb(); const F = useFmt(); const E = useErr(); const toast = useToast();
  const [vals, setVals] = useState<Record<string, string>>({}); const [confirm, setConfirm] = useState<Record<string, string>>({});
  const [errs, setErrs] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const inputs = useRef<HTMLInputElement[]>([]);
  const rows = useMemo(() => o.template.map((t) => {
    const p = parseLabValue(vals[t.analyteCode] ?? "");
    const flag = p.ok ? labFlag(p.value, t.range, t) : null;
    const delta = p.ok && t.previous ? deltaOf(p.value, t.previous.value, t) : null;
    return { t, p, flag, delta, crit: p.ok && isCritical(flag) };
  }), [o.template, vals]);
  // Enter / ↓ next field, ↑ previous (the prototype's keyboard flow); a critical row adds its confirm field in order.
  const move = (i: number, d: number) => { const n = inputs.current[i + d]; if (n) { n.focus(); n.select(); } };
  const send = async () => {
    setBusy(true); setErrs({});
    try {
      const x = await lab.results(o.id, { entries: o.template.map((t) => ({ analyteCode: t.analyteCode, value: vals[t.analyteCode] ?? "", ...(confirm[t.analyteCode] ? { confirm: confirm[t.analyteCode] } : {}) })) }, key.current);
      key.current = crypto.randomUUID(); show(x); toast(T("sent_for_verification", { test: o.nameEn }), "send");
    } catch (e) {
      if (e instanceof ApiFailure && e.body.fields) setErrs(Object.fromEntries((e.body.fields as { field: string; code: string }[]).map((f) => [f.field, T(`ve_${f.code}`)])));
      else { toast(E(e), "triangle-alert"); await reload(); }
    } finally { setBusy(false); }
  };
  let idx = 0;
  return (
    <>
      <div style={{ overflowX: "auto" }}>
        <table className="table" data-testid={`entry-${o.testCode}`}>
          <thead><tr><th>{T("col_test")}</th><th>{T("col_result")}</th><th>{T("col_unit")}</th><th>{T("col_ref")}</th><th>{T("col_flag")}</th><th>{T("col_prev")}</th><th>{T("col_delta")}</th></tr></thead>
          <tbody>
            {rows.map(({ t, p, flag, delta, crit }) => {
              const i = idx++; const ci = crit ? idx++ : -1;
              return (
                <tr key={t.analyteCode} data-analyte={t.analyteCode} style={crit ? { background: "var(--danger-bg)", boxShadow: "inset 3px 0 0 var(--danger-border)" } : undefined}>
                  <td>{s.lang === "bn" ? t.nameBn : t.nameEn}</td>
                  <td style={{ minWidth: 130 }}>
                    <input ref={(el) => { if (el) inputs.current[i] = el; }} className="input num" name={`v-${t.analyteCode}`} inputMode="decimal" autoComplete="off" aria-label={t.nameEn}
                      value={vals[t.analyteCode] ?? ""} onChange={(e) => setVals((x) => ({ ...x, [t.analyteCode]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); move(i, 1); } if (e.key === "ArrowUp") { e.preventDefault(); move(i, -1); } }}
                      style={{ borderColor: crit ? "var(--danger-border)" : flag === "H" || flag === "L" ? "var(--warn-border, #d97706)" : undefined }} />
                    {crit && <input ref={(el) => { if (el) inputs.current[ci] = el; }} className="input num" name={`c-${t.analyteCode}`} inputMode="decimal" autoComplete="off" placeholder={T("confirm_again")} aria-label={T("confirm_again_for", { test: t.nameEn })}
                      value={confirm[t.analyteCode] ?? ""} onChange={(e) => setConfirm((x) => ({ ...x, [t.analyteCode]: e.target.value }))} style={{ marginTop: 4 }}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); move(ci, 1); } if (e.key === "ArrowUp") { e.preventDefault(); move(ci, -1); } }} />}
                    {!p.ok && (vals[t.analyteCode] ?? "") !== "" && <span className="field-error">{T(`ve_${p.code}`)}</span>}
                    {errs[t.analyteCode] && <span className="field-error" role="alert">{errs[t.analyteCode]}</span>}
                  </td>
                  <td className="t-small">{t.unit}</td>
                  <td><RangeText range={t.range} decimals={t.decimals} />{(t.critLow !== null || t.critHigh !== null) && <div className="t-small t-muted">{T("crit_line", { low: t.critLow === null ? "—" : `<${F.value(t.critLow, t.decimals)}`, high: t.critHigh === null ? "—" : `>${F.value(t.critHigh, t.decimals)}` })}</div>}</td>
                  <td>{p.ok ? <FlagPill flag={flag} /> : "—"}</td>
                  <td className="t-small num">{t.previous ? `${F.value(t.previous.value, t.decimals)} · ${F.date(t.previous.at)}` : "—"}</td>
                  <td className="t-small num">{delta ? <span style={{ color: delta.hit ? "var(--danger-fg, #b91c1c)" : undefined, fontWeight: delta.hit ? 600 : 400 }}>{delta.pct > 0 ? "▲" : delta.pct < 0 ? "▼" : ""} {F.pct(delta.pct)}</span> : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <span className="t-small t-muted">{T("sample_list")} · {T("source_manual")}</span>
      <span><Button variant="primary" icon="send" data-testid={`send-${o.testCode}`} disabled={busy || !s.online || rows.some((r) => !r.p.ok)} onClick={() => void send()}>{T("send_for_verification")}</Button></span>
    </>
  );
}

export function ResultsTable({ o, onCorrect }: { o: LabOrder; onCorrect: ((r: LabResult) => void) | null }) {
  const T = useLb(); const F = useFmt();
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="table" data-testid={`results-${o.testCode}`}>
        <thead><tr><th>{T("col_test")}</th><th>{T("col_result")}</th><th>{T("col_flag")}</th><th>{T("col_ref")}</th><th>{T("col_delta")}</th><th>{T("col_status")}</th><th /></tr></thead>
        <tbody>
          {o.results.map((r) => (
            <tr key={r.id} data-result={r.analyteCode} data-status={r.status} style={r.status === "entered-in-error" ? { opacity: 0.6 } : isCritical(r.flag) ? { background: "var(--danger-bg)", boxShadow: "inset 3px 0 0 var(--danger-border)" } : undefined}>
              <td>{r.nameEn}{r.replacesId && <div className="t-small t-muted">{T("correction_of_previous")}</div>}</td>
              <td className="num" style={r.status === "entered-in-error" ? { textDecoration: "line-through" } : undefined}><b>{F.value(r.value, r.decimals)}</b> <span className="t-small">{r.unit}</span></td>
              <td><FlagPill flag={r.flag} /></td>
              <td><RangeText range={r.range} decimals={r.decimals} /></td>
              <td className="t-small num">{r.delta ? `${F.pct(r.delta.pct)}${r.delta.hit ? " !" : ""}` : "—"}</td>
              <td>
                <Pill tone={RESULT_TONE[r.status]}>{T(`rs_${r.status}`)}</Pill>
                {r.error && <div className="t-small">{r.withdrawn ? T("withdrawn_short") : T("corrected_short")}: {r.error.reason}</div>}
                <div className="t-small t-muted">{T("entered_by", { name: F.name(r.enteredBy), at: F.time(r.enteredAt) })}</div>
              </td>
              <td style={{ textAlign: "right" }}>{onCorrect && r.status !== "entered-in-error" && <Button size="sm" variant="ghost" icon="pencil" data-testid={`correct-${r.analyteCode}`} onClick={() => onCorrect(r)}>{T("correct")}</Button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CorrectDialog({ r, onClose, onDone }: { r: LabResult | null; onClose: () => void; onDone: (v: LabVisitView) => void }) {
  const T = useLb(); const F = useFmt(); const E = useErr();
  const [value, setValue] = useState(""); const [confirm, setConfirm] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  if (!r) return null;
  const p = parseLabValue(value);
  const flag = p.ok ? labFlag(p.value, r.range, r) : null;
  const crit = p.ok && isCritical(flag);
  return (
    <ReasonDialog open title={T("correct_title", { test: r.nameEn })} label={T("reason")} confirm={T("correct_confirm")} busy={busy} error={error} tone="primary"
      body={<>{T("correct_body", { old: `${F.value(r.value, r.decimals)} ${r.unit}` })}{r.released && <><br /><b>{T("correct_released")}</b></>}</>}
      extraValid={p.ok && (!crit || confirm.trim() !== "")}
      onClose={() => { setValue(""); setConfirm(""); setError(null); onClose(); }}
      onConfirm={async (reason) => {
        setBusy(true); setError(null);
        try { const x = await lab.correct(r.id, { value, ...(crit ? { confirm } : {}), reason }, key.current); key.current = crypto.randomUUID(); setValue(""); setConfirm(""); onDone(x); }
        catch (e) { setError(E(e)); } finally { setBusy(false); }
      }}>
      <label className="field t-small">{T("new_value", { unit: r.unit })}<input className="input num" name="correct-value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></label>
      {p.ok && <span style={{ display: "flex", gap: 8, alignItems: "center" }}><FlagPill flag={flag} /><RangeText range={r.range} decimals={r.decimals} /></span>}
      {crit && <label className="field t-small">{T("confirm_again")}<input className="input num" name="correct-confirm" inputMode="decimal" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>}
    </ReasonDialog>
  );
}

function WithdrawDialog({ o, others, onClose, onDone }: { o: LabOrder | null; others: LabOrder[]; onClose: () => void; onDone: (v: LabVisitView) => void }) {
  const T = useLb(); const E = useErr();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  if (!o) return null;
  return (
    <ReasonDialog open title={T("withdraw_title", { test: o.nameEn })} body={<>{T("withdraw_body")}{o.results.some((r) => r.released && r.status !== "entered-in-error") && <><br /><b>{T("withdraw_released")}</b></>}
        {others.length > 0 && <><br /><b data-testid="withdraw-others">{T("withdraw_others", { tests: others.map((x) => x.nameEn).join(", ") })}</b></>}</>}
      label={T("reason")} confirm={T("withdraw_confirm")} busy={busy} error={error}
      onClose={() => { setError(null); onClose(); }}
      onConfirm={async (reason) => {
        setBusy(true); setError(null);
        try { const x = await lab.withdraw(o.id, reason, key.current); key.current = crypto.randomUUID(); onDone(x); }
        catch (e) { setError(E(e)); } finally { setBusy(false); }
      }} />
  );
}

