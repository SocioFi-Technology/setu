import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { PIN_MAX } from "../src/routes/auth.js";

process.env.NODE_ENV = "test";
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });

const login = async (identifier = "01711000002", password = "setu1234") => {
  const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier, password } });
  const cookie = r.headers["set-cookie"]; return { r, cookie: Array.isArray(cookie) ? cookie[0]! : (cookie as string) };
};

describe("meta", () => {
  it("GET /health", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ ok: true, db: "skipped" });
  });
});
describe("auth", () => {
  it("rejects a wrong password with a bilingual error", async () => {
    const { r } = await login("01711000002", "wrong-pass");
    expect(r.statusCode).toBe(401); expect(r.json()).toMatchObject({ code: "bad_credentials", message_bn: expect.any(String), message_en: expect.any(String) });
  });
  it("logs the demo doctor in and returns a session cookie", async () => {
    const { r, cookie } = await login();
    expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ role: "doctor", plan: "pro", nameEn: "Dr. Imran Kabir" }); expect(cookie).toContain("setu_session=");
  });
  it("GET /v1/me/capabilities hides clinical screens from the receptionist (walkthrough: role access)", async () => {
    const { cookie } = await login("01711000001");
    const r = await app.inject({ method: "GET", url: "/v1/me/capabilities", headers: { cookie } });
    const mods = r.json().modules as { key: string }[];
    expect(mods.map((m) => m.key)).toContain("fd"); expect(mods.map((m) => m.key)).not.toContain("cons");
  });
  it("needs a session", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/me" }); expect(r.statusCode).toBe(401);
  });
  it("PIN: wrong tries count down, then lock; right PIN resets", async () => {
    const { cookie } = await login("01711000001");
    for (let i = 1; i < PIN_MAX; i++) {
      const r = await app.inject({ method: "POST", url: "/v1/auth/pin/verify", headers: { cookie }, payload: { pin: "9999" } });
      expect(r.json()).toEqual({ ok: false, triesLeft: PIN_MAX - i });
    }
    const locked = await app.inject({ method: "POST", url: "/v1/auth/pin/verify", headers: { cookie }, payload: { pin: "9999" } });
    expect(locked.json()).toMatchObject({ ok: false, triesLeft: 0, lockedUntil: expect.any(String) });
    const { cookie: c2 } = await login("01711000002");
    const ok = await app.inject({ method: "POST", url: "/v1/auth/pin/verify", headers: { cookie: c2 }, payload: { pin: "1234" } });
    expect(ok.json()).toEqual({ ok: true });
  });
  it("replays an Idempotency-Key with the stored response", async () => {
    const { cookie } = await login("01711000002");
    const h = { cookie, "idempotency-key": "k-1" };
    const a = await app.inject({ method: "POST", url: "/v1/auth/pin/verify", headers: h, payload: { pin: "0000" } });
    const b = await app.inject({ method: "POST", url: "/v1/auth/pin/verify", headers: h, payload: { pin: "0000" } });
    expect(b.headers["idempotent-replay"]).toBe("true"); expect(b.json()).toEqual(a.json());
  });
});
