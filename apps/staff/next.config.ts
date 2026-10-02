import type { NextConfig } from "next";
const API = process.env.API_URL ?? "http://localhost:4000";
const config: NextConfig = {
  /* NEXT_DIST_DIR lets a second dev server (e.g. one for the journeys) run beside another without sharing .next. */
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  transpilePackages: ["@setu/ui", "@setu/domain", "@setu/contracts", "@setu/i18n"],
  /* The browser talks to /api/*, which Next proxies to the API — same origin, so cookies and CORS are not a concern. */
  async rewrites() { return [{ source: "/api/:path*", destination: `${API}/:path*` }]; },
};
export default config;
