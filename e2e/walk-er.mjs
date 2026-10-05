// Local hands-on walkthrough (not a test): ER arrival, triage and disposition, then the admission (ADR 0014, journey
// B1–B2) in the E2E Lite Hospital, Bangla screens as staff see them, a screenshot per step. As the ER nurse (Lite
// Nurse), the ER doctor (Dr. Lite Emergency) and the admission desk (Lite Receptionist). Run `pnpm db:reset-e2e` first.
// node walk-er.mjs <outDir>
import { chromium, request as pwRequest } from "@playwright/test";
const OUT = process.argv[2] ?? "shots-er";
const BASE = process.env.STAFF_URL ?? "http://localhost:3300";
const DESK = "01798000001", DOCTOR = "01798000002", NURSE = "01798000004";
let n = 0;
const api = await pwRequest.newContext({ baseURL: BASE });
const key = () => ({ "idempotency-key": crypto.randomUUID() });
async function as(phone) { const r = await api.post("/api/v1/auth/login", { data: { identifier: phone, password: "setu1234" } }); if (!r.ok()) throw new Error(await r.text()); }
async function post(url, data, status = 201) { const r = await api.post("/api" + url, { headers: key(), data }); if (r.status() !== status) throw new Error(url + " " + r.status() + " " + (await r.text())); return r.json(); }
// Farzana Akter (E2L-240188) is the walkthrough's ER patient; a run that finds her still in the ER uses a fresh synthetic patient instead.
await as(DESK);
let patientNo = "E2L-240188";
const board0 = await (await api.get("/api/v1/er/board", {})).json().catch(() => null);
const browser = await chromium.launch();
let page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
async function login(phone) {
  await page.context().clearCookies();
  await page.goto(BASE + "/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForSelector("header.shell-top", { timeout: 60000 });
  await page.getByRole("radio", { name: "বাং", exact: true }).click();
  await page.getByRole("radio", { name: "০১২৩", exact: true }).click();
}
async function shot(name, full = false) { n++; const f = `${OUT}/${String(n).padStart(2, "0")}-${name}.png`; await page.waitForTimeout(700); await page.screenshot({ path: f, fullPage: full }); console.log("saved", f); }

// ── the ER nurse: arrival, triage, doctor ──
await login(NURSE);
await page.goto(BASE + "/m/er/triage");
await page.getByTestId("new-arrival").waitFor();
await shot("nurse-board-empty");
await page.getByTestId("new-arrival").click();
await page.getByTestId("arrival-search").fill(patientNo);
await page.locator(`[role=option][data-patient="${patientNo}"]`).click();
await page.getByRole("radio", { name: "হেঁটে এসেছেন" }).click();
await page.getByTestId("arrival-complaint").fill("তলপেটে তীব্র ব্যথা ৬ ঘণ্টা, একবার অজ্ঞান");
await page.getByTestId("arrival-bay").selectOption({ label: "ER-2" });
await shot("nurse-arrival-dialog");
await page.getByTestId("arrival-submit").click();
await page.getByTestId("triage-panel").getByText("ফারজানা").waitFor();
// the visit just made, from the board API (her closed visits of earlier runs are on the board too)
await as(NURSE);
const open = (await (await api.get("/api/v1/er/board")).json()).items.find((i) => i.patient.facilityNo === patientNo && ["arrived", "triaged", "in-progress"].includes(i.status));
const token = open.token, encId = open.id;
const row = page.locator(`[data-er-row="${encId}"]`);
await page.getByRole("radio", { name: "২", exact: true }).click();
await page.getByTestId("save-triage").click();
await page.locator(`[data-er-row="${encId}"][data-level="2"]`).waitFor();
await page.getByTestId("doctor-select").selectOption("u_e2l_paed");
await page.getByTestId("paed-prompt").waitFor();
await shot("nurse-paediatric-prompt");
await page.getByTestId("doctor-select").selectOption("u_e2l_doctor");
await page.getByTestId("save-triage").click();
await row.getByText("ডা. লাইট ইমার্জেন্সি").waitFor();
await shot("nurse-triaged-level-2");
// an unknown patient by ambulance
await page.getByTestId("new-arrival").click();
await page.getByRole("radio", { name: "অজ্ঞাত রোগী" }).click();
await page.getByTestId("unknown-age").fill("৪০");
await page.getByTestId("unknown-features").fill("বাম হাতে কাটা দাগ, নীল শার্ট");
await page.getByRole("radio", { name: "অ্যাম্বুলেন্স" }).click();
await page.getByTestId("arrival-complaint").fill("সড়ক দুর্ঘটনা — মাথায় আঘাত, GCS 11");
await page.getByTestId("arrival-bay").selectOption({ label: "ER-1" });
await page.getByTestId("arrival-submit").click();
await page.getByTestId("triage-panel").getByText("অজ্ঞাত পুরুষ").waitFor();
await page.getByRole("radio", { name: "১", exact: true }).click();
await page.getByTestId("save-triage").click();
await page.locator("[data-er-row][data-level='1']").first().waitFor();
await shot("nurse-board-unknown-level-1");
// vitals for Farzana through the vitals station
await page.goto(BASE + `/m/fd/vitals?enc=${encId}`);
await page.getByRole("textbox", { name: /Systolic|সিস্টোলিক/ }).fill("96");
await page.getByRole("textbox", { name: /Diastolic|ডায়াস্টোলিক/ }).fill("60");
await page.getByRole("textbox", { name: /Pulse|পালস/ }).fill("112");
await page.getByRole("textbox", { name: /SpO/ }).fill("98");
await page.getByRole("button", { name: /^(Save vitals|সংরক্ষণ)$/ }).click();
await page.waitForTimeout(1500);
await shot("nurse-vitals-saved");

// ── the ER doctor: orders, note, the admit disposition ──
await login(DOCTOR);
await page.goto(BASE + `/m/er/orders?enc=${encId}`);
await page.getByTestId("er-strip").waitFor();
await page.locator('[data-order="cbc"]').click();
await page.locator('[data-order="cbc"][data-order-status="active"]').waitFor();
await page.locator('[data-care="ivf"]').click();
await page.locator('[data-care="ivf"][data-care-on="1"]').waitFor();
await page.getByTestId("er-notes").fill("USG: ?ruptured ovarian cyst. IV line in. Surgery consult.");
await page.getByRole("button", { name: /নোট সংরক্ষণ/ }).click();
await shot("doctor-orders");
await page.locator('[data-disposition="admit"]').click();
await page.getByTestId("consultant-select").selectOption("u_e2l_surgeon");
await page.getByTestId("admit-diagnosis").fill("Acute lower abdominal pain · ?ruptured ovarian cyst");
await page.locator('[data-bed="2A-03"]').click();
await shot("doctor-admit-bed-picked", true);
await page.getByTestId("sign-disposition").click();
await page.getByTestId("pin").fill("1234");
await shot("doctor-pin-sheet");
await page.getByTestId("pin-sign").click();
await page.getByTestId("disposition-signed").waitFor();
await shot("doctor-admit-signed");

// ── the admission desk ──
await login(DESK);
await page.goto(BASE + "/m/ipd/admit");
const req = page.locator(`[data-request][data-request-patient="${patientNo}"]`);
await req.waitFor();
await shot("desk-requests");
await req.click();
await page.getByTestId("guardian-name").fill("রাশেদ চৌধুরী");
await page.getByTestId("guardian-phone").fill("০১৭১১-৯০৮৮১২");
for (const c of ["general", "financial", "guardian-id"]) await page.locator(`[data-consent="${c}"] input`).check();
await shot("desk-admit-form-ready", true);
await page.getByTestId("admit").click();
await page.getByTestId("admitted-card").waitFor();
await shot("desk-admitted");
// the board afterwards, as the nurse
await login(NURSE);
await page.goto(BASE + "/m/er/triage");
await page.getByTestId("new-arrival").waitFor();
await shot("nurse-board-after-admission");
await browser.close();
console.log("done", token);
