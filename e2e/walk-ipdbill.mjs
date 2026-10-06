// Local hands-on walkthrough (not a test): the IPD running bill and the discharge checklist (ADR 0017, B7–B9) in the
// E2E Lite Hospital, Bangla screens as staff see them, a screenshot per step. The desk admits a fresh patient on the
// laparoscopy package with a card deposit; the surgeon's round orders CBC ×3; the cashier opens the running bill, sends
// the guardian a bKash link, takes cash, prints the money receipt and the interim bill, previews a cabin; the surgeon
// orders the discharge; the pharmacist clears it; the cashier records steps 4–5 by hand; the nurse releases the bed.
// node walk-ipdbill.mjs <outDir>
import { chromium, request as pwRequest } from "@playwright/test";
const OUT = process.argv[2] ?? "shots-ipdbill";
const BASE = process.env.STAFF_URL ?? "http://localhost:3300";
const OWNER = "01798000009", DESK = "01798000001", SURGEON = "01798000005", NURSE = "01798000004", PHARM = "01798000011", CASHIER = "01798000008", ADMIN = "01798000010";
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
let n = 0;
const api = await pwRequest.newContext({ baseURL: BASE });
const key = () => ({ "idempotency-key": crypto.randomUUID() });
async function as(phone) { const r = await api.post("/api/v1/auth/login", { data: { identifier: phone, password: "setu1234" } }); if (!r.ok()) throw new Error(await r.text()); }
async function post(url, data) { const r = await api.post("/api" + url, { headers: key(), data }); if (!r.ok()) throw new Error(url + " " + r.status() + " " + (await r.text())); return r.json(); }
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
async function shot(name, full = false) { n++; const f = `${OUT}/${String(n).padStart(2, "0")}-${name}.png`; await page.waitForTimeout(800); await page.screenshot({ path: f, fullPage: full }); console.log("saved", f); }
async function pin() { await page.getByTestId("pin").fill("1234"); await page.getByTestId("pin-submit").click(); }

