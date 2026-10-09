"use client";
/* D5–D6 (ADR 0021): share records with a doctor or a facility of the Setu network — what (all / one visit / one
   report), with whom, for how long (30 days unless the patient picks 24 h or 7 days); the active shares with who opened
   them, "Stop sharing" in two taps; and who viewed the patient's records, break-glass labelled. Needs the network. */
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { AccessLog, DirectoryView, ShareList, ShareView, TimelineItem } from "@setu/contracts";
import { format } from "@setu/domain";
import { Icon, Pill } from "@setu/ui";
import { Shell } from "../../components/Shell";
import { patient } from "../../lib/api";
import { errText, useLang } from "../../lib/lang";

type Tab = "new" | "active" | "viewed";
export default function SharePage() { return <Suspense><ShareScreen /></Suspense>; }

function ShareScreen() {
  const q = useSearchParams();
  const { T } = useLang();
  const [tab, setTab] = useState<Tab>("new");
  const [shares, setShares] = useState<ShareList | null>(null);
  const loadShares = useCallback(() => patient.shares().then(setShares).catch(() => setShares({ items: [] })), []);
  useEffect(() => { void loadShares(); }, [loadShares]);
  return (
    <Shell>
      <h1 className="pa-h2">{T("share_title")}</h1>
      <div className="pa-tabsbar" role="tablist">
        {(["new", "active", "viewed"] as const).map((k) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{T(k === "new" ? "share_new" : k === "active" ? "share_active" : "share_viewed")}</button>)}
      </div>
      {tab === "new" && <NewShare presetClaim={q.get("claim")} presetReport={q.get("report")} onMade={() => { void loadShares(); setTab("active"); }} />}
      {tab === "active" && <Active shares={shares} onChange={(v) => setShares((s) => s && { items: s.items.map((x) => (x.id === v.id ? v : x)) })} />}
      {tab === "viewed" && <Viewed />}
    </Shell>
  );
}

