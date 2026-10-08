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
  two runs of a job never overlap. Each replica
  still takes its own turn, so a sweep runs up to twice a minute (staging: 108 runs in ~54 min); the sweeps are
  idempotent, so that is harmless. The nightly rollup catches up idempotently too.
- `GET /health/jobs` lists each job's last finish, age in seconds, last result and run/skip counts, for the job-age
  monitor (session 2).

## Consequences
- Session 2 brings this up on the chosen host. It adds the backup/restore drill, the 20-user load check through
  journey A, uptime monitoring (`/ready`) and job-age monitoring (`/health/jobs`), and the on-call notes in HANDOVER.
- A deploy needs a green `ci` run on main and the images workflow after it, about 15 min after a push.
- The two api replicas share Redis (sessions, locks, counters) and Postgres. Nothing in an API process is state that
  another replica would need.
- Follow-ups: smaller images; a staging-only Sentry DSN or equivalent error tracking when the host is chosen.

## Addendum — session 2 (08/10/2026): staging on the shared SocioFi VPS, not AWS (Kamrul)
- **Where:** staging runs on the existing SocioFi VPS (Ubuntu 24.04, 8 vCPU, 23 GiB, shared with five other projects)
  at **https://setu.sociofitechnology.com**. A dedicated host comes later, "after we do enough testing", with the
  product's own name and domain. The session 2 prompt's AWS plan (RDS, ElastiCache, S3, Secrets Manager, CloudWatch)
  was dropped before anything was created. `HOSTING_REGION` stays open until that host is chosen; the residency
  question stays with the lawyer.
