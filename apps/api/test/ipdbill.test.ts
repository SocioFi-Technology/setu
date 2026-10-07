/* Slice B7–B9 (ADR 0017): the IPD running bill and the discharge checklist on the real database (as setu_app), E2E Lite
   Hospital. The walkthrough cases first (B8: the package, bed days in and beyond it, a ward-stock medicine off the list,
   the low deposit with a link to the guardian; B9–B12: six steps, the blocker named, the events that finish them), then the class-change rule
   (Kamrul, decision 3), the database's refusals, and the discharge's effects. Each test admits its own patient. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { censusOf } from "../src/modules/ipdBill.js";
import { T, TICKS, client, dhakaHHMM, line, setup, slotAt, withScans } from "./ward-helpers.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
let app: Awaited<ReturnType<typeof buildApp>>;
let c: ReturnType<typeof client>; let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { app = await buildApp(); if (!db) return; c = client(app); await c.login(); h = await setup(c); });
afterAll(async () => { await app?.close(); });
const tenant = <R>(fn: (tx: import("@setu/db").Tx) => Promise<R>, userId = "u_e2l_cashier") => db!.forTenant(T, fn, { userId });
type Bill = { lines: { key: string; tag: string; unitPaisa: number | null; qty: number; totalPaisa: number; superseded: object | null; credited: boolean; creditOf: string | null; bedClass: string | null; dayNo: number | null; source: string }[]; totals: { totalPaisa: number; packagePaisa: number; excludedPaisa: number }; balancePaisa: number; depositState: string; deposits: { items: { id: string; status: string; method: string; to: string | null; phoneLast4: string | null; amountPaisa: number }[]; confirmedPaisa: number } };
const bill = async (admissionId: string): Promise<Bill> => { const r = await c.get(`/v1/ipd/bills/${admissionId}`, "cashier"); expect(r.statusCode, r.body).toBe(200); return r.json(); };
const live = (b: Bill) => b.lines.filter((l) => !l.superseded && !l.credited && !l.creditOf);
const byKey = (b: Bill, key: string) => live(b).find((l) => l.key === key);
const packages = async () => (await c.get("/v1/ipd/packages", "cashier")).json().items as { id: string; code: string }[];
const pkgId = async (code: string) => (await packages()).find((p) => p.code === code)!.id;
/** a direct admission with the package / deposit given (the desk) */
async function admit(ward: string, extra: Record<string, unknown> = {}, bedClass = "General") {
  const beds = (await c.get("/v1/ipd/beds", "nurse")).json().wards.find((w: { name: string }) => w.name === ward).beds;
  const patientId = await h.newPatient();
  const r = await c.post("/v1/ipd/admissions", { patientId, admittingDoctorId: "u_e2l_surgeon", department: "surgery", diagnosis: "Ovarian cyst for laparoscopy", bedClass, bedId: beds[0].id,
    guardian: { name: "রাশেদ চৌধুরী", relationship: "husband", phone: "+880 1711-908812" }, consents: ["general", "financial", "guardian-id"], ...extra }, "desk");
  expect(r.statusCode, r.body).toBe(201);
  return { patientId, admissionId: r.json().id as string, encounterId: r.json().encounter.id as string, wardId: beds[0].ward.id as string, admission: r.json() };
}
const DAY = 864e5;
const tomorrow = () => new Date(Date.now() + 6 * 3600_000 + DAY).toISOString().slice(0, 10);
/** B11: the surgeon opens, writes and signs the discharge summary (PIN 1234) */
async function signSummary(admissionId: string) {
  const open = await c.post(`/v1/ipd/admissions/${admissionId}/summary/open`, {}, "surgeon");
  expect(open.statusCode, open.body).toBe(200);
  const d = open.json().draft;
  const saved = await c.put(`/v1/ipd/summaries/${d.id}`, { rev: d.rev, sections: { course: "Laparoscopic cystectomy on day 1, uneventful recovery", procedures: [], followUp: { date: tomorrow(), place: "Surgery OPD" }, redFlags: ["Fever above 100.4°F (38°C)"] },
    diagnoses: [{ code: "GC00", verificationStatus: "confirmed" }], medicines: [{ medicineKey: "napa", dose: "1+1+1", meal: "after", days: 5 }] });
  expect(saved.statusCode, saved.body).toBe(200);
  const signed = await c.post(`/v1/ipd/summaries/${d.id}/sign`, { rev: saved.json().draft.rev, pin: "1234" }, "surgeon");
  expect(signed.statusCode, signed.body).toBe(200);
  return signed.json();
}

