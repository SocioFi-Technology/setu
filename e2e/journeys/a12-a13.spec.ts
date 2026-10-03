import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
/* Journey A, steps A12–A13 on the real stack, in the seeded E2E Test Clinic, as the E2E doctor (01799000002).
   A12 (phone, @phone = 390 px; one test also at 412): the results inbox critical first, "Seen" and "Seen + tell patient"
   (decision D1: the SMS only after the server stored the acknowledgement), offline "Acknowledged — not yet synced" then
   synced, the quick consult with the red allergy strip under the name and the PIN sheet before "Sign & send" (issue
   #8), no sideways scrolling (issue #14). A13 (desktop): print preview — a draft cannot be printed ("Drafts cannot be
   printed — sign first", issue #19); a signed note prints the original, a reprint needs a reason (DUPLICATE #1); the
   QR page shows initials and medicines, no name; the lab report prints too. Earlier steps are prepared through the API. */
const DESK = "01799000001", DOCTOR = "01799000002", TECH = "01799000005", PATH = "01799000006";
const RUN = Date.now().toString(36).slice(-5);

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForURL("**/"); await expect(page.locator("header.shell-top")).toBeVisible();
  await page.getByRole("radio", { name: "EN", exact: true }).click();
  const latin = page.getByRole("radio", { name: "0123", exact: true });
  if (await latin.isVisible()) await latin.click(); // the numerals toggle is hidden below 900 px
}
const key = () => ({ "idempotency-key": crypto.randomUUID() });
async function as(request: APIRequestContext, phone: string) {
  const r = await request.post("/api/v1/auth/login", { data: { identifier: phone, password: "setu1234" } });
  expect(r.ok(), await r.text()).toBe(true);
}
async function post<T = unknown>(request: APIRequestContext, url: string, data: object, status = 200): Promise<T> {
  const r = await request.post("/api" + url, { headers: key(), data });
  expect(r.status(), await r.text()).toBe(status);
  return (await r.json()) as T;
}
type LV = { specimens: { id: string; status: string }[]; orders: { id: string; testCode: string; results: { id: string; status: string; flag: string | null }[] }[]; release: { observationIds: string[] }; reports: { id: string }[] };

