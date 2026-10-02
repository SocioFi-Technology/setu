/* FakeMessenger: records every SMS in memory instead of sending it (dev and tests; an API restart forgets them). A
   message id that was already delivered is not delivered again — the same guarantee the real gateway must give for a
   retried message. `failNext` makes the next send(s) fail like an unreachable number (the walkthrough's failed SMS
   that the lab retries, issue #2); in dev it is reached only through FAKE_MESSAGING_DEV_ROUTE=1. */
import { randomBytes } from "node:crypto";
import type { Messenger, SendResult, SmsMessage } from "./messenger.js";

export interface FakeAttempt { messageId: string; to: string; text: string; at: Date; outcome: "delivered" | "failed" | "already-delivered"; providerRef: string | null }

export class FakeMessenger implements Messenger {
  readonly name = "fake";
  private attempts: FakeAttempt[] = [];
  private delivered = new Map<string, string>();
  private failures: string[] = [];

  async sendSms(m: SmsMessage): Promise<SendResult> {
    const at = new Date();
    const done = this.delivered.get(m.messageId);
    if (done) { this.attempts.push({ ...m, at, outcome: "already-delivered", providerRef: done }); return { status: "delivered", providerRef: done }; }
    if (!/^01[3-9]\d{8}$/.test(m.to)) { this.attempts.push({ ...m, at, outcome: "failed", providerRef: null }); return { status: "failed", error: "invalid number", providerRef: null }; }
    const failure = this.failures.shift();
    if (failure) { this.attempts.push({ ...m, at, outcome: "failed", providerRef: null }); return { status: "failed", error: failure, providerRef: null }; }
    const providerRef = "FM" + randomBytes(8).toString("hex").toUpperCase();
    this.delivered.set(m.messageId, providerRef);
    this.attempts.push({ ...m, at, outcome: "delivered", providerRef });
    return { status: "delivered", providerRef };
  }

  /** The next `n` sends fail with `error` (default: the number cannot be reached). */
  failNext(n = 1, error = "number unreachable") { for (let i = 0; i < n; i++) this.failures.push(error); }
  /** Every attempt, oldest first (tests and the dev route read it; nothing leaves the process). */
  log(): FakeAttempt[] { return [...this.attempts]; }
  /** Messages that reached a phone, one per message id. */
  deliveredMessages(): FakeAttempt[] { return this.attempts.filter((a) => a.outcome === "delivered"); }
  clearFailures() { this.failures = []; }
}