describe.runIf(db)("the walkthrough (B8): the running bill", () => {
  it("admitted on the laparoscopy package with ৳20,000 by card at the desk: the package line, day 1 Included, the deposit — and the balance is due", async () => {
    const w = await h.ownWard(1);
    const a = await admit(w, { packageId: await pkgId("PKG-LAP-01"), deposit: { method: "card", amountPaisa: 2_000_000, reference: "APPR 4471" } });
    expect(a.admission.checklist.find((x: { key: string }) => x.key === "deposit")).toMatchObject({ ok: true, blocks: false });
    // cash is the cash counter's (it is counted in a drawer shift); the desk takes card or bank
    const w2 = await h.ownWard(1);
    const beds = (await c.get("/v1/ipd/beds", "nurse")).json().wards.find((x: { name: string }) => x.name === w2).beds;
    const deskCash = await c.post("/v1/ipd/admissions", { patientId: await h.newPatient(), admittingDoctorId: "u_e2l_surgeon", department: "surgery", diagnosis: "Ovarian cyst for laparoscopy", bedClass: "General", bedId: beds[0].id,
      guardian: { name: "রাশেদ চৌধুরী", relationship: "husband", phone: "01711908812" }, consents: ["general", "financial", "guardian-id"], deposit: { method: "cash", amountPaisa: 100_000, tenderedPaisa: 100_000 } }, "desk");
    expect(deskCash.statusCode).toBe(422); expect(deskCash.json().code).toBe("cash_at_counter");
    const b = await bill(a.admissionId);
    expect(byKey(b, "pkg")).toMatchObject({ tag: "package", unitPaisa: 4_800_000, bedClass: "General" });
    expect(byKey(b, "bed:1")).toMatchObject({ tag: "included", unitPaisa: 0, dayNo: 1 });
    expect(b.deposits).toMatchObject({ confirmedPaisa: 2_000_000 });
    expect(b.totals.totalPaisa).toBe(4_800_000);
    expect(b.balancePaisa).toBe(-2_800_000); expect(b.depositState).toBe("due");
  });
  it("the census: days 2–3 Included, day 4 beyond the package Excluded at the ward rate — posted once, attributed to nobody", async () => {
    const w = await h.ownWard(1);
    const a = await admit(w, { packageId: await pkgId("PKG-LAP-01") });
    const admittedAt = new Date(a.admission.admittedAt);
    const day4 = new Date(new Date(`${new Date(admittedAt.getTime() + 6 * 36e5 + 3 * DAY).toISOString().slice(0, 10)}T00:05:00+06:00`).getTime());
    await censusOf(T, a.admissionId, day4); await censusOf(T, a.admissionId, day4); // twice: idempotent
    const lines = await tenant((tx) => tx.chargeItem.findMany({ where: { invoice: { encounterId: a.encounterId }, source: "bed_day" }, orderBy: { dayNo: "asc" } }));
    expect(lines.map((l) => [l.dayNo, l.tag, l.unitPaisa, l.addedById, l.auto])).toEqual([[1, "included", 0, "u_e2l_desk", true], [2, "included", 0, null, true], [3, "included", 0, null, true], [4, "excluded", 120_000, null, true]]);
  });
  it("round orders: CBC ×3 on a package of two — two Included, the third Excluded; a revoked one leaves by a credit line", async () => {
    const w = await h.ownWard(1);
    const a = await admit(w, { packageId: await pkgId("PKG-LAP-01") });
    const open = (await c.post(`/v1/ipd/encounters/${a.encounterId}/round/open`, {}, "surgeon")).json().draft;
    const saved = await c.put(`/v1/ipd/round-notes/${open.id}`, { rev: open.rev, sections: { s: "", o: "", a: "Post-op", p: "Bloods" }, lines: [], orders: [{ testCode: "cbc", priority: "routine" }, { testCode: "cbc", priority: "routine" }, { testCode: "cbc", priority: "routine" }] });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await c.post(`/v1/ipd/round-notes/${open.id}/sign`, { rev: saved.json().draft.rev, pin: "1234" }, "surgeon")).statusCode).toBe(200);
    let b = await bill(a.admissionId);
    const orders = live(b).filter((l) => l.source === "order");
    expect(orders.map((l) => l.tag).sort()).toEqual(["excluded", "included", "included"]);
    const excluded = orders.find((l) => l.tag === "excluded")!;
    expect(excluded.unitPaisa).toBe(45_000);
    // the surgeon revokes one of the Included ones: it is credited, and the third moves inside the limit (superseded)
    const inc = orders.find((l) => l.tag === "included")!;
    const rv = await c.post(`/v1/orders/${inc.key.slice(6)}/revoke`, { reason: "Ordered twice by mistake" }, "surgeon");
    expect(rv.statusCode, rv.body).toBe(200);
    b = await bill(a.admissionId);
    expect(b.lines.find((l) => l.key === `credit:${inc.key}`)).toMatchObject({ qty: -1, tag: "included" });
    expect(live(b).filter((l) => l.source === "order").map((l) => l.tag)).toEqual(["included", "included"]);
    expect(b.lines.find((l) => l.key === excluded.key && l.superseded)).toBeTruthy();
  });
  it("ward stock drawn at the bedside is billed at its MRP (Excluded: off the package list); the dose marked 'stock not drawn' is credited", async () => {
    const w = await h.ownWard(1);
    const a = await admit(w, { packageId: await pkgId("PKG-LAP-01") });
    const hhmm = dhakaHHMM(2);
    const r = await h.signRound(a.encounterId, [line("ceftriaxone", { doseText: "1 g IV", times: [hhmm] })]);
    const o = r.activeOrders.find((x: { medicine: { key: string } }) => x.medicine.key === "ceftriaxone");
    const ind = await c.post(`/v1/nursing/wards/${a.wardId}/indents`, { lines: [{ medicineKey: "ceftriaxone", qty: 2 }] });
    expect((await c.post(`/v1/pharmacy/indents/${ind.json().id}/issue`, { lines: [{ lineId: ind.json().lines[0].id, qty: 2 }] }, "pharm")).statusCode).toBe(200);
    const d = await c.post(`/v1/nursing/encounters/${a.encounterId}/doses`, await withScans(c, a.encounterId, { requestId: o.id, scheduledFor: slotAt(hhmm), outcome: "given", administeredAt: new Date().toISOString(), checks: TICKS, source: "ward-stock" }), "nurse");
    expect(d.statusCode, d.body).toBe(201);
    let b = await bill(a.admissionId);
    const st = live(b).find((l) => l.source === "stock")!;
    const mrp = await tenant(async (tx) => (await tx.chargeItem.findFirst({ where: { key: st.key }, include: { invoice: true } }))!);
    const batch = await tenant((tx) => tx.stockBatch.findFirst({ where: { id: mrp.batchId! } }));
    expect(st).toMatchObject({ tag: "excluded", qty: 1, unitPaisa: batch!.mrpPaisa });
    const doseId = (await tenant((tx) => tx.medicationAdministration.findFirst({ where: { encounterId: a.encounterId, status: "given" } })))!.id;
    const e = await c.post(`/v1/nursing/doses/${doseId}/entered-in-error`, { reason: "Recorded on the wrong patient", stockDrawn: "no" }, "nurse");
    expect(e.statusCode, e.body).toBe(200);
    b = await bill(a.admissionId);
    expect(b.lines.find((l) => l.key === `credit:${st.key}`)).toMatchObject({ qty: -1 });
    expect(live(b).some((l) => l.source === "stock")).toBe(false);
  });
  it("a charge from the price list, withdrawn with a reason by a credit line; nothing on an IPD bill is edited or deleted (database)", async () => {
    const w = await h.ownWard(1);
    const a = await admit(w);
    const p = await c.post(`/v1/ipd/bills/${a.admissionId}/charges`, { code: "desk:transfusion", qty: 1 }, "cashier");
    expect(p.statusCode, p.body).toBe(201);
    const ln = live(p.json()).find((l: { key: string }) => l.key.startsWith("manual:"))!;
    expect(ln).toMatchObject({ tag: "excluded", unitPaisa: 250_000 });
    expect((await c.post(`/v1/ipd/bills/${a.admissionId}/charges`, { code: "desk:dress", qty: 1 }, "nurse")).statusCode).toBe(403);
    // a test or a medicine never by hand (they come through the order / the stock drawn)
    expect((await c.post(`/v1/ipd/bills/${a.admissionId}/charges`, { code: "test:cbc", qty: 1 }, "cashier")).json().code).toBe("code_unknown");
    const lineId = (ln as { id: string }).id;
    const wd = await c.post(`/v1/ipd/bills/${a.admissionId}/lines/${lineId}/withdraw`, { reason: "Posted to the wrong patient" }, "cashier");
    expect(wd.statusCode, wd.body).toBe(200);
    expect(live(wd.json()).some((l) => l.key.startsWith("manual:"))).toBe(false);
    const anyLine = await tenant((tx) => tx.chargeItem.findFirst({ where: { invoice: { encounterId: a.encounterId }, key: "bed:1" } }));
    await expect(tenant((tx) => tx.chargeItem.update({ where: { id: anyLine!.id }, data: { unitPaisa: 1, grossPaisa: 1, netPaisa: 1, totalPaisa: 1 } }))).rejects.toThrow(/never edited/);
    await expect(tenant((tx) => tx.chargeItem.delete({ where: { id: anyLine!.id } }))).rejects.toThrow();
  });
});

