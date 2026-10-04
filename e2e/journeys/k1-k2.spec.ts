import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
/* Journey K — bKash tokenized checkout (ADR 0011) on the real stack against the local bKash sandbox stand-in, in the
   E2E Test Clinic as the E2E cashier. Runs only when the API runs in bKash mode (PAYMENTS_PROVIDER=bkash pointed at
   `pnpm --filter @setu/api bkash:standin`) and the run sets BKASH_STANDIN=1; the default suite runs on the fake gateway.
   K1 the cashier makes a bKash link → QR + short link; the patient's phone opens it, pays on bKash's page (wallet,
      OTP, PIN) and lands on the result page (paid, TrxID); the cashier's screen confirms by itself; bill balanced.
   K2 the patient closes bKash's page → "not paid" on both sides; the cashier makes a new link — the old short link
      now says it has ended — and the patient pays on the new one. */
const DESK = "01799000001", DOCTOR = "01799000002", CASHIER = "01799000008";
const RUN = Date.now().toString(36).slice(-5);
test.use({ viewport: { width: 1440, height: 1000 } });
test.skip(process.env.BKASH_STANDIN !== "1", "bKash journey: run with the API in bKash mode and BKASH_STANDIN=1");

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForURL("**/"); await expect(page.locator("header.shell-top")).toBeVisible();
  await page.getByRole("radio", { name: "EN", exact: true }).click();
  await page.getByRole("radio", { name: "0123", exact: true }).click();
}
const key = () => ({ "idempotency-key": crypto.randomUUID() });
/** A new synthetic patient's visit, signed by the E2E doctor (consultation only, ৳800). */
async function signedVisit(request: APIRequestContext, tag: string): Promise<{ id: string; token: string }> {
  await request.post("/api/v1/auth/login", { data: { identifier: DESK, password: "setu1234" } });
  const r = await request.post("/api/v1/patients", { headers: key(), data: {
    nameBn: "বিকাশ রোগী", nameEn: `Bkash ${tag} ${RUN}`, sex: "male", dobMode: "dob", dob: "07/07/1987", phone: `018${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
    phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
  } });
  expect(r.status(), await r.text()).toBe(201);
  const enc = ((await r.json()) as { encounter: { id: string; token: string } }).encounter;
  await request.post("/api/v1/auth/login", { data: { identifier: DOCTOR, password: "setu1234" } });
  const v = (await (await request.post(`/api/v1/encounters/${enc.id}/consultation/open`, { headers: key(), data: {} })).json()) as { draft: { id: string } };
  const saved = await request.put(`/api/v1/compositions/${v.draft.id}`, { headers: key(), data: {
    rev: 1, sections: { complaints: [{ text: "Back pain", duration: { n: 1, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [], orders: [],
  } });
  expect(saved.status(), await saved.text()).toBe(200);
  const s = await request.post(`/api/v1/compositions/${v.draft.id}/sign`, { headers: key(), data: { rev: ((await saved.json()) as { rev: number }).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false } });
  expect(s.status(), await s.text()).toBe(200);
  return enc;
}
async function toPayment(page: Page, token: string) {
  await page.goto("/m/bill/opd");
  await page.locator(`[data-bill-token="${token}"]`).click();
  await page.waitForURL(/\/m\/bill\/opd\?inv=/);
  await page.getByTestId("issue").click();
  await expect(page.getByTestId("invoice-number")).toHaveText(/^INV\/\d{2}\/\d{4,}$/);
  await page.getByTestId("take-payment").click();
  await page.waitForURL(/\/m\/bill\/pay\?inv=/);
  await page.getByRole("radio", { name: "bKash" }).click();
  await page.getByTestId("pay-submit").click();
  const bk = page.locator('[data-payment="bkash"]').last();
  await expect(bk).toHaveAttribute("data-status", "link-sent");
  return bk;
}
/** The patient's own phone (no session). */
async function phone(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  return { ctx, page: await ctx.newPage() };
}

test("K1: QR and short link → the patient pays on bKash's page → result page with the TrxID; the cashier's screen confirms by itself", async ({ page, request, browser }) => {
  test.setTimeout(150_000);
  const visit = await signedVisit(request, "K1");
  await login(page, CASHIER);
  const bk = await toPayment(page, visit.token);
  await expect(bk.getByTestId("pay-qr")).toBeVisible();
  await expect(bk).toContainText("Waiting for the patient to pay in bKash");
  const url = (await bk.getByTestId("pay-url").textContent())!.trim();
  expect(url).toMatch(/\/p\/[A-Z2-9]{10}$/);
  await expect.poll(() => bk.getByTestId("pay-qr").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0); // the QR image loaded

  const p = await phone(browser);
  try {
    await p.page.goto(url);
    await expect(p.page.getByTestId("standin-amount")).toHaveText("৳800.00");
    await p.page.getByTestId("standin-otp").fill("123456");
    await p.page.getByTestId("standin-pin").fill("12121");
    await p.page.getByTestId("standin-pay").click();
    await p.page.waitForURL(/\/pay\/result\?o=paid&c=/);
    await expect(p.page.locator('[data-screen="pay-result"]')).toHaveAttribute("data-outcome", "paid");
    await expect(p.page.getByTestId("pay-result-amount")).toHaveText("৳ 800");
    const trx = (await p.page.getByTestId("pay-result-trx").textContent())!.trim();
    expect(trx).toMatch(/^TRX/);
    expect(await p.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);

    await expect(bk).toHaveAttribute("data-status", "confirmed");
    await expect(bk.getByTestId("trx")).toContainText(trx);
    await expect(page.locator("[data-screen='bill/pay']")).toHaveAttribute("data-invoice-status", "balanced");
    // the short link after payment: the result page says paid
    await p.page.goto(url);
    await expect(p.page.locator('[data-screen="pay-result"]')).toHaveAttribute("data-outcome", "paid");
  } finally { await p.ctx.close(); }
});

test("K2: the patient closes bKash's page → not paid; a new link — the old one has ended — and the patient pays on it", async ({ page, request, browser }) => {
  test.setTimeout(150_000);
  const visit = await signedVisit(request, "K2");
  await login(page, CASHIER);
  const bk = await toPayment(page, visit.token);
  const oldUrl = (await bk.getByTestId("pay-url").textContent())!.trim();
  const p = await phone(browser);
  try {
    await p.page.goto(oldUrl);
    await p.page.getByTestId("standin-cancel").click();
    await p.page.waitForURL(/\/pay\/result/);
    await expect(p.page.locator('[data-screen="pay-result"]')).toHaveAttribute("data-outcome", "not-paid");
    await expect(p.page.getByTestId("pay-result")).toContainText("No money was taken from your bKash");

    await expect(bk).toHaveAttribute("data-status", "failed");
    await expect(bk.getByTestId("fail-reason")).toContainText("Not paid in bKash");
    await bk.getByRole("button", { name: /Resend|Retry|new link/i }).click();
    await expect(bk).toHaveAttribute("data-status", "link-sent");
    const newUrl = (await bk.getByTestId("pay-url").textContent())!.trim();
    expect(newUrl).not.toBe(oldUrl);

    await p.page.goto(oldUrl);
    await expect(p.page.locator('[data-screen="pay-result"]')).toHaveAttribute("data-outcome", "unknown"); // the old code is gone
    await p.page.goto(newUrl);
    await p.page.getByTestId("standin-otp").fill("123456");
    await p.page.getByTestId("standin-pin").fill("12121");
    await p.page.getByTestId("standin-pay").click();
    await expect(p.page.locator('[data-screen="pay-result"]')).toHaveAttribute("data-outcome", "paid");
    await expect(bk).toHaveAttribute("data-status", "confirmed");
  } finally { await p.ctx.close(); }
});
