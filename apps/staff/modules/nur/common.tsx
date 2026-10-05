"use client";
/* Shared by the ward screens (ADR 0015): strings, the error text, the banner for an inpatient (bed and allergies), the
   ward remembered on this device, a PIN sheet for signing / stopping / issuing, and the NEWS2 pill. */
import { useEffect, useRef, useState } from "react";
import type { AllergyView, News2, PatientSummary } from "@setu/contracts";
import { format } from "@setu/domain";
import { fill } from "@setu/i18n";
import { Button, Callout, Dialog, Pill, TextField, type BannerPatient } from "@setu/ui";
import { ApiFailure, ward } from "../../lib/api";
import { useSession } from "../../lib/session";
import { toBanner, useLabels } from "../fd/common";

export function useN() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) =>
    fill(s.t("nurApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}
export function useErr() {
  const s = useSession(); const N = useN();
  return (e: unknown) => (e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : N("error_generic"));
}
export const hhmm = (iso: string | null | undefined, bn: boolean) => (iso ? format.time(iso, bn) : "—");

/** The shell banner for a patient on the ward: location = ward · bed; allergies from the view ([] = none known). */
export function useWardBanner(p: PatientSummary | null | undefined, allergies: AllergyView[] | null | undefined, location: string | null | undefined) {
  const s = useSession(); const L = useLabels();
  useEffect(() => {
    if (!p) { s.setPatient(null); return; }
    const b: BannerPatient = { ...toBanner(p, `${L.age(p)} ${L.sex(p.sex)}`), location: location ?? undefined, allergies: allergies ? allergies.filter((a) => a.status === "active").map((a) => (s.lang === "bn" ? a.labelBn : a.labelEn)) : null };
    s.setPatient(b);
  }, [p?.id, allergies?.length, location, s.lang, s.numerals]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => s.setPatient(null), []); // eslint-disable-line react-hooks/exhaustive-deps
}

const WARD_KEY = "setu.ward";
/** The ward this nurse works on, remembered on this device (a convenience — the board works without it). */
export function rememberedWard(): string | null { try { return localStorage.getItem(WARD_KEY); } catch { return null; } }
export function rememberWard(id: string) { try { localStorage.setItem(WARD_KEY, id); } catch { /* private window */ } }

export function News2Pill({ n }: { n: News2 | null | undefined }) {
  const N = useN();
  if (!n) return <span data-news2="none"><Pill tone="neu" icon="circle-dashed">{N("news2_none")}</Pill></span>;
  const tone = n.risk === "high" ? "crit" : n.risk === "medium" ? "bad" : n.risk === "low-medium" ? "warn" : "ok";
  return <span data-news2={n.total} data-news2-red={n.red ? "1" : "0"}><Pill tone={tone} icon="activity">{N("news2_n", { n: n.total })}{n.red ? " · 3" : ""}</Pill></span>;
}

/** A 4-digit PIN sheet; `submit` throws ApiFailure on a wrong PIN (pin_wrong with triesLeft / pin_locked). */
export function PinSheet({ title, label, action, icon = "pen-line", onClose, submit }: { title: string; label?: string; action: string; icon?: string; onClose: () => void; submit: (pin: string) => Promise<void> }) {
  const s = useSession(); const N = useN(); const err = useErr();
  const [pin, setPin] = useState(""); const [waiting, setWaiting] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const ref = useRef(false);
  const ok = /^\d{4}$/.test(format.toEn(pin)) && s.online && !waiting;
  const go = async () => {
    if (!ok || ref.current) return;
    ref.current = true; setWaiting(true); setMsg(null);
    try { await submit(format.toEn(pin)); }
    catch (e) {
      setPin("");
      const b = (e instanceof ApiFailure ? e.body : {}) as { code?: string; triesLeft?: number };
      setMsg(b.code === "pin_wrong" || b.code === "witness_pin_wrong" ? N("pin_wrong", { n: b.triesLeft ?? 0 }) : err(e));
    } finally { ref.current = false; setWaiting(false); }
  };
  return (
    <Dialog open onClose={() => { if (!waiting) onClose(); }} label={title} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }} data-testid="pin-sheet">
        <b>{title}</b>
        <TextField label={label ?? N("pin_label")} value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" type="password" maxLength={4} autoFocus name="pin" data-testid="pin" onKeyDown={(e) => { if (e.key === "Enter") void go(); }} />
        {msg && <Callout tone="warn" icon="triangle-alert" data-testid="pin-error">{msg}</Callout>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button onClick={onClose} disabled={waiting}>{N("cancel")}</Button>
          <Button variant="primary" icon={icon} disabled={!ok} onClick={() => void go()} data-testid="pin-submit">{waiting ? N("recording") : action}</Button>
        </div>
      </div>
    </Dialog>
  );
}
export { useLabels };

/** When a ward screen opens without a patient: the beds of the remembered ward, one tap to pick. */
export function WardPatientPicker({ screen, title }: { screen: string; title: string }) {
  const s = useSession(); const N = useN(); const err = useErr(); const L = useLabels();
  const [beds, setBeds] = useState<import("@setu/contracts").WardBoardBed[] | null>(null); const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const w = await ward.wards();
        const id = w.wards.find((x) => x.id === rememberedWard())?.id ?? w.wards.find((x) => x.occupied > 0)?.id;
        setBeds(id ? (await ward.board(id)).beds.filter((b) => b.patient && b.encounterId) : []);
      } catch (e) { setMsg(err(e)); }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (msg) return <Callout tone="warn" icon="triangle-alert">{msg}</Callout>;
  if (!beds) return <div aria-busy="true" className="t-muted">{N("loading")}</div>;
  return (
    <div data-screen={screen} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 className="t-h2" style={{ margin: 0 }}>{title}</h1>
      <span className="t-small t-muted">{N("pick_patient")}</span>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
        {beds.map((b) => (
          <a key={b.bed.id} className="card" href={`/m/${screen}?enc=${encodeURIComponent(b.encounterId!)}`} data-pick-bed={b.bed.name} style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4, textDecoration: "none", color: "inherit" }}>
            <b className="num">{b.bed.name}</b>
            <span>{s.lang === "bn" ? b.patient!.nameBn : b.patient!.nameEn || b.patient!.nameBn}</span>
            <span className="t-small t-muted num">{b.patient!.facilityNo} · {L.age(b.patient!)} {L.sex(b.patient!.sex)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
