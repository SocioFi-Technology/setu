# ADR 0017 — The IPD running bill, deposits, packages, class changes and the discharge checklist (slice B7–B9)

Status: accepted (Kamrul, 06/10/2026 — the B7–B9 plan: decisions 1, 2, 4–12 as recommended; 2 and 3 with the changes
recorded below)

## Context
Walkthrough B8 (IPD billing: line tags, the low-deposit alert with a guardian link, the class-change preview) and B9
(ward in-charge: six steps, the blocker named, mark done). B7 (the round) was built in slice B3–B4. Until now the
admission opened an empty IPD bill draft that nothing posted to and nothing could pay (decision 245); bed-class prices
were sample constants; a transfer changed the admission's class without a price (decision 263); there was no package,
deposit or inpatient discharge, and an unused linear `DISCHARGE` machine. B10 (the final bill, settled against the
deposit) and B11 (the discharge summary) are the next slice.

## Decisions
### The running bill is rebuilt from its sources
The IPD bill (Invoice kind `ipd`) stays a **draft** for the whole stay; B10 issues it. Its lines are derived from five
sources, each line carrying a stable `key`:

| Source | Key | Posted |
|---|---|---|
| the package (if any) | `pkg` | at admit, or when the cashier applies one |
| bed days | `bed:<n>` | day 1 at admit; day n by the 00:01 Dhaka census (the minute sweep) |
| orders on the inpatient visit (round lab orders) | `order:<serviceRequestId>` | when placed |
| ward stock drawn for the patient (MAR doses, vials opened) | `stock:<refType>:<refId>:<batchId>` | when drawn |
| charges the cashier posts from the price list | `manual:<id>` | when posted |

One pure function in `@setu/domain` (`ipdBill.ts`, `desiredLines`) turns the facts (package snapshot, admission day,
the classes occupied each day, orders, stock drawn net of returns, manual charges) into the lines the bill should
have — tag, unit price, quantity. The API **reconciles** the bill to it after every event that changes a source and in
the sweep:
- a line whose key is wanted unchanged stays;
- a wanted line whose price, tag or quantity changed **supersedes** the posted one: the old line keeps every value and
  gets `supersededById` / `supersededAt` / `supersededReason` (set once, nothing else ever changes — rule 3), the new
  line is active, the audit names the event;
- a posted line no longer wanted (an order cancelled, a dose's stock put back) gets a **credit line** (`credit:<key>`,
  negative quantity, `creditOfId`), both shown;
- totals are the sums over lines that are not superseded. Lines of an IPD bill are never deleted (database).

### Tags: Package / Included / Excluded
- **Package** — the package line, at the package's price for the stay's class (below).
- **Included** — covered by the package, shown at ৳0: bed days 1..`days`; a service whose code is on the package's
  item list, up to its limit, counted in order placed; a medicine on the package's medicine list.
- **Excluded** — everything else, at its price: bed days past the package's days, services past their limit or not on
  the list, medicines off the list, manual charges not on the list. With no package every line is Excluded.

### Bed days: midnight census; class changes (Kamrul, decision 3)
- Admit posts day 1 (the admission day) at admit. Day n is posted at 00:01 Dhaka of the admission day + n − 1 while the
  patient is in. The discharge day was posted at its own 00:01, so there is no extra day at release.
- **Moving up** re-prices the **current** bed day to the higher class: the posted line is superseded by a new line
  (never edited), audited with the move. **Moving down** applies from the next bed day; it costs the patient nothing
  on the day of the move. One rule gives both: **a bed day is priced at the highest-rate class occupied during that
  Dhaka day** (the census class at 00:00, and every class arrived in that day).
