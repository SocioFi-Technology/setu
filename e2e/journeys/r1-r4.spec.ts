import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
/* Journey R — refunds and returns (ADR 0013; prototype Setu Billing › Refunds & cancellations), in the E2E Test Clinic at
   1440 px. R1 the cashier refunds a cancelled test from bill/pay: the consultation is locked (given), the RBS is ticked,
   cash back; the owner approves in the single Approvals queue; the cashier pays it out with who took the money → voucher
   RF/yy/nnnn printed, a reprint needs a reason, the public check shows the amount; the bill shows what was refunded.
   R2 the pharmacist takes 4 tablets back as a wrong dispense (owner approves) → paid in cash → the units sit in quarantine
   → the doctor's inbox has the return notice → the pharmacist releases them to the counter ("unopened" + reason).
   R3 a return without refund on an unpaid pharmacy bill (decision 221): credit voucher CV/…, the due goes to zero → the
   owner voids the bill. R4 the owner's dashboard: the refunds tile is live, the medication incident is on the leakage
   list and its list opens the refund. Bills are set up through the API (the billing and dispensing screens are journeys
   A and P). */
const DESK = "01799000001", DOCTOR = "01799000002", PHARM = "01799000007", CASHIER = "01799000008", OWNER = "01799000009";
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const YY = new Date(Date.now() + 6 * 3600_000).toISOString().slice(2, 4);

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
async function post<T = Record<string, any>>(request: APIRequestContext, url: string, data: object, status = 200): Promise<T> {
  const r = await request.post("/api" + url, { headers: key(), data }); expect(r.status(), `${url}: ${await r.text()}`).toBe(status); return (await r.json()) as T;
}
async function getJ<T = Record<string, any>>(request: APIRequestContext, url: string): Promise<T> { const r = await request.get("/api" + url); expect(r.ok(), await r.text()).toBe(true); return (await r.json()) as T; }

