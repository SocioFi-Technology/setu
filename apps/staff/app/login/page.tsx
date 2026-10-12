"use client";
/* Staff sign-in (plan 2026-10-13, wave A): the Chartis sign-in layout — the pine brand panel beside the form. */
import { useEffect, useState, type FormEvent, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthLayout, Button, Icon, Segmented } from "@setu/ui";
import { api, ApiFailure } from "../../lib/api";
import { useSession } from "../../lib/session";

function LoginInner() {
  const s = useSession(); const router = useRouter(); const q = useSearchParams();
  const [id, setId] = useState(""); const [pw, setPw] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [demo, setDemo] = useState(false); const [plan, setPlan] = useState<"clinic" | "lite" | "pro">("pro");
  useEffect(() => { api.health().then((h) => setDemo(h.db === "skipped")).catch(() => {}); }, []);
  const L = (key: string) => s.t("loginApp", key);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api.login(id, pw, demo ? plan : undefined); await s.refresh(); router.replace(q.get("next") || "/"); }
    catch (x) { setErr(x instanceof ApiFailure ? (s.lang === "bn" ? x.body.message_bn : x.body.message_en) : L("err_unreachable")); }
    finally { setBusy(false); }
  }
  return (
    <AuthLayout
      headline={L("brand_headline")} lead={L("brand_lead")}
      points={[{ icon: "languages", title: L("pt1_title"), text: L("pt1_text") }, { icon: "activity", title: L("pt2_title"), text: L("pt2_text") }, { icon: "shield-check", title: L("pt3_title"), text: L("pt3_text") }]}
      foot={<><span>{L("brand_foot_left")}</span><span>{L("brand_foot_right")}</span></>}
      top={<Segmented value={s.lang} onChange={s.setLang} options={[{ value: "bn", label: "বাংলা" }, { value: "en", label: "English" }]} label="Language" />}>
      <form onSubmit={submit} className="ck-auth-card">
        <h2>{L("title")}</h2>
        <p className="ck-auth-sub">{L("subtitle")}</p>
        {q.get("ended") && <div className="callout callout-warn" data-testid="session-ended"><Icon name="clock" size={16} style={{ marginTop: 2 }} /><span>{L("session_ended")}</span></div>}
        <div className="field">
          <label htmlFor="identifier">{L("identifier")}</label>
          <input id="identifier" className="input" name="identifier" autoComplete="username" value={id} onChange={(e) => setId(e.target.value)} required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="password">{L("password")}</label>
          <span className="input" style={{ display: "flex", alignItems: "center", padding: "0 6px 0 14px" }} aria-invalid={err ? "true" : undefined}>
            <input id="password" name="password" type={showPw ? "text" : "password"} autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required
              aria-invalid={err ? "true" : undefined} aria-describedby={err ? "password-err" : undefined}
              style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: "transparent", font: "inherit", color: "inherit" }} />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowPw((v) => !v)} aria-pressed={showPw}>{showPw ? L("hide_pw") : L("show_pw")}</button>
          </span>
          {err && <span id="password-err" className="field-error" role="alert">{err}</span>}
        </div>
        <Button variant="primary" size="lg" type="submit" disabled={busy} icon="log-in">{busy ? L("signing_in") : L("sign_in")}</Button>
        <div className="ck-auth-note"><Icon name="shield-check" size={18} /><span>{L("privacy_note")}</span></div>
        {demo && (
          <div className="callout callout-warn" style={{ flexDirection: "column", gap: 8 }}>
            <span>{L("demo_note")}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="t-small">{L("demo_plan")}</span><Segmented value={plan} onChange={setPlan} options={[{ value: "clinic", label: "Clinic" }, { value: "lite", label: "Lite" }, { value: "pro", label: "Pro" }]} label="Demo plan" /></span>
          </div>
        )}
      </form>
    </AuthLayout>
  );
}

/* A production build pre-renders the page: useSearchParams() needs a Suspense boundary (staging build, week 2). */
export default function Login() {
  return <Suspense fallback={null}><LoginInner /></Suspense>;
}
