// Local hands-on walkthrough (not a test): slice B5–B6 (ADR 0016) in the E2E Lite Hospital, Bangla screens, a
// screenshot per step — scans at the bedside, a scan mismatch, "scanner not working", the wristband, intake & output,
// the care plan and the shift handover. Its own ward and patient each run (set up through the API).
// node walk-b5b6.mjs <outDir>
import { chromium, request as pwRequest } from "@playwright/test";
import { mkdirSync } from "node:fs";
const OUT = process.argv[2] ?? "shots-b5b6"; mkdirSync(OUT, { recursive: true });
const BASE = process.env.STAFF_URL ?? "http://localhost:3300";
const NURSE2 = "01798000007", NURSE1 = "01798000004", SURGEON = "01798000005", DESK = "01798000001", ADMIN = "01798000010", PHARM = "01798000011", OWNER = "01798000009";
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const api = await pwRequest.newContext({ baseURL: BASE });
const key = () => ({ "idempotency-key": crypto.randomUUID() });
const as = async (p) => { const r = await api.post("/api/v1/auth/login", { data: { identifier: p, password: "setu1234" } }); if (!r.ok()) throw new Error(await r.text()); };
const post = async (u, d) => { const r = await api.post("/api" + u, { headers: key(), data: d }); if (!r.ok()) throw new Error(u + " " + (await r.text())); return r.json(); };
const hhmm = (m) => new Date(Date.now() + 6 * 3600_000 + m * 60_000).toISOString().slice(11, 16);
// setup: a ward, a patient admitted, orders signed, stock issued
await as(ADMIN); const wardName = `HW${RUN}`; await post("/v1/admin/wards", { name: wardName, beds: 2, bedClass: "General" });
await as(DESK);
const p = await post("/v1/patients", { nameBn: "রোকেয়া বেগম", nameEn: `Rokeya Begum ${RUN}`, sex: "female", dobMode: "dob", dob: "12/03/1971", phone: `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: false });
const beds = (await (await api.get("/api/v1/ipd/beds")).json()).wards.find((w) => w.name === wardName).beds;
const adm = await post("/v1/ipd/admissions", { patientId: p.patient.id, admittingDoctorId: "u_e2l_surgeon", department: "surgery", diagnosis: "পায়ে সেলুলাইটিস", bedClass: "General", bedId: beds[0].id, guardian: { name: "আব্দুল করিম", relationship: "husband", phone: "01811223355" }, consents: ["general", "financial", "guardian-id"] });
const enc = adm.encounter.id, wardId = beds[0].ward.id;
await as(SURGEON);
const open = await post(`/v1/ipd/encounters/${enc}/round/open`, {});
const saved = await (await api.put(`/api/v1/ipd/round-notes/${open.draft.id}`, { headers: key(), data: { rev: open.draft.rev, sections: { s: "", o: "", a: "সেলুলাইটিস", p: "IV অ্যান্টিবায়োটিক" }, orders: [], lines: [
  { medicineKey: "ceftriaxone", route: "iv", doseText: "1 g IV", doseQty: 1, times: [hhmm(3), hhmm(6)], prn: false, prnMaxPer24h: null },
  { medicineKey: "paracetamol-iv", route: "iv", doseText: "1 g IV ১৫ মিনিটে", doseQty: 1, times: [], prn: true, prnMaxPer24h: 4 }] } })).json();
await post(`/v1/ipd/round-notes/${open.draft.id}/sign`, { rev: saved.draft.rev, pin: "1234" });
await as(NURSE2);
const ind = await post(`/v1/nursing/wards/${wardId}/indents`, { lines: [{ medicineKey: "ceftriaxone", qty: 4 }, { medicineKey: "paracetamol-iv", qty: 2 }] });
await as(PHARM); await post(`/v1/pharmacy/indents/${ind.id}/issue`, { lines: ind.lines.map((l) => ({ lineId: l.id, qty: l.requested })) });
await as(NURSE2);
const band = (await post(`/v1/nursing/encounters/${enc}/wristband`, {})).code;
const stock = await (await api.get(`/api/v1/nursing/wards/${wardId}/stock`)).json();
const label = (k) => stock.items.find((i) => i.medicineKey === k).batches[0].label;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
let n = 0;
async function shot(name, full = false, pg = page) { n++; const f = `${OUT}/${String(n).padStart(2, "0")}-${name}.png`; await pg.waitForTimeout(700); await pg.screenshot({ path: f, fullPage: full }); console.log("saved", f, errs.splice(0).join(" | ")); }
async function login(phone) {
  await ctx.clearCookies(); await page.goto(BASE + "/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForSelector("header.shell-top", { timeout: 60000 });
  await page.getByRole("radio", { name: "বাং", exact: true }).click(); await page.getByRole("radio", { name: "০১২৩", exact: true }).click();
}
const dlg = page.getByTestId("dose-dialog");
const ticks = async () => { for (const c of ["patient", "drug", "dose", "route", "time"]) await dlg.locator(`[data-check="${c}"]`).check(); };
const scan = async (b, m) => { await dlg.getByTestId("scan-band-input").fill(b); await dlg.getByTestId("scan-band-input").press("Enter"); if (m) { await dlg.getByTestId("scan-med-input").fill(m); await dlg.getByTestId("scan-med-input").press("Enter"); } };

// ── the nurse at the bedside ──
await login(NURSE2);
await page.goto(`${BASE}/m/nur/mar?enc=${enc}`); await page.locator('[data-order="ceftriaxone"]').waitFor();
await shot("nurse-mar");
await page.locator('[data-order="ceftriaxone"] [data-slot]:not([disabled])').first().click(); await ticks();
await shot("nurse-dose-locked-until-scanned");
await scan(band.replace(/\d{8}$/, (d) => String((Number(d) + 1) % 1e8).padStart(8, "0")), label("ceftriaxone"));
if (await dlg.getByTestId("dose-reason").isVisible()) await dlg.getByTestId("dose-reason").fill("রাউন্ডের সময় একটু আগে দেওয়া");
await dlg.getByTestId("dose-record").click(); await dlg.locator('[data-blocker="band_mismatch"]').waitFor();
await shot("nurse-scan-mismatch");
await scan(band); await ticks();
await shot("nurse-dose-scanned");
await dlg.getByTestId("dose-record").click(); await dlg.waitFor({ state: "detached" });
await page.locator('[data-order="paracetamol-iv"]').getByTestId("give-prn").click(); await ticks();
await dlg.getByTestId("no-scanner").check(); await dlg.getByTestId("override-reason").fill("স্ক্যানারের ব্যাটারি শেষ, ব্যান্ড চোখে মিলিয়েছি");
await shot("nurse-scanner-not-working");
await dlg.getByTestId("dose-record").click(); await dlg.waitFor({ state: "detached" });
await shot("nurse-mar-after", true);
// the wristband reprint asks why
await page.goto(`${BASE}/m/nur/ward`); await page.getByTestId("ward-pick").selectOption(wardId);
const bedCard = page.locator(`[data-bed-patient="${p.patient.facilityNo}"]`);
await bedCard.getByTestId("wristband-print").click(); await bedCard.getByTestId("wristband-reason").waitFor();
await bedCard.getByTestId("wristband-reason").fill("ব্যান্ড ভিজে ছিঁড়ে গেছে");
await shot("nurse-board-wristband-reprint", true);
const pop = page.waitForEvent("popup"); await bedCard.getByTestId("wristband-print").click(); const w = await pop; await w.waitForLoadState();
await shot("wristband-print", false, w); await w.close();
// intake & output, care plan
await page.goto(`${BASE}/m/nur/io?enc=${enc}`); await page.getByTestId("io-panel").waitFor();
await page.getByTestId("io-quick-in-oral-200").click(); await page.getByTestId("io-quick-in-iv-500").click(); await page.waitForTimeout(800);
await page.getByTestId("io-side").selectOption("out"); await page.getByTestId("io-ml").fill("650"); await page.waitForTimeout(500); await shot("nurse-io-entry", true); await page.getByTestId("io-add").click({ timeout: 5000 }); await page.waitForTimeout(800);
await shot("nurse-intake-output", true);
// ── the doctor writes a care task ──
await login(SURGEON);
await page.goto(`${BASE}/m/ipd/rounds?enc=${enc}`); await page.getByTestId("round-care").waitFor();
await page.getByTestId("round-care").getByTestId("task-text").fill("পা উঁচু করে রাখুন, নাড়ি দেখুন"); await page.getByTestId("round-care").getByTestId("task-every").fill("4");
await page.getByTestId("round-care").getByTestId("task-add").click(); await page.waitForTimeout(800);
await shot("doctor-round-care-task", true);
// ── the nurse ticks it; the handover ──
await login(NURSE2);
await page.goto(`${BASE}/m/nur/io?enc=${enc}&tab=care`); await page.getByTestId("care-panel").waitFor();
await page.getByTestId("task-done").first().click(); await page.waitForTimeout(800);
await shot("nurse-care-plan", true);
await page.goto(`${BASE}/m/nur/handover`); await page.getByTestId("ward-pick").selectOption(wardId);
await page.getByTestId("ho-open").click(); await page.getByTestId("ho-sheet").waitFor();
const card = page.locator(`[data-ho-patient="${p.patient.facilityNo}"]`);
await card.getByTestId("sbar-s").fill("সেলুলাইটিস, আজ জ্বর নেই"); await card.getByTestId("sbar-r").fill("পরের সেফট্রিয়াক্সোন সময়মতো; পা উঁচু");
await card.getByTestId("sbar-save").click(); await page.waitForTimeout(800); await card.getByTestId("ho-reviewed").click(); await page.waitForTimeout(800);
await shot("nurse-handover-sheet", true);
await page.getByTestId("ho-sign").click(); await page.getByTestId("pin").fill("1234"); await page.getByTestId("pin-submit").click(); await page.locator('[data-ho-status="outgoing-signed"]').waitFor();
await login(NURSE1);
await page.goto(`${BASE}/m/nur/handover`); await page.getByTestId("ward-pick").selectOption(wardId); await page.locator('[data-ho-status="outgoing-signed"]').waitFor();
await page.getByTestId("ho-accept-note").fill("সব রোগী দেখে বুঝে নিলাম");
await shot("incoming-nurse-accept", true);
await page.getByTestId("ho-accept").click(); await page.getByTestId("pin").fill("1234"); await page.getByTestId("pin-submit").click(); await page.locator('[data-ho-status="accepted"]').waitFor();
await shot("handover-accepted", true);
await login(OWNER); await page.goto(`${BASE}/m/own/dash`); await page.locator('[data-leak="scanOverride"]').waitFor({ timeout: 60000 });
await page.locator('[data-leak="scanOverride"]').click(); await page.waitForTimeout(1500);
await shot("owner-scan-overrides");
await browser.close();
