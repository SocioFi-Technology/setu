// Training walkthroughs (pilot-readiness sprint, week 3): one PDF per role, Bangla first, from the e2e/walk-*.mjs
// screenshots. A draft for a Bangla-speaking trainer to review — the captions are not reviewed copy yet.
//   1. run the walkthroughs into e2e/training/shots/<walk>/   (node e2e/training/shots.mjs, dev servers on STAFF_URL)
//   2. node e2e/training/build.mjs [role ...]                  → e2e/training/out/<role>.pdf (not committed)
// A caption file e2e/training/captions/<role>.json: { "titleBn", "titleEn", "introBn", "introEn",
//   "steps": [{ "shot": "<walk>/<file>.png", "bn": "…", "en": "…" }, …] }. A step whose screenshot is missing is listed
// at the end and the PDF says so — never silently dropped.
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "shots"), CAPS = join(HERE, "captions"), OUT = join(HERE, "out");
const FONTS = resolve(HERE, "../../packages/ui/fonts");
mkdirSync(OUT, { recursive: true });
const font = (family, file) => `@font-face{font-family:'${family}';font-weight:100 900;src:url(data:font/woff2;base64,${readFileSync(join(FONTS, file)).toString("base64")}) format('woff2');}`;
const FONT_CSS = font("Noto Sans Bengali", "4801dbf4-01de-479f-b795-f5a8b505f71f.woff2") + font("IBM Plex Sans", "2879f905-a1f3-4583-b397-b24c91250c8a.woff2");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const bnDigits = (s) => String(s).replace(/\d/g, (d) => "০১২৩৪৫৬৭৮৯"[d]);

const roles = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(CAPS).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
const browser = await chromium.launch();
for (const role of roles) {
  const c = JSON.parse(readFileSync(join(CAPS, `${role}.json`), "utf8"));
  const missing = c.steps.filter((s) => !existsSync(join(SHOTS, s.shot))).map((s) => s.shot);
  const pages = c.steps.filter((s) => existsSync(join(SHOTS, s.shot))).map((s, i) => `
    <section class="step">
      <div class="cap"><span class="n">${bnDigits(i + 1)}</span><div><p class="bn">${esc(s.bn)}</p><p class="en">${esc(s.en)}</p></div></div>
      <img src="data:image/png;base64,${readFileSync(join(SHOTS, s.shot)).toString("base64")}">
    </section>`).join("");
  const html = `<!doctype html><html lang="bn"><head><meta charset="utf-8"><style>${FONT_CSS}
    @page{size:A4;margin:12mm}
    body{font-family:'Noto Sans Bengali','IBM Plex Sans',sans-serif;color:#111;margin:0}
    .cover{height:265mm;display:flex;flex-direction:column;justify-content:center;gap:6mm;page-break-after:always}
    .cover h1{font-size:26pt;margin:0}.cover h2{font-size:15pt;margin:0;font-weight:500;color:#444}
    .cover .draft{border:1.2pt solid #b00;color:#b00;padding:3mm 4mm;font-weight:700;width:fit-content}
    .cover p{font-size:11.5pt;line-height:1.6;max-width:165mm;margin:0}
    .step{page-break-inside:avoid;break-inside:avoid;margin-bottom:7mm}
    .cap{display:flex;gap:3mm;align-items:flex-start;margin-bottom:2.5mm}
    .n{flex:none;width:8mm;height:8mm;border-radius:50%;background:#0b6b5a;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:10pt}
    .bn{font-size:12pt;font-weight:600;margin:0 0 1mm;line-height:1.45}.en{font-size:9pt;color:#555;margin:0}
    img{width:100%;max-height:215mm;object-fit:contain;object-position:top left;border:.4pt solid #bbb;border-radius:2mm}
    .missing{color:#b00;font-size:10pt}</style></head><body>
    <div class="cover">
      <div class="draft">খসড়া — প্রশিক্ষকের যাচাইয়ের জন্য · DRAFT — for a trainer to review</div>
      <h1>সেতু হেলথ · ${esc(c.titleBn)}</h1><h2>Setu Health · ${esc(c.titleEn)}</h2>
      <p>${esc(c.introBn)}</p><p style="color:#555">${esc(c.introEn)}</p>
      <p style="color:#555;font-size:9.5pt">${bnDigits(c.steps.length - missing.length)} ধাপ · ${c.steps.length - missing.length} steps · ছবিগুলো পরীক্ষার তথ্য দিয়ে নেওয়া (E2E টেস্ট ক্লিনিক) — বাস্তব রোগী নয় · screenshots from test data, not real patients</p>
    </div>${pages}
    ${missing.length ? `<p class="missing">ছবি পাওয়া যায়নি · screenshots missing: ${missing.map(esc).join(", ")}</p>` : ""}
  </body></html>`;
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" } });
  writeFileSync(join(OUT, `${role}.pdf`), pdf);
  await page.close();
  console.log(`${role}: ${c.steps.length - missing.length} steps → training/out/${role}.pdf${missing.length ? ` (missing: ${missing.length})` : ""}`);
}
await browser.close();
