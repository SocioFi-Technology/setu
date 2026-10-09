# ADR 0021 — The patient's report, sharing with a doctor, revoking, and who viewed (slice D4–D6)

Status: accepted (Kamrul, 09/10/2026 — the D4–D6 plan with four decisions, below).

## Context
D1–D3 (ADR 0020) gave a signed-in Person their linked records as a history list that could not be opened. The facilities
already write `patient_app` notices when a lab report is released or a discharge summary signed; nothing read them.
The CONSENT machine existed (`machines.ts`), no Consent table. Journey D4–D6 (prototype `Setu Patient App.dc.html`
152–178, walkthrough round 2: pass): open a report in plain language with its original PDF; share records with a
doctor for a while; stop sharing; see who looked.

## Kamrul's decisions (09/10/2026)
1. **Who receives a share:** a doctor or a facility from a **directory of Setu facilities that opted in to the
   network** and their doctors — names only. Every share is **time-limited (default 30 days)**, the patient can revoke
   it any time, it is **scoped to what the patient picked — one visit, one report, or "all"** — and the patient sees
   **who opened it and when**. No external share links in this slice.
2. **Plain-language wording:** drafts from the lab catalogue, marked "draft" in the app and on the clinician pre-pilot
   list (gap 12). **Never shown for a critical result until a clinician signs the wording off**: a critical result
   shows only the value, the flag and "contact your doctor / the facility now" with the facility's phone.
3. **Who viewed:** the name, role and facility for staff reads; the patient's own reads left out. **Break-glass reads
   are shown with that label** — the patient must be able to see them.
4. **The patient app on staging**, the dev sign-in code route only under `SETU_STAGE=staging` with the fake SMS, and a
   visible **"STAGING — test data"** banner in the staging patient app.

## Decisions
### D4 — opening a report
- `GET /v1/patient/reports/:claimId/:reportId` reads one **current, released** DiagnosticReport of the claim's linked
  patient inside that facility's tenant (`forTenant`; a superseded version answers with the current one's id). Per
  result: test and analyte name, value, unit, the range **stored on the result** (never re-flagged), the flag
  (L / H / LL / HH from the stored critical limits), corrected or withdrawn. Audited `view` in the facility (basis
  `patient`, actor `person:<id>`).
- **Explanations** (`@setu/domain` `labPlain`): per analyte a short "what it measures", per unit a plain name, per
  direction (low / high) one sentence — **drafts** (`sample: true`, the app shows "Draft — a clinician will review
  this wording"). For a **critical** result (LL / HH) the domain returns no explanation at all; the app shows the
  value, the flag and "Contact your doctor or the facility now" with the facility's phone
  (`Organization.phone`, new; the admin sets it). A clinician's sign-off later is a flag per analyte, not a code change.
- **Range bar:** the domain places the value against the stored range (`rangePosition`, clamped, "no range" says so).
- **Trend:** the same analyte's earlier current results from **every linked facility** (validated / corrected, not
  entered-in-error), newest 6, each point with its date and facility. Drawn as inline SVG (no chart dependency).
- "This is not a diagnosis — talk to your doctor about these results." on every report.
- **Original PDF:** the facility's own report template, marked **"Patient copy — from the Setu app"**, with the
  document's real verify QR (the DocumentCode is issued if the facility never printed it). It is **not** a facility
  print copy (no DocumentPrint row, the copy count unchanged), and is audited `print` with basis `patient`. A blocked
  document (superseded, withdrawn) is refused as for staff. Prescriptions and discharge summaries in the history open
  the same way (PDF only — their own screens are later slices).
- **Notices:** the facility's `patient_app` Communications mark history items "new"; opening the item marks them read
  (`Communication.readAt`, new).

### D5 — sharing
- **The network directory.** `Organization.networkJoinedAt` (new; set by the owner / admin on the facility screen:
  "Join the Setu network — patients can share their records with this facility's doctors"). `network_directory()`
  (SECURITY DEFINER) lists joined facilities (id, tenant, names, district) and their active doctors (user id, names) —
  names only, nothing else about the facility or its staff.
