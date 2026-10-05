"use client";
/* doc/inbox — the results inbox on the phone (walkthrough A12, ADR 0007). Critical first (the server's order, the same
   @setu/domain sortInbox); a released report shows its flagged results with the range label, values under correction
   marked "do not act on it", a version replaced by a newer one says so and cannot be acknowledged. "Seen" and "Seen +
   tell patient" (decision D1): online the card says Acknowledged only after the server answers; offline the
   acknowledgement waits in the outbox — "Acknowledged — not yet synced" — and the patient is told only after it syncs. */
import { SMS_MAYBE_SENT } from "@setu/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InboxItem, InboxView } from "@setu/contracts";
import { Button, Callout, Card, Icon, PageState, Pill, useToast } from "@setu/ui";
import { ApiFailure, doctor, docs } from "../../lib/api";
import { onOutbox, outboxItems } from "../../lib/outbox";
import { useSession } from "../../lib/session";
import { useLabels } from "../fd/common";
import { DocFrame, rememberUnread, useD, useDF } from "./common";

const VITAL_KEY: Record<string, string> = { "bp-systolic": "f_bp", "bp-diastolic": "f_bp", pulse: "f_pulse", "body-temperature": "f_temp", spo2: "f_spo2", "blood-glucose": "f_rbs" };
const UNIT: Record<string, string> = { "[degF]": "°F" };

/** Acknowledgements waiting in this device's outbox: item id → tell patient. */
function queuedAcks(): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const i of outboxItems()) {
    const hit = i.label === "inbox_ack" && !i.error ? /^\/v1\/doctor\/inbox\/([^/]+)\/ack$/.exec(i.path) : null;
    if (hit) m.set(decodeURIComponent(hit[1]!), !!(i.body as { notifyPatient?: boolean } | null)?.notifyPatient);
  }
  return m;
}

