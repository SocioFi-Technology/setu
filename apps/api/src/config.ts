import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
/* .env lives at the repo root; the API runs from apps/api. Load whichever exists, never overriding real env vars. */
for (const f of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) if (existsSync(f)) loadEnv({ path: f, override: false });

export const config = {
  port: Number(process.env.API_PORT ?? 4000),
  sessionSecret: process.env.SESSION_SECRET ?? "dev-only-secret-change-me-in-env-file",
  databaseUrl: process.env.DATABASE_URL,
  /** When no DATABASE_URL is set (first run, CI without Docker) the API serves /health and the demo login from memory. */
  dbEnabled: Boolean(process.env.DATABASE_URL),
  version: process.env.npm_package_version ?? "0.0.1",
  adapters: { payments: process.env.PAYMENTS_PROVIDER ?? "fake", sms: process.env.SMS_PROVIDER ?? "fake", ai: process.env.AI_PROVIDER ?? "fake" },
};
