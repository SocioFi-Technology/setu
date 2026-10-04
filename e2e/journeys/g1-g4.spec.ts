import { expect, test, type Browser, type Page } from "@playwright/test";
/* Journey G — admin (ADR 0010; prototype Setu Admin), desktop 1440, in the E2E Test Clinic group:
   G1 the E2E New Clinic (in setup — pnpm reset-e2e puts it back) is onboarded by its admin: details, branch, ward with
   beds, a doctor added with a one-time password and a verified BMDC number, the doctor's fee, print formats and payment
   methods, a test SMS → Go live (refused until then);
   G2 the doctor's first sign-in sets a password and PIN (nothing else opens before); switched off by the admin, the
   doctor's open session ends at the next request and the sign-in page says why;
   G3 the owner adds a service, changes its price with a reason (history), and changes an approval limit with a reason;
   G4 the audit log shows the flagged events; the CSV link carries the filters. */
const NEWADMIN = "01799000011", OWNER = "01799000009";
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const phone = () => `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

async function login(page: Page, id: string, password = "setu1234", english = true) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.fill("input[name=identifier]", id); await page.fill("input[name=password]", password); await page.click("button[type=submit]");
  if (!english) return;
  await page.waitForURL("**/");
  await expect(page.locator("header.shell-top").or(page.locator('[data-screen="first-sign-in"]'))).toBeVisible();
  if (await page.locator("header.shell-top").isVisible()) {
    await page.getByRole("radio", { name: "EN", exact: true }).click();
    await page.getByRole("radio", { name: "0123", exact: true }).click();
  }
}
const item = (page: Page, key: string) => page.locator(`[data-testid="checklist"] [data-item="${key}"]`);

test.describe("Journey G — admin", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });
  let doctorPhone = "", doctorOtp = "";

  test("G1: onboarding — the checklist blocks go-live until complete; then the facility is live", async ({ page }) => {
    await login(page, NEWADMIN);
    await page.goto("/m/adm/wizard");
    await expect(page.locator('[data-screen="adm/wizard"]')).toHaveAttribute("data-status", "setup");
    await expect(page.getByTestId("go-live")).toBeDisabled();
    await expect(item(page, "organization")).toHaveAttribute("data-done", "0");

    await page.getByTestId("org-address").fill("Road 4, Sector 7, Uttara, Dhaka");
    await page.getByTestId("org-licence").fill(`DGHS-${RUN}`);
    await page.getByTestId("org-save").click();
    await expect(item(page, "organization")).toHaveAttribute("data-done", "1");
    await page.getByTestId("branch-name").fill("Uttara branch");
    await page.getByTestId("branch-add").click();
    await expect(item(page, "branch")).toHaveAttribute("data-done", "1");
    await page.getByTestId("ward-name").fill("Ward A");
    await page.getByTestId("ward-beds").fill("4");
    await page.getByTestId("ward-add").click();
    await expect(item(page, "wards")).toHaveAttribute("data-done", "1");

    // a doctor: the one-time password is shown once; the BMDC number verified
    await page.goto("/m/adm/users");
    await page.getByTestId("add-user").click();
    doctorPhone = phone();
    await page.getByTestId("new-name-bn").fill("ডা. নতুন চিকিৎসক");
    await page.getByTestId("new-name-en").fill(`Dr. New ${RUN}`);
    await page.getByTestId("new-phone").fill(doctorPhone);
    await page.getByTestId("new-role").selectOption("doctor");
    await page.getByTestId("new-reg").fill("A-52817");
    await page.getByTestId("create-user").click();
    await expect(page.getByTestId("otp")).toHaveText(/^[A-Za-z2-9]{10}$/);
    doctorOtp = (await page.getByTestId("otp").textContent())!.trim();
    await expect(page.getByTestId("credential")).toContainText("never shown again");
    await page.getByTestId("otp-done").click();
    const row = page.locator(`[data-testid="user-list"] tr[data-phone="${doctorPhone}"]`);
    await expect(row).toContainText("First sign-in pending");
    await expect(row.locator("[data-reg]")).toHaveAttribute("data-reg", "unverified");
    await row.getByTestId("manage").click();
    await page.getByTestId("reg-verify").click();
    await expect(row.locator("[data-reg]")).toHaveAttribute("data-reg", "verified");
    await page.keyboard.press("Escape");

    // the doctor's fee on the price list
    await page.goto("/m/adm/masters");
    await expect(page.getByTestId("no-fee")).toContainText(`Dr. New ${RUN}`);
    await page.getByTestId("add-price").click();
    await page.getByTestId("add-kind").selectOption("consultation");
    await page.getByTestId("add-price-tk").fill("700");
    await page.getByTestId("add-price-save").click();
    await expect(page.getByTestId("no-fee")).toHaveCount(0);

    // formats, payment methods, a test SMS → Go live
    await page.goto("/m/adm/wizard");
    await page.getByTestId("receipt-format").selectOption("thermal");
    await page.locator('[data-testid="methods"] input[data-method="cash"]').check();
    await page.locator('[data-testid="methods"] input[data-method="bkash"]').check();
    await page.getByTestId("prints-save").click();
    await expect(item(page, "payment_method")).toHaveAttribute("data-done", "1");
    await expect(item(page, "templates")).toHaveAttribute("data-done", "1");
    await page.getByTestId("sms-phone").fill("01712345678");
    await page.getByTestId("sms-send").click();
    await expect(item(page, "test_sms")).toHaveAttribute("data-done", "1");
    await expect(item(page, "doctor")).toHaveAttribute("data-done", "1");
    await expect(item(page, "price_list")).toHaveAttribute("data-done", "1");
    await page.getByTestId("go-live").click();
    await expect(page.locator('[data-screen="adm/wizard"]')).toHaveAttribute("data-status", "live");
    await expect(page.getByTestId("checklist")).toContainText("Live since");
  });

  test("G2: the doctor's first sign-in sets a password and PIN; switched off, the open session ends", async ({ page, browser }) => {
    test.skip(!doctorOtp, "G1 created the doctor");
    const doc = await (browser as Browser).newContext();
    const dp = await doc.newPage();
    await login(dp, doctorPhone, doctorOtp, false);
    await expect(dp.locator('[data-screen="first-sign-in"]')).toBeVisible();
    await dp.fill("input[name=new-password]", "short"); await dp.fill("input[name=repeat-password]", "short");
    await dp.fill("input[name=new-pin]", "1234"); await dp.fill("input[name=repeat-pin]", "1234");
    await expect(dp.getByTestId("first-save")).toBeDisabled(); // too short to send
    await dp.fill("input[name=new-password]", "uttara2026"); await dp.fill("input[name=repeat-password]", "uttara2026");
    await dp.getByTestId("first-save").click();
    await expect(dp.getByTestId("first-error")).toBeVisible(); // 1234 is too simple — the server says so
    await dp.fill("input[name=new-pin]", "8642"); await dp.fill("input[name=repeat-pin]", "8642");
    await dp.getByTestId("first-save").click();
    await expect(dp.locator("header.shell-top")).toBeVisible();

    // the admin switches the doctor off; the doctor's next request ends the session
    await login(page, NEWADMIN);
    await page.goto("/m/adm/users");
    const row = page.locator(`[data-testid="user-list"] tr[data-phone="${doctorPhone}"]`);
    await row.getByTestId("manage").click();
    await page.getByTestId("off-reason").fill("Left the clinic — e2e test");
    await page.getByTestId("deactivate").click();
    await expect(row).toHaveAttribute("data-active", "0");
    await dp.goto("/m/doc/inbox");
    await expect(dp).toHaveURL(/\/login\?ended=1/);
    await expect(dp.getByTestId("session-ended")).toBeVisible();
    await doc.close();
  });

  test("G3: the owner changes a price with a reason (history) and an approval limit with a reason", async ({ page }) => {
    await login(page, OWNER);
    await page.goto("/m/adm/masters");
    await page.getByTestId("add-price").click();
    await page.getByTestId("add-kind").selectOption("service");
    await page.getByTestId("add-name-en").fill(`Dressing ${RUN}`);
    await page.getByTestId("add-name-bn").fill("ড্রেসিং");
    await page.getByTestId("add-price-tk").fill("200");
    await page.getByTestId("add-price-save").click();
    const row = page.locator('[data-testid="price-list"] tr').filter({ hasText: `Dressing ${RUN}` });
    await expect(row).toContainText("200");
    await row.getByTestId("change-price").click();
    await page.getByTestId("new-price").fill("250");
    await expect(page.getByTestId("price-save")).toBeDisabled(); // needs a reason
    await page.getByTestId("price-reason").fill("Dressing material costs more");
    await page.getByTestId("price-save").click();
    await expect(row).toContainText("250");
    await row.getByTestId("price-history").click();
    await expect(page.getByTestId("history-table").locator("tbody tr")).toHaveCount(2);
    await page.keyboard.press("Escape");

    await page.getByRole("radio", { name: "Approval limits & settings" }).click();
    const before = await page.getByTestId("cashier-limit").inputValue();
    await page.getByTestId("cashier-limit").fill(String(Number(before) + 100));
    await expect(page.getByTestId("limits-save")).toBeDisabled();
    await page.getByTestId("limits-reason").fill("Busier desk this month — e2e");
    await page.getByTestId("limits-save").click();
    await expect(page.getByTestId("limits-reason")).toHaveCount(0); // saved: the form now holds the server's values
    await page.reload();
    await page.getByRole("radio", { name: "Approval limits & settings" }).click();
    await expect(page.getByTestId("cashier-limit")).toHaveValue(String(Number(before) + 100));
    await page.getByTestId("cashier-limit").fill(before);
    await page.getByTestId("limits-reason").fill("Back to the usual limit — e2e");
    await page.getByTestId("limits-save").click();
    await expect(page.getByTestId("limits-reason")).toHaveCount(0);
    await expect(page.getByTestId("cashier-limit")).toHaveValue(before);
  });

  test("G4: the audit log shows the flagged events; the CSV download carries the filters", async ({ page }) => {
    await login(page, OWNER);
    await page.goto("/m/adm/audit");
    const table = page.getByTestId("audit-table");
    await expect(table.locator('tr[data-action="settings-change"]').first()).toBeVisible();
    await expect(table.locator('tr[data-action="price-change"]').first()).toBeVisible();
    await expect(table.locator('tr[data-flagged="0"]')).toHaveCount(0);
    await page.getByTestId("f-action").selectOption("price-change");
    await expect(table.locator("tbody tr").first()).toHaveAttribute("data-action", "price-change");
    await expect(page.getByTestId("audit-csv")).toHaveAttribute("href", /audit\.csv\?.*flagged=1.*action=price-change|audit\.csv\?.*action=price-change.*flagged=1/);
  });

  test("the admin screens fit a 1024 px tablet", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await login(page, OWNER);
    for (const path of ["/m/adm/wizard", "/m/adm/users", "/m/adm/masters", "/m/adm/audit"]) {
      await page.goto(path);
      await expect(page.locator(`[data-screen="${path.slice(3)}"]`)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1025);
    }
  });
});
