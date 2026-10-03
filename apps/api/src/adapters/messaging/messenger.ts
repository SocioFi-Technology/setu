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
export type SendResult = { status: "delivered"; providerRef: string } | { status: "failed"; error: string; providerRef: string | null };

export interface Messenger {
  /** stored with the message's attempts */
  readonly name: string;
  sendSms(m: SmsMessage): Promise<SendResult>;
}
