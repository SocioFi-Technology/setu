import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
/* Journey P — the pharmacy (ADR 0009; prototype Setu Pharmacy), in the E2E Test Clinic, as the pharmacist at the counter
   (desktop 1440) with the owner deciding. P1 dispense a signed prescription: FEFO batch, the expired batch shown and
   never given, the Bangla / English dose label; P2 an out-of-stock line (Napa has only an expired batch) → a
   same-generic substitute with a reason → the doctor's inbox is told; P3 partial (the rest stays open) → the charge on
   the visit's pharmacy bill → issued and paid at the counter, then the rest declined with a reason; P4 OTC: an OTC item
   sells, a prescription-only item needs the photo, a controlled one is refused; P5 purchase order → goods received
   short (debit note) → posted; a short-expiry batch is posted by the owner; above ৳50,000 the owner approves; P6 store
   → fridge transfer, a count with a difference and a reason → the owner approves → the adjustment; the owner's stock
   tile is live. Prescriptions are set up through the API (the doctor's part is journey A). */
const DESK = "01799000001", DOCTOR = "01799000002", PHARM = "01799000007", OWNER = "01799000009";
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
async function post<T = Record<string, unknown>>(request: APIRequestContext, url: string, data: object, status = 200): Promise<T> {
  const r = await request.post("/api" + url, { headers: key(), data }); expect(r.status(), `${url}: ${await r.text()}`).toBe(status); return (await r.json()) as T;
}
const noSideways = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width + 1);