- **`Consent`** — network level (no `tenantId`, like Person): grantor `personId`; grantee `granteeTenantId` +
  `granteeOrganizationId` + optional `granteeUserId` (a doctor; null = the facility's doctors); scope `all` | `visit` |
  `report` with, for a visit or a report, the owner tenant, the linked patient and the record id; `basis = patient`;
  `startsAt`, `endsAt` (24 h | 7 d | **30 d default**); `status` (CONSENT machine: active → revoked | expired);
  `revokedAt`. Row-level security: the person sees and writes their own (`app.person_id`); the **grantee tenant can
  only read** consents given to it (`app.tenant_id`). Scope "all" means the person's records at every linked facility
  **during the share's period** (records added while it runs are included — what a doctor following the patient needs).
- **Rules (`@setu/domain` `share.ts`, unit-tested first):** one of the three scopes; a visit or report must belong to
  a linked claim; a period from the list, default 30 days; a grantee from the directory; `shareCovers(consent, item,
  now)` decides each read — active, `now < endsAt`, the right grantee, the item inside the scope.
- **The consent-checked read service** (`modules/network.ts`) — the only path from one tenant to another: in the
  grantee's tenant it loads the consent (RLS), checks `shareCovers`, then reads the owner tenant's rows **inside that
  tenant's own RLS** (`forTenant`), audits the read **in both tenants** (owner: `view`, basis `patient-share`, the
  reader's name / role / facility in the detail; grantee: `view`, the consent), and records an **open**
  (`ConsentAccess`, network level: who, role, facility, what, when; the person reads their own, the grantee tenant
  inserts). Refused reads answer `403 { reason: expired | revoked | out-of-scope | not-grantee, canRequest: false }`.
  Journey E extends this service (policy reads, access requests); `Person.networkSharing` governs those policy reads,
  not a share the patient made.
- **Expiry:** the `consents` job (one instance, JobRun, in `/health/jobs/ok`) moves due shares to `expired` through
  `consent_expire_due()` (SECURITY DEFINER). Reads never trust the status alone: `shareCovers` checks `endsAt` too.
- **The receiving doctor** (staff app, doctor / facility admin roles): "Shared with you" — active shares to them or to
  their facility, each opening the shared items through the service.
- Sharing, revoking and every read need the network; the app says so offline.

### D6 — revoking and who viewed
- Revoke: two taps in the app ("Stop sharing" → "Confirm — stop now") → `revoke` (idempotent; a second revoke answers
  the revoked share). The next read by the grantee is refused (`revoked`).
- Each share lists its **opens** (who, role, facility, what, when).
- **Who viewed** (`GET /v1/patient/access-log`): from every linked facility's AuditEvents about the linked patient —
  views, prints, reprints, shared reads and **break-glass reads (labelled "Emergency access", with the reason and the
  review state once break-glass exists)** — with the staff member's name, role and facility; the patient's own reads
  left out; newest first, paged. Shared reads carry the reader's name from the audit detail (the reader's user row is
  in another tenant).

### Staging
The patient app joins the staging deploy at `https://setu.sociofitechnology.com/patient` (Next `basePath`, the same
host and Caddy: no new DNS or certificate). `GET /v1/dev/patient-otp` exists only when the SMS adapter is the fake one
**and** `SETU_STAGE=staging` or the dev flag (never in production). The staging patient app shows a fixed
**"STAGING — test data"** banner (`NEXT_PUBLIC_SETU_STAGE=staging` at build).

## Consequences
- Three network-level tables now (Person, Consent, ConsentAccess) beside the per-tenant ones; each has person RLS and
  a grantee-tenant policy; the cross-tenant path is one module, reviewed like the SECURITY DEFINER functions.
- The clinician list gains the plain-language wording (gap 12); critical results stay wording-free until signed off.
- Found while building it: the database's `lab_actor_ok()` is NULL (not false) on a connection that never carried
  `app.user_id`, so the "who" checks it guards pass there — HANDOVER gap 16, fixed the same day (migration
  `20261009160000_actor_check_never_null`; jobs and gateway writes as the system actor). The patient copy issues its document code
  as the facility's system actor with `app.user_id` set, which is right under either behaviour.
- Follow-ups: share links for doctors outside Setu; the prescription and summary screens; uploads ("mine");
  break-glass itself (Journey E's emergency path); guardians.
