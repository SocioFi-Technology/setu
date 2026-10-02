/* The SMS gateway for this process, chosen by SMS_PROVIDER (.env). Only `fake` exists until phase 2 (the gateway
   decision); any other value stops the API at start rather than claiming to send messages it cannot send. */
import { config } from "../../config.js";
import { FakeMessenger } from "./fake.js";
import type { Messenger } from "./messenger.js";

export * from "./messenger.js";
export { FakeMessenger, type FakeAttempt } from "./fake.js";

function make(name: string): Messenger {
  if (name === "fake") return new FakeMessenger();
  throw new Error(`SMS_PROVIDER=${name} is not available yet (only "fake" until the SMS gateway is chosen, phase 2)`);
}

export const messenger: Messenger = make(config.adapters.sms);
/** The dev/test helper (fail the next send, read what was "sent"); null when a real gateway is configured. */
export const fakeMessenger = (): FakeMessenger | null => (messenger instanceof FakeMessenger ? messenger : null);
