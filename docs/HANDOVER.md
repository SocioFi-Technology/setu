# Handover to Claude Code — state of the project on 02/10/2026 (after slice A1–A3)

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

## Done (slice A1–A3, 02/10/2026) — front desk
- **Database role:** the API connects as `setu_app` (no superuser, no BYPASSRLS) via `DATABASE_URL_APP`; migrations and the seed keep the owner `DATABASE_URL`. `pnpm db:migrate` sets the role's password from `DATABASE_URL_APP`. Login's only pre-tenant read is the `auth_login_lookup` SECURITY DEFINER function. `apps/api/test/tenancy.test.ts` proves a wrong `app.tenant_id` returns no rows.
- **One transaction per request:** `apps/api/src/command.ts` — `command()` (write + audit + idempotency key together; key required) and `query()` (read + view audit).
- **Rules** in `@setu/domain`: `patient.ts` (registration validation, normalisation, Same/Similar/Different/Missing comparison, link rules) and `queue.ts` (A-017 tokens, Dhaka day, board = view of ENCOUNTER). No new state machines: visits use ENCOUNTER, duplicate review is a `Task` through APPROVAL, identity confidence changes with a `Provenance` row.
- **Models:** `Encounter` (token attributes, per-branch daily `Sequence`), `Task`, `Provenance` (append-only), `Tenant.patientNoPrefix`, Patient approx-age fields. Seed: Mirpur branch, the walkthrough family on 01711-234567, plan-demo tenants (Clinic nurse 01722000004, Lite doctor 01733000002).
- **API:** search, matches, match-preview, match decisions + undo, register, create visit, queue, queue actions (`packages/contracts/src/frontdesk.ts`, `openapi.json`).
- **Screens:** `fd/search`, `fd/match`, `fd/register`, `fd/queue` in `apps/staff/modules/fd/`; strings in `packages/i18n/locales/app/frontDeskApp.json`; offline outbox `apps/staff/lib/outbox.ts` (pending writes show "not synced", the shell's sync count reads it).
- **Tests:** domain 47, api 40 (incl. 22 front desk + cross-tenant, 6 transaction/idempotency), i18n 3, contracts 2; Playwright 22 (13 shell + 9 `a1-a3.spec.ts`).
- **Reviews:** security and clinical-safety reviews ran on the slice; fixes landed, the rest is in `docs/open-questions.md` 16–24 (16 needs your decision).
- Decisions and rules chosen in this slice: `docs/open-questions.md` — please read and confirm.

## How to run the journeys on this PC
- Playwright's bundled Chromium is not installed; use the installed Chrome: `cd e2e` then `CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" pnpm exec playwright test -c pw.local.config.ts`.
- Older dev servers were holding ports 3000/3001 on 02/10/2026; a fresh staff server was run on 3100 (`STAFF_URL=http://localhost:3100`). Stop old `next dev` processes before `pnpm dev`.
- The API tests and journeys create synthetic patients and today's tokens in the local database (names like "Nusrat Jahan <run id>"). Re-seeding does not remove them; that is expected in dev.

## Known gaps (fix in the slice that touches them, or when listed)
1. ~~RLS is bypassed at runtime~~ — fixed in A1–A3 (`setu_app`). Production: the migration role must be superuser or BYPASSRLS for `auth_login_lookup` (open question 11).
2. **MinIO image cannot be pulled** on this machine (Docker Hub / quay denied). Not needed until PDFs in A6–A7; then switch to another S3-compatible image or a local-folder storage adapter for dev.
3. Password and PIN hashing is dev-only SHA-256 (`apps/api/src/modules/users.ts`); replace with argon2id in the auth hardening pass (before the pilot).
4. PIN attempt counter and idempotency keys live in memory when the DB is off; with the DB they use `IdempotencyKey`; PIN tries should move to Redis.
5. Home-page figures are sample data; each slice swaps its tiles/rows for live queries.
6. Patient app (`apps/patient`) is a placeholder until Journey D.
7. Prisma migrations: create with `--create-only`, append SQL, then apply (see `packages/db/prisma/migrations/README.md`). Never edit an applied migration.

8. Front desk follow-ups (not blocking A4): queue reorder with reason (+ audit), Lab/Billing queue columns, register "Save draft" and the register-screen Compare for an unsaved form (today: "Visit on this record" per candidate), payer/photo/referral fields (need Coverage/Media), records-officer role for review Tasks, branch choice for multi-branch organisations.
9. Some screen strings still come from the shell's inline `L(bn, en)`; new screens use `packages/i18n` namespaces (`locales/app/*.json`).

## Next (in order)
1. ~~`/slice A1-A3`~~ — done 02/10/2026.
2. `/slice A4-A5` — vitals, consultation, sign/amend.
3. `/slice A6-A7` — billing, payments (FakeProvider), receipt PDF (+ gap 2).
4. `/slice A8-A11` — lab.
5. `/slice A12-A13` — doctor app layout, printing; run all of Journey A.
Prompt texts for each are in `docs/CLAUDE-CODE-GUIDE.md`.

## Conventions worth repeating
Every write route takes `Idempotency-Key`; every table has `tenantId`; money is paisa; strings through `@setu/i18n`; numbers through `@setu/domain` `format`; status changes only through `@setu/domain` state machines; a journey step is done when its Playwright spec is green on the real stack.
