import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
/* Journey E1–E2 (ADR 0022) — the portable lab order across three facilities and the patient app:
   the E2E clinic's doctor orders CBC, HbA1c and USG for "a network centre the patient picks"; the patient (390 px) sees
   the centres and chooses the E2E Lite Hospital with home collection (it does not do USG); the Lite technologist
   accepts CBC and declines HbA1c with a reason (USG goes back as not offered there); the doctor's inbox shows the
   declines and opens the order, where the doctor re-orders them elsewhere; the clinic's desk chooses Green Life for the
   patient (who has the app, but the desk can); the patient sees both outcomes. The order and the patient's sign-in are
   made through the API; every decision is made on the screens. */
const PATIENT = process.env.PATIENT_URL ?? "http://localhost:3001";
const STAFF = process.env.STAFF_URL ?? "http://localhost:3000";
const DESK = "01799000001", DOCTOR = "01799000002", CASHIER = "01799000008", LITE_TECH = "01798000006";
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

test("@phone Journey E1–E2: a portable lab order — the patient picks a centre, the centre accepts part, the doctor re-orders, the desk picks for the patient", async ({ page, request, browser }) => {
  test.setTimeout(300_000);
  const run = Math.random().toString(36).slice(2, 7);
  const phone = `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  // the doctor's order: three tests at a network centre the patient picks, RBS here
  await as(request, DESK);
  const reg = await post<{ patient: { id: string }; encounter: { id: string } }>(request, "/v1/patients", { nameBn: "নাসরিন আক্তার", nameEn: `Nasrin Akter ${run}`, sex: "female", dobMode: "dob", dob: "12/02/1979", phone, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true }, 201);
  await as(request, DOCTOR);
  const open = await post<{ draft: { id: string } }>(request, `/v1/encounters/${reg.encounter.id}/consultation/open`, {});
  const saved = await request.put(`/api/v1/compositions/${open.draft.id}`, { headers: key(), data: {
    rev: 1, sections: { complaints: [{ text: "Thirst", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [],
    orders: [{ testCode: "cbc", priority: "routine", performer: "network" }, { testCode: "hba1c", priority: "routine", performer: "network" }, { testCode: "usgwa", priority: "routine", performer: "network" }, { testCode: "rbs", priority: "routine" }],
  } });
  expect(saved.status(), await saved.text()).toBe(200);
  await post(request, `/v1/compositions/${open.draft.id}/sign`, { rev: ((await saved.json()) as { rev: number }).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });
  const orders = (await (await request.get(`/api/v1/portable-orders?patientId=${reg.patient.id}`)).json()) as { items: { id: string; number: string }[] };
  const number = orders.items[0]!.number;

  // the patient signs in and links the clinic's record (the API; journey D covers these screens)
  await page.request.post(`${PATIENT}/api/v1/patient/otp`, { data: { phone, lang: "bn" } });
  const otp = ((await (await page.request.get(`${PATIENT}/api/v1/dev/patient-otp?phone=${phone}`)).json()) as { code: string }).code;
  expect((await page.request.post(`${PATIENT}/api/v1/patient/sign-in`, { data: { phone, code: otp } })).ok()).toBe(true);
  const claims = (await (await page.request.get(`${PATIENT}/api/v1/patient/claims`)).json()) as { items: { id: string; facilityEn: string | null }[] };
  const claim = claims.items.find((c) => c.facilityEn?.startsWith("E2E Test"))!;
  // the code the patient holds: on the receipt of this visit's bill — which carries the RBS done here, never a network test
  await as(request, CASHIER);
  const bill = await post<{ invoice: { id: string; rev: number; totalPaisa: number }; lines: { nameEn: string }[] }>(request, `/v1/encounters/${reg.encounter.id}/invoice`, {}, 201);
  expect(bill.lines.map((l) => l.nameEn).filter((n) => /CBC|HbA1c|USG/.test(n))).toEqual([]);
  expect(bill.lines.some((l) => l.nameEn === "RBS")).toBe(true);
  await post(request, `/v1/invoices/${bill.invoice.id}/issue`, { rev: bill.invoice.rev });
  await post(request, `/v1/invoices/${bill.invoice.id}/payments`, { method: "cash", amountPaisa: bill.invoice.totalPaisa, tenderedPaisa: bill.invoice.totalPaisa }, 201);
  const rc = await post<{ receipt: { snapshot: { patient: { claimCode?: string } } } }>(request, `/v1/invoices/${bill.invoice.id}/receipts`, {}, 201);
  const receiptCode = rc.receipt.snapshot.patient.claimCode ?? null;
  expect(receiptCode, "the app code printed on the receipt").toMatch(/^[23456789A-Z]{6}$/);
  expect((await page.request.post(`${PATIENT}/api/v1/patient/claims/${claim.id}/proof`, { headers: key(), data: { method: "code", code: receiptCode } })).ok()).toBe(true);

  // E1 — the patient's tests: home collection → only the Lite hospital (2 of 3 tests, USG not offered); choose it
  await page.goto(`${PATIENT}/tests`);
  const card = page.locator(`section[aria-label="${number}"]`);
  await expect(card).toHaveAttribute("data-portable", "active");
  await expect(card.locator("[data-item]")).toHaveCount(3);
  await card.getByRole("radio", { name: "বাড়ি থেকে নমুনা" }).click();
  const lite = card.locator('[data-centre="o_e2e_lite"]');
  await expect(lite).toContainText("৩টির মধ্যে ২টি");
  await expect(lite).toContainText("USG whole abdomen");
  await expect(card.locator("[data-centre]")).toHaveCount(1);
  await lite.getByRole("button", { name: "এই কেন্দ্র বাছুন" }).click();
  await expect(card).toHaveAttribute("data-portable", "centre-chosen");
  await expect(card).toContainText("ই২ই লাইট হাসপাতাল");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // E2 — the Lite technologist: accept CBC, decline HbA1c with a reason; USG goes back as not offered here
  const tech = await staffPage(browser, LITE_TECH);
  await tech.page.goto("/m/net/lab");
  await tech.page.getByRole("radio", { name: "For this facility" }).click();
  await tech.page.locator(`[data-testid="portable-item"][data-number="${number}"]`).getByRole("button").click();
  const decide = tech.page.locator('[data-testid="po-decide"]');
  await decide.locator('[data-decide="hba1c"]').getByRole("radio", { name: "Decline" }).click();
  await decide.locator('[data-decide="hba1c"]').getByRole("textbox").fill("Analyser for HbA1c under repair this week");
  await expect(decide).toContainText("USG whole abdomen");
  await decide.getByRole("button", { name: "Send the decision" }).click();
  await expect(tech.page.locator('[data-testid="portable-detail"]')).toHaveAttribute("data-status", "partially-accepted");
  await expect(tech.page.locator('tr[data-item="cbc"]')).toHaveAttribute("data-status", "accepted");
  await tech.ctx.close();

  // the ordering doctor: the inbox names the declined tests; the order opens; re-order them elsewhere
  const doc = await staffPage(browser, DOCTOR);
  await doc.page.goto("/m/doc/inbox");
  const declined = doc.page.locator('[data-testid="portable-declined"]').filter({ hasText: "HbA1c" }).filter({ hasText: "Analyser for HbA1c under repair this week" });
  await expect(declined.first()).toBeVisible();
  await declined.first().getByTestId("open-portable").click();
  // the first open of a screen compiles it on the dev server (a production build has no such wait)
  await expect(doc.page.locator('[data-testid="portable-detail"]')).toHaveAttribute("data-status", "partially-accepted", { timeout: 30_000 });
  await doc.page.getByTestId("po-reorder").click();
  await expect(doc.page.locator('[data-testid="portable-detail"]')).toHaveAttribute("data-status", "active");
  await expect(doc.page.locator("tr[data-item]")).toHaveCount(2);
  const second = (await doc.page.locator('[data-testid="portable-detail"] b.num').first().textContent())!.trim();
  await doc.ctx.close();

  // the clinic's desk chooses for the patient: Green Life (offers both), at the centre
  const desk = await staffPage(browser, DESK);
  await desk.page.goto("/m/net/lab");
  await desk.page.locator(`[data-testid="portable-item"][data-number="${second}"]`).getByRole("button").click();
  await desk.page.locator('[data-testid="po-choose"] [data-centre="o_greenlife_mirpur"]').getByRole("button", { name: "Choose" }).click();
  await expect(desk.page.locator('[data-testid="portable-detail"]')).toHaveAttribute("data-status", "centre-chosen");
  await expect(desk.page.locator('[data-testid="portable-detail"]')).toContainText("chosen by the desk for the patient");
  await desk.ctx.close();

  // the patient sees both: the first partly accepted with the reason, the re-order at Green Life
  await page.reload();
  await expect(card).toHaveAttribute("data-portable", "partially-accepted");
  await expect(card.locator('[data-item="hba1c"]')).toContainText("Analyser for HbA1c under repair this week");
  await expect(card.locator('[data-item="usgwa"]')).toContainText("এই কেন্দ্রে হয় না");
  const again = page.locator(`section[aria-label="${second}"]`);
  await expect(again).toHaveAttribute("data-portable", "centre-chosen");
  await expect(again).toContainText("গ্রিন লাইফ ক্লিনিক");
});