// a ward of its own and a fresh patient (the desk registers through the API; the admission goes through the screen)
await as(ADMIN);
const wardName = `ওয়ার্ড ${RUN}`;
await post("/v1/admin/wards", { name: wardName, beds: 2, bedClass: "General" });
await post("/v1/admin/wards", { name: `কেবিন ${RUN}`, beds: 1, bedClass: "Cabin" });
await as(DESK);
const p = await post("/v1/patients", { nameBn: "ফারহানা ইসলাম", nameEn: `Farhana Islam ${RUN}`, sex: "female", dobMode: "dob", dob: "02/05/1995", phone: `019${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: false });

// ── the desk: the Admit form with the package and a card deposit ──
await login(DESK);
await page.goto(BASE + "/m/ipd/admit");
await page.getByTestId("admit-search").fill(p.patient.facilityNo);
await page.locator(`[role=option][data-patient="${p.patient.facilityNo}"]`).click();
await page.getByTestId("admit-doctor").selectOption("u_e2l_surgeon");
await page.getByTestId("admit-diagnosis").fill("ডিম্বাশয়ের সিস্ট — ল্যাপারোস্কোপি");
await page.locator(`[data-bed-id]`).filter({ hasText: "" }).first().waitFor();
const bedName = (await getJ("/v1/ipd/beds")).wards.find((w) => w.name === wardName).beds[0].name;
await page.locator(`[data-bed="${bedName}"]`).first().click();
await page.getByTestId("guardian-name").fill("রাশেদ চৌধুরী");
await page.getByTestId("guardian-phone").fill("০১৭১১-৯০৮৮১২");
for (const k of ["general", "financial", "guardian-id"]) await page.locator(`[data-consent="${k}"] input`).check();
const pkgId = (await getJ("/v1/ipd/packages")).items.find((x) => x.code === "PKG-LAP-01").id;
await page.getByTestId("admit-package-pick").selectOption(pkgId);
await page.getByTestId("admit-deposit").getByRole("radio", { name: "কার্ড" }).click();
await page.getByTestId("admit-deposit-amount").fill("২০০০০");
await page.getByTestId("admit-deposit-reference").fill("APPR 4471");
await shot("desk-admit-package-deposit", true);
await page.getByTestId("admit").click();
await page.getByTestId("admitted-card").waitFor();
await shot("desk-admitted");
await as(DESK);
const adm = (await getJ("/v1/ipd/admissions")).admitted.find((a) => a.patient.id === p.patient.id);

// the surgeon's round: CBC ×3 (two inside the package's limit)
await as(SURGEON);
const open = await post(`/v1/ipd/encounters/${adm.encounterId}/round/open`, {});
const put = await api.put(`/api/v1/ipd/round-notes/${open.draft.id}`, { headers: key(), data: { rev: open.draft.rev, sections: { s: "", o: "", a: "অপারেশনের পর", p: "রক্ত পরীক্ষা" }, lines: [], orders: [{ testCode: "cbc", priority: "routine" }, { testCode: "cbc", priority: "routine" }, { testCode: "cbc", priority: "routine" }] } });
await post(`/v1/ipd/round-notes/${open.draft.id}/sign`, { rev: (await put.json()).draft.rev, pin: "1234" });

// ── the cashier: the running bill ──
await login(CASHIER);
await page.goto(BASE + "/m/bill/ipd");
await page.getByTestId("ipd-bill-list").waitFor();
await shot("cashier-bill-list");
await page.locator(`[data-adm="${adm.number}"]`).click();
await page.getByTestId("ipd-lines").waitFor();
await shot("cashier-bill-due", true);
await page.getByTestId("send-link").click();
await shot("cashier-link-form");
await page.getByTestId("deposit-submit").click();
await page.locator('[data-deposit="bkash"]').waitFor();
await as(CASHIER);
const b1 = await getJ(`/v1/ipd/bills/${adm.id}`);
await post(`/v1/dev/fake-payments/${b1.deposits.items.find((d) => d.method === "bkash").id}/confirmed`, {});
await page.reload();
await page.getByTestId("take-deposit").click();
await page.getByTestId("deposit-amount").fill("৫০০০");
await page.getByTestId("deposit-submit").click();
await page.locator('[data-deposit="cash"][data-status="confirmed"]').waitFor();
await page.locator('[data-deposit="cash"]').getByTestId("deposit-receipt").click();
await page.getByTestId("deposit-receipt-print").click();
await page.getByTestId("deposit-receipt-dialog").locator("iframe").waitFor();
await shot("cashier-deposit-receipt");
await page.keyboard.press("Escape");
await page.getByTestId("class-preview-pick").selectOption("Cabin");
await page.getByTestId("class-preview").waitFor();
await page.getByTestId("charge-search").fill("রক্ত");
await page.locator('[data-charge="desk:transfusion"]').click();
await page.getByTestId("interim-print").click();
await page.getByTestId("interim-card").locator("iframe").waitFor();
await shot("cashier-bill-ok-preview-charge-interim", true);
await login(OWNER);
await page.goto(BASE + "/m/bill/pkg");
await page.locator("[data-package]").first().waitFor();
await shot("cashier-packages");

// ── B9: the surgeon orders the discharge ──
await login(SURGEON);
await page.goto(BASE + `/m/ipd/rounds?enc=${adm.encounterId}`);
await page.getByTestId("round-discharge").waitFor();
await shot("surgeon-round-discharge-link");
await page.getByTestId("round-discharge").click();
await page.getByTestId("discharge-advice").fill("ব্যথা কমেছে, স্বাভাবিক খাচ্ছেন — মুখে খাওয়ার ব্যথানাশক নিয়ে বাড়ি");
await shot("surgeon-order-form");
await page.getByTestId("discharge-order").click(); await pin();
await page.getByTestId("discharge-steps").waitFor();
await shot("surgeon-ordered-blocked-by-pharmacy", true);
// the pharmacist
await login(PHARM);
await page.goto(BASE + "/m/ph/indent");
await page.locator(`[data-clearance="${adm.number}"]`).getByTestId("clearance-open").click();
await page.getByTestId("take-pharmacy").click();
await page.waitForTimeout(800);
await shot("pharmacist-took-step", true);
await page.getByTestId("done-pharmacy").click();
await page.getByRole("radio", { name: "ছিল না" }).click();
await shot("pharmacist-done-dialog");
await page.getByTestId("step-continue").click(); await pin();
await page.waitForTimeout(800);
// the cashier: steps 4–5 by hand on the bill
await login(CASHIER);
await page.goto(BASE + `/m/bill/ipd?adm=${adm.id}`);
const clear = page.getByTestId("clearance");
await clear.getByTestId("done-final-bill").click(); await page.getByTestId("step-note").fill("কাগজে চূড়ান্ত বিল"); await page.getByTestId("step-continue").click(); await pin();
await clear.locator('[data-step="final-bill"][data-step-status="done"]').waitFor();
await clear.getByTestId("done-payment").click(); await page.getByTestId("step-continue").click(); await pin();
await clear.locator('[data-step="payment"][data-step-status="done"]').waitFor();
await clear.scrollIntoViewIfNeeded();
await shot("cashier-clearance-by-hand", true);
// the nurse: the list, remind the doctor
await login(NURSE);
await page.goto(BASE + "/m/ipd/discharge");
await page.getByTestId("discharge-list").waitFor();
await shot("nurse-discharge-list");
await page.goto(BASE + `/m/ipd/discharge?adm=${adm.id}`);
await page.getByTestId("remind-summary").click();
await page.waitForTimeout(800);
await shot("nurse-reminded-summary", true);
// the surgeon: the summary (by hand); the nurse: bed release
await login(SURGEON);
await page.goto(BASE + `/m/ipd/discharge?adm=${adm.id}`);
await page.getByTestId("done-summary").click(); await page.getByTestId("step-continue").click(); await pin();
await page.waitForTimeout(800);
await login(NURSE);
await page.goto(BASE + `/m/ipd/discharge?adm=${adm.id}`);
await page.getByTestId("done-bed-release").click(); await page.getByTestId("step-continue").click(); await pin();
await page.locator('[data-screen="ipd/discharge"][data-status="completed"]').waitFor();
await shot("nurse-discharged", true);
await browser.close();
console.log("done", adm.number);
