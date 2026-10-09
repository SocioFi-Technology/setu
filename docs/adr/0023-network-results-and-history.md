# ADR 0023 — Results back across facilities (E3) and another clinic's view of a patient's history (E4)

Status: accepted (Kamrul, 10/10/2026 — "go" on the E3–E4 plan with its five recommendations, below).

## Context
Journey E3 (prototype `Setu Connected Care.dc.html` 88, 93, 99–114): the patient pays the centre (bKash, Nagad or at
the centre; home collection adds the fee), the centre collects and a pathologist releases, the result reaches the
ordering doctor's inbox, the patient app and SMS, the doctor acknowledges and the patient is told; the tracker reads
Ordered → Centre chosen → Accepted n/N → Collected → Released → Received.
Journey E4 (137–156): a doctor at another clinic sees, for a linked patient, by policy (without asking) allergies,
current medicines, active problems and blood group — each with source facility, author, date and badge; never the
sensitive categories (mental health, reproductive and sexual health, HIV), not even a hint; more only by the patient's
consent (scope, period, a reason of 10+ characters the patient sees; approve, deny, revoke); the patient's "network
sharing" off hides everything external.
In place after E1–E2 (ADR 0022): the portable order to the centre's decision; the accepted tests as the centre's own
orders; the consent-checked read service, Consent and "who viewed" (ADR 0021); bKash links (ADR 0011).

## Kamrul's decisions (10/10/2026)
1. **Payment:** bKash link and "pay at the centre" now; Nagad when its adapter is built (credentials before production).
2. **Sensitive categories:** a sample tagging list (ICD-11 codes), marked sample, on the clinician pre-pilot list
   (gap 12); never shared in this slice, not even by consent.
3. **The centre's record is linked to the same person automatically** — the order proves it.
4. **Blood group:** a field on the patient record (source and date), shown by policy.
5. **Current medicines:** prescriptions from signed notes still within their days, and active inpatient orders, from
   the other linked facilities.

## Decisions — E3
- **Payment stays in the existing money path:** the centre's cashier bills its network-order visit and sends the bKash
  link (ADR 0011) or takes payment at the counter — every taka inside a cashier's shift (ADR 0008). The patient app
  shows the bill (total, paid) and opens the live bKash link the centre sent ("Pay with bKash"); otherwise "pay at the
  centre". A payment started by the patient alone (no cashier) is not built: it would sit outside every shift.
- **The centre's visit is lab only:** on acceptance the visit is started and finished (ENCOUNTER), so the bill can be
  made; its bill has no consultation line, the tests at the centre's prices, and the home collection fee (fixed on the
  order at the choice, `PortableOrder.homeFeePaisa`) as a line.
- **The centre's record is the same person's:** on acceptance a linked claim (method `network-order`) is made at the
  centre for the person who chose, or the one person linked to the ordering record (`person_of_record()`, SECURITY
  DEFINER); one record per facility as for any claim. The centre's report then is in the patient's history and can be
  shared (ADR 0021).
- **Progress on the order, set once and in order** (the order guard): `collectedAt` (a tube of the accepted tests
  collected), `releasedAt` + `resultReportId` (the current version; a correction moves the id), `receivedAt` (the
  ordering doctor's acknowledgement). Recorded after each lab write at a network-order visit commits.
- **The result reaches the ordering facility** (as its system actor, after the centre's release commits): the ordering
  doctor's inbox (`portable-result`, naming the order and the centre) and the patient app. The centre's own lab
  delivery (SMS "report ready", the app notice) is unchanged.
- **The ordering doctor reads the centre's report through the order** (`GET /v1/portable-orders/:id/report`): only the
  report the order names, read in the centre's tenant, audited there (basis `portable-order`, the reader's names) and at
  the ordering facility. Acknowledging the inbox item marks the order received and tells the patient (app).

## Decisions — E4
- **Only a linked patient:** this clinic's record must be linked to a Person (a claim — the app code, or the network
  order; `person_of_record()`). Otherwise the panel says "not linked to Setu" — never a match by name or phone.
- **By policy** (no request; never when `Person.networkSharing` is off — read through the SECURITY DEFINER
  `person_network_sharing()`): from every *other* linked facility, each read inside that facility's tenant —
  active allergies, current medicines (decision 5: an outpatient line within its days from the signing, an active
  inpatient order; newest per medicine), active problems (diagnoses of signed notes of the last 180 days — no
  "resolved" flag exists yet; newest per code), blood group (decision 4) — each row with facility, author, date and the
  provider-verified badge. **Doctors only** (screen net/consent; an owner or admin is refused `doctors_only`).
- **Sensitive, never hinted:** a visit any of whose notes carries a sensitive condition (the sample ICD-11 prefixes,
  `@setu/domain` `history.ts`) or a medicine of a sensitive class is left out whole — its problems, medicines,
  allergies, records and trend points — before anything is counted. The sample catalogue (gap 12) has no such code
  yet; the API test writes one as a facility whose list has it would.
- **Audit:** each read by policy is an AuditEvent in the owner facility (basis `network-policy`, the reader's names,
  the counts) and in the reader's; the patient's "who viewed" lists it as a look by another facility.
- **By consent:** "Request access" (`AccessRequest`, network level: the requesting tenant makes and reads its own, the
  person reads and answers theirs — RLS) — kinds (lab reports, discharge summaries, prescriptions, visits), period
  (today's visit = 24 h, or 30 days), a reason of 10+ characters the patient sees; one waiting request per doctor and
  patient. The patient app lists it and an SMS of a fixed template (the facility's name only) tells them. The patient
  answers once (a database guard: sent → granted | denied | expired; nothing else changes); unanswered for 7 days it
  expires. **Approve** makes a Consent (basis `patient-request`, `requestId`, scope "all" with `kinds` = the item
  kinds asked) to the requesting doctor by name; it is then read through the same consent-checked service (ADR 0021):
  `shareCovers` refuses another kind, and with `hideSensitive` an item of a sensitive visit answers "not shared"
  (out-of-scope — no hint). The patient stops it from the shares list like any share.
- **The patient's own shares (D5) are unchanged:** what the patient chose to share themselves is shown as shared; the
  sensitive filter applies to what another clinic asks for or sees without asking.
- **Blood group** is recorded on the record by a doctor, nurse or lab technologist (`POST
  /v1/patients/:id/blood-group`; who and when; a database check allows the eight groups only).
- **Network sharing** is the patient app's switch (Shares → Requests): off = nothing by policy; requests still reach
  the patient.
- Break-glass stays a follow-up (designed in the consent model).

## Consequences
- The order now carries its progress; the lab's post-commit step touches only network-order visits.
- Follow-ups: Nagad; a patient-started payment with its own reconciliation; a pushed (not only in-app) notice; the
  clinician's sensitive-category rules (gap 12) and the codes in the catalogue; a "resolved" problem status; the
  requesting doctor told in the inbox when the patient answers; break-glass screens.
