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


## Slice A4–A5 session 2 (consultation backend) — 02/10/2026

### Decided by Kamrul (02/10/2026, before the session)
- **Record allergy now** (ADR 0004): substance or class, reaction, severity, source provider-verified, recorded by + time,
  audited; never deleted, only marked entered-in-error; feeds the same domain check that blocks signing.
- **Split:** stop after plan step 6 (rules, database, API, tests); screens and the journey spec in session 3. Commit
  after each step.
- **Same medicine** compares generic names (Seclo = omeprazole), not brand text.
- **Opening the consultation** moves the visit to "With doctor" only through the ENCOUNTER transition, only when a
  doctor opens it (not a receptionist viewing), and re-opening is a no-op.
- **Offline drafts:** stored per user, cleared on sign-out, kept 24 h; never sign offline (built in session 3).
- **AI scribe:** the "Patient agreed to recording" tick is visible but disabled, "not available yet"; no consent is
  stored until the lawyer's wording exists.
- Confirmed in the build: sign = draft → PIN verify → server ack → final through DOCUMENT `transition()`, no
  client-side "signed"; allergy and same-medicine checks are pure functions in `@setu/domain` with unit tests, called by
  the route and (session 3) the screen; amend = a new Composition version, the old one superseded, the signed row never
  edited (ADR 0003; also enforced by a database trigger).

### Chosen conservatively by Claude — please confirm
52. **"No known allergies" (NKDA) is not recorded.** An empty list means "Allergies not recorded — ask the patient",
    never NKDA. Recording NKDA needs a rule for what happens when an allergy is added later.
53. **Interaction rule on the ingredient omeprazole** (the prototype matched the brand Seclo). Esomeprazole is not
    included — a clinician should say whether it should be (and whether the rule should cover more PPIs).
54. **Same medicine = any shared ingredient**, so a combination containing paracetamol counts as the same medicine as
    Napa. Checked within this prescription only, not against medicines from earlier visits — clinician to decide.
55. **Test names stay in English in both languages** (CBC, RBS, S. Electrolytes — as written on request slips); the
    prototype gives no Bangla names. Bangla brand names were added for search where the prototype had none (e.g.
    প্যান্টোনিক্স) — please check the spellings.
56. **Allergy matching:** a class allergy blocks every medicine of that class; a substance allergy blocks that
    ingredient only (an amoxicillin allergy does not block other penicillins). Cross-reactivity rules are for a
    clinician. Substance names are the English ingredient keys (no Bangla ingredient names yet).
57. **Free-text allergies** ("Egg") cannot be checked automatically: when anything is prescribed, signing needs the tick
    "I checked the medicines against the allergies that are not coded".
58. **Severity does not change blocking:** every match with an active allergy blocks, whatever its severity.
59. **Signing needs at least one complaint and one diagnosis** (a provisional one is enough; it prints "Provisional").
60. **Amendment content:** v2 starts as a copy of v1's sections, diagnoses and prescription; text that was reviewed and
    signed in v1 counts as provider-verified in v2. An amendment can add orders but never removes one already placed
    (cancelling is ORDER `revoke`, in the lab slice); the same test cannot be ordered twice in a visit.
