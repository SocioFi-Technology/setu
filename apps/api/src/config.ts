import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
/* .env lives at the repo root; the API runs from apps/api. Load whichever exists, never overriding real env vars. */
for (const f of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) if (existsSync(f)) loadEnv({ path: f, override: false });

export const config = {
  port: Number(process.env.API_PORT ?? 4000),
  sessionSecret: process.env.SESSION_SECRET ?? "dev-only-secret-change-me-in-env-file",
  /** ADR 0016: signs wristband QR codes (defaults to the session secret; rotating it invalidates printed bands) */
  wristbandSecret: process.env.WRISTBAND_SECRET ?? process.env.SESSION_SECRET ?? "dev-only-secret-change-me-in-env-file",
  /** The API connects as setu_app (RLS applies). DATABASE_URL is the owner and is only for migrations and the seed. */
  databaseUrl: process.env.DATABASE_URL_APP,
  /** When no database URL is set (first run, CI without Docker) the API serves /health and the demo login from memory. */
  dbEnabled: Boolean(process.env.DATABASE_URL_APP),
  version: process.env.npm_package_version ?? "0.0.1",
  /** What a receipt's QR opens: the staff app's public page /verify/rc/<code> (no login, no patient details). */
  verifyBaseUrl: (process.env.VERIFY_BASE_URL ?? "http://localhost:3000/verify/rc").replace(/\/+$/, ""),
  /** ADR 0011: the staff app's public origin. The patient's phone reaches us through it: the short payment link
      (<origin>/p/<code>), bKash's return (<origin>/api/v1/payments/return/bkash) and the result page (<origin>/pay/result). */
  publicAppUrl: (process.env.PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
  get publicApiUrl() { return `${this.publicAppUrl}/api`; },
  /** ADR 0012: the gap between two payment-link SMS for one payment (tests shorten it; never below 1 s) */
  linkSmsGapMs: Math.max(1_000, Number(process.env.LINK_SMS_GAP_MS) || 60_000),
  /** The fake gateway's "play the customer" route (dev and tests only). Off unless FAKE_PAYMENTS_DEV_ROUTE=1, and never
      in production (security review A6–A7: a cashier must not be able to mark a payment paid without money). */
  fakePaymentsDevRoute: process.env.FAKE_PAYMENTS_DEV_ROUTE === "1" && process.env.NODE_ENV !== "production",
  /** The fake SMS gateway's dev helpers (make the next SMS fail, list what was "sent"). Off unless
      FAKE_MESSAGING_DEV_ROUTE=1, and never in production. */
  fakeMessagingDevRoute: process.env.FAKE_MESSAGING_DEV_ROUTE === "1" && process.env.NODE_ENV !== "production",
  /** dev and tests only: POST /v1/dev/rollup/run (ADR 0008) — ROLLUP_DEV_ROUTE=1, never in production. */
  rollupDevRoute: process.env.ROLLUP_DEV_ROUTE === "1" && process.env.NODE_ENV !== "production",
  /** decision 235: the owner may settle a gateway refund by hand only after it has been "processing" this long */
  refundReleaseMinutes: Number(process.env.REFUND_RELEASE_MINUTES ?? 30),
  adapters: { payments: process.env.PAYMENTS_PROVIDER ?? "fake", sms: process.env.SMS_PROVIDER ?? "fake", ai: process.env.AI_PROVIDER ?? "fake" },
};

/* An owner URL without the app URL means an old .env: refuse to start rather than silently run without the database
   (or, worse, as the owner, which ignores row-level security). */
if (process.env.DATABASE_URL && !process.env.DATABASE_URL_APP)
  throw new Error("DATABASE_URL_APP is missing from .env. Add it from .env.example and run `pnpm db:migrate` (the API connects as setu_app, never as the owner).");

/* The fake gateway is for dev and tests: a production API refuses to start with it (or with its published secret). */
if (process.env.NODE_ENV === "production" && !/^https:\/\//.test(config.publicAppUrl)) throw new Error("PUBLIC_APP_URL must be https in production (payment links and bKash's return use it)");
if (process.env.NODE_ENV === "production" && config.adapters.payments === "fake") throw new Error("PAYMENTS_PROVIDER=fake is not allowed in production");
if (process.env.NODE_ENV === "production" && config.adapters.sms === "fake") throw new Error("SMS_PROVIDER=fake is not allowed in production");
// ADR 0016 review: wristbands are forged with the published dev secret — production sets its own
if (process.env.NODE_ENV === "production" && (!process.env.WRISTBAND_SECRET || process.env.WRISTBAND_SECRET.length < 32)) throw new Error("WRISTBAND_SECRET (at least 32 characters) is required in production");
