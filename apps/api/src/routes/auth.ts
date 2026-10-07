import type { FastifyInstance } from "fastify";
import { Capabilities, FirstSignInRequest, LoginRequest, Me, PinVerifyRequest } from "@setu/contracts";
import { capabilities, passwordProblems, pinProblems } from "@setu/domain";
import { aiEnabled } from "../adapters/ai.js";
import { command } from "../command.js";
import { config } from "../config.js";
import { err, unauthorized } from "../errors.js";
import { checkPassword, checkPin, findLoginCandidates, findUserById } from "../modules/users.js";
import { decoyVerify, hashSecret } from "../modules/secrets.js";
import { checkPinAttempt } from "../modules/pin.js";
import { counters } from "../adapters/counters.js";
import { COOKIE, encodeSession, requireSession, type SessionData } from "../plugins/session.js";

/* PIN attempts (5 tries, then 15 minutes locked) are counted in modules/pin.ts, shared with the sign routes. */
export { PIN_LOCK_MS, PIN_MAX } from "../modules/pin.js";
/** external review A3 */
export const LOGIN_RATE_MAX = 10, LOGIN_FAIL_MAX = 10, LOGIN_LOCK_MS = 15 * 60_000;
/** the session cookie: `secure` in production (review A3) */
const COOKIE_OPTIONS = { path: "/", httpOnly: true, sameSite: "lax" as const, signed: true, maxAge: 12 * 3600, secure: process.env.NODE_ENV === "production" };

