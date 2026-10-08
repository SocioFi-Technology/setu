/* Review C: modules/pin.ts and modules/users.ts on their own (Redis for the PIN tries, the real database for the users):
   - the signing PIN: a right PIN passes and clears the count; wrong ones count `triesLeft` down; PIN_MAX wrong tries
     lock it for PIN_LOCK_MS (even the right PIN, without asking it); requirePin / requireUserPin throw pin_wrong /
     pin_locked; an old-style PIN hash is upgraded on the right PIN;
   - the users: checkPassword / checkPin against argon2 hashes (right, wrong, empty), the login lookup by either stored
     phone spelling (10 digits, or with the leading 0) and any typed form, and an inactive user is never found.
   Each test clears the Redis keys it makes, so nothing stays locked for the other files. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { closeCounters, counters } from "../src/adapters/counters.js";
import { HttpError } from "../src/errors.js";
import { PIN_LOCK_MS, PIN_MAX, checkPinAttempt, requirePin, requireUserPin } from "../src/modules/pin.js";
import { hashSecret, legacyHash } from "../src/modules/secrets.js";
import { checkPassword, checkPin, findLoginCandidates, findUserById, type UserRecord } from "../src/modules/users.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("pin-users.test: DATABASE_URL_APP not set — the user lookups are SKIPPED");
const RUN = randomUUID().slice(0, 6);
const T = "t_e2e";
afterAll(async () => { await closeCounters(); });

const keys = (id: string) => [`pin:tries:${id}`, `pin:lock:${id}`];
/** the HttpError a call throws (status and body), or null when it passes */
const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { if (e instanceof HttpError) return { status: e.status, ...e.body }; throw e; } };

describe("review C: the signing PIN (modules/pin.ts)", () => {
  it("review C: a right PIN passes and clears the count; wrong PINs count triesLeft down", async () => {
    const id = `u_pin_${RUN}_a`, c = counters();
    try {
      expect(await checkPinAttempt(id, () => false)).toEqual({ ok: false, triesLeft: PIN_MAX - 1 });
      expect(await checkPinAttempt(id, async () => false)).toEqual({ ok: false, triesLeft: PIN_MAX - 2 });
      expect(await c.get(`pin:tries:${id}`)).toBe(2);
      const ttl = await c.ttlMs(`pin:tries:${id}`);
      expect(ttl).toBeGreaterThan(0); expect(ttl).toBeLessThanOrEqual(PIN_LOCK_MS);
      expect(await checkPinAttempt(id, () => true)).toEqual({ ok: true });
      expect(await c.get(`pin:tries:${id}`)).toBe(0); // the count starts again
      expect(await checkPinAttempt(id, () => false)).toEqual({ ok: false, triesLeft: PIN_MAX - 1 });
    } finally { await c.del(...keys(id)); }
  });

  it("review C: PIN_MAX wrong tries lock the PIN for PIN_LOCK_MS — the right PIN is refused without being checked; requirePin says pin_locked", async () => {
    const id = `u_pin_${RUN}_b`, c = counters();
    try {
      for (let i = 1; i < PIN_MAX; i++) expect(await checkPinAttempt(id, () => false)).toEqual({ ok: false, triesLeft: PIN_MAX - i });
      const t0 = Date.now();
      const last = await checkPinAttempt(id, () => false);
      expect(last).toMatchObject({ ok: false, triesLeft: 0, lockedUntil: expect.any(String) });
      const until = Date.parse((last as { lockedUntil: string }).lockedUntil);
      expect(until - t0).toBeGreaterThanOrEqual(PIN_LOCK_MS - 1_000); expect(until - t0).toBeLessThanOrEqual(PIN_LOCK_MS + 5_000);
      expect(await c.ttlMs(`pin:lock:${id}`)).toBeGreaterThan(PIN_LOCK_MS - 10_000);
      expect(await c.get(`pin:tries:${id}`)).toBe(0); // the lock replaces the count
      let asked = false;
      expect(await checkPinAttempt(id, () => { asked = true; return true; })).toMatchObject({ ok: false, triesLeft: 0, lockedUntil: expect.any(String) });
      expect(asked).toBe(false);
      expect(await refusal(requirePin(id, () => true))).toMatchObject({ status: 423, code: "pin_locked", triesLeft: 0, lockedUntil: expect.any(String) });
      // the lock ends (here: cleared): the right PIN passes again
      await c.del(`pin:lock:${id}`);
      expect(await refusal(requirePin(id, () => true))).toBeNull();
    } finally { await c.del(...keys(id)); }
  });

  it("review C: requirePin throws 401 pin_wrong with the tries left (field pin); a right PIN resolves", async () => {
    const id = `u_pin_${RUN}_c`, c = counters();
    try {
      expect(await refusal(requirePin(id, () => false))).toMatchObject({ status: 401, code: "pin_wrong", field: "pin", triesLeft: PIN_MAX - 1 });
      expect(await refusal(requirePin(id, async () => false))).toMatchObject({ status: 401, code: "pin_wrong", triesLeft: PIN_MAX - 2 });
      expect(await refusal(requirePin(id, () => true))).toBeNull();
      expect(await c.get(`pin:tries:${id}`)).toBe(0);
    } finally { await c.del(...keys(id)); }
  });
});

