import type { NextConfig } from "next";
const config: NextConfig = { transpilePackages: ["@setu/ui", "@setu/domain", "@setu/contracts", "@setu/i18n"] };
export default config;
