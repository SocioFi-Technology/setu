/* Passwords, one-time passwords and signing PINs (external review A2). Stored as argon2id (OWASP: 19 MiB, 2 passes,
   1 lane). Hashes written before this change (sha256 of "dev-only:" + value, 64 hex) still verify — compared with
   timingSafeEqual — and are re-hashed on the next successful use (login for a password, a signature for a PIN), so the
   seeded and existing accounts keep working. Nothing else may compare a stored hash. */
import { createHash, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
export const hashSecret = (value: string): Promise<string> => hash(value, ARGON);

const LEGACY = /^[0-9a-f]{64}$/;
const legacyDigest = (value: string) => createHash("sha256").update("dev-only:" + value).digest();
export const isLegacyHash = (stored: string | null | undefined): boolean => Boolean(stored && LEGACY.test(stored));
/** The old scheme, for tests and for checking that no stored hash still uses it. Never written by the app. */
export const legacyHash = (value: string): string => legacyDigest(value).toString("hex");

export interface Verified { ok: boolean; rehash: boolean }
/** `rehash`: right value on an old-style hash — the caller stores `hashSecret(value)` in the same transaction. */
export async function verifySecret(stored: string | null | undefined, value: string): Promise<Verified> {
  if (!stored) return { ok: false, rehash: false };
  if (stored.startsWith("$argon2")) return { ok: await verify(stored, value).catch(() => false), rehash: false };
  if (LEGACY.test(stored)) {
    const a = Buffer.from(stored, "hex"), b = legacyDigest(value);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    return { ok, rehash: ok };
  }
  return { ok: false, rehash: false };
}
/** A login for a phone with no account still costs one verify, so its timing does not say whether the account exists. */
let decoy: Promise<string> | null = null;
export async function decoyVerify(value: string): Promise<void> {
  decoy ??= hashSecret("setu-decoy-not-a-password");
  await verify(await decoy, value).catch(() => false);
}
