import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
/* Journey B end to end (ADR 0014–0018): one synthetic patient from ER arrival to discharge in the E2E Lite Hospital —
   what one step produces is what the next one uses. The ER nurse records the arrival and triages; the ER doctor signs
   "admit" to a ward bed under the surgeon; the desk completes the admission; the ward records vitals and the surgeon's
   round orders a CBC; the cashier takes a deposit larger than the stay will cost; the surgeon orders the discharge; the
   pharmacist clears; the cashier issues the final bill — balanced, the excess a refund the owner approves and the
   counter pays back; the surgeon signs the summary and prints it (A4, QR); the take-home medicine is on the pharmacy's
   queue; the nurse records "patient left": the visit finishes, the bed goes to cleaning with its note, "Bed ready" frees
   it; the summary's QR check shows no clinical content. Each step's own screens are covered by their specs. */
const DESK = "01798000001", ER_DOCTOR = "01798000002", NURSE = "01798000004", SURGEON = "01798000005", CASHIER = "01798000008", OWNER = "01798000009", ADMIN = "01798000010", PHARM = "01798000011";
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const NAME = `Journey B ${RUN}`;

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

test("Journey B (B1–B12): one patient from ER arrival to discharge, with the final bill and the summary", async ({ page, request }) => {
  test.setTimeout(480_000);
  // a ward of this run's own (one General bed)
  await as(request, ADMIN);
  const ward = `JB${RUN}`;
  await post(request, "/v1/admin/wards", { name: ward, beds: 1, bedClass: "General" });

  // B1 — the desk registers, the ER nurse records the arrival, triages level 2, assigns the ER doctor
  await as(request, DESK);
  const reg = await post(request, "/v1/patients", { nameBn: "জার্নি বি রোগী", nameEn: NAME, sex: "female", dobMode: "dob", dob: "02/05/1990", phone: `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: false });
  const patientNo = reg.patient.facilityNo as string;
  await as(request, NURSE);
  const arr = await post(request, "/v1/er/arrivals", { patientId: reg.patient.id, arrivalMode: "walk-in", broughtBy: "Husband", complaint: "Lower abdominal pain and fever since yesterday" });
  const er = arr.item.id as string;
  await post(request, `/v1/er/encounters/${er}/triage`, { level: 2 });
  await post(request, `/v1/er/encounters/${er}/assign`, { doctorId: "u_e2l_doctor" });

  // B2 — the ER doctor signs "admit" (PIN) to the run's ward bed under the surgeon
  await as(request, ER_DOCTOR);
  const ev = await getJ(request, `/v1/er/encounters/${er}`);
  const bed = ev.beds.find((b: { ward: string; pickable: boolean }) => b.ward === ward && b.pickable);
  await post(request, `/v1/er/encounters/${er}/disposition`, { rev: ev.note.rev, pin: "1234", disposition: { kind: "admit", bedId: bed.id, consultantId: "u_e2l_surgeon", diagnosis: "Ovarian cyst, torsion suspected" } });

  // B2 → the desk completes the admission on screen
  await login(page, DESK);
  await page.goto("/m/ipd/admit");
  await page.locator(`[data-request][data-request-patient="${patientNo}"]`).click();
  await expect(page.getByTestId("source-note")).toContainText("From the ER");
  await page.getByTestId("guardian-name").fill("রাশেদ চৌধুরী");
  await page.getByTestId("guardian-phone").fill("01711908812");
  for (const c of ["general", "financial", "guardian-id"]) await page.locator(`[data-consent="${c}"] input`).check();
  await page.getByTestId("admit").click();
  await expect(page.getByTestId("admitted-card")).toContainText(/ADM\/\d{2}\/\d{4}/);
  const admNo = ((await page.getByTestId("admitted-card").textContent()) ?? "").match(/ADM\/\d{2}\/\d{4}/)![0];
  await as(request, CASHIER);
  const adm = (await getJ(request, "/v1/ipd/bills")).items.find((x: { number: string }) => x.number === admNo);
  const admissionId = adm.admissionId as string;

  // B3–B7 — the ward: vitals; the surgeon's round orders a CBC (it reaches the running bill)
  await as(request, SURGEON);
  const encId = (await getJ(request, `/v1/ipd/admissions/${admissionId}/summary`)).admission.encounterId as string;
  await as(request, NURSE);
  await post(request, `/v1/nursing/encounters/${encId}/vitals`, { values: { bpSys: 122, bpDia: 78, pulse: 88, temp: 99, spo2: 98, rr: 16, consciousness: "A", onOxygen: false }, effectiveAt: new Date().toISOString() });
  await as(request, SURGEON);
  const open = await post(request, `/v1/ipd/encounters/${encId}/round/open`, {});
  const saved = await request.put(`/api/v1/ipd/round-notes/${open.draft.id}`, { headers: key(), data: { rev: open.draft.rev, sections: { s: "Pain less", o: "Afebrile", a: "Settling on antibiotics", p: "CBC; home tomorrow" }, lines: [], orders: [{ testCode: "cbc", priority: "routine" }] } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await post(request, `/v1/ipd/round-notes/${open.draft.id}/sign`, { rev: (await saved.json()).draft.rev, pin: "1234" });

  // B8 — the cashier takes a card deposit of ৳10,000 on the running bill
  await login(page, CASHIER);
  await page.goto(`/m/bill/ipd?adm=${admissionId}`);
  await expect(page.locator('[data-line^="order:"]').first()).toBeVisible();
  await page.getByTestId("take-deposit").click();
  await page.getByRole("radio", { name: "Card" }).click();
  await page.getByTestId("deposit-amount").fill("10000");
  await page.getByTestId("deposit-reference").fill("APPR 7781");
  await page.getByTestId("deposit-submit").click();
  await expect(page.locator('[data-deposit="card"][data-status="confirmed"]')).toBeVisible();
  // the final bill waits for the doctor's record
  await expect(page.locator('[data-blocker="not_ordered"]')).toBeVisible();

  // B9 — the surgeon orders the discharge on screen
  await login(page, SURGEON);
  await page.goto(`/m/ipd/discharge?adm=${admissionId}`);
  await page.getByTestId("discharge-advice").fill("Afebrile 24 hours, pain settled — home with oral medicines");
  await page.getByTestId("discharge-order").click(); await pin(page);
  await expect(page.locator('[data-screen="ipd/discharge"][data-status="ordered"]')).toBeVisible();

  // the pharmacist clears (own medicines: none)
  await login(page, PHARM);
  await page.goto("/m/ph/indent");
  await page.locator(`[data-clearance="${admNo}"]`).getByTestId("clearance-open").click();
  await page.getByTestId("done-pharmacy").click();
  await page.getByRole("radio", { name: "There were none" }).click();
  await page.getByTestId("step-continue").click(); await pin(page);
  await expect(page.locator('[data-step="pharmacy"]')).toHaveAttribute("data-step-status", "done");

  // B10 — the cashier issues the final bill: balanced, the excess a deposit-excess refund
  await login(page, CASHIER);
  await page.goto(`/m/bill/ipd?adm=${admissionId}`);
  await page.getByTestId("final-issue").click();
  await expect(page.getByTestId("final-preview")).toContainText("Deposit beyond the bill");
  await page.getByTestId("final-issue-confirm").click();
  await expect(page.getByTestId("final-card")).toHaveAttribute("data-status", "balanced");
  await expect(page.getByTestId("final-excess")).toHaveAttribute("data-status", "requested");
  await expect(page.getByTestId("final-due")).toContainText("0");
  const final = (await (await page.request.get(`/api/v1/ipd/bills/${admissionId}`)).json()).final;
  expect(final.excessPaisa).toBeGreaterThan(0);
  // the owner approves the refund (never rejected: no Reject button)
  await login(page, OWNER);
  await page.goto(`/m/bill/refund?rf=${final.excessRefund.id}`);
  await expect(page.getByTestId("rf-deposit-excess")).toBeVisible();
  await expect(page.getByTestId("rf-reject")).toHaveCount(0);
  await page.getByTestId("rf-approve").click();
  await expect(page.getByTestId("rf-status")).toContainText("Approved");
  // the counter pays it back in cash from the cashier's shift (the refunds journey covers the payout screen)
  await as(request, CASHIER);
  const sh = await getJ(request, "/v1/shifts/mine");
  if (sh.shift?.status !== "open") await post(request, "/v1/shifts", { openingFloatPaisa: 200_000 });
  const rf = await getJ(request, `/v1/refunds/${final.excessRefund.id}`);
  await post(request, `/v1/refunds/${final.excessRefund.id}/pay`, { rev: rf.refund.rev, recipient: { name: "রাশেদ চৌধুরী", phone: "01711908812", relation: "spouse" } });
  await login(page, CASHIER);
  await page.goto(`/m/bill/ipd?adm=${admissionId}`);
  await expect(page.getByTestId("final-excess")).toHaveAttribute("data-status", "paid");
  await expect(page.getByTestId("clearance").locator('[data-step="payment"]')).toHaveAttribute("data-step-status", "done");

  // B11 — the surgeon writes, signs and prints the summary
  await login(page, SURGEON);
  await page.goto(`/m/ipd/summary?adm=${admissionId}`);
  await page.getByTestId("summary-open").click();
  await page.locator('input[name="dx-search"]').fill("Cystitis");
  await page.getByRole("option", { name: /GC00/ }).click();
  await page.locator('[data-dx="GC00"] input[type=checkbox]').check();
  await page.getByTestId("sm-course").fill("Admitted from the ER with pain and fever; IV antibiotics; settled in 24 hours");
  await page.getByTestId("rx-search").fill("ace");
  await page.locator('[data-medicine="ace"]').first().click();
  await page.getByTestId("sm-fu-date").fill(tomorrow());
  await page.getByTestId("sm-fu-place").fill("Surgery OPD room 4");
  await page.locator('[data-flag="fever"] input').check();
  await page.getByTestId("sm-sign").click(); await pin(page);
  await expect(page.locator('[data-screen="ipd/summary"][data-status="signed"]')).toBeVisible();
  await expect(page.locator('[data-take-home="ace"]')).toHaveAttribute("data-status", "waiting");
  await page.getByTestId("doc-print").click();
  await expect(page.getByTestId("doc-verify-url")).toContainText("/ds/");
  const verifyUrl = (await page.getByTestId("doc-verify-url").textContent())!;

  // the take-home medicine is on the pharmacy's queue as a normal dispense
  await login(page, PHARM);
  await page.goto("/m/ph/dispense");
  await expect(page.locator(`[data-encounter="${encId}"]`).getByTestId("take-home")).toBeVisible();

  // B12 — the nurse records "patient left": discharged, the visit finished, the bed to cleaning, then ready
  await login(page, NURSE);
  await page.goto(`/m/ipd/discharge?adm=${admissionId}`);
  await page.getByTestId("done-bed-release").click(); await page.getByTestId("step-continue").click(); await pin(page);
  await expect(page.locator('[data-screen="ipd/discharge"][data-status="completed"]')).toBeVisible();
  await expect(page.getByTestId("visit-finished")).toBeVisible();
  await page.goto("/m/ipd/map");
  const card = page.locator(`[data-map-ward="${ward}"] [data-bed]`).first();
  await expect(card).toHaveAttribute("data-bed-state", "cleaning");
  await expect(card).toContainText("Discharged");
  await card.click();
  await page.getByTestId("bed-ready").click();
  await expect(card).toHaveAttribute("data-bed-state", "vacant");

  // the summary's QR check: current, no clinical content
  await page.context().clearCookies();
  await page.goto(`/verify/ds/${verifyUrl.split("/").pop()}`);
  await expect(page.getByTestId("verify-status")).toContainText("current");
  await expect(page.locator("main")).not.toContainText("Cystitis");
});
