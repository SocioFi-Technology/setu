# Setu Health — rules for every Claude Code session

## What this is
Setu Health is a Bangla-first clinic and hospital platform for Bangladesh: a staff web app (front desk, OPD consultation, billing, lab, pharmacy, IPD, nursing, ER/OT, owner dashboard, admin), a doctor app, a patient app, and a connected-care network (portable lab orders, shared records with consent). It is sold as three plans: Clinic, Hospital Lite, Hospital Pro. Each clinic or hospital is a tenant.

The signed-off prototype lives in `docs/prototype/` (reference only — never import from it). The product spec is `docs/design-handoff/`: **`domain-model.md` is the source of truth for entities and state machines**, `shell-roles-plans.md` for roles × screens × plans, `screens.md`/`sitemap.json` for routes, `i18n/` for every user-facing string, `print-specs.md` for printed documents. The build order is `docs/BUILD-PLAN.md`. **Current state, known gaps and what comes next: `docs/HANDOVER.md`** — read it at the start of a session and update it when a slice lands.

## Hard constraints (from the domain model — enforce server-side, reflect in UI)
1. **Server confirmation.** A write is `pending` locally until the API acknowledges it. The UI never shows Signed / Sent / Paid / Saved for a pending write; it shows "Not yet synced".
2. **Provenance on every clinical item**: `agent`, `onBehalfOf`, `recorded`, `source ∈ provider-verified | patient-uploaded | patient-reported | ai-draft`. AI drafts can never become `final` without the clinician's "I reviewed" tick and signature.
3. **Amend, never overwrite.** Signed documents get a new version; the old one stays as `superseded` / `entered-in-error`.
4. **Permissions are data.** Cross-facility reads evaluate `Consent`; a denied read returns `403 { reason, canRequest }`.
5. **Audit everything that reveals PHI** — an `AuditEvent` per view/create/sign/print/reprint/break-glass. Patients can list events about themselves.
6. **Identity confidence** on Patient: `verified | unverified | possible-duplicate | provisional` + method.

## Conventions
- TypeScript everywhere, strict. pnpm workspaces + Turborepo. Node 22.
- `tenant_id` on every table; Postgres row-level security keyed by the session's tenant. Never write a query that bypasses it.
- Every mutating route accepts `Idempotency-Key`; a replay returns the stored response.
- Money is integer **paisa** (৳1 = 100 paisa). VAT rate is stored on the line.
- Human numbers (GLC-240117, INV/25/0938, token A-017) are display identifiers from per-tenant sequences, never primary keys; always rendered in Latin digits.
- All user-facing strings go through i18n keys (`packages/i18n`, keys from `docs/design-handoff/i18n`). Bangla is the default; English must exist for every key.
- Numbers, dates, taka and amount-in-words are formatted through `@setu/domain` `format` (ported from the prototype's `setu-format.js`). Never hand-format a taka amount.
- State changes go through the state machines in `@setu/domain` (`transition(state, event)`); routes and screens both import them. Never inline a status change.
- Zod schemas in `@setu/contracts` are the API contract: write the schema first, then the route, then the screen. OpenAPI and the typed client are generated from them (`pnpm contracts:gen`).
- External services (bKash, Nagad, SMS, Claude) sit behind interfaces in `apps/api/src/adapters` with a `Fake*` implementation used in dev and tests.
- Errors are `{ code, message_bn, message_en, field? }`.

## How to run
- `pnpm install` · `pnpm db:up` (Postgres, Redis, MinIO in Docker) · `pnpm db:migrate` · `pnpm db:seed`
- `pnpm dev` runs api (:4000), staff (:3000), patient (:3001)
- `pnpm typecheck` · `pnpm test` (unit + contract) · `pnpm e2e` (Playwright journeys)

## Definition of done for any task
- Typecheck clean; unit tests for every domain rule touched; the matching journey spec in `e2e/` green on the real stack.
- Bangla and English strings present; no hardcoded numbers or taka.
- No change to `docs/design-handoff/domain-model.md` or a state machine without a new file in `docs/adr/`.
- Commit message lists what changed and what was tested.

## Working style
- For anything touching money, signing, consent or beds: write a plan first, then the failing unit test from the walkthrough case, then the code.
- Prefer small vertical slices (one journey step end to end) over layers.
- Ask before adding a dependency over 1 MB or a new service.
