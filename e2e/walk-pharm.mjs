// Local hands-on walkthrough (not a test): the pharmacy, journey P1–P6, in the demo clinic (Green Life, Mirpur) with
// Rahima Khatun (penicillin and sulfa allergies); Bangla screens as staff see them; a screenshot per step.
// node walk-pharm.mjs <outDir>
import { chromium, request as pwRequest } from "@playwright/test";
const OUT = process.argv[2] ?? "shots";
const BASE = process.env.STAFF_URL ?? "http://localhost:3300";
const DESK = "01711000001", DOCTOR = "01711000002", PHARM = "01711000007", OWNER = "01711000009";
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
let n = 0;

const api = await pwRequest.newContext({ baseURL: BASE });
const key = () => ({ "idempotency-key": crypto.randomUUID() });
async function as(phone) { const r = await api.post("/api/v1/auth/login", { data: { identifier: phone, password: "setu1234" } }); if (!r.ok()) throw new Error(await r.text()); }
async function post(url, data, status = 200) { const r = await api.post("/api" + url, { headers: key(), data }); if (r.status() !== status) throw new Error(url + " " + r.status() + " " + (await r.text())); return r.json(); }

// Rahima Khatun's visit today, signed by Dr. Imran Kabir: Comet 500 1+0+1 × 30 days, Napa 1+1+1 × 3 days
await as(DESK);
const visit = await post("/v1/encounters", { patientId: "p_rahima", visitType: "follow-up" }, 201);
const enc = visit.encounter.id;
await as(DOCTOR);
const o = await post(`/v1/encounters/${enc}/consultation/open`, {});
const s1 = await api.put(`/api/v1/compositions/${o.draft.id}`, { headers: key(), data: { rev: o.draft.rev ?? 1, sections: { complaints: [{ text: "জ্বর ও শরীর ব্যথা; ডায়াবেটিস ফলো-আপ", duration: { n: 3, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
  sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "confirmed" }], orders: [],
  medications: [{ medicineKey: "comet", dose: "1+0+1", meal: "after", days: 30 }, { medicineKey: "napa", dose: "1+1+1", meal: "after", days: 3 }] } });
if (!s1.ok()) throw new Error(await s1.text());
await post(`/v1/compositions/${o.draft.id}/sign`, { rev: (await s1.json()).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
async function login(phone, english = false) {
  await page.context().clearCookies();
  await page.goto(BASE + "/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForSelector("header.shell-top", { timeout: 60000 });
  await page.getByRole("radio", { name: english ? "EN" : "বাং", exact: true }).click();
  await page.getByRole("radio", { name: english ? "0123" : "০১২৩", exact: true }).click();
}
async function shot(name, full = false) { n++; const f = `${OUT}/${String(n).padStart(2, "0")}-${name}.png`; await page.waitForTimeout(600); await (full ? page.evaluate(() => window.scrollTo(0, 0)) : Promise.resolve()).then(() => page.screenshot({ path: f, fullPage: full })); console.log("saved", f); }
const line = (k) => page.locator(`[data-testid="rx-line"][data-medicine="${k}"]`);

// P1–P3 as the pharmacist
await login(PHARM);
await page.goto(BASE + "/m/ph/dispense");
await page.locator(`[data-testid="rx-row"][data-encounter="${enc}"]`).waitFor();
await shot("queue");
await page.locator(`[data-testid="rx-row"][data-encounter="${enc}"]`).click();
await line("comet").waitFor();
await line("comet").locator("summary").click();
await line("comet").getByTestId("line-give-qty").fill("20");
await line("napa").getByTestId("line-medicine").selectOption("ace");
await line("napa").getByTestId("line-reason").fill("নাপার ব্যাচের মেয়াদ শেষ — একই প্যারাসিটামল");
await shot("dispense-ready", true);
await page.getByTestId("dispense").click();
await page.locator('[data-testid="rx-line"][data-medicine="comet"][data-status="partial"]').waitFor();
await page.getByTestId("issue-bill").click();
await page.locator('[data-testid="pharmacy-bill"][data-status="issued"]').waitFor();
await shot("dispensed-bill-issued", true);
await page.getByTestId("take-payment").click();
await page.locator('[data-screen="ph/pay"]').waitFor();
await page.locator("input[name=pay-amount]").waitFor();
await page.fill("input[name=pay-tendered]", "500");
await shot("pay-at-counter");
await page.getByTestId("pay-submit").click();
await page.locator('[data-screen="ph/pay"][data-invoice-status="balanced"]').waitFor();
await shot("paid");

// P4 OTC, with the prescription photo
await page.goto(BASE + "/m/ph/otc");
await page.getByTestId("buyer-name").fill("করিম উদ্দিন");
await page.getByTestId("start-sale").click();
await page.locator('[data-screen="ph/otc"][data-status="draft"]').waitFor();
async function addOtc(q, k, qty) { await page.getByTestId("otc-search").fill(""); await page.getByTestId("otc-search").fill(q); await page.locator(`[data-testid="otc-results"] [data-medicine="${k}"]`).click(); await page.getByTestId("otc-qty").fill(qty); }
await addOtc("ace", "ace", "10"); await page.getByTestId("otc-add").click(); await page.waitForTimeout(800);
await addOtc("diazepam", "sedil", "5");
await shot("otc-controlled-refused");
await addOtc("moxacil", "moxacil", "15");
await shot("otc-rx-needs-photo");
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
await page.getByTestId("photo-input").setInputFiles({ name: "rx.png", mimeType: "image/png", buffer: png });
await page.getByText("ছবি যোগ হয়েছে").waitFor();
await page.getByTestId("otc-add").click(); await page.waitForTimeout(800);
await shot("otc-ready", true);
await page.getByTestId("complete-sale").click();
await page.locator('[data-screen="ph/otc"][data-status="issued"]').waitFor();

// stock: near expiry
await page.goto(BASE + "/m/ph/stock");
await page.getByRole("radio", { name: "মেয়াদ শেষের কাছে" }).click();
await page.waitForTimeout(800);
await page.locator('[data-testid="stock-table"] tr[data-medicine="comet"] [data-testid="batches-toggle"]').click();
await shot("stock-near-expiry", true);

// P5 purchase: order, goods short, a short-expiry batch
await page.goto(BASE + "/m/ph/purchase?tab=orders");
await page.getByTestId("new-po").click();
await page.locator('[data-screen="ph/purchase"][data-status="draft"]').waitFor();
for (const [m, q, c] of [["comet", "200", "3.40"], ["amdocal", "100", "4"]]) { await page.getByTestId("po-medicine").selectOption(m); await page.getByTestId("po-qty").fill(q); await page.getByTestId("po-cost").fill(c); await page.getByTestId("po-add").click(); await page.locator(`[data-testid="po-lines"] tr[data-line="${m}"]`).waitFor(); }
await page.getByTestId("po-send").click();
await page.locator('[data-screen="ph/purchase"][data-status="sent"]').waitFor();
await shot("po-sent");
await page.getByTestId("grn-invoice").fill(`SQ-${RUN}`);
await page.getByTestId("receive").click();
const day = (k) => new Date(Date.now() + 6 * 3600_000 + k * 864e5).toISOString().slice(0, 10);
for (const [m, b, e, billed, rec, mrp] of [["comet", `CM${RUN}`, day(700), "200", "180", "4"], ["amdocal", `AM${RUN}`, day(80), "100", "100", "5"]]) {
  const f = page.locator(`[data-testid="grn-form"][data-line="${m}"]`);
  await f.getByTestId("grn-batch").fill(b); await f.getByTestId("grn-expiry").fill(e); await f.getByTestId("grn-invoiced").fill(billed); await f.getByTestId("grn-received").fill(rec); await f.getByTestId("grn-mrp").fill(mrp);
  await f.getByTestId("grn-add").click(); await page.locator(`[data-testid="grn-lines"] tr[data-batch="${b}"]`).waitFor();
}
await shot("grn-checked", true);
const grnUrl = page.url();

// P6 count of the counter's Comet batches: start, a difference with a reason, submit
await page.goto(BASE + "/m/ph/count");
await page.getByTestId("count-location").selectOption("fridge").catch(() => undefined);
await page.goto(BASE + "/m/ph/stock");
await page.getByTestId("stock-search").fill("pantonix");
await page.locator('[data-testid="stock-table"] tr[data-medicine="pantonix"] [data-testid="batches-toggle"]').click();
await page.locator('[data-testid="batch-table"] tr[data-location="store"]').first().getByTestId("transfer").click();
await page.getByTestId("move-to").selectOption("fridge"); await page.getByTestId("move-qty").fill("20"); await page.getByTestId("move-confirm").click();
await page.waitForTimeout(800);
await page.goto(BASE + "/m/ph/count");
await page.getByTestId("count-location").selectOption("fridge");
await page.getByTestId("start-count").click();
await page.locator('[data-screen="ph/count"][data-status="counting"]').waitFor();
const rows = page.locator('[data-testid="count-lines"] tbody tr');
for (let i = 0; i < await rows.count(); i++) {
  const r = rows.nth(i); const exp = (await r.locator("td").nth(3).innerText()).trim().replace(/[০-৯]/g, (d) => "০১২৩৪৫৬৭৮৯".indexOf(d));
  await r.getByTestId("count-qty").fill(String(i === 0 ? Number(exp) - 2 : Number(exp))); await r.getByTestId("count-qty").press("Enter"); await page.waitForTimeout(500);
  if (i === 0) { await r.getByTestId("count-reason").fill("ফ্রিজে দুটি স্ট্রিপ পানিতে নষ্ট"); await r.getByTestId("count-reason").blur(); await page.waitForTimeout(500); }
}
await page.getByTestId("submit-count").click();
await page.locator('[data-screen="ph/count"][data-status="submitted"]').waitFor();
await shot("count-submitted", true);
const countUrl = page.url();

// the owner: approvals, posts the short-expiry receipt, approves the count; the dashboard's stock tiles
await login(OWNER);
await page.goto(BASE + "/m/ph/purchase");
await page.getByTestId("ph-approvals").waitFor();
await shot("owner-approvals");
await page.goto(grnUrl);
await page.getByTestId("grn-note").fill("স্বল্প মেয়াদ গ্রহণ — দ্রুত বিক্রি হয়");
await page.getByTestId("grn-post").click();
await page.locator('[data-screen="ph/purchase"][data-grn][data-status="posted"]').waitFor();
await shot("grn-posted-by-owner", true);
await page.goto(countUrl);
await page.getByTestId("approve-count").click();
await page.locator('[data-screen="ph/count"][data-status="approved"]').waitFor();
await shot("count-approved", true);
await page.goto(BASE + "/m/own/dash");
await page.locator('[data-kpi="stockValue"]').waitFor();
await shot("owner-dash-stock-tiles");

// the doctor's phone: the substitution notice
await page.setViewportSize({ width: 412, height: 900 });
await login(DOCTOR);
await page.goto(BASE + "/m/doc/inbox");
await page.locator('[data-kind="substitution-notice"]').first().waitFor();
await page.locator('[data-kind="substitution-notice"]').first().scrollIntoViewIfNeeded();
await shot("doctor-substitution-notice");

// English, for reviewers: the dispense screen after the rest was given out
await page.setViewportSize({ width: 1440, height: 900 });
await login(PHARM, true);
await page.goto(BASE + `/m/ph/dispense?enc=${encodeURIComponent(enc)}`);
await line("comet").waitFor();
await shot("dispense-english", true);
await browser.close();
