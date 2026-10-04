/* Starts the local bKash sandbox stand-in (ADR 0011) for the hands-on: `pnpm --filter @setu/api bkash:standin`.
   Prints the .env settings that point an API at it. Not part of the API build that runs in production. */
import { BkashSandboxStandIn, STANDIN_CREDENTIALS } from "../adapters/payments/bkash-standin.js";

const port = Number(process.env.BKASH_STANDIN_PORT ?? 4199);
const s = new BkashSandboxStandIn();
const api = await s.start({ port, host: process.env.BKASH_STANDIN_HOST ?? "127.0.0.1" });
console.log(`bKash stand-in on ${s.baseUrl} — wallet 01770618575, OTP 123456, PIN 12121. API settings:
PAYMENTS_PROVIDER=bkash
BKASH_BASE_URL=${api}
BKASH_APP_KEY=${STANDIN_CREDENTIALS.appKey}
BKASH_APP_SECRET=${STANDIN_CREDENTIALS.appSecret}
BKASH_USERNAME=${STANDIN_CREDENTIALS.username}
BKASH_PASSWORD=${STANDIN_CREDENTIALS.password}`);
