/* HANDOVER gap 16 (Kamrul 09/10/2026): the database's "who did it" check never passes by default. lab_actor_ok() is
   true or false, never NULL: a write as setu_app with no app.user_id is refused on every guarded table, and the same
   write with the right actor gets past that rule (each pair runs in a transaction that is always rolled back). Jobs and
   gateway callbacks write as the tenant's system actor (forTenant { system: true }, decision 317). */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("actor-guards.test: DATABASE_URL_APP not set — SKIPPED");
const T = "t_e2e", CASHIER = "u_e2e_cashier";
let app: Awaited<ReturnType<typeof buildApp>>;
let cashierCookie = "", ownerCookie = "";

class Rollback { constructor(public error: unknown) {} }
/** a brand-new setu_app connection: app.user_id has never existed on it (current_setting(..., true) is NULL — the
    case the old function let through; a pooled connection that once carried a user reads '' instead) */
async function fresh<R>(fn: (c: InstanceType<NonNullable<typeof db>["PrismaClient"]>) => Promise<R>): Promise<R> {
  const url = new URL(process.env.DATABASE_URL_APP!); url.searchParams.set("connection_limit", "1");
  const c = new db!.PrismaClient({ datasourceUrl: url.toString() });
  try { return await fn(c); } finally { await c.$disconnect(); }
}
/** one statement as setu_app in tenant T, with app.user_id set to `actor` (null: never set, on a fresh connection);
    always rolled back */