function NewShare({ presetClaim, presetReport, onMade }: { presetClaim: string | null; presetReport: string | null; onMade: () => void }) {
  const { lang, T } = useLang();
  const [dir, setDir] = useState<DirectoryView | null>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [scope, setScope] = useState<"all" | "visit" | "report">(presetReport ? "report" : "all");
  const [pick, setPick] = useState<string>(presetClaim && presetReport ? `${presetClaim}|${presetReport}` : "");
  const [org, setOrg] = useState("");
  const [doctor, setDoctor] = useState("");
  const [period, setPeriod] = useState<"24h" | "7d" | "30d">("30d");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    patient.directory().then(setDir).catch((e) => setError(errText(lang, e, T)));
    patient.timeline("all").then((t) => setItems(t.items)).catch(() => {});
    const on = () => setOnline(navigator.onLine); on();
    addEventListener("online", on); addEventListener("offline", on);
    return () => { removeEventListener("online", on); removeEventListener("offline", on); };
  }, [lang, T]);
  const nm = (en: string | null, bn: string | null) => (lang === "bn" ? bn ?? en : en ?? bn) ?? "";
  const facility = dir?.facilities.find((f) => f.organizationId === org);
  const visits = items.filter((i) => i.kind === "visit" || i.kind === "admission");
  const reports = items.filter((i) => i.kind === "report");
  const ready = online && !!org && (scope === "all" || !!pick) && !busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      const [claimId, recordId] = pick.split("|");
      const body = scope === "all" ? { kind: "all" as const } : scope === "visit" ? { kind: "visit" as const, claimId: claimId!, encounterId: recordId! } : { kind: "report" as const, claimId: claimId!, reportId: recordId! };
      await patient.share({ period, scope: body, grantee: { organizationId: org, userId: doctor || null } }, crypto.randomUUID());
      onMade();
    } catch (e) { setError(errText(lang, e, T)); } finally { setBusy(false); }
  };
  const label = (i: TimelineItem) => `${format.date(i.at, lang === "bn")} · ${i.kind === "report" ? `${T("k_report")}${i.number ? " " + i.number : ""}` : T(i.kind === "admission" ? "k_admission" : i.visitClass === "er" ? "k_visit_er" : "k_visit_opd")} · ${nm(i.facilityEn, i.facilityBn)}`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <fieldset className="pa-choice" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="pa-label">{T("share_what")}</legend>
        {(["all", "visit", "report"] as const).map((k) => (
          <label key={k}><input type="radio" name="scope" checked={scope === k} onChange={() => { setScope(k); setPick(""); }} />
            <span>{T(`scope_${k}`)}{k === "all" && <><br /><span className="pa-note">{T("scope_all_hint")}</span></>}</span></label>
        ))}
      </fieldset>
      {scope !== "all" && (
        <label className="pa-label">{T("pick_record")}
          <select name="record" className="pa-select" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">—</option>
            {(scope === "visit" ? visits : reports).map((i) => <option key={i.key} value={`${i.claimId}|${scope === "visit" ? i.encounterId ?? i.recordId : i.recordId}`}>{label(i)}</option>)}
          </select>
        </label>
      )}
      <label className="pa-label">{T("share_with")} · {T("pick_facility")}
        <select name="facility" className="pa-select" value={org} onChange={(e) => { setOrg(e.target.value); setDoctor(""); }}>
          <option value="">—</option>
          {dir?.facilities.map((f) => <option key={f.organizationId} value={f.organizationId}>{nm(f.nameEn, f.nameBn)}</option>)}
        </select>
      </label>
      {facility && (
        <label className="pa-label">{T("pick_doctor")}
          <select name="doctor" className="pa-select" value={doctor} onChange={(e) => setDoctor(e.target.value)}>
            <option value="">{T("any_doctor")}</option>
            {facility.doctors.map((d) => <option key={d.userId} value={d.userId}>{nm(d.nameEn, d.nameBn)}</option>)}
          </select>
        </label>
      )}
      <fieldset className="pa-choice" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="pa-label">{T("share_for")}</legend>
        <div className="pa-row">
          {(["24h", "7d", "30d"] as const).map((p) => <label key={p}><input type="radio" name="period" checked={period === p} onChange={() => setPeriod(p)} /><span>{T(`p_${p}`)}</span></label>)}
        </div>
      </fieldset>
      <span className="pa-note">{T("share_rules")}</span>
      {error && <span className="pa-err" role="alert"><Icon name="circle-x" size={16} />{error}</span>}
      <button type="button" className="pa-btn pa-btn-primary" disabled={!ready} onClick={submit}><Icon name="share-2" size={18} />{online ? T("share_go") : T("share_offline")}</button>
    </div>
  );
}

function Active({ shares, onChange }: { shares: ShareList | null; onChange: (v: ShareView) => void }) {
  const { T } = useLang();
  if (!shares) return <p className="pa-sub">{T("loading")}</p>;
  if (!shares.items.length) return <p className="pa-sub">{T("no_shares")}</p>;
  return <>{shares.items.map((s) => <ShareCard key={s.id} s={s} onChange={onChange} />)}</>;
}

