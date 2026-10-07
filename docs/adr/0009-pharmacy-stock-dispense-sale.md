# ADR 0009 — Pharmacy: stock ledger, dispense, over-the-counter sale, purchasing and counts

Date: 2026-10-03 · Status: accepted (Kamrul, 03/10/2026 — pharmacy slice decisions; journey P1–P6)

## Context
The domain model has one row for the pharmacy (`MedicationDispense / SupplyRequest / InventoryItem | batch, expiry,
FEFO`); `screens.md` adds "Dispense: preparation → completed | declined". The prototype (Setu Pharmacy) shows FEFO batch
picking with expired batches blocked, same-generic substitution with a reason (the doctor is told), partial dispensing,
a Bangla dose label, OTC sales gated by class, stock by item and batch with near-expiry, purchase orders and goods
received with checks, and physical counts where stock changes only once approved. Prices did not exist (open question
67). Kamrul's decisions: a separate pharmacy bill per visit; the pharmacist takes OTC money and has a shift; prices per
batch set at goods received; approvals above a threshold by the owner / admin.

## Decision
### Stock is a ledger
- **StockBatch** — one per facility × medicine × batch number × location: expiry (last usable day), unit cost and MRP
  (paisa, per tablet / capsule), VAT rate, `sample`. Its quantity on hand is **only** ever changed by **StockMove** rows.
- **StockMove** (append-only): signed quantity, kind `receive | dispense | sale | adjust | return | transfer`, what it
  belongs to (dispense, bill line, goods-received line, count), who, when, reason. The database keeps the batch quantity
  equal to the sum of its moves and never below zero; nobody edits a batch quantity directly.
- FEFO (`@setu/domain` `fefoPick`): usable batches by expiry; expired, empty and quarantined batches are never picked.

### Dispense (P1–P3)
- A dispense works on a **signed, current** consultation note (final or amended). Each action is an append-only
  **MedicationDispense** row for one prescription line: the medicine actually given (the prescribed one, or a
  same-generic **substitute** with a reason ≥ 10 — never one the patient is allergic to; the prescribing doctor's inbox
  gets a `substitution-notice`), the quantity, the batches it came from (StockMove rows), or a **decline** with a reason.
  A line's status is derived (`dispenseStatus`): to dispense → partial (the rest stays open) → dispensed, or declined.
  After an amendment, what was already dispensed for the visit counts against the new version's line for the same
  medicine.
- The charge goes on the visit's **pharmacy bill** (Invoice kind `pharmacy`, at most one open per visit): one line per
  dispense, priced at the batch's MRP × quantity, VAT per line from the batch. The OPD bill is untouched.

### Over-the-counter sale (P4)
- A **pharmacy bill without a visit** (Invoice kind `otc`; the patient optional — a walk-in buyer's name / phone only):
  lines from FEFO batches; `otc` items sell, `rx` items need a prescription photo (stored through the Storage adapter),
  `ctrl` items are refused. Stock moves when the bill is issued; it is paid at the counter by the pharmacist (cash /
  bKash) under the same billing rules; the pharmacist's money is in a **shift** (ADR 0008) like a cashier's.

### Purchasing and counts (P5–P6, session 2)
- New machines: **PURCHASE_ORDER** `draft → sent → partially-received → received | cancelled` (sent above a threshold
  only with the owner's / admin's approval), **GOODS_RECEIPT** `checking → posted` (posting writes the batches' receive
  moves; a line expiring within 6 months is accepted only with an owner / admin OK; a short delivery becomes a debit note
  against the supplier), **STOCK_COUNT** `counting → submitted → approved | rejected` (counted − system per batch;
  any variance needs a reason; stock changes only when the owner / admin approves — the adjustment moves are written
  then). Suppliers carry what is owed (goods received − payments).

### The pharmacist at the counter (session 3; Kamrul 03/10/2026)
**`ph/pay`, `ph/receipt` and `ph/shift` are Pharmacy screens** — beyond the design handoff (`shell-roles-plans.md` has no
such screens): added to `packages/domain/src/access-matrix.json` by hand (pharmacist, owner, admin; Clinic plan) with a
test that keeps them; **the prototype gets them in the next design round.** They reuse the billing payment, receipt and
shift components (links stay inside Pharmacy); the cashier keeps `bill/pay`. The pharmacist has no Billing screen; the
API shows them pharmacy and OTC bills only (`billKindsFor`). Shift close moved with payment so the pharmacist's menu has
one module (Kamrul asked for pay and receipt; shift follows the same rule).

### Approvals (session 3; Kamrul 03/10/2026)
The owner's Approvals screen (`bill/approvals`) is the **single queue for every approval kind** — discount, not billed
here, purchase order above the limit, a goods receipt only the owner may post (price different from the order, expiry
within 6 months), count variance — with a kind filter. The Pharmacy approvals tab stays as the pre-filtered view of the
pharmacy kinds. Nothing is approvable in one place and invisible in the other.

### Dose labels (session 3; Kamrul 03/10/2026)
Printed through the browser's print dialog on a label-sized page (default 50 × 30 mm; the page size is a facility
setting), so any thermal label printer with an OS driver works. Direct printer protocols (ZPL / TSPL) come only when a
pilot clinic names its printer (phase 2). Each print is audited.

