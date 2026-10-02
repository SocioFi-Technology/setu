One spec per walkthrough step, named like the test log: `A1.spec.ts` … `E4.spec.ts`.
Use the same clicks and the same sample people (Rahima Khatun GLC-240117, Farzana Akter, Shahidul Islam, Nasrin Sultana).
Tag phone-only steps (A12, C1–C4, D1–D6) with `@phone` so they also run at 390 px.

`shell.spec.ts` is the phase-0 gate. Run with `pnpm e2e` while `pnpm dev` is up (first time: `pnpm --filter @setu/e2e exec playwright install chromium`).
`pw.local.config.ts` only matters in Claude's sandbox (bundled Chromium path via CHROME_PATH); ignore it locally.
