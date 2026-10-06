# ADR 0016 — Scan-to-verify, intake/output, care tasks and the shift handover (slice B5–B6)

Status: accepted (Kamrul, 06/10/2026 — the ten plan defaults, with changes to 5 and 10)

## Context
Walkthrough B5 ("due dose, two scans, Given; Held needs reason") and B6 (escalation) were mostly built in slice B3–B4
(ADR 0015). What remains of the nursing module: the wristband and medicine scans that unlock "Given", the intake/output
chart and the care plan (`nur/io`), and the shift handover (`nur/handover`, screens.md: SBAR per patient, mark reviewed,
dual PIN; Handover: draft → outgoing-signed → accepted).

## Decisions
### Scan-to-verify (the MAR)
- **The wristband** is printed at admission and can be reprinted from the ward (a reprint needs a reason; audited). Its
  QR carries `SETU-WB1.<admissionId>.<facilityNo>.<signature>` — an HMAC over the admission id and facility number with
  a server secret: nothing else about the patient, and a forged band never verifies.
- **The medicine label** is a QR per ward batch, `SETU-MB1.<batchId>`, printed when the pharmacist issues an indent (no
  manufacturer barcode master list yet).
- **Given** stays locked until the band matches this admission and the medicine label is a batch of the order's
  medicine on this patient's ward, not expired. The two scans tick "right patient" and "right drug"; the nurse ticks the
  other three. A mismatch is refused, shown as "scan mismatch" and audited.
- **The patient's own supply:** the wristband only. **Held, refused, missed:** no scans.
- **Override** ("scanner not working") with a reason of at least 10 characters, flagged on the record and in the audit —
  **never for a high-alert or controlled drug** (both scans, no override). Override counts per nurse are on the owner's
  exceptions list (leakage kind `scanOverride`, drill by nurse). No limit per shift for now.
- Scanners: keyboard-wedge (USB / Bluetooth) and the browser's camera BarcodeDetector where the tablet has it; no new
  dependency. The database refuses a given dose without both scans or an override reason, and an override on a
  high-alert or controlled drug.

### Intake / output
- Append-only entries: intake (oral, IV, NG, other) and output (urine, drain, vomit, stool, NG aspirate, other) in mL
  (1–5000), with device time; offline through the outbox like vitals; a wrong entry is marked entered-in-error with a
  reason by its writer. IV fluids given on the MAR are not added automatically (no double counting).
- Totals per **shift day** (08:00 to 08:00 Dhaka, a facility setting, sample) and the fluid balance; the 24-hour
  balance shows on the ward card and the doctor's round.

### Care plan tasks
- A nurse or a doctor writes a task: once at a time, or every N hours (1–24). Only a nurse ticks it. CARE_TASK:
  requested → completed | cancelled. Completing a recurring task creates the next one, due N hours after it was done.
  Overdue tasks (past due by more than 30 minutes, sample) are flagged on the ward board. A cancel needs a reason.

### Shift handover
- One handover per ward per shift; shifts start 08:00, 14:00, 20:00 Dhaka (facility setting, sample). The sheet lists
  **every patient on the ward** with their latest NEWS2, open escalations and due doses, pre-filled SBAR (the outgoing
  nurse edits S / B / A / R), I/O balance and open tasks.
- HANDOVER: draft → outgoing-signed → accepted; `query` (outgoing-signed → draft, with a note). The outgoing nurse marks
  every patient reviewed, then signs with the PIN (blocked until all are reviewed); a different nurse accepts with her
  PIN. **It cannot be accepted while an unacknowledged escalation exists on the ward unless the acceptance note names
  it** (the bed or the patient number). Accepted is final; the incoming nurse then owns the ward's tasks and alerts.
- Applied to every unacknowledged NEWS2 escalation, the same set as escalation reach (ADR 0015 amendment 2).

## Consequences
- New tables IntakeOutputEntry, CareTask, Handover, HandoverPatient; MedicationAdministration gains scanBand, scanMed,
  scanOverrideReason; Organization gains shiftStartHours and ioDayStartHour; machines CARE_TASK and HANDOVER.
- The owner dashboard's leakage list gains `scanOverride`.
- Pre-pilot for a clinician: shift times, the I/O day start, the overdue grace for tasks.

## Amendment — Kamrul, 06/10/2026
The acceptance rule covers **every open escalation on the ward** (raised, doctor-informed or acknowledged; however recent),
not only unacknowledged ones: the sheet lists them (`openEscalations`, each marked unacknowledged or not) and the
acceptance note names each by bed or patient number as a whole word, or acceptance is refused (`escalation_not_named`).
A clinician may relax this later, never tighten it.


## Amendment 2 — Kamrul, 06/10/2026: scan codes are digits only
A keyboard-wedge scanner types keystrokes. Under a Bangla layout (Avro, Bijoy) letters arrive mangled while digits arrive
as Bangla digits, which the scan field turns back into Latin digits (decision 253). So every code we print is digits
only, after a two-digit prefix that says what it is; this replaces the lettered `SETU-WB1` / `SETU-MB1` payloads above.
- **Wristband:** `91` + the print's 10-digit serial (per-tenant sequence `wristband`, stored on `WristbandPrint.serial`)
  + an 8-digit signature (HMAC-SHA256 of tenant and serial with `WRISTBAND_SECRET`, reduced to decimal). The serial finds
  the print; it verifies only if it is this admission's latest print for this patient (a reprint still retires earlier
  bands). Eight digits (10⁸) is enough for a bedside identity check made by a signed-in nurse: a forger must also hit a
  real serial of the right admission, and every scan is recorded. Bands printed before this change no longer verify —
  reprint them (none exist outside test data).
- **Medicine label:** `92` + the label's 10-digit serial (sequence `batch-label`, table `BatchLabel`, one per ward
  batch, append-only, made at the indent issue or when the ward first prints it) + two ISO 7064 mod 97-10 check digits,
  which catch a misread. Printing labels is now `POST /v1/nursing/labels { batchIds }`, since it may create a label.
- **The dose dialog:** the band field has the cursor when the dialog opens; after a band scan the cursor moves to the
  medicine field, so a nurse scans band then medicine with no tap between.
