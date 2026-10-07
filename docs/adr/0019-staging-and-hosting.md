# ADR 0019 — Staging and hosting: images, the deploy, storage, config, single-instance jobs (week 2, session 1)

Status: accepted (Kamrul, 08/10/2026 — the session 1 plan; the security answers on storage, the registry, the process
manager and the S3 client recorded below). The host itself is chosen before session 2.

## Context
Everything so far ran with `pnpm dev`: the API under tsx, the staff app under `next dev`, files on the local disk,
sweeps on `setInterval` in every process, and config that assumed localhost. Staging needs the same code as production
images, a deploy that can be undone, private object storage, and jobs that are safe with more than one API replica.

## Decisions
### Where it runs — `HOSTING_REGION` is a variable
- The region is **not in code and not in config**: nothing in the app reads it. It is a choice recorded here as
  `HOSTING_REGION` once the host is chosen (session 2). The candidates: a Bangladesh data centre (data stays in the
  country), or `ap-southeast-1` (Singapore, managed services, ~40–60 ms from Dhaka). **Which one patient data may live
  in is the lawyer's question** (the data-protection policy drafted before the first real patient, BUILD-PLAN); staging
  holds only seed and test data, so it can go up before that answer.
- What the host must provide, whichever it is: **managed Postgres 16** with daily snapshots and point-in-time recovery;
  **managed Redis** (or a Redis container with no persistence needed: it holds locks, counters and rate limits only);
  **S3-compatible object storage** (AWS S3, Cloudflare R2 or MinIO) with a private bucket; **secrets in the host's
  secret store**, rendered into `infra/staging.env` on the host (never in git: `infra/.gitignore`); a machine that runs
  containers (Docker Engine with compose v2, or the platform's equivalent).

### Images — one per app, GHCR private, commit SHA tags only
- `infra/Dockerfile`, one multi-stage file with three targets:
  - **api**: the API bundled by esbuild into `dist/server.js` (`@setu/*` inlined, npm packages external), run with
    plain `node` under `tini`, with Chromium and the Bangla fonts for PDFs; 1.76 GB.
  - **staff**: the Next.js standalone server; 466 MB.
  - **tools**: the repo with pnpm, for `migrate:deploy`, `db:set-app-password` and the seed; 2.87 GB.
  - Trimming the api and tools images (Chromium is most of the api image; tools carries the whole workspace) is a
    follow-up, not a blocker.
- **GHCR, private; images tagged with the commit SHA and never `latest` in a deploy** (Kamrul). `.github/workflows/
  images.yml` builds and pushes `ghcr.io/sociofi-technology/setu-{api,staff,tools}:<full sha>` **only after the `ci`
  workflow succeeded on a push to main**. So an image exists only for a commit whose typecheck, tests and journeys
  passed. GHCR packages pushed by an organisation's workflow are private by default; check this once in the package
  settings when the first image lands. The host logs in with a read-only token (`read:packages`).
- **No PM2. The container runtime is the process manager** (Kamrul): one process per container, `restart: unless-
  stopped` from the orchestrator, health checks in the image (`/ready` for the api, the login page for staff),
  `stop_grace_period: 20s`. The API handles SIGTERM itself: it stops scheduling sweeps, lets in-flight requests finish
  (`app.close()`), then exits.
- `/health` answers "is the process up" (and the db); `/ready` answers "can this replica serve": db, redis and the PDF
  browser warmed by a test render at start. (The first render took about 8 s and broke the first print's transaction;
  a browser that crashes is restarted.)

### The staging stack — `infra/docker-compose.staging.yml`
- **caddy** (TLS for the real domain, automatic certificates; JSON access logs; HSTS, nosniff, referrer policy) →
  **api** ×2 and **staff** ×1. Caddy sends `/api/*` and `/p/*` **straight to the API replicas**: it looks the replicas
  up every second, retries a refused connection on another replica, and skips a failing one for 10 s. Everything else
  goes to staff. That is one proxy hop, so **`TRUST_PROXY=1`**: the audit log records the caller's IP, and Caddy
  replaces any `X-Forwarded-For` a client sends.
- **Logs**: JSON lines on stdout from all three (pino for the API, Caddy's JSON format), rotated by Docker's json-file
  driver (20 MB × 5). The API redacts cookies, `authorization`, device keys, passwords and PINs; request logs never
  carry the query string (security review A1–A3).
- A `local` profile adds postgres/redis/minio so the whole stack can be rehearsed on one machine.
  `infra/staging-smoke.sh` builds the images, brings the stack up, creates the bucket, migrates, seeds, then checks
  through Caddy: ready, login, a prescription printed into object storage and served back, the object unreadable
  anonymously, JSON logs with no secrets, `/health/jobs`.

### Deploy and rollback — `infra/deploy.sh`
- `deploy.sh <full sha>`: refuses `latest` and short SHAs; checks the commit's `ci` run is green (gh) and its three
  images exist. Then **pull → `migrate:deploy` (once, in the tools image, with the `setu_app` password) → reload a
  changed Caddyfile in place → rolling restart**. The api replicas go first, then staff. For each, new containers start
  beside the old ones; the old ones stop only once the new ones are healthy. If the new ones never become healthy,
  they are removed and the old ones keep serving.
- **Rollback = the previous image**: `deploy.sh --rollback` deploys `.previous-tag` and **skips migrations**.
  Migrations stay **additive** (a new column is nullable or has a default; a column is dropped only in a later release
  that no longer reads it), so the previous image runs against the newer schema. A migration that cannot be additive
  needs its own plan in its ADR. Never `migrate dev`, never a reset, outside a developer's machine.
- Rehearsed locally (three deploys under a request loop through Caddy): no failed request apart from `/ready` 503s
  from a replica still warming, which is that replica answering truthfully.

### Object storage — streaming through the API only
- `S3Storage` behind the existing `Storage` interface. It speaks S3 SigV4 through **`aws4fetch`** (72 KB, no
  dependencies). The rule "ask before a dependency over 1 MB" is satisfied, and Kamrul approved it. One client covers
  AWS S3, Cloudflare R2 and MinIO (`S3_PATH_STYLE` for MinIO). Writes are write-once (`If-None-Match: *`). Production
  refuses to start with any storage but `s3`.
- **The bucket is private, and clients never get a signed URL** (Kamrul): every download goes through the API, which
  checks the session, the tenant and consent, and writes the audit event. A signed URL would bypass all of that. The
  PDF is streamed from the bucket through the API.
- CI runs the storage test against a MinIO container (`S3_TEST_ENDPOINT`).

### Config
- `PUBLIC_APP_URL`, `VERIFY_BASE_URL`, `VERIFY_DOC_ROOT_URL` (https required in production: they are printed as QR
  codes), `TRUST_PROXY` (hop count, required in production), `CORS_ORIGINS` (exact origins; development also allows
  any `http://localhost:<port>`). Production refuses to start without `SESSION_SECRET`, `DEVICE_KEY_SECRET` (≥ 32
  characters, not the session secret), `GATEWAY_TOKEN_KEY`, `WRISTBAND_SECRET` (each ≥ 32 characters), `DATABASE_URL_APP`, S3 storage, and real payment
  and SMS providers (the fakes and their dev routes never run in production): staging therefore runs `NODE_ENV=
  production` with the bKash and SMS sandboxes, never the fakes. `.env.example` lists
  every variable with what it is for.

### Jobs — one instance at a time
- Every background job (the nightly owner rollup; the payment, SMS, refund, bed-day and escalation sweeps) runs
  through `singleRun(name)`. It takes a Postgres **advisory lock** `job:<name>` without waiting: a replica that finds the
  lock held skips this run. Each run is recorded in `JobRun` (started, finished, ok, error, summary). With two replicas
  each job still runs once a minute (or once a night), never twice at the same time.
- `GET /health/jobs` lists each job's last finish, age in seconds, last result and run/skip counts, for the job-age
  monitor (session 2).

## Consequences
- Session 2 brings this up on the chosen host. It adds the backup/restore drill, the 20-user load check through
  journey A, uptime monitoring (`/ready`) and job-age monitoring (`/health/jobs`), and the on-call notes in HANDOVER.
- A deploy needs a green `ci` run on main and the images workflow after it, about 15 min after a push.
- The two api replicas share Redis (sessions, locks, counters) and Postgres. Nothing in an API process is state that
  another replica would need.
- Follow-ups: smaller images; a staging-only Sentry DSN or equivalent error tracking when the host is chosen.
