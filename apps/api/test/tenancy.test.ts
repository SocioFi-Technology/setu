/* Known gap 1: row-level security must hold for the role the API actually connects as.
   Runs against the real database (DATABASE_URL_APP); skipped, loudly, when the database is off. */
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("tenancy.test: DATABASE_URL_APP not set — RLS contract tests SKIPPED");
afterAll(async () => { await db?.prisma.$disconnect(); });

describe.runIf(db)("row-level security as setu_app", () => {
  it("connects as a role that is neither superuser nor BYPASSRLS", async () => {
    const [r] = await db!.prisma.$queryRaw<{ user: string; super: boolean; bypass: boolean }[]>`SELECT current_user AS user, rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
    expect(r).toEqual({ user: "setu_app", super: false, bypass: false });
  });

  it("a query with app.tenant_id set to another tenant returns no rows", async () => {
    const own = await db!.forTenant("t_greenlife", (tx) => tx.patient.count());
    const other = await db!.forTenant("t_other", (tx) => tx.patient.findMany());
    expect(own).toBeGreaterThan(0); // the seed has patients, so an empty result below is RLS, not an empty table
    expect(other).toEqual([]);
    expect(await db!.forTenant("t_other", (tx) => tx.user.findMany())).toEqual([]);
    expect(await db!.forTenant("t_other", (tx) => tx.tenant.findMany())).toEqual([]);
  });

  it("returns no rows when app.tenant_id is not set at all", async () => {
    expect(await db!.prisma.patient.findMany()).toEqual([]);
    expect(await db!.prisma.user.findMany()).toEqual([]);
  });

  it("cannot write a row into another tenant", async () => {
    await expect(db!.forTenant("t_greenlife", (tx) => tx.sequence.create({ data: { tenantId: "t_other", name: "rls-probe" } }))).rejects.toThrow();
  });

  it("cannot change or delete the audit log", async () => {
    await expect(db!.forTenant("t_greenlife", (tx) => tx.auditEvent.updateMany({ data: { action: "x" } }))).rejects.toThrow();
    await expect(db!.forTenant("t_greenlife", (tx) => tx.auditEvent.deleteMany({}))).rejects.toThrow();
  });

  it("login lookup returns only the login fields, never PIN hashes", async () => {
    const rows = await db!.loginLookup(["1711000001", "01711000001"], null);
    expect(rows).toHaveLength(1);
    // ADR 0010 adds what the first sign-in and the session generation need — still never the PIN hash
    expect(Object.keys(rows[0]!).sort()).toEqual(["email", "id", "mustChangePassword", "nameBn", "nameEn", "passwordHash", "phone", "plan", "roles", "sessionGeneration", "tempPasswordExpiresAt", "tempPasswordUsedAt", "tenantId"].sort());
    expect(rows[0]).not.toHaveProperty("pinHash");
  });
});

describe.runIf(db)("gap 10: a reference never crosses tenants — the database's own check, beside row-level security", () => {
  // on the owner's connection (no RLS): what refuses these is the key or the trigger, not the policy
  const ownerDb = () => new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  it("a visit or a patient link pointing at another tenant's patient is refused (composite foreign keys)", async () => {
    const o = ownerDb();
    try {
      const mine = (await o.patient.findFirst({ where: { tenantId: "t_e2e" } }))!;
      const theirs = (await o.patient.findFirst({ where: { tenantId: "t_e2e_lite" } }))!;
      const enc = (await o.encounter.findFirst({ where: { tenantId: "t_e2e" } }))!;
      await expect(o.$executeRawUnsafe(`UPDATE "Encounter" SET "patientId" = $1 WHERE "id" = $2`, theirs.id, enc.id)).rejects.toThrow(/Encounter_tenant_patient_fkey|never|foreign key/i);
      await expect(o.$executeRawUnsafe(`UPDATE "Patient" SET "linkedToId" = $1 WHERE "id" = $2`, theirs.id, mine.id)).rejects.toThrow(/Patient_tenant_linkedTo_fkey/);
    } finally { await o.$disconnect(); }
  });
  it("a task's focus or candidate, and a provenance target, of another tenant are refused (by kind / type)", async () => {
    const o = ownerDb();
    try {
      const theirs = (await o.patient.findFirst({ where: { tenantId: "t_e2e_lite" } }))!;
      const mine = (await o.patient.findFirst({ where: { tenantId: "t_e2e" } }))!;
      const theirInvoice = (await o.invoice.findFirst({ where: { tenantId: "t_e2e_lite" } }))!;
      const base = { tenantId: "t_e2e", status: "requested" as const, requestedById: "u_e2e_desk", requestedAt: new Date(), reason: "cross-tenant check" };
      await expect(o.task.create({ data: { ...base, kind: "patient-link-review", focusId: theirs.id } })).rejects.toThrow(/not a Patient of this tenant/);
      await expect(o.task.create({ data: { ...base, kind: "patient-link-review", focusId: mine.id, candidateId: theirs.id } })).rejects.toThrow(/candidate .* not a Patient of this tenant/);
      await expect(o.task.create({ data: { ...base, kind: "discount-approval", focusId: theirInvoice.id } })).rejects.toThrow(/not a Invoice of this tenant/);
      const pv = { tenantId: "t_e2e", activity: "cross-tenant check", agentId: "u_e2e_desk", onBehalfOf: "o_e2e", source: "provider_verified" as const };
      await expect(o.provenance.create({ data: { ...pv, targetType: "Patient", targetId: theirs.id } })).rejects.toThrow(/not of this tenant/);
      await expect(o.provenance.create({ data: { ...pv, targetType: "Nothing", targetId: mine.id } })).rejects.toThrow(/unknown target type/);
    } finally { await o.$disconnect(); }
  });
});

describe.runIf(db)("decision 317: each tenant's system actor", () => {
  const ownerDb = () => new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  it("exists for every tenant, inactive, with no password, PIN, phone or role — it can never sign in or be given a role", async () => {
    const o = ownerDb();
    try {
      const tenants = await o.tenant.findMany({ select: { id: true } });
      const sys = await o.user.findMany({ where: { system: true }, include: { roles: true } });
      expect(sys.map((u) => u.tenantId).sort()).toEqual(tenants.map((t) => t.id).sort());
      for (const u of sys) expect(u).toMatchObject({ id: `sys_${u.tenantId}`, active: false, passwordHash: "!", pinHash: null, phone: null, email: null, roles: [] });
      await expect(o.practitionerRole.create({ data: { tenantId: "t_e2e", userId: "sys_t_e2e", organizationId: "o_e2e", role: "owner" } })).rejects.toThrow(/holds no role/);
      await expect(o.user.update({ where: { id: "sys_t_e2e" }, data: { active: true } })).rejects.toThrow(/user_system_shape/);
      await expect(o.user.update({ where: { id: "sys_t_e2e" }, data: { passwordHash: "x" } })).rejects.toThrow(/user_system_shape/);
    } finally { await o.$disconnect(); }
  });
  it("a sign-in never reaches it (no identifier to sign in with)", async () => {
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    try {
      for (const identifier of ["sys_t_e2e", "Setu (system)"]) {
        const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier, password: "!" }, remoteAddress: "10.3.3.3" });
        expect([400, 401]).toContain(r.statusCode);
      }
    } finally { await app.close(); }
  });
});

