import type { NextConfig } from "next";
import { resolve } from "node:path";
const API = process.env.API_URL ?? "http://localhost:4000";
const config: NextConfig = {
  /* NEXT_DIST_DIR lets a second dev server (e.g. one for the journeys) run beside another without sharing .next. */
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  /* staging (week 2): a standalone server (node server.js) with only the files it needs; traced from the repo root */
  output: "standalone",
  outputFileTracingRoot: resolve(__dirname, "../.."),
  transpilePackages: ["@setu/ui", "@setu/domain", "@setu/contracts", "@setu/i18n"],
  /* The browser talks to /api/*, which Next proxies to the API — same origin, so cookies and CORS are not a concern. */
  /* /p/<code>: the short payment link the patient opens (ADR 0011) — the API redirects to the gateway's page. */
  async rewrites() { return [{ source: "/api/:path*", destination: `${API}/:path*` }, { source: "/p/:code", destination: `${API}/v1/pay/:code` }]; },
};
export default config;
