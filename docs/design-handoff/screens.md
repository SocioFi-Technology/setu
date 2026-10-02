# Screen inventory

Routes: staff web = Next.js App Router under `apps/staff/app/(facility)/[facility]/…`; TV = `apps/staff/app/tv/…` (no auth, read-only projection); doctor/patient = Flutter `go_router` paths. Every staff route renders inside the single shell described in `shell-roles-plans.md` (plan tier per screen in `sitemap.md` / `screens.json.plan`). Every staff route also has the global states from the shell: **offline**, **syncing**, **session expired**, **no access (role)**, **not in plan**.

### `/[facility]/home`
- **App / module:** staff · Shell — design file `design/Setu Staff Shell.dc.html`
- **Roles:** all staff (role-specific home)
- **Device:** desktop 1440 · tablet 1024
- **Data shown:** role worklist, today counts, alerts
- **Primary actions:** open task, switch branch, ⌘K
- **Empty / error / offline / permission states:** empty day, offline, no access (plan/role), session expiring
- **Backend objects:** Practitioner, PractitionerRole, Organization, Location, Task
- **State transitions:** —

### `/[facility]/front-desk/search`
- **App / module:** staff · Front desk — design file `design/Setu Front Desk.dc.html`
- **Roles:** receptionist
- **Device:** desktop 1440
- **Data shown:** patients matched by phone/name/no/QR, family on same phone, identity confidence
- **Primary actions:** select, new patient (Alt+N), create visit (Enter)
- **Empty / error / offline / permission states:** empty, loading, no results, offline (local cache), error
- **Backend objects:** Patient, RelatedPerson, Encounter
- **State transitions:** Encounter: planned → arrived

### `/[facility]/front-desk/register`
- **App / module:** staff · Front desk — design file `design/Setu Front Desk.dc.html`
- **Roles:** receptionist
- **Device:** desktop 1440
- **Data shown:** bn/en name, DOB or approx age, phone owner, address cascade, IDs, payer, photo, live duplicate check
- **Primary actions:** save, fill from NID, link guardian
- **Empty / error / offline / permission states:** validation errors, possible duplicate, offline draft (not registered until synced)
- **Backend objects:** Patient, RelatedPerson, Identifier(NID/BRN), Coverage, Media
- **State transitions:** Patient: draft → active; identity: unverified → verified

### `/[facility]/front-desk/match/[a]/[b]`
- **App / module:** staff · Front desk — design file `design/Setu Front Desk.dc.html`
- **Roles:** receptionist, records officer
- **Device:** desktop 1440
- **Data shown:** field-by-field compare (Same/Similar/Different/Missing)
- **Primary actions:** link, keep separate, undo
- **Empty / error / offline / permission states:** blocked link (sex/age conflict), no access
- **Backend objects:** Patient (link), AuditEvent
- **State transitions:** Patient.link: none → replaced-by (reversible)

### `/[facility]/front-desk/appointments`
- **App / module:** staff · Front desk — design file `design/Setu Front Desk.dc.html`
- **Roles:** receptionist
- **Device:** desktop 1440
- **Data shown:** day/week by doctor & chamber, slot types, SMS status
- **Primary actions:** book, walk-in insert, check in, reschedule/cancel (reason)
- **Empty / error / offline / permission states:** empty day, doctor on leave, SMS failed
- **Backend objects:** Appointment, Slot, Schedule, Communication
- **State transitions:** Appointment: booked → arrived → fulfilled | cancelled | noshow

### `/[facility]/front-desk/queue`
- **App / module:** staff · Front desk — design file `design/Setu Front Desk.dc.html`
- **Roles:** receptionist
- **Device:** desktop 1440
- **Data shown:** tokens per doctor in 7 state columns, waits
- **Primary actions:** reorder (reason), call next
- **Empty / error / offline / permission states:** empty, offline
- **Backend objects:** Encounter, Task(queue), AuditEvent
- **State transitions:** Token: waiting → called → in-consult → done | skipped

