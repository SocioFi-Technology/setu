# Handoff: Setu Health — hospital & clinic platform (Bangladesh)

## Overview
Setu Health is a Bangla-first hospital/clinic management platform (OPD, IPD, beds, nursing, billing, pharmacy, lab, OT, ER, owner dashboards) with a connected-care layer: bKash/Nagad payments, SMS/WhatsApp delivery, QR-verified documents, a multi-chamber doctor app, a patient Health Passport app, and consented record sharing between independent facilities. AI appears only as labelled drafts a clinician must review and sign.

## About the design files
The files in `design/` are **design references built in HTML** — interactive prototypes that show intended look, content and behaviour. They are not production code. Recreate them in the target stack:
- **Staff web + TV display:** Next.js (App Router) + TypeScript + Tailwind.
- **Doctor app and patient app:** Flutter (Android first, 360–412 dp).

**Start at `design/Setu Health.dc.html`** — the platform index: the three apps, plan tiers, links to every module and journey, and the sitemap. The staff web app is consolidated in **`design/Setu Staff App.dc.html`** (one shell; role switcher, plan switcher, org/branch switcher; `?role=&plan=&mod=&screen=&lang=`). The per-module pages remain as detailed references for each screen's states. Open any `design/*.dc.html` directly in a browser (they load `support.js`, `styles.css`, `tokens/*`, `lib/setu-format.js` from the same folder, plus Google Fonts and the Lucide icon font from a CDN). Each module page has a review bar at the top to switch screens and states; that bar is not part of the product. `design/Setu Journeys.dc.html` strings the real screens into the five end-to-end journeys (A–E) with role, device and step labels.

## Fidelity
**High-fidelity.** Colours, type, spacing, states and copy are final for v1. Recreate pixel-accurately using the tokens below. Sample patients, prices, drug brands, ICD codes and reference ranges are fictional and must be replaced with real master data (ICD-11 codes need checking against the official browser).

## What is in this folder
| Path | Contents |
|---|---|
| `tokens/setu.tokens.json` | All 293 tokens, nested (colour scales + semantic + clinical + status + provenance + bed, typography with Bangla line heights, font stacks, spacing, radius, shadow, border, size, motion, z-index), each with light / hc / dark values and its CSS variable |
| `tokens/setu-tokens.css` | Same tokens as CSS variables; themes via `[data-theme="hc"|"dark"]` |
| `tokens/tailwind.preset.ts` | Tailwind preset mapping every token to `var(--…)` |
| `tokens/setu_tokens.dart` | Flutter `ThemeExtension` (`SetuColors.light/highContrast/dark`), `SetuSpace`, `SetuRadius`, `SetuType.style(name, isBn:)`, touch sizes |
| `components.md / .json` | 25 components: props/variants, states, accessibility, where used |
| `shell-roles-plans.md` | The single staff shell: top bar, grouped nav, role × plan visibility matrix (11 modules), role home pages, plan tiers, capabilities API shape, how journeys run through the shell |
| `sitemap.md / .json` | 86 screens across Staff web, Doctor app, Patient app, Owner mobile — app, module, screen (en/bn), roles, lowest plan tier, prototype link |
| `screens.md / .json` | 55 routes (now with `plan`): app, module, roles, device, data, actions, empty/error/offline/permission states, backend objects, state transitions |
| `domain-model.md`, `types.ts` | Objects (FHIR-aligned), cross-cutting rules, all state machines, suggested API shape |
| `i18n/bn.json`, `i18n/en.json`, `i18n/strings.csv` | ~2,080 string keys extracted from the prototypes, namespaced by module (`common.*` = used in 3+ modules, `format.*` = ICU templates, `sample.*` = sample names — do not ship) |
| `i18n/flutter/app_bn.arb`, `app_en.arb` | Mobile subset (common, doctorApp, patientApp, network, owner, format) for `flutter gen-l10n` |
| `print-specs.md` | Sizes, margins, fonts, QR placement for A4/A5 Rx, 80 mm + A5 receipts, A4 lab report, discharge summary, labels |
| `lib/setu-format.js` | Reference formatter: Bangla/Latin digits, `৳ 1,25,000` grouping, amount in words (bn/en), DD/MM/YYYY, age y/m/d, +880 phone, dose pattern. Port to `packages/format` (TS) and `setu_format` (Dart) with the same test cases |
| `design/` | All prototype pages |

