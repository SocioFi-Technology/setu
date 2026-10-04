// Local hands-on walkthrough (not a test): admin, journey G, in the demo clinic's Uttara facility (in setup) as its admin
// (01711000011), Bangla screens; a screenshot per step. Stops at a complete checklist — Go live is left for Kamrul to
// press (a live facility never goes back to setup).
// node walk-admin.mjs <outDir>
import { chromium } from "@playwright/test";
const OUT = process.argv[2] ?? "shots";
const BASE = process.env.STAFF_URL ?? "http://localhost:3300";
const ADMIN = "01711000011";
const RUN = Date.now().toString(36).slice(-3).toUpperCase();
let n = 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
async function login(p, id, pw) {
  await p.context().clearCookies();
  await p.goto(BASE + "/login");
  await p.fill("input[name=identifier]", id); await p.fill("input[name=password]", pw); await p.click("button[type=submit]");
}
async function shot(p, name, full = false) { n++; const f = `${OUT}/${String(n).padStart(2, "0")}-${name}.png`; await p.waitForTimeout(700); await p.screenshot({ path: f, fullPage: full }); console.log("saved", f); }

await login(page, ADMIN, "setu1234");
await page.waitForSelector("header.shell-top");
await page.goto(BASE + "/m/adm/wizard");
await page.locator('[data-screen="adm/wizard"]').waitFor();
await shot(page, "wizard-start", true);

await page.getByTestId("org-address").fill("বাড়ি ১২, রোড ৪, সেক্টর ৭, উত্তরা, ঢাকা");
await page.getByTestId("org-licence").fill("DGHS-HSM-41872");
await page.getByTestId("org-save").click(); await page.waitForTimeout(800);
if (await page.locator('[data-testid="step-branch"] .t-small').count() === 0) {
  await page.getByTestId("branch-name").fill("Uttara branch");
  await page.locator('[data-testid="step-branch"] input').nth(1).fill("উত্তরা শাখা");
  await page.getByTestId("branch-add").click(); await page.waitForTimeout(800);
}
if (await page.locator('[data-testid="step-wards"] .t-small').filter({ hasText: "শয্যা" }).count() === 0) {
  await page.getByTestId("ward-name").fill("ওয়ার্ড ১");
  await page.getByTestId("ward-beds").fill("6");
  await page.getByTestId("ward-add").click(); await page.waitForTimeout(800);
}

// a doctor with a one-time password
await page.goto(BASE + "/m/adm/users");
await page.getByTestId("add-user").click();
const phone = `0171${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
await page.getByTestId("new-name-bn").fill("ডা. সাবরিনা হক");
await page.getByTestId("new-name-en").fill(`Dr. Sabrina Haque ${RUN}`);
await page.getByTestId("new-phone").fill(phone);
await page.getByTestId("new-role").selectOption("doctor");
await page.getByTestId("new-reg").fill("A-61234");
await shot(page, "add-doctor");
await page.getByTestId("create-user").click();
await page.getByTestId("otp").waitFor();
const otp = (await page.getByTestId("otp").textContent()).trim();
await shot(page, "one-time-password");
await page.getByTestId("otp-done").click();
const row = page.locator(`[data-testid="user-list"] tr[data-phone="${phone}"]`);
await row.getByTestId("manage").click();
await page.getByTestId("reg-verify").click(); await page.waitForTimeout(900);
await shot(page, "manage-doctor-verified");
await page.keyboard.press("Escape");
await shot(page, "users-list");

// the doctor's first sign-in (another browser)
const doc = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const dp = await doc.newPage();
await login(dp, phone, otp);
await dp.locator('[data-screen="first-sign-in"]').waitFor();
await shot(dp, "doctor-first-sign-in");
await doc.close();

// the doctor's fee
await page.goto(BASE + "/m/adm/masters");
await page.getByTestId("price-list").waitFor();
await shot(page, "masters-no-fee");
await page.getByTestId("add-price").click();
await page.getByTestId("add-kind").selectOption("consultation");
await page.getByTestId("add-price-tk").fill("800");
await page.getByTestId("add-price-save").click(); await page.waitForTimeout(900);
await page.getByRole("radio", { name: /অনুমোদন সীমা/ }).click();
await shot(page, "masters-limits");

// formats, payment methods, test SMS → the checklist is complete
await page.goto(BASE + "/m/adm/wizard");
await page.locator('[data-screen="adm/wizard"]').waitFor();
await page.getByTestId("receipt-format").selectOption("a5");
for (const m of ["cash", "bkash", "card"]) { const c = page.locator(`[data-testid="methods"] input[data-method="${m}"]`); if (!(await c.isChecked())) await c.check(); }
await page.getByTestId("prints-save").click(); await page.waitForTimeout(800);
await page.getByTestId("sms-phone").fill("01711234567");
await page.getByTestId("sms-send").click(); await page.waitForTimeout(1000);
await shot(page, "wizard-ready-to-go-live", true);

// the audit log (flags)
await page.goto(BASE + "/m/adm/audit");
await page.getByTestId("audit-filters").waitFor(); await page.waitForTimeout(800);
await shot(page, "audit-flags");
console.log(`doctor ${phone} one-time password ${otp} (already used once by the walkthrough — reset it to try the first sign-in)`);
await browser.close();
