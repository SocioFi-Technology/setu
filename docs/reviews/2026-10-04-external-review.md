# External review — Setu Health at commit e1c717b (04/10/2026)

Read against `CLAUDE.md`. Covers everything since lab session 1: lab session 2, A12–A13, C1–C4, pharmacy (3 sessions),
admin (2 sessions), bKash session 1. Every item below was confirmed in the source at the file:line given.

Work in order: **A** before any pilot or real money, **B** in the next fix session, **C** as housekeeping.
One commit per item; a new state machine or a changed one needs an ADR (CLAUDE.md). Add the test named under each item.

## A. Blocking before the pilot or real money

**A1. Production accepts the published default session secret.** `apps/api/src/config.ts:9`
`sessionSecret: process.env.SESSION_SECRET ?? "dev-only-secret-change-me-in-env-file"`. The cookie carries tenant, facility
and role; seed user ids are guessable. `config.ts:40-44` refuses fake payments/SMS in production but not this.
Fix: in production throw at startup when `SESSION_SECRET` is unset or shorter than 32 characters; also refuse
`AI_PROVIDER=fake` and refuse to start with no `DATABASE_URL_APP` (the in-memory demo login with `setu1234` must never run
in production, `config.ts:13`, `modules/users.ts:38`). Test: config module throws under `NODE_ENV=production` for each.

**A2. Passwords, PINs and one-time passwords are unsalted SHA-256.** `apps/api/src/modules/users.ts:14`
`devHash = createHash("sha256").update("dev-only:" + s)`. A database read reveals every 4-digit PIN at once; the admin
slice now routes OTPs and first-sign-in through it. HANDOVER gap 3, now overdue.
Fix: argon2id for password and OTP; PIN = argon2id or HMAC with a server pepper from env; compare with `timingSafeEqual`;
re-hash on next successful login so the seed keeps working. Test: stored hash is not `devHash(value)`; wrong value refused.

**A3. Login has no rate limit, no lockout and writes no audit event; cookie is not `secure`.**
`apps/api/src/app.ts:32` `rateLimit, { global: false }` and `routes/auth.ts:14` carries no `rateLimit`. `plugins/audit.ts:12`
returns early when there is no session, so the `login` audit on `auth.ts:14` never fires (the owner's "sign-ins" view in
`modules/admin.ts:329` is therefore empty). `auth.ts:41,78` cookie options lack `secure`.
Fix: per-IP+phone limit (e.g. 10/min) and a per-user failed-attempt counter in Redis beside the PIN tries (gap 4 — move
`modules/pin.ts:6` Map to Redis in the same change); write `login` and `login-failed` (phone last 4) AuditEvents inside the
handler's transaction; `secure: NODE_ENV === "production"`. Tests: 11th attempt → 429; audit rows exist.

**A4. bKash: a refused execute plus an unreachable status query fails a payment bKash may have completed.**
`apps/api/src/adapters/payments/bkash.ts:150-152`: `ask()` returns `null` for both "unknown" and "network error", and
`settled: true` is forced for any error code outside `["2062","2117","503","9999"]`; `modules/billing.ts:941,969` then runs
`fail`. Contradicts the docblock.
Fix: `ask()` returns `status | "unknown" | "unreachable"`; `settled` is false on unreachable so the sweep re-asks later.
Related in the same commit: `packages/domain/src/wallet.ts:78` — `Completed` without a TrxID currently fails the payment;
it must open reconciliation (`outcome: "mismatch"`). `wallet.ts:12` `STUCK_MINUTES = 5` is shorter than the worst-case
execute path (`packages/db/src/index.ts:86` token lock `maxWait 150_000` + two 30 s auth calls + execute): bound the whole
execute to ≤ 120 s and have `payment_sweep_targets` skip claims younger than that bound. `billing.ts:698` and `:1068` write
`status: "failed"` inline — use `transition("PAYMENT", PAYMENT, "initiated", "fail")`. Tests: refused execute + unreachable
query leaves the payment pending; Completed without TrxID → reconciliation case; parallel returns → one execute.

