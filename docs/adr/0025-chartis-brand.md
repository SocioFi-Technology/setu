# ADR 0025 — The Chartis brand: name, product family, pine & mint design layer

Status: accepted (Kamrul, 13/10/2026 — name "Chartis"; product family "Family by product"; the pine & mint system on the
brand board "now the system is ok. go with this design system").

## Context
"Setu" (bridge) is crowded — India's Aarogya Setu health app and the Setu fintech API — and reads as Indian next to the
main competitor, Axonic Health (axonichealth.com: an "AI healthcare operating system" built for India's ABDM, product
lines AxonHIS / AxonMD / AxonHealthHub / AxonScribe / AxonCare, styled in dark navy `#1a1a2e/#16213e/#0f3460` with
yellow-gold). Kamrul chose the name Chartis (domain later: "chartis health") and asked for a premium look that stands
apart. The direction was explored on a Claude Design board — https://claude.ai/artifact/5Pf8ZxvnaNopUWPbXaBn3y —
(brand foundation, staff and patient screens, eight colour options, the component sheet, the selected-row variants). A
first indigo + navy draft was dropped as too close to Axonic.

## Decisions
- **Product family.** Chartis Health = the company and platform · **Chartis HIS** = the staff web app, in three editions
  that are the existing plans: **Clinic**, **Lite** (Hospital Lite), **Pro** (Hospital Pro) — the top bar shows
  "Chartis HIS" + the edition · **Chartis Passport** (চার্টিস পাসপোর্ট) = the patient app (it keeps the "health
  passport" idea) · **Chartis Link** (চার্টিস লিংক) = the network (shared records, portable orders, history across
  facilities). Product names stay in Latin letters in the lockup; Bangla text uses চার্টিস.
- **Only the visible name changes.** Screens, page titles, the PWA manifest and icon, SMS ("Chartis: your code…"),
  printed receipts and prescriptions (the app code and its QR are now "in Chartis Passport"), API error messages, the
  access matrix's network module name, the OpenAPI title. The repo, the `@setu/*` packages, the database, i18n keys,
  env names (`NEXT_PUBLIC_SETU_STAGE`…), cookies and the prototype file names stay as they are — renaming them buys
  nothing for users and risks the data.
- **A brand layer, not a rewrite of the handoff tokens.** `packages/ui/styles/chartis.css`, imported after `setu.css`
  in both apps, overrides only brand tokens and component finish: pine `#0e5e52` (hover `#0a4a40`, mist `#e6f2ef`) for
  actions, selection and "final"; mint `#2bb596` for the chart line in the mark; ink `#13201e`; warm paper ground
  `#f6f5f1` with `#e2dfd6` hairlines; Plus Jakarta Sans (Latin) + Anek Bangla (Bangla), self-hosted woff2 under SIL OFL
  (~200 KB); radii 8/10/16 (dialogs 20); controls 36/40/44 px; softer ink-tinted two-layer shadows; a pine focus ring
  with a gap. High-contrast and dark themes get matching pine/mint values. `setu-tokens.css` (the handoff's generated
  tokens) is untouched.
- **Clinical colours do not move.** Allergy and critical red, result high/low, draft violet, pending amber, paid/success
  green, provenance and bed colours keep their values: staff read them as meaning. Pine was checked against the green
  "Paid" pill — pine is darker and bluer; success stays the brighter, yellower green.
- **The selected row** is a mist highlight with a straight pine bar on the left (`--select-bar`, 4 px) — no ticks, no
  outline (Kamrul's choice on the board). It applies to `.row-btn`, `.option`, `.table tr[aria-selected]`, the nav's
  current item and the screens that already drew a 3 px brand bar.
- **The mark**: a C held open with the chart line running through the opening (`ChartisMark`, `ChartisLockup` in
  `@setu/ui`); the patient app's icon is the same mark.
- **Printed documents keep their fonts** (Noto Sans Bengali + IBM Plex Sans, embedded): they are legal documents with
  print tests and thermal-printer checks; only their wording changes.

## Consequences
- `docs/prototype/` (the Claude Design pages) now differs from the build in colour, type and name; bringing it up to
  date is part of Kamrul's prototype round in Claude Design, with the brand board as the reference.
- `docs/design-handoff/` (i18n copies, tokens json, sitemap) still says Setu; the app's own locales and this layer win.
- The SMS sender ID, the domain and production hosting are unchanged until the domain is bought (open item).
