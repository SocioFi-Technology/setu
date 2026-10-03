/* Session = signed cookie carrying {userId, tenantId, organizationId, role, plan}. Device-bound later (auth slice). */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Plan, Role } from "@setu/domain";
import { err, unauthorized } from "../errors.js";

/** `generation`: the user's session generation when signed in (ADR 0010 — a bump signs them out everywhere);
    `setup`: signed in with a one-time password — only the first-sign-in routes answer until a password and PIN are set. */
export interface SessionData { userId: string; tenantId: string; organizationId: string; role: Role; plan: Plan; nameBn: string; nameEn: string; organizationName: string; generation?: number; setup?: boolean }
declare module "fastify" { interface FastifyRequest { session: SessionData | null } }

export const COOKIE = "setu_session";
export function sessionPlugin(app: FastifyInstance) {
  app.decorateRequest("session", null);
  app.addHook("onRequest", async (req) => {
    const raw = req.cookies[COOKIE];
    if (!raw) { req.session = null; return; }
    const v = req.unsignCookie(raw);
    req.session = v.valid && v.value ? (JSON.parse(Buffer.from(v.value, "base64url").toString()) as SessionData) : null;
  });
}
export const encodeSession = (s: SessionData) => Buffer.from(JSON.stringify(s)).toString("base64url");
/** Routes a setup session (one-time password) may use. */
const SETUP_ROUTES = new Set(["/v1/me", "/v1/me/capabilities", "/v1/auth/logout", "/v1/auth/first-sign-in"]);
export function requireSession(req: FastifyRequest): SessionData {
  if (!req.session) throw unauthorized();
  if (req.session.setup && !SETUP_ROUTES.has(req.routeOptions.url ?? ""))
    throw err(403, "setup_required", "আগে নিজের পাসওয়ার্ড ও পিন ঠিক করুন", "Set your own password and PIN first", { reason: "setup", canRequest: false });
  return req.session;
}
