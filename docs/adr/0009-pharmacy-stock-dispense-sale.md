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

### The pharmacist at the counter (session 3)
**`bill/pay`, `bill/receipt` and `bill/shift` gain the pharmacist** — beyond the design handoff (`shell-roles-plans.md`):
added to `packages/domain/src/access-matrix.json` by hand with a test that keeps it (as `bill/reconcile`, ADR 0005);
**the prototype gets it in the next design round.** The pharmacist never gets `bill/opd`, approvals or reconciliation,
and the API shows them pharmacy and OTC bills only (`billKindsFor`).

## Consequences
- Migrations: StockBatch, StockMove, MedicationDispense (session 1); Supplier, PurchaseOrder (+ lines), GoodsReceipt
  (+ lines), StockCount (+ lines) (session 2); Invoice.kind (`opd | pharmacy | otc`), nullable visit / patient for `otc`,
  ChargeItem source `dispense | sale` and kind `medicine` with the batch; the one-open-bill-per-visit rule becomes per
  visit **and kind**.
- Billing code that finds "the visit's bill" asks for kind `opd` explicitly.
- `@setu/domain` `pharmacy.ts` (FEFO, batch state, near expiry, dispense status, substitution, sale class, dose label);
  the demo list gains one controlled sample (diazepam) and a sample sale class per medicine (pending a licensed drug
  database — gap 12).
