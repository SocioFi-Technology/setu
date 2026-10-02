# ADR 0002 — Provenance source `desk-decision` for front-desk identity decisions

Date: 2026-10-02 · Status: accepted (Kamrul, 02/10/2026 — open question 18)

## Decision
Add a fifth Provenance `source`, `desk-decision`, to the four in `docs/design-handoff/domain-model.md` rule 2
(`provider-verified | patient-uploaded | patient-reported | ai-draft`). It is used for the front desk's and the admin's
identity decisions on a Patient: `link`, `link-anyway`, `review-requested`, `checked-different`, `undo`, `unlink`,
`link-reviewed`. Registration keeps `patient-reported`. Clinical items keep the four original sources.

## Why
A1–A3 recorded these decisions as `provider-verified`. The clinical-safety review read that as over-stating
verification: a receptionist comparing two records is not a clinician verifying a fact. A separate value keeps the
meaning of `provider-verified` for clinical data.

## Consequences
- Prisma enum `ProvenanceSource` gains `desk_decision @map("desk-decision")` (migration `desk_decision_source`).
- Provenance is append-only: rows written before this ADR keep `provider-verified`; readers must treat both values as a
  desk decision for those seven activities.
- `domain-model.md` is a design input and is not edited; this ADR is the record of the extra value. FHIR export maps
  `desk-decision` to `Provenance.activity` + agent role "registration clerk", not to a verification.
