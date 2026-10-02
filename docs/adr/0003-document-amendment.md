# ADR 0003 — Amending a signed clinical document

Date: 2026-10-02 · Status: accepted (Kamrul, 02/10/2026 — decision D1 of slice A4–A5)

## Decision
The DOCUMENT machine (`packages/domain/src/machines.ts`) gains one event:

```
draft ──signAmendment──▶ amended      ; only for a draft that amends another version
```

An amendment is a **new row** (v2) that starts as `draft`, points at the version it amends (`amendsId`) and must carry
a reason. Signing it (PIN + server, the same as `sign`) applies `signAmendment` to v2 and `supersede` to v1 **in the
same transaction**, so there is never a moment with two current versions or none. v1 keeps its content and stays
readable as `superseded`, with a pointer to v2.

Signing offline is disabled (prototype, round-2 fix #6): the existing `offlineSign → queued → serverAck` path stays in
the table but no screen uses it in slice A4–A5.

## Why
`domain-model.md` says "final ──amend(reason)──▶ amended (v2); v1 → superseded". The existing table applied `amend` to
v1 itself (`final → amended`), which would change v1's status instead of creating v2, and had no way for a new version
to become `amended`. The guard "only for a draft that amends another version" (with a reason of ≥5 characters) is enforced in
`@setu/domain` `signDocument` (`documents.ts`), which every caller uses — the table has no notion of a pointer; a plain
draft still signs with `sign → final`, and an amendment cannot use plain `sign`.

## Consequences
- `final|amended ──amend──▶ amended` stays in the table but is not used for versioning; amendments go through
  `signAmendment` on the new row.
- A v3 amends v2 the same way (v2 `amended ──supersede──▶ superseded`).
- Tests: `machines.test.ts` covers `signAmendment` from every state.
