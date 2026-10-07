// Local hands-on walkthrough (not a test): the final bill, the discharge summary and the bed after discharge (ADR 0018,
// B10–B12) in the E2E Lite Hospital, Bangla screens as staff see them, a screenshot per step — as the cashier, the doctor
// and the nurse. Patient 1 (normal): the surgeon records the discharge; the cashier issues the final bill (a shortfall),
// takes the rest by card and prints the receipt; the surgeon writes, signs and prints the summary; the nurse records
// "patient left" and the bed map shows cleaning → ready. Patient 2 (LAMA, with a deposit larger than the bill): the
// LAMA record, the excess refund on the bill, leaving before the summary. Patient 3: a death on the ward and "body moved".
// The owner's inpatient rows and the summary's QR check close it.
// node walk-discharge.mjs <outDir>
import { chromium, request as pwRequest } from "@playwright/test";
const OUT = process.argv[2] ?? "shots-discharge";
const BASE = process.env.STAFF_URL ?? "http://localhost:3300";
const OWNER = "01798000009", DESK = "01798000001", SURGEON = "01798000005", NURSE = "01798000004", PHARM = "01798000011", CASHIER = "01798000008", ADMIN = "01798000010";
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
let n = 0;
const api = await pwRequest.newContext({ baseURL: BASE });
const key = () => ({ "idempotency-key": crypto.randomUUID() });
async function as(phone) { const r = await api.post("/api/v1/auth/login", { data: { identifier: phone, password: "setu1234" } }); if (!r.ok()) throw new Error(await r.text()); }
async function post(url, data) { const r = await api.post("/api" + url, { headers: key(), data }); if (!r.ok()) throw new Error(url + " " + r.status() + " " + (await r.text())); return r.json(); }
async function put(url, data) { const r = await api.put("/api" + url, { headers: key(), data }); if (!r.ok()) throw new Error(url + " " + r.status() + " " + (await r.text())); return r.json(); }
async function getJ(url) { const r = await api.get("/api" + url); if (!r.ok()) throw new Error(url + " " + (await r.text())); return r.json(); }
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
async function login(phone) {
  await page.context().clearCookies();
  await page.goto(BASE + "/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForSelector("header.shell-top", { timeout: 60000 });
  await page.getByRole("radio", { name: "বাং", exact: true }).click();
  await page.getByRole("radio", { name: "০১২৩", exact: true }).click();
}
async function shot(name, full = false) { n++; const f = `${OUT}/${String(n).padStart(2, "0")}-${name}.png`; await page.waitForTimeout(900); await page.screenshot({ path: f, fullPage: full }); console.log("saved", f); }
async function pin() { await page.getByTestId("pin").fill("1234"); await page.getByTestId("pin-submit").click(); }
const tomorrow = () => new Date(Date.now() + 6 * 3600_000 + 864e5).toISOString().slice(0, 10);

await as(ADMIN);
const wardName = `ছুটি ${RUN}`;
await post("/v1/admin/wards", { name: wardName, beds: 3, bedClass: "General" });
const beds = async () => (await getJ("/v1/ipd/beds")).wards.find((w) => w.name === wardName).beds;
async function admit(nameBn, nameEn, bedIndex, deposit) {
  await as(DESK);
  const p = await post("/v1/patients", { nameBn, nameEn: `${nameEn} ${RUN}`, sex: "female", dobMode: "dob", dob: "02/05/1988", phone: `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: false });
  const b = (await beds())[bedIndex];
  const a = await post("/v1/ipd/admissions", { patientId: p.patient.id, admittingDoctorId: "u_e2l_surgeon", department: "surgery", diagnosis: "তলপেটে ব্যথা ও জ্বর", bedClass: "General", bedId: b.id,
    guardian: { name: "রাশেদ চৌধুরী", relationship: "husband", phone: "01711908812" }, consents: ["general", "financial", "guardian-id"], ...(deposit ? { deposit: { method: "card", amountPaisa: deposit, reference: "APPR 5501" } } : {}) });
  await as(SURGEON);
  const open = await post(`/v1/ipd/encounters/${a.encounter.id}/round/open`, {});
  const saved = await put(`/v1/ipd/round-notes/${open.draft.id}`, { rev: open.draft.rev, sections: { s: "ব্যথা কম", o: "জ্বর নেই", a: "উন্নতি", p: "সিবিসি" }, lines: [], orders: [{ testCode: "cbc", priority: "routine" }] });
  await post(`/v1/ipd/round-notes/${open.draft.id}/sign`, { rev: saved.draft.rev, pin: "1234" });
  return { id: a.id, encounterId: a.encounter.id, number: a.number, bed: b.name };
}
const p1 = await admit("ফারহানা ইসলাম", "Farhana Islam", 0, 0);

// ── the doctor: the record form (three kinds), then a normal discharge ──
await login(SURGEON);
await page.goto(`${BASE}/m/ipd/discharge?adm=${p1.id}`);
await page.getByTestId("discharge-advice").fill("২৪ ঘণ্টা জ্বর নেই, ব্যথা কমেছে — মুখে খাওয়ার ওষুধে বাড়ি");
await shot("doctor-record-discharge");
await page.getByRole("radio", { name: "LAMA (পরামর্শের বিরুদ্ধে ছুটি)" }).click();
await shot("doctor-record-lama-form");
await page.getByRole("radio", { name: "ওয়ার্ডে মৃত্যু" }).click();
await shot("doctor-record-death-form", true);
await page.getByRole("radio", { name: "ছুটি", exact: true }).click();
await page.getByTestId("discharge-advice").fill("২৪ ঘণ্টা জ্বর নেই, ব্যথা কমেছে — মুখে খাওয়ার ওষুধে বাড়ি");
await page.getByTestId("discharge-order").click(); await pin();
await page.locator('[data-screen="ipd/discharge"][data-status="ordered"]').waitFor();
await shot("doctor-checklist-ordered", true);

// ── the cashier: the final bill (does not wait for the pharmacy), the shortfall, the receipt ──
await login(CASHIER);
await page.goto(`${BASE}/m/bill/ipd?adm=${p1.id}`);
await page.getByTestId("final-card").waitFor();
await shot("cashier-bill-before-issue", true);
await page.getByTestId("final-issue").click();
await shot("cashier-issue-confirm", true);
await page.getByTestId("final-issue-confirm").click();
await page.locator('[data-testid="final-card"][data-status="issued"]').waitFor();
await shot("cashier-final-issued", true);
await page.getByTestId("final-pay").click();
await page.getByRole("radio", { name: "কার্ড" }).click();
await page.getByTestId("final-pay-reference").fill("APPR 9902");
await shot("cashier-pay-form");
await page.getByTestId("final-pay-submit").click();
await page.locator('[data-testid="final-card"][data-status="balanced"]').waitFor();
await page.getByTestId("final-receipt").click();
await page.getByTestId("final-receipt-number").waitFor();
await page.getByTestId("final-receipt-print").click();
await page.getByTestId("final-receipt-dialog").locator("iframe").waitFor();
await page.waitForTimeout(2500);
await shot("cashier-final-receipt");
const rcpt = (await (await api.get(`/api/v1/ipd/bills/${p1.id}`, {})).json());
void rcpt;
await page.keyboard.press("Escape");
await page.goto(`${BASE}/m/bill/ipd`);
await shot("cashier-bills-list");

// the pharmacist's clearance (API — the ward and the bill are the walk's roles)
await as(PHARM);
const d1 = await getJ(`/v1/ipd/admissions/${p1.id}/discharge`);
await post(`/v1/ipd/discharges/${d1.discharge.id}/steps/pharmacy/done`, { pin: "1234", ownMedicines: "none" });

// ── the doctor: the summary ──
await login(SURGEON);
await page.goto(`${BASE}/m/ipd/summary`);
await shot("doctor-summary-list");
await page.goto(`${BASE}/m/ipd/summary?adm=${p1.id}`);
await page.getByTestId("summary-open").click();
await page.getByTestId("sm-sign-card").waitFor();
await page.getByTestId("sm-sign").click();
await page.waitForTimeout(1200);
await shot("doctor-summary-empty-blockers", true);
await page.locator('input[name="dx-search"]').fill("Cystitis");
await page.getByRole("option", { name: /GC00/ }).click();
await page.locator('[data-dx="GC00"] input[type=checkbox]').check();
await page.getByTestId("sm-course").fill("জরুরি বিভাগ থেকে ভর্তি; শিরায় অ্যান্টিবায়োটিক; ২৪ ঘণ্টায় জ্বর নেমেছে, খাওয়া স্বাভাবিক");
await page.getByTestId("rx-search").fill("ace");
await page.locator('[data-medicine="ace"]').first().click();
await page.getByTestId("sm-fu-date").fill(tomorrow());
await page.getByTestId("sm-fu-place").fill("সার্জারি ওপিডি, কক্ষ ৪");
await page.locator('[data-flag="fever"] input').check();
await page.locator('[data-flag="pain"] input').check();
await shot("doctor-summary-filled", true);
await page.getByTestId("sm-sign").click(); await pin();
await page.locator('[data-screen="ipd/summary"][data-status="signed"]').waitFor();
await page.getByTestId("doc-print").click();
await page.getByTestId("doc-verify-url").waitFor();
await page.waitForTimeout(2500);
await shot("doctor-summary-signed-printed", true);
const verifyUrl = await page.getByTestId("doc-verify-url").textContent();

// ── the nurse: patient left → the bed to cleaning → ready ──
await login(NURSE);
await page.goto(`${BASE}/m/ipd/discharge?adm=${p1.id}`);
await shot("nurse-checklist-ready-to-leave", true);
await page.getByTestId("done-bed-release").click();
await shot("nurse-patient-left-dialog");
await page.getByTestId("step-continue").click(); await pin();
await page.locator('[data-screen="ipd/discharge"][data-status="completed"]').waitFor();
await shot("nurse-discharged");
await page.goto(`${BASE}/m/ipd/map`);
await page.locator(`[data-map-ward="${wardName}"]`).waitFor();
await page.locator(`[data-map-ward="${wardName}"] [data-bed="${p1.bed}"]`).click();
await shot("nurse-map-cleaning");
await page.getByTestId("bed-ready").click();
await page.waitForTimeout(1200);
await shot("nurse-map-ready");

// ── patient 2: LAMA, the deposit larger than the bill ──
const p2 = await admit("সালমা বেগম", "Salma Begum", 1, 1_000_000);
await login(SURGEON);
await page.goto(`${BASE}/m/ipd/discharge?adm=${p2.id}`);
await page.getByRole("radio", { name: "LAMA (পরামর্শের বিরুদ্ধে ছুটি)" }).click();
await page.getByTestId("lama-reason").fill("পরিবার ঢাকা মেডিকেলে নিয়ে যেতে চান");
await page.getByTestId("lama-risks").check(); await page.getByTestId("lama-form").check();
await page.getByTestId("lama-witness").selectOption("u_e2l_nurse");
await page.getByTestId("lama-witness-pin").fill("1234");
await shot("doctor-lama-filled");
await page.getByTestId("discharge-order").click(); await pin();
await page.locator('[data-screen="ipd/discharge"][data-status="ordered"]').waitFor();
await shot("doctor-lama-checklist", true);
await login(CASHIER);
await page.goto(`${BASE}/m/bill/ipd?adm=${p2.id}`);
await page.getByTestId("final-issue").click();
await shot("cashier-lama-excess-preview", true);
await page.getByTestId("final-issue-confirm").click();
await page.getByTestId("final-excess").waitFor();
await shot("cashier-lama-excess-refund", true);
await as(PHARM);
const d2 = await getJ(`/v1/ipd/admissions/${p2.id}/discharge`);
await post(`/v1/ipd/discharges/${d2.discharge.id}/steps/pharmacy/done`, { pin: "1234", ownMedicines: "handed-back" });
await login(NURSE);
await page.goto(`${BASE}/m/ipd/discharge?adm=${p2.id}`);
await page.getByTestId("done-bed-release").click(); await page.getByTestId("step-continue").click(); await pin();
await page.locator('[data-screen="ipd/discharge"][data-status="completed"]').waitFor();
await shot("nurse-lama-left-summary-owed", true);

// ── patient 3: a death on the ward ──
const p3 = await admit("আমিনা খাতুন", "Amina Khatun", 2, 0);
await login(SURGEON);
await page.goto(`${BASE}/m/ipd/discharge?adm=${p3.id}`);
await page.getByRole("radio", { name: "ওয়ার্ডে মৃত্যু" }).click();
await page.getByTestId("death-cause").fill("সেপটিক শক");
for (const c of ["certificate", "family"]) await page.locator(`[data-check="${c}"] input`).check();
await page.getByTestId("discharge-order").click(); await pin();
await page.locator('[data-screen="ipd/discharge"][data-status="ordered"]').waitFor();
await shot("doctor-death-checklist", true);
await login(NURSE);
await page.goto(`${BASE}/m/ipd/discharge?adm=${p3.id}`);
await page.getByTestId("done-bed-release").click();
await shot("nurse-body-moved-dialog");
await page.getByTestId("step-continue").click(); await pin();
await page.locator('[data-screen="ipd/discharge"][data-status="completed"]').waitFor();
await page.goto(`${BASE}/m/ipd/map`);
await page.locator(`[data-map-ward="${wardName}"]`).waitFor();
await shot("nurse-map-after-three");

// ── the owner's inpatient rows; the summary's QR check ──
await login(OWNER);
await page.goto(`${BASE}/m/own/dash`);
await page.getByTestId("leakage").waitFor();
await page.locator('[data-leak="excessUnpaid"]').scrollIntoViewIfNeeded();
await shot("owner-inpatient-rows", true);
await page.locator('[data-leak="excessUnpaid"]').click();
await page.getByTestId("drill").waitFor();
await shot("owner-excess-drill");
await page.context().clearCookies();
await page.goto(`${BASE}/verify/ds/${verifyUrl.split("/").pop()}`);
await page.getByTestId("verify-ok").waitFor();
await shot("public-verify-ds");
await browser.close();
console.log("done", n, "screenshots");