describe.runIf(db)("class changes (Kamrul, decision 3)", () => {
  it("moving up re-prices today's bed day by supersession, audited with the move; the package follows the dearer class", async () => {
    const gw = await h.ownWard(1), cw = await h.ownWard(1, "Cabin");
    const a = await admit(gw);
    expect(byKey(await bill(a.admissionId), "bed:1")).toMatchObject({ unitPaisa: 120_000, bedClass: "General" });
    const pv = await c.get(`/v1/ipd/bills/${a.admissionId}/preview?to=Cabin`, "cashier");
    expect(pv.json()).toMatchObject({ direction: "up", appliesFrom: "today", perDayFromPaisa: 120_000, perDayToPaisa: 450_000, extraPaisa: 660_000 });
    const cab = (await c.get("/v1/ipd/beds", "nurse")).json().wards.find((x: { name: string }) => x.name === cw).beds[0];
    const mv = await c.post(`/v1/ipd/admissions/${a.admissionId}/transfer`, { bedId: cab.id, reason: "Family asked for a cabin", mode: "now" }, "nurse");
    expect(mv.statusCode, mv.body).toBe(200);
    const b = await bill(a.admissionId);
    expect(byKey(b, "bed:1")).toMatchObject({ unitPaisa: 450_000, bedClass: "Cabin" });
    expect(b.lines.find((l) => l.key === "bed:1" && l.superseded)).toMatchObject({ unitPaisa: 120_000, superseded: { reason: "class-change" } });
    const audit = await tenant((tx) => tx.auditEvent.findFirst({ where: { entityId: a.admission.invoice.id, action: "update", detail: { path: ["reason"], equals: "class-change" } } }));
    expect(audit!.detail).toMatchObject({ event: "ipd-sync", reason: "class-change", superseded: [{ key: "bed:1", from: 120_000, to: 450_000 }] });
    // with a package: the package line is superseded by the cabin price
    const gw2 = await h.ownWard(1), cw2 = await h.ownWard(1, "Cabin");
    const p = await admit(gw2, { packageId: await pkgId("PKG-LAP-01") });
    const cab2 = (await c.get("/v1/ipd/beds", "nurse")).json().wards.find((x: { name: string }) => x.name === cw2).beds[0];
    expect((await c.post(`/v1/ipd/admissions/${p.admissionId}/transfer`, { bedId: cab2.id, reason: "Family asked for a cabin", mode: "now" }, "nurse")).statusCode).toBe(200);
    expect(byKey(await bill(p.admissionId), "pkg")).toMatchObject({ unitPaisa: 6_200_000, bedClass: "Cabin" });
  });
  it("moving down costs nothing today; the next bed day is at the lower class", async () => {
    const cw = await h.ownWard(1, "Cabin"), gw = await h.ownWard(1);
    const a = await admit(cw, {}, "Cabin");
    const ward = (await c.get("/v1/ipd/beds", "nurse")).json().wards.find((x: { name: string }) => x.name === gw).beds[0];
    expect((await c.post(`/v1/ipd/admissions/${a.admissionId}/transfer`, { bedId: ward.id, reason: "Cabin needed for another", mode: "now" }, "nurse")).statusCode).toBe(200);
    expect(byKey(await bill(a.admissionId), "bed:1")).toMatchObject({ unitPaisa: 450_000, bedClass: "Cabin" });
    const day2 = new Date(`${new Date(Date.now() + 6 * 36e5 + DAY).toISOString().slice(0, 10)}T00:05:00+06:00`);
    await censusOf(T, a.admissionId, day2);
    const l2 = await tenant((tx) => tx.chargeItem.findFirst({ where: { invoice: { encounterId: a.encounterId }, key: "bed:2" } }));
    expect(l2).toMatchObject({ unitPaisa: 120_000, bedClass: "General" });
  });
});

