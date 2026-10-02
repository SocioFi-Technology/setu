import { expect, test, type Page } from "@playwright/test";
/* Journey A, steps A1–A3 (front desk) on the real stack, with the walkthrough's clicks: receptionist Sadia at Green Life
   Clinic, Mirpur; the family that shares +880 1711-234567. Covers test-log issues #4 (no one-click link with conflicts),
   #5 (blocked save, then the queue lands on the patient just registered) and #21 (nothing clipped at 1440 px). */
const RUN = Date.now().toString(36).slice(-5);

async function login(page: Page, phone = "01711000001") {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForURL("**/"); await expect(page.locator("header.shell-top")).toBeVisible();
  // English labels and Latin digits make the assertions readable; Bangla strings are covered by the i18n tests.
  await page.getByRole("radio", { name: "EN", exact: true }).click();
  await page.getByRole("radio", { name: "0123", exact: true }).click();
}
/** Elements whose text is cut off (issue #21). */
const clipped = (page: Page, sel: string) => page.locator(sel).evaluateAll((els) =>
  els.filter((e) => { const h = e as HTMLElement; return h.offsetParent !== null && (h.scrollWidth > h.clientWidth + 1); }).map((e) => (e as HTMLElement).innerText));

test.describe("A1 search", () => {
  test("A1: the phone finds five family members with the shared-phone warning; the possible duplicate opens Compare", async ({ page }) => {
    await login(page);
    await page.goto("/m/fd/search");
    await page.getByRole("combobox", { name: "Search patient" }).fill("01711-234567");
    await expect(page.getByTestId("shared-phone")).toHaveText("5 patients use 01711-234567");
    await expect(page.getByRole("option")).toHaveCount(5);
    await expect(page.getByText("Results never merge automatically")).toBeVisible();
    await expect(page.locator(".pt-banner")).toHaveCount(0); // nobody chosen yet: no default patient in the banner
    await page.locator('[role=option][data-patient="GLC-230982"]').click();
    await expect(page.locator(".pt-banner")).toContainText("Rahima Begum");
    await page.getByRole("button", { name: "Compare" }).click();
    await page.waitForURL(/\/m\/fd\/match\?id=/);
    await expect(page.getByRole("heading", { name: "Possible match review" })).toBeVisible();
  });
  test("A1: Enter while results are still loading does nothing (never a visit on the previous search's patient)", async ({ page }) => {
    await login(page);
    await page.goto("/m/fd/search");
    const box = page.getByRole("combobox", { name: "Search patient" });
    await box.fill("karim");
    await expect(page.locator('[role=option][data-patient="GLC-220311"]')).toBeVisible();
    await box.fill("GLC-24011");
    await box.press("Enter"); // results for "karim" are still on screen; the new search has not answered yet
    await page.waitForTimeout(800);
    expect(page.url()).toContain("/m/fd/search");
  });
  test("A1: Bangla name, English name, and no match → register with the name filled in", async ({ page }) => {
    await login(page);
    await page.goto("/m/fd/search");
    const box = page.getByRole("combobox", { name: "Search patient" });
    await box.fill("রহিমা");
    await expect(page.locator('[role=option][data-patient="GLC-240117"]')).toBeVisible();
    await box.fill("karim");
    await expect(page.locator('[role=option][data-patient="GLC-220311"]')).toBeVisible();
    await box.fill(`Zubaida ${RUN}`);
    await expect(page.getByText(`No patient matches "Zubaida ${RUN}"`)).toBeVisible();
    await page.getByRole("button", { name: `Register "Zubaida ${RUN}" as new` }).click();
    await page.waitForURL(/\/m\/fd\/register/);
    await expect(page.locator("input[name=nameEn]")).toHaveValue(`Zubaida ${RUN}`);
  });
});

