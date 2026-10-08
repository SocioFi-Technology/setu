// Local hands-on walkthrough (not a test): Journey C — the cashier closes a short shift (desk), the owner's morning
// check on a 412 px phone. E2E Test Clinic; a screenshot per step.  node walk-owner.mjs <outDir>
import { chromium, request as pwRequest } from "@playwright/test";
const OUT = process.argv[2] ?? "shots";
const BASE = process.env.STAFF_URL ?? "http://localhost:3300";
const DESK = "01799000001", DOCTOR = "01799000002", CASHIER = "01799000008", OWNER = "01799000009";
const RUN = Date.now().toString(36).slice(-4);
let n = 0;
const log = (...a) => console.log(...a);
const api = await pwRequest.newContext({ baseURL: BASE });
const key = () => ({ "idempotency-key": crypto.randomUUID() });
async function as(phone) { const r = await api.post("/api/v1/auth/login", { data: { identifier: phone, password: "setu1234" } }); if (!r.ok()) throw new Error(await r.text()); }
async function post(url, data, status = 200) { const r = await api.post("/api" + url, { headers: key(), data }); if (r.status() !== status) throw new Error(url + " " + r.status() + " " + (await r.text())); return r.json(); }
const get = async (url) => (await api.get("/api" + url)).json();
async function billFor(tag) {
  await as(DESK);
  const r = await post("/v1/patients", { nameBn: "সকালের রোগী", nameEn: `Morning ${tag} ${RUN}`, sex: "female", dobMode: "dob", dob: "01/01/1985", phone: `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true }, 201);
  await as(DOCTOR);
  const v = await post(`/v1/encounters/${r.encounter.id}/consultation/open`, {});
  const s = await api.put(`/api/v1/compositions/${v.draft.id}`, { headers: key(), data: { rev: 1, sections: { complaints: [{ text: "Cough", duration: { n: 3, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" }, sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }], orders: [] } });
  await post(`/v1/compositions/${v.draft.id}/sign`, { rev: (await s.json()).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });
  await as(CASHIER);
  return (await post(`/v1/encounters/${r.encounter.id}/invoice`, {}, 201)).invoice;
}
// finish any shift the cashier has open
await as(CASHIER);
const mine = await get("/v1/shifts/mine");
if (mine.shift) { if (mine.shift.status === "open") await post(`/v1/shifts/${mine.shift.id}/count`, { counts: {} }).catch(() => {}); await post(`/v1/shifts/${mine.shift.id}/hand-over`, { reason: "closing before the hands-on walkthrough" }).catch(() => {}); await as(OWNER); await post(`/v1/shifts/${mine.shift.id}/review`, { decision: "approve", note: "closing before the hands-on walkthrough" }).catch(() => {}); }

const browser = await chromium.launch();
const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const phone = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
/* training (e2e/training): the steps run on the English screen; each picture is taken in Bangla, then English again */
async function inBangla(p, take) {
  // a dialog can cover the toggle: then the picture is taken as the screen is (never a failed step for a toggle)
  const r = (l) => p.getByRole("radio", { name: l, exact: true });
  const toggled = await r("বাং").click({ timeout: 2000 }).then(() => true, () => false);
  if (toggled) await p.waitForTimeout(300);
  try { await take(); } finally { if (toggled) await r("EN").click({ timeout: 2000 }).then(() => p.waitForTimeout(200), () => {}); }
}
async function shot(page, name) { n++; const f = `${OUT}/${String(n).padStart(2, "0")}-${name}.png`; await page.waitForTimeout(700); await inBangla(page, () => page.screenshot({ path: f })); console.log("saved", f); }
async function step(page, name, fn) { try { await fn(); await shot(page, name); log("OK  ", name); } catch (e) { await shot(page, "FAIL-" + name).catch(() => {}); log("FAIL", name, String(e.message).split("\n")[0]); } }
async function login(page, ph) { await page.context().clearCookies(); await page.goto(BASE + "/login"); await page.fill("input[name=identifier]", ph); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]"); await page.waitForSelector("header.shell-top"); await page.getByRole("radio", { name: "EN", exact: true }).click(); await page.getByRole("radio", { name: "0123", exact: true }).click(); }

// the cashier's morning: open the shift, one cash bill, then the evening count (blind) — ৳500 short
await login(desk, CASHIER);
await step(desk, "C4-cashier-open-shift", async () => { await desk.goto(BASE + "/m/bill/shift"); await desk.fill("input[name=shift-float]", "2000"); await desk.getByTestId("shift-open").click(); await desk.getByTestId("shift-live").waitFor(); });
const inv = await billFor("cash");
const issued = await post(`/v1/invoices/${inv.id}/issue`, { rev: inv.rev });
await post(`/v1/invoices/${inv.id}/payments`, { method: "cash", amountPaisa: issued.invoice.totalPaisa, tenderedPaisa: issued.invoice.totalPaisa }, 201);
await step(desk, "C4-cashier-blind-count", async () => { await desk.reload(); await desk.fill("input[name=note-1000]", "2"); await desk.fill("input[name=note-100]", "3"); await desk.fill("input[name=settle-bkash]", "0"); });
await step(desk, "C4-count-stored-variance-shown", async () => { await desk.getByTestId("shift-handover").click(); await desk.getByTestId("shift-counted-card").waitFor(); await desk.getByTestId("reason-needed").waitFor(); });
await step(desk, "C4-handed-over", async () => { await desk.fill("textarea[name=shift-reason]", "a ৳500 note seems to be missing"); await desk.getByTestId("shift-handover-reason").click(); await desk.getByTestId("shift-closed").waitFor(); });
// two discount requests above the cashier's limit
const d1 = await billFor("disc1"); await post(`/v1/invoices/${d1.id}/discount`, { mode: "amount", amountPaisa: 20_000, category: "doctor", reason: `Doctor's request, morning ${RUN}`, rev: d1.rev });
const d2 = await billFor("disc2"); await post(`/v1/invoices/${d2.id}/discount`, { mode: "amount", amountPaisa: 30_000, category: "poor", reason: `Patient cannot pay, morning ${RUN}`, rev: d2.rev });

// the owner's phone
await login(phone, OWNER);
await step(phone, "C1-owner-home-dashboard", async () => { await phone.locator('[data-screen="own/dash"]').waitFor(); });
await step(phone, "C1-chart-and-leakage", async () => { await phone.getByTestId("revenue-chart").scrollIntoViewIfNeeded(); });
await step(phone, "C1-revenue-drill", async () => { await phone.locator('[data-kpi="revenue"]').scrollIntoViewIfNeeded(); await phone.locator('[data-kpi="revenue"]').click(); await phone.getByTestId("drill").waitFor(); });
await phone.keyboard.press("Escape").catch(() => {}); await phone.goto(BASE + "/");
await step(phone, "C3-approvals", async () => { await phone.goto(BASE + "/m/bill/approvals"); await phone.locator("[data-approval]").filter({ hasText: `morning ${RUN}` }).first().waitFor(); });
await step(phone, "C3-approved-one-rejected-one", async () => {
  const c = (t) => phone.locator("[data-approval]").filter({ hasText: t });
  await c(`Doctor's request, morning ${RUN}`).getByTestId("approve").click(); await phone.waitForTimeout(800);
  await c(`Patient cannot pay, morning ${RUN}`).locator("textarea").fill("Not within policy — bill in full, offer instalments");
  await c(`Patient cannot pay, morning ${RUN}`).getByTestId("reject").click(); await phone.waitForTimeout(800);
});
await as(CASHIER); const di = await get(`/v1/invoices/${d1.id}`); await post(`/v1/invoices/${d1.id}/issue`, { rev: di.invoice.rev });
await step(phone, "C2-discounts-above-policy", async () => { await phone.goto(BASE + "/m/own/dash"); await phone.locator('[data-leak="discountAbovePolicy"]').click(); await phone.getByTestId("drill").waitFor(); });
await step(phone, "C4-owner-shift-card", async () => { await phone.goto(BASE + "/m/bill/shift"); await phone.locator("[data-shift]").first().waitFor(); });
await step(phone, "C4-owner-recount", async () => { const c = phone.locator("[data-shift]").first(); await c.locator("textarea[name=review-note]").fill("count the drawer again, check the coin box"); await c.getByTestId("shift-recount").click(); await phone.waitForTimeout(1000); });
await as(CASHIER); const ms = await get("/v1/shifts/mine");
await post(`/v1/shifts/${ms.shift.id}/count`, { counts: { 1000: 2, 100: 3 } });
await post(`/v1/shifts/${ms.shift.id}/hand-over`, { reason: "recounted — the ৳500 note is not in the drawer" });
await step(phone, "C4-owner-accepts-with-note", async () => { await phone.reload(); const c = phone.locator("[data-shift]").first(); await c.locator("textarea[name=review-note]").fill("accepted — cashier repays from next salary"); await c.getByTestId("shift-approve").click(); await phone.waitForTimeout(1200); });
await step(phone, "C4-dashboard-after", async () => { await phone.goto(BASE + "/m/own/dash"); await phone.locator('[data-leak="shiftVariance"]').scrollIntoViewIfNeeded(); });
await step(phone, "C1-bangla-7-days", async () => { await phone.getByRole("radio", { name: "বাং", exact: true }).click(); await phone.getByRole("radio", { name: "০১২৩", exact: true }).click(); await phone.goto(BASE + "/m/own/dash"); await phone.getByRole("radio", { name: "৭ দিন", exact: true }).click(); await phone.waitForTimeout(2500); });
log("done"); await browser.close(); await api.dispose();
