import { expect, test, type APIRequestContext } from "@playwright/test";
/* Journey D1–D3 (ADR 0020) — the patient app at 390 px: sign in with an SMS code, claim the clinic's records with the
   code printed on the receipt (not the sister's on the same phone), say "not mine" to another facility, then read the
   history. The staff side runs through the API in the E2E Test Clinic and the E2E Lite Hospital; the patient side is
   the real patient app (PATIENT_URL), which proxies /api to the same API. The SMS code is read from the dev route of
   the fake SMS gateway — never present with a real gateway. */
const PATIENT = process.env.PATIENT_URL ?? "http://localhost:3001";
const DESK = "01799000001", DOCTOR = "01799000002", CASHIER = "01799000008", LITE_DESK = "01798000001";
const key = () => ({ "idempotency-key": crypto.randomUUID() });
async function as(request: APIRequestContext, phone: string) {
  const r = await request.post("/api/v1/auth/login", { data: { identifier: phone, password: "setu1234" } });
  expect(r.ok(), await r.text()).toBe(true);
}
async function post<T = Record<string, unknown>>(request: APIRequestContext, url: string, data: object, status = 200): Promise<T> {
  const r = await request.post("/api" + url, { headers: key(), data });
  expect(r.status(), `${url}: ${await r.text()}`).toBe(status);
  return (await r.json()) as T;
}