### `/tv/[facility]/[room]`
- **App / module:** tv · Front desk — design file `design/Setu Front Desk.dc.html`
- **Roles:** display (no login)
- **Device:** TV 1920×1080
- **Data shown:** now serving + next 3, first name + initial
- **Primary actions:** —
- **Empty / error / offline / permission states:** offline (last update time)
- **Backend objects:** Encounter (read-only projection)
- **State transitions:** —

### `/[facility]/front-desk/vitals`
- **App / module:** staff · Front desk — design file `design/Setu Front Desk.dc.html`
- **Roles:** nurse
- **Device:** tablet 1024
- **Data shown:** BP, pulse, temp, SpO₂, weight, height, BMI (Asian cut-offs), last values
- **Primary actions:** save
- **Empty / error / offline / permission states:** out-of-range warning, impossible value block, saving, offline
- **Backend objects:** Observation (vital-signs)
- **State transitions:** Observation: preliminary → final (server confirm)

### `/[facility]/opd/consult/[encounterId]`
- **App / module:** staff · Consultation — design file `design/Setu Consultation.dc.html`
- **Roles:** doctor
- **Device:** desktop 1440 · tablet 1024
- **Data shown:** history, trends, network records (consented), note sections, orders, Rx, AI draft panel
- **Primary actions:** add dx/orders/Rx, insert AI draft, sign (Ctrl+Enter), amend, print (Ctrl+P)
- **Empty / error / offline / permission states:** draft, offline draft, signed, amended, no access, allergy block, interaction ack
- **Backend objects:** Encounter, Condition, ServiceRequest, MedicationRequest, ClinicalImpression/Composition, DocumentReference, Consent, AuditEvent, Provenance
- **State transitions:** Composition: draft → signed(final) → amended (v2, v1 superseded)

### `/[facility]/billing/opd/[invoiceId]`
- **App / module:** staff · Billing — design file `design/Setu Billing.dc.html`
- **Roles:** cashier
- **Device:** desktop 1440
- **Data shown:** charge items with source, packages, discount, VAT, totals in words
- **Primary actions:** add item (F3), discount (approval), pay
- **Empty / error / offline / permission states:** empty bill, pending approval, VAT off, no access
- **Backend objects:** Invoice, ChargeItem, ChargeItemDefinition, Task(approval)
- **State transitions:** Invoice: draft → issued → balanced | cancelled

### `/[facility]/billing/pay/[invoiceId]`
- **App / module:** staff · Billing — design file `design/Setu Billing.dc.html`
- **Roles:** cashier
- **Device:** desktop 1440
- **Data shown:** split tender, bKash/Nagad link status, change
- **Primary actions:** send link, confirm, retry
- **Empty / error / offline / permission states:** sending, waiting customer, failed, partially paid
- **Backend objects:** PaymentNotice, PaymentReconciliation, Communication
- **State transitions:** Payment: initiated → pending → confirmed | failed

### `/[facility]/billing/receipt/[id]`
- **App / module:** staff · Billing — design file `design/Setu Billing.dc.html`
- **Roles:** cashier
- **Device:** desktop 1440
- **Data shown:** 80 mm / A5 VAT invoice (Mushak-6.3), QR
- **Primary actions:** print, reprint (reason)
- **Empty / error / offline / permission states:** duplicate watermark
- **Backend objects:** Invoice, DocumentReference, AuditEvent
- **State transitions:** Print: original → duplicate #n

### `/[facility]/billing/ipd/[admissionId]`
- **App / module:** staff · Billing — design file `design/Setu Billing.dc.html`
- **Roles:** IPD billing, cashier
- **Device:** desktop 1440
- **Data shown:** running bill, package/included/excluded, payer split, deposit
- **Primary actions:** post charge, change bed class (preview), payment link, final summary
- **Empty / error / offline / permission states:** low deposit, returns pending (blocks final), corporate cap
- **Backend objects:** Account, ChargeItem, Coverage, Invoice
- **State transitions:** Account: active → final-billing → closed

