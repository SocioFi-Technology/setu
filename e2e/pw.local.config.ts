import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";
/* Local override used only in Claude's sandbox, where the bundled Chromium lives at a fixed path. */
const exe = process.env.CHROME_PATH;
export default defineConfig({ ...base, projects: [
  { name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 }, launchOptions: { executablePath: exe } }, grepInvert: /@phone/ },
  { name: "phone-390", use: { ...devices["iPhone 13"], browserName: "chromium", launchOptions: { executablePath: exe } }, grep: /@phone/ },
] });