/** A new patient's visit signed by the E2E doctor with Comet 500 1+0+1 × 30 days (60) and Napa 1+1+1 × 3 days (9). */
async function signedRx(request: APIRequestContext, tag: string) {
  await as(request, DESK);
  const name = `Pharmacy ${tag} ${RUN}`;
  const r = await post<{ encounter: { id: string } }>(request, "/v1/patients", { nameBn: "ফার্মেসি রোগী", nameEn: name, sex: "male", dobMode: "dob", dob: "05/05/1968",
    phone: `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true }, 201);
  await as(request, DOCTOR);
  const v = await post<{ draft: { id: string } }>(request, `/v1/encounters/${r.encounter.id}/consultation/open`, {});
  const saved = await request.put(`/api/v1/compositions/${v.draft.id}`, { headers: key(), data: { rev: 1, sections: { complaints: [{ text: "Fever, diabetes follow-up", duration: { n: 3, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], orders: [],
    medications: [{ medicineKey: "comet", dose: "1+0+1", meal: "after", days: 30 }, { medicineKey: "napa", dose: "1+1+1", meal: "after", days: 3 }] } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await post(request, `/v1/compositions/${v.draft.id}/sign`, { rev: ((await saved.json()) as { rev: number }).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });
  return { enc: r.encounter.id, name };
}
/** Cash for the whole open amount on the payment screen (the amount box starts at what is still due). */
async function payCash(page: Page) {
  await expect(page.locator('[data-screen="ph/pay"]')).toBeVisible();
  await page.getByRole("radio", { name: "Cash" }).click();
  await expect(page.locator("input[name=pay-amount]")).not.toHaveValue("");
  await page.fill("input[name=pay-tendered]", await page.inputValue("input[name=pay-amount]"));
  await page.getByTestId("pay-submit").click();
  await expect(page.locator('[data-screen="ph/pay"]')).toHaveAttribute("data-invoice-status", "balanced");
}
const line = (page: Page, key: string) => page.locator(`[data-testid="rx-line"][data-medicine="${key}"]`);

test.describe("Journey P — the pharmacy", () => {
  // each test is a whole journey with two or three people signing in — more than the default 30 s under load
  test.describe.configure({ timeout: 120_000 });
  test("P1–P3: FEFO, expired never given, substitute (doctor told), partial → pharmacy bill paid at the counter → rest declined", async ({ page, request }) => {
    const rx = await signedRx(request, "P1");
    await login(page, PHARM);
    await page.goto("/m/ph/dispense");
    const row = page.locator(`[data-testid="rx-row"][data-encounter="${rx.enc}"]`);
    await expect(row).toHaveAttribute("data-status", "to-dispense");
    await row.click();
    await expect(page.locator('[data-screen="ph/dispense"][data-encounter]')).toBeVisible();
    await expect(page.getByText("Three separate facts")).toBeVisible();

    // P1: Comet — FEFO from the counter, the expired batch shown blocked, the dose label
    const comet = line(page, "comet");
    await expect(comet.getByTestId("fefo")).toContainText("First expiry, first out");
    await expect(comet.getByTestId("fefo")).not.toContainText("CM2508");
    await comet.locator("summary").click();
    await expect(comet.locator('tr[data-batch="CM2508"]')).toContainText("Expired — never given");
    await expect(comet.getByTestId("dose-label")).toContainText("সকালে ১টি, রাতে ১টি · খাবারের পরে · ৩০ দিন");
    await expect(comet).toContainText("Morning 1, Night 1 · After food · 30 days");
    // P3: only 20 of 60 now
    await comet.getByTestId("line-give-qty").fill("20");

    // P2: Napa has only an expired batch → a same-generic substitute (Ace) with a reason
    const napa = line(page, "napa");
    await expect(napa).toContainText("9 short at the counter");
    await napa.getByTestId("line-medicine").selectOption("ace");
    await expect(page.getByTestId("dispense")).toBeDisabled(); // a substitute needs a reason
    await napa.getByTestId("line-reason").fill("Napa batch expired — same paracetamol");
    await page.getByTestId("dispense").click();
    await expect(comet).toHaveAttribute("data-status", "partial");
    await expect(comet.getByTestId("line-qty")).toContainText("Prescribed 60 · given 20");
    await expect(napa).toHaveAttribute("data-status", "dispensed");
    await expect(napa.getByTestId("given")).toContainText("Ace");
    await expect(napa.getByTestId("given")).toContainText("Substitute");
    await noSideways(page);

    // the charge is on the visit's pharmacy bill: issue it and take the cash at the counter
    const billCard = page.getByTestId("pharmacy-bill");
    await expect(billCard).toHaveAttribute("data-status", "draft");
    await billCard.getByTestId("issue-bill").click();
    await expect(billCard).toHaveAttribute("data-status", "issued");
    await billCard.getByTestId("take-payment").click();
    await payCash(page);
    await page.getByTestId("back-to-bill").click();
    await expect(page.locator('[data-screen="ph/dispense"][data-encounter]')).toBeVisible();
    await expect(page.getByTestId("pharmacy-bill")).toHaveAttribute("data-status", "balanced");

    // the dose labels print through the browser on the facility's label page (default 50 × 30 mm); each print is logged
    await page.evaluate(() => { (window as unknown as { __printed: number }).__printed = 0; window.print = () => { (window as unknown as { __printed: number }).__printed++; }; });
    await page.getByTestId("print-labels").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
    const sheet = page.getByTestId("label-print");
    await expect(sheet).toHaveAttribute("data-page", "50x30");
    await expect(sheet.locator(".label-page")).toHaveCount(2);
    await expect(sheet.locator(".label-page").nth(1)).toContainText("Ace 500 mg × 9");
    await expect(sheet.locator(".label-page").nth(1)).toContainText("সকালে ১টি, দুপুরে ১টি, রাতে ১টি · খাবারের পরে · ৩ দিন");

    // P3: the rest of Comet is declined with a reason → the visit is done
    await comet.getByTestId("decline").click();
    await page.getByTestId("decline-reason").fill("Patient will buy the rest next month");
    await page.getByTestId("decline-confirm").click();
    await expect(comet).toHaveAttribute("data-status", "partial-declined");
    await page.goto("/m/ph/dispense");
    await expect(page.locator(`[data-testid="rx-row"][data-encounter="${rx.enc}"]`)).toHaveAttribute("data-status", "done");

    // P2: the prescribing doctor's inbox has the substitution notice
    await login(page, DOCTOR);
    await page.goto("/m/doc/inbox");
    const notice = page.locator('[data-kind="substitution-notice"]').filter({ hasText: rx.name });
    await expect(notice.getByTestId("substitution")).toContainText("Napa 500 mg → Ace 500 mg (9)");
    await expect(notice.getByTestId("substitution")).toContainText("Napa batch expired — same paracetamol");
  });

  test("P4: OTC sells; prescription-only needs the photo; controlled is refused; stock moves on completing the sale", async ({ page }) => {
    await login(page, PHARM);
    await page.goto("/m/ph/otc");
    await page.getByTestId("buyer-name").fill(`Walk-in ${RUN}`);
    await page.getByTestId("start-sale").click();
    await expect(page.locator('[data-screen="ph/otc"][data-status="draft"]')).toBeVisible();
    const add = async (q: string, key: string, qty: string) => {
      await page.getByTestId("otc-search").fill("");
      await page.getByTestId("otc-search").fill(q);
      await page.locator(`[data-testid="otc-results"] [data-medicine="${key}"]`).click();
      await page.getByTestId("otc-qty").fill(qty);
    };
    await add("ace", "ace", "10");
    await page.getByTestId("otc-add").click();
    await expect(page.getByTestId("otc-lines")).toContainText("Ace 500 mg");
    // controlled: refused, with the reason on screen
    await add("diazepam", "sedil", "5");
    await expect(page.getByText("A controlled medicine is never sold over the counter")).toBeVisible();
    await page.getByTestId("otc-add").click();
    await expect(page.getByTestId("otc-lines")).not.toContainText("Sedil");
    // prescription-only: needs the photo
    await add("moxacil", "moxacil", "15");
    await expect(page.getByText("Prescription-only — add a photo of the prescription first")).toBeVisible();
    await page.getByTestId("otc-add").click();
    await expect(page.getByTestId("otc-lines")).not.toContainText("Moxacil");
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
    await page.getByTestId("photo-input").setInputFiles({ name: "rx.png", mimeType: "image/png", buffer: png });
    await expect(page.getByTestId("rx-photo")).toContainText("Photo added");
    await add("moxacil", "moxacil", "15");
    await page.getByTestId("otc-add").click();
    await expect(page.getByTestId("otc-lines")).toContainText("Moxacil 500 mg");
    await page.getByTestId("complete-sale").click();
    await expect(page.locator('[data-screen="ph/otc"]')).toHaveAttribute("data-status", "issued");
    await page.getByTestId("take-payment").click();
    await payCash(page);
  });

  test("P5: order → goods received short (debit note) → posted; short expiry posted by the owner; above ৳50,000 the owner approves", async ({ page }) => {
    await test.step("pharmacist: sign in", () => login(page, PHARM));
    await page.goto("/m/ph/purchase?tab=orders");
    await page.getByTestId("new-po").click();
    await expect(page.locator('[data-screen="ph/purchase"][data-status="draft"]')).toBeVisible();
    const addLine = async (med: string, qty: string, cost: string) => {
      await page.getByTestId("po-medicine").selectOption(med); await page.getByTestId("po-qty").fill(qty); await page.getByTestId("po-cost").fill(cost);
      await page.getByTestId("po-add").click(); await expect(page.locator(`[data-testid="po-lines"] tr[data-line="${med}"]`)).toBeVisible();
    };
    await test.step("pharmacist: order with two lines, sent", async () => {
    await addLine("comet", "200", "3.40");
    await addLine("amdocal", "100", "4");
    await page.getByTestId("po-send").click();
    await expect(page.locator('[data-screen="ph/purchase"]')).toHaveAttribute("data-status", "sent");
    await expect(page.getByTestId("po-number")).toContainText("PO/");
    });

    // goods arrive: Comet 180 of 200 billed (a debit note); Amlodipine expiring in 80 days (the owner posts it)
    await page.getByTestId("grn-invoice").fill(`SQ-${RUN}`);
    await page.getByTestId("receive").click();
    const form = (med: string) => page.locator(`[data-testid="grn-form"][data-line="${med}"]`);
    const day = (n: number) => new Date(Date.now() + 6 * 3600_000 + n * 864e5).toISOString().slice(0, 10);
    const fill = async (med: string, batch: string, expiry: string, billed: string, received: string, mrp: string) => {
      const f = form(med);
      await f.getByTestId("grn-batch").fill(batch); await f.getByTestId("grn-expiry").fill(expiry);
      await f.getByTestId("grn-invoiced").fill(billed); await f.getByTestId("grn-received").fill(received); await f.getByTestId("grn-mrp").fill(mrp);
      await f.getByTestId("grn-add").click();
      await expect(page.locator(`[data-testid="grn-lines"] tr[data-batch="${batch}"]`)).toBeVisible();
    };
    await test.step("pharmacist: goods received, two lines checked", async () => {
    await fill("comet", `CM${RUN}`, day(700), "200", "180", "4");
    await expect(page.locator(`[data-testid="grn-lines"] tr[data-batch="CM${RUN}"]`)).toContainText("Short — debit note");
    await expect(page.getByTestId("grn-money")).toContainText("68");
    await fill("amdocal", `AM${RUN}`, day(80), "100", "100", "5");
    await expect(page.locator(`[data-testid="grn-lines"] tr[data-batch="AM${RUN}"]`)).toContainText("Expires within 6 months");
    await expect(page.getByText("the owner or an admin posts it").first()).toBeVisible();
    await expect(page.getByTestId("grn-post")).toBeDisabled();
    });
    const grnId = new URL(page.url()).searchParams.get("grn")!;

    // the owner sees it in the one approval queue (and on Pharmacy › Purchase) and posts it
    await test.step("owner: sign in", () => login(page, OWNER));
    await test.step("owner: the receipt is in both approval views; posts it", async () => {
    await page.goto("/m/bill/approvals");
    await page.getByRole("radiogroup", { name: "Kind" }).getByRole("radio", { name: "Goods receipt" }).click();
    await expect(page.locator('[data-testid="appr-grn"]').first()).toContainText("Expires within 6 months");
    await page.goto("/m/ph/purchase");
    await expect(page.getByTestId("ph-approvals")).toBeVisible();
    await expect(page.locator('[data-testid="appr-grn"]').first()).toBeVisible();
    await page.goto(`/m/ph/purchase?grn=${grnId}`);
    await page.getByTestId("grn-note").fill("Short expiry accepted — fast mover");
    await page.getByTestId("grn-post").click();
    await expect(page.locator('[data-screen="ph/purchase"][data-grn]')).toHaveAttribute("data-status", "posted");
    await expect(page.getByTestId("grn-number")).toContainText("GRN/");
    await page.getByRole("button", { name: "Purchase order" }).click();
    await expect(page.locator('[data-screen="ph/purchase"][data-po]')).toHaveAttribute("data-status", "partially-received");
    await page.getByTestId("po-close").click();
    await page.getByTestId("reason").fill("Supplier out of Comet until next month");
    await page.getByTestId("reason-confirm").click();
    await expect(page.locator('[data-screen="ph/purchase"][data-po]')).toHaveAttribute("data-status", "received");
    });

    // above ৳50,000: the pharmacist asks, the owner approves (and so sends) from the one approval queue
    await test.step("pharmacist: sign in", () => login(page, PHARM));
    await test.step("pharmacist: an order above the limit asks the owner", async () => {
    await page.goto("/m/ph/purchase?tab=orders");
    await page.getByTestId("new-po").click();
    await addLine("azith", "2000", "30");
    await expect(page.getByTestId("po-send")).toContainText("Ask the owner to approve");
    await page.getByTestId("po-send").click();
    await expect(page.getByTestId("po-approval")).toContainText("asked for approval");
    });
    const poId = new URL(page.url()).searchParams.get("po")!;
    await test.step("owner: sign in", () => login(page, OWNER));
    await test.step("owner: approves it in the Approvals screen (kind: purchase order)", async () => {
    await page.goto("/m/bill/approvals");
    await page.getByRole("radiogroup", { name: "Kind" }).getByRole("radio", { name: "Purchase order" }).click();
    const card = page.locator(`[data-testid="appr-po"][data-po="${poId}"]`);
    await card.getByTestId("appr-po-approve").click();
    await expect(card).toHaveCount(0);
    await page.goto(`/m/ph/purchase?po=${poId}`);
    await expect(page.locator('[data-screen="ph/purchase"][data-po]')).toHaveAttribute("data-status", "sent");
    await expect(page.getByTestId("po-approval")).toContainText("Approved and sent by Test Owner");
    });
  });

  test("P6: store → fridge, a count with a difference and a reason → the owner approves → adjusted; the stock tile is live", async ({ page }) => {
    await login(page, PHARM);
    await page.goto("/m/ph/stock");
    await page.getByTestId("stock-search").fill("pantonix");
    const row = page.locator('[data-testid="stock-table"] tr[data-medicine="pantonix"]');
    await row.getByTestId("batches-toggle").click();
    await page.locator('[data-testid="batch-table"] tr[data-location="store"]').first().getByTestId("transfer").click();
    await page.getByTestId("move-to").selectOption("fridge");
    await page.getByTestId("move-qty").fill("20");
    await page.getByTestId("move-confirm").click();
    await expect(page.locator('[data-testid="batch-table"] tr[data-location="fridge"]').first()).toBeVisible();

    await page.goto("/m/ph/count");
    await page.getByTestId("count-location").selectOption("fridge");
    await page.getByTestId("start-count").click();
    await expect(page.locator('[data-screen="ph/count"][data-status="counting"]')).toBeVisible();
    const rows = page.locator('[data-testid="count-lines"] tbody tr');
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const r = rows.nth(i);
      const expected = (await r.locator("td").nth(3).innerText()).trim();
      const isTarget = i === 0;
      await r.getByTestId("count-qty").fill(isTarget ? String(Number(expected) - 2) : expected);
      await r.getByTestId("count-qty").press("Enter");
      if (isTarget) {
        await expect(r).toHaveAttribute("data-variance", "-2");
        await r.getByTestId("count-reason").fill("Two strips damaged in the fridge");
        await r.getByTestId("count-reason").blur();
      }
    }
    await expect(page.getByTestId("submit-count")).toBeEnabled();
    await page.getByTestId("submit-count").click();
    await expect(page.locator('[data-screen="ph/count"]')).toHaveAttribute("data-status", "submitted");
    await expect(page.getByText("Waiting for the owner or an admin")).toBeVisible();
    const countId = new URL(page.url()).searchParams.get("count")!;

    // the owner approves it from the one approval queue (kind: stock count)
    await login(page, OWNER);
    await page.goto("/m/bill/approvals");
    await page.getByRole("radiogroup", { name: "Kind" }).getByRole("radio", { name: "Stock count" }).click();
    await page.locator(`[data-testid="appr-count"][data-count="${countId}"]`).getByTestId("appr-count-approve").click();
    await expect(page.locator(`[data-testid="appr-count"][data-count="${countId}"]`)).toHaveCount(0);
    await page.goto(`/m/ph/count?count=${countId}`);
    await expect(page.locator('[data-screen="ph/count"]')).toHaveAttribute("data-status", "approved");
    await expect(page.getByText("Approved by Test Owner")).toBeVisible();
    await page.goto("/m/own/dash");
    await expect(page.locator('[data-kpi="stockValue"] .v')).toContainText("৳");
  });

  test("the pharmacy screens fit a 1024 px counter tablet", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await login(page, PHARM);
    for (const path of ["/m/ph/dispense", "/m/ph/otc", "/m/ph/stock", "/m/ph/purchase", "/m/ph/count"]) {
      await page.goto(path);
      await expect(page.locator(`[data-screen="${path.slice(3)}"]`)).toBeVisible();
      await noSideways(page);
    }
  });
});
