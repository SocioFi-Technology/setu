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
