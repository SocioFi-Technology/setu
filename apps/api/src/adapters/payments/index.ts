/* The wallet providers for this process (ADR 0011). PAYMENTS_PROVIDER=fake: every wallet on FakeProvider (dev, tests).
   PAYMENTS_PROVIDER=bkash: bKash on BkashProvider (BKASH_* in .env), Nagad still on the fake until its slice. Anything
   else, or bKash without its settings, stops the API at start rather than taking payments it cannot confirm. */
import { config } from "../../config.js";
import { BkashProvider, type TokenStore } from "./bkash.js";
import { FakeProvider } from "./fake.js";
import type { PaymentProvider } from "./provider.js";

export * from "./provider.js";
export { FakeProvider, FAKE_SIGNATURE_HEADER } from "./fake.js";
export { BkashProvider } from "./bkash.js";

const production = process.env.NODE_ENV === "production";
const fakeSecret = process.env.FAKE_PAYMENTS_SECRET ?? "dev-only-fake-payments-secret";
const fake = new FakeProvider(fakeSecret);

const dbTokenStore: TokenStore = async (renew) => (await import("@setu/db")).withGatewayToken("bkash", renew);

function bkash(): BkashProvider {
  const need = ["BKASH_BASE_URL", "BKASH_APP_KEY", "BKASH_APP_SECRET", "BKASH_USERNAME", "BKASH_PASSWORD"] as const;
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`PAYMENTS_PROVIDER=bkash needs ${missing.join(", ")} in .env`);
  // security review (bKash slice): production talks to bKash itself, over TLS — never a stand-in or a typo'd host
  if (production && !/^https:\/\/[^/]+\.bka\.sh\//.test(process.env.BKASH_BASE_URL!)) throw new Error("BKASH_BASE_URL must be an https bka.sh address in production");
  return new BkashProvider({
    baseUrl: process.env.BKASH_BASE_URL!, appKey: process.env.BKASH_APP_KEY!, appSecret: process.env.BKASH_APP_SECRET!,
    username: process.env.BKASH_USERNAME!, password: process.env.BKASH_PASSWORD!, callbackUrl: `${config.publicApiUrl}/v1/payments/return/bkash`,
    timeoutMs: Number(process.env.BKASH_TIMEOUT_MS ?? 30_000), linkHost: production ? /\.bka\.sh$/ : undefined,
  }, dbTokenStore);
}

/* Security review (bKash slice): in production nothing runs on the fake — its signing secret is published, so a forged
   "paid" callback would confirm money that never moved. Nagad is unavailable there until its own adapter exists. */
function make(name: string): { bkash: PaymentProvider; nagad: PaymentProvider | null } {
  if (name === "fake") return { bkash: fake, nagad: fake };
  if (name === "bkash") return { bkash: bkash(), nagad: production ? null : fake };
  throw new Error(`PAYMENTS_PROVIDER=${name} is not available (fake | bkash)`);
}

const byMethod = make(config.adapters.payments);
/** The provider that takes this wallet method's new payments. */
export const providerFor = (method: "bkash" | "nagad"): PaymentProvider | null => byMethod[method];
/** A payment's own provider, by the name stored on it. */
export const providerByName = (name: string | null | undefined): PaymentProvider | null =>
  name ? [byMethod.bkash, byMethod.nagad].find((p) => p?.name === name) ?? null : null;
/** The dev/test helper that plays the customer's side of the fake; null when no wallet uses it. */
export const fakeProvider = (): FakeProvider | null => (production ? null : fake);
