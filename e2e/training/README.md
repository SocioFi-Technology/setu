# Training walkthroughs (pilot-readiness sprint, week 3)

One PDF per role, Bangla first, made from the hands-on walkthrough scripts (`e2e/walk-*.mjs`). **Drafts**: the
Bangla captions were written with the screens, not by a trainer — a Bangla-speaking trainer reviews them before a
pilot clinic sees them. The screenshots are test data (the E2E Test Clinic / E2E Lite Hospital), never real patients.

1. Dev servers on `STAFF_URL` (default http://localhost:3300) with the API behind them, the seed loaded.
2. `node e2e/training/shots.mjs` — runs the walkthroughs into `shots/<walk>/` (git-ignored). The bKash and SMS walks
   need the API in stand-in mode; run them by name when it is (`node e2e/training/shots.mjs walk-bkash`).
3. `node e2e/training/build.mjs [role …]` — `captions/<role>.json` + the screenshots → `out/<role>.pdf` (git-ignored).
   A caption whose screenshot is missing is listed on the last page, never dropped silently.

Roles: front desk, doctor, nurse, lab, pharmacist, cashier, owner, admin. A screenshot's name comes from its walk
(`walk-desk/03-search-shared-phone.png`); when a walk changes, check its role's captions still point at the right
pictures.
