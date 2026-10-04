/* SMS behind an interface (CLAUDE.md: external services sit in adapters with a Fake* in dev and tests). The real
   gateway comes in phase 2 behind the same interface, chosen by SMS_PROVIDER. Every send is a Communication row first
   (ADR 0006); the gateway gets that row's id as the message id, so a retry of the same message is never delivered
   twice. The text is always one of the fixed templates (facility name + what to do) — never a result value, a test
   name, a diagnosis or the patient's name. */

export interface SmsMessage {
  /** the Communication id; a retry sends the same id */
  messageId: string;
  /** Bangladesh mobile as stored on the patient (01XXXXXXXXX) */
  to: string;
  text: string;
  /** whose message it is (the gateway's accounting; the fake keeps each tenant's log and failures apart) */
  tenantId?: string;
}
/** delivered: the gateway confirmed the phone received it; sent: the gateway accepted it and cannot say more (BulkSMSBD,
    ADR 0012); failed: `reason` — the number, the facility's setup, the gateway, or no answer (it may have been sent). */
export type SendResult =
  | { status: "delivered"; providerRef: string }
  | { status: "sent"; providerRef: string | null }
  | { status: "failed"; error: string; providerRef: string | null; reason?: import("@setu/domain").SmsFailure };

export interface Messenger {
  /** stored with the message's attempts */
  readonly name: string;
  /** false: a "sent" message is never shown as delivered (ADR 0012) */
  readonly confirmsDelivery: boolean;
  sendSms(m: SmsMessage): Promise<SendResult>;
}