/** A visit signed by the E2E doctor: these test orders and medicines. */
async function signedVisit(request: APIRequestContext, tag: string, o: { orders?: string[]; meds?: { medicineKey: string; dose: string; meal: string; days: number }[] }) {
  await as(request, DESK);
  const name = `Refund ${tag} ${RUN}`;
  const r = await post<{ encounter: { id: string } }>(request, "/v1/patients", { nameBn: "ফেরত রোগী", nameEn: name, sex: "female", dobMode: "dob", dob: "06/06/1979",
    phone: `018${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true }, 201);
  await as(request, DOCTOR);
  const v = await post<{ draft: { id: string } }>(request, `/v1/encounters/${r.encounter.id}/consultation/open`, {});
  const saved = await request.put(`/api/v1/compositions/${v.draft.id}`, { headers: key(), data: { rev: 1, sections: { complaints: [{ text: "Fever", duration: { n: 2, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], orders: (o.orders ?? []).map((testCode) => ({ testCode, priority: "routine" })), medications: o.meds ?? [] } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await post(request, `/v1/compositions/${v.draft.id}/sign`, { rev: ((await saved.json()) as { rev: number }).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });
  return { enc: r.encounter.id, compositionId: v.draft.id, name };
}
/** The signed-in person's drawer is open (cash refunds leave it). */
async function openShift(request: APIRequestContext) {
  const mine = await getJ<{ shift: { status: string } | null }>(request, "/v1/shifts/mine");
  if (mine.shift?.status === "open") return;
  const r = await request.post("/api/v1/shifts", { headers: key(), data: { openingFloatPaisa: 200_000 } });
  expect([201, 409]).toContain(r.status());
}
/** A pharmacy bill: 10 Comet dispensed and issued by the pharmacist; paid in cash when `pay`. */
async function pharmacyBill(request: APIRequestContext, tag: string, pay: boolean) {
  const v = await signedVisit(request, tag, { meds: [{ medicineKey: "comet", dose: "1+0+1", meal: "after", days: 5 }] });
  await as(request, PHARM);
  const d0 = await getJ<{ lines: { requestId: string }[] }>(request, `/v1/pharmacy/encounters/${v.enc}`);
  const d = await post<{ bill: { id: string } }>(request, `/v1/pharmacy/encounters/${v.enc}/dispense`, { compositionId: v.compositionId, lines: [{ requestId: d0.lines[0]!.requestId, medicineKey: "comet", qty: 10 }] });
  const b = await getJ<{ invoice: { rev: number } }>(request, `/v1/invoices/${d.bill.id}`);
  const issued = await post<{ invoice: { totalPaisa: number; number: string } }>(request, `/v1/invoices/${d.bill.id}/issue`, { rev: b.invoice.rev });
  if (pay) await post(request, `/v1/invoices/${d.bill.id}/payments`, { method: "cash", amountPaisa: issued.invoice.totalPaisa, tenderedPaisa: issued.invoice.totalPaisa }, 201);
  return { ...v, invoiceId: d.bill.id, number: issued.invoice.number };
}
/** The owner approves the refund from the single Approvals queue (the Refunds filter). */
async function ownerApproves(page: Page, billNumber: string) {
  await login(page, OWNER);
  await page.goto("/m/bill/approvals");
  await page.getByRole("radio", { name: "Refunds", exact: true }).click();
  const card = page.locator("[data-approval]", { hasText: billNumber });
  await expect(card.locator('[data-kind="refund-approval"]')).toBeVisible();
  await card.getByTestId("approve").click();
  await expect(page.locator("[data-approval]", { hasText: billNumber })).toHaveCount(0);
}

test.describe("Journey R — refunds and returns", () => {
  test.describe.configure({ timeout: 150_000 });

  test("R1: a cancelled test refunded in cash — locked consultation, owner approves, paid with who took it, voucher, reprint, public check", async ({ page, request }) => {
    const v = await signedVisit(request, "R1", { orders: ["cbc", "rbs"] });
    await as(request, CASHIER);
    const b0 = await post<{ invoice: { id: string; rev: number } }>(request, `/v1/encounters/${v.enc}/invoice`, {}, 201);
    const issued = await post<{ invoice: { totalPaisa: number; number: string } }>(request, `/v1/invoices/${b0.invoice.id}/issue`, { rev: b0.invoice.rev });
    await post(request, `/v1/invoices/${b0.invoice.id}/payments`, { method: "cash", amountPaisa: issued.invoice.totalPaisa, tenderedPaisa: issued.invoice.totalPaisa }, 201);

    await login(page, CASHIER);
    await page.goto(`/m/bill/pay?inv=${b0.invoice.id}`);
    await page.getByTestId("pay-refund").click();
    await expect(page.locator('[data-screen="bill/refund"][data-kind="refund"]')).toBeVisible();
    const lines = page.getByTestId("rf-lines");
    // the consultation was given: locked; the RBS can be refunded
    await expect(lines.locator("tr", { hasText: "Consultation" })).toHaveAttribute("data-lock", "performed");
    await expect(lines.locator("tr", { hasText: "Consultation" }).getByRole("checkbox")).toBeDisabled();
    await lines.locator("tr", { hasText: "RBS" }).getByRole("checkbox").check();
    await expect(page.getByTestId("rf-total")).toHaveText("৳ 150");
    await page.locator("select[name=rf-category]").selectOption("cancelled-test");
    await page.fill("textarea[name=rf-reason]", "RBS not collected — the patient left first");
    await page.getByTestId("rf-ways").getByRole("radio", { name: "Cash (from your drawer)" }).click();
    await page.getByTestId("rf-request").click();
    await expect(page.locator('[data-screen="bill/refund"][data-refund-status="requested"]')).toBeVisible();
    await expect(page.getByTestId("rf-decide")).toContainText("no money moves until approved");
    const refundUrl = page.url();

    await ownerApproves(page, issued.invoice.number);

    // the cashier pays it out — who takes the money is required
    await login(page, CASHIER);
    await openShift(page.request);
    await page.goto(refundUrl.replace(/^https?:\/\/[^/]+/, ""));
    await expect(page.locator('[data-screen="bill/refund"][data-refund-status="approved"]')).toBeVisible();
    await expect(page.getByTestId("rf-pay-submit")).toBeDisabled();
    await page.fill("input[name=rf-recipient-name]", "Rashed Chowdhury");
    await page.fill("input[name=rf-recipient-phone]", "01711908812");
    await page.locator("select[name=rf-recipient-relation]").selectOption("spouse");
    await page.getByTestId("rf-pay-submit").click();
    await expect(page.locator('[data-screen="bill/refund"][data-refund-status="paid"]')).toBeVisible();
    await expect(page.getByTestId("voucher-number")).toHaveText(new RegExp(`^RF/${YY}/\\d{4,}$`));
    await expect(page.getByTestId("voucher")).toContainText("Rashed Chowdhury");
    // printed like a receipt: the original, then a duplicate only with a reason
    await page.getByTestId("voucher-print").click();
    await expect(page.getByTestId("voucher").locator('[data-copy="0"]')).toBeVisible();
    await expect(page.getByTestId("voucher-reprint")).toBeDisabled();
    await page.locator("select[name=voucher-reprint-reason]").selectOption("lost");
    await page.getByTestId("voucher-reprint").click();
    await expect(page.getByTestId("voucher").locator('[data-copy="1"]')).toContainText("Patient lost it");
    // the public check (no login): facility, number, date, amount
    const verify = await page.getByTestId("voucher-verify-url").getAttribute("href");
    await page.context().clearCookies();
    await page.goto(new URL(verify!).pathname);
    await expect(page.getByTestId("verify-amount")).toHaveText("৳ 150");
    // back at the bill: what was refunded
    await login(page, CASHIER);
    await page.goto(`/m/bill/pay?inv=${b0.invoice.id}`);
    await expect(page.getByTestId("pay-refunded")).toContainText("৳ 150");
  });

  test("R2: wrong dispense — 4 tablets back in cash, into quarantine, the doctor told, released to the counter", async ({ page, request }) => {
    const b = await pharmacyBill(request, "R2", true);
    await login(page, PHARM);
    await page.goto(`/m/ph/pay?inv=${b.invoiceId}`);
    await page.getByTestId("pay-refund").click();
    await expect(page.locator('[data-screen="ph/refund"][data-kind="refund"]')).toBeVisible();
    const row = page.getByTestId("rf-lines").locator("tr[data-line]").first();
    await row.getByRole("checkbox").check();
    await row.locator("input[name^=rf-]").fill("4");
    await expect(page.getByTestId("rf-total")).toHaveText("৳ 16");
    await page.locator("select[name=rf-category]").selectOption("wrong-dispense");
    await page.fill("textarea[name=rf-reason]", "Comet 500 given for Comet 850 — taken back");
    await page.getByTestId("rf-ways").getByRole("radio", { name: "Cash (from your drawer)" }).click();
    await page.getByTestId("rf-request").click();
    await expect(page.locator('[data-screen="ph/refund"][data-refund-status="requested"]')).toBeVisible();
    const url = page.url().replace(/^https?:\/\/[^/]+/, "");

    await ownerApproves(page, b.number);
    await login(page, PHARM);
    await openShift(page.request);
    await page.goto(url);
    await page.fill("input[name=rf-recipient-name]", "Karim Uddin");
    await page.fill("input[name=rf-recipient-phone]", "01912345678");
    await page.locator("select[name=rf-recipient-relation]").selectOption("child");
    await page.getByTestId("rf-pay-submit").click();
    await expect(page.locator('[data-screen="ph/refund"][data-refund-status="paid"]')).toBeVisible();

    // the prescribing doctor is told
    await login(page, DOCTOR);
    await page.goto("/m/doc/inbox");
    await expect(page.getByTestId("return-notice").filter({ hasText: "Comet 500 given for Comet 850" }).first()).toBeVisible();

    // the units wait in quarantine until the pharmacist releases them ("unopened" + a reason)
    await login(page, PHARM);
    await page.goto("/m/ph/stock");
    await page.getByTestId("stock-search").fill("Comet");
    const med = page.locator('tr[data-medicine="comet"]');
    await med.getByTestId("batches-toggle").click();
    const q = page.getByTestId("batch-table").locator('tr[data-location="quarantine"]').first();
    await q.getByTestId("release").click();
    await page.getByTestId("release-qty").fill("4");
    await page.getByTestId("release-reason").fill("Strip sealed, returned the same day");
    await expect(page.getByTestId("release-confirm")).toBeDisabled();
    await page.getByTestId("release-unopened").check();
    await page.getByTestId("release-confirm").click();
    await expect(page.getByText("4 back at the counter")).toBeVisible();
  });

  test("R3: a return without refund on an unpaid pharmacy bill — credit voucher, due to zero, then the owner voids the bill", async ({ page, request }) => {
    const b = await pharmacyBill(request, "R3", false);
    await login(page, PHARM);
    await page.goto(`/m/ph/pay?inv=${b.invoiceId}`);
    await page.getByTestId("pay-refund").click();
    await expect(page.locator('[data-screen="ph/refund"][data-kind="return"]')).toBeVisible();
    await expect(page.getByTestId("return-hint")).toContainText("no money is paid");
    await expect(page.getByTestId("rf-ways")).toHaveCount(0);
    const row = page.getByTestId("rf-lines").locator("tr[data-line]").first();
    await row.getByRole("checkbox").check();
    await page.locator("select[name=rf-category]").selectOption("patient-request");
    await page.fill("textarea[name=rf-reason]", "All ten brought back unopened before paying");
    await page.getByTestId("rf-request").click();
    await expect(page.locator('[data-screen="ph/refund"][data-refund-status="requested"]')).toBeVisible();
    const url = page.url().replace(/^https?:\/\/[^/]+/, "");

    await ownerApproves(page, b.number);
    await login(page, PHARM);
    await page.goto(url);
    await expect(page.locator("input[name=rf-recipient-name]")).toHaveCount(0);
    await page.getByTestId("rf-pay-submit").click();
    await expect(page.locator('[data-screen="ph/refund"][data-refund-status="paid"]')).toBeVisible();
    await expect(page.getByTestId("rf-status")).toContainText("Return recorded");
    await expect(page.getByTestId("voucher-number")).toHaveText(new RegExp(`^CV/${YY}/\\d{4,}$`));
    await page.goto(`/m/ph/pay?inv=${b.invoiceId}`);
    await expect(page.locator('[data-sum="due"]')).toContainText("৳ 0");
    await expect(page.getByTestId("pay-credited")).toBeVisible();

    // nothing was ever paid and every unit came back: the owner voids the bill (ADR 0005)
    await as(request, OWNER);
    const voided = await post<{ invoice: { status: string } }>(request, `/v1/invoices/${b.invoiceId}/void`, { reason: "All medicine returned before payment" });
    expect(voided.invoice.status).toBe("entered-in-error");
  });

  test("R4: the owner's dashboard — refunds tile live, the medication incident on the leakage list, its list opens the refund", async ({ page, request }) => {
    // a wrong-dispense refund paid today (set up through the API)
    const b = await pharmacyBill(request, "R4", true);
    await as(request, PHARM);
    const rb = await getJ<{ lines: { id: string }[]; payments: { id: string }[] }>(request, `/v1/invoices/${b.invoiceId}/refundable`);
    const r = await post<{ refund: { id: string } }>(request, `/v1/invoices/${b.invoiceId}/refunds`, { category: "wrong-dispense", reason: `Wrong strength given — two taken back ${RUN}`, lines: [{ chargeItemId: rb.lines[0]!.id, units: 2 }], allocations: [{ paymentId: rb.payments[0]!.id, amountPaisa: 800, way: "cash" }] }, 201);
    await as(request, OWNER);
    await post(request, `/v1/refunds/${r.refund.id}/decision`, { decision: "approve" });
    await as(request, PHARM);
    await openShift(request);
    const rv = await getJ<{ refund: { rev: number } }>(request, `/v1/refunds/${r.refund.id}`);
    await post(request, `/v1/refunds/${r.refund.id}/pay`, { rev: rv.refund.rev, recipient: { name: "Sumaiya Akter", phone: "01612345678", relation: "self" } });

    await login(page, OWNER);
    await page.goto("/m/own/dash");
    const tile = page.locator('[data-kpi="refunds"]');
    await expect(tile).toBeVisible();
    await expect(tile).not.toContainText("Comes with");
    const incident = page.locator('[data-leak="medicationIncident"]');
    await expect(incident).not.toHaveAttribute("data-count", "0");
    await incident.click();
    const row = page.locator("[data-drill-row]", { hasText: `Wrong strength given — two taken back ${RUN}` });
    await expect(row.locator("[data-refund-status]")).toHaveAttribute("data-refund-status", "paid");
    await row.getByRole("button", { name: "Open" }).click();
    await page.waitForURL(`**/m/bill/refund?rf=${r.refund.id}`);
    await expect(page.locator('[data-screen="bill/refund"][data-refund-status="paid"]')).toBeVisible();
  });
});