describe.runIf(db)("deposits (Kamrul, decision 2)", () => {
  it("cash on the running bill; a bKash link goes to the guardian's phone by SMS naming the admission; the money receipt DR/yy/nnnn", async () => {
    const w = await h.ownWard(1);
    const a = await admit(w);
    const cash = await c.post(`/v1/ipd/bills/${a.admissionId}/deposits`, { method: "cash", amountPaisa: 500_000, tenderedPaisa: 500_000 }, "cashier");
    expect(cash.statusCode, cash.body).toBe(201);
    const inv = await tenant((tx) => tx.invoice.findFirst({ where: { encounterId: a.encounterId, kind: "ipd" } }));
    expect(inv).toMatchObject({ status: "draft", paidPaisa: 500_000 });
    const link = await c.post(`/v1/ipd/bills/${a.admissionId}/deposits`, { method: "bkash", amountPaisa: 300_000 }, "cashier");
    expect(link.statusCode, link.body).toBe(201);
    const dep = (link.json() as Bill).deposits.items.find((d) => d.method === "bkash")!;
    expect(dep).toMatchObject({ to: "guardian", phoneLast4: "8812", status: "link-sent" });
    const sms = await tenant((tx) => tx.communication.findFirst({ where: { paymentId: dep.id, kind: "payment-link" } }));
    expect(sms!.toPhone).toBe("01711908812"); expect(sms!.text).toContain(a.admission.number);
    // the gateway (fake) confirms: still a draft, the deposits add up
    expect((await c.post(`/v1/dev/fake-payments/${dep.id}/confirmed`, {}, "cashier", null)).statusCode).toBe(200);
    const b = await bill(a.admissionId);
    expect(b.deposits.confirmedPaisa).toBe(800_000);
    // the money receipts: one per confirmed deposit, the same one again on a repeat
    const cashId = b.deposits.items.find((d) => d.method === "cash")!.id;
    const r1 = await c.post(`/v1/ipd/deposits/${cashId}/receipt`, {}, "cashier");
    expect(r1.statusCode, r1.body).toBe(201);
    expect(r1.json().number).toMatch(/^DR\/\d{2}\/\d{4}$/);
    expect(r1.json().snapshot).toMatchObject({ amountPaisa: 500_000, method: "cash", admission: { number: a.admission.number } });
    const r2 = await c.post(`/v1/ipd/deposits/${cashId}/receipt`, {}, "cashier");
    expect(r2.statusCode).toBe(200); expect(r2.json().id).toBe(r1.json().id);
    // the money receipt prints through the receipt pipeline with its own page; a reprint needs a reason
    const pr = await c.post(`/v1/receipts/${r1.json().id}/print`, { format: "thermal", lang: "both" }, "cashier");
    expect(pr.statusCode, pr.body).toBe(201);
    const pdf = await c.get(pr.json().print.pdfUrl, "cashier");
    expect(pdf.statusCode).toBe(200); expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect((await c.post(`/v1/receipts/${r1.json().id}/print`, { format: "a5", lang: "en" }, "cashier")).json().code).toBe("reprint_needs_reason");
    // the running bills list; the interim bill (A4) and its reprint with a reason
    const list = (await c.get("/v1/ipd/bills", "cashier")).json().items;
    expect(list.find((x: { admissionId: string }) => x.admissionId === a.admissionId)).toMatchObject({ depositsPaisa: 800_000, depositState: "ok" });
    const ip = await c.post(`/v1/ipd/bills/${a.admissionId}/interim-prints`, { lang: "both" }, "cashier");
    expect(ip.statusCode, ip.body).toBe(201);
    expect((await c.post(`/v1/ipd/bills/${a.admissionId}/interim-prints`, { lang: "both" }, "cashier")).json().code).toBe("reprint_needs_reason");
    const ip2 = await c.post(`/v1/ipd/bills/${a.admissionId}/interim-prints`, { lang: "en", reason: "lost" }, "cashier");
    expect(ip2.json().items.map((x: { copy: number }) => x.copy)).toEqual([0, 1]);
    const ipdf = await c.get(ip2.json().items[1].pdfUrl, "cashier");
    expect(ipdf.statusCode).toBe(200); expect(ipdf.headers["content-disposition"]).toContain("DUPLICATE-1");
    // an OPD-style payment on the IPD bill is refused (deposits only); a payment on an OPD draft still is too (database)
    expect((await c.post(`/v1/invoices/${inv!.id}/payments`, { method: "cash", amountPaisa: 100, tenderedPaisa: 100 }, "cashier")).statusCode).toBe(404); // the OPD payment route never reaches it
  }, 60_000);
  it("low = under two days of the class's rate; a guardian with no mobile cannot get a link", async () => {
    const w = await h.ownWard(1);
    const a = await admit(w, { deposit: { method: "bank", amountPaisa: 350_000, reference: "EFT 2210" } });
    const b = await bill(a.admissionId); // day 1 ৳1,200 → balance ৳2,300 < ৳2,400
    expect(b.balancePaisa).toBe(230_000); expect(b.depositState).toBe("low");
    await tenant((tx) => tx.admission.update({ where: { id: a.admissionId }, data: { guardianPhone: null } }), "u_e2l_desk");
    const r = await c.post(`/v1/ipd/bills/${a.admissionId}/deposits`, { method: "bkash", amountPaisa: 100_000 }, "cashier");
    expect(r.statusCode).toBe(422); expect(r.json().code).toBe("no_phone");
  });
});

