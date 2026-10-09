"use client";
/* net/consent — another clinic's view of a patient's history (ADR 0023, Journey E4; prototype Setu Connected Care 137–156).
   Opened for one patient (?patient=<id>, from the consultation). Only a record linked to a Setu person shows anything —
   never a match by name or phone. By policy (no request): active allergies, current medicines, active problems and
   blood group from the patient's other facilities, each with facility, author, date and the provider-verified badge;
   the sensitive categories are never shown and never hinted (the server drops them before anything is counted). More
   only by the patient's consent: "Request access" — kinds, period, a reason the patient sees. Doctors only (the
   server decides; the screen shows its answer). */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { AccessRequestCreate, NetworkHistory } from "@setu/contracts";
import { BLOOD_GROUPS, format } from "@setu/domain";
import { fill } from "@setu/i18n";
import { Button, Callout, Card, Icon, PageState, Pill, Segmented, SelectField, TextArea, useToast } from "@setu/ui";
import { ApiFailure, net } from "../../lib/api";
import { useSession } from "../../lib/session";

function useN() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) => fill(s.t("netApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}
const KINDS = ["reports", "summaries", "prescriptions", "visits"] as const;
const STATE_TONE: Record<string, "pend" | "ok" | "bad" | "neu"> = { sent: "pend", granted: "ok", denied: "bad", expired: "neu" };

export function NetConsent() {
  const s = useSession(); const N = useN();
  const patientId = useSearchParams().get("patient");
  const [h, setH] = useState<NetworkHistory | null>(null); const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!patientId) return;
    try { setH(await net.history(patientId)); setError(null); }
    catch (e) { setError(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : N("error")); }
  }, [patientId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { s.setPatient(null); void load(); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!patientId) return <PageState icon="shield-check" title={N("nh_pick")} />;
  if (error) return <div className="module-page"><Callout tone="bad" icon="shield-x" role="alert">{error}</Callout></div>;
  if (!h) return <PageState icon="loader" title="…" />;
  return (
    <div className="module-page" style={{ display: "flex", flexDirection: "column", gap: 12 }} data-screen="net/consent">
      <h1 className="t-h2" style={{ margin: 0 }}>{N("nh_title")}</h1>
      {!h.linked && <Callout icon="link-2-off" data-testid="nh-not-linked">{N("nh_not_linked")}</Callout>}
      {h.linked && !h.sharing && <Callout tone="warn" icon="eye-off" data-testid="nh-sharing-off">{N("nh_sharing_off")}</Callout>}
      {h.linked && h.sharing && <Policy h={h} />}
      <OwnBloodGroup h={h} onSaved={load} />
      {h.linked && <Requests h={h} onSent={load} />}
    </div>
  );
}

function Source({ r }: { r: { facilityEn: string | null; facilityBn: string | null; authorEn: string | null; authorBn: string | null; at: string } }) {
  const s = useSession(); const N = useN();
  const name = (en: string | null, bn: string | null) => (s.lang === "bn" ? bn ?? en : en ?? bn) ?? "";
  return (
    <span className="t-small t-muted" style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      {name(r.facilityEn, r.facilityBn)}{name(r.authorEn, r.authorBn) ? ` · ${name(r.authorEn, r.authorBn)}` : ""} · {format.date(r.at, s.numerals === "bn")}
      <Pill tone="final" icon="shield-check">{N("nh_verified")}</Pill>
    </span>
  );
}

function Policy({ h }: { h: NetworkHistory }) {
  const s = useSession(); const N = useN();
  const L = (en: string, bn: string) => (s.lang === "bn" ? bn : en);
  const block = (key: string, testid: string, rows: React.ReactNode[]) => (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }} data-testid={testid}>
      <b>{N(key)}</b>
      {rows.length ? rows : <span className="t-small t-muted">{N("nh_none")}</span>}
    </Card>
  );
  return <>
    <span className="t-small t-muted" data-testid="nh-intro">{N("nh_intro", { n: h.facilities })}</span>
    {block("nh_allergies", "nh-allergies", h.allergies.map((a, i) => (
      <div key={i} data-row="allergy"><span className="allergy"><Icon name="triangle-alert" size={13} />{L(a.labelEn, a.labelBn)}{a.reaction ? ` · ${a.reaction}` : ""}</span><br /><Source r={a} /></div>
    )))}
    {block("nh_medicines", "nh-medicines", h.medicines.map((m, i) => (
      <div key={i} data-row="medicine"><b>{m.form} {m.brand} {m.strength}</b> <i>({m.generic})</i> · <span className="num">{m.dose}</span>{m.inpatient ? ` · ${N("nh_inpatient")}` : ` · ${N("nh_days", { n: m.days })}`}<br /><Source r={m} /></div>
    )))}
    {block("nh_problems", "nh-problems", h.problems.map((p, i) => (
      <div key={i} data-row="problem"><b>{L(p.labelEn, p.labelBn)}</b> <span className="t-small num">{p.code}</span><br /><Source r={p} /></div>
    )))}
    {block("nh_blood", "nh-blood", h.bloodGroups.map((b, i) => (
      <div key={i} data-row="blood"><b className="num">{b.value}</b><br /><Source r={b} /></div>
    )))}
    <span className="t-small t-muted">{N("nh_never")}</span>
  </>;
}

