import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
/* Journey C — the owner's morning check on the phone (Setu Journeys C1–C4, @phone at 412 px), in the E2E Test Clinic,
   with the cashier at the desk. C1 KPIs with the list behind each number (changes compared with the period before,
   issue #23; labelled axes); C2 discounts above policy — the bills and who gave them, viewing logged; C3 approve one,
   reject one with a reason, the cashier sees the outcome; C4 the cashier counts the drawer short and hands over with a
   reason, the owner asks for a recount, then accepts the variance with a note (issue #24). Data through the API. */
const DESK = "01799000001", DOCTOR = "01799000002", CASHIER = "01799000008", OWNER = "01799000009";
const RUN = Date.now().toString(36).slice(-5);

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForURL("**/"); await expect(page.locator("header.shell-top")).toBeVisible();
  await page.getByRole("radio", { name: "EN", exact: true }).click();
  await page.getByRole("radio", { name: "0123", exact: true }).click();
}
const key = () => ({ "idempotency-key": crypto.randomUUID() });
async function as(request: APIRequestContext, phone: string) { const r = await request.post("/api/v1/auth/login", { data: { identifier: phone, password: "setu1234" } }); expect(r.ok(), await r.text()).toBe(true); }
async function post<T = Record<string, unknown>>(request: APIRequestContext, url: string, data: object, status = 200): Promise<T> {
  const r = await request.post("/api" + url, { headers: key(), data }); expect(r.status(), `${url}: ${await r.text()}`).toBe(status); return (await r.json()) as T;
}
const getJ = async <T,>(request: APIRequestContext, url: string): Promise<T> => (await (await request.get("/api" + url)).json()) as T;
const noSideways = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width + 1);

