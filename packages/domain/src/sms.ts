/* SMS gateways (ADR 0012): BulkSMSBD's numbers and answer codes, what a stuck message means, and the payment-link
   template's allowed blanks. Pure; the API's adapters and sweep import these. */

/** Our stored mobile (01XXXXXXXXX, or the 10 digits after 0) as BulkSMSBD wants it: 8801XXXXXXXXX; null if not one. */
export function bulkSmsNumber(phone: string): string | null {
  const d = phone.replace(/[\s-]/g, "");
  const m = /^(?:\+?880|0)?(1[3-9]\d{8})$/.exec(d);
  return m ? `880${m[1]}` : null;
}

/** What BulkSMSBD's response_code means for the message: 202 accepted ("sent" — never "delivered": no delivery
    reports); the number; the facility's setup (sender id, balance, account, IP whitelist — someone must fix it first);
    the gateway itself. */
export type SmsFailure = "number" | "setup" | "gateway" | "no-answer";
export type BulkSmsOutcome = { status: "sent" } | { status: "failed"; reason: SmsFailure };
const SETUP_CODES = new Set([1002, 1006, 1007, 1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019, 1020, 1021, 1031, 1032]);
export function bulkSmsOutcome(code: unknown): BulkSmsOutcome {
  const c = typeof code === "number" ? code : Number(code);
  if (c === 202) return { status: "sent" };
  if (c === 1001) return { status: "failed", reason: "number" };
  if (SETUP_CODES.has(c)) return { status: "failed", reason: "setup" };
  return { status: "failed", reason: "gateway" };
}

/** The sweep (open question 124): queued for 1 minute → send it; "sending" for 2 minutes → the send was interrupted
    and may have gone out: failed, for a person to retry (never resent automatically — a resend cannot be recognised). */
export const SMS_QUEUED_STUCK_MS = 60_000;
export const SMS_SENDING_STUCK_MS = 120_000;
export const SMS_MAYBE_SENT = "no answer from the gateway — it may have been sent";

/** The payment-link SMS (ADR 0012) names only the facility, the bill number, the amount and our short link — never the
    patient, a test or a diagnosis. */
export const PAYMENT_LINK_SMS_BLANKS = ["facility", "number", "amount", "link"] as const;
export const paymentLinkSmsOk = (template: string) =>
  [...template.matchAll(/\{(\w+)\}/g)].every((m) => (PAYMENT_LINK_SMS_BLANKS as readonly string[]).includes(m[1]!)) && template.includes("{link}");