### `/[facility]/billing/refunds`
- **App / module:** staff · Billing — design file `design/Setu Billing.dc.html`
- **Roles:** cashier, manager
- **Device:** desktop 1440
- **Data shown:** refundable items (performed = locked)
- **Primary actions:** request, approve/reject
- **Empty / error / offline / permission states:** pending approval, rejected
- **Backend objects:** Invoice, Task(approval), PaymentReconciliation
- **State transitions:** Refund: requested → approved → paid | rejected

### `/[facility]/billing/shift`
- **App / module:** staff · Billing — design file `design/Setu Billing.dc.html`
- **Roles:** cashier, manager
- **Device:** desktop 1440
- **Data shown:** cash count by note, digital vs settlement, variance
- **Primary actions:** close shift (reason if variance), hand over, approve
- **Empty / error / offline / permission states:** variance, not approved
- **Backend objects:** ShiftClose (custom), AuditEvent
- **State transitions:** Shift: open → counted → closed → approved

### `/[facility]/billing/approvals`
- **App / module:** staff · Billing — design file `design/Setu Billing.dc.html`
- **Roles:** manager, owner
- **Device:** desktop 1440 · Android (owner)
- **Data shown:** pending approvals with leak signals
- **Primary actions:** approve (A), reject with note (R)
- **Empty / error / offline / permission states:** empty, already actioned
- **Backend objects:** Task(approval), AuditEvent
- **State transitions:** Task: requested → accepted | rejected

### `/[facility]/billing/ledger`
- **App / module:** staff · Billing — design file `design/Setu Billing.dc.html`
- **Roles:** owner, accountant (cashier read-only)
- **Device:** desktop 1440
- **Data shown:** doctor/referrer share rules and entries
- **Primary actions:** statement print
- **Empty / error / offline / permission states:** no access (reception)
- **Backend objects:** ShareRule, ShareEntry (custom)
- **State transitions:** ShareEntry: payable → paid | reversed

### `/[facility]/ipd/admit`
- **App / module:** staff · IPD — design file `design/Setu IPD.dc.html`
- **Roles:** admission desk
- **Device:** desktop 1440
- **Data shown:** source (OPD/ER), doctor, dx, bed class, package, deposit, consents, passes
- **Primary actions:** pick bed, collect deposit, admit
- **Empty / error / offline / permission states:** checklist incomplete, no vacant bed
- **Backend objects:** Encounter(inpatient), Location(bed), Account, Consent, PaymentNotice
- **State transitions:** Encounter: planned → in-progress; Bed: vacant/reserved → occupied

### `/[facility]/ipd/beds`
- **App / module:** staff · IPD — design file `design/Setu IPD.dc.html`
- **Roles:** ward in-charge, admission desk, doctor
- **Device:** desktop 1440
- **Data shown:** 32 beds, state, MEWS, deposit, EDD
- **Primary actions:** filter, admit here, transfer, discharge, mark ready
- **Empty / error / offline / permission states:** empty ward, offline
- **Backend objects:** Location(bed), Encounter, Observation(MEWS)
- **State transitions:** Bed: vacant → reserved → occupied → discharge-pending → cleaning → vacant | blocked

### `/[facility]/ipd/transfer/[admissionId]`
- **App / module:** staff · IPD — design file `design/Setu IPD.dc.html`
- **Roles:** ward in-charge
- **Device:** desktop 1440
- **Data shown:** destination, price delta
- **Primary actions:** confirm (reason + handover)
- **Empty / error / offline / permission states:** no destination, payer cap
- **Backend objects:** Encounter.location, ChargeItem, AuditEvent
- **State transitions:** Bed: occupied → cleaning (old); vacant → occupied (new)

