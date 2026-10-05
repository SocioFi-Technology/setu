# Handover to Claude Code — state of the project on 03/10/2026 (slices A1–A3, A4–A5, A6–A7 + billing follow-ups done; A8–A11 done; A12–A13 done — Journey A complete; phase 2 slice C1–C4 done; pharmacy slice done; admin slice done (04/10/2026); SMS + bKash slice done (04/10/2026) — Phase 2 pilot-clinic slices complete; refunds slice done (05/10/2026); slice B1–B2 done (05/10/2026, two sessions); next: see Next)

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

## Done (slice A1–A3, 02/10/2026) — front desk ✅
Status: **done**. Search, duplicate review, registration and queue work end to end on the real stack as `setu_app`; all checks green (see Tests).
- **Database role — known gap 1 (RLS bypassed) is closed:** the API connects as `setu_app` (no superuser, no BYPASSRLS) via `DATABASE_URL_APP`; migrations and the seed keep the owner `DATABASE_URL`. `pnpm db:migrate` sets the role's password from `DATABASE_URL_APP`. Login's only pre-tenant read is the `auth_login_lookup` SECURITY DEFINER function. `apps/api/test/tenancy.test.ts` proves a wrong `app.tenant_id` returns no rows.
- **One transaction per request:** `apps/api/src/command.ts` — `command()` (write + audit + idempotency key together; key required) and `query()` (read + view audit).
- **Rules** in `@setu/domain`: `patient.ts` (registration validation, normalisation, Same/Similar/Different/Missing comparison, link rules) and `queue.ts` (A-017 tokens, Dhaka day, board = view of ENCOUNTER). No new state machines: visits use ENCOUNTER, duplicate review is a `Task` through APPROVAL, identity confidence changes with a `Provenance` row.
- **Models:** `Encounter` (token attributes, per-branch daily `Sequence`), `Task`, `Provenance` (append-only), `Tenant.patientNoPrefix`, Patient approx-age fields. Seed: Mirpur branch, the walkthrough family on 01711-234567, plan-demo tenants (Clinic nurse 01722000004, Lite doctor 01733000002).
- **API:** search, matches, match-preview, match decisions + undo, register, create visit, queue, queue actions, duplicate-review queue, admin unlink, admin keep (`packages/contracts/src/frontdesk.ts`, `openapi.json`).
- **Screens:** `fd/search`, `fd/match`, `fd/register`, `fd/queue` in `apps/staff/modules/fd/`; strings in `packages/i18n/locales/app/frontDeskApp.json`; offline outbox `apps/staff/lib/outbox.ts` (pending writes show "not synced", the shell's sync count reads it).
- **Tests:** domain 49, api 44 (incl. 26 front desk + cross-tenant, 6 transaction/idempotency), i18n 3, contracts 2; Playwright 24 (13 shell + 11 `a1-a3.spec.ts`), green twice in a row on 02/10/2026.
- **Reviews:** security and clinical-safety reviews ran on the slice; fixes landed, the rest is in `docs/open-questions.md` 17–24.
- **Decision 16 (Kamrul, 02/10/2026): "Link anyway" stays immediate**, with admin after-the-fact review:
  - `fd/match` with no patient is the **duplicate-review queue**: open "Send for review" items and links made with "Link anyway", shown as **"Linked with override"** until an admin reviews them.
  - Admin **Unlink** (on the queue and on a linked patient's record): reason ≥10 characters, record becomes `unverified`, Provenance `unlink`, audited; the desk's Undo cannot reach back past it. Admin **Keep link — reviewed** takes it off the queue (Provenance `link-reviewed`). The Task stays `approved` (APPROVAL has no way back); the outcome is stored in `Task.detail.review`.
  - Visits opened on the linked record between link and unlink stay where they are (open question 17).
- **Hands-on walkthrough (02/10/2026)** as receptionist 01711000001 through search → duplicate review → register → queue in the browser; 10 issues found and fixed (see commit "A1-A3: fixes from the hands-on walkthrough").
- Decisions and rules chosen in this slice: `docs/open-questions.md` — please read and confirm.

## Done (slice A4–A5, session 1 of 3, 02/10/2026) — follow-ups + vitals (A4) ✅
Plan agreed with Kamrul: two sessions (decision D5). Decisions D1–D4 and items 25–44: `docs/open-questions.md` (A4–A5).
- **A1–A3 follow-ups (open questions 17, 18, 19, 22, 23):**
  - Undo of a desk decision: only its maker or an admin; undoing a "Link anyway" needs a reason (≥10); a dialog lists
    the visits opened on the linked record since (they stay there). `GET /v1/patients/:id/matches` returns `lastDecision`.
  - ADR 0002: Provenance source `desk-decision` for link / link-anyway / review / different / undo / unlink / reviewed.
  - Match preview on the register screen returns name, patient no., age and sex only.
  - Refused offline writes show in the top bar as "N couldn't sync — check" with the server's reason (`RefusedSync`).
  - No own phone: phone owner Guardian / Family / Other needs that person's name and relationship; stored on the
    RelatedPerson.
- **ADR 0003** (D1): DOCUMENT gains `draft --signAmendment--> amended`; used in session 2.
- **Vitals (A4):** `@setu/domain` `vitals.ts` (impossible / critical / high / low, BMI Asian cut-offs) shared by screen
  and API; `Observation` model (append-only for `setu_app`, RLS); `GET /v1/vitals/worklist`, `GET|POST
  /v1/encounters/:id/vitals`; first batch moves the token Waiting → Vitals done; screen `fd/vitals` (worklist → entry),
  outbox when offline; queue has a "Record vitals" shortcut for nurse/receptionist. Seed: Rahima Khatun's 12/08/2026
  visit with vitals (Green Life + E2E), E2E nurse 01799000004.
- **ADR 0003 guard** in `@setu/domain` `signDocument` (`documents.ts`): only a draft that amends another version, with
  a reason, signs to `amended`.
- **Reviews:** security (pass, 4 medium / 4 low) and clinical safety (glucose mg/dL slip, BP flags, offline ordering,
  unit hints, BMI, child labels, outbox expiry) — fixes landed; the rest is `docs/open-questions.md` 45–51.
- **Kamrul's decisions on 45–49 (same day):** default thresholds = prototype + adult NEWS2 (labelled pending clinician
  sign-off); "Critical vital sign" flag on the queue card; earlier readings from the owner's other branches shown
  read-only with the branch name; undoing a Link anyway turns its admin-queue entry into "Link undone + reason".
- **Hands-on test (02/10/2026)** in Green Life as receptionist 01711000001 → nurse 01711000004 at tablet 1024 px:
  pulse 300 blocked (screen + API 400), glucose 40 needs the re-checked tick, language switched to English mid-entry
  (values and tick kept), saved only after server confirm, the queue card showed "Critical vital sign"; the visit was
  then marked no-show (Green Life keeps one A-001 no-show and that vitals batch for 02/10/2026). Found and fixed:
  sign-out returned 500 (the client sent an empty JSON body; the API now answers Fastify client errors as 4xx);
  the top bar overflowed at 1024 px (toggles squeezed, page scrolled sideways); the glucose warning ran past its card.
  Regression specs added (shell: sign-out, tablet top bar in bn and en; a4: warning stays inside the card).
- **Tests:** domain 78, api 66, i18n 3, contracts 2; Playwright 32 (16 shell + 12 `a1-a3` + 4 `a4`) with plain
  `pnpm e2e`, green twice in a row on 02/10/2026.

## Done (slice A4–A5, session 2 of 3, 02/10/2026) — consultation backend (A5 plan steps 1–6) ✅
Plan agreed with Kamrul the same day, split after step 6 (decision 2): **session 3** does the screens, the journey spec,
the reviews and the hands-on test. Kamrul's decisions for this session: open questions "Session 2 — decided by Kamrul".
- **Rules in `@setu/domain`** (screen and API call the same functions):
  - `catalog.ts`: the prototype's sample lists — 10 ICD-11 codes flagged `unverified-prototype`; 15 medicines labelled
    sample with ingredient and class keys (no DGDA numbers, no prices); orderable tests incl. CBC, RBS, S. Electrolytes
    (for the A6 bill); the demo interaction (Clopidogrel + Omeprazole) and duplicate-class (PPI) rules.
  - `prescription.ts`: `rxWarnings` / `rxBlockers` — allergy (by class or ingredient; Remove only), same medicine (by
    generic ingredient, Seclo = omeprazole; Remove or Keep both), same class, interaction acknowledge, dose and days.
  - `consultation.ts`: `signBlockers` (Rx + complaint + diagnosis + AI "I reviewed" tick + free-text-allergy check +
    amendment reason), `consultAccess` (decision 28; only a doctor starts the visit; re-open is a no-op),
    `parseComplaint`.
  - **ADR 0004** + `ALLERGY` machine (`active → entered-in-error`).
- **Database** (migration `consultation`): sample catalogues per tenant (read-only for `setu_app`), AllergyIntolerance,
  Composition (one row per version), Condition, MedicationRequest, ServiceRequest; RLS on all. **Triggers for every
  role:** a signed note is never edited or deleted (only final/amended → superseded/entered-in-error); diagnoses and Rx
  lines change only in a draft; a placed order is never edited or deleted; an allergy is never deleted or edited (only
  active → entered-in-error with who, when and a reason ≥10). One draft and one current version per visit (partial
  unique indexes). Seed: catalogues in all 4 tenants; Rahima Khatun's Penicillin (rash) and Sulfa allergies and her
  signed 12/08/2026 note (5A11, BA00; Comet, Seclo, Amdocal) in Green Life and the E2E clinic; E2E doctor 2 (01799000003).
- **API** (`apps/api/src/modules/consultation.ts`, `routes/consultation.ts`, `packages/contracts/src/consultation.ts`):
  catalogue search (bn/en), worklist, consultation view (versions, allergies, current medicines and past diagnoses from
  earlier signed notes, critical-vitals flag), open, save draft, sign, amend, AI draft, record allergy, mark
  entered-in-error. **Sign** = PIN checked inside the transaction (shared 5 tries / 15 min, `modules/pin.ts`) →
  `signBlockers` re-run on the server's data (422 `sign_blocked`) → `signDocument` (DOCUMENT) → orders `order`
  (ORDER) → visit `finish` (ENCOUNTER) → Provenance for the note, every item and every reviewed AI section. Nothing is
  final until that commits; there is no client-side "signed". **Amend** = new version (v+1) copying v1; signing it
  supersedes v1 first, then signs v2 `amended`, in one transaction (ADR 0003). The PIN is never stored, not even in the
  idempotency hash (`command(…, { hashOmit: ["pin"] })`). FakeAi adapter (`apps/api/src/adapters/ai.ts`) builds drafts
  only from the patient's own record. A state-machine refusal now answers 409 `invalid_transition` (was 500).
- **Tests:** domain 111 (+33), api 83 (+17 in `consultation.test.ts`: care relationship, cross-tenant, screen-and-API
  same blocker, Napa + Ace, wrong PIN / lock, AI tick, free-text allergy, final only after the server, orders placed,
  queue Done, replay, PIN not stored, DB refuses edits to a signed note, amend v1 → superseded, allergy
  entered-in-error), contracts 2, i18n 3; `pnpm typecheck` 13/13. The API suite was green twice in a row.
  **Playwright was not re-run this session** (no screen changed; the local server check was not available to Claude) —
  run plain `pnpm e2e` at the start of session 3; 32 specs were green at the end of session 1.
- Note on history: commit `dbc5a5d` (step 4) does not build on its own — its service file imports `adapters/ai.ts` and
  `modules/pin.ts`, which arrived one commit later in `38a2c1c` (step 5). Every later commit builds.

## Done (slice A4–A5, session 3 of 3, 02–03/10/2026) — consultation screens (A5 plan steps 7–10) ✅
Slice A4–A5 is **done**. Kamrul's decisions for this session: hands-on test in the E2E Test Clinic (penicillin on
Karim); the E2E reset never deletes and never switches a safety trigger off (open questions, session 3).
- **Screens** (`apps/staff/modules/cons/`, registered in `registry.tsx`, strings in `locales/app/consultApp.json`):
  - `cons/draft` without `?enc` = today's list (with doctor → waiting, critical first → completed); with `?enc` = the
    note: complaints (`parseComplaint`, bn digits), history, exam, vitals read-only with flags, diagnosis search bn/en
    (provisional by default, "code not verified (sample list)"), test orders (placed ones locked), Rx builder
    (`Rx.tsx`: `rxWarnings` as the doctor types — allergy Remove only, same medicine Remove / Keep both, same class,
    interaction Acknowledge, dose and days; footnotes "sample list" and "tablet/capsule counts only"), allergy strip
    (`Allergies.tsx`: Record allergy, Entered in error with a reason ≥ 10; never NKDA), AI panel (`Ai.tsx`: "draft — not
    a diagnosis", inserted text marks the section ai-draft; the scribe consent tick is disabled "not available yet"),
    current medicines and past diagnoses, sign sheet (`SignSheet.tsx`).
  - `cons/signed` (server-confirmed time, signer, registration only when stored with "not verified", Amend) and
    `cons/amended` (every version with its status, reason, "Replaced by vN").
  - Keys: "/" focuses the Rx search outside a text box (#9), Ctrl+Enter opens the sign sheet, Alt+1…9 sections, Esc.
- **Rule 1 on screen:** autosave with check-and-set on `rev`; the status reads "Not yet synced" until the server
  answers; the sign sheet says "Waiting for server — still a draft" until the API answers; there is no client-side
  signed state; offline: "Draft on this device — not sent", Sign disabled "Sign when back online".
- **Device drafts** (`apps/staff/lib/outbox.ts`): per user + tenant + facility, at most 24 h from the first unsent
  change (then a listed "not sent" line without the text), replayed with their base rev (409 keeps a conflict copy,
  never overwrites the server), schema-checked before sending or loading; sign-out sends them first and asks before
  deleting any; an expired session clears them; leaving the editor keeps unconfirmed text on the device.
- **API fix:** two opens at the same moment (double click) were a 409; the doctor's own winning open is now the
  ordinary re-open (test added). `@setu/domain` `format.dose`: 0+0+0 is not a dose (screen and sign route).
- **E2E reset** (`packages/db/src/reset-e2e.ts`): allergies runs recorded on the family → entered-in-error (Rahima's
  seeded two recorded again if needed), leftover visits closed via ENCOUNTER cancel / markError, as the E2E admin,
  audited; refuses a non-local database unless `E2E_RESET_ALLOWED=1`. First run closed 385 leftover test visits.
- **UI package:** Callout has a danger tone and passes attributes; the patient banner wraps at tablet width.
- **Reviews:** clinical safety (verdict FAIL on three ways to lose edits — all fixed: conflict copy, confirm before
  loading it, sign-out warning; plus 0+0+0, stale allergies, leave-the-screen copy, reset actor) and security (pass;
  medium items fixed except draft encryption → pre-pilot gap 10). Open questions 68–82.
- **Hands-on test (03/10/2026)** as doctor 01799000002 at 1024 px on Karim: penicillin recorded from the strip;
  amoxicillin blocked on screen, on the sign sheet and by the server (422); "/" → Rx search; Napa + Ace → Keep both;
  wrong PIN ("4 tries left", still a draft) then the right PIN with the same Idempotency-Key → signed; amended (Ace 3 →
  5 days), v2 "Amended", v1 "Superseded — replaced by v2"; Completed on the desk's queue. Found and fixed: finished
  visits listed before the waiting patient, the entered-in-error list repeating "Penicillin" seven times, no inner
  padding in the new dialogs (regression specs added).
- **Tests:** domain 111, api 84 (+1 concurrent open), contracts 2, i18n 3; typecheck 12/12 plus `@setu/db` tsc
  (its `prisma generate` step fails with EPERM while the API dev server holds the Prisma engine — stop the API to run
  the full `pnpm typecheck`); Playwright **43** (16 shell + 12 `a1-a3` + 4 `a4` + 11 `a5`), green twice in a row on
  03/10/2026.

## Done (slice A6–A7, session 1 of 2, 03/10/2026) — billing backend ✅
Plan agreed with Kamrul the same day (decisions D1–D8 and the additions: open questions "Slice A6–A7 session 1").
**Session 2** does the billing screens, the receipt PDF (Storage interface + local-folder adapter, Playwright Chromium,
QR, Mushak-6.3, amount in words), reprint with DUPLICATE watermark, the verify endpoint, the A6–A7 journey spec, the
reviews and the hands-on test as the cashier.
- **Housekeeping:** `.gitattributes` (`* text=auto eol=lf`); `*.tsbuildinfo` ignored and untracked.
- **Money rules** (`@setu/domain` `billing.ts`, `money.ts`): integer paisa everywhere; one rounding rule
  (`divHalfUp`, half-up to the paisa, integer only); line = gross → its share of the bill discount (largest
  remainder, sums exactly) → net → VAT on the net → total; bill totals are sums of line paisa; cashier limit, approval,
  issue blockers, pending wallet amounts reserved, "Paid by" from confirmed money only (issue #10), provider-callback
  decision (repeat = noop, backwards / out-of-order = refused, money on a failed link → reconciliation).
  `format.wordsPaisa`. The walkthrough bill (৳2,300, words bn + en) was proved by a unit test before any route.
- **Database** (migrations `billing` + `billing_guards`): ChargeItemDefinition (sample price list, read-only for
  setu_app), Invoice, ChargeItem, Payment, ProviderEvent; Organization BIN + limits. RLS on all; CHECKs redo the paisa
  arithmetic; triggers: lines only in a draft, an issued bill is frozen, issue refused while a discount Task is
  requested / with unpriced lines / when totals ≠ line sums, paid = sum of confirmed payments, PAYMENT transitions
  only and nothing out of confirmed, bills and payments never deleted; `payment_ref_lookup` (SECURITY DEFINER) for
  callbacks. Seed: price list in all 4 facilities (consultation ৳800 per doctor, CBC 450, RBS 150, S. Electrolytes
  900, desk card / certificate at 15%), sample BIN, **E2E cashier 01799000008**.
- **Payments adapter** (`apps/api/src/adapters/payments`): `PaymentProvider` + `FakeProvider` (HMAC-signed callbacks,
  verify by reference or TrxID, cancel before retry, `simulate` for the customer's side). `FAKE_PAYMENTS_SECRET` in
  `.env.example`.
- **API** (`modules/billing.ts`, `routes/billing.ts`, `packages/contracts/src/billing.ts`, openapi regenerated):
  billing worklist, price-list search, bill from a finished visit, desk lines, discount / remove, approvals list /
  approve / reject, issue (INV/yy/nnnn per facility per year), payments (cash, card, bank, bKash, Nagad), retry,
  TrxID check, provider callback, and — dev/test only — `POST /v1/dev/fake-payments/:id/:kind`.
- **Tests:** domain 139 (+28), api 106 (+4 adapter, +18 billing contract tests), contracts 2, i18n 3; `pnpm typecheck`
  13/13. The API suite was green twice in a row. **Playwright was not run this session** (no screen changed) — run
  plain `pnpm e2e` at the start of session 2; 43 specs were green at the end of A4–A5.
- Note on history: the migration `20261002190221_billing` was applied by `prisma migrate dev --create-only` (it
  applies pending migrations first) before its SQL could be appended; the guards are in `20261002190302_billing_guards`.
  An empty migration created along the way was removed before any commit. **Create a migration with
  `--create-only` only when nothing is pending**, then append, then apply.

## Done (slice A6–A7, session 2 of 2, 03/10/2026) — billing screens, receipt PDF, reprint, verify ✅
Slice A6–A7 is **done**. Kamrul's decisions for this session: open questions "Decisions of 03/10/2026 on items 83–93"
and "Slice A6–A7 session 2".
- **Receipts (backend):** `Storage` interface + `LocalFolderStorage` (`apps/api/src/adapters/storage.ts`; root
  `STORAGE_DIR` or `<repo>/var/storage`, gitignored, write-once keys) — **HANDOVER gap 2 closed for dev**. Migration
  `receipts`: `Receipt` (immutable copy of the bill at that moment, RCPT/yy/nnnn per facility per year from Sequence in
  the same transaction, 20-character random verify code) and `ReceiptPrint` (copy 0 = original, n = DUPLICATE #n with
  a reason; append-only); triggers refuse every update/delete; `receipt_verify_lookup` (SECURITY DEFINER) returns
  facility, number, date, amount only. Migration `payment_superseded_index` restores the GIN index the receipts
  migration had dropped (now declared in `schema.prisma`).
- **PDF:** HTML → PDF with the Playwright Chromium already installed (`playwright-core` 1.63.0, already in the
  lockfile; network blocked, page JavaScript off, fonts inlined from `packages/ui`); QR via `qrcode-generator` 2.0.4
  (0.56 MB, no dependencies). `apps/api/src/receipts/template.ts`: A5 (Mushak-6.3 title, BIN marked sample and VAT by
  rate **only on the receipt that settles the bill**; part-payment receipts are money receipts) and 80 mm thermal;
  Bangla + English / Bangla / English; amounts from paisa; "Amount received in words" via `format.wordsPaisa`; "Paid
  by" = confirmed money with TrxID / reference, pending wallet amounts marked pending; duplicates "অনুলিপি · DUPLICATE
  #n" + 10% diagonal watermark + reprint line; everything from the record HTML-escaped. `CHROMIUM_PATH` for servers.
- **Routes:** receipts list / create (same receipt while no new confirmed money) / view / print (original; then only
  with a reason: lost, jam, corp, ins) / stored PDF, audited print / reprint / view; public `GET /v1/verify/rc/:code`
  (no session, 20 per minute per visitor, no-store); `POST /v1/payments/:id/cancel` ("Cancel link": confirms money that
  did arrive, else cancels the link and PAYMENT fail). `VERIFY_BASE_URL` sets what the QR opens.
- **Screens** (`apps/staff/modules/bill/`, strings `locales/app/billingApp.json`): `bill/opd` (today's finished
  visits newest first → the bill: lines with source and VAT, desk services, discount with the domain's preview,
  approval waiting / approved / rejected, Issue, view-only for the receptionist), `bill/pay` (cash with change, card /
  bank reference, bKash / Nagad link with polling, TrxID check, Cancel link, resend, test-only fake-gateway buttons,
  "Paid by", receipt button; offline: outbox, provisional cash receipt with no number / no QR / "PROVISIONAL — not
  synced" on every page, queued money counts against "Still to take", refused payments keep their amount; stale data
  pauses taking payment), `bill/receipt` (copy, language, paper, Print → Reprint with reason, print audit),
  `bill/approvals` (owner/admin; A / R; never your own request); public page `/verify/rc/[code]` (no login).
- **Fake gateway route** `POST /v1/dev/fake-payments/:id/:kind` only with `FAKE_PAYMENTS_DEV_ROUTE=1` (set in
  `.env.example`, the local `.env` and `apps/api/vitest.config.ts`) and never in production; a production API refuses
  `PAYMENTS_PROVIDER=fake`.
- **Reviews:** security (1 high — the dev route; 1 medium — superseded race; 4 low) and money / clinical safety (3 high
  — a test added twice at the desk, a wallet link stuck pending, offline cash collected twice / refused silently; 5
  medium; lows) — all fixed except M1 (unpriced tests) and M4 (revoked orders), see open questions 94–106.
- **Hands-on test (03/10/2026)** as cashier 01799000008 in the E2E clinic (bill A-582 grown to ৳10,600 with desk
  items so ৳500 was within the ৳500 limit; walkthrough bill A-583 ৳2,300): ৳500 within limit applied at once (line
  shares summed to exactly ৳500.00); ৳500 above the ৳115 limit → approval request → total stayed ৳2,300, issue blocked
  → approved as owner 01799000009 → ৳1,800 (shares 173.91 / 97.83 / 32.61 / 195.65); cash ৳10,100 from ৳10,500 →
  change ৳400; bKash ৳1,000 confirmed by the fake callback; bKash ৳800 with the callback lost → confirmed with the
  TrxID; receipt RCPT/26/0029 printed, reprinted "patient lost it" → DUPLICATE #1 with watermark; the QR page showed
  facility, number, date, ৳1,800 and no patient details. Found and fixed: the verify page showed the UTC clock as
  Dhaka time; the two-language discount line ran together; the receipt screen's lines did not add up to its total.
- **Tests:** domain 140, api 121, contracts 2, i18n 3; `pnpm typecheck` 13/13; Playwright **48** (43 + 5 `a6-a7`),
  green twice in a row on 03/10/2026 after the review fixes (API on :4100, staff on :3300 — port 4000 held by E:healthcare).

## Done (billing follow-ups, 03/10/2026) — not billed here, void, reconciliation, order refresh ✅
One session, plan agreed with Kamrul (8 recommendations + the replacement chain + the design-round note). **ADR 0005.**
- **Decision 98 — "Not billed here":** on an unpriced order line the cashier asks with a reason (≥10) → APPROVAL Task
  kind `bill-elsewhere` (owner/admin, never their own, blocks Issue and locks lines while requested). Approved → the
  line stays on the bill and the receipt as "Not billed here — <reason>", outside totals and VAT ("—"); the order stays
  active. The database accepts the exclusion only through an approved Task of that bill naming that line.
- **Void = INVOICE entered-in-error** (ADR 0005): owner/admin, reason ≥10, never a delete; refused with confirmed money
  (refunds later), with a pending link, with an approval waiting or a reconciliation open. The number is kept and never
  reused; the visit can get a new bill that says "This bill replaces the voided bill INV/…", and once it is issued every
  voided bill of the visit shows "Replaced by INV/…" (the database checks the target). A voided bill shows no Paid / Due,
  takes no payments, cannot retry a failed link; any PDF of it is stamped VOID.
- **Reconciliation queue `bill/reconcile`** (owner only; **beyond the design handoff — the prototype gets it in the next
  design round**; hand-added to `access-matrix.json` with a test): cases from late money on a failed / replaced link, a
  different amount, a second payment, a TrxID paid on a replaced link, money on a bill that takes no payments. Each shows
  why (bn/en), what the gateway reported, the payment and the bill. **Apply** only after the gateway, asked again,
  confirms the same amount and TrxID for a payment of this bill that is still pending (any newer link is cancelled);
  otherwise **resolve with a note**. While a case is open the bill and payment screens say "do not take money again" and
  the link cannot be cancelled or the bill voided. A late callback for money already applied is a no-op.
- **Order refresh (decision 99 prep):** opening a draft brings its order lines in line with the visit's placed orders
  (audited with the lines removed / added); with a discount or approval on the bill it waits and Issue is blocked;
  orders changed after issue are flagged on the issued bill (open question 109).
- **Migrations:** `billing_followups` (enum value, columns), `billing_followups_guards` (split: a new enum value must be
  committed before an index uses it — the first attempt rolled back completely and was marked rolled back),
  `billing_followups_fixes` (review fixes in payment_guard, charge_item_guard, invoice_guard).
- **Reviews:** security (1 high — retry on a voided bill; 2 medium; 5 low) and money / safety (1 high — void or cancel
  while the owner is reconciling; 4 medium; lows) — all fixed in step 7.
- **Hands-on test (03/10/2026)** as owner 01799000009 in the E2E clinic: approved the cashier's "Not billed here" on SGPT
  (line shows the reason, total ৳1,250, Issue free); voided INV/26/0279 with a reason (number kept, banner), opened the
  new bill ("replaces the voided bill INV/26/0279"), issued INV/26/0281, the voided bill links "Replaced by INV/26/0281";
  applied a TrxID paid on a replaced link (bill INV/26/0280 → partially paid ৳300); resolved a ৳20-vs-৳200 case with a
  note (Apply was disabled: "the amount does not match"); a draft whose RBS order was revoked (in the test database —
  revoke comes with the lab slice) refreshed itself on open to ৳2,150. Found and fixed: a voided bill showed "Due".
  Not fixed (test data): the E2E clinic's reconciliation queue holds ~45 old cases from test runs (open question 110).
- **Tests:** domain 147, api 133, contracts 2, i18n 3; `pnpm typecheck` 13/13; Playwright **51** (48 + 3
  `a6-followups`), green twice in a row on 03/10/2026 (API :4100, staff :3300).
- Note on history: commit `2341bc3` (step 2) was made while one API test still expected the old guard message; fixed
  in the next commit `d246dac`. From then on every commit was gated on the test command's exit code.

## Done (slice A8–A11, session 1 of 2, 03/10/2026) — lab backend ✅
Plan agreed with Kamrul the same day (decisions D1–D10 with his changes: open questions "Slice A8–A11 session 1").
**Session 2** does the lab screens (collection with tube guidance and labels, accession, result entry with Enter-to-next
and flags as text + icon, verification with the call-back panel, report on screen, delivery with per-channel status and
retry, opening released from the journey), "cancel order" on the doctor's signed note, the A8–A11 journey spec, the
security and clinical-safety reviews and the hands-on test as the E2E lab technologist 01799000005 and pathologist
01799000006.
- **Step 0:** decisions 107–113 recorded; the E2E reset resolves leftover reconciliation cases as the E2E owner with
  the note "test run" (decision 110; the first run resolved 47); E2E lab technologist and pathologist seeded.
- **ADR 0006:** RESULT gains `verified` (technical verify) and `entered-in-error` (a correction is a new row); new
  LAB_REPORT machine (released versions preliminary | final | corrected → superseded) and COMMUNICATION machine
  (preparation → in-progress → completed | failed → retry, same message id); CriticalCallback is an append-only record.
- **Rules** (`@setu/domain` `lab.ts`, sample content pending clinician sign-off): tube guidance and tube plan, reject
  reasons, analytes and adult ranges (Hb and creatinine adult female only; "adult female range" label), flags
  N/H/L/HH/LL, age at collection, result entry (numbers only, critical typed twice), delta check (>20%, WBC excluded),
  verify / call-back / validate blockers (same person by plan or facility setting), corrections, release plan (partial,
  final, corrected), ORDER revoke rules, SMS placeholder check.
- **Database** (migrations `lab` + `lab_guards`): Specimen (+ SpecimenOrder), LabAnalyte, LabReferenceRange,
  DiagnosticReport (+ results), CriticalCallback, Communication; lab columns on Observation; revoke record on
  ServiceRequest; Organization.labSamePersonAllowed. Guards for every role: ORDER / SPECIMEN / RESULT / COMMUNICATION
  transitions only; a lab value is never changed or deleted; validation refused for the verifier (unless allowed) and for
  a critical result without a reached + read-back call-back; released versions immutable; one current version per visit.
  Seed: sample analytes / ranges in all 4 tenants; Rahima Khatun's validated 12/08 results (Green Life + E2E) for the
  delta check.
- **Messaging adapter** (`apps/api/src/adapters/messaging`): `Messenger` + `FakeMessenger` (records, never delivers a
  message id twice, `failNext`); SMS templates in `locales/app/labApp.json` (facility name only); dev routes
  `/v1/dev/fake-messenger/fail-next|messages` with `FAKE_MESSAGING_DEV_ROUTE=1`; production refuses `SMS_PROVIDER=fake`.
- **API** (`modules/lab.ts`, `routes/lab.ts`, `packages/contracts/src/lab.ts`, openapi regenerated): worklist per stage,
  visit view (audited incl. earlier results for the delta check), report version view, labels, collect / receive / start,
  reject, results, correct, verify (PIN), call-back, validate (PIN), release, send, retry, `POST /v1/orders/:id/revoke`
  (refreshes the draft bill at once — billing `refreshDraftOrders`, decision 99). SMS are sent after the write commits.
- **Tests:** domain 184 (+37 `lab.test.ts`), api 154 (+5 messaging adapter, +16 `lab.test.ts`; billing-followups now
  revokes through the real route), contracts 2, i18n 3; `pnpm typecheck` 13/13. The API suite was green twice in a row.
  **Playwright was not run this session** (no screen changed) — run plain `pnpm e2e` at the start of session 2; 51 specs
  were green at the end of the billing follow-ups.
- **Migrations note:** `prisma migrate dev` now refuses on the dev database because the rolled-back first attempt of
  `billing_followups` is still recorded with an older checksum (the applied one matches the file). Never reset: write
  migrations from `prisma migrate diff … --script` and apply with `pnpm --filter @setu/db migrate:deploy` (see
  `packages/db/prisma/migrations/README.md`).

## Done (slice A8–A11, session 2 of 2, 03/10/2026) — lab screens, journey spec, reviews, hands-on ✅
Slice A8–A11 is **done**. Kamrul's decisions on 114–133 and the session's hands-on list: open questions "Slice A8–A11
session 2".
- **Send-back and withdraw** (decisions 119, 133; ADR 0006 addendum): RESULT `return` (verified → preliminary,
  pathologist, reason ≥10); withdraw results = entered-in-error with no replacement, the tube rejected as
  results-withdrawn (SPECIMEN done → rejected), new tube + recollection SMS, doctor told if released; migration
  `lab_return_withdraw`; `POST /v1/lab/orders/:id/return` and `/withdraw`.
- **Screens** (`apps/staff/modules/lab/`, strings `locales/app/labApp.json`): `lab/collect`, `lab/accession`,
  `lab/result`, `lab/verify`, `lab/report`, `lab/delivery` (see commit `be30326`); `cons/signed` gets "Cancel test"
  before collection (the draft bill drops the line).
- **Reviews:** clinical safety (3 high, 6 medium, 6 low) and security (0 high, 4 medium, 6 low) — all fixed in commit
  `40e6d06` (migrations `lab_review_fixes` + `lab_review_fixes_order_guard`).
- **Hands-on test (03/10/2026, on the Linux machine)** in the E2E clinic, patient "Walkthrough c71l" visit A-067 (CBC,
  RBS, S. Electrolytes signed by the E2E doctor), driven in the browser with a screenshot per step (`e2e/walk-lab.mjs`,
  untracked helper): labels printed (3) with the on-screen confirmation; EDTA collected → "Partial"; fluoride rejected
  as haemolysed → Recollect + recollection SMS delivered; new fluoride tube labelled and collected; accession receive +
  start for all three; K 6.9 typed twice → "HH · Critical high", Na/Cl Normal, RBS 11.2 "H · High"; technical verify
  with PIN; as pathologist 01799000006 validation locked "log the call-back first", still locked after a no-answer
  attempt, unlocked after reached + read-back; validated; release preview "PRELIMINARY — 1 of 3 tests pending" (CBC);
  released → report LR/26/0008 v1 with the call-back legend; delivery: forced SMS failure → retried → delivered "2
  attempts", patient app delivered, doctor's inbox recorded; correction of the released RBS 11.2 → 12.1 (old value
  struck "Entered in error", new value "To verify"); Bangla + Bangla digits and tablet 1024 px checked.
  Found and fixed: the recollection SMS line on `lab/collect` showed the raw phone (01913652797) and wrapped its "·" onto
  its own line — now `L.phone` like Delivery. Noted, not fixed: the nav badge counts (e.g. Verification "4", shown as
  "৪" in Bangla) are fixed sample numbers from the prototype, not live counts (gap 5, open question 134).
  The send-back, withdraw and cancel-from-the-signed-note items of the list are covered by the journey spec (green).
- **Tests:** domain 189, api 165, contracts 2, i18n 3; `pnpm typecheck` 13/13; Playwright **61** (51 + 10 `a8-a11`),
  green on 03/10/2026 on the Linux machine (`--workers=2`, see below).

## Done (slice A12–A13, session 1 of 2, 03/10/2026) — doctor's inbox, acknowledgement, printed documents (backend) ✅
Plan agreed with Kamrul the same day (decisions D1–D4: open questions "Slice A12–A13 session 1"). **Session 2** does the
doctor app module at phone width (bottom tabs: home with live counts, queue, quick consult with the allergy strip and
the PIN sign sheet, results inbox with "Seen" / "Seen + tell patient" and the offline outbox), print preview + print /
reprint on `cons/signed` and the lab report screen, the public pages `/verify/rx/[code]` and `/verify/lr/[code]`, the
A12–A13 journey spec at 390 and 412 px, the security and clinical-safety reviews, the hands-on test as the doctor, and
then the whole of Journey A end to end.
- **ADR 0007:** INBOX_ITEM (unread → acknowledged) stored as an append-only `InboxAck`; "Seen + tell patient" only for a
  released report (SMS `report-reviewed`, facility name only, sent after the commit); `critical-vital` inbox items;
  printed prescriptions and lab report versions (drafts never, superseded not, DUPLICATE #n with a reason), 20-character
  verify codes, what the public pages show.
- **Rules** (`@setu/domain`): `inbox.ts` (inboxSeverity, sortInbox — unread first, critical → abnormal → normal →
  notice, newest first; ackBlockers), `printing.ts` (rxPrintBlockers, labReportPrintBlockers, REPRINT_REASONS
  lost/jam/copy, copyCheck, rxVerifyStatus, initials); access matrix module **`doc`** (home, queue, consult, inbox;
  doctors, every plan).
- **Database** (migration `doctor_inbox_printing`): InboxAck, DocumentCode, DocumentPrint; append-only for every role;
  inbox_ack_guard (signed-in user = recipient, not a superseded report, the SMS must be report-reviewed to the same
  patient); document_printable checked on code and print; copies in order; SECURITY DEFINER `rx_verify_lookup` /
  `lr_verify_lookup` (initials via `person_initials`).
- **API:** `GET /v1/doctor/inbox`, `POST /v1/doctor/inbox/:id/ack`; vitals write a critical-vital item for the visit's
  doctor; `GET|POST /v1/documents/:kind/:id/print`, `GET …/preview` (DRAFT / PREVIEW watermark, no QR),
  `GET /v1/documents/prints/:id/pdf`, public `GET /v1/verify/rx/:code` and `/v1/verify/lr/:code` (20/min, no-store).
  PDFs: `apps/api/src/print/clinical.ts` (A5 / A4, bn+en / bn / en), strings in the new i18n namespace `printApp`.
- **Found and fixed during the session:** the acknowledgement route lacked `config.ownTx` (a replay was answered by
  the generic idempotency hook before the route's checks — test added); `SELECT … FOR UPDATE` on DocumentCode needs
  UPDATE, which setu_app does not have — an advisory transaction lock instead; print digits now follow one rule (Bangla
  digits only on a Bangla print), the long preview watermark fits the page, the bilingual signature / released lines
  no longer repeat the date.
- **Tests:** domain 211, api 186 (+9 `doctor.test.ts`, +12 `documents.test.ts`), contracts 2, i18n 3; `pnpm typecheck`
  13/13. **Playwright was not run at the end of this session** (the machine was out of memory — see below); 61 specs
  were green at the start of the day; the only spec change is the shell's doctor nav list (+ `doc`). Run plain
  `STAFF_URL=http://localhost:3300 pnpm e2e --workers=2` at the start of session 2.
- **Memory on the Linux machine (03/10/2026):** 15 GB shared with other projects; the kernel killed the staff dev
  server (2.5 GB) and Kamrul's Cursor / Edge windows. The staff server now runs with
  `NODE_OPTIONS=--max-old-space-size=1536`; the patient app is not started until Journey D; the package watchers
  (`pnpm dev` in packages/domain, contracts, i18n) keep `dist` current — without them the API runs on stale packages.

## Done (slice A12–A13, session 2 of 2, 03/10/2026) — doctor app, printing, Journey A end to end ✅
Slice A12–A13 is **done** and with it **all of Journey A (phase 1)**: every step's spec plus `journey-a.spec.ts` (one
patient from the front desk to the doctor's printed prescription) are green.
- **Doctor app** (`apps/staff/modules/doc/`, module `doc`, strings `locales/app/doctorApp.json`): one phone column with a
  bottom tab bar (home, queue, reports + unread badge) inside the staff shell. `doc/home` live counts (waiting, seen,
  not signed, results to review + critical); `doc/queue` (with you now / waiting, critical vitals first / completed);
  `doc/consult` = the desk note editor in a phone variant (`ConsNavContext` in `cons/common.tsx`): sticky name + token +
  red allergy strip (issue #8), "Sign & send" → the same PIN sheet, signed view with the prescription and Print;
  `doc/inbox` cards (critical / abnormal / normal / notice, worst result first with the labelled range, "under
  correction" / "replaced by a newer version" states, "Seen" and "Seen + tell patient", offline outbox "Acknowledged —
  not yet synced").
- **Printing on screen:** `components/PrintPanel.tsx` (A5/A4, language, server preview without QR, Print / Reprint with
  a reason → DUPLICATE #n, print log, verify link; on a phone it opens PDFs instead of framing them) on `cons/signed`,
  `lab/report` and the doctor app; "Print preview" on the draft shows the DRAFT preview with Print disabled ("Drafts
  cannot be printed — sign first", issue #19). Public pages `/verify/rx/[code]` and `/verify/lr/[code]`.
- **Reviews:** clinical safety (1 high — medicine instructions not printed; 6 medium; 3 low) and security (0 high, 2
  medium — no care-relationship check on printing / lab report access; 3 low) — all fixed in commit `1009307` except the
  items in open questions 144–149. Migration `doctor_inbox_printing_review_fixes` (verify lookups).
- **Hands-on (03/10/2026)** as doctor 01799000002 at 390 px with screenshots (`e2e/walk-doc.mjs`, untracked): inbox
  critical first → Seen + tell patient → SMS delivered; queue → quick consult with the penicillin strip; amoxicillin
  flagged and blocked; Napa; Sign & send → PIN → server-confirmed; printed A5; QR page (initials, medicine, sample-list
  note). Found and fixed: numerals toggle hidden on phones (English with Bangla digits), PIN sheet title, PDFs not shown
  inside a phone page. The journey spec also caught an outbox-listener race (a synced acknowledgement could show as
  not acknowledged) — fixed.
- **Tests:** domain 216, api 189, contracts 2, i18n 3; `pnpm typecheck` 13/13; Playwright **69** (61 + 7 `a12-a13` + 1
  `journey-a`), green twice in a row on 03/10/2026 (API :4100, staff :3300, `--workers=2`). One earlier full run had a single
  failure whose name was not captured (the next three runs were all green) — if a spec flakes, note which one.
- **Staff dev server memory:** at `--max-old-space-size=1536` it ran out of heap during the full run; it now runs with
  3072 (the machine had ~11 GB free with the other projects stopped).

## Done (slice C1–C4, session 1 of 2, 03/10/2026) — shift close and owner dashboard (backend) ✅
Phase 2 split in four slices (Kamrul, 03/10/2026; open questions "Phase 2 plan"): C1–C4 owner + shift close → pharmacy
→ admin → real SMS + bKash. **Session 2** does `bill/shift` (cashier: open, live expected, count by note, hand over;
owner / admin: approve with a note or recount) and `own/dash` at 1440 and 412 (KPI tiles with real changes, labelled
axes, leakage, the list behind each number, approvals and variance on the phone), the owner's live home, the C1–C4
journey spec @phone, the reviews, the hands-on test as the owner.
- **ADR 0008:** Shift / ShiftCount / ShiftReview (expected = float + the cashier's confirmed cash; count by note and hand
  over; variance needs a reason; owner / admin approve with a note (issue #24) or recount; history append-only);
  DailyRollup per facility and Dhaka day (nightly 00:30 job recomputes the last 7 finished days; today live); KPI
  comparisons; drill-downs audited; leakage list.
- **Rules:** `@setu/domain` `shift.ts`, `kpi.ts`. **Database:** migrations `shift_close_rollup` (guards) and
  `rollup_targets` (SECURITY DEFINER list of facilities for the job).
- **API:** `/v1/shifts/mine`, `/v1/shifts` (open, list), `/v1/shifts/:id` (+ `/count`, `/review`), `/v1/owner/dashboard`,
  `/v1/owner/drill`, dev `/v1/dev/rollup/run`; the server schedules the nightly job (`scheduleNightlyRollup`).
- **E2E reset** approves shifts left unfinished by test runs ("e2e reset: test run").
- **Tests:** domain 231, api 199 (+10 `owner.test.ts`, green twice), contracts 2, i18n 3; `pnpm typecheck` 13/13.
  Playwright not re-run this session (no screen changed; 69 green at the end of A12–A13).

## Done (slice C1–C4, session 2 of 2, 03/10/2026) — shift close and owner dashboard screens, Journey C ✅
Slice C1–C4 is **done**: Journey C (the owner's morning check on the phone) is green.
- **`bill/shift`** (`apps/staff/modules/bill/Shift.tsx`): the cashier opens a shift with a float and counts **blind**
  (what the drawer should hold is not shown); the server reveals the variance on hand-over and asks for the reason;
  digital settlements are the cashier's figures ("matches the cashier's figure", "check against the terminal / bank
  statement"). The owner / admin sees handed-over shifts (float marked as the cashier's figure, every count and
  decision): accept with a note (issue #24), approve a matching count, or ask for a recount; never their own shift.
- **`own/dash`** (`apps/staff/modules/own/Dash.tsx`, strings `ownerApp`): today / 7 / 30 days; KPI tiles with real
  changes judged per KPI (issue #23), tiles of later modules say so; waiting for you (approvals, shifts handed over,
  reconciliation, shifts open > 12 h); revenue vs collected (one taka axis with labelled ticks, labelled time axis,
  legend, hover tooltip, table view; colours validated light + dark with the dataviz check, collected dashed); by method;
  leakage (cash outside a shift, shift variance with short / over apart, discounts above policy, reprints, not billed
  here); operations; every number opens its list (totals over every row, "viewing is logged"). The owner's home is this
  dashboard (sample figures gone for the owner).
- **Reviews:** money controls (3 high — the float is the cashier's figure, digital settlements are the cashier's
  figures, short and over cancelled out; 5 medium; 4 low) and security (0 high, 4 medium — the Shift row could be
  approved without a decision row, the latest count could be repointed, the dev rollup route was on by default, a 30-day
  first load could time out; 7 low) — fixed in commit `f313522` except open questions 159–165. Migration
  `shift_review_fixes`; rollup v2 (short / over apart); `command()` answers 409 for a unique-slot clash that is not a
  key replay (every route).
- **Hands-on (03/10/2026)** as the cashier at the desk and the owner on a 412 px phone (`e2e/walk-owner.mjs`,
  untracked): see commit `C1-C4 session 2 step 5`.
- **Tests:** domain 232, api 199, contracts 2, i18n 3; `pnpm typecheck` 13/13; Playwright **74** (69 + 5 `c1-c4`), green
  twice in a row on 03/10/2026 (runs 3 and 4). **Flaky under full parallel load (not changed by this slice):** in one
  run `a1-a3` "A2 / issue #4" did not find the candidate column within 5 s and `a12-a13` "A13 / D10" hung on opening
  the lab report's QR page until the 150 s timeout; both files passed twice on their own and the next two full runs
  were all green. Watch them; if they recur, look at the dev server under load first.
  `ROLLUP_DEV_ROUTE=1` in the local `.env` and the API tests (dev route opt-in).

## Done (pharmacy, session 1 of 3, 03/10/2026) — stock ledger, dispense, OTC sale (backend) ✅
Journey P (Kamrul, 03/10/2026; open questions "Phase 2 slice 2"): P1–P3 dispense, P4 OTC sale, P5 goods received, P6
count and adjust. **Session 2:** suppliers, purchase orders, goods received, counts and adjustments, store →
counter transfer, owner stock tiles. **Session 3:** the six pharmacy screens, `e2e/journeys/p1-p6.spec.ts`, reviews,
hands-on as the pharmacist.
- **ADR 0009.** `@setu/domain` `pharmacy.ts` (FEFO, batch state, near expiry, dispense status, substitution — same
  ingredients, strength and form —, sale class, dose label through the prescription's dose parser); `access.ts`
  `billKindsFor`, `holdsShift`; inbox kind `substitution-notice`; sample "Sedil" (diazepam, controlled).
- **Database:** StockBatch (quantity only through StockMove; the app role cannot update it), StockMove (append-only,
  never below zero), MedicationDispense (append-only; signed current note; every dispense billed at commit);
  Invoice.kind `opd | pharmacy | otc` (OTC: no visit, optional patient, walk-in buyer, prescription photo); one OPD bill
  per visit, one draft pharmacy bill per visit; medicine lines priced at their batch MRP / VAT; a dispense line is
  never edited or removed; an OTC bill is issued only after every line's stock moved; payment / receipt patient = the
  bill's patient. Migrations `20261003200000_pharmacy` … `20261003200600_pharmacy_review_fixes`.
- **API:** `/v1/pharmacy/queue`, `/v1/pharmacy/encounters/:id` (+ `/dispense`, `/decline`), `/v1/pharmacy/otc`
  (+ `/:id`, `/lines`, `/lines/:lineId/remove`, `/rx-photo` GET/POST, `/issue`), `/v1/pharmacy/stock`. The billing
  view / issue / payment / receipt routes and the shift routes serve the pharmacist for pharmacy and OTC bills only
  (`invoiceHere` hides every other kind). Billing's "the visit's bill" lookups ask for kind `opd`; OTC bills take no
  discount and are issued only from the pharmacy; a bill with given medicine cannot be voided (returns: refunds slice, question 191).
- **Seed:** sample stock per medicine (counter + store; Comet has a near-expiry and an expired batch; Napa only an
  expired one), E2E pharmacist 01799000007; `pnpm reset-e2e` tops the sample batches back up with an `adjust` move.
- **Reviews:** security (no critical / high; fixed: app role could set the ledger flag and update a batch, dispense
  without a bill line, orphan photo on a refused upload, photo headers) and clinical / money (fixed: blank dose label
  for ½ / dashes / Bangla digits, another strength accepted as a substitute, a substitute counted twice after an
  amendment, two lines of the same medicine counting each other, given medicine voidable off its bill, a pharmacy bill
  marked "Replaced by" the next one). Open: questions 166–178 (stock out before payment, OTC discount, photo rules,
  controlled register, queue days, expiry vs course, revenue split by kind).
- **Also fixed:** consultation orders written in one save keep their order (load-only test flake).
- **Tests:** domain 247, api 207 (+8 `pharmacy.test.ts`), `pnpm typecheck` 13/13. No screens yet (session 3).

## Done (pharmacy, session 2 of 3, 03/10/2026) — purchasing, goods received, counts, transfers, stock tiles (backend) ✅
- **Domain:** machines PURCHASE_ORDER, GOODS_RECEIPT, STOCK_COUNT; `purchasing.ts` (approval threshold ৳50,000 sample,
  receipt line checks, short expiry < 180 days and a price different from the order → owner / admin posts, debit note
  for a short delivery, supplier owed, count submit / decision rules, money range). KPI tiles supplier dues, stock value,
  near-expiry are live (point-in-time from the ledgers, with drills).
- **Database:** Supplier, PurchaseOrder (+lines), GoodsReceipt (+lines), SupplierEntry (append-only), StockCount
  (+lines); guards for every machine step; and at commit: every stock move the app writes is backed (receive ← posted
  receipt line, adjust ← approved count, transfer = two legs that cancel out), supplier entries match the posted
  receipt / are paid by the owner or admin and never below zero, an order line's received quantity is what posted
  receipts brought, a count is decided by the facility's owner / admin. One supplier invoice is posted once.
  Migrations `20261003210000_pharmacy_purchasing`, `20261003210100_purchasing_review_fixes`.
- **API:** `/v1/pharmacy/suppliers` (+ ledger, payments), `/purchase-orders` (lines, send / ask approval, approval,
  cancel, close short), `/goods-receipts` (lines, post, discard), `/counts` (start, lines, submit, decision),
  `/transfers`, `/approvals`; owner dashboard tiles + drills `stockValue`, `nearExpiry`, `supplierDues`.
- **Seed:** three sample suppliers per demo facility. API tests that need stock top-ups use the owner connection
  (the app role can only adjust from an approved count).
- **Reviews:** security (no critical) and money / stock: fixed — a count no longer takes sales made during it off twice,
  a receipt at another price than the order needs the owner, the database backs every stock move and supplier entry,
  the count decider's role is re-checked, one invoice posted once, totals capped at the paisa range. Open: 179–191.
- **Tests:** domain 257, api 215 (+9 `purchasing.test.ts`), `pnpm typecheck` 13/13, Playwright 74 green (the C1
  owner spec now expects a live stock tile). **Returns of dispensed medicine move to the refunds slice** (question 191).

## Done (pharmacy, session 3 of 3, 03/10/2026) — the six pharmacy screens, journey P ✅
- **Screens** (`apps/staff/modules/ph/`, ported from the prototype Setu Pharmacy): `ph/dispense` (queue of today's
  signed prescriptions; per line prescribed / given / batch, FEFO, expired shown never given, same-generic substitute
  with a reason, decline, the 50 × 30 mm label preview, the pharmacy bill → issue → payment), `ph/otc` (walk-in, sale
  class on every item, prescription photo, controlled refused), `ph/stock` (counter / store / near expiry / expired,
  batches, moves), `ph/purchase` (orders, goods received, suppliers and payments, the owner's approvals tab),
  `ph/count` (expected = start + moves since; owner / admin approves). `ph/indent` (ward indents) stays a placeholder
  until IPD (B3–B4).
- **Access matrix:** the pharmacist reaches `bill/pay`, `bill/receipt`, `bill/shift` (ADR 0009 note + test); Pay and
  Receipt go back to the right screen for each bill kind. The doctor's inbox shows the substitution notice.
- **Writes keep their Idempotency-Key after a network failure or a server error** and renew it only after a 4xx
  (`renewKey`), so a retry after a lost answer replays instead of dispensing / paying twice (screen review). Changes
  to an OTC sale and to a count's lines run one after another on the latest rev (nothing dropped while busy).
- **E2E:** `e2e/journeys/p1-p6.spec.ts` (P1–P3, P4, P5, P6, 1024 px); `pnpm reset-e2e` also rejects open counts and
  discards receipts left in checking. Hands-on: `node e2e/walk-pharm.mjs <dir>` (demo clinic, Rahima Khatun, Bangla).
- **Kamrul's decisions (03/10/2026, after the session):** (1) the dose label prints through the browser's print dialog on a
  label-sized page — default 50 × 30 mm, `Organization.labelWidthMm / labelHeightMm` (migration `label_page`; set in the
  database until the admin slice brings settings screens) — so any thermal printer with an OS driver works; each print is
  recorded first (`POST /v1/pharmacy/encounters/:id/labels/print`, audited `DoseLabel print`). **Direct printer protocols
  (ZPL / TSPL) are phase 2**, only when a pilot clinic names its printer. (2) The pharmacist's payment, receipt and shift
  are Pharmacy screens `ph/pay`, `ph/receipt`, `ph/shift` reusing the billing components; the cashier keeps `bill/pay`;
  the pharmacist has no Billing screen (access matrix + test, ADR 0009 note — shift moved with pay and receipt so the
  pharmacist has one module). (3) The owner's Approvals screen (`bill/approvals`) is the single queue for every kind —
  discount, not billed here, purchase order, goods receipt (owner-only post), count — with a kind filter; Pharmacy ›
  Purchase › Approvals is the pre-filtered view; the dashboard's pending count includes the pharmacy kinds.
  A goods receipt is "approved" by posting it from its page (its lines are checked there); the queue links to it.
- **Not yet:** the prescription photo is not checked for content (pre-pilot list, gap 12); the menu badges are the
  prototype's static sample numbers (not live counts — gap 5).
- **Journey P timing (P5, 28.9 s on this PC):** four sign-ins 10.5 s (login page, home, the language and numeral toggles),
  owner screens 12.3 s (Approvals with the kind filter, Purchase, the receipt, the order — mostly dev-server page loads),
  the pharmacist's own work about 3.6 s, page loads between steps 2.5 s. Signing in once per role (Playwright
  storageState) would save about 10 s per journey if the suite grows slow.
- **Tests (slice closed 04/10/2026):** domain 258, api 217, `pnpm typecheck` 13/13, **Playwright 79 green twice in a row**. The
  last intermittent P5 failure was a real bug: the goods-receipt form's defaults, set after the order loaded, replaced a
  batch number already typed when the order loaded a second time (React runs effects twice in development) — fixed.

## Done (admin, session 1 of 2, 04/10/2026) — onboarding, users, masters, audit log (backend) ✅
Kamrul's decisions (open questions "Phase 2 slice 3"): one-time password for new users, no Manager role yet, a price
change applies to bills made after it, two sessions. **Session 2:** `adm/wizard`, `adm/users`, `adm/masters`,
`adm/audit` screens, the first-sign-in screen, journey spec, reviews, hands-on.
- **ADR 0010.** `@setu/domain` `admin.ts`: go-live checklist, who may change whose role / switch whom off, password and
  PIN rules, approval limits (an approver limit of 0 refused), price changes, flagged audit actions.
- **Database:** Organization `status` setup | live (+ formats, payment methods, test SMS); User one-time password
  (works once, 24 h), `sessionGeneration` (only goes up), deactivation; `ChargePriceChange` (append-only; a price set or
  changed by the app without its history row is refused at commit); a signed note keeps its signer's registration
  (`Composition.signerReg*`, filled by the database at signing; the public prescription check reads it); `AuditEvent.
  organizationId` (backfilled for single-facility users). Migrations `20261004100000_admin` … `20261004100400_otp_single_use`.
- **Sessions can end:** every command / query and `/v1/me` check the user is active, holds the role and has the same
  generation — deactivation, a role change, a password reset and the first sign-in end the user's other sessions; a
  one-time-password sign-in is a setup session that can only `POST /v1/auth/first-sign-in`.
- **API `/v1/admin`:** facility (details, branches, wards with beds, settings, test SMS, go-live), users (create with a
  one-time password — never in the stored replay —, role, deactivate / reactivate, reset, verify BMDC / BNMC through
  the `RegistrationVerifier` adapter, Fake in dev), price list (add, change with a reason, switch off — never an active
  doctor's fee —, history), audit log (this facility's events — the owner also sees tenant-level ones —, filters,
  flags incl. bill voids, CSV export audited as `export`). An account that is an owner anywhere, or that works at
  another facility, is changed only by an owner.
- **Billing:** payments (and link retries) only by methods the facility takes; a draft line shows "price changed since"
  (price or VAT); more of the same service after a change goes on a new line; a draft made before the doctor had a fee
  takes the fee once it exists.
- **Seed / reset:** demo facilities live; E2E New Clinic (`01799000011`) and Green Life Uttara (`01711000011`, PIN 2580)
  in setup; `pnpm reset-e2e` puts the E2E one back into setup.
- **Reviews:** security (fixed: an admin could reset an owner's account held at another facility; the audit log was
  tenant-wide; an admin could bring back an owner; the one-time password worked many times and past its 24 h; a
  first-sign-in race; the PIN check skipped ended sessions) and controls (fixed: re-verifying changed signed
  prescriptions — now a copy on the note; voids missing from Flags; a role change kept a nurse's registration as a
  doctor's; unpriced consultation lines; the same service merged at the old price; VAT-only changes unseen; a link
  retry by a switched-off method; filters overwriting each other; approver limit 0; pending users counted as approvers;
  stale plan; colliding service codes). Open: questions 195–200.
- **Tests:** domain 266, api 226 (+15 `admin.test.ts`), `pnpm typecheck` 13/13, Playwright 79 green twice in a row (no screen changed; the per-request session check runs under every journey).

## How to run the journeys on this PC
- Playwright's Chromium is installed (02/10/2026): plain `pnpm e2e` runs the journeys against `pnpm dev` (staff :3000,
  api :4000). The installed-Chrome route still works: `cd e2e` then `CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" pnpm exec playwright test -c pw.local.config.ts`.
- **Linux machine (razer-kamrul, from 03/10/2026):** the repo now also runs at `~/Desktop/Setu Health APP/setu`. Other
  projects hold 5432 / 6379 / 9000 / 3000 / 3001, so Setu has its own containers `setu-postgres` (127.0.0.1:5442,
  volume `setu_pgdata`) and `setu-redis` (6390); the local `.env` points there and `API_PORT=4100` (the Windows `.env`
  is kept as `.env.bak-windows`). A fresh database: `pnpm --filter @setu/db migrate:deploy`, set the `setu_app`
  password (`ALTER ROLE setu_app PASSWORD '…'` from `DATABASE_URL_APP`), `pnpm db:seed`. Start: `cd apps/api` then
  `API_PORT=4100 pnpm exec tsx watch src/server.ts`; `cd apps/staff` then `API_URL=http://localhost:4100 pnpm exec next
  dev -p 3300` (patient app on 3301). Journeys: `STAFF_URL=http://localhost:3300 pnpm e2e --workers=2` — the default
  worker count got headless Chromium OOM-killed (15 GB shared with other projects). `node_modules` copied from Windows
  do not work on Linux: delete them and `pnpm install --frozen-lockfile`. Screenshot helper: `e2e/shot.mjs` (untracked).
- Older dev servers were holding ports 3000/3001/3100 on 02/10/2026 (the one on 3100 had crashed). A journey server can
  now run beside them with its own build folder: `cd apps/staff` then `NEXT_DIST_DIR=.next-e2e pnpm exec next dev -p 3200`,
  and `STAFF_URL=http://localhost:3200` for Playwright. Next rewrites `apps/staff/tsconfig.json` and `next-env.d.ts`
  for that folder when it starts: restore them (`git checkout -- apps/staff/tsconfig.json apps/staff/next-env.d.ts`)
  before committing. Stop old `next dev` processes before `pnpm dev`.
- **03/10/2026: port 4000 was held by another project's NestJS server** (`E:\healthcare`), so the Setu API ran on
  4100 beside it: `cd apps/api` then `API_PORT=4100 pnpm exec tsx watch src/server.ts`, and the journey staff server
  `cd apps/staff` then `API_URL=http://localhost:4100 NEXT_DIST_DIR=.next-e2e pnpm exec next dev -p 3300`, with
  `STAFF_URL=http://localhost:3300 pnpm e2e`. If `next dev` stops answering after a CSS change in `packages/ui`,
  restart it.
- API contract test files run one at a time (`apps/api/vitest.config.ts`): they share the E2E family.
- **Tests never touch the demo clinic.** The API contract tests and the Playwright journeys that create patients or visits sign in to the seeded **E2E Test Clinic** (`t_e2e`, users 01799000001 receptionist / …02 doctor / …09 owner / …10 admin, prefix `E2E-`, same walkthrough family). Playwright's `e2e/global-setup.ts` runs `pnpm db:reset-e2e` (restores the family, closes open reviews) and warms the dev server. The cross-tenant fixtures in the Hospital Lite demo are deleted after each API run. Green Life (`t_greenlife`) stays at its 8 seeded patients and an empty queue; the test patients made before 02/10/2026 evening were removed.
## Done (admin, session 2 of 2, 04/10/2026) — the four admin screens, first sign-in, journey G ✅
- **Screens (ported from `docs/prototype/Setu Admin.dc.html`, `adminApp` i18n namespace bn + en):** `adm/wizard`
  (go-live checklist beside each step — details, branch, wards with beds, doctors → Users, fees → Masters, print
  formats and payment methods, a test SMS; Go live refused until complete), `adm/users` (role, status, BMDC / BNMC,
  last sign-in; add → one-time password shown once; change role, verify, reset, switch off with a reason / back on;
  an owner's account is shown locked to an admin), `adm/masters` (price list, change with a reason, switch off,
  history, add; approval limits with a reason; dose-label page size), `adm/audit` (this facility's events, filters
  that combine, Flags, actions and records in the reader's language, load more, CSV of the filtered log).
- **First sign-in:** a one-time-password session shows only "set your password and PIN". **An ended session**
  (switched off, role or password changed) clears that user's local drafts, signs out, and the sign-in page says why.
- **Screen review fixes:** an Idempotency-Key per wizard step and per managed user (renewed after success or a 4xx,
  kept after a network error); a slow audit answer never overwrites newer filters; taka input parsed strictly (≤ ৳1
  crore); percentages to basis points without float drift; a failed load shows an error, not an empty list; the audit
  summary shows only the detail bits, never raw JSON.
- **Journey G** (`e2e/journeys/g1-g4.spec.ts`): G1 onboarding → go live, G2 first sign-in → switched off → session
  ends, G3 price and limit changes with reasons (checked after reload), G4 flagged audit + CSV link, 1024 px.
- **Hands-on (`e2e/walk-admin.mjs`, Bangla):** Green Life Uttara onboarded up to a complete checklist — **Go live is
  left for Kamrul** (`01711000011` / setu1234 / PIN 2580; a live facility never goes back to setup).
- **Tests:** domain 266, api 226, `pnpm typecheck` 13/13, Playwright 84. Full runs: 84/84 (6.4 min); 82/84 (9.5 min —
  the dev server slowed: journey A's public verify page hung loading, P1's dispense list missed its 5 s; both green
  re-run alone, 6/6); 84/84 (6.3 min). Watch for it: if it recurs, restart `next dev` before a run.

## Done (SMS + bKash, session 1 of 2, 04/10/2026) — bKash tokenized checkout ✅
Kamrul's decisions: SMS through **BulkSMSBD** (session 2), bKash built to the documented API with a local stand-in until
sandbox credentials arrive, two sessions. **ADR 0011.**
- **How bKash works (developer.bka.sh v2):** create → bKash gives a page URL (nothing is sent to the patient) → the
  patient pays on it → bKash sends the patient's browser back to us → **we execute; money moves only there, once per
  paymentId**. Token grant + refresh at most twice an hour or the merchant is blocked for an hour.
- **Payment first (open question 90):** the Payment commits `initiated`, the link is made after the commit
  (`command` `after` hook → `attachLink`); a gateway refusal fails it and frees the amount.
- **The patient's side (public, no login, no patient details):** short link `<PUBLIC_APP_URL>/p/<code>` (QR on the
  cashier's screen) → bKash's page; return `GET /v1/payments/return/bkash` → claim once under the bill's lock →
  execute → `/pay/result?o=…&c=<code>` (the page asks the server by the code; nothing else rides in the URL). A replaced,
  cancelled or expired link (30 min) is never executed.
- **Sweep** (every minute, `server.ts`): a link never made, or an execute never answered, after 5 minutes.
- **Adapters:** `BkashProvider` (token in `GatewayToken`, owner-only, through SECURITY DEFINER functions; renewals
  counted in the database — failed ones too — and stopped locally at two an hour); `BkashSandboxStandIn`
  (`pnpm --filter @setu/api bkash:standin`, port 4199, wallet 01770618575 / OTP 123456 / PIN 12121).
  `PAYMENTS_PROVIDER=bkash` puts bKash on the real adapter; Nagad stays on the fake in dev and is **unavailable in
  production** (the fake's secret is public).
- **Staff:** Pay shows the QR, the short link and copy for bKash, "completing" during an execute, why a payment failed;
  the pay button says "Make payment link" until SMS lands.
- **Reviews:** security (fixed: Nagad on the fake in production = forgeable "paid"; result page parameters spoofable;
  rate-limit key from the left of X-Forwarded-For; https / bka.sh checks) and money (fixed: an execute timeout failing a
  payment bKash completed → double charge; a late Completed dropped silently; the TrxID check on a failed payment;
  amount mismatch freeing the amount; token renewals able to lock the merchant out; a slow renewal outliving its
  transaction). Open: questions 205–212.
- **Tests:** domain 274 (+8 wallet), api 238 (+12 `bkash.test.ts` against the stand-in), `pnpm typecheck` 13/13,
  Playwright 84 green twice + journey K 2/2 in bKash mode (`e2e/journeys/k1-k2.spec.ts`, skipped in the default run).
- **Run journey K / the hands-on:** start the stand-in, run the API with `PAYMENTS_PROVIDER=bkash` and the printed
  `BKASH_*` settings, `DELETE FROM "GatewayToken"` (a new stand-in knows no earlier token), then
  `BKASH_STANDIN=1 STAFF_URL=http://localhost:3300 pnpm e2e journeys/k1-k2.spec.ts --project=desktop-1440`;
  `node e2e/walk-bkash.mjs <dir>` for screenshots. Switch the API back to the fake before the full suite.
- **Before real money:** sandbox credentials from bKash → run journey K against `tokenized.sandbox.bka.sh`; check the
  return's `signature`, the `Authorization` form (raw vs Bearer) and the live hostname (open question 207).

## Done (SMS + bKash, session 2 of 2, 04/10/2026) — SMS through BulkSMSBD ✅
**ADR 0012.** BulkSMSBD (`POST https://bulksmsbd.net/api/smsapi`, key in the body; https works with a valid
certificate) answers 202 = **accepted** and has **no delivery reports and no client message id**.
- **"Sent" is not "delivered":** `SendResult` `sent`; `Messenger.confirmsDelivery`; `Communication.deliveryConfirmed`
  (default false). Lab delivery, the doctor's "Seen + tell", the Pay screen and the admin's test SMS say "Sent
  (delivery not confirmed)" for BulkSMSBD; FakeMessenger still confirms delivery.
- **Failures:** the number / the facility's setup (sender id, balance, account, IP whitelist) / the gateway / no answer
  ("it may have been sent"). We store our own words per code, never the gateway's text.
- **Stuck messages (open question 124):** `sweepSms` every minute — queued > 1 min sent, sending > 2 min failed "it may
  have been sent"; never resent by itself; nothing older than 30 min, and no payment link that is no longer the
  payment's. Retry / "Send again" of a message the patient may already have needs "they may get it twice" accepted
  (audited); a lab SMS that was only "sent" can be sent again as a new message.
- **Payment link by SMS:** when a bKash link is made (patient with a mobile number): Bangla + English, then the link
  once; facility, bill number, amount only. "Send SMS again": five per payment, a minute apart. An earlier attempt's
  short link says "ended".
- **Admin's test SMS:** with BulkSMSBD it is done when the admin confirms "it arrived" (24 h); a failed test undoes an
  earlier one and shows why; five tests an hour per facility; a facility name in an SMS carries no web address.
- **Stand-in:** `pnpm --filter @setu/api sms:standin` (port 4198, `/inbox` shows what it took, like a phone).
- **Reviews:** security (fixed: test SMS and "Send again" unlimited — cost and phishing via the facility name; the
  gateway's raw error text stored; unbounded timeout setting) and controls (fixed: confirm after a failed test; no
  duplicate warning; no way to resend a "sent" lab SMS; the sweep sending stale messages; old links "not found"; a late
  result landing on a newer attempt; "not delivered" for a may-have-been-sent message; the payment SMS carrying the
  link twice). Hands-on found the link twice. Open: questions 213–219.
- **Tests:** domain 278, api 245 (+6 `sms.test.ts`, +1 lab duplicate-risk retry), `pnpm typecheck` 13/13, journeys K + L
  4/4 on both stand-ins (`e2e/journeys/l1-l2.spec.ts`). Playwright default suite (84 + 4 skipped stand-in journeys):
  first run after the review fixes 3 failures — a real bug (the doctor's "Seen + tell" and the lab's recollection SMS
  showed "sent" for a FakeMessenger SMS that was delivered: the route's merge dropped `deliveryConfirmed`) — fixed; then
  runs 82/84 (2 failures not identified — the next run overwrote their reports), 84/84, 84/84. If failures recur,
  keep `test-results` (run with `--output`) before the next run.
- **Run on the stand-ins:** start both stand-ins, run the API with the printed `BKASH_*` and `BULKSMSBD_*` settings
  (`PAYMENTS_PROVIDER=bkash SMS_PROVIDER=bulksmsbd`), `DELETE FROM "GatewayToken"`, then
  `SMS_STANDIN=1 BKASH_STANDIN=1 STAFF_URL=http://localhost:3300 pnpm e2e journeys/k1-k2.spec.ts journeys/l1-l2.spec.ts --project=desktop-1440`;
  `node e2e/walk-sms.mjs <dir>` for screenshots. Switch the API back to the fakes before the full suite.
- **Before real SMS:** the BulkSMSBD key and sender id in `.env` (rotate the key that was pasted in chat if it is the
  real one); whitelist the server's IP; one real test SMS from the admin wizard; ask BulkSMSBD about delivery reports
  and `type=unicode` for Bangla (question 214).

- Shell specs still sign in as Green Life users; they only read.

## Done (refunds, session 1 of 2, 05/10/2026) — refund rules, database, contracts, routes, bKash refund ✅
Kamrul's decisions: open questions "Refunds slice, session 1". **ADR 0013.** **Session 2:** `bill/refund` and `ph/refund`
(ported from the prototype's Refunds screen; Refund buttons on `bill/pay` / `ph/pay`), the refund kind in Approvals, the
voucher PDF (A5 + thermal, amount in words, recipient and signature line, DUPLICATE #n) and `/verify/rf/[code]`, strings
in `billingApp` / `pharmApp`, the journey spec, reviews, hands-on as cashier, pharmacist and owner.
- **Domain:** REFUND machine (requested → approved → paid; rejected; approved → withdrawn); INVOICE `markError` from
  partially-paid / balanced; `refund.ts` (performed = locked, credit-note parts with VAT in proportion, the way back per
  method, request / approval / withdraw blockers, recipient check); `dispenseStatus` with returns; `resaleBlockers`;
  refunds KPI live; inbox `return-notice`; `ph/refund` hand-added to the access matrix (+ test).
- **Database** (migrations `20261005100000_refunds` … `20261005100400_refunds_fixes`): Refund, RefundLine,
  RefundAllocation, RefundVoucher (+ prints), StockResale; Invoice.refundedPaisa; MedicationDispense `return`. Guards: the
  machine through its approval task, decided by the facility's owner / admin and never the requester (owner when
  `needsOwner`), one open refund per bill, caps per bill line / payment / bill, the way back per method, cash from the
  payer's open shift, manual flagged, at commit: sums, voucher, returns and refundedPaisa; void only once paid = refunded,
  no refund open, all medicine back; returns into quarantine once per refund line; quarantine → counter only on a resale.
- **API:** refundable, request, list, view, decision, pay (gateway claimed, refunded after the commit), check, voucher,
  public `/v1/verify/rf/:code`, reconciliation → refund, pharmacy resale; refunds in the single Approvals queue and in the
  reconciliation queue (refunds paid by hand); void after refund; shift cash refunds (question 150 closed); dashboard tile,
  leakage (refunds paid, medication incidents, unmatched manual refunds), drills; the refunds sweep.
- **bKash:** `refund/payment/transaction` + `refund/payment/status` in `BkashProvider` and the stand-in (developer.bka.sh
  v2, read 05/10/2026: 10 partial refunds per transaction, 60 days, no duplicate in 10 minutes, status check when there is
  no answer). Never refunded again by the system; a person's retry asks Refund Status first.
- **Tests:** domain 305, api 264 (refunds.test.ts 10, bkash.test.ts 21), typecheck 13/13. Playwright (no screen changed
  except the Approvals buyer line): run 1 81/84 (G4 audit order and a shell page-load timeout — both green alone, 21/21),
  run 2 83/84 (A4 timed out with 12 GB of 15 in use by other projects — green alone 4/4). Not yet two clean full runs.
- **Debugging tip:** API tests hide 500s (the logger is off under NODE_ENV=test): to see one, temporarily add
  `console.error(e)` beside `req.log.error(e)` in `apps/api/src/app.ts`.
- **Run the refund routes on the bKash stand-in:** as for journey K (`PAYMENTS_PROVIDER=bkash`, the printed `BKASH_*`);
  on the fake (the default) bKash and Nagad refunds are made by hand with a reference.

## Done (refunds, session 2 of 2, 05/10/2026) — Kamrul's decisions, screens, voucher, journey R, reviews, hands-on ✅
The refunds slice is **done**. Kamrul's decisions on questions 220–232 (open questions "Refunds slice, session 2"), ADR 0013
addendum.
- **Decisions built first (step 0):** one refund = one payout method, never part-paid (220); a return without refund on an
  unpaid pharmacy / OTC bill — `Invoice.creditedPaisa` lowers the due, credit voucher CV/yy/nnnn, then the ADR 0005 void
  (221; receipts print the credit, a bill is balanced at total − credited); self-approval only as the facility's only
  approver, with a note, flagged everywhere (223, database `facility_approvers`); unrecognised bKash refund codes are
  "unknown — ask Refund Status" (227).
- **Screens:** `bill/refund` and `ph/refund` (one component): list, request (performed = locked, units for medicine,
  one way back, wallet → cash only without wallet access), one refund (approve / reject, pay with who took the money,
  manual reference, bKash "processing" + check, refused → cash, withdraw, history), the voucher printed / reprinted like a
  receipt. Refund buttons on `bill/pay` / `ph/pay`; refund items in Approvals (Refunds filter) and Reconciliation
  (manual refunds "Matches the statement", "Refund to patient" on a case); `ph/stock` "Release to counter"; the doctor's
  return notice; dashboard drills open refunds and show their state; public `/verify/rf/[code]`.
- **Voucher PDF** (`apps/api/src/receipts/voucher.ts`): A5 / 80 mm, Bangla + English, QR, credit-note lines with net and
  VAT, amount in words, how it went back, requested / approved (self-approved) / paid by, recipient above a signature line.
- **Reviews:** security (1 high — an unreadable Refund Status answer counted as "nothing refunded"; 2 medium — a case
  refund sent against the bill's link instead of the case's, several rules app-only; 3 low) and money (2 high — a return
  recorded after money arrived, returns counted as money refunded; 3 medium — a test collected after the request, a case
  closed before the money moved, a partly paid bill returned in full; 4 low) — all fixed in `c5723cf` except money M5
  (question 233). Migration `20261005210000_refunds_review`.
- **Hands-on (`node e2e/walk-refund.mjs <dir>`, demo clinic, Bangla, owner at 412 px):** cashier cash refund → owner
  approves on the phone → paid to Rashed Chowdhury (spouse) → voucher printed → public check; pharmacist wrong dispense →
  doctor's notice → released to the counter; return without refund → CV voucher → due 0; the owner's dashboard. Found and
  fixed: Bangla digits refused in the units box, the voucher's paper labelled "Mushak-6.3", returns counted in "refunds
  paid" (now their own row), a fully returned bill still offering "take payment".
- **E2E:** `journeys/r1-r4.spec.ts` (R1 cashier refund + voucher + public check, R2 wrong dispense → quarantine → doctor →
  release, R3 return without refund → CV → void, R4 dashboard). Journey R uses a **second E2E cashier `01799000012`**
  (seed) so its drawer never meets journey C4's.
- **Tests:** domain 311, api 270 (refunds.test.ts 15, bkash.test.ts 22), typecheck 13/13, **Playwright 88 green twice in a row** (84 + 4 journey R; 7.8 and 7.5 min, 2 workers, fresh `next dev`).
- **Watch:** the API test suite failed in unrelated files while the dev API (`tsx watch`) ran beside it and passed 270/270
  without it — stop the dev API before `apps/api pnpm test`. A long-running `next dev` slowed until journey C4 timed out
  (C4 alone: 3.5 min tired → 47 s fresh): restart it before a full run.
- **Pre-pilot (bKash sandbox):** the duplicate-refund and 11th-refund codes, Refund Status's `trxId` meaning, a manual
  release for a refund stuck "processing" (question 235).

## Done (refunds, follow-up, 05/10/2026) — Kamrul's decisions 233–235 ✅
ADR 0013 addendum 2; migrations `20261005220000_refunds_decisions_233_235`, `20261005220100_refunds_233_fix`.
- **233 a return on a partly paid bill:** one request; credit = min(value, due) lowers the due (`Refund.creditPaisa` →
  `Invoice.creditedPaisa`), the rest is refunded from confirmed money through the allocations (one way back, who took
  it); one approval, one voucher with both parts (RF when money went back, CV when it only credited); the bill is
  balanced when the due reaches what was paid; then the ADR 0005 void. A fully paid bill has no due → a refund. The
  request screen shows the split ("Off the due" / "Refunded") and asks for a way back only when money leaves.
- **234 one self-approval rule everywhere:** stock counts follow refunds — the counter decides their own count only as
  the facility's only approver, with a note (`StockCount.selfApproved`, the count screen asks for the note, the
  database re-checks with `facility_approvers`), flagged in the audit and counted on the owner's self-approved
  exceptions row (drill rows open the count). Open question 186 is decided.
- **235 the owner's manual release** of a bKash refund stuck "processing": `POST /v1/refunds/:id/release` (owner only,
  after `REFUND_RELEASE_MINUTES` = 30 since the claim) — "not refunded on the portal" (note) hands the allocation back
  failed so the cashier retries or pays cash; "refunded, TrxID" pays it; both audited (`owner-release`) and both open a
  refund-reconciliation case. The refund screen shows the owner the release card after the wait (and the wait until then).
- **Tests:** domain 313, api 273 (refunds 17: +233, +234; bkash 23: +235; purchasing's own-count case) — every file green;
  typecheck 13/13. **Playwright 89** (84 + journey R's 5, R5 added for 233): full runs this evening were under heavy load
  from other projects (an Android emulator + Android Studio, ~6 GB; load average 8–10) — run 6 (1 worker) 88/89 with P6
  failing on a real bug (the count screen's new state hook sat after an early return — fixed in `e6e2bb8`), run 7
  (2 workers) 87/89 with two load stalls (P5's screen not visible in 5 s; R1's public verify page never loaded in 150 s)
  that passed alone straight after (6/6). The API suite under the same load: Prisma connection and 5 s timeouts in
  unrelated files; each file green alone. A quiet machine and two clean full runs are still owed before this is called
  closed — first thing next session.
- **Found in the run's API log:** `GET /v1/approvals` crossed the 5 s transaction limit once — `approvalItem` re-read the
  facility's whole bill list per item (A6-era; the E2E clinic has thousands of bills after many runs). Now read once per
  list. The refund items' per-task reads in `refundApprovalItems` are small (by refund id) and left as they are.
- **Playwright close-out (05/10/2026 evening, before slice B1–B2, 89 specs, 2 workers, a fresh `next dev` each run,
  load 7–9 and ~3 GB swap from other projects' containers):** three full runs, each 88/89 with a different single
  stall, each green alone straight after — run 1 (9.8 min) `a8-a11` decision D5 (the reason textarea kept detaching for
  120 s; 6.7 s alone), run 2 (8.7 min) `g1-g4` G4 (the filtered audit table empty for 5 s; 5.9 s alone), run 3 (8.6 min)
  `p1-p6` P1–P3 (the dispense row absent for 5 s; 25 s alone). Each is a 5 s expectation on a list right after a
  navigation while the dev server was busy — load stalls, not bugs. Kamrul's call: the two clean runs come from CI.

## Done (slice B1–B2, session 1 of 2, 05/10/2026) — ER arrival, triage, disposition; admission to a bed (backend) ✅
ADR 0014. Kamrul's plan decisions (05/10/2026): the five assumptions accepted with three refinements (STAT lab orders
carry the priority flag and sit at the top of the lab worklist; a provisional quick registration lands on the desk's
review queue and blocks nothing in the ER; death / refer / discharge close the ER encounter when signed) and three
confirmations (occupancy enforced in the database, reserve and occupy in one transaction with the admission, the IPD
bill draft created by the admission and nowhere else).
- **Domain (`er.ts`, `ipd.ts`, 29 tests):** the five-level triage scale as a **sample pending clinician sign-off**
  (targets 0 / 10 / 30 / 60 / 120 min, untriaged overdue after 10), overdue = past target and unassigned, board order,
  the paediatric prompt (issue #24), dispositions and their blockers (death: certificate + family, police when
  medico-legal), the unknown patient's name, the care-order sample list; bed classes (sample), the bed picker
  (vacant or reserved for this patient), consents (general, financial, guardian ID required), the admission checklist
  (deposit shown, never blocking), ADM/yy/nnnn, the **two-leg bed move** (reserve → occupy + vacate / release) and
  **BED `vacate`** (occupied → cleaning).
- **Database:** `ErVisit`, `BedAssignment` (the location history; append-only, the session user as "who"), `Admission`,
  `Invoice.kind ipd`, `Location.bedNote`, encounter tokens unique per class (ER tokens `E-nnn`). Guards: one live
  assignment per bed, one occupied and one reserved per patient, one open inpatient encounter per patient, one
  requested admission per patient, one live IPD bill per encounter; `Location.bedState` ⇔ the live assignment at
  commit (both directions, deferred); an ER encounter has its ErVisit and an inpatient encounter its admitted
  Admission; an IPD bill only from an admission (deferred). Probed in psql, then through the API tests.
- **Seed:** the **E2E Lite Hospital** `t_e2e_lite` (plan Hospital Lite, prefix E2L, users 017980000xx: desk 01, ER
  doctor 02, paediatrician 03, nurse 04, surgeon 05, lab technologist 06, cashier 08, owner 09, admin 10; the
  walkthrough family as `e2l_`), wards ER (4 bays, class ER), 2A (6, 2A-05 cleaning, 2A-06 blocked "O₂ line
  repair"), Cabins (3), HDU (3) — the same shape the admin masters make; the same wards for the Meghna Lite demo and
  an ER + HDU for Green Life; doctor specialities. `pnpm db:reset-e2e` ends live assignments, puts beds back, cancels
  requested admissions, closes ER / IPD visits and provisional reviews in both E2E tenants in one transaction.
- **Contracts and routes:** `GET /v1/er/board`, `POST /v1/er/arrivals` (existing patient or `unknown` → provisional
  record + review task), `/v1/er/encounters/:id/{triage,assign,orders,care-orders,notes,disposition}`,
  `GET /v1/er/encounters/:id`; `GET /v1/ipd/beds`, `POST /v1/ipd/beds/:id/actions` (block with reason / unblock /
  mark ready), `GET|POST /v1/ipd/admissions`, `GET /v1/ipd/admissions/:id`, `POST …/cancel`. ER writes are the
  clinical team's (doctor, nurse); the disposition is signed by a doctor with the PIN (never stored in the replay);
  the admission desk is receptionist / admin; bed actions nurse / receptionist / admin. OPD lists (queue, vitals,
  consultation, billing, pharmacy worklists) show OPD visits only; the vitals route never triages an ER visit; the OPD
  bill route refuses an inpatient (`inpatient_bill`).
- **Tests:** domain 344, api 294 (er 13, ipd 8), typecheck 13/13. The API suite ran with the dev API stopped.
- **Session 2 (next):** strings in new `erApp` / `ipdApp` namespaces; screens `er/triage`, `er/orders`, `ipd/admit` in
  `registry.tsx` (the bed picker shared with the later bed map; `er/unknown` = the quick registration inside the
  arrival form, merge later); the lab's collection and result screens show the STAT marker; the banner shows this
  patient (issue #1); `journeys/b1-b2.spec.ts` in the E2E Lite Hospital; `e2e/global-setup.ts` warms the new pages;
  reviews; hands-on `e2e/walk-er.mjs` as the ER nurse, the ER doctor and the admission desk in the Meghna Lite demo.
  Open questions 240–248.

## Done (slice B1–B2, session 2 of 2, 05/10/2026) — the ER and admission screens, journey B1–B2, reviews, hands-on ✅
- **Screens (`apps/staff/modules/er`, `ipd`; strings `erApp`, `ipdApp`):** `er/triage` — the board by level with ⚠
  past target, the legend with counts and the "pending clinician sign-off (sample scale)" tag, the panel (level 1–5,
  bay, doctor with the paediatric prompt, Record vitals, Orders & disposition), the arrival dialog for a registered or
  an unknown patient (the ER team's own search `GET /v1/er/patients`: the desk's search screen is not theirs);
  `er/orders` — the strip with allergies, one-tap STAT lab orders, the sample care orders, the ER note, the four
  dispositions with their blockers, the PIN sheet; `ipd/admit` — the ER's requests, a direct admission by search, the
  form (source, doctor, department, class with sample prices, the shared `BedPicker`, guardian, consents, the deposit
  line that never blocks, the checklist), Admit, cancel request, today's admissions. The lab's worklist, collection and
  result screens mark STAT. Banner = this patient (issue #1); nothing clipped at 1440 (issue #21).
- **Journey `journeys/b1-b2.spec.ts` (6, E2E Lite Hospital):** B1 arrival on a bay, level 2, the paediatric prompt, the
  ER doctor; the unknown male → provisional → the desk's review queue; B2 STAT CBC at the top of the lab's collection
  list, a care order, the admit disposition after a wrong PIN with 2A-05 / 2A-06 not pickable; the desk's Admit → ADM
  number, bed occupied, bay cleaning, IPD bill draft, ER visit finished; a discharge.
- **Review (code review, 18 findings, all fixed in `d3935fa`):** high — a cancelled admission request stranded the ER
  visit (now: the admit disposition is cleared from the visit and the doctor signs a new one as an amendment, v2 /
  v1 superseded; `canRedispose`); reset-e2e wrote a Lite row's audit under the clinic; medium — time of death shifted by
  the timezone, unsaved note text lost on a reload, a bay change without a level sent nothing, a stale note cost a PIN
  try, the ER request's department was free text, link chains, Admission / BedAssignment status outside a machine (now
  `ADMISSION`, `BED_ASSIGNMENT`), raw reason keys inside Bangla messages, the domain's leg not applied to the source bed;
  low — Dhaka year, repeated queries per view, copied helpers, async bedView, dead code, a direct admission of a patient
  in the ER now comes from that visit.
- **Hands-on (`node e2e/walk-er.mjs <dir>`, E2E Lite Hospital, Bangla, nurse → doctor → desk, 15 screenshots):** found
  and fixed: the guardian's phone in Bangla digits refused by the checklist (now accepted, stored as Latin digits), the
  admitted card repeating the ADM number, the move legs in raw English, closed board rows showing a meaningless wait.
- **Tests:** domain 347, api 296 (er 13, ipd 9), typecheck 13/13, journey B 6/6; **full Playwright run 4: 95 passed, 4 skipped, 0 failed** (8.2 min, 2 workers, fresh `next dev`, load ~5) — the first clean full run on this machine; CI brings the second.
- **Not in this slice (next slices):** the bed map and transfers (B3–B4: the picker and the two-leg move are ready),
  the IPD running bill, deposit and package (B8), ER billing, the unknown-patient merge, the referral letter and the
  death certificate, discharge from the ward (B9–B12).

## Known gaps (fix in the slice that touches them, or when listed)
1. ~~RLS is bypassed at runtime~~ — fixed in A1–A3 (`setu_app`). Production: the migration role must be superuser or BYPASSRLS for `auth_login_lookup` (open question 11).
2. ~~MinIO image cannot be pulled~~ — dev and tests store receipts with `LocalFolderStorage` (A6–A7). Before staging: an S3-compatible adapter behind the same `Storage` interface.
3. Password and PIN hashing is dev-only SHA-256 (`apps/api/src/modules/users.ts`); replace with argon2id in the auth hardening pass (before the pilot).
4. PIN attempt counter and idempotency keys live in memory when the DB is off; with the DB they use `IdempotencyKey`; PIN tries should move to Redis.
5. Home-page figures are sample data; each slice swaps its tiles/rows for live queries.
6. Patient app (`apps/patient`) is a placeholder until Journey D.
7. Prisma migrations: create with `--create-only`, append SQL, then apply (see `packages/db/prisma/migrations/README.md`). Never edit an applied migration.

8. Front desk follow-ups (not blocking A4): queue reorder with reason (+ audit), Lab/Billing queue columns, register "Save draft" and the register-screen Compare for an unsaved form (today: "Visit on this record" per candidate), payer/photo/referral fields (need Coverage/Media), records-officer role for review Tasks, branch choice for multi-branch organisations.
9. Some screen strings still come from the shell's inline `L(bn, en)`; new screens use `packages/i18n` namespaces (`locales/app/*.json`).
10. **Pre-pilot security pass** (decided 02/10/2026, open questions 20 and 24):
    - composite `(tenantId, id)` foreign keys for Patient.linkedToId, Task.focusId/candidateId, Provenance.targetId and Encounter.patientId (defence in depth beside RLS);
    - `pnpm db:migrate` must stop sending the `setu_app` password in plain text (SCRAM hash, or statement logging off);
    - together with gap 3 (argon2id) and gap 4 (PIN tries in Redis);
    - device drafts and queued outbox writes encrypted (or signed) with a key bound to the server session, so a copy
      left in a browser is unreadable and a planted copy is never sent (security review A5, open question 79).
12. **Pre-pilot clinical content (decisions D2, D3 of 02/10/2026):**
    - **Lab (slice A8–A11, D1/D2):** a clinician signs off the sample analytes, adult ranges, critical thresholds and the
      20% delta rule in `packages/domain/src/lab.ts`, adds men's ranges for Hb and creatinine, children's ranges, the
      impossible-value limits, and result templates for lipid profile, urine R/E, urine C/S, TSH and SGPT (decision
      116: until then those tests cannot be entered and keep a visit's report preliminary).
    - ICD-11: a clinician verifies the 10 seeded codes against the WHO ICD-11 browser; production source = WHO ICD-11
      API or a local extract.
    - Medicines: a licensed drug database with DGDA numbers + clinician-approved allergy/interaction rules; the demo
      list's class matching is a demo check only (`packages/domain/src/catalog.ts`, all rows `sample`).
    - Clinician questions from session 2 (open questions 53, 54, 56, 58): esomeprazole in the interaction rule, same
      medicine against earlier visits, allergy cross-reactivity, severity and blocking.
    - Lawyer: AI scribe consent wording before any recording is turned on (the tick stays disabled until then).
    - Vitals limits (decision 46): clinician sign-off of the default thresholds (prototype + adult NEWS2) in
      `packages/domain/src/vitals.ts`, a critical-high glucose, and paediatric/infant ranges (none yet; under 18 the
      screen says the ranges are for adults).
    - **Dose formats beyond tablets (syrup, drops, injection) are not yet accepted** (Kamrul, 03/10/2026): the Rx
      builder takes only tablet/capsule counts like 1+0+1 (`packages/domain/src/format.ts` `dose`; the screen says so
      under the prescription). A clinician decides the formats (ml, drops, IU, "as needed") and a per-dose cap
      (open question 78).
    - **Pharmacy (pre-pilot, a pharmacist):** verify the uploaded photo is a prescription (prescriber, date, the items
      and quantities sold against it) — today any JPEG / PNG unlocks prescription-only items on that OTC sale; the sale
      classes (OTC / Rx / controlled) of the demo list (`packages/domain/src/pharmacy.ts`, all `sample`); whether
      controlled drugs need a register entry or a second check; substitution rules (same ingredients, strength and form)
      and the dose-label wording.
11. **Patients are per tenant** (decided 02/10/2026, open question 21): one record shared across an owner's branches; between different owners only through Connected Care with consent (Journey E), never by default.

## Next (in order)
1. ~~`/slice A1-A3`~~ — done 02/10/2026.
2. ~~`/slice A4-A5`~~ — done 02–03/10/2026 (three sessions). Kamrul to confirm open questions 68–82.
3. ~~`/slice A6-A7`~~ — done 03/10/2026 (two sessions) + ~~billing follow-ups~~ done 03/10/2026 (ADR 0005). Kamrul to
   confirm open questions 107–113. Refunds (and voiding a bill that holds money) are a later slice.
4. ~~`/slice A8-A11`~~ — done 03/10/2026 (two sessions). Kamrul to confirm open question 134.
5. ~~`/slice A12-A13`~~ — done 03/10/2026 (two sessions); **Journey A complete**. Kamrul to confirm open questions
   135–149.
6. **Phase 2 pilot clinic, split in four slices (Kamrul, 03/10/2026):** ~~`/slice C1-C4`~~ owner dashboard + shift close
   (done 03/10/2026; Kamrul to confirm open questions 150–165) → **pharmacy** (session 1 done 03/10/2026, questions 166–178; session 2 done 03/10/2026, questions 179–191; session 3 done 03/10/2026 — the screens and journey P, questions 192–194) → ~~admin~~ (done 04/10/2026, two sessions; questions 195–204) → ~~SMS + bKash~~ (done 04/10/2026, two sessions; questions 205–219). **The four Phase 2 pilot-clinic slices are done.** ~~**Refunds**~~ done 05/10/2026 (two sessions + the 233–235 follow-up; ADR 0013; questions 220–239, 233–235 decided). **Phase 3 Journey B started:** ~~`/slice B1-B2`~~ done 05/10/2026 (two sessions; ADR 0014; questions 240–253). Then `/slice B3-B4` (bed map, transfer, the ward's view) and on per `docs/CLAUDE-CODE-GUIDE.md`. Or Kamrul's call — the pre-pilot hardening (known gaps 3, 4, 10, 12: argon2id, PIN tries in Redis, composite keys, clinical sign-offs), real credentials (bKash sandbox, BulkSMSBD), then the pilot; or Phase 3 per `docs/BUILD-PLAN.md`. See open questions "Phase 2 plan".
Prompt texts for each are in `docs/CLAUDE-CODE-GUIDE.md`.

## Conventions worth repeating
Every write route takes `Idempotency-Key`; every table has `tenantId`; money is paisa; strings through `@setu/i18n`; numbers through `@setu/domain` `format`; status changes only through `@setu/domain` state machines; a journey step is done when its Playwright spec is green on the real stack.
