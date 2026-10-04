"use client";
/* adm/users — journey G2 (ADR 0010). Ported from docs/prototype/Setu Admin.dc.html ("Users & roles"): everyone with a
   role at this facility — role, status (active / switched off / first sign-in pending), BMDC / BNMC registration and
   last sign-in. Add a user → the one-time password is shown once (copy it now; it is never shown again). Per user:
   change role, verify the registration, reset the password (a new one-time password), switch off with a reason or
   back on. The server refuses yourself, an owner unless you are one, and the last owner / admin; the screen says why.
   Writes keep their Idempotency-Key until they succeed (a refusal stores nothing). */
import { useCallback, useEffect, useState } from "react";
import type { UserCredentialResponse, UserList, UserView } from "@setu/contracts";
import { Button, Callout, Card, Dialog, PageState, Pill, SelectField, TextArea, TextField, useToast, type Tone } from "@setu/ui";
import { adm } from "../../lib/api";
import { useSession } from "../../lib/session";
import { renewKey, useA, useErr, useFmt } from "./common";

const ROLES = ["receptionist", "doctor", "nurse", "labTech", "pathologist", "pharmacist", "cashier", "admin", "owner"] as const;
const NEEDS_REG: Record<string, "BMDC" | "BNMC"> = { doctor: "BMDC", pathologist: "BMDC", nurse: "BNMC" };

