// Local hands-on walkthrough (not a test): the admitted patient on the ward (ADR 0015, journey B3–B4) in the E2E Lite
// Hospital, Bangla screens as staff see them, a screenshot per step. As the ward nurse (Lite Nurse Two), the doctor
// (Dr. Lite Surgeon), the pharmacist (Lite Pharmacist); the witness is Lite Nurse. Run `pnpm db:reset-e2e` first.
// node walk-ward.mjs <outDir>
import { chromium, request as pwRequest } from "@playwright/test";
import { mkdirSync } from "node:fs";
const OUT = process.argv[2] ?? "shots-ward"; mkdirSync(OUT, { recursive: true });
const BASE = process.env.STAFF_URL ?? "http://localhost:3300";
const NURSE = "01798000007", SURGEON = "01798000005", PHARM = "01798000011", SHAHIDUL = "E2L-240201";
let n = 0;
const api = await pwRequest.newContext({ baseURL: BASE });
await api.post("/api/v1/auth/login", { data: { identifier: NURSE, password: "setu1234" } });
const wards = (await (await api.get("/api/v1/nursing/wards")).json()).wards;
let ip;
for (const w of wards) { const b = await (await api.get(`/api/v1/nursing/wards/${w.id}/board`)).json(); const hit = b.beds.find((x) => x.patient?.facilityNo === SHAHIDUL); if (hit) ip = { wardId: w.id, enc: hit.encounterId, bed: hit.bed.name }; }
if (!ip) throw new Error("run pnpm db:reset-e2e");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
async function login(phone) {
  await page.context().clearCookies(); await page.goto(BASE + "/login");
  await page.fill("input[name=identifier]", phone); await page.fill("input[name=password]", "setu1234"); await page.click("button[type=submit]");
  await page.waitForSelector("header.shell-top", { timeout: 60000 });
  await page.getByRole("radio", { name: "বাং", exact: true }).click(); await page.getByRole("radio", { name: "০১২৩", exact: true }).click();
}
async function shot(name, full = false) { n++; const f = `${OUT}/${String(n).padStart(2, "0")}-${name}.png`; await page.waitForTimeout(700); await (full ? page.evaluate(() => window.scrollTo(0, 0)) : Promise.resolve()).then(() => page.screenshot({ path: f, fullPage: full })); console.log("saved", f, errs.splice(0).join(" | ")); }
async function board() { await page.goto(BASE + "/m/nur/ward"); await page.getByTestId("ward-pick").selectOption(ip.wardId); await page.locator(`[data-bed-patient="${SHAHIDUL}"]`).waitFor({ timeout: 30000 }); }
const ticks = async (dlg) => { for (const c of ["patient", "drug", "dose", "route", "time"]) await dlg.locator(`[data-check="${c}"]`).check(); };

// ── the ward nurse: board, NEWS2 round, escalation ──
await login(NURSE);
await board(); await shot("nurse-ward-board", true);
await page.locator(`[data-bed-patient="${SHAHIDUL}"]`).getByTestId("open-vitals").click();
await page.getByTestId("vitals-form").waitFor();
for (const [k, v] of [["rr", "24"], ["spo2", "93"], ["sbp", "98"], ["dbp", "60"], ["pulse", "118"], ["temp", "101.5"]]) await page.fill(`input[name=${k}]`, v);
await page.getByRole("radio", { name: "A · সজাগ" }).click();
await shot("nurse-news2-live-9");
await page.getByTestId("save-vitals").click(); await page.getByTestId("escalated").waitFor();
await shot("nurse-escalated");
await board(); await shot("nurse-board-escalation-banner");
await page.getByTestId("escalation-banner").first().getByTestId("log-inform").click();
await page.fill("input[name=spokeTo]", "ডা. লাইট সার্জন (ফোনে)"); await page.fill("textarea[name=instruction]", "IV স্যালাইন, ৩০ মিনিট পর আবার পর্যবেক্ষণ, এসে দেখবেন");
await shot("nurse-log-doctor-contact");
await page.getByTestId("inform-save").click(); await page.locator('[data-escalation-status="doctor-informed"]').first().waitFor();
await shot("nurse-doctor-informed");

