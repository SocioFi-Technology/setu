# ADR 0010 — Admin: onboarding and go-live, users and roles, masters and settings, the audit log

Date: 2026-10-04 · Status: accepted (Kamrul, 04/10/2026 — admin slice decisions)

## Context
The design handoff gives the Admin module seven screens (`screens.md` `/[facility]/admin/*`; prototype Setu Admin):
onboarding wizard with go-live, users & roles, masters, print templates, audit log, subscription, integrations. Phase 2
needs the first four for a pilot clinic. Until now users, prices and limits came only from the seed; sessions are
signed cookies the server never re-checks, so a user switched off kept working until the cookie expired.

## Decision
### Facility status and go-live
`Organization.status` `setup | live` (+ `liveAt`). A facility in setup completes a checklist (`@setu/domain`
`goLiveChecklist`): organization details (name, address, licence), a branch, wards with beds (hospital plans only), a
doctor whose registration (BMDC) was verified, a price list (every active doctor has a consultation fee), receipt and
prescription formats chosen, at least one payment method, a test SMS delivered. **Go live** (owner / admin) is refused
until it is complete; it is audited and flagged. Facilities that already existed are `live`. Being in setup does not
block clinical work in this slice (the screens say "in setup"); a later decision may.
Payment methods become a facility setting (`paymentMethods`); a payment by a method that is switched off is refused.
Registration numbers are checked through a `RegistrationVerifier` adapter (`Fake*` in dev and tests; BMDC / BNMC
lookups when available).

### Users and roles (Kamrul: one-time password; no Manager role yet)
Owner / admin create a user at their facility with one role; the server answers with a **one-time password shown once**
(valid 24 h); at the first sign-in the user must set their own password and PIN (`passwordProblems`, `pinProblems`) —
until then the session can do nothing else. Role change, deactivate (with a reason), reactivate, reset password (a new
one-time password). Rules (`roleChangeBlockers`, `deactivateBlockers`): never yourself; only an owner makes or unmakes
an owner; a facility always keeps one active owner or admin. **Every session carries the user's session generation;
deactivation, a role change and a password reset bump it, and every data request checks it with the user's active flag
and role** — the user is signed out everywhere on their next request. An SMS invite replaces the one-time password when
the real gateway lands.

### Masters and settings (Kamrul: a price change applies to bills created after it)
The price list (`ChargeItemDefinition`) is edited in place with an append-only `ChargePriceChange` history (old / new
price and VAT, reason ≥ 10, who, when); the database refuses a price change without its history row. Bills keep the
price they were made with — a draft line whose item has changed since shows "price changed since". Approval limits
(cashier discount amount / percent, approver limit — `limitProblems`) and the dose-label page are facility settings;
every change is audited as `settings-change` and flagged. The medicine and ICD-11 lists stay read-only samples.

### The audit log
Owner / admin list audit events with filters (from–to, person, action, record, patient, flagged only) and export them as
CSV; the export is itself an audited, flagged event. Flagged actions: `FLAGGED_ACTIONS`.

## Consequences
- Migration: Organization `status`, `liveAt`, `receiptFormat`, `rxFormat`, `paymentMethods`, `smsTestedAt`,
  `smsTestPhone`; User `mustChangePassword`, `tempPasswordExpiresAt`, `sessionGeneration`, `lastLoginAt`;
  `ChargePriceChange`; `auth_login_lookup` returns the new user fields.
- Sessions gain `generation` and `setup`; `command()` / `query()` check the user is active, holds the role and has the
  same generation.
- Not in this slice: print template designer, subscription, integrations, departments, bed classes, packages, the
  Manager role, argon2id (HANDOVER gap 3).