describe.runIf(db)("review C: the users (modules/users.ts) and requireUserPin", () => {
  const phone10 = `19${String(randomInt(0, 1e8)).padStart(8, "0")}`; // stored as 10 digits, like the admin screen stores it
  const PASSWORD = "reviewc2026", PIN = "2468";
  let userId = "";
  const asOwner = <R>(fn: (tx: NonNullable<typeof db>["prisma"]) => Promise<R>) => db!.forTenant(T, fn as never, { userId: "u_e2e_owner" }) as Promise<R>;

  it("review C: findLoginCandidates finds a user by either stored phone spelling and any typed form; checkPassword right / wrong / empty", async () => {
    const [passwordHash, pinHash] = await Promise.all([hashSecret(PASSWORD), hashSecret(PIN)]);
    const u = await asOwner((tx) => tx.user.create({ data: { tenantId: T, nameBn: "পিন পরীক্ষা", nameEn: `Pin Test ${RUN}`, phone: phone10, passwordHash, pinHash } }));
    userId = u.id;
    await asOwner((tx) => tx.practitionerRole.create({ data: { tenantId: T, userId: u.id, organizationId: "o_e2e", role: "receptionist" } }));
    // stored without the 0: found by the 11-digit number, the bare 10 digits, +880 and with spaces / dashes
    for (const typed of [`0${phone10}`, phone10, `+880${phone10}`, `+880 ${phone10.slice(0, 4)}-${phone10.slice(4)}`, `880${phone10}`]) {
      const found = await findLoginCandidates(typed);
      expect(found.map((x) => x.id), typed).toEqual([u.id]);
    }
    const [cand] = await findLoginCandidates(`0${phone10}`);
    expect(cand).toMatchObject({ tenantId: T, nameEn: `Pin Test ${RUN}`, plan: "pro", mustChangePassword: false, sessionGeneration: 0, roles: [{ organizationId: "o_e2e", role: "receptionist", organizationName: "E2E Test Clinic" }] });
    // a seeded user stored with the leading 0 (01799000002): found by the bare 10 digits and +880 too
    for (const typed of ["01799000002", "1799000002", "+8801799000002"]) expect((await findLoginCandidates(typed)).map((x) => x.id), typed).toEqual(["u_e2e_doctor"]);
    expect(await findLoginCandidates(`01600${String(randomInt(0, 1e6)).padStart(6, "0")}`)).toEqual([]); // nobody has it
    expect(await findLoginCandidates("")).toEqual([]);
    // the password against its argon2 hash
    expect(await checkPassword(cand!, PASSWORD)).toEqual({ ok: true, rehash: false });
    expect(await checkPassword(cand!, "reviewc2027")).toEqual({ ok: false, rehash: false });
    expect(await checkPassword(cand!, "")).toEqual({ ok: false, rehash: false });
    // the login lookup never carries the PIN hash: no PIN matches on a candidate
    expect(cand!.pinHash).toBeUndefined();
    expect(await checkPin(cand!, PIN)).toEqual({ ok: false, rehash: false });
    // an old-style hash still verifies and asks for a re-hash
    const legacy: UserRecord = { ...cand!, passwordHash: legacyHash(PASSWORD), pinHash: legacyHash(PIN) };
    expect(await checkPassword(legacy, PASSWORD)).toEqual({ ok: true, rehash: true });
    expect(await checkPin(legacy, "1357")).toEqual({ ok: false, rehash: false });
  });

  it("review C: findUserById reads the user under its own tenant with the PIN hash; checkPin right / wrong / empty", async () => {
    expect(userId).not.toBe("");
    const u = await findUserById(T, userId);
    expect(u).toMatchObject({ id: userId, tenantId: T, phone: phone10, plan: "pro", roles: [{ organizationId: "o_e2e", role: "receptionist" }] });
    expect(await checkPin(u!, PIN)).toEqual({ ok: true, rehash: false });
    expect(await checkPin(u!, "1357")).toEqual({ ok: false, rehash: false });
    expect(await checkPin(u!, "")).toEqual({ ok: false, rehash: false });
    expect(await checkPassword(u!, PASSWORD)).toEqual({ ok: true, rehash: false });
    expect(await findUserById("t_e2e_lite", userId)).toBeNull(); // another tenant does not see it
    expect(await findUserById(T, `u_none_${RUN}`)).toBeNull();
  });

  it("review C: requireUserPin — the user's own PIN passes, a wrong one counts (pin_wrong), an old-style PIN hash is upgraded on the right PIN", async () => {
    expect(userId).not.toBe("");
    const c = counters();
    const sign = (pin: string) => refusal(db!.forTenant(T, (tx) => requireUserPin(tx, userId, pin), { userId }));
    try {
      expect(await sign(PIN)).toBeNull();
      expect(await sign("1357")).toMatchObject({ status: 401, code: "pin_wrong", triesLeft: PIN_MAX - 1 });
      expect(await c.get(`pin:tries:${userId}`)).toBe(1);
      expect(await sign(PIN)).toBeNull();
      expect(await c.get(`pin:tries:${userId}`)).toBe(0);
      // an account still on the old scheme: the right PIN passes and is stored as argon2id in the same transaction
      await db!.forTenant(T, (tx) => tx.user.update({ where: { id: userId }, data: { pinHash: legacyHash(PIN) } }), { userId });
      expect(await sign("1357")).toMatchObject({ code: "pin_wrong" });
      expect((await findUserById(T, userId))!.pinHash).toBe(legacyHash(PIN)); // a wrong PIN upgrades nothing
      expect(await sign(PIN)).toBeNull();
      expect((await findUserById(T, userId))!.pinHash).toMatch(/^\$argon2id\$/);
      expect(await sign(PIN)).toBeNull();
      // a user with no PIN set never passes
      expect(await refusal(db!.forTenant(T, (tx) => requireUserPin(tx, `u_none_${RUN}`, PIN)))).toMatchObject({ code: "pin_wrong" });
    } finally { await c.del(...keys(userId), ...keys(`u_none_${RUN}`)); }
  });

  it("review C: an inactive user is never found — not by findUserById, not at the login lookup", async () => {
    expect(userId).not.toBe("");
    await asOwner((tx) => tx.user.update({ where: { id: userId }, data: { active: false, deactivatedAt: new Date(), deactivatedReason: "review C test user, no longer needed" } }));
    expect(await findUserById(T, userId)).toBeNull();
    expect(await findLoginCandidates(`0${phone10}`)).toEqual([]);
    expect(await findLoginCandidates(phone10)).toEqual([]);
  });
});
