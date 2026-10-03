import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
/* Journey A end to end (runbook prompt 9: "run the whole of Journey A (A1–A13) … and fix anything that breaks the
   chain"). One synthetic patient through every step, each as its own role, in the E2E Test Clinic: what one step
   produces is what the next one uses — the doctor's orders become the bill's lines, the bill is paid, the same orders
   become the lab's tubes and results, the release reaches this doctor's inbox, and this doctor prints this note. The
   steps' own screens are covered by their specs (a1-a3 … a12-a13); here the screens are checked at the hand-offs. */
const DESK = "01799000001", DOCTOR = "01799000002", NURSE = "01799000004", TECH = "01799000005", PATH = "01799000006", CASHIER = "01799000008";
const RUN = Date.now().toString(36).slice(-5);
const NAME = `Journey A ${RUN}`;

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
async function post<T = Record<string, unknown>>(request: APIRequestContext, url: string, data: object, status = 200): Promise<T> {
  const r = await request.post("/api" + url, { headers: key(), data });
  expect(r.status(), `${url}: ${await r.text()}`).toBe(status);
  return (await r.json()) as T;
}
const getJ = async <T,>(request: APIRequestContext, url: string): Promise<T> => { const r = await request.get("/api" + url); expect(r.ok(), await r.text()).toBe(true); return (await r.json()) as T; };
type LV = { specimens: { id: string; status: string }[]; orders: { id: string; testCode: string; results: { id: string; status: string; flag: string | null }[] }[]; release: { status: string; observationIds: string[] }; reports: { id: string; status: string }[] };

