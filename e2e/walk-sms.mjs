// Local hands-on walkthrough (not a test): SMS through BulkSMSBD (ADR 0012) + bKash, against the local stand-ins, E2E
// clinics, Bangla screens; the API must run on both stand-ins. A screenshot per step. node walk-sms.mjs <outDir>
import { chromium, request as pwRequest } from "@playwright/test";
const OUT = process.argv[2] ?? "shots";
const BASE = process.env.STAFF_URL ?? "http://localhost:3300";
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
let n = 0;
const PHONE = `013${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const INBOX = "http://127.0.0.1:4198/inbox";
const key = () => ({ "idempotency-key": crypto.randomUUID() });
async function shot(p, name, full = false) { n++; const f = `${OUT}/${String(n).padStart(2, "0")}-${name}.png`; await p.waitForTimeout(800); await p.screenshot({ path: f, fullPage: full }); console.log("saved", f); }

async function visit(tag) {
  const r = await pwRequest.newContext({ baseURL: BASE });
  await r.post("/api/v1/auth/login", { data: { identifier: "01799000001", password: "setu1234" } });
  const p = await (await r.post("/api/v1/patients", { headers: key(), data: { nameBn: "রহিমা খাতুন", nameEn: `Rahima Khatun ${tag}${RUN}`, sex: "female", dobMode: "dob", dob: "12/02/1979",
    phone: PHONE, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true } })).json();
  await r.post("/api/v1/auth/login", { data: { identifier: "01799000002", password: "setu1234" } });
  const v = await (await r.post(`/api/v1/encounters/${p.encounter.id}/consultation/open`, { headers: key(), data: {} })).json();
  const saved = await (await r.put(`/api/v1/compositions/${v.draft.id}`, { headers: key(), data: { rev: 1, sections: { complaints: [{ text: "Headache", duration: { n: 3, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" }, sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [], orders: [] } })).json();
  await r.post(`/api/v1/compositions/${v.draft.id}/sign`, { headers: key(), data: { rev: saved.rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false } });
  await r.dispose();
  return p.encounter.token;
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(BASE + "/login");
await page.fill("input[name=identifier]", "01799000008"); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
await page.waitForSelector("header.shell-top");

async function pay(token) {
  await page.goto(BASE + "/m/bill/opd");
  await page.locator(`[data-bill-token="${token}"]`).click();
  await page.waitForURL(/\/m\/bill\/opd\?inv=/);
  await page.getByTestId("issue").click();
  await page.getByTestId("invoice-number").waitFor();
  await page.getByTestId("take-payment").click();
  await page.waitForURL(/\/m\/bill\/pay\?inv=/);
  await page.getByRole("radio", { name: /বিকাশ|bKash/ }).click();
  await page.getByTestId("pay-submit").click();
  const bk = page.locator('[data-payment="bkash"]').last();
  await bk.getByTestId("pay-qr").waitFor();
  return (await bk.getByTestId("pay-url").textContent()).trim();
}
await pay(await visit("S"));
await page.locator('[data-testid="link-sms"][data-sms-status="completed"]').waitFor();
await shot(page, "cashier-link-sms-sent", true);
const ph = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
await ph.goto(`${INBOX}?n=${PHONE}`);
await shot(ph, "phone-sms-inbox");
await ph.getByTestId("sms-link").first().click();
await ph.getByTestId("standin-otp").fill("123456"); await ph.getByTestId("standin-pin").fill("12121");
await ph.getByTestId("standin-pay").click();
await ph.waitForURL(/\/pay\/result/); await ph.getByTestId("pay-result-trx").waitFor();
await shot(ph, "phone-paid-from-sms", true);

// the admin's test SMS (E2E New Clinic, in setup)
await page.context().clearCookies();
await page.goto(BASE + "/login");
await page.fill("input[name=identifier]", "01799000011"); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
await page.waitForSelector("header.shell-top");
await page.goto(BASE + "/m/adm/wizard");
await page.locator('[data-screen="adm/wizard"]').waitFor().catch(async () => { await page.screenshot({ path: OUT + "/debug.png" }); });
await page.getByTestId("sms-phone").fill(PHONE);
await page.getByTestId("sms-send").click();
await page.getByTestId("sms-confirm-box").waitFor();
await page.getByTestId("step-test_sms").scrollIntoViewIfNeeded();
await shot(page, "admin-test-sms-confirm");
await page.getByTestId("sms-arrived").click();
await page.locator('[data-testid="checklist"] [data-item="test_sms"][data-done="1"]').waitFor();
await shot(page, "admin-test-sms-done");
await browser.close();
