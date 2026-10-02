# Open questions

Decisions made during a slice where the spec (`docs/design-handoff/`, the prototype, the test log) was silent or ambiguous.
Each one names what was chosen and why, and stays here until a human confirms or changes it. When one is answered,
move it to "Answered" with the date and who decided.

## Slice A1–A3 (front desk) — 02/10/2026

### Decided by Kamrul (02/10/2026)
- **Token numbering:** one counter per branch per day, `A-001` upward, resetting at midnight Asia/Dhaka. Per-doctor letters (B-, C-) later.
- **Guardian under 18:** registration is blocked until a guardian name and relationship are entered.
- **Name search:** same script only (a Bangla query matches Bangla names, an English query English names). No transliteration.
- **Queue scope:** board + next / no-show through ENCOUNTER. Drag-to-reorder with reason later.
- **No new state machines:** the queue is a view of ENCOUNTER (token is an Encounter attribute from a per-branch daily
  Sequence); identity confidence is a Patient field changed by linking, with a Provenance row; duplicate review is a
  Task through APPROVAL ("Send for review" = requested; "Link anyway" with a reason = approved immediately, reason audited).

### Chosen by Claude — confirmed by Kamrul 02/10/2026 (all recommendations accepted; notes per item)
1. **Field-status rules** (`packages/domain/src/patient.ts`). The prototype hard-codes Same/Similar/Different.
   - Names: Same after normalisation (case, dots, spaces, Md./Mst. prefix); Similar if the first word matches or ≤2 letters differ; else Different.
   - Date of birth: Same if identical; Similar if both exact and within 366 days, or either approximate and within 2 years; else Different.
   - Address: Same if district and upazila match; Similar if only the district matches; Different if districts differ.
   - Guardian: compared as a name. NID / birth registration: Same or Different only when both records have one.
   - Strong match: ≥6 of 8 fields Same.
   - Candidate list: the same ID, or a Same/Similar name together with the same phone or a Same/Similar birth. A shared
     family phone alone is **not** a match (hands-on walkthrough 02/10/2026: the 9-year-old and the grandmother were being
     offered as matches for Rahima Begum). At most 3 candidates.
   - A different sex blocks any link, even "Link anyway" (prototype: "Blocked: sex and age conflict").
   - The prototype shows Rahima Khatun vs Rahima Begum's English name as Different; with these rules it is Similar (same first word). The A2 requirement — conflicts block the one-click link — still holds (DOB and guardian are Different).
2. **Queue columns:** Waiting = `arrived`, Vitals done = `triaged`, With doctor = `in-progress`, Completed = `finished`,
   No-show = `cancelled` (reason "no-show"). The prototype's **Sent to lab** and **Billing** columns have no ENCOUNTER state;
   they are left out until the lab and billing slices (likely as Task/ServiceRequest status, not new Encounter states).
   **Requeue** from no-show is not possible because `cancelled` is terminal in ENCOUNTER.
   → **Deferred (Kamrul, 02/10/2026):** decide before the lab/billing slices (A6–A11) whether a late no-show can be
   requeued; that would need a new ENCOUNTER transition and an ADR. Until then a late arrival gets a new token.
3. **"Call" (ডাকুন)** records `calledAt` and an audit event; it is not a state change.
4. **What linking does** (A is the possible duplicate, B the record it is the same person as):
   - Same person — link (strong match, no conflicts, Bangla name and birth Same): A `replaced-by` B (`Patient.linkedToId`), Provenance `link`. A's identity confidence is left as it was; screens and new visits use B.
   - Link anyway (any candidate that is not a strong clean match, reason ≥10): as above, plus Task `patient-link-review` created and approved in the same transaction with the reason, and A set to `possible-duplicate` so it can still be split later.
   - Send for review: Task requested; A set to `possible-duplicate`; the visit continues on A.
   - Different person: Provenance `checked-different`; if A was `possible-duplicate` and has no open review it goes back to `unverified`.
   - Undo: reverses the last decision on A with a new Provenance row (never deletes); an open review Task is rejected with note "withdrawn"; an approved one stays approved (APPROVAL has no way back) and the unlink is recorded.
