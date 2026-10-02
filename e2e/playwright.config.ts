import { defineConfig, devices } from "@playwright/test";
/* Journeys run against the real stack: `pnpm dev` (api :4000, staff :3000, patient :3001) with the seeded demo tenant. */
export default defineConfig({
  testDir: "./journeys",
  timeout: 30_000,
  use: { baseURL: process.env.STAFF_URL ?? "http://localhost:3000", trace: "retain-on-failure" },
  projects: [
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "phone-390", use: { ...devices["iPhone 13"], browserName: "chromium" }, grep: /@phone/ },
  ],
});
