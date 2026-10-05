import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
/* Journey B, steps B1–B2 (ADR 0014) on the real stack, in the seeded E2E Lite Hospital (Hospital Lite, 017980000xx)
   at 1440 px, with the walkthrough's clicks. B1 the ER nurse records an arrival (Farzana Akter, walk-in, bay ER-1),
   triages level 2, assigns the paediatrician (adult → prompt, issue #24) then the ER doctor; an unknown male arrives
   provisionally and lands on the desk's review queue. B2 the ER doctor places a one-tap STAT CBC (top of the lab's
   collection list with STAT), ticks a care order, signs the admit disposition with the PIN (2A-01 reserved; 2A-05
   cleaning and 2A-06 blocked cannot be picked); the admission desk completes the admission (ADM/yy/nnnn, the IPD bill
   draft). A second visit is discharged. Issues #1 (the banner is this patient) and #21 (nothing clipped). */
const DESK = "01798000001", DOCTOR = "01798000002", NURSE = "01798000004", TECH = "01798000006";
const RUN = Date.now().toString(36).slice(-4).toUpperCase();

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
async function getJ<T = Record<string, any>>(request: APIRequestContext, url: string): Promise<T> { const r = await request.get("/api" + url); expect(r.ok(), await r.text()).toBe(true); return (await r.json()) as T; }
/** A fresh synthetic patient at the desk (every run its own, so the "one open ER visit" rule never trips on a leftover). */
async function newPatient(request: APIRequestContext, tag: string, dob = "02/06/1995") {
  await as(request, DESK);
  const r = await request.post("/api/v1/patients", { headers: key(), data: { nameBn: "জরুরি রোগী", nameEn: `ER ${tag} ${RUN}`, sex: "female", dobMode: "dob", dob, phone: `018${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: false } });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).patient as { id: string; facilityNo: string; nameEn: string };
}
const clipped = (page: Page, sel: string) => page.locator(sel).evaluateAll((els) =>
  els.filter((e) => { const h = e as HTMLElement; return h.offsetParent !== null && (h.scrollWidth > h.clientWidth + 1); }).map((e) => (e as HTMLElement).innerText));
const row = (page: Page, token: string) => page.locator(`[data-er-row][data-token="${token}"]`);

test.describe("Journey B — B1 arrival and triage, B2 orders and disposition, the admission", () => {
  test.describe.configure({ mode: "serial" });
  let token = ""; let encId = ""; let patientNo = "";

  test("B1: the nurse records an arrival on bay ER-1, triages level 2, meets the paediatric prompt, assigns the ER doctor", async ({ page, request }) => {
    const p = await newPatient(request, "Triage", "02/06/1986");
    patientNo = p.facilityNo;
    await login(page, NURSE);
    await page.goto("/m/er/triage");
    await expect(page.getByRole("heading", { name: "Emergency — triage board" })).toBeVisible();
    await expect(page.getByTestId("scale-sample")).toContainText("Pending clinician sign-off (sample scale)");
    await expect(page.locator("[data-legend='1']")).toContainText("immediate");
    await expect(page.locator("[data-legend='3']")).toContainText("≤ 30 min");
    await page.getByTestId("new-arrival").click();
    await page.getByTestId("arrival-search").fill(p.facilityNo);
    await page.locator(`[role=option][data-patient="${p.facilityNo}"]`).click();
    await expect(page.getByTestId("arrival-dialog")).toContainText(`Picked: ${p.nameEn}`);
    await page.getByTestId("arrival-complaint").fill("Chest pain 40 min, sweating");
    await page.getByTestId("arrival-bay").selectOption({ label: "ER-1" });
    await page.getByTestId("arrival-submit").click();
    await expect(page.getByTestId("triage-panel")).toContainText(p.nameEn);
    await expect(page.locator(".pt-banner")).toContainText(p.nameEn); // issue #1: the banner is this patient
    await expect(page.locator(".pt-banner")).toContainText("ER · ER-1");
    const r = page.locator(`[data-er-row]`, { hasText: p.nameEn });
    token = (await r.getAttribute("data-token"))!;
    expect(token).toMatch(/^E-\d{3}$/);
    await expect(r).toHaveAttribute("data-level", "none");
    await expect(r).toContainText("Unassigned");
    await expect(r).toContainText("ER-1");
    encId = (await r.getAttribute("data-er-row"))!;
    // triage level 2 on the sample scale
    await page.getByRole("radio", { name: "2", exact: true }).click();
    await page.getByTestId("save-triage").click();
    await expect(row(page, token)).toHaveAttribute("data-level", "2");
    await expect(row(page, token)).toContainText("Level 2 · Emergent");
    await expect(page.locator("[data-legend='2']")).toContainText("· 1");
    // an adult to the paediatrician: the prompt (issue #24), then continue
    await page.getByTestId("doctor-select").selectOption("u_e2l_paed");
    await expect(page.getByTestId("paed-prompt")).toContainText("Paediatrician — the patient is 40y. Continue?");
    await expect(page.getByTestId("save-triage")).toBeDisabled();
    await page.getByTestId("paed-continue").click();
    await page.getByTestId("save-triage").click();
    await expect(row(page, token)).toContainText("Dr. Lite Paediatrics");
    // then the ER doctor takes over (no prompt)
    await page.getByTestId("doctor-select").selectOption("u_e2l_doctor");
    await page.getByTestId("save-triage").click();
    await expect(row(page, token)).toContainText("Dr. Lite Emergency");
    await expect(row(page, token)).toHaveAttribute("data-overdue", "0"); // assigned: never ⚠
    expect(await clipped(page, ".btn, .pill, th")).toEqual([]); // issue #21
  });

  test("B1: an unknown male arrives by ambulance — a provisional record, flagged on the board and sent to the desk's review queue", async ({ page, request }) => {
    await login(page, NURSE);
    await page.goto("/m/er/triage");
    await page.getByTestId("new-arrival").click();
    await page.getByRole("radio", { name: "Unknown patient" }).click();
    await page.getByRole("radio", { name: "Male", exact: true }).click();
    await page.getByTestId("unknown-age").fill("40");
    await page.getByTestId("unknown-features").fill("Scar left forearm, blue shirt");
    await page.getByRole("radio", { name: "Ambulance" }).click();
    await page.getByTestId("arrival-complaint").fill("RTA — head injury, GCS 11");
    await page.getByTestId("arrival-submit").click();
    const r = page.locator("[data-er-row]", { hasText: "Unknown male ~40y" }).first();
    await expect(r).toContainText("Provisional identity");
    await expect(page.getByTestId("triage-panel")).toContainText("Provisional identity — at the desk for review");
    await page.getByRole("radio", { name: "1", exact: true }).click();
    await page.getByTestId("save-triage").click();
    await expect(r).toContainText("Level 1 · Resuscitation");
    // the desk's review queue has the provisional record; nothing in the ER waited for it
    await as(request, DESK);
    const q = await getJ<{ items: { subject: { nameEn: string | null; identityConfidence: string }; reason: string | null }[] }>(request, "/v1/reviews/duplicates");
    const item = q.items.find((i) => i.subject.nameEn === "Unknown male ~40y" && i.reason?.startsWith("ER provisional"));
    expect(item?.subject.identityConfidence).toBe("provisional");
  });

  test("B2: the doctor places a one-tap STAT CBC (top of the lab's collection list), ticks CT head, signs the admit disposition — 2A-01 reserved, cleaning / blocked beds not pickable", async ({ page }) => {
    await login(page, DOCTOR);
    await page.goto(`/m/er/orders?enc=${encId}`);
    await expect(page.getByTestId("er-strip")).toContainText(token);
    await expect(page.locator(".pt-banner")).toContainText(patientNo);
    await page.locator('[data-order="cbc"]').click();
    await expect(page.locator('[data-order="cbc"]')).toHaveAttribute("data-order-status", "active");
    await expect(page.locator('[data-order="cbc"]')).toContainText("Ordered · STAT");
    await page.locator('[data-care="ct"]').click();
    await expect(page.locator('[data-care="ct"]')).toHaveAttribute("data-care-on", "1");
    await expect(page.getByTestId("care-sample")).toContainText("Sample list");
    // disposition: admit — the blockers show until the three fields are filled
    await page.locator('[data-disposition="admit"]').click();
    await expect(page.getByTestId("disposition-blockers")).toContainText("Ward & bed is required");
    await expect(page.getByTestId("sign-disposition")).toBeDisabled();
    await page.getByTestId("consultant-select").selectOption("u_e2l_surgeon");
    await page.getByTestId("admit-diagnosis").fill("Head injury, moderate (GCS 11) — RTA");
    await expect(page.locator('[data-bed="2A-05"]')).toHaveAttribute("data-pickable", "0");
    await expect(page.locator('[data-bed="2A-05"]')).toContainText("being cleaned");
    await expect(page.locator('[data-bed="2A-06"]')).toHaveAttribute("data-pickable", "0");
    await expect(page.locator('[data-bed="2A-06"]')).toContainText("blocked");
    await expect(page.locator('[data-bed="2A-05"]')).toBeDisabled();
    await page.locator('[data-bed="2A-01"]').click();
    await expect(page.getByTestId("disposition-blockers")).toHaveCount(0);
    await page.getByTestId("sign-disposition").click();
    await page.getByTestId("pin").fill("0000");
    await page.getByTestId("pin-sign").click();
    await expect(page.getByTestId("pin-sheet")).toContainText("Wrong PIN — 4 tries left");
    await page.getByTestId("pin").fill("1234");
    await page.getByTestId("pin-sign").click();
    await expect(page.getByTestId("disposition-signed")).toContainText("Admit · Signed by Dr. Lite Emergency");
    await expect(page.getByTestId("disposition-signed")).toContainText("Admission: waiting at the desk · 2A-01");
    await expect(page.getByTestId("sign-disposition")).toBeDisabled();
    await expect(page.locator('[data-order="rbs"]')).toBeDisabled(); // signed: no more orders
    expect(await clipped(page, ".btn, .pill")).toEqual([]);
  });

  test("B2: the lab's collection list shows the ER visit at the top with STAT", async ({ page }) => {
    await login(page, TECH);
    await page.goto("/m/lab/collect");
    const card = page.locator(`[data-lab-token="${token}"]`);
    await expect(card).toContainText("STAT");
    await expect(card).toContainText("CBC");
    // STAT visits sit above every routine one (another STAT visit may be older than ours)
    const tokens = await page.locator("[data-lab-token]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-lab-token"), /STAT/.test((e as HTMLElement).innerText)] as [string, boolean]));
    const idx = tokens.findIndex((t) => t[0] === token);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(tokens.slice(0, idx).every((t) => t[1])).toBe(true);
    await card.click();
    await expect(page.locator("[data-screen='lab/collect']")).toContainText("STAT");
  });

  test("B2 → the desk completes the admission: guardian, three consents, Admit → ADM number, bed occupied, the IPD bill draft; the ER visit is closed", async ({ page, request }) => {
    await login(page, DESK);
    await page.goto("/m/ipd/admit");
    const req = page.locator(`[data-request][data-request-patient="${patientNo}"]`);
    await expect(req).toContainText("2A-01 · Reserved");
    await req.click();
    await expect(page.locator(".pt-banner")).toContainText(patientNo);
    await expect(page.getByTestId("source-note")).toContainText("From the ER");
    await expect(page.getByTestId("admit-diagnosis")).toHaveValue("Head injury, moderate (GCS 11) — RTA");
    await expect(page.locator('[data-bed="2A-01"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-bed="2A-01"]')).toContainText("reserved for this patient");
    await expect(page.locator('[data-bed="2A-05"]')).toHaveAttribute("data-pickable", "0");
    await expect(page.getByTestId("deposit-note")).toContainText("does not block the admission");
    await expect(page.locator('[data-check="guardian"]')).toHaveAttribute("data-check-ok", "0");
    await expect(page.getByTestId("admit")).toBeDisabled();
    await page.getByTestId("guardian-name").fill("রাশেদ চৌধুরী");
    await page.getByTestId("guardian-phone").fill("+880 1711-908812");
    await expect(page.locator('[data-check="guardian"]')).toHaveAttribute("data-check-ok", "1");
    await expect(page.locator('[data-check="consents"]')).toContainText("3 consent(s) missing");
    for (const c of ["general", "financial", "guardian-id"]) await page.locator(`[data-consent="${c}"] input`).check();
    await expect(page.locator('[data-check="consents"]')).toHaveAttribute("data-check-ok", "1");
    await expect(page.locator('[data-check="deposit"]')).toContainText("Deposit — at the counter");
    await expect(page.getByTestId("admit")).toBeEnabled();
    await page.getByTestId("admit").click();
    await expect(page.getByTestId("admitted-card")).toContainText(/ADM\/\d{2}\/\d{4}/);
    await expect(page.getByTestId("admitted-card")).toContainText("2A-01");
    await expect(page.getByTestId("ipd-bill")).toContainText("IPD bill: draft");
    await expect(page.getByTestId("admitted-today")).toContainText("2A-01");
    await expect(page.locator(`[data-request][data-request-patient="${patientNo}"]`)).toHaveCount(0);
    // the server's view: the ER visit finished, the bay cleaning, the ward bed occupied by this patient
    await as(request, DESK);
    const beds = await getJ<{ wards: { beds: { name: string; state: string; patient: { facilityNo: string } | null }[] }[] }>(request, "/v1/ipd/beds");
    const all = beds.wards.flatMap((w) => w.beds);
    expect(all.find((b) => b.name === "2A-01")).toMatchObject({ state: "occupied", patient: { facilityNo: patientNo } });
    expect(all.find((b) => b.name === "ER-1")?.state).toBe("cleaning");
    await as(request, NURSE);
    const board = await getJ<{ items: { id: string; status: string; disposition: { kind: string } | null }[] }>(request, "/v1/er/board");
    expect(board.items.find((i) => i.id === encId)).toMatchObject({ status: "finished", disposition: { kind: "admit" } });
    expect(await clipped(page, ".btn, .pill")).toEqual([]);
  });

  test("B2: a discharge closes the visit the moment it is signed", async ({ page, request }) => {
    const p = await newPatient(request, "Discharge");
    await as(request, NURSE);
    const a = await request.post("/api/v1/er/arrivals", { headers: key(), data: { patientId: p.id, arrivalMode: "walk-in", complaint: "Cut finger, bleeding controlled", bayId: undefined } });
    expect(a.status(), await a.text()).toBe(201);
    const id = (await a.json()).item.id as string;
    await login(page, DOCTOR);
    await page.goto("/m/er/orders");
    await page.locator("[data-er-pick]", { hasText: p.nameEn }).click();
    await page.locator('[data-disposition="discharge"]').click();
    await page.getByTestId("advice").fill("Rest; return if bleeding restarts");
    await page.getByTestId("sign-disposition").click();
    await page.getByTestId("pin").fill("1234");
    await page.getByTestId("pin-sign").click();
    await expect(page.getByTestId("disposition-signed")).toContainText("Discharge · Signed by Dr. Lite Emergency");
    await expect(page.getByTestId("er-strip")).toContainText("Visit closed");
    await as(request, NURSE);
    const board = await getJ<{ items: { id: string; status: string }[] }>(request, "/v1/er/board");
    expect(board.items.find((i) => i.id === id)?.status).toBe("finished");
  });
});