function OwnBloodGroup({ h, onSaved }: { h: NetworkHistory; onSaved: () => Promise<void> }) {
  const s = useSession(); const N = useN(); const toast = useToast();
  const [v, setV] = useState(h.own.bloodGroup ?? ""); const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await net.bloodGroup(h.patientId, v, crypto.randomUUID()); toast(N("nh_bg_saved"), "check"); await onSaved(); }
    catch (e) { toast(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : N("error"), "circle-alert"); }
    finally { setBusy(false); }
  };
  return (
    <Card style={{ padding: 14, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }} data-testid="nh-own-blood">
      <SelectField label={N("nh_bg_own")} value={v} onChange={(e) => setV(e.target.value)} style={{ minWidth: 120 }}>
        <option value="">—</option>
        {BLOOD_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
      </SelectField>
      <Button icon="save" disabled={!v || v === h.own.bloodGroup || busy} onClick={() => void save()}>{N("nh_bg_save")}</Button>
      {h.own.bloodGroupAt && <span className="t-small t-muted">{N("nh_bg_at", { t: format.dateTime(h.own.bloodGroupAt, s.numerals === "bn") })}</span>}
    </Card>
  );
}

function Requests({ h, onSent }: { h: NetworkHistory; onSent: () => Promise<void> }) {
  const s = useSession(); const N = useN(); const toast = useToast();
  const [kinds, setKinds] = useState<AccessRequestCreate["kinds"]>([]);
  const [period, setPeriod] = useState<AccessRequestCreate["period"]>("24h");
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const bn = s.numerals === "bn";
  const waiting = h.requests.some((r) => r.state === "sent");
  const send = async () => {
    setBusy(true); setError(null);
    try {
      await net.requestAccess({ patientId: h.patientId, kinds, period, reason: reason.trim() }, crypto.randomUUID());
      toast(N("nh_req_sent"), "check"); setKinds([]); setReason(""); await onSent();
    } catch (e) { setError(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : N("error")); }
    finally { setBusy(false); }
  };
  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }} data-testid="nh-request">
      <b>{N("nh_req_title")}</b>
      <span className="t-small t-muted">{N("nh_req_intro")}</span>
      {!waiting && <>
        <span style={{ display: "flex", gap: 12, flexWrap: "wrap" }} role="group" aria-label={N("nh_req_kinds")}>
          {KINDS.map((k) => (
            <label key={k} style={{ display: "inline-flex", gap: 6, alignItems: "center", minHeight: 44 }}>
              <input type="checkbox" checked={kinds.includes(k)} data-kind={k} onChange={(e) => setKinds(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k))} />{N(`nh_kind_${k}`)}
            </label>
          ))}
        </span>
        <Segmented label={N("nh_req_period")} value={period} onChange={setPeriod} options={[{ value: "24h", label: N("nh_period_24h") }, { value: "30d", label: N("nh_period_30d") }]} />
        <TextArea label={N("nh_req_reason")} hint={N("nh_req_reason_hint")} value={reason} maxLength={300} rows={2} onChange={(e) => setReason(e.target.value)} data-testid="nh-reason" />
        {error && <Callout tone="bad" icon="circle-alert" role="alert">{error}</Callout>}
        <span><Button variant="primary" icon="send" disabled={busy || !kinds.length || reason.trim().length < 10} onClick={() => void send()} data-testid="nh-send">{N("nh_req_send")}</Button></span>
      </>}
      {h.requests.map((r) => (
        <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--border-subtle)", paddingTop: 8 }} data-testid="nh-request-row" data-state={r.state}>
          <Pill tone={STATE_TONE[r.state] ?? "neu"}>{N(`nh_state_${r.state}`)}</Pill>
          <span className="t-small" style={{ flex: 1, minWidth: 200 }}>{r.kinds.map((k) => N(`nh_kind_${k}`)).join(", ")} · {N(`nh_period_${r.period}`)} · {format.dateTime(r.createdAt, bn)}<br /><i>“{r.reason}”</i></span>
          {r.state === "granted" && r.consentId && <a className="btn" href={`/m/net/shared?consent=${encodeURIComponent(r.consentId)}`} data-testid="nh-open-shared"><Icon name="folder-open" size={16} />{N("open")}</a>}
        </div>
      ))}
    </Card>
  );
}
