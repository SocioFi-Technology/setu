import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
/* Journey B, steps B4–B7 on the ward (ADR 0015) on the real stack, in the seeded E2E Lite Hospital at 1440 px, with the
   seeded inpatient Shahidul Islam (E2L-240201, Ward 3B, Dr. Lite Surgeon, seven orders started 24 h ago). B4 the ward
   nurse's board, a NEWS2 round that escalates (doctor's inbox + ward banner, the contact logged); B5 the doctor's round
   (worklist by risk, a new order signed with the PIN, an order stopped with the PIN); B6 the MAR: the stopped order
   takes no dose, a dose with the five checks, a high-alert PRN refused on a wrong witness PIN then witnessed by a
   second nurse, the patient's own supply shown distinctly, a wrong record marked entered-in-error; nursing notes; B7
   ward stock: an indent issued by the pharmacist (PIN for the controlled line) and a bed move. Offline: vitals wait in
   the outbox with "call the doctor now — not yet synced"; doses need the connection. Issues #1 (the banner is this
   patient), #7 (NEWS2 escalation reaches the doctor) and #24 (a high-alert dose needs a witness). */
const NURSE = "01798000007", NURSE1 = "01798000004", SURGEON = "01798000005", PHARM = "01798000011";
const SHAHIDUL = "E2L-240201";

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForURL("**/"); await expect(page.locator("header.shell-top")).toBeVisible();
  await page.getByRole("radio", { name: "EN", exact: true }).click();
  await page.getByRole("radio", { name: "0123", exact: true }).click();
}
async function as(request: APIRequestContext, phone: string) { const r = await request.post("/api/v1/auth/login", { data: { identifier: phone, password: "setu1234" } }); expect(r.ok(), await r.text()).toBe(true); }
async function getJ<T = Record<string, any>>(request: APIRequestContext, url: string): Promise<T> { const r = await request.get("/api" + url); expect(r.ok(), await r.text()).toBe(true); return (await r.json()) as T; }
/** Shahidul's encounter and ward, wherever the run left him. */
async function inpatient(request: APIRequestContext) {
  await as(request, NURSE);
  const { wards } = await getJ<{ wards: { id: string; name: string }[] }>(request, "/v1/nursing/wards");
  // the seed admits him to Ward 3B: look there first — the API tests add a ward of their own every run, so walking every
  // board in order took past the 3-minute budget once there were thousands
  wards.sort((a, b) => Number(b.name === "Ward 3B") - Number(a.name === "Ward 3B"));
  for (const w of wards) {
    const b = await getJ<{ beds: { bed: { name: string }; patient: { facilityNo: string } | null; encounterId: string | null }[] }>(request, `/v1/nursing/wards/${w.id}/board`);
    const hit = b.beds.find((x) => x.patient?.facilityNo === SHAHIDUL);
    if (hit) return { encounterId: hit.encounterId!, wardId: w.id, wardName: w.name, bed: hit.bed.name };
  }
  throw new Error("the seeded inpatient is not on a ward — run pnpm db:reset-e2e");
}
/** ADR 0016: what the nurse scans at the bedside — the wristband (printed through the API) and ward batch labels. */
async function bedsideCodes(request: APIRequestContext, encounterId: string, wardId: string) {
  await as(request, NURSE);
  const r = await request.post(`/api/v1/nursing/encounters/${encounterId}/wristband`, { headers: { "idempotency-key": crypto.randomUUID() }, data: { reason: "journey: band for the doses" } });
  expect(r.status(), await r.text()).toBe(201);
  const band = (await r.json()).code as string;
  // the label a nurse prints for a ward batch with stock (its digit-only code is made on first print)
  const label = async (key: string) => {
    const batch = (await getJ<{ items: { medicineKey: string; batches: { id: string; qty: number }[] }[] }>(request, `/v1/nursing/wards/${wardId}/stock`)).items.find((i) => i.medicineKey === key)!.batches.find((b) => b.qty > 0)!;
    const r = await request.post("/api/v1/nursing/labels", { headers: { "idempotency-key": crypto.randomUUID() }, data: { batchIds: [batch.id] } });
    expect(r.status(), await r.text()).toBe(200);
    return (await r.json()).items[0].code as string;
  };
  return { band, label };
}
async function scan(page: Page, band: string, med?: string) {
  const dlg = page.getByTestId("dose-dialog");
  await dlg.getByTestId("scan-band-input").fill(band); await dlg.getByTestId("scan-band-input").press("Enter");
  if (med) { await dlg.getByTestId("scan-med-input").fill(med); await dlg.getByTestId("scan-med-input").press("Enter"); }
}
async function pickWard(page: Page, wardId: string) {
  await page.goto("/m/nur/ward");
  await page.getByTestId("ward-pick").selectOption(wardId);
  await expect(page.locator(`[data-bed-patient="${SHAHIDUL}"]`)).toBeVisible({ timeout: 15_000 });
}

