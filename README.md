# Setu Health

[![ci](https://github.com/SocioFi-Technology/setu/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SocioFi-Technology/setu/actions/workflows/ci.yml)

Bangla-first clinic and hospital platform for Bangladesh. Monorepo: one API, one database, three clients.
Read `CLAUDE.md` first (rules), then `docs/BUILD-PLAN.md` (what to build in which order).

## Prerequisites (Windows)

| Tool | Why | Install |
| --- | --- | --- |
| Git | version control, Claude Code reads diffs | https://git-scm.com/download/win (tick "Git Bash") |
| Node.js 22 LTS | runs everything | https://nodejs.org (LTS) — then `corepack enable` in an admin terminal |
| pnpm 10 | workspace package manager | comes with corepack; verify `pnpm -v` |
| Docker Desktop | local Postgres, Redis, MinIO | https://www.docker.com/products/docker-desktop (needs WSL 2; the installer sets it up) |
| Claude Code | the AI pair programmer | `npm install -g @anthropic-ai/claude-code` then `claude` in the repo and sign in |
| VS Code (optional) | editor; Claude Code has an extension | https://code.visualstudio.com |

Use **Git Bash** or **Windows Terminal (PowerShell)** for the commands below; both work.

## First run (about 10 minutes)

```bash
git clone <your repo url> setu && cd setu        # or unzip setu-repo.zip and `cd setu`
pnpm install                                     # installs every workspace package
cp .env.example .env                             # PowerShell: copy .env.example .env
pnpm db:up                                       # starts Postgres, Redis, MinIO in Docker
pnpm db:migrate                                  # creates the tables (answer "init" when asked for a name)
pnpm db:seed                                     # Green Life Clinic demo tenant, 10 users, 4 patients
pnpm dev                                         # api :4000 · staff :3000 · patient :3001
```

Then open http://localhost:3000. Demo logins: any seeded phone (`01711000001` receptionist … `01711000010` admin), password `setu1234`, PIN `1234`.

Without Docker, `pnpm dev` still works: the API serves `/health`, login, `/me/capabilities` and PIN from in-memory demo users (it says `db disabled` in its log). Set `DATABASE_URL` in `.env` to switch to Postgres.

After the first migration, append `packages/db/prisma/rls.sql` to the generated migration file (`packages/db/prisma/migrations/<timestamp>_init/migration.sql`) and run `pnpm db:migrate` again — that turns on row-level security and the append-only audit log.

## Daily commands

```bash
pnpm dev          # everything, with reload
pnpm typecheck    # all packages
pnpm test         # unit + contract tests (vitest)
pnpm e2e          # Playwright journeys against the running stack (first time: pnpm --filter @setu/e2e exec playwright install chromium)
pnpm contracts:gen  # regenerate openapi.json from the Zod contracts
pnpm db:studio    # browse the database
```

## Working with Claude Code

```bash
cd setu && claude
```

Claude Code reads `CLAUDE.md` automatically. Two slash commands are included:

- `/slice A1` — implement journey step A1 end to end (plan first, then schema → contract → domain → route → screen → e2e).
- `/review` — run the checks and draft the commit message.

The ten prompts for phase 0 and phase 1 are in `docs/BUILD-PLAN.md`, section "Working with Claude Code". Prompts 1–4 are already done; start with prompt 5 (`/slice A1`).

## Layout

```
apps/api        Fastify API (routes, plugins: session, audit, idempotency; adapters)
apps/staff      Next.js staff web app: login, shell (top bar, nav from /me/capabilities, patient banner, page states), home per role; modules/registry.tsx lists ported screens
apps/patient    Next.js patient app
packages/domain pure rules: format (Bangla numerals, taka, words), money (paisa), access matrix, state machines
packages/db     Prisma schema, migrations, seed, RLS SQL
packages/contracts  Zod request/response schemas → openapi.json
packages/i18n   bn.json / en.json from the design, loader with fallback
packages/ui     design system: tokens, fonts, styles/setu.css and React components ported from DS 1–6 + the shell
e2e             Playwright journey specs
docs            design handoff (source of truth), prototype pages, test log, ADRs, build plan
infra           docker-compose
```

## CI (`.github/workflows/ci.yml`)

Every push and pull request runs two jobs: **typecheck + unit tests** (Postgres 16 and Redis as service containers,
`migrate:deploy`, the `setu_app` password set from a secret, `db:seed`, `pnpm typecheck`, `pnpm test`) and, only when
that is green, **Playwright journeys** (`pnpm e2e --workers=2` against the API on 4100 and the staff app on 3300, the
E2E reset in global-setup; journeys K and L skip because the stand-ins are not there; traces, screenshots and the
server logs are uploaded when a run fails). Chromium is cached by Playwright version; pnpm's store by the lockfile.

Nothing real runs in CI: `PAYMENTS_PROVIDER`, `SMS_PROVIDER` and `AI_PROVIDER` are `fake` and no `BKASH_*` or
`BULKSMSBD_*` variable exists on the runner. Three repository secrets, all CI-only values, never a real credential:

| Secret | What it is |
| --- | --- |
| `SETU_APP_PASSWORD` | the password of the `setu_app` database role on the runner (8+ characters) |
| `CI_SESSION_SECRET` | the API's session secret on the runner (32+ characters) |
| `FAKE_PAYMENTS_SECRET` | what the fake payment gateway signs its callbacks with |

A red run reproduces locally with the same commands (`docs/HANDOVER.md` › How to run the journeys). Make the `ci`
check required on `main` in the repository settings so a red push cannot merge.
