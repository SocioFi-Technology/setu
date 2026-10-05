# ADR 0013 — Refunds: REFUND machine, credit-note lines, payout, voucher; void after refund; pharmacy returns

Date: 2026-10-05 · Status: accepted (Kamrul, 05/10/2026 — refunds slice plan, decisions 1–10 with changes to 2, 4, 6
and the recipient on the voucher; two sessions)

## Context
Until now confirmed money could never leave a bill: a paid bill could not be voided (ADR 0005, open question 107),
given medicine could not come back (ADR 0009, questions 166 and 191), a reconciliation case could only be applied or
resolved with a note, the shift's cash refunds were always 0 (ADR 0008, question 150) and the owner's refunds tile said
"comes with refunds". The design has a `bill/refund` screen (refund items, performed services locked, reason, "Refund
to", request → approval → pay → RF/yy/nnnn) and a refund kind in the Approvals queue.

bKash tokenized checkout v2 (developer.bka.sh, read 05/10/2026): `POST refund/payment/transaction` (`paymentId`,
`refundAmount` "10.00", `trxId` = the original TrxID, `sku` ≤ 255, `reason` ≤ 255) → `refundTrxId`,
`refundTransactionStatus` Completed, `originalTrxId`, `refundAmount`, `completedTime`; `POST refund/payment/status`
(`paymentId`, `trxId`) → `refundTransactions[]` (each `refundTrxId`, status, amount, time). Up to **10 partial refunds
per transaction**, within `maxRefundableAmount`, within **60 days**, **no duplicate refund within 10 minutes**, 30 s
timeout — "if the refund API does not respond within 30 s, call Refund Status; if there is no refund for that time and
amount, refund again". Refund errors: 2071 after the window, 2072 amount not valid, 2073 / 2075 SKU, 2074 cannot be
reversed, 2076 / 2078 reason, 2077 invalid TrxID, 2023 insufficient (merchant) balance, 2127 not yet completed,
2080–2082 not permitted.

## Decision
### REFUND machine (new)
```
requested ──approve──▶ approved ──pay──▶ paid
requested ──reject(note)──▶ rejected
approved  ──withdraw(note)──▶ withdrawn
```
`withdrawn` is its own state: an approved refund that will not be paid (the patient never came back, the request was
wrong) — owner / admin, a note ≥ 10, only while no part of it has been paid out. It is never shown or counted as
"rejected" (history, Approvals, dashboard). Nothing moves before `approved`; `paid` is final.

### A refund belongs to one bill
- **Refund** (one bill, its facility): category `cancelled-test | wrong-dispense | overpayment | patient-request |
  other`, reason ≥ 10, requested by a cashier or a pharmacist (owner / admin may request too, never approve their own).
  At most one refund per bill is open (requested or approved) at a time.
- **Refund lines** name the bill lines being refunded, each with its net, VAT and total — the accountant's credit note.
  A service line is refunded by amount (≤ what is left of it); a medicine line by units (≤ units not yet returned).
  The VAT of a part is the line's remaining VAT in proportion, half-up, never leaving negative net or VAT behind; the
  last part takes exactly what is left.
- **Performed is locked** (design): a test whose specimen was collected, and the consultation of a finished visit,
  cannot be refunded; a "Not billed here" line has nothing to refund. Desk items and orders not collected or revoked
  can be. "Cancelled test" takes order lines only; requesting a refund never revokes an order (the doctor or the lab
  does that). "Overpayment" is only the reconciliation kind below (a bill can never hold more than its total).
- **Allocations** say which confirmed payments of the bill the money goes back against, and how it is paid out. The
  lines, the allocations and the refund add up to the same paisa. Per bill: ≤ confirmed money − refunds already paid
  out; per payment: ≤ its amount − what was refunded against it.

### How the money goes back (decision 2, Kamrul's guards)
| Paid by | Paid back by | Rule |
|---|---|---|
| cash | cash | from the payer's open shift |
| bKash / Nagad | the gateway's refund | when the gateway has a refund API (bKash) |
| bKash / Nagad | manual with a reference | when the adapter has none (Nagad, the fake) — flagged for reconciliation |
| bKash / Nagad | cash | only when the gateway refund failed on this refund, or the patient has no access to the wallet — the reason is stored |
| card / bank | manual with a reference | flagged for reconciliation |
| card / bank | cash | only with the **owner's** approval (not an admin's), and flagged for reconciliation |

The way back is chosen per allocation at the request (the approver sees it); a gateway allocation whose refund failed
may be paid in cash at payout with the reason `gateway-failed`.

