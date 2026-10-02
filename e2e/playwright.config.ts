import { defineConfig, devices } from "@playwright/test";
/* Journeys run against the real stack: `pnpm dev` (api :4000, staff :3000, patient :3001). Specs that create patients
   or visits sign in to the seeded E2E Test Clinic (017990000xx), never the demo clinic; global-setup resets its family. */
export default defineConfig({
  testDir: "./journeys",
  globalSetup: "./global-setup.ts",
  timeout: 30_000,
  use: { baseURL: process.env.STAFF_URL ?? "http://localhost:3000", trace: "retain-on-failure" },
  projects: [
    // @phone specs run only in the phone project (as in pw.local.config.ts).
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } }, grepInvert: /@phone/ },
    { name: "phone-390", use: { ...devices["iPhone 13"], browserName: "chromium" }, grep: /@phone/ },
  ],
});
