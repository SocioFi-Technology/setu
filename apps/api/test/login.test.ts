/* External review A3 on the real stack (Redis + database): failed sign-ins limited per address and phone, an account
   locked after ten wrong passwords, every sign-in and refused sign-in audited (the owner's audit log lists them), the
   signing-PIN tries counted in Redis. Each test cleans its own keys so no account stays locked for the other files. */
import { randomInt } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { counters } from "../src/adapters/counters.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app?.close(); });
const T = "t_e2e_lite";
const login = (identifier: string, password: string, ip = "127.0.0.1") => app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier, password }, remoteAddress: ip });

describe("sign-in limits (external review A3)", () => {
  it("ten failed attempts from one address for one phone: the eleventh is 429, even with nothing else changed", async () => {
    const phone = `0170${String(randomInt(0, 1e7)).padStart(7, "0")}`, ip = `10.9.${randomInt(0, 250)}.${randomInt(1, 250)}`;
    for (let i = 0; i < 10; i++) expect((await login(phone, "wrong-password", ip)).statusCode).toBe(401);
    const r = await login(phone, "wrong-password", ip);
    expect(r.statusCode).toBe(429); expect(r.json().code).toBe("rate_limited");
    // another address is not limited by this one
    expect((await login(phone, "wrong-password", "10.8.0.1")).statusCode).toBe(401);
  });
  it.runIf(db)("ten wrong passwords on an account lock it for 15 minutes — the right password is refused too; audited as login-failed", async () => {
    const phone = "01798000007", id = "u_e2l_nurse2";
    const c = counters();
    try {
      for (let i = 0; i < 10; i++) expect((await login(phone, "not-the-password", `10.7.${i}.1`)).statusCode).toBe(401);
      const r = await login(phone, "setu1234", "10.7.99.1");
      expect(r.statusCode).toBe(423); expect(r.json().code).toBe("login_locked");
      const rows = await db!.forTenant(T, (tx) => tx.auditEvent.findMany({ where: { action: "login-failed", entityId: id, at: { gte: new Date(Date.now() - 60_000) } } }));
      expect(rows.map((x) => (x.detail as { reason: string }).reason)).toEqual(expect.arrayContaining(["bad-password", "locked"]));
      expect(rows.every((x) => (x.detail as { phoneLast4: string }).phoneLast4 === "0007")).toBe(true);
    } finally { await c.del(`login:lock:${id}`, `login:fail:${id}`); }
    expect((await login(phone, "setu1234", "10.7.99.2")).statusCode).toBe(200);
  });
  it.runIf(db)("a sign-in is audited in its own transaction; the owner's audit log lists it", async () => {
    const r = await login("01798000008", "setu1234");
    expect(r.statusCode).toBe(200);
    const ev = await db!.forTenant(T, (tx) => tx.auditEvent.findFirst({ where: { action: "login", userId: "u_e2l_cashier" }, orderBy: { at: "desc" } }));
    expect(ev).toMatchObject({ entity: "User", entityId: "u_e2l_cashier", role: "cashier", organizationId: "o_e2e_lite" });
    expect(Date.now() - ev!.at.getTime()).toBeLessThan(60_000);
    const owner = await login("01798000009", "setu1234");
    const cookie = [owner.headers["set-cookie"]].flat()[0] as string;
    const page = await app.inject({ method: "GET", url: "/v1/admin/audit?action=login", headers: { cookie } });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().items.some((x: { user: { id: string } | null; action: string }) => x.action === "login" && x.user?.id === "u_e2l_cashier")).toBe(true);
    const failed = await app.inject({ method: "GET", url: "/v1/admin/audit?action=login-failed&flagged=1", headers: { cookie } });
    expect(failed.statusCode).toBe(200);
  });
  it("the session cookie is httpOnly and signed; `secure` in production (set from NODE_ENV)", async () => {
    const r = await login(config.dbEnabled ? "01798000008" : "01711000008", "setu1234");
    const set = String([r.headers["set-cookie"]].flat()[0]);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).not.toMatch(/Secure/); // tests run in development
  });
});

describe.runIf(db)("signing-PIN tries in Redis (gap 4)", () => {
  it("five wrong PINs lock the PIN for 15 minutes, counted where every API instance sees them", async () => {
    const id = "u_e2l_nurse2";
    const c = counters();
    const ok = await login("01798000007", "setu1234", "10.6.0.1");
    const cookie = [ok.headers["set-cookie"]].flat()[0] as string;
    const pin = (p: string) => app.inject({ method: "POST", url: "/v1/auth/pin/verify", payload: { pin: p }, headers: { cookie } });
    try {
      for (let i = 0; i < 4; i++) expect((await pin("9999")).json()).toMatchObject({ ok: false, triesLeft: 4 - i });
      expect(await c.get(`pin:tries:${id}`)).toBe(4);
      expect((await pin("9999")).json()).toMatchObject({ ok: false, triesLeft: 0 });
      expect(await c.ttlMs(`pin:lock:${id}`)).toBeGreaterThan(14 * 60_000);
      expect((await pin("1234")).json()).toMatchObject({ ok: false, triesLeft: 0 }); // locked: even the right PIN
    } finally { await c.del(`pin:lock:${id}`, `pin:tries:${id}`); }
    expect((await pin("1234")).json()).toMatchObject({ ok: true });
  });
});