## Consequences
- Migrations: StockBatch, StockMove, MedicationDispense (session 1); Supplier, PurchaseOrder (+ lines), GoodsReceipt
  (+ lines), StockCount (+ lines) (session 2); Invoice.kind (`opd | pharmacy | otc`), nullable visit / patient for `otc`,
  ChargeItem source `dispense | sale` and kind `medicine` with the batch; the one-open-bill-per-visit rule becomes per
  visit **and kind**.
- Billing code that finds "the visit's bill" asks for kind `opd` explicitly.
- `@setu/domain` `pharmacy.ts` (FEFO, batch state, near expiry, dispense status, substitution, sale class, dose label);
  the demo list gains one controlled sample (diazepam) and a sample sale class per medicine (pending a licensed drug
  database — gap 12).

## Addendum (2026-10-07, external review A6): purchasing decisions 179–186
- **179 — one supplier's day toward the limit.** A purchase order is judged against the approval threshold (sample
  ৳50,000) together with what this facility already sent to the same supplier that Dhaka day **without an approver** —
  orders not cancelled, neither approved by the owner / admin nor sent by one. Splitting one need into several orders
  under the limit therefore asks; an order the owner already approved does not make every later small order of the day
  ask again. Sends to one supplier are serialised (advisory lock); the approval task and its audit carry the day's
  figure; the order view shows it (`supplierDayPaisa`).
- **180 — receipt price tolerance, per facility.** A supplier bill's line may differ from the order by
  min(`grnToleranceBp` of the line at the order's cost, `grnTolerancePaisa`) — defaults 2 % and ৳50 — and still be
  posted by the pharmacist; beyond it only the owner / admin posts (`price_variance_needs_owner`). The difference is
  |bill cost − order cost| × billed quantity, either direction. Every variance is still shown on the line and recorded
  in the posting's audit (`withinTolerance`); the owner's queue lists only receipts beyond the tolerance. The tolerance
  is stored on the Organization (CHECK 0–10 %, ৳0–1,000), returned with the facility settings and changed through
  them like an approval limit (a reason, flagged `settings-change`).
- **181 — the supplier's VAT / AIT are data.** A goods receipt records the VAT and AIT printed on the supplier's bill
  (`supplierVatPaisa`, `supplierAitPaisa`, entered when posting, frozen with the receipt). What is owed stays
  received qty × the bill's unit cost; input-VAT accounting is a later change.
- **182–184** stand as built: a short delivery is a debit note; short expiry is fewer than 180 days; the same batch
  number at another expiry or price is refused (`batch_conflict`).
- **185 — a count left open at shift close.** STOCK_COUNT gains `counting → abandoned` (event `abandon`). When a
  shift holder's shift closes (the hand-over, in the same transaction), every count they are still entering is ended
  with the reason "ended at shift close…", `decidedById` = the counter, nothing moved. It is audited as the flagged
  action `count-abandoned` and listed on the owner's exceptions (`countAbandoned`, with a drill to each count). The
  location can be counted again. The database: `abandoned` is final, only from `counting`, only by the count's own
  counter (signed in), with a reason of 10+ characters, never self-approved.
- **186** (= 234, decided 05/10): the one self-approval rule for counts — confirmed to reach the owner's
  exceptions list (`selfApproved` leakage row) and its drill.
- **The PO cancel path:** a cancelled order's open approval request is closed through
  `transition("APPROVAL", …, "requested", "reject")`, not an inline status.

## Addendum 2 (2026-10-07, external review A6 follow-up): as the review states the decisions
- **179:** the approval request names the earlier orders the limit counted — their ids, numbers and totals in the
  Task detail (`earlierOrders`), their numbers in its reason and audit; the owner's approval card and the order show them.
- **181:** each Supplier carries `vatTreatment` — `included` | `on-top` | `exempt` (CHECK; default included; set when
  the supplier is added, changed by the owner / admin, audited). A goods receipt copies the flag when it is posted
  (`supplierVatTreatment`, frozen with the receipt), beside the VAT / AIT amounts printed on the bill. Nothing is
  computed: the batch's unit cost is the bill's net unit cost as entered (the landed net cost), and what is owed stays
  received × that cost. How input VAT is accounted for is on the accountant's pre-pilot list.
- **The PO cancel path — APPROVAL gains `withdraw` (requested → withdrawn).** A cancelled order's open request is
  withdrawn, recorded with who cancelled and why (`order cancelled: <reason>`); nobody is recorded as having rejected
  it. The database (`task_withdraw_guard`): only an open request is withdrawn, by the signed-in user, with a reason of
  10+ characters; a withdrawn request is final. Billing and refund tasks are never withdrawn.
