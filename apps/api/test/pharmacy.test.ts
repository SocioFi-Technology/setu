/* Pharmacy session 1 contract tests on the real database (as setu_app), in the seeded E2E Test Clinic (ADR 0009):
   - the queue shows today's signed prescriptions; the dispense view proposes FEFO from the counter, never an expired
     batch, and prints the Bangla dose label;
   - a partial dispense moves exactly that stock and bills it on the visit's pharmacy bill at the batch MRP (the OPD bill
     is untouched); more than is left, an expired-only medicine, a different generic or a substitute without a reason
     are refused; a same-generic substitute tells the prescribing doctor; the rest can be declined with a reason;
   - after an amendment the old version is refused and what was given counts against the new line;
   - the pharmacist issues and takes money on the pharmacy bill, never sees an OPD bill, and holds a shift;
   - over the counter: OTC items sell, prescription-only items need a photo, controlled items never; stock moves on issue;
     the billing issue route refuses an OTC bill; no discount; the receipt names the walk-in buyer;
   - the database refuses a mispriced medicine line, removing a dispense line and stock below zero;
   - the doctor is denied; another tenant finds nothing. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("pharmacy.test: DATABASE_URL_APP not set — pharmacy contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const cookies: Record<string, string> = {};
const T = "t_e2e";
const USERS = { desk: "01799000001", doctor: "01799000002", pharm: "01799000007", cashier: "01799000008", owner: "01799000009", otherPharm: "01711000007" } as const;
type Who = keyof typeof USERS;
const TODAY = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of Object.entries(USERS)) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; cookies[k] = Array.isArray(c) ? c[0]! : (c as string);
  }
  // Repeated runs use up the sample counter stock: top the usable counter batches back up to their opening quantity
  // with an `adjust` move (the ledger stays append-only), as pnpm reset-e2e does.
  await db.forTenant(T, async (tx) => {
    const opening = await tx.stockMove.groupBy({ by: ["batchId"], where: { refType: "seed" }, _sum: { qty: true } });
    for (const b of await tx.stockBatch.findMany({ where: { location: "counter", expiry: { gte: TODAY }, sample: true } })) {
      const want = opening.find((o) => o.batchId === b.id)?._sum.qty ?? 0;
      if (b.qtyOnHand < want) await tx.stockMove.create({ data: { tenantId: T, organizationId: b.organizationId, batchId: b.id, kind: "adjust", qty: want - b.qtyOnHand, refType: "test-top-up", reason: "api test: sample stock top-up", byId: "u_e2e_pharm" } });
    }
  }, { userId: "u_e2e_pharm" });
});
afterAll(async () => { await app.close(); });

const get = (url: string, who: Who = "pharm") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const post = (url: string, payload: object = {}, who: Who = "pharm", key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const put = (url: string, payload: object, who: Who = "doctor") => app.inject({ method: "PUT", url, payload, headers: { cookie: cookies[who]!, "idempotency-key": randomUUID() } });
const inTenant = <R>(fn: (tx: NonNullable<typeof db>["prisma"]) => Promise<R>) => db!.forTenant(T, fn as never) as Promise<R>;

type Med = { medicineKey: string; dose: string; meal: string; days: number };
const note = (medications: Med[]) => ({
  sections: { complaints: [{ text: "Fever and body ache", duration: { n: 3, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
  sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications, orders: [],
});
const COMET: Med = { medicineKey: "comet", dose: "1+0+1", meal: "after", days: 30 }; // 60 tablets
const NAPA: Med = { medicineKey: "napa", dose: "1+1+1", meal: "after", days: 3 }; // 9 tablets — E2E has only an expired Napa batch

/** A new synthetic patient's visit, signed by the E2E doctor with Comet 500 for 30 days and Napa for 3 days. */
async function signedVisit(meds: Med[] = [COMET, NAPA]) {
  const r = await post("/v1/patients", {
    nameBn: "রহিম উদ্দিন", nameEn: `Pharmacy Patient ${RUN}`, sex: "male", dobMode: "dob", dob: "04/04/1970", phone: `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self",
    division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
  }, "desk");
  expect(r.statusCode, r.body).toBe(201);
  const enc = r.json().encounter.id as string;
  const v = (await post(`/v1/encounters/${enc}/consultation/open`, {}, "doctor")).json();
  const saved = await put(`/v1/compositions/${v.draft.id}`, { rev: 1, ...note(meds) });
  expect(saved.statusCode, saved.body).toBe(200);
  const s = await post(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.json().rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor");
  expect(s.statusCode, s.body).toBe(200);
  return { enc, patient: r.json().patient.id as string, compositionId: v.draft.id as string };
}
type Line = { requestId: string; prescribed: { key: string }; status: string; dispensedQty: number; remaining: number; proposal: { allocations: { batch: { id: string; batchNo: string; expiry: string }; qty: number }[]; shortfall: number }; batches: { batchNo: string; state: string }[]; substitutes: { medicine: { key: string }; available: number; allergy: boolean }[]; label: { bn: string; en: string } };
const lineOf = (view: { lines: Line[] }, key: string) => view.lines.find((l) => l.prescribed.key === key)!;
const qtyOf = (batchId: string) => inTenant((tx) => tx.stockBatch.findFirst({ where: { id: batchId } })).then((b) => b!.qtyOnHand);
/** The earliest-expiring usable counter batch of a medicine, as the database sees it now (tests run repeatedly). */
const fefoFirst = (org: string, key: string) => inTenant((tx) => tx.stockBatch.findFirst({ where: { organizationId: org, medicineKey: key, location: { in: ["counter", "fridge"] }, expiry: { gte: TODAY }, qtyOnHand: { gt: 0 } }, orderBy: [{ expiry: "asc" }, { id: "asc" }] }));

describe.runIf(db)("P1–P3 dispense against the signed prescription", () => {
  it("queue → FEFO proposal → partial dispense → refusals → substitute (doctor told) → decline the rest", { timeout: 30_000 }, async () => {
    const { enc, compositionId } = await signedVisit();
    const org = (await inTenant((tx) => tx.encounter.findFirst({ where: { id: enc } })))!.organizationId;

    // the queue: today's signed prescriptions, still to dispense
    const q = await get("/v1/pharmacy/queue");
    expect(q.statusCode, q.body).toBe(200);
    expect(q.json().items.find((i: { encounter: { id: string } }) => i.encounter.id === enc)).toMatchObject({ status: "to-dispense", lineCount: 2, bill: null });

    // the view: FEFO from the earliest usable batch, never the expired one; Napa has only an expired batch
    const v0 = await get(`/v1/pharmacy/encounters/${enc}`);
    expect(v0.statusCode, v0.body).toBe(200);
    const comet0 = lineOf(v0.json(), "comet");
    const first = (await fefoFirst(org, "comet"))!;
    expect(comet0).toMatchObject({ status: "to-dispense", remaining: 60, dispensedQty: 0 });
    expect(comet0.proposal.allocations[0]!.batch.id).toBe(first.id);
    expect(comet0.proposal.allocations.map((a) => a.batch.batchNo)).not.toContain("CM2508");
    expect(comet0.batches.find((b) => b.batchNo === "CM2508")?.state).toBe("expired");
    expect(comet0.label).toEqual({ bn: "সকালে ১টি, রাতে ১টি · খাবারের পরে · ৩০ দিন", en: "Morning 1, Night 1 · After food · 30 days" });
    const napa0 = lineOf(v0.json(), "napa");
    expect(napa0.proposal).toEqual({ allocations: [], shortfall: 9 });
    expect(napa0.substitutes.find((x) => x.medicine.key === "ace")).toMatchObject({ allergy: false, available: expect.any(Number) });

    // partial: 20 of 60 Comet — exactly 20 leave the shelf, billed at the batch MRP on the pharmacy bill
    const before = await qtyOf(first.id);
    const key = randomUUID();
    const d1 = await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: comet0.requestId, medicineKey: "comet", qty: 20 }] }, "pharm", key);
    expect(d1.statusCode, d1.body).toBe(200);
    expect(lineOf(d1.json(), "comet")).toMatchObject({ status: "partial", dispensedQty: 20, remaining: 40 });
    const taken = Math.min(20, before);
    expect(await qtyOf(first.id)).toBe(before - taken);
    // a replay answers the stored response and moves nothing again
    const again = await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: comet0.requestId, medicineKey: "comet", qty: 20 }] }, "pharm", key);
    expect(again.statusCode).toBe(200);
    expect(await qtyOf(first.id)).toBe(before - taken);
    const bill = d1.json().bill;
    expect(bill).toMatchObject({ status: "draft", number: null, totalPaisa: 20 * first.mrpPaisa });
    const invs = await inTenant((tx) => tx.invoice.findMany({ where: { encounterId: enc } }));
    expect(invs.map((i) => i.kind)).toEqual(["pharmacy"]); // the OPD bill is untouched (none was made)

    // refusals
    const over = await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: comet0.requestId, medicineKey: "comet", qty: 41 }] });
    expect([over.statusCode, over.json().code, over.json().remaining]).toEqual([422, "qty_over_remaining", 40]);
    const expired = await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: napa0.requestId, medicineKey: "napa", qty: 9 }] });
    expect([expired.statusCode, expired.json().code, expired.json().shortfall]).toEqual([409, "stock_short", 9]);
    const otherGeneric = await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: napa0.requestId, medicineKey: "seclo", qty: 9, reason: "Napa out of stock today" }] });
    expect([otherGeneric.statusCode, otherGeneric.json().code]).toEqual([422, "not_same_generic"]);
    const noReason = await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: napa0.requestId, medicineKey: "ace", qty: 9 }] });
    expect([noReason.statusCode, noReason.json().code, noReason.json().field]).toEqual([400, "reason_required", "lines.0.reason"]);

    // same-generic substitute with a reason: given, billed, and the prescribing doctor's inbox is told
    const sub = await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: napa0.requestId, medicineKey: "ace", qty: 9, reason: "Napa batch expired — same paracetamol" }] });
    expect(sub.statusCode, sub.body).toBe(200);
    const napa1 = sub.json().lines.find((l: Line) => l.prescribed.key === "napa");
    expect(napa1).toMatchObject({ status: "dispensed", dispensedQty: 9 });
    expect(napa1.given[0]).toMatchObject({ medicine: { key: "ace" }, substitute: true, reason: "Napa batch expired — same paracetamol", qty: 9 });
    const inbox = await get("/v1/doctor/inbox?days=1", "doctor");
    expect(inbox.statusCode, inbox.body).toBe(200);
    const notice = inbox.json().items.find((i: { kind: string; encounter: { id: string } }) => i.kind === "substitution-notice" && i.encounter.id === enc);
    expect(notice).toMatchObject({ severity: "notice", substitution: { prescribed: { brand: "Napa" }, given: { brand: "Ace" }, qty: 9, reason: "Napa batch expired — same paracetamol", by: { nameEn: "Test Pharmacist" } } });

    // decline the rest of Comet with a reason → partial-declined; the visit is done in the queue
    const shortReason = await post(`/v1/pharmacy/encounters/${enc}/decline`, { compositionId, requestId: comet0.requestId, reason: "later" });
    expect([shortReason.statusCode, shortReason.json().code]).toEqual([400, "reason_required"]);
    const dec = await post(`/v1/pharmacy/encounters/${enc}/decline`, { compositionId, requestId: comet0.requestId, reason: "Patient will buy the rest next month" });
    expect(dec.statusCode, dec.body).toBe(200);
    expect(lineOf(dec.json(), "comet")).toMatchObject({ status: "partial-declined", dispensedQty: 20, remaining: 0 });
    const q2 = await get("/v1/pharmacy/queue");
    expect(q2.json().items.find((i: { encounter: { id: string } }) => i.encounter.id === enc)).toMatchObject({ status: "done" });
    const closed = await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: comet0.requestId, medicineKey: "comet", qty: 1 }] });
    expect([closed.statusCode, closed.json().code]).toEqual([409, "line_declined"]);

    // the ledger: one dispense move per batch taken, referenced; the bill's lines are what was given
    const rows = await inTenant((tx) => tx.medicationDispense.findMany({ where: { encounterId: enc }, orderBy: { at: "asc" } }));
    const moves = await inTenant((tx) => tx.stockMove.findMany({ where: { refType: "dispense", refId: { in: rows.map((r) => r.id) } } }));
    expect(moves.reduce((a, m) => a + m.qty, 0)).toBe(-29);
    const lines = await inTenant((tx) => tx.chargeItem.findMany({ where: { invoiceId: bill.id } }));
    expect(lines.every((l) => l.source === "dispense" && l.batchId && l.medicineKey)).toBe(true);
    expect(lines.reduce((a, l) => a + l.qty, 0)).toBe(29);
  });

  it("after an amendment the old version is refused, and what was given counts against the new line", async () => {
    const { enc, compositionId } = await signedVisit([COMET]);
    const v0 = (await get(`/v1/pharmacy/encounters/${enc}`)).json();
    const d = await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: lineOf(v0, "comet").requestId, medicineKey: "comet", qty: 20 }] });
    expect(d.statusCode, d.body).toBe(200);
    const am = await post(`/v1/compositions/${compositionId}/amend`, { reason: "Shorter course — review in 2 weeks" }, "doctor");
    expect(am.statusCode, am.body).toBe(201);
    const v2 = am.json().draft;
    const saved = await put(`/v1/compositions/${v2.id}`, { rev: 1, ...note([{ ...COMET, days: 15 }]) });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await post(`/v1/compositions/${v2.id}/sign`, { rev: saved.json().rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor")).statusCode).toBe(200);
    const stale = await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: lineOf(v0, "comet").requestId, medicineKey: "comet", qty: 5 }] });
    expect([stale.statusCode, stale.json().code]).toEqual([409, "prescription_changed"]);
    const v = (await get(`/v1/pharmacy/encounters/${enc}`)).json();
    expect(v.composition).toMatchObject({ id: v2.id, version: 2, status: "amended" });
    expect(lineOf(v, "comet")).toMatchObject({ quantity: 30, dispensedQty: 20, remaining: 10, status: "partial" });
  });

  it("the pharmacist issues and takes cash on the pharmacy bill, never sees an OPD bill, and holds a shift", async () => {
    const { enc, compositionId } = await signedVisit([COMET]);
    const v0 = (await get(`/v1/pharmacy/encounters/${enc}`)).json();
    const d = (await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: lineOf(v0, "comet").requestId, medicineKey: "comet", qty: 60 }] })).json();
    const view = (await get(`/v1/invoices/${d.bill.id}`)).json();
    expect(view.invoice).toMatchObject({ kind: "pharmacy", buyer: null, status: "draft" });
    expect(view.lines[0].batch).toMatchObject({ batchNo: expect.any(String), expiry: expect.any(String) });
    const issued = await post(`/v1/invoices/${d.bill.id}/issue`, { rev: view.invoice.rev });
    expect(issued.statusCode, issued.body).toBe(200);
    const total = issued.json().invoice.totalPaisa;
    const paid = await post(`/v1/invoices/${d.bill.id}/payments`, { method: "cash", amountPaisa: total, tenderedPaisa: total });
    expect(paid.statusCode, paid.body).toBe(201);
    expect(paid.json().view.invoice.status).toBe("balanced");
    // the OPD bill of the same visit: hidden from the pharmacist; billing's worklist: denied
    const opd = await post(`/v1/encounters/${enc}/invoice`, {}, "cashier");
    expect(opd.statusCode, opd.body).toBe(201);
    expect((await get(`/v1/invoices/${opd.json().invoice.id}`)).statusCode).toBe(404);
    expect((await get("/v1/billing/worklist")).statusCode).toBe(403);
    expect((await get("/v1/shifts/mine")).statusCode).toBe(200);
  });
});

describe.runIf(db)("review fixes (clinical, money)", () => {
  it("another strength is never a substitute; a substitute then amended to is not given twice; given medicine is never voided off its bill", { timeout: 30_000 }, async () => {
    const MOX: Med = { medicineKey: "moxacil", dose: "1+1+1", meal: "after", days: 7 }; // 21 capsules
    const { enc, compositionId } = await signedVisit([COMET, MOX]);
    const v0 = (await get(`/v1/pharmacy/encounters/${enc}`)).json();
    expect(lineOf(v0, "comet").substitutes.map((x) => x.medicine.key)).not.toContain("comet850");
    const strength = await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: lineOf(v0, "comet").requestId, medicineKey: "comet850", qty: 10, reason: "Comet 500 out of stock today" }] });
    expect([strength.statusCode, strength.json().code]).toEqual([422, "not_same_generic"]);
    // Fimoxyl given for Moxacil, then the doctor amends the line to Fimoxyl: the 21 given count against it
    const sub = await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: lineOf(v0, "moxacil").requestId, medicineKey: "fimoxyl", qty: 21, reason: "Moxacil out of stock today" }] });
    expect(sub.statusCode, sub.body).toBe(200);
    const am = await post(`/v1/compositions/${compositionId}/amend`, { reason: "Change to the brand the patient received" }, "doctor");
    expect(am.statusCode, am.body).toBe(201);
    const v2 = am.json().draft;
    const saved = await put(`/v1/compositions/${v2.id}`, { rev: 1, ...note([COMET, { ...MOX, medicineKey: "fimoxyl" }]) });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await post(`/v1/compositions/${v2.id}/sign`, { rev: saved.json().rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor")).statusCode).toBe(200);
    const v = (await get(`/v1/pharmacy/encounters/${enc}`)).json();
    expect(lineOf(v, "fimoxyl")).toMatchObject({ dispensedQty: 21, remaining: 0, status: "dispensed" });
    expect(lineOf(v, "comet")).toMatchObject({ dispensedQty: 0, remaining: 60 });
    const twice = await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId: v2.id, lines: [{ requestId: lineOf(v, "fimoxyl").requestId, medicineKey: "fimoxyl", qty: 1 }] });
    expect([twice.statusCode, twice.json().code]).toEqual([422, "qty_over_remaining"]);
    // the owner cannot void the pharmacy bill: the medicine has left the shelf (returns come later)
    const voided = await post(`/v1/invoices/${sub.json().bill.id}/void`, { reason: "Wrong patient was billed" }, "owner");
    expect([voided.statusCode, voided.json().code]).toEqual([409, "medicine_given"]);
  });
  it("the database refuses a direct batch update by the app role", async () => {
    await expect(db!.forTenant(T, (tx) => tx.stockBatch.updateMany({ where: { medicineKey: "ace" }, data: { qtyOnHand: 9999 } }), { userId: "u_e2e_pharm" })).rejects.toThrow(/permission denied/);
  });
});

describe.runIf(db)("P4 over-the-counter sale", () => {
  it("OTC sells; Rx needs a photo; controlled never; stock moves on issue; walk-in receipt", { timeout: 30_000 }, async () => {
    const c = await post("/v1/pharmacy/otc", { buyerName: `Walk-in ${RUN}`, buyerPhone: "01712345678" });
    expect(c.statusCode, c.body).toBe(201);
    const id = c.json().bill.invoice.id as string;
    expect(c.json()).toMatchObject({ rxPhoto: false, blockers: [{ code: "no_lines" }], bill: { invoice: { kind: "otc", buyer: { name: `Walk-in ${RUN}`, phone: "1712345678" } }, encounter: null } });
    let rev = c.json().bill.invoice.rev as number;
    const expired = await post(`/v1/pharmacy/otc/${id}/lines`, { rev, medicineKey: "napa", qty: 10 });
    expect([expired.statusCode, expired.json().code]).toEqual([409, "stock_short"]);
    const ace = await post(`/v1/pharmacy/otc/${id}/lines`, { rev, medicineKey: "ace", qty: 10 });
    expect(ace.statusCode, ace.body).toBe(200);
    rev = ace.json().bill.invoice.rev;
    const rx = await post(`/v1/pharmacy/otc/${id}/lines`, { rev, medicineKey: "moxacil", qty: 15 });
    expect([rx.statusCode, rx.json().code]).toEqual([422, "rx_photo_required"]);
    const ctrl = await post(`/v1/pharmacy/otc/${id}/lines`, { rev, medicineKey: "sedil", qty: 5 });
    expect([ctrl.statusCode, ctrl.json().code]).toEqual([422, "controlled"]);
    const notImage = await post(`/v1/pharmacy/otc/${id}/rx-photo`, { rev, contentType: "image/png", dataBase64: Buffer.from("this is not a png image at all").toString("base64") });
    expect([notImage.statusCode, notImage.json().code]).toEqual([400, "not_an_image"]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    const photo = await post(`/v1/pharmacy/otc/${id}/rx-photo`, { rev, contentType: "image/png", dataBase64: png.toString("base64") });
    expect(photo.statusCode, photo.body).toBe(200);
    expect(photo.json().rxPhoto).toBe(true);
    rev = photo.json().bill.invoice.rev;
    const shown = await get(`/v1/pharmacy/otc/${id}/rx-photo`);
    expect([shown.statusCode, shown.headers["content-type"], shown.headers["x-content-type-options"], shown.headers["content-security-policy"]]).toEqual([200, "image/png", "nosniff", "default-src 'none'"]);
    const mox = await post(`/v1/pharmacy/otc/${id}/lines`, { rev, medicineKey: "moxacil", qty: 15 });
    expect(mox.statusCode, mox.body).toBe(200);
    rev = mox.json().bill.invoice.rev;
    expect(mox.json().blockers).toEqual([]);

    // no discount on an OTC sale; the billing issue route refuses it (stock must move first)
    const disc = await post(`/v1/invoices/${id}/discount`, { rev, mode: "amount", amountPaisa: 100, category: "staff", reason: "Staff family discount" }, "owner");
    expect([disc.statusCode, disc.json().code]).toEqual([409, "no_discount_otc"]);
    const wrongIssue = await post(`/v1/invoices/${id}/issue`, { rev });
    expect([wrongIssue.statusCode, wrongIssue.json().code]).toEqual([409, "issue_as_sale"]);

    const lines = await inTenant((tx) => tx.chargeItem.findMany({ where: { invoiceId: id } }));
    const before = await Promise.all(lines.map((l) => qtyOf(l.batchId!)));
    const issued = await post(`/v1/pharmacy/otc/${id}/issue`, { rev });
    expect(issued.statusCode, issued.body).toBe(200);
    expect(issued.json().bill.invoice).toMatchObject({ status: "issued", number: expect.stringMatching(/^INV\//) });
    const after = await Promise.all(lines.map((l) => qtyOf(l.batchId!)));
    expect(before.reduce((a, b) => a + b, 0) - after.reduce((a, b) => a + b, 0)).toBe(25);

    const total = issued.json().bill.invoice.totalPaisa;
    const paid = await post(`/v1/invoices/${id}/payments`, { method: "cash", amountPaisa: total, tenderedPaisa: total + 1000 });
    expect(paid.statusCode, paid.body).toBe(201);
    const pay = await inTenant((tx) => tx.payment.findFirst({ where: { invoiceId: id } }));
    expect(pay!.patientId).toBeNull();
    const rc = await post(`/v1/invoices/${id}/receipts`, {});
    expect(rc.statusCode, rc.body).toBe(201);
    expect(rc.json().receipt.snapshot.patient).toEqual({ nameBn: `Walk-in ${RUN}`, nameEn: `Walk-in ${RUN}`, facilityNo: "" });
  });
});

describe.runIf(db)("the database keeps money and stock together (ADR 0009)", () => {
  it("refuses a medicine line not at its batch MRP, removing a dispense line, and stock below zero", async () => {
    const c = (await post("/v1/pharmacy/otc", {})).json();
    const id = c.bill.invoice.id as string;
    const b = (await inTenant((tx) => tx.stockBatch.findFirst({ where: { medicineKey: "ace", location: "counter", qtyOnHand: { gt: 0 } } })))!;
    await expect(inTenant((tx) => tx.chargeItem.create({ data: {
      tenantId: T, invoiceId: id, position: 1, addedById: "u_e2e_pharm", source: "sale", code: "med:ace", nameEn: "Ace", nameBn: "Ace",
      unitPaisa: b.mrpPaisa - 1, vatRateBp: b.vatRateBp, batchId: b.id, medicineKey: "ace", qty: 1, grossPaisa: b.mrpPaisa - 1, discountPaisa: 0, netPaisa: b.mrpPaisa - 1, vatPaisa: 0, totalPaisa: b.mrpPaisa - 1,
    } }))).rejects.toThrow(/MRP/);
    await expect(db!.forTenant(T, (tx) => tx.stockMove.create({ data: { tenantId: T, organizationId: b.organizationId, batchId: b.id, kind: "adjust", qty: -(b.qtyOnHand + 1), reason: "test: below zero", byId: "u_e2e_pharm" } }), { userId: "u_e2e_pharm" })).rejects.toThrow(/cannot take/);
    const line = await inTenant((tx) => tx.chargeItem.findFirst({ where: { source: "dispense" } }));
    if (line) await expect(inTenant((tx) => tx.chargeItem.delete({ where: { id: line.id } }))).rejects.toThrow();
  });
});

describe.runIf(db)("who may", () => {
  it("the doctor is denied the pharmacy; another tenant's pharmacist finds nothing", async () => {
    const { enc } = await signedVisit([COMET]);
    expect((await get("/v1/pharmacy/queue", "doctor")).statusCode).toBe(403);
    expect((await get(`/v1/pharmacy/encounters/${enc}`, "otherPharm")).statusCode).toBe(404);
    const st = await get("/v1/pharmacy/stock?filter=expired");
    expect(st.statusCode, st.body).toBe(200);
    expect(st.json().items.map((i: { medicine: { key: string } }) => i.medicine.key)).toEqual(expect.arrayContaining(["napa", "comet"]));
  });
});
