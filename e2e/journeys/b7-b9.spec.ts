import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
/* Journey B, walkthrough B8–B9 (ADR 0017) on the real stack, in the seeded E2E Lite Hospital at 1440 px. Each run has
   its own wards and patient (set up through the API: the admin's wards, the desk's direct admission on the laparoscopy
   package with a card deposit, the surgeon's round with three CBCs).
   B8 (IPD billing): each line tagged Package / Included / Excluded; the low-deposit (here: due) alert offers a bKash
   link to the guardian; deposits with their money receipt; the class-change preview; a move up re-prices today's bed
   day (struck through, "class change"); a charge posted and withdrawn; the interim bill.
   B9–B12 (ward in-charge, ADR 0018): the surgeon orders the discharge; six steps; "Blocked by Billing" (the final bill
   starts at once); the cashier issues the final bill and takes the rest (the steps finish by these events); remind; the
   surgeon signs the summary; "Blocked by Pharmacy · <name>"; the pharmacist's clearance; "patient left" → discharged,
   the visit finished, the bed to cleaning.
   Issue #1: the banner is this patient. */
const NURSE = "01798000004", SURGEON = "01798000005", DESK = "01798000001", ADMIN = "01798000010", PHARM = "01798000011", CASHIER = "01798000008";
const RUN = Date.now().toString(36).slice(-5).toUpperCase();

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
async function post<T = Record<string, any>>(request: APIRequestContext, url: string, data: object, status = [200, 201]): Promise<T> {
  const r = await request.post("/api" + url, { headers: key(), data }); expect(status, `${url} ${r.status()} ${await r.text()}`).toContain(r.status()); return (await r.json()) as T;
}
async function getJ<T = Record<string, any>>(request: APIRequestContext, url: string): Promise<T> { const r = await request.get("/api" + url); expect(r.ok(), await r.text()).toBe(true); return (await r.json()) as T; }
async function pin(page: Page, p = "1234") { await page.getByTestId("pin").fill(p); await page.getByTestId("pin-submit").click(); }
const tomorrow = () => new Date(Date.now() + 6 * 3600_000 + 864e5).toISOString().slice(0, 10);
/** B11: the surgeon writes the discharge summary on ipd/summary and signs it with the PIN. */
async function writeSummary(page: Page, admissionId: string) {
  await page.goto(`/m/ipd/summary?adm=${admissionId}`);
  await page.getByTestId("summary-open").click();
  await page.locator('input[name="dx-search"]').fill("Cystitis");
  await page.getByRole("option", { name: /GC00/ }).click();
  await page.locator('[data-dx="GC00"] input[type=checkbox]').check();
  await page.getByTestId("sm-course").fill("Laparoscopic cystectomy on day 1, uneventful recovery, eating normally");
  await page.getByTestId("rx-search").fill("ace");
  await page.locator('[data-medicine="ace"]').first().click();
  await page.getByTestId("sm-fu-date").fill(tomorrow());
  await page.getByTestId("sm-fu-place").fill("Surgery OPD room 4");
  await page.locator('[data-flag="fever"] input').check();
  await page.getByTestId("sm-sign").click(); await pin(page);
  await expect(page.locator('[data-screen="ipd/summary"][data-status="signed"]')).toBeVisible();
}