### `/[facility]/ipd/rounds`
- **App / module:** staff · IPD — design file `design/Setu IPD.dc.html`
- **Roles:** doctor
- **Device:** desktop 1440
- **Data shown:** patients by risk, overnight events, SOAP
- **Primary actions:** sign note, next patient
- **Empty / error / offline / permission states:** no patients, draft
- **Backend objects:** Composition(progress note), Observation
- **State transitions:** Note: draft → signed

### `/[facility]/ipd/discharge/[admissionId]`
- **App / module:** staff · IPD — design file `design/Setu IPD.dc.html`
- **Roles:** ward, doctor, pharmacy, billing
- **Device:** desktop 1440
- **Data shown:** 6-step checklist with owner and wait
- **Primary actions:** complete step, remind
- **Empty / error / offline / permission states:** blocked by step, overdue
- **Backend objects:** Task (per step), Encounter
- **State transitions:** Discharge: initiated → summary-signed → pharmacy-cleared → billed → paid → left; Bed → cleaning

### `/[facility]/ipd/summary/[admissionId]`
- **App / module:** staff · IPD — design file `design/Setu IPD.dc.html`
- **Roles:** doctor
- **Device:** desktop 1440 · A4 print
- **Data shown:** final dx, procedures, course, discharge meds, advice, follow-up
- **Primary actions:** sign, print, send to app
- **Empty / error / offline / permission states:** draft (watermark, no QR)
- **Backend objects:** Composition(discharge summary), MedicationRequest, DocumentReference
- **State transitions:** draft → signed → amended

### `/[facility]/ipd/reports`
- **App / module:** staff · IPD — design file `design/Setu IPD.dc.html`
- **Roles:** manager, owner
- **Device:** desktop 1440
- **Data shown:** occupancy, ALOS, discharges before noon, turnover
- **Primary actions:** change period
- **Empty / error / offline / permission states:** no data
- **Backend objects:** Encounter, Location (aggregates)
- **State transitions:** —

### `/[facility]/nursing/ward`
- **App / module:** staff · Nursing — design file `design/Setu Nursing.dc.html`
- **Roles:** nurse
- **Device:** tablet 1024 · desktop
- **Data shown:** bed cards with MEWS + trend, due items
- **Primary actions:** open patient
- **Empty / error / offline / permission states:** empty, offline, bright-light (HC)
- **Backend objects:** Encounter, Observation, MedicationAdministration, Task
- **State transitions:** —

### `/[facility]/nursing/vitals/[admissionId]`
- **App / module:** staff · Nursing — design file `design/Setu Nursing.dc.html`
- **Roles:** nurse
- **Device:** tablet 1024
- **Data shown:** vitals entry with MEWS points, 72 h chart
- **Primary actions:** save, inform doctor (log)
- **Empty / error / offline / permission states:** MEWS ≥5 escalation (must log contact), offline
- **Backend objects:** Observation, Communication, Flag
- **State transitions:** Escalation: raised → doctor informed (logged) → resolved

### `/[facility]/nursing/mar/[admissionId]`
- **App / module:** staff · Nursing — design file `design/Setu Nursing.dc.html`
- **Roles:** nurse
- **Device:** tablet 1024
- **Data shown:** dose grid, orders, 5 rights
- **Primary actions:** scan wristband + medicine, give / hold / refuse (reason)
- **Empty / error / offline / permission states:** missed, due, allergy conflict, scan mismatch
- **Backend objects:** MedicationRequest, MedicationAdministration
- **State transitions:** Dose: scheduled → due → given | held | refused | missed

### `/[facility]/nursing/io, /notes, /careplan`
- **App / module:** staff · Nursing — design file `design/Setu Nursing.dc.html`
- **Roles:** nurse
- **Device:** tablet 1024
- **Data shown:** intake/output totals, notes, tasks
- **Primary actions:** add, sign, tick
- **Empty / error / offline / permission states:** overdue task
- **Backend objects:** Observation(I/O), Composition, CarePlan, Task
- **State transitions:** Task: requested → completed

