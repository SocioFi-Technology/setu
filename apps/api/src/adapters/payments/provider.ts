/* Wallet payments behind an interface (CLAUDE.md: external services sit in adapters with a Fake* in dev and tests).
   bKash and Nagad adapters come with the sandbox in phase 2 and implement the same interface, chosen by
   PAYMENTS_PROVIDER. The API never trusts a callback by itself: it checks the signature (parseWebhook), records the
   event once, and asks the provider (verify) before it confirms money. */
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
}
export interface PaymentLink { providerRef: string; url: string; expiresAt: Date }
export interface ProviderStatus { providerRef: string; status: "pending" | "opened" | "confirmed" | "failed"; trxId: string | null; amountPaisa: number }
export interface ProviderWebhook { eventId: string; providerRef: string; kind: ProviderEventKind; trxId: string | null; amountPaisa: number | null }

export class InvalidSignature extends Error { constructor() { super("invalid provider signature"); } }

export interface PaymentProvider {
  /** stored on Payment.provider */
  readonly name: string;
  createLink(req: LinkRequest): Promise<PaymentLink>;
  /** What the provider says happened, by its reference or by a TrxID the cashier typed; null = unknown to it. */
  verify(q: { providerRef: string } | { trxId: string }): Promise<ProviderStatus | null>;
  /** Called before a retry so an old link can no longer be paid. */
  cancel(providerRef: string): Promise<void>;
  /** Checks the signature over the raw body and returns the event; throws InvalidSignature. */
  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): ProviderWebhook;
  /** Refunds come with the refunds screen (not in slice A6–A7). */
  refund(providerRef: string, amountPaisa: number): Promise<never>;
}