describe.runIf(db)("the discharge checklist (B9)", () => {
  it("six steps: the order (PIN) puts the bed to discharge-pending; the final bill starts at once; the summary, the bill and the payment finish by their events; the pharmacy and the patient leaving by PIN", async () => {
    const w = await h.ownWard(1);
    const a = await admit(w, { packageId: await pkgId("PKG-LAP-01") });
    expect((await c.post(`/v1/ipd/admissions/${a.admissionId}/discharge`, { advice: "Pain settled, eating normally", pin: "1234" }, "nurse")).statusCode).toBe(403);
    expect((await c.post(`/v1/ipd/admissions/${a.admissionId}/discharge`, { advice: "Pain settled, eating normally", pin: "0000" }, "surgeon")).statusCode).toBe(401);
    const o = await c.post(`/v1/ipd/admissions/${a.admissionId}/discharge`, { advice: "Pain settled, eating normally", pin: "1234" }, "surgeon");
    expect(o.statusCode, o.body).toBe(201);
    let v = o.json();
    // Kamrul, 2: the bill does not wait for the pharmacy — leaving does
    expect(v.steps.map((x: { key: string; status: string }) => `${x.key}:${x.status}`)).toEqual(["order:done", "summary:in-progress", "pharmacy:in-progress", "final-bill:in-progress", "payment:waiting", "bed-release:waiting"]);
    expect(v.header).toMatchObject({ done: 1, total: 6, blockedBy: [{ key: "final-bill", department: "billing" }] });
    expect(v.discharge.kind).toBe("normal");
    const bed = await tenant((tx) => tx.location.findFirst({ where: { id: a.admission.bed.id } }));
    expect(bed!.bedState).toBe("discharge_pending");
    expect((await c.post(`/v1/ipd/admissions/${a.admissionId}/transfer`, { bedId: a.admission.bed.id, reason: "test move", mode: "now" }, "nurse")).json().code).toBe("discharge_ordered");
    const id = v.discharge.id;
    v = (await c.post(`/v1/ipd/discharges/${id}/steps/pharmacy/take`, {}, "pharm")).json();
    expect(v.steps.find((x: { key: string }) => x.key === "pharmacy").takenBy.id).toBe("u_e2l_pharm");
    // the event steps are never marked by hand (the B9 by-hand steps are gone)
    for (const [k, who] of [["final-bill", "cashier"], ["payment", "cashier"], ["summary", "surgeon"]] as const)
      expect((await c.post(`/v1/ipd/discharges/${id}/steps/${k}/done`, { pin: "1234" }, who)).json().code).toMatch(/step_by_event|step_waiting/);
    expect((await c.post(`/v1/ipd/discharges/${id}/steps/pharmacy/done`, { pin: "1234", ownMedicines: "none" }, "nurse")).statusCode).toBe(403);
    expect((await c.post(`/v1/ipd/discharges/${id}/steps/pharmacy/done`, { pin: "1234" }, "pharm")).json().code).toBe("own_medicines");
    v = (await c.post(`/v1/ipd/discharges/${id}/steps/pharmacy/done`, { pin: "1234", ownMedicines: "handed-back" }, "pharm")).json();
    expect(v.steps.find((x: { key: string }) => x.key === "bed-release").status).toBe("waiting"); // the summary and the payment first
    // remind: the summary is the doctor's — it reaches the doctor's inbox; at most once in 10 minutes
    expect((await c.post(`/v1/ipd/discharges/${id}/steps/summary/remind`, {}, "nurse")).statusCode).toBe(200);
    expect((await c.post(`/v1/ipd/discharges/${id}/steps/summary/remind`, {}, "nurse")).json().code).toBe("reminded_recently");
    const inbox = await tenant((tx) => tx.communication.findFirst({ where: { kind: "discharge-remind", encounterId: a.encounterId } }));
    expect(inbox!.recipientUserId).toBe("u_e2l_surgeon");
    // B10: the cashier issues the final bill — the step finishes by the event; the payment step starts
    const issued = await c.post(`/v1/ipd/bills/${a.admissionId}/issue`, {}, "cashier");
    expect(issued.statusCode, issued.body).toBe(200);
    expect(issued.json().final).toMatchObject({ status: "issued", duePaisa: 4_800_000, excessPaisa: 0 });
    v = (await c.get(`/v1/ipd/admissions/${a.admissionId}/discharge`, "nurse")).json();
    expect(v.steps.find((x: { key: string }) => x.key === "final-bill")).toMatchObject({ status: "done", byHand: false, doneBy: expect.objectContaining({ id: "u_e2l_cashier" }) });
    expect(v.steps.find((x: { key: string }) => x.key === "payment").status).toBe("in-progress");
    // the shortfall at the counter (card): balanced → the payment step done by the event
    const paid = await c.post(`/v1/ipd/bills/${a.admissionId}/payments`, { method: "card", amountPaisa: 4_800_000, reference: "APPR 5520" }, "cashier");
    expect(paid.statusCode, paid.body).toBe(201);
    expect(paid.json().final.status).toBe("balanced");
    v = (await c.get(`/v1/ipd/admissions/${a.admissionId}/discharge`, "nurse")).json();
    expect(v.steps.find((x: { key: string }) => x.key === "payment").status).toBe("done");
    expect(v.header.blockedBy).toEqual([expect.objectContaining({ key: "summary", department: "doctor", person: expect.objectContaining({ id: "u_e2l_surgeon" }) })]);
    // B11: the summary signed → its step done; the patient may leave
    await signSummary(a.admissionId);
    v = (await c.get(`/v1/ipd/admissions/${a.admissionId}/discharge`, "nurse")).json();
    expect(v.steps.find((x: { key: string }) => x.key === "bed-release").status).toBe("in-progress");
    expect((await c.post(`/v1/ipd/discharges/${id}/steps/bed-release/done`, { pin: "0000" }, "nurse")).statusCode).toBe(401);
    v = (await c.post(`/v1/ipd/discharges/${id}/steps/bed-release/done`, { pin: "1234" }, "nurse")).json();
    expect(v.discharge.status).toBe("completed"); expect(v.header).toMatchObject({ done: 6, complete: true }); expect(v.admission.visitFinished).toBe(true);
    const after = await tenant(async (tx) => ({
      adm: await tx.admission.findFirst({ where: { id: a.admissionId } }), enc: await tx.encounter.findFirst({ where: { id: a.encounterId } }),
      bed: await tx.location.findFirst({ where: { id: a.admission.bed.id } }), asg: await tx.bedAssignment.findFirst({ where: { encounterId: a.encounterId }, orderBy: { createdAt: "desc" } }),
      inv: await tx.invoice.findFirst({ where: { encounterId: a.encounterId, kind: "ipd" } }),
    }));
    expect(after.adm).toMatchObject({ status: "discharged" }); expect(after.enc!.status).toBe("finished");
    // B12: the bed to cleaning with a note the ward board shows
    expect(after.bed!.bedState).toBe("cleaning"); expect(after.bed!.bedNote).toMatch(/^ছুটি \/ Discharged \d\d:\d\d · /); expect(after.asg).toMatchObject({ status: "ended", endReason: "discharged" });
    expect(after.inv!.status).toBe("balanced");
    // the census never posts after the release
    expect(await censusOf(T, a.admissionId, new Date(Date.now() + 3 * DAY))).toBe(0);
    expect(await tenant((tx) => tx.chargeItem.count({ where: { invoice: { encounterId: a.encounterId }, source: "bed_day", creditOfId: null } }))).toBe(1);
  });
  it("the doctor cancels before the bed release: the bed back to occupied; a discharged admission is only reached through the checklist (database)", async () => {
    const w = await h.ownWard(1);
    const a = await admit(w);
    const o = (await c.post(`/v1/ipd/admissions/${a.admissionId}/discharge`, { advice: "Fever settled, home tomorrow", pin: "1234" }, "surgeon")).json();
    expect((await c.post(`/v1/ipd/discharges/${o.discharge.id}/cancel`, { reason: "short", pin: "1234" }, "surgeon")).statusCode).toBe(400);
    const cn = await c.post(`/v1/ipd/discharges/${o.discharge.id}/cancel`, { reason: "Spiked a fever this morning", pin: "1234" }, "surgeon");
    expect(cn.statusCode, cn.body).toBe(200);
    expect((await tenant((tx) => tx.location.findFirst({ where: { id: a.admission.bed.id } })))!.bedState).toBe("occupied");
    // ordered again later: a new discharge
    expect((await c.post(`/v1/ipd/admissions/${a.admissionId}/discharge`, { advice: "Fever settled now, home today", pin: "1234" }, "surgeon")).statusCode).toBe(201);
    await expect(tenant((tx) => tx.admission.update({ where: { id: a.admissionId }, data: { status: "discharged", dischargedAt: new Date(), dischargedById: "u_e2l_nurse" } }), "u_e2l_nurse")).rejects.toThrow(/through the checklist/);
    await expect(tenant((tx) => tx.dischargeStep.updateMany({ where: { discharge: { admissionId: a.admissionId, status: "ordered" }, key: "payment" }, data: { status: "in-progress", startedAt: new Date() } }), "u_e2l_cashier")).rejects.toThrow(/waits for its earlier steps/);
  });
});