test.describe.configure({ mode: "serial" });
test.describe("Journey B4–B7: the patient on the ward", () => {
  test.beforeEach(({}, info) => { info.setTimeout(180_000); });

  test("B4 the ward board and a NEWS2 round that escalates to the doctor; the contact logged", async ({ page, request }) => {
    const ip = await inpatient(request);
    await login(page, NURSE);
    await pickWard(page, ip.wardId);
    const card = page.locator(`[data-bed-patient="${SHAHIDUL}"]`);
    await expect(card).toContainText("Shahidul Islam");
    await expect(card).toContainText("Dr. Lite Surgeon");
    await expect(card.locator("[data-allergies]")).toBeVisible();
    // vitals from the card: NEWS2 worked out live, scale 1
    await card.getByTestId("open-vitals").click();
    await expect(page.locator("[data-testid=vitals-form]")).toBeVisible();
    await expect(page.locator(".pt-banner")).toContainText(SHAHIDUL); // #1
    await page.fill("input[name=rr]", "24");
    await page.fill("input[name=spo2]", "93");
    await page.fill("input[name=sbp]", "98");
    await page.fill("input[name=dbp]", "60");
    await page.fill("input[name=pulse]", "118");
    await page.fill("input[name=temp]", "101.5");
    await page.getByRole("radio", { name: "A · Alert" }).click();
    // RR 24 → 2, SpO₂ 93 → 2, air 0, SBP 98 → 2, pulse 118 → 2, 38.6 °C → 1, alert 0 = 9
    await expect(page.getByTestId("news2-live")).toHaveAttribute("data-news2-live", "9");
    await page.getByTestId("save-vitals").click();
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-save", "saved");
    await expect(page.getByTestId("escalated")).toBeVisible();
    // the ward banner; log the doctor's contact
    await pickWard(page, ip.wardId);
    const banner = page.getByTestId("escalation-banner").filter({ hasText: "Shahidul" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("NEWS2 9");
    await banner.getByTestId("log-inform").click();
    await page.fill("input[name=spokeTo]", "Dr. Lite Surgeon (phone)");
    await page.fill("textarea[name=instruction]", "IV fluids, repeat obs in 30 min, will review");
    await page.getByTestId("inform-save").click();
    await expect(banner).toHaveAttribute("data-escalation-status", "doctor-informed");
  });

  test("B5 the doctor: the escalation in the inbox (#7), the round worklist by risk, a new order signed, an order stopped", async ({ page, request }) => {
    const ip = await inpatient(request);
    await login(page, SURGEON);
    await page.goto("/m/doc/inbox");
    const item = page.locator('[data-kind="news2-escalation"]').filter({ hasText: "Shahidul" }).first();
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute("data-severity", "critical");
    await expect(item.getByTestId("news2-escalation")).toContainText("NEWS2 9");
    // escalation reach: the doctor acknowledges it in the app (a nurse's logged call is not an acknowledgement)
    await item.getByTestId("ack-seen").click();
    await expect(item).toHaveAttribute("data-acked", "server");
    await page.goto("/m/ipd/rounds");
    await expect(page.locator(`[data-round-patient="${SHAHIDUL}"]`)).toBeVisible();
    await page.locator(`[data-round-patient="${SHAHIDUL}"]`).click();
    await expect(page.getByTestId("overnight")).toContainText("NEWS2 9");
    await expect(page.locator(".pt-banner")).toContainText(SHAHIDUL); // #1
    // stop metronidazole: a reason, then the doctor's PIN
    const metro = page.locator('[data-active-order="metronidazole"]');
    await metro.getByTestId("stop-order").click();
    await page.getByTestId("stop-reason").fill("Afebrile 48 h, cultures negative");
    await page.getByTestId("stop-confirm").click();
    await page.getByTestId("pin").fill("1234");
    await page.getByTestId("pin-submit").click();
    await expect(page.locator('[data-active-order="metronidazole"]')).toHaveCount(0);
    // the round note with a new order
    if (await page.getByTestId("open-round").isVisible()) await page.getByTestId("open-round").click();
    await expect(page.getByTestId("round-editor")).toBeVisible();
    await page.getByTestId("soap-s").fill("Feels better, mild pain at the wound");
    await page.getByTestId("soap-a").fill("Post-op day 2, febrile episode settling");
    await page.getByTestId("soap-p").fill("Continue ceftriaxone; IV fluids 8-hourly; obs 4-hourly");
    await page.getByTestId("add-line").click();
    const ln = page.locator("[data-line]").last();
    await ln.getByTestId("line-medicine").selectOption("paracetamol-iv");
    await ln.getByTestId("line-route").selectOption("iv");
    await ln.getByTestId("line-dose").fill("1 g IV over 15 min");
    await ln.getByTestId("line-qty").fill("1");
    await ln.getByTestId("line-times").fill("06:00, 14:00, 22:00");
    await page.getByTestId("sign-round").click();
    await page.getByTestId("pin").fill("1234");
    await page.getByTestId("pin-submit").click();
    // the A5 checks on signing: IV paracetamol duplicates the PRN Napa (paracetamol) — not signed, the line says why
    await expect(ln.locator('[data-sign-warning="same-medicine"]')).toBeVisible();
    await expect(page.getByTestId("round-error")).toContainText("not signed");
    await ln.getByRole("button", { name: "Remove" }).click();
    await page.getByTestId("add-line").click();
    const ns = page.locator("[data-line]").last();
    await ns.getByTestId("line-medicine").selectOption("ns");
    await ns.getByTestId("line-route").selectOption("iv");
    await ns.getByTestId("line-dose").fill("1 L IV over 8 h");
    await ns.getByTestId("line-qty").fill("1");
    await ns.getByTestId("line-times").fill("06:00, 14:00, 22:00");
    await page.getByTestId("sign-round").click();
    await page.getByTestId("pin").fill("1234");
    await page.getByTestId("pin-submit").click();
    await expect(page.getByTestId("open-round")).toBeVisible();
    await expect(page.locator('[data-active-order="ns"]')).toBeVisible();
    await expect(page.locator('[data-signed-line="ns"]').first()).toBeVisible();
    void ip;
  });

  test("B6 the MAR: the stopped order takes no dose; five checks; a high-alert PRN needs a witness (#24); the patient's own supply; entered-in-error; notes", async ({ page, request }) => {
    const ip = await inpatient(request);
    const codes = await bedsideCodes(request, ip.encounterId, ip.wardId);
    await login(page, NURSE);
    await page.goto(`/m/nur/mar?enc=${ip.encounterId}`);
    await expect(page.locator("[data-order]").first()).toBeVisible();
    await expect(page.locator(".pt-banner")).toContainText(SHAHIDUL); // #1
    // stopped: struck through, no slot can be picked
    const metro = page.locator('[data-order="metronidazole"][data-order-status="stopped"]');
    await expect(metro).toBeVisible();
    await expect(metro.getByTestId("order-stopped")).toContainText("Afebrile");
    await expect(metro.locator("[data-slot]")).toHaveCount(0);
    // ceftriaxone: the first open slot, the five checks (Record stays disabled until all are ticked)
    const cef = page.locator('[data-order="ceftriaxone"]');
    const slot = cef.locator('[data-slot]:not([disabled])').first();
    const slotAt = await slot.getAttribute("data-slot-at");
    await slot.click();
    const dlg = page.getByTestId("dose-dialog");
    await expect(dlg).toBeVisible();
    // walkthrough B5: Record stays locked until the wristband and the medicine are scanned
    await expect(dlg.locator('[data-blocker="band_required"]')).toBeVisible();
    await scan(page, codes.band, await codes.label("ceftriaxone"));
    await expect(dlg.locator('[data-blocker="band_required"]')).toHaveCount(0);
    for (const c of ["patient", "drug", "dose", "route"]) await dlg.locator(`[data-check="${c}"]`).check();
    await expect(dlg.getByTestId("dose-record")).toBeDisabled();
    await expect(dlg.locator('[data-blocker="checks_incomplete"]')).toBeVisible();
    await dlg.locator('[data-check="time"]').check();
    if (await dlg.getByTestId("dose-reason").isVisible()) await dlg.getByTestId("dose-reason").fill("Given at the round, outside the hour window");
    await dlg.getByTestId("dose-record").click();
    await expect(dlg).toHaveCount(0);
    await expect(cef.locator(`[data-slot-at="${slotAt}"]`)).toHaveAttribute("data-slot-state", "given");
    await expect(cef.locator(`[data-slot-at="${slotAt}"]`)).toBeDisabled(); // no double dose from the screen
    // morphine PRN: high-alert + controlled → a witness; the giver is not offered; a wrong PIN is refused
    const mor = page.locator('[data-order="morphine"]');
    await mor.getByTestId("give-prn").click();
    await expect(dlg.getByTestId("witness")).toBeVisible();
    await expect(dlg.getByTestId("no-override")).toBeVisible(); // no "scanner not working" for a controlled drug
    await scan(page, codes.band, await codes.label("morphine"));
    for (const c of ["patient", "drug", "dose", "route", "time"]) await dlg.locator(`[data-check="${c}"]`).check();
    await expect(dlg.getByTestId("dose-record")).toBeDisabled();
    await expect(dlg.getByTestId("witness-pick").locator("option", { hasText: "Lite Nurse Two" })).toHaveCount(0);
    await dlg.getByTestId("witness-pick").selectOption("u_e2l_nurse");
    await dlg.getByTestId("witness-pin").fill("0000");
    await dlg.getByTestId("dose-record").click();
    await expect(dlg.getByTestId("dose-error")).toContainText("Wrong PIN");
    await dlg.getByTestId("witness-pin").fill("1234");
    await dlg.getByTestId("dose-record").click();
    await expect(dlg).toHaveCount(0);
    await expect(mor.locator("[data-prn-count]")).toHaveAttribute("data-prn-count", "1");
    // insulin (high-alert, multi-dose): no dose until a vial is opened; the amount given is recorded
    const ins = page.locator('[data-order="insulin"]');
    await ins.locator("[data-slot]:not([disabled])").first().click();
    for (const c of ["patient", "drug", "dose", "route", "time"]) await dlg.locator(`[data-check="${c}"]`).check();
    await expect(dlg.locator('[data-blocker="vial_required"]')).toBeVisible();
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await ins.getByTestId("open-vial").click();
    await page.getByTestId("vial-confirm").click();
    await expect(ins.getByTestId("vial")).toContainText("Opened");
    const insSlot = ins.locator("[data-slot]:not([disabled])").first();
    const insAt = await insSlot.getAttribute("data-slot-at");
    await insSlot.click();
    await scan(page, codes.band, await codes.label("insulin"));
    for (const c of ["patient", "drug", "dose", "route", "time"]) await dlg.locator(`[data-check="${c}"]`).check();
    await expect(dlg.locator('[data-blocker="amount_required"]')).toBeVisible();
    await dlg.getByTestId("amount-given").fill("4 IU");
    if (await dlg.getByTestId("dose-reason").isVisible()) await dlg.getByTestId("dose-reason").fill("CBG 11.2 at the night round");
    await dlg.getByTestId("witness-pick").selectOption("u_e2l_nurse");
    await dlg.getByTestId("witness-pin").fill("1234");
    await dlg.getByTestId("dose-record").click();
    await expect(dlg).toHaveCount(0);
    await expect(ins.locator(`[data-slot-at="${insAt}"]`)).toHaveAttribute("data-slot-state", "given");
    await expect(ins.locator(`[data-slot-at="${insAt}"]`)).toContainText("4 IU");
    // Napa PRN from the patient's own supply: shown distinctly
    const napa = page.locator('[data-order="napa"]');
    await napa.getByTestId("give-prn").click();
    await dlg.getByRole("radio", { name: "Patient's own supply" }).click();
    await scan(page, codes.band); // the patient's own supply: the wristband only
    for (const c of ["patient", "drug", "dose", "route", "time"]) await dlg.locator(`[data-check="${c}"]`).check();
    await dlg.getByTestId("dose-record").click();
    await expect(dlg).toHaveCount(0);
    const hist = page.getByTestId("mar-history");
    const own = hist.locator("[data-dose]").filter({ hasText: "Napa" }).filter({ hasText: "Patient's own" }).first();
    await expect(own).toBeVisible();
    // a wrong record: entered-in-error with a reason — kept, struck through
    await own.getByRole("button", { name: "Mark entered in error" }).click();
    await own.locator("textarea[name=errorReason]").fill("Recorded against the wrong PRN line");
    await own.getByTestId("dose-error-confirm").click();
    await expect(hist.locator('[data-dose-status="entered-in-error"]').filter({ hasText: "Napa" }).first()).toBeVisible();
    // a ward-stock dose marked entered-in-error: "was the stock drawn?" — "No" puts the vial back on the ward
    const cefRec = hist.locator("[data-dose]").filter({ hasText: "Ceftriaxone" }).filter({ hasNotText: "Patient's own" }).first();
    const stockBefore = Number(await cef.locator("[data-ward-stock]").getAttribute("data-ward-stock"));
    await cefRec.getByRole("button", { name: "Mark entered in error" }).click();
    await cefRec.locator("textarea[name=errorReason]").fill("Charted on the wrong slot");
    await expect(cefRec.getByTestId("dose-error-confirm")).toBeDisabled(); // the question must be answered
    await cefRec.getByRole("radio", { name: "No — back to the ward" }).click();
    await cefRec.getByTestId("dose-error-confirm").click();
    await expect(hist.locator('[data-dose-status="entered-in-error"]').filter({ hasText: "Ceftriaxone" }).first()).toContainText("1 returned");
    await expect(cef.locator("[data-ward-stock]")).toHaveAttribute("data-ward-stock", String(stockBefore + 1));
    // nursing notes: append-only
    await page.goto(`/m/nur/io?enc=${ip.encounterId}&tab=notes`);
    await page.getByTestId("note-text").fill("Wound dressing changed, clean and dry. Patient ambulating with support.");
    await page.getByTestId("add-note").click();
    await expect(page.locator('[data-note-status="active"]').filter({ hasText: "Wound dressing changed" }).first()).toBeVisible();
  });

  test("B7 ward stock: an indent issued by the pharmacist (PIN for the controlled line); a bed move", async ({ page, request }) => {
    const ip = await inpatient(request);
    await login(page, NURSE);
    await pickWard(page, ip.wardId);
    // the doctor's in-app acknowledgement shows on the ward banner
    await expect(page.getByTestId("escalation-banner").filter({ hasText: "Shahidul" })).toContainText("Acknowledged by Dr. Lite Surgeon");
    await expect(page.getByTestId("escalation-banner").filter({ hasText: "Shahidul" })).toHaveAttribute("data-unacknowledged", "0");
    // the errored ceftriaxone dose's vial came back and is listed for the next count
    await expect(page.getByTestId("ward-returns")).toContainText("Charted on the wrong slot");
    const before = Number(await page.locator('[data-stock="ceftriaxone"]').getAttribute("data-stock-qty"));
    await page.getByTestId("indent-new").click();
    const form = page.getByTestId("indent-form");
    await form.getByTestId("indent-medicine").first().selectOption("ceftriaxone");
    await form.getByTestId("indent-qty").first().fill("4");
    await form.getByRole("button", { name: "Add line" }).click();
    await form.getByTestId("indent-medicine").nth(1).selectOption("morphine");
    await form.getByTestId("indent-qty").nth(1).fill("2");
    await form.getByTestId("indent-send").click();
    const sent = page.locator('[data-indent][data-indent-status="requested"]').first();
    await expect(sent).toBeVisible();
    const number = (await sent.getAttribute("data-indent"))!;
    // the pharmacist issues: the controlled line needs the PIN
    await login(page, PHARM);
    await page.goto("/m/ph/indent");
    const card = page.locator(`[data-indent="${number}"]`);
    await expect(card).toBeVisible();
    await card.getByTestId("issue").click();
    await page.getByTestId("pin").fill("1234");
    await page.getByTestId("pin-submit").click();
    await expect(page.locator(`[data-indent="${number}"]`)).toHaveCount(0); // left the open list
    await page.getByRole("radio", { name: "Issued" }).click();
    await expect(page.locator(`[data-indent="${number}"][data-indent-status="issued"]`)).toBeVisible();
    // back on the ward: the stock came, the indent says issued
    await login(page, NURSE);
    await pickWard(page, ip.wardId);
    await expect(page.locator('[data-stock="ceftriaxone"]')).toHaveAttribute("data-stock-qty", String(before + 4));
    await expect(page.locator(`[data-indent="${number}"]`)).toHaveAttribute("data-indent-status", "issued");
    // a bed move (two legs in one go): the old bed goes to cleaning
    await page.locator(`[data-bed-patient="${SHAHIDUL}"]`).getByTestId("open-move").click();
    await expect(page.getByTestId("move-form")).toBeVisible();
    const target = page.locator(`[data-testid=bed-picker] [data-pickable="1"][data-bed^="${ip.bed.split("-")[0]}-"]`).first(); // a free bed on the same ward
    const targetName = (await target.getAttribute("data-bed"))!;
    await target.click();
    await page.getByTestId("move-reason").fill("Closer to the nursing station for observation");
    const moved = page.waitForResponse((r) => r.url().includes("/transfer") && r.request().method() === "POST");
    await page.getByTestId("move-submit").click();
    expect((await moved).ok()).toBe(true);
    await pickWard(page, ip.wardId);
    await expect(page.locator(`[data-bed="${targetName}"][data-bed-patient="${SHAHIDUL}"]`)).toBeVisible();
    await expect(page.locator(`[data-bed="${ip.bed}"]`)).toHaveAttribute("data-bed-state", "cleaning");
  });

  test("offline: vitals wait in the outbox with 'call the doctor now'; doses need the connection", async ({ page, request, context }) => {
    const ip = await inpatient(request);
    await login(page, NURSE1);
    await page.goto(`/m/nur/vitals?enc=${ip.encounterId}`);
    await expect(page.getByTestId("vitals-form")).toBeVisible();
    await context.setOffline(true);
    await page.fill("input[name=rr]", "26");
    await page.fill("input[name=spo2]", "91");
    await page.fill("input[name=pulse]", "124");
    await expect(page.getByTestId("news2-live")).toHaveAttribute("data-news2-live", "8");
    await page.getByTestId("save-vitals").click();
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-save", "queued");
    await expect(page.getByTestId("call-doctor-offline")).toContainText("Call the doctor now");
    await context.setOffline(false);
    await page.goto(`/m/nur/mar?enc=${ip.encounterId}`);
    await expect(page.locator("[data-order]").first()).toBeVisible();
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.getByTestId("mar-offline")).toBeVisible();
    await expect(page.locator('[data-order="napa"]').getByTestId("give-prn")).toBeDisabled();
    await context.setOffline(false);
  });
});
