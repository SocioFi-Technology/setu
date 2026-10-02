import { expect, test, type Page } from "@playwright/test";
/* Phase 0 gate (prompt 4): the Staff App shell renders for all 9 roles with the modules the prototype gives them,
   plan locks show as in the prototype, and the three page states work. Runs against `pnpm dev` (demo users). */
const ROLES: [string, string, string[]][] = [
  ["01711000001", "receptionist", ["fd", "bill", "ipd", "net"]],
  ["01711000002", "doctor", ["cons", "ipd", "er", "net"]],
  ["01711000004", "nurse", ["fd", "ipd", "nur", "er"]],
  ["01711000005", "labTech", ["lab", "net"]],
  ["01711000006", "pathologist", ["lab"]],
  ["01711000007", "pharmacist", ["ph"]],
  ["01711000008", "cashier", ["bill"]],
  ["01711000009", "owner", ["fd", "bill", "ipd", "lab", "ph", "own", "adm", "net"]],
  ["01711000010", "admin", ["fd", "bill", "ipd", "nur", "lab", "ph", "er", "own", "adm", "net"]],
];
async function login(page: Page, phone: string, plan?: "Clinic" | "Hospital Lite" | "Hospital Pro") {
  await page.context().clearCookies();
  await page.goto("/login");
  if (plan) await page.getByRole("radiogroup", { name: "Demo plan" }).getByRole("radio", { name: plan, exact: true }).click();
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForURL("**/"); await expect(page.locator("header.shell-top")).toBeVisible();
}
const navModules = (page: Page) => page.locator("nav a.nav-item:not(.home)").evaluateAll((as) => [...new Set(as.map((a) => (a as HTMLAnchorElement).pathname.split("/")[2]))]);

for (const [phone, role, mods] of ROLES) {
  test(`shell renders for ${role}`, async ({ page }) => {
    await login(page, phone);
    await expect(page.locator("h1")).toContainText(/শুভ সকাল|Good morning/);
    expect(await navModules(page)).toEqual(mods);
    await expect(page.getByRole("radiogroup", { name: "Language" })).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Numerals" })).toBeVisible();
  });
}
test("role denied → Permission-denied panel (prototype state)", async ({ page }) => {
  await login(page, "01711000002"); await page.goto("/m/fd/register");
  await expect(page.locator("h2")).toHaveText(/প্রবেশাধিকার নেই/);
});
/* Plan demos are seeded tenants (Shapla Clinic on Clinic, Meghna Hospital on Hospital Lite), so this runs against the
   real database too — the login page's demo-plan picker only exists when the database is off. */
test("Clinic plan locks IPD/nursing/ER for a nurse; Lite locks OT for a doctor", async ({ page }) => {
  await login(page, "01722000004");
  await expect(page.locator("nav .lock-tag")).toHaveCount(3);
  await page.goto("/m/nur/ward"); await expect(page.locator("h2")).toContainText("এই প্ল্যানে নেই");
  await login(page, "01733000002");
  await expect(page.locator("nav a.nav-item.locked")).toHaveCount(3);
  await expect(page.locator(".nav-foot")).toContainText("Hospital Pro");
});
test("language and numerals toggles, command palette", async ({ page }) => {
  await login(page, "01711000002");
  await page.getByRole("radio", { name: "EN", exact: true }).click();
  await expect(page.locator("nav .nav-group").first()).toContainText("OPD consultation");
  await page.getByRole("radio", { name: "0123", exact: true }).click();
  await expect(page.locator(".kpi .v").first()).toHaveText(/^[0-9]/);
  await page.keyboard.press("Control+k"); await page.keyboard.type("round"); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/m\/ipd\/rounds/);
});
test("@phone staff shell fits 390 px", async ({ page }) => {
  await login(page, "01711000002");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390 + 1);
});