5. **Who reviews:** (screen text now says "an admin will check it") "records officer" is not one of the nine roles. Review Tasks are visible to **admin** until that role exists.
6. **Login with a phone that exists in two tenants:** accepted only when exactly one account matches the password; otherwise "wrong phone or password". A tenant picker may be needed later.
7. **Branch for the token:** the first `Location(kind=branch)` of the session's organisation. Multi-branch organisations need a branch choice at login.
8. **Approximate age** is stored as years + months + the date it was recorded (`approxAgeAt`), so it ages forward; no estimated birth date is invented.
9. **ID numbers:** NID must have 10, 13 or 17 digits and birth registration 17 when entered; passport numbers are not checked. Payer, photo and referral from the register form are not stored in this slice (no Coverage/Media model yet).
   → **Decided (Kamrul, 02/10/2026): hide them until they are saved.** The register screen does not show them today; a
   slice may only add them to the form together with the model that stores them (Coverage / Media).
10. **The A3 journey's "GLC-240117" result** is the prototype's sample number for a patient who already exists in A1. The A3 spec registers a new synthetic patient and checks that it gets the next facility number and its own token.

13. **Register-screen Compare** for an unsaved form is replaced by "Visit on this record" on each candidate in the live
    duplicate box (no new record is created). Linking with conflicts happens on saved records in `fd/match`.
14. **Offline:** registrations and visits made offline wait in the device outbox (localStorage) with their Idempotency-Key
    and show "Saved on this device · not synced"; they never show a facility number or token until the server answers.
    The outbox holds patient details on the device until synced — acceptable for a desk PC, to revisit for shared devices.
15. **Search scope:** results exclude records already linked into another (replaced-by); at most 20 results.

### From the security and clinical-safety reviews (02/10/2026) — decided by Kamrul 02/10/2026 (see below)
Fixed in the slice: one-click link only on a strong clean match (Bangla name and birth Same); guardian detection both
ways and on near spellings; register-screen "Visit on this record" only for a clean match; Enter ignores stale search
results and an exact patient number comes first; banner follows the record the visit goes on; strong duplicates are
flagged on save; no-show needs a confirm; the desk cannot finish a visit; queue actions are scoped to the facility and
branch; Idempotency-Keys are scoped to user + URL and bound to the body (reuse → 422), replays re-check permissions and
are audited; the outbox only replays under the user/tenant/facility that queued it and expires after 24 h; request
logs drop query strings; register prefill no longer travels in the URL; DOB "future" uses the Dhaka calendar day.

Still open:
16. ~~"Link anyway" approves itself~~ — **answered by Kamrul, 02/10/2026:** keep it immediate; add an admin "Unlink" on
    the patient record and show overrides in the admin duplicate-review queue as "Linked with override" for
    after-the-fact review. Built in A1–A3 (see HANDOVER).
17. **Undo after a link** does not move or flag visits created on the linked record in between, needs no reason, and
    any desk user can undo another's link. Proposed: list those visits and require a reason to undo a link-anyway.
