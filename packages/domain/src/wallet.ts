/* Wallet gateways that move money at "execute" (ADR 0011, bKash tokenized checkout): amounts as the gateway writes
   them, what to do with the patient's return from the payment page, and what an execute / query answer means for the
   PAYMENT. Pure; the API and the bKash adapter import these. */
import type { Paisa } from "./money.js";
import { PENDING_STATES } from "./billing.js";
import type { PaymentState } from "./machines.js";

/** Our window for paying a link (bKash keeps a paymentId 24 h; a counter waits minutes, not a day). */
export const LINK_WINDOW_MINUTES = 30;
/** The sweep fails a payment left without a link, or resolves an unanswered execute, after this long. */
export const STUCK_MINUTES = 2;
/** Our short link code: 10 characters with no look-alikes (0/O, 1/I/L). */
export const LINK_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const LINK_CODE_LENGTH = 10;
export const isLinkCode = (s: string): boolean => s.length === LINK_CODE_LENGTH && [...s].every((c) => LINK_CODE_ALPHABET.includes(c));

/** Paisa as the gateway's amount string ("500.00"); integer arithmetic only. */
export function walletAmount(p: Paisa): string {
  if (!Number.isSafeInteger(p) || p <= 0) throw new RangeError(`amount ${p} is not a positive whole number of paisa`);
  return `${Math.floor(p / 100)}.${String(p % 100).padStart(2, "0")}`;
}
/** The gateway's amount ("500", "500.5", "500.00", or a number) as paisa; null when it is not a plain amount. */
export function parseWalletAmount(v: unknown): Paisa | null {
  const s = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(2) : "") : typeof v === "string" ? v.trim() : "";
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

/* ── the patient comes back from the payment page ── */
export type ReturnStatus = "success" | "failure" | "cancel";
export interface ReturnFacts {
  status: ReturnStatus;
  payment: PaymentState;
  /** the redirect's paymentID is the payment's current reference (not a replaced link) */
  current: boolean;
  /** our window has passed */
  expired: boolean;
  /** an execute was already claimed for this payment */
  claimed: boolean;
  /** the redirect's signature equals the one the gateway gave at create */
  signatureOk: boolean;
}
export type ReturnDecision =
  | { action: "execute" }
  /** ask the gateway (failure / cancel, or a repeat of a success already being executed) */
  | { action: "query" }
  /** nothing is executed; the page says why */
  | { action: "refuse"; reason: "ended" | "expired" | "signature" | "already-paid" };

export function decideReturn(f: ReturnFacts): ReturnDecision {
  // a replaced link is never executed, whatever it carries (its signature was the old link's)
  if (!f.current) return { action: "refuse", reason: "ended" };
  if (!f.signatureOk) return { action: "refuse", reason: "signature" };
  if (f.payment === "confirmed") return { action: "refuse", reason: "already-paid" };
  if (!PENDING_STATES.includes(f.payment)) return { action: "refuse", reason: "ended" };
  if (f.claimed) return { action: "query" };
  if (f.status !== "success") return { action: "query" };
  if (f.expired) return { action: "refuse", reason: "expired" };
  return { action: "execute" };
}

/* ── what an execute or query answer means ── */
export interface GatewayAnswer { transactionStatus: string | null; amountPaisa: Paisa | null; trxId: string | null }
export type AnswerOutcome =
  | { outcome: "confirm"; trxId: string }
  /** money arrived but not the amount asked: never applied silently (the owner reconciles) */
  | { outcome: "mismatch" }
  | { outcome: "fail" }
  /** query only: the patient may still pay */
  | { outcome: "pending" };

/** After an execute attempt the paymentId is spent: anything but Completed is a failed payment. After a query alone
    (`afterExecute` false) Initiated means the patient has not finished yet. */
export function answerOutcome(a: GatewayAnswer | null, amountPaisa: Paisa, afterExecute: boolean): AnswerOutcome {
  if (a?.transactionStatus === "Completed") {
    if (!a.trxId) return afterExecute ? { outcome: "fail" } : { outcome: "pending" };
    return a.amountPaisa === amountPaisa ? { outcome: "confirm", trxId: a.trxId } : { outcome: "mismatch" };
  }
  return afterExecute ? { outcome: "fail" } : { outcome: "pending" };
}
