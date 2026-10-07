# ADR 0018 — The IPD final bill, the discharge summary, LAMA and death on the ward, the bed after discharge (slice B10–B12)

Status: accepted (Kamrul, 07/10/2026 — the B10–B12 plan: 1, 4–11, 13, 14, 16, 17 as recommended; 2, 3, 12, 15 with the
changes recorded below; the e2e job's CI limit to 30 minutes)

## Context
ADR 0017 left the IPD running bill a draft (`invoice_ipd_frozen`), the summary, final bill and payment steps recorded by
hand, and "bed release" as the moment the patient leaves. Walkthrough B10 (cashier: final summary, settle against the
deposit), B11 (doctor: sign the summary, QR, print, languages) and B12 (ward in-charge: cleaning → mark ready → vacant)
close Journey B. Four database rules assumed a bill holds no money until it is issued; the refunds slice refunds lines of
a bill; nothing modelled LAMA or a death on the ward.

## Decisions
### B10 — the final bill
- **Issue** (cashier / owner, `bill/ipd`): allowed once the discharge is ordered (any kind) — **not** waiting for the
  pharmacy (Kamrul, 2): the pharmacy gates the patient leaving, not the money. The issue transaction runs the final
  census first, then nothing posts to the bill again (database: lines change only in a draft; the sync stops at issue).
  Refused while a live line has no price (credit pairs never count) or a deposit link is waiting.
- **The arithmetic** (decision 1): `Invoice.excessPaisa` = deposits − total when the deposits are more (else 0), set once
  at issue and never changed. The bill counts **net paid = paid − excess**: `balanced` when it equals the total,
  `partially-paid` between, `issued` at 0 — the issued bill holds exactly its total. In the same transaction an excess
  becomes a refund request of source **`deposit-excess`** for exactly the excess (decision 297).
- **After issue, care goes on.** A dose drawn from ward stock after the issue is recorded and listed on the owner's
  exceptions ("after the final bill") but never charged. A dose-error answer pending at issue leaves the line on the
  bill at its charged value; an errored dose after issue is settled by a refund through the refunds slice — never by
  editing the bill (Kamrul, 2).
- **The deposit-excess refund** (decision 3): owner approval with the one self-approval rule, no ৳10,000 approver cap; it
  can never be rejected or withdrawn (the excess must always have somewhere to go) — only its payout way changes. Paid
  in cash from the payer's open shift by default, or as a bKash refund to the wallet when one bKash deposit covers the
  whole excess (within bKash's 60 days); the usual RF voucher. **One that cannot be paid at the counter** (the patient
  left, no cash in the shift) stays approved and sits on the owner's dues / exceptions list until paid (Kamrul, 3).
  Refunds have no expiry today (decision 225); if one is ever added, deposit-excess is exempt.
- **Numbering and Mushak-6.3** (decision 4): the IPD final bill takes the facility's one INV/yy/nnnn series (one
  sequential VAT-invoice series; whether IPD and OPD share it is on the accountant's list). Mushak-6.3 is printed once, on
  the receipt that settles the bill — at issue when the deposits cover the total, otherwise after the last payment of the
  shortfall; earlier receipts are money receipts. The final receipt groups the lines by category (package, bed days,
  tests, medicines, services) with VAT per rate, and lists the deposits applied and the excess refunded.
- **The shortfall** (decision 5) is paid on `bill/ipd` by the normal payment routes (cash, card, bank, bKash link), which
  now take an issued IPD bill. **No discount** on an IPD bill in this slice (decision 6).
- **The checklist** (decision 7): Final bill is done by the issue; Payment and clearance is done when the bill is balanced
  and any excess refund paid. The "recorded by hand" path is gone (database).

### B11 — the discharge summary
- A Composition of kind **`discharge-summary`** (DOCUMENT machine: draft → final, amended v2 never overwriting; the
  doctor's PIN; one per admission), opened from the checklist once the discharge is ordered. Sections: diagnoses (ICD-11
  picker, final / provisional; pre-filled from the admission), procedures (name, date, surgeon), course in hospital,
  medicines on discharge with instructions, follow-up (date, place), red-flag advice (sample items pending clinician
  sign-off, plus free text); the facility's phone as the emergency contact.
- **Medicines on discharge** are MedicationRequest lines of kind **`discharge`** on the summary, checked like a
  prescription (allergy, same medicine, class, interaction). The pharmacy's dispense queue gets a take-home section for
  signed summaries; they are dispensed as a normal dispense onto a pharmacy bill of the inpatient visit, paid at the
  pharmacy counter as in OPD. Collecting them never holds up the patient leaving.
- **Signing is refused** while a critical lab result on this visit is unacknowledged by the doctor or an escalation is
  open (Kamrul, 12), besides the summary's own checks (a final diagnosis, the course, follow-up, at least one red flag).
- **Print** (DocKind `ds`): A4, Bangla + English / Bangla / English, the DRAFT watermark until signed; then a 22 mm QR to
  the public `/verify/ds/<code>` (facility, date, version, status — no clinical content); reprints DUPLICATE with a
  reason, as for the prescription.
- **The patient app**: signing records the summary available to the patient (an in-app Communication with a new
  `compositionId`), again for an amendment.
- **The summary gates the patient leaving**: step 2 finishes when it is signed (no hand path). An amendment after the
  discharge is allowed.

### B12 — after discharge; LAMA; death
- **Patient left** is the last step (nurse, PIN, the time): the bed goes to cleaning with the note "Discharged HH:MM ·
  <name>"; **Bed ready** (bed map, and now the ward board) makes it vacant. The admission is discharged at "left"; the
  **visit finishes when the patient has left and the bill is issued**, whichever comes second.
- **Discharge kinds** (`Discharge.kind`): `normal`, `lama`, `death`, each with its step graph:

| Kind | Steps (waits for) | The patient leaves when |
|---|---|---|
| normal | order; summary (order); pharmacy (order); final bill (order); payment (final bill); left (summary, pharmacy, payment) | all of it is done |
| lama | LAMA record; pharmacy (record); final bill (record); payment (final bill); summary (record); left (pharmacy) | the pharmacy has cleared |
| death | death record; final bill (record); payment (final bill); body moved (record) | — (body moved) |

- **LAMA** (decision 14): the doctor records it with a PIN — the reason, "risks explained", "LAMA form signed by the
  patient or guardian" (required), a witness (a nurse or doctor of the facility). The bill may be issued after the
  patient left and may stay due (the due shows on the owner's dashboard); the summary is required within 24 hours and is
  flagged on the owner's exceptions until signed.
- **Death on the ward** (decision 15): the doctor records it with a PIN — time of death, cause, certificate drafted,
  family informed, police when medico-legal (the ER's checks). It sets the inpatient visit's outcome to **deceased**; the
  final bill carries no discharge-medicine or follow-up lines; there is no discharge summary (the death record stands in
  its place). **Body moved** needs the nurse's PIN like "patient left" and releases the bed to cleaning. The certificate
  document and the mortuary are later (decision 247).
- **Live bed state** (decision 16): the bed map and the admission desk's bed picker poll every 30 s, the ward board
  every 60 s (it shows discharge-pending and cleaning beds); no push channel.

### Journey B
`e2e/journeys/journey-b.spec.ts` follows one patient from ER arrival to the bed made ready again (decision 17). The CI
e2e job's limit goes to 30 minutes.

## Consequences
- `invoice_ipd_frozen` gives way to an IPD issue path; `invoice_paid_matches_status` and `invoice_amounts` count paid −
  excess for IPD bills; the bill-refund caps leave deposit-excess out; `refund_shape` / guards admit the new source.
- The unpriced count at issue skips credit pairs (ADR 0017 review note).
- `DocumentCode.kind` gains `ds`; `MedicationRequest.kind` gains `discharge`; `Communication` gains `compositionId`;
  `Discharge` gains `kind` and its record (`detail`); `Encounter` gains `outcome`.
