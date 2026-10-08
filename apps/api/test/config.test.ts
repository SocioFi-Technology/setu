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
  SESSION_SECRET: S32, WRISTBAND_SECRET: S32, DATABASE_URL_APP: "postgresql://setu_app:pw@localhost:5432/setu", AI_PROVIDER: "off",
  REDIS_URL: "redis://localhost:6379", GATEWAY_TOKEN_KEY: S32, DEVICE_KEY_SECRET: "y".repeat(32),
  STORAGE: "s3", S3_ENDPOINT: "https://s3.example", S3_BUCKET: "setu", S3_ACCESS_KEY: "k", S3_SECRET_KEY: "s",
  VERIFY_BASE_URL: "https://clinic.example/verify/rc", TRUST_PROXY: "2",
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
  it("AI_PROVIDER=fake (or unset, which means fake) — the sample drafter never serves in production; off is allowed", () => {
    expect(start({ ...good, AI_PROVIDER: "fake" })).toContain("AI_PROVIDER=fake is not allowed in production");
    expect(start({ ...good, AI_PROVIDER: undefined })).toContain("AI_PROVIDER=fake is not allowed in production");
    expect(start({ ...good, AI_PROVIDER: "claude" })).toContain("AI_PROVIDER=claude is not available");
  });
  it("staging config: the public links are https, the proxy hops are stated, CORS lists origins only (https)", () => {
    expect(start({ ...good, VERIFY_BASE_URL: "http://clinic.example/verify/rc" })).toContain("VERIFY_BASE_URL must be https");
    expect(start({ ...good, VERIFY_DOC_ROOT_URL: "http://clinic.example/verify" })).toContain("VERIFY_DOC_ROOT_URL must be https");
    expect(start({ ...good, TRUST_PROXY: undefined })).toContain("TRUST_PROXY");
    expect(start({ ...good, CORS_ORIGINS: "http://other.example" })).toContain("CORS_ORIGINS");
    expect(start({ ...good, CORS_ORIGINS: "https://other.example/path" })).toContain("CORS_ORIGINS");
    expect(start({ ...good, CORS_ORIGINS: "https://patient.example, https://doctor.example" })).toBe("");
  });
  it("STORAGE other than s3 in production — files never live on a container's disk (staging)", () => {
    expect(start({ ...good, STORAGE: undefined })).toContain("STORAGE=s3 is required");
    expect(start({ ...good, STORAGE: "local" })).toContain("STORAGE=s3 is required");
  });
  it("DEVICE_KEY_SECRET missing, short, or the session secret — the device keys need their own (gap 10)", () => {
    expect(start({ ...good, DEVICE_KEY_SECRET: undefined })).toContain("DEVICE_KEY_SECRET");
    expect(start({ ...good, DEVICE_KEY_SECRET: "short" })).toContain("DEVICE_KEY_SECRET");
    expect(start({ ...good, DEVICE_KEY_SECRET: S32 })).toContain("must differ from SESSION_SECRET");
  });
  it("GATEWAY_TOKEN_KEY missing or short — the gateway tokens are stored encrypted (review B6)", () => {
    expect(start({ ...good, GATEWAY_TOKEN_KEY: undefined })).toContain("GATEWAY_TOKEN_KEY");
    expect(start({ ...good, GATEWAY_TOKEN_KEY: "short" })).toContain("GATEWAY_TOKEN_KEY");
  });
  it("REDIS_URL missing — login and PIN tries must be counted in one place (review A3)", () => {
    expect(start({ ...good, REDIS_URL: undefined })).toContain("REDIS_URL is required in production");
  });
  it("the fake gateway and SMS: refused in production, allowed only with SETU_STAGE=staging (Kamrul, 08/10/2026)", () => {
    expect(start({ ...good, PAYMENTS_PROVIDER: "fake" })).toContain("PAYMENTS_PROVIDER=fake is not allowed in production");
    expect(start({ ...good, SMS_PROVIDER: "fake" })).toContain("SMS_PROVIDER=fake is not allowed in production");
    expect(start({ ...good, PAYMENTS_PROVIDER: "fake", SMS_PROVIDER: "fake", SETU_STAGE: "staging" })).toBe("");
    expect(start({ ...good, PAYMENTS_PROVIDER: "fake", SETU_STAGE: "prod" })).toContain("SETU_STAGE");
    // the fake AI is not covered by the stage: staging runs AI_PROVIDER=off
    expect(start({ ...good, AI_PROVIDER: "fake", SETU_STAGE: "staging" })).toContain("AI_PROVIDER=fake is not allowed in production");
  });
  it("development is unchanged: no secrets, no database, the demo login", () => { expect(start({ NODE_ENV: "development" })).toBe(""); });
});

describe("AI_PROVIDER=off (external review A1)", () => {
  it("no drafter: the AI-draft route answers ai_off and the profile says ai: false", async () => {
    const { config } = await import("../src/config.js");
    const { aiDrafter, aiEnabled } = await import("../src/adapters/ai.js");
    const was = config.adapters.ai;
    try {
      config.adapters.ai = "off";
      expect(aiDrafter()).toBeNull(); expect(aiEnabled()).toBe(false);
      config.adapters.ai = "fake";
      expect(aiDrafter()?.model).toBe("fake-ai-v1");
    } finally { config.adapters.ai = was; }
  });
});
