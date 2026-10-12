# ADR 0024 — Proof at the reception desk, and the claim QR

Status: accepted (Kamrul, 12/10/2026 — "go" on the plan).

## Context
ADR 0020 let a patient prove a facility's records in the app with the code printed on the receipt or prescription, or
choose "verify at the reception" — which only put the claim in proof-pending (desk) with no screen to finish it. The
app's QR option was not usable: the papers' QR is the document's verify link, and the API read any 6-character tail of
a scanned text as a claim code, so scanning the wrong QR could cost one of the three tries. The prototype (Setu Patient
App, claim) has the three methods — receipt code, QR scan, reception — and, for the desk, "show this code and your NID /
birth registration at the reception".

## Decisions
- **A desk code proves the app is at the counter.** Choosing the desk makes a 6-character desk code (the claim-code
  alphabet), valid 7 days; only its hash (bound to the facility) is stored — the app shows it from the answer and keeps
  it on that phone; "New code" replaces it. A claim locked by wrong codes may still go to the desk (in person is the
  stronger proof).
- **"Link Setu app" at the reception** (receptionist, admin, owner — the front desk's Find patient screen, a dialog;
  no new screen): the receptionist types the code (POST, never in a URL), sees the app's phone masked and **only this
  facility's records on that phone** (name, number, age, last visit — never a search), checks the NID or birth
  registration (the document type is recorded, its number is not), picks the record and links it — or "Could not
  verify". Wrong codes are limited per receptionist (10 per 10 minutes). The person's phone is read through
  `desk_claim_phone()` (SECURITY DEFINER, only for a claim of the caller's tenant waiting for the desk).
- **CLAIM machine:** proof-pending gains `deskOk` → linked and `deskRefused` → candidate (the patient chooses again;
  the app says the reception could not verify). Linking by the desk writes a Provenance row (agent: the receptionist,
  on behalf of the person, source desk-decision) and the audit; the facility's own identity-confidence decisions are
  untouched, as for the code.
- **The claim QR:** printed beside the Setu app code on receipts and prescriptions (not on a copy shared with another
  doctor), labelled for the app: `<patient app>/claim?t=<facility>&c=<code>` (`PATIENT_APP_URL`, by default the public
  origin's `/patient`). The app reads it with the phone's own barcode reader (`BarcodeDetector`, Chrome on Android — no
  library), or the phone's camera opens the link (kept through a sign-in). **Only this QR is read**: a verify QR or any
  other text is refused before a try is counted; the facility in the QR picks the claim
  (`POST /v1/patient/claims/qr`).

## Consequences
- `PatientClaim` gains the desk code hash and expiry, the document checked, who and when, and the refusal time.
- Follow-ups: dependants (a guardian's desk proof); a person whose phone changed (the desk cannot offer a record on
  another number — the facility updates the phone first).