/** A new synthetic patient's visit: registered, opened by the E2E doctor, a draft with the given tests; signed unless asked. */
async function visit(request: APIRequestContext, tag: string, tests: string[], o: { sign?: boolean; allergy?: string } = {}) {
  await as(request, DESK);
  const r = await post<{ encounter: { id: string; token: string }; patient: { id: string } }>(request, "/v1/patients", {
    nameBn: "ডাক্তার অ্যাপ রোগী", nameEn: `Doc ${tag} ${RUN}`, sex: "female", dobMode: "dob", dob: "03/03/1991", phone: `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
    phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
  }, 201);
  await as(request, DOCTOR);
  const v = await post<{ draft: { id: string } }>(request, `/v1/encounters/${r.encounter.id}/consultation/open`, {});
  if (o.allergy) await post(request, `/v1/patients/${r.patient.id}/allergies`, { encounterId: r.encounter.id, kind: "class", key: o.allergy, reaction: "rash", severity: "moderate" }, 201);
  const saved = await request.put(`/api/v1/compositions/${v.draft.id}`, { headers: key(), data: {
    rev: 1, sections: { complaints: [{ text: "Tiredness", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "Drink water", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }],
    orders: tests.map((testCode) => ({ testCode, priority: "routine" })),
  } });
  expect(saved.status(), await saved.text()).toBe(200);
  const rev = ((await saved.json()) as { rev: number }).rev;
  if (o.sign !== false) await post(request, `/v1/compositions/${v.draft.id}/sign`, { rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });
  return { enc: r.encounter.id, token: r.encounter.token, patient: r.patient.id, compositionId: v.draft.id };
}
/** Collected, entered, verified, called back, validated and released (the lab's part, A8–A11). */
async function released(request: APIRequestContext, enc: string, values: Record<string, [string, string, string?][]>) {
  await as(request, TECH);
  let v = await post<LV>(request, `/v1/lab/visits/${enc}/labels`, {});
  for (const sp of v.specimens.filter((x) => x.status === "pending")) for (const step of ["collect", "receive", "start"]) await post(request, `/v1/lab/specimens/${sp.id}/${step}`, { at: new Date().toISOString() });
  v = (await (await request.get(`/api/v1/lab/visits/${enc}`)).json()) as LV;
  for (const [t, entries] of Object.entries(values)) await post(request, `/v1/lab/orders/${v.orders.find((o) => o.testCode === t)!.id}/results`, { entries: entries.map(([analyteCode, value, confirm]) => ({ analyteCode, value, ...(confirm ? { confirm } : {}) })) }, 201);
  v = (await (await request.get(`/api/v1/lab/visits/${enc}`)).json()) as LV;
  v = await post<LV>(request, `/v1/lab/visits/${enc}/verify`, { pin: "1234", observationIds: v.orders.flatMap((o) => o.results.filter((x) => x.status === "preliminary").map((x) => x.id)), deltaChecked: true });
  for (const x of v.orders.flatMap((o) => o.results).filter((x) => x.flag === "HH" || x.flag === "LL"))
    await post(request, `/v1/lab/observations/${x.id}/callbacks`, { outcome: "reached", recipientRole: "ordering-doctor", recipientName: "Dr. Test", via: "phone", calledAt: new Date().toISOString(), readBack: true }, 201);
  await as(request, PATH);
  v = await post<LV>(request, `/v1/lab/visits/${enc}/validate`, { pin: "1234", observationIds: v.orders.flatMap((o) => o.results.filter((x) => x.status === "verified").map((x) => x.id)) });
  v = await post<LV>(request, `/v1/lab/visits/${enc}/release`, { observationIds: v.release.observationIds }, 201);
  return v.reports[0]!.id;
}
const noSideways = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width + 1);

test("@phone A12: the inbox lists the critical report before the high one; Seen + tell patient sends the SMS after the server; Seen alone sends none", async ({ page, request }) => {
  test.setTimeout(180_000);
  const high = await visit(request, "High", ["rbs"]);
  await released(request, high.enc, { rbs: [["rbs", "11.2"]] });
  const crit = await visit(request, "Crit", ["elec"]);
  await released(request, crit.enc, { elec: [["na", "138"], ["k", "6.9", "6.9"], ["cl", "101"]] });
  await login(page, DOCTOR);
  await page.goto("/m/doc/inbox");
  const card = (enc: string) => page.locator(`[data-inbox-item][data-kind="report-inbox"]`).filter({ hasText: enc === crit.enc ? crit.token : high.token });
  await expect(card(crit.enc)).toHaveAttribute("data-severity", "critical");
  await expect(card(high.enc)).toHaveAttribute("data-severity", "abnormal");
  const ids = await page.locator("[data-inbox-item]").evaluateAll((els) => els.map((e) => e.getAttribute("data-inbox-item")));
  expect(ids.indexOf(await card(crit.enc).getAttribute("data-inbox-item"))).toBeLessThan(ids.indexOf(await card(high.enc).getAttribute("data-inbox-item")));
  // the worst result first, with its flag as text
  await expect(card(crit.enc).locator("[data-result]").first()).toContainText("S. Potassium");
  await expect(card(crit.enc).locator('[data-flag="HH"]')).toContainText("HH · Critical high");
  await noSideways(page);
  await card(crit.enc).getByTestId("ack-tell").click();
  await expect(card(crit.enc).getByTestId("acked")).toContainText("Patient SMS: delivered");
  await expect(card(crit.enc)).toHaveAttribute("data-acked", "server");
  await card(high.enc).getByTestId("ack-seen").click();
  await expect(card(high.enc).getByTestId("acked")).toContainText("Acknowledged");
  await expect(card(high.enc).getByTestId("acked")).not.toContainText("Patient SMS");
  // the fake gateway's copy: the facility's name only
  await as(request, TECH);
  const msgs = ((await (await request.get("/api/v1/dev/fake-messenger/messages")).json()) as { messages: { text: string }[] }).messages;
  const last = msgs.at(-1)!;
  expect(last.text).toContain("Your doctor has reviewed your lab report");
  expect(last.text).not.toMatch(/Potassium|6\.9|Doc Crit/);
});

test("@phone A12 offline: Seen waits on the phone as 'not yet synced' and is stored when back online", async ({ page, request }) => {
  test.setTimeout(150_000);
  const v = await visit(request, "Off", ["rbs"]);
  await released(request, v.enc, { rbs: [["rbs", "6.1"]] });
  await login(page, DOCTOR);
  await page.goto("/m/doc/inbox");
  const card = page.locator(`[data-inbox-item][data-kind="report-inbox"]`).filter({ hasText: v.token });
  await expect(card).toHaveAttribute("data-acked", "no");
  await page.context().setOffline(true);
  await expect(page.getByTestId("doc-offline")).toBeVisible();
  await card.getByTestId("ack-seen").click();
  await expect(card.getByTestId("acked-pending")).toContainText("Acknowledged — not yet synced");
  await page.context().setOffline(false);
  await expect(card).toHaveAttribute("data-acked", "server", { timeout: 20_000 });
});

test("@phone A12 quick consult: the red allergy strip stays under the name; 'Sign & send' asks for the PIN; signed only after the server", async ({ page, request }) => {
  test.setTimeout(120_000);
  const v = await visit(request, "Rx", [], { sign: false, allergy: "penicillin" });
  await login(page, DOCTOR);
  await page.goto("/m/doc/queue");
  await page.locator(`[data-doc-token="${v.token}"]`).click();
  await page.waitForURL(/\/m\/doc\/consult\?enc=/);
  const strip = page.getByTestId("phone-head").getByTestId("allergy-strip");
  await expect(strip).toContainText("Allergy: Penicillin");
  await expect(page.getByTestId("phone-head")).toContainText(v.token);
  await noSideways(page);
  // scrolled down to the prescription, the strip is still on screen
  await page.getByText("Prescription", { exact: true }).first().scrollIntoViewIfNeeded();
  await expect(strip).toBeInViewport();
  await expect(page.getByTestId("sign-open")).toHaveText(/Sign & send/);
  await page.getByTestId("sign-open").click();
  const sheet = page.getByTestId("sign-sheet");
  await expect(sheet.locator("input[name=sign-pin]")).toBeVisible();
  await sheet.locator("input[name=sign-pin]").fill("1234");
  await sheet.getByRole("button", { name: "Sign", exact: true }).click();
  await page.waitForURL(/\/m\/doc\/consult\?enc=.*signed=1/);
  await expect(page.getByTestId("doc-signed")).toContainText("Signed · server confirmed");
  await expect(page.getByTestId("doc-rx")).toContainText("Napa");
});

test("@phone A12 doctor app fits 390 px and 412 px without sideways scrolling (issue #14)", async ({ page }) => {
  await login(page, DOCTOR);
  for (const width of [390, 412]) {
    await page.setViewportSize({ width, height: 860 });
    for (const screen of ["home", "queue", "inbox"]) {
      await page.goto(`/m/doc/${screen}`);
      await expect(page.locator(`[data-doc-screen="${screen}"]`)).toBeVisible();
      await expect(page.locator(".doc-tabs")).toBeVisible();
      await noSideways(page);
    }
  }
});

test("A13: a draft cannot be printed — sign first; the preview shows it", async ({ page, request }) => {
  const v = await visit(request, "Draft", [], { sign: false });
  await login(page, DOCTOR);
  await page.goto(`/m/cons/draft?enc=${v.enc}`);
  await page.getByTestId("draft-print-preview").click();
  const panel = page.getByTestId("print-panel-rx");
  await expect(panel).toHaveAttribute("data-blocked", "draft_not_printable");
  await expect(panel.getByTestId("print-blocked")).toHaveText("Drafts cannot be printed — sign first");
  await expect(panel.getByTestId("doc-print")).toBeDisabled();
  await expect(panel.getByTestId("doc-preview")).toBeVisible();
});

test("A13: the signed note prints the original; a reprint needs a reason and is DUPLICATE #1; the QR page shows initials and medicines, no name", async ({ page, request }) => {
  test.setTimeout(120_000);
  const v = await visit(request, "Print", ["rbs"]);
  await login(page, DOCTOR);
  await page.goto(`/m/cons/signed?enc=${v.enc}`);
  const panel = page.getByTestId("print-panel-rx");
  await panel.getByRole("radio", { name: "A4" }).click();
  await panel.getByTestId("doc-print").click();
  await expect(panel.getByTestId("doc-print-log").locator('[data-copy="0"]')).toContainText("Original");
  await expect(panel.getByTestId("doc-open-pdf")).toBeVisible();
  await expect(panel.getByTestId("doc-reprint")).toBeDisabled();
  await panel.locator("select[name=doc-reprint-reason]").selectOption("lost");
  await panel.getByTestId("doc-reprint").click();
  await expect(panel.getByTestId("doc-print-log").locator('[data-copy="1"]')).toContainText("Duplicate #1 — Lost by the patient");
  const url = await panel.getByTestId("doc-verify-url").getAttribute("href");
  expect(url).toMatch(/\/verify\/rx\/[0-9A-Z]{20}$/);
  await page.context().clearCookies();
  await page.goto(new URL(url!).pathname);
  await expect(page.getByTestId("verify-ok")).toHaveAttribute("data-status", "current");
  await expect(page.getByTestId("verify-medicines")).toContainText("Napa");
  await expect(page.getByTestId("verify-patient")).toContainText(/^D\. P\. /);
  await expect(page.locator("main")).not.toContainText(`Doc Print ${RUN}`);
  await expect(page.locator("main")).not.toContainText("5A11");
});

test("A13 / decision D10: the lab report prints with its QR; the QR page shows the values", async ({ page, request }) => {
  test.setTimeout(150_000);
  const v = await visit(request, "Lab", ["rbs"]);
  const rep = await released(request, v.enc, { rbs: [["rbs", "11.2"]] });
  await login(page, TECH);
  await page.goto(`/m/lab/report?id=${rep}`);
  const panel = page.getByTestId("print-panel-lr");
  await panel.getByTestId("doc-print").click();
  await expect(panel.getByTestId("doc-print-log").locator('[data-copy="0"]')).toContainText("Original");
  const url = await panel.getByTestId("doc-verify-url").getAttribute("href");
  await page.context().clearCookies();
  await page.goto(new URL(url!).pathname);
  await expect(page.getByTestId("verify-results").locator('[data-result="rbs"]')).toContainText("11.2");
  await expect(page.getByTestId("verify-results").locator('[data-result="rbs"]')).toContainText("H · High");
});
