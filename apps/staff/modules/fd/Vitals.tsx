"use client";
/* fd/vitals — walkthrough A4. Ported from docs/prototype/Setu Front Desk.dc.html (screen "Vitals (tablet)").
   Warnings come from @setu/domain assessVitals as you type (the API runs the same function and refuses impossible
   values). "Saved" appears only after the server answers; offline the batch waits in the outbox as "not synced". */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { VitalsView, VitalsWorklist } from "@setu/contracts";
import { assessVitals, format, parseVital, type RbsMode, type VitalAssessment, type VitalField } from "@setu/domain";
import { fill } from "@setu/i18n";
import { Button, Callout, Card, PageState, Pill, Segmented, useToast, type Tone } from "@setu/ui";
import { ApiFailure, vitals as api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { ageOf, bannerOf, useLabels } from "./common";

type Form = Record<"bpSys" | "bpDia" | "pulse" | "temp" | "spo2" | "rbs" | "weight" | "height", string>;
const EMPTY: Form = { bpSys: "", bpDia: "", pulse: "", temp: "", spo2: "", rbs: "", weight: "", height: "" };
const TONE: Record<VitalAssessment["level"], Tone> = { impossible: "bad", critical: "bad", high: "warn", low: "warn", normal: "ok" };
const ICON: Record<VitalAssessment["level"], string> = { impossible: "octagon-x", critical: "siren", high: "arrow-up", low: "arrow-down", normal: "check" };

function useV() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) =>
    fill(s.t("vitalsApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}

export function FrontDeskVitals() {
  const enc = useSearchParams().get("enc");
  return enc ? <VitalsEntry encounterId={enc} /> : <VitalsWorklistView />;
}

function VitalsWorklistView() {
  const s = useSession(); const V = useV(); const L = useLabels(); const router = useRouter();
  const [w, setW] = useState<VitalsWorklist | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => { s.setPatient(null); api.worklist().then(setW).catch(() => setFailed(true)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <Callout tone="warn" icon="triangle-alert">{V("error_generic")}</Callout>;
  if (!w) return <div aria-busy="true" className="t-muted">{V("loading")}</div>;
  return (
    <div data-screen="fd/vitals" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{V("worklist_title")}</h1>
      {w.items.length === 0 ? <PageState icon="heart-pulse" title={V("worklist_empty")} /> : (
        <>
          <span className="t-muted">{V("worklist_hint")}</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
            {w.items.map((i) => (
              <button key={i.id} type="button" className="card" data-vitals-token={i.token} onClick={() => router.push(`/m/fd/vitals?enc=${encodeURIComponent(i.id)}`)}
                style={{ display: "flex", flexDirection: "column", gap: 4, padding: 14, textAlign: "left", cursor: "pointer" }}>
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <b className="num" style={{ fontSize: 18 }}>{i.token}</b>
                  <Pill tone={i.hasVitals ? "ok" : "neu"} icon={i.hasVitals ? "check" : "clock"}>{i.hasVitals ? V("worklist_done") : V("worklist_waiting")}</Pill>
                </span>
                <b>{s.lang === "bn" ? i.patient.nameBn : i.patient.nameEn ?? i.patient.nameBn}</b>
                <span className="t-small t-muted num">{i.patient.facilityNo} · {L.age(i.patient)} {L.sex(i.patient.sex)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* Field → (form keys, unit key, observation code for the "last" value). */
const FIELDS: { f: VitalField; keys: (keyof Form)[]; code: string[] }[] = [
  { f: "bp", keys: ["bpSys", "bpDia"], code: ["bp-systolic", "bp-diastolic"] },
  { f: "pulse", keys: ["pulse"], code: ["pulse"] },
  { f: "temp", keys: ["temp"], code: ["body-temperature"] },
  { f: "spo2", keys: ["spo2"], code: ["spo2"] },
  { f: "rbs", keys: ["rbs"], code: ["blood-glucose"] },
  { f: "weight", keys: ["weight"], code: ["body-weight"] },
  { f: "height", keys: ["height"], code: ["body-height"] },
];

function VitalsEntry({ encounterId }: { encounterId: string }) {
  const s = useSession(); const V = useV(); const L = useLabels(); const router = useRouter(); const toast = useToast();
  const [view, setView] = useState<VitalsView | null>(null); const [failed, setFailed] = useState(false);
  const [f, setF] = useState<Form>(EMPTY);
  const [rbsMode, setRbsMode] = useState<RbsMode>("random");
  const [confirmed, setConfirmed] = useState<VitalField[]>([]);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [save, setSave] = useState<{ st: "idle" | "saving" | "saved" | "queued" | "failed"; at?: string; name?: string }>({ st: "idle" });

  const load = useCallback(async () => { try { setView(await api.view(encounterId)); } catch { setFailed(true); } }, [encounterId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (view) s.setPatient(bannerOf(view.encounter.patient, L)); }, [view?.encounter.patient.id, s.lang, s.numerals]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const values = useMemo(() => {
    const v: Record<string, number> = {};
    for (const k of Object.keys(EMPTY) as (keyof Form)[]) { const n = parseVital(f[k]); if (n !== null) v[k] = n; }
    return v;
  }, [f]);
  const a = useMemo(() => assessVitals({ ...values, rbsMode }), [values, rbsMode]);
  const fieldOf = (k: keyof Form): VitalField => (k === "bpSys" || k === "bpDia" ? "bp" : k);
  const set = (k: keyof Form, v: string) => {
    setF((x) => ({ ...x, [k]: v })); setKey(crypto.randomUUID()); if (save.st !== "saving") setSave({ st: "idle" });
    setConfirmed((c) => c.filter((x) => x !== fieldOf(k))); // a changed value must be re-checked again
  };
  const unconfirmed = a.needsConfirm.filter((x) => !confirmed.includes(x));

  const submit = async () => {
    if (a.blocked || unconfirmed.length || save.st === "saving") return;
    setSave({ st: "saving" });
    try {
      const r = await api.record(encounterId, { values: { ...values, ...(values.rbs !== undefined ? { rbsMode } : {}) }, confirmed: a.needsConfirm.filter((x) => confirmed.includes(x)), effectiveAt: new Date().toISOString() }, key);
      if (r.queued) { setSave({ st: "queued" }); return; }
      setSave({ st: "saved", at: r.data.batch.recordedAt, name: s.L(r.data.batch.recordedBy.nameBn, r.data.batch.recordedBy.nameEn) });
      await load();
    } catch (e) {
      setSave({ st: "failed" });
      toast(e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : V("error_generic"), "triangle-alert");
    }
  };

  if (failed) return <Callout tone="warn" icon="triangle-alert">{V("error_generic")}</Callout>;
  if (!view) return <div aria-busy="true" className="t-muted">{V("loading")}</div>;
  const closed = !["arrived", "triaged", "in-progress"].includes(view.encounter.status);
  const prev = (code: string) => view.previous.find((p) => p.code === code);
  const dm = (iso: string) => s.n(format.date(iso).slice(0, 5));
  const lastText = (fl: (typeof FIELDS)[number]) => {
    const p = fl.code.map(prev);
    if (!p[0]) return V("no_last");
    const v = fl.f === "bp" ? `${s.n(p[0].value)}/${p[1] ? s.n(p[1].value) : "—"}` : s.n(p[0].value);
    return V("last", { v, d: dm(p[0].effectiveAt) });
  };
  const status = (fl: VitalField) => a.fields.find((x) => x.field === fl);
  const wPrev = prev("body-weight"); const wNow = values.weight;
  const delta = wPrev && wNow !== undefined && status("weight")?.level !== "impossible" ? Math.round((wNow - wPrev.value) * 10) / 10 : null;
  const summary = a.empty ? V("sum_empty") : a.blocked ? V("sum_blocked") : unconfirmed.length ? V("sum_confirm") : a.critical ? V("sum_critical") : a.outOfRange ? V("sum_out", { n: a.outOfRange }) : V("sum_ok");
  const me = s.me ? s.L(s.me.nameBn, s.me.nameEn) : "";
  // Limits and BMI cut-offs are adult ones (clinical review): under 18 the BMI category is not shown.
  const age = ageOf(view.encounter.patient);
  const minor = age !== null && age.y < 18;

  return (
    <div data-screen="fd/vitals" style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0, paddingBottom: 72 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{V("title")}</h1>
        <Pill tone="neu" icon="ticket">{V("token", { t: view.encounter.token })}</Pill>
        <span style={{ marginLeft: "auto" }} />
        <Button size="sm" icon="arrow-left" onClick={() => router.push("/m/fd/vitals")}>{V("back_to_list")}</Button>
      </div>
      {!s.online && <Callout tone="warn" icon="cloud-off">{V("offline_banner")}</Callout>}
      {closed && <Callout tone="warn" icon="lock">{V("visit_closed")}</Callout>}
      {minor && <Callout icon="baby">{V("adult_ranges")}</Callout>}
      {view.current && save.st !== "saved" && <span className="t-small t-muted">{V("saved_before", { at: format.dateTime(view.current.recordedAt, s.numerals === "bn") })}</span>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12 }}>
        {FIELDS.map((fl) => {
          const st = status(fl.f);
          return (
            <Card key={fl.f} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }} data-vital={fl.f} data-level={st?.level ?? "empty"}>
              <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <b>{V(`f_${fl.f}`)}</b><span className="t-small t-muted">{V(`u_${fl.f}`)}</span>
              </span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {fl.keys.map((k, i) => (
                  <span key={k} style={{ display: "contents" }}>
                    {i > 0 && <span aria-hidden="true" style={{ fontSize: 20 }}>/</span>}
                    <input name={k} className="input num" inputMode="decimal" aria-label={fl.keys.length > 1 ? V(k === "bpSys" ? "f_bp_sys" : "f_bp_dia") : V(`f_${fl.f}`)}
                      aria-invalid={st?.level === "impossible" ? "true" : undefined} disabled={closed}
                      style={{ minWidth: 72, width: "100%", fontSize: 20 }} value={f[k]} onChange={(e) => set(k, e.target.value)} />
                  </span>
                ))}
              </span>
              {fl.f === "rbs" && (
                <Segmented label="RBS mode" value={rbsMode} onChange={(v) => { setRbsMode(v); setKey(crypto.randomUUID()); }} options={[{ value: "random", label: V("rbs_random") }, { value: "fasting", label: V("rbs_fasting") }]} />
              )}
              {st ? (
                <span role={st.level === "impossible" || st.level === "critical" ? "alert" : undefined}><Pill tone={TONE[st.level]} icon={ICON[st.level]}>{V(`c_${st.code}`)}</Pill></span>
              ) : <span className="t-small t-muted">&nbsp;</span>}
              {st?.confirm && (
                <label className="t-small" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" checked={confirmed.includes(fl.f)} onChange={(e) => { setConfirmed((c) => (e.target.checked ? [...c, fl.f] : c.filter((x) => x !== fl.f))); setKey(crypto.randomUUID()); }} />
                  {V("confirm_tick")}
                </label>
              )}
              <span className="t-small t-muted">{fl.f === "weight" && delta !== null ? V("weight_delta", { d: `${delta > 0 ? "+" : ""}${s.n(delta)}` }) : lastText(fl)}</span>
            </Card>
          );
        })}
        <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14, background: "var(--surface-subtle)" }} data-vital="bmi">
          <span style={{ display: "flex", justifyContent: "space-between" }}><b>{V("f_bmi")}</b><span className="t-small t-muted">{V("u_bmi")}</span></span>
          <b className="num" style={{ fontSize: 24 }} data-testid="bmi-value">{a.bmi === null ? "—" : s.n(a.bmi.toFixed(1))}</b>
          {a.bmiClass ? (minor ? <span className="t-small t-muted">{V("bmi_child")}</span> : <Pill tone={a.bmiClass === "normal" ? "ok" : "warn"}>{V(`bmi_${a.bmiClass}`)}</Pill>) : <span className="t-small t-muted">{V("bmi_enter")}</span>}
          <span className="t-small t-muted">{V("bmi_auto")}</span>
        </Card>
      </div>

      <div className="card" style={{ position: "sticky", bottom: 0, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "10px 16px", zIndex: 2 }}>
        <span style={{ flex: "1 1 280px", display: "flex", flexDirection: "column", gap: 2 }}>
          <b data-testid="vitals-summary" style={{ color: a.blocked || a.critical ? "var(--status-bad-fg, inherit)" : undefined }}>{summary}</b>
          <span className="t-small" role="status" data-testid="vitals-stamp">
            {save.st === "saving" ? V("stamp_saving") : save.st === "saved" ? V("stamp_saved", { name: save.name ?? me, at: format.time(save.at ?? Date.now(), s.numerals === "bn") })
              : save.st === "queued" ? V("stamp_queued") : save.st === "failed" ? V("stamp_failed") : V("stamp_idle", { name: me })}
          </span>
        </span>
        <Button variant="primary" icon="save" disabled={a.blocked || unconfirmed.length > 0 || closed || save.st === "saving"} onClick={() => void submit()}>{V("save")}</Button>
      </div>
    </div>
  );
}
