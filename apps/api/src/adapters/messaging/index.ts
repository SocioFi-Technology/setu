/* The SMS gateway for this process, chosen by SMS_PROVIDER (.env): fake (dev, tests) | bulksmsbd (ADR 0012). Anything
   else, or BulkSMSBD without its settings, stops the API at start rather than claiming to send messages it cannot send. */
import { config } from "../../config.js";
import { BulkSmsBdMessenger } from "./bulksmsbd.js";
import { FakeMessenger } from "./fake.js";
import type { Messenger } from "./messenger.js";

export * from "./messenger.js";
export { FakeMessenger, type FakeAttempt } from "./fake.js";
export { BulkSmsBdMessenger } from "./bulksmsbd.js";

function make(name: string): Messenger {
  if (name === "fake") return new FakeMessenger();
  if (name === "bulksmsbd") {
    const missing = ["BULKSMSBD_API_KEY", "BULKSMSBD_SENDER_ID"].filter((k) => !process.env[k]);
    if (missing.length) throw new Error(`SMS_PROVIDER=bulksmsbd needs ${missing.join(", ")} in .env`);
    const url = process.env.BULKSMSBD_URL || "https://bulksmsbd.net/api/smsapi";
    if (process.env.NODE_ENV === "production" && !/^https:\/\/bulksmsbd\.net\//.test(url)) throw new Error("BULKSMSBD_URL must be https://bulksmsbd.net/… in production (the key is in the request)");
    return new BulkSmsBdMessenger({ url, apiKey: process.env.BULKSMSBD_API_KEY!, senderId: process.env.BULKSMSBD_SENDER_ID!, timeoutMs: Number(process.env.BULKSMSBD_TIMEOUT_MS ?? 20_000) });
  }
  throw new Error(`SMS_PROVIDER=${name} is not available (fake | bulksmsbd)`);
}

export const messenger: Messenger = make(config.adapters.sms);
/** The dev/test helper (fail the next send, read what was "sent"); null when a real gateway is configured. */
export const fakeMessenger = (): FakeMessenger | null => (messenger instanceof FakeMessenger ? messenger : null);
