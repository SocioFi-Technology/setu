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
- **25–36, D1–D5** (02/10/2026, Kamrul): approved before slice A4–A5 started.
- **45, 46, 47, 49** (02/10/2026, Kamrul): see "Decisions of 02/10/2026 on items 45–49" (slice A4–A5).
- **Decided at the start of A1–A3** (02/10/2026, Kamrul): token per branch per day, under-18 guardian blocks the save, same-script name search, queue board with call / next / no-show, no new state machines.

## Slice A4–A5 (vitals, consultation, sign/amend) — decided by Kamrul 02/10/2026 before the slice started

Split into two sessions (D5): **session 1** = A1–A3 follow-ups (17, 18 + ADR 0002, 19, 22, 23), ADR 0003, vitals rules,
vitals end to end (A4). **Session 2** = clinical models, Rx/sign rules, consultation API and screens, A5 spec.

### Chosen conservatively by Claude — approved by Kamrul 02/10/2026
25. **Signing offline is disabled** ("Sign when back online"), as in the prototype and round-2 fix #6. DOCUMENT's
    `offlineSign → queued` stays in the machine but no screen uses it.
26. **Same medicine twice** (same generic) is a warning that blocks signing until the doctor chooses "Keep both" or
    Remove (prototype behaviour; the slice prompt calls it a warning).
27. **Vitals are read-only in the doctor's note.** The prototype's "Edit with reason" is deferred: Observation has no
    version or state machine yet.
28. **Care relationship:** a doctor opens a consultation only for a visit at their facility that is assigned to them or
    unassigned (opening it assigns them). Others get `403 { reason, canRequest }`. "Add to my queue" and "Emergency
    access" stay hidden until Journey E (break-glass).
29. **No prices on orders** until price lists exist (A6); the "est. ৳" total is not shown.
30. **Deferred note sections:** referral, medical certificate and diet templates. Built: complaint, history, exam,
    vitals (read-only), diagnosis, orders, Rx, advice, follow-up.
31. **Signing the note finishes the visit** (ENCOUNTER `finish`), so the queue shows Completed.
32. **New diagnoses are provisional**; the doctor ticks one to make it confirmed (Condition.verificationStatus).
33. **Who records vitals:** nurse and receptionist, as in the access matrix.
34. **AI scribe:** the FakeAi adapter returns canned text; no audio is recorded or stored.
35. **BMDC number on the sign line** only when stored, with "not verified" when `regVerified` is false. Never invented.
36. **Observation status:** stored as `final` when the server accepts the batch; "preliminary" exists only as the
    device's pending outbox write. No new state machine.

### Decisions (Kamrul, 02/10/2026)
- **D1 — amendment through DOCUMENT:** ADR 0003. New event `draft --signAmendment--> amended`, allowed only on a
  draft that amends another version; in the same transaction v1 `supersede → superseded`. Amendment reason required;
  v2 keeps a pointer to the version it amends.
- **D2 — ICD-11 codes:** seed the prototype's 10 codes flagged "unverified, from prototype". Pre-pilot: a clinician
  verifies codes against the WHO ICD-11 browser; production source = WHO ICD-11 API or a local extract.
- **D3 — medicines:** seed the prototype's 12 medicines as a synthetic demo list labelled demo; the UI footnote says
  class matching is a demo check. Pre-pilot: licensed drug database with DGDA numbers + clinician-approved
  allergy/interaction rules.
- **D4:** include the interaction-acknowledge step (Clopidogrel + Omeprazole) — blocks signing until acknowledged.
- **D5:** two sessions (above).
- **Note for A6:** the OPD bill attaches to the encounter even after signing has finished it.

### Chosen by Claude during session 1 (02/10/2026) — please confirm
37. **Two impossible limits the prototype does not state:** diastolic < 20 mmHg and SpO₂ < 1 % block the save (the
    prototype only gives diastolic > 200 and SpO₂ > 100). Everything else is the prototype's table.
38. **Receptionist-recorded vitals** are stored with source `provider-verified`, as the nurse's are (the access matrix
    lets receptionists use the vitals station); the Provenance row also records the role. Revisit if only clinical
    staff should count as provider-verified.
39. **Measurement time:** the device's "measured at" may be at most 5 minutes ahead of the server and at most 24 hours
    behind (the outbox keeps offline writes for 24 h); outside that the batch is refused ("check the device clock").
40. **A second vitals save in the same visit** is a new batch (re-measure), never an edit; the doctor sees the latest.
41. **Vitals only on an open visit** (waiting, vitals done, with doctor). The first batch moves the token from
    Waiting to Vitals done (ENCOUNTER `triage`).
42. **Observation codes** are Setu keys (`bp-systolic`, `pulse`, `body-temperature`, …), not LOINC; mapping to LOINC
    comes with the FHIR export and must be checked by a clinician then. No code was invented.