// ── the doctor: inbox, round, stop, sign ──
await login(SURGEON);
await page.goto(BASE + "/m/doc/inbox"); await page.locator('[data-kind="news2-escalation"]').first().waitFor({ timeout: 30000 });
await shot("doctor-inbox-news2");
await page.goto(BASE + "/m/ipd/rounds"); await page.locator(`[data-round-patient="${SHAHIDUL}"]`).waitFor();
await shot("doctor-round-worklist");
await page.locator(`[data-round-patient="${SHAHIDUL}"]`).click(); await page.getByTestId("overnight").waitFor();
await shot("doctor-round-patient", true);
await page.locator('[data-active-order="metronidazole"]').getByTestId("stop-order").click();
await page.getByTestId("stop-reason").fill("৪৮ ঘণ্টা জ্বর নেই, কালচার নেগেটিভ");
await page.getByTestId("stop-confirm").click(); await page.getByTestId("pin").fill("1234");
await shot("doctor-stop-pin");
await page.getByTestId("pin-submit").click(); await page.locator('[data-active-order="metronidazole"]').waitFor({ state: "detached" });
await page.getByTestId("open-round").click(); await page.getByTestId("round-editor").waitFor();
await page.getByTestId("soap-s").fill("ভালো বোধ করছেন, ক্ষতে হালকা ব্যথা");
await page.getByTestId("soap-a").fill("অপারেশনের পর, জ্বর কমছে");
await page.getByTestId("soap-p").fill("সেফট্রিয়াক্সোন চলবে; IV প্যারাসিটামল ৮ ঘণ্টা পর পর");
await page.getByTestId("add-line").click();
const ln = page.locator("[data-line]").last();
await ln.getByTestId("line-medicine").selectOption("paracetamol-iv"); await ln.getByTestId("line-route").selectOption("iv");
await ln.getByTestId("line-dose").fill("1 g IV ১৫ মিনিটে"); await ln.getByTestId("line-qty").fill("1"); await ln.getByTestId("line-times").fill("06:00, 14:00, 22:00");
await page.getByTestId("sign-round").click(); await page.getByTestId("pin").fill("1234"); await page.getByTestId("pin-submit").click();
await ln.locator('[data-sign-warning="same-medicine"]').waitFor();
await shot("doctor-sign-blocked-duplicate-paracetamol", true);
await ln.getByRole("button", { name: "সরান" }).click();
await page.getByTestId("add-line").click();
const ns = page.locator("[data-line]").last();
await ns.getByTestId("line-medicine").selectOption("ns"); await ns.getByTestId("line-route").selectOption("iv");
await ns.getByTestId("line-dose").fill("1 L IV ৮ ঘণ্টায়"); await ns.getByTestId("line-qty").fill("1"); await ns.getByTestId("line-times").fill("06:00, 14:00, 22:00");
await page.getByTestId("sign-round").click(); await page.getByTestId("pin").fill("1234"); await page.getByTestId("pin-submit").click();
await page.getByTestId("open-round").waitFor();
await shot("doctor-round-signed", true);