/** A signed consultation-only visit (৳800) and its draft bill, as the cashier sees it. */
async function draftBill(request: APIRequestContext, tag: string) {
  await as(request, DESK);
  const r = await post<{ encounter: { id: string } }>(request, "/v1/patients", { nameBn: "মালিক রোগী", nameEn: `Owner ${tag} ${RUN}`, sex: "female", dobMode: "dob", dob: "01/01/1985",
    phone: `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true }, 201);
  await as(request, DOCTOR);
  const v = await post<{ draft: { id: string } }>(request, `/v1/encounters/${r.encounter.id}/consultation/open`, {});
  const saved = await request.put(`/api/v1/compositions/${v.draft.id}`, { headers: key(), data: { rev: 1, sections: { complaints: [{ text: "Cough", duration: { n: 3, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }], orders: [] } });
  await post(request, `/v1/compositions/${v.draft.id}/sign`, { rev: ((await saved.json()) as { rev: number }).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });
  await as(request, CASHIER);
  const bill = await post<{ invoice: { id: string; rev: number } }>(request, `/v1/encounters/${r.encounter.id}/invoice`, {}, 201);
  return { enc: r.encounter.id, invoiceId: bill.invoice.id, rev: bill.invoice.rev };
}
/** The cashier asks for a ৳200 discount on a ৳800 bill (limit 5% = ৳40) → an approval task for the owner. */
async function discountRequest(request: APIRequestContext, tag: string) {
  const b = await draftBill(request, tag);
  const r = await post<{ outcome: string }>(request, `/v1/invoices/${b.invoiceId}/discount`, { mode: "amount", amountPaisa: 20_000, category: "doctor", reason: `Doctor's request for ${tag} ${RUN}`, rev: b.rev });
  expect(r.outcome).toBe("approval-requested");
  return b;
}
async function finishCashierShift(request: APIRequestContext) {
  await as(request, CASHIER);
  const mine = await getJ<{ shift: { id: string; status: string; live: { expectedCashPaisa: number } | null } | null }>(request, "/v1/shifts/mine");
  if (!mine.shift) return;
  if (mine.shift.status === "open") await post(request, `/v1/shifts/${mine.shift.id}/count`, { counts: {}, reason: "closing a shift left open by an earlier test run" });
  await as(request, OWNER);
  await post(request, `/v1/shifts/${mine.shift.id}/review`, { decision: "approve", note: "closing a shift left open by an earlier test run" });
}

test("@phone C1: the owner's phone home is the live dashboard — every number opens the list behind it; the chart's axes are labelled", async ({ page, request }) => {
  test.setTimeout(120_000);
  const b = await draftBill(request, "C1");
  await as(request, CASHIER);
  const issued = await post<{ invoice: { totalPaisa: number; rev: number } }>(request, `/v1/invoices/${b.invoiceId}/issue`, { rev: b.rev });
  await post(request, `/v1/invoices/${b.invoiceId}/payments`, { method: "cash", amountPaisa: issued.invoice.totalPaisa, tenderedPaisa: issued.invoice.totalPaisa }, 201);
  await page.setViewportSize({ width: 412, height: 900 });
  await login(page, OWNER);
  await expect(page.locator('[data-screen="own/dash"]')).toBeVisible();
  await expect(page.getByTestId("dash-compare")).toContainText("vs the same day last week");
  const revenue = page.locator('[data-kpi="revenue"]');
  await expect(revenue.locator(".v")).toContainText("৳");
  await expect(page.locator('[data-kpi="stockValue"]')).toContainText("Comes with the pharmacy module");
  await expect(page.getByTestId("revenue-chart").locator("svg text").filter({ hasText: "X: hour of day · Y: taka" })).toHaveCount(1);
  await noSideways(page);
  await revenue.click();
  const drill = page.getByTestId("drill");
  await expect(drill).toHaveAttribute("data-what", "revenue");
  await expect(drill).toContainText("Viewing this list is logged");
  await expect(drill).toContainText(`Owner C1 ${RUN}`);
});

test("@phone C2: discounts above policy — the bill, who asked and who approved; viewing is logged", async ({ page, request }) => {
  test.setTimeout(120_000);
  const b = await discountRequest(request, "C2");
  await as(request, OWNER);
  const list = await getJ<{ items: { taskId: string; reason: string }[] }>(request, "/v1/approvals?status=requested");
  const task = list.items.find((x) => x.reason.includes(`C2 ${RUN}`))!;
  await post(request, `/v1/approvals/${task.taskId}/approve`, {});
  await as(request, CASHIER);
  const inv = await getJ<{ invoice: { rev: number } }>(request, `/v1/invoices/${b.invoiceId}`);
  await post(request, `/v1/invoices/${b.invoiceId}/issue`, { rev: inv.invoice.rev });
  await page.setViewportSize({ width: 412, height: 900 });
  await login(page, OWNER);
  const line = page.locator('[data-leak="discountAbovePolicy"]');
  await expect(line).not.toHaveAttribute("data-count", "0");
  await line.click();
  const drill = page.getByTestId("drill");
  await expect(drill).toHaveAttribute("data-what", "discountAbovePolicy");
  const row = drill.locator("[data-drill-row]").filter({ hasText: `Owner C2 ${RUN}` });
  await expect(row).toContainText("৳ 200");
  await expect(row).toContainText("by Test Cashier");
  await expect(row).toContainText("approved by Test Owner");
});

test("@phone C3: approve one, reject one with a reason; the cashier sees both outcomes", async ({ page, request }) => {
  test.setTimeout(150_000);
  const one = await discountRequest(request, "C3a");
  const two = await discountRequest(request, "C3b");
  await page.setViewportSize({ width: 412, height: 900 });
  await login(page, OWNER);
  await page.goto("/m/bill/approvals");
  const card = (tag: string) => page.locator("[data-approval]").filter({ hasText: `${tag} ${RUN}` });
  await card("C3a").getByTestId("approve").click();
  await expect(card("C3a")).toHaveCount(0);
  await expect(card("C3b").getByTestId("reject")).toBeDisabled();
  await card("C3b").locator("textarea").fill("Not a policy reason — please bill in full");
  await card("C3b").getByTestId("reject").click();
  await expect(card("C3b")).toHaveCount(0);
  await noSideways(page);
  await as(request, CASHIER);
  const a = await getJ<{ invoice: { discountPaisa: number } }>(request, `/v1/invoices/${one.invoiceId}`);
  const r = await getJ<{ invoice: { discountPaisa: number }; approval: { status: string; decisionNote: string | null } | null }>(request, `/v1/invoices/${two.invoiceId}`);
  expect(a.invoice.discountPaisa).toBe(20_000);
  expect(r.invoice.discountPaisa).toBe(0);
});

test("C4 cashier: counts the drawer by note, a short count needs a reason, hands over", async ({ page, request }) => {
  test.setTimeout(120_000);
  await finishCashierShift(request);
  await login(page, CASHIER);
  await page.goto("/m/bill/shift");
  await page.fill("input[name=shift-float]", "2000");
  await page.getByTestId("shift-open").click();
  // blind count (money-controls review M1): what the drawer should hold is not shown while counting
  await expect(page.getByTestId("shift-live")).toContainText("Blind count");
  await expect(page.getByTestId("shift-variance")).toHaveCount(0);
  await page.fill("input[name=note-1000]", "1");
  await page.fill("input[name=note-500]", "1");
  await expect(page.getByTestId("shift-counted")).toContainText("৳ 1,500");
  await page.fill("input[name=settle-bkash]", "0");
  await page.getByTestId("shift-handover").click();
  // the server reveals the variance and asks for the reason
  await expect(page.getByTestId("shift-variance")).toHaveAttribute("data-judgement", "short");
  await expect(page.getByTestId("shift-variance")).toContainText("500");
  await expect(page.getByTestId("reason-needed")).toBeVisible();
  await expect(page.getByTestId("shift-handover")).toBeDisabled();
  await page.fill("textarea[name=shift-reason]", "gave change twice to one patient");
  await page.getByTestId("shift-handover").click();
  await expect(page.getByTestId("shift-closed")).toContainText("waiting for the owner / admin");
  await expect(page.getByTestId("count-variance")).toHaveAttribute("data-judgement", "short");
});

test("@phone C4 owner: a recount sends it back; accepting the variance needs a note (issue #24); the dashboard shows it", async ({ page, request }) => {
  test.setTimeout(150_000);
  await finishCashierShift(request);
  await as(request, CASHIER);
  const sh = await post<{ id: string }>(request, "/v1/shifts", { openingFloatPaisa: 200_000 }, 201);
  await post(request, `/v1/shifts/${sh.id}/count`, { counts: { "1000": 1, "500": 1 }, reason: `drawer short on ${RUN}` });
  await page.setViewportSize({ width: 412, height: 900 });
  await login(page, OWNER);
  await page.getByTestId("pending-shifts").click();
  await page.waitForURL(/\/m\/bill\/shift/);
  const card = page.locator(`[data-shift="${sh.id}"]`);
  await expect(card).toContainText(`drawer short on ${RUN}`);
  await expect(card.getByTestId("shift-approve")).toBeDisabled();
  await expect(card.getByTestId("shift-recount")).toBeDisabled();
  await card.locator("textarea[name=review-note]").fill("count the coin box again please");
  await card.getByTestId("shift-recount").click();
  await expect(card).toHaveCount(0);
  // the cashier counts again (the recount note shows), finds the ৳500, hands over
  await as(request, CASHIER);
  const mine = await getJ<{ shift: { reviews: { note: string }[] } }>(request, "/v1/shifts/mine");
  expect(mine.shift.reviews.at(-1)!.note).toBe("count the coin box again please");
  await post(request, `/v1/shifts/${sh.id}/count`, { counts: { "1000": 1, "500": 1 }, reason: "the ৳500 was not found on recount" });
  await page.reload();
  await expect(card.getByTestId("shift-approve")).toHaveText(/Accept the variance/);
  await expect(card.getByTestId("shift-approve")).toBeDisabled();
  await card.locator("textarea[name=review-note]").fill(`accepted on ${RUN}, cashier to repay`);
  await card.getByTestId("shift-approve").click();
  await expect(card).toHaveCount(0);
  await noSideways(page);
  await page.goto("/m/own/dash");
  await page.locator('[data-leak="shiftVariance"]').click();
  await expect(page.getByTestId("drill").locator("[data-drill-row]").filter({ hasText: `accepted on ${RUN}, cashier to repay` })).toContainText(/500/);
});
