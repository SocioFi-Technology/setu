# Setu Health prototype — Round 2 re-test (01/10/2026)

Prototype link (unchanged): https://claude.ai/artifact/WGAfWVs6C7d5D1Y6EA8t1W — now Version 3 "Round 2 fixes".

## Result

- All 6 round-1 Blockers and all 9 Majors: **fixed and re-verified**.
- 39 / 39 journey steps pass (A1–A13, B1–B12, C1–C4, D1–D6, E1–E4). 115 index links open the right screen. No script errors. All four phone pages fit 390 px.
- Roles, plans, offline switch, Doctor App tabs and Patient App tabs re-checked.
- **Verdict: ready to send to health-sector testers.**

## One thing to fix in Claude Design before the next export (#27)

The round-2 export hides each module's own header in bare mode with `display:none`, but the module grid still reserves the first row for it — so the content lands in a 0 px row and 48 of the 68 Staff App screens showed as a blank strip. I patched the published files (one line in 10 pages); the Claude Design source still has the bug, so the next export would bring it back.

Paste this into Claude Design (master design, all module pages):

> In every module page (Admin, Billing, Consultation, ER and OT, Front Desk, IPD, Lab, Nursing, Owner Dashboard, Pharmacy), the bare-mode header rule `__o.hdrD = __b ? 'none' : 'flex'` must become `__o.hdrD = 'flex'`. The header already has `height: 0` and `overflow: hidden` in bare mode, so it stays invisible, and the `<main>` area fills the shell again. Do not change anything else.

## Small things still open (fine for testers)

- #17 Journeys "English" switches the guide and most screens; a few embedded labels stay bilingual.
- #22 Owner dashboard ignores the ০১২৩ / 0123 toggle (always English digits). Receptionist home and registration now follow it.
- #28 Lab › Sample collection: the "আংশিক · Partially collected" badge runs past the Status column edge.

## Notes for testers

- Laptop for the Staff App and Journeys; phone for Doctor App, Patient App and Owner Dashboard.
- Everything is sample data — nothing is saved, sent or charged.
- Patient-app claim code: **7K4Q2M**. Signing PIN: **1234**.
- Start with **Journeys** (A → E); the step panel on the left tells the tester what to do and which role they are.

## Files in this folder

- `Setu Walkthrough Test Log.xlsx` — Summary, Issues (Status + "Round 2 result" columns), Journey steps (round 1 and round 2 result per step).
- `Evidence/` — round-2 screenshots per issue and contact sheets of all 39 journey steps.
- `../Setu Prototype Site.zip` — the exact files that are published (open `index.html` to run it locally).
