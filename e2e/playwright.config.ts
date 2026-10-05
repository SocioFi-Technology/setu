import { defineConfig, devices } from "@playwright/test";
/* Journeys run against the real stack: `pnpm dev` (api :4000, staff :3000, patient :3001). Specs that create patients
   or visits sign in to the seeded E2E Test Clinic (017990000xx), never the demo clinic; global-setup resets its family. */
/* CI (GitHub Actions, a 2-core runner, `next dev`): a longer expect window and test timeout, one retry — the dev server
   stalls and full-reloads under two workers (run 37343639208: a page not hydrated in 5 s, a blank frame mid-test) — and
   the HTML report for the failure artifact. Locally nothing changes: a red here is a bug. */
const CI = Boolean(process.env.CI);
export default defineConfig({
  testDir: "./journeys",
  globalSetup: "./global-setup.ts",
  timeout: CI ? 60_000 : 30_000,
  expect: { timeout: CI ? 15_000 : 5_000 },
  retries: CI ? 1 : 0,
  reporter: CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  use: { baseURL: process.env.STAFF_URL ?? "http://localhost:3000", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    // @phone specs run only in the phone project (as in pw.local.config.ts).
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } }, grepInvert: /@phone/ },
    { name: "phone-390", use: { ...devices["iPhone 13"], browserName: "chromium" }, grep: /@phone/ },
  ],
});