describe.runIf(db)("the review (session 2)", () => {
  it("the OPD bill routes never reach the IPD running bill; the database never voids it", async () => {
    const w = await h.ownWard(1);
    const a = await admit(w);
    const inv = a.admission.invoice.id as string;
    expect((await c.post(`/v1/invoices/${inv}/void`, { reason: "Opened by mistake, void it" }, "owner")).statusCode).toBe(404);
    expect((await c.post(`/v1/invoices/${inv}/issue`, { rev: 1 }, "cashier")).statusCode).toBe(404);
    await expect(tenant((tx) => tx.invoice.update({ where: { id: inv }, data: { status: "entered_in_error", voidReason: "test: void the IPD bill", voidedById: "u_e2l_owner", voidedAt: new Date() } }), "u_e2l_owner")).rejects.toThrow(/never voided/);
  });
  it("a price-list change never re-prices an order already on the bill", async () => {
    const w = await h.ownWard(1);
    const a = await admit(w);
    const open = (await c.post(`/v1/ipd/encounters/${a.encounterId}/round/open`, {}, "surgeon")).json().draft;
    const saved = await c.put(`/v1/ipd/round-notes/${open.id}`, { rev: open.rev, sections: { s: "", o: "", a: "Check", p: "Bloods" }, lines: [], orders: [{ testCode: "rbs", priority: "routine" }] });
    expect((await c.post(`/v1/ipd/round-notes/${open.id}/sign`, { rev: saved.json().draft.rev, pin: "1234" }, "surgeon")).statusCode).toBe(200);
    const before = live(await bill(a.admissionId)).find((l) => l.source === "order")!;
    const def = await tenant((tx) => tx.chargeItemDefinition.findFirst({ where: { organizationId: "o_e2e_lite", code: "test:rbs" } }));
    const change = (unitPaisa: number) => c.post(`/v1/admin/prices/${def!.id}`, { unitPaisa, vatRateBp: def!.vatRateBp, reason: "test: the price list changes" }, "admin");
    expect((await change(def!.unitPaisa! + 10_000)).statusCode).toBe(200);
    try {
      const after = live(await bill(a.admissionId)).find((l) => l.source === "order")!;
      expect(after.unitPaisa).toBe(before.unitPaisa);
    } finally { await change(def!.unitPaisa!); }
  });
  it("the final bill is refused while a deposit link waits (decision 2: never while the pharmacy works)", async () => {
    const w = await h.ownWard(1);
    const a = await admit(w);
    expect((await c.post(`/v1/ipd/bills/${a.admissionId}/issue`, {}, "cashier")).json().code).toBe("final_not_ordered");
    expect((await c.post(`/v1/ipd/admissions/${a.admissionId}/discharge`, { advice: "Settled, home today with advice", pin: "1234" }, "surgeon")).statusCode).toBe(201);
    expect((await c.post(`/v1/ipd/bills/${a.admissionId}/deposits`, { method: "bkash", amountPaisa: 100_000 }, "cashier")).statusCode).toBe(201);
    expect((await c.post(`/v1/ipd/bills/${a.admissionId}/issue`, {}, "cashier")).json().code).toBe("final_link_pending");
    const p = (await bill(a.admissionId)).deposits.items.find((d) => d.method === "bkash")!;
    expect((await c.post(`/v1/payments/${p.id}/cancel`, {}, "cashier")).statusCode).toBe(200);
    const r = await c.post(`/v1/ipd/bills/${a.admissionId}/issue`, {}, "cashier");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().final).toMatchObject({ status: "issued", depositsPaisa: 0, duePaisa: 120_000 });
  });
});

describe.runIf(db)("who and where", () => {
  it("the IPD bill is the cashier's, the owner's or the admin's; the Clinic plan sees the lock", async () => {
    const w = await h.ownWard(1);
    const a = await admit(w);
    expect((await c.get(`/v1/ipd/bills/${a.admissionId}`, "nurse")).statusCode).toBe(403);
    expect((await c.get(`/v1/ipd/bills/${a.admissionId}`, "owner")).statusCode).toBe(200);
    const clinic = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: "01722000004", password: "setu1234" } }); // the Clinic-plan demo
    const cookie = [clinic.headers["set-cookie"]].flat()[0] as string;
    const r = await app.inject({ method: "GET", url: `/v1/ipd/bills/${a.admissionId}`, headers: { cookie } });
    expect(r.statusCode).toBe(403); expect(r.json().reason).toBe("plan");
  });
});