### `/[facility]/nursing/handover`
- **App / module:** staff · Nursing — design file `design/Setu Nursing.dc.html`
- **Roles:** nurse (outgoing + incoming)
- **Device:** tablet 1024
- **Data shown:** SBAR per patient, outstanding tasks
- **Primary actions:** mark reviewed, dual PIN sign
- **Empty / error / offline / permission states:** not all reviewed (blocks sign)
- **Backend objects:** Composition(handover), AuditEvent
- **State transitions:** Handover: draft → outgoing-signed → accepted

### `/[facility]/lab/intake`
- **App / module:** staff · Lab — design file `design/Setu Lab.dc.html`
- **Roles:** lab front desk
- **Device:** desktop 1440
- **Data shown:** orders from own doctors, network, walk-in paper Rx
- **Primary actions:** accept all/some, decline (reason), bill
- **Empty / error / offline / permission states:** unpaid (policy), network billing
- **Backend objects:** ServiceRequest, Task(network), Invoice
- **State transitions:** ServiceRequest: active → accepted | partially-accepted | declined

### `/[facility]/lab/collect`
- **App / module:** staff · Lab — design file `design/Setu Lab.dc.html`
- **Roles:** phlebotomist
- **Device:** desktop 1440
- **Data shown:** pending samples, tube guidance, labels
- **Primary actions:** collect, reject, print label
- **Empty / error / offline / permission states:** partially collected, rejected
- **Backend objects:** Specimen, ServiceRequest
- **State transitions:** Specimen: pending → collected | rejected

### `/[facility]/lab/home`
- **App / module:** staff · Lab — design file `design/Setu Lab.dc.html`
- **Roles:** lab manager, rider
- **Device:** desktop 1440
- **Data shown:** route, riders, stops
- **Primary actions:** assign, mark collected, bKash link
- **Empty / error / offline / permission states:** en route, failed visit
- **Backend objects:** Appointment(home), Specimen, PaymentNotice
- **State transitions:** Home visit: assigned → en-route → collected

### `/[facility]/lab/accession`
- **App / module:** staff · Lab — design file `design/Setu Lab.dc.html`
- **Roles:** lab technologist
- **Device:** desktop 1440
- **Data shown:** worklists by department
- **Primary actions:** receive (scan), start, reject (recollect)
- **Empty / error / offline / permission states:** empty worklist
- **Backend objects:** Specimen, Task
- **State transitions:** Specimen: received → in-process

### `/[facility]/lab/result/[srId]`
- **App / module:** staff · Lab — design file `design/Setu Lab.dc.html`
- **Roles:** lab technologist
- **Device:** desktop 1440
- **Data shown:** analytes, ref ranges (age/sex), delta, source analyser/manual
- **Primary actions:** enter (Enter/↓), save
- **Empty / error / offline / permission states:** critical, delta fail, analyser offline
- **Backend objects:** Observation, Device
- **State transitions:** Observation: registered → preliminary

### `/[facility]/lab/verify/[reportId]`
- **App / module:** staff · Lab — design file `design/Setu Lab.dc.html`
- **Roles:** technologist, pathologist
- **Device:** desktop 1440
- **Data shown:** results, critical call-back log
- **Primary actions:** verify, validate (PIN)
- **Empty / error / offline / permission states:** blocked until critical call logged
- **Backend objects:** DiagnosticReport, Communication(critical)
- **State transitions:** DiagnosticReport: preliminary → final → amended

