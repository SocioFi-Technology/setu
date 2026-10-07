/* Gap 10 (Kamrul 07/10/2026, option b): what a device keeps for its user is encrypted with keys the server derives
   and hands to the signed-in client, which holds them in memory only.
   - draft: per user, device and sign-in — a new sign-in gets a new key, so drafts from an earlier session become
     unreadable (listed as a count, gone at 24 h);
   - outbox: per user and device — a write queued offline is still sent after the same person signs in again on the
     same device; nobody else can read it;
   - queue: per user and device — the client signs each queued write with it, and the server checks the signature and
     that the user it was queued under is the one signed in (queuedWriteCheck), so a planted or copied write is refused. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import type { SessionData } from "../plugins/session.js";

// production refuses to start without its own DEVICE_KEY_SECRET (config.ts); the session secret stands in for dev only
const secret = () => process.env.DEVICE_KEY_SECRET || config.sessionSecret;
const derive = (label: string) => createHmac("sha256", secret()).update(label).digest();
/** The device's own id as the client sends it at sign-in (random, kept in the browser). */
export const deviceIdOf = (raw: unknown): string => (typeof raw === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(raw) ? raw : "unknown");
export const newSignInId = () => randomBytes(16).toString("base64url");
/** Sessions from before gap 10 carry no sign-in id: their generation stands in. */
const sidOf = (s: SessionData) => s.sid ?? `g${s.generation ?? 0}`;

export function deviceKeys(s: SessionData): { draft: string; outbox: string; queue: string } {
  const who = `${s.tenantId}|${s.userId}|${s.device ?? "unknown"}`;
  return {
    draft: derive(`draft|${who}|${sidOf(s)}`).toString("base64url"),
    outbox: derive(`outbox|${who}`).toString("base64url"),
    queue: derive(`queue|${who}`).toString("base64url"),
  };
}
/** The signature a client puts on a queued write: HMAC-SHA256(queue key, "METHOD path idempotency-key"). */
export function queuedSignature(s: SessionData, method: string, path: string, key: string): string {
  return createHmac("sha256", derive(`queue|${s.tenantId}|${s.userId}|${s.device ?? "unknown"}`)).update(`${method} ${path} ${key}`).digest("base64url");
}
export function signatureOk(s: SessionData, method: string, path: string, key: string, sig: string): boolean {
  const want = Buffer.from(queuedSignature(s, method, path, key)), got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
