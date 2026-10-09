import type { NextConfig } from "next";
import { resolve } from "node:path";
const API = process.env.API_URL ?? "http://localhost:4000";
const config: NextConfig = {
  ...(process.env.NEXT_DEV_INDICATOR === "off" ? { devIndicators: false as const } : {}),
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  outputFileTracingRoot: resolve(__dirname, "../.."),
  transpilePackages: ["@setu/ui", "@setu/domain", "@setu/contracts", "@setu/i18n"],
  /* The browser talks to /api/*, which Next proxies to the API — same origin, so the patient cookie needs no CORS. */
  async rewrites() { return [{ source: "/api/:path*", destination: `${API}/:path*` }]; },
};
export default config;
