/* External review A2 on the real database: passwords, PINs and one-time passwords are argon2id; an account still on the
   old sha256 scheme signs in (password) and signs (PIN) as before and is upgraded on that success; a wrong value is
   refused either way. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { hashSecret, isLegacyHash, legacyHash, verifySecret } from "../src/modules/secrets.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app?.close(); });
const T = "t_e2e_lite", DESK = "u_e2l_desk", PHONE = "01798000001";
const login = (password: string) => app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: PHONE, password } });
const row = () => db!.forTenant(T, (tx) => tx.user.findFirst({ where: { id: DESK }, select: { passwordHash: true, pinHash: true } }), { userId: DESK });

describe("the hashing (external review A2)", () => {
  it("argon2id: a right value verifies, a wrong one does not; the old scheme verifies and asks to be re-hashed", async () => {
    const h = await hashSecret("setu1234");
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifySecret(h, "setu1234")).toEqual({ ok: true, rehash: false });
    expect(await verifySecret(h, "setu1235")).toEqual({ ok: false, rehash: false });
    expect(await verifySecret(legacyHash("1234"), "1234")).toEqual({ ok: true, rehash: true });
    expect(await verifySecret(legacyHash("1234"), "1235")).toEqual({ ok: false, rehash: false });
    expect(await verifySecret(null, "1234")).toEqual({ ok: false, rehash: false });
    expect(await verifySecret("plaintext", "plaintext")).toEqual({ ok: false, rehash: false }); // never a plain compare
  });
});

describe.runIf(db)("the accounts (external review A2)", () => {
  it("no seeded account's stored hash is the old scheme of its seeded value", async () => {
    const left = await db!.forTenant(T, (tx) => tx.user.count({ where: { OR: [{ passwordHash: legacyHash("setu1234") }, { pinHash: { in: [legacyHash("1234"), legacyHash("2580")] } }] } }), { userId: DESK });
    expect(left).toBe(0);
    const r = await row();
    expect(r!.passwordHash).toMatch(/^\$argon2id\$/); expect(r!.pinHash).toMatch(/^\$argon2id\$/);
  });
  it("an account still on the old scheme signs in and is upgraded on that login; its PIN on the next right PIN", async () => {
    await db!.forTenant(T, (tx) => tx.user.update({ where: { id: DESK }, data: { passwordHash: legacyHash("setu1234"), pinHash: legacyHash("1234") } }), { userId: DESK });
    expect((await login("wrong-password")).statusCode).toBe(401);
    expect(isLegacyHash((await row())!.passwordHash)).toBe(true); // a wrong password upgrades nothing
    const ok = await login("setu1234");
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await row())!.passwordHash).toMatch(/^\$argon2id\$/);
    const cookie = [ok.headers["set-cookie"]].flat()[0] as string;
    const pin = (p: string) => app.inject({ method: "POST", url: "/v1/auth/pin/verify", payload: { pin: p }, headers: { cookie } });
    expect((await pin("9999")).json()).toMatchObject({ ok: false });
    expect(isLegacyHash((await row())!.pinHash)).toBe(true);
    expect((await pin("1234")).json()).toMatchObject({ ok: true });
    expect((await row())!.pinHash).toMatch(/^\$argon2id\$/);
    // and it still signs in with the same password afterwards
    expect((await login("setu1234")).statusCode).toBe(200);
  });
});
