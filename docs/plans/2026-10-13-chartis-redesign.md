# Plan — redesign the whole app in the Chartis brand system (after ADR 0025)

Status: **go** (Kamrul, 13/10/2026; defaults taken: waves A → G, comfortable density with a compact table variant,
the hosted prototype updated once at the end). Step 0 templates drafted 13/10/2026 on the board's "Page templates" page —
waiting for Kamrul's approval before Step 1. Ask: "redesign properly the whole app with the redesigned brand
system including the login page".

## Where we are
ADR 0025 put the Chartis tokens and finish over the whole app (colours, type, radii, shadows, selected rows, logo).
Every screen *looks* Chartis, but none was *re-laid-out*: the 73 module files (≈14,000 lines) carry ≈1,300 hand-written
`style={{…}}` blocks, and the shared kit (`@setu/ui`, 13 components, ≈260 lines) is too thin to give screens one
consistent shape. A "proper" redesign means a real component kit and each screen rebuilt on it.

## Rules for the whole redesign
- **Presentation only.** No change to routes, API calls, state machines, permissions, i18n keys' meaning or what a
  screen lets you do. New copy only where a new layout needs a label (bn + en).
- **Tests are the contract.** Every `data-testid` / `data-*` hook the journeys use stays; each wave ends with its
  journeys green alone and the full suite + CI green before shipping. No test is loosened to make a layout pass.
- **Clinical meaning untouched:** allergy/critical red, high/low, draft violet, pending amber, paid green, provenance,
  bed colours, the patient banner's allergy chip. Printed documents keep their layout (print specs).
- **Devices:** staff desktop 1440 and tablet 1024 (vitals, ward), doctor app and patient app 360–412, the TV display.
  Bangla first; numbers through `format`.
- **One wave = one commit (or two), screenshots before → after**, staging ship at the end of each wave.

## Step 0 — page templates on the brand board (approval gate, before code)
Add to https://claude.ai/artifact/5Pf8ZxvnaNopUWPbXaBn3y:
1. **Login** — split screen: pine brand panel (mark, "Chartis HIS", the tagline in Bangla + English, the facility
   name when known) and the sign-in card (phone/email, password, language, "staging" ribbon); first sign-in and
   "session ended" variants; phone width.
2. **Staff home** — per-role start page: greeting, today's numbers as stat tiles, "your work" lists, quick actions.
3. **Work screen template** — page header (title, context, actions), filter bar with chips, list ⇄ detail split with
   the selected row style, empty / loading / error / not-in-plan states.
4. **Form template** — sectioned form with a sticky action bar (register, admit, purchase).
5. **Patient app home** (Chartis Passport) — the board's patient screen, refined.
Kamrul approves or corrects these; every screen below follows them.

## Step 1 — the component kit (`@setu/ui`)
PageHeader · Toolbar + FilterChips · SplitView (list | detail, stacks on tablet) · SelectableList / QueueRow ·
DataTable (sticky header, selected row, row actions, empty state, overflow scroll) · Section / Panel · StatTile ·
KeyValue grid · Tabs · Stepper (checklists: discharge, admission, go-live) · EmptyState · Skeleton · Drawer (side
panel) · ActionBar (sticky save/sign) · Avatar/Token tile · AuthLayout (login family). Documented on a "kit" route in
dev, typed, a11y (keyboard, focus, labels).

## Step 2 — waves (each: rebuild on the kit → screenshots → journeys → commit → staging)
| Wave | Screens | Journeys that guard it |
|---|---|---|
| A · Shell & entry | login, first sign-in, session ended, top bar, left nav, home per role, palette, not-in-plan / denied / 404, offline, print panel, public verify pages, bKash result | a1-a3, g, auth specs, all (shell) |
| B · Front desk & consultation | search, register, match, review, queue board + TV, vitals (tablet), desk claim; consultation worklist, draft, Rx, sign sheet, signed; doctor app (home, queue, consult, inbox) | a1-a5, a12-a13, d7 |
| C · Money | OPD bill, pay, receipt, refund, shift close, approvals, reconcile, packages, IPD bill; owner dashboard | a6-a7, c, r, a6-followups |
| D · Lab & pharmacy | lab worklist, collect, accession, result, verify, report, delivery; dispense, OTC, stock, purchase, count, indents, approvals | a8-a11, p |
| E · Hospital | ER triage + orders, admit + bed picker, bed map, transfer, rounds, discharge + summary; nursing ward, vitals/NEWS2, MAR, I/O, notes, handover | b1-b12, journey-b, lite specs |
| F · Admin & Link | wizard, users, masters, audit; Chartis Link consent/history, portable lab, shared records | g, e1-e4, l1-l2 |
| G · Chartis Passport | welcome/OTP, home, timeline, tests + report, share/requests/who viewed, claim (code, QR, desk), family | d, d4-d7, e4 |

