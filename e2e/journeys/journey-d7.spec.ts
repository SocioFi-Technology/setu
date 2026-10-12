import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
/* ADR 0024 — proof at the reception desk, and the claim QR. A mother and her daughter are E2E clinic patients on one
   phone. The mother (390 px) has no receipt with her: she taps "This is mine", chooses the reception, and the app shows
   a desk code. At the counter the receptionist types the code, sees only the clinic's records on that phone (both),
   checks her NID, picks hers and links it; the app shows it linked. Later she visits the Lite hospital: its receipt
   carries the claim QR — opened by the phone's camera it lands on the claim screen with the code, and one tap links
   the Lite record. The visit, the bill and the sign-in go through the API; the decisions are made on the screens. */
const PATIENT = process.env.PATIENT_URL ?? "http://localhost:3001";
const STAFF = process.env.STAFF_URL ?? "http://localhost:3000";
const DESK = "01799000001", LITE_DESK = "01798000001", LITE_DOCTOR = "01798000002", LITE_CASHIER = "01798000008";
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
const reg = (nameEn: string, nameBn: string, dob: string, phone: string, run: string, createVisit = false) =>
  ({ nameBn, nameEn: `${nameEn} ${run}`, sex: "female", dobMode: "dob", dob, phone, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit });

test("@phone Journey D7: the reception confirms the app in person; the receipt's claim QR links another facility", async ({ page, request, browser }) => {
  test.setTimeout(240_000);
  const run = Math.random().toString(36).slice(2, 7);
  const phone = `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  // a mother and her daughter on one phone at the clinic
  await as(request, DESK);
  const mother = await post<{ patient: { id: string; facilityNo: string } }>(request, "/v1/patients", reg("Rokeya Begum", "রোকেয়া বেগম", "03/05/1970", phone, run), 201);
  await post(request, "/v1/patients", reg("Mitu Akter", "মিতু আক্তার", "14/08/2001", phone, run), 201);

  // the mother signs in (the API; journey D covers these screens) and, without a receipt, chooses the reception
  await page.request.post(`${PATIENT}/api/v1/patient/otp`, { data: { phone, lang: "bn" } });
  const otp = ((await (await page.request.get(`${PATIENT}/api/v1/dev/patient-otp?phone=${phone}`)).json()) as { code: string }).code;
  expect((await page.request.post(`${PATIENT}/api/v1/patient/sign-in`, { data: { phone, code: otp } })).ok()).toBe(true);
  await page.goto(`${PATIENT}/claim`);
  const card = page.locator('section[data-claim]').filter({ hasText: "ই২ই টেস্ট" });
  await card.getByRole("button", { name: "এটা আমার" }).click();
  await card.getByRole("radio", { name: "রিসেপশনে" }).click();
  await card.getByRole("button", { name: "রিসেপশনে যাচাই করুন" }).click();
  const desk = card.locator("[data-desk-code]");
  await expect(desk).toHaveAttribute("data-desk-code", /^[23456789A-Z]{6}$/);
  const code = (await desk.getAttribute("data-desk-code"))!;
  await expect(card).toContainText(`${code.slice(0, 3)}-${code.slice(3)}`);

  // the reception: the code → the clinic's two records on that phone → NID checked → hers linked
  const fd = await staffPage(browser, DESK);
  await fd.page.goto("/m/fd/search");
  await fd.page.getByTestId("open-desk-claim").click();
  const dlg = fd.page.getByTestId("desk-claim");
  await dlg.getByTestId("desk-code").fill(`${code.slice(0, 3).toLowerCase()}-${code.slice(3)}`);
  await dlg.getByTestId("desk-find").click();
  await expect(dlg.locator("[data-record]")).toHaveCount(2);
  await expect(dlg).toContainText(`0${phone.slice(1, 3)}*****${phone.slice(-3)}`);
  await expect(dlg.getByTestId("desk-confirm")).toBeDisabled();
  await dlg.locator(`[data-record="${mother.patient.facilityNo}"] input`).check();
  await dlg.locator('input[data-doc="nid"]').check();
  await dlg.getByTestId("desk-confirm").click();
  await expect(fd.page.getByText(`Linked to the app · ${mother.patient.facilityNo}`)).toBeVisible();
  await expect(dlg).toHaveCount(0);
  await fd.ctx.close();

  // the app: linked
  await page.reload();
  await expect(card).toHaveAttribute("data-claim", "linked");

  // the Lite hospital: a visit, a paid bill — its receipt's claim code (the QR carries it with the facility)
  await as(request, LITE_DESK);
  const lite = await post<{ patient: { id: string }; encounter: { id: string } }>(request, "/v1/patients", reg("Rokeya Begum", "রোকেয়া বেগম", "03/05/1970", phone, run, true), 201);
  await as(request, LITE_DOCTOR);
  const open = await post<{ draft: { id: string } }>(request, `/v1/encounters/${lite.encounter.id}/consultation/open`, {});
  const saved = await request.put(`/api/v1/compositions/${open.draft.id}`, { headers: key(), data: {
    rev: 1, sections: { complaints: [{ text: "Sore throat", duration: { n: 3, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "CA02", verificationStatus: "provisional" }], medications: [], orders: [] } });
  expect(saved.status(), await saved.text()).toBe(200);
  await post(request, `/v1/compositions/${open.draft.id}/sign`, { rev: ((await saved.json()) as { rev: number }).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });
  await as(request, LITE_CASHIER);
  const bill = await post<{ invoice: { id: string; rev: number; totalPaisa: number } }>(request, `/v1/encounters/${lite.encounter.id}/invoice`, {}, 201);
  await post(request, `/v1/invoices/${bill.invoice.id}/issue`, { rev: bill.invoice.rev });
  const shift = (await (await request.get("/api/v1/shifts/mine")).json()) as { shift: { status: string } | null };
  if (!shift.shift || shift.shift.status !== "open") await post(request, "/v1/shifts", { openingFloatPaisa: 100_000 }, 201);
  await post(request, `/v1/invoices/${bill.invoice.id}/payments`, { method: "cash", amountPaisa: bill.invoice.totalPaisa, tenderedPaisa: bill.invoice.totalPaisa }, 201);
  const rc = await post<{ receipt: { snapshot: { patient: { claimCode?: string } } } }>(request, `/v1/invoices/${bill.invoice.id}/receipts`, {}, 201);
  const liteCode = rc.receipt.snapshot.patient.claimCode!;

  // the phone's camera opens the QR's link: the claim screen with the code; one tap links the Lite record
  await page.goto(`${PATIENT}/claim?t=t_e2e_lite&c=${liteCode}`);
  const fromQr = page.locator("[data-claim-qr]");
  await expect(fromQr).toContainText(`${liteCode.slice(0, 3)}-${liteCode.slice(3)}`);
  await fromQr.getByRole("button", { name: "এই কোডে যাচাই করুন" }).click();
  await expect(page.locator("section[data-claim]").filter({ hasText: "লাইট" })).toHaveAttribute("data-claim", "linked");
  await expect(fromQr).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("");
});