test("Journey A (A1–A13): one patient from the front desk to the doctor's printed prescription", async ({ page, request }) => {
  test.setTimeout(300_000);
  const phone = `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  // A1 search — no match for a new patient
  await as(request, DESK);
  const found = await getJ<{ items: unknown[] }>(request, `/v1/patients/search?q=${encodeURIComponent(NAME)}`);
  expect(found.items).toHaveLength(0);
  // A2–A3 register (no duplicate) and open the visit → token
  const reg = await post<{ patient: { id: string; facilityNo: string }; encounter: { id: string; token: string } }>(request, "/v1/patients", {
    nameBn: "জার্নি এ রোগী", nameEn: NAME, sex: "female", dobMode: "dob", dob: "12/05/1984", phone, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
  }, 201);
  const enc = reg.encounter.id, token = reg.encounter.token;
  await login(page, DESK);
  await page.goto("/m/fd/queue");
  await expect(page.getByText(token, { exact: true }).first()).toBeVisible();

  // A4 vitals (nurse) → the token moves to "vitals done"
  await as(request, NURSE);
  await post(request, `/v1/encounters/${enc}/vitals`, { values: { bpSys: 150, bpDia: 95, pulse: 88, temp: 99, spo2: 97, weight: 62 }, effectiveAt: new Date().toISOString() }, 201);

  // A5 consultation (doctor): complaints, diagnosis, the walkthrough's orders (CBC, RBS, S. Electrolytes), Napa; signed with the PIN
  await as(request, DOCTOR);
  const open = await post<{ draft: { id: string } }>(request, `/v1/encounters/${enc}/consultation/open`, {});
  const saved = await request.put(`/api/v1/compositions/${open.draft.id}`, { headers: key(), data: {
    rev: 1, sections: { complaints: [{ text: "Thirst", duration: { n: 2, unit: "m" } }, { text: "Burning micturition", duration: { n: 5, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "Drink water", followUp: "after 7 days" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }],
    orders: ["cbc", "rbs", "elec"].map((testCode) => ({ testCode, priority: "routine" })),
  } });
  expect(saved.status(), await saved.text()).toBe(200);
  await post(request, `/v1/compositions/${open.draft.id}/sign`, { rev: ((await saved.json()) as { rev: number }).rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false });

  // A6 bill (cashier): the bill is made from the signed visit — consultation + the three tests = ৳2,300; issued
  await as(request, CASHIER);
  const bill = await post<{ invoice: { id: string; rev: number; totalPaisa: number }; lines: { code?: string; nameEn: string }[] }>(request, `/v1/encounters/${enc}/invoice`, {}, 201);
  expect(bill.invoice.totalPaisa).toBe(230_000);
  const issued = await post<{ invoice: { id: string; number: string; status: string } }>(request, `/v1/invoices/${bill.invoice.id}/issue`, { rev: bill.invoice.rev });
  expect(issued.invoice.status).toBe("issued");
  // A7 payment: cash ৳2,300 from ৳2,500 → paid; a receipt
  await post(request, `/v1/invoices/${bill.invoice.id}/payments`, { method: "cash", amountPaisa: 230_000, tenderedPaisa: 250_000 }, 201);
  const after = await getJ<{ invoice: { status: string; paidPaisa: number } }>(request, `/v1/invoices/${bill.invoice.id}`);
  expect(after.invoice).toMatchObject({ status: "balanced", paidPaisa: 230_000 });
  const receipt = await post<{ receipt: { number: string } }>(request, `/v1/invoices/${bill.invoice.id}/receipts`, {}, 201);
  expect(receipt.receipt.number).toMatch(/^RCPT\/\d{2}\/\d{4}$/);

  // A8 collection: the same three orders need EDTA, fluoride and plain tubes
  await as(request, TECH);
  let v = await post<LV>(request, `/v1/lab/visits/${enc}/labels`, {});
  expect(v.orders.map((o) => o.testCode).sort()).toEqual(["cbc", "elec", "rbs"]);
  expect(v.specimens).toHaveLength(3);
  for (const sp of v.specimens) for (const step of ["collect", "receive", "start"]) await post(request, `/v1/lab/specimens/${sp.id}/${step}`, { at: new Date().toISOString() });
  // A9 results (critical potassium typed twice)
  v = await getJ<LV>(request, `/v1/lab/visits/${enc}`);
  const VALUES: Record<string, [string, string, string?][]> = { cbc: [["hb", "9.6"], ["wbc", "11800"], ["plt", "245000"]], rbs: [["rbs", "11.2"]], elec: [["na", "138"], ["k", "6.9", "6.9"], ["cl", "101"]] };
  for (const o of v.orders) await post(request, `/v1/lab/orders/${o.id}/results`, { entries: VALUES[o.testCode]!.map(([analyteCode, value, confirm]) => ({ analyteCode, value, ...(confirm ? { confirm } : {}) })) }, 201);
  // A10 technical verify, the critical call-back, clinical validation
  v = await getJ<LV>(request, `/v1/lab/visits/${enc}`);
  v = await post<LV>(request, `/v1/lab/visits/${enc}/verify`, { pin: "1234", observationIds: v.orders.flatMap((o) => o.results.map((x) => x.id)), deltaChecked: true });
  const k = v.orders.flatMap((o) => o.results).find((x) => x.flag === "HH")!;
  await post(request, `/v1/lab/observations/${k.id}/callbacks`, { outcome: "reached", recipientRole: "ordering-doctor", recipientName: "Dr. Test", via: "phone", calledAt: new Date().toISOString(), readBack: true }, 201);
  await as(request, PATH);
  v = await post<LV>(request, `/v1/lab/visits/${enc}/validate`, { pin: "1234", observationIds: v.orders.flatMap((o) => o.results.map((x) => x.id)) });
  // A11 release: every test validated → FINAL; the doctor's inbox is told
  expect(v.release.status).toBe("final");
  v = await post<LV>(request, `/v1/lab/visits/${enc}/release`, { observationIds: v.release.observationIds }, 201);
  expect(v.reports[0]!.status).toBe("final");

  // A12 the doctor on the phone: this patient's report, critical, in the inbox; "Seen + tell patient"
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, DOCTOR);
  await page.goto("/m/doc/inbox");
  const card = page.locator('[data-inbox-item][data-kind="report-inbox"]').filter({ hasText: token });
  await expect(card).toHaveAttribute("data-severity", "critical");
  await expect(card.locator('[data-flag="HH"]')).toContainText("HH · Critical high");
  await card.getByTestId("ack-tell").click();
  await expect(card.getByTestId("acked")).toContainText("Patient SMS: delivered");

  // A13 the signed note prints with its QR; the QR page shows the medicine
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/m/cons/signed?enc=${enc}`);
  const panel = page.getByTestId("print-panel-rx");
  await panel.getByTestId("doc-print").click();
  await expect(panel.getByTestId("doc-print-log").locator('[data-copy="0"]')).toContainText("Original");
  const url = await panel.getByTestId("doc-verify-url").getAttribute("href");
  await page.context().clearCookies();
  await page.goto(new URL(url!).pathname);
  await expect(page.getByTestId("verify-ok")).toHaveAttribute("data-status", "current");
  await expect(page.getByTestId("verify-medicines")).toContainText("Napa");
  await expect(page.locator("main")).not.toContainText(NAME);
});