export async function authRoutes(app: FastifyInstance) {
  /* External review A3: 10 failed sign-ins per minute from one address for one phone → 429; 10 failed sign-ins on an
     account within 15 minutes → that account is locked for 15 minutes (Redis, shared by every instance); every sign-in
     and every refused one is audited in its own transaction (the account's facility; an unknown phone goes to the log). */
  app.post("/v1/auth/login", async (req, reply) => {
    const body = LoginRequest.parse(req.body);
    const digits = body.identifier.replace(/\D/g, "").replace(/^880/, "").replace(/^0/, "");
    const last4 = digits.slice(-4) || null;
    const c = counters(), rateKey = `login:rate:${req.ip}|${digits || body.identifier.trim().toLowerCase()}`;
    /* The same phone may exist in two tenants; exactly one account must match the password, never a guess. */
    const candidates = await findLoginCandidates(body.identifier);
    const refused = async (reason: "bad-password" | "locked" | "rate-limited") => {
      if (!candidates.length) { req.log.warn({ audit: { action: "login-failed", reason, phoneLast4: last4, ip: req.ip } }, "login refused"); return; }
      if (!config.dbEnabled) return;
      const { forTenant } = await import("@setu/db");
      for (const u of candidates) await forTenant(u.tenantId, (tx) => tx.auditEvent.create({ data: {
        tenantId: u.tenantId, organizationId: u.roles[0]?.organizationId ?? null, userId: null, role: null, action: "login-failed", entity: "User", entityId: u.id, ip: req.ip,
        detail: { route: "/v1/auth/login", reason, phoneLast4: last4 } } }));
    };
    if (await c.get(rateKey) >= LOGIN_RATE_MAX) {
      await refused("rate-limited");
      throw err(429, "rate_limited", "অনেকবার ভুল চেষ্টা — এক মিনিট পরে আবার চেষ্টা করুন", "Too many wrong attempts — try again in a minute");
    }
    const locks = await Promise.all(candidates.map((u) => c.ttlMs(`login:lock:${u.id}`)));
    if (locks.some((t) => t > 0)) {
      await refused("locked");
      throw err(423, "login_locked", "অনেকবার ভুল পাসওয়ার্ড — অ্যাকাউন্ট ১৫ মিনিটের জন্য বন্ধ", "Too many wrong passwords — this account is locked for 15 minutes", { lockedUntil: new Date(Date.now() + Math.max(...locks)).toISOString() });
    }
    if (!candidates.length) await decoyVerify(body.password); // no account: the same cost as a wrong password (review A2)
    const checked = await Promise.all(candidates.map(async (x) => ({ c: x, v: await checkPassword(x, body.password) })));
    const matches = checked.filter((x) => x.v.ok);
    const u = matches.length === 1 ? matches[0]!.c : null;
    const rehash = matches.length === 1 && matches[0]!.v.rehash;
    if (!u || !u.roles[0]) {
      await c.incr(rateKey, 60_000);
      for (const x of candidates) {
        const n = await c.incr(`login:fail:${x.id}`, LOGIN_LOCK_MS);
        if (n >= LOGIN_FAIL_MAX) { await c.set(`login:lock:${x.id}`, 1, LOGIN_LOCK_MS); await c.del(`login:fail:${x.id}`); }
      }
      await refused("bad-password");
      throw err(401, "bad_credentials", "ফোন/ইমেইল বা পাসওয়ার্ড ভুল", "Wrong phone/email or password");
    }
    await c.del(`login:fail:${u.id}`);
    // ADR 0010: a one-time password works once, for 24 hours, and only to set the user's own password and PIN
    if (u.mustChangePassword && (!u.tempPasswordExpiresAt || Date.parse(u.tempPasswordExpiresAt) < Date.now()))
      throw err(401, "otp_expired", "এককালীন পাসওয়ার্ডের মেয়াদ শেষ — অ্যাডমিনকে নতুনটি দিতে বলুন", "The one-time password has expired — ask the admin for a new one");
    // …and works for one sign-in only (security review): a second use needs a new one from the admin
    if (u.mustChangePassword && u.tempPasswordUsedAt)
      throw err(401, "otp_used", "এই এককালীন পাসওয়ার্ড আগেই ব্যবহার হয়েছে — অ্যাডমিনকে নতুনটি দিতে বলুন", "This one-time password was already used — ask the admin for a new one");
    const r = u.roles[0]!;
    const plan = !config.dbEnabled && body.demoPlan ? body.demoPlan : u.plan;
    let generation = u.sessionGeneration ?? 0;
    if (config.dbEnabled) {
      const { forTenant } = await import("@setu/db");
      const now = new Date();
      const h = rehash ? await hashSecret(body.password) : null; // review A2: an old-style hash becomes argon2id now
      const claimed = await forTenant(u.tenantId, async (tx) => {
        if (u.mustChangePassword) {
          // claim the one-time password atomically; the setup session gets a fresh generation
          const n = await tx.user.updateMany({ where: { id: u.id, mustChangePassword: true, tempPasswordUsedAt: null, sessionGeneration: generation }, data: { tempPasswordUsedAt: now, lastLoginAt: now, sessionGeneration: { increment: 1 } } });
          if (n.count !== 1) return false;
        } else await tx.user.update({ where: { id: u.id }, data: { lastLoginAt: now } });
        if (h) await tx.user.update({ where: { id: u.id }, data: { passwordHash: h } });
        // review A3: the sign-in itself is audited here, in the same transaction
        await tx.auditEvent.create({ data: { tenantId: u.tenantId, organizationId: r.organizationId, userId: u.id, role: r.role, action: "login", entity: "User", entityId: u.id, ip: req.ip,
          detail: { route: "/v1/auth/login", phoneLast4: last4, ...(u.mustChangePassword ? { oneTimePassword: true } : {}) } } });
        return true;
      }, { userId: u.id });
      if (!claimed) throw err(401, "otp_used", "এই এককালীন পাসওয়ার্ড আগেই ব্যবহার হয়েছে — অ্যাডমিনকে নতুনটি দিতে বলুন", "This one-time password was already used — ask the admin for a new one");
      if (u.mustChangePassword) generation += 1;
    }
    const session: SessionData = { userId: u.id, tenantId: u.tenantId, organizationId: r.organizationId, organizationName: r.organizationName, role: r.role, plan, nameBn: u.nameBn, nameEn: u.nameEn,
      generation, ...(u.mustChangePassword ? { setup: true } : {}) };
    reply.setCookie(COOKIE, encodeSession(session), COOKIE_OPTIONS);
    return Me.parse({ ...session, roles: u.roles.map(({ organizationId, role }) => ({ organizationId, role })), mustSetCredentials: Boolean(session.setup), ai: aiEnabled() });
  });

  app.post("/v1/auth/logout", async (req, reply) => { reply.clearCookie(COOKIE, { path: "/" }); return { ok: true }; });

  app.get("/v1/me", async (req, reply) => {
    const s = requireSession(req);
    const u = await findUserById(s.tenantId, s.userId);
    // ADR 0010: switched off, the role taken away or the generation bumped → this session has ended
    if (config.dbEnabled && (!u || (u.sessionGeneration ?? 0) !== (s.generation ?? 0) || !u.roles.some((r) => r.organizationId === s.organizationId && r.role === s.role))) {
      reply.clearCookie(COOKIE, { path: "/" });
      throw err(401, "session_ended", "আপনার সেশন শেষ — আবার লগইন করুন", "Your session has ended — sign in again");
    }
    return Me.parse({ ...s, roles: u?.roles.map(({ organizationId, role }) => ({ organizationId, role })) ?? [{ organizationId: s.organizationId, role: s.role }], mustSetCredentials: Boolean(s.setup), ai: aiEnabled() });
  });

  /* ADR 0010: the first sign-in with a one-time password — the user sets their own password and PIN; the session is
     replaced by a normal one (a new generation, so the one-time session ends everywhere). */
  app.post("/v1/auth/first-sign-in", { config: { ownTx: true } }, async (req, reply) => {
    const s = requireSession(req);
    if (!s.setup) throw err(409, "not_needed", "পাসওয়ার্ড আগেই ঠিক করা আছে", "Your password is already set");
    const body = FirstSignInRequest.parse(req.body ?? {});
    // argon2 before the transaction (it is slow); the password's own checks need the user, inside
    const [passwordHash, pinHash] = await Promise.all([hashSecret(body.password), hashSecret(body.pin)]);
    // external review B5: one transaction with its audit and idempotency key (command); the key's request hash leaves
    // the password and PIN out — no unsalted hash of them is stored
    const me = await command(req, reply, async (tx) => {
      const u = await tx.user.findFirst({ where: { id: s.userId, active: true } });
      if (!u || !u.mustChangePassword || u.sessionGeneration !== (s.generation ?? 0)) throw err(401, "session_ended", "আপনার সেশন শেষ — আবার লগইন করুন", "Your session has ended — sign in again");
      if (!u.tempPasswordExpiresAt || u.tempPasswordExpiresAt.getTime() < Date.now()) throw err(401, "otp_expired", "এককালীন পাসওয়ার্ডের মেয়াদ শেষ — অ্যাডমিনকে নতুনটি দিতে বলুন", "The one-time password has expired — ask the admin for a new one");
      const pw = passwordProblems(body.password, u.phone);
      if (pw.length) throw err(400, pw[0]!, "পাসওয়ার্ড অন্তত ৮ অক্ষর, অক্ষর ও সংখ্যা দুটোই, ফোন নম্বর নয়", "Password: at least 8 characters, a letter and a digit, not your phone number", { field: "password" });
      const pin = pinProblems(body.pin);
      if (pin.length) throw err(400, pin[0]!, "পিন ৪ সংখ্যার, খুব সহজ নয় (১১১১ / ১২৩৪ নয়)", "PIN: 4 digits, not too simple (not 1111 / 1234)", { field: "pin" });
      // atomic: a reset or role change that lands meanwhile wins (the generation no longer matches → refused)
      const n = await tx.user.updateMany({ where: { id: u.id, active: true, mustChangePassword: true, sessionGeneration: u.sessionGeneration },
        data: { passwordHash, pinHash, mustChangePassword: false, tempPasswordExpiresAt: null, tempPasswordUsedAt: null, sessionGeneration: { increment: 1 } } });
      if (n.count !== 1) throw err(401, "session_ended", "আপনার সেশন শেষ — আবার লগইন করুন", "Your session has ended — sign in again");
      const session: SessionData = { ...s, generation: u.sessionGeneration + 1, setup: undefined };
      delete session.setup;
      return { body: Me.parse({ ...session, roles: [{ organizationId: s.organizationId, role: s.role }], mustSetCredentials: false, ai: aiEnabled() }),
        audit: [{ action: "first-sign-in", entity: "User", entityId: u.id, detail: { event: "credentials-set" } }] };
    }, { hashOmit: ["password", "pin"] });
    // a fresh request replaces the one-time session (a replay cannot reach here: the old session has ended)
    const session: SessionData = { ...s, generation: (s.generation ?? 0) + 1, setup: undefined };
    delete session.setup;
    reply.setCookie(COOKIE, encodeSession(session), COOKIE_OPTIONS);
    return me;
  });

  app.get("/v1/me/capabilities", async (req) => {
    const s = requireSession(req);
    return Capabilities.parse({ modules: capabilities(s.role, s.plan) });
  });

  app.post("/v1/auth/pin/verify", { config: { audit: { action: "pin", entity: "User" } } }, async (req) => {
    const s = requireSession(req);
    const { pin } = PinVerifyRequest.parse(req.body);
    const u = await findUserById(s.tenantId, s.userId);
    // an ended session is no PIN oracle (security review)
    if (!u || (config.dbEnabled && (u.sessionGeneration ?? 0) !== (s.generation ?? 0))) throw unauthorized();
    let rehash = false;
    const r = await checkPinAttempt(s.userId, async () => { const v = await checkPin(u, pin); rehash = v.rehash; return v.ok; });
    if (rehash && config.dbEnabled) {
      const h = await hashSecret(pin);
      const { forTenant } = await import("@setu/db");
      await forTenant(s.tenantId, (tx) => tx.user.update({ where: { id: s.userId }, data: { pinHash: h } }), { userId: s.userId });
    }
    return r;
  });
}
