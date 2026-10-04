// Local helper (not a test): log in and screenshot a page.
// node shot.mjs <phone|-> <path> <out.png> [width=1440] [height=900]
import { chromium } from "@playwright/test";
const [phone, path, out, w = "1440", h = "900"] = process.argv.slice(2);
const base = process.env.STAFF_URL ?? "http://localhost:3300";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
if (phone && phone !== "-") {
  await page.goto(base + "/login");
  await page.fill("input[name=identifier]", phone);
  await page.fill("input[name=password]", "setu1234");
  await page.click("button[type=submit]");
  await page.waitForSelector("header.shell-top", { timeout: 60000 });
}
await page.goto(base + path, { waitUntil: "networkidle", timeout: 120000 });
await page.waitForTimeout(800);
await page.screenshot({ path: out, fullPage: false });
console.log("saved", out);
await browser.close();
