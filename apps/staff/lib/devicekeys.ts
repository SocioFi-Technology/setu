"use client";
/* Gap 10 (Kamrul 07/10/2026, option b): the keys this device keeps its drafts and queued writes with. The server
   derives them and hands them over with the session (/v1/me); they live in this module's memory only — never in
   localStorage — so a copy of the browser's storage is unreadable, and a sign-out or an ended session leaves nothing
   to open it with. AES-GCM seals each entry; the queue key signs each queued write for the server's check. */
const DEVICE = "setu.device";
/** This browser's own id, sent at sign-in (the keys are bound to it). Random, not secret. */
export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE);
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) { id = b64u(crypto.getRandomValues(new Uint8Array(18))); localStorage.setItem(DEVICE, id); }
    return id;
  } catch { return "unknown"; }
}
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const enc = new TextEncoder(), dec = new TextDecoder();

export interface DeviceKey { kid: string; key: CryptoKey }
/** An AES-GCM key from the server's bytes; `kid` names it (a hash prefix — which key sealed an entry, nothing more). */
export async function importSealKey(raw: string): Promise<DeviceKey> {
  const bytes = unb64u(raw);
  const kid = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 9));
  return { kid, key: await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]) };
}
export async function importMacKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", unb64u(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
export async function seal(k: DeviceKey, value: unknown): Promise<{ kid: string; iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k.key, enc.encode(JSON.stringify(value))));
  return { kid: k.kid, iv: b64u(iv), ct: b64u(ct) };
}
/** null = not this key, or the entry was changed (GCM refuses it). */
export async function open<T>(k: DeviceKey, e: { kid: string; iv: string; ct: string }): Promise<T | null> {
  if (e.kid !== k.kid) return null;
  try { return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(e.iv) }, k.key, unb64u(e.ct)))) as T; } catch { return null; }
}
/** The signature the server checks on a queued write: HMAC-SHA256("METHOD path idempotency-key"). */
export async function signQueued(mac: CryptoKey, method: string, path: string, key: string): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", mac, enc.encode(`${method} ${path} ${key}`))));
}
/** A short, non-reversible tag for "whose entry is this" (tenant:facility:user), stored beside the ciphertext. */
export async function ownerTag(owner: string): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`setu-owner|${owner}`))).slice(0, 12));
}