- **Cash** comes from the drawer of whoever pays out: they must have an open shift (cashier or pharmacist). It counts as
  `cashRefundPaisa` in that shift's expected cash. It is not checked against what the drawer should hold (counts are blind).
- **Gateway refunds** follow ADR 0011: the payout is claimed and committed first, the gateway is called after the
  commit, its answer is stored in a second transaction. Completed → that allocation is paid with the `refundTrxId`. A
  refusal → the allocation stays unpaid with why (the cashier can retry later, or pay cash with `gateway-failed`).
  No answer → Refund Status; still unknown → "being checked" and the payments sweep asks Refund Status again after 2
  minutes. A refund is **never sent again by the system** (bKash refuses a duplicate within 10 minutes anyway): only a
  person, after Refund Status shows nothing for it. `sku` = the refund's id, `reason` = the category (never clinical text).
- **Manual refunds** (and cash for card / bank) record the reference and open a `refund-reconciliation` Task in the
  owner's `bill/reconcile`: "matches the statement" or resolved with a note. The refund is paid either way; the flag shows
  until the owner decides.
- A refund is `paid` when every allocation is paid. Each allocation keeps who paid it, when, how and its reference.
- **Who received it** (Kamrul): at payout the name, mobile number and relationship to the patient of the person who took
  the money are required (the payer is often a relative) and printed on the voucher above a signature line.

### Approvals (decision 10)
A Task kind `refund-approval` (focus = the bill) in the single Approvals queue, the same rules as a discount: owner or
admin, never their own request, within the approver's limit. A refund with a **controlled drug** on it, or one paying a
card / bank payment back in cash, is approved by an **owner** only. Rejecting needs a note ≥ 10.

### The refund voucher
Paid → **RF/yy/nnnn** per facility per year from `Sequence` in the same transaction; an immutable copy (bill, lines with
VAT, allocations with method and reference / TrxID, recipient, requester, approver, payer) with a ≥ 20-character verify
code. Printed and reprinted like a receipt (copy 0, then DUPLICATE #n with a reason; append-only); a public verify page
shows facility, voucher number, date and amount only. Titled "Refund voucher" until the accountant confirms the Mushak
credit-note layout (pre-pilot accountant list).

### Void after refund (ADR 0005 addendum)
INVOICE gains `markError` from `partially-paid` and `balanced`. A bill holding money is voidable only when every paisa
of its confirmed money has been refunded and no refund is open; a pharmacy / OTC bill only when every unit of medicine on
it has been returned. Everything else in ADR 0005 stays (owner / admin, reason, no pending link, approval or case).
Confirmed payments stay confirmed (there is still no way out of `confirmed`); the bill carries `refundedPaisa`.

### Pharmacy returns (ADR 0009 addendum)
- A medicine line is refunded by units. When the refund is **paid**, the units come back as a `return` StockMove into a
  **quarantine** batch (same medicine, batch number, expiry and prices as the batch it left), and a `MedicationDispense`
  row with action `return` points at the dispense it reverses (append-only; the original row is never edited). An OTC
  sale's units come back the same way (no dispense row).
- **Returned units reopen the prescription line** (`dispenseStatus` counts given − returned). With "wrong dispense" the
  pharmacist dispenses again through the normal dispense with the reason "re-dispense after return".
- **"Wrong dispense"** tells the prescribing doctor (inbox `return-notice`) on every return of that category, and shows on
  the owner's leakage list as a **medication incident**.
- **Quarantine → counter** only with a pharmacist's "unopened, resaleable" decision and a reason ≥ 10, never for an
  expired batch; a controlled drug needs the owner. It is a `transfer` (two legs) backed by that decision. Otherwise it
  stays in quarantine (disposal is a later step).
- A refund with a controlled drug on it is approved by an owner only.

### Reconciliation → refund
A reconciliation case (money the gateway reported that never became confirmed money on the bill) can be resolved as
**"refund to patient"**: that opens a refund with source `reconciliation`, category `overpayment`, no lines (not a credit
note — no revenue was recognised), one allocation against the case's payment for the case's amount, re-confirmed by the
gateway at that moment. The case is resolved with the refund's id. Callback gateways only (bKash cannot produce such a
case, ADR 0011) → manual or cash with a reason.

### Owner dashboard (ADR 0008)
The refunds tile is live: refunds paid out in the period (by allocation paid day; lower is better), with the list
behind it (bill, category, reason, requester, approver, payer, method) — audited with the patients it reveals.
Leakage: refunds paid (with reason and approver), manual refunds not yet matched, wrong-dispense medication incidents.
Withdrawn refunds are listed as withdrawn, never as rejected. Revenue stays "bills issued"; collections stay gross.

### Offline
Refunds need a connection: no outbox, every refund screen and route refuses work offline.

