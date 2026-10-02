import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
/* Billing follow-ups (ADR 0005) on the real stack, E2E Test Clinic: cashier 01799000008, owner 01799000009.
   - "Not billed here" on an unpriced order (SGPT): the cashier asks, the owner approves, the line leaves the totals
     and the bill can be issued;
   - void: the owner voids an unpaid bill with a reason; a new bill for the visit says what it replaces, and the voided
     one then shows "Replaced by INV/…";
   - reconciliation: money that arrived on a link the gateway had reported failed is applied by the owner; a different
     amount is resolved with a note.
   Order refresh has no screen action until the lab slice adds ORDER revoke; the API contract test covers it. */
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
async function signedVisit(request: APIRequestContext, tag: string, orders: string[]): Promise<{ id: string; token: string }> {
  await request.post("/api/v1/auth/login", { data: { identifier: DESK, password: "setu1234" } });
  const r = await request.post("/api/v1/patients", { headers: key(), data: {
    nameBn: "ফলো-আপ রোগী", nameEn: `Followup ${tag} ${RUN}`, sex: "male", dobMode: "dob", dob: "05/05/1980", phone: `018${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
    phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
  } });
  expect(r.status(), await r.text()).toBe(201);
  const enc = ((await r.json()) as { encounter: { id: string; token: string } }).encounter;
  await request.post("/api/v1/auth/login", { data: { identifier: DOCTOR, password: "setu1234" } });
  const v = (await (await request.post(`/api/v1/encounters/${enc.id}/consultation/open`, { headers: key(), data: {} })).json()) as { draft: { id: string } };
  const saved = await request.put(`/api/v1/compositions/${v.draft.id}`, { headers: key(), data: {
    rev: 1, sections: { complaints: [{ text: "Fatigue", duration: { n: 1, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }],
    orders: orders.map((testCode) => ({ testCode, priority: "routine" })),
  } });
  const s = await request.post(`/api/v1/compositions/${v.draft.id}/sign`, { headers: key(), data: { rev: ((await saved.json()) as { rev: number }).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false } });
  expect(s.status(), await s.text()).toBe(200);
  return enc;
}
async function openBill(page: Page, token: string) {
  await page.goto("/m/bill/opd");
  await page.locator(`[data-bill-token="${token}"]`).click();
  await page.waitForURL(/\/m\/bill\/opd\?inv=/);
  await expect(page.getByTestId("bill-lines")).toBeVisible();
}
async function asOwner(browser: Browser, fn: (p: Page) => Promise<void>) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const p = await ctx.newPage();
  try { await login(p, OWNER); await fn(p); } finally { await ctx.close(); }
}

test("decision 98: 'Not billed here' on an unpriced test — cashier asks, owner approves, the line leaves the totals", async ({ page, request, browser }) => {
  test.setTimeout(120_000);
  const visit = await signedVisit(request, "NB", ["cbc", "sgpt"]);
  await login(page, CASHIER);
  await openBill(page, visit.token);
  const sgpt = page.locator('[data-line="test:sgpt"]');
  await expect(sgpt).toContainText("No price set");
  await expect(page.getByText("Some lines have no price — the price list needs it")).toBeVisible();
  await sgpt.getByTestId("nb-open").click();
  await page.fill("input[name=nb-reason]", "Sent to the partner lab, billed there");
  await sgpt.getByTestId("nb-send").click();
  await expect(sgpt.getByTestId("nb-pending")).toContainText("waiting for approval");
  await expect(page.getByTestId("issue")).toBeDisabled();
  await expect(page.getByTestId("bill-total")).toHaveText("৳ 1,250");

  await asOwner(browser, async (o) => {
    await o.goto("/m/bill/approvals");
    const card = o.locator("[data-approval]", { hasText: `Followup NB ${RUN}` });
    await expect(card.locator('[data-kind="bill-elsewhere"]')).toContainText("Not billed here");
    await expect(card.getByTestId("appr-line")).toContainText("SGPT");
    await card.getByTestId("approve").click();
    await expect(card).toHaveCount(0);
  });
  await expect(sgpt.getByTestId("not-billed")).toContainText("Not billed here — Sent to the partner lab, billed there", { timeout: 15_000 });
  await expect(page.getByTestId("bill-total")).toHaveText("৳ 1,250");
  await page.getByTestId("issue").click();
  await expect(page.getByTestId("invoice-number")).toHaveText(/^INV\/\d{2}\/\d{4,}$/);
});

test("void: the owner voids an unpaid bill; a new bill says what it replaces; the voided one shows 'Replaced by'", async ({ page, request }) => {
  test.setTimeout(120_000);
  const visit = await signedVisit(request, "VOID", ["cbc"]);
  await login(page, CASHIER);
  await openBill(page, visit.token);
  await expect(page.getByTestId("void-open")).toHaveCount(0); // cashier: no void
  await page.getByTestId("issue").click();
  const number = (await page.getByTestId("invoice-number").textContent())!;
  const billUrl = page.url().replace(/^https?:\/\/[^/]+/, "");
  await login(page, OWNER);
  await page.goto(billUrl);
  await page.getByTestId("void-open").click();
  await expect(page.getByTestId("void-confirm")).toBeDisabled();
  await page.fill("input[name=void-reason]", "Billed on the wrong visit");
  await page.getByTestId("void-confirm").click();
  await expect(page.getByTestId("void-banner")).toContainText("VOID (entered in error) — Billed on the wrong visit · Test Owner");
  await expect(page.getByTestId("invoice-number")).toHaveText(number);
  await expect(page.getByTestId("take-payment")).toHaveCount(0);
  await page.getByTestId("new-bill").click();
  await page.waitForURL(/\/m\/bill\/opd\?inv=/);
  await expect(page.getByTestId("replaces")).toContainText(`This bill replaces the voided bill ${number}`);
  await page.getByTestId("issue").click();
  const newNumber = (await page.getByTestId("invoice-number").textContent())!;
  expect(newNumber).not.toBe(number);
  await page.goto(billUrl);
  await expect(page.getByTestId("replaced-by")).toHaveText(`Replaced by ${newNumber}`);
});

test("reconciliation: money on a link the gateway reported failed is applied by the owner; a different amount is resolved with a note", async ({ page, request, browser }) => {
  test.setTimeout(150_000);
  const visit = await signedVisit(request, "REC", ["cbc"]);
  await login(page, CASHIER);
  await openBill(page, visit.token);
  await page.getByTestId("issue").click();
  await page.getByTestId("take-payment").click();
  await page.waitForURL(/\/m\/bill\/pay\?inv=/);
  // The patient pays, the callback is lost, then the gateway wrongly reports the link failed.
  await page.getByRole("radio", { name: "bKash" }).click();
  await page.fill("input[name=pay-amount]", "500");
  await page.getByTestId("pay-submit").click();
  const bk = page.locator('[data-payment="bkash"]');
  await bk.getByRole("button", { name: "Pays, callback lost" }).click();
  const trx = (await bk.getByTestId("lost-trx").textContent())!.match(/[A-Z0-9]{10}$/)![0];
  await bk.getByRole("button", { name: "Payment fails" }).click();
  await expect(bk).toHaveAttribute("data-status", "failed");
  await bk.getByRole("button", { name: "Resend link" }).click();
  await expect(bk).toHaveAttribute("data-status", "link-sent");
  await bk.locator("input[name^=trx-]").fill(trx);
  await bk.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByTestId("pay-notice")).toContainText("Do not ask the patient to pay again");
  await expect(bk).toHaveAttribute("data-status", "link-sent");
  // A second link where the gateway reports a different amount.
  await page.getByRole("radio", { name: "Nagad" }).click();
  await page.fill("input[name=pay-amount]", "750");
  await page.getByTestId("pay-submit").click();
  const ng = page.locator('[data-payment="nagad"]');
  await expect(ng).toHaveAttribute("data-status", "link-sent");
  const nagadId = (await page.evaluate(async (inv) => (await (await fetch(`/api/v1/invoices/${inv}`)).json()).payments.find((p: { method: string }) => p.method === "nagad").id, new URL(page.url()).searchParams.get("inv")));
  expect((await page.request.post(`/api/v1/dev/fake-payments/${nagadId}/confirmed`, { data: { amountPaisa: 7_500 } })).ok()).toBe(true);

  await asOwner(browser, async (o) => {
    await o.goto("/m/bill/reconcile");
    const late = o.locator("[data-reconcile]", { has: o.locator('[data-why="earlier-link"]'), hasText: `Followup REC ${RUN}` });
    await expect(late.getByTestId("rec-reported")).toContainText(trx);
    await late.getByTestId("rec-apply").click();
    await expect(late).toHaveCount(0);
    const diff = o.locator("[data-reconcile]", { has: o.locator('[data-why="amount-mismatch"]'), hasText: `Followup REC ${RUN}` });
    await expect(diff.getByTestId("rec-blockers")).toContainText("The amount does not match");
    await expect(diff.getByTestId("rec-apply")).toBeDisabled();
    await diff.locator("textarea").fill("Called the patient; Nagad support will reverse ৳75");
    await diff.getByTestId("rec-resolve").click();
    await expect(diff).toHaveCount(0);
    await o.getByRole("radio", { name: "Applied" }).click();
    await expect(o.locator("[data-reconcile]", { hasText: `Followup REC ${RUN}` }).getByTestId("rec-outcome")).toContainText("Applied — Test Owner");
  });
  await page.reload();
  await expect(page.locator('[data-payment="bkash"]')).toHaveAttribute("data-status", "confirmed");
  await expect(page.locator('[data-payment="nagad"]')).toHaveAttribute("data-status", "link-sent");
});