### `/[facility]/lab/report/[reportId]`
- **App / module:** staff · Lab — design file `design/Setu Lab.dc.html`
- **Roles:** lab, doctor
- **Device:** desktop · A4 print
- **Data shown:** report bn/en/both, signatures, QR
- **Primary actions:** print, amend (reason)
- **Empty / error / offline / permission states:** PRELIMINARY watermark, amended v2 banner
- **Backend objects:** DiagnosticReport, DocumentReference
- **State transitions:** as above

### `/[facility]/lab/delivery`
- **App / module:** staff · Lab — design file `design/Setu Lab.dc.html`
- **Roles:** lab front desk
- **Device:** desktop 1440
- **Data shown:** channel status per report
- **Primary actions:** send, retry, re-send v2
- **Empty / error / offline / permission states:** not released (blocked), failed
- **Backend objects:** Communication
- **State transitions:** Communication: preparation → in-progress → completed | failed

### `/[facility]/lab/qc, /lab/dashboard`
- **App / module:** staff · Lab — design file `design/Setu Lab.dc.html`
- **Roles:** lab manager
- **Device:** desktop 1440
- **Data shown:** Levey-Jennings + Westgard; TAT, rejections, criticals
- **Primary actions:** enter QC, hold results
- **Empty / error / offline / permission states:** QC fail (holds patient results)
- **Backend objects:** Observation(QC), Device
- **State transitions:** Run: accepted | warning | rejected

### `/[facility]/pharmacy/*`
- **App / module:** staff · Pharmacy — design file `design/Setu Pharmacy.dc.html`
- **Roles:** pharmacist, store keeper
- **Device:** desktop 1440
- **Data shown:** dispense from Rx, OTC, ward indent, stock/expiry, purchase
- **Primary actions:** dispense (batch FEFO), substitute (generic), return
- **Empty / error / offline / permission states:** out of stock, expired batch, controlled drug
- **Backend objects:** MedicationDispense, Medication, SupplyRequest, SupplyDelivery, InventoryItem
- **State transitions:** Dispense: preparation → completed | declined; Indent: requested → issued

### `/[facility]/er/triage, /er/unknown, /er/orders`
- **App / module:** staff · ER — design file `design/Setu ER and OT.dc.html`
- **Roles:** ER doctor, triage nurse
- **Device:** desktop 1440
- **Data shown:** triage board by level, unknown patient reg, merge, STAT orders, disposition
- **Primary actions:** triage, assign, register unknown, merge (2 confirmers), admit/discharge/refer/death
- **Empty / error / offline / permission states:** over target, identity provisional, death checklist
- **Backend objects:** Encounter(emergency), Patient(temporary), Patient.link, ServiceRequest
- **State transitions:** Encounter: triaged → in-progress → disposition; Patient: temporary → merged

### `/[facility]/ot/calendar, /ot/safety/[caseId], /ot/intraop/[caseId]`
- **App / module:** staff · OT — design file `design/Setu ER and OT.dc.html`
- **Roles:** OT coordinator, surgeon, anaesthetist, OT nurse
- **Device:** desktop 1440
- **Data shown:** OT timeline, pre-op, WHO checklist, intra-op record, counts, CSSD
- **Primary actions:** book (clash check), sign phases, close case
- **Empty / error / offline / permission states:** blocked (fitness), count mismatch, expired set
- **Backend objects:** Appointment(OT), Procedure, Task(checklist), Observation, Device(CSSD)
- **State transitions:** Case: requested → scheduled → sign-in → time-out → sign-out → closed | cancelled

### `/[facility]/owner`
- **App / module:** staff · Owner — design file `design/Setu Owner Dashboard.dc.html`
- **Roles:** owner, manager
- **Device:** desktop 1440 · Android 412
- **Data shown:** KPIs with deltas, revenue vs collected, methods, payers, operations, leakage
- **Primary actions:** change period/branch, drill down, export
- **Empty / error / offline / permission states:** no data, offline (last refresh), no access
- **Backend objects:** aggregates over Invoice, PaymentReconciliation, Encounter, AuditEvent
- **State transitions:** —

