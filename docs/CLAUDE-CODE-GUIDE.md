# Working on Setu with Claude Code — runbook

Everything Claude Code needs is in the repo: `CLAUDE.md` (the rules it reads every session), `.claude/commands/slice.md` and `review.md`, `docs/BUILD-PLAN.md`, the design handoff, the prototype pages and the walkthrough test log. This file is the copy-paste runbook.

## 1. One-time setup (after the restart)

Open **PowerShell** (normal, not admin) and run, one line at a time:

```powershell
cd "C:\Users\User\Desktop\Cowork\Setu Health APP\setu"
pnpm install
copy .env.example .env
pnpm db:up                 # Docker: Postgres, Redis, MinIO — wait ~20 s the first time
pnpm db:migrate            # name the migration: init
pnpm db:seed               # Green Life Clinic demo tenant
```

Then turn on row-level security (once): open `packages\db\prisma\migrations\<timestamp>_init\migration.sql`, paste the contents of `packages\db\prisma\rls.sql` at the end, save, and run `pnpm db:migrate` again.

Back up the code to GitHub (private repo), so every day's work is safe:

```powershell
git init -b main            # only if the folder has no .git yet
git add -A
git commit -m "Phase 0: scaffold, design system, staff shell"
gh auth login               # or create the repo on github.com and copy its URL
git remote add origin https://github.com/<you>/setu.git
git push -u origin main
```

## 2. Every working session

Two terminals in the `setu` folder:

**Terminal 1 — the stack** (leave running):

```powershell
pnpm dev
```

API on :4000, staff app on :3000, patient app on :3001. Log in at http://localhost:3000 with phone `01711000002`, password `setu1234`, PIN `1234`.

**Terminal 2 — Claude Code:**

```powershell
claude
```

First time in this folder, Claude Code asks to trust it — say yes. It reads `CLAUDE.md` automatically.

Useful inside Claude Code:

| Type | What it does |
| --- | --- |
| `/slice A1` | Implements one journey step end to end; it stops after the plan and waits for you to say **go** |
| `/review` | Runs typecheck, tests and the e2e specs touched, checks the CLAUDE.md rules, drafts the commit message |
| `/clear` | Start a fresh context (do this between slices) |
| `Shift+Tab` | Toggle plan mode — Claude Code only plans, no edits; use it before anything touching money, signing or consent |
| `Esc` | Interrupt what it is doing |
| `/compact` | Shrink the context when a session gets long |

Rhythm that works for a solo builder: **one slice per session** → read the plan → `go` → when it says done, open the browser and click through the step yourself → `/review` → `git commit` → `/clear`.

## 3. The prompts, in order

Prompts 1–4 are done. Paste each of the following as one message. Where it says `/slice`, that is the command — the text after it is the step.

### Prompt 5 — Front desk (A1–A3)

```
/slice A1-A3
Scope: patient search (Bangla and English names, phone, shared-phone warning, "no match → register"), duplicate review with field-level Same / Similar / Different / Missing, "Send for review" or "Link anyway" with a ≥10-character reason and a confirm dialog when any field conflicts (never one-click link for conflicts), registration with the prototype's validation (required fields, Bangla digits, approximate age, invalid/future DOB, phone check; blocked save shows "N fields need attention"), and visit creation with a per-branch daily token (A-017 style) that lands the queue on the patient just registered.
Reference pages: docs/prototype/Setu Front Desk.dc.html (screens search, match, register, queue). Walkthrough checks: docs/test-log (issues #4, #5, #21, steps A1–A3).
Register the screens in apps/staff/modules/registry.tsx as fd/search, fd/match, fd/register, fd/queue. Set the patient banner from the screen via useSession().setPatient when a patient is in context.
```

### Prompt 6 — Vitals and consultation (A4–A5)

```
/slice A4-A5
Scope: Observation batch write with abnormal-value warnings and impossible-value blocking (A4); the Consultation module (complaint, ICD-11 search in Bangla and English, orders, prescription builder with allergy conflict blocking the sign and a "same medicine already prescribed" warning, AI panel behind the FakeAi adapter labelled "draft — not a diagnosis"), sign with PIN that only becomes final after the server acknowledges, amend creating a new version with the old one superseded. Inside the shell "/" must focus the Rx search (not global search).
Reference: docs/prototype/Setu Consultation.dc.html; state machine DOCUMENT in packages/domain/src/machines.ts; walkthrough issues #9, #16, steps A4–A5.
```

### Prompt 7 — Billing (A6–A7)