**String keys:** extracted automatically from bilingual labels in the prototypes. Review before use: a few keys come from data rows and some Bangla/English pairs are close equivalents rather than literal translations. Add new keys under the same namespaces.

## Suggested repo structure
```
setu/
  apps/
    staff/                      Next.js 14 App Router, TS, Tailwind (preset from tokens/)
      app/
        (auth)/login
        (facility)/[facility]/
          layout.tsx            Shell: top bar, grouped nav, branch switch, lang/numerals, offline banner
          home/  front-desk/{search,register,match/[a]/[b],appointments,queue,vitals}
          opd/consult/[encounterId]
          billing/{opd/[id],pay/[id],receipt/[id],ipd/[admissionId],refunds,shift,approvals,ledger}
          ipd/{admit,beds,transfer/[id],rounds,discharge/[id],summary/[id],reports}
          nursing/{ward,vitals/[id],mar/[id],io/[id],notes/[id],careplan/[id],handover}
          lab/{intake,collect,home,accession,result/[id],verify/[id],report/[id],delivery,qc,dashboard}
          pharmacy/  er/{triage,unknown,orders}  ot/{calendar,safety/[id],intraop/[id]}
          owner/  admin/{onboarding,users,masters,print,audit,plan,integrations}
          patients/[id]/network  break-glass/[patientId]
        network/{orders/[id],referrals/[id]}
        tv/[facility]/[room]    kiosk, no auth
      components/ui/            Button, TextField, … (components.md)
      components/clinical/      PatientHeaderBanner, ProvenanceBadge, StatusPill, ResultRow, …
      lib/i18n/                 next-intl with messages/bn.json, en.json
      lib/offline/              IndexedDB outbox + sync indicator state
    doctor_app/                 Flutter
      lib/{app.dart, router.dart}
      lib/core/{theme/setu_tokens.dart, l10n/, format/, offline/ (drift outbox), api/}
      lib/features/{onboarding,home,queue,consult,results,ipd,earnings}/{data,domain,presentation}
    patient_app/                Flutter
      lib/features/{onboarding,claim,family,home,timeline,report,rx,share,book,upload,settings}
  packages/
    tokens/  (json + css + tailwind preset + dart, generated from one source)
    format/  (TS port of setu-format.js)   api-types/ (types.ts)
```

## Consistency pass (what changed in the consolidation)
All screens were re-checked against the tokens; these drifts were fixed and should not be re-introduced:
- Hard-coded hex colours and `rgba()` shadows replaced with token variables (`--shadow-1…4`, semantic colours).
- Radii normalised to the scale (4 / 6 / 8 / 12 / 16 / pill); odd 3, 5, 7, 10 px values removed.
- Module pages lost their own headers/nav; the shell owns top bar, nav and the `PatientHeaderBanner` (identical props in OPD, IPD, lab, pharmacy, billing).
- Provenance badge colours unified (`--prov-verified/-uploaded/-patient/-ai`); "reported by patient" badges that pointed to a non-existent token were corrected.
- Draft vs signed: every draft uses `--pattern-draft` + dashed border + DRAFT label and no QR; signed uses `--status-final-*` + QR.
- Offline / syncing / permission-denied panels use the shared components from `design/Setu DS 5`.

## Global behaviour (applies to every screen)
- **Language:** Bangla default, English toggle on every screen. Numerals are a separate user setting (`bn` | `en`); IDs, tokens, barcodes, BMDC numbers and codes stay Latin. When `lang=bn`, use the `-lh-bn` line heights.
- **Money:** `৳ 1,25,000` (South Asian grouping), amount in words in bn and en on receipts and totals. Store integer paisa.
- **Dates/phones:** DD/MM/YYYY; +880 1XXX-XXXXXX.
- **Offline:** visible banner + pending count. Nothing reads Signed/Sent/Paid/Saved until the server confirms; queued items say "সিঙ্ক হয়নি · Not yet synced".
- **Meaning is never colour-only:** every status, flag and bed state has an icon and a text label.
- **Drafts vs final:** drafts use a hatched background (`--pattern-draft`), dashed border and a DRAFT label; they never show a QR code.
- **Permissions:** render the Permission-denied panel (reason + who can grant + Request access / Break glass where allowed), not hidden buttons.
- **Keyboard (desktop high-volume screens):** registration, billing, result entry, prescriptions are fully keyboard-driven. Shortcuts: Ctrl/⌘+K palette, F2 search, Alt+N new patient, F3 add bill item, / medicine search, Alt+1…9 note sections, Ctrl+Enter sign, Ctrl+P print, A/R approve/reject, Enter/↓ next result field.
- **Touch:** 44 dp minimum on phone, 48 dp on tablet, 56 dp for nurse vitals inputs.
- **Contrast:** WCAG AA in light; the `hc` theme is for bright wards (nurse "Bright light" toggle).

