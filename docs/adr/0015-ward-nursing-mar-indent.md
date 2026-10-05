# ADR 0015 — The admitted patient on the ward: NEWS2 rounds and escalation, nursing notes, ward round notes with
# inpatient orders, the medication administration record, ward indents, bed moves

Date: 2026-10-05 · Status: accepted (Kamrul, 05/10/2026 — slice B3–B4 plan, the ten defaults with changes to 3, 5, 6
and 9; two sessions)

## Context
Slice B1–B2 admits a patient to a bed and opens the IPD encounter. Walkthrough B4–B7 continue on the ward: the bed map
(B4), the MAR with checks and reasons (B5), vitals with an escalation that must be logged (B6, issue #24), the doctor's
round (B7); the pharmacy issues ward indents. The domain model has MedicationRequest, MedicationAdministration, the
MAR_DOSE and ESCALATION machines and the BED machine; nothing yet orders a medicine for an inpatient, records a dose,
scores NEWS2 or moves stock to a ward.

## Decision
### Nursing rounds: NEWS2 (sample, pending clinician sign-off)
- Ward vitals add respiratory rate, consciousness (ACVPU: Alert, new Confusion, Voice, Pain, Unresponsive) and
  supplemental oxygen to the A4 fields; the A4 impossible-value rules apply. NEWS2 (RCP 2017, SpO₂ scale 1 for every
  patient — scale 2 is not supported and the screen says so) is computed in `@setu/domain` ward.ts and stored as an
  Observation `news2` (method `calculated`).
- **Escalation**: aggregate ≥ 5 (sample threshold) or any single parameter scoring 3 (the NEWS2 red score) raises an
  EscalationEvent (ESCALATION `raised`), a critical doctor-inbox item (`news2-escalation`) for the admitting doctor and
  a banner on the ward board. One open escalation per encounter; a higher score while it is open sends one more inbox
  item. The nurse logs whom she spoke to and the instruction (`inform` → doctor-informed); the doctor or the nurse
  resolves it with a note (`resolve`).
- **Next observation**: at or above the threshold (or a red score) in 15 minutes (issue #24); otherwise NEWS2's own
  intervals (0 → 12 h, 1–4 → 4 h). Sample, pending sign-off.
- Vitals and nursing notes go through the outbox with device time inside the 24-hour window; offline, the screen
  scores NEWS2 locally and says "call the doctor now — not yet synced". Escalation is raised at server time on sync.
### Nursing notes
Append-only, attributed to the signed-in nurse at server time (device time kept), no PIN (they work offline); a wrong
note is marked entered-in-error with a reason (NURSING_NOTE `markError`), never edited.
### Ward round note and inpatient orders
- A Composition of kind `progress-note`, one per round (a thread): draft → final, amended as v2 of its thread (ADR
  0003). The one-current rule and the version uniqueness move from (encounter, kind) to (thread) for progress notes
  (`Composition.threadId`); other kinds keep theirs.
- Its medication lines are **inpatient orders** (`MedicationRequest.kind = inpatient`): route, dose text, dose in issue
  units (none for multi-dose vials), times of day or PRN with a maximum per 24 hours, start (the signing time).
  Lab orders are ServiceRequests on the note, active at signing (ORDER). The allergy, same-medicine, same-class and
  interaction checks of A5 run on the lines exactly as in A5 (against the patient's active allergies and the other
  active inpatient orders); a blocking warning refuses the signature.
- **MEDICATION_ORDER** (new): `active → stopped | superseded | completed`. A doctor stops an order with a reason and the
  PIN (future doses end at once). Signing an amendment supersedes v1's lines; a v2 line continues a v1 line — and
  carries its regimen (`regimenId`: PRN cap and slots) — only when drug, dose, route and frequency are unchanged; any
  change is a new regimen and the old line's future doses stop. A line is an active order only while it is `active`
  and its note is current.
### Medication administration record
- **MedicationAdministration** (custom row per recorded dose, append-only): the order, its regimen, the slot (or none
  for PRN), the outcome (given | held | refused | missed — MAR_DOSE), the time given, the nurse, who prepared it, the
  five checks (patient, drug, dose, route, time) as recorded ticks, the reason, the witness, the stock source
  (`ward-stock` | `patient-supplied`, shown distinctly on the chart). MAR_DOSE gains `markError` (→ entered-in-error,
  with a reason); nothing else is ever changed.
- Rules (`@setu/domain` mar.ts; the route and the database enforce them): only an active order of this patient and this
  open inpatient encounter; never in the future (server clock + 2 min) or before the order started; one record per
  slot (a double dose is refused); a dose outside ±60 minutes of its slot (sample) needs a reason; held, refused and
  missed need a reason, and missed only once the window has passed; given needs all five ticks; PRN given at most the
  order's maximum in any 24 hours (counted over the regimen); an active allergy matching the drug (recorded after the
  order) blocks giving until the doctor stops or re-signs it.
- **High-alert drugs** (sample, pending clinician sign-off: insulin, heparin, potassium chloride, morphine, pethidine)
  need a witness: a second nurse or a doctor of the facility, never the person who prepared or is giving the dose; the
  witness's PIN is verified inside the same transaction (a wrong PIN counts against the witness).
- **Stock**: a unit-dose drug given from ward stock moves its issue units out of the ward (`administer`, FEFO); short
  ward stock refuses it (raise an indent, or record the patient's own supply). A multi-dose vial (insulin, heparin) is
  consumed when the nurse records "vial opened" (opened-at kept and shown); discard-after-opening periods are on the
  clinician pre-pilot list.
- Doses need the connection (like signing); no offline administration.
### Ward stock and indents
- Ward stock is a stock location `ward:<ward id>`. A nurse requests an indent (WardIndent + lines); the pharmacist
  issues from the store (FEFO, not expired) as a two-leg transfer `indent-issue`. **INDENT** (new): `requested →
  partially-issued → issued`, `requested | partially-issued → cancelled` (the balance). A controlled drug's issue needs
  the pharmacist's PIN and writes a ControlledDrugRegister line; so does giving a controlled drug (with the witness).
  The database refuses a controlled-drug issue or dose without its register line.
### Bed moves
Within and between wards through the two-leg move of ADR 0014: the destination is reserved (leg 1), the receiving
ward confirms arrival (leg 2: destination occupied, source to cleaning), or both in one step; reason and handover note
recorded. A move to another class shows the sample daily difference only — the IPD bill is untouched (slice B8).

## Consequences
- New tables MedicationAdministration, MultiDoseVial, EscalationEvent, NursingNote, WardIndent, WardIndentLine,
  ControlledDrugRegister; MedicationRequest gains the inpatient columns; Medicine gains inpatientOnly, highAlert,
  controlled, multiDose, issueUnit, routes; Composition gains threadId; StockMove gains the kind `administer`;
  StockBatch locations gain `ward:<id>`.
- New machines MEDICATION_ORDER, INDENT, NURSING_NOTE; MAR_DOSE gains `markError`; the doctor inbox gains
  `news2-escalation`. OPD prescription search hides inpatient-only medicines.
- Pre-pilot, for a clinician: NEWS2 threshold and intervals, the dose window, the high-alert list, discard-after-opening
  periods, SpO₂ scale 2.

## Amendment — session 2 reviews (06/10/2026)
The code and clinical-safety reviews of the screens changed these rules (domain `doseBlockers`, the API and the database
guard; migrations `20261006090600_ward_review`, `20261006090700_escalation_worse`):
- **ESCALATION gains `worsen`** (doctor-informed → raised): a patient worse after the doctor was informed — a higher
  score, or a first red parameter at any total (`peakRed`) — notifies the doctor again and asks the nurse for a new
  contact log. Before, only a higher total notified, and the status stayed "informed".
- **Multi-dose vials:** a dose from ward stock needs an opened vial of that medicine for this patient (any regimen — a
  dose change keeps the open vial); the amount actually given is recorded (`amountGiven`, e.g. "4 IU" for a sliding
  scale). Opening a vial is a confirmed dialog with its source.
- **Doses:** the same medicine given under an earlier regimen within the window of a new slot needs a reason (a changed
  order starts a new regimen and could otherwise double a dose just given); a PRN dose is charted within the hour it is
  given (no backdating between the 24-hour cap windows); no slot more than 12 hours ahead is charted; the guard
  requires a witness for controlled as well as high-alert drugs and refuses the giver or preparer as witness.
- **Amendments:** a copied line whose order was stopped after the amendment draft opened blocks signing (`line_stopped`)
  — the doctor removes it, never a silent restart.
- **Entered-in-error:** only the nurse who recorded the dose, only on an open admission; the MAR cell shows a slot's
  errored record.
- **The MAR day:** today's grid carries the last 24 hours' slots (`marSlotRange`), so every dose the ward board counts as
  overdue is on the MAR (just after midnight yesterday's 22:00 dose).

## Amendment 2 — Kamrul's decisions of 06/10/2026
Migration `20261006090800_escalation_reach_dose_error_stock`.
- **Escalation reach (engineering half built; the clinician decides N and who is on duty before the pilot):** every
  escalation carries `ackDueAt` = raise (or worsening) + N minutes, N a facility setting (`escalationAckMinutes`, 5–120,
  sample 15). A doctor's acknowledgement of the NEWS2 item in the app inbox acknowledges it; a nurse's logged phone call
  does not. A sweep every minute raises an escalation past `ackDueAt` without an acknowledgement to every doctor on duty
  — the facility's duty list (`escalationDutyDoctorIds`), or every active doctor when it is empty — who has not had it,
  marks it `widenedAt`, and audits it as `system:escalation-sweep`. The ward board, the vitals screen and the round
  worklist show it **unacknowledged**. Worsening clears the acknowledgement and restarts the clock. Applied to every
  NEWS2 escalation (score at or above the threshold, or a single red parameter).
- **A dose marked entered-in-error asks "was the stock drawn?"** when it took ward stock. "No" puts the units back to
  the ward batches they came from (StockMove `ward-return`, refType `dose-error`, with the error reason; the database
  allows no more than the dose took) and the ward stock card lists returns of the last 7 days for the next count; "yes"
  or "not sure" moves nothing. A controlled register line is never changed: a linked `dose-error` line records the
  reason and the answer and adds back what was returned (qty 0 otherwise).
- Kept as built: a controlled drug is always witnessed; stopping an order needs the doctor's PIN; held / refused before
  due, missed only after the window, PRN given or refused only. Open questions 264–269 accepted.

