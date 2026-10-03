/* FakeMessenger: records every SMS in memory instead of sending it (dev and tests; an API restart forgets them). A
   message id that was already delivered is not delivered again — the same guarantee the real gateway must give for a
   retried message. `failNext` makes the next send(s) fail like an unreachable number (the walkthrough's failed SMS
   that the lab retries, issue #2); in dev it is reached only through FAKE_MESSAGING_DEV_ROUTE=1. */
import { randomBytes } from "node:crypto";
import type { Messenger, SendResult, SmsMessage } from "./messenger.js";

export interface FakeAttempt { messageId: string; to: string; text: string; tenantId: string; at: Date; outcome: "delivered" | "failed" | "already-delivered"; providerRef: string | null }

export class FakeMessenger implements Messenger {
  readonly name = "fake";
  private attempts: FakeAttempt[] = [];
  private delivered = new Map<string, string>();
  private failures = new Map<string, string[]>();

  async sendSms(m: SmsMessage): Promise<SendResult> {
    const at = new Date(), tenantId = m.tenantId ?? "";
    const rec = (outcome: FakeAttempt["outcome"], providerRef: string | null) => this.attempts.push({ messageId: m.messageId, to: m.to, text: m.text, tenantId, at, outcome, providerRef });
    const done = this.delivered.get(m.messageId);
    if (done) { rec("already-delivered", done); return { status: "delivered", providerRef: done }; }
    if (!/^01[3-9]\d{8}$/.test(m.to)) { rec("failed", null); return { status: "failed", error: "invalid number", providerRef: null }; }
    const failure = this.failures.get(tenantId)?.shift();
    if (failure) { rec("failed", null); return { status: "failed", error: failure, providerRef: null }; }
    const providerRef = "FM" + randomBytes(8).toString("hex").toUpperCase();
    this.delivered.set(m.messageId, providerRef);
    rec("delivered", providerRef);
    return { status: "delivered", providerRef };
  }

  /** The next `n` sends of this tenant fail with `error` (default: the number cannot be reached). */
  failNext(n = 1, error = "number unreachable", tenantId = "") {
    const q = this.failures.get(tenantId) ?? [];
    for (let i = 0; i < n; i++) q.push(error);
    this.failures.set(tenantId, q);
  }
  /** Every attempt, oldest first, optionally of one tenant (tests and the dev route read it; nothing leaves the process). */
  log(tenantId?: string): FakeAttempt[] { return this.attempts.filter((a) => tenantId === undefined || a.tenantId === tenantId); }
  /** Messages that reached a phone, one per message id. */
  deliveredMessages(): FakeAttempt[] { return this.attempts.filter((a) => a.outcome === "delivered"); }
  clearFailures() { this.failures.clear(); }
}