61. **Only the visit's doctor may amend** (care relationship, decision 28) — another doctor at the facility cannot.
    Covering for an absent colleague needs a rule (and probably Journey E's emergency access).
62. **AI provenance:** the server records every AI draft it produced (Provenance `ai-draft-generated`). Which text was
    inserted is reported by the screen as the section's source; once a section is `ai-draft` the server keeps it so
    until the version is signed with "I reviewed". FakeAi builds drafts only from the patient's own record, so a
    dev/test draft never adds a fact the record does not hold.
63. **Draft saves are not kept as versions** (the prototype's "draft autosaves kept 30 days for audit" is not built);
    each save is audited with counts only.
64. **Worklist:** every doctor at the branch sees the unassigned waiting visits (no per-doctor queue yet; per-doctor
    token letters come later, open question 2's neighbour).
65. **Signing PIN is 4 digits** (the existing PIN contract and seed); the prototype accepts 4–6.
66. **A replay of a sign request** (same Idempotency-Key and body) returns the stored result without checking the PIN
    again; it signs nothing new. The PIN itself is never stored, not even inside the request hash.
67. **No prices on medicines either** (the prototype shows a price per tablet); prices come with the pharmacy/price
    lists.


## Slice A4–A5 session 3 (consultation screens) — 02–03/10/2026

### Decided by Kamrul (02/10/2026, before the session)
- **Hands-on test in the E2E Test Clinic** as doctor 01799000002, penicillin allergy recorded on Karim; nothing
  permanent is created in Green Life (the demo clinic people see).
- **E2E clinic reset without deleting anything:** allergies recorded by test runs are marked entered-in-error, leftover
  visits are closed through the normal ENCOUNTER transitions, every run uses fresh visits and no spec depends on
  counts. No purge and no safety trigger switched off, not even in the test clinic.

### Chosen conservatively by Claude — please confirm
68. **Device copy vs a newer server version:** the screen shows the server's version and offers "Load the device copy
    into the note" or "Discard the device copy". Loading replaces the note's text with the device copy (on the
    doctor's click only); there is no automatic merge.
69. **Keys:** "/" jumps to the medicine search only outside a text box (inside one it types a slash); Ctrl+Enter opens
    the sign sheet and never signs by itself (the PIN is always asked); keys do nothing while a dialog is open.
70. **One Idempotency-Key per opening of the sign sheet:** a wrong PIN then the right one is the same request;
    closing and reopening the sheet starts a new request.
71. **Brand names stay in English on prescription lines and warnings** in both languages (as printed on
    prescriptions, and the same after a reload); Bangla brand names are used only to help the search.
72. **Record allergy / Entered in error are also on the signed-note screen** for the visit's doctor (an allergy belongs
    to the patient; the API already allows it on a finished visit for that doctor).
73. **Signing out with a draft not yet sent** (your decision: cleared at sign-out): after the clinical review,
    sign-out first tries to send it, then asks "N consultation note draft(s) … Signing out deletes them" with "Stay
    signed in" / "Sign out and delete them". The top bar's "not synced" count includes device drafts.
74. **A session that expires without signing out** leaves that user's device draft on the browser, unreadable to other
    users, until it expires at 24 h (then only a "not sent within 24 hours" line without the text remains).
75. **A consultation cannot be opened offline** (the note is read from the server); a note already open keeps working
    offline as a device draft.
76. **The AI draft reads the note as saved on the server**, so text typed in the last second before pressing it may
    not be included.
77. **Leftover test visits in the E2E clinic** are closed with cancel (waiting / vitals done) or markError (with
    doctor) — never finish, which only signing does.

### From the reviews and the hands-on test of session 3 (03/10/2026)
Fixed in the session (commits "step 8" and "step 9"): typing is kept as a device copy when the server holds a newer
version, and loading that copy asks first; sign-out sends unsent drafts first and asks before deleting them; leaving
the editor keeps unconfirmed text on the device; 0+0+0 is not a dose; allergies are re-read when the window regains
focus and after the sign sheet closes; expired drafts are removed at app start; an expired session clears the last
user's drafts; device drafts are schema-checked before they are sent or loaded; the reset refuses a non-local
database, filters by tenant, acts as the E2E admin and audits; PIN autocomplete off for password managers; the
doctor's list puts waiting patients before completed visits; repeated entered-in-error allergies are grouped.

78. **Needs a clinician (pre-pilot):** a per-dose cap (today any single digit per dose is accepted, e.g. 9+9+9), and
    the dose formats beyond tablet/capsule counts (syrup in ml, drops, injections, "as needed").
79. **Pre-pilot security pass (HANDOVER gap 10):** encrypt device drafts with a key bound to the server session (or
    sign them), so a copy left in a browser is useless to anyone else and a planted copy is never sent; queued
    writes in the older outbox (registration, vitals) keep their bodies after sign-out for the same user — same fix.
80. **Test clinic only:** visits the reset closes (cancelled / entered-in-error) show in the queue's "No-show"
    column. Harmless in t_e2e; a real "cancelled" column comes with the queue follow-ups (gap 8).
81. **Signing out while offline** fails (the server cannot be told), and the user stays signed in on that screen —
    behaviour from before this slice. Suggest: sign out locally and clear the cookie when back online.
82. **The AI context includes the patient's free text** (complaints, allergy reactions) — fine for FakeAi; before a
    real model is connected it must be passed as data, never as instructions (security review).

## Slice A6–A7 session 1 (billing backend) — 03/10/2026

### Decided by Kamrul (03/10/2026, before the session)
- D1 VAT after the discount: a bill-level discount is split across lines in proportion to their gross by largest
  remainder (line discounts sum to the discount exactly, ties to the earlier line); VAT per line on the line's net,
  half-up to the paisa; totals are sums of line paisa. The prototype's other sample bill prints ৳3,411.59, not
  ৳3,415.00. **Pre-pilot (accountant):** confirm this VAT-after-discount treatment and the Mushak-6.3 layout.
- D2 A bill cannot be issued, so cannot be paid, while a discount approval Task is requested.
- D3 One consultation fee per doctor (sample ৳800); no new / follow-up price yet.
- D4 Cashier limit = lower of ৳500 and 5% of the subtotal; approver limit ৳10,000 per request; owner and admin
  approve; no one approves their own request; stored per facility (`Organization`). **Pre-pilot (accountant):** the
  real limits per facility.
- D5 Seller BIN: the prototype's 000123456-0101 seeded as `sample` in Green Life and the E2E clinic; a facility with no
  BIN prints no Mushak-6.3 line.
- D6 Receptionist sees the OPD bill but cannot change it.
- D7 QR library `qrcode-generator` (session 2). D8 Payment-link SMS: the fake provider only records the link; real SMS
  with the Messenger (A8) or the bKash sandbox (phase 2).
- Smaller: the bill number is given at issue; a discount above the subtotal is refused, never capped; cancelling a
  bill is out of scope. **Next billing follow-up: bill void / entered-in-error — never a delete.**
- For session 2: verify code ≥16 random characters (never sequential), verify endpoint rate-limited and returns only
  facility, receipt number, date, amount; an offline cash receipt has no receipt number and no QR, says
  "PROVISIONAL — not synced" on every page, and gets its RCPT number only when the server confirms; receipt copies
  are immutable; RCPT/yy/nnnn per facility per year from Sequence, in the same transaction as the receipt.

### Chosen conservatively by Claude — please confirm
83. **Lines are locked while a discount is applied or requested** ("remove the discount first"), so a within-limit or
    approved discount is never stretched over a different bill. The approval also re-checks that the bill is the one
    the request was made on (same rev and subtotal), otherwise "request again".
84. **A discount request cannot be withdrawn by the cashier** (APPROVAL has no cancel); the owner/admin rejects it with
    a note. A new request needs the old discount removed first.
85. **Only desk lines can be removed or re-counted.** The consultation fee and the doctor's orders stay on the bill; a
    patient who declines a test needs the order revoked (ORDER `revoke`, lab slice) — until then the bill keeps it.
86. **Billed orders** = every placed order not revoked or declined (active, in progress, complete …). Tests without a
    prototype price (Urine C/S, SGPT, USG KUB, Echo, Fundoscopy) are unpriced: shown, and they block issuing.
87. **Discount reason and rejection note: at least 10 characters**, like other reasons in Setu.
88. **Callbacks answer 200 for every correctly signed event** (outcome applied / noop / refused) so the gateway stops
    retrying; "refused" events are recorded in ProviderEvent and never applied. A callback for an unknown reference
    is 404 and not recorded (no tenant to record it under).
89. **Money the provider reports on a failed or superseded link, or with a different amount, is never applied** — it
    opens a `payment-reconciliation` Task. Who works that queue (owner? accountant?) and the screen for it are not
    built yet.
90. **The payment link is created inside the database transaction.** If the transaction fails afterwards, the
    provider holds an unused link that expires after 15 minutes. Acceptable for the fake; revisit with the bKash
    sandbox (create the Payment first, then the link).
91. **A patient without a valid mobile number cannot get a payment link** (422 "take cash or card"). Sending the link to
    another number (guardian) is not offered yet.
92. **The billing worklist shows today's finished visits** at the branch. Unpaid bills from earlier days need a
    "dues" list (later).
93. **The first billing migration was applied before its SQL could be appended**, so RLS, checks and triggers are in
    the follow-up migration `billing_guards` (an applied migration is never edited). Both are needed together on any
    database.

### Decisions of 03/10/2026 (Kamrul) on items 83–93
- All accepted as recorded.
- 89: **the owner works the payment-reconciliation queue** for now (the Clinic plan has no accountant role); add an
  accountant role when the Hospital plans need it. The queue screen is a **billing follow-up**, not part of A6–A7.
- 90: **phase 2 list (before the bKash sandbox):** create the Payment row first and the provider link second.

## Slice A6–A7 session 2 (billing screens, receipt PDF, reprint, verify) — 03/10/2026

### Decided by Kamrul (03/10/2026, before the session)
- Hands-on list: ৳500 within limit, above-limit → approval → nothing applied before, cash with change, bKash confirmed
  by callback, bKash with the callback lost → TrxID, print + reprint DUPLICATE #1, verify page without patient
  details — all done (HANDOVER).
- **Note on "৳500 within limit":** with the limit of decision D4 (lower of ৳500 and 5% of the subtotal) ৳500 is within
  the limit only on a bill of ৳10,000 or more; the hands-on used a bill grown to ৳10,600 with desk items. The rule was
  not changed.

### Chosen conservatively by Claude — please confirm
94. **Bill edits, discounts, issuing and approvals need a connection** (refused offline, like signing); only
    payments go through the offline outbox (cash queued, links "will send when online").
95. **Desk items are services only** (card, certificate, dressing, nebulisation). Tests reach the bill only through
    the doctor's order (review: a second CBC, or a test with no order for the lab).
96. **Mushak-6.3 is printed once per bill — on the receipt that settles it.** Part-payment receipts are money
    receipts. **Pre-pilot (accountant):** confirm, together with VAT after discount (D1) and the layout.
97. **The words on a receipt are the amount received on it** ("Amount received in words"); the bill screen shows
    "Total in words".
98. **Unpriced tests block issuing and cannot be removed by the cashier** (review M1). The consultation fee cannot be
    collected until the price list has the test. Needs a decision: owner sets a price on the spot, or "bill elsewhere"
    with owner approval. Masters screens come in phase 2.
99. **Revoked orders (lab slice, review M4):** when ORDER `revoke` exists, a draft bill must drop or refresh that
    line; an issued bill needs the void follow-up.
100. **"Cancel link"** asks the gateway first: money that arrived is confirmed ("the patient had already paid"),
     otherwise the link is cancelled (PAYMENT fail) and the amount is free for another method.
101. **A TrxID paid on a replaced link** is never applied to the new link: a reconciliation Task for the owner and the
     message "do not ask the patient to pay again". A second "confirmed" with another TrxID is reconciled too.
102. **Refused offline payments** keep method and amount on the device (no patient data) and stay on the Payment
     screen until dismissed; the owner is told by the cashier (no automatic Task — the server cannot tell an offline
     replay from a mistaken click).
103. **Receipt numbers**: a new RCPT only when confirmed money changed; a change in pending money alone returns the
     same receipt.
104. **Public verify page** at the staff app's `/verify/rc/<code>`, 20 checks per minute per visitor; behind the staff
     app's proxy the first X-Forwarded-For is trusted only from a loopback/private peer. **Before staging:** decide the
     public host (verify.setu…) and the proxy hops (`trustProxy`).
105. **The fake gateway's buttons** ("Patient pays / Payment fails / Pays, callback lost") are on screen only in dev
     builds and only work with `FAKE_PAYMENTS_DEV_ROUTE=1`; production refuses the fake gateway entirely.
106. **Receipt PDFs are rendered inside the print transaction** (30 s limit) so the copy number and the file agree;
     revisit if printing becomes slow under load (render first, then claim the copy number).

### Pre-pilot list (accountant)
- VAT after discount (D1), Mushak-6.3 once per bill on the settling receipt (96) and its layout (print-specs), cashier
  and approver limits per facility (D4), the seller BIN per facility (sample in demo tenants).

### Phase 2 list
- Before the bKash sandbox: create the Payment row first and the provider link second (decision 90).
- S3-compatible Storage adapter before staging (HANDOVER gap 2).

### Decisions of 03/10/2026 (Kamrul) on items 94–106
- All accepted as recorded.
- 98: no on-the-spot pricing — "Not billed here" with owner/admin approval (built, ADR 0005); owner-set prices come
  with the admin price-list screen in phase 2.

## Billing follow-ups (ADR 0005) — 03/10/2026

### Decided by Kamrul (03/10/2026, before the session)
- Reconciliation queue: owner only. `bill/reconcile` added to the access matrix by hand; beyond the design handoff — the
  prototype gets it in the next design round.
- After a void the visit may get a new bill; it records which bill it replaces, the voided bill records its
  replacement once issued; voided numbers are never reused.
- Void refused while a link is pending ("cancel the link first"); "Not billed here" on order lines only; reconciliation
  "apply" only on a pending payment; VOID stamped on any PDF of a voided bill; order refresh waits (Issue blocked) when
  a discount or approval is on the bill, and adds newly placed orders otherwise.

### Chosen conservatively by Claude — please confirm
107. **Refunds, and voiding a bill that holds confirmed money,** are a later slice. Until then such a bill cannot be
     voided; a wrong paid bill is handled by the owner outside Setu and noted (reconciliation "resolve" note).
108. **Void is also refused while an approval waits on the bill or a reconciliation case is open** (security / money
     reviews): decide those first, so nothing is left in a queue for a voided bill and no money is stranded.
109. **Orders changed after a bill was issued** (an amended note adds a test) are flagged on the issued bill but not
     added: if no money was taken, the owner or an admin voids and re-bills; otherwise tell the owner (an "additional
     bill" for the same visit is a later decision — today one open bill per visit).
110. **Test data:** the E2E clinic's reconciliation queue holds ~45 old cases from automated test runs (oldest first).
     Suggest: the E2E reset resolves leftover cases as the E2E owner with the note "test run". Green Life is unaffected.
111. **The reconciliation list checks without the gateway** (same bill, still pending, same amount); the gateway is
     asked only when the owner presses Apply, so a case can still be refused at that moment ("the gateway does not
     confirm it now").
112. **"Not billed here" on an unpriced consultation** (a doctor without a fee) is not offered; the price list must have
     the fee (phase 2 masters).
113. **Accessibility:** labels wrap their inputs in the new forms; a screen-reader check is due in the accessibility pass.

### Decisions of 03/10/2026 (Kamrul) on items 107–113
- All accepted as recorded.
- 110: yes — the E2E reset resolves leftover reconciliation cases in the E2E clinic as the E2E owner with the note
  "test run" (done in slice A8–A11 session 1, step 0). Green Life is unaffected.

## Slice A8–A11 session 1 (lab backend) — 03/10/2026

### Decided by Kamrul (03/10/2026, before the session)
Plan in two sessions: session 1 = domain rules, schema, contracts, routes and tests for order / specimen / result /
validation / release and ORDER revoke; session 2 = lab screens, delivery and retry screens, the A8–A11 journey spec,
reviews, hands-on test as the lab technologist and the pathologist in the E2E clinic. Safety rules given with the
prompt: a result is never overwritten (a correction is a new Observation version, the old one entered-in-error with a
reason, the ordering doctor notified, a released report that changes gets a new version marked "Corrected"); a critical
call-back is a recorded event that must exist before clinical validation of any HH/LL result, and nothing critical is
released automatically; reference ranges and critical thresholds are a seeded sample labelled "pending clinician
sign-off"; release needs technical verify and clinical validation by users with the right roles, and the same person
may not do both unless the facility allows it (default: not allowed on the Hospital plans, allowed on Clinic); every
message is logged with its status, SMS text has no result values and no diagnosis, and a retry keeps the message id;
the lab's read of earlier results for the delta check is audited like any PHI view.

Plan decisions (all as recommended unless noted):
- D1 **Ranges:** the prototype's single ranges are seeded as adult ranges (Hb 12.0–15.5 as adult female only). Where
  the sample list has no range (men for Hb, under 18 for everything) the screen says "no reference range in the sample
  list" and shows no H/L flag; critical thresholds still apply, marked "adult". **Added:** wherever an adult-female
  range is shown or printed it is labelled "adult female range" next to the value, so a reader never takes it for the
  patient's own range. Clinician sign-off: pre-pilot list.
- D2 **Impossible values:** only non-numbers and negatives are blocked; a critical value (HH/LL) must be typed twice.
  Clinician plausibility limits: pre-pilot list.
- D3 **Report per visit with partial release (changed by Kamrul):** one report per visit covering its lab tests.
  Validated tests can be released early as "PRELIMINARY — n of m tests pending"; the report becomes final when every
  test not cancelled is validated; a critical result never waits on another tube. Each release (preliminary, final,
  corrected) is a new report version.
- D4 **Corrections:** values are saved together at "Send for verification"; any change after that is a correction
  with a reason, a new Observation version, and verify + validate again. The ordering doctor is notified once the
  result had been released (when the correction starts and when the corrected version is released).
- D5 **Order cancellation (ORDER revoke):** only before the first tube is collected; by the ordering doctor, the lab
  technologist or the pathologist (not admin); a lab cancellation notifies the ordering doctor's inbox. **Added:** a
  reason of at least 10 characters, audited, and it triggers billing's order refresh (decision 99).
- D6 **Doctor's inbox** is sent automatically on every release; SMS and the patient app are manual sends; the
  patient-app channel records "available in the app" until Journey D; WhatsApp and print are not offered yet.
- D7 **Payment is not required before collection** in this slice; the bill's status is shown on the row; a facility
  setting comes later.
- D8 **Offline:** collect, reject and receive go through the outbox; results, verify, validate, call-back, release and
  sending need a connection.
- D9 **Call-back and release** by the lab technologist or the pathologist; recipients from the prototype (ordering
  doctor, duty doctor, the patient when no doctor can be reached); a corrected value that is still critical needs a new
  call-back. **Added:** a call-back record stores the recipient's role and name, the time, the caller and a
  read-back-confirmed tick; attempts that reached no one are logged as attempts and do not unblock validation.
- D10 **The lab report PDF with QR** comes with A12–A13 (printing); this slice shows the report on screen.

### Chosen conservatively by Claude — please confirm
114. **Creatinine is seeded like Hb: adult female range only** (the prototype's 0.5–1.1 mg/dL is the women's range).
     Men get "no reference range in the sample list" and no H/L flag; the critical threshold (>4) still applies.
115. **Analyte names stay in English in both languages** (Haemoglobin, S. Potassium …), as on Bangladeshi lab reports —
     the same rule as test names (open question 55).
116. **Tests with no result template in the sample list cannot be entered** (lipid profile, urine R/E and C/S, TSH,
     SGPT): they stay "pending", so a visit with one of them never gets a final report — only preliminary versions.
     Templates come with the clinician's sign-off (pre-pilot list).
117. **Technical verify needs the "sample identity checked" tick when the delta check warned.** The prototype only warned
     ("confirm sample identity before verifying"); the tick makes the check a recorded step.
118. **Verify and validate act on whole tests** (all results of a test together); a test is released only when all its
     results are validated.
119. **Only the lab technologist corrects a result** (the result-entry screen). The pathologist cannot correct and there
     is no "send back to the technologist" yet — the pathologist asks in person. Decide if a send-back is wanted.
120. **Admin** sees the lab screens and may send deliveries (access matrix: Delivery), but cannot collect, enter, verify,
     validate, release or cancel orders.
121. **A label is reprinted only before collection** (audited, copy counted). A printed label whose tests were all
     cancelled stays on record as an uncollected tube; collecting it is refused ("discard the label").
122. **No valid mobile number:** a rejection records no recollection SMS (the screen must say "tell the patient"), and
     "Send SMS" answers 422. The SMS goes to the registered number even when it is a family phone (the text has no name).
123. **SMS text:** one message, Bangla then English, facility name only, "collect at the lab counter" (no app link until
     Journey D). The facility's phone number is not in the text (not stored yet).
124. **SMS are sent right after the write commits**, one transaction per message. If the API stops in between, a message
     can stay in preparation / in progress with no retry button (retry is for failed only) — phase 2: a worker that
     sweeps these, together with the real gateway.
125. **Worklists look back 30 days** (orders placed in the last 30 days); older open work needs a separate list later.
126. **A test under correction is "pending" in the next version**; the version that released the old value marks it
     "under correction — do not act on it".
127. **Rahima's 12/08 lab results are seeded without an order or report** (her 12/08 note was seeded before the lab
     existed and a signed note takes no new orders); they only feed the delta check.
128. **A call-back can be logged only for an HH/LL result that is not yet validated.** A call logged after validation is
     not possible (validation already needed it).
129. **The lab technologist may release** (D9): on Hospital plans a technologist can release what a pathologist
     validated; release is never automatic.
130. **The doctor's inbox is a list of Communication rows for now** (report released, result under correction, order
     cancelled by the lab); the inbox screen is A12.
131. **The same-person setting has no screen yet** (Organization.labSamePersonAllowed; default by plan); admin masters,
     phase 2.
132. **Collect / receive / start / reject carry the device's time** (offline outbox, D8), accepted within 24 hours back
     and 5 minutes ahead.
133. **Results cannot be withdrawn without a replacement value.** If a sample turns out to be wrong after results were
     entered (wrong patient's tube), a result can only be corrected to a new value; there is no "entered in error, no
     result" for a whole test yet. Needs a decision (proposal: mark the test's results entered-in-error with a reason and
     ask for a new tube, which notifies the doctor if released).

### Decisions of 03/10/2026 (Kamrul) on items 114–133
- All accepted as recorded, with these:
- 116: correct as is; result templates for lipid profile, urine R/E, urine C/S, TSH and SGPT are on the pre-pilot
  clinician list.
- 119: **send-back** — the pathologist can return a verified test to the technologist with a reason (≥10 characters):
  RESULT `return` (verified → preliminary, ADR 0006 addendum), audited, shown on the technologist's worklist as
  "Returned — <reason>"; validating a returned test needs verify again.
- 133: **withdraw results** — on a test, marks all its current results entered-in-error with a reason (≥10), no
  replacement value; a new tube is required (recollection with SMS); the doctor gets a correction notice if any of them
  had been released; the released version marks the test "withdrawn — do not act on it". Lab technologist or
  pathologist, audited.

## Slice A8–A11 session 2 (lab screens, journey spec, reviews, hands-on) — 03/10/2026

### Decided by Kamrul (03/10/2026, before the session)
- Run `pnpm e2e` first (51 green on the journey servers :4100 / :3300).
- Hands-on as technologist 01799000005 and pathologist 01799000006: collect with label print; reject a tube and see
  the recollection SMS in the fake messenger; critical potassium typed twice; validate blocked without a call-back,
  still blocked after a no-answer attempt, validated after a reached call-back with read-back; release PRELIMINARY with
  one test pending; correct a released value (doctor's inbox notice, "do not act on it" on v1); pathologist send-back;
  withdraw a test's results; retry a failed SMS; cancel an order from the signed note and see the bill line drop.

### From the hands-on test of session 2 (03/10/2026)
134. **Nav badge counts are sample numbers.** The badges in the side menu (Verification "4", Serial board "6",
     Approvals "3", …) come from `access-matrix.json`, copied from the prototype, so they do not match the real
     worklists (in Bangla "4" shows as "৪", which reads like an 8). Proposal: hide a badge until its module has a live
     count, and add live counts slice by slice (lab: tests waiting for verify / validate / call-back).

## Slice A12–A13 session 1 (doctor's inbox, acknowledgement, prescription and lab report PDFs) — 03/10/2026

### Decided by Kamrul (03/10/2026, before the session)
Plan in two sessions: session 1 = ADR 0007, domain rules, schema, contracts, routes, PDFs and verify pages with tests;
session 2 = the doctor app module at phone width (bottom tabs: home, queue, quick consult, reports), print preview on
the signed note, the A12–A13 journey spec, reviews, hands-on as the doctor, then the whole of Journey A end to end.
Commit after each step, push at the end of each session.
- D1 **Acknowledge (two buttons, as the prototype):** "Seen" marks the report version reviewed by this doctor; "Seen +
  tell patient" also sends the patient an SMS with the facility's name only ("your doctor has reviewed your report,
  please contact <facility>") — no test, value or diagnosis. The SMS is sent only after the server has stored the
  acknowledgement; an acknowledgement made offline waits in the outbox as "Not yet synced" and sends nothing until then.
- D2 **Prescription verify page (QR):** facility, doctor with BMDC number (as stored, "not verified" when unverified),
  date, version status ("a newer version exists" when superseded, "withdrawn" when entered-in-error), the patient's
  initials, age and sex, and the medicine lines (so a pharmacy can check them). No name, phone, diagnosis or notes.
- D3 **The lab report PDF with QR** (decision D10 of A8–A11) is part of this slice, on the same pipeline.
- D4 **Two sessions** (above).

### Settled by the sources (no decision needed)
- **Drafts are blocked from print** (runbook, issue #19, the Consultation prototype and DS 6 agree): the preview shows the
  watermark "খসড়া — বৈধ নয় · DRAFT", no QR, Print disabled, message "Drafts cannot be printed — sign first"; the server
  refuses (422). `print-specs.md` line 3 ("drafts print a diagonal watermark … printing may be disabled by policy") is
  read as that policy being on.
- **The doctor app is a phone-width module inside apps/staff** (runbook and BUILD-PLAN); the Flutter `doctor://` routes in
  `screens.md` are the later native app.
- The signing PIN stays 4 digits (prototype says 4–6). "Comment" on an inbox card has no behaviour in the prototype and
  waits; onboarding/OTP, chamber linking, voice draft, rounds and earnings belong to later journeys.
- Inbox order: critical (HH/LL) → high/low → normal → notices, newest first within a group (the prototype only
  hard-codes its sample order).
- **Critical vital signs** reach the inbox of the visit's doctor (decision 47 of A4–A5).

### Chosen conservatively by Claude in session 1 — please confirm
135. **The printed verify code is 20 characters (in groups of four), not the print spec's 6.** The prescription page
     shows medicines (D2), and a 6-character code could be guessed; the QR carries it, so nobody types it.
136. **Who prints:** a prescription — doctors only (from the signed note or the doctor app), not the receptionist; a lab
     report — the lab technologist, the pathologist and doctors. Ask if the front desk should print prescriptions.
137. **"Tell patient" only at acknowledgement:** an item acknowledged with "Seen" cannot send the SMS later (one
     acknowledgement per item). A later "send to patient" button can come with Journey D.
138. **Critical vital signs:** one inbox item per critical value, only when the visit has a doctor (the doctor who
     opened the consultation); before that the queue card's "Critical vital sign" flag is the only signal.
139. **Inbox scope:** this facility only (the doctor switches facility to see another chamber's results), the last 14
     days by default (up to 90), at most 200 items.
140. **The lab report verify page shows the values** (with flags, ranges and "under correction" marks) next to the
     patient's initials, age and sex — the page's purpose; D2 covered the prescription page only.
141. **Digits on prints:** Bangla digits only on a Bangla-only print; the bilingual print uses Latin digits throughout,
     the dose included (the prototype's bilingual pad showed the dose in Bangla digits).
142. **Reprint reasons for clinical documents:** lost, printer jam / unclear, extra copy (pharmacy, another doctor) —
     not the receipt's corporate / insurance reasons.
143. **The doctor's menu shows "Doctor app"** from now on; its screens show the slice placeholder until session 2.

## Slice A12–A13 session 2 (doctor app, printing, reviews, Journey A) — 03/10/2026

### From the reviews and the hands-on test — please confirm
144. **Patient SMS wording** (clinical review M6): changed to "{facility}: Your doctor has reviewed your lab report.
     Please contact {facility}." (no "if you need to"). Should "Seen + tell patient" be refused for a critical report
     (the doctor must phone instead)? Today it is allowed, as the prototype shows the button on critical cards.
145. **Allergies on a reprint** (clinical review L3): a print shows the allergies as they are when printed, not when the
     note was signed — safer clinically, but a reprint can differ from the original. Keep?
146. **A printed original can still be printed again from the browser tab it was opened in** (clinical review M5): the
     server no longer hands out a replaced or withdrawn version's stored copy and the QR says "replaced", but an open
     PDF tab cannot be recalled. Accept (QR is the check), or add "COPY" to every stored PDF view?
147. **PDF rendering inside the database transaction** (security review S5): a print holds a connection for the render
     (≤30 s, rate-limited to 30/min per user). A file written just before a failed commit stays in storage without a
     print row. Move rendering before the transaction and add a cleanup job before the pilot?
148. **A correction notice about a critical value ranks with critical results** (clinical review M1); a report with a
     value under correction cannot be acknowledged until the corrected version is released. Confirm the rule.
149. **Who opens a lab report as a doctor:** the doctor it was sent to, a doctor who ordered a test of the visit, or the
     visit's doctor (security review S2). Covering doctors (leave, nights) need a rule later (break-glass, Journey E).


## Phase 2 plan and slice C1–C4 session 1 (owner dashboard, shift close) — 03/10/2026

### Decided by Kamrul (03/10/2026, before the session)
- **Phase 2 is split into four slices** (runbook prompt 10 was about five slices of work and only C1–C4 has walkthrough
  steps): 1) `/slice C1-C4` — owner dashboard (live + nightly rollup, drill-downs, leakage), cashier shift close, owner
  approvals and variance on the phone; 2) pharmacy (dispense FEFO, OTC, stock, purchase / GRN / suppliers, count);
  3) admin (onboarding + go-live, users & roles, masters); 4) real SMS gateway + bKash sandbox (with open questions 90
  and 124). Each slice plans before code; pharmacy and admin get their own journey specs.
- **No 'manager' / 'store keeper' role:** approvals the prototypes give a manager (shift hand-over, variance accept,
  later purchase / count approvals) go to the **owner or admin**, as approvals do today. A manager role can come with
  the admin slice.
- **SMS gateway: decided later** (slice 4; Claude lists the options then — sender-ID approval has lead time).
- **bKash: no sandbox credentials yet** — the fake provider stays until slice 4; real bKash checkout is create →
  redirect → execute, so slice 4 adds an ADR for the execute step.
- Plan for C1–C4 in two sessions: session 1 = ADR 0008, shift and KPI rules, Shift + DailyRollup tables, nightly job,
  routes and tests; session 2 = bill/shift and own/dash screens (1440 + 412), phone approvals / variance, C1–C4 journey
  spec, reviews, hands-on as the owner.

### Chosen conservatively by Claude in C1–C4 session 1 — please confirm
150. **Cash refunds count as 0** in the expected cash until the refunds slice exists.
151. **Taking cash without an open shift is not blocked** (the A6–A7 flows stay as they are); it shows on the owner's
     leakage list as "cash taken outside a shift". Should a cashier have to open a shift before taking cash?
152. **Whose shift a payment belongs to:** the cashier who took it (`Payment.createdById`), by the time it was confirmed —
     a bKash link confirmed later by the gateway counts in that cashier's shift if it is still open.
153. **"Today" is compared with the same weekday last week, up to the same hour** (the prototype's "vs last Sunday");
     7 / 30 days with the 7 / 30 before.
154. **Lab turnaround** = the average minutes from the order to the test's first release (the prototype says TAT without
     defining it).
155. **"Discounts above policy"** = discounts that needed the owner's approval (above the cashier's limit), with who asked
     and who approved.
156. **Dues** = issued, not voided bills minus confirmed payments at the end of the day (no credit notes or refunds yet).
157. **Pending approvals on the dashboard are counted per tenant** (an approval task has no facility); right for a
     single-facility pilot, to revisit for multi-branch owners.
158. **The nightly job runs inside the API process** (00:30 Dhaka; a second instance would recompute the same rows); a
     separate worker before scaling out.

### From the reviews and the hands-on test of C1–C4 session 2 — please confirm
159. **Opening float** (money-controls review H1): the cashier types it and the owner's review card marks it as the
     cashier's figure. A fixed float per counter set by the owner (admin slice) and a check against it — or the owner
     confirming each float — would close the gap. Which?
160. **Card / bank / bKash / Nagad settlements are the cashier's figures** (H2): shown as such. Should the owner (or a
     second person) enter or confirm the terminal batch / bank statement before a shift is approved?
