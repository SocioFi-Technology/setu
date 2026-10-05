# ADR 0014 — ER arrival, triage and disposition; admission to a bed; BED `vacate`; two-leg bed moves

Date: 2026-10-05 · Status: accepted (Kamrul, 05/10/2026 — slice B1–B2 plan, the five assumptions and the three
confirmations; two sessions)

## Context
Journey B starts in the ER (prototype Setu ER and OT: triage board by level, assign doctor, overdue flags, one-tap
STAT orders, a signed disposition) and continues at the admission desk (Setu IPD: source, doctor, diagnosis, bed
class, bed pick, guardian, consents, checklist, Admit). The domain model has `Encounter` (class, status, location
history), `Organization / Location` (ward, bed + class, state) and the BED machine; nothing yet records a triage, a
disposition, a bed assignment or an admission, and no bill of kind `ipd` exists.

## Decision
### ER visit = an Encounter of class `er` with an `ErVisit` row (custom, one to one)
- Arrival creates the encounter `arrived` with an ER token (`E-nnn`, its own per-branch-per-day sequence; the token
  unique index now includes the class). Arrival mode (walk-in, ambulance, police, public, referral), brought by and
  the complaint are stored on `ErVisit`. An existing patient is chosen, or an **unknown patient gets a quick
  provisional registration**: a Patient with `identityConfidence = provisional`, named "অজ্ঞাত পুরুষ / Unknown male"
  (female, person), approximate age, identifying features in the ER note. The registration lands on the front desk's
  duplicate-review queue (a `patient-link-review` Task) so the desk resolves the identity later; it blocks nothing in
  the ER. The merge with two confirmers is a later slice.
- **Triage** = ENCOUNTER `triage` with a level 1–5 and the bay (an ER bed, see below). The scale (level, target
  minutes 0 / 10 / 30 / 60 / 120, names) lives in `@setu/domain` er.ts as a **sample scale pending clinician
  sign-off** (the vitals-thresholds pattern); the API and the screen label it so. Overdue = waited past the level's
  target and no doctor assigned; an untriaged arrival is overdue after 10 minutes. Re-triage is allowed while the
  visit is open and is audited.
- **Assign doctor** sets `Encounter.practitionerId` (ENCOUNTER `start`, in-progress). Assigning a patient of 18 or
  over to a doctor whose speciality is paediatrics needs an explicit `paediatricOk` (walkthrough issue #24).
- **The ER note** is a Composition of kind `er-note` (one draft per visit, created at arrival). ER lab orders are
  ServiceRequests on it with `priority = stat`, **active the moment they are placed** (ORDER `order` at creation, not
  at signing), so they reach the lab worklist at once and sit at the top with a STAT marker. Non-lab STAT items (CT,
  fluids, oxygen, injections) are care-order lines in the note's sections until an imaging catalogue and the MAR exist.
- **Disposition** (admit, discharge, refer, death) is a section of the ER note, signed with the PIN through the
  DOCUMENT machine (draft → final; amend, never overwrite). Signing records the kind and its fields on `ErVisit`.
  Admit: the chosen ward bed is **reserved** (leg 1 of the move, below) and an admission request is opened for the
  desk. Discharge (advice, follow-up), refer (destination, reason, transport) and death (time, cause, declared by;
  checklist: certificate drafted, family informed, police informed when medico-legal) **close the ER encounter**
  (ENCOUNTER `finish`) the moment they are signed; their downstream documents are later slices. An admit disposition
  closes the ER encounter when the desk completes the admission.
### Beds: `BedAssignment` rows (custom) and the BED machine
- `Location.bedState` is the bed's state, changed only through BED. A `BedAssignment` (encounter, patient, bed;
  `reserved` → `occupied` → `ended`, with who and when) is the location history the domain model asks for.
- **ER bays are beds** in an ER ward from the admin masters (bed class `ER`), so a triaged patient on a bay holds a
  bed assignment like an inpatient, and admission from the ER is the first bed move.
- **A bed move is two legs with one `transferId`, like a stock transfer** (ADR 0009): leg 1 reserves the destination
  (BED `reserve`, vacant → reserved; a `reserved` assignment); leg 2 occupies it (BED `occupy`) and frees the source:
  an occupied source goes to cleaning through the new event **`vacate`** (occupied → cleaning), a merely reserved
  source is released (reserved → vacant). A direct admission runs both legs in one transaction.
  ```
  Bed   vacant → reserved → occupied → discharge-pending → cleaning → vacant ; blocked(reason)
        occupied ──vacate──▶ cleaning        (transfer out; ADR 0014)
  ```
- **The database enforces occupancy**, not only the route: partial unique indexes allow one live (reserved or
  occupied) assignment per bed and one per patient, and one open inpatient encounter per patient; a trigger keeps
  `Location.bedState` consistent with the live assignment and refuses an assignment on a bed that is cleaning,
  blocked or discharge-pending.
- Block / unblock (reason) and mark-ready (cleaning → vacant) are ward actions with their own routes.
### Admission = an Encounter of class `ipd` with an `Admission` row (custom)
- The desk's Admit, **one transaction**: the IPD encounter is created (ENCOUNTER planned → arrive → start, so it is
  in-progress), the bed move is completed (leg 2, or both legs for a direct admission), the source ER encounter is
  finished and its bay vacated, the admission number `ADM/yy/nnnn` is drawn, and **the IPD bill draft (Invoice kind
  `ipd`) is created here and nowhere else** — later slices (bed days, deposits, packages, pharmacy, discharge) add to
  it. The admission records source (opd / er / direct), admitting doctor, department, diagnosis, bed class, guardian
  and the consents taken (general, financial and guardian ID required; surgical, anaesthesia, blood when relevant).
- The checklist (bed picked, diagnosis, guardian name and phone, required consents) is `@setu/domain` ipd.ts
  `admissionBlockers`; the route refuses on the same list. A bed is pickable when vacant or reserved for this patient;
  cleaning, blocked, occupied and discharge-pending beds are never (walkthrough B3). Deposit and package are **not**
  taken in this slice: the checklist shows "deposit at the counter" without blocking.
- A patient can hold one open inpatient encounter and one live bed at a time (database guards above). The OPD bill
  route refuses an inpatient encounter.

## Why
- Beds and money are the two things a hospital cannot get wrong twice: the database holds the invariants, the
  machine holds the states, the route holds the workflow.
- The ER note as a Composition reuses signing, provenance and amendment instead of a second signing path.
- Two-leg moves make a transfer auditable as one thing and let a reserved bed exist without a patient in it.

## Consequences
- New tables `ErVisit`, `BedAssignment`, `Admission`; `Invoice.kind` gains `ipd`; Encounter token uniqueness is per
  class; `ServiceRequest` orders may be active without a signed note (ER only, flagged by the composition kind).
- Lists of "today's visits" (queue board, vitals worklist, consultation worklist, billing and pharmacy worklists)
  show OPD visits only; the ER board and the admission desk have their own lists.
- `pnpm db:reset-e2e` also closes the E2E Lite hospital's ER and IPD encounters and puts its beds back.
- Open: the triage scale and the ER care-order list are samples until a clinician signs them off (known gap 12).
