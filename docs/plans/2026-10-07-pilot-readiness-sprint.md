# Pilot-readiness sprint — plan (07/10/2026)

Journeys A, B and C and the phase-2 slices are built and green (447 domain, 375 API, 108 journeys, CI on every push).
Nothing in this sprint adds a feature. Its purpose is that a real clinic can sign in, treat a patient and take money
without the system, the content or the operation being the weak link. Three tracks run side by side; the code track is
Claude Code's, the people track is Kamrul's, the pilot track is both.

Exit criteria (all must hold before a clinic goes live):
1. Every item in track 1 week 1 is merged with its test, CI green.
2. Staging runs on a hosted stack from a production build, with backups restored once in a drill.
3. The clinician, pharmacist and accountant lists are signed off, and the signed-off values replace the samples.
4. Real bKash sandbox and BulkSMSBD credentials have passed journeys K and L against the real endpoints.
5. The pilot clinic is onboarded on staging, its staff trained, and the go/no-go checklist is green.

## Track 1 — code (Claude Code, in this order)

### Week 1: the external review, section A (`docs/reviews/2026-10-04-external-review.md`)
Status on 07/10: A1 is closed for `SESSION_SECRET` only. Still open: A2, A3, A4, A5, A6 and the rest of A1.
- **A1 rest.** Production refuses to start without `DATABASE_URL_APP` (the in-memory demo login must never serve),
  with `AI_PROVIDER=fake`, or with `GATEWAY_TOKEN_KEY` unset once B6 lands. Test: the config module throws for each.
- **A2 hashing.** argon2id for passwords and one-time passwords; PIN = argon2id (or HMAC with a server pepper from env);
  `timingSafeEqual` everywhere; re-hash transparently on the next successful login so seeded accounts keep working;
  seed writes argon2 hashes. Test: no stored hash equals `devHash(value)`; wrong value refused; old hash upgraded on login.
- **A3 login.** Per-IP+phone rate limit (10/min) and a per-user failed-attempt lock in Redis (move the PIN tries there
  in the same change — gap 4); `login` and `login-failed` (phone last 4) audit events written in the handler's
  transaction; cookie `secure` in production. Test: 11th attempt → 429; audit rows exist; owner's audit log shows sign-ins.
- **A4 bKash.** `ask()` returns `status | "unknown" | "unreachable"`; `settled` only on a definite answer; `Completed`
  without a TrxID → reconciliation, never `failed`; sweep skips claims younger than the execute bound (≤ 120 s total);
  inline `status: "failed"` writes go through `transition()`. Tests: refused execute + unreachable query stays pending;
  parallel returns → one execute.
- **A5 blind count.** The cashier's shift responses carry no `cashInPaisa` / `expectedCashPaisa` / digital system
  figures (contract fields optional, filled only for approvers); the first count submission persists `ShiftCount` and
  moves SHIFT `open → counted` before any variance is shown. Tests: cashier `/mine` has no expected figure; a zero-note
  probe leaves a row and an audit event.
- **A6 purchasing decisions 179–186** as written in the review: same-supplier same-day aggregation toward the
  threshold; receipt tolerance min(2 %, ৳50) per line, stored per facility; supplier VAT/AIT recorded as data;
  abandoned counts at shift close; the one self-approval rule (already built for counts — confirm the flag reaches the
  owner's exceptions list); the PO cancel path through `transition("APPROVAL", …)`. Record 179–186 as decided.

### Week 1–2: review section B and the staging prerequisites
- B1 stored lab PDF after withdrawal/correction; B2 critical vital with no doctor assigned → duty doctors; B3 withdrawn
  value blocking an inbox item; B4 ORGANIZATION machine for go-live; B5 first-sign-in through `command()`; B6 gateway
  tokens encrypted with `GATEWAY_TOKEN_KEY`; B7 nightly rollup under an advisory lock, 7 vs 35 days aligned with ADR
  0008; B8 audit the receipt verify and QR routes; B9 `StockMove.seq` for count snapshots, `stock_short` → 409;
  B10 drill-down paging; B11 shift window edge. Section C as time allows (the 62 inline Bangla strings first).
- Gap 10 items: composite `(tenantId, id)` foreign keys; device drafts and outbox encrypted with a session-bound key;
  `pnpm db:migrate` not sending the role password in clear.
- A `system` actor for event-driven steps (decision 317) so "done by" never names a bystander.

### Week 2: staging
- **Production build.** `next build` for `apps/staff` (and `apps/patient` placeholder), the API under a process
  manager, one Docker image per app, `docker-compose.staging.yml`; health checks; structured logs to stdout.
- **Hosting.** Decide the region with the lawyer's note on patient-data residency (Bangladesh-hosted vs Singapore
  ap-southeast-1 — not legal advice, a decision to record in an ADR). Managed Postgres 16 with daily snapshots + PITR,
  Redis, object storage.
- **Storage adapter.** `S3Storage` behind the existing `Storage` interface (works with AWS S3, Cloudflare R2 or MinIO);
  receipts, vouchers, PDFs, prescription photos; private bucket, signed URLs only through the API.
