"use client";
/* ADR 0010: the first sign-in with a one-time password. Until the user sets their own password and PIN the server
   answers nothing else, so the shell shows only this. The rules (8+ characters with a letter and a digit, not the phone
   number; a 4-digit PIN that is not 1111 / 1234) are the server's; the screen says them up front. */
import { useState } from "react";
import { Button, Callout, TextField } from "@setu/ui";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { useA, useErr } from "../modules/adm/common";

export function FirstSignIn() {
  const s = useSession(); const A = useA(); const E = useErr();
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState(""); const [pin, setPin] = useState(""); const [pin2, setPin2] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const mismatch = (pw2 && pw !== pw2) || (pin2 && pin !== pin2);
  const ready = pw.length >= 8 && pw === pw2 && /^\d{4}$/.test(pin) && pin === pin2;
  return (
    <div data-screen="first-sign-in" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, background: "var(--surface-sunken)" }}>
      <form className="card" style={{ width: 440, maxWidth: "100%", padding: 24, display: "flex", flexDirection: "column", gap: 14 }}
        onSubmit={async (e) => { e.preventDefault(); if (!ready || busy) return; setBusy(true); setError(null); try { await api.firstSignIn(pw, pin); await s.refresh(); } catch (x) { setError(E(x)); } finally { setBusy(false); } }}>
        <span className="shell-brand" style={{ padding: 0 }}>Setu</span>
        <h1 className="t-h2" style={{ margin: 0 }}>{A("first_title", { name: s.me ? (s.lang === "bn" ? s.me.nameBn : s.me.nameEn) : "" })}</h1>
        <span className="t-small t-secondary">{A("first_sub")}</span>
        <TextField label={A("new_password")} hint={A("password_rule")} type="password" autoComplete="new-password" name="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <TextField label={A("repeat_password")} type="password" autoComplete="new-password" name="repeat-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        <TextField label={A("new_pin")} hint={A("pin_rule")} type="password" inputMode="numeric" autoComplete="off" name="new-pin" value={pin} onChange={(e) => setPin(e.target.value)} />
        <TextField label={A("repeat_pin")} type="password" inputMode="numeric" autoComplete="off" name="repeat-pin" value={pin2} onChange={(e) => setPin2(e.target.value)} />
        {mismatch && <Callout tone="warn" icon="triangle-alert">{A("not_same")}</Callout>}
        {error && <Callout tone="bad" icon="triangle-alert" data-testid="first-error">{error}</Callout>}
        <Button variant="primary" type="submit" icon="key-round" disabled={!ready || busy || !s.online} data-testid="first-save">{busy ? A("saving") : A("first_save")}</Button>
        <Button type="button" variant="ghost" icon="log-out" onClick={() => void s.logout(true)}>{A("sign_out")}</Button>
      </form>
    </div>
  );
}
