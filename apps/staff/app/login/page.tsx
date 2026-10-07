"use client";
import { useEffect, useState, type FormEvent, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, TextField, Segmented } from "@setu/ui";
import { api, ApiFailure } from "../../lib/api";
import { useSession } from "../../lib/session";

function LoginInner() {
  const s = useSession(); const router = useRouter(); const q = useSearchParams();
  const [id, setId] = useState(""); const [pw, setPw] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(false); const [plan, setPlan] = useState<"clinic" | "lite" | "pro">("pro");
  useEffect(() => { api.health().then((h) => setDemo(h.db === "skipped")).catch(() => {}); }, []);
  const L = s.L;
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api.login(id, pw, demo ? plan : undefined); await s.refresh(); router.replace(q.get("next") || "/"); }
    catch (x) { setErr(x instanceof ApiFailure ? (s.lang === "bn" ? x.body.message_bn : x.body.message_en) : L("সার্ভারে পৌঁছানো যায়নি", "Could not reach the server")); }
    finally { setBusy(false); }
  }
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--surface-sunken)", padding: 16 }}>
      <form onSubmit={submit} className="card" style={{ width: 400, maxWidth: "100%", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className="shell-brand" style={{ padding: 0 }}>Setu</span>
          <Segmented value={s.lang} onChange={s.setLang} options={[{ value: "bn", label: "বাং" }, { value: "en", label: "EN" }]} label="Language" />
        </div>
        <div><h1 className="t-h2">{L("স্টাফ লগইন", "Staff sign in")}</h1><p className="t-small t-muted" style={{ margin: "4px 0 0" }}>{L("আপনার প্রতিষ্ঠানের দেওয়া ফোন নম্বর বা ইমেইল", "The phone number or email your facility gave you")}</p></div>
        {q.get("ended") && <div className="callout callout-warn" data-testid="session-ended">{L("আপনার সেশন শেষ হয়েছে (অ্যাকাউন্ট বন্ধ, ভূমিকা বা পাসওয়ার্ড বদলেছে) — আবার লগইন করুন", "Your session has ended (account switched off, role or password changed) — sign in again")}</div>}
        <TextField label={L("ফোন বা ইমেইল", "Phone or email")} name="identifier" autoComplete="username" value={id} onChange={(e) => setId(e.target.value)} required autoFocus />
        <TextField label={L("পাসওয়ার্ড", "Password")} name="password" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required error={err ?? undefined} />
        <Button variant="primary" size="lg" type="submit" disabled={busy} icon="log-in">{busy ? L("লগইন হচ্ছে…", "Signing in…") : L("লগইন", "Sign in")}</Button>
        {demo && (
          <div className="callout callout-warn" style={{ flexDirection: "column", gap: 8 }}>
            <span>{L("ডেমো মোড (ডাটাবেস নেই): ফোন 01711000001–10 · পাসওয়ার্ড setu1234 · PIN 1234", "Demo mode (no database): phone 01711000001–10 · password setu1234 · PIN 1234")}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="t-small">{L("প্ল্যান", "Plan")}</span><Segmented value={plan} onChange={setPlan} options={[{ value: "clinic", label: "Clinic" }, { value: "lite", label: "Hospital Lite" }, { value: "pro", label: "Hospital Pro" }]} label="Demo plan" /></span>
          </div>
        )}
      </form>
    </main>
  );
}

/* A production build pre-renders the page: useSearchParams() needs a Suspense boundary (staging build, week 2). */
export default function Login() {
  return <Suspense fallback={null}><LoginInner /></Suspense>;
}
