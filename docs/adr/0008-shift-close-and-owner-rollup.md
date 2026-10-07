# ADR 0008 — Cashier shift close and the owner's daily rollup

Date: 2026-10-03 · Status: accepted (Kamrul, 03/10/2026 — phase 2 plan, slice C1–C4)

## Context
Journey C is the owner's morning check on a phone: KPIs with the list behind each number (C1), discounts above policy
(C2), approve one / reject one with a reason (C3), and a cashier's cash variance — accept it or ask for a recount (C4).
The domain model names `ShiftClose (custom) | cashier, counter, expected, counted by denomination, digital vs
settlement, variance, reason, approver` and the machine `Shift open → counted → closed(variance reason) → approved |
recount` (already in `machines.ts`). There is no table for either, no scheduler, and no reporting store. Walkthrough
issue #24: accepting a variance needed no note; #23: every KPI showed the same templated change.

## Decision
### Shift close
- A **Shift** belongs to one cashier at one facility, opened with an opening float (paisa ≥ 0). At most one shift per
  cashier per facility is not yet approved (open, counted or closed).
- **Expected cash** = opening float + confirmed cash payments taken by that cashier (Payment.createdById) at that facility
  from the shift's opening until the count − cash refunds (none exist yet: 0). Digital money (bKash, Nagad, card, bank)
  is summed the same way and shown against the settlement the cashier enters; a mismatch is shown, never blocking.
- **Count:** the cashier enters notes by denomination (1000 … 1 taka). Each count is an append-only **ShiftCount** row
  (counts, counted, expected, the digital totals and settlement as at that moment, variance, reason); the Shift points
  at its latest count. `count` (open → counted) and `close` (counted → closed, the hand-over) happen together when the
  cashier presses "Hand over & close": a non-zero variance needs a reason (≥ 10 characters).
- **Owner / admin** (no manager role — decision of 03/10/2026), never the cashier of that shift: **approve** (closed →
  approved; a non-zero variance needs a note ≥ 10 — issue #24) or **recount** (closed → open, with a note ≥ 10; the
  cashier counts again — the earlier count stays on record).
- Payments are not blocked when the cashier has no open shift (the flows of slices A6–A7 stay as they are); the owner's
  leakage list shows "cash taken outside a shift".

### Owner rollup and live counts
- **DailyRollup** — one row per tenant, facility and Dhaka day: the day's metrics as JSON (revenue = bills issued that
  day, not voided; collections = payments confirmed that day; discounts given on bills issued that day; dues = what was
  still owed on issued bills at the end of the day; OPD visits; no-shows; lab tests released and their median
  turnaround; cash variance of shifts approved that day; receipt reprints), revenue and collections also **by hour**,
  collections by method. Computed by an in-process nightly job (00:30 Dhaka; the last 7 days are recomputed so a late
  void or a late confirmation is reflected) and on demand for any missing past day. **Today is always live** from the
  source tables; nothing on the dashboard is a sample.
- Each KPI is compared with the period before (today against the same weekday last week up to the same hour; 7 / 30
  days against the 7 / 30 before), judged better or worse by its own direction (`@setu/domain kpi.ts`). Tiles whose data
  comes with a later module (deposits, refunds, share payable, supplier dues, stock value, near-expiry) say so.
- **Drill-down:** every number opens the list behind it (bills, payments, visits, shifts) for the same period — each
  view is audited with the patients it revealed (C1, C2 "viewing is logged").
- **Leakage list:** discounts above the cashier's limit (bill, amount, who asked, who approved), receipt reprints with
  their reasons, shift variances, "not billed here" lines, cash taken outside a shift. Voided-after-payment cannot
  happen (ADR 0005 refuses it).

## Consequences
- Migrations: Shift, ShiftCount (append-only), DailyRollup; guards (SHIFT transitions only, who columns = signed-in
  user, approver ≠ cashier, one open shift per cashier and facility).
- `@setu/domain`: `shift.ts` (denominations, count, expected, hand-over and accept blockers, digital rows) and `kpi.ts`
  (periods, changes, which tiles have data).
- The API gets a small scheduler (`setTimeout` to the next 00:30 Dhaka, one run per process; a second process would only
  recompute the same rows — upsert).

## Addendum (2026-10-07, external review A5): the blind count — count and hand-over are separate steps
The money-controls review (M1) made the count blind on the screen, but the server still revealed the variance in a 422
that stored nothing, so a cashier could post an empty count, read what the drawer should hold, and then "count" to
match. Now:
- **What the system expects is never the cashier's to see.** The cashier's shift view (`/v1/shifts/mine`, the shift
  itself, the counts) carries no expected cash, cash in, cash refunds or digital system totals: the fields are optional
  in `ShiftView` / `ShiftCountView` and only the owner or admin (not on their own shift) gets them. While open, the
  cashier sees how many payments were taken, nothing more.
- **`count` (open → counted) stores the count first.** Every `POST /v1/shifts/:id/count` writes the ShiftCount (no
  reason on it), points the shift at it and moves it to `counted`, audited as `count` with the variance. Only that
  answer shows the variance. A count cannot be repeated: the next one needs the owner's `recount` (closed → open), so a
  zero-note probe is itself the count of record.
- **`close` (counted → closed) is the hand-over.** A matching count is handed over in the same request. A variance
  waits in `counted` for `POST /v1/shifts/:id/hand-over { reason }` (10+ characters), which writes an append-only
  **ShiftHandover** row (shift, the count it hands over, reason, the cashier, when) and is audited as `hand-over`.
- The database: `ShiftHandover` is immutable, its guard requires a counted shift's latest count, the cashier themself
  and a reason when the variance is not zero; `shift_guard` closes a counted shift with a variance only when that count
  has a hand-over reason (or, for counts written before this change, the reason on the count). `shift_count_sums` no
  longer asks the count for a reason.
- The `variance_changed` / `varianceSeenPaisa` handshake (M2) is gone: the variance a reason answers is the stored one.
- The owner's review is unchanged (closed → approved | open), and so are the dashboard's variance list and drill.

## Addendum 2 (2026-10-07, external review B7): the nightly job — 35 days, once across instances; the median TAT
- **35 days, not 7.** The nightly job recomputes the last **35** finished days (as built): the 30-day view and its
  comparison must reflect late voids, confirmations and refunds across the month the owner looks at. The Decision
  above ("the last 7 days are recomputed") is amended to 35; older days are still computed on demand when missing.
- **One run at a time.** Each API process keeps its own 00:30 timer, but a run first takes a transaction-scoped
  advisory lock (`pg_try_advisory_xact_lock(hashtext('nightly-rollup'))`) held for the run; an instance that finds it
  taken skips (`skipped: true`). The rows stay upserts.
- **Lab turnaround is the median**, as the Decision says (it was a mean). Each day's row stores every released test's
  minutes from order to first release (`labTatMinutes`, rollup version 8 — older rows are recomputed); the tile is the
  median over all tests in the period (`@setu/domain medianMinutes`), never an average of days or of daily medians.
