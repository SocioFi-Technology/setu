// Local hands-on walkthrough (not a test): the front desk, journey A1–A4, E2E Test Clinic; a screenshot per step in
// Bangla (the steps are driven on the English screen, each picture taken after switching to বাং). Training material:
// e2e/training. node walk-desk.mjs <outDir>
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const OUT = process.argv[2] ?? "shots-desk"; mkdirSync(OUT, { recursive: true });
const BASE = process.env.STAFF_URL ?? "http://localhost:3300";
const DESK = "01799000001", NURSE = "01799000004";
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
let n = 0;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const lang = async (l) => { await page.getByRole("radio", { name: l === "bn" ? "বাং" : "EN", exact: true }).click(); await page.waitForTimeout(250); };
async function shot(name, full = false) { n++; await lang("bn"); await page.waitForTimeout(600); const f = `${OUT}/${String(n).padStart(2, "0")}-${name}.png`; await (full ? page.evaluate(() => window.scrollTo(0, 0)) : Promise.resolve()).then(() => page.screenshot({ path: f, fullPage: full })); console.log("saved", f); await lang("en"); }
async function login(phone) {
  await page.context().clearCookies();
  await page.goto(BASE + "/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForSelector("header.shell-top"); await lang("en");
}
await page.goto(BASE + "/login"); await page.fill("input[name=identifier]", DESK); await shot("login");
await login(DESK);
await shot("home");
// A1: search by phone — the shared-phone warning, the family on one number
await page.goto(BASE + "/m/fd/search");
await page.getByRole("combobox", { name: "Search patient" }).fill("01711-234567");
await page.getByTestId("shared-phone").waitFor();
await shot("search-shared-phone");
// A2: no match → register
await page.getByRole("combobox", { name: "Search patient" }).fill(`Shirin ${RUN}`);
await page.getByRole("button", { name: `Register "Shirin ${RUN}" as new` }).click();
await page.waitForURL(/\/m\/fd\/register/);
await page.getByRole("button", { name: /Save & create visit/ }).click();
await page.getByTestId("error-summary").waitFor();
await shot("register-errors", true);
await page.fill("input[name=nameBn]", "শিরিন আক্তার");
await page.fill("input[name=nameEn]", `Shirin Akter ${RUN}`);
await page.getByRole("radiogroup", { name: "Sex" }).getByRole("radio", { name: "F", exact: true }).click();
await page.fill("input[name=dob]", "১৪/০৩/১৯৮৮");
await page.fill("input[name=phone]", `015${String(Date.now()).slice(-8)}`);
await page.selectOption("select[name=division]", "Dhaka"); await page.selectOption("select[name=district]", "Dhaka"); await page.selectOption("select[name=upazila]", "Mirpur");
await shot("register-filled", true);
// A3: saved → the token on the queue board
await page.getByRole("button", { name: /Save & create visit/ }).click();
await page.waitForURL(/\/m\/fd\/queue\?sel=.+&new=1/);
await page.getByTestId("queue-selected").waitFor();
await shot("queue-new-token");
await page.getByRole("button", { name: "Call" }).click(); await page.waitForTimeout(500);
await shot("queue-called");
await page.getByRole("button", { name: "To vitals" }).click();
await page.locator('[data-column="vitals"]').getByText(`Shirin Akter ${RUN}`).waitFor();
await shot("queue-to-vitals");
const token = (await page.getByTestId("selected-token").textContent()).trim();
// A4: vitals (the nurse's station; the receptionist has it too)
await login(NURSE);
await page.goto(BASE + "/m/fd/vitals");
await page.locator(`[data-vitals-token="${token}"]`).click();
await page.getByRole("textbox", { name: "Temperature" }).fill("98.6"); await page.getByRole("textbox", { name: "SpO₂" }).fill("98");
await page.getByRole("textbox", { name: "Systolic" }).fill("150"); await page.getByRole("textbox", { name: "Diastolic" }).fill("95");
await page.getByRole("textbox", { name: "Pulse" }).fill("84"); await page.getByRole("textbox", { name: "Weight" }).fill("58"); await page.getByRole("textbox", { name: "Height" }).fill("152");
await shot("vitals-entered", true);
await page.getByRole("button", { name: "Save vitals" }).click();
await page.getByTestId("vitals-stamp").filter({ hasText: "Saved" }).waitFor();
await shot("vitals-saved", true);
await browser.close();