161. **Blind count** (M1): the cashier no longer sees the expected cash while counting; the variance appears only after
     the count is sent. Keep (recommended practice), or show it?
162. **A payment confirmed while the cashier is counting** (money-controls review L2) can fall between the expected cash
     and "cash outside a shift"; a check that compares each approved count's cash with the payments in its window
     comes with the pilot hardening.
163. **Drill-down audit rows keep the patients in `detail.patientIds`, not in `AuditEvent.patientId`** (security
     review #6) — the patient-facing "who saw my record" list (Journey D) must read both.
164. **A rollup older than 35 days is not recomputed** when a bill or payment from that day changes later; the 30-day
     view is always within it. Recompute on change, or accept?
165. **Rendering of the dashboard happens inside one read transaction** (≤30 s; at most 8 missing days computed per
     request, the rest "still being prepared"). A separate worker for the nightly job before scaling out (see 158).


## Phase 2 slice 2 — pharmacy, session 1 — 03/10/2026

### Decided by Kamrul (03/10/2026, before the session)
- **Journey P (pharmacy acceptance, no walkthrough steps existed):** P1 dispense Rahima's signed prescription — FEFO
  batch, expired blocked; P2 out-of-stock line → same-generic substitute with a reason, the doctor's inbox told; P3
  partial dispense (the rest stays open) → Bangla dose label → the charge on a bill; P4 OTC sale — an Rx-only item needs
  a prescription photo, a controlled drug is refused; P5 goods received against a purchase order with a short-expiry
  line and a short delivery → stock up, debit note; P6 physical count with a variance → owner approves → adjustment
  posted; stock tiles on the owner dashboard. Becomes `e2e/journeys/p1-p6.spec.ts`.
- **Three sessions:** 1) ADR 0009, stock core (medicine, batch, ledger), dispense and OTC — backend; 2) suppliers,
  purchase orders, goods received, counts and adjustments, dashboard stock tiles — backend; 3) the six pharmacy screens,
  the journey spec, reviews, hands-on as the pharmacist.
