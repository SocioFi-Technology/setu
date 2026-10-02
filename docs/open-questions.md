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

### Chosen by Claude — please confirm or change
1. **Field-status rules** (`packages/domain/src/patient.ts`). The prototype hard-codes Same/Similar/Different.
   - Names: Same after normalisation (case, dots, spaces, Md./Mst. prefix); Similar if the first word matches or ≤2 letters differ; else Different.
   - Date of birth: Same if identical; Similar if both exact and within 366 days, or either approximate and within 2 years; else Different.
   - Address: Same if district and upazila match; Similar if only the district matches; Different if districts differ.
   - Guardian: compared as a name. NID / birth registration: Same or Different only when both records have one.
   - Strong match: ≥6 of 8 fields Same.
   - Candidate list: same phone, same ID, or a Same/Similar name together with a Same/Similar birth.
   - The prototype shows Rahima Khatun vs Rahima Begum's English name as Different; with these rules it is Similar (same first word). The A2 requirement — conflicts block the one-click link — still holds (DOB and guardian are Different).
2. **Queue columns:** Waiting = `arrived`, Vitals done = `triaged`, With doctor = `in-progress`, Completed = `finished`,
   No-show = `cancelled` (reason "no-show"). The prototype's **Sent to lab** and **Billing** columns have no ENCOUNTER state;
   they are left out until the lab and billing slices (likely as Task/ServiceRequest status, not new Encounter states).
   **Requeue** from no-show is not possible because `cancelled` is terminal in ENCOUNTER.
3. **"Call" (ডাকুন)** records `calledAt` and an audit event; it is not a state change.
4. **What linking does** (A is the possible duplicate, B the record it is the same person as):
   - Same person — link (no conflicts): A `replaced-by` B (`Patient.linkedToId`), Provenance `link`. A's identity confidence is left as it was; screens and new visits use B.
   - Link anyway (conflicts, reason ≥10): as above, plus Task `patient-link-review` created and approved in the same transaction with the reason, and A set to `possible-duplicate` so the records officer can still split it later.
   - Send for review: Task requested; A set to `possible-duplicate`; the visit continues on A.
   - Different person: Provenance `checked-different`; if A was `possible-duplicate` and has no open review it goes back to `unverified`.
   - Undo: reverses the last decision on A with a new Provenance row (never deletes); an open review Task is rejected with note "withdrawn"; an approved one stays approved (APPROVAL has no way back) and the unlink is recorded.
5. **Who reviews:** "records officer" is not one of the nine roles. Review Tasks are visible to **admin** until that role exists.
6. **Login with a phone that exists in two tenants:** accepted only when exactly one account matches the password; otherwise "wrong phone or password". A tenant picker may be needed later.
7. **Branch for the token:** the first `Location(kind=branch)` of the session's organisation. Multi-branch organisations need a branch choice at login.
8. **Approximate age** is stored as years + months + the date it was recorded (`approxAgeAt`), so it ages forward; no estimated birth date is invented.
9. **ID numbers:** NID must have 10, 13 or 17 digits and birth registration 17 when entered; passport numbers are not checked. Payer, photo and referral from the register form are not stored in this slice (no Coverage/Media model yet).
10. **The A3 journey's "GLC-240117" result** is the prototype's sample number for a patient who already exists in A1. The A3 spec registers a new synthetic patient and checks that it gets the next facility number and its own token.

### Infrastructure (step 1)
11. **`auth_login_lookup` runs as its owner.** In local Docker the owner is the superuser. In production the migration
    role must be a superuser or have `BYPASSRLS`, or login will find no users. Decide when choosing the managed Postgres.
12. **`setu_app` password** is set by `pnpm db:migrate` from `DATABASE_URL_APP`; production sets it from the secrets vault (`ALTER ROLE setu_app PASSWORD …`), never in a migration.

## Answered
(none yet)
