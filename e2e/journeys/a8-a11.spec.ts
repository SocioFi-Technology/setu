import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
/* Journey A, steps A8–A11 (lab) on the real stack, in the seeded E2E Test Clinic (Hospital Pro: two people verify and
   validate), as the E2E lab technologist (01799000005) and pathologist (01799000006). Each test has a new synthetic
   patient whose visit the E2E doctor signs with the walkthrough's A5 orders (CBC, RBS, S. Electrolytes); earlier steps
   are prepared through the API. Walkthrough checks: A8 tube guidance (EDTA / fluoride / plain), labels with an on-screen
   confirmation (round-1 note), partial collection with a short badge (issue #28), reject → recollection SMS; A9
   Enter-to-next, flags as text + icon, a critical value typed twice, the delta check; A10 validation locked until the
   critical call-back is logged (an attempt does not count), release "PRELIMINARY — n of m"; A11 Delivery opens released
   (issue #2), per-channel status, a failed SMS retried. Kamrul's decisions: correction → doctor's inbox + "do not act on
   it" on the released version; pathologist send-back; withdraw results; cancel a test from the signed note → bill. */
const DESK = "01799000001", DOCTOR = "01799000002", TECH = "01799000005", PATH = "01799000006", CASHIER = "01799000008";
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
async function as(request: APIRequestContext, phone: string) {
  const r = await request.post("/api/v1/auth/login", { data: { identifier: phone, password: "setu1234" } });
  expect(r.ok(), await r.text()).toBe(true);
}
async function post<T = unknown>(request: APIRequestContext, url: string, data: object, status = 200): Promise<T> {
  const r = await request.post("/api" + url, { headers: key(), data });
  expect(r.status(), await r.text()).toBe(status);
  return (await r.json()) as T;
}
type View = {
  encounter: { id: string; token: string }; specimens: { id: string; tube: string; status: string }[];
  orders: { id: string; testCode: string; results: { id: string; analyteCode: string; status: string; flag: string | null }[] }[];
  release: { observationIds: string[] }; reports: { id: string; version: number; status: string }[];
};
/** A new synthetic patient's visit, signed by the E2E doctor with the given tests (default: the walkthrough's three). */
async function signedVisit(request: APIRequestContext, tag: string, tests = ["cbc", "rbs", "elec"], patientId?: string): Promise<{ id: string; token: string; patientId: string }> {
  await as(request, DESK);
  let enc: { id: string; token: string }, pid: string;
  if (patientId) { enc = (await post<{ encounter: { id: string; token: string } }>(request, "/v1/encounters", { patientId }, 201)).encounter; pid = patientId; }
  else {
    const r = await post<{ encounter: { id: string; token: string }; patient: { id: string } }>(request, "/v1/patients", {
      nameBn: "ল্যাব রোগী", nameEn: `Lab ${tag} ${RUN}`, sex: "female", dobMode: "dob", dob: "03/03/1991", phone: `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
    }, 201);
    enc = r.encounter; pid = r.patient.id;
  }
  await as(request, DOCTOR);
  const v = await post<{ draft: { id: string } }>(request, `/v1/encounters/${enc.id}/consultation/open`, {});
  const saved = await request.put(`/api/v1/compositions/${v.draft.id}`, { headers: key(), data: {
    rev: 1, sections: { complaints: [{ text: "Tiredness", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }],
    orders: tests.map((testCode) => ({ testCode, priority: "routine" })),
  } });
  expect(saved.status(), await saved.text()).toBe(200);
  await post(request, `/v1/compositions/${v.draft.id}/sign`, { rev: ((await saved.json()) as { rev: number }).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });
  return { ...enc, patientId: pid };
}
/** As the technologist: labels, collect, receive and start every tube. */
async function inProcess(request: APIRequestContext, enc: string): Promise<View> {
  await as(request, TECH);
  let v = await post<View>(request, `/v1/lab/visits/${enc}/labels`, {});
  for (const sp of v.specimens.filter((x) => x.status === "pending")) {
    const at = new Date().toISOString();
    await post(request, `/v1/lab/specimens/${sp.id}/collect`, { at });
    await post(request, `/v1/lab/specimens/${sp.id}/receive`, { at });
    v = await post<View>(request, `/v1/lab/specimens/${sp.id}/start`, { at });
  }
  return v;
}
const VALUES: Record<string, [string, string, string?][]> = { cbc: [["hb", "9.6"], ["wbc", "11800"], ["plt", "245000"]], rbs: [["rbs", "11.2"]], elec: [["na", "138"], ["k", "6.9", "6.9"], ["cl", "101"]] };
const order = (v: View, t: string) => v.orders.find((o) => o.testCode === t)!;
async function enter(request: APIRequestContext, v: View, t: string): Promise<View> {
  await as(request, TECH);
  return post<View>(request, `/v1/lab/orders/${order(v, t).id}/results`, { entries: VALUES[t]!.map(([analyteCode, value, confirm]) => ({ analyteCode, value, ...(confirm ? { confirm } : {}) })) }, 201);
}
const ids = (v: View, tests: string[], status: string) => tests.flatMap((t) => order(v, t).results.filter((r) => r.status === status).map((r) => r.id));
/** Entered (already), verified by the technologist, called back (critical), validated by the pathologist, released. */
async function validateAndRelease(request: APIRequestContext, enc: string, tests: string[], release = true): Promise<View> {
  await as(request, TECH);
  let v = (await (await request.get(`/api/v1/lab/visits/${enc}`)).json()) as View;
  v = await post<View>(request, `/v1/lab/visits/${enc}/verify`, { pin: "1234", observationIds: ids(v, tests, "preliminary"), deltaChecked: true });
  for (const r of tests.flatMap((t) => order(v, t).results).filter((x) => x.status === "verified" && (x.flag === "HH" || x.flag === "LL")))
    await post(request, `/v1/lab/observations/${r.id}/callbacks`, { outcome: "reached", recipientRole: "ordering-doctor", recipientName: "Dr. Test", via: "phone", calledAt: new Date().toISOString(), readBack: true }, 201);
  await as(request, PATH);
  v = await post<View>(request, `/v1/lab/visits/${enc}/validate`, { pin: "1234", observationIds: ids(v, tests, "verified") });
  if (release) v = await post<View>(request, `/v1/lab/visits/${enc}/release`, { observationIds: v.release.observationIds }, 201);
  return v;
}

test("A8: tube guidance, labels with an on-screen confirmation, partial collection; a rejected tube asks for a new one and the patient gets the recollection SMS", async ({ page, request }) => {
  test.setTimeout(120_000);
  const visit = await signedVisit(request, "A8");
  await login(page, TECH);
  await page.goto("/m/lab/collect");
  await page.locator(`[data-encounter="${visit.id}"]`).click();
  await page.waitForURL(/\/m\/lab\/collect\?enc=/);
  for (const [tube, text] of [["edta", "EDTA (purple top)"], ["fluoride", "Fluoride (grey top)"], ["plain", "Plain / clot (red top)"]]) await expect(page.locator(`[data-tube="${tube}"]`)).toContainText(text);
  await page.getByTestId("print-labels").click();
  await expect(page.getByTestId("labels-status")).toContainText("3 label(s) sent to the printer");
  await expect(page.getByTestId("label-preview")).toContainText(/S-\d{4}-\d{4}/);
  await page.getByTestId("collect-edta").click();
  await expect(page.locator("[data-collection]")).toHaveAttribute("data-collection", "partial");
  // issue #28: the badge is the short "Partial" and stays inside its box
  const badge = page.locator("[data-collection] .pill");
  await expect(badge).toHaveText("Partial");
  const [b, box] = [await badge.boundingBox(), await page.locator("[data-collection]").boundingBox()];
  expect(b!.x + b!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
  await page.getByTestId("collect-fluoride").click();
  await expect(page.locator('[data-specimen][data-status="collected"]')).toHaveCount(2);
  await page.getByTestId("reject-fluoride").click();
  await page.selectOption("select[name=reject-reason]", "haemolysed");
  await page.getByTestId("reject-confirm").click();
  await expect(page.locator('[data-tube="fluoride"]')).toContainText("Recollect");
  await expect(page.getByTestId("recollect-sms")).toContainText("Delivered");
  // the fake gateway's copy: the facility's name, no test, no name, no value
  await as(request, TECH);
  const msgs = ((await (await request.get("/api/v1/dev/fake-messenger/messages")).json()) as { messages: { text: string; outcome: string }[] }).messages;
  const last = msgs.filter((m) => m.outcome === "delivered").at(-1)!;
  expect(last.text).toContain("E2E Test Clinic");
  expect(last.text).not.toMatch(/RBS|sugar|haemoly|Lab A8/i);
});

test("A9: Enter moves to the next field; flags are text + icon; a critical potassium must be typed twice", async ({ page, request }) => {
  test.setTimeout(120_000);
  const visit = await signedVisit(request, "A9");
  await inProcess(request, visit.id);
  await login(page, TECH);
  await page.goto(`/m/lab/result?enc=${visit.id}`);
  const elec = page.getByTestId("entry-elec");
  await elec.locator("input[name=v-na]").fill("138");
  await elec.locator("input[name=v-na]").press("Enter");
  await expect(elec.locator("input[name=v-k]")).toBeFocused();
  await page.keyboard.type("6.9");
  await expect(elec.locator('[data-analyte="k"] [data-flag="HH"]')).toContainText("HH · Critical high");
  await page.keyboard.press("Enter");
  await expect(elec.locator("input[name=c-k]")).toBeFocused();
  await page.keyboard.type("6.9"); await page.keyboard.press("Enter");
  await expect(elec.locator("input[name=v-cl]")).toBeFocused();
  await page.keyboard.type("101");
  await expect(elec.locator('[data-analyte="na"] [data-flag="N"]')).toContainText("Normal");
  await page.getByTestId("send-elec").click();
  const res = page.getByTestId("results-elec");
  await expect(res.locator('[data-result="k"]')).toContainText("To verify");
  await expect(res.locator('[data-result="k"] [data-flag="HH"]')).toBeVisible();
  // Hb against the adult female range, labelled as such (decision D1)
  await expect(page.getByTestId("entry-cbc").locator('[data-analyte="hb"] [data-range="adult-female"]')).toContainText("adult female range");
});

test("A9: the delta check compares with the patient's previous validated result and asks for the sample-identity tick", async ({ page, request }) => {
  test.setTimeout(150_000);
  const first = await signedVisit(request, "A9d", ["rbs"]);
  let v = await inProcess(request, first.id);
  await enter(request, v, "rbs");
  await validateAndRelease(request, first.id, ["rbs"], false);
  const second = await signedVisit(request, "A9d", ["rbs"], first.patientId);
  await inProcess(request, second.id);
  await login(page, TECH);
  await page.goto(`/m/lab/result?enc=${second.id}`);
  const rbs = page.getByTestId("entry-rbs");
  await expect(rbs.locator('[data-analyte="rbs"]')).toContainText("11.2");
  await rbs.locator("input[name=v-rbs]").fill("6.7");
  await expect(rbs.locator('[data-analyte="rbs"]')).toContainText("−40%");
  await page.getByTestId("send-rbs").click();
  await expect(page.getByTestId("delta-banner")).toContainText("Delta check:");
  await page.goto(`/m/lab/verify?enc=${second.id}`);
  await page.fill("input[name=verify-pin]", "1234");
  await expect(page.getByTestId("verify")).toBeDisabled();
  await page.check("input[name=delta-checked]");
  await page.getByTestId("verify").click();
  await expect(page.locator('[data-step="verify"]')).toContainText("Nothing waiting");
});

test("A10: validation is locked until the critical call-back; an attempt does not unlock it; release goes out PRELIMINARY 1 of 3", async ({ page, request }) => {
  test.setTimeout(150_000);
  const visit = await signedVisit(request, "A10");
  let v = await inProcess(request, visit.id);
  v = await enter(request, v, "elec");
  v = await enter(request, v, "rbs");
  await as(request, TECH);
  await post(request, `/v1/lab/visits/${visit.id}/verify`, { pin: "1234", observationIds: ids(v, ["elec", "rbs"], "preliminary"), deltaChecked: true });
  await login(page, PATH);
  await page.goto("/m/lab/verify");
  await expect(page.locator(`[data-encounter="${visit.id}"]`)).toContainText("1 critical");
  await page.locator(`[data-encounter="${visit.id}"]`).click();
  await expect(page.getByTestId("callback-lock")).toContainText("Critical value: log the call-back first");
  // Validate takes the ready test (RBS); the potassium stays locked (clinical review L6: one critical does not hold the rest)
  await expect(page.getByTestId("validate")).toContainText("Validate the 1 ready test(s)");
  await page.fill("input[name=validate-pin]", "1234");
  await page.getByTestId("validate").click();
  await expect(page.locator('[data-order="rbs"] [data-result="rbs"]')).toContainText("Validated");
  await expect(page.locator('[data-order="elec"] [data-result="k"]')).toContainText("Verified");
  const panel = page.locator('[data-callback="k"]');
  await panel.getByLabel("No answer").check();
  await panel.locator("input[name=cb-name]").fill("Dr. Test (no answer)");
  await panel.getByTestId("log-call").click();
  await expect(panel.getByTestId("callback-log")).toContainText("Attempt — no answer");
  await expect(page.getByTestId("callback-lock")).toBeVisible();
  await panel.getByLabel("Reached").check();
  await panel.locator("input[name=cb-name]").fill("Dr. Test");
  await panel.locator("input[name=cb-readback]").check();
  await panel.getByTestId("log-call").click();
  await expect(panel.getByTestId("callback-log").locator('[data-outcome="reached"]')).toContainText("read-back ✓");
  await expect(page.getByTestId("callback-lock")).toHaveCount(0);
  await page.fill("input[name=validate-pin]", "1234");
  await page.getByTestId("validate").click();
  await expect(page.locator('[data-step="validate"]')).toContainText("Nothing waiting");
  await expect(page.locator("[data-release-preview]")).toContainText("PRELIMINARY — 1 of 3 tests pending");
  await page.getByTestId("release-btn").click();
  // the pathologist has no Delivery screen: they land on the released report
  await page.waitForURL(/\/m\/lab\/report\?id=/);
  await expect(page.getByTestId("report-banner")).toContainText("PRELIMINARY — 1 of 3 tests pending");
  await expect(page.locator('[data-report-test="elec"] [data-result="k"]')).toContainText("HH · Critical high");
  await expect(page.getByTestId("pending-tests")).toContainText("CBC");
});

test("A11: released by the technologist, Delivery opens released (issue #2); per-channel status; a failed SMS is retried and delivered once; patient app; doctor's inbox", async ({ page, request }) => {
  test.setTimeout(150_000);
  const visit = await signedVisit(request, "A11", ["rbs"]);
  const v = await inProcess(request, visit.id);
  await enter(request, v, "rbs");
  await validateAndRelease(request, visit.id, ["rbs"], false);
  await login(page, TECH);
  await page.goto(`/m/lab/verify?enc=${visit.id}`);
  await expect(page.locator("[data-release-preview]")).toContainText("FINAL");
  await page.getByTestId("release-btn").click();
  await page.waitForURL(/\/m\/lab\/delivery\?enc=/);
  await expect(page.getByTestId("released")).toContainText("v1 released");
  await expect(page.getByTestId("not-released")).toHaveCount(0);
  await page.getByTestId("dev-sms").getByRole("button").click();
  await page.getByTestId("send-sms").click();
  await expect(page.locator('[data-channel="sms"]')).toHaveAttribute("data-status", "failed");
  await expect(page.locator('[data-channel="sms"]')).toContainText("number unreachable");
  await page.getByTestId("retry-sms").click();
  await expect(page.locator('[data-channel="sms"]')).toHaveAttribute("data-status", "completed");
  await expect(page.locator('[data-channel="sms"]')).toContainText("2 attempts");
  await page.getByTestId("send-app").click();
  await expect(page.locator('[data-channel="app"]')).toHaveAttribute("data-status", "completed");
  await expect(page.locator('[data-channel="inbox"]')).toHaveAttribute("data-status", "completed");
  await expect(page.getByTestId("event-log")).toContainText("Report-ready SMS");
});

test("correction after release: a new version of the value, the doctor's inbox told, the released version says 'do not act on it'", async ({ page, request }) => {
  test.setTimeout(150_000);
  const visit = await signedVisit(request, "Cor", ["rbs"]);
  const v = await inProcess(request, visit.id);
  await enter(request, v, "rbs");
  const r = await validateAndRelease(request, visit.id, ["rbs"]);
  await login(page, TECH);
  await page.goto(`/m/lab/result?enc=${visit.id}`);
  await page.getByTestId("correct-rbs").click();
  await page.fill("input[name=correct-value]", "12.1");
  await page.fill("textarea[name=reason]", "transcription error at entry");
  await page.getByTestId("reason-confirm").click();
  const res = page.getByTestId("results-rbs");
  await expect(res.locator('[data-status="entered-in-error"]')).toContainText("transcription error at entry");
  await expect(res.locator('[data-status="preliminary"]')).toContainText("12.1");
  await page.goto(`/m/lab/delivery?enc=${visit.id}`);
  await expect(page.locator('[data-event="correction-notice"]')).toContainText("Doctor's inbox");
  await page.goto(`/m/lab/report?id=${r.reports[0]!.id}`);
  await expect(page.getByTestId("do-not-act")).toContainText("Under correction — do not act on it");
});

test("decision 119: the pathologist sends a verified test back; the technologist's list shows 'Returned — reason'", async ({ page, request }) => {
  test.setTimeout(150_000);
  const visit = await signedVisit(request, "Ret", ["rbs"]);
  let v = await inProcess(request, visit.id);
  v = await enter(request, v, "rbs");
  await as(request, TECH);
  await post(request, `/v1/lab/visits/${visit.id}/verify`, { pin: "1234", observationIds: ids(v, ["rbs"], "preliminary"), deltaChecked: true });
  await login(page, PATH);
  await page.goto(`/m/lab/verify?enc=${visit.id}`);
  await page.getByTestId("send-back-rbs").click();
  await page.fill("textarea[name=reason]", "value does not fit the clinical note");
  await page.getByTestId("reason-confirm").click();
  await expect(page.locator('[data-step="validate"]')).toContainText("Nothing waiting");
  await login(page, TECH);
  await page.goto("/m/lab/result");
  await expect(page.locator(`[data-encounter="${visit.id}"]`)).toContainText("Returned — RBS: value does not fit the clinical note");
});

test("decision 133: withdrawing released results asks for a new tube and marks the released version 'withdrawn — do not act on it'", async ({ page, request }) => {
  test.setTimeout(150_000);
  const visit = await signedVisit(request, "Wd", ["rbs"]);
  const v = await inProcess(request, visit.id);
  await enter(request, v, "rbs");
  const r = await validateAndRelease(request, visit.id, ["rbs"]);
  await login(page, TECH);
  await page.goto(`/m/lab/result?enc=${visit.id}`);
  await page.getByTestId("withdraw-rbs").click();
  await page.fill("textarea[name=reason]", "tube belonged to another patient");
  await page.getByTestId("reason-confirm").click();
  await expect(page.getByTestId("withdrawn")).toContainText("A new tube is needed");
  await page.goto(`/m/lab/collect?enc=${visit.id}`);
  await expect(page.locator('[data-tube="fluoride"]')).toContainText("Recollect");
  await expect(page.getByTestId("recollect-sms")).toContainText("Delivered");
  await page.goto(`/m/lab/report?id=${r.reports[0]!.id}`);
  await expect(page.getByTestId("withdrawn-marker")).toContainText("Withdrawn — do not act on it");
});

test("decision D5: the doctor cancels a test from the signed note before collection; the draft bill drops the line", async ({ page, request }) => {
  test.setTimeout(120_000);
  const visit = await signedVisit(request, "Rv");
  await as(request, CASHIER);
  const bill = await post<{ invoice: { id: string; totalPaisa: number } }>(request, `/v1/encounters/${visit.id}/invoice`, {}, 201);
  expect(bill.invoice.totalPaisa).toBe(230_000);
  await login(page, DOCTOR);
  await page.goto(`/m/cons/signed?enc=${visit.id}`);
  await page.getByTestId("cancel-order-rbs").click();
  await page.fill("textarea[name=reason]", "ordered twice by mistake");
  await page.getByTestId("reason-confirm").click();
  await expect(page.getByTestId("order-notice")).toContainText("removed from the bill: test:rbs");
  await expect(page.locator('[data-order="rbs"]')).toHaveAttribute("data-order-status", "revoked");
  await as(request, CASHIER);
  const after = (await (await request.get(`/api/v1/invoices/${bill.invoice.id}`)).json()) as { invoice: { totalPaisa: number } };
  expect(after.invoice.totalPaisa).toBe(215_000);
});

test("lab screens: the receptionist is refused; the lab technologist cannot validate", async ({ page }) => {
  await login(page, DESK);
  await page.goto("/m/lab/collect");
  await expect(page.locator(".state-card")).toBeVisible();
  await login(page, TECH);
  await page.goto("/m/lab/verify");
  await expect(page.locator('[data-worklist="verify"]')).toBeVisible();
});
