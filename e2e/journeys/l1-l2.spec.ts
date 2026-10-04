import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
/* Journey L — SMS through BulkSMSBD (ADR 0012) on the real stack against the local stand-ins (BulkSMSBD on :4198, bKash
   on :4199), E2E clinics. Runs only with the API in stand-in mode (SMS_PROVIDER=bulksmsbd + PAYMENTS_PROVIDER=bkash)
   and SMS_STANDIN=1 BKASH_STANDIN=1; the default suite runs on the fakes.
   L1 a bKash link goes to the patient by SMS — the Pay screen says "sent (delivery not confirmed)", never delivered;
      the patient opens the link from the SMS and pays.
   L2 the admin's test SMS: the gateway only accepts it, so the checklist waits until the admin confirms it arrived. */
const INBOX = process.env.SMS_INBOX ?? "http://127.0.0.1:4198/inbox";
test.skip(process.env.SMS_STANDIN !== "1" || process.env.BKASH_STANDIN !== "1", "SMS journey: run with the API on the stand-ins and SMS_STANDIN=1 BKASH_STANDIN=1");
const DESK = "01799000001", DOCTOR = "01799000002", CASHIER = "01799000008";
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
/** A new synthetic patient's visit, signed by the E2E doctor (consultation only, ৳800). */
async function signedVisit(request: APIRequestContext, tag: string, phone: string): Promise<{ id: string; token: string }> {
  await request.post("/api/v1/auth/login", { data: { identifier: DESK, password: "setu1234" } });
  const r = await request.post("/api/v1/patients", { headers: key(), data: {
    nameBn: "বিকাশ রোগী", nameEn: `Bkash ${tag} ${RUN}`, sex: "male", dobMode: "dob", dob: "07/07/1987", phone,
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
async function phone_(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  return { ctx, page: await ctx.newPage() };
}


test("L1: the payment link goes by SMS ('sent', never 'delivered'); the patient pays from the SMS", async ({ page, request, browser }) => {
  test.setTimeout(150_000);
  const phone = `016${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const visit = await signedVisit(request, "L1", phone);
  await login(page, CASHIER);
  const bk = await toPayment(page, visit.token);
  await expect(bk.getByTestId("link-sms")).toHaveAttribute("data-sms-status", "completed");
  await expect(bk.getByTestId("link-sms")).toContainText(`…${phone.slice(-4)}: sent (delivery not confirmed)`);
  await expect(bk.getByTestId("link-sms")).not.toContainText("delivered:");
  const p = await phone_(browser);
  try {
    await p.page.goto(`${INBOX}?n=${phone}`);
    const sms = p.page.getByTestId("sms").first();
    await expect(sms).toContainText("Tk 800 by bKash");
    await expect(sms).not.toContainText(`Bkash L1`); // never the patient's name
    await sms.getByTestId("sms-link").click();
    await p.page.getByTestId("standin-otp").fill("123456");
    await p.page.getByTestId("standin-pin").fill("12121");
    await p.page.getByTestId("standin-pay").click();
    await expect(p.page.locator('[data-screen="pay-result"]')).toHaveAttribute("data-outcome", "paid");
    await expect(bk).toHaveAttribute("data-status", "confirmed");
  } finally { await p.ctx.close(); }
});

test("L2: the admin's test SMS waits for 'it arrived' before the checklist counts it", async ({ page, browser }) => {
  await login(page, "01799000011");
  await page.goto("/m/adm/wizard");
  const item = page.locator('[data-testid="checklist"] [data-item="test_sms"]');
  const phone = `015${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  await page.getByTestId("sms-phone").fill(phone);
  await page.getByTestId("sms-send").click();
  await expect(page.getByTestId("sms-confirm-box")).toContainText("cannot tell whether it arrived");
  await expect(item).toHaveAttribute("data-done", "0");
  const p = await phone_(browser);
  try {
    await p.page.goto(`${INBOX}?n=${phone}`);
    await expect(p.page.getByTestId("sms").first()).toContainText("Setu test message");
  } finally { await p.ctx.close(); }
  await page.getByTestId("sms-arrived").click();
  await expect(item).toHaveAttribute("data-done", "1");
  await expect(page.getByTestId("sms-confirm-box")).toHaveCount(0);
});
