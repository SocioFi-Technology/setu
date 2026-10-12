"use client";
/* D2 — claiming a facility's records: the facility and the month only, "This is mine" / "Not mine", then a proof —
   the code printed on the receipt or prescription, or the reception desk. 3 wrong codes lock it for 24 hours.
   ADR 0024: the desk shows a desk code here (kept on this phone only — the server has its hash); the claim QR printed
   beside the code is scanned in the app (the phone's own barcode reader) or opens this page from the phone's camera
   (?t=<facility>&c=<code>) — only Setu's claim QR is read, never a document's verify QR. */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ClaimItem, ClaimProofResponse } from "@setu/contracts";
import { format } from "@setu/domain";
import { Icon, Pill, Segmented } from "@setu/ui";
import { Shell } from "../../components/Shell";
import { patient } from "../../lib/api";
import { errText, monthLabel, useLang } from "../../lib/lang";

/** the desk code shown at the reception lives on this phone only (the server keeps its hash) */
const DESK_KEY = (claimId: string) => `setu.deskcode.${claimId}`;
const storeDesk = (r: ClaimProofResponse) => { try { if (r.deskCode) localStorage.setItem(DESK_KEY(r.claim.id), r.deskCode); } catch {} };
const readDesk = (claimId: string) => { try { return localStorage.getItem(DESK_KEY(claimId)); } catch { return null; } };
/** a claim QR opened from the phone's camera survives the sign-in (home sends the person back here) */
const QR_KEY = "setu.claimqr";

export default function ClaimPage() {
  const { lang, T } = useLang();
  const [items, setItems] = useState<ClaimItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const load = useCallback(() => patient.claims().then((r) => { setItems(r.items); setError(null); }).catch((e) => setError(errText(lang, e, T))), [lang, T]);
  useEffect(() => {
    // the claim QR's link (?t=&c=) — kept until used, so a sign-in in between does not lose it
    const here = new URL(location.href);
    if (here.searchParams.get("c")) { try { sessionStorage.setItem(QR_KEY, here.href); } catch {} }
    try { setQr(sessionStorage.getItem(QR_KEY)); } catch {}
    void load();
  }, [load]);
  const put = (c: ClaimItem) => setItems((xs) => xs?.map((x) => (x.id === c.id ? c : x)) ?? null);
  const applyQr = async () => {
    if (!qr) return;
    setQrBusy(true); setError(null);
    try { const r = await patient.proveQr(qr, crypto.randomUUID()); put(r.claim); } catch (e) { setError(errText(lang, e, T)); }
    finally { try { sessionStorage.removeItem(QR_KEY); } catch {} setQr(null); setQrBusy(false); history.replaceState(null, "", location.pathname); }
  };
  const qrCode = qr ? new URL(qr).searchParams.get("c") : null;
  const anyLinked = items?.some((c) => c.status === "linked");
  return (
    <Shell>
      <h1 className="pa-h2">{T("claim_title")}</h1>
      <div className="pa-why"><b>{T("why_title")}</b>{T("why_body")}</div>
      {qr && qrCode && <section className="pa-card" style={{ borderColor: "var(--brand-primary)" }} data-claim-qr>
        <b>{T("qr_found", { code: `${qrCode.slice(0, 3)}-${qrCode.slice(3)}` })}</b>
        <button type="button" className="pa-btn pa-btn-primary" disabled={qrBusy} onClick={applyQr}><Icon name="scan-line" size={18} />{T("qr_use")}</button>
      </section>}
      {error && <span className="pa-err" role="alert"><Icon name="circle-x" size={16} />{error}</span>}
      {items === null && !error && <p className="pa-sub">{T("loading")}</p>}
      {items?.length === 0 && <p className="pa-sub">{T("claim_none")}</p>}
      {items?.map((c) => <ClaimCard key={c.id} c={c} onChange={put} />)}
      <Link className={"pa-btn" + (anyLinked ? " pa-btn-primary" : "")} href="/timeline">{anyLinked ? T("see_history") : T("later_home")}</Link>
    </Shell>
  );
}