```
/slice A6-A7
Scope: ChargeItem/ChargeItemDefinition and Invoice with lines, VAT per line in paisa, discount above the cashier's limit creating an approval Task (nothing applied before approval); PaymentProvider interface in apps/api/src/adapters/payments with FakeProvider; payment link flow initiated → link-sent → waiting-customer → confirmed | failed → retry; cash and partial payments; receipt rendered server-side as PDF (Bangla + English, QR verify URL, Mushak-6.3 line, amount in words via format.words); the "Paid by" line lists only confirmed money with pending wallet amounts marked pending; reprint needs a reason and is watermarked DUPLICATE and audited.
Reference: docs/prototype/Setu Billing.dc.html; machines INVOICE, PAYMENT, APPROVAL; walkthrough issue #10, steps A6–A7. The A6 bill must contain the tests ordered in A5 (CBC, RBS, S. Electrolytes).
```

### Prompt 8 — Lab (A8–A11)

```
/slice A8-A11
Scope: ServiceRequest → Specimen with tube guidance, label printing (on-screen confirmation), reject with reason that queues a recollection SMS through the Messenger interface (FakeMessenger); result entry with Enter-to-next, flags H/L/HH/LL with text + icon, delta check; pathologist technical verify then clinical validation gated on a logged critical-value call-back; release; delivery per channel (SMS, patient app, doctor inbox) with per-channel status and a failed send that can be retried. The Delivery screen must open in the released state when reached from the journey.
Reference: docs/prototype/Setu Lab.dc.html; machines ORDER, SPECIMEN, RESULT; walkthrough issues #2, #28, steps A8–A11.
```

### Prompt 9 — Doctor app and printing (A12–A13), then all of Journey A

```
/slice A12-A13
Scope: the Doctor App layout inside apps/staff at phone width (results inbox ordered critical-first, acknowledge notifies the patient, the red allergy strip under the patient name on quick consult, PIN sheet before "Sign & send", offline outbox with "not yet synced"); print preview A5/A4 for prescriptions with QR; drafts blocked from print with the message "Drafts cannot be printed — sign first".
Reference: docs/prototype/Setu Doctor App.dc.html; walkthrough issues #8, #14, #19, steps A12–A13.
Then run the whole of Journey A (A1–A13) end to end with pnpm e2e and fix anything that breaks the chain.
```

### Prompt 10 — Phase 2 pilot clinic

```
/slice C1-C4
Scope: Pharmacy (dispense from MedicationRequest with FEFO batches, OTC sale, stock & expiry, purchase, count & adjust), ShiftClose with denomination count, digital vs settlement, and a mandatory note to accept a variance; Owner dashboard from a nightly rollup table plus today's live counts with varied per-KPI changes and labelled chart axes; Admin onboarding wizard and Users & roles with the permission matrix. Replace FakeMessenger and FakeProvider with the real SMS gateway and the bKash sandbox behind the same interfaces, selected by SMS_PROVIDER / PAYMENTS_PROVIDER in .env.
Reference: Setu Pharmacy, Setu Owner Dashboard, Setu Admin prototype pages; walkthrough issues #23, #24, #25, steps C1–C4.
```

After prompt 10, Journey B (prompts for B1–B12), D and E follow the same pattern: `/slice B1-B2`, `/slice B3-B4`, `/slice B5-B6`, `/slice B7-B9`, `/slice B10-B12`, `/slice D1-D3`, `/slice D4-D6`, `/slice E1-E4`, each naming the prototype page and the walkthrough issue numbers from the test log.

## 4. Things to say to Claude Code when it drifts

- "Read CLAUDE.md and docs/design-handoff/domain-model.md again before continuing." — when it invents a status or a field.
- "Write the failing unit test from the walkthrough case first, then the code." — for money, signing, consent, beds.
- "Use the state machine in packages/domain, do not set the status directly." — if you see `status = "final"` in a route.
- "Every string through i18n, every number through format." — if Bangla text or taka amounts are hardcoded.
- "Stop and show me the plan." — if it starts editing before you agreed.
- "Add an ADR in docs/adr before changing that." — if it wants to change an entity or a state machine.

## 5. If something fails

| Symptom | Fix |
| --- | --- |
| `pnpm db:up` says Docker not running | open Docker Desktop, wait for "Engine running" |
| Prisma complains about the Node version | Node 24 is fine for this repo; if Prisma still complains, install Node 22 with nvm-windows and run `nvm use 22` |
| `pnpm e2e` cannot find Chromium | `pnpm --filter @setu/e2e exec playwright install chromium` (once) |
| Login page shows "Could not reach the server" | Terminal 1 is not running `pnpm dev`, or the API crashed — check its log there |
| Claude Code says a file is outside the project | start `claude` from the `setu` folder, not from `Setu Health APP` |
