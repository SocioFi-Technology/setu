# Handover to Claude Code — state of the project on 02/10/2026

Read this at the start of a session when you need context beyond `CLAUDE.md`. Keep it current: when a slice lands, move it from "Next" to "Done" and update "Known gaps".

## Where the work lives
- The only copy that matters is this folder on Kamrul's PC (`C:\Users\User\Desktop\Cowork\Setu Health APP\setu`), a git repo on `main`. Push to the private GitHub repo `setu` after every session.
- Design and spec inputs (never edit): `docs/design-handoff/` (domain model, roles × screens × plans, i18n, tokens, print specs), `docs/prototype/` (Claude Design pages), `docs/test-log/` (walkthrough test log — the acceptance list).
- Plan: `docs/BUILD-PLAN.md`. Day-to-day runbook and slice prompts: `docs/CLAUDE-CODE-GUIDE.md`.

## Done (phase 0 complete)
- Monorepo: pnpm + Turborepo; `pnpm dev / typecheck / test / e2e / db:*`.
- `packages/domain`: Bangla/English formatting (`format`), money in paisa, access matrix generated from the prototype nav (`access-matrix.json`, 11 modules, 65 screens, 9 roles, 3 plans) with `authorize`, `capabilities`, `defaultScreen`; 17 state machines (`machines.ts`). 22 tests.
- `packages/db`: Prisma schema (tenancy, identity, Patient/RelatedPerson, Session/Device, AuditEvent, IdempotencyKey, Sequence); migration `init` applied locally with `rls.sql` (RLS forced on 12 tables, append-only audit trigger); seed = Green Life Clinic, 10 users (password `setu1234`, PIN `1234`), 4 walkthrough patients, ward 2A. `prisma.config.ts`; scripts load the root `.env` through dotenv-cli.
- `packages/contracts`: Zod schemas (bilingual `ApiError`, Login, Me, PIN, Capabilities, Health) + OpenAPI generator.
- `packages/i18n`: 2,082 design strings in 20 namespaces, fallback loader, test that every bn key has en.
- `packages/ui`: `styles/setu.css` (classes mirroring the DS pages, all tokens), self-hosted fonts, components (Icon, Button, Segmented, Pill, Card, Field, Dialog, Toast, Table, PatientHeaderBanner, PageState, OfflineBanner).
- `apps/api` (Fastify): `/health`, login (signed cookie), `/v1/me`, `/v1/me/capabilities`, PIN verify (5 tries / 15-min lock); plugins: session, audit (every PHI route writes `AuditEvent`), idempotency (replay returns stored response). Loads root `.env`; without `DATABASE_URL` it serves in-memory demo users and accepts `demoPlan` at login. 7 contract tests.
- `apps/staff` (Next.js 15): login page, session context (lang, numerals, online, patient banner slot), Shell (top bar: org, F2 search, Ctrl+K palette, sync pill, বাং/EN and ০১২৩/0123 toggles, user; nav from capabilities with plan locks; offline banner), home per role (prototype content, marked as sample), `/m/[mod]/[screen]` with Permission-denied / Not-in-plan / slice placeholder; `modules/registry.tsx` maps screens to components. `/api/*` is proxied to the API by `next.config.ts`.
- `e2e/journeys/shell.spec.ts`: 13 Playwright specs (9 roles, denied, Clinic/Lite locks, toggles, palette, 390 px).
- Verified locally on 02/10/2026: `/api/health` → db up; doctor login shows the home with 4 modules in Bangla.

## Known gaps (fix in the slice that touches them, or when listed)
1. **RLS is bypassed at runtime**: the API connects as the Docker `setu` superuser, which ignores RLS. Fix in slice A1–A3: a `setu_app` login role with table/sequence grants (new migration), `DATABASE_URL_APP` for the API, owner URL kept for migrations, and a contract test that a wrong `app.tenant_id` returns no rows.
2. **MinIO image cannot be pulled** on this machine (Docker Hub / quay denied). Not needed until PDFs in A6–A7; then switch to another S3-compatible image or a local-folder storage adapter for dev.
3. Password and PIN hashing is dev-only SHA-256 (`apps/api/src/modules/users.ts`); replace with argon2id in the auth hardening pass (before the pilot).
4. PIN attempt counter and idempotency keys live in memory when the DB is off; with the DB they use `IdempotencyKey`; PIN tries should move to Redis.
5. Home-page figures are sample data; each slice swaps its tiles/rows for live queries.
6. Patient app (`apps/patient`) is a placeholder until Journey D.
7. Prisma migrations: create with `--create-only`, append SQL, then apply (see `packages/db/prisma/migrations/README.md`). Never edit an applied migration.

## Next (in order)
1. `/slice A1-A3` — Front desk: search, duplicate review, registration, queue (+ gap 1).
2. `/slice A4-A5` — vitals, consultation, sign/amend.
3. `/slice A6-A7` — billing, payments (FakeProvider), receipt PDF (+ gap 2).
4. `/slice A8-A11` — lab.
5. `/slice A12-A13` — doctor app layout, printing; run all of Journey A.
Prompt texts for each are in `docs/CLAUDE-CODE-GUIDE.md`.

## Conventions worth repeating
Every write route takes `Idempotency-Key`; every table has `tenantId`; money is paisa; strings through `@setu/i18n`; numbers through `@setu/domain` `format`; status changes only through `@setu/domain` state machines; a journey step is done when its Playwright spec is green on the real stack.
