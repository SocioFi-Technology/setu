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

## Decisions — E4 (built next)
- **Only a linked patient:** this clinic's record must be linked to a Person (a claim — the app code, or the network
  order). Otherwise the network panel says "not linked to Setu" — never a match by name or phone.
- **By policy** (no request; never when `Person.networkSharing` is off): from every *other* linked facility — active
  allergies, current medicines (decision 5), active problems (conditions of signed notes, not resolved), blood group
  (decision 4) — each row with facility, author, date and the provider-verified badge. **Sensitive** rows (the sample
  ICD-11 list, `@setu/domain` `sensitive.ts`) are dropped before anything is counted or returned.
- **By consent:** "Request access" — scope (lab reports, discharge summaries, prescriptions, visits), period (today's
  visit = 24 h, or 30 days), reason ≥ 10 characters → the patient app and an SMS (fixed template); the patient approves
  (a Consent, ADR 0021, granted to the requesting doctor, scope "all" limited to the requested kinds, sensitive never) or
  denies; every read through the read service, audited, in "who viewed".
- **Network sharing off** (patient app setting): nothing by policy; requests still reach the patient.
- Break-glass stays a follow-up (designed in the consent model).

## Consequences
- The order now carries its progress; the lab's post-commit step touches only network-order visits.
- Follow-ups: Nagad; a patient-started payment with its own reconciliation; a pushed (not only in-app) notice; the
  clinician's sensitive-category rules (gap 12); break-glass screens.
