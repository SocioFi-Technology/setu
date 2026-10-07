/* Gap 10: the setu_app password is sent to Postgres as a SCRAM-SHA-256 verifier, never in clear. A temporary role
   proves Postgres accepts the verifier computed here (the right password signs in, a wrong one does not). */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;

describe("SCRAM verifier (gap 10)", () => {
  it("has Postgres's shape and never contains the password", async () => {
    const { scramVerifier } = await import("@setu/db");
    const v = scramVerifier("setu_app_dev", Buffer.alloc(16, 7));
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(v).not.toContain("setu_app_dev");
    expect(scramVerifier("setu_app_dev", Buffer.alloc(16, 7))).toBe(v); // deterministic for a salt
    expect(scramVerifier("setu_app_dev")).not.toBe(v); // a fresh salt each time
    expect(() => scramVerifier("with space")).toThrow(/ASCII/);
  });
});

describe.runIf(db)("Postgres accepts the verifier (gap 10)", () => {
  it("a role given only the verifier signs in with the password, not with another", { timeout: 30_000 }, async () => {
    const owner = new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    const role = `setu_scram_${randomBytes(4).toString("hex")}`, password = `pw_${randomBytes(8).toString("hex")}`;
    const url = (pw: string) => { const u = new URL(process.env.DATABASE_URL!); u.username = role; u.password = pw; return u.toString(); };
    try {
      await owner.$executeRawUnsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${db!.scramVerifier(password)}'`);
      const [{ pw }] = await owner.$queryRawUnsafe<{ pw: string }[]>(`SELECT rolpassword AS pw FROM pg_authid WHERE rolname = '${role}'`);
      expect(pw).toMatch(/^SCRAM-SHA-256\$4096:/);
      expect(pw).not.toContain(password);
      const ok = new db!.PrismaClient({ datasourceUrl: url(password) });
      try { expect(await ok.$queryRawUnsafe<{ one: number }[]>("SELECT 1 AS one")).toEqual([{ one: 1 }]); } finally { await ok.$disconnect(); }
      const bad = new db!.PrismaClient({ datasourceUrl: url(`${password}x`) });
      try { await expect(bad.$queryRawUnsafe("SELECT 1")).rejects.toThrow(); } finally { await bad.$disconnect(); }
      // and setu_app itself holds a verifier, not a clear or md5 password
      const [{ app }] = await owner.$queryRawUnsafe<{ app: string }[]>("SELECT rolpassword AS app FROM pg_authid WHERE rolname = 'setu_app'");
      expect(app).toMatch(/^SCRAM-SHA-256\$/);
    } finally {
      await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
      await owner.$disconnect();
    }
  });
});