- **A dispensed prescription is charged on a separate pharmacy bill for the visit** (the OPD bill stays as it is; same
  billing rules, VAT per line); the cashier collects it like any bill.
- **The pharmacist takes the money for an OTC sale at the counter** (a pharmacy bill without a visit; cash / bKash) and
  has a shift like a cashier — counted blind, reviewed by the owner.
- **Prices per batch, set at goods received** (cost and MRP); FEFO picks the batch and its price; demo clinics get
  sample batches labelled sample.
- Stock adjustments and purchase orders above a sample threshold go to the owner / admin (no manager role).

### Decided in the session (defaults — Kamrul to confirm)
166. **Medicine leaves the shelf when it is dispensed**, while the visit's pharmacy bill is still a draft; a bill that
     holds given medicine cannot be voided (409 "medicine given") until returns exist (refunds slice — question 191: a `return` move with
     a reason, owner / admin). Should an unpaid pharmacy bill block the next visit, or only show on the owner's list?
167. **An OTC sale takes no discount** for now (409 `no_discount_otc`). A visit's pharmacy bill takes one through the
     cashier's normal discount rules — and while it has one, further dispensing waits ("settle it first"). Keep?
168. **An OTC sale's stock moves when the bill is issued, before it is paid** (issued-but-unpaid = the buyer may leave
     with the goods). Should the counter require payment before handing over (issue + pay as one step)?
