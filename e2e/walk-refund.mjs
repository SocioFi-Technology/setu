// Local hands-on walkthrough (not a test): refunds and returns (ADR 0013, journey R) in the demo clinic (Green Life,
// Mirpur) with Rahima Khatun; Bangla screens as staff see them; a screenshot per step. As the cashier (Kafia Mia), the
// pharmacist (Md. Jewel Rana) and the owner (Anwar Hossain), with the owner's approvals also at 412 px.
// node walk-refund.mjs <outDir>
import { chromium, request as pwRequest } from "@playwright/test";
const OUT = process.argv[2] ?? "shots";
const BASE = process.env.STAFF_URL ?? "http://localhost:3300";
const DESK = "01711000001", DOCTOR = "01711000002", PHARM = "01711000007", CASHIER = "01711000008", OWNER = "01711000009";
let n = 0;

const api = await pwRequest.newContext({ baseURL: BASE });
const key = () => ({ "idempotency-key": crypto.randomUUID() });
async function as(phone) { const r = await api.post("/api/v1/auth/login", { data: { identifier: phone, password: "setu1234" } }); if (!r.ok()) throw new Error(await r.text()); }
async function post(url, data, status = 200) { const r = await api.post("/api" + url, { headers: key(), data }); if (r.status() !== status) throw new Error(url + " " + r.status() + " " + (await r.text())); return r.json(); }
async function get(url) { const r = await api.get("/api" + url); if (!r.ok()) throw new Error(url + " " + (await r.text())); return r.json(); }
async function openShift() { const m = await get("/v1/shifts/mine"); if (m.shift?.status !== "open") await api.post("/api/v1/shifts", { headers: key(), data: { openingFloatPaisa: 200_000 } }); }