## Consequences
- Migrations `refunds` (+ guards): Refund, RefundLine, RefundAllocation, RefundVoucher, RefundVoucherPrint,
  StockResale; Invoice.refundedPaisa; MedicationDispense `return` (+ returnOfId); triggers for every rule above.
- `@setu/domain` `refund.ts`; REFUND machine; INVOICE `markError` from partially-paid / balanced; `dispenseStatus`
  with returns; kpi refunds tile live.
- `PaymentProvider` gains `refundSupport`, `refund`, `refundStatus` (bKash + stand-in; the fake is manual).
- New screen `ph/refund` hand-added to the access matrix (pharmacist, owner, admin; Clinic) beside the designed
  `bill/refund` — **the prototype gets it in the next design round.**

## Addendum (Kamrul, 05/10/2026 — open questions 220–232)
- **One refund = one payout method (220).** All allocations of a refund go back the same way; a gateway refund goes back
  against one payment (one call). A bill paid part cash, part bKash gets two refunds, each with its own voucher. A refund
  is never part-paid: "paid" means the whole amount left in one transaction (a gateway refund: one claim, one answer; if
  the gateway refuses, the whole refund may go back in cash with "gateway-failed"). This replaces the per-allocation
  payout above.
- **Return without refund (221).** On an issued pharmacy / OTC bill on which no money was ever confirmed and nothing is
  pending, the pharmacist (or cashier) asks for a `return` (Refund.kind `return`, categories wrong dispense / patient
  request / other, medicine lines only, no allocations). Same approval path (owner / admin; controlled → owner). Recording
  it brings the units into quarantine like a refund's, marks them back on the bill line, and lowers the due:
  `Invoice.creditedPaisa` (the database keeps it equal to the recorded returns) — due = total − credited − paid; a bill is
  balanced at paid = total − credited; a receipt prints the credit (paid + due + credited = total). The voucher is a
  **credit voucher CV/yy/nnnn** (no money left; no recipient required). Once every unit is back and no money was ever
  confirmed, the ADR 0005 void applies. Once money is on the bill, a refund is the way.
- **Self-approval (223).** The requester may decide their own refund only when they are the facility's only active owner
  / admin, with a note (≥ 10); the refund is flagged `selfApproved`, the audit says "self-approved", and the owner's
  dashboard lists it (leakage `selfApproved`). The same rule applies to the owner's check of a refund paid by hand. The
  database re-checks it (`facility_approvers`). Stock counts keep their own rule (open question 186) for now.
- **Unknown gateway answers (227).** A refund answer with a code the adapter does not recognise (a duplicate refund, an
  11th refund — undocumented) is "unknown — ask Refund Status", never refunded and never failed. A gateway answer for
  an allocation we already recorded as paid changes nothing. The exact codes go on the pre-pilot bKash sandbox list.
- The owner's leakage list keeps money and credits apart: "refunds paid" counts money refunds only; returns without
  refund have their own row ("due written off"); self-approved refunds their own.
- Migration `20261005200000_refunds_decisions`.

## Addendum 2 (Kamrul, 05/10/2026 — open questions 233–235)
- **A return on a partly paid bill (233).** A return's value V on a pharmacy / OTC bill with a due resolves in two parts by
  one rule: **credit = min(V, due)** lowers the due (`Refund.creditPaisa`, kept on `Invoice.creditedPaisa`), **refund = V −
  credit** goes back from confirmed money through the allocations under the refund rules (one way back, who took it).
  One request, one approval, one voucher showing both parts (RF when money went back, CV when it only credited). A bill
  whose due reaches what was paid becomes balanced. A fully paid bill has no due: medicine on it is refunded, not
  returned. No stock ever stays out because of how the bill was paid. Replaces "return without refund" as the only
  return.
- **One self-approval rule everywhere (234).** Refused while another active owner / admin exists at the facility; with
  exactly one approver, allowed with a mandatory note and flagged self-approved on the record, in the audit and on the
  owner's exceptions list. Stock counts follow it now (`StockCount.selfApproved`; Kamrul's purchasing decision 5 of
  03/10/2026, open question 186 closed).
- **Manual release of a stuck gateway refund (235).** Owner only, audited, after the sweep has tried for at least
  `REFUND_RELEASE_MINUTES` (30): "checked on the bKash merchant portal — not refunded" (note) hands the allocation back
  failed, so the cashier retries or pays cash; "checked — refunded, TrxID …" pays it with that TrxID. Both open a
  refund-reconciliation case so the statement check still happens. On the pre-pilot bKash sandbox list.
- Migration `20261005220000_refunds_decisions_233_235`.