- **The package on a class change** is priced at the highest class occupied during the stay so far (a move up
  supersedes the package line with the higher class's price from the package snapshot; a move down leaves it). If the
  package has no price for the new class, the package keeps its price and the bed days in the new class beyond the
  package's days are Excluded at that class's rate (open question).
- The class-change **preview** is read-only arithmetic on the bill (`classPreview`): per day old → new, package old →
  new, extra for the patient for the rest of the package days plus two more days, "applies from today (moving up) /
  from tomorrow (moving down); earlier days are not re-priced". Classes change only through the bed move (slice B3–B4).

### Prices
Bed-class daily rates move from the sample constant to a per-facility table `BedClassRate` (class, rate paisa,
`sample`), seeded from the old sample values (pending the owner's prices). The package snapshot carries per-class
package prices. Orders are priced from `ChargeItemDefinition` (`test:<code>`), stock from the batch's MRP and VAT (as
dispense lines), manual charges from the price list. VAT on IPD lines is the stored rate, 0% by default (decision 11).

### Packages (decision 5)
`Package` (code, names, days included, valid from/to, `sample`), `PackagePrice` (per bed class) and `PackageItem`
(included services by code with a limit, included medicines by key, excluded items as text) — seeded samples pending
sign-off. The admission keeps a **snapshot** of the package (prices per class, days, items) taken when it is applied,
so a later catalogue change never re-prices an admitted patient. A package is chosen at admission or applied by the
cashier while the bill has none; applying it re-tags earlier lines by supersession. `bill/pkg` is read-only in this
slice; editing and the owner's publish step are a later slice.

### Deposits are payments on the draft IPD bill (Kamrul, decision 2)
- **Paying against a draft bill is an IPD-only exception**: a payment may be taken on a `draft` bill of kind `ipd`
  (the deposit); every other bill still takes money only once issued (database, `payment_guard`). A deposit uses the
  whole payment machinery unchanged: cash into the cashier's open shift, card, bKash links and their sweep,
  reconciliation. The bill stays `draft`; its `paidPaisa` is the deposits confirmed so far (the database keeps it the
  sum of confirmed payments, as for every bill). The deposit amount is free (no "more than due" check — the bill is
  still running), at most ৳5,00,000 a payment.
- **A deposit receipt is a money receipt, not a tax invoice**: `Receipt.kind = deposit`, one per confirmed payment,
  numbered `DR/yy/nnnn`, printing the amount (in words, Bangla and English), method, TrxID or reference, the admission
  number, deposits to date and the cashier — no lines, no VAT. The tax invoice is the final bill (B10).
- **Excess deposit returns through the refunds slice** (ADR 0013) as a refund of source **`deposit-excess`** once the
  final bill is issued (B10): approved, paid out in cash from an open shift or to the bKash wallet it came from, on an
  RF voucher.

### The low-deposit alert and the guardian's link (decision 6)
Balance = deposits − patient share (package + excluded − credits). **Low** when the balance is under two days of the
current class's daily rate; **Due** when it is negative. "Send payment link" takes a bKash deposit by link sent by SMS
to the **guardian's phone on the admission** (the patient's phone is the other choice); the cashier sets the amount,
the payment records the phone it went to, and the SMS names the admission number. Audited.

### The discharge checklist (B9)
`Discharge` (one live per admission: `ordered` → `completed` | `cancelled`) with six `DischargeStep` rows. (The
domain model says "Task per step"; `Task.status` is the approval machine, so steps get their own table.) Each step is
`waiting` → `in-progress` → `done`; it starts when the steps it waits for are done:

| # | Step | Done by | Waits for | Done how |
|---|---|---|---|---|
| 1 | Doctor's discharge order | doctor | — | the order itself (PIN, advice, target time) |
| 2 | Discharge summary | doctor | 1 | by hand with PIN until B11 signs the summary |
| 3 | Pharmacy clearance | pharmacist | 1 | PIN: the patient's own medicines handed back (or none) — a dose error is answered when it is recorded |
| 4 | Final bill | cashier / owner | 3 | by hand with PIN until B10 issues the final bill |
| 5 | Payment and clearance | cashier / owner | 4 | by hand with PIN until B10 settles against the deposit |
| 6 | Bed release to cleaning | nurse | 2 and 5 | PIN |