18. **Provenance source for desk decisions** is `provider-verified` (the domain model's four sources have no "desk
    decision"). The reviewer reads this as over-stating verification. Needs an ADR if a new source value is wanted.
19. **Match preview** returns full summaries (phone, address, guardian) of candidates to anyone on the register
    screen; consider reduced fields until a candidate is chosen.
20. **Composite tenant foreign keys** (`(tenantId, id)`) for Patient.linkedToId, Task, Provenance and Encounter.patientId
    as defence in depth (today every id is read through a tenant-filtered lookup first).
21. **The patient index is tenant-wide** (Patient has no organizationId): a tenant's facilities share patients. Intended?
22. **Refused outbox writes** (e.g. 409 visit already exists) leave the pending count silently; show them to staff.
23. **Phone is required** (prototype rule); a patient without a phone pushes staff to type a placeholder. Allow "no phone"?
24. `pnpm db:migrate` sends `ALTER ROLE … PASSWORD` in plain text; turn off `log_statement` or set it with a SCRAM hash.

### Infrastructure (step 1)
11. **`auth_login_lookup` runs as its owner.** In local Docker the owner is the superuser. In production the migration
    role must be a superuser or have `BYPASSRLS`, or login will find no users. Decide when choosing the managed Postgres.
12. **`setu_app` password** is set by `pnpm db:migrate` from `DATABASE_URL_APP`; production sets it from the secrets vault (`ALTER ROLE setu_app PASSWORD …`), never in a migration.

## Decisions of 02/10/2026 (Kamrul) on the review items
- **17 → start of A4–A5:** undoing a "Link anyway" needs a reason; only the person who made the decision or an admin may
  undo it; the undo warns with the list of visits opened on the linked record in between.
- **18 → start of A4–A5, with an ADR:** a new Provenance source for desk decisions (e.g. `desk-decision`) instead of
  `provider-verified` for link / different / undo / unlink. Domain-model change, so `docs/adr/` first.
- **19 → start of A4–A5:** match preview on the register screen returns name, patient no., age and sex only; phone,
  address and guardian are shown once "Compare" opens the candidate on the match screen.
- **20 → pre-pilot security pass** (HANDOVER known gaps): composite `(tenantId, id)` foreign keys for
  Patient.linkedToId, Task.focusId/candidateId, Provenance.targetId and Encounter.patientId.
- **21 — answered, intended:** one patient record per tenant, shared across that owner's branches and facilities.
  Sharing between **different owners (tenants)** only ever happens through Connected Care with the patient's consent
  (Journey E: `Consent` evaluated, a denied read returns `403 { reason, canRequest }`), **never by default**. No change
  to RLS (tenant-scoped) is needed; Journey E must not add any cross-tenant read that bypasses consent.
- **22 → start of A4–A5:** writes the server refuses after an offline save (e.g. 409 visit already exists, 400
  validation) are shown to staff as "couldn't sync — check" with the reason, instead of silently leaving the count.
- **23 → start of A4–A5:** a patient may be registered with **no own phone**, but then a guardian's or relative's phone
  is required and `phoneOwner` records whose it is (guardian / family / other, with the related person), because
  results delivery (SMS) and the patient-app claim need a reachable number. Registration still blocks when there is
  no reachable number at all.
- **24 → pre-pilot security pass** (HANDOVER known gaps): `pnpm db:migrate` must not send the `setu_app` password in
  plain text (set it as a SCRAM hash, or with statement logging off).
- **2 and 11 deferred:** 2 (requeue after no-show) before A6–A11; 11 (`auth_login_lookup` needs an owner with
  BYPASSRLS / superuser) when choosing the managed Postgres.

## Answered
- **16** (02/10/2026, Kamrul): "Link anyway" stays immediate; admin Unlink + "Linked with override" in the review queue.
- **1, 3–8, 10, 12–15** (02/10/2026, Kamrul): confirmed as built.
- **9** (02/10/2026, Kamrul): payer / photo / referral stay hidden until a slice stores them.
- **21** (02/10/2026, Kamrul): one patient record per tenant across its branches; cross-owner sharing only via Connected Care with consent.
- **17, 18, 19, 22, 23** (02/10/2026, Kamrul): agreed; scheduled for the start of A4–A5 (18 with an ADR).
- **20, 24** (02/10/2026, Kamrul): agreed; pre-pilot security pass.
- **Decided at the start of A1–A3** (02/10/2026, Kamrul): token per branch per day, under-18 guardian blocks the save, same-script name search, queue board with call / next / no-show, no new state machines.
