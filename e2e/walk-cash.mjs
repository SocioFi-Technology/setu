// Local hands-on walkthrough (not a test): the OPD cashier — the bill from a signed visit, issue, cash with change, the
// receipt and its print, the shift. E2E Test Clinic; driven on the English screen, each picture in Bangla.
// node walk-cash.mjs <outDir>
import { chromium, request as pwRequest } from "@playwright/test";
import { mkdirSync } from "node:fs";
const OUT = process.argv[2] ?? "shots-cash"; mkdirSync(OUT, { recursive: true });
const BASE = process.env.STAFF_URL ?? "http://localhost:3300";
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const key = () => ({ "idempotency-key": crypto.randomUUID() });
let n = 0;
async function visit() {
  const r = await pwRequest.newContext({ baseURL: BASE });
  await r.post("/api/v1/auth/login", { data: { identifier: "01799000001", password: "setu1234" } });
  const p = await (await r.post("/api/v1/patients", { headers: key(), data: { nameBn: "করিম উদ্দিন", nameEn: `Karim Uddin ${RUN}`, sex: "male", dobMode: "dob", dob: "02/09/1975",
    phone: `017${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true } })).json();
  await r.post("/api/v1/auth/login", { data: { identifier: "01799000002", password: "setu1234" } });
  const v = await (await r.post(`/api/v1/encounters/${p.encounter.id}/consultation/open`, { headers: key(), data: {} })).json();
  const saved = await (await r.put(`/api/v1/compositions/${v.draft.id}`, { headers: key(), data: { rev: 1, sections: { complaints: [{ text: "Fever", duration: { n: 3, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "BA00", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }], orders: [{ testCode: "cbc", priority: "routine" }] } })).json();
  const signed = await r.post(`/api/v1/compositions/${v.draft.id}/sign`, { headers: key(), data: { rev: saved.rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false } });
  if (!signed.ok()) throw new Error(`sign: ${signed.status()} ${await signed.text()}`); // never photograph a visit that did not finish
  await r.dispose();
  return p.encounter.token;
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const lang = async (l) => { await page.getByRole("radio", { name: l === "bn" ? "বাং" : "EN", exact: true }).click(); await page.waitForTimeout(250); };
async function shot(name, full = true) { n++; await lang("bn"); await page.waitForTimeout(600); const f = `${OUT}/${String(n).padStart(2, "0")}-${name}.png`; await (full ? page.evaluate(() => window.scrollTo(0, 0)) : Promise.resolve()).then(() => page.screenshot({ path: f, fullPage: full })); console.log("saved", f); await lang("en"); }
const token = await visit();
await page.goto(BASE + "/login");
await page.fill("input[name=identifier]", "01799000008"); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
await page.waitForSelector("header.shell-top"); await lang("en");
await page.goto(BASE + "/m/bill/opd");
await page.locator(`[data-bill-token="${token}"]`).waitFor();
await shot("worklist", false);
await page.locator(`[data-bill-token="${token}"]`).click();
await page.waitForURL(/\/m\/bill\/opd\?inv=/);
await shot("bill-draft");
await page.getByTestId("issue").click();
await page.getByTestId("invoice-number").waitFor();
await shot("bill-issued");
await page.getByTestId("take-payment").click();
await page.waitForURL(/\/m\/bill\/pay\?inv=/);
await page.getByRole("radio", { name: "Cash" }).click();
const due = (await page.locator("input[name=pay-amount]").inputValue()).replace(/,/g, "");
await page.fill("input[name=pay-tendered]", String(Math.ceil(Number(due) / 500) * 500 + 500));
await page.getByTestId("pay-change").waitFor();
await shot("pay-cash-change");
await page.getByTestId("pay-submit").click();
await page.getByTestId("paid-line").waitFor();
await shot("paid");
await page.getByTestId("make-receipt").click();
await page.getByTestId("receipt-number").waitFor();
await shot("receipt");
await page.getByTestId("print").click(); await page.waitForTimeout(800);
await shot("receipt-printed");
await page.goto(BASE + "/m/bill/shift"); await page.waitForTimeout(800);
await shot("shift");
await browser.close();
