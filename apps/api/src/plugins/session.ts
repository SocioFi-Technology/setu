/* Session = signed cookie carrying {userId, tenantId, organizationId, role, plan}. Device-bound later (auth slice). */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Plan, Role } from "@setu/domain";
import { unauthorized } from "../errors.js";

export interface SessionData { userId: string; tenantId: string; organizationId: string; role: Role; plan: Plan; nameBn: string; nameEn: string; organizationName: string }
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
export function requireSession(req: FastifyRequest): SessionData { if (!req.session) throw unauthorized(); return req.session; }