export function AdmUsers() {
  const s = useSession(); const A = useA(); const F = useFmt(); const E = useErr(); const toast = useToast();
  const [list, setList] = useState<UserList | null>(null); const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false); const [open, setOpen] = useState<UserView | null>(null);
  const [credential, setCredential] = useState<UserCredentialResponse | null>(null);
  const load = useCallback(async () => { try { setList(await adm.users()); } catch { setFailed(true); } }, []);
  useEffect(() => { void load(); s.setPatient(null); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <PageState icon="users" title={A("error_generic")} />;
  if (!list) return <div aria-busy="true" className="t-muted">{A("loading")}</div>;
  const changed = async (u?: UserView) => { await load(); if (u) setOpen(u); };

  return (
    <div data-screen="adm/users" style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="t-h2" style={{ margin: 0 }}>{A("users_title")}</h1>
        <span className="t-small t-secondary">{A("users_count", { n: list.items.filter((u) => u.active).length, approvers: list.activeApprovers })}</span>
        <span style={{ marginLeft: "auto" }} />
        <Button variant="primary" icon="user-plus" data-testid="add-user" disabled={!s.online} onClick={() => setAdding(true)}>{A("add_user")}</Button>
      </div>
      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table className="table" style={{ width: "100%" }} data-testid="user-list">
          <thead><tr><th>{A("name")}</th><th>{A("phone")}</th><th>{A("role")}</th><th>{A("status")}</th><th>{A("registration")}</th><th>{A("last_sign_in")}</th><th /></tr></thead>
          <tbody>
            {list.items.map((u) => (
              <tr key={u.id} data-user={u.id} data-phone={u.phone ?? ""} data-active={u.active ? "1" : "0"}>
                <td><b>{F.name(u)}</b>{u.id === s.me?.userId && <span className="t-small t-muted"> · {A("you")}</span>}</td>
                <td className="num">{F.n(u.phone ?? "—")}</td>
                <td>{A(`role_${u.role}`)}</td>
                <td><UserStatus u={u} /></td>
                <td>{u.registration ? <RegPill r={u.registration} /> : <span className="t-small t-muted">—</span>}</td>
                <td className="num t-small">{F.dateTime(u.lastLoginAt)}</td>
                <td><Button size="sm" icon="settings-2" data-testid="manage" onClick={() => setOpen(u)}>{A("manage")}</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Dialog open={adding} onClose={() => setAdding(false)} label={A("add_user")} width={520}>
        <AddUser onDone={async (c) => { setAdding(false); setCredential(c); await load(); }} />
      </Dialog>
      <Dialog open={!!credential} onClose={() => setCredential(null)} label={A("otp_title")} width={480}>
        {credential && <Credential c={credential} onClose={() => setCredential(null)} />}
      </Dialog>
      <Dialog open={!!open} onClose={() => setOpen(null)} label={open ? F.name(open) : ""} width={560}>
        {open && <Manage key={`${open.id}:${open.active}:${open.role}`} u={open} onChanged={changed} onCredential={(c) => { setOpen(null); setCredential(c); void load(); }} onError={(e) => toast(E(e), "triangle-alert")} />}
      </Dialog>
    </div>
  );
}

function UserStatus({ u }: { u: UserView }) {
  const A = useA();
  if (!u.active) return <Pill tone="off" icon="user-x">{A("st_off")}</Pill>;
  if (u.firstSignInPending) return <Pill tone="warn" icon="key-round">{A("st_first")}</Pill>;
  return <Pill tone="ok" icon="check">{A("st_active")}</Pill>;
}
function RegPill({ r }: { r: NonNullable<UserView["registration"]> }) {
  const A = useA(); const F = useFmt();
  const tone: Tone = r.verified ? "ok" : r.number ? "warn" : "pend";
  return <span data-reg={r.verified ? "verified" : "unverified"}><Pill tone={tone} icon={r.verified ? "badge-check" : "badge-alert"}>{r.body} {r.number ? F.n(r.number) : A("reg_missing")} · {r.verified ? A("reg_verified") : A("reg_unverified")}</Pill></span>;
}

function AddUser({ onDone }: { onDone: (c: UserCredentialResponse) => Promise<void> }) {
  const s = useSession(); const A = useA(); const E = useErr();
  const [v, setV] = useState({ nameBn: "", nameEn: "", phone: "", role: "receptionist", regNo: "" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [key, setKey] = useState(() => crypto.randomUUID());
  const reg = NEEDS_REG[v.role];
  const ok = v.nameBn.trim().length >= 2 && v.nameEn.trim().length >= 2 && /^01[3-9]\d{8}$/.test(v.phone.trim()) && (!reg || v.regNo.trim().length > 0);
  return (
    <form style={{ display: "flex", flexDirection: "column", gap: 10 }} onSubmit={async (e) => {
      e.preventDefault(); if (!ok || busy) return; setBusy(true); setError(null);
      try { const c = await adm.createUser({ nameBn: v.nameBn.trim(), nameEn: v.nameEn.trim(), phone: v.phone.trim(), role: v.role as UserView["role"], ...(reg ? { regNo: v.regNo.trim() } : {}) }, key); setKey(crypto.randomUUID()); await onDone(c); }
      catch (x) { if (renewKey(x)) setKey(crypto.randomUUID()); setError(E(x)); } finally { setBusy(false); }
    }}>
      <TextField label={A("name_bn")} value={v.nameBn} onChange={(e) => setV({ ...v, nameBn: e.target.value })} data-testid="new-name-bn" />
      <TextField label={A("name_en")} value={v.nameEn} onChange={(e) => setV({ ...v, nameEn: e.target.value })} data-testid="new-name-en" />
      <TextField label={A("phone")} hint={A("phone_hint")} inputMode="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} data-testid="new-phone" />
      <SelectField label={A("role")} value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })} data-testid="new-role">
        {ROLES.filter((r) => r !== "owner" || s.me?.role === "owner").map((r) => <option key={r} value={r}>{A(`role_${r}`)}</option>)}
      </SelectField>
      {reg && <TextField label={A("reg_no", { body: reg })} hint={A("reg_hint")} value={v.regNo} onChange={(e) => setV({ ...v, regNo: e.target.value })} data-testid="new-reg" />}
      <Callout tone="info" icon="key-round">{A("otp_explain")}</Callout>
      {error && <Callout tone="bad" icon="triangle-alert" data-testid="add-error">{error}</Callout>}
      <Button variant="primary" type="submit" icon="user-plus" disabled={!ok || busy || !s.online} data-testid="create-user">{A("create_user")}</Button>
    </form>
  );
}

/** The one-time password, shown once: copy it now. */
function Credential({ c, onClose }: { c: UserCredentialResponse; onClose: () => void }) {
  const A = useA(); const F = useFmt();
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="credential">
      <span>{A("otp_for", { name: F.name(c.user), phone: F.n(c.user.phone ?? "") })}</span>
      {c.oneTimePassword
        ? <code data-testid="otp" style={{ fontSize: 26, letterSpacing: 2, padding: "12px 16px", borderRadius: 8, background: "var(--surface-sunken)", textAlign: "center", userSelect: "all" }}>{c.oneTimePassword}</code>
        : <Callout tone="warn" icon="eye-off">{A("otp_gone")}</Callout>}
      <Callout tone="warn" icon="triangle-alert">{A("otp_once", { at: F.dateTime(c.expiresAt) })}</Callout>
      <span style={{ display: "flex", gap: 8 }}>
        {c.oneTimePassword && <Button icon={copied ? "check" : "copy"} onClick={async () => { try { await navigator.clipboard.writeText(c.oneTimePassword!); setCopied(true); } catch { setCopied(false); } }}>{copied ? A("copied") : A("copy")}</Button>}
        <Button variant="primary" onClick={onClose} data-testid="otp-done">{A("otp_done")}</Button>
      </span>
    </div>
  );
}

function Manage({ u, onChanged, onCredential, onError }: { u: UserView; onChanged: (u?: UserView) => Promise<void>; onCredential: (c: UserCredentialResponse) => void; onError: (e: unknown) => void }) {
  const s = useSession(); const A = useA(); const F = useFmt();
  const [role, setRole] = useState<string>(u.role); const [why, setWhy] = useState(""); const [offWhy, setOffWhy] = useState(""); const [regNo, setRegNo] = useState(u.registration?.number ?? "");
  const [busy, setBusy] = useState(false);
  const keys = useState(() => ({ role: crypto.randomUUID(), off: crypto.randomUUID(), on: crypto.randomUUID(), reset: crypto.randomUUID(), verify: crypto.randomUUID() }))[0];
  const self = u.id === s.me?.userId;
  // an admin never changes an owner (only an owner does — the server refuses it): say so instead of offering it
  const ownerOnly = u.role === "owner" && s.me?.role !== "owner";
  const locked = self || ownerOnly;
  const run = async <T,>(f: () => Promise<T>, after: (x: T) => Promise<void> | void, renew?: keyof typeof keys) => {
    if (busy) return; setBusy(true);
    try { const x = await f(); if (renew) keys[renew] = crypto.randomUUID(); await after(x); } catch (e) { if (renew && renewKey(e)) keys[renew] = crypto.randomUUID(); onError(e); } finally { setBusy(false); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }} data-testid="manage-user" data-user={u.id}>
      <span style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <UserStatus u={u} /> <span>{A(`role_${u.role}`)}</span> <span className="num t-small">{F.n(u.phone ?? "")}</span>
        {u.deactivated && <span className="t-small t-secondary">{A("off_why", { at: F.dateTime(u.deactivated.at), reason: u.deactivated.reason })}</span>}
      </span>
      {self && <Callout tone="info" icon="info">{A("self_note")}</Callout>}
      {ownerOnly && <Callout tone="info" icon="lock">{A("owner_only_note")}</Callout>}

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <b>{A("change_role")}</b>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <SelectField label={A("role")} value={role} onChange={(e) => setRole(e.target.value)} data-testid="role-select">
            {ROLES.filter((r) => r !== "owner" || s.me?.role === "owner").map((r) => <option key={r} value={r}>{A(`role_${r}`)}</option>)}
          </SelectField>
          <TextField label={A("reason_optional")} value={why} onChange={(e) => setWhy(e.target.value)} />
          <Button icon="shuffle" data-testid="role-save" disabled={locked || busy || !s.online || role === u.role || !u.active} onClick={() => void run(() => adm.role(u.id, role, why.trim(), keys.role), (x) => onChanged(x), "role")}>{A("save")}</Button>
        </div>
        <span className="t-small t-muted">{A("role_signs_out")}</span>
      </section>

      {u.registration && (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <b>{A("registration")}</b> <RegPill r={u.registration} />
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
            <TextField label={A("reg_no", { body: u.registration.body })} value={regNo} onChange={(e) => setRegNo(e.target.value)} data-testid="reg-no" />
            <Button icon="badge-check" data-testid="reg-verify" disabled={ownerOnly || busy || !s.online || !regNo.trim()} onClick={() => void run(() => adm.verify(u.id, regNo.trim(), keys.verify), (x) => onChanged(x), "verify")}>{A("verify")}</Button>
          </div>
          <span className="t-small t-muted">{A("reg_signed_note")}</span>
        </section>
      )}

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <b>{A("password")}</b>
        <span><Button icon="key-round" data-testid="reset-password" disabled={locked || busy || !s.online || !u.active} onClick={() => void run(() => adm.resetPassword(u.id, keys.reset), (c) => onCredential(c), "reset")}>{A("reset_password")}</Button></span>
        <span className="t-small t-muted">{A("reset_note")}</span>
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <b>{u.active ? A("switch_off") : A("switch_on")}</b>
        {u.active ? (
          <>
            <TextArea label={A("off_reason")} hint={A("reason_hint")} value={offWhy} onChange={(e) => setOffWhy(e.target.value)} data-testid="off-reason" />
            <span><Button variant="danger" icon="user-x" data-testid="deactivate" disabled={locked || busy || !s.online || offWhy.trim().length < 10} onClick={() => void run(() => adm.deactivate(u.id, offWhy.trim(), keys.off), (x) => onChanged(x), "off")}>{A("switch_off")}</Button></span>
            <span className="t-small t-muted">{A("off_note")}</span>
          </>
        ) : <span><Button icon="user-check" data-testid="reactivate" disabled={locked || busy || !s.online} onClick={() => void run(() => adm.reactivate(u.id, keys.on), (x) => onChanged(x), "on")}>{A("switch_on")}</Button></span>}
      </section>
    </div>
  );
}
