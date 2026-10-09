"use client";
/* D1 — onboarding: language → phone → the SMS code → the three privacy points (draft until the lawyer's terms). */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "@setu/domain";
import { Icon, Pill } from "@setu/ui";
import { patient } from "../../lib/api";
import { StagingBanner } from "../../components/Shell";
import { errText, useLang } from "../../lib/lang";

const RESEND_SECONDS = 45;

export default function Welcome() {
  const router = useRouter();
  const { lang, setLang, T, n } = useLang();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [phoneRaw, setPhoneRaw] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [online, setOnline] = useState(true);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const on = () => setOnline(navigator.onLine); on();
    addEventListener("online", on); addEventListener("offline", on);
    return () => { removeEventListener("online", on); removeEventListener("offline", on); };
  }, []);
  useEffect(() => { if (wait <= 0) return; const id = setTimeout(() => setWait(wait - 1), 1000); return () => clearTimeout(id); }, [wait]);

  const ph = format.phone(phoneRaw);
  const phone01 = "0" + ph.digits;

  const send = async () => {
    if (!ph.valid) { setError(T("phone_bad")); return; }
    setBusy(true); setError(null);
    try { await patient.otp(phone01, lang); setSent(true); setWait(RESEND_SECONDS); setTimeout(() => codeRef.current?.focus(), 0); }
    catch (e) { setError(errText(lang, e, T)); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setError(null);
    try { await patient.signIn(phone01, code); setStep(2); }
    catch (e) { setError(errText(lang, e, T)); setCode(""); }
    finally { setBusy(false); }
  };
  const pick = (l: "bn" | "en") => { setLang(l); setStep(1); };

  return (
    <div className="pa">
      <StagingBanner />
      <main className="pa-main" style={{ paddingTop: 32 }}>
        {step === 0 && <>
          <h1 className="pa-h1">{T("welcome")}</h1>
          <p className="pa-sub">{T("welcome_sub")}</p>
          <span className="pa-label">{T("choose_lang")}</span>
          <div className="pa-lang">
            <button type="button" className="pa-btn pa-btn-primary" onClick={() => pick("bn")}>বাংলা</button>
            <button type="button" className="pa-btn" onClick={() => pick("en")}>English</button>
          </div>
        </>}

        {step === 1 && <>
          <h1 className="pa-h1">{T("phone_label")}</h1>
          <label className="pa-label" htmlFor="phone">{T("phone_label")}</label>
          <input id="phone" className="pa-input" inputMode="tel" autoComplete="tel" placeholder="01XXXXXXXXX" value={phoneRaw} disabled={sent}
            aria-invalid={error && !sent ? "true" : undefined} onChange={(e) => { setPhoneRaw(e.target.value); setError(null); }} />
          {sent && <>
            <span className="pa-sub">{T("code_sent")}</span>
            <label className="pa-label" htmlFor="otp">{T("code_label")}</label>
            <input id="otp" ref={codeRef} className="pa-input" inputMode="numeric" autoComplete="one-time-code" value={n(code)} aria-label="OTP"
              onChange={(e) => { setCode(format.toEn(e.target.value).replace(/\D/g, "").slice(0, 6)); setError(null); }} />
          </>}
          {/* staging only (ADR 0021): no real SMS there — the tester reads the code the fake gateway "sent" */}
          {sent && process.env.NEXT_PUBLIC_SETU_STAGE === "staging" && (
            <button type="button" className="pa-btn pa-btn-link" onClick={() => fetch(`/api/v1/dev/patient-otp?phone=${phone01}`).then((r) => r.json()).then((j: { code?: string }) => j.code && setCode(j.code)).catch(() => {})}>{T("staging_code")}</button>
          )}
          {error && <span className="pa-err" role="alert"><Icon name="circle-x" size={16} />{error}</span>}
          {!online ? <button type="button" className="pa-btn" disabled>{T("offline_need_net")}</button>
            : !sent ? <button type="button" className="pa-btn pa-btn-primary" disabled={busy} onClick={send}>{T("send_code")}</button>
            : <button type="button" className="pa-btn pa-btn-primary" disabled={busy || code.length !== 6} onClick={verify}>{code.length === 6 ? T("continue") : T("type_6")}</button>}
          {sent && <div className="pa-row">
            <button type="button" className="pa-btn pa-btn-link" onClick={() => { setSent(false); setCode(""); setError(null); }}>{T("change_number")}</button>
            {wait > 0 ? <span className="pa-note" style={{ alignSelf: "center" }}>{T("resend_in", { s: n(wait) })}</span>
              : <button type="button" className="pa-btn pa-btn-link" disabled={busy || !online} onClick={send}>{T("resend")}</button>}
          </div>}
        </>}

        {step === 2 && <>
          <h1 className="pa-h1">{T("privacy_title")}</h1>
          <span><Pill tone="draft" icon="file-pen">{T("privacy_draft")}</Pill></span>
          {([["lock", 1], ["share-2", 2], ["eye", 3]] as const).map(([icon, i]) => (
            <div key={i} className="pa-card pa-privacy">
              <Icon name={icon} size={22} style={{ color: "var(--brand-primary)", marginTop: 2 }} />
              <div><b>{T(`privacy_${i}_t`)}</b><span className="pa-sub">{T(`privacy_${i}_d`)}</span></div>
            </div>
          ))}
          <button type="button" className="pa-btn pa-btn-primary" onClick={() => router.replace("/")}>{T("privacy_ok")}</button>
        </>}
      </main>
    </div>
  );
}
