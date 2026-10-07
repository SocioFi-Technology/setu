import type { FastifyInstance } from "fastify";
import { Capabilities, FirstSignInRequest, LoginRequest, Me, PinVerifyRequest } from "@setu/contracts";
import { capabilities, passwordProblems, pinProblems } from "@setu/domain";
import { aiEnabled } from "../adapters/ai.js";
import { config } from "../config.js";
import { err, unauthorized } from "../errors.js";
import { checkPassword, checkPin, findLoginCandidates, findUserById } from "../modules/users.js";
import { decoyVerify, hashSecret } from "../modules/secrets.js";
import { checkPinAttempt } from "../modules/pin.js";
import { COOKIE, encodeSession, requireSession, type SessionData } from "../plugins/session.js";

/* PIN attempts (5 tries, then 15 minutes locked) are counted in modules/pin.ts, shared with the sign routes. */
export { PIN_LOCK_MS, PIN_MAX } from "../modules/pin.js";

export async function authRoutes(app: FastifyInstance) {
  app.post("/v1/auth/login", { config: { audit: { action: "login", entity: "User" } } }, async (req, reply) => {
    const body = LoginRequest.parse(req.body);
    /* The same phone may exist in two tenants; exactly one account must match the password, never a guess. */
    const candidates = await findLoginCandidates(body.identifier);
    if (!candidates.length) await decoyVerify(body.password); // no account: the same cost as a wrong password (review A2)
    const checked = await Promise.all(candidates.map(async (c) => ({ c, v: await checkPassword(c, body.password) })));
    const matches = checked.filter((x) => x.v.ok);
    const u = matches.length === 1 ? matches[0]!.c : null;
    const rehash = matches.length === 1 && matches[0]!.v.rehash;
    if (!u || !u.roles[0]) throw err(401, "bad_credentials", "ফোন/ইমেইল বা পাসওয়ার্ড ভুল", "Wrong phone/email or password");
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
      if (u.mustChangePassword) {
        // claim the one-time password atomically; the setup session gets a fresh generation
        const n = await forTenant(u.tenantId, (tx) => tx.user.updateMany({ where: { id: u.id, mustChangePassword: true, tempPasswordUsedAt: null, sessionGeneration: generation }, data: { tempPasswordUsedAt: now, lastLoginAt: now, sessionGeneration: { increment: 1 } } }), { userId: u.id });
        if (n.count !== 1) throw err(401, "otp_used", "এই এককালীন পাসওয়ার্ড আগেই ব্যবহার হয়েছে — অ্যাডমিনকে নতুনটি দিতে বলুন", "This one-time password was already used — ask the admin for a new one");
        generation += 1;
      } else await forTenant(u.tenantId, (tx) => tx.user.update({ where: { id: u.id }, data: { lastLoginAt: now } }), { userId: u.id });
      // review A2: an old-style password hash becomes argon2id on this successful login
      if (rehash) { const h = await hashSecret(body.password); await forTenant(u.tenantId, (tx) => tx.user.update({ where: { id: u.id }, data: { passwordHash: h } }), { userId: u.id }); }
    }
    const session: SessionData = { userId: u.id, tenantId: u.tenantId, organizationId: r.organizationId, organizationName: r.organizationName, role: r.role, plan, nameBn: u.nameBn, nameEn: u.nameEn,
      generation, ...(u.mustChangePassword ? { setup: true } : {}) };
    reply.setCookie(COOKIE, encodeSession(session), { path: "/", httpOnly: true, sameSite: "lax", signed: true, maxAge: 12 * 3600 });
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
  app.post("/v1/auth/first-sign-in", { config: { audit: { action: "first-sign-in", entity: "User" } } }, async (req, reply) => {
    const s = requireSession(req);
    if (!s.setup) throw err(409, "not_needed", "পাসওয়ার্ড আগেই ঠিক করা আছে", "Your password is already set");
    const body = FirstSignInRequest.parse(req.body ?? {});
    const { forTenant } = await import("@setu/db");
    const u = await forTenant(s.tenantId, (tx) => tx.user.findFirst({ where: { id: s.userId, active: true } }), { userId: s.userId });
    if (!u || !u.mustChangePassword || u.sessionGeneration !== (s.generation ?? 0)) throw err(401, "session_ended", "আপনার সেশন শেষ — আবার লগইন করুন", "Your session has ended — sign in again");
    if (!u.tempPasswordExpiresAt || u.tempPasswordExpiresAt.getTime() < Date.now()) throw err(401, "otp_expired", "এককালীন পাসওয়ার্ডের মেয়াদ শেষ — অ্যাডমিনকে নতুনটি দিতে বলুন", "The one-time password has expired — ask the admin for a new one");
    const pw = passwordProblems(body.password, u.phone), pin = pinProblems(body.pin);
    if (pw.length || pin.length) throw err(400, pw[0] ?? pin[0]!, pw.length ? "পাসওয়ার্ড অন্তত ৮ অক্ষর, অক্ষর ও সংখ্যা দুটোই, ফোন নম্বর নয়" : "পিন ৪ সংখ্যার, খুব সহজ নয় (১১১১ / ১২৩৪ নয়)",
      pw.length ? "Password: at least 8 characters, a letter and a digit, not your phone number" : "PIN: 4 digits, not too simple (not 1111 / 1234)", { field: pw.length ? "password" : "pin" });
    // atomic: a reset or role change that lands meanwhile wins (the generation no longer matches → refused)
    const generation = u.sessionGeneration + 1;
    const [passwordHash, pinHash] = await Promise.all([hashSecret(body.password), hashSecret(body.pin)]);
    const n = await forTenant(s.tenantId, (tx) => tx.user.updateMany({ where: { id: u.id, active: true, mustChangePassword: true, sessionGeneration: u.sessionGeneration },
      data: { passwordHash, pinHash, mustChangePassword: false, tempPasswordExpiresAt: null, tempPasswordUsedAt: null, sessionGeneration: { increment: 1 } } }), { userId: s.userId });
    if (n.count !== 1) throw err(401, "session_ended", "আপনার সেশন শেষ — আবার লগইন করুন", "Your session has ended — sign in again");
    const session: SessionData = { ...s, generation, setup: undefined };
    delete session.setup;
    reply.setCookie(COOKIE, encodeSession(session), { path: "/", httpOnly: true, sameSite: "lax", signed: true, maxAge: 12 * 3600 });
    return Me.parse({ ...session, roles: [{ organizationId: s.organizationId, role: s.role }], mustSetCredentials: false, ai: aiEnabled() });
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
