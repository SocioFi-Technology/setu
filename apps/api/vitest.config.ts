import { defineConfig } from "vitest/config";
/* Contract test files share the E2E Test Clinic's seeded family (e.g. Rahima Khatun's visit today), so they run one
   file at a time; tests inside a file are sequential anyway. */
export default defineConfig({ test: { include: ["test/**/*.test.ts"], fileParallelism: false, env: { FAKE_PAYMENTS_DEV_ROUTE: "1", FAKE_MESSAGING_DEV_ROUTE: "1" } } });
