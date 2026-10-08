// Local hands-on walkthrough (not a test): the doctor on a phone, A12–A13, in the E2E Test Clinic; a screenshot per step.
// node walk-doc.mjs <outDir>
import { chromium, request as pwRequest } from "@playwright/test";
const OUT = process.argv[2] ?? "shots";
const BASE = process.env.STAFF_URL ?? "http://localhost:3300";
const DESK = "01799000001", DOCTOR = "01799000002", TECH = "01799000005", PATH = "01799000006";
const RUN = Date.now().toString(36).slice(-4);
let n = 0;
const log = (...a) => console.log(...a);

const api = await pwRequest.newContext({ baseURL: BASE });
const key = () => ({ "idempotency-key": crypto.randomUUID() });
async function as(phone) { const r = await api.post("/api/v1/auth/login", { data: { identifier: phone, password: "setu1234" } }); if (!r.ok()) throw new Error(await r.text()); }
async function post(url, data, status = 200) { const r = await api.post("/api" + url, { headers: key(), data }); if (r.status() !== status) throw new Error(url + " " + r.status() + " " + (await r.text())); return r.json(); }
const get = async (url) => (await api.get("/api" + url)).json();

// 1. Walkthrough patient with a penicillin allergy; an earlier visit with a released critical potassium
await as(DESK);
const reg = await post("/v1/patients", { nameBn: "হাতে-কলমে রোগী", nameEn: `Hands-on ${RUN}`, sex: "female", dobMode: "dob", dob: "03/03/1984",
  phone: `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true }, 201);
const pid = reg.patient.id, enc1 = reg.encounter.id;
await as(DOCTOR);
const o1 = await post(`/v1/encounters/${enc1}/consultation/open`, {});
await post(`/v1/patients/${pid}/allergies`, { encounterId: enc1, kind: "class", key: "penicillin", reaction: "rash", severity: "moderate" }, 201);
const s1 = await api.put(`/api/v1/compositions/${o1.draft.id}`, { headers: key(), data: { rev: 1, sections: { complaints: [{ text: "Weakness", duration: { n: 1, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
  sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }], orders: [{ testCode: "elec", priority: "routine" }] } });
await post(`/v1/compositions/${o1.draft.id}/sign`, { rev: (await s1.json()).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });
await as(TECH);
let v = await post(`/v1/lab/visits/${enc1}/labels`, {});
for (const sp of v.specimens.filter((x) => x.status === "pending")) for (const st of ["collect", "receive", "start"]) await post(`/v1/lab/specimens/${sp.id}/${st}`, { at: new Date().toISOString() });
v = await get(`/v1/lab/visits/${enc1}`);
await post(`/v1/lab/orders/${v.orders[0].id}/results`, { entries: [{ analyteCode: "na", value: "138" }, { analyteCode: "k", value: "6.9", confirm: "6.9" }, { analyteCode: "cl", value: "101" }] }, 201);
v = await get(`/v1/lab/visits/${enc1}`);
v = await post(`/v1/lab/visits/${enc1}/verify`, { pin: "1234", observationIds: v.orders[0].results.map((r) => r.id), deltaChecked: true });
const k = v.orders[0].results.find((r) => r.flag === "HH");
await post(`/v1/lab/observations/${k.id}/callbacks`, { outcome: "reached", recipientRole: "ordering-doctor", recipientName: "Dr. Test", via: "phone", calledAt: new Date().toISOString(), readBack: true }, 201);
await as(PATH);
v = await post(`/v1/lab/visits/${enc1}/validate`, { pin: "1234", observationIds: v.orders[0].results.map((r) => r.id) });
await post(`/v1/lab/visits/${enc1}/release`, { observationIds: v.release.observationIds }, 201);
// a second, normal report for the offline check
await as(DESK);
const enc2 = (await post("/v1/encounters", { patientId: pid }, 201).catch(async () => null))?.encounter?.id;
log(`patient Hands-on ${RUN}: penicillin allergy; critical K 6.9 released (visit ${reg.encounter.token}); new visit ${enc2 ?? "(exists today)"}`);

// 2. The phone
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
/* training (e2e/training): the steps run on the English screen; each picture is taken in Bangla, then English again */
async function inBangla(p, take) {
  // a dialog can cover the toggle: then the picture is taken as the screen is (never a failed step for a toggle)
  const r = (l) => p.getByRole("radio", { name: l, exact: true });
  const toggled = await r("বাং").click({ timeout: 2000 }).then(() => true, () => false);
  if (toggled) await p.waitForTimeout(300);
  try { await take(); } finally { if (toggled) await r("EN").click({ timeout: 2000 }).then(() => p.waitForTimeout(200), () => {}); }
}
async function shot(name, full = false) { n++; const f = `${OUT}/${String(n).padStart(2, "0")}-${name}.png`; await page.waitForTimeout(700); await inBangla(page, () => (full ? page.evaluate(() => window.scrollTo(0, 0)) : Promise.resolve()).then(() => page.screenshot({ path: f, fullPage: full }))); console.log("saved", f); }
async function step(name, fn, full = false) {
  try { await fn(); await shot(name, full); log("OK  ", name); }
  catch (e) { await shot("FAIL-" + name).catch(() => {}); log("FAIL", name, String(e.message).split("\n")[0]); }
}
const go = (p) => page.goto(BASE + p, { waitUntil: "networkidle" });
await page.goto(BASE + "/login");
await page.fill("input[name=identifier]", DOCTOR); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
await page.waitForSelector("header.shell-top");
await page.getByRole("radio", { name: "EN", exact: true }).click();

await step("A12-home", async () => { await go("/m/doc/home"); await page.getByTestId("doc-tiles").waitFor(); });
const card = () => page.locator('[data-inbox-item][data-kind="report-inbox"]').filter({ hasText: `Hands-on ${RUN}` }).first();
await step("A12-inbox-critical-card", async () => { await go("/m/doc/inbox"); await card().waitFor(); await card().scrollIntoViewIfNeeded(); });
await step("A12-seen-tell-patient", async () => { await card().getByTestId("ack-tell").click(); await card().getByTestId("acked").filter({ hasText: "delivered" }).waitFor(); });
await step("A12-queue", async () => { await go("/m/doc/queue"); await page.locator("[data-doc-token]").first().waitFor(); });
await step("A12-quick-consult-allergy-strip", async () => {
  if (!enc2) throw new Error("no second visit today");
  await go(`/m/doc/consult?enc=${enc2}`); await page.getByTestId("phone-head").getByTestId("allergy-strip").waitFor();
});
await step("A12-amoxicillin-flagged-in-search", async () => {
  const search = page.getByTestId("rx-search"); await search.scrollIntoViewIfNeeded(); await search.fill("moxa");
  await page.locator('[data-medicine="moxacil"]').waitFor();
});
await step("A12-amoxicillin-blocked", async () => {
  await page.locator('[data-medicine="moxacil"]').click();
  await page.locator('[data-rx-line="moxacil"] [data-warning="allergy"]').waitFor();
  await page.locator('[data-rx-line="moxacil"]').scrollIntoViewIfNeeded();
});
await step("A12-removed-napa-added", async () => {
  await page.locator('[data-rx-line="moxacil"] [data-warning="allergy"]').getByRole("button").first().click();
  await page.locator('[data-rx-line="moxacil"]').waitFor({ state: "detached" });
  await page.getByTestId("rx-search").fill("napa"); await page.locator('[data-medicine="napa"]').click();
  await page.locator('[data-rx-line="napa"]').waitFor();
  await page.locator("input[aria-label='Chief complaints'], input[placeholder*='Complaint']").first().fill("Weakness 1w").catch(() => {});
});
await step("A12-pin-sheet", async () => {
  // a complaint and a diagnosis for signing (prepared through the editor's own fields)
  const complaint = page.locator("section, .card").filter({ hasText: "Chief complaints" }).locator("input").first();
  await complaint.fill("Weakness 1w"); await complaint.press("Enter");
  const dx = page.locator("section, .card").filter({ hasText: "Diagnosis" }).locator("input").first();
  await dx.fill("diabetes"); await page.waitForTimeout(800); await dx.press("ArrowDown").catch(() => {}); await dx.press("Enter");
  await page.waitForTimeout(1500);
  // the sheet covers the language toggle: switch to Bangla first so the PIN sheet is pictured in Bangla
  await page.getByRole("radio", { name: "বাং", exact: true }).click();
  await page.getByTestId("sign-open").click(); await page.getByTestId("sign-sheet").waitFor();
});
await step("A12-signed-server-confirmed", async () => {
  const sheet = page.getByTestId("sign-sheet");
  await sheet.locator("input[name=sign-pin]").fill("1234");
  await sheet.getByRole("button", { name: /^(Sign|স্বাক্ষর)$/ }).click();
  await page.waitForURL(/signed=1/, { timeout: 20000 }); await page.getByTestId("doc-signed").waitFor();
  await page.getByRole("radio", { name: "EN", exact: true }).click().catch(() => {});
});
await step("A13-printed-A5", async () => {
  const panel = page.getByTestId("print-panel-rx"); await panel.scrollIntoViewIfNeeded();
  await panel.getByTestId("doc-print").click(); await panel.getByTestId("doc-print-log").locator('[data-copy="0"]').waitFor();
});
let verifyUrl = null;
await step("A13-verify-page-public", async () => {
  verifyUrl = await page.getByTestId("doc-verify-url").getAttribute("href");
  const pub = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await pub.goto(BASE + new URL(verifyUrl).pathname, { waitUntil: "networkidle" }); await pub.getByTestId("verify-ok").waitFor();
  n++; await pub.screenshot({ path: `${OUT}/${String(n).padStart(2, "0")}-A13-verify-page.png`, fullPage: true }); await pub.close(); n--;
});
log("done", verifyUrl ?? "");
await browser.close(); await api.dispose();