### `/[facility]/admin/*`
- **App / module:** staff · Admin — design file `design/Setu Admin.dc.html`
- **Roles:** admin, owner
- **Device:** desktop 1440
- **Data shown:** onboarding wizard, users/roles/permission matrix, masters, print designer, audit log, plan, integrations
- **Primary actions:** save step, go live, invite, toggle permission, export audit, test integration
- **Empty / error / offline / permission states:** go-live blocked, BMDC not found (cannot sign), integration failing
- **Backend objects:** Organization, Location, HealthcareService, Practitioner(Role), ChargeItemDefinition, PlanDefinition, AuditEvent, Endpoint, Subscription
- **State transitions:** Facility: setup → live; Credential: pending → verified | not-found

### `doctor://onboard`
- **App / module:** doctor · Doctor app — design file `design/Setu Doctor App.dc.html`
- **Roles:** doctor
- **Device:** Android 360–412
- **Data shown:** phone OTP, chambers to link
- **Primary actions:** send OTP, link/unlink chamber
- **Empty / error / offline / permission states:** OTP wrong, invite pending
- **Backend objects:** Practitioner, PractitionerRole
- **State transitions:** Role: invited → active

### `doctor://home`
- **App / module:** doctor · Doctor app — design file `design/Setu Doctor App.dc.html`
- **Roles:** doctor
- **Device:** Android 412
- **Data shown:** today per chamber (colour + name), counts, urgent items
- **Primary actions:** switch chamber (switches access context)
- **Empty / error / offline / permission states:** offline (cached day), no chambers
- **Backend objects:** PractitionerRole, Schedule, Encounter
- **State transitions:** —

### `doctor://queue`
- **App / module:** doctor · Doctor app — design file `design/Setu Doctor App.dc.html`
- **Roles:** doctor
- **Device:** Android 412
- **Data shown:** current patient card (allergies, identity, flags), waiting list
- **Primary actions:** start consult
- **Empty / error / offline / permission states:** IPD-only facility (no OPD queue), empty, offline
- **Backend objects:** Encounter, AllergyIntolerance, Observation
- **State transitions:** Token: called → in-consult

### `doctor://consult/[encounterId]`
- **App / module:** doctor · Doctor app — design file `design/Setu Doctor App.dc.html`
- **Roles:** doctor
- **Device:** Android 412
- **Data shown:** complaints, dx, Rx with 4-slot dose grid, voice AI draft
- **Primary actions:** record, insert draft, sign & send
- **Empty / error / offline / permission states:** offline draft (not synced), AI draft unreviewed
- **Backend objects:** Composition, MedicationRequest, Condition, Provenance(AI)
- **State transitions:** draft → queued(offline) → signed

### `doctor://results, doctor://ipd, doctor://earnings`
- **App / module:** doctor · Doctor app — design file `design/Setu Doctor App.dc.html`
- **Roles:** doctor
- **Device:** Android 412
- **Data shown:** results by severity per chamber; admitted patients + round note; earnings by chamber
- **Primary actions:** acknowledge, comment, notify; sign round note; statement PDF
- **Empty / error / offline / permission states:** acknowledged not synced, no admitted
- **Backend objects:** DiagnosticReport, Communication, Composition, ShareEntry
- **State transitions:** Report ack: unread → acknowledged

### `patient://onboard, /claim, /family`
- **App / module:** patient · Patient app — design file `design/Setu Patient App.dc.html`
- **Roles:** patient, guardian
- **Device:** Android 360–412
- **Data shown:** language, OTP, privacy; record candidates (facility + month only); dependents
- **Primary actions:** claim with receipt code / QR / desk code; add dependent with proof
- **Empty / error / offline / permission states:** wrong code (lockout after 3), pending desk verification, dependent locked
- **Backend objects:** Patient, Person, RelatedPerson, Consent, Task(verification)
- **State transitions:** Claim: candidate → proof-pending → linked | rejected; Dependent: pending → verified