- Steps 2, 4 and 5 done by hand are marked **"recorded by hand"**; B10 and B11 complete them from the real events and
  remove the manual path (decision 8). Admin may do any step.
- **Blocking**: an unfinished step that a waiting step depends on, when that waiting step's other dependencies are
  done. The header names who is blocking: the department and, when someone has taken the step ("I'll take it"), the
  person — "Blocked by Pharmacy · Md. Jewel Rana". Steps show how long they have waited; "Remind" marks the step
  reminded (who, when — shown on the department's discharge list) and, for the doctor's steps, sends a doctor-inbox
  notice (kind `discharge-remind`); at most once every 10 minutes per step.
- **The order** (doctor, PIN): BED `startDischarge` (occupied → discharge-pending), the target time (default three
  hours). No bed move while discharge-pending. **Cancel** (doctor, reason, before step 6): steps stop, BED
  `cancelDischarge` (discharge-pending → occupied, new event).
- **Bed release** (step 6, nurse): ADMISSION `discharge` (admitted → discharged, new state), ENCOUNTER `finish`, the
  live bed assignment ended `discharged`, BED `leave` (→ cleaning), active medication orders MEDICATION_ORDER
  `complete`. Bed days stop. The bill stays a draft for B10.
- The old linear `DISCHARGE` machine is replaced by the step graph (`DISCHARGE_STEP`: waiting → start → in-progress →
  finish → done; plus `DISCHARGE`: ordered → complete | cancel).

### Who
IPD bill: cashier, owner, admin (read and write); the bill route checks `bill/ipd`. Discharge screen: nurse, doctor,
receptionist, admin (`ipd/discharge`) and the pharmacist for step 3; each step is written by its owner role. Clinic
plan: the lock page (Hospital Lite and up).

## Consequences
- `billKindsFor` gains `ipd` for the IPD bill's routes only; the OPD pay screens still never list an IPD bill.
- `charge_item_guard`: an IPD line is never deleted; an update only sets the supersession once. `charge_item_kind_guard`
  admits the new sources (`package`, `bed-day`, `stock`) on IPD bills only. `invoice_guard`'s issue check sums the lines
  that are not superseded. `payment_guard` admits a payment on an IPD draft. `admission_guard` admits `discharged` and
  the package snapshot set once.
- The bed-day census runs in the minute sweep (`bed_day_sweep_targets`), idempotent per admission and day.
- ER charges of an admitted patient (known gap 13), corporate payers and the payer split stay out (self-pay only).

## Addendum — Kamrul, 06/10/2026 (questions 287–297)
- The package follows the dearest class occupied during the stay and is never lowered (287).
- Cash deposits only from someone who holds a drawer shift (291): shift close counts cash by who took it.
- **For B10 (297):** when the final bill is issued at discharge and the deposits held exceed its total, the excess
  becomes a refund request (source `deposit-excess`, owner approval, paid at the counter) in the same transaction that
  issues the bill: the issued bill holds exactly its total, the patient leaves with a voucher for the rest, and the bill
  is never issued while an excess is unassigned.

## Addendum — the session 2 review (06/10/2026)
- The OPD bill routes never reach the IPD running bill (they could have voided or issued it): `billKindsFor` is back to
  opd / pharmacy / otc, and only the routes the deposits share (wallet retry / check / cancel / SMS, reconciliation, the
  receipt view and print) ask for it. The database keeps the IPD bill a draft until the final-bill step (B10) lifts it.
- A wallet deposit's retry is not capped by a "due" (the running bill has none). The money receipt names who took the
  money. Payment and clearance by hand is refused while a deposit link is waiting, and keeps the bill as it stood.
- Who posted an IPD line is the signed-in user (null only for the census); rates and packages are read-only for the app
  role until the owner's publish step; the census lists only open draft bills and never for a future time.
