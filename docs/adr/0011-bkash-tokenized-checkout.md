# ADR 0011 — bKash tokenized checkout: create, the patient pays, we execute

Date: 2026-10-04 · Status: accepted (Kamrul, 04/10/2026 — SMS + bKash slice: BulkSMSBD for SMS, bKash built to the
documented API with a local stand-in until sandbox credentials arrive, two sessions)

## Context
Slice A6–A7 built wallet payments against `FakeProvider`, which behaves like a webhook gateway: it texts the patient a
link, the patient pays, and a signed callback reports the money (ADR 0005, open question 90). bKash tokenized checkout
(developer.bka.sh, v2, read 04/10/2026) works differently:

1. **Grant token** (`auth/grant-token`, headers `username` / `password`, body `app_key` / `app_secret`) → `id_token`
   (3600 s) + `refresh_token` (30 days). **Grant and refresh together may be called at most twice an hour**, or the app
   is blocked for an hour.
2. **Create** (`payment/create`: `payerReference`, `callbackURL`, `amount` "500.00", `currency` BDT, `intent` sale,
   `merchantInvoiceNumber`) → `paymentId`, `bkashURL`, `signature`, `transactionStatus` Initiated. bKash sends nothing to
   the patient: the merchant opens `bkashURL` for them. A `paymentId` lives 24 h.
3. The patient enters wallet number, OTP and PIN on bKash's page; bKash **redirects the patient's browser** to
   `callbackURL?paymentID=…&status=success|failure|cancel&signature=…`. The redirect is not proof of payment.
4. **Execute** (`payment/execute`, `paymentId`) → `trxId`, `transactionStatus` Completed. **Money moves only here.** A
   `paymentId` can be executed once, "regardless of the result" — executing before the patient authorised burns it.
5. **Query** (`query/payment`) → `transactionStatus` Completed, or Initiated (also for cancelled / failed). **Search**
   (`general/search-transaction`, `trxId`) does not return the `paymentId`.
6. Errors: `{ internalCode, externalCode, errorMessageEn }` (2062 / 2117 already completed, 2056 invalid state, 2002
   invalid payment id); token errors `{ statusCode, statusMessage }`. No documented webhook.

## Decision
### The payment row first (open question 90)
`addPayment` / `retryPayment` commit the Payment as `initiated` (amount reserved) **before** any gateway call; the link
is created after the commit and stored in a second transaction (`link-sent`). A gateway error marks the payment
`failed` (`failReason` gateway-error) so the amount is freed and the cashier can retry or take cash. A payment still
`initiated` with no link after 2 minutes (the API stopped in between) is failed by the payments sweep.

### Delivering the link
Each link gets our own short code (`Payment.linkCode`, 10 characters, unique). `GET /v1/pay/:code` (public,
rate-limited) redirects to the current `bkashURL` while the payment is still waiting and its link is current; otherwise
it shows "this link has ended — ask at the counter". The cashier's screen shows the short link and a QR of it
(`/v1/billing/payments/:id/qr.svg`) for the patient to scan; session 2 also texts it through the SMS gateway. The text
and the page show only the facility, the bill number and the amount.

### Execute only what is current
`GET /v1/payments/return/bkash` (public, rate-limited, no session) handles the redirect:
- `status=success`: under the bill's lock the payment must be this link's current reference, still waiting, within our
  window (30 minutes), with the same `signature` bKash returned at create; then `executeClaimedAt` is set once
  (a second redirect or a race finds it claimed). After the commit the server calls **execute**; its answer — or, on a
  timeout / 2062 / 2117, a **query** — is applied like a provider event (`eventId` `execute:<paymentId>`): Completed
  with the full amount → `confirmed` with the TrxID; anything else → `failed` (the `paymentId` cannot be executed again).
- `status=failure | cancel`: query; Completed (never expected) is applied, otherwise PAYMENT `fail`.
- A replaced, cancelled or expired link is **never executed** — no money moves, so bKash never needs the reconciliation
  that a late webhook payment needs. The patient's page says to ask at the counter.
The browser is then sent to the staff app's public page `/pay/result` (paid with the TrxID / not paid / ask at the
counter), in Bangla and English.

### Checking, cancelling, the sweep
- **Check (TrxID):** the provider is asked about the payment's own references (query), never by TrxID alone (search has
  no `paymentId`); the typed TrxID must equal what bKash reports for that payment.
- **Cancel:** refused while an execute is claimed and unresolved ("being completed — check again"); otherwise query
  first (Completed → confirmed, never thrown away), then PAYMENT `fail`. bKash has no cancel call: an unexecuted
  `paymentId` simply expires.
- **Sweep** (every minute, each API process, rows claimed with `FOR UPDATE SKIP LOCKED`): initiated with no link
  > 2 min → failed; an execute claimed > 2 min ago with no result → query → confirmed or failed.

### Tokens
One merchant account per deployment for the pilot (`BKASH_*` in `.env`, never in the repo). The token is kept in the
database (`GatewayToken`, reachable only through two `SECURITY DEFINER` functions) so restarts and several API processes
share it; it is renewed under an advisory lock at ≤ 5 minutes left — refresh first, grant only when the refresh token
is gone — so the two-an-hour limit is never reached by our own restarts. `Authorization` sends the raw `id_token`
(every curl sample in the docs does; the prose says `Bearer` — checked against the sandbox when credentials arrive).

### Adapters and the stand-in
`PaymentProvider` gains `flow: "callback" | "execute"` and `execute(providerRef)`; `createLink` may return a
`signature`. `FakeProvider` stays the callback gateway (dev, tests, Nagad until its slice). `BkashProvider` implements
the API above with a 30 s timeout. `BkashSandboxStandIn` (`apps/api/src/adapters/payments/bkash-standin.ts`) answers
the same endpoints with the documented shapes — once-only execute, 2062, the token limit, a hosted page with wallet /
OTP / PIN, success / failure / cancel redirects — for API tests and the hands-on; it is never used by a running API in
production. `PAYMENTS_PROVIDER=bkash` selects bKash for the bKash method; Nagad stays on the fake.

## Consequences
- The "paid on an earlier link" reconciliation stays for callback gateways; for bKash it cannot happen.
- A patient who authorises after the cashier cancelled is not charged; the result page tells them so.
- Refunds (bKash `refund/payment/transaction`) come with the refunds slice.
- Open: per-facility merchant accounts (or bKash aggregator / sub-merchant) before a second clinic; the live hostname,
  the `signature` algorithm and the `Bearer` question are checked with sandbox credentials.