Order can change (e.g. G before C if the patient app is demoed first).

## Size and cost
Step 0: one session. Step 1: one session. Waves A–G: one session each, B and E possibly two. ≈ 9–11 sessions. Each
wave is shippable on its own; the app stays usable between waves (old and new screens share the tokens).

## Decisions for Kamrul
1. Approve the approach: **templates first on the board, then the kit, then waves**.
2. Wave order (default A → G above; or patient app earlier).
3. Density for the staff app: **comfortable** (44 px rows, current board) or **compact** option for heavy lists
   (lab worklist, stock) — default comfortable with a compact table variant.
4. Prototype: after each wave, update the hosted Claude Design prototype too, or leave it to the end.

## Progress
- **Step 0** (13/10/2026): templates on the board — approved by Kamrul ("approved").
- **Step 1** (13/10/2026): the kit in `packages/ui/src/components/Kit.tsx` (PageHeader, Toolbar, FilterChips, SplitView,
  Panel, StatTile, KeyValue, Tabs, Checklist, EmptyState, Skeleton, ActionBar, TokenTile, AuthLayout, PublicFrame);
  styles `.ck-*` in `packages/ui/styles/chartis.css`.
- **Wave A** (13/10/2026): sign-in and first sign-in on AuthLayout (pine brand panel; phone: band + lifted card; show
  password; privacy note); shell (64 px top bar that never wraps a control — extras step aside below 1400 px; 248 px nav
  with section labels, the current item's bar, the plan card); home on PageHeader / stat tiles / panels / token tiles;
  page states (denied, not in plan, 404) restyled; public verify pages and the bKash result inside PublicFrame.
- **Wave B** (13/10/2026): `ScreenHeader` (crumb = module, title = screen, from the capability names) on front desk and
  consultation; search in a toolbar with the results in a panel (selected row: mist + bar) and the patient as a panel
  with a key–value grid; the queue board's selected bar card and token tile; registration's numbered sections, sticky
  duplicate box (amber when it has candidates) and lifted save bar; the consultation draft's desktop header (the phone
  keeps its compact one); the doctor app's tabs and cards; count bubbles pine instead of red.
- **Wave C** (13/10/2026): billing headers on ScreenHeader (15 screens), worklist hints as subtitles, work cards lift on
  hover, the mint **key** button (`variant="key"`) for the one money-taking action (take payment, pay, deposit, final
  bill); the owner's tiles as stat tiles.
- **Wave D–F** (13/10/2026): lab (the shared VisitHead), pharmacy, ER, IPD, nursing, admin and Chartis Link headers on
  ScreenHeader; the remaining 2 px outline selections (bed picker, admission requests, bed map, accession) moved to the
  mist + bar style.
- **Wave G** (13/10/2026): Chartis Passport — the mark in the header and on the welcome screen, the template's chips,
  timeline cards (mist icon tiles; unread with the bar), the pine "records to claim" card, tabs with the bar.
- Tests run against a production build of the staff app (`.next-prod`; the dev server was OOM-killed on this machine);
  the four specs that need the dev-only gateway / SMS controls run against `next dev`.

## Task list — second pass (Kamrul 13/10/2026: commit after each pass, then the next, until all are done; push only at the end)
Each pass: rebuild the screens' bodies on the kit (panels, list ⇄ detail, key–value grids, checklists, drawers),
screenshots, its journeys green on a production build (dev-only gateway/SMS specs on `next dev`), commit, next pass.
- [x] P0 · Nav sections distinguishable; type one step smaller (8b5db7a, 436bdb3)
- [x] P1 · Side drawer for previews and documents (draft print preview, print panel, receipts, vouchers, IPD receipts and
      interim bill, owner drill-down)
- [ ] P2 · Billing and money: OPD worklist + bill, payment, receipt, refunds, shift close, approvals, reconciliation,
      packages, IPD running/final bill; owner dashboard
- [ ] P3 · Lab: worklists, collection, accession, result entry, verification, report, delivery
- [ ] P4 · Pharmacy: dispense, OTC, stock, purchase / goods received, count, indents, approvals
- [ ] P5 · ER and IPD: triage board, orders, admission + bed picker, bed map, transfer, rounds, discharge, summary
- [ ] P6 · Nursing: ward board, vitals / NEWS2, MAR, I/O and notes, handover
- [ ] P7 · Admin and Chartis Link: wizard, users, masters, audit; network history, portable lab, shared records
- [ ] P8 · Phones: doctor app screens; Chartis Passport tests, report, share, claim
- [ ] P9 · Close: full suite, HANDOVER + plan, the hosted Claude Design prototype, then ask Kamrul before pushing