43. **Undo after an admin decision:** the desk cannot undo an admin's "Send for review" (only its maker or an admin).
44. **E2E Test Clinic nurse:** user 01799000004 (Test Nurse) added to the seed for the vitals specs.

### From the security and clinical-safety reviews of session 1 (02/10/2026)
Fixed in the session: previous vitals and the undo dialog's visit list are limited to this facility (45); the visit
list is only sent to someone who may undo; undo and vitals saves use check-and-set (409 if changed meanwhile); view
audits name the patients and earlier batches revealed; a refused offline write keeps no patient details on the device,
refused items stay listed 7 days and are cleared at sign-out, and a write not sent within 24 h becomes a listed
refusal instead of disappearing; systolic and diastolic are flagged separately; glucose above 40 is read as mg/dL
(blocked with a unit message) and 25–40 needs a "re-checked" tick (also enforced by the API); °C in the °F box and
feet in the cm box get unit messages; an impossible BMI (8–80) blocks on height; the "current" batch is the most
recently measured; entered-in-error rows are excluded; the source shown is read from Provenance; adult BMI labels are
hidden under 18 with an "adult ranges" note; "give sugar" was removed from the low-glucose text (receptionists use
this screen); the low end of impossible ranges says "if confirmed, tell the doctor now"; the `signAmendment` guard
moved into `@setu/domain` `signDocument` (ADR 0003 updated).

45. **Previous vitals across facilities:** a visit shows earlier readings from this facility only, although the
    patient record is tenant-wide (decision 21). Should a tenant's other facilities' readings show (with an ADR)?
46. **Needs a clinician (pre-pilot):** critical-low thresholds (suggested: systolic < 90 or < 80, pulse < 40,
    temperature < 95 or < 93 °F as "tell the doctor now"); a critical-high glucose (≥ 16.7 or ≥ 20 mmol/L); child and
    infant ranges (today adult limits apply to everyone, with a note under 18); whether a confirmed extreme value
    beyond the impossible limits (e.g. systolic < 40 in shock, a baby under 1 kg) may be saved.
47. **Needs a decision:** critical values entered offline reach the doctor only after sync; should a critical value
    raise an active alert to the doctor, or require a "told the doctor" confirmation on the vitals screen?
48. **Doctor sees the latest batch of a visit** (40): show "earlier in this visit: critical" too? (session 2, consult screen)
49. **Undo with visits opened in between** (clinical review): the visits stay on the linked record, as decided in 17;
    the reviewer suggests also opening a review Task (or refusing the undo until they are moved). Your call.
50. **Doctor access to vitals:** any doctor at the facility can read a visit's vitals today; session 2 applies the
    care-relationship rule (28) to the consultation and this read.
51. **Branch:** visits and vitals use the organisation's first branch (gap 8, "branch choice"); real branch isolation
    needs the branch on the session.

### Decisions of 02/10/2026 (Kamrul) on items 45–49 — built the same day
- **46 → default thresholds = prototype + standard adult NEWS2 bands**, whichever flags first, labelled "default
  thresholds, pending clinician sign-off" in the code (`packages/domain/src/vitals.ts` header) and on the vitals
  screen. Critical (NEWS2 3 points): systolic ≤ 90, pulse ≤ 40, temperature ≤ 35.0 °C (95.0 °F), SpO₂ ≤ 91 %; plus
  the prototype's ≥ 180/120, pulse > 120, ≥ 103 °F. Warnings (NEWS2 1–2): systolic 91–110, pulse 41–50 or > 90,
  temperature ≤ 36.0 °C (96.8 °F) or ≥ 38.1 °C, SpO₂ 92–95 %; plus the prototype's ≥ 140/90 and ≥ 100.4 °F.
  NEWS2 has no glucose band (glucose stays on the prototype's rules; critical-high glucose still needs a clinician)
  and no NEWS2 total is computed (respiratory rate, consciousness and oxygen are not captured). The under-18 "adult
  ranges" note stays. Clinician sign-off of the thresholds and paediatric ranges is on the pre-pilot list (HANDOVER).
  Note for the clinician: the NEWS2 warning bands flag more OPD patients than the prototype did (e.g. pulse 91–100,
  systolic 101–110) — alarm fatigue is part of the sign-off.
- **47 → yes, now:** a "Critical vital sign" flag on the queue card when any vital in the visit was critical (a calmer
  re-measure does not clear it); the same flag at the top of the consultation screen in A5; an active notification to
  the doctor comes with the Doctor App inbox in A12.
- **45 → yes:** earlier readings from the owner's other branches and facilities are shown read-only, labelled with the
  branch name (consistent with decision 21; other tenants never — RLS).
- **49 → only for undoing a "Link anyway":** the existing override entry in the admin queue changes to "Link undone"
  with the reason and who undid it (no new Task); the admin marks it reviewed. An ordinary undo is audit-only.

