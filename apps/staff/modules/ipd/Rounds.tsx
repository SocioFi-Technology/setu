"use client";
/* ipd/rounds — walkthrough B5–B6. Ported from docs/prototype/Setu IPD.dc.html (screen "rounds"): the doctor's worklist
   (open escalations and highest NEWS2 first, missed doses and nursing notes since the last round); a patient opens
   the last 24 hours (observations, escalations, notes, doses not given), the active orders (stop with a reason and the
   doctor's PIN — future doses end), and the round note: S/O/A/P with inpatient order lines (drug, route, dose, times or
   PRN with a 24-hour cap), saved as a draft and signed with the PIN (the A5 allergy / duplicate / interaction checks
   run on signing). A signed note is amended, never overwritten: the amendment's unchanged lines carry their history,
   a changed line starts a new one and the old line's future doses stop. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { InpatientLineInput, InpatientOrder, RoundNote, RoundView, RoundWorklist } from "@setu/contracts";
import { lineProblems, roundNoteBlockers, wardMedicine } from "@setu/domain";
import { Button, Callout, Card, PageState, Pill, SelectField, TextArea, TextField, useToast } from "@setu/ui";
import { ApiFailure, ward } from "../../lib/api";
import { useSession } from "../../lib/session";
import { News2Pill, PinSheet, hhmm, useErr, useLabels, useN, useWardBanner } from "../nur/common";

type Med = RoundView["activeOrders"][number]["medicine"];

export function IpdRounds() {
  const enc = useSearchParams().get("enc");
  if (!enc) return <Worklist />;
  return <RoundFor key={enc} enc={enc} />;
}

function Worklist() {
  const s = useSession(); const N = useN(); const err = useErr(); const L = useLabels(); const router = useRouter();
  const [w, setW] = useState<RoundWorklist | null>(null); const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => { ward.rounds().then(setW).catch((e) => setFailed(err(e))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <Callout tone="warn" icon="triangle-alert">{failed}</Callout>;
  if (!w) return <div aria-busy="true" className="t-muted">{N("loading")}</div>;
  const bn = s.lang === "bn";
  return (
    <div data-screen="ipd/rounds" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{N("rounds_title")}</h1>
      <span className="t-small t-muted">{N("sample_rule")}: NEWS2 ≥ {s.n(w.rule.threshold)}</span>
      {w.items.length === 0 && <PageState icon="bed-double" title={N("rounds_title")} body={N("rounds_none")} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="worklist">
        {w.items.map((i) => (
          <button key={i.encounterId} type="button" className="card" data-round-patient={i.patient.facilityNo} onClick={() => router.push(`/m/ipd/rounds?enc=${encodeURIComponent(i.encounterId)}`)}
            style={{ textAlign: "left", padding: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", cursor: "pointer", borderColor: i.escalation ? "var(--danger-border)" : undefined }}>
            <b className="num" style={{ minWidth: 90 }}>{i.ward} · {i.bed}</b>
            <span style={{ flex: 1, minWidth: 180 }}><b>{bn ? i.patient.nameBn : i.patient.nameEn || i.patient.nameBn}</b> <span className="t-small t-muted num">{i.patient.facilityNo} · {L.age(i.patient)} {L.sex(i.patient.sex)} · {N("day_n", { n: i.day })}</span></span>
            <News2Pill n={i.news2} />
            {i.escalation && <Pill tone="crit" icon="siren">{N("news2_n", { n: i.escalation.peakScore })}</Pill>}
            {i.missedLast24h > 0 && <Pill tone="bad" icon="pill">{N("missed_n", { n: i.missedLast24h })}</Pill>}
            {i.notesSinceRound > 0 && <Pill tone="info" icon="notebook-pen">{N("notes_since", { n: i.notesSinceRound })}</Pill>}
            {i.draftId && <Pill tone="draft">{N("continue_round")}</Pill>}
          </button>
        ))}
      </div>
    </div>
  );
}

function RoundFor({ enc }: { enc: string }) {
  const s = useSession(); const N = useN(); const err = useErr(); const toast = useToast();
  const [v, setV] = useState<RoundView | null>(null); const [failed, setFailed] = useState<string | null>(null);
  const [stop, setStop] = useState<InpatientOrder | null>(null); const [stopReason, setStopReason] = useState(""); const [stopPin, setStopPin] = useState(false);
  const load = useCallback(async () => { try { setV(await ward.round(enc)); } catch (e) { setFailed(err(e)); } }, [enc]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  useWardBanner(v?.patient, v?.allergies, v?.bed ? `${v.bed.ward} · ${v.bed.name}` : null);
  if (failed) return <Callout tone="warn" icon="triangle-alert">{failed}</Callout>;
  if (!v) return <div aria-busy="true" className="t-muted">{N("loading")}</div>;
  const bn = s.lang === "bn"; const bnNum = s.numerals === "bn";
  const startRound = async () => { try { setV(await ward.openRound(enc)); } catch (e) { toast(err(e), "triangle-alert"); } };
  const amend = async (n: RoundNote) => {
    const reason = (document.querySelector<HTMLTextAreaElement>(`[name="amend-${n.id}"]`)?.value ?? "").trim();
    if (reason.length < 5) return;
    try { setV(await ward.amendRound(n.id, reason)); } catch (e) { toast(err(e), "triangle-alert"); }
  };
  return (
    <div data-screen="ipd/rounds" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{N("rounds_title")} · {N("day_n", { n: v.day })}</h1>
      <span className="t-small">{v.diagnosis}</span>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.3fr)", gap: 14, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Card style={{ display: "flex", flexDirection: "column", gap: 6, padding: 14 }} data-testid="overnight">
            <b>{N("overnight")}</b>
            {v.overnight.escalations.map((x) => <span key={x.id} className="t-small" data-overnight-escalation={x.status}><Pill tone="crit" icon="siren">{N("news2_n", { n: x.peakScore })} · {hhmm(x.raisedAt, bnNum)}</Pill> {x.spokeTo ? `${N("escalation_informed")}: ${x.spokeTo}` : ""}{x.instruction ? ` — ${x.instruction}` : ""}</span>)}
            {v.overnight.vitals.map((x, i) => <span key={i} className="t-small" style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="num">{hhmm(x.at, bnNum)}</span><News2Pill n={x.news2} /><span className="t-muted">{x.summary}</span></span>)}
            {v.overnight.doses.filter((d) => d.status !== "given").map((d, i) => <span key={i} className="t-small" data-overnight-dose={d.status}>{d.medicine} · {N(`st_${d.status}`)} · {hhmm(d.at, bnNum)}{d.reason ? ` — ${d.reason}` : ""}</span>)}
            {v.overnight.notes.filter((n) => n.status === "active").map((n) => <span key={n.id} className="t-small">{hhmm(n.effectiveAt, bnNum)} · {n.text}</span>)}
          </Card>
          <Card style={{ display: "flex", flexDirection: "column", gap: 8, padding: 14 }} data-testid="active-orders">
            <b>{N("active_orders")}</b>
            {v.activeOrders.map((o) => (
              <div key={o.id} className="t-small" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }} data-active-order={o.medicine.key}>
                <b>{bn ? o.medicine.brandBn : o.medicine.brand} {o.medicine.strength}</b> {o.doseText} · {o.route} · {o.prn ? `${N("prn")}${o.prnMaxPer24h ? ` ≤${s.n(o.prnMaxPer24h)}` : ""}` : o.times.join(", ")}
                {o.medicine.highAlert && <Pill tone="crit">{N("high_alert")}</Pill>}
                {s.me?.role === "doctor" && <Button size="sm" icon="octagon-x" disabled={!s.online} onClick={() => { setStop(o); setStopReason(""); }} data-testid="stop-order">{N("stop")}</Button>}
              </div>
            ))}
            {stop && (
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <TextArea label={`${N("stop_reason")} · ${stop.medicine.brand}`} value={stopReason} onChange={(e) => setStopReason(e.target.value)} rows={2} name="stopReason" data-testid="stop-reason" />
                <Button size="sm" variant="danger" icon="octagon-x" disabled={stopReason.trim().length < 5 || !s.online} onClick={() => setStopPin(true)} data-testid="stop-confirm">{N("stop")}</Button>
                <Button size="sm" onClick={() => setStop(null)}>{N("cancel")}</Button>
              </div>
            )}
          </Card>
          {v.signed.map((n) => (
            <Card key={n.id} style={{ display: "flex", flexDirection: "column", gap: 6, padding: 14 }} data-testid="signed-note" data-note-version={n.version} data-note-status={n.status}>
              <b>{N("signed_by", { name: n.signedBy ? (bn ? n.signedBy.nameBn : n.signedBy.nameEn) : "—", t: hhmm(n.signedAt, bnNum) })} · v{s.n(n.version)}</b>
              {n.amendReason && <span className="t-small t-muted">{N("amend_reason")}: {n.amendReason}</span>}
              {(["a", "p"] as const).map((k) => n.sections[k] && <span key={k} className="t-small"><b>{k.toUpperCase()}</b> {n.sections[k]}</span>)}
              {n.lines.map((l) => <span key={l.id} className="t-small" data-signed-line={l.medicineKey} data-line-status={l.status}>{wardMedicine(l.medicineKey)?.brand ?? l.medicineKey} {l.doseText} · {l.route} · {l.prn ? N("prn") : l.times.join(", ")} · {l.status}</span>)}
              {s.me?.role === "doctor" && !v.draft && n.status !== "superseded" && (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <TextArea label={N("amend_reason")} rows={1} name={`amend-${n.id}`} defaultValue="" />
                  <Button size="sm" icon="pen-line" disabled={!s.online} onClick={() => void amend(n)} data-testid="amend">{N("amend")}</Button>
                </div>
              )}
            </Card>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {v.draft ? <Editor key={v.draft.id} v={v} draft={v.draft} onChanged={setV} />
            : <Card style={{ padding: 16 }}><Button variant="primary" icon="stethoscope" disabled={!s.online || s.me?.role !== "doctor"} onClick={() => void startRound()} data-testid="open-round">{N("open_round")}</Button></Card>}
        </div>
      </div>
      {stop && stopPin && (
        <PinSheet title={`${N("stop")} · ${stop.medicine.brand} ${stop.medicine.strength}`} action={N("stop")} icon="octagon-x" onClose={() => setStopPin(false)}
          submit={async (pin) => { setV(await ward.stopOrder(stop.id, { reason: stopReason.trim(), pin }, crypto.randomUUID())); setStop(null); setStopPin(false); toast(N("order_stopped", { name: "", reason: stopReason.trim() }), "octagon-x"); }} />
      )}
    </div>
  );
}

type Line = InpatientLineInput & { timesText: string; qtyText: string; maxText: string };
const toLine = (l: InpatientLineInput): Line => ({ ...l, timesText: l.times.join(", "), qtyText: l.doseQty == null ? "" : String(l.doseQty), maxText: l.prnMaxPer24h == null ? "" : String(l.prnMaxPer24h) });
const fromLine = (l: Line): InpatientLineInput => ({
  medicineKey: l.medicineKey, route: l.route, doseText: l.doseText, doseQty: l.qtyText.trim() ? Number(l.qtyText) : null,
  times: l.prn ? [] : l.timesText.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean), prn: l.prn, prnMaxPer24h: l.prn && l.maxText.trim() ? Number(l.maxText) : null,
  note: l.note || undefined, keepBoth: l.keepBoth || undefined, acks: l.acks?.length ? l.acks : undefined,
});

function Editor({ v, draft, onChanged }: { v: RoundView; draft: RoundNote; onChanged: (v: RoundView) => void }) {
  const s = useSession(); const N = useN(); const err = useErr(); const toast = useToast();
  const [sec, setSec] = useState(draft.sections);
  const [lines, setLines] = useState<Line[]>(draft.lines.map(toLine));
  const [meds, setMeds] = useState<Med[]>([]);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [signBlockers, setSignBlockers] = useState<{ code: string; warning?: { line: string; kind: string; allergy?: { labelEn?: string; labelBn?: string }; ruleId?: string; textBn?: string; textEn?: string } }[]>([]);
  const [signing, setSigning] = useState(false);
  const rev = useRef(draft.rev); const signKey = useRef(crypto.randomUUID());
  useEffect(() => { ward.medicines("").then((r) => setMeds(r.items)).catch(() => setMeds([])); }, []);
  const medOf = (k: string) => meds.find((m) => m.key === k);
  const problems = lines.map((l) => (l.medicineKey ? lineProblems(fromLine(l)) : ["unknown_medicine"]));
  const linesOk = problems.every((p) => p.length === 0);
  const noteOk = roundNoteBlockers(sec).length === 0;
  const save = async (): Promise<boolean> => {
    if (!linesOk) return false;
    setBusy(true); setMsg(null);
    try {
      const nv = await ward.saveRound(draft.id, { rev: rev.current, sections: sec, lines: lines.map(fromLine), orders: [] });
      rev.current = nv.draft?.rev ?? rev.current; onChanged(nv);
      if (nv.draft) setLines(nv.draft.lines.map(toLine));
      return true;
    } catch (e) {
      setMsg(err(e));
      if (e instanceof ApiFailure && e.body.code === "stale") { toast(N("stale_refresh"), "refresh-cw"); onChanged(await ward.round(v.encounterId)); }
      return false;
    } finally { setBusy(false); }
  };
  const lineIndex = (id: string) => (v.draft?.lines ?? []).findIndex((l) => l.id === id);
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16 }} data-testid="round-editor" data-draft-version={draft.version}>
      {draft.amendsId && <Pill tone="draft" icon="pen-line">{N("amend")} · {draft.amendReason}</Pill>}
      {(["s", "o", "a", "p"] as const).map((k) => <TextArea key={k} label={N(`soap_${k}`)} value={sec[k]} onChange={(e) => setSec({ ...sec, [k]: e.target.value })} rows={k === "p" || k === "a" ? 3 : 2} name={`soap-${k}`} data-testid={`soap-${k}`} />)}
      <b className="t-small">{N("new_orders")}</b>
      {lines.map((l, i) => {
        const m = medOf(l.medicineKey) ?? (wardMedicine(l.medicineKey) as unknown as Med | null);
        const warn = signBlockers.filter((b) => b.warning && lineIndex(b.warning.line) === i);
        return (
          <div key={i} className="card" style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }} data-line={i} data-line-medicine={l.medicineKey}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8 }}>
              <SelectField label={N("indent_medicine")} value={l.medicineKey} onChange={(e) => { const nm = medOf(e.target.value); set(i, { medicineKey: e.target.value, route: nm?.routes[0] ?? "" }); }} data-testid="line-medicine">
                <option value="">—</option>
                {meds.map((x) => <option key={x.key} value={x.key}>{x.brand} {x.strength}{x.highAlert ? ` · ${N("high_alert")}` : ""}</option>)}
              </SelectField>
              <SelectField label={N("route")} value={l.route} onChange={(e) => set(i, { route: e.target.value })} data-testid="line-route">
                <option value="">—</option>
                {(m?.routes ?? []).map((r) => <option key={r} value={r}>{r}</option>)}
              </SelectField>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 8 }}>
              <TextField label={N("dose_text")} value={l.doseText} onChange={(e) => set(i, { doseText: e.target.value })} data-testid="line-dose" />
              <TextField label={`${N("dose_qty")}${m ? ` (${m.issueUnit})` : ""}`} value={l.qtyText} onChange={(e) => set(i, { qtyText: e.target.value.replace(/\D/g, "") })} inputMode="numeric" data-testid="line-qty" />
            </div>
            <label className="t-small" style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={l.prn} onChange={(e) => set(i, { prn: e.target.checked })} data-testid="line-prn" /> {N("prn")}</label>
            {l.prn ? <TextField label={N("prn_max")} value={l.maxText} onChange={(e) => set(i, { maxText: e.target.value.replace(/\D/g, "") })} inputMode="numeric" data-testid="line-prn-max" />
              : <TextField label={N("times")} value={l.timesText} onChange={(e) => set(i, { timesText: e.target.value })} placeholder="08:00, 20:00" data-testid="line-times" />}
            {problems[i]!.length > 0 && l.medicineKey && <span className="t-small" style={{ color: "var(--warning-fg)" }} data-line-problems={problems[i]!.join(",")}>{problems[i]!.join(" · ")}</span>}
            {warn.map((b, j) => {
              const w = b.warning!;
              return (
                <div key={j} className="t-small" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", color: "var(--danger-fg)" }} data-sign-warning={w.kind}>
                  {w.kind === "allergy" ? N("blocker_allergy", { drug: m?.brand ?? l.medicineKey, allergy: s.lang === "bn" ? w.allergy?.labelBn ?? "" : w.allergy?.labelEn ?? "" })
                    : w.kind === "interaction" ? `${m?.brand ?? l.medicineKey}: ${s.L(w.textBn ?? "", w.textEn ?? "")}` : N("blocker_rx", { drug: m?.brand ?? l.medicineKey, kind: w.kind })}
                  {w.kind === "same-medicine" && <label><input type="checkbox" checked={Boolean(l.keepBoth)} onChange={(e) => set(i, { keepBoth: e.target.checked })} /> {N("keep_both")}</label>}
                  {(w.kind === "interaction" || w.kind === "same-class") && <label><input type="checkbox" checked={(l.acks ?? []).includes(w.ruleId ?? w.kind)} onChange={(e) => set(i, { acks: e.target.checked ? [...(l.acks ?? []), w.ruleId ?? w.kind] : (l.acks ?? []).filter((x) => x !== (w.ruleId ?? w.kind)) })} /> {N("acknowledge")}</label>}
                </div>
              );
            })}
            <div><Button size="sm" icon="trash-2" onClick={() => setLines(lines.filter((_, j) => j !== i))}>{N("remove")}</Button></div>
          </div>
        );
      })}
      <div><Button size="sm" icon="plus" onClick={() => setLines([...lines, toLine({ medicineKey: "", route: "", doseText: "", doseQty: null, times: [], prn: false, prnMaxPer24h: null })])} data-testid="add-line">{N("add_order")}</Button></div>
      {signBlockers.filter((b) => !b.warning).map((b, i) => <Callout key={i} tone="warn" icon="triangle-alert" data-sign-blocker={b.code}>{N(`blocker_${b.code}`)}</Callout>)}
      {msg && <Callout tone="warn" icon="triangle-alert" data-testid="round-error">{msg}</Callout>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button icon="save" disabled={busy || !linesOk || !s.online} onClick={() => void save().then((ok) => ok && toast(N("save_draft"), "save"))} data-testid="save-round">{N("save_draft")}</Button>
        <Button variant="primary" icon="pen-line" disabled={busy || !linesOk || !noteOk || !s.online} onClick={() => void save().then((ok) => { if (ok) setSigning(true); })} data-testid="sign-round">{N("sign_round")}</Button>
        {!noteOk && <span className="t-small t-muted">{N("blocker_assessment_or_plan")}</span>}
      </div>
      {signing && (
        <PinSheet title={N("sign_round")} action={N("sign")} onClose={() => setSigning(false)} submit={async (pin) => {
          try {
            const nv = await ward.signRound(draft.id, { rev: rev.current, pin }, signKey.current);
            setSigning(false); setSignBlockers([]); onChanged(nv); toast(N("sign_round"), "badge-check");
          } catch (e) {
            signKey.current = crypto.randomUUID();
            if (e instanceof ApiFailure && e.body.code === "sign_blocked") { setSigning(false); setSignBlockers((e.body as unknown as { blockers: typeof signBlockers }).blockers ?? []); setMsg(err(e)); return; }
            throw e;
          }
        }} />
      )}
    </Card>
  );
}
