# Setu Health — Backend Build Plan

As of 2026-10-01. The living copy is the Claude doc "Setu Health — Backend Build Plan"; keep this file in sync when the plan changes.

## Where we are
The prototype passed its second walkthrough on 01/10/2026 (39/39 journey steps). This plan is for one developer driving Claude Code, TypeScript end-to-end, cloud multi-tenant (each clinic or hospital is a tenant). The backend's job is to make the signed-off screens real, persistent and multi-user — not to change what they do.

Assets and what they become: the 22 Claude Design pages (`docs/prototype/`) → reference UI, ported per module; `docs/design-handoff/domain-model.md` → Prisma schema + state machines; `shell-roles-plans.md` → access matrix (`packages/domain/src/access-matrix.json`); `screens.json`/`sitemap.json` → routes; `i18n/` → `packages/i18n`; tokens + `print-specs.md` → `packages/ui`; the walkthrough test log (`docs/test-log/`) → the acceptance suite.

## Architecture
One Fastify + TypeScript API, one PostgreSQL database with `tenant_id` on every row (RLS), Redis/BullMQ for jobs, S3-compatible storage for files. Three thin clients: staff web app (Next.js, also hosts the doctor-app phone layout), patient app (separate Next.js, OTP login), both installable PWAs; Flutter later. Clients hold an offline outbox; every write carries an `Idempotency-Key`; the API decides when something is Signed / Sent / Paid. External services (bKash, Nagad, SMS, Claude) sit behind adapter interfaces with `Fake*` implementations.

## Data model
Translate `domain-model.md` as written (FHIR-named objects + ShiftClose, ShareRule/ShareEntry, BreakGlass). Add: `Tenant` + `tenant_id` + RLS; `User`/`Session`/`Device`; `IdempotencyKey`; `Sequence` for display numbers. State machines live in `packages/domain/src/machines.ts` as `transition(state, event)`; routes and screens both use them. Money is integer paisa; display numbers (GLC-240117, INV/25/0938, A-017) come from per-tenant sequences and are never primary keys.

Schema build order: tenancy + users + Patient/RelatedPerson/Practitioner/Organization/Location (done) → Encounter, Appointment, Observation, Condition, AllergyIntolerance, Composition, MedicationRequest → ServiceRequest, Specimen, DiagnosticReport, Communication → ChargeItem, Invoice, PaymentNotice, ShiftClose, ShareEntry → beds, MAR, Task, OT → Consent, BreakGlass, claim tables.

## API contract
Zod schemas in `packages/contracts` first; `pnpm contracts:gen` writes `openapi.json`; the API validates against them. REST under `/v1`, cursor pagination, errors `{code, message_bn, message_en, field?}`; 403 on cross-facility reads returns `{reason, canRequest}`.

Areas: auth (login, PIN verify, OTP) · patients (search bn/en/phone, candidates, link-with-reason, register) · encounters/queue (per-branch daily tokens) · clinical (compositions sign/amend, observations batch, medication requests) · orders/lab (service requests, specimens collect/reject, reports validate/release/deliver with critical call-back gate) · billing (invoices, lines, discount approval tasks, payment links + webhooks, shift close) · IPD/nursing/OT (admissions, beds, MAR give/hold, escalations, OT cases) · network/consent (portable orders, consents, break-glass, shared records) · patient app (claim with 3-try/24 h lock, timeline, reports, shares, access log) · admin/owner (dashboard rollup, audit, users, masters, print templates).

Porting a prototype module: copy its `.dc.html` into `docs/prototype/`; port components to `apps/staff/modules/<module>/` keeping markup, tokens and i18n keys; replace inline sample data with hooks on the typed client; move list/bill/bed state to server state; put the offline outbox in front of every mutation; run the journey spec.

## Cross-cutting (built once in phase 0/1)
Tenancy (RLS + per-request tenant) · auth (password + device session, 4-digit PIN with 5 tries/15 min lock; patients OTP) · roles and plans (`authorize(role, plan, module, screen)` from the seeded matrix; `GET /me/capabilities`) · audit + provenance (Prisma middleware / Fastify hook) · offline (IndexedDB outbox, idempotent replay, typed 409 conflicts) · Bangla first (i18n keys, `format` for numerals/taka/words/dates, Noto Sans Bengali in PDFs) · payments (`PaymentProvider`: createLink/verify/refund/parseWebhook; Fake, Bkash, Nagad) · messaging (`Messenger`; every send is a `Communication` row with retries) · QR + printing (verify URL per signed doc; server-rendered PDFs; reprints watermarked and audited) · AI drafts (always `source: ai-draft`, never final without "I reviewed") · clinical safety rules as pure functions with walkthrough-derived tests.

Decide before phase 2: SMS gateway; apply for bKash/Nagad sandboxes in week 1.

