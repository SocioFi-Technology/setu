/* Gap 10 (Kamrul 07/10/2026, option b): device keys and queued writes.
   - draft key: new at every sign-in (drafts of an earlier session become unreadable); outbox and queue keys: per user and
     device (a queued write survives the same person signing in again on the same device); none shared across users or
     devices; never in a stored idempotent answer;
   - a queued write goes on only for the user it was queued under (409 otherwise) and only with this user's and device's
     signature (400, audited and flagged otherwise) — the server checks, not only the client;
   - dropped entries reported by the device are audited and flagged. */
import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app?.close(); });
const T = "t_e2e_lite";
const NURSE = "01798000007", CASHIER = "01798000008";
const device = () => randomBytes(12).toString("base64url");
type Keys = { draft: string; outbox: string; queue: string };
async function signIn(phone: string, dev: string) {
  const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" }, headers: { "x-setu-device": dev }, remoteAddress: `10.4.${randomBytes(1)[0]}.${randomBytes(1)[0]}` });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.headers["cache-control"]).toBe("no-store");
  return { cookie: [r.headers["set-cookie"]].flat()[0] as string, me: r.json() as { userId: string; deviceKeys: Keys } };
}
const sign = (k: Keys, method: string, path: string, key: string) => createHmac("sha256", Buffer.from(k.queue, "base64url")).update(`${method} ${path} ${key}`).digest("base64url");

describe("device keys (gap 10)", () => {
  it("draft: new at each sign-in; outbox and queue: the same for this user on this device; different users or devices never share", async () => {
    const d1 = device(), d2 = device();
    const a = await signIn(NURSE, d1), b = await signIn(NURSE, d1), c = await signIn(NURSE, d2), other = await signIn(CASHIER, d1);
    expect(a.me.deviceKeys.draft).not.toBe(b.me.deviceKeys.draft);
    expect(a.me.deviceKeys.outbox).toBe(b.me.deviceKeys.outbox);
    expect(a.me.deviceKeys.queue).toBe(b.me.deviceKeys.queue);
    expect(c.me.deviceKeys.outbox).not.toBe(a.me.deviceKeys.outbox);
    expect(other.me.deviceKeys.outbox).not.toBe(a.me.deviceKeys.outbox);
    expect(new Set(Object.values(a.me.deviceKeys)).size).toBe(3);
    // /v1/me hands the same keys again during the session (a reload), not stored
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: a.cookie } });
    expect(me.json().deviceKeys).toEqual(a.me.deviceKeys);
    expect(me.headers["cache-control"]).toBe("no-store");
  });
});

describe.runIf(db)("queued writes (gap 10): the server sends one on only for its own user, signed by this device", () => {
  it("another user's queued write is refused (409, nothing done); a forged signature is refused (400, audited, flagged); a good one passes", async () => {
    const dev = device();
    const nurse = await signIn(NURSE, dev), cashier = await signIn(CASHIER, dev);
    const path = "/v1/device/dropped", key = `q-${randomBytes(6).toString("hex")}`;
    const send = (cookie: string, by: string, sig: string, k = key) => app.inject({ method: "POST", url: path, payload: { count: 1, reason: "foreign", kinds: ["write"] }, headers: { cookie, "idempotency-key": k, "x-setu-queued-by": by, "x-setu-queued-sig": sig } });
    // queued by the nurse, the cashier now signed in on that device
    const mismatch = await send(cashier.cookie, nurse.me.userId, sign(nurse.me.deviceKeys, "POST", path, key));
    expect([mismatch.statusCode, mismatch.json().code]).toEqual([409, "queued_by_other"]);
    // a copy planted with the right user but a signature made without this device's key
    const forged = await send(nurse.cookie, nurse.me.userId, createHmac("sha256", "not-the-key").update(`POST ${path} ${key}`).digest("base64url"));
    expect([forged.statusCode, forged.json().code]).toEqual([400, "queued_forged"]);
    const ev = await db!.forTenant(T, (tx) => tx.auditEvent.findFirst({ where: { action: "device-queue-refused", userId: nurse.me.userId }, orderBy: { at: "desc" } }));
    expect(ev).toMatchObject({ entity: "Device", entityId: dev });
    // a different path or key under the same signature is refused too (the signature binds both)
    expect((await app.inject({ method: "POST", url: path, payload: { count: 1, reason: "foreign", kinds: [] }, headers: { cookie: nurse.cookie, "idempotency-key": `${key}x`, "x-setu-queued-by": nurse.me.userId, "x-setu-queued-sig": sign(nurse.me.deviceKeys, "POST", path, key) } })).statusCode).toBe(400);
    // the genuine one passes — also after the same nurse signs in again on the same device (option b)
    const again = await signIn(NURSE, dev), k2 = `${key}-2`;
    const good = await send(again.cookie, again.me.userId, sign(nurse.me.deviceKeys, "POST", path, k2), k2);
    expect(good.statusCode, good.body).toBe(200);
    // but not from another device of the same nurse
    const elsewhere = await signIn(NURSE, device()), k3 = `${key}-3`;
    expect((await send(elsewhere.cookie, elsewhere.me.userId, sign(nurse.me.deviceKeys, "POST", path, k3), k3)).statusCode).toBe(400);
  });
  it("entries the device dropped are audited and flagged (the owner's audit log lists them)", async () => {
    const dev = device();
    const n = await signIn(NURSE, dev);
    const r = await app.inject({ method: "POST", url: "/v1/device/dropped", payload: { count: 2, reason: "tampered", kinds: ["draft"] }, headers: { cookie: n.cookie } });
    expect(r.statusCode).toBe(200);
    const ev = await db!.forTenant(T, (tx) => tx.auditEvent.findFirst({ where: { action: "device-entry-dropped", entityId: dev } }));
    expect(ev!.detail).toMatchObject({ count: 2, reason: "tampered", kinds: ["draft"], flag: "device-entry-dropped" });
    const { isFlagged } = await import("@setu/domain");
    expect(isFlagged("device-entry-dropped") && isFlagged("device-queue-refused")).toBe(true);
  });
  it("the first sign-in's stored answer (idempotency) never holds the keys", async () => {
    const rows = await db!.forTenant("t_e2e", (tx) => tx.idempotencyKey.findMany({ where: { route: { startsWith: "POST /v1/auth/first-sign-in" } }, orderBy: { createdAt: "desc" }, take: 5 }));
    for (const r of rows) expect(JSON.stringify(r.response)).not.toContain("deviceKeys");
  });
});