### `patient://home, /timeline, /report/[id], /rx/[id]`
- **App / module:** patient · Patient app — design file `design/Setu Patient App.dc.html`
- **Roles:** patient
- **Device:** Android 412
- **Data shown:** next appointment, latest report, doses; timeline with provenance; plain-language results + trend; pictogram Rx
- **Primary actions:** mark dose taken, filter, download PDF, reminder toggle, read aloud
- **Empty / error / offline / permission states:** slow network (light mode), offline (cached), big text
- **Backend objects:** Appointment, DiagnosticReport, Observation, MedicationRequest, Provenance
- **State transitions:** —

### `patient://share, /book, /upload`
- **App / module:** patient · Patient app — design file `design/Setu Patient App.dc.html`
- **Roles:** patient
- **Device:** Android 412
- **Data shown:** share selection/recipient/period, active shares, access log; doctor/slot/pay; photo upload
- **Primary actions:** share, revoke (confirm), book, pay bKash/Nagad, upload
- **Empty / error / offline / permission states:** offline (blocked), payment failed, upload queued
- **Backend objects:** Consent, AuditEvent, Appointment, PaymentNotice, DocumentReference(patient-supplied)
- **State transitions:** Consent: active → revoked | expired; Payment: pending → confirmed | failed; Upload: queued → uploaded (unverified)

### `/network/orders/[id]`
- **App / module:** staff + patient · Connected care — design file `design/Setu Connected Care.dc.html`
- **Roles:** ordering doctor, patient, diagnostic centre
- **Device:** desktop · Android
- **Data shown:** portable order tracker visible to authorised parties only
- **Primary actions:** choose centre, accept some, re-order, collect, release, acknowledge
- **Empty / error / offline / permission states:** centre sees nothing before chosen, partial decline
- **Backend objects:** ServiceRequest, Task(fulfilment), Consent, DiagnosticReport
- **State transitions:** Order: ordered → centre-chosen → accepted(partial) → collected → released → received

### `/network/referrals/[id]`
- **App / module:** staff + patient · Connected care — design file `design/Setu Connected Care.dc.html`
- **Roles:** referring doctor, receiving facility, patient
- **Device:** desktop · Android
- **Data shown:** referral summary (selected), slots, consultation note
- **Primary actions:** send (consent), accept + schedule, sign note back, acknowledge
- **Empty / error / offline / permission states:** needs info, returned
- **Backend objects:** ServiceRequest(referral), Task, Appointment, Composition, Consent
- **State transitions:** Referral: draft → sent → scheduled → seen → note-returned → acknowledged

### `/[facility]/patients/[id]/network`
- **App / module:** staff · Connected care — design file `design/Setu Connected Care.dc.html`
- **Roles:** doctor at another facility
- **Device:** desktop 1440
- **Data shown:** external records by policy/consent with source, author, date, badge
- **Primary actions:** request access (scope, period, reason)
- **Empty / error / offline / permission states:** policy-only, pending, consented, patient opted out, sensitive never hinted
- **Backend objects:** Consent, Provenance, AuditEvent, all clinical resources
- **State transitions:** Access request: sent → granted | denied; Consent expires automatically

### `/[facility]/break-glass/[patientId]`
- **App / module:** staff · Connected care — design file `design/Setu Connected Care.dc.html`
- **Roles:** ER doctor, ICU consultant; privacy officer
- **Device:** desktop 1440
- **Data shown:** denied state → form → active banner + countdown → ended; review queue
- **Primary actions:** request (reason ≥20 chars, ack, PIN), end early, review justified/investigate
- **Empty / error / offline / permission states:** expired automatically at 60 min
- **Backend objects:** Consent(emergency override), AuditEvent, Communication(patient SMS), Task(review)
- **State transitions:** BreakGlass: requested → active → ended → reviewed(justified | investigating)