169. **Medicine is picked from the counter (and fridge) only**; store stock reaches the counter by a transfer
     (session 2). Until then a counter shortfall is "not enough stock at the counter".
170. **A substitute must be the same ingredients, strength and form** (clinical review: Comet 850 is not a substitute
     for Comet 500). After an amendment, what was given counts against the current line of the same medicine — the one
     prescribed then or the substitute given. A different strength after an amendment (500 → 850) counts nothing.
     Clinician to confirm.
171. **A decline is tied to its line**; after an amendment the matching line keeps it. The doctor is told about
     substitutes only, not declines — should a decline also notify the doctor?
172. **The prescription photo for an Rx-only OTC item** is any JPEG / PNG ≤ 3 MB; nothing checks it is a prescription
     (prescriber, date, quantity), and one photo unlocks every Rx line on that sale. What must the pharmacist check,
     and how long are photos kept? (Stored through the Storage adapter, local folder in dev — HANDOVER gap 2.)
173. **Controlled drugs** are refused over the counter; against a prescription they dispense like any line. Does a
     controlled-drug register entry or a second check need to exist before the pilot?
174. **The dispense queue lists today's visits only.** A partial dispense continued on a later day — show earlier
     days' open lines too (e.g. the last 7 days)?
175. **Expiry against course length:** FEFO can give a 30-day course from a batch expiring tomorrow. Warn when the
     batch expires before the course ends, or skip such batches?
