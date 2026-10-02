# Handover to Claude Code — state of the project on 03/10/2026 (slices A1–A3, A4–A5, A6–A7 + billing follow-ups done; next A8–A11)

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

## How to run the journeys on this PC
- Playwright's Chromium is installed (02/10/2026): plain `pnpm e2e` runs the journeys against `pnpm dev` (staff :3000,
  api :4000). The installed-Chrome route still works: `cd e2e` then `CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" pnpm exec playwright test -c pw.local.config.ts`.
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
- Shell specs still sign in as Green Life users; they only read.

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
11. **Patients are per tenant** (decided 02/10/2026, open question 21): one record shared across an owner's branches; between different owners only through Connected Care with consent (Journey E), never by default.

## Next (in order)
1. ~~`/slice A1-A3`~~ — done 02/10/2026.
2. ~~`/slice A4-A5`~~ — done 02–03/10/2026 (three sessions). Kamrul to confirm open questions 68–82.
3. ~~`/slice A6-A7`~~ — done 03/10/2026 (two sessions) + ~~billing follow-ups~~ done 03/10/2026 (ADR 0005). Kamrul to
   confirm open questions 107–113. Refunds (and voiding a bill that holds money) are a later slice.
4. `/slice A8-A11` — lab.
5. `/slice A12-A13` — doctor app layout, printing; run all of Journey A.
Prompt texts for each are in `docs/CLAUDE-CODE-GUIDE.md`.

## Conventions worth repeating
Every write route takes `Idempotency-Key`; every table has `tenantId`; money is paisa; strings through `@setu/i18n`; numbers through `@setu/domain` `format`; status changes only through `@setu/domain` state machines; a journey step is done when its Playwright spec is green on the real stack.
