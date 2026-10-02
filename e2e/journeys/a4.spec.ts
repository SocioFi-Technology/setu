import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
/* Journey A, step A4 (nurse vitals, tablet) on the real stack, in the seeded E2E Test Clinic: Rahima Khatun's visit
   today. Walkthrough check: text warning for each abnormal value; impossible values block the save; "Saved" only
   after the server confirms (offline: "not synced"). The token then shows in the queue's "Vitals done" column. */
const NURSE = "01799000004", DESK = "01799000001";
test.use({ viewport: { width: 1024, height: 900 } });

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForURL("**/"); await expect(page.locator("header.shell-top")).toBeVisible();
  await page.getByRole("radio", { name: "EN", exact: true }).click();
  await page.getByRole("radio", { name: "0123", exact: true }).click();
}
/** Today's waiting visit for Rahima Khatun, opened at the desk through the API (a leftover one is marked no-show first). */
async function rahimaVisit(request: APIRequestContext): Promise<{ id: string; token: string }> {
  await request.post("/api/v1/auth/login", { data: { identifier: DESK, password: "setu1234" } });
  const open = () => request.post("/api/v1/encounters", { data: { patientId: "e2e_p_rahima" }, headers: { "idempotency-key": crypto.randomUUID() } });
  let r = await open();
  if (r.status() === 409) {
    const existing = ((await r.json()) as { existing?: { encounterId: string } }).existing!;
    await request.post(`/api/v1/encounters/${existing.encounterId}/actions`, { data: { action: "noShow" }, headers: { "idempotency-key": crypto.randomUUID() } });
    r = await open();
  }
  expect(r.status()).toBe(201);
  const b = (await r.json()) as { encounter: { id: string; token: string } };
  return b.encounter;
}
const card = (page: Page, f: string) => page.locator(`[data-vital="${f}"]`);

test("A4: impossible values block the save, abnormal ones warn in text, Saved only after the server confirms", async ({ page, request }) => {
  const visit = await rahimaVisit(request);
  await login(page, NURSE);
  await page.goto("/m/fd/vitals");
  await page.locator(`[data-vitals-token="${visit.token}"]`).click();
  await expect(page.locator(".pt-banner")).toContainText("Rahima Khatun");
  await expect(page.getByTestId("vitals-stamp")).toHaveText("Not saved yet · Recording as Test Nurse");
  await expect(card(page, "bp")).toContainText(/Last: \d+\/\d+ · \d\d\/\d\d/);

  // Impossible: the prototype's error demo (994 °F) and SpO₂ over 100 — save is blocked.
  await page.getByRole("textbox", { name: "Temperature" }).fill("994");
  await expect(card(page, "temp")).toContainText("Not possible — check the value");
  await page.getByRole("textbox", { name: "SpO₂" }).fill("101");
  await expect(card(page, "spo2")).toContainText("Cannot exceed 100%");
  await expect(page.getByTestId("vitals-summary")).toHaveText("Fix impossible values to save");
  const save = page.getByRole("button", { name: "Save vitals" });
  await expect(save).toBeDisabled();

  // Fixed, with one abnormal value: a text warning, not a block. BMI uses the Asian cut-offs.
  await page.getByRole("textbox", { name: "Temperature" }).fill("৯৯.৪"); // Bangla digits are accepted
  await page.getByRole("textbox", { name: "SpO₂" }).fill("98");
  await page.getByRole("textbox", { name: "Systolic" }).fill("150");
  await page.getByRole("textbox", { name: "Diastolic" }).fill("95");
  await page.getByRole("textbox", { name: "Pulse" }).fill("96");
  await page.getByRole("textbox", { name: "Weight" }).fill("58");
  await page.getByRole("textbox", { name: "Height" }).fill("152");
  await expect(card(page, "bp")).toContainText("High — 140/90 mmHg or above");
  await expect(card(page, "temp")).toContainText("Normal");
  await expect(page.getByTestId("bmi-value")).toHaveText("25.1");
  await expect(card(page, "bmi")).toContainText("Overweight (Asian 23–27.4)");
  await expect(page.getByTestId("vitals-summary")).toHaveText("1 out of range — the doctor sees them flagged");
  await expect(page.getByTestId("vitals-stamp")).not.toContainText("Saved");

  await save.click();
  await expect(page.getByTestId("vitals-stamp")).toHaveText(/^Saved — Provider verified · Test Nurse · \d\d:\d\d · server confirmed$/);

  // The desk's queue shows the token under "Vitals done".
  await login(page, DESK);
  await page.goto(`/m/fd/queue?sel=${visit.id}`);
  await expect(page.locator('[data-column="vitals"]')).toContainText(visit.token);
});

test("A4 offline: the batch waits on the device as 'not synced' and is stored when back online", async ({ page, request }) => {
  const visit = await rahimaVisit(request);
  await login(page, NURSE);
  await page.goto(`/m/fd/vitals?enc=${visit.id}`);
  await page.getByRole("textbox", { name: "Pulse" }).fill("88");
  await page.context().setOffline(true);
  await expect(page.getByText("Offline — vitals stay on this device; the doctor cannot see them yet.")).toBeVisible();
  await page.getByRole("button", { name: "Save vitals" }).click();
  await expect(page.getByTestId("vitals-stamp")).toHaveText("Saved on this device, not on the server · syncs when back online");
  await page.context().setOffline(false);
  // The outbox replays with the same Idempotency-Key; the server then has the batch.
  await expect.poll(async () => {
    const r = await page.request.get(`/api/v1/encounters/${visit.id}/vitals`);
    return ((await r.json()) as { current: { observations: { code: string; value: number }[] } | null }).current?.observations.find((o) => o.code === "pulse")?.value ?? null;
  }, { timeout: 15_000 }).toBe(88);
});

test("A4 / clinical review: glucose that may be in mg/dL needs a re-checked tick; °C in the °F box gets a unit message", async ({ page, request }) => {
  const visit = await rahimaVisit(request);
  await login(page, NURSE);
  await page.goto(`/m/fd/vitals?enc=${visit.id}`);
  await page.getByRole("textbox", { name: "Temperature" }).fill("38.5");
  await expect(card(page, "temp")).toContainText("Looks like °C — enter °F");
  await page.getByRole("textbox", { name: "Temperature" }).fill("");
  await page.getByRole("textbox", { name: "Blood glucose" }).fill("180");
  await expect(card(page, "rbs")).toContainText("Looks like mg/dL — enter mmol/L");
  await page.getByRole("textbox", { name: "Blood glucose" }).fill("32");
  const save = page.getByRole("button", { name: "Save vitals" });
  await expect(page.getByTestId("vitals-summary")).toHaveText("Re-check the marked value and tick to confirm");
  await expect(save).toBeDisabled();
  await card(page, "rbs").getByRole("checkbox", { name: "I re-checked this value — it is correct" }).check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByTestId("vitals-stamp")).toContainText("server confirmed");
});

test("A4: the doctor cannot open the vitals station (role)", async ({ page }) => {
  await login(page, "01799000002");
  await page.goto("/m/fd/vitals");
  await expect(page.getByText(/No access|Permission/i).first()).toBeVisible();
});