// ── the ward nurse: MAR (ADR 0016: the doses scan the wristband and the ward batch labels) ──
await api.post("/api/v1/auth/login", { data: { identifier: NURSE, password: "setu1234" } });
const band = (await (await api.post(`/api/v1/nursing/encounters/${ip.enc}/wristband`, { headers: { "idempotency-key": crypto.randomUUID() }, data: { reason: "walk: band for the doses" } })).json()).code;
const stockNow = await (await api.get(`/api/v1/nursing/wards/${ip.wardId}/stock`)).json();
const labelIds = stockNow.items.flatMap((i) => i.batches.filter((b) => b.qty > 0).map((b) => b.id));
const printed = await (await api.post("/api/v1/nursing/labels", { headers: { "idempotency-key": crypto.randomUUID() }, data: { batchIds: labelIds } })).json();
const labelOf = (k) => { const ids = stockNow.items.find((i) => i.medicineKey === k)?.batches.filter((b) => b.qty > 0).map((b) => b.id) ?? []; return printed.items.find((x) => ids.includes(x.batchId))?.code; };
const scan = async (med) => { const d = page.getByTestId("dose-dialog"); await d.getByTestId("scan-band-input").fill(band); await d.getByTestId("scan-band-input").press("Enter"); if (med) { await d.getByTestId("scan-med-input").fill(med); await d.getByTestId("scan-med-input").press("Enter"); } };
await login(NURSE);
await page.goto(`${BASE}/m/nur/mar?enc=${ip.enc}`); await page.locator("[data-order]").first().waitFor();
await shot("nurse-mar", true);
const cef = page.locator('[data-order="ceftriaxone"]');
await cef.locator("[data-slot]:not([disabled])").first().click();
const dlg = page.getByTestId("dose-dialog");
await shot("nurse-dose-scans-needed");
await scan(labelOf("ceftriaxone"));
await shot("nurse-dose-scanned-checks-incomplete");
await ticks(dlg);
if (await dlg.getByTestId("dose-reason").isVisible()) await dlg.getByTestId("dose-reason").fill("রাতের শিফট বদলের সময় দেরি");
await shot("nurse-dose-ready");
await dlg.getByTestId("dose-record").click(); await dlg.waitFor({ state: "detached" });
await page.locator('[data-order="morphine"]').getByTestId("give-prn").click();
await scan(labelOf("morphine")); await ticks(dlg); await dlg.getByTestId("witness-pick").selectOption("u_e2l_nurse"); await dlg.getByTestId("witness-pin").fill("0000");
await dlg.getByTestId("dose-record").click(); await dlg.getByTestId("dose-error").waitFor();
await shot("nurse-morphine-wrong-witness-pin");
await dlg.getByTestId("witness-pin").fill("1234"); await dlg.getByTestId("dose-record").click(); await dlg.waitFor({ state: "detached" });
await page.locator('[data-order="napa"]').getByTestId("give-prn").click();
await dlg.getByRole("radio", { name: "রোগীর নিজের" }).click(); await scan(); await ticks(dlg);
await shot("nurse-napa-patients-own");
await dlg.getByTestId("dose-record").click(); await dlg.waitFor({ state: "detached" });
await page.locator('[data-order="insulin"]').getByTestId("open-vial").click(); await page.getByTestId("vial-confirm").click(); await page.waitForTimeout(1500);
await shot("nurse-mar-after-doses", true);
await page.goto(`${BASE}/m/nur/io?enc=${ip.enc}&tab=notes`);
await page.getByTestId("note-text").fill("ক্ষতের ড্রেসিং বদলানো হয়েছে, পরিষ্কার ও শুকনো।"); await page.getByTestId("add-note").click();
await page.locator('[data-note-status="active"]').first().waitFor();
await shot("nurse-notes");
// indent
await board();
await page.getByTestId("indent-new").click();
const form = page.getByTestId("indent-form");
await form.getByTestId("indent-medicine").first().selectOption("ceftriaxone"); await form.getByTestId("indent-qty").first().fill("4");
await form.getByRole("button", { name: "লাইন যোগ" }).click();
await form.getByTestId("indent-medicine").nth(1).selectOption("morphine"); await form.getByTestId("indent-qty").nth(1).fill("2");
await shot("nurse-indent-form");
await form.getByTestId("indent-send").click(); await page.locator('[data-indent-status="requested"]').first().waitFor();
// ── the pharmacist ──
await login(PHARM);
await page.goto(BASE + "/m/ph/indent"); await page.locator("[data-indent]").first().waitFor();
await shot("pharm-indents");
await page.locator("[data-indent]").first().getByTestId("issue").click(); await page.getByTestId("pin").fill("1234");
await shot("pharm-controlled-pin");
await page.getByTestId("pin-submit").click(); await page.waitForTimeout(1500);
await page.getByRole("radio", { name: "দেওয়া" }).click(); await page.locator('[data-indent-status="issued"]').first().waitFor();
await shot("pharm-issued");
// ── nurse: bed move, map ──
await login(NURSE);
await board();
await page.locator(`[data-bed-patient="${SHAHIDUL}"]`).getByTestId("open-move").click(); await page.getByTestId("move-form").waitFor();
await page.locator(`[data-testid=bed-picker] [data-pickable="1"][data-bed^="${ip.bed.split("-")[0]}-"]`).first().click();
await page.getByTestId("move-reason").fill("নার্সিং স্টেশনের কাছে পর্যবেক্ষণের জন্য");
await shot("nurse-bed-move");
await page.getByTestId("move-submit").click(); await page.waitForTimeout(1500);
await board(); await shot("nurse-board-after-move", true);
await page.goto(BASE + "/m/ipd/map"); await page.locator("[data-bed]").first().waitFor();
await shot("nurse-bed-map", true);
await browser.close();
