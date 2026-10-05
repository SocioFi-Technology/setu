import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { request } from "@playwright/test";

/* Before every run:
   1. put the E2E Test Clinic's walkthrough family back to its seeded state (links, reviews);
   2. warm the dev server: `next dev` compiles a page on first visit and can answer 404 while several workers hit a
      page it is still compiling (seen right after editing a screen). Signing in once and loading each front desk
      page avoids that; a production build has no such step. */
export default async function globalSetup() {
  execSync("pnpm db:reset-e2e", { cwd: resolve(__dirname, ".."), stdio: "inherit" });
  const baseURL = process.env.STAFF_URL ?? "http://localhost:3000";
  const ctx = await request.newContext({ baseURL });
  const login = await ctx.post("/api/v1/auth/login", { data: { identifier: "01799000001", password: "setu1234" } });
  if (!login.ok()) throw new Error(`global-setup: E2E receptionist cannot sign in (${login.status()}) — is the stack running and seeded?`);
  for (const path of ["/", "/m/fd/search", "/m/fd/match", "/m/fd/register", "/m/fd/queue", "/m/fd/vitals", "/m/cons/draft", "/m/cons/signed", "/m/cons/amended", "/m/bill/opd", "/m/bill/pay", "/m/bill/receipt", "/m/bill/approvals", "/m/bill/reconcile", "/m/bill/refund", "/m/lab/collect", "/m/lab/accession", "/m/lab/result", "/m/lab/verify", "/m/lab/report", "/m/lab/delivery", "/m/er/triage", "/m/er/orders", "/m/ipd/admit", "/m/nur/ward", "/m/nur/vitals", "/m/nur/mar", "/m/nur/io", "/m/ipd/map", "/m/ipd/transfer", "/m/ipd/rounds", "/m/ph/indent", "/m/doc/inbox"]) await ctx.get(path, { timeout: 120_000 });
  await ctx.dispose();
}
