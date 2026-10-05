/* Wallet payments behind an interface (CLAUDE.md: external services sit in adapters with a Fake* in dev and tests).
   Two kinds of gateway (ADR 0011): a "callback" gateway (FakeProvider) reports money in a signed callback; an "execute"
   gateway (bKash tokenized checkout) sends the patient back to us and moves the money only when we call `execute`,
   once per link. The API never trusts a callback or a redirect by itself: it records the event once and asks the
   provider (verify / execute) before it confirms money. */
import type { ProviderEventKind } from "@setu/domain";

export interface LinkRequest {
  method: "bkash" | "nagad";
  amountPaisa: number;
  /** our Payment id, echoed back by the provider */
  reference: string;
  /** shown to the customer on the provider's page — the bill number only, never clinical content */
  invoiceNumber: string;
  /** Bangladesh mobile, 10 digits after +880 */
  phone: string;
  /** which attempt of the payment this link is (a new merchant invoice number per attempt) */
  attempt: number;
}
/** `signature`: what an execute gateway returned at create; the patient's return must carry the same. */
export interface PaymentLink { providerRef: string; url: string; expiresAt: Date; signature?: string | null }
export interface ProviderStatus { providerRef: string; status: "pending" | "opened" | "confirmed" | "failed"; trxId: string | null; amountPaisa: number }
/** `settled`: the gateway's answer decides the payment (Completed, or it refused this execute); otherwise ask again later. */
export interface ExecuteAnswer { status: ProviderStatus | null; settled: boolean }
export interface ProviderWebhook { eventId: string; providerRef: string; kind: ProviderEventKind; trxId: string | null; amountPaisa: number | null }
/** ADR 0013: a refund against one completed payment (bKash: paymentId + its TrxID). `sku` = our refund allocation id,
    `reason` = the category (never clinical text). `known`: refund TrxIDs of this payment already recorded by us — a
    refund found by a status check is ours only if it is not one of them. */
export interface RefundCall { providerRef: string; trxId: string; amountPaisa: number; sku: string; reason: string; known: string[] }
/** completed: the money went back (refundTrxId); refused: the gateway said no — nothing moved (`code`, for the log and
    the cashier); unknown: no answer and the status check found nothing yet — ask again later, never refund again by itself. */
export interface RefundAnswer { status: "completed" | "refused" | "unknown"; refundTrxId: string | null; code: string | null }
export interface RefundRecord { refundTrxId: string; amountPaisa: number; completed: boolean; completedAt: string | null }

export class InvalidSignature extends Error { constructor() { super("invalid provider signature"); } }
/** The gateway could not be reached or refused the request (`code`: the gateway's own code, for the log). */
export class GatewayError extends Error { constructor(readonly code: string, message: string) { super(message); } }

export interface PaymentProvider {
  /** stored on Payment.provider */
  readonly name: string;
  readonly flow: "callback" | "execute";
  createLink(req: LinkRequest): Promise<PaymentLink>;
  /** What the provider says happened, by its reference or by a TrxID the cashier typed; null = unknown to it. */
  verify(q: { providerRef: string } | { trxId: string }): Promise<ProviderStatus | null>;
  /** Called before a retry so an old link can no longer be paid. */
  cancel(providerRef: string): Promise<void>;
  /** Checks the signature over the raw body and returns the event; throws InvalidSignature. */
  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): ProviderWebhook;
  /** Execute gateways only: move the money for this link, once. Never throws for a gateway answer: an error, a timeout
      or "already completed" is followed by a query; `settled` says whether that answer decides the payment. */
  execute(providerRef: string): Promise<ExecuteAnswer>;
  /** ADR 0013: "gateway" = the wallet's own refund API; "manual" = refunded by hand with a reference (flagged). */
  readonly refundSupport: "gateway" | "manual";
  /** Gateway refunds only. Never throws for a gateway answer: a refusal is `refused`; a timeout or a broken answer is
      followed by a status check (`unknown` when that finds nothing). */
  refund(req: RefundCall): Promise<RefundAnswer>;
  /** Every refund the gateway holds against this payment; null = it does not know the payment. */
  refundStatus(q: { providerRef: string; trxId: string }): Promise<RefundRecord[] | null>;
}
