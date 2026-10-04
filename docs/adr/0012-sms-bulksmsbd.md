# ADR 0012 — SMS through BulkSMSBD: "sent" is not "delivered"

Date: 2026-10-04 · Status: accepted (Kamrul, 04/10/2026 — SMS gateway BulkSMSBD; SMS + bKash slice session 2)

## Context
Until now every SMS went to `FakeMessenger`, which "delivers" at once (ADR 0006). Kamrul chose **BulkSMSBD**. Its API
(the account page, read 04/10/2026; probed without a key): `POST https://bulksmsbd.net/api/smsapi` with `api_key`,
`type=text`, `number` (8801XXXXXXXXX), `senderid`, `message` → JSON `{ response_code, success_message,
error_message }`: **202 = submitted**; 1001 invalid number; 1002 sender id wrong / disabled; 1003 fields missing; 1005
internal error; 1006 / 1007 balance validity / insufficient; 1011–1021, 1031 account or price setup; 1012 masking SMS
must be in Bangla; 1032 IP not whitelisted. Also `smsapimany` and `getBalanceApi`. **There is no delivery-report API,
and no client message id** — the gateway cannot tell us that a phone received a message, nor recognise a resend.
It answers over https (valid certificate), so the key never needs to cross the network in clear text.

## Decision
### What a status means
`SendResult` gains `sent` (the gateway accepted it) beside `delivered` (the gateway confirmed it reached the phone) and
`failed`. Each `Messenger` says whether it `confirmsDelivery`. A Communication that the gateway accepted is
`completed` with `deliveryConfirmed = false`, and every screen says **"Sent"**, never "Delivered", for it (lab
delivery, the doctor's view, the admin's test SMS, the payment link). `FakeMessenger` keeps confirming delivery.

### Failures
BulkSMSBD's codes map to: the number (1001) — fix the number; the facility's setup (1002, 1006, 1007, 1011–1021, 1031,
1032, 1012) — tell the owner / admin, the message can be retried once fixed; the gateway (1005, HTTP errors) — retry.
A **timeout or a broken answer** is `failed` with "no answer from the gateway — it may have been sent": we never resend
by ourselves (a resend cannot be recognised as the same message), the person decides, and Retry warns that the
patient may get it twice. The texts are fixed templates (facility + what to do; never a result, a test, a diagnosis or
the patient's name), so a duplicate tells nobody anything new.

### Stuck messages (open question 124)
A sweep (every minute, with the payments sweep): an SMS still queued after 1 minute is sent; one "sending" for more
than 2 minutes (the API stopped mid-send) becomes `failed` with "no answer — it may have been sent" so its Retry
appears. Nothing is resent automatically.

### The payment link by SMS (ADR 0011)
When a bKash link is made for a bill with a patient who has a mobile number, an SMS `payment-link` (facility, bill
number, amount, our short link) is queued in the same transaction and sent after the commit. "Send SMS again" makes a
new message for the current link. A walk-in buyer with no patient record gets the QR only.

### The admin's test SMS (go-live checklist, ADR 0010)
With a gateway that confirms delivery the test is done when it is delivered (as before). With BulkSMSBD it is
**sent**, and the admin confirms "It arrived" on the checklist (within 24 hours) — only then is the item done.

### Configuration
`SMS_PROVIDER=bulksmsbd` with `BULKSMSBD_API_KEY`, `BULKSMSBD_SENDER_ID` (a number until BTRC approves a masking name),
`BULKSMSBD_URL` (default `https://bulksmsbd.net/api/smsapi`; https required in production). The key is sent in the POST
body, never in a URL or a log. The production server's IP must be whitelisted at BulkSMSBD (1032).
`BulkSmsBdStandIn` (`pnpm --filter @setu/api sms:standin`) answers the same API for tests and the hands-on and keeps a
"phone inbox" page of what it received.

## Consequences
- No delivery confirmation for any message until BulkSMSBD offers delivery reports (open question) or another gateway
  is chosen; the lab's "per-channel status" shows "Sent" for SMS.
- Bangla + English templates are Unicode: one message is several SMS parts (cost per patient message ≈ 3–4 parts).
- The SMS balance is not shown in the app yet (`getBalanceApi` exists).
