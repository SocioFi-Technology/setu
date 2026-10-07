/* Signing PIN: 5 tries then a 15-minute lock, per user, shared by /v1/auth/pin/verify and every sign route (a wrong PIN
   while signing counts the same). In memory for now; Redis in the auth hardening pass (HANDOVER known gap 4). */
import type { Tx } from "@setu/db";
import { err } from "../errors.js";
import { hashSecret, verifySecret } from "./secrets.js";

const tries = new Map<string, { n: number; lockedUntil?: number }>();
export const PIN_MAX = 5, PIN_LOCK_MS = 15 * 60_000;

export type PinResult = { ok: true } | { ok: false; triesLeft: number; lockedUntil?: string };

/** Checks a PIN with `matches` (which compares against the stored hash) and counts the attempt. */
export async function checkPinAttempt(userId: string, matches: () => Promise<boolean> | boolean): Promise<PinResult> {
  const st = tries.get(userId) ?? { n: 0 };
  if (st.lockedUntil && st.lockedUntil > Date.now()) return { ok: false, triesLeft: 0, lockedUntil: new Date(st.lockedUntil).toISOString() };
  if (await matches()) { tries.delete(userId); return { ok: true }; }
  st.n += 1;
  if (st.n >= PIN_MAX) { st.lockedUntil = Date.now() + PIN_LOCK_MS; st.n = 0; tries.set(userId, st); return { ok: false, triesLeft: 0, lockedUntil: new Date(st.lockedUntil).toISOString() }; }
  tries.set(userId, st);
  return { ok: false, triesLeft: PIN_MAX - st.n };
}

/** For sign routes: throws 401 pin_wrong / 423 pin_locked, so the whole transaction is refused. */
export async function requirePin(userId: string, matches: () => Promise<boolean> | boolean): Promise<void> {
  const r = await checkPinAttempt(userId, matches);
  if (r.ok) return;
  if (r.lockedUntil) throw err(423, "pin_locked", "পিন ১৫ মিনিটের জন্য বন্ধ — পরে চেষ্টা করুন", "PIN locked for 15 minutes — try later", { lockedUntil: r.lockedUntil, triesLeft: 0 });
  throw err(401, "pin_wrong", "পিন ভুল", "Wrong PIN", { field: "pin", triesLeft: r.triesLeft });
}

/** A user's signing PIN against the stored hash (external review A2: argon2id; an old-style hash is re-hashed on the
    first right PIN, in the caller's transaction). Counts the try like `requirePin`. */
export async function requireUserPin(tx: Tx, userId: string, pin: string): Promise<void> {
  const u = await tx.user.findFirst({ where: { id: userId }, select: { pinHash: true } });
  let rehash = false;
  await requirePin(userId, async () => { const v = await verifySecret(u?.pinHash, pin); rehash = v.rehash; return v.ok; });
  if (rehash) await tx.user.update({ where: { id: userId }, data: { pinHash: await hashSecret(pin) } });
}