test.describe("A2 duplicate review", () => {
  test("A2 / issue #4: conflicting candidate has no one-click link; Link anyway needs a 10-character reason and a confirm; Undo restores", async ({ page }) => {
    await login(page);
    await page.goto("/m/fd/match?id=p_rbegum");
    const col = page.locator('th[data-candidate="GLC-240117"]');
    await expect(col).toBeVisible();
    await expect(page.locator('td[data-field="birth"][data-status="different"]').first()).toBeVisible();
    await expect(page.locator('td[data-field="phone"][data-status="same"]').first()).toBeVisible();
    // Find the action cell for Rahima Khatun's column: no "Same person — link" there.
    const idx = await page.locator("thead th").evaluateAll((ths) => ths.findIndex((t) => t.getAttribute("data-candidate") === "GLC-240117"));
    const actions = page.locator("tbody tr").last().locator("td").nth(idx);
    await expect(actions.getByRole("button", { name: "Same person — link" })).toHaveCount(0);
    await expect(actions.getByRole("button", { name: "Send for review" })).toBeVisible();
    await actions.getByRole("button", { name: "Link anyway" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toHaveText(/You are linking records with \d conflicting field/);
    await expect(dialog.locator("[data-conflict=birth]")).toBeVisible();
    await expect(dialog.locator("[data-conflict=guardian]")).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Confirm link" });
    await dialog.getByRole("textbox").fill("too short");
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("textbox").fill(`Same woman, husband confirmed ${RUN}`);
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByTestId("decision")).toContainText("Linked to Rahima Khatun (GLC-240117) with");
    await expect(page.getByTestId("decision")).toContainText(`husband confirmed ${RUN}`);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByTestId("decision")).toHaveCount(0);
    await expect(actions.getByRole("button", { name: "Link anyway" })).toBeEnabled();
  });
  test("A2: Send for review, then Undo", async ({ page }) => {
    await login(page);
    await page.goto("/m/fd/match?id=p_rbegum");
    await page.getByRole("textbox", { name: "Not sure? Reason" }).fill("guardian differs");
    await page.getByRole("button", { name: "Not sure — send for review" }).click();
    await expect(page.getByTestId("decision")).toContainText("Sent for review — an admin will check it");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByTestId("decision")).toHaveCount(0);
  });
  test("A2: child on parent's phone — family members who only share the phone are not offered as matches", async ({ page }) => {
    await login(page);
    await page.goto("/m/fd/match?id=p_sumaiya");
    await expect(page.getByText("No existing record matches")).toBeVisible();
    await page.goto("/m/fd/match?id=p_rbegum");
    await expect(page.locator("th[data-candidate]")).toHaveCount(1); // only Rahima Khatun, not the child or the grandmother
    await expect(page.locator(".pt-banner")).toContainText("58y F"); // banner follows the EN / 0123 toggles
  });
});

