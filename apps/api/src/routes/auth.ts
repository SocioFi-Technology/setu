import type { FastifyInstance } from "fastify";
import { Capabilities, LoginRequest, Me, PinVerifyRequest } from "@setu/contracts";
import { capabilities } from "@setu/domain";
import { config } from "../config.js";
import { err, unauthorized } from "../errors.js";
import { checkPassword, checkPin, findUser } from "../modules/users.js";
import { COOKIE, encodeSession, requireSession } from "../plugins/session.js";

/* PIN attempts: 5 tries then a 15-minute lock, per user. In memory here; Redis in the auth slice. */
const pinTries = new Map<string, { n: number; lockedUntil?: number }>();
export const PIN_MAX = 5, PIN_LOCK_MS = 15 * 60_000;

export async function authRoutes(app: FastifyInstance) {
  app.post("/v1/auth/login", { config: { audit: { action: "login", entity: "User" } } }, async (req, reply) => {
    const body = LoginRequest.parse(req.body);
    const u = await findUser(body.identifier);
    if (!u || !checkPassword(u, body.password)) throw err(401, "bad_credentials", "ফোন/ইমেইল বা পাসওয়ার্ড ভুল", "Wrong phone/email or password");
    const r = u.roles[0]!;
    const plan = !config.dbEnabled && body.demoPlan ? body.demoPlan : u.plan;
    const session = { userId: u.id, tenantId: u.tenantId, organizationId: r.organizationId, organizationName: r.organizationName, role: r.role, plan, nameBn: u.nameBn, nameEn: u.nameEn };
    reply.setCookie(COOKIE, encodeSession(session), { path: "/", httpOnly: true, sameSite: "lax", signed: true, maxAge: 12 * 3600 });
    return Me.parse({ ...session, roles: u.roles.map(({ organizationId, role }) => ({ organizationId, role })) });
  });

  app.post("/v1/auth/logout", async (req, reply) => { reply.clearCookie(COOKIE, { path: "/" }); return { ok: true }; });

  app.get("/v1/me", async (req) => {
    const s = requireSession(req);
    const u = await findUser(s.userId.startsWith("u_") ? (await findUserPhone(s.userId)) : s.userId);
    return Me.parse({ ...s, roles: u?.roles.map(({ organizationId, role }) => ({ organizationId, role })) ?? [{ organizationId: s.organizationId, role: s.role }] });
  });

  app.get("/v1/me/capabilities", async (req) => {
    const s = requireSession(req);
    return Capabilities.parse({ modules: capabilities(s.role, s.plan) });
  });

  app.post("/v1/auth/pin/verify", { config: { audit: { action: "pin", entity: "User" } } }, async (req) => {
    const s = requireSession(req);
    const { pin } = PinVerifyRequest.parse(req.body);
    const st = pinTries.get(s.userId) ?? { n: 0 };
    if (st.lockedUntil && st.lockedUntil > Date.now()) return { ok: false, triesLeft: 0, lockedUntil: new Date(st.lockedUntil).toISOString() };
    const u = await findUser(await findUserPhone(s.userId));
    if (!u) throw unauthorized();
    if (checkPin(u, pin)) { pinTries.delete(s.userId); return { ok: true }; }
    st.n += 1;
    if (st.n >= PIN_MAX) { st.lockedUntil = Date.now() + PIN_LOCK_MS; st.n = 0; pinTries.set(s.userId, st); return { ok: false, triesLeft: 0, lockedUntil: new Date(st.lockedUntil).toISOString() }; }
    pinTries.set(s.userId, st);
    return { ok: false, triesLeft: PIN_MAX - st.n };
  });
}

/* Demo users are keyed by id in memory; map back to the identifier findUser expects. */
async function findUserPhone(userId: string): Promise<string> {
  if (config.dbEnabled) { const { prisma } = await import("@setu/db"); const u = await prisma.user.findUnique({ where: { id: userId } }); return u?.phone ?? u?.email ?? userId; }
  const map: Record<string, string> = { u_sadia: "01711000001", u_imran: "01711000002", u_shirin: "01711000004", u_tanvir: "01711000005", u_kanta: "01711000006", u_jewel: "01711000007", u_kafia: "01711000008", u_anwar: "01711000009", u_admin: "01711000010" };
  return map[userId] ?? userId;
}
