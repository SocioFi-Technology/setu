/* Production refusals in config.ts (external review A1; ADR 0016 review): each starts the config in a child process with
   NODE_ENV=production, from a folder with no .env, so only the variables given here are set. */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const configUrl = pathToFileURL(fileURLToPath(new URL("../src/config.ts", import.meta.url))).href;
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const bare = mkdtempSync(join(tmpdir(), "setu-config-"));
const S32 = "x".repeat(32);
const good = {
  NODE_ENV: "production", PUBLIC_APP_URL: "https://clinic.example", PAYMENTS_PROVIDER: "bkash", SMS_PROVIDER: "bulksmsbd",
  SESSION_SECRET: S32, WRISTBAND_SECRET: S32, DATABASE_URL_APP: "postgresql://setu_app:pw@localhost:5432/setu",
};
/** the startup error, or "" when the config loads */
function start(env: Record<string, string | undefined>): string {
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
  try {
    execFileSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", `await import(${JSON.stringify(configUrl)})`], { cwd: bare, env: { PATH: process.env.PATH ?? "", ...clean }, stdio: "pipe" });
    return "";
  } catch (e) { return String((e as { stderr?: Buffer }).stderr ?? e); }
}

describe("production refuses to start without its secrets (external review A1)", () => {
  it("starts with every secret set", () => { expect(start(good)).toBe(""); });
  it("SESSION_SECRET unset or under 32 characters", () => {
    expect(start({ ...good, SESSION_SECRET: undefined })).toContain("SESSION_SECRET (at least 32 characters) is required in production");
    expect(start({ ...good, SESSION_SECRET: "x".repeat(31) })).toContain("SESSION_SECRET (at least 32 characters) is required in production");
  });
  it("DATABASE_URL_APP missing — the in-memory demo login never serves in production", () => {
    expect(start({ ...good, DATABASE_URL_APP: undefined })).toContain("DATABASE_URL_APP is required in production");
  });
  it("WRISTBAND_SECRET still required", () => { expect(start({ ...good, WRISTBAND_SECRET: undefined })).toContain("WRISTBAND_SECRET"); });
  it("development is unchanged: no secrets, no database, the demo login", () => { expect(start({ NODE_ENV: "development" })).toBe(""); });
});
