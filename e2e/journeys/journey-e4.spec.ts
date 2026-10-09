import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
/* Journey E4 (ADR 0023) — another clinic's view of a patient's history, and a request for more:
   the patient was treated at the E2E clinic (diabetes, metformin for 30 days, a penicillin allergy, blood group O+) and
   now visits the E2E Lite hospital. With both records linked in the Setu app, the Lite doctor sees by policy the
   clinic's allergy, current medicine, active problem and blood group — each with facility, author, date and the
   provider-verified badge; asks for the prescriptions and visits with a reason; the patient (390 px) reads who asks,
   what for and why, and allows it; the doctor opens the share. Network sharing off hides the policy view. The visits,
   the bills that carry the app codes and the patient's sign-in go through the API; the decisions are made on screens. */
const PATIENT = process.env.PATIENT_URL ?? "http://localhost:3001";
const STAFF = process.env.STAFF_URL ?? "http://localhost:3000";
const DESK = "01799000001", DOCTOR = "01799000002", NURSE = "01799000004", CASHIER = "01799000008";
const LITE_DESK = "01798000001", LITE_DOCTOR = "01798000002", LITE_CASHIER = "01798000008";
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
async function staffPage(browser: Browser, phone: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: STAFF });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForURL("**/"); await expect(page.locator("header.shell-top")).toBeVisible();
  await page.getByRole("radio", { name: "EN", exact: true }).click();
  return { ctx, page };
}
/** a visit with a signed note; then the bill, paid, and its receipt — the Setu app code the receipt carries */
async function visitWithReceipt(request: APIRequestContext, who: { desk: string; doctor: string; cashier: string }, phone: string, run: string, note: { diagnoses: string[]; medications: object[] }, after?: (patientId: string, encounterId: string) => Promise<void>) {
  await as(request, who.desk);
  const reg = await post<{ patient: { id: string }; encounter: { id: string } }>(request, "/v1/patients", { nameBn: "হালিমা বেগম", nameEn: `Halima Begum ${run}`, sex: "female", dobMode: "dob", dob: "03/05/1968", phone, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true }, 201);
  await as(request, who.doctor);
  const open = await post<{ draft: { id: string } }>(request, `/v1/encounters/${reg.encounter.id}/consultation/open`, {});
  const saved = await request.put(`/api/v1/compositions/${open.draft.id}`, { headers: key(), data: {
    rev: 1, sections: { complaints: [{ text: "Follow-up", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: note.diagnoses.map((code) => ({ code, verificationStatus: "provisional" })), medications: note.medications, orders: [],
  } });
  expect(saved.status(), await saved.text()).toBe(200);
  if (after) await after(reg.patient.id, reg.encounter.id);
  await as(request, who.doctor);
  await post(request, `/v1/compositions/${open.draft.id}/sign`, { rev: ((await saved.json()) as { rev: number }).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });
  await as(request, who.cashier);
  const bill = await post<{ invoice: { id: string; rev: number; totalPaisa: number } }>(request, `/v1/encounters/${reg.encounter.id}/invoice`, {}, 201);
  await post(request, `/v1/invoices/${bill.invoice.id}/issue`, { rev: bill.invoice.rev });
  const shift = (await (await request.get("/api/v1/shifts/mine")).json()) as { shift: { status: string } | null };
  if (!shift.shift || shift.shift.status !== "open") await post(request, "/v1/shifts", { openingFloatPaisa: 100_000 }, 201);
  await post(request, `/v1/invoices/${bill.invoice.id}/payments`, { method: "cash", amountPaisa: bill.invoice.totalPaisa, tenderedPaisa: bill.invoice.totalPaisa }, 201);
  const rc = await post<{ receipt: { snapshot: { patient: { claimCode?: string } } } }>(request, `/v1/invoices/${bill.invoice.id}/receipts`, {}, 201);
  expect(rc.receipt.snapshot.patient.claimCode, "the app code on the receipt").toMatch(/^[23456789A-Z]{6}$/);
  return { patientId: reg.patient.id, code: rc.receipt.snapshot.patient.claimCode! };
}

test("@phone Journey E4: another clinic sees allergies, medicines, problems and blood group by policy; asks for more; the patient allows it", async ({ page, request, browser }) => {
  test.setTimeout(300_000);
  const run = Math.random().toString(36).slice(2, 7);
  const phone = `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  // the clinic: diabetes, metformin for 30 days, a penicillin allergy; the nurse records the blood group
  const clinic = await visitWithReceipt(request, { desk: DESK, doctor: DOCTOR, cashier: CASHIER }, phone, run,
    { diagnoses: ["5A11"], medications: [{ medicineKey: "comet", dose: "1+0+1", meal: "after", days: 30 }] },
    async (patientId, encounterId) => {
      await post(request, `/v1/patients/${patientId}/allergies`, { encounterId, kind: "class", key: "penicillin", reaction: "rash", severity: "moderate" }, 201);
      await as(request, NURSE);
      await post(request, `/v1/patients/${patientId}/blood-group`, { bloodGroup: "O+" });
    });
  // the Lite hospital: today's visit
  const lite = await visitWithReceipt(request, { desk: LITE_DESK, doctor: LITE_DOCTOR, cashier: LITE_CASHIER }, phone, run, { diagnoses: ["CA02"], medications: [] });

  // the patient signs in and links the clinic's record only (the API; journey D covers these screens)
  await page.request.post(`${PATIENT}/api/v1/patient/otp`, { data: { phone, lang: "bn" } });
  const otp = ((await (await page.request.get(`${PATIENT}/api/v1/dev/patient-otp?phone=${phone}`)).json()) as { code: string }).code;
  expect((await page.request.post(`${PATIENT}/api/v1/patient/sign-in`, { data: { phone, code: otp } })).ok()).toBe(true);
  const claims = (await (await page.request.get(`${PATIENT}/api/v1/patient/claims`)).json()) as { items: { id: string; facilityEn: string | null }[] };
  const prove = async (prefix: string, code: string) => {
    const c = claims.items.find((x) => x.facilityEn?.startsWith(prefix))!;
    expect((await page.request.post(`${PATIENT}/api/v1/patient/claims/${c.id}/proof`, { headers: key(), data: { method: "code", code } })).ok()).toBe(true);
  };
  await prove("E2E Test", clinic.code);

  // the Lite doctor: this record is not linked yet — nothing, never a match by the same phone
  const doc = await staffPage(browser, LITE_DOCTOR);
  await doc.page.goto(`/m/net/consent?patient=${lite.patientId}`);
  await expect(doc.page.getByTestId("nh-not-linked")).toBeVisible();
  await expect(doc.page.getByTestId("nh-allergies")).toHaveCount(0);

  // linked: by policy — the clinic's allergy, current medicine, active problem and blood group, with their source
  await prove("E2E Lite", lite.code);
  await doc.page.reload();
  await expect(doc.page.locator('[data-testid="nh-allergies"] [data-row="allergy"]')).toContainText(/penicillin/i);
  const med = doc.page.locator('[data-testid="nh-medicines"] [data-row="medicine"]');
  await expect(med).toContainText("Metformin");
  await expect(med).toContainText("E2E Test");
  await expect(med).toContainText("Dr. Test");
  await expect(med).toContainText("Provider-verified");
  await expect(doc.page.locator('[data-testid="nh-problems"] [data-row="problem"]')).toContainText("Type 2 diabetes");
  await expect(doc.page.locator('[data-testid="nh-blood"] [data-row="blood"]')).toContainText("O+");
  await expect(doc.page.locator('[data-testid="nh-blood"] [data-row="blood"]')).toContainText("Test Nurse");

  // request access: prescriptions and visits, for today's visit, with a reason the patient will read
  const req = doc.page.getByTestId("nh-request");
  await expect(req.getByTestId("nh-send")).toBeDisabled();
  await req.locator('input[data-kind="prescriptions"]').check();
  await req.locator('input[data-kind="visits"]').check();
  await req.getByTestId("nh-reason").fill("Chest pain today; need her earlier treatment");
  await req.getByTestId("nh-send").click();
  await expect(req.locator('[data-testid="nh-request-row"]').first()).toHaveAttribute("data-state", "sent");
  await expect(req.getByTestId("nh-send")).toHaveCount(0);

  // the patient (390 px): turns network sharing off — the doctor sees nothing by policy; on again
  await page.goto(`${PATIENT}/share?tab=requests`);
  const sw = page.getByRole("switch");
  await expect(page.locator("[data-network-sharing]")).toHaveAttribute("data-network-sharing", "on");
  await sw.click();
  await expect(page.locator("[data-network-sharing]")).toHaveAttribute("data-network-sharing", "off");
  await doc.page.reload();
  await expect(doc.page.getByTestId("nh-sharing-off")).toBeVisible();
  await expect(doc.page.getByTestId("nh-allergies")).toHaveCount(0);
  await sw.click();
  await expect(page.locator("[data-network-sharing]")).toHaveAttribute("data-network-sharing", "on");

  // the request: who asks, from where, what, how long and why — allowed
  const card = page.locator('section[data-request]').first();
  await expect(card).toHaveAttribute("data-request", "sent");
  await expect(card).toContainText("ডা. লাইট ইমার্জেন্সি");
  await expect(card).toContainText("প্রেসক্রিপশন");
  await expect(card).toContainText("Chest pain today; need her earlier treatment");
  await card.locator('[data-answer="approve"]').click();
  await expect(card).toHaveAttribute("data-request", "granted");
  await page.getByRole("tab", { name: "চালু শেয়ার" }).click();
  await expect(page.locator('section[data-share="active"]').first()).toContainText("ডা. লাইট ইমার্জেন্সি");

  // the doctor: allowed → the share opens with the clinic's prescription
  await doc.page.reload();
  await expect(doc.page.locator('[data-testid="nh-request-row"]').first()).toHaveAttribute("data-state", "granted");
  await doc.page.getByTestId("nh-open-shared").first().click();
  const rx = doc.page.locator('[data-testid="shared-record"][data-kind="prescription"]').filter({ hasText: "E2E Test" });
  await expect(rx.first()).toBeVisible();
  await expect(doc.page.locator('[data-testid="shared-record"][data-kind="report"]')).toHaveCount(0);
  await doc.ctx.close();
});
