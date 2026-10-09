import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
/* Journey D1–D6 (ADR 0020, 0021) — the patient app at 390 px: sign in with an SMS code, claim the clinic's records with
   the code printed on the receipt (not the sister's on the same phone), say "not mine" to another facility, read the
   history; open a lab report in plain language (a critical result: only "contact the facility now" with its phone),
   share it for 30 days with a doctor at another network facility, who opens it in the staff app; the patient sees who
   opened it, stops sharing, and the doctor's next look is refused. The staff side runs through the API in the E2E Test
   Clinic and the E2E Lite Hospital; the patient side is the real patient app (PATIENT_URL), which proxies /api to the
   same API. The SMS code is read from the dev route of the fake SMS gateway — never present with a real gateway. */
const PATIENT = process.env.PATIENT_URL ?? "http://localhost:3001";
const DESK = "01799000001", DOCTOR = "01799000002", TECH = "01799000005", PATH = "01799000006", CASHIER = "01799000008", LITE_DESK = "01798000001", LITE_DOCTOR = "01798000002";
const STAFF = process.env.STAFF_URL ?? "http://localhost:3000";
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

type LV = { orders: { id: string; testCode: string; results: { id: string; flag: string | null }[] }[]; release: { observationIds: string[] }; reports: { id: string }[] };
const get = async <T,>(request: APIRequestContext, url: string): Promise<T> => { const r = await request.get("/api" + url); expect(r.ok(), await r.text()).toBe(true); return (await r.json()) as T; };
/** a visit whose lab tests are ordered, entered, verified (critical ones called back), validated, released and sent to the app */
async function labVisit(request: APIRequestContext, patientId: string, values: Record<string, [string, string, string?][]>) {
  await as(request, DESK);
  const enc = (await post<{ encounter: { id: string } }>(request, "/v1/encounters", { patientId }, 201)).encounter.id;
  await as(request, DOCTOR);
  const open = await post<{ draft: { id: string } }>(request, `/v1/encounters/${enc}/consultation/open`, {});
  const saved = await request.put(`/api/v1/compositions/${open.draft.id}`, { headers: key(), data: {
    rev: 1, sections: { complaints: [{ text: "Thirst", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [], orders: Object.keys(values).map((testCode) => ({ testCode, priority: "routine" })),
  } });
  expect(saved.status(), await saved.text()).toBe(200);
  await post(request, `/v1/compositions/${open.draft.id}/sign`, { rev: ((await saved.json()) as { rev: number }).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });
  await as(request, TECH);
  const lab = await post<{ specimens: { id: string; status: string }[] }>(request, `/v1/lab/visits/${enc}/labels`, {});
  for (const sp of lab.specimens.filter((x) => x.status === "pending")) for (const step of ["collect", "receive", "start"]) await post(request, `/v1/lab/specimens/${sp.id}/${step}`, { at: new Date().toISOString() });
  let v = await get<LV>(request, `/v1/lab/visits/${enc}`);
  for (const o of v.orders) await post(request, `/v1/lab/orders/${o.id}/results`, { entries: values[o.testCode]!.map(([analyteCode, value, confirm]) => ({ analyteCode, value, ...(confirm ? { confirm } : {}) })) }, 201);
  v = await get<LV>(request, `/v1/lab/visits/${enc}`);
  v = await post<LV>(request, `/v1/lab/visits/${enc}/verify`, { pin: "1234", observationIds: v.orders.flatMap((o) => o.results.map((x) => x.id)), deltaChecked: true });
  for (const r of v.orders.flatMap((o) => o.results).filter((x) => x.flag === "HH" || x.flag === "LL"))
    await post(request, `/v1/lab/observations/${r.id}/callbacks`, { outcome: "reached", recipientRole: "ordering-doctor", recipientName: "Dr. Test", via: "phone", calledAt: new Date().toISOString(), readBack: true }, 201);
  await as(request, PATH);
  v = await post<LV>(request, `/v1/lab/visits/${enc}/validate`, { pin: "1234", observationIds: v.orders.flatMap((o) => o.results.map((x) => x.id)) });
  v = await post<LV>(request, `/v1/lab/visits/${enc}/release`, { observationIds: v.release.observationIds }, 201);
  await as(request, TECH);
  const rep = v.reports.at(-1)!.id;
  await post(request, `/v1/lab/reports/${rep}/send`, { channel: "patient-app" });
  return rep;
}
/** the receiving doctor in the staff app (its own browser context: the patient's stays signed in) */
async function staffPage(browser: Browser, phone: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: STAFF });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForURL("**/"); await expect(page.locator("header.shell-top")).toBeVisible();
  return { ctx, page };
}

test("@phone Journey D1–D6: sign in, claim with the receipt code, the history, a report in plain language, share it, who opened it, stop sharing", async ({ page, request, browser }) => {
  test.setTimeout(300_000);
  const run = Math.random().toString(36).slice(2, 7);
  const phone = `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const reg = (nameBn: string, nameEn: string, visit: boolean) => post<{ patient: { id: string }; encounter?: { id: string } }>(request, "/v1/patients", {
    nameBn, nameEn: `${nameEn} ${run}`, sex: "female", dobMode: "dob", dob: "12/02/1979", phone, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: visit,
  }, 201);

  // Staff side: Rahima and her sister share one phone at the E2E clinic; Rahima's visit ends with a signed prescription
  // and a paid bill — the receipt carries her Setu app code. The Lite hospital has a third record on the same phone.
  await as(request, DESK);
  const rahima = await reg("নাসরিন আক্তার", "Nasrin Akter", true);
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
  // two HbA1c results for the trend; the later visit also has the walkthrough's critical potassium
  await labVisit(request, rahima.patient.id, { hba1c: [["hba1c", "6.8"]] });
  const report = await labVisit(request, rahima.patient.id, { hba1c: [["hba1c", "7.4"]], elec: [["na", "138"], ["k", "6.9", "6.9"], ["cl", "101"]] });
  await as(request, LITE_DESK);
  await reg("নাসরিন আক্তার", "Nasrin Akter", false);

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
  const items = page.locator("main .pa-item");
  await expect(items.filter({ hasText: "প্রেসক্রিপশন" })).toHaveCount(3);
  await expect(items.filter({ hasText: "ল্যাব রিপোর্ট" })).toHaveCount(2);
  await expect(items.first().getByText("ডাক্তার/ল্যাব যাচাইকৃত")).toBeVisible();
  // the facility's "now in the app" notices: both reports are new
  await expect(items.filter({ hasText: "ল্যাব রিপোর্ট" }).filter({ hasText: "নতুন" })).toHaveCount(2);
  await page.getByRole("button", { name: "প্রেসক্রিপশন", exact: true }).click();
  await expect(items).toHaveCount(3);
  await expect(items.first()).toHaveAttribute("data-kind", "prescription");
  await page.getByRole("button", { name: "আমার দেওয়া", exact: true }).click();
  await expect(page.getByText("আপলোড পরের ধাপে আসছে।")).toBeVisible();
  // English on the same screen
  await page.getByRole("button", { name: "ভাষা · Language" }).click();
  await expect(page.getByRole("heading", { name: "Medical history" })).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(items.filter({ hasText: "Prescription" })).toHaveCount(3);
  // nothing scrolls sideways at 390 px
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "ভাষা · Language" }).click();
  await expect(page.getByRole("heading", { name: "চিকিৎসার ইতিহাস" })).toBeVisible();

  // D4 — the newest report: not a diagnosis; HbA1c high with a draft explanation and its trend; the critical potassium
  // shows only "contact the facility now" and the facility's phone
  await page.locator(`a.pa-item[href*="${report}"]`).click();
  await page.waitForURL(`**/report/**/${report}`);
  await expect(page.getByText("এটি রোগ নির্ণয় নয় — ফলাফল নিয়ে আপনার ডাক্তারের সাথে কথা বলুন।")).toBeVisible();
  const hba1c = page.locator('[data-analyte="hba1c"]');
  await expect(hba1c.getByText("বেশি", { exact: true })).toBeVisible();
  await expect(hba1c.getByText(/গত ২–৩ মাসে রক্তে চিনির গড়/)).toBeVisible();
  await expect(hba1c.locator("[data-draft]")).toBeVisible();
  await expect(hba1c.locator("figure li")).toHaveCount(2);
  const k = page.locator('[data-analyte="k"]');
  await expect(k.getByText("খুব বেশি", { exact: true })).toBeVisible();
  await expect(k.getByRole("alert")).toContainText("এখনই আপনার ডাক্তার বা প্রতিষ্ঠানের সাথে যোগাযোগ করুন");
  await expect(k.getByRole("link", { name: /কল করুন/ })).toHaveAttribute("href", "tel:01700000103");
  await expect(k.locator("[data-draft]")).toHaveCount(0);
  await expect(k.locator("figure")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("tab", { name: "মূল PDF" }).click();
  const pdfHref = await page.getByRole("link", { name: "PDF খুলুন" }).getAttribute("href");
  const pdf = await page.request.get(`${PATIENT}${pdfHref}`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");

  // D5 — share this report with Dr. Lite Emergency at the E2E Lite Hospital (another network facility), 30 days
  await page.getByRole("link", { name: "শেয়ার করুন" }).click();
  await page.waitForURL("**/share?**");
  await expect(page.getByRole("radio", { name: "একটি রিপোর্ট" })).toBeChecked();
  await page.locator('select[name="facility"]').selectOption({ label: "ই২ই লাইট হাসপাতাল" });
  await page.locator('select[name="doctor"]').selectOption({ label: "ডা. লাইট ইমার্জেন্সি" });
  await expect(page.getByRole("radio", { name: "৩০ দিন" })).toBeChecked();
  await page.getByRole("button", { name: "শেয়ার করুন", exact: true }).click();
  const card = page.locator("section[data-share]").first();
  await expect(card).toHaveAttribute("data-share", "active");
  await expect(card.getByText("এখনো কেউ খোলেননি")).toBeVisible();

  // the receiving doctor opens it in the staff app: exactly that report, no earlier results (a one-report share)
  const doc = await staffPage(browser, LITE_DOCTOR);
  await doc.page.goto("/m/net/shared");
  // English names: this run's patient is told apart from earlier runs' (their shares may still be running)
  await doc.page.getByRole("radio", { name: "EN", exact: true }).click();
  await doc.page.locator('[data-testid="shared-item"]').filter({ hasText: `Nasrin Akter ${run}` }).getByRole("button").click();
  await expect(doc.page.locator('[data-testid="shared-record"]')).toHaveCount(1);
  await doc.page.locator('[data-testid="shared-record"]').getByRole("button").click();
  const table = doc.page.locator('[data-testid="shared-report"]');
  await expect(table.locator('tr[data-analyte="k"]')).toContainText("HH");
  await expect(table.locator('tr[data-analyte="hba1c"] td').last()).toHaveText("—");

  // the patient sees who opened it; who viewed lists the shared look and the clinic's own staff
  await page.reload();
  await page.getByRole("tab", { name: "চালু শেয়ার" }).click();
  await expect(card.getByText(/ডা\. লাইট ইমার্জেন্সি/).first()).toBeVisible();
  await page.getByRole("tab", { name: "কে দেখেছে" }).click();
  await expect(page.locator('[data-access="shared"]').first()).toContainText("ই২ই লাইট হাসপাতাল");
  await expect(page.locator('[data-access="view"]').first()).toBeVisible();

  // D6 — stop sharing in two taps; the doctor's next look is refused
  await page.getByRole("tab", { name: "চালু শেয়ার" }).click();
  await card.getByRole("button", { name: "শেয়ার বন্ধ করুন" }).click();
  await card.getByRole("button", { name: "নিশ্চিত — এখনই বন্ধ করুন" }).click();
  await expect(card).toHaveAttribute("data-share", "revoked");
  await expect(card.getByText(/^বন্ধ · /)).toBeVisible();
  await doc.page.getByRole("button", { name: /Back|ফিরে যান/ }).click();
  await doc.page.locator('[data-testid="shared-record"]').getByRole("button").click();
  await expect(doc.page.getByRole("alert").filter({ hasText: /The patient stopped sharing|রোগী শেয়ার বন্ধ করেছেন/ })).toBeVisible();
  await doc.ctx.close();

  // sign-out ends the session: the app goes back to the welcome screens and the API refuses the history
  await page.getByRole("button", { name: "সাইন আউট" }).click();
  await page.waitForURL("**/welcome");
  expect((await page.request.get(`${PATIENT}/api/v1/patient/timeline`)).status()).toBe(401);
});