**A5. The "blind" cash count is only blind on the screen.** `apps/api/src/modules/shift.ts:46-49` builds
`live = { cashInPaisa, expectedCashPaisa, … }` for the open shift and returns it to the cashier on `GET /v1/shifts/mine`
and `/v1/shifts/:id` (`Shift.tsx:109` just doesn't render it; `owner.test.ts:40` reads it). And `shift.ts:93-94`: a count
with zero notes answers `422 reason_required { amountPaisa: variance }` and rolls back, so the variance can be probed with
nothing recorded.
Fix: when the caller is the shift's cashier and not an approver, return `live` without `cashInPaisa` /
`expectedCashPaisa` / digital system figures (contract fields optional); the first count submission must persist the
`ShiftCount` row and move SHIFT `open → counted` before any variance is revealed, the reason + `close` is a second call.
Tests: cashier's `/mine` has no expected figure; a zero-note count leaves a row and an audit event.

**A6. Kamrul's pharmacy decisions on questions 179–186 were never recorded or built.** `docs/open-questions.md:780-795`
still asks them; code: `apps/api/src/modules/purchasing.ts:184` checks one order only (no same-supplier same-day
aggregation); `packages/domain/src/purchasing.ts:52` `priceVariance = costPaisa !== orderCostPaisa` (no tolerance);
no supplier VAT/AIT recorded; `purchasing.ts:447` + `stock_count_guard` refuse self-approval outright.
Decisions (Kamrul, 03/10/2026): (1) purchase orders to the same supplier on the same Dhaka day count together toward
the ৳50,000 threshold; the order that crosses it needs approval and the Task detail names the earlier orders. (2) Receipt
price tolerance per line = min(2% of the ordered price, ৳50), accepted by the pharmacist with the difference shown; above
it owner/admin; tolerance stored per facility (default as stated; accountant pre-pilot list). (3) Supplier VAT/AIT is
recorded as data from the supplier's invoice — per-supplier flag included / on top / exempt, and the amounts as printed —
never computed; stock cost per unit = landed net cost; accountant pre-pilot list. (4) Counting does not stop sales (as
built); a count undecided at shift close is marked abandoned, kept, audited, nothing posted. (5) Self-approval of a count
is refused when another approver exists; with exactly one approver at the facility it is allowed with a mandatory note,
flagged `self-approved` on the count, in the audit and on the owner dashboard's exceptions list. Also `purchasing.ts:224`
writes Task `status: "rejected"` inline with the requester as decider — go through `transition("APPROVAL", …)`, record the
withdrawal honestly (ADR addendum if a `withdraw` event is added). Tests for each decision; record 179–186 as decided.

## B. Next fix session

**B1. A stored lab-report PDF is re-served clean after a value was withdrawn or corrected.**
`apps/api/src/modules/documents.ts:177-181` refuses only when `labReportPrintBlockers` blocks, and that blocks `superseded`
only; withdraw/correct leave the version current, so copy 0 (value un-struck, no "do not act") is handed out via
`/v1/documents/prints/:id/pdf`, audited as `view` not `reprint`. Fix: for `lr`, refuse with 409 `content_changed` when any
result is `underCorrection || withdrawn`, or re-render; audit stored-PDF downloads as `reprint`. Test added.

**B2. A critical vital on a visit with no doctor assigned reaches nobody.** `apps/api/src/modules/vitals.ts:134-136`
`if (e.practitionerId)` gates the inbox item (`doctor.test.ts:226` codifies it). Fix: write the item to the duty doctor /
every doctor on today's queue at the branch, or create it when the visit is later assigned; clinician to confirm the
escalation rule (pre-pilot list). Test: SpO₂ 88 before assignment → someone is told.

**B3. A report inbox item is blocked for ever by a withdrawn value.** `apps/api/src/modules/doctor.ts:78`
`correctionPending` is true for any `entered_in_error` result, including withdrawn with no replacement; `Inbox.tsx:108`
says "under correction". Fix: distinguish withdrawn (as `labReportView` does, `lab.ts:180`); allow acknowledgement; label
"withdrawn — no result". `documents.ts:206-214` + `verify/rx/[code]/page.tsx:40-42`: the public page lists medicines for a
withdrawn prescription — omit them.

**B4. Facility go-live is an inline status write with no machine.** `apps/api/src/modules/admin.ts:128`
`data: { status: "live", liveAt: now }`; `admin.ts` has no `transition(` call. Fix: ORGANIZATION machine `setup → live`
(ADR 0010 addendum) and use it; the DB guard already refuses live → setup.

**B5. First-sign-in bypasses `command()` and the generic idempotency key has no user.**
`routes/auth.ts:60` writes password/PIN hashes outside `command()`; `plugins/idempotency.ts:16-21` keys on
`${tenantId}:${url}:${key}` and answers before authorisation, so a replay can return another user's `Me`. Fix: route
first-sign-in through `command()` (or require a key and include `userId` in the generic key); exclude auth routes from the
generic plugin.

**B6. Gateway tokens are stored in clear.** `20261004200000_bkash_checkout/migration.sql` `GatewayToken.idToken /
refreshToken`; the app role is kept out, but the 30-day refresh token is readable by the owner role and in dumps. Fix:
encrypt in `withGatewayToken` with a key from env (`GATEWAY_TOKEN_KEY`, refused if unset in production). Also `withGatewayToken`
holds a transaction and advisory lock across up to two 30 s HTTP calls (`db/src/index.ts:75-86`) — shorten `maxWait`.

**B7. Nightly rollup runs once per API instance with no lock; ADR says 7 days, code recomputes 35.**
`routes/owner.ts:95-110`, `owner.ts:120-135`. Fix: `pg_try_advisory_lock(hashtext('nightly-rollup'))` on the base
connection, skip when held; align the window with ADR 0008 (or amend it). Lab TAT tile is a mean, ADR says median
(`owner.ts:59,173`).

**B8. Two public/PHI reads are not audited.** `routes/billing.ts:359` `/v1/verify/rc/:code` (rx and lr verify call
`auditPublicView`, `documents.ts:84,93`; receipts don't) and `routes/billing.ts:412` `/v1/payments/:id/qr.svg`
(`audit: []`, reads a patient's payment and bill). Fix: audit both.

**B9. Stock count snapshot race and stock-short errors.** `modules/purchasing.ts:410` reads `qtyOnHand` without a lock and
`expectedQty` (`:372`) filters moves by wall-clock `at`, so a dispense that committed after the snapshot but with an
earlier `at` is missed on both sides and the approved adjustment understates stock. Fix: `seq BIGSERIAL` on `StockMove`,
store `sinceSeq` on the count. `pharmacy.ts:244-246`: the DB correctly refuses a second last-unit take but
`app.ts:37-49` maps the PL/pgSQL RAISE to 500 — map `StockMove:` raises to 409 `stock_short`. `purchasing.ts:461`: a
null count reason becomes `"count: "` (< 10 chars) and trips the DB CHECK → 500; fall back to a fixed text.

**B10. Owner drill-downs cap at 200 rows with no paging** (`owner.ts:225,254,285`; `collections` loads every payment id).
Fix: cursor on `(at, id)`; keep the aggregate for totals.

**B11. Shift edge: a payment confirmed while the count runs can belong to no bucket** (`shift.ts:87,102` vs leakage SQL
`owner.ts:75-77`). Fix: compute `windowTo` after the sum with `max(confirmedAt)`, or lock the cashier's initiated payments.

## C. Housekeeping

- 62 user-facing Bangla literals outside `packages/i18n` in 22 staff files: `components/Shell.tsx:30-91`,
  `app/login/page.tsx:27-35`, `lib/api.ts:26,44`, `lib/outbox.ts:36,119`, `modules/fd/common.tsx:71-81`,
  `modules/ph/Dispense.tsx:108`. Move to `shellApp` / `loginApp` namespaces (gap 9).
- Half-compliant status writes (transition called, literal written): `consultation.ts:202,326,334,436` — write the
  transition's result.
- `routes/billing.ts:993` `q.signature === p.providerSignature` → `timingSafeEqual`. `bkash.ts:78` re-POSTs
  `payment/execute` after a 401 — guard on the token-error body shape. `bkash.ts:52,68` a valid token with < 5 min left is
  thrown away when the hourly budget is spent — use it until expiry.
- `command.ts:79` runs `after` (link creation) only on fresh requests; the stored replay keeps `payUrl: null` — update
  the stored response after `after`.
- `modules/admin.ts:115-117` test SMS to any number, unlimited → 3/hour per facility. `admin.ts:311` `doctor_active`
  checks `active` only, not the current role. `admin.ts:152` `activeApprovers` excludes pending-OTP approvers.
- `.env.example` is missing `VERIFY_BASE_URL`, `VERIFY_DOC_ROOT_URL`, `STORAGE_DIR`, `CHROMIUM_PATH`, `BKASH_TIMEOUT_MS`,
  `BKASH_STANDIN_PORT/HOST`; `REDIS_URL` and `S3_*` are documented but never read.
- `print/clinical.ts:142` ℞ (U+211E) is outside both embedded fonts' ranges → use an SVG or add the glyph.
- `lab.ts:669-678` withdraw always rejects the tube; ask "specimen problem?" first.
- Tests without a file of their own: `modules/pin.ts`, `users.ts`, `shift.ts`; domain `money.ts`, `catalog.ts`.

## Tests the reviewers found missing (add with the item they belong to)
bKash: parallel returns; mismatch at execute; bill voided between link and return; sweep confirming a Completed payment;
Completed without TrxID; overlapping sweeps. Admin: replay of create-user hides the OTP; OTP past 24 h; role change to/from
owner via `/role`; CSV cell starting with `=`; go-live by admin, live→setup refused. Shift: cashier response without
expected; zero-note probe; cash while `closed`; midnight-spanning shift; owner of A sees nothing of B. Pharmacy: parallel
last-unit dispenses; count during an in-flight dispense; duplicate supplier invoice; photo > 3 MB. Lab/doc: storedPdf
after withdrawal; concurrent prints; print replay same copy; verify 429.

## Done well (so it stays that way)
RLS loop on every tenantId table and all 42 migrations in order; ledger integrity enforced in the database
(`stock_move_apply`, append-only moves, backed receipts/counts/transfers); FEFO server-side; dispense tied to the current
signed version; billing CHECKs redo the paisa arithmetic; bKash claim under the bill lock with `execute:<ref>` dedupe and
no amounts from the request; verify lookups return initials and age only; OTP single-use with generation precondition;
"owner anywhere" guard; CSV neutralised; SHIFT / RESULT / LAB_REPORT / COMMUNICATION all through `transition()` with DB
triggers; no float arithmetic on money anywhere.

## Consolidated pre-pilot list (people, not code)
Clinician: lab ranges/thresholds/delta, men's and children's ranges, result templates (116), ICD-11 verification,
drug database with DGDA numbers and allergy/interaction rules, vitals thresholds and paediatric ranges, dose formats and
per-dose cap, critical-vital escalation rule when no doctor is assigned (B2). Pharmacist: prescription-photo check, sale
classes, controlled register, substitution rules, label wording. Accountant: VAT after discount, Mushak-6.3 once per bill
and layout, cashier/approver limits, seller BIN, receipt-price tolerance (A6-2), supplier VAT/AIT treatment (A6-3).
Lawyer: AI scribe consent wording. Engineering before staging: A1–A5, S3 storage adapter, bKash sandbox credentials and
the open signature question (207), SMS gateway (session 2), composite tenant FKs and encrypted device drafts (gap 10).