export function DocInbox() {
  const s = useSession(); const D = useD(); const toast = useToast();
  const [v, setV] = useState<InboxView | null>(null); const [failed, setFailed] = useState(false);
  const [queued, setQueued] = useState<Map<string, boolean>>(() => queuedAcks());
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { const x = await doctor.inbox(); setV(x); rememberUnread(x.counts.unread); setFailed(false); setQueued(queuedAcks()); } catch { setFailed(true); }
  }, []);
  useEffect(() => { s.setPatient(null); void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // when a queued acknowledgement leaves the outbox (sent, or refused), reload: the server's record replaces "not yet
  // synced". The browser's own online flag, not a captured one: the outbox can drain before this screen re-renders.
  const queuedRef = useRef(queued);
  useEffect(() => { queuedRef.current = queued; }, [queued]);
  useEffect(() => onOutbox(() => {
    const now = queuedAcks();
    const left = [...queuedRef.current.keys()].some((id) => !now.has(id));
    setQueued(now);
    if (left && navigator.onLine) void load();
  }), [load]);

  const ack = async (item: InboxItem, notify: boolean) => {
    setBusy(item.id);
    try {
      const r = await doctor.ack(item.id, notify, crypto.randomUUID());
      if (r.queued) setQueued(queuedAcks());
      else {
        setV((old) => old && { ...old, items: old.items.map((x) => (x.id === item.id ? r.data.item : x)), counts: { unread: Math.max(0, old.counts.unread - 1), critical: Math.max(0, old.counts.critical - (item.severity === "critical" ? 1 : 0)) } });
        toast(D("seen_done_toast"), "check");
      }
    } catch (e) {
      toast(e instanceof ApiFailure ? (s.lang === "bn" ? e.body.message_bn : e.body.message_en) : D("error_generic"), "triangle-alert");
      if (e instanceof ApiFailure && e.status === 409) void load();
    } finally { setBusy(null); }
  };

  const unread = v ? v.items.filter((x) => !x.acknowledged && !x.resolved && !queued.has(x.id)).length : 0;
  return (
    <DocFrame tab="inbox">
      <span style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{D("i_title")}</h1>
        {v && unread > 0 && <span data-testid="inbox-unread"><Pill tone="neu">{D("i_unread", { n: unread })}</Pill></span>}
      </span>
      <span className="t-small t-muted">{D("i_sub")}</span>
      {failed && <Callout tone="warn" icon="triangle-alert">{D("error_generic")} <Button size="sm" onClick={() => void load()}>{D("retry")}</Button></Callout>}
      {!failed && !v && <div aria-busy="true" className="t-muted">{D("loading")}</div>}
      {v && v.items.length === 0 && <PageState icon="inbox" title={D("i_empty")} />}
      {v?.items.map((x) => <InboxCard key={x.id} item={x} queued={queued.get(x.id)} busy={busy === x.id} onAck={(n) => void ack(x, n)} />)}
    </DocFrame>
  );
}

function InboxCard({ item: x, queued, busy, onAck }: { item: InboxItem; queued: boolean | undefined; busy: boolean; onAck: (notify: boolean) => void }) {
  const s = useSession(); const D = useD(); const F = useDF(); const L = useLabels();
  const lab = (key: string, vars: Record<string, string> = {}) => s.t("labApp", key).replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  const testName = x.test ? (s.lang === "bn" ? x.test.nameBn : x.test.nameEn) : "";
  // worst first: critical, then high / low, then normal, then unflagged
  const rank = (f: string | null) => (f === "HH" || f === "LL" ? 0 : f === "H" || f === "L" ? 1 : f === "N" ? 2 : 3);
  const results = x.report ? [...x.report.results].sort((a, b) => rank(a.flag) - rank(b.flag)) : [];
  const shown = results.slice(0, 3);
  const val = (v: number, d: number) => F.num(v.toFixed(d));
  const tone = x.severity === "critical" ? "crit" : x.severity === "abnormal" ? "warn" : x.severity === "normal" ? "ok" : "neu";
  return (
    <Card className={`doc-card ${x.severity}`} data-inbox-item={x.id} data-kind={x.kind} data-severity={x.severity} data-acked={x.acknowledged ? "server" : queued !== undefined ? "queued" : "no"}>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Pill tone={tone} icon={x.severity === "critical" ? "siren" : x.severity === "notice" ? "info" : undefined}>{D(`sev_${x.severity}`)}</Pill>
        <span style={{ marginLeft: "auto" }} className="t-small t-muted num">{F.time(x.at)}</span>
      </span>
      <b style={{ overflowWrap: "anywhere" }}>{F.name(x.patient)} · <span className="num">{x.patient.ageYears == null ? "—" : D("age_y", { n: x.patient.ageYears })}</span> {L.sex(x.patient.sex)}{x.encounter.token ? <> · <span className="num">{x.encounter.token}</span></> : null}</b>

      {x.kind === "report-inbox" && x.report && (
        <>
          <span className="t-small t-secondary"><span className="num">{x.report.number} v{F.num(x.report.version)}</span> · {x.report.status === "preliminary" ? lab("wm_preliminary", { n: F.num(x.report.pendingCount), m: F.num(x.report.testCount) }) : lab(`rep_${x.report.status}`)}</span>
          {shown.map((r) => (
            <span key={r.code} data-result={r.code} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <span>{s.lang === "bn" ? r.nameBn : r.nameEn}</span>
              <b className={`num${r.underCorrection ? " strike" : ""}`} style={r.underCorrection ? { textDecoration: "line-through" } : undefined}>{val(r.value, r.decimals)}</b>
              <span className="t-small">{r.unit}</span>
              {r.flag && <span data-flag={r.flag}><Pill tone={r.flag === "HH" || r.flag === "LL" ? "crit" : r.flag === "N" ? "ok" : "warn"} icon={r.flag === "HH" || r.flag === "LL" ? "siren" : r.flag === "H" ? "arrow-up" : r.flag === "L" ? "arrow-down" : "check"}>{lab(`flag_${r.flag}`)}</Pill></span>}
              {r.refLow != null && r.refHigh != null && <span className="t-small t-muted num">({val(r.refLow, r.decimals)}–{val(r.refHigh, r.decimals)}{r.refLabel ? ` · ${lab(`range_${r.refLabel}`)}` : ""})</span>}
              {r.underCorrection && <b className="t-small" data-testid="under-correction">{lab("under_correction_dna")}</b>}
            </span>
          ))}
          {results.length > shown.length && <span className="t-small t-muted">{D("more_results", { n: results.length - shown.length })}</span>}
          {x.report.superseded && <Callout tone="warn" icon="history" data-testid="superseded">{D("v_superseded")}</Callout>}
          {x.correctionPending && <Callout tone="warn" icon="hourglass" data-testid="correction-pending">{D("v_correction_pending")}</Callout>}
        </>
      )}
      {x.kind === "correction-notice" && <span>{D("k_correction", { test: testName })}</span>}
      {x.kind === "results-withdrawn" && <span>{D("k_withdrawn", { test: testName })}</span>}
      {x.kind === "order-cancelled" && <span>{D("k_cancelled", { test: testName })}</span>}
      {x.kind === "critical-vital" && x.vital && (
        <span data-testid="critical-vital"><Icon name="siren" size={14} /> {D("k_vital", { vital: `${s.t("vitalsApp", VITAL_KEY[x.vital.code] ?? x.vital.code)} ${F.num(x.vital.value)} ${UNIT[x.vital.unit] ?? x.vital.unit}${x.vital.flag ? ` · ${lab(`flag_${x.vital.flag}`)}` : ""}` })}</span>
      )}

      {x.kind === "substitution-notice" && x.substitution && (
        <span data-testid="substitution" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span><Icon name="repeat" size={14} /> {D("k_substitution", { from: `${x.substitution.prescribed.brand} ${x.substitution.prescribed.strength}`, to: `${x.substitution.given.brand} ${x.substitution.given.strength}`, n: x.substitution.qty })}</span>
          <span className="t-small t-secondary">{D("k_substitution_why", { reason: x.substitution.reason, name: F.name(x.substitution.by) })}</span>
        </span>
      )}

      {x.kind === "return-notice" && x.returned && (
        <span data-testid="return-notice" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span><Icon name="undo-2" size={14} /> {D("k_return", { medicine: `${x.returned.medicine.brand} ${x.returned.medicine.strength}`, n: x.returned.qty })}</span>
          <span className="t-small t-secondary">{D("k_return_why", { reason: x.returned.reason, name: F.name(x.returned.by) })}</span>
        </span>
      )}

      {x.acknowledged ? (
        <span className="t-small" data-testid="acked" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Icon name="check" size={14} />{D("seen_at", { at: F.time(x.acknowledged.at) })}
          {x.acknowledged.sms && <span data-sms-status={x.acknowledged.sms.status}>· {D("seen_told", { status: D(x.acknowledged.sms.status === "completed" && !x.acknowledged.sms.deliveryConfirmed ? "sms_sent" : x.acknowledged.sms.status === "failed" && x.acknowledged.sms.lastError === SMS_MAYBE_SENT ? "sms_maybe_sent" : `sms_${x.acknowledged.sms.status}`) })}</span>}
        </span>
      ) : queued !== undefined ? (
        <span data-testid="acked-pending"><Pill tone="off" icon="cloud-off" wrap>{queued ? D("seen_pending_tell") : D("seen_pending")}</Pill></span>
      ) : !x.report?.superseded && !x.correctionPending && (
        <>
          <span className="doc-actions">
            <Button icon="check" data-testid="ack-seen" disabled={busy} onClick={() => onAck(false)}>{D("b_seen")}</Button>
            {x.canNotify && <Button variant="primary" icon="message-square" data-testid="ack-tell" disabled={busy} onClick={() => onAck(true)}>{D("b_seen_tell")}</Button>}
          </span>
          {x.canNotify && <span className="t-small t-muted">{D("tell_hint")}</span>}
          {x.kind === "report-inbox" && !x.patient.hasMobile && <span className="t-small t-muted" data-testid="no-mobile">{D("no_mobile")}</span>}
        </>
      )}
      {x.report && <a className="t-small" href={docs.previewSrc("lr", x.report.id, "a5", s.lang === "bn" ? "bn" : "both")} target="_blank" rel="noreferrer" data-testid="open-report"><Icon name="file-text" size={14} /> {D("b_report")}</a>}
    </Card>
  );
}
