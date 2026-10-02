import type { ApiError, Capabilities, Me } from "@setu/contracts";
export class ApiFailure extends Error { constructor(public status: number, public body: ApiError) { super(body.message_en); } }

async function call<T>(method: string, path: string, body?: unknown, idemKey?: string): Promise<T> {
  const r = await fetch("/api" + path, {
    method, credentials: "include",
    headers: { "content-type": "application/json", ...(idemKey ? { "idempotency-key": idemKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) { let e: ApiError = { code: "http_" + r.status, message_bn: "সার্ভারে সমস্যা", message_en: r.statusText }; try { e = await r.json(); } catch {} throw new ApiFailure(r.status, e); }
  return r.json() as Promise<T>;
}
export const api = {
  health: () => call<{ ok: true; version: string; db: string }>("GET", "/health"),
  login: (identifier: string, password: string, demoPlan?: string) => call<Me>("POST", "/v1/auth/login", { identifier, password, ...(demoPlan ? { demoPlan } : {}) }),
  logout: () => call<{ ok: true }>("POST", "/v1/auth/logout"),
  me: () => call<Me>("GET", "/v1/me"),
  capabilities: () => call<Capabilities>("GET", "/v1/me/capabilities"),
  pinVerify: (pin: string) => call<{ ok: boolean; triesLeft?: number; lockedUntil?: string }>("POST", "/v1/auth/pin/verify", { pin }),
};
