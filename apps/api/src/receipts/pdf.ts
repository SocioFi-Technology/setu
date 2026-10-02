/* HTML → PDF with the Chromium that Playwright already installed on this machine (Kamrul 03/10/2026: no new PDF
   library). One browser per API process, started on first use; each render gets a fresh context with every network
   request blocked — the receipt HTML carries its fonts and QR inline and never loads anything. CHROMIUM_PATH (.env)
   points at another Chromium when the Playwright one is not installed (servers). */
import { chromium, type Browser } from "playwright-core";

let browser: Promise<Browser> | null = null;
const launch = () => (browser ??= chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) }).catch((e) => { browser = null; throw e; }));

export async function htmlToPdf(html: string, paper: "a5" | "thermal"): Promise<Uint8Array> {
  const b = await launch();
  const ctx = await b.newContext();
  await ctx.route("**/*", (r) => r.abort());
  try {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    if (paper === "a5") return await page.pdf({ preferCSSPageSize: true, printBackground: true });
    // 80 mm roll: as long as the content (72 mm printable; 3 mm top and 6 mm bottom margins).
    const px = await page.evaluate(() => Math.ceil(document.body.scrollHeight));
    const mm = Math.ceil((px * 25.4) / 96) + 12;
    return await page.pdf({ width: "80mm", height: `${mm}mm`, printBackground: true });
  } finally {
    await ctx.close();
  }
}

export async function closePdfBrowser() { if (browser) { const b = await browser.catch(() => null); browser = null; await b?.close(); } }