async function attempt(actor: string | null, sql: string, ...params: unknown[]): Promise<string | null> {
  if (actor === null) return fresh((c) => run(c, null, sql, params));
  return run(db!.prisma, actor, sql, params);
}
async function run(client: { $transaction: typeof db extends null ? never : NonNullable<typeof db>["prisma"]["$transaction"] }, actor: string | null, sql: string, params: unknown[]): Promise<string | null> {
  try {
    await (client as NonNullable<typeof db>["prisma"]).$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${T}, true)`;
      if (actor) await tx.$executeRaw`SELECT set_config('app.user_id', ${actor}, true)`;
      let error: unknown = null;
      try { await tx.$executeRawUnsafe(sql, ...params); } catch (e) { error = e; }
      throw new Rollback(error);
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    return e.error ? String((e.error as Error).message) : null;
  }
  return null;
}
/** refused without a user for the actor rule; with the actor, whatever happens, not for that rule */
async function pair(actor: string, rule: RegExp, sql: string, ...params: unknown[]) {
  const none = await attempt(null, sql, ...params);
  expect(none, "no app.user_id").toMatch(rule);
  const empty = await attempt("", sql, ...params);
  expect(empty, "app.user_id ''").toMatch(rule);
  const other = await attempt("u_someone_else", sql, ...params);
  expect(other, "another user").toMatch(rule);
  const right = await attempt(actor, sql, ...params);
  expect(right ?? "", "the right actor").not.toMatch(rule);
}
const id = () => `t_${randomUUID().slice(0, 12)}`;

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  const login = async (phone: string) => { const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } }); const c = r.headers["set-cookie"]; return Array.isArray(c) ? c[0]! : (c as string); };
  cashierCookie = await login("01799000008"); ownerCookie = await login("01799000009");
});
afterAll(async () => { await app.close(); });

describe.runIf(db)("gap 16: lab_actor_ok() is never NULL", () => {
  it("unset or empty app.user_id → false; the same user → true; another → false", async () => {
    const ask = (c: NonNullable<typeof db>["prisma"], actor: string | null, uid: string | null) => c.$transaction(async (tx) => {
      if (actor !== null) await tx.$executeRaw`SELECT set_config('app.user_id', ${actor}, true)`;
      return (await tx.$queryRaw<{ ok: boolean | null }[]>`SELECT lab_actor_ok(${uid}::text) AS ok`)[0]!.ok;
    });
    const q = (actor: string | null, uid: string | null) => (actor === null ? fresh((c) => ask(c as NonNullable<typeof db>["prisma"], null, uid)) : ask(db!.prisma, actor, uid));
    expect(await q(null, "u_x")).toBe(false);
    expect(await q("", "u_x")).toBe(false);
    expect(await q(null, null)).toBe(false);
    expect(await q("u_x", "u_x")).toBe(true);
    expect(await q("u_x", "u_y")).toBe(false);
  });
  it("forTenant { system: true } writes as the tenant's system actor; { userId } as that user; never both", async () => {
    const who = (opts: { system?: boolean; userId?: string }) => db!.forTenant(T, async (tx) => (await tx.$queryRaw<{ u: string | null }[]>`SELECT nullif(current_setting('app.user_id', true), '') AS u`)[0]!.u, opts);
    expect(await who({ system: true })).toBe("sys_t_e2e");
    expect(await who({ userId: "u_e2e_doctor" })).toBe("u_e2e_doctor");
    expect(await who({})).toBeNull();
    await expect(db!.forTenant(T, async () => 1, { system: true, userId: "u_x" })).rejects.toThrow(/not both/);
  });
});

describe.runIf(db)("gap 16: a write with no signed-in user is refused on every guarded table", () => {
  it("Observation (a lab result)", async () => {
    await pair("u_tech", /entered by the signed-in user/,
      `INSERT INTO "Observation" ("id","tenantId","organizationId","branchId","patientId","encounterId","batchId","category","code","value","unit","status","recordedById","effectiveAt","serviceRequestId")
       VALUES ($1,'t_e2e','o_e2e','b','p','e','batch','laboratory','rbs',5,'mmol/L','preliminary','u_tech',now(),'sr')`, id());
  });
  it("CriticalCallback", async () => {
    await pair("u_tech", /logged by the signed-in user/,
      `INSERT INTO "CriticalCallback" ("id","tenantId","organizationId","patientId","encounterId","observationId","outcome","recipientRole","recipientName","via","calledAt","readBack","callerId")
       VALUES ($1,'t_e2e','o_e2e','p','e','obs','reached','ordering-doctor','Dr. X','phone',now(),true,'u_tech')`, id());
  });
  it("InboxAck", async () => {
    await pair("u_doc", /acknowledged by someone other than the signed-in user/,
      `INSERT INTO "InboxAck" ("id","tenantId","communicationId","ackedById") VALUES ($1,'t_e2e','com','u_doc')`, id());
  });
  it("MedicationAdministration (a dose on the MAR)", async () => {
    await pair("u_nurse", /recorded by someone other than the signed-in user/,
      `INSERT INTO "MedicationAdministration" ("id","tenantId","organizationId","encounterId","patientId","requestId","regimenId","medicineKey","status","administeredAt","administeredById","preparedById","timing","route","doseText","source")
       VALUES ($1,'t_e2e','o_e2e','e','p','mr','reg','napa','given',now(),'u_nurse','u_nurse','on-time','oral','1 tab','ward')`, id());
  });
  it("Handover (the ward's shift handover)", async () => {
    await pair("u_nurse", /started as a draft by the signed-in nurse/,
      `INSERT INTO "Handover" ("id","tenantId","organizationId","wardId","shiftDay","shiftStartHour","status","outgoingId")
       VALUES ($1,'t_e2e','o_e2e','w','2026-10-09',8,'draft','u_nurse')`, id());
  });
  it("ShiftCount and ShiftHandover (the cashier's drawer)", async () => {
    const call = (method: "GET" | "POST", url: string, payload?: object, cookie = cashierCookie) =>
      app.inject({ method, url, ...(payload ? { payload } : {}), headers: { cookie, ...(method === "POST" ? { "idempotency-key": randomUUID() } : {}) } });
    const approve = (sid: string) => call("POST", `/v1/shifts/${sid}/review`, { decision: "approve", note: "actor guard test (gap 16)" }, ownerCookie);
    let mine = (await call("GET", "/v1/shifts/mine")).json() as { shift: { id: string; status: string } | null };
    // a drawer an earlier run left counted or handed over is finished first (the cashier opens one shift at a time)
    if (mine.shift?.status === "counted") { await call("POST", `/v1/shifts/${mine.shift.id}/hand-over`, { reason: "actor guard test run (gap 16)" }); mine = (await call("GET", "/v1/shifts/mine")).json(); }
    if (mine.shift?.status === "closed") { expect((await approve(mine.shift.id)).statusCode).toBe(200); mine = (await call("GET", "/v1/shifts/mine")).json(); }
    if (!mine.shift || mine.shift.status !== "open") { expect((await call("POST", "/v1/shifts", { openingFloatPaisa: 100_000 })).statusCode).toBe(201); mine = (await call("GET", "/v1/shifts/mine")).json(); }
    const shift = mine.shift!;
    const owner = new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    try {
      const s = await owner.shift.findUniqueOrThrow({ where: { id: shift.id } });
      await pair(CASHIER, /the cashier counts their own drawer/,
        `INSERT INTO "ShiftCount" ("id","tenantId","shiftId","countNo","counts","countedPaisa","openingFloatPaisa","cashInPaisa","expectedCashPaisa","variancePaisa","digitalSystem","digitalSettlement","windowFrom","windowTo","countedById")
         VALUES ($1,'t_e2e',$2,1,'{}'::jsonb,0,$3,0,0,0,'{}'::jsonb,'{}'::jsonb,$4::timestamp,now(),'u_e2e_cashier')`, id(), shift.id, s.openingFloatPaisa, s.openedAt.toISOString().replace("Z", ""));
      // the count through the API, then the hand-over row itself
      const counted = (await call("POST", `/v1/shifts/${shift.id}/count`, { counts: {} })).json() as { status: string };
      expect(counted.status).toBe("counted");
      const after = await owner.shift.findUniqueOrThrow({ where: { id: shift.id } });
      await pair(CASHIER, /the cashier hands over their own drawer/,
        `INSERT INTO "ShiftHandover" ("id","tenantId","shiftId","countId","reason","byId") VALUES ($1,'t_e2e',$2,$3,'actor guard test, rolled back','u_e2e_cashier')`, id(), shift.id, after.latestCountId);
      // the drawer is handed over for real, so the cashier's next shift starts clean
      expect((await call("POST", `/v1/shifts/${shift.id}/hand-over`, { reason: "actor guard test run (gap 16)" })).statusCode).toBe(200);
      expect((await approve(shift.id)).statusCode).toBe(200);
    } finally { await owner.$disconnect(); }
  });
});
