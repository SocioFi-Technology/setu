# ADR 0020 — The patient app's person, claiming records, and the timeline (slice D1–D3)

Status: accepted (Kamrul, 09/10/2026 — Phase 4 plan, "go with the recommendations": phone + OTP person, records only by
a proven claim; consent as a network-level row and a consent-checked read service (E); a network centre is another
Setu tenant; build with the prototype's privacy wording marked draft until the lawyer's terms; guardians later).

## Context
Journey D gives a patient their own records from every Setu facility. Records live per tenant behind row-level security
(decision 21: one patient record per tenant, never shared by default). Nothing patient-facing existed: the patient app was
an empty page, patients had no sign-in, and the `patient_app` messages lab reports and discharge summaries write were
never read. The domain model already has `Claim` (candidate → proof-pending → linked | not-mine; 3 wrong codes → locked
24 h, `CLAIM` in machines.ts) and identity confidence with a method (receipt code is one).

## Decisions
### The Person — who signed in, above the tenants
- `Person` is a **network-level** row (no `tenantId` — the one deliberate exception to "tenant_id on every table", like
  the gateway token): id, phone (`01XXXXXXXXX` → stored as the 10 digits, as Patient.phone), language, network sharing
  on/off (Journey E), session generation, created / last sign-in. Its row-level security keys on `app.person_id`
  (`forPerson()` in @setu/db), so a patient's queries see their own Person row and nothing else.
- **Sign-in is phone + a one-time SMS code** (6 digits, 5 minutes, 5 wrong tries end it; 3 sends per phone per 15 minutes
  and 10 per IP per hour). The code is kept in Redis (the counters store — internal only) and sent through the SMS
  adapter with a fixed template that says never to share it. The first sign-in creates the Person (`person_upsert`,
  SECURITY DEFINER). The answer to "send a code" never says whether the number is known.
- **The OTP proves the phone, not the person**: families share phones (5 people on 01711-234567 in the demo clinic), so a
  signed-in Person sees **nothing** of any record until a claim is proven.
- A **separate cookie** (`setu_patient`) and session: patient routes (`/v1/patient/*`) never accept a staff session and
  staff routes never a patient one. Sign-out everywhere = the generation bump, as for staff (ADR 0010).

### Claiming — per facility, proven by the code on a paper the patient holds
- A **candidate is a tenant** that has patient records on the Person's phone (`person_candidates`, SECURITY DEFINER),
  shown with **minimal disclosure**: the facility's name and the month of the last visit there — never a name, a test,
  or how many people share the number. One candidate per tenant, not per record, because a shared phone would otherwise
  list the same "Green Life · Aug 2026" line five times.
- `PatientClaim` lives **in the facility's tenant** (tenant RLS as usual, so the facility sees who claimed what): person,
  status (CLAIM machine), method (code | qr | desk), tries, locked-until, the linked patient once linked.
- **Proof by code:** every Patient gets a 6-character **claim code** (`Patient.claimCode`, unique per tenant; an alphabet
  without 0/O/1/I/L), printed on the receipt and the prescription ("Setu app code"). The code the patient types is
  compared (constant time) with the codes of that tenant's patients on the same phone; the one that matches is linked.
  A wrong code counts; the third locks the claim for 24 hours (`CLAIM_MAX_TRIES`, `CLAIM_LOCK_HOURS`); every attempt is
  audited in that tenant. A QR carrying the same code is accepted by the API (printing it on the papers is a follow-up;
  today's QR is the verify link, so the app offers code and desk). **Desk** proof puts the claim in proof-pending (desk)
  for the front desk to confirm (the desk screen: a follow-up).
- **Linking** records the method on the patient's identity (method `receipt-code`) with a Provenance row; it never
  changes the facility's own identity-confidence decisions. "Not mine" closes the candidate and is audited (the clinic is
  informed by the audit row).
- A Person may link one record per tenant now; a guardian linking a child's record is a later slice.

### The timeline — read only through linked claims, inside each tenant
- `person_claims` (SECURITY DEFINER) lists the Person's claims across tenants (ids and status only). For each **linked**
  claim the API reads that tenant's records with `forTenant(tenant)` — row-level security per tenant is unchanged — and
  only the linked patient's: finished visits and admissions, signed prescriptions (current versions), released lab
  reports, signed discharge summaries. Each item carries its facility, date and source badge (provider-verified;
  patient-uploaded / patient-reported when uploads arrive). Filters: all, reports, prescriptions, visits, mine.
- **Every read is audited** in the facility's tenant (`view`, actor `person:<id>` in the detail, basis `patient`), so a
  facility's audit log shows the patient reading their own record.
- Writes by a Person go through `personCommand()` — the same idempotency contract as staff writes, keyed by the person
  (`PersonIdempotency`, network-level, person RLS) — so a replayed code attempt never counts twice.

### The app
A Next.js PWA in `apps/patient` (installable on Android; Flutter remains a phase 5 question), 390–412 px first, Bangla
first with English, reads cached offline (sending a code, verifying and sharing need the network and say so). The privacy
points and terms are the prototype's wording, **marked draft until the lawyer's terms** (pilot-readiness plan).

## Consequences
- Two new SECURITY DEFINER reads (candidates by phone; a person's claims) — each returns ids, facility names and months
  only. The audit and a security review cover them like `auth_login_lookup`.
- Every patient now carries a claim code; receipts and prescriptions print it.
- Journey E reuses the Person (network sharing, consent grantor) and adds the consent-checked cross-tenant read.
- Follow-ups: the desk-proof confirm screen; guardians / dependants; uploads ("mine"); lawyer's terms; identity beyond
  phone + receipt code (open decision).
