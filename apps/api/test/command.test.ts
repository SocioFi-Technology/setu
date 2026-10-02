/* Step 2: a command's write, its AuditEvent and its IdempotencyKey commit together or not at all. Real database only. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { command } from "../src/command.js";
import { config } from "../src/config.js";
import { err } from "../src/errors.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("command.test: DATABASE_URL_APP not set — transaction tests SKIPPED");
const T = "t_greenlife";
let app: Awaited<ReturnType<typeof buildApp>>;
let runs = 0;
const probe = `cmdtest-${randomUUID()}`;

beforeAll(async () => {
  app = await buildApp();
  app.post("/test/probe", { config: { ownTx: true } }, async (req, reply) => command(req, reply, async (tx, s) => {
    runs++;
    const { name, fail } = req.body as { name: string; fail?: boolean };
    await tx.sequence.create({ data: { tenantId: s.tenantId, name, value: 1 } });
    if (fail) throw err(422, "probe_failed", "পরীক্ষা ব্যর্থ", "Probe failed after writing");
    return { status: 201, body: { name, run: runs }, audit: [{ action: "create", entity: "TestProbe", entityId: name }] };
  }));
});
afterAll(async () => {
  await db?.forTenant(T, (tx) => tx.sequence.deleteMany({ where: { name: { startsWith: probe } } }));
  await app.close();
});

const login = async () => {
  const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: "01711000001", password: "setu1234" } });
  const c = r.headers["set-cookie"]; return Array.isArray(c) ? c[0]! : (c as string);
};
const state = (name: string, key: string) => db!.forTenant(T, async (tx) => ({
  seq: await tx.sequence.count({ where: { name } }),
  audit: await tx.auditEvent.count({ where: { entity: "TestProbe", entityId: name } }),
  idem: await tx.idempotencyKey.count({ where: { key } }),
}));

describe.runIf(db)("command(): one transaction per request", () => {
  it("commits the write, its audit event and its idempotency key together; a replay does not run again", async () => {
    const cookie = await login(); const key = randomUUID(); const name = `${probe}-ok`;
    const a = await app.inject({ method: "POST", url: "/test/probe", headers: { cookie, "idempotency-key": key }, payload: { name } });
    expect(a.statusCode).toBe(201);
    expect(await state(name, key)).toEqual({ seq: 1, audit: 1, idem: 1 });
    const before = runs;
    const b = await app.inject({ method: "POST", url: "/test/probe", headers: { cookie, "idempotency-key": key }, payload: { name } });
    expect(b.statusCode).toBe(201); expect(b.headers["idempotent-replay"]).toBe("true"); expect(b.json()).toEqual(a.json());
    expect(runs).toBe(before);
    expect(await state(name, key)).toEqual({ seq: 1, audit: 1, idem: 1 });
  });

  it("rolls everything back when the command fails after writing", async () => {
    const cookie = await login(); const key = randomUUID(); const name = `${probe}-fail`;
    const r = await app.inject({ method: "POST", url: "/test/probe", headers: { cookie, "idempotency-key": key }, payload: { name, fail: true } });
    expect(r.statusCode).toBe(422); expect(r.json()).toMatchObject({ code: "probe_failed", message_bn: expect.any(String) });
    expect(await state(name, key)).toEqual({ seq: 0, audit: 0, idem: 0 });
  });

  it("a concurrent duplicate with the same key commits once", async () => {
    const cookie = await login(); const key = randomUUID(); const name = `${probe}-race`;
    const send = () => app.inject({ method: "POST", url: "/test/probe", headers: { cookie, "idempotency-key": key }, payload: { name } });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(await state(name, key)).toEqual({ seq: 1, audit: 1, idem: 1 });
  });

  it("a key reused with a different body is refused, not answered with the stored response", async () => {
    const cookie = await login(); const key = randomUUID();
    expect((await app.inject({ method: "POST", url: "/test/probe", headers: { cookie, "idempotency-key": key }, payload: { name: `${probe}-k1` } })).statusCode).toBe(201);
    const other = await app.inject({ method: "POST", url: "/test/probe", headers: { cookie, "idempotency-key": key }, payload: { name: `${probe}-k2` } });
    expect(other.statusCode).toBe(422); expect(other.json().code).toBe("idempotency_key_reused");
  });

  it("a key is scoped to the user: another user with the same key runs their own request", async () => {
    const key = randomUUID();
    const a = await app.inject({ method: "POST", url: "/test/probe", headers: { cookie: await login(), "idempotency-key": key }, payload: { name: `${probe}-u1` } });
    const r2 = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: "01711000010", password: "setu1234" } });
    const c2 = r2.headers["set-cookie"]; const cookie2 = Array.isArray(c2) ? c2[0]! : (c2 as string);
    const b = await app.inject({ method: "POST", url: "/test/probe", headers: { cookie: cookie2, "idempotency-key": key }, payload: { name: `${probe}-u2` } });
    expect(a.statusCode).toBe(201); expect(b.statusCode).toBe(201); expect(b.headers["idempotent-replay"]).toBeUndefined();
    expect(b.json().name).toBe(`${probe}-u2`);
  });

  it("refuses a write without Idempotency-Key", async () => {
    const cookie = await login();
    const r = await app.inject({ method: "POST", url: "/test/probe", headers: { cookie }, payload: { name: `${probe}-nokey` } });
    expect(r.statusCode).toBe(400); expect(r.json()).toMatchObject({ code: "idempotency_key_required" });
  });
});