176. **Owner revenue now includes pharmacy and OTC bills** (one total). Split revenue by bill kind on the dashboard
     (a rollup version bump), or keep one figure until the stock tiles (session 2)?
177. **The pharmacist sees only pharmacy and OTC bills** and may issue, take money (cash / bKash / card) and print
     receipts on them, and holds a shift; discounts, voids and reconciliation stay with billing / the owner.
178. **Low stock** on the stock list = fewer than 100 usable at the counter (sample); per-item reorder levels come with
     purchasing (session 2).

## Phase 2 slice 2 — pharmacy, session 2 — 03/10/2026

### Decided in the session (defaults — Kamrul to confirm)
179. **Purchase-order approval above ৳50,000 (sample)**, VAT not included; the pharmacist asks, the owner / admin
     approves (and so sends). Splitting one need into several orders under the threshold needs no approval — add a
     per-supplier daily total, or an owner digest of orders sent?
180. **A supplier bill at another unit cost than the order** is posted only by the owner / admin (any difference; no
     tolerance). What tolerance, if any, may the pharmacist accept?
181. **VAT / AIT on purchases are not handled**: what is owed = received qty × the bill's unit cost; the line's VAT
     rate is the sale VAT of the batch. Do suppliers bill VAT on top, and must input VAT be tracked?
182. **A short delivery** is a debit note (billed − received) × cost; what was not delivered stays open on the order
     until it arrives or the order is closed short with a reason.
183. **Short expiry = fewer than 180 days** (not calendar months) → posted only by the owner / admin.
184. **The same batch number again at another expiry or price** is refused (409 `batch_conflict`) — should it become a
     separate batch instead (e.g. the batch number + a suffix)?
185. **Counting does not stop the counter**: the adjustment is counted − (system at the start + what moved before that
     batch was counted). Alternatively freeze sales at a location while it is counted?
186. **A count is decided by the owner / admin, never the person who counted** — a clinic whose only approver counts
     cannot approve it. Is a second admin always available, or may the owner approve their own count with a note?
187. **Counts list batches with stock above zero**; quarantine is not a count location; expired batches at a location
     are counted. Stock found in an empty batch cannot be recorded yet.
188. **Expired stock moves to the store** (never to the counter / fridge); should expired stock go to quarantine
     instead, and can fridge stock move to the counter (cold chain)?
