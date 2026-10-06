"use client";
/* Shared by the ward screens (ADR 0015): strings, the error text, the banner for an inpatient (bed and allergies), the
   ward remembered on this device, a PIN sheet for signing / stopping / issuing, and the NEWS2 pill. */
import { useEffect, useRef, useState } from "react";
import type { AllergyView, BatchLabels, News2, PatientSummary, WristbandView } from "@setu/contracts";
import { format, normaliseScan } from "@setu/domain";
import { fill } from "@setu/i18n";
import { Button, Callout, Dialog, Pill, TextField, useToast, type BannerPatient } from "@setu/ui";
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

/* ───── ADR 0016: scans and prints ───── */
type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
/** A scan field: a keyboard-wedge scanner types the code and presses Enter; or the camera (BarcodeDetector) where the
    tablet has it. `state` shows what the server will check (the field never claims a match on its own). */
export function ScanField({ label, value, onScan, testId, disabled, focus, autoFocus }: { label: string; value: string; onScan: (code: string) => void; testId: string; disabled?: boolean; /** bump to move the cursor here */ focus?: number; autoFocus?: boolean }) {
  const N = useN();
  const [text, setText] = useState(""); const [cam, setCam] = useState(false); const [camMsg, setCamMsg] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement | null>(null); const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (focus) box.current?.querySelector("input")?.focus(); }, [focus]);
  const can = typeof window !== "undefined" && "BarcodeDetector" in window;
  useEffect(() => {
    if (!cam) return;
    let stop = false; let stream: MediaStream | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!video.current) return;
        video.current.srcObject = stream; await video.current.play();
        const det = new (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => Detector }).BarcodeDetector({ formats: ["qr_code"] });
        while (!stop) {
          const hits = await det.detect(video.current).catch(() => []);
          if (hits[0]?.rawValue) { onScan(hits[0].rawValue); setCam(false); break; }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch { setCamMsg(N("scan_not_supported")); setCam(false); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [cam]); // eslint-disable-line react-hooks/exhaustive-deps
  if (value) return (
    <span className="t-small" style={{ display: "flex", gap: 8, alignItems: "center" }} data-testid={testId} data-scanned="1">
      <Pill tone="info" icon="scan-line">{label}: {N("scan_scanned")}</Pill>
      <Button size="sm" onClick={() => onScan("")} disabled={disabled}>{N("scan_clear")}</Button>
    </span>
  );
  return (
    <div ref={box} style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid={testId} data-scanned="0">
      <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
        <TextField label={label} value={text} hint={N("scan_hint")} autoComplete="off" disabled={disabled} name={testId}
          autoFocus={autoFocus}
          // codes are digits only: a wedge under a Bangla layout types Bangla digits — read back as Latin (decision 253)
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && normaliseScan(text)) { e.preventDefault(); onScan(normaliseScan(text)); setText(""); } }} data-testid={`${testId}-input`} />
        {can && <Button size="sm" icon="camera" onClick={() => setCam(true)} disabled={disabled}>{N("scan_camera")}</Button>}
      </div>
      {cam && <video ref={video} muted playsInline style={{ width: 240, borderRadius: 8 }} />}
      {camMsg && <span className="t-small t-muted">{camMsg}</span>}
    </div>
  );
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** A print window opened on the click itself (a window opened after awaiting the server is blocked as a pop-up). */
export const openPrintWindow = () => window.open("", "_blank", "width=480,height=640");
/** Prints in a window of its own (the app's styles never reach the label printer). */
export function printHtml(w: Window | null, title: string, body: string): boolean {
  if (!w || w.closed) return false;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body{font-family:system-ui,"Noto Sans Bengali",sans-serif;margin:8px} .band{display:flex;gap:10px;align-items:center;border:1px solid #000;padding:6px;width:250mm;max-width:100%}
    .band svg,.label svg{width:22mm;height:22mm} .label{display:inline-flex;gap:6px;align-items:center;border:1px dashed #000;padding:4px;margin:3px;width:60mm} b{font-size:13px} small{font-size:10px}
    @page{margin:4mm}</style></head><body>${body}<script>window.onload=()=>{window.print()}</script></body></html>`);
  w.document.close();
  return true;
}
export function wristbandHtml(v: WristbandView, t: { allergy: string; nkda: string }) {
  return `<div class="band">${v.qrSvg}<div><b>${esc(v.patient.nameBn)} · ${esc(v.patient.nameEn ?? "")}</b><br><small>${esc(v.patient.facilityNo)} · ${esc(v.admissionNumber ?? "")} · ${esc(v.ward ?? "")} ${esc(v.bed ?? "")}</small><br><small>${v.allergies.length ? `${esc(t.allergy)}: ${esc(v.allergies.join(", "))}` : esc(t.nkda)}</small></div></div>`;
}
export function labelsHtml(l: BatchLabels, t: { exp: string }) {
  return l.items.map((x) => `<div class="label">${x.qrSvg}<div><b>${esc(x.medicine)}</b><br><small>${esc(x.batchNo)} · ${esc(t.exp)} ${esc(x.expiry)}<br>${esc(x.ward)}</small></div></div>`).join("");
}
/** Print the wristband: the first print needs nothing; a reprint asks why (the server says so). */
export function WristbandButton({ encounterId, size = "sm" }: { encounterId: string; size?: "sm" | "md" }) {
  const s = useSession(); const N = useN(); const err = useErr(); const toast = useToast();
  const [ask, setAsk] = useState(false); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const go = async () => {
    setBusy(true);
    const w = openPrintWindow();
    try {
      const v = await ward.wristband(encounterId, reason.trim() || undefined, key.current); key.current = crypto.randomUUID(); setAsk(false); setReason("");
      if (!printHtml(w, N("wristband"), wristbandHtml(v, { allergy: N("band_allergy"), nkda: N("band_nkda") }))) toast(N("print_blocked"), "printer");
    }
    catch (e) {
      w?.close();
      if (e instanceof ApiFailure) key.current = crypto.randomUUID();
      if (e instanceof ApiFailure && e.body.code === "reason_required") setAsk(true); else toast(err(e), "triangle-alert");
    } finally { setBusy(false); }
  };
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "flex-end", flexWrap: "wrap" }} data-testid="wristband">
      {ask && <TextField label={N("wristband_reprint_reason")} value={reason} onChange={(e) => setReason(e.target.value)} name="wristbandReason" data-testid="wristband-reason" />}
      <Button size={size} icon="printer" disabled={busy || !s.online || (ask && reason.trim().length < 5)} onClick={() => void go()} data-testid="wristband-print">{N("wristband_print")}</Button>
    </span>
  );
}
/** Opens the window on the click, then fills it; false when the browser blocked it. */
export async function printLabels(batchIds: string[], title: string, exp: string): Promise<boolean> {
  if (!batchIds.length) return true;
  const w = openPrintWindow();
  try { return printHtml(w, title, labelsHtml(await ward.labels(batchIds), { exp })); } catch (e) { w?.close(); throw e; }
}