## Phases (vertical slices; each gate = that journey's Playwright specs green on the real stack)
| Phase | Weeks | Journey steps | Prototype pages ported | Gate |
| --- | --- | --- | --- | --- |
| 0 Foundation | 1–2 | — | Staff App shell, DS 1–6 | login + smoke e2e (done except DS/shell port) |
| 1 Journey A | 3–8 | A1–A13 | Front Desk, Consultation, Billing (OPD), Lab, Doctor App | A1–A13 green |
| 2 Pilot clinic | 9–12 | C1–C4 + pharmacy, admin | Pharmacy, Owner Dashboard, Admin; real SMS + bKash sandbox | one clinic live a week |
| 3 Journey B | 13–20 | B1–B12 | ER (ER screens), IPD, Nursing, Billing (IPD) | B1–B12 + C green |
| 4 Journeys D, E | 21–28 | D1–D6, E1–E4 | Patient App, Connected Care | D, E green |
| 5 Pro + scale | 29+ | OT, share ledger, integrations | ER and OT (OT), Billing (ledger), Admin (integrations) | — |

Definition of done per slice: Prisma models + migration + seed; Zod contract + regenerated client; domain rules with unit tests from the walkthrough cases; route with tenancy/authorize/audit/idempotency; screen ported with outbox; journey spec green; Bangla + English strings; numbers through `format`.

## Working with Claude Code
Daily loop: pick one slice → `/slice <step>` → read the plan → go → run the journey yourself → `/review` → commit. For money, signing, consent or beds: plan first, failing unit test from the walkthrough case, then code. Never change `domain-model.md` or a state machine without an ADR.

The first ten prompts (1–4 are done):
1. Monorepo scaffold — done.
2. Tenancy + identity Prisma schema, RLS, seed — done (apply `prisma/rls.sql` after the first migration).
3. Auth: login, session, PIN with lock, `authorize`, audit hook, idempotency — done (dev password hashing is a placeholder: replace with argon2id in the auth slice; move PIN tries and idempotency keys to Redis/DB).
4. Port DS 1–6 into `packages/ui`; port the Staff App shell into `apps/staff` — done 02/10/2026 (13 Playwright specs: all 9 roles, role-denied and plan-locked panels, language/numerals toggles, command palette, 390 px). Screens register in `apps/staff/modules/registry.tsx` as each slice ports them.
5. Slice A1–A3: patient search (bn/en/phone, shared-phone warning), duplicate candidates with Same/Similar/Different, link-with-reason when conflicting, registration validation, visit creation with daily token. Port Front Desk. Specs A1–A3.
6. Slice A4–A5: observations with impossible-value blocking; Consultation (complaint, ICD-11 bn/en, orders, Rx with allergy + duplicate checks, AI panel via FakeAi), sign with PIN + server ack, amend as new version. Specs A4–A5.
7. Slice A6–A7: ChargeItem, Invoice, discount approval Task, PaymentProvider + FakeProvider, link flow (initiated → link-sent → confirmed | failed → retry), cash + partial, receipt PDF with QR and amount in words, reprint with reason. Specs A6–A7.
8. Slice A8–A11: ServiceRequest → Specimen (tube guidance, labels, reject + recollection SMS), result entry with flags + delta check, verify with critical call-back gate, release, delivery per channel with retry. Specs A8–A11.
9. Slice A12–A13: Doctor App layout (critical-first inbox, acknowledge notifies patient, outbox "not yet synced"), print preview A5/A4 with QR, drafts blocked from print. Specs A12–A13; run all of Journey A.
10. Phase 2: Pharmacy (dispense, OTC, FEFO stock), ShiftClose with variance note, Owner dashboard from nightly rollup + live counts, Admin onboarding + users; swap FakeMessenger/FakeProvider for the real SMS gateway and bKash sandbox.

## Testing
Unit (vitest, `packages/domain`, `packages/contracts`) · contract (Fastify inject, `apps/api/test`) · journey e2e (Playwright, one spec per step, 1440 desktop; phone steps also at 390) · regression (one spec per walkthrough issue) · manual pilot. Seeded demo tenant = the prototype's sample people. A slice is not done until its spec is green; every tester bug gets a failing test before the fix.

## Deployment
`local` (docker-compose) · `staging` (fake payments) · `production`. One container on a managed platform in Singapore/Mumbai, managed Postgres with PITR, S3-compatible bucket, Next.js on Vercel or the same platform, GitHub Actions (typecheck/unit/contract/e2e on PR; staging on merge; production on tag), Sentry + structured logs + `/health` uptime check, secrets in the platform vault, append-only audit, daily snapshots + weekly restore drill, per-tenant export on request. Pilot-scale cost roughly USD 60–150/month, dominated by SMS (approximate).

## Open decisions
SMS gateway (phase 2) · bKash/Nagad sandbox applications (week 1) · hosting region (phase 2) · patient identity beyond phone + receipt code (phase 4) · PWA vs Flutter (phase 5) · data-protection policy and retention, drafted with a local lawyer before the first real patient.
