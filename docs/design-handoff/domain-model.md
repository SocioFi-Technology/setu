# Domain model & state machines

Resource names follow HL7 FHIR R4 where one fits, so the backend can expose FHIR later (the Admin › Integrations screen shows a daily FHIR export). Custom objects are marked *(custom)*. All IDs are opaque; human numbers (GLC-240117, INV/25/0938, A-017) are separate display identifiers and always render in Latin digits.

## Cross-cutting rules (enforce server-side, show in UI)
1. **Server confirmation.** A write is `pending` locally until the server acknowledges it. The UI never shows Signed / Sent / Paid / Saved for a pending write — it shows "Not yet synced" (status token `--status-offline-*`).
2. **Provenance on every clinical item.** Store a `Provenance` with `agent` (who), `onBehalfOf` (organisation), `recorded` (when) and `source` ∈ `provider-verified | patient-uploaded | patient-reported | ai-draft`. AI drafts can never be `final`; inserting AI text into a note keeps an `ai-draft` provenance on that section until the clinician ticks "I reviewed" and signs.
3. **Amend, never overwrite.** Signed/final documents get a new version; the previous version is kept with status `superseded` / `entered-in-error` and is visible in history.
4. **Permissions are data.** Each read of another facility's data evaluates `Consent` (patient grant, referral, policy or emergency). A denied read returns a typed `403` with `reason` and `canRequest`, which the UI renders as the Permission-denied panel.
5. **Audit everything that reveals PHI.** Writes an `AuditEvent` (who, what, patient, device, IP, basis). Patients can list AuditEvents about themselves.
6. **Identity confidence** on Patient: `verified | unverified | possible-duplicate | provisional` + method (NID, birth reg., receipt code, desk).

## Core objects
| Object | Key fields | Used by |
|---|---|---|
| Patient | id, identifiers[] (facility no, Setu ID, NID, BRN), name {bn, en}, birthDate or approxAge, sex, telecom[] {value, owner}, address {division, district, upazila, line}, photo, identityConfidence, link[] | all |
| RelatedPerson | patient, relationship, guardianProof, verified | registration, family |
| Practitioner / PractitionerRole | BMDC/BNMC no + verification, roles per facility/branch, chambers, schedule | shell, admin, doctor app |
| Organization / Location | facility, branch, department, ward, room, bed (+ class, state) | all |
| Encounter | class (OPD, IPD, ER, home), status, token, practitioner, location history, account | front desk, consult, IPD, ER |
| Appointment / Slot / Schedule | type (new, follow-up, report, OT, home collection), status, SMS status | front desk, patient app, OT |
| Observation | vitals, MEWS, lab analytes, I/O, QC; refRange; interpretation (N, H, L, HH, LL); device/manual | nursing, lab, consult |
| Condition | ICD-11 code, bn/en label, verificationStatus provisional/confirmed | consult, IPD |
| AllergyIntolerance | substance, reaction, criticality, provenance | header everywhere |
| Composition | consultation note, progress note, discharge summary, handover, referral note; sections with provenance; version | consult, IPD, nursing, network |
| ServiceRequest | lab, imaging, procedure, referral; priority; performer (in-house or network facility); consent | consult, lab, network |
| Specimen | tube, barcode, collected at/by, rejection reason | lab |
| DiagnosticReport | results[], status, validator, version, delivery[] | lab, apps |
| MedicationRequest | brand + generic, dose pattern {m, n, e, bed}, meal (before/after/with), days, qty | consult, pharmacy, MAR |
| MedicationAdministration | dose, status given/held/refused/missed, reason, scans | nursing |
| MedicationDispense / SupplyRequest / InventoryItem | batch, expiry, FEFO | pharmacy |
| ChargeItem / ChargeItemDefinition | price by bed class, VAT rate, package membership, source | billing, admin |
| Invoice / Account | lines, discounts (approval), VAT, totals, payer split | billing |
| PaymentNotice / PaymentReconciliation | method (cash, card, bKash, Nagad, bank), gateway ref, status | billing, patient app |
| Task | approvals, discharge steps, checklist phases, network fulfilment, verification | many |
| Consent | grantor, grantee (practitioner/organisation), scope (categories/resources), basis (patient, referral, policy, emergency), period, status | network, patient app, admin |
| Communication | SMS/WhatsApp/app/inbox deliveries, critical-value call-backs | lab, billing, front desk |
| AuditEvent | agent, action (view, create, sign, print, reprint, break-glass), entity, patient, device, basis | admin audit, patient "who viewed" |
| ShiftClose *(custom)* | cashier, counter, expected, counted by denomination, digital vs settlement, variance, reason, approver | billing, owner |
| ShareRule / ShareEntry *(custom)* | doctor/referrer share %, entries payable/paid/reversed | billing ledger, doctor earnings |
| BreakGlass *(custom, maps to Consent + AuditEvent)* | reason category, text (≥20), acknowledged, startedAt, expiresAt (60 min), endedAt, review | network |

## State machines
```
Clinical document (Composition, DiagnosticReport, discharge summary, Rx)
  draft ──sign(PIN, server ack)──▶ final/signed ──amend(reason)──▶ amended (v2)   ; v1 → superseded
  draft ──offline sign──▶ queued (shows "Not yet synced", not final)

Order (ServiceRequest, incl. network)
  draft → active(ordered) → [network: centre-chosen] → accepted | partially-accepted | declined(reason)
        → in-progress (specimen collected) → partially-complete (some results final) → complete
        → revoked (cancelled by doctor)       ; declined items can be re-ordered elsewhere

Specimen    pending → collected → received → in-process → done | rejected(reason → recollect)
Result      registered → preliminary → final → amended ; critical → call-back logged before final
Invoice     draft → issued → partially-paid → balanced | cancelled(approval)
Payment     initiated → link-sent → waiting-customer → confirmed | failed(retry)
Approval    requested → approved | rejected(note)          ; nothing is applied before approved
Encounter   planned → arrived → triaged → in-progress → finished | cancelled | entered-in-error
Bed         vacant → reserved → occupied → discharge-pending → cleaning → vacant ; blocked(reason)
Discharge   initiated → summary-signed → pharmacy-cleared → final-bill → paid → left (bed → cleaning)
MAR dose    scheduled → due → given | held(reason) | refused(reason) | missed(reason)
Escalation  raised(MEWS≥5) → doctor-informed(logged: who, when, instruction) → resolved
Consent     proposed → active → revoked | expired      ; emergency: active ≤60 min → ended → reviewed
Claim       candidate → proof-pending(code | QR | desk) → linked | not-mine ; 3 wrong codes → locked 24 h
Referral    draft → sent → accepted/scheduled → seen → note-returned → acknowledged | returned
OT case     requested → scheduled → sign-in → time-out → sign-out → closed | cancelled
Shift       open → counted → closed(variance reason) → approved | recount
Sync        local → pending → confirmed | conflict(user resolves) | failed-retry
```

## API shape (suggested)
REST + typed errors, or tRPC for the staff app. Mobile apps use the same REST API with an offline outbox (Drift/SQLite on Flutter). Every mutation accepts an `Idempotency-Key` so offline retries never double-post a payment or a dose.