test.describe("A3 registration", () => {
  test("A3 / issue #5: an empty form is blocked with 7 fields; a filled form saves and the queue opens on the new token", async ({ page }) => {
    await login(page);
    await page.goto("/m/fd/register");
    await page.getByRole("button", { name: "Clear" }).click();
    await page.getByRole("button", { name: /Save & create visit/ }).click();
    await expect(page.getByTestId("error-summary")).toHaveText("7 field(s) need attention");
    await expect(page.locator("input[name=nameBn]")).toBeFocused();
    await expect(page.getByText("Enter the name in Bangla")).toBeVisible();
    expect(page.url()).toContain("/m/fd/register");

    // Date and phone checks, with Bangla digits accepted.
    await page.fill("input[name=nameBn]", "নুসরাত জাহান");
    await page.fill("input[name=nameEn]", `Nusrat Jahan ${RUN}`);
    await page.getByRole("radiogroup", { name: "Sex" }).getByRole("radio", { name: "F", exact: true }).click();
    await page.fill("input[name=dob]", "01/01/2031");
    await expect(page.getByText("Date of birth is in the future")).toBeVisible();
    await page.fill("input[name=dob]", "31/02/2000");
    await expect(page.getByText("Use DD/MM/YYYY")).toBeVisible();
    await page.fill("input[name=dob]", "১২/০৭/১৯৯২");
    await page.fill("input[name=phone]", "171123");
    await expect(page.getByText("Needs 11 digits starting 01")).toBeVisible();
    const phone = `015${String(Date.now()).slice(-8)}`;
    await page.fill("input[name=phone]", phone);
    await page.selectOption("select[name=division]", "Dhaka");
    await page.selectOption("select[name=district]", "Dhaka");
    await page.selectOption("select[name=upazila]", "Mirpur");
    await expect(page.getByTestId("error-summary")).toHaveCount(0);

    await page.getByRole("button", { name: /Save & create visit/ }).click();
    await page.waitForURL(/\/m\/fd\/queue\?sel=.+&new=1/);
    const card = page.locator("[data-token-id][aria-pressed=true]");
    await expect(card).toContainText(`Nusrat Jahan ${RUN}`);
    await expect(card).toContainText("Just registered");
    await expect(page.locator('[data-column="waiting"]')).toContainText(`Nusrat Jahan ${RUN}`);
    await expect(page.getByTestId("selected-token")).toHaveText(/^A-\d{3,}$/);
    await expect(page.locator(".pt-banner")).toContainText(`Nusrat Jahan ${RUN}`);
    await expect(page.getByTestId("queue-selected")).toBeInViewport();

    // Queue moves go through ENCOUNTER: call, then to vitals.
    await page.getByRole("button", { name: "Call" }).click();
    await expect(page.getByTestId("queue-selected")).toContainText("Called");
    await page.getByRole("button", { name: "To vitals" }).click();
    await expect(page.locator('[data-column="vitals"]')).toContainText(`Nusrat Jahan ${RUN}`);
  });
  test("A3: approximate age and an under-18 guardian rule", async ({ page }) => {
    await login(page);
    await page.goto("/m/fd/register");
    await page.fill("input[name=nameBn]", "তাহসিন");
    await page.getByRole("radiogroup", { name: "Sex" }).getByRole("radio", { name: "M", exact: true }).click();
    await page.getByRole("radiogroup", { name: "DOB or age" }).getByRole("radio", { name: "Approximate age" }).click();
    await page.fill("input[name=ageYears]", "৭");
    await page.fill("input[name=phone]", `016${String(Date.now()).slice(-8)}`);
    await page.selectOption("select[name=division]", "Dhaka");
    await page.selectOption("select[name=district]", "Dhaka");
    await page.selectOption("select[name=upazila]", "Pallabi");
    await page.getByRole("button", { name: "Save Ctrl S" }).click();
    await expect(page.getByTestId("error-summary")).toHaveText("2 field(s) need attention");
    await expect(page.getByText("Under 18 — enter the guardian's name")).toBeVisible();
    await page.fill("input[name=guardianName]", "আব্দুল করিম");
    await page.selectOption("select[name=guardianRel]", "father");
    await page.getByRole("button", { name: "Save Ctrl S" }).click();
    await expect(page.getByTestId("save-status")).toContainText(/Saved — patient no\. GLC-\d+ · server confirmed/);
  });
});

test("issue #21: nothing clipped on the front desk screens at 1440 px", async ({ page }) => {
  await login(page);
  await page.goto("/m/fd/search");
  await page.getByRole("combobox", { name: "Search patient" }).fill("01711234567");
  await expect(page.getByRole("option")).toHaveCount(5);
  // The results table must fit without a sideways scrollbar (round-3 walkthrough: the flags column was cut off).
  expect(await page.locator("#fd-results").evaluate((e) => { const c = e.parentElement!; return c.scrollWidth <= c.clientWidth + 1; })).toBe(true);
  expect(await clipped(page, ".btn, .pill")).toEqual([]);
  await page.goto("/m/fd/match?id=p_rbegum");
  await expect(page.locator("th[data-candidate]").first()).toBeVisible();
  expect(await clipped(page, ".btn, .pill")).toEqual([]);
  await page.goto("/m/fd/register");
  expect(await clipped(page, ".btn, .seg button, .pill")).toEqual([]);
  await page.goto("/m/fd/queue");
  await expect(page.getByRole("heading", { name: "Queue board" })).toBeVisible();
  expect(await clipped(page, ".btn, .pill, [data-token] b")).toEqual([]);
});
