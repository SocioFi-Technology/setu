/* BulkSmsBdMessenger (ADR 0012): POST https://bulksmsbd.net/api/smsapi (form body: api_key, type, number 8801…,
   senderid, message) → { response_code, success_message, error_message }. 202 = the gateway accepted the message —
   "sent"; BulkSMSBD has no delivery reports and no client message id, so nothing here can say "delivered" or
   recognise a resend. A timeout or a broken answer is "no answer — it may have been sent": never resent by us. The
   key travels in the POST body only, never in a URL or a log line. */
import { SMS_MAYBE_SENT, bulkSmsCodeText, bulkSmsNumber, bulkSmsOutcome } from "@setu/domain";
import type { Messenger, SendResult, SmsMessage } from "./messenger.js";

export interface BulkSmsBdConfig { url: string; apiKey: string; senderId: string; timeoutMs?: number }

export class BulkSmsBdMessenger implements Messenger {
  readonly name = "bulksmsbd";
  readonly confirmsDelivery = false;
  constructor(private cfg: BulkSmsBdConfig) {}

  async sendSms(m: SmsMessage): Promise<SendResult> {
    const number = bulkSmsNumber(m.to);
    if (!number) return { status: "failed", error: "not a Bangladesh mobile number", providerRef: null, reason: "number" };
    const body = new URLSearchParams({ api_key: this.cfg.apiKey, type: "text", number, senderid: this.cfg.senderId, message: m.text });
    let res: Response;
    try {
      res = await fetch(this.cfg.url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000) });
    } catch (e) {
      // the request may or may not have reached the gateway
      return { status: "failed", error: `${SMS_MAYBE_SENT} (${(e as Error).name === "TimeoutError" ? "timed out" : "unreachable"})`, providerRef: null, reason: "no-answer" };
    }
    type Answer = { response_code?: unknown; success_message?: unknown; error_message?: unknown; message_id?: unknown };
    const j: Answer | null = await res.json().then((x: unknown) => (x && typeof x === "object" ? (x as Answer) : null), () => null);
    if (!j || j.response_code === undefined) {
      // a 5xx or a page instead of JSON: we cannot know whether it was taken
      return res.status >= 500 || !j ? { status: "failed", error: `${SMS_MAYBE_SENT} (HTTP ${res.status})`, providerRef: null, reason: "no-answer" } : { status: "failed", error: `HTTP ${res.status}`, providerRef: null, reason: "gateway" };
    }
    const o = bulkSmsOutcome(j.response_code);
    const ref = j.message_id !== undefined && j.message_id !== null ? String(j.message_id).slice(0, 80) : null;
    if (o.status === "sent") return { status: "sent", providerRef: ref };
    // our own words for the code (the gateway's text can name account details); the raw text stays out of the database
    return { status: "failed", error: bulkSmsCodeText(j.response_code), providerRef: null, reason: o.reason };
  }
}
