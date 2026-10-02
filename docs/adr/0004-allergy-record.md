# ADR 0004 — Recording an allergy, and marking it entered-in-error

Date: 2026-10-02 · Status: accepted (Kamrul, 02/10/2026 — decision 1 of slice A4–A5 session 2)

## Decision
`AllergyIntolerance` gets its own state machine in `packages/domain/src/machines.ts`:

```
active ──markError(reason)──▶ entered-in-error
```

An allergy is recorded by a doctor from the consultation (substance or class, reaction, severity), stored `active` with a
Provenance row (`provider-verified`, who, when, on behalf of which facility) and an AuditEvent. It is **never deleted**
and its content is never edited: a wrong entry is marked `entered-in-error` with a reason (≥10 characters), and a
correct one is recorded as a new row. The database enforces this (no DELETE for `setu_app`; an UPDATE may only move an
`active` row to `entered-in-error`).

Only `active` allergies feed the prescription check in `@setu/domain` `prescription.ts` (`rxWarnings`), which the
consultation route and the screen both call, so an allergy recorded during the consultation blocks a conflicting
medicine at once — on the screen and when signing.

## Why
`domain-model.md` lists AllergyIntolerance (substance, reaction, criticality, provenance) but gives it no lifecycle, and
CLAUDE.md requires a state machine before any status. Rule 3 (amend, never overwrite) applies to clinical facts: a
mistaken allergy must stay visible in history, not disappear.

## Consequences
- FHIR export: `active` → `clinicalStatus = active`; `entered-in-error` → `verificationStatus = entered-in-error`.
- "Resolved" / "inactive" (an allergy that went away) is not modelled; add an event with a new ADR when a screen needs it.
- "No known allergies" (NKDA) is not recorded in this slice: an empty list shows "Allergies not recorded — ask the
  patient", never NKDA (open question 52).
- Tests: `machines.test.ts` covers ALLERGY from every state.
