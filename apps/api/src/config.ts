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
  /** external review A3: login failures, account locks and PIN tries are shared through Redis (in memory without it) */
  redisUrl: process.env.REDIS_URL,
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
// external review A1: sessions are signed with the published dev secret, and with no DATABASE_URL_APP the API serves the
// in-memory demo login — neither may ever run in production
if (process.env.NODE_ENV === "production" && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) throw new Error("SESSION_SECRET (at least 32 characters) is required in production");
if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL_APP) throw new Error("DATABASE_URL_APP is required in production (without it the API would serve the in-memory demo login)");
// external review A1: the fake AI writes deterministic sample drafts — production runs a real provider, or AI_PROVIDER=off
// (no drafts; the consultation's AI panel is hidden). The Claude adapter is a later change.
if (process.env.NODE_ENV === "production" && config.adapters.ai === "fake") throw new Error("AI_PROVIDER=fake is not allowed in production (set AI_PROVIDER=off until a real provider is configured)");
// external review A3 (gap 4): with several API instances, login and PIN tries must be counted in one place
if (process.env.NODE_ENV === "production" && !process.env.REDIS_URL) throw new Error("REDIS_URL is required in production (login and PIN tries are counted there)");
// external review B6: the stored bKash tokens are encrypted with this key (a refresh token lives 30 days)
if (process.env.NODE_ENV === "production" && (!process.env.GATEWAY_TOKEN_KEY || process.env.GATEWAY_TOKEN_KEY.length < 32)) throw new Error("GATEWAY_TOKEN_KEY (at least 32 characters) is required in production (the payment gateway's tokens are stored encrypted with it)");
// gap 10: the device keys (drafts, queued writes) come from their own secret in production — never the session's
if (process.env.NODE_ENV === "production" && (!process.env.DEVICE_KEY_SECRET || process.env.DEVICE_KEY_SECRET.length < 32)) throw new Error("DEVICE_KEY_SECRET (at least 32 characters) is required in production (the device keys are derived from it)");
if (process.env.NODE_ENV === "production" && process.env.DEVICE_KEY_SECRET === process.env.SESSION_SECRET) throw new Error("DEVICE_KEY_SECRET must differ from SESSION_SECRET");
// staging (week 2): files live in object storage in production — never a container's own disk
if (process.env.NODE_ENV === "production" && process.env.STORAGE !== "s3") throw new Error("STORAGE=s3 is required in production (with S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY)");
if (!["fake", "off"].includes(config.adapters.ai)) throw new Error(`AI_PROVIDER=${config.adapters.ai} is not available (fake, off)`);