- **Config.** `PUBLIC_APP_URL`, `VERIFY_BASE_URL`, `trustProxy` for the real proxy hops (open question 104), the
  public verify host, CORS, secrets in the host's secret store, `.env.example` completed (review item C).
- **Jobs.** Nightly rollup, payment sweep, message sweep run in exactly one instance (advisory locks, B7).
- **Deploy pipeline.** CI green → build images → `migrate:deploy` → rolling restart; never `migrate dev` or reset;
  a rollback is a redeploy of the previous image with the database left as is (migrations are additive).
- **Backup drill.** Restore last night's snapshot to a scratch database and run the API tests against it, once.
- **Load check.** 20 concurrent staff sessions through journey A on staging; p95 under 1 s for the queue, bill and
  MAR screens; fix what the trace shows.
- **Monitoring.** Uptime on `/health`, error rate, sweep and rollup last-run age, CI badge; an on-call phone for the pilot.
- **Real providers.** bKash sandbox credentials → journey K against `tokenized.sandbox.bka.sh`, settle open questions
  207 and 227 (signature, duplicate-refund codes, `trxId`); BulkSMSBD credentials → journey L against the gateway,
  the delivery-report format and `type=unicode` check; BTRC sender ID registration started (lead time).

### Week 3: prototype catch-up and training material
- A design round in Claude Design for the screens built beyond the handoff: reconcile, refund, pharmacy pay/receipt/
  shift, ward board, MAR with scans, handover, IPD bill, discharge checklist and summary, ER triage board, admission
  desk, approvals with kinds. The prototype is the training deck; it must match the build.
- The `e2e/walk-*.mjs` screenshot sets become the per-role training walkthroughs (Bangla), one PDF per role.

## Track 2 — people (Kamrul; arrange the clinician first, it has the longest lead time)

### Clinician (one or two half-day sessions, with the screens in front of them)
Gaps 12 and 14 and the lab/ward lists: lab analytes, adult ranges incl. men's, children's ranges, critical thresholds,
delta rule, result templates (lipid, urine R/E and C/S, TSH, SGPT); ICD-11 verification of the seeded codes and the
production source; vitals thresholds, NEWS2 bands for OPD vs ward, paediatric ranges; dose formats beyond tablets and a
per-dose cap; high-alert list, insulin sliding scale, daily maxima across regimens, vial discard periods; triage scale
and targets; escalation chain and acknowledgement timeout (default 15 min, duty-doctor fallback); allergy
cross-reactivity and interaction rules; red-flag discharge advice; handover rule 286 (keep or relax); critical-vital
item when no doctor is assigned (B2). Output: a signed list of values that replaces every `sample` row, committed as
seed data with the clinician named in the ADR.

### Pharmacist
Prescription-photo check for OTC Rx items; sale classes; controlled-drug register gaps (own-supply, indent
countersignature, errored dose); substitution rules; label wording; drug database licensing with DGDA numbers
(a purchase decision — the sample list cannot go to a pilot).

### Accountant / tax adviser (not legal or tax advice from this plan — their call)
VAT after discount; Mushak-6.3 once per bill and its layout; one INV series for OPD and IPD; seller BIN per facility;
cashier/approver limits; receipt price tolerance; supplier VAT/AIT treatment; ER fee and ER-to-IPD charges (gap 13);
bed day counted from admission after 23:00 (288); credit notes for refunds.

### Lawyer
AI scribe consent wording; patient-data residency and the hosting region; LAMA form and witness wording; death record
and medico-legal fields; the public verify pages (what may be shown); terms for the patient app before Journey D.

### Providers
bKash merchant onboarding and sandbox; BulkSMSBD account and BTRC sender ID; a label printer the pilot clinic
actually owns (phase-2 ZPL/TSPL only if needed).

## Track 3 — the pilot itself
- **Which clinic.** A Clinic-plan OPD clinic first (Journey A + phase 2), two to four weeks, then a Hospital Lite site
  for Journey B. Pick one whose owner will sit in the owner dashboard daily.
- **Onboarding.** Through `adm/wizard` on staging by the clinic's own admin, with Kamrul beside them; real price list,
  real staff, real BMDC numbers verified; go-live checklist green.
- **Training.** One session per role from the walkthrough PDFs; the E2E clinic on staging as the sandbox; each staff
  member completes their journey once before day 1.
- **Operation.** Daily: owner dashboard review, exceptions list, failed messages, reconciliation queue. Weekly: open
  questions from the clinic recorded in `open-questions.md` with the same numbering. A support phone and a 4-hour
  response promise for the pilot period.
- **Go/no-go checklist** (the exit criteria above plus): backups verified, on-call named, the clinic's data-handling
  consent signed, a rollback plan for the clinic (paper forms for one day) written down.
- **What the pilot measures.** Registration-to-token time, queue accuracy, bill correctness (owner's cash variance),
  SMS delivery rate, the number of override/self-approval flags, and the clinic's own list of "this is wrong".

## Sequencing
Week 1 code (A), clinician and accountant sessions booked. Week 2 code (B, staging), provider credentials, clinician
session held. Week 3 prototype round, training material, pilot clinic onboarding on staging, lawyer sign-off. Week 4
go/no-go, then the pilot starts; phase 4 (patient app, Connected Care) planning runs in parallel from week 3.