- **Co-hosting** (`infra/compose.cohost.yml`, the same pattern as the other projects on the box): the VPS's edge nginx
  (`sociofi-nginx`, `/opt/sociofitechnology`) owns :80/:443 and terminates TLS (Let's Encrypt via its certbot, renewed
  with the others); it reaches Setu's Caddy as `setu-proxy:80` on the external network `setu_edge`. Setu publishes no
  port. Two proxies in front of the API, so `TRUST_PROXY=2`, and Caddy keeps the edge's `X-Forwarded-For`
  (`trusted_proxies private_ranges`); a client-sent header is not believed (checked: the audit IP is the caller's).
  Memory limits on every Setu container (api 1 GiB ×2, staff 512 MiB, postgres 1 GiB, minio 512 MiB, redis 256 MiB).
- **Data:** the stack's own Postgres 16, Redis and MinIO containers (profile `bundled`), on Setu's network only.
  Storage is S3Storage against that MinIO — no code change, the bucket private, files streamed by the API.
- **Secrets:** `/opt/setu/staging.env`, generated on the VPS by `infra/staging/vps-env.sh`, mode 600, never printed
  or committed. The seeded staff accounts get their own password and PIN there (`SEED_PASSWORD` / `SEED_PIN`), never
  the published dev ones.
- **Providers (Kamrul):** `SETU_STAGE=staging` lets the production build run the fake gateway and the fake SMS — no
  real money, no texts to seeded numbers; a real production deploy never sets it. AI stays `off`.
- **Images and deploy:** `infra/staging/ship.sh` sends a committed revision with `git archive`, builds
  `setu/setu-{api,staff,tools,drill}:<full sha>` on the VPS and runs `deploy.sh` (`SETU_IMAGES=local`): no registry
  token on the shared box, still SHA tags only. The GHCR workflow stays for the dedicated host.
- **Backups (Kamrul: no off-server copy until production):** nightly at 02:30 Dhaka (`infra/staging/backup.sh`, cron):
  `pg_dump` + the MinIO volume + row counts into `/opt/setu/backups`, 7 kept, the run recorded in `JobRun`
  ("backup") so a missed or failed backup trips the job-age check. Same disk as the data — a disk loss loses both;
  accepted for staging.
- **Restore drill** (`infra/staging/restore-drill.sh`): the newest backup into scratch containers on their own network
  → row counts, every stored print's file, `migrate status`, the API test suite → removed.
- **Alarms:** `/api/ready` (uptime) and `/api/health/jobs/ok` (job age, incl. the backup) are the two checks for an
  external monitor emailing Kamrul — see HANDOVER "On call (staging)".
- **Results on 08/10/2026.** Restore drill: the newest backup restored in 8 s; row counts and every stored print's
  file matched; migrations up to date; API tests against the restored copy **432 passed, 3 skipped** (S3 tests: no S3
  endpoint in the drill); scratch removed; 551 s in all. Rolling deploys on the VPS: 0 failed requests in 632 during a
  ship. **20-user journey-A load** (k6 from Bangladesh, 5 min at 20 users, 248 full visits incl. lab and prints, 6,761
  requests, 0 failed): server-side p95 (Caddy) every endpoint ≤ 0.46 s — queue 0.27 s, billing worklist 0.30 s, bill
  make / issue / pay ≈ 0.3–0.4 s. Seen from Bangladesh p95: bill steps 0.43–0.64 s (target met), **queue 1.47 s and
  billing worklist 1.50 s (target missed)** — the VPS is in France (≈ 215 ms round trip from Dhaka), and those two lists
  return every visit of the day (≈ 490 after two runs, 23–30 KB gzipped). Follow-ups: page or narrow the queue and the
  worklists to the active visits; choose the dedicated host near Bangladesh (Singapore / Mumbai ≈ 40–70 ms, or in the
  country); the lab worklist query (0.46 s server p95 on a 1 KB answer) is the slowest read.

### What staging is, why not the managed services, and what must change before production (recorded 08/10/2026)
- **What it is:** one Contabo VPS (AS51167 Contabo GmbH, Lauterbourg, France; KVM, 8 vCPU AMD EPYC, 23 GiB RAM,
  290 GB disk, Ubuntu 24.04), shared with five other SocioFi projects. Postgres 16 is a container on that VPS (the
  `setu-staging` compose project, a Docker volume on the VPS's own disk), as are Redis and MinIO.
- **Backups:** nightly `pg_dump` + a copy of the MinIO volume into `/opt/setu/backups` **on the same disk**, 7 kept.
  **No PITR** (no WAL archiving) and **no copy to S3 or anywhere off the VPS**. The restore drill exists and passed
  (8 s restore, API tests 432/3 against the copy) but is run by hand, not on a schedule.
- **Secrets:** `/opt/setu/staging.env` on the VPS, mode 600, owner `kamrul`. Not a secrets manager: every member of the
  VPS's `docker` group (`kamrul`, `deploy`, `gojobs-deploy`) can read them through `docker inspect`, and `sudo` users
  through the file.
- **Cost:** no new bill — the VPS is SocioFi's existing server; Setu uses ≈ 0.7 GiB RAM idle, ≈ 3 cores at peak under
  20 users, < 1 GB disk. The VPS's own monthly price is on SocioFi's Contabo invoice (not visible from the server).
- **Why not the managed plan:** **not cost.** The AWS estimate (≈ USD 105/month: RDS with 7-day PITR, ElastiCache,
  S3, Secrets Manager, CloudWatch) was under the USD 150 limit. Kamrul decided on 08/10/2026 that staging runs on the
  SocioFi VPS as a subdomain during testing, with a dedicated host — and off-server backups — when the product goes to
  production under its own name and domain. Nothing was created on AWS.
- **What a pilot on this setup would lose**, against the managed plan:
  - *PITR:* the most that can be recovered is last night's dump — up to ~24 h of entries (bills, payments, signed
    notes) lost on a bad migration, a deletion or a corrupt database.
  - *Off-site backups:* the dumps sit on the same disk as the database; losing the disk or the VPS loses both.
  - *Failover:* one VPS, one Postgres, no standby; a host failure is an outage until the VPS is restored, then a
    restore from the last dump. No provider SLA on the database.
  - *Isolation and secrets:* a host shared with other projects; other deploy users can read Setu's secrets and
    containers; no audit or rotation of secret access.
  - *Region and latency:* data in France (the residency question is open); ≈ 215 ms from Dhaka — the queue missed its
    p95 < 1 s from Bangladesh.
  - *Alarms:* not live yet (they need an account that can send email).
  - **So the pilot (real patients) must not run on this staging.**
- **Before production — must change:**
  1. Postgres with PITR (managed with ≥ 7 days, or WAL archiving to object storage, e.g. WAL-G) and a tested
     point-in-time restore; stated RPO / RTO.
  2. Encrypted backups off the host (another provider / account or region), the restore drill on a schedule (monthly),
     its results recorded.
  3. A dedicated host (no shared `docker` group); secrets in a secrets manager or root-only with no other deployers.
  4. `HOSTING_REGION` decided with the lawyer, near Bangladesh (in-country, or Singapore / Mumbai).
  5. Uptime and job-age alarms live and tested (one fired on purpose).
  6. `SETU_STAGE` unset; the real bKash and SMS providers; the seed never run.
  7. The queue and worklists paged or narrowed (the load check's miss), and the load check rerun on that host.