function ClaimCard({ c, onChange }: { c: ClaimItem; onChange: (c: ClaimItem) => void }) {
  const { lang, T, n } = useLang();
  const [open, setOpen] = useState(c.status === "proof-pending" && c.method !== "desk");
  const [method, setMethod] = useState<"code" | "qr" | "desk">(c.method === "desk" ? "desk" : "code");
  const [deskCode, setDeskCode] = useState<string | null>(null);
  useEffect(() => { setDeskCode(readDesk(c.id)); }, [c.id, c.deskCodeUntil]);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const fac = (lang === "bn" ? c.facilityBn ?? c.facilityEn : c.facilityEn ?? c.facilityBn) ?? T("facility_unknown");
  const desk = c.status === "proof-pending" && c.method === "desk";
  const closed = c.status === "linked" || c.status === "not-mine";

  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(errText(lang, e, T)); } finally { setBusy(false); } };
  const submit = () => run(async () => {
    const r = await patient.prove(c.id, { method: "code", code }, crypto.randomUUID());
    onChange(r.claim); setWrong(r.outcome === "wrong-code"); setCode("");
  });
  const toDesk = () => run(async () => { const r = await patient.prove(c.id, { method: "desk" }, crypto.randomUUID()); storeDesk(r); setDeskCode(r.deskCode ?? null); onChange(r.claim); });
  const scanned = (raw: string) => run(async () => { const r = await patient.proveQr(raw, crypto.randomUUID()); onChange(r.claim); setWrong(r.outcome === "wrong-code"); });
  const notMine = () => run(async () => { onChange(await patient.notMine(c.id, crypto.randomUUID())); });

  const pill = c.status === "linked" ? <Pill tone="ok" icon="check">{T("st_linked")}</Pill>
    : c.status === "not-mine" ? <Pill tone="neu" icon="x">{T("st_not_mine")}</Pill>
    : desk ? <Pill tone="pend" icon="clock">{T("st_desk")}</Pill>
    : c.status === "locked" ? <Pill tone="bad" icon="lock">{T("st_locked")}</Pill>
    : <Pill tone="pend" icon="lock">{T("st_proof")}</Pill>;
  const border = c.status === "linked" ? "var(--success-border)" : open || desk ? "var(--brand-primary)" : "var(--border-subtle)";

  return (
    <section className="pa-card" style={{ borderColor: border }} data-claim={c.status} aria-label={fac}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <Icon name="building-2" size={22} style={{ color: "var(--brand-primary)", marginTop: 2 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b style={{ display: "block", font: "600 16px/22px var(--font-sans)" }}>{fac}</b>
          <span className="pa-meta">{T("visit_month", { m: monthLabel(c.lastMonth, T, n) })}</span>
        </div>
        {pill}
      </div>

      {closed && <span className="pa-sub">{c.status === "linked" ? T("linked_body") : T("not_mine_body")}</span>}

      {c.status === "locked" && <div className="pa-lock" role="status">
        <span style={{ display: "flex", gap: 8 }}><Icon name="lock" size={18} />{T("locked_banner")}</span>
        {c.lockedUntil && <span style={{ fontWeight: 400 }}>{T("locked_until", { t: format.dateTime(c.lockedUntil, lang === "bn") })}</span>}
        <span style={{ fontWeight: 400 }}>{T("locked_desk")}</span>
      </div>}

      {desk && <div className="pa-desk" data-desk-code={deskCode ?? ""} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="pa-sub">{T("desk_body")}</span>
        {deskCode ? <>
          <span className="pa-label">{T("desk_code_title")}</span>
          <b className="num" style={{ font: "700 32px/40px var(--font-mono, monospace)", letterSpacing: 4, textAlign: "center" }} aria-label={deskCode.split("").join(" ")}>{deskCode.slice(0, 3)}-{deskCode.slice(3)}</b>
          {c.deskCodeUntil && <span className="pa-meta" style={{ textAlign: "center" }}>{T("desk_code_until", { t: format.dateTime(c.deskCodeUntil, lang === "bn") })}</span>}
        </> : <span className="pa-note">{T("desk_code_lost")}</span>}
        <button type="button" className="pa-btn" disabled={busy} onClick={toDesk}><Icon name="refresh-cw" size={18} />{T("desk_code_new")}</button>
      </div>}

      {c.deskRefused && c.status === "candidate" && <span className="pa-err" role="status"><Icon name="circle-alert" size={16} />{T("desk_refused")}</span>}

      {c.status === "candidate" && !open && <div className="pa-row">
        <button type="button" className="pa-btn pa-btn-primary" disabled={busy} onClick={() => setOpen(true)}>{T("mine")}</button>
        <button type="button" className="pa-btn" disabled={busy} onClick={notMine}>{T("not_mine")}</button>
      </div>}

      {(c.status === "candidate" || (c.status === "proof-pending" && !desk)) && open && <>
        <span className="pa-label">{T("how_prove")}</span>
        <Segmented value={method} onChange={setMethod} label={T("how_prove")} options={[{ value: "code", label: T("m_code") }, { value: "qr", label: T("m_qr") }, { value: "desk", label: T("m_desk") }]} />
        {method === "qr" ? <Scanner onCode={scanned} busy={busy} /> : method === "code" ? <>
          <label className="pa-sub" htmlFor={"code-" + c.id}>{T("code_hint")}</label>
          <input id={"code-" + c.id} className="pa-input" autoCapitalize="characters" autoComplete="off" spellCheck={false} value={code} aria-label={T("claim_code_label")}
            aria-invalid={wrong ? "true" : undefined}
            onChange={(e) => { setCode(format.toEn(e.target.value).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6)); setWrong(false); setError(null); }} />
          {wrong && <span className="pa-err" role="alert"><Icon name="circle-x" size={16} />{T("code_wrong", { n: n(c.triesLeft) })}</span>}
          <span className="pa-note">{T("three_lock")}</span>
          <button type="button" className="pa-btn pa-btn-primary" disabled={busy || code.length !== 6} onClick={submit}>{code.length === 6 ? T("verify") : T("type_6_chars")}</button>
        </> : <>
          <span className="pa-sub">{T("desk_body")}</span>
          <button type="button" className="pa-btn pa-btn-primary" disabled={busy} onClick={toDesk}><Icon name="building-2" size={18} />{T("desk_go")}</button>
        </>}
        {c.status === "candidate" && <button type="button" className="pa-btn pa-btn-link" disabled={busy} onClick={notMine}>{T("not_mine")}</button>}
      </>}

      {error && <span className="pa-err" role="alert"><Icon name="circle-x" size={16} />{error}</span>}
    </section>
  );
}

