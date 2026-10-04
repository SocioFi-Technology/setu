// Local hands-on walkthrough (not a test): one patient through A8–A11 in the E2E Test Clinic, a screenshot per step.
// node walk-lab.mjs <outDir>
import { chromium, request as pwRequest } from "@playwright/test";
const OUT = process.argv[2] ?? "shots";
const BASE = process.env.STAFF_URL ?? "http://localhost:3300";
const DESK = "01799000001", DOCTOR = "01799000002", TECH = "01799000005", PATH = "01799000006";
const RUN = Date.now().toString(36).slice(-4);
let n = 0;
const log = (...a) => console.log(...a);

// --- preparation through the API (A1–A5 are done and tested elsewhere) ---
const api = await pwRequest.newContext({ baseURL: BASE });
const key = () => ({ "idempotency-key": crypto.randomUUID() });
async function as(phone) { const r = await api.post("/api/v1/auth/login", { data: { identifier: phone, password: "setu1234" } }); if (!r.ok()) throw new Error(await r.text()); }
async function post(url, data, status = 200) { const r = await api.post("/api" + url, { headers: key(), data }); if (r.status() !== status) throw new Error(url + " " + r.status() + " " + (await r.text())); return r.json(); }
await as(DESK);
const reg = await post("/v1/patients", { nameBn: "হাতে-কলমে রোগী", nameEn: `Walkthrough ${RUN}`, sex: "female", dobMode: "dob", dob: "03/03/1991",
  phone: `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true }, 201);
const enc = reg.encounter.id;
await as(DOCTOR);
const open = await post(`/v1/encounters/${enc}/consultation/open`, {});
const saved = await api.put(`/api/v1/compositions/${open.draft.id}`, { headers: key(), data: {
  rev: 1, sections: { complaints: [{ text: "Tiredness", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
  sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }],
  orders: ["cbc", "rbs", "elec"].map((testCode) => ({ testCode, priority: "routine" })) } });
await post(`/v1/compositions/${open.draft.id}/sign`, { rev: (await saved.json()).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });
log(`patient Walkthrough ${RUN}, visit ${reg.encounter.token} (${enc}) signed with CBC, RBS, S. Electrolytes`);

// --- the UI ---
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
async function shot(name) { n++; const f = `${OUT}/${String(n).padStart(2, "0")}-${name}.png`; await page.waitForTimeout(600); await page.screenshot({ path: f, fullPage: true }); log("  shot", f); }
async function login(phone) {
  await page.context().clearCookies(); await page.goto(BASE + "/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForSelector("header.shell-top"); await page.getByRole("radio", { name: "EN", exact: true }).click(); await page.getByRole("radio", { name: "0123", exact: true }).click();
}
async function step(name, fn) {
  try { await fn(); await shot(name); log("OK  ", name); }
  catch (e) { await shot("FAIL-" + name).catch(() => {}); log("FAIL", name, String(e.message).split("\n")[0]); }
}
const go = (p) => page.goto(BASE + p, { waitUntil: "networkidle" });

await login(TECH);
await step("A8-collect-worklist", async () => { await go("/m/lab/collect"); await page.locator(`[data-encounter="${enc}"]`).waitFor(); });
await step("A8-tube-guidance", async () => { await page.locator(`[data-encounter="${enc}"]`).click(); await page.waitForURL(/enc=/); await page.locator('[data-tube="edta"]').waitFor(); });
await step("A8-labels-printed", async () => { await page.getByTestId("print-labels").click(); await page.getByTestId("labels-status").waitFor(); });
await step("A8-partial-collection", async () => { await page.getByTestId("collect-edta").click(); await page.locator('[data-collection="partial"]').waitFor(); });
await step("A8-reject-dialog", async () => { await page.getByTestId("collect-fluoride").click(); await page.waitForTimeout(800); await page.getByTestId("reject-fluoride").click(); await page.selectOption("select[name=reject-reason]", "haemolysed"); });
await step("A8-rejected-recollect-sms", async () => { await page.getByTestId("reject-confirm").click(); await page.getByTestId("recollect-sms").filter({ hasText: "Delivered" }).waitFor(); });
await step("A8-new-tube-and-plain-collected", async () => {
  await page.getByTestId("collect-plain").click(); await page.waitForTimeout(800);
  const print = page.getByTestId("print-labels"); if (await print.isEnabled()) { await print.click(); await page.waitForTimeout(800); }
  await page.getByTestId("collect-fluoride").click(); await page.waitForTimeout(800);
});
await step("A8-accession", async () => {
  await go(`/m/lab/accession?enc=${enc}`);
  for (const t of ["edta", "fluoride", "plain"]) { await page.getByTestId(`receive-${t}`).click(); await page.waitForTimeout(700); await page.getByTestId(`start-${t}`).click(); await page.waitForTimeout(700); }
});
await step("A9-entry-critical-k-typed-twice", async () => {
  await go(`/m/lab/result?enc=${enc}`);
  const el = page.getByTestId("entry-elec");
  await el.locator("input[name=v-na]").fill("138"); await el.locator("input[name=v-na]").press("Enter");
  await page.keyboard.type("6.9"); await page.keyboard.press("Enter"); await page.keyboard.type("6.9"); await page.keyboard.press("Enter"); await page.keyboard.type("101");
  const rbs = page.getByTestId("entry-rbs"); await rbs.locator("input[name=v-rbs]").fill("11.2");
});
await step("A9-sent-for-verification", async () => { await page.getByTestId("send-elec").click(); await page.waitForTimeout(1000); await page.getByTestId("send-rbs").click(); await page.getByTestId("results-rbs").waitFor(); });
await step("A9-technical-verify", async () => {
  await go(`/m/lab/verify?enc=${enc}`); await page.fill("input[name=verify-pin]", "1234");
  const d = page.locator("input[name=delta-checked]"); if (await d.count()) await d.check();
  await page.getByTestId("verify").click(); await page.locator('[data-step="verify"]').filter({ hasText: "Nothing waiting" }).waitFor();
});

await login(PATH);
await step("A10-validate-locked-callback", async () => { await go(`/m/lab/verify?enc=${enc}`); await page.getByTestId("callback-lock").waitFor(); });
await step("A10-no-answer-still-locked", async () => {
  const p = page.locator('[data-callback="k"]'); await p.getByLabel("No answer").check(); await p.locator("input[name=cb-name]").fill("Dr. Walkthrough");
  await p.getByTestId("log-call").click(); await p.getByTestId("callback-log").filter({ hasText: "no answer" }).waitFor(); await page.getByTestId("callback-lock").waitFor();
});
await step("A10-reached-readback-unlocked", async () => {
  const p = page.locator('[data-callback="k"]'); await p.getByLabel("Reached").check(); await p.locator("input[name=cb-name]").fill("Dr. Walkthrough"); await p.locator("input[name=cb-readback]").check();
  await p.getByTestId("log-call").click(); await page.getByTestId("callback-lock").waitFor({ state: "detached" });
});
await step("A10-validated-release-preview", async () => {
  await page.fill("input[name=validate-pin]", "1234"); await page.getByTestId("validate").click();
  await page.locator("[data-release-preview]").filter({ hasText: "PRELIMINARY" }).waitFor();
});
await step("A10-released-preliminary-report", async () => { await page.getByTestId("release-btn").click(); await page.waitForURL(/\/m\/lab\/report\?id=/); await page.getByTestId("report-banner").waitFor(); });

await login(TECH);
await step("A11-delivery", async () => { await go(`/m/lab/delivery?enc=${enc}`); await page.getByTestId("released").waitFor(); });
await step("A11-sms-failed", async () => { await page.getByTestId("dev-sms").getByRole("button").click(); await page.getByTestId("send-sms").click(); await page.locator('[data-channel="sms"][data-status="failed"]').waitFor(); });
await step("A11-sms-retried-app-sent", async () => {
  await page.getByTestId("retry-sms").click(); await page.locator('[data-channel="sms"][data-status="completed"]').waitFor();
  await page.getByTestId("send-app").click(); await page.locator('[data-channel="app"][data-status="completed"]').waitFor();
});
await step("correction-after-release", async () => {
  await go(`/m/lab/result?enc=${enc}`); await page.getByTestId("correct-rbs").click(); await page.fill("input[name=correct-value]", "12.1");
  await page.fill("textarea[name=reason]", "transcription error at entry"); await page.getByTestId("reason-confirm").click();
  await page.getByTestId("results-rbs").locator('[data-status="entered-in-error"]').waitFor();
});
await step("bangla-result-screen", async () => { await page.getByRole("radio", { name: "বাং", exact: true }).click(); await page.getByRole("radio", { name: "০১২৩", exact: true }).click(); });
await step("tablet-1024-result-screen", async () => { await page.setViewportSize({ width: 1024, height: 768 }); });
log("done");
await browser.close(); await api.dispose();