189. **Supplier payments**: owner / admin only, never more than is owed; how it was paid is a note (cheque no. / TrxID).
190. **Sample batches count in the stock-value tile** (demo stock) — keep, or show them separately?
191. **Patient returns of dispensed medicine** (and voiding a pharmacy bill with given medicine) move to the refunds
     slice, since money goes back; until then the void stays refused (open question 166).

## Phase 2 slice 2 — pharmacy, session 3 — 03/10/2026
192. **The dose label is a screen preview only** (50 × 30 mm, Bangla). Which label printer / paper, and is the label
     part of `print-specs.md` (patient name, medicine, dose, batch, expiry, facility)? Printing comes when decided.
193. **The pharmacist now reaches Payment, Receipt and Shift close** in the Billing menu (ADR 0009 note) — the prototype
     should show the pharmacist's counter till in the next design round. Keep it under Billing, or a "Counter" item in
     the Pharmacy menu?
194. **Owner approvals for the pharmacy are a tab in Purchase** (orders above the limit, receipts only the owner may
     post, counts waiting). Should they also appear in the owner's Approvals screen and the dashboard's pending count?

### Decided by Kamrul (03/10/2026, after session 3)
- **192 → the browser prints the label** on a label-sized page (default 50 × 30 mm, a facility setting); ZPL / TSPL
  only when a pilot clinic names its printer (phase 2).
- **193 → Pharmacy screens `ph/pay`, `ph/receipt`** (and `ph/shift`, which moved with them so the pharmacist has one
  module — confirm), reusing the billing components; the cashier keeps `bill/pay`.
- **194 → one approval queue**: the owner's Approvals screen lists every kind with a kind filter; Pharmacy's tab is the
  pre-filtered view; nothing approvable in one place and invisible in the other.
- Pre-pilot (pharmacist): verify the uploaded photo is a prescription — HANDOVER gap 12.

## Phase 2 slice 3 — admin, session 1 — 04/10/2026

### Decided by Kamrul (04/10/2026, before the session)
- **Scope:** onboarding + go-live checklist, users & roles, masters (price list with versions, approval limits, dose-label
  page), audit log with export. Not in this slice: print template designer, subscription, integrations, real SMS / bKash.
- **New users get a one-time password** shown once to the admin; at first sign-in the user sets their own password and
  PIN. An SMS invite replaces it when the real gateway lands.
- **No Manager role yet** — owner / admin stay the approvers; a Manager comes later with a role-matrix ADR.
- **A price change applies to bills created after it takes effect**; drafts and issued bills keep the price they were
  made with (a draft shows "price changed since").
- **Two sessions:** 1) backend; 2) the four screens, journey spec, reviews, hands-on.

### Decided in the session (defaults — Kamrul to confirm)
195. **A signed prescription keeps the signer's registration as it was at signing** (a later re-check or a new number
     does not change it). Notes signed before 04/10/2026 got the registration as it stood then.
196. **A doctor who is switched off:** their open visits, inbox items and drafts are not reassigned. Who takes them over?
197. **The Flags filter** shows reprints, voids, exports, deactivation / reactivation, role changes, password resets,
     price and settings changes, go-live. Emergency access (break-glass) is not recorded until Connected Care. Should
     marked-in-error records, cancelled payment links or approved discounts be flagged too?
198. **The admin's audit log is per facility;** the owner also sees tenant-level events (sign-ins, public QR checks).
     Events from before 04/10/2026 by someone working at several facilities stay tenant-level.
199. **An account is one person across the owner's facilities** (one password, PIN, registration): a facility admin
     cannot reset, re-register, change or switch off someone who also works elsewhere — the owner does it. Keep?
