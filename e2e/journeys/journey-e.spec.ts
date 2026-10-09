import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
/* Journey E1–E3 (ADR 0022, 0023) — the portable lab order across three facilities and the patient app:
   the E2E clinic's doctor orders CBC, HbA1c and USG for "a network centre the patient picks"; the patient (390 px) sees
   the centres and chooses the E2E Lite Hospital with home collection (it does not do USG); the Lite technologist
   accepts CBC and declines HbA1c with a reason (USG goes back as not offered there); the doctor's inbox shows the
   declines and opens the order, where the doctor re-orders them elsewhere; the clinic's desk chooses Green Life for the
   patient (who has the app, but the desk can); the patient sees both outcomes. E3: Green Life takes the re-order, works
   the sample and bills it with a bKash link; the patient sees the bill and the result; the doctor opens the centre's
   result from the inbox and acknowledges it; the patient sees it received. The order, the patient's sign-in and the
   centre's lab and cashier steps go through the API; the decisions people make are made on the screens. */
const PATIENT = process.env.PATIENT_URL ?? "http://localhost:3001";
const STAFF = process.env.STAFF_URL ?? "http://localhost:3000";
const DESK = "01799000001", DOCTOR = "01799000002", CASHIER = "01799000008", LITE_TECH = "01798000006", GL_TECH = "01711000005", GL_PATH = "01711000006", GL_CASHIER = "01711000008";
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

test("@phone Journey E1–E3: a portable lab order — the patient picks a centre, the centre accepts part, the doctor re-orders, the desk picks for the patient, the result comes back", async ({ page, request, browser }) => {
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

  // E3 — Green Life accepts both, collects, releases; its cashier bills and sends the bKash link (the API)
  type LV = { specimens: { id: string; status: string }[]; orders: { id: string; testCode: string; results: { id: string }[] }[]; release: { observationIds: string[] } };
  await as(request, GL_TECH);
  const glOrders = (await (await request.get("/api/v1/network-orders")).json()) as { items: { id: string; number: string; items: { id: string }[] }[] };
  const glOrder = glOrders.items.find((x) => x.number === second)!;
  await post(request, `/v1/network-orders/${glOrder.id}/decide`, { items: glOrder.items.map((i) => ({ itemId: i.id, accept: true })) });
  const enc = ((await (await request.get(`/api/v1/network-orders/${glOrder.id}`)).json()) as { centreVisitId: string | null }).centreVisitId;
  expect(enc, "the centre's visit for the order").toBeTruthy();
  let lv = await post<LV>(request, `/v1/lab/visits/${enc}/labels`, {});
  for (const sp of lv.specimens.filter((x) => x.status === "pending")) for (const step of ["collect", "receive", "start"]) await post(request, `/v1/lab/specimens/${sp.id}/${step}`, { at: new Date().toISOString() });
  lv = (await (await request.get(`/api/v1/lab/visits/${enc}`)).json()) as LV;
  const VALUES: Record<string, [string, string][]> = { hba1c: [["hba1c", "7.4"]], usgwa: [] };
  for (const o of lv.orders.filter((x) => VALUES[x.testCode]?.length)) await post(request, `/v1/lab/orders/${o.id}/results`, { entries: VALUES[o.testCode]!.map(([analyteCode, value]) => ({ analyteCode, value })) }, 201);
  lv = (await (await request.get(`/api/v1/lab/visits/${enc}`)).json()) as LV;
  lv = await post<LV>(request, `/v1/lab/visits/${enc}/verify`, { pin: "1234", observationIds: lv.orders.flatMap((o) => o.results.map((r) => r.id)), deltaChecked: true });
  await as(request, GL_PATH);
  lv = await post<LV>(request, `/v1/lab/visits/${enc}/validate`, { pin: "1234", observationIds: lv.orders.flatMap((o) => o.results.map((r) => r.id)) });
  await post(request, `/v1/lab/visits/${enc}/release`, { observationIds: lv.release.observationIds }, 201);
  await as(request, GL_CASHIER);
  const glBill = await post<{ invoice: { id: string; rev: number; totalPaisa: number } }>(request, `/v1/encounters/${enc}/invoice`, {}, 201);
  await post(request, `/v1/invoices/${glBill.invoice.id}/issue`, { rev: glBill.invoice.rev });
  const shift = (await (await request.get("/api/v1/shifts/mine")).json()) as { shift: { status: string } | null };
  if (!shift.shift || shift.shift.status !== "open") await post(request, "/v1/shifts", { openingFloatPaisa: 100_000 }, 201);
  await post(request, `/v1/invoices/${glBill.invoice.id}/payments`, { method: "bkash", amountPaisa: glBill.invoice.totalPaisa }, 201);

  // the patient: the bill with the bKash link, and the result is out
  await page.reload();
  await expect(again.locator("[data-bill]")).toContainText("বিকাশে পরিশোধ করুন");
  await expect(again.getByRole("link", { name: "বিকাশে পরিশোধ করুন" })).toHaveAttribute("href", /\/p\/[A-Za-z0-9_-]+$/);
  await expect(again.locator("[data-result-ready]")).toBeVisible();

  // the ordering doctor: the result in the inbox → the order → the centre's report; acknowledged
  const doc2 = await staffPage(browser, DOCTOR);
  await doc2.page.goto("/m/doc/inbox");
  const result = doc2.page.locator('[data-kind="portable-result"]').filter({ hasText: second });
  await expect(result.first()).toBeVisible();
  await result.first().getByTestId("ack-seen").click();
  await expect(result.first()).toHaveAttribute("data-acked", "server");
  await result.first().getByTestId("open-portable-result").click();
  await expect(doc2.page.locator('[data-testid="portable-detail"]')).toHaveAttribute("data-status", "accepted", { timeout: 30_000 });
  await doc2.page.getByTestId("po-result").click();
  await expect(doc2.page.locator('[data-testid="shared-report"] tr[data-analyte="hba1c"]')).toContainText("H");
  await expect(doc2.page.locator('[data-testid="portable-detail"]')).toContainText("Received by the doctor");
  await doc2.ctx.close();

  // the patient sees it received
  await page.reload();
  await again.locator("summary").click();
  await expect(again).toContainText("ডাক্তার দেখেছেন");
});