test("@phone Journey D1–D3: sign in, claim the clinic's records with the receipt code, read the history", async ({ page, request }) => {
  test.setTimeout(180_000);
  const run = Math.random().toString(36).slice(2, 7);
  const phone = `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const reg = (nameBn: string, nameEn: string, visit: boolean) => post<{ patient: { id: string }; encounter?: { id: string } }>(request, "/v1/patients", {
    nameBn, nameEn: `${nameEn} ${run}`, sex: "female", dobMode: "dob", dob: "12/02/1979", phone, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: visit,
  }, 201);

  // Staff side: Rahima and her sister share one phone at the E2E clinic; Rahima's visit ends with a signed prescription
  // and a paid bill — the receipt carries her Setu app code. The Lite hospital has a third record on the same phone.
  await as(request, DESK);
  const rahima = await reg("রহিমা খাতুন", "Rahima Khatun", true);
  await reg("সুমাইয়া আক্তার", "Sumaiya Akter", true);
  const enc = rahima.encounter!.id;
  await as(request, DOCTOR);
  const open = await post<{ draft: { id: string } }>(request, `/v1/encounters/${enc}/consultation/open`, {});
  const saved = await request.put(`/api/v1/compositions/${open.draft.id}`, { headers: key(), data: {
    rev: 1, sections: { complaints: [{ text: "Fever", duration: { n: 3, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }], orders: [],
  } });
  expect(saved.status(), await saved.text()).toBe(200);
  await post(request, `/v1/compositions/${open.draft.id}/sign`, { rev: ((await saved.json()) as { rev: number }).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });
  await as(request, CASHIER);
  const bill = await post<{ invoice: { id: string; rev: number; totalPaisa: number } }>(request, `/v1/encounters/${enc}/invoice`, {}, 201);
  await post(request, `/v1/invoices/${bill.invoice.id}/issue`, { rev: bill.invoice.rev });
  await post(request, `/v1/invoices/${bill.invoice.id}/payments`, { method: "cash", amountPaisa: bill.invoice.totalPaisa, tenderedPaisa: bill.invoice.totalPaisa }, 201);
  const rc = await post<{ receipt: { snapshot: { patient: { claimCode?: string } } } }>(request, `/v1/invoices/${bill.invoice.id}/receipts`, {}, 201);
  const code = rc.receipt.snapshot.patient.claimCode!;
  expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  await as(request, LITE_DESK);
  await reg("রহিমা খাতুন", "Rahima Khatun", false);

  // D1 — welcome: Bangla, the phone, the SMS code, then the three privacy points marked draft
  await page.goto(PATIENT + "/");
  await page.waitForURL("**/welcome");
  await page.getByRole("button", { name: "বাংলা", exact: true }).click();
  await page.getByLabel("আপনার মোবাইল নম্বর", { exact: true }).fill(phone);
  await page.getByRole("button", { name: "কোড পাঠান" }).click();
  await expect(page.getByText("SMS-এ ৬ সংখ্যার কোড পাঠানো হয়েছে")).toBeVisible();
  const otp = await request.get(`${PATIENT}/api/v1/dev/patient-otp?phone=${phone}`);
  expect(otp.ok(), await otp.text()).toBe(true);
  const sms = ((await otp.json()) as { code: string }).code;
  // a wrong code first: refused, the field is cleared
  await page.getByLabel("OTP").fill(String((Number(sms) % 899_999) + 100_001));
  await page.getByRole("button", { name: "এগিয়ে যান" }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await page.getByLabel("OTP").fill(sms);
  await page.getByRole("button", { name: "এগিয়ে যান" }).click();
  await expect(page.getByRole("heading", { name: "আপনার তথ্য, আপনার নিয়ন্ত্রণে" })).toBeVisible();
  await expect(page.getByText("খসড়া — আইনজীবীর চূড়ান্ত শর্ত আসছে")).toBeVisible();
  for (const p of ["আপনার রেকর্ড শুধু আপনার", "আপনি অনুমতি দিলে তবেই শেয়ার", "কে দেখেছে, সব জানবেন"]) await expect(page.getByText(p)).toBeVisible();
  await page.getByRole("button", { name: "বুঝেছি, এগিয়ে যান" }).click();

  // D2 — nothing linked yet, records to claim → the claim screen: the facility and the month only, never a name
  await page.waitForURL("**/claim");
  await expect(page.getByRole("heading", { name: "কিছু রেকর্ড পাওয়া গেছে যা আপনার হতে পারে" })).toBeVisible();
  const clinic = page.getByRole("region", { name: /ই২ই .*ক্লিনিক/ });
  const lite = page.getByRole("region", { name: /ই২ই লাইট হাসপাতাল/ });
  await expect(clinic).toBeVisible();
  await expect(lite).toBeVisible();
  await expect(clinic.getByText(/^ভিজিট: \S+ ২০২৬$/)).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/রহিমা|সুমাইয়া|Rahima|Sumaiya|Napa/);
  // the Lite hospital's record is not hers: closed, and the clinic is told (its audit)
  await lite.getByRole("button", { name: "আমার না" }).click();
  await expect(lite.getByText("ঠিক আছে — এটি আপনার প্রোফাইলে যোগ হবে না। ক্লিনিককে জানানো হয়েছে।")).toBeVisible();
  // the clinic's: "this is mine", a wrong code counts down, the code on her receipt links it
  await clinic.getByRole("button", { name: "এটা আমার" }).click();
  await expect(clinic.getByText("৩ বার ভুল হলে নিরাপত্তার জন্য ২৪ ঘণ্টা বন্ধ থাকবে।")).toBeVisible();
  const box = clinic.getByLabel("Setu অ্যাপ কোড");
  await box.fill((code.startsWith("2") ? "3" : "2") + code.slice(1));
  await clinic.getByRole("button", { name: "যাচাই করুন" }).click();
  await expect(clinic.getByRole("alert")).toHaveText("কোড মেলেনি — আরও ২ বার চেষ্টা করা যাবে");
  await box.fill(code.toLowerCase());
  await clinic.getByRole("button", { name: "যাচাই করুন" }).click();
  await expect(clinic.getByText("যুক্ত", { exact: true })).toBeVisible();
  await expect(clinic.getByText("এই ক্লিনিকের রেকর্ড আপনার ইতিহাসে যুক্ত হয়েছে।")).toBeVisible();

  // D3 — the history: her visit and the signed prescription, provider-verified; the filters narrow it
  await page.getByRole("link", { name: "ইতিহাস দেখুন" }).click();
  await page.waitForURL("**/timeline");
  await expect(page.getByRole("heading", { name: "চিকিৎসার ইতিহাস" })).toBeVisible();
  const items = page.locator("article.pa-item");
  await expect(items.filter({ hasText: "প্রেসক্রিপশন" })).toHaveCount(1);
  await expect(items.filter({ hasText: "ভিজিট · বহির্বিভাগ" })).toHaveCount(1);
  await expect(items.first().getByText("ডাক্তার/ল্যাব যাচাইকৃত")).toBeVisible();
  await page.getByRole("button", { name: "প্রেসক্রিপশন", exact: true }).click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toHaveAttribute("data-kind", "prescription");
  await page.getByRole("button", { name: "আমার দেওয়া", exact: true }).click();
  await expect(page.getByText("আপলোড পরের ধাপে আসছে।")).toBeVisible();
  // English on the same screen
  await page.getByRole("button", { name: "ভাষা · Language" }).click();
  await expect(page.getByRole("heading", { name: "Medical history" })).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(items.filter({ hasText: "Prescription" })).toHaveCount(1);
  // nothing scrolls sideways at 390 px
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // sign-out ends the session: the app goes back to the welcome screens and the API refuses the history
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/welcome");
  expect((await page.request.get(`${PATIENT}/api/v1/patient/timeline`)).status()).toBe(401);
});
