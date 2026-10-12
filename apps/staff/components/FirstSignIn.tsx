"use client";
/* ADR 0010: the first sign-in with a one-time password. Until the user sets their own password and PIN the server
   answers nothing else, so the shell shows only this. The rules (8+ characters with a letter and a digit, not the phone
   number; a 4-digit PIN that is not 1111 / 1234) are the server's; the screen says them up front. */
import { useState } from "react";
import { AuthLayout, Button, Callout, TextField } from "@setu/ui";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { useA, useErr } from "../modules/adm/common";

export function FirstSignIn() {
  const s = useSession(); const A = useA(); const E = useErr();
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState(""); const [pin, setPin] = useState(""); const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const mismatch = (pw2 && pw !== pw2) || (pin2 && pin !== pin2);
  const ready = pw.length >= 8 && pw === pw2 && /^\d{4}$/.test(pin) && pin === pin2;
  const L = (key: string) => s.t("loginApp", key);
  return (
    <div data-screen="first-sign-in">
      <AuthLayout
        headline={L("brand_headline")} lead={L("brand_lead")}
        points={[{ icon: "languages", title: L("pt1_title"), text: L("pt1_text") }, { icon: "activity", title: L("pt2_title"), text: L("pt2_text") }, { icon: "shield-check", title: L("pt3_title"), text: L("pt3_text") }]}
        foot={<><span>{L("brand_foot_left")}</span><span>{L("brand_foot_right")}</span></>}>
        <form className="ck-auth-card"
          onSubmit={async (e) => { e.preventDefault(); if (!ready || busy) return; setBusy(true); setError(null); try { await api.firstSignIn(pw, pin); await s.refresh(); } catch (x) { setError(E(x)); } finally { setBusy(false); } }}>
          <span className="t-label" style={{ color: "var(--brand-primary-text)", textTransform: "none" }}>{L("first_kicker")}</span>
          <h2 style={{ marginTop: -10 }}>{A("first_title", { name: s.me ? (s.lang === "bn" ? s.me.nameBn : s.me.nameEn) : "" })}</h2>
          <p className="ck-auth-sub">{A("first_sub")}</p>
          <TextField label={A("new_password")} hint={A("password_rule")} type="password" autoComplete="new-password" name="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <TextField label={A("repeat_password")} type="password" autoComplete="new-password" name="repeat-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
            <TextField label={A("new_pin")} hint={A("pin_rule")} type="password" inputMode="numeric" autoComplete="off" name="new-pin" value={pin} onChange={(e) => setPin(e.target.value)} />
            <TextField label={A("repeat_pin")} type="password" inputMode="numeric" autoComplete="off" name="repeat-pin" value={pin2} onChange={(e) => setPin2(e.target.value)} />
          </div>
          {mismatch && <Callout tone="warn" icon="triangle-alert">{A("not_same")}</Callout>}
          {error && <Callout tone="bad" icon="triangle-alert" data-testid="first-error">{error}</Callout>}
          <Button variant="primary" size="lg" type="submit" icon="key-round" disabled={!ready || busy || !s.online} data-testid="first-save">{busy ? A("saving") : A("first_save")}</Button>
          <Button type="button" variant="ghost" icon="log-out" onClick={() => void s.logout(true)}>{A("sign_out")}</Button>
        </form>
      </AuthLayout>
    </div>
  );
}