200. **A facility in setup is not blocked** from clinical work or payments in this slice (the screens will say "in
     setup"); a setup facility takes no payment until it chooses its methods. Should setup block registration?

## Phase 2 slice 3 — admin, session 2 — 04/10/2026
### Decided in the session (defaults — Kamrul to confirm)
201. **The one-time password is shown once** (with a copy button) and never again; a lost one means "Reset password",
     which makes a new one and ends the user's sessions. Should it also go to the user by SMS once SMS is real?
202. **An ended session clears that user's drafts on the device** (consultation drafts, refused writes) before signing
     out, so a switched-off user's notes never sync later. A half-written note is lost — acceptable?
203. **The audit log opens on Flags only** (the owner's usual question is "anything unusual?"); untick for every event.
204. **The sign-in page's strings are still inline** (known gap 9) — the session-ended banner follows that page's
     pattern; moving the page to `packages/i18n` is left for the auth hardening pass.

## Phase 2 slice 4 — SMS + bKash, session 1 (bKash) — 04/10/2026
### Decided by Kamrul (04/10/2026, before the session)
- SMS gateway: **BulkSMSBD** (session 2). bKash: no sandbox credentials yet — built to the documented API with a local
  stand-in. Two sessions.

### Decided in the session (defaults — Kamrul to confirm)
205. **The patient scans a QR on the cashier's screen** (or opens the short link); bKash itself sends nothing. Session 2
     also texts the short link. Is a QR at the counter acceptable for patients without a smartphone camera? (They pay
     cash / card, or the link by SMS after session 2.)
206. **Our link window is 30 minutes** (bKash keeps a paymentId 24 h). A patient who pays after that is not charged and
     is told to ask at the counter.
207. **To check with bKash when credentials arrive:** how the return's `signature` is made (we only compare it with the
     one from create — if create has none, every return would be refused); `Authorization` raw token or `Bearer`; the
     live hostname (`tokenized.pay.bka.sh`?); whether 9999 on a payment API ever means a bad token.
208. **One bKash merchant account per deployment** for the pilot (credentials in `.env`). A second clinic needs its own
     merchant account per facility, or Setu as a bKash aggregator with sub-merchants — a business decision.
209. **Nagad is unavailable in production** until its own adapter (the fake's signing secret is public). In dev it stays
     on the fake. Should the pilot clinic's payment methods simply leave Nagad off?
210. **bKash money confirmed after the cashier's shift was counted** is in no shift's digital totals (money review M3; the
     "outside a shift" list covers cash only). Add wallet payments to that list, or count a wallet payment in the shift
     it was started in?
211. **An execute whose answer is unknown** (timeout, bKash unreachable) keeps the payment "being completed" — the
     cashier cannot cancel it — until bKash answers or 5 minutes pass. Acceptable at a busy counter?
212. **BulkSMSBD's API is plain `http://`** with the key in the URL (from the page you pasted) — session 2 tries https
     first; if only http works, the key crosses the network in clear text. The pasted text contained two API keys —
     if either is the real account key, consider rotating it, and it goes only in `.env`.

## Phase 2 slice 4 — SMS + bKash, session 2 (SMS) — 04/10/2026
### Decided in the session (defaults — Kamrul to confirm)
213. **BulkSMSBD cannot confirm delivery**, so every SMS through it shows "Sent (delivery not confirmed)". Ask BulkSMSBD
     whether delivery reports exist on their side (a report API or a callback); if not, is that acceptable for the
     pilot, or should gateways that offer delivery reports be compared (to be checked, e.g. SSL Wireless)?
214. **Bangla text:** we send `type=text` with UTF-8 (the account page shows only `text`; code 1012 says masking SMS must
     be in Bangla, so Bangla is accepted). Confirm with one real Bangla test SMS, or with BulkSMSBD whether
     `type=unicode` is needed.
215. **Every patient SMS is Bangla + English** (Unicode, about 3 SMS parts each — the payment link about 3). Bangla only,
     or by the facility's language setting, would roughly halve the cost.
216. **The sender id is a number** until BTRC approves a masking name through BulkSMSBD (about a week). Which name
     should be applied for — the clinic's, or "Setu"?
217. **One BulkSMSBD account and balance for the whole deployment** (like bKash, question 208). A low balance stops every
     facility's SMS (codes 1006 / 1007 show as "the facility's setup"); the balance is not shown in the app yet
     (`getBalanceApi` exists). Show it to the owner?
218. **No automatic resend, ever:** a message without an answer from the gateway is "may have been sent" and waits for a
     person (Retry asks "they may get it twice"). A doctor's "Seen + tell patient" SMS has no Retry yet.
219. **The admin's test SMS is confirmed by the admin** ("Yes, it arrived") — the only proof possible without delivery
     reports. Five tests an hour per facility; a payment link at most five SMS per payment, a minute apart.


## Refunds slice, session 1 (domain, database, contracts, routes, bKash refund) — 05/10/2026
### Decided by Kamrul (05/10/2026, before the session)
- Recommendations 1, 3, 5, 7, 8, 9, 10 accepted: `bill/refund` (and a hand-added `ph/refund`) host request, payout and
  voucher, opened from `bill/pay` / `ph/pay`; performed = locked; returned medicine into quarantine at payout; the
  reconciliation refund (no lines, the case's amount); a cash payout needs the payer's open shift; refunds paid by hand go to
  the owner's reconciliation queue; owner / admin approve, controlled drugs owner only.
- **2:** a card / bank payment paid back in cash needs the **owner** (not an admin) and is flagged for reconciliation; a bKash
  payment goes back through the gateway, cash only when the gateway refund failed or the patient has no wallet access
  (the reason stored).
- **4:** `withdrawn` is its own state (approved → withdrawn, owner / admin, note ≥ 10), never shown as rejected.
- **6:** returned units reopen the line; every "wrong dispense" return tells the prescribing doctor and is a medication
  incident on the owner's list; the re-dispense is a normal dispense with the reason "re-dispense after return".
- The voucher records who took the money (name, mobile, relationship), required at payout, above a signature line.
- This answers **107** (a paid bill is voided once all its money was refunded — ADR 0005 addendum), **150** (cash refunds
  now count in the shift's expected cash), **166 / 191** (returns of dispensed medicine; a pharmacy bill is voidable once
  all its medicine and money came back).

### Decided in the session (defaults — Kamrul to confirm)
220. **A refund pays out per allocation.** A refund against two payments (e.g. part cash, part bKash) can be part-paid: the
     cash is out of the drawer while the bKash part waits or failed. The voucher is made only when every part is paid; the
     refund cannot be withdrawn once any part moved. Acceptable, or one payout method per refund?
221. **Medicine returns on an unpaid pharmacy bill** (given, nothing paid yet) have no path: a refund needs confirmed money,
     and the bill still cannot be voided. Should the pharmacist be able to take medicine back off an unpaid bill (a return
     without money), and the bill then be voided or reduced?
222. **A refund on a bill that still has a due** (partly paid) is allowed and does not reduce the due (credit note lines
     are recorded; due = total − confirmed money, as before — question 156). The accountant should confirm, or the cashier
     should be steered to "reduce the due" instead of paying money back.
223. **Reconciliation "refund to patient" is requested by the owner,** so it needs another approver (an admin, or a second
     owner). A clinic with a single owner and no admin cannot approve it — allow the owner with a note, or require an admin?
224. **A cash refund is not checked against what the drawer holds** (counts are blind); a large cash refund shows only as a
     variance at hand-over. Add a cap per refund for cashiers?
225. **An approved refund never paid out** has no expiry; it blocks a new refund on that bill until someone withdraws it.
     Auto-withdraw after N days?
226. **Quarantine has no disposal step yet:** returned units not released to the counter stay in quarantine (not in the
     stock value tile, not pickable). Disposal / return-to-supplier comes with a later pharmacy step.
227. **bKash, to check with sandbox credentials:** the error code for a duplicate refund within 10 minutes and for an 11th
     refund (the stand-in answers 2074); whether Refund Status's `trxId` is the original TrxID (the sample) or a refund
     request id (the parameter table); Refund Status's `completedTime` format.
228. **An unanswered gateway refund** is asked about by the sweep after 2 minutes and handed back to a person after 15 with
     nothing found; a retry asks Refund Status first and only then refunds again. bKash documents no refund webhook.
229. **Revenue stays "bills issued"** and collections stay gross; refunds are their own tile (money paid back in the period,
     by the day each part was paid). Should the owner also see a "net collected" figure?
230. **The wrong-dispense notice goes to the visit's practitioner** (the encounter's doctor), like the substitution notice.
231. **The voucher is titled "Refund voucher"** until the accountant confirms the Mushak credit-note form (6.7) and its
     layout (pre-pilot accountant list).
232. **Nagad (and the fake gateway) have no refund API in Setu:** their refunds are made by hand with a reference and checked
     by the owner against the statement.

## Refunds slice, session 2 (screens, voucher, journey R, reviews, hands-on) — 05/10/2026
### Decided by Kamrul (05/10/2026, after session 1)
- **220** one refund = one payout method, never part-paid; part cash, part bKash = two refunds, two vouchers.
- **221** return without refund on an unpaid pharmacy bill: same approval path, stock to quarantine, the due goes down,
  a credit voucher (CV/…); due zero and no money ever → the ADR 0005 void.
- **223** self-approval only when the requester is the facility's only approver, with a note, flagged (refund, audit,
  dashboard).
- **227** bKash sandbox codes on the pre-pilot list; an unrecognised refund code is "unknown — ask Refund Status"; an
  answer for money already recorded as paid changes nothing.
- Cautious readings on 222, 224–226, 228–232 stand as written.

### Decided in the session (defaults — Kamrul to confirm)
233. **A partly paid pharmacy bill whose medicine all comes back gets stuck** (money review M5): ৳1,000 bill, ৳500 paid,
     10 tablets back → a refund covers 5 (the money paid), a return without refund is refused (money is on the bill), so
     ৳500 stays due and the other 5 tablets are not in stock. Recommend: allow a return without refund on a bill holding
     money for the unpaid part (credited ≤ total − paid). Not built — it widens decision 221.
234. **Stock counts still refuse self-approval outright** (question 186) while refunds allow the only approver with a
     note (223). Align counts with 223?
235. **A gateway refund whose status answer cannot be read stays "being processed"** (security review H1: an unreadable
     answer is never taken as "nothing refunded"). Only "Check with bKash" and the sweep can settle it — there is no
     manual release yet. Before real money: an owner action "checked on the bKash merchant portal — not refunded" (with a
     note) that hands it back to the cashier.
236. **The controlled-drug rule (owner approves, owner releases from quarantine) is checked by the app only:** the sale
     class lives in the sample drug list, not the database (the database checks the resale is by a pharmacist or the
     owner). It moves into the database with the licensed drug list (gap 12).
237. **The owner's check of a refund paid by hand is owner-only** (bill/reconcile); an admin cannot do it. With one owner
     who paid it themselves, they may check it with a note (223's rule, counting owners only).
238. **Wrong-dispense returns of an OTC sale** count as medication incidents on the owner's list but tell no doctor
     (there is no prescription). Fine?
239. **The refund amount boxes** take Latin or Bangla digits; amounts are typed as taka (৳150 or ১৫০).
