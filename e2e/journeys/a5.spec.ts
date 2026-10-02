import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
/* Journey A, step A5 (OPD consultation) on the real stack, as the E2E doctor in the seeded E2E Test Clinic, at tablet
   width 1024 px. Walkthrough checks: allergy conflict blocks signing (screen and server); "same medicine" (Napa + Ace,
   issue #16) needs Remove or Keep both; "/" focuses the Rx search, not the global search (issue #9); the note is final
   only after the server acknowledges the PIN; an amendment is a new version and the old one shows superseded; the
   finished visit is Completed on the desk's queue. Each test has its own patient (Karim for the walkthrough, new
   synthetic patients for the rest), so it never races the A4 spec, which re-opens Rahima Khatun's visit. */
const DOCTOR = "01799000002", DOCTOR2 = "01799000003", DESK = "01799000001";
const RUN = Date.now().toString(36).slice(-5);
test.use({ viewport: { width: 1024, height: 900 } });

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForURL("**/"); await expect(page.locator("header.shell-top")).toBeVisible();
  await page.getByRole("radio", { name: "EN", exact: true }).click();
  await page.getByRole("radio", { name: "0123", exact: true }).click();
}
const deskLogin = (request: APIRequestContext) => request.post("/api/v1/auth/login", { data: { identifier: DESK, password: "setu1234" } });
/** Today's visit for a family member, opened at the desk (global setup closed the leftovers of earlier runs). */
async function visitFor(request: APIRequestContext, patientId: string): Promise<{ id: string; token: string }> {
  await deskLogin(request);
  const r = await request.post("/api/v1/encounters", { data: { patientId }, headers: { "idempotency-key": crypto.randomUUID() } });
  expect(r.status(), await r.text()).toBe(201);
  return ((await r.json()) as { encounter: { id: string; token: string } }).encounter;
}
/** A new synthetic patient registered at the desk with today's token. */
async function newPatientVisit(request: APIRequestContext, tag: string): Promise<{ id: string; token: string; patientId: string }> {
  await deskLogin(request);
  const r = await request.post("/api/v1/patients", {
    data: { nameBn: "শিলা রানী", nameEn: `Shila ${tag} ${RUN}`, sex: "female", dobMode: "dob", dob: "03/03/1991", phone: `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true },
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  expect(r.status(), await r.text()).toBe(201);
  const b = (await r.json()) as { patient: { id: string }; encounter: { id: string; token: string } };
  return { ...b.encounter, patientId: b.patient.id };
}
const sync = (page: Page) => page.getByTestId("sync-status");
const synced = (page: Page) => expect(sync(page)).toHaveAttribute("data-sync", "saved", { timeout: 10_000 });
async function addComplaint(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: "Chief complaints" });
  await box.fill(text); await box.press("Enter");
}
async function addDiagnosis(page: Page, q: string, code: string) {
  await page.getByRole("textbox", { name: "Diagnosis in Bangla or English, or a code" }).fill(q);
  await page.locator('[role=option]', { hasText: code }).click();
  await expect(page.locator(`[data-dx="${code}"]`)).toBeVisible();
}
/** "/" (outside a field) focuses the medicine search; type and Enter adds the first match. */
async function prescribe(page: Page, q: string, key: string) {
  await page.getByRole("heading", { level: 1 }).click();
  await page.keyboard.press("/");
  await expect(page.getByTestId("rx-search")).toBeFocused();
  await page.keyboard.type(q);
  await expect(page.locator(`[role=option][data-medicine="${key}"]`)).toBeVisible();
  await page.locator(`[role=option][data-medicine="${key}"]`).click();
  await expect(page.locator(`[data-rx-line="${key}"]`)).toBeVisible();
}
async function openSheet(page: Page) {
  await page.getByRole("heading", { level: 1 }).click();
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("sign-sheet")).toBeVisible();
  await expect(page.getByTestId("sign-status")).toHaveAttribute("data-phase", "ready");
}
async function signWithPin(page: Page, pin = "1234") {
  await page.locator("input[name=sign-pin]").fill(pin);
  await page.locator("input[name=sign-pin]").press("Enter");
}

test("A5 walkthrough: allergy blocks, Napa + Ace → Keep both, wrong PIN then right with the same key, amend → v1 superseded, queue Completed", async ({ page, request }) => {
  test.setTimeout(150_000);
  const visit = await visitFor(request, "e2e_p_karim");
  await login(page, DOCTOR);
  await page.goto("/m/cons/draft");
  await page.locator(`[data-cons-token="${visit.token}"]`).click();
  await page.waitForURL(/\/m\/cons\/draft\?enc=/);
  await expect(page.locator(".pt-banner")).toContainText("Abdul Karim");
  await expect(page.getByTestId("allergy-none")).toHaveText("Allergies not recorded — ask the patient");
  await expect(page.getByTestId("ai-label")).toHaveText("AI draft — review required. Suggestions only; not a diagnosis.");

  await addComplaint(page, "Fever 3d");
  await expect(page.getByTestId("complaints")).toContainText("Fever· 3 d");
  await addDiagnosis(page, "typhoid", "1A07");
  for (const t of ["cbc", "rbs", "elec"]) await page.locator(`[data-test="${t}"]`).click();
  await synced(page);

  // Record a penicillin allergy from the strip; it waits for the server, then the strip shows it.
  await page.getByRole("button", { name: "Record allergy" }).click();
  const dlg = page.getByTestId("record-allergy");
  await dlg.locator("select[name=allergy-key]").selectOption("penicillin");
  await dlg.locator("input[name=allergy-reaction]").fill("rash");
  await dlg.getByRole("radio", { name: "Severe" }).click();
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(page.locator('[data-allergy="penicillin"]')).toContainText("Penicillin · rash · Severe");
  await expect(page.locator(".pt-banner")).toContainText("Penicillin");

  // Issue #9: "/" focuses the Rx search (not the global search). Amoxicillin (Moxacil) is blocked on screen…
  await prescribe(page, "moxa", "moxacil");
  const allergyWarning = page.locator('[data-rx-line="moxacil"] [data-warning="allergy"]');
  await expect(allergyWarning).toHaveAttribute("data-blocking", "true");
  await expect(allergyWarning).toContainText("Allergy: Penicillin — Moxacil matches it. Remove it.");
  await expect(allergyWarning.getByRole("button", { name: "Keep both" })).toHaveCount(0);
  await expect(page.getByTestId("sign-open")).toContainText("Resolve 1 warning(s)");
  await synced(page);
  // …on the sign sheet…
  await openSheet(page);
  await expect(page.getByTestId("sign-blockers")).toContainText("Moxacil: Allergy: Penicillin");
  await page.locator("input[name=sign-pin]").fill("1234");
  await expect(page.getByTestId("sign-sheet").getByRole("button", { name: "Sign", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  // …and by the server, which re-reads the medicines and allergies (422, nothing signed).
  const v0 = await (await page.request.get(`/api/v1/encounters/${visit.id}/consultation`)).json();
  const refused = await page.request.post(`/api/v1/compositions/${v0.draft.id}/sign`, { data: { rev: v0.draft.rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, headers: { "idempotency-key": crypto.randomUUID() } });
  expect(refused.status()).toBe(422);
  expect(JSON.stringify(await refused.json())).toContain('"kind":"allergy"');
  await allergyWarning.getByRole("button", { name: "Remove" }).click();
  await expect(page.locator('[data-rx-line="moxacil"]')).toHaveCount(0);

  // Issue #16: Napa + Ace is the same medicine (paracetamol): blocked until Keep both.
  await prescribe(page, "napa", "napa");
  await prescribe(page, "ace", "ace");
  const same = page.locator('[data-rx-line="ace"] [data-warning="same-medicine"]');
  await expect(same).toHaveAttribute("data-blocking", "true");
  await expect(same).toContainText("Same medicine: Napa also contains Paracetamol. Remove one or keep both.");
  await same.getByRole("button", { name: "Keep both" }).click();
  await expect(same).toHaveAttribute("data-blocking", "false");
  await expect(same).toContainText("Kept both — Paracetamol twice (your choice)");
  await synced(page);

  // Sign: a wrong PIN, then the right one, with one Idempotency-Key; "Signed" only after the server's 200.
  const keys: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/sign") && r.method() === "POST") keys.push(r.headers()["idempotency-key"] ?? ""); });
  await openSheet(page);
  await expect(page.getByTestId("sign-blockers")).toHaveCount(0);
  await signWithPin(page, "9999");
  await expect(page.getByTestId("sign-error")).toHaveText(/^Wrong PIN — \d tries left$/);
  await expect(page.getByTestId("sign-status")).toHaveText("Still a draft — not signed");
  await expect(page.getByTestId("signed-stamp")).toHaveCount(0);
  await signWithPin(page, "1234");
  await page.waitForURL(/\/m\/cons\/signed\?enc=/);
  await expect(page.getByTestId("signed-stamp")).toContainText(/Signed · server confirmed \d\d\/\d\d\/\d{4} \d\d:\d\d/);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const note = page.getByTestId("note-view");
  await expect(note).toHaveAttribute("data-status", "final");
  for (const k of ["napa", "ace"]) await expect(note.locator(`[data-rx-line="${k}"]`)).toBeVisible();
  for (const t of ["cbc", "rbs", "elec"]) await expect(note.locator(`[data-order="${t}"]`)).toBeVisible();

  // Amend: v2 is a new version; signing it supersedes v1, which stays in the history.
  await page.getByRole("button", { name: "Amend", exact: true }).click();
  await page.getByTestId("amend-dialog").locator("textarea[name=amend-reason]").fill("Napa course 3 → 5 days");
  await page.getByRole("button", { name: "Start amendment" }).click();
  await page.waitForURL(/\/m\/cons\/draft\?enc=/);
  await expect(page.getByTestId("amending")).toContainText("Amending signed v1 — reason: Napa course 3 → 5 days");
  await page.locator('[data-rx-line="napa"] input[name=rx-days]').fill("5");
  await synced(page);
  await openSheet(page);
  await signWithPin(page);
  await page.waitForURL(/\/m\/cons\/signed\?enc=/);
  await expect(page.getByTestId("note-view")).toHaveAttribute("data-status", "amended");
  await expect(page.getByTestId("note-view")).toHaveAttribute("data-version", "2");
  await page.getByRole("button", { name: "Version history" }).click();
  await expect(page.locator('[data-version="1"]')).toHaveAttribute("data-status", "superseded");
  await expect(page.locator('[data-version="1"]')).toContainText("Replaced by v2");
  await expect(page.locator('[data-version="2"]')).toHaveAttribute("data-status", "amended");
  await expect(page.locator('[data-version="2"]')).toContainText("Reason: Napa course 3 → 5 days");

  // Decision 31: signing finished the visit; the desk sees it under Completed.
  await login(page, DESK);
  await page.goto(`/m/fd/queue?sel=${visit.id}`);
  await expect(page.locator('[data-column="done"]')).toContainText(visit.token);
});

test("A5 rule 1: 'Not yet synced' until the server answers a save; 'Waiting for server — still a draft' until it answers the sign", async ({ page, request }) => {
  test.setTimeout(90_000);
  const visit = await newPatientVisit(request, "sync");
  await login(page, DOCTOR);
  await page.goto(`/m/cons/draft?enc=${visit.id}`);
  await synced(page);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route("**/api/v1/compositions/*", async (route) => { if (route.request().method() === "PUT") await held; await route.continue(); });
  await addComplaint(page, "Cough 5d");
  await expect(sync(page)).toContainText(/not yet synced/i);
  await page.waitForTimeout(2500); // the save is on the wire and the server has not answered
  await expect(sync(page)).toContainText(/not yet synced/i);
  await expect(sync(page)).not.toContainText("Saved");
  release();
  await synced(page);
  await page.unroute("**/api/v1/compositions/*");

  await addDiagnosis(page, "pharyngitis", "CA02");
  await synced(page);
  let releaseSign!: () => void;
  const signHeld = new Promise<void>((r) => { releaseSign = r; });
  await page.route("**/api/v1/compositions/*/sign", async (route) => { await signHeld; await route.continue(); });
  await openSheet(page);
  await signWithPin(page);
  await expect(page.getByTestId("sign-status")).toHaveText("Waiting for server — still a draft");
  await page.waitForTimeout(1500);
  expect(page.url()).toContain("/m/cons/draft");
  await expect(page.getByTestId("signed-stamp")).toHaveCount(0);
  await expect(page.getByTestId("sign-sheet").getByRole("button", { name: "Sign", exact: true })).toBeDisabled();
  releaseSign();
  await page.waitForURL(/\/m\/cons\/signed\?enc=/);
  await expect(page.getByTestId("signed-stamp")).toContainText("Signed · server confirmed");
});

test("A5 offline: the draft stays on this device, signing waits for the connection, and the draft syncs when back online", async ({ page, request }) => {
  const visit = await newPatientVisit(request, "offline");
  await login(page, DOCTOR);
  await page.goto(`/m/cons/draft?enc=${visit.id}`);
  await synced(page);
  await page.context().setOffline(true);
  await expect(page.getByTestId("cons-offline")).toBeVisible();
  await addComplaint(page, `Headache ${RUN} 2d`);
  await expect(sync(page)).toHaveAttribute("data-sync", "device", { timeout: 5_000 });
  await expect(sync(page)).toHaveText("Draft on this device — not sent");
  await expect(page.getByTestId("sign-open")).toBeDisabled();
  await expect(page.getByTestId("sign-open")).toContainText("Sign when back online");
  await expect(page.getByRole("button", { name: "Record allergy" })).toBeDisabled();
  await expect(page.getByTestId("ai-panel").getByRole("button", { name: "Draft note from the record" })).toBeDisabled();
  // Kept per user (owner = tenant:facility:user), never as a pending sign.
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("setu.cons.drafts") ?? "[]") as { owner: string }[]);
  expect(stored).toHaveLength(1);
  expect(stored[0]!.owner).toMatch(/:u_e2e_doctor$/);
  await page.context().setOffline(false);
  await synced(page);
  const v = await (await page.request.get(`/api/v1/encounters/${visit.id}/consultation`)).json();
  expect(JSON.stringify(v.draft.sections.complaints)).toContain(`Headache ${RUN}`);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("setu.cons.drafts") ?? "[]").length)).toBe(0);
});

test("A5: device drafts are cleared at sign-out (shared PC)", async ({ page, request }) => {
  const visit = await newPatientVisit(request, "signout");
  await login(page, DOCTOR);
  await page.goto(`/m/cons/draft?enc=${visit.id}`);
  await synced(page);
  // The network drops for saves only: the draft is kept on the device.
  await page.route("**/api/v1/compositions/*", (route) => (route.request().method() === "PUT" ? route.abort("internetdisconnected") : route.continue()));
  await addComplaint(page, "Back pain 1w");
  await expect(sync(page)).toHaveAttribute("data-sync", "device", { timeout: 5_000 });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("setu.cons.drafts") ?? "[]").length)).toBe(1);
  // Clinical review A5: sign-out tries to send it first, then asks before deleting what could not be sent.
  await page.getByRole("button", { name: "Sign out" }).click();
  const ask = page.getByTestId("unsent-drafts");
  await expect(ask).toContainText("1 consultation note draft(s) on this device have not reached the server. Signing out deletes them.");
  await ask.getByRole("button", { name: "Stay signed in" }).click();
  await expect(page.getByTestId("rx-search")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByTestId("unsent-drafts").getByRole("button", { name: "Sign out and delete them" }).click();
  await page.waitForURL("**/login**");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("setu.cons.drafts") ?? "[]").length)).toBe(0);
});

test("A5 conflict: typing over a newer server version is kept as a device copy; loading it asks first and replaces the server's", async ({ page, request }) => {
  const visit = await newPatientVisit(request, "conflict");
  await login(page, DOCTOR);
  await page.goto(`/m/cons/draft?enc=${visit.id}`);
  await synced(page);
  // The note changes somewhere else (another tab of the same doctor) while this screen still holds the old rev.
  const v = await (await page.request.get(`/api/v1/encounters/${visit.id}/consultation`)).json();
  const other = { sections: { ...v.draft.sections, history: "Written in the other tab" }, sectionSources: {}, diagnoses: [], medications: [], orders: [] };
  expect((await page.request.put(`/api/v1/compositions/${v.draft.id}`, { data: { rev: v.draft.rev, ...other }, headers: { "idempotency-key": crypto.randomUUID() } })).status()).toBe(200);
  await addComplaint(page, "Typed on this screen 2d");
  const conflict = page.getByTestId("device-conflict");
  await expect(conflict).toContainText("did not reach the server — the note changed elsewhere");
  await expect(page.getByRole("textbox", { name: "History" })).toHaveValue("Written in the other tab"); // the server's version is shown
  await expect(page.getByTestId("complaints")).not.toContainText("Typed on this screen");
  await conflict.getByRole("button", { name: "Load the device copy into the note" }).click();
  const confirm = page.getByTestId("device-load-confirm");
  await expect(confirm).toContainText("Parts that differ: Chief complaints, History");
  await confirm.getByRole("button", { name: "Replace with the device copy" }).click();
  await expect(page.getByTestId("complaints")).toContainText("Typed on this screen");
  await expect.poll(async () => JSON.stringify((await (await page.request.get(`/api/v1/encounters/${visit.id}/consultation`)).json()).draft.sections.complaints), { timeout: 10_000 })
    .toContain("Typed on this screen");
  await synced(page);
  // The device copy went only after the server accepted it.
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("setu.cons.drafts") ?? "[]").length)).toBe(0);
});

test("A5 / clinical review: a 0+0+0 dose blocks signing", async ({ page, request }) => {
  const visit = await newPatientVisit(request, "dose");
  await login(page, DOCTOR);
  await page.goto(`/m/cons/draft?enc=${visit.id}`);
  await prescribe(page, "napa", "napa");
  await page.locator('[data-rx-line="napa"] input[name=rx-dose]').fill("0+0+0");
  await expect(page.locator('[data-rx-line="napa"] [data-warning="dose-invalid"]')).toHaveAttribute("data-blocking", "true");
  await expect(page.getByTestId("sign-open")).toContainText(/Resolve \d warning\(s\)/);
});

test("A5 AI panel: text inserted from the draft must be reviewed before signing; the scribe consent tick is disabled", async ({ page, request }) => {
  test.setTimeout(60_000);
  const visit = await newPatientVisit(request, "ai");
  await login(page, DOCTOR);
  await page.goto(`/m/cons/draft?enc=${visit.id}`);
  const scribe = page.getByTestId("scribe-consent");
  await expect(scribe.getByRole("checkbox")).toBeDisabled();
  await expect(scribe.getByRole("checkbox")).not.toBeChecked();
  await expect(scribe).toContainText("Not available yet");
  await addComplaint(page, "Burning micturition 5d");
  await addDiagnosis(page, "UTI", "GC08");
  await synced(page);
  await page.getByRole("button", { name: "Draft note from the record" }).click();
  const proposal = page.locator('[data-ai-proposal="history"]');
  await expect(proposal).toContainText("Presents with Burning micturition for 5 day(s).");
  await proposal.getByRole("button", { name: "Insert into note" }).click();
  await expect(page.locator('[data-section="2"]')).toContainText("From AI draft — review");
  await expect(page.getByRole("textbox", { name: "History" })).toHaveValue(/Presents with Burning micturition/);
  await synced(page);
  await openSheet(page);
  await page.locator("input[name=sign-pin]").fill("1234");
  const signBtn = page.getByTestId("sign-sheet").getByRole("button", { name: "Sign", exact: true });
  await expect(signBtn).toBeDisabled();
  await page.getByRole("checkbox", { name: "I reviewed the text inserted from the AI draft" }).check();
  await expect(signBtn).toBeEnabled();
  await signBtn.click();
  await page.waitForURL(/\/m\/cons\/signed\?enc=/);
  await expect(page.getByTestId("signed-stamp")).toContainText("Signed · server confirmed");
});

test("A5 allergy strip: Mark entered in error keeps the allergy on the record and stops it blocking", async ({ page, request }) => {
  const visit = await newPatientVisit(request, "allergy");
  await login(page, DOCTOR);
  await page.goto(`/m/cons/draft?enc=${visit.id}`);
  await page.getByRole("button", { name: "Record allergy" }).click();
  const dlg = page.getByTestId("record-allergy");
  await dlg.getByRole("radio", { name: "Substance" }).click();
  await dlg.locator("select[name=allergy-key]").selectOption("amoxicillin");
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(page.locator('[data-allergy="amoxicillin"]')).toBeVisible();
  await prescribe(page, "fimox", "fimoxyl");
  await expect(page.locator('[data-rx-line="fimoxyl"] [data-warning="allergy"]')).toHaveAttribute("data-blocking", "true");
  await page.getByRole("button", { name: "Entered in error: Amoxicillin" }).click();
  const mark = page.getByTestId("mark-allergy-error");
  const confirm = mark.getByRole("button", { name: "Mark entered in error" });
  await mark.locator("textarea[name=allergy-error-reason]").fill("wrong");
  await expect(confirm).toBeDisabled(); // a reason of at least 10 characters
  await mark.locator("textarea[name=allergy-error-reason]").fill("Recorded on the wrong patient");
  await confirm.click();
  await expect(page.getByTestId("allergy-errored")).toHaveText("Entered in error: Amoxicillin");
  await expect(page.getByTestId("allergy-none")).toBeVisible();
  await expect(page.locator('[data-rx-line="fimoxyl"] [data-warning="allergy"]')).toHaveCount(0);
  // Hands-on test 03/10/2026: repeated entries are grouped; the dialogs have inner padding like the rest of the app.
  await page.getByRole("button", { name: "Record allergy" }).click();
  expect(await page.getByTestId("record-allergy").evaluate((e) => getComputedStyle(e).paddingLeft)).toBe("20px");
  await dlg.getByRole("radio", { name: "Substance" }).click();
  await dlg.locator("select[name=allergy-key]").selectOption("amoxicillin");
  await dlg.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Entered in error: Amoxicillin" }).click();
  await mark.locator("textarea[name=allergy-error-reason]").fill("Recorded on the wrong patient again");
  await mark.getByRole("button", { name: "Mark entered in error" }).click();
  await expect(page.getByTestId("allergy-errored")).toHaveText("Entered in error: Amoxicillin ×2");
});

test("A5 hands-on regression: the doctor's list shows waiting patients before completed visits", async ({ page, request }) => {
  const done = await newPatientVisit(request, "listdone");
  await login(page, DOCTOR);
  await page.goto(`/m/cons/draft?enc=${done.id}`);
  await addComplaint(page, "Cold 2d");
  await addDiagnosis(page, "pharyngitis", "CA02");
  await synced(page);
  await openSheet(page);
  await signWithPin(page);
  await page.waitForURL(/\/m\/cons\/signed\?enc=/);
  const waiting = await newPatientVisit(request, "listwait"); // a later token than the finished one
  await page.goto("/m/cons/draft");
  await expect(page.locator(`[data-cons-token="${waiting.token}"]`)).toBeVisible();
  const order = await page.locator("[data-cons-token]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.status));
  const firstFinished = order.indexOf("finished");
  const lastOpen = Math.max(order.lastIndexOf("arrived"), order.lastIndexOf("triaged"), order.lastIndexOf("in-progress"));
  expect(firstFinished).toBeGreaterThan(lastOpen);
});

test("A5 care relationship: another doctor cannot open a visit assigned to the first", async ({ page, request }) => {
  const visit = await newPatientVisit(request, "care");
  await login(page, DOCTOR);
  await page.goto(`/m/cons/draft?enc=${visit.id}`);
  await synced(page);
  await login(page, DOCTOR2);
  await page.goto(`/m/cons/draft?enc=${visit.id}`);
  await expect(page.getByTestId("cons-denied")).toHaveText("No care relationship with this patient");
});

test("A5 tablet 1024 px: the note fits without sideways scrolling, in both languages", async ({ page, request }) => {
  const visit = await newPatientVisit(request, "layout");
  await login(page, DOCTOR);
  for (const lang of ["EN", "বাং"]) {
    await page.getByRole("radio", { name: lang, exact: true }).click();
    await page.goto(`/m/cons/draft?enc=${visit.id}`);
    await expect(page.getByTestId("rx-search")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
  }
});
