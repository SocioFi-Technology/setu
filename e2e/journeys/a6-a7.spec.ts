import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
/* Journey A, steps A6–A7 (OPD bill, payment, receipt) on the real stack, in the seeded E2E Test Clinic, as the E2E
   cashier (01799000008); the owner (01799000009) approves. Each test has a new synthetic patient whose visit the E2E
   doctor signs with CBC, RBS and S. Electrolytes (the walkthrough's A5 orders), so the bill is ৳800 + ৳450 + ৳150 +
   ৳900 = ৳2,300. Walkthrough checks: source per line and VAT shown; a discount above the limit needs approval and
   nothing is applied before it; bKash confirm / fail paths; partial payment "Paid by" lists only confirmed money with
   bKash pending (issue #10); receipt with QR, Mushak-6.3, amount in words; reprint needs a reason → DUPLICATE #1. */
const DESK = "01799000001", DOCTOR = "01799000002", CASHIER = "01799000008", OWNER = "01799000009";
const RUN = Date.now().toString(36).slice(-5);
test.use({ viewport: { width: 1440, height: 1000 } });

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForURL("**/"); await expect(page.locator("header.shell-top")).toBeVisible();
  await page.getByRole("radio", { name: "EN", exact: true }).click();
  await page.getByRole("radio", { name: "0123", exact: true }).click();
}
const key = () => ({ "idempotency-key": crypto.randomUUID() });
/** A new synthetic patient's visit, signed by the E2E doctor with CBC, RBS and S. Electrolytes (finished). */
async function signedVisit(request: APIRequestContext, tag: string): Promise<{ id: string; token: string }> {
  await request.post("/api/v1/auth/login", { data: { identifier: DESK, password: "setu1234" } });
  const r = await request.post("/api/v1/patients", { headers: key(), data: {
    nameBn: "বিল রোগী", nameEn: `Bill ${tag} ${RUN}`, sex: "female", dobMode: "dob", dob: "03/03/1991", phone: `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
    phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
  } });
  expect(r.status(), await r.text()).toBe(201);
  const enc = ((await r.json()) as { encounter: { id: string; token: string } }).encounter;
  await request.post("/api/v1/auth/login", { data: { identifier: DOCTOR, password: "setu1234" } });
  const v = (await (await request.post(`/api/v1/encounters/${enc.id}/consultation/open`, { headers: key(), data: {} })).json()) as { draft: { id: string } };
  const saved = await request.put(`/api/v1/compositions/${v.draft.id}`, { headers: key(), data: {
    rev: 1, sections: { complaints: [{ text: "Tiredness", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }],
    orders: [{ testCode: "cbc", priority: "routine" }, { testCode: "rbs", priority: "routine" }, { testCode: "elec", priority: "routine" }],
  } });
  expect(saved.status(), await saved.text()).toBe(200);
  const s = await request.post(`/api/v1/compositions/${v.draft.id}/sign`, { headers: key(), data: { rev: ((await saved.json()) as { rev: number }).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false } });
  expect(s.status(), await s.text()).toBe(200);
  return enc;
}
/** From the cashier's list to the visit's bill. */
async function openBill(page: Page, token: string) {
  await page.goto("/m/bill/opd");
  await page.locator(`[data-bill-token="${token}"]`).click();
  await page.waitForURL(/\/m\/bill\/opd\?inv=/);
  await expect(page.getByTestId("bill-lines")).toBeVisible();
}
const total = (page: Page) => page.getByTestId("bill-total");
async function issue(page: Page) {
  await page.getByTestId("issue").click();
  await expect(page.getByTestId("invoice-number")).toHaveText(/^INV\/\d{2}\/\d{4,}$/);
}
async function asOwner(browser: Browser, fn: (p: Page) => Promise<void>) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const p = await ctx.newPage();
  try { await login(p, OWNER); await fn(p); } finally { await ctx.close(); }
}

test("A6: bill from the doctor's orders; a discount above the limit waits for the owner and nothing is applied before approval", async ({ page, request, browser }) => {
  test.setTimeout(120_000);
  const visit = await signedVisit(request, "A6");
  await login(page, CASHIER);
  await openBill(page, visit.token);
  const lines = page.getByTestId("bill-lines");
  for (const code of ["consult:u_e2e_doctor", "test:cbc", "test:rbs", "test:elec"]) await expect(lines.locator(`[data-line="${code}"]`)).toBeVisible();
  await expect(lines.locator('[data-line="test:rbs"]')).toContainText("From the doctor's order");
  await expect(lines.locator('[data-line="consult:u_e2e_doctor"]')).toContainText("From consultation");
  await expect(lines).toContainText("Exempt");
  await expect(total(page)).toHaveText("৳ 2,300");
  await expect(page.getByTestId("discount-limit")).toHaveText("Your limit on this bill: ৳ 115");

  await page.fill("input[name=discount-value]", "500");
  await page.selectOption("select[name=discount-category]", "doctor");
  await page.fill("input[name=discount-reason]", "Doctor's request — day labourer");
  await expect(page.getByTestId("discount-message")).toContainText("is above your limit of ৳ 115");
  await expect(page.getByTestId("discount-submit")).toHaveText("Request approval");
  await page.getByTestId("discount-submit").click();
  await expect(page.getByTestId("discount-pending")).toContainText("does not include this ৳ 500 until approved");
  await expect(total(page)).toHaveText("৳ 2,300");
  await expect(page.getByText("A discount is waiting for approval — issue after the decision")).toBeVisible();
  await expect(page.getByTestId("issue")).toBeDisabled();

  await asOwner(browser, async (o) => {
    await o.goto("/m/bill/approvals");
    const card = o.locator("[data-approval]", { hasText: `Bill A6 ${RUN}` });
    await expect(card).toContainText("৳ 500");
    await card.getByTestId("approve").click();
    await expect(card).toHaveCount(0);
  });
  await expect(page.getByTestId("discount-applied")).toBeVisible({ timeout: 15_000 });
  await expect(total(page)).toHaveText("৳ 1,800");
  await expect(page.getByTestId("discount-panel")).toContainText("Approved by Test Owner");
  await issue(page);
  await expect(page.getByTestId("take-payment")).toBeVisible();
});

test("A7 / issue #10: bKash link + cash with change → partial receipt lists only cash as paid; bKash confirms; print, then reprint with a reason → DUPLICATE #1; the QR page shows no patient", async ({ page, request }) => {
  test.setTimeout(150_000);
  const visit = await signedVisit(request, "A7");
  await login(page, CASHIER);
  await openBill(page, visit.token);
  await issue(page);
  await page.getByTestId("take-payment").click();
  await page.waitForURL(/\/m\/bill\/pay\?inv=/);

  await page.getByRole("radio", { name: "bKash" }).click();
  await page.fill("input[name=pay-amount]", "2000");
  await page.getByTestId("pay-submit").click();
  const bk = page.locator('[data-payment="bkash"]');
  await expect(bk).toHaveAttribute("data-status", "link-sent");
  await expect(bk).toContainText("Waiting for the patient to pay");
  await expect(page.locator('[data-sum="pending"]')).toContainText("৳ 2,000");

  await page.getByRole("radio", { name: "Cash" }).click();
  await page.fill("input[name=pay-amount]", "300");
  await page.fill("input[name=pay-tendered]", "500");
  await expect(page.getByTestId("pay-change")).toContainText("৳ 200");
  await page.getByTestId("pay-submit").click();
  await expect(page.locator('[data-payment="cash"]')).toHaveAttribute("data-status", "confirmed");
  await expect(page.getByTestId("paid-line")).toHaveText("Cash ৳ 300");
  await expect(page.getByTestId("pending-line")).toContainText("bKash ৳ 2,000 pending (not paid)");
  await expect(page.locator("[data-screen='bill/pay']")).toHaveAttribute("data-invoice-status", "partially-paid");

  // Partial receipt: the issue #10 line.
  await page.getByTestId("make-receipt").click();
  await page.waitForURL(/\/m\/bill\/receipt\?rc=/);
  await expect(page.getByTestId("receipt-paid-by")).toContainText("Cash ৳ 300 · bKash ৳ 2,000 pending (not paid)");
  await expect(page.getByTestId("receipt-paid")).toHaveText("৳ 300");
  await page.goBack();

  // The patient pays on the phone; the fake gateway's callback arrives.
  await bk.getByRole("button", { name: "Patient pays" }).click();
  await expect(bk).toHaveAttribute("data-status", "confirmed");
  await expect(page.getByTestId("paid-line")).toContainText(/bKash ৳ 2,000 \(TrxID [A-Z0-9]{10}\) \+ Cash ৳ 300/);
  await expect(page.locator("[data-screen='bill/pay']")).toHaveAttribute("data-invoice-status", "balanced");
  await page.getByTestId("make-receipt").click();
  await page.waitForURL(/\/m\/bill\/receipt\?rc=/);
  await expect(page.getByTestId("receipt-number")).toHaveText(/^RCPT\/\d{2}\/\d{4,}$/);
  await expect(page.getByTestId("receipt-summary")).toContainText("Two thousand three hundred taka only");

  await page.getByTestId("print").click();
  await expect(page.locator('[data-testid="print-audit"] [data-copy="0"]')).toContainText("Original printed — Test Cashier");
  const pdf = await request.get(await page.getByTestId("open-pdf").getAttribute("href") as string, { headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } });
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  await page.getByTestId("reprint").click();
  await expect(page.getByTestId("print-duplicate")).toBeDisabled();
  await page.selectOption("select[name=reprint-reason]", "lost");
  await page.getByTestId("print-duplicate").click();
  await expect(page.locator('[data-testid="print-audit"] [data-copy="1"]')).toContainText("Duplicate #1 — Patient lost it — Test Cashier");

  // The QR's public page: facility, number, date, amount — no patient details, no login.
  const url = await page.getByTestId("verify-url").textContent();
  const receiptNo = await page.getByTestId("receipt-number").textContent();
  const pub = await page.context().browser()!.newContext();
  const p2 = await pub.newPage();
  await p2.goto(new URL(url!).pathname);
  await expect(p2.getByTestId("verify-ok")).toBeVisible();
  await expect(p2.getByTestId("verify-number")).toHaveText(receiptNo!);
  await expect(p2.getByTestId("verify-amount")).toHaveText("৳ 2,300");
  await expect(p2.locator("body")).not.toContainText(`Bill A7 ${RUN}`);
  await expect(p2.locator("body")).not.toContainText("E2E-");
  await pub.close();
});

test("A7: a bKash payment whose callback is lost is confirmed with the TrxID from the patient's phone; a failed link can be resent", async ({ page, request }) => {
  test.setTimeout(120_000);
  const visit = await signedVisit(request, "TRX");
  await login(page, CASHIER);
  await openBill(page, visit.token);
  await issue(page);
  await page.getByTestId("take-payment").click();
  await page.getByRole("radio", { name: "Nagad" }).click();
  await page.getByTestId("pay-submit").click();
  const ng = page.locator('[data-payment="nagad"]');
  await expect(ng).toHaveAttribute("data-status", "link-sent");
  await ng.getByRole("button", { name: "Payment fails" }).click();
  await expect(ng).toHaveAttribute("data-status", "failed");
  await ng.getByRole("button", { name: "Resend link" }).click();
  await expect(ng).toHaveAttribute("data-status", "link-sent");
  await ng.getByRole("button", { name: "Pays, callback lost" }).click();
  const trx = (await ng.getByTestId("lost-trx").textContent())!.match(/[A-Z0-9]{10}$/)![0];
  await expect(ng).toHaveAttribute("data-status", "link-sent");
  await ng.locator("input[name^=trx-]").fill(trx);
  await ng.getByRole("button", { name: "Verify" }).click();
  await expect(ng).toHaveAttribute("data-status", "confirmed");
  await expect(ng.getByTestId("trx")).toContainText(trx);
  await expect(page.locator("[data-screen='bill/pay']")).toHaveAttribute("data-invoice-status", "balanced");
});

test("A7 offline: cash is recorded on this device, a provisional receipt has no number or QR, and the payment is confirmed when back online", async ({ page, request, context }) => {
  test.setTimeout(120_000);
  const visit = await signedVisit(request, "OFF");
  await login(page, CASHIER);
  await openBill(page, visit.token);
  await issue(page);
  await page.getByTestId("take-payment").click();
  await page.waitForURL(/\/m\/bill\/pay\?inv=/);
  await expect(page.getByTestId("pay-form")).toBeVisible();
  await context.setOffline(true);
  await page.fill("input[name=pay-amount]", "2300");
  await page.fill("input[name=pay-tendered]", "2500");
  await page.getByTestId("pay-submit").click();
  await expect(page.getByTestId("pay-queued")).toContainText("Cash ৳ 2,300 — Cash recorded on this device · not synced");
  await expect(page.getByTestId("paid-line")).toHaveText("—");
  const prov = page.getByTestId("provisional-receipt");
  await expect(page.getByTestId("provisional-banner")).toHaveText("PROVISIONAL — not synced");
  await expect(prov).not.toContainText("RCPT/");
  // No QR: the only drawing allowed is the icon on the Print button.
  expect(await prov.evaluate((el) => [...el.querySelectorAll("svg, img, canvas")].filter((x) => !x.closest("button")).length)).toBe(0);
  await expect(page.getByTestId("make-receipt")).toBeDisabled();
  await context.setOffline(false);
  await expect(page.locator('[data-payment="cash"]')).toHaveAttribute("data-status", "confirmed", { timeout: 15_000 });
  await expect(page.getByTestId("provisional-receipt")).toHaveCount(0);
  await expect(page.getByTestId("paid-line")).toHaveText("Cash ৳ 2,300");
});

test("A6: the receptionist sees the bill but cannot change it", async ({ page, request }) => {
  const visit = await signedVisit(request, "RO");
  await login(page, CASHIER);
  await openBill(page, visit.token);
  const url = page.url();
  await login(page, DESK);
  await page.goto(url.replace(/^https?:\/\/[^/]+/, ""));
  await expect(page.getByText("You can view this bill but not change it")).toBeVisible();
  await expect(page.getByTestId("issue")).toHaveCount(0);
  await expect(page.getByTestId("discount-submit")).toHaveCount(0);
});