type Ctx = { admissionId: string; encounterId: string; number: string; nameEn: string; cabinWard: string; bedId: string };
let ctx: Ctx;
async function setup(request: APIRequestContext): Promise<Ctx> {
  await as(request, ADMIN);
  const wardName = `BL${RUN}`, cabinWard = `CB${RUN}`;
  await post(request, "/v1/admin/wards", { name: wardName, beds: 1, bedClass: "General" });
  await post(request, "/v1/admin/wards", { name: cabinWard, beds: 1, bedClass: "Cabin" });
  await as(request, DESK);
  const nameEn = `Bill Journey ${RUN}`;
  const p = await post(request, "/v1/patients", { nameBn: "বিল রোগী", nameEn, sex: "female", dobMode: "dob", dob: "02/05/1995", phone: `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: false });
  const beds = (await getJ(request, "/v1/ipd/beds")).wards.find((w: { name: string }) => w.name === wardName).beds;
  const pkg = (await getJ(request, "/v1/ipd/packages")).items.find((x: { code: string }) => x.code === "PKG-LAP-01");
  const adm = await post(request, "/v1/ipd/admissions", { patientId: p.patient.id, admittingDoctorId: "u_e2l_surgeon", department: "surgery", diagnosis: "Ovarian cyst for laparoscopy", bedClass: "General", bedId: beds[0].id,
    guardian: { name: "রাশেদ চৌধুরী", relationship: "husband", phone: "01711908812" }, consents: ["general", "financial", "guardian-id"], packageId: pkg.id, deposit: { method: "card", amountPaisa: 2_000_000, reference: "APPR 4471" } });
  await as(request, SURGEON);
  const open = await post(request, `/v1/ipd/encounters/${adm.encounter.id}/round/open`, {});
  const r = await request.put(`/api/v1/ipd/round-notes/${open.draft.id}`, { headers: key(), data: { rev: open.draft.rev, sections: { s: "", o: "", a: "Post-op day 0", p: "Bloods" }, lines: [],
    orders: [{ testCode: "cbc", priority: "routine" }, { testCode: "cbc", priority: "routine" }, { testCode: "cbc", priority: "routine" }] } });
  expect(r.ok(), await r.text()).toBe(true);
  await post(request, `/v1/ipd/round-notes/${open.draft.id}/sign`, { rev: (await r.json()).draft.rev, pin: "1234" });
  return { admissionId: adm.id, encounterId: adm.encounter.id, number: adm.number, nameEn, cabinWard, bedId: beds[0].id };
}

test.describe.configure({ mode: "serial" });
test.describe("Journey B7–B9: the IPD running bill and the discharge checklist", () => {
  test.beforeEach(({}, info) => { info.setTimeout(180_000); });
  test.beforeAll(async ({ request }) => { ctx = await setup(request); });

  test("B8: tagged lines, the due alert sends a bKash link to the guardian, deposits with receipts, the class preview", async ({ page, request }) => {
    await login(page, CASHIER);
    await page.goto("/m/bill/ipd");
    await page.locator(`[data-adm="${ctx.number}"]`).click();
    await expect(page.locator('[data-screen="bill/ipd"][data-status="due"]')).toBeVisible();
    await expect(page.locator(".pt-banner")).toContainText(ctx.nameEn); // issue #1
    const lines = page.getByTestId("ipd-lines");
    await expect(lines.locator('[data-line="pkg"][data-tag="package"]')).toContainText("Laparoscopic cystectomy");
    await expect(lines.locator('[data-line="bed:1"][data-tag="included"]')).toBeVisible();
    await expect(lines.locator('[data-tag="included"][data-line^="order:"]')).toHaveCount(2);
    await expect(lines.locator('[data-tag="excluded"][data-line^="order:"]')).toHaveCount(1);
    // the due alert → a bKash link to the guardian (suggested top-up filled in)
    await expect(page.getByTestId("deposit-alert")).toContainText("রাশেদ চৌধুরী");
    await page.getByTestId("send-link").click();
    await expect(page.getByTestId("deposit-amount")).not.toHaveValue("");
    await page.getByTestId("deposit-amount").fill("30000");
    await page.getByTestId("deposit-submit").click();
    const link = page.locator('[data-deposit="bkash"]');
    await expect(link).toContainText("··8812");
    // the guardian pays (the fake gateway), then a cash top-up at the counter
    await as(request, CASHIER);
    const bill = await getJ(request, `/v1/ipd/bills/${ctx.admissionId}`);
    const pay = bill.deposits.items.find((d: { method: string }) => d.method === "bkash");
    await post(request, `/v1/dev/fake-payments/${pay.id}/confirmed`, {});
    await page.reload();
    await expect(page.locator('[data-deposit="bkash"][data-status="confirmed"]')).toBeVisible();
    await page.getByTestId("take-deposit").click();
    await page.getByTestId("deposit-amount").fill("5000");
    await page.getByTestId("deposit-submit").click();
    await expect(page.locator('[data-deposit="cash"][data-status="confirmed"]')).toBeVisible();
    await expect(page.locator('[data-screen="bill/ipd"]')).toHaveAttribute("data-status", "ok");
    // the money receipt: DR/yy/nnnn, printed on 80 mm
    await page.locator('[data-deposit="cash"]').getByTestId("deposit-receipt").click();
    await expect(page.getByTestId("deposit-receipt-number")).toHaveText(/^DR\/\d{2}\/\d{4}$/);
    await page.getByTestId("deposit-receipt-print").click();
    await expect(page.getByTestId("deposit-receipt-dialog").locator("iframe")).toBeVisible();
    await page.keyboard.press("Escape");
    // the class preview: cabin from today, the package at the cabin price
    await page.getByTestId("class-preview-pick").selectOption("Cabin");
    await expect(page.getByTestId("class-preview")).toHaveAttribute("data-direction", "up");
    await expect(page.getByTestId("class-preview")).toContainText("62,000");
  });

  test("B8: a move up re-prices by supersession; a charge posted and withdrawn; the interim bill", async ({ page, request }) => {
    await as(request, NURSE);
    const cab = (await getJ(request, "/v1/ipd/beds")).wards.find((w: { name: string }) => w.name === ctx.cabinWard).beds[0];
    await post(request, `/v1/ipd/admissions/${ctx.admissionId}/transfer`, { bedId: cab.id, reason: "Family asked for a cabin", mode: "now" });
    await login(page, CASHIER);
    await page.goto(`/m/bill/ipd?adm=${ctx.admissionId}`);
    const lines = page.getByTestId("ipd-lines");
    await expect(lines.locator('[data-line="pkg"][data-superseded="1"]')).toContainText("class change");
    await expect(lines.locator('[data-line="pkg"][data-superseded="0"]')).toContainText("62,000");
    // a charge from the price list, then withdrawn with a reason (a credit line)
    await page.getByTestId("charge-search").fill("transfusion");
    await page.locator('[data-charge="desk:transfusion"]').click();
    const manual = lines.locator('[data-line^="manual:"][data-superseded="0"]');
    await expect(manual).toHaveCount(1);
    await manual.getByTestId("withdraw").click();
    await page.getByTestId("withdraw-reason").fill("Posted to the wrong patient");
    await page.getByTestId("withdraw-confirm").click();
    await expect(lines.locator('[data-line^="credit:manual:"]')).toBeVisible();
    // the interim bill (A4, not a final bill)
    await page.getByTestId("interim-print").click();
    await expect(page.getByTestId("interim-card").locator("iframe")).toBeVisible();
  });

  test("B9–B12: the order; the final bill issued and settled (Blocked by Billing first); remind; the summary signed; Blocked by Pharmacy · the pharmacist; patient left → discharged", async ({ page, request }) => {
    // the surgeon orders the discharge from the checklist screen
    await login(page, SURGEON);
    await page.goto("/m/ipd/discharge");
    await page.locator(`[data-candidate="${ctx.number}"]`).click();
    await page.getByTestId("discharge-advice").fill("Pain settled, eating normally — home with oral analgesia");
    await page.getByTestId("discharge-order").click(); await pin(page);
    await expect(page.locator('[data-screen="ipd/discharge"][data-status="ordered"]')).toBeVisible();
    // Kamrul, 2: the final bill starts at once — the payment waits for it
    await expect(page.locator('[data-step="final-bill"]')).toHaveAttribute("data-step-status", "blocking");
    await expect(page.getByTestId("discharge-header")).toContainText("Blocked by Billing");
    await expect(page.getByTestId("event-summary")).toContainText("Finishes when the doctor signs the summary");
    // B10 — the cashier issues the final bill (the pharmacy has not cleared yet) and takes the rest at the counter
    await login(page, CASHIER);
    await page.goto(`/m/bill/ipd?adm=${ctx.admissionId}`);
    const clear = page.getByTestId("clearance");
    await page.getByTestId("final-issue").click();
    await expect(page.getByTestId("final-preview")).toContainText("Due at the counter");
    await page.getByTestId("final-issue-confirm").click();
    await expect(page.getByTestId("final-card")).toHaveAttribute("data-status", "partially-paid");
    await expect(page.getByTestId("final-number")).toContainText(/INV\/\d{2}\/\d{4}/);
    await expect(page.getByTestId("bill-frozen")).toBeVisible();
    await expect(clear.locator('[data-step="final-bill"]')).toHaveAttribute("data-step-status", "done");
    await page.getByTestId("final-pay").click();
    await page.getByRole("radio", { name: "Card" }).click();
    await page.getByTestId("final-pay-reference").fill("APPR 9902");
    await page.getByTestId("final-pay-submit").click();
    await expect(page.getByTestId("final-card")).toHaveAttribute("data-status", "balanced");
    await page.reload();
    await expect(page.getByTestId("clearance").locator('[data-step="payment"]')).toHaveAttribute("data-step-status", "done");
    await page.getByTestId("final-receipt").click();
    await expect(page.getByTestId("final-receipt-number")).toContainText(/RCPT\/\d{2}\/\d{4}/);
    await page.getByTestId("final-receipt-print").click();
    await expect(page.getByTestId("final-receipt-dialog").locator("iframe")).toBeVisible({ timeout: 20_000 });
    // the ward reminds the doctor of the summary
    await login(page, NURSE);
    await page.goto(`/m/ipd/discharge?adm=${ctx.admissionId}`);
    await page.getByTestId("remind-summary").click();
    await expect(page.locator('[data-step="summary"]')).toContainText("Reminded");
    // B11 — the surgeon writes and signs the summary: now only the pharmacy stands before leaving
    await login(page, SURGEON);
    await writeSummary(page, ctx.admissionId);
    await page.goto(`/m/ipd/discharge?adm=${ctx.admissionId}`);
    await expect(page.locator('[data-step="pharmacy"]')).toHaveAttribute("data-step-status", "blocking");
    await expect(page.getByTestId("discharge-header")).toContainText("Blocked by Pharmacy");
    // the pharmacist takes it (the header names them), then clears it with the PIN
    await login(page, PHARM);
    await page.goto("/m/ph/indent");
    await page.locator(`[data-clearance="${ctx.number}"]`).getByTestId("clearance-open").click();
    await page.getByTestId("take-pharmacy").click();
    await expect(page.getByTestId("discharge-header")).toContainText(/Blocked by Pharmacy · \S+/);
    await page.getByTestId("done-pharmacy").click();
    await page.getByRole("radio", { name: "There were none" }).click();
    await page.getByTestId("step-continue").click(); await pin(page);
    await expect(page.locator('[data-step="pharmacy"]')).toHaveAttribute("data-step-status", "done");
    // B12 — the nurse records "patient left"
    await login(page, NURSE);
    await page.goto(`/m/ipd/discharge?adm=${ctx.admissionId}`);
    await page.getByTestId("done-bed-release").click(); await page.getByTestId("step-continue").click(); await pin(page);
    await expect(page.locator('[data-screen="ipd/discharge"][data-status="completed"]')).toBeVisible();
    await expect(page.getByTestId("discharge-header")).toContainText("Discharged");
    await expect(page.getByTestId("visit-finished")).toBeVisible();
    await as(request, NURSE);
    const board = await getJ(request, "/v1/ipd/beds");
    const bed = board.wards.flatMap((w: { beds: { name: string; ward: { name: string }; state: string }[] }) => w.beds).find((b: { ward: { name: string } }) => b.ward.name === ctx.cabinWard);
    expect(bed.state).toBe("cleaning");
  });
});