function ShareCard({ s, onChange }: { s: ShareView; onChange: (v: ShareView) => void }) {
  const { lang, T } = useLang();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bn = lang === "bn";
  const nm = (en: string | null, b: string | null) => (bn ? b ?? en : en ?? b) ?? "";
  const who = [nm(s.grantee.doctorEn, s.grantee.doctorBn), nm(s.grantee.facilityEn, s.grantee.facilityBn)].filter(Boolean).join(" · ");
  const what = s.scope.kind === "all" ? T("what_all") : s.scope.kind === "report" ? T("what_report", { n: s.scope.number ?? "" }) : T("what_visit", { t: s.scope.at ? format.date(s.scope.at, bn) : "" });
  const stop = async () => {
    setBusy(true); setError(null);
    try { onChange(await patient.revoke(s.id, crypto.randomUUID())); setConfirm(false); } catch (e) { setError(errText(lang, e, T)); } finally { setBusy(false); }
  };
  return (
    <section className="pa-card" data-share={s.status} aria-label={who}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}><b style={{ display: "block" }}>{what}</b><span className="pa-meta">{T("to", { who })}</span></div>
        {s.status === "active" ? <Pill tone="ok" icon="share-2">{T("share_active")}</Pill> : <Pill tone="neu" icon="circle-off">{s.status === "revoked" ? T("stopped_at", { t: format.dateTime(s.revokedAt!, bn) }) : T("expired_at", { t: format.dateTime(s.endsAt, bn) })}</Pill>}
      </div>
      {s.status === "active" && <span className="pa-meta">{T("ends", { t: format.dateTime(s.endsAt, bn) })}</span>}
      <div>
        <span className="pa-label">{T("opens")}</span>
        {s.opens.length ? <ul className="pa-meta" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {s.opens.map((o, i) => <li key={i}>{format.dateTime(o.at, bn)} · {bn ? o.nameBn : o.nameEn} ({T(`role_${o.role}`)}) · {nm(o.facilityEn, o.facilityBn)} · {T(`w_${o.itemKind}`)}</li>)}
        </ul> : <p className="pa-note" style={{ margin: 0 }}>{T("no_opens")}</p>}
      </div>
      {error && <span className="pa-err" role="alert"><Icon name="circle-x" size={16} />{error}</span>}
      {s.status === "active" && (!confirm
        ? <button type="button" className="pa-btn" onClick={() => setConfirm(true)}><Icon name="circle-stop" size={18} />{T("stop")}</button>
        : <button type="button" className="pa-btn pa-btn-primary" style={{ background: "var(--danger-solid)", borderColor: "var(--danger-solid)" }} disabled={busy} onClick={stop}>{T("stop_confirm")}</button>)}
    </section>
  );
}

function Viewed() {
  const { lang, T, n } = useLang();
  const [log, setLog] = useState<AccessLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { patient.accessLog(null).then(setLog).catch((e) => setError(errText(lang, e, T))); }, [lang, T]);
  const more = async () => { if (!log?.next) return; const m = await patient.accessLog(log.next); setLog({ items: [...log.items, ...m.items], next: m.next }); };
  const bn = lang === "bn";
  if (error) return <span className="pa-err" role="alert"><Icon name="circle-x" size={16} />{error}</span>;
  if (!log) return <p className="pa-sub">{T("loading")}</p>;
  if (!log.items.length) return <p className="pa-sub">{T("viewed_none")}</p>;
  // one row per person, kind of look, kind of record and day (a lab visit is looked at many times); never break-glass
  const rows: (AccessLog["items"][number] & { times: number })[] = [];
  for (const e of log.items) {
    const last = rows.at(-1);
    if (last && e.kind !== "break-glass" && last.kind === e.kind && last.what === e.what && last.nameEn === e.nameEn && last.facilityEn === e.facilityEn && last.at.slice(0, 10) === e.at.slice(0, 10)) last.times++;
    else rows.push({ ...e, times: 1 });
  }
  return (
    <>
      {rows.map((e, i) => (
        <article key={i} className={"pa-item" + (e.kind === "break-glass" ? " pa-bg" : "")} data-access={e.kind}>
          <span className="pa-ic"><Icon name={e.kind === "break-glass" ? "siren" : e.kind === "shared" ? "share-2" : e.kind === "view" ? "eye" : "printer"} size={20} /></span>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            <span className="pa-meta">{format.dateTime(e.at, bn)}</span>
            <b>{(bn ? e.nameBn ?? e.nameEn : e.nameEn ?? e.nameBn) ?? "—"}{e.role ? ` · ${T(`role_${e.role}`)}` : ""}</b>
            <span className="pa-meta">{(bn ? e.facilityBn ?? e.facilityEn : e.facilityEn ?? e.facilityBn) ?? ""}</span>
            <span>{T(`k_${e.kind.replace("-", "_")}`)} · {T(`w_${e.what}`)}{e.times > 1 ? ` · ${T("times", { n: n(e.times) })}` : ""}</span>
            {e.kind === "break-glass" && <>
              {e.reason && <span className="pa-meta">{T("bg_reason", { r: e.reason })}</span>}
              <span className="pa-meta">{e.reviewed ? T("bg_reviewed") : T("bg_not_reviewed")}</span>
            </>}
          </div>
        </article>
      ))}
      {log.next && <button type="button" className="pa-btn" onClick={more}>{T("more")}</button>}
    </>
  );
}