## Key tokens (full list in `tokens/`)
| Token | Light | High contrast | Dark |
|---|---|---|---|
| `--brand-primary` | #006157 | #00342e | #82d3c6 |
| `--brand-primary-hover` | #004b43 | #091010 | #b1e8de |
| `--brand-accent` | #ff9f49 | #ff9f49 | #ff9f49 |
| `--text-primary` | #131b1b | #091010 | #f9fafa |
| `--text-secondary` | #3c4646 | #131b1b | #e2e7e7 |
| `--surface-page` | #f9fafa | #ffffff | #091010 |
| `--surface-card` | #ffffff | #ffffff | #131b1b |
| `--surface-sunken` | #f0f4f4 | #f0f4f4 | #091010 |
| `--border-default` | #cfd6d6 | #252f2f | #3c4646 |
| `--success-fg` | #165229 | #103a1c | #b5e6be |
| `--warning-fg` | #694e00 | #4b3702 | #fddb96 |
| `--danger-fg` | #801616 | #5a1110 | #ffc7bf |
| `--info-fg` | #0f467b | #0b3157 | #bcdbfd |
| `--result-critical-bg` | #a31d1d | #5a1110 | #c72827 |
| `--result-critical-fg` | #ffffff | #ffffff | #ffffff |
| `--allergy-bg` | #a31d1d | #5a1110 | #c72827 |
| `--allergy-fg` | #ffffff | #ffffff | #ffffff |
| `--status-draft-fg` | #4d3675 | #362653 | #dcd0fa |
| `--status-final-fg` | #ffffff | #ffffff | #091010 |
| `--status-offline-fg` | #ffffff | #ffffff | #091010 |
| `--prov-ai-fg` | #4d3675 | #362653 | #dcd0fa |

Type: IBM Plex Sans (Latin UI, tabular figures), Noto Sans Bengali (Bangla; Hind Siliguri fallback), IBM Plex Mono (IDs, codes). Scale: display 40/48 (bn 56), h1 30/38 (44), h2 24/32 (36), h3 20/28 (32), h4 17/24 (28), body-lg 17/26 (28), body 15/22 (26), small 13/18 (22), caption 12/16 (20), table 13/20 (22). Spacing 4-px base: 0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64. Radius 4 / 6 / 8 / 12 / … ; shadows `--shadow-1…4`. Layout grids: desktop 1440 (12 col), tablet 1024/768, mobile 360–412 (4 col). Table density: comfortable 48 px rows, compact 36 px.

## Screens
See `sitemap.md` (86 screens, every app) and `screens.md` (55 staff/mobile routes with data, actions, states, backend objects and transitions). The ones with the most rules to get right:
1. **Patient header banner** (every clinical screen) — allergies always visible; identity confidence warning; context variants OPD / IPD / lab / pharmacy / billing / mobile.
2. **Consultation** — AI scribe needs patient consent; drafts insert as editable, tagged sections; signing requires "I reviewed"; allergy conflicts block signing; interactions need acknowledgement; amend creates v2.
3. **Billing** — discounts above policy need approval with a reason and are excluded from totals until approved; only confirmed payments count; reprints are audited.
4. **Lab** — critical value call-back must be logged before validation; amended reports notify all recipients of v2.
5. **Network / consent** — policy shows only allergies, meds and problems; everything else needs consent; sensitive categories are never shown or hinted; break glass = reason ≥20 chars + acknowledgement + PIN, 60 min, patient notified by SMS, reviewed by privacy officer within 24 h.

## Assets
- Icons: Lucide (`lucide-static@0.460.0` icon font in prototypes). Use `lucide-react` on web and `lucide_icons` on Flutter; every nav icon has a text label.
- No logo yet — the wordmark is set in type. Patient photos and maps are placeholders.
- QR payloads in prototypes point to `verify.setu.example` (placeholder domain).

## Open decisions for the product team
- Referral commission to outside referrers: in the share ledger or a separate owner-only report.
- Should MEWS ≥5 notify the duty doctor automatically and escalate to nurse-in-charge after 15 min unacknowledged?
- Network order acceptance: any front-desk user, or manager approval?
- Triage scale names: facility-specific or standard 5-level.
