import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
/* Journey B, walkthrough B5–B6 on the ward (ADR 0016) on the real stack, in the seeded E2E Lite Hospital at 1440 px. Each
   run has its own ward and patient (set up through the API: the admin's ward, the desk's direct admission, the
   surgeon's signed round note, an indent the pharmacist issues), so a handover never meets an earlier run's.
   B5: "due dose, two scans, Given; Held needs reason" — Record stays locked until the wristband and the medicine label
   are scanned; a scan that is not this patient's band is refused as a mismatch; held needs a reason and no scan;
   "scanner not working" with a reason, flagged on the record and on the owner's exceptions. Then the wristband reprint
   (asks why), intake & output, the doctor's care task ticked by the nurse, and the shift handover: reviewed, signed by
   the outgoing nurse, accepted by another nurse, who then holds the ward. Issue #1 (the banner is this patient). */
const NURSE2 = "01798000007", NURSE1 = "01798000004", SURGEON = "01798000005", DESK = "01798000001", ADMIN = "01798000010", PHARM = "01798000011", OWNER = "01798000009";
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
async function post<T = Record<string, any>>(request: APIRequestContext, url: string, data: object, status = [200, 201]): Promise<T> {
  const r = await request.post("/api" + url, { headers: key(), data }); expect(status, `${url} ${r.status()} ${await r.text()}`).toContain(r.status()); return (await r.json()) as T;
}
async function getJ<T = Record<string, any>>(request: APIRequestContext, url: string): Promise<T> { const r = await request.get("/api" + url); expect(r.ok(), await r.text()).toBe(true); return (await r.json()) as T; }
const dhakaHHMM = (min: number) => new Date(Date.now() + 6 * 3600_000 + min * 60_000).toISOString().slice(11, 16);

