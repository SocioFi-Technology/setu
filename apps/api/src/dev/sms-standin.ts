/* Starts the local BulkSMSBD stand-in (ADR 0012) for the hands-on: `pnpm --filter @setu/api sms:standin`. Prints the
   .env settings that point an API at it; GET /inbox shows what it received, like a phone. Never in production. */
import { BulkSmsBdStandIn, STANDIN_SMS } from "../adapters/messaging/bulksmsbd-standin.js";

if (process.env.NODE_ENV === "production") throw new Error("the SMS stand-in is for dev and tests only");
const s = new BulkSmsBdStandIn();
const url = await s.start({ port: Number(process.env.SMS_STANDIN_PORT ?? 4198), host: "127.0.0.1" });
console.log(`BulkSMSBD stand-in on ${s.baseUrl} — inbox ${s.baseUrl}/inbox. API settings:
SMS_PROVIDER=bulksmsbd
BULKSMSBD_URL=${url}
BULKSMSBD_API_KEY=${STANDIN_SMS.apiKey}
BULKSMSBD_SENDER_ID=${STANDIN_SMS.senderId}`);
