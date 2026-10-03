# ADR 0006 — Lab results, report versions, critical call-backs and messages

Date: 2026-10-03 · Status: accepted (Kamrul, 03/10/2026 — slice A8–A11 plan decisions D1–D10)

## Context
The domain model gives `Result registered → preliminary → final → amended ; critical → call-back logged before final`
and treats DiagnosticReport as a clinical document (draft → final → amended). The prototype (Setu Lab, steps A8–A11)
and Kamrul's safety rules for the lab slice need more than that:
- two separate checks before a result counts: **technical verification** (values plausible, sample OK) and **clinical
  validation** (the pathologist interprets and signs), by two different people unless the facility allows one person
  to do both (default: allowed on the Clinic plan, not on Hospital Lite / Pro);
- a result is **never overwritten** — a correction is a new Observation, the old one is entered-in-error with a reason;
- **one report per visit, released in versions** (decision D3): validated tests may go out early as "PRELIMINARY —
  n of m tests pending", the report is final when every test not cancelled is validated, a critical result never waits
  on another tube, and each release (preliminary, final, corrected) is a new version;
- a **critical-value call-back** must be recorded before any HH/LL result is validated; attempts that reached no one are
  logged and do not count;
- every message (recollection SMS, "report ready" SMS, patient app, doctor's inbox) is logged with a status, and a
  failed send can be retried with the same message id.

## Decision
### RESULT (lab Observation) gains `verified` and `entered-in-error`
```
registered ──enter──▶ preliminary ──verify(PIN)──▶ verified ──validate(PIN)──▶ final ──amend──▶ amended
preliminary | verified | final | amended ──markError(reason)──▶ entered-in-error
```
- `enter` happens when the technologist presses "Send for verification" (all analytes of the test together; the form
  is not a server draft).
- `verified` is a Setu state (FHIR has none; it maps to FHIR `preliminary` in the export).
- A correction (any change after "Send for verification") marks the old row `entered-in-error` with who, when and a
  reason (≥10), and creates a new row (`replacesId` = the old one) that starts again at `preliminary` and needs verify
  and validate again — and a new call-back if it is still critical.
- `amend` stays for the domain model but no lab route uses it (corrections are new rows).
- Vital signs keep their own rule (stored `final` when the server accepts the batch, slice A4).

### LAB_REPORT (DiagnosticReport version) — new machine
```
preliminary | final | corrected ──supersede──▶ superseded
```
- A version is created only by **Release** (lab technologist or pathologist; never automatic). It is an immutable
  snapshot of the tests whose every current result is `final`. Its status is computed at release:
  `corrected` when it replaces a result that an earlier version released; otherwise `preliminary` while any test that is
  not cancelled is still pending ("PRELIMINARY — n of m tests pending"); otherwise `final`. A corrected version that is
  still partial shows both labels.
- Releasing version n+1 supersedes version n in the same transaction. One report number per visit (LR/yy/nnnn per
  facility per year); versions share it.
- The ORDER machine is unchanged: `collect` when its first tube is collected, `allFinal` when a release first includes
  the test. `revoke` (cancel) only before collection, with a reason (≥10), audited; it triggers billing's order refresh.

### COMMUNICATION — new machine
```
preparation ──send──▶ in-progress ──deliver──▶ completed
                                  └──fail────▶ failed ──retry──▶ preparation   (same message id)
```
- Every message is a `Communication` row. SMS goes through the `Messenger` adapter (`apps/api/src/adapters/messaging`;
  `FakeMessenger` in dev and tests); the doctor's inbox and the patient app are in-app deliveries (completed on write).
- SMS text is a fixed template: facility name + "results ready / come back for a new sample" + how to collect. Never a
  value, a test name, a diagnosis or the patient's name.
- The doctor's inbox gets an item automatically on every release, and when a released result is put under correction.

### Critical call-back — a record, not a message
`CriticalCallback` (append-only; maps to FHIR Communication on export): the critical Observation, outcome `reached` or
`no-answer`, recipient role (ordering doctor, duty doctor, the patient when no doctor can be reached) and name, the
time of the call, how (phone, app, in person), the caller (the session user) and a read-back-confirmed tick. Only a
`reached` record with read-back confirmed, logged for that exact Observation, unblocks its validation.

### SPECIMEN
Unchanged. A tube's row is created when its label is printed (`pending`); a rejected tube is never reused — the tests
it carried need a new tube (a new row) and the patient gets the recollection SMS.

## Consequences
- `domain-model.md` is unchanged (spec input); this ADR is the record of the lab lifecycle.
- The database enforces it for every role: lab result values never change, statuses move only along RESULT,
  report versions and call-backs are append-only, a message's text and recipient never change.
- Pre-pilot (clinician): the sample reference ranges, critical thresholds and the 20% delta rule
  (`packages/domain/src/lab.ts`) are labelled "pending clinician sign-off".
- Phase 2: a real SMS gateway behind `Messenger`; sending moves to a worker after commit if the gateway is slow.

## Addendum (03/10/2026, Kamrul's decisions 119 and 133)
### RESULT gains `return` (send-back)
```
verified ──return(reason ≥10, pathologist)──▶ preliminary
```
The pathologist returns a verified test (all its current results together) to the technologist with a reason. The
verification record is cleared (who verified is kept in the audit log and Provenance), the return is recorded on each
result (who, when, why) and the technologist's worklist shows "Returned — <reason>". The test must be verified again —
by anyone allowed — before it can be validated; the same-person rule then applies to the new verifier.

### Withdraw results (no replacement value) and SPECIMEN `done → rejected`
A lab technologist or pathologist withdraws a test's results with a reason (≥10): every current result of the test is
marked entered-in-error with that reason and no new row; the tube it was measured in is rejected with the reason
`results-withdrawn` (SPECIMEN gains `done ──reject──▶ rejected`; a rejection from collected / received / in-process
was already possible), so the test needs a new tube and the patient gets the recollection SMS. Other tests on that tube
keep their results; tests on it that had none need the new tube too. If any withdrawn result had been released, the
ordering doctor's inbox gets a correction notice and every released version shows the test as "withdrawn — do not act
on it". The ORDER stays where it is (a complete order is not reopened; the lab's own state comes from its results).

### A released report that loses a value is "Corrected"
Every version released after a released result was corrected or withdrawn is `corrected` (it differs from what the
doctor already saw), whether or not other tests are still pending — replacing the narrower rule above ("when it
replaces a released result").

