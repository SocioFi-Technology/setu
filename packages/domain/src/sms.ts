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

/** What we store and show for a BulkSMSBD refusal: the code and our own fixed words — never the gateway's text, which can
    name account details (security review, SMS slice). */
const CODE_TEXT: Record<number, string> = {
  1001: "invalid number", 1002: "sender ID not accepted", 1003: "request incomplete", 1005: "gateway internal error", 1006: "balance validity expired",
  1007: "balance insufficient", 1011: "account not found", 1012: "masking SMS must be in Bangla", 1031: "account not verified", 1032: "server IP not whitelisted",
};
export const bulkSmsCodeText = (code: unknown) => {
  const c = Number(code);
  return `BulkSMSBD ${Number.isFinite(c) ? c : "?"}: ${CODE_TEXT[c] ?? (c >= 1013 && c <= 1021 ? "account or price setup" : "gateway error")}`;
};
/** A facility name as it goes into an SMS: no web addresses (an admin's text must not turn our sender into a link
    sender — security review), at most 60 characters. */
export const smsSafeName = (name: string) => name.replace(/(https?:\/\/|www\.)\S*/gi, "").replace(/\s+/g, " ").trim().slice(0, 60);
/** A queued SMS older than this is not sent any more (after an outage): failed "not sent — too old". */
export const SMS_QUEUED_MAX_MS = 30 * 60_000;
/** Payment-link SMS per payment (every attempt) and the gap between two (cost, and a patient's phone). */
export const LINK_SMS_MAX = 5, LINK_SMS_GAP_MS = 60_000;

/** The sweep (open question 124): queued for 1 minute → send it; "sending" for 2 minutes → the send was interrupted
    and may have gone out: failed, for a person to retry (never resent automatically — a resend cannot be recognised). */
export const SMS_QUEUED_STUCK_MS = 60_000;
export const SMS_SENDING_STUCK_MS = 120_000;
export const SMS_MAYBE_SENT = "no answer from the gateway — it may have been sent";

/** The payment-link SMS (ADR 0012) names only the facility, the bill number and the amount — never the patient, a test
    or a diagnosis; our short link follows once, on its own line, after both languages. */
export const PAYMENT_LINK_SMS_BLANKS = ["facility", "number", "amount"] as const;
export const paymentLinkSmsOk = (template: string) =>
  [...template.matchAll(/\{(\w+)\}/g)].every((m) => (PAYMENT_LINK_SMS_BLANKS as readonly string[]).includes(m[1]!));
