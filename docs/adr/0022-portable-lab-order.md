# ADR 0022 — The portable lab order: the doctor orders, the patient picks a centre, the centre accepts all or part (E1–E2)

Status: accepted (Kamrul, 09/10/2026 — "go" on the E1–E2 plan with its five recommendations, below).

## Context
Journey E1–E2 (prototype `Setu Connected Care.dc.html`, scenario "lab"; walkthrough round 2: pass; issue #12 fixed):
Dr. Mizanur at Green Life orders tests the patient may have done anywhere in the Setu network (order LO-2609-0441, six
tests at list price); the patient picks a diagnostic centre (price, turnaround, home collection, "USG not offered");
the centre accepts all or part, with a reason for each declined test that reaches the doctor and the patient; the
doctor re-orders a declined test elsewhere. A centre sees nothing before it is chosen and only this order after; the
tracker is visible to the ordering doctor, the patient and the chosen centre only.
In place: the ORDER machine's network states (`active → centre-chosen → accepted | partially-accepted | declined`),
the network directory and the consent-checked read service (ADR 0021), the patient app (ADR 0020). Orders were
in-house only (`ServiceRequest`, placed by signing a draft note).

## Kamrul's decisions (09/10/2026)
1. **The centre's catalogue:** each centre offers its own tests to the network at its own prices — its price list plus
   an "offered to the network" switch per test — and sets home collection on/off and its fee (prototype ৳200) and its
   turnaround. Payment is E3.
2. **Where the order lives:** at the ordering facility; on acceptance the accepted tests are created in the centre's own
   system as its orders, for a centre patient record holding only name, sex, age and phone (marked "from the Setu
   network"); the two are tied by a network-level order row and visibility scoped to that one order.
3. **Who picks:** the patient in the app, or the ordering facility's front desk on the patient's behalf (recorded as
   made for the patient).
4. **Distance:** not stored yet — sort by price and turnaround, show the centre's area; real distance later.
5. **A declined test's reason:** at least 10 characters.

## Decisions
### The doctor's order
- A consultation order carries `performer`: `in-house` (as before) or `network` ("the patient chooses where").
  `ServiceRequest.performer` (new, default in-house). The ordering facility's lab and bill never take a network order
  (its labels, worklist and visit bill skip them).
- Signing the note with network orders makes **one portable order** (`PortableOrder`, network level, no tenantId) with
  its items (`PortableOrderItem`, one per network ServiceRequest): number `LO-YYMM-NNNN` (one network sequence), the
  ordering facility / patient / visit / doctor, names as snapshots (no cross-tenant reads to show them), status by the
  ORDER machine (`active`). The patient is told: an SMS (fixed template, no test names) and the patient app.
- Row-level security: the ordering tenant reads and writes its orders; the chosen centre's tenant reads the orders
  that chose it (and writes its decision through the API only); the patient reads theirs through
  `person_has_record()` (SECURITY DEFINER: the person's linked claim on that record).

### The centre and the patient's choice
- The centre's network offer: `ChargeItemDefinition.network` (a test offered to the network), on `Organization`:
  `homeCollection`, `homeCollectionFeePaisa`, `networkTurnaroundHours`. `network_centres()` (SECURITY DEFINER): live,
  joined facilities, their area (address), turnaround, home collection and fee, and their network tests with prices —
  nothing else.
- `@setu/domain` `portable.ts`: the offer for an order at a centre (which items it offers, which not, the total at its
  prices, + home collection), the sort (price | turnaround), the acceptance decision (each item accepted or declined
  with a reason ≥ 10 characters → ORDER `accept | acceptPartial | decline`), what may be re-ordered (declined items not
  already re-ordered), visibility.
- Choosing (patient app, or the desk for the patient): only a centre that offers at least one item; ORDER
  `chooseCentre`; audited in the ordering tenant (basis `patient`, or the desk user "for the patient"). Until then no
  centre sees the order; after, only that centre — `PortableOrder` RLS + the API.

### The centre decides (E2)
- A technologist (lab roles) at the chosen centre sees "Network orders" (orders that chose its facility, awaiting a
  decision) with the minimum: patient name, sex, age, phone, the tests, the ordering doctor and facility. Accepting:
  1. the decision is validated (`portable.ts`); items not offered are declined with "not offered here";
  2. in the centre's tenant: the patient record (name, sex, age, phone; `networkOrigin`), a visit, a `network-order`
     note (who ordered, LO number) with the accepted tests drafted under it and signed by the technologist — the tests
     become the centre's active orders through the normal path (its lab labels, worklist and bill take them);
  3. on the portable order: each item's decision, the centre's order ids, ORDER `accept | acceptPartial | decline`.
- Declined items reach the ordering doctor (inbox kind `portable-declined`, written in the ordering tenant as the
  system actor) and the patient (app notice + the tracker). The doctor's "Re-order elsewhere" makes a new portable
  order from the declined items (same original ServiceRequests; each item re-ordered once), and the patient chooses
  again.
- The tracker (`GET …/portable-orders/:id`): steps with who and when, visible to the ordering facility's staff, the
  patient, and the chosen centre — each read audited in the reader's tenant.

## Consequences
- Two more network-level tables (PortableOrder, PortableOrderItem) with three-party RLS; the cross-tenant writes (the
  centre's decision onto the order, the decline notice into the ordering tenant) happen only in `modules/portable.ts`.
- Follow-ups: payment (E3 — bKash / Nagad / at the centre, the centre's prices, home collection fee); results back to
  the doctor and the patient (E3); revoking a portable order; real distance; non-Setu centres; the centre's
  duplicate-patient review for network-origin records.