/* ADR 0024: the claim QR, read by the phone's own barcode reader (Chrome on Android) — no library. Elsewhere the phone's
   camera app opens the QR's link instead, or the patient types the code. */
type Detector = { detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
function Scanner({ onCode, busy }: { onCode: (raw: string) => void; busy: boolean }) {
  const { T } = useLang();
  const video = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [failed, setFailed] = useState(false);
  const supported = typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null, stop = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        const v = video.current!; v.srcObject = stream; await v.play();
        const det = new (window as unknown as { BarcodeDetector: new (o: object) => Detector }).BarcodeDetector({ formats: ["qr_code"] });
        while (!stop) {
          const found = (await det.detect(v)).find((x) => /\/claim\?/.test(x.rawValue));
          if (found) { stop = true; setOn(false); onCode(found.rawValue); break; }
          await new Promise((r) => setTimeout(r, 300));
        }
      } catch { setFailed(true); setOn(false); }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!supported || failed) return <span className="pa-note" data-qr="unsupported">{T("qr_no_camera")}</span>;
  return <>
    <span className="pa-sub">{T("qr_hint")}</span>
    {on ? <video ref={video} muted playsInline style={{ width: "100%", borderRadius: 12, background: "#000" }} /> :
      <button type="button" className="pa-btn pa-btn-primary" disabled={busy} onClick={() => setOn(true)}><Icon name="scan-line" size={18} />{T("qr_start")}</button>}
  </>;
}
