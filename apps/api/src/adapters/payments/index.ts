/* The wallet provider for this process, chosen by PAYMENTS_PROVIDER (.env). Only `fake` exists until the bKash / Nagad
   sandboxes (phase 2); any other value stops the API at start rather than taking payments it cannot confirm. */
import { config } from "../../config.js";
import { FakeProvider } from "./fake.js";
import type { PaymentProvider } from "./provider.js";

export * from "./provider.js";
export { FakeProvider, FAKE_SIGNATURE_HEADER } from "./fake.js";

const fakeSecret = process.env.FAKE_PAYMENTS_SECRET ?? "dev-only-fake-payments-secret";

function make(name: string): PaymentProvider {
  if (name === "fake") return new FakeProvider(fakeSecret);
  throw new Error(`PAYMENTS_PROVIDER=${name} is not available yet (only "fake" until the bKash / Nagad sandboxes)`);
}

export const payments: PaymentProvider = make(config.adapters.payments);
/** Providers that may post callbacks to /v1/payments/callback/:provider. */
export const providerByName = (name: string): PaymentProvider | null => (name === payments.name ? payments : null);
/** The dev/test helper that plays the customer's side; null when the real provider is configured. */
export const fakeProvider = (): FakeProvider | null => (payments instanceof FakeProvider ? payments : null);