type Ctx = { wardId: string; wardName: string; encounterId: string; facilityNo: string; nameEn: string };
let ctx: Ctx;
/** A ward of its own, one patient admitted to it, ceftriaxone (two slots) and PRN IV paracetamol signed, ward stock issued. */
async function setupWard(request: APIRequestContext): Promise<Ctx> {
  await as(request, ADMIN);
  const wardName = `HO${RUN}`;
  await post(request, "/v1/admin/wards", { name: wardName, beds: 2, bedClass: "General" });
  await as(request, DESK);
  const nameEn = `Ward Journey ${RUN}`;
  const p = await post(request, "/v1/patients", { nameBn: "ওয়ার্ড রোগী", nameEn, sex: "female", dobMode: "dob", dob: "12/03/1980", phone: `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: false });
  const beds = (await getJ(request, "/v1/ipd/beds")).wards.find((w: { name: string }) => w.name === wardName).beds;
  const adm = await post(request, "/v1/ipd/admissions", { patientId: p.patient.id, admittingDoctorId: "u_e2l_surgeon", department: "surgery", diagnosis: "Cellulitis of the leg", bedClass: "General", bedId: beds[0].id, guardian: { name: "রাশেদা ইসলাম", relationship: "husband", phone: "01811223355" }, consents: ["general", "financial", "guardian-id"] });
  const encounterId = adm.encounter.id as string, wardId = beds[0].ward.id as string;
  await as(request, SURGEON);
  const open = await post(request, `/v1/ipd/encounters/${encounterId}/round/open`, {});
  const r = await request.put(`/api/v1/ipd/round-notes/${open.draft.id}`, { headers: key(), data: { rev: open.draft.rev, sections: { s: "", o: "", a: "Cellulitis", p: "IV antibiotics" }, orders: [], lines: [
    { medicineKey: "ceftriaxone", route: "iv", doseText: "1 g IV", doseQty: 1, times: [dhakaHHMM(3), dhakaHHMM(6)], prn: false, prnMaxPer24h: null },
    { medicineKey: "paracetamol-iv", route: "iv", doseText: "1 g IV over 15 min", doseQty: 1, times: [], prn: true, prnMaxPer24h: 4 },
  ] } });
  expect(r.ok(), await r.text()).toBe(true);
  await post(request, `/v1/ipd/round-notes/${open.draft.id}/sign`, { rev: (await r.json()).draft.rev, pin: "1234" });
  await as(request, NURSE2);
  const ind = await post(request, `/v1/nursing/wards/${wardId}/indents`, { lines: [{ medicineKey: "ceftriaxone", qty: 4 }, { medicineKey: "paracetamol-iv", qty: 2 }] });
  await as(request, PHARM);
  await post(request, `/v1/pharmacy/indents/${ind.id}/issue`, { lines: ind.lines.map((l: { id: string; requested: number }) => ({ lineId: l.id, qty: l.requested })) });
  return { wardId, wardName, encounterId, facilityNo: p.patient.facilityNo, nameEn };
}
async function codes(request: APIRequestContext) {
  await as(request, NURSE2);
  const band = (await post(request, `/v1/nursing/encounters/${ctx.encounterId}/wristband`, { reason: "journey: the band to scan" })).code as string;
  const stock = await getJ(request, `/v1/nursing/wards/${ctx.wardId}/stock`);
  const label = (k: string) => stock.items.find((i: { medicineKey: string }) => i.medicineKey === k).batches[0].label as string;
  return { band, label };
}
async function scan(page: Page, band: string, med?: string) {
  const dlg = page.getByTestId("dose-dialog");
  await dlg.getByTestId("scan-band-input").fill(band); await dlg.getByTestId("scan-band-input").press("Enter");
  if (med) { await dlg.getByTestId("scan-med-input").fill(med); await dlg.getByTestId("scan-med-input").press("Enter"); }
}
const ticks = async (page: Page) => { for (const c of ["patient", "drug", "dose", "route", "time"]) await page.getByTestId("dose-dialog").locator(`[data-check="${c}"]`).check(); };

test.describe.configure({ mode: "serial" });
test.describe("Journey B5–B6: scans, intake/output, care tasks, the shift handover", () => {
  test.beforeEach(({}, info) => { info.setTimeout(180_000); });
  test.beforeAll(async ({ request }) => { ctx = await setupWard(request); });

  test("B5: Record locked until the wristband and the medicine label are scanned; a wrong band is a mismatch; held needs a reason", async ({ page, request }) => {
    const c = await codes(request);
    await login(page, NURSE2);
    await page.goto(`/m/nur/mar?enc=${ctx.encounterId}`);
    const cef = page.locator('[data-order="ceftriaxone"]');
    await expect(cef).toBeVisible();
    await expect(page.locator(".pt-banner")).toContainText(ctx.facilityNo); // #1
    const first = cef.locator("[data-slot]:not([disabled])").first();
    const firstAt = await first.getAttribute("data-slot-at");
    await first.click();
    const dlg = page.getByTestId("dose-dialog");
    await ticks(page);
    await expect(dlg.getByTestId("dose-record")).toBeDisabled();
    await expect(dlg.locator('[data-blocker="band_required"]')).toBeVisible();
    await expect(dlg.locator('[data-blocker="med_required"]')).toBeVisible();
    // a code that is not this patient's band: refused by the server, cleared, shown as a mismatch
    await scan(page, c.band.replace(/\.[^.]+$/, ".AAAAAAAAAAAAAAAAAAAAAA"), c.label("ceftriaxone"));
    await expect(dlg.getByTestId("dose-record")).toBeEnabled();
    if (await dlg.getByTestId("dose-reason").isVisible()) await dlg.getByTestId("dose-reason").fill("Given at the round, early");
    await dlg.getByTestId("dose-record").click();
    await expect(dlg.locator('[data-blocker="band_mismatch"]')).toBeVisible();
    await expect(dlg.getByTestId("scan-band")).toHaveAttribute("data-scanned", "0");
    // the right band: given, with the batch scanned
    await scan(page, c.band);
    await ticks(page);
    await dlg.getByTestId("dose-record").click();
    await expect(dlg).toHaveCount(0);
    await expect(cef.locator(`[data-slot-at="${firstAt}"]`)).toHaveAttribute("data-slot-state", "given");
    // held: no scans, but a reason
    await cef.locator("[data-slot]:not([disabled])").first().click();
    await dlg.getByRole("radio", { name: "Held" }).click();
    await expect(dlg.getByTestId("scans")).toHaveCount(0);
    await expect(dlg.getByTestId("dose-record")).toBeDisabled();
    await dlg.getByTestId("dose-reason").fill("Patient in theatre for debridement");
    await dlg.getByTestId("dose-record").click();
    await expect(dlg).toHaveCount(0);
    await expect(cef.locator('[data-slot-state="held"]')).toHaveCount(1);
  });

  test("B5: 'scanner not working' — a reason, flagged on the record and on the owner's exceptions; the wristband reprint asks why", async ({ page }) => {
    await login(page, NURSE2);
    await page.goto(`/m/nur/mar?enc=${ctx.encounterId}`);
    const pcm = page.locator('[data-order="paracetamol-iv"]');
    await pcm.getByTestId("give-prn").click();
    const dlg = page.getByTestId("dose-dialog");
    await ticks(page);
    await dlg.getByTestId("no-scanner").check();
    await dlg.getByTestId("override-reason").fill("short");
    await expect(dlg.locator('[data-blocker="override_reason"]')).toBeVisible();
    await dlg.getByTestId("override-reason").fill("Scanner battery flat, band checked by eye");
    await dlg.getByTestId("dose-record").click();
    await expect(dlg).toHaveCount(0);
    await expect(page.getByTestId("mar-history").locator("[data-dose]").filter({ hasText: "Without scans" }).first()).toBeVisible();
    // the wristband reprint (from the ward board) asks why — and retires the earlier band
    await page.goto("/m/nur/ward");
    await page.getByTestId("ward-pick").selectOption(ctx.wardId);
    const bed = page.locator(`[data-bed-patient="${ctx.facilityNo}"]`);
    await bed.getByTestId("wristband-print").click();
    await expect(bed.getByTestId("wristband-reason")).toBeVisible();
    await bed.getByTestId("wristband-reason").fill("Band soaked and torn");
    const popup = page.waitForEvent("popup");
    await bed.getByTestId("wristband-print").click();
    const w = await popup;
    await expect(w.locator(".band svg")).toBeVisible();
    await expect(w.locator(".band")).toContainText(ctx.facilityNo);
    await w.close();
    // the owner sees the override on the exceptions list
    await login(page, OWNER);
    await page.goto("/m/own/dash");
    await expect(page.locator('[data-leak="scanOverride"]')).not.toHaveAttribute("data-count", "0");
  });

  test("intake & output: quick add and a free entry; the balance; the doctor's care task ticked by the nurse", async ({ page }) => {
    await login(page, SURGEON);
    await page.goto(`/m/ipd/rounds?enc=${ctx.encounterId}`);
    const care = page.getByTestId("round-care");
    await care.getByTestId("task-text").fill("Elevate the leg and check pulses");
    await care.getByTestId("task-every").fill("4");
    await care.getByTestId("task-add").click();
    await expect(care.locator('[data-task="Elevate the leg and check pulses"]')).toBeVisible();
    await expect(care.getByTestId("task-done")).toHaveCount(0); // a nurse ticks it
    await login(page, NURSE2);
    await page.goto(`/m/nur/io?enc=${ctx.encounterId}`);
    const io = page.getByTestId("io-panel");
    await io.getByTestId("io-quick-in-oral-200").click();
    await expect(io.getByTestId("io-totals")).toHaveAttribute("data-balance", "200");
    await io.getByTestId("io-side").selectOption("out");
    await io.getByTestId("io-route").selectOption("urine");
    await io.getByTestId("io-ml").fill("450");
    await io.getByTestId("io-add").click();
    await expect(io.getByTestId("io-totals")).toHaveAttribute("data-balance", "-250");
    await page.getByRole("radio", { name: "Care plan" }).click();
    const task = page.locator('[data-task="Elevate the leg and check pulses"]');
    await task.getByTestId("task-done").click();
    await expect(page.getByTestId("tasks-done")).toContainText("Elevate the leg");
    await expect(page.locator('[data-task="Elevate the leg and check pulses"]')).toHaveCount(1); // the next one, 4 h on
  });

  test("the shift handover: every patient reviewed, signed by the outgoing nurse, accepted by another nurse who then holds the ward", async ({ page }) => {
    await login(page, NURSE2);
    await page.goto("/m/nur/handover");
    await page.getByTestId("ward-pick").selectOption(ctx.wardId);
    await page.getByTestId("ho-open").click();
    const sheet = page.getByTestId("ho-sheet");
    await expect(sheet).toHaveAttribute("data-ho-status", "draft");
    const card = sheet.locator(`[data-ho-patient="${ctx.facilityNo}"]`);
    await expect(card).toContainText("24 h balance -250 mL");
    await expect(page.getByTestId("ho-sign")).toBeDisabled();
    await card.getByTestId("sbar-s").fill("Cellulitis, afebrile today");
    await card.getByTestId("sbar-r").fill("Ceftriaxone due at the next slot; elevate the leg");
    await card.getByTestId("sbar-save").click();
    await expect(card.getByTestId("sbar-save")).toHaveCount(0); // saved on the server
    await card.getByTestId("ho-reviewed").click(); // ticks when the server confirms
    await expect(card).toHaveAttribute("data-ho-reviewed", "1");
    await page.getByTestId("ho-sign").click();
    await page.getByTestId("pin").fill("1234");
    await page.getByTestId("pin-submit").click();
    await expect(sheet).toHaveAttribute("data-ho-status", "outgoing-signed");
    // the incoming nurse accepts with her PIN
    await login(page, NURSE1);
    await page.goto("/m/nur/handover");
    await page.getByTestId("ward-pick").selectOption(ctx.wardId);
    await expect(page.getByTestId("ho-sheet")).toHaveAttribute("data-ho-status", "outgoing-signed");
    await expect(page.locator(`[data-ho-patient="${ctx.facilityNo}"]`)).toContainText("Ceftriaxone due at the next slot");
    await page.getByTestId("ho-accept-note").fill("Taken over, all patients seen");
    await page.getByTestId("ho-accept").click();
    await page.getByTestId("pin").fill("1234");
    await page.getByTestId("pin-submit").click();
    await expect(page.getByTestId("ho-sheet")).toHaveAttribute("data-ho-status", "accepted");
    await expect(page.getByTestId("ho-shift")).toContainText("On duty: Lite Nurse");
  });
});