/** Rahima Khatun's visit today, signed by Dr. Imran Kabir with these orders and medicines. */
async function visit(orders, meds) {
  await as(DESK);
  const v = await post("/v1/encounters", { patientId: "p_rahima", visitType: "follow-up" }, 201);
  await as(DOCTOR);
  const o = await post(`/v1/encounters/${v.encounter.id}/consultation/open`, {});
  const s = await api.put(`/api/v1/compositions/${o.draft.id}`, { headers: key(), data: { rev: o.draft.rev ?? 1, sections: { complaints: [{ text: "জ্বর ও শরীর ব্যথা", duration: { n: 3, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "confirmed" }], orders: orders.map((testCode) => ({ testCode, priority: "routine" })), medications: meds } });
  if (!s.ok()) throw new Error(await s.text());
  await post(`/v1/compositions/${o.draft.id}/sign`, { rev: (await s.json()).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });
  return { enc: v.encounter.id, compositionId: o.draft.id };
}
async function pharmacyBill(pay) {
  const v = await visit([], [{ medicineKey: "comet", dose: "1+0+1", meal: "after", days: 5 }]);
  await as(PHARM);
  const d0 = await get(`/v1/pharmacy/encounters/${v.enc}`);
  const d = await post(`/v1/pharmacy/encounters/${v.enc}/dispense`, { compositionId: v.compositionId, lines: [{ requestId: d0.lines[0].requestId, medicineKey: "comet", qty: 10 }] });
  const b = await get(`/v1/invoices/${d.bill.id}`);
  const i = await post(`/v1/invoices/${d.bill.id}/issue`, { rev: b.invoice.rev });
  if (pay) await post(`/v1/invoices/${d.bill.id}/payments`, { method: "cash", amountPaisa: i.invoice.totalPaisa, tenderedPaisa: i.invoice.totalPaisa }, 201);
  return { ...v, invoiceId: d.bill.id, number: i.invoice.number };
}

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
async function ownerApproves(billNumber, phone = false) {
  if (phone) { await page.close(); page = await browser.newPage({ viewport: { width: 412, height: 915 } }); }
  await login(OWNER);
  await page.goto(BASE + "/m/bill/approvals");
  await page.locator('[data-kind="refund-approval"]').first().waitFor();
  const card = page.locator("[data-approval]", { hasText: billNumber });
  await card.scrollIntoViewIfNeeded();
  await shot(phone ? "owner-approvals-412" : "owner-approvals", phone);
  await card.getByTestId("approve").click();
  await page.locator("[data-approval]", { hasText: billNumber }).waitFor({ state: "detached" });
  if (phone) { await page.close(); page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); }
}

// ── 1. the cashier: a cancelled RBS, paid in cash, back in cash ──
const v1 = await visit(["cbc", "rbs"], []);
await as(CASHIER);
const b0 = await post(`/v1/encounters/${v1.enc}/invoice`, {}, 201);
const i0 = await post(`/v1/invoices/${b0.invoice.id}/issue`, { rev: b0.invoice.rev });
await post(`/v1/invoices/${b0.invoice.id}/payments`, { method: "cash", amountPaisa: i0.invoice.totalPaisa, tenderedPaisa: i0.invoice.totalPaisa }, 201);
await openShift();
await login(CASHIER);
await page.goto(`${BASE}/m/bill/pay?inv=${b0.invoice.id}`);
await page.getByTestId("pay-refund").waitFor();
await shot("cashier-pay-with-refund-button", true);
await page.getByTestId("pay-refund").click();
await page.getByTestId("rf-lines").waitFor();
await shot("cashier-refund-form");
await page.getByTestId("rf-lines").locator("tr", { hasText: "RBS" }).getByRole("checkbox").check();
await page.locator("select[name=rf-category]").selectOption("cancelled-test");
await page.fill("textarea[name=rf-reason]", "রক্ত নেওয়ার আগেই রোগী চলে গেছেন — RBS হয়নি");
await page.getByTestId("rf-ways").getByRole("radio").first().click();
await shot("cashier-refund-filled", true);
await page.getByTestId("rf-request").click();
await page.locator('[data-refund-status="requested"]').waitFor();
await shot("cashier-refund-requested");
const r1 = page.url();

await ownerApproves(i0.invoice.number, true);

await login(CASHIER);
await page.goto(r1);
await page.locator('[data-refund-status="approved"]').waitFor();
await page.fill("input[name=rf-recipient-name]", "রাশেদ চৌধুরী");
await page.fill("input[name=rf-recipient-phone]", "০১৭১১৯০৮৮১২");
await page.locator("select[name=rf-recipient-relation]").selectOption("spouse");
await shot("cashier-payout", true);
await page.getByTestId("rf-pay-submit").click();
await page.locator('[data-refund-status="paid"]').waitFor();
await page.getByTestId("voucher-print").click();
await page.locator("iframe").waitFor();
await page.waitForTimeout(2500);
await shot("cashier-voucher-printed", true);
const verify = await page.getByTestId("voucher-verify-url").getAttribute("href");
await page.context().clearCookies();
await page.goto(BASE + new URL(verify).pathname);
await page.getByTestId("verify-ok").waitFor();
await shot("public-voucher-check");

// ── 2. the pharmacist: a wrong dispense taken back, the doctor told, released after a check ──
const p2 = await pharmacyBill(true);
await login(PHARM);
await page.goto(`${BASE}/m/ph/pay?inv=${p2.invoiceId}`);
await page.getByTestId("pay-refund").click();
const row = page.getByTestId("rf-lines").locator("tr[data-line]").first();
await row.getByRole("checkbox").check();
await row.locator("input[name^=rf-]").fill("৪");
await page.locator("select[name=rf-category]").selectOption("wrong-dispense");
await page.fill("textarea[name=rf-reason]", "কমেট ৮৫০-এর জায়গায় ৫০০ দেওয়া হয়েছিল — ফেরত নেওয়া হলো");
await page.getByTestId("rf-ways").getByRole("radio").first().click();
await shot("pharm-wrong-dispense-form", true);
await page.getByTestId("rf-request").click();
await page.locator('[data-refund-status="requested"]').waitFor();
const r2 = page.url();
await ownerApproves(p2.number);
await as(PHARM); await openShift();
await login(PHARM);
await page.goto(r2);
await page.fill("input[name=rf-recipient-name]", "রহিমা খাতুন");
await page.fill("input[name=rf-recipient-phone]", "01712345678");
await page.locator("select[name=rf-recipient-relation]").selectOption("self");
await page.getByTestId("rf-pay-submit").click();
await page.locator('[data-refund-status="paid"]').waitFor();
await shot("pharm-refund-paid", true);
await login(DOCTOR);
await page.goto(BASE + "/m/doc/inbox");
await page.getByTestId("return-notice").first().waitFor();
await shot("doctor-return-notice");
await login(PHARM);
await page.goto(BASE + "/m/ph/stock");
await page.getByTestId("stock-search").fill("Comet");
await page.locator('tr[data-medicine="comet"]').getByTestId("batches-toggle").click();
await page.getByTestId("batch-table").locator('tr[data-location="quarantine"]').first().getByTestId("release").click();
await page.getByTestId("release-qty").fill("4");
await page.getByTestId("release-reason").fill("পাতা সিল করা, একই দিনে ফেরত — আবার বিক্রয়যোগ্য");
await page.getByTestId("release-unopened").check();
await shot("pharm-release-to-counter");
await page.getByTestId("release-confirm").click();
await page.waitForTimeout(800);

// ── 3. a return without refund on an unpaid pharmacy bill ──
const p3 = await pharmacyBill(false);
await login(PHARM);
await page.goto(`${BASE}/m/ph/pay?inv=${p3.invoiceId}`);
await page.getByTestId("pay-refund").click();
await page.getByTestId("return-hint").waitFor();
await page.getByTestId("rf-lines").locator("tr[data-line]").first().getByRole("checkbox").check();
await page.locator("select[name=rf-category]").selectOption("patient-request");
await page.fill("textarea[name=rf-reason]", "টাকা দেওয়ার আগেই সব ওষুধ না খুলে ফেরত দিয়েছেন");
await shot("pharm-return-without-refund", true);
await page.getByTestId("rf-request").click();
await page.locator('[data-refund-status="requested"]').waitFor();
const r3 = page.url();
await ownerApproves(p3.number);
await login(PHARM);
await page.goto(r3);
await page.getByTestId("rf-pay-submit").click();
await page.locator('[data-refund-status="paid"]').waitFor();
await shot("pharm-credit-voucher", true);
await page.goto(`${BASE}/m/ph/pay?inv=${p3.invoiceId}`);
await page.getByTestId("pay-credited").waitFor();
await shot("pharm-bill-due-zero", true);

// ── 4. the owner: the dashboard ──
await login(OWNER);
await page.goto(BASE + "/m/own/dash");
await page.locator('[data-kpi="refunds"]').waitFor();
await shot("owner-dashboard", true);
await page.locator('[data-leak="medicationIncident"]').click();
await page.locator("[data-drill-row]").first().waitFor();
await shot("owner-medication-incidents");
await page.goto(BASE + "/m/bill/refund");
await shot("refund-list");

await browser.close();
await api.dispose();
