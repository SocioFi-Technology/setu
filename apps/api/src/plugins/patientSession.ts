/* ADR 0020 — the patient app's session: its own signed cookie (`setu_patient`), never the staff one. Patient routes
   read only this; staff routes read only `setu_session` — a person can never use a staff route or the reverse. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { err } from "../errors.js";

export interface PersonSession { personId: string; phone: string; lang: "bn" | "en"; generation: number }
declare module "fastify" { interface FastifyRequest { person: PersonSession | null } }

export const PATIENT_COOKIE = "setu_patient";
export const PATIENT_COOKIE_OPTIONS = { path: "/", httpOnly: true, sameSite: "lax" as const, signed: true, maxAge: 30 * 24 * 3600, secure: process.env.NODE_ENV === "production" };
export const encodePerson = (p: PersonSession) => Buffer.from(JSON.stringify(p)).toString("base64url");

export function patientSessionPlugin(app: FastifyInstance) {
  app.decorateRequest("person", null);
  app.addHook("onRequest", async (req) => {
    const raw = req.cookies[PATIENT_COOKIE];
    if (!raw) { req.person = null; return; }
    const v = req.unsignCookie(raw);
    req.person = v.valid && v.value ? (JSON.parse(Buffer.from(v.value, "base64url").toString()) as PersonSession) : null;
  });
}
export function requirePerson(req: FastifyRequest): PersonSession {
  if (!req.person) throw err(401, "patient_signed_out", "আবার সাইন ইন করুন", "Sign in again");
  return req.person;
}
export const clearPerson = (reply: FastifyReply) => reply.clearCookie(PATIENT_COOKIE, { path: "/" });
/** the phone in logs and audit rows: never the number itself */
export const phoneRef = (phone10: string) => "ph_" + createHash("sha256").update("setu-person:" + phone10).digest("hex").slice(0, 16);
