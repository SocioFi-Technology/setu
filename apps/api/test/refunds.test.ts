/* ADR 0013 — refunds on the real database (E2E Test Clinic), new synthetic patients signed by the E2E doctor:
   - a cancelled test refunded in cash: performed lines locked, the owner approves in the single queue (never the
     requester), who took the money is required, the voucher RF/yy/nnnn, the bill's refunded money, the cashier's shift;
   - void after a full refund (ADR 0005 addendum); reject needs a note; withdraw is its own state;
   - the way back: a wallet on a gateway without a refund API is refunded by hand (flagged; the owner matches it), cash
     only without wallet access; card paid back in cash needs the owner, not an admin;
   - pharmacy returns: into quarantine, the dispense reversed by a return row, the line reopens, the doctor is told about a
     wrong dispense, re-dispense, resale to the counter; a controlled drug needs the owner;
   - reconciliation → refund to patient; the dashboard's refunds tile and leakage; the database's own guards. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeProvider } from "../src/adapters/payments/index.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { closePdfBrowser } from "../src/receipts/pdf.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("refunds.test: DATABASE_URL_APP not set — SKIPPED");
const T = "t_e2e";
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const cookies: Record<string, string> = {};
const USERS = { desk: "01799000001", doctor: "01799000002", pharm: "01799000007", cashier: "01799000008", owner: "01799000009", admin: "01799000010" } as const;
type Who = keyof typeof USERS;
const TODAY = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
const YY = TODAY.slice(2, 4);

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of Object.entries(USERS)) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; cookies[k] = Array.isArray(c) ? c[0]! : (c as string);
  }
  // sample counter stock topped up as pharmacy.test.ts does (owner connection; the app role adjusts only from a count)
  const owner = new db.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try {
    const opening = await owner.stockMove.groupBy({ by: ["batchId"], where: { tenantId: T, refType: "seed" }, _sum: { qty: true } });
    for (const b of await owner.stockBatch.findMany({ where: { tenantId: T, location: "counter", expiry: { gte: TODAY }, sample: true } })) {
      const want = opening.find((o) => o.batchId === b.id)?._sum.qty ?? 0;
      if (b.qtyOnHand < want) await owner.stockMove.create({ data: { tenantId: T, organizationId: b.organizationId, batchId: b.id, kind: "adjust", qty: want - b.qtyOnHand, refType: "test-top-up", reason: "api test: sample stock top-up", byId: "u_e2e_pharm" } });
    }
  } finally { await owner.$disconnect(); }
  for (const who of ["cashier", "pharm"] as const) await freshShift(who);
}, 90_000);
afterAll(async () => { await closePdfBrowser(); await app.close(); });

const get = (url: string, who: Who = "cashier") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const post = (url: string, payload: object = {}, who: Who = "cashier", key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const ok = <T = Record<string, any>>(r: { statusCode: number; body: string; json: () => unknown }, status = 200): T => { expect(r.statusCode, r.body).toBe(status); return r.json() as T; };
const inTenant = <R>(fn: (tx: NonNullable<typeof db>["prisma"]) => Promise<R>) => db!.forTenant(T, fn as never) as Promise<R>;

const notesFor = (paisa: number) => {
  let taka = Math.round(paisa / 100); const out: Record<string, number> = {};
  for (const d of [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1]) { const k = Math.floor(taka / d); if (k) { out[String(d)] = k; taka -= k * d; } }
  return out;
};
/** Close whatever shift an earlier run left, then open a new one with a ৳2,000 float. */
async function freshShift(who: "cashier" | "pharm") {
  const mine = ok(await get("/v1/shifts/mine", who));
  let sh = mine.shift;
  if (sh?.status === "open") sh = ok(await post(`/v1/shifts/${sh.id}/count`, { counts: notesFor(sh.live.expectedCashPaisa) }, who));
  if (sh?.status === "closed") ok(await post(`/v1/shifts/${sh.id}/review`, { decision: "approve", note: "closing a shift left by an earlier test run" }, "owner"));
  return ok(await post("/v1/shifts", { openingFloatPaisa: 200_000 }, who), 201);
}
/** A read on the owner connection (no RLS, no signed-in user) — for database checks only. */
async function owner2<R>(fn: (c: InstanceType<NonNullable<typeof db>["PrismaClient"]>) => Promise<R>): Promise<R> {
  const c = new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  try { return await fn(c); } finally { await c.$disconnect(); }
}
const myShift = async (who: "cashier" | "pharm" = "cashier") => ok(await get("/v1/shifts/mine", who)).shift;

type Med = { medicineKey: string; dose: string; meal: string; days: number };
async function signedVisit(o: { orders?: string[]; meds?: Med[] } = {}) {
  const r = await post("/v1/patients", {
    nameBn: "ফেরত রোগী", nameEn: `Refund ${RUN}`, sex: "female", dobMode: "dob", dob: "03/03/1983", phone: `017${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self",
    division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
  }, "desk");
  expect(r.statusCode, r.body).toBe(201);
  const enc = r.json().encounter.id as string;
  const v = (await post(`/v1/encounters/${enc}/consultation/open`, {}, "doctor")).json();
  const saved = await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: cookies.doctor!, "idempotency-key": randomUUID() }, payload: {
    rev: 1, sections: { complaints: [{ text: "Fever", duration: { n: 2, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: o.meds ?? [], orders: (o.orders ?? []).map((testCode) => ({ testCode, priority: "routine" })),
  } });
  expect(saved.statusCode, saved.body).toBe(200);
  ok(await post(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.json().rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor"));
  return { enc, compositionId: v.draft.id as string };
}
/** An issued OPD bill (consultation ৳800 + the orders), optionally paid. */
async function opdBill(orders: string[], pay?: { method: "cash" | "card" | "bkash" | "nagad"; amountPaisa?: number }) {
  const { enc } = await signedVisit({ orders });
  const v0 = ok(await post(`/v1/encounters/${enc}/invoice`), 201);
  const v = ok(await post(`/v1/invoices/${v0.invoice.id}/issue`, { rev: v0.invoice.rev }));
  if (pay) {
    const amountPaisa = pay.amountPaisa ?? v.invoice.totalPaisa;
    const body = pay.method === "cash" ? { method: "cash", amountPaisa, tenderedPaisa: amountPaisa } : pay.method === "card" ? { method: "card", amountPaisa, reference: "APPR123" } : { method: pay.method, amountPaisa };
    const p = ok(await post(`/v1/invoices/${v.invoice.id}/payments`, body), 201).payment;
    if (pay.method === "bkash" || pay.method === "nagad") {
      const ref = (await inTenant((tx) => tx.payment.findFirst({ where: { id: p.id } })))!.providerRef!;
      const cb = fakeProvider()!.simulate(ref, "confirmed")!;
      expect((await app.inject({ method: "POST", url: "/v1/payments/callback/fake", payload: cb.body, headers: cb.headers })).json()).toMatchObject({ outcome: "applied" });
    }
  }
  return { enc, view: ok(await get(`/v1/invoices/${v.invoice.id}`)) };
}
const lineOf = (v: { lines: { code: string; id: string }[] }, code: string) => v.lines.find((l) => l.code === code)!;
const recipient = { name: "Rashed Chowdhury", phone: "01711908812", relation: "spouse" };
/** Approve through the single Approvals queue (by the refund's task). */
async function approve(refundId: string, who: Who = "owner") {
  const item = ok(await get("/v1/approvals", "owner")).items.find((i: { refund: { id: string } | null }) => i.refund?.id === refundId);
  expect(item).toBeTruthy();
  return post(`/v1/approvals/${item.taskId}/approve`, {}, who);
}

describe.runIf(db)("a cancelled test refunded in cash (bill/refund)", () => {
  it("RBS not collected: requested, approved by the owner, paid with who took it — voucher, bill and shift", { timeout: 30_000 }, async () => {
    const { view } = await opdBill(["cbc", "rbs"], { method: "cash" }); // ৳800 + 450 + 150 = ৳1,400
    const id = view.invoice.id;
    const shiftBefore = await myShift();
    const rb = ok(await get(`/v1/invoices/${id}/refundable`));
    expect(rb).toMatchObject({ confirmedLeftPaisa: 140_000, blockers: [], openRefundId: null });
    expect(rb.lines.find((l: { source: string }) => l.source === "consultation")).toMatchObject({ lock: "performed" });
    const rbs = lineOf(view, "test:rbs"), cbc = lineOf(view, "test:cbc"), consult = view.lines.find((l: { source: string }) => l.source === "consultation");
    expect(rb.lines.find((l: { id: string }) => l.id === rbs.id)).toMatchObject({ lock: null, left: { totalPaisa: 15_000, qty: 1 } });
    const cash = rb.payments[0];
    expect(cash).toMatchObject({ method: "cash", leftPaisa: 140_000, ways: ["cash"], gatewayRefunds: false });

    const req = (lines: object[], amountPaisa: number, o: object = {}) => ({ category: "cancelled-test", reason: "RBS not done — patient left before collection", lines, allocations: [{ paymentId: cash.id, amountPaisa, way: "cash" }], ...o });
    // the consultation was given; more than the line; a reason under 10 characters; not a test for "cancelled test"
    expect(ok(await post(`/v1/invoices/${id}/refunds`, req([{ chargeItemId: consult.id, amountPaisa: 80_000 }], 80_000), "cashier"), 409).code).toBe("line_locked");
    expect(ok(await post(`/v1/invoices/${id}/refunds`, req([{ chargeItemId: rbs.id, amountPaisa: 15_001 }], 15_001)), 422).code).toBe("line_over");
    expect((await post(`/v1/invoices/${id}/refunds`, req([{ chargeItemId: rbs.id, amountPaisa: 15_000 }], 15_000, { reason: "not done" }))).statusCode).toBe(400);
    expect(ok(await post(`/v1/invoices/${id}/refunds`, req([{ chargeItemId: rbs.id, amountPaisa: 15_000 }], 14_000)), 422).code).toBe("allocation_mismatch");
    // the receptionist sees bills but never asks for money back
    expect((await post(`/v1/invoices/${id}/refunds`, req([{ chargeItemId: rbs.id, amountPaisa: 15_000 }], 15_000), "desk")).statusCode).toBe(403);

    const r = ok(await post(`/v1/invoices/${id}/refunds`, req([{ chargeItemId: rbs.id, amountPaisa: 15_000 }], 15_000)), 201);
    expect(r.refund).toMatchObject({ status: "requested", amountPaisa: 15_000, netPaisa: 15_000, vatPaisa: 0, needsOwner: false, requestedBy: { id: "u_e2e_cashier" } });
    expect(r.can).toMatchObject({ approve: false, pay: false });
    // one open refund per bill; nothing paid before approval
    expect(ok(await post(`/v1/invoices/${id}/refunds`, req([{ chargeItemId: cbc.id, amountPaisa: 45_000 }], 45_000)), 409).code).toBe("refund_open");
    expect(ok(await post(`/v1/refunds/${r.refund.id}/pay`, { rev: r.refund.rev, recipient }), 409).code).toBe("not_approved");
    expect(ok(await get(`/v1/invoices/${id}`)).refund).toMatchObject({ openId: r.refund.id, openStatus: "requested", canRequest: false });

    // the single queue: a refund item with how it goes back; the cashier cannot decide
    const item = ok(await get("/v1/approvals", "owner")).items.find((i: { refund: { id: string } | null }) => i.refund?.id === r.refund.id);
    expect(item).toMatchObject({ kind: "refund-approval", amountPaisa: 15_000, refund: { category: "cancelled-test", needsOwner: false, ways: [{ method: "cash", way: "cash", amountPaisa: 15_000 }], lines: [{ nameEn: "RBS", totalPaisa: 15_000 }] } });
    expect((await post(`/v1/approvals/${item.taskId}/approve`, {}, "cashier")).statusCode).toBe(403);
    const a = ok(await approve(r.refund.id));
    expect(a.approval).toMatchObject({ status: "approved", decidedBy: { id: "u_e2e_owner" } });

    // pay: who took it is required (name, a real mobile, relationship)
    const r1 = ok(await get(`/v1/refunds/${r.refund.id}`));
    expect(r1.refund.status).toBe("approved");
    expect(ok(await post(`/v1/refunds/${r.refund.id}/pay`, { rev: r1.refund.rev, recipient: { ...recipient, phone: "0171190881" } }), 400).code).toBe("recipient_phone");
    const paid = ok(await post(`/v1/refunds/${r.refund.id}/pay`, { rev: r1.refund.rev, recipient }));
    expect(paid.outcome).toBe("paid");
    expect(paid.view.refund).toMatchObject({ status: "paid", recipient: { name: "Rashed Chowdhury", phone: "1711908812", relation: "spouse" }, voucher: { number: expect.stringMatching(new RegExp(`^RF/${YY}/\\d{4,}$`)) } });
    expect(paid.view.allocations[0]).toMatchObject({ status: "paid", way: "cash", paidBy: { id: "u_e2e_cashier" }, needsReconciliation: false });
    expect(paid.view.timeline.map((e: { event: string }) => e.event)).toEqual(["requested", "approved", "allocation-paid", "paid"]);
    // the bill keeps its confirmed money and records what went back; the drawer should hold ৳150 less
    const after = ok(await get(`/v1/invoices/${id}`));
    expect(after.invoice).toMatchObject({ status: "balanced", paidPaisa: 140_000, refundedPaisa: 15_000 });
    const sh = await myShift();
    expect(sh.live.cashRefundPaisa - (shiftBefore.live?.cashRefundPaisa ?? 0)).toBe(15_000);
    expect(sh.live.expectedCashPaisa).toBe(shiftBefore.live.expectedCashPaisa - 15_000);
    // what is left: the RBS line has nothing more; CBC can still be refunded
    const rb2 = ok(await get(`/v1/invoices/${id}/refundable`));
    expect(rb2.confirmedLeftPaisa).toBe(125_000);
    expect(rb2.lines.find((l: { id: string }) => l.id === rbs.id).lock).toBe("nothing-left");

    // the voucher, and its public check (facility, number, date, amount — no patient)
    const v = ok(await get(`/v1/refunds/${r.refund.id}/voucher`));
    expect(v.voucher.snapshot).toMatchObject({ amountPaisa: 15_000, category: "cancelled-test", recipient: { name: "Rashed Chowdhury", relation: "spouse" }, lines: [{ nameEn: "RBS", totalPaisa: 15_000 }],
      paidBack: [{ method: "cash", way: "cash", amountPaisa: 15_000 }], approvedBy: { nameEn: expect.any(String) } });
    const code = v.voucher.verifyUrl.split("/").pop();
    expect(v.voucher.verifyUrl).toContain("/verify/rf/");
    const pub = await app.inject({ method: "GET", url: `/v1/verify/rf/${code}` });
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json()).toEqual({ facilityEn: expect.any(String), facilityBn: expect.anything(), number: paid.view.refund.voucher.number, date: expect.any(String), amountPaisa: 15_000 });
    expect((await app.inject({ method: "GET", url: "/v1/verify/rf/ZZZZZZZZZZZZZZZZZZZZ" })).statusCode).toBe(404);
    expect(await inTenant((tx) => tx.refundVoucher.count({ where: { refundId: r.refund.id } }))).toBe(1);
    // printed like a receipt: the original, then only with a reason as DUPLICATE #1; each print stored and audited
    expect(ok(await post(`/v1/refunds/${r.refund.id}/voucher/print`, { format: "a5", lang: "both", reason: "lost" }), 409).code).toBe("not_printed_yet");
    const p0 = ok(await post(`/v1/refunds/${r.refund.id}/voucher/print`, { format: "a5", lang: "both" }), 201);
    expect(p0.print).toMatchObject({ copy: 0, reason: null });
    expect(ok(await post(`/v1/refunds/${r.refund.id}/voucher/print`, { format: "thermal", lang: "bn" }), 409).code).toBe("reprint_needs_reason");
    const p1 = ok(await post(`/v1/refunds/${r.refund.id}/voucher/print`, { format: "thermal", lang: "bn", reason: "lost" }), 201);
    expect(p1.print).toMatchObject({ copy: 1, reason: "lost" });
    const pdf = await app.inject({ method: "GET", url: `/v1${p1.print.pdfUrl.replace(/^\/api\/v1/, "")}`, headers: { cookie: cookies.cashier! } });
    expect(pdf.statusCode, pdf.body.slice(0, 200)).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toContain("DUPLICATE-1");
    expect(await inTenant((tx) => tx.auditEvent.count({ where: { entity: "RefundVoucher", entityId: v.voucher.id, action: { in: ["print", "reprint"] } } }))).toBe(2);
  });

  it("a partly paid bill whose money all went back can be voided (ADR 0005 addendum)", { timeout: 30_000 }, async () => {
    const { view } = await opdBill(["cbc"], { method: "cash", amountPaisa: 45_000 }); // ৳1,250 bill, ৳450 paid
    const id = view.invoice.id;
    expect(ok(await post(`/v1/invoices/${id}/void`, { reason: "Billed to the wrong patient" }, "owner"), 409).code).toBe("has_confirmed_money");
    const rb = ok(await get(`/v1/invoices/${id}/refundable`));
    const r = ok(await post(`/v1/invoices/${id}/refunds`, { category: "patient-request", reason: "Wrong patient — money given back in full", lines: [{ chargeItemId: lineOf(view, "test:cbc").id, amountPaisa: 45_000 }], allocations: [{ paymentId: rb.payments[0].id, amountPaisa: 45_000, way: "cash" }] }), 201);
    expect(ok(await post(`/v1/invoices/${id}/void`, { reason: "Billed to the wrong patient" }, "owner"), 409).code).toBe("refund_open");
    ok(await approve(r.refund.id, "admin"));
    ok(await post(`/v1/refunds/${r.refund.id}/pay`, { rev: ok(await get(`/v1/refunds/${r.refund.id}`)).refund.rev, recipient: { name: "Ayesha Siddiqa", phone: "01812345678", relation: "self" } }));
    const v = ok(await post(`/v1/invoices/${id}/void`, { reason: "Billed to the wrong patient" }, "owner"));
    expect(v.invoice).toMatchObject({ status: "entered-in-error", paidPaisa: 45_000, refundedPaisa: 45_000 });
  });

  it("reject needs a note; an approved refund is withdrawn (its own state), and then the bill can ask again", { timeout: 30_000 }, async () => {
    const { view } = await opdBill(["cbc", "rbs"], { method: "cash" });
    const id = view.invoice.id;
    const pay = ok(await get(`/v1/invoices/${id}/refundable`)).payments[0];
    const ask = (code: string, amount: number) => post(`/v1/invoices/${id}/refunds`, { category: "cancelled-test", reason: "Test cancelled by the doctor today", lines: [{ chargeItemId: lineOf(view, code).id, amountPaisa: amount }], allocations: [{ paymentId: pay.id, amountPaisa: amount, way: "cash" }] });
    const r = ok(await ask("test:rbs", 15_000), 201);
    expect((await post(`/v1/refunds/${r.refund.id}/decision`, { decision: "reject", note: "no" }, "owner")).statusCode).toBe(400);
    const rej = ok(await post(`/v1/refunds/${r.refund.id}/decision`, { decision: "reject", note: "The RBS was collected at 10:40" }, "owner"));
    expect(rej.refund).toMatchObject({ status: "rejected", decisionNote: "The RBS was collected at 10:40" });
    const r2 = ok(await ask("test:rbs", 15_000), 201);
    ok(await post(`/v1/refunds/${r2.refund.id}/decision`, { decision: "approve" }, "owner"));
    expect((await post(`/v1/refunds/${r2.refund.id}/decision`, { decision: "withdraw", note: "Patient did not come back" }, "cashier")).statusCode).toBe(403);
    const w = ok(await post(`/v1/refunds/${r2.refund.id}/decision`, { decision: "withdraw", note: "Patient did not come back" }, "owner"));
    expect(w.refund).toMatchObject({ status: "withdrawn", withdrawNote: "Patient did not come back", withdrawnBy: { id: "u_e2e_owner" } });
    expect(w.timeline.map((e: { event: string }) => e.event)).toEqual(["requested", "approved", "withdrawn"]);
    const list = ok(await get(`/v1/refunds?status=all&invoiceId=${id}`)).items;
    expect(list.map((x: { status: string }) => x.status).sort()).toEqual(["rejected", "withdrawn"]);
    ok(await ask("test:rbs", 15_000), 201); // nothing is left open: the line can be asked for again
  });
});

describe.runIf(db)("the way the money goes back (decision 2)", () => {
  it("a wallet on a gateway without a refund API: by hand with a reference, flagged; the owner matches it — never the payer", { timeout: 30_000 }, async () => {
    const { view } = await opdBill(["cbc"], { method: "nagad" });
    const id = view.invoice.id;
    const pay = ok(await get(`/v1/invoices/${id}/refundable`)).payments[0];
    expect(pay).toMatchObject({ method: "nagad", gatewayRefunds: false, ways: ["cash", "manual"] });
    const base = { category: "cancelled-test", reason: "CBC cancelled, patient refunded by Nagad", lines: [{ chargeItemId: lineOf(view, "test:cbc").id, amountPaisa: 45_000 }] };
    expect(ok(await post(`/v1/invoices/${id}/refunds`, { ...base, allocations: [{ paymentId: pay.id, amountPaisa: 45_000, way: "gateway" }] }), 422).code).toBe("payout_not_allowed");
    expect(ok(await post(`/v1/invoices/${id}/refunds`, { ...base, allocations: [{ paymentId: pay.id, amountPaisa: 45_000, way: "cash" }] }), 422).code).toBe("payout_not_allowed");
    const r = ok(await post(`/v1/invoices/${id}/refunds`, { ...base, allocations: [{ paymentId: pay.id, amountPaisa: 45_000, way: "manual" }] }), 201);
    ok(await approve(r.refund.id));
    const rev = ok(await get(`/v1/refunds/${r.refund.id}`)).refund.rev;
    expect(ok(await post(`/v1/refunds/${r.refund.id}/pay`, { rev, recipient }), 400).code).toBe("reference_required");
    const paid = ok(await post(`/v1/refunds/${r.refund.id}/pay`, { rev, recipient, reference: "NGD-RF-77812" }));
    expect(paid.view.allocations[0]).toMatchObject({ status: "paid", way: "manual", reference: "NGD-RF-77812", needsReconciliation: true, reconciled: "waiting" });
    const item = ok(await get("/v1/reconciliation", "owner")).items.find((i: { refund: { id: string } | null }) => i.refund?.id === r.refund.id);
    expect(item).toMatchObject({ kind: "refund", whyCode: "manual-refund", refund: { way: "manual", amountPaisa: 45_000, reference: "NGD-RF-77812", paidBy: { id: "u_e2e_cashier" } }, applyBlockers: [] });
    const m = ok(await post(`/v1/reconciliation/${item.taskId}/apply`, { note: "On the Nagad statement" }, "owner"));
    expect(m.item.resolution).toMatchObject({ action: "matched", by: { id: "u_e2e_owner" } });
    expect(ok(await get(`/v1/refunds/${r.refund.id}`)).allocations[0].reconciled).toBe("matched");
  });

  it("a wallet back in cash only when the patient has no wallet access; card back in cash needs the owner, not an admin", { timeout: 30_000 }, async () => {
    const { view } = await opdBill(["cbc"], { method: "card" });
    const id = view.invoice.id;
    const pay = ok(await get(`/v1/invoices/${id}/refundable`)).payments[0];
    expect(pay.ways).toEqual(["cash", "manual"]);
    const r = ok(await post(`/v1/invoices/${id}/refunds`, { category: "patient-request", reason: "Card reversal not possible, cash given", lines: [{ chargeItemId: lineOf(view, "test:cbc").id, amountPaisa: 45_000 }], allocations: [{ paymentId: pay.id, amountPaisa: 45_000, way: "cash" }] }), 201);
    expect(r.refund.needsOwner).toBe(true);
    expect(ok(await approve(r.refund.id, "admin"), 403).code).toBe("owner_only");
    ok(await approve(r.refund.id, "owner"));
    const paid = ok(await post(`/v1/refunds/${r.refund.id}/pay`, { rev: ok(await get(`/v1/refunds/${r.refund.id}`)).refund.rev, recipient }));
    expect(paid.view.allocations[0]).toMatchObject({ way: "cash", needsReconciliation: true, reconciled: "waiting" });

    const w = await opdBill(["cbc"], { method: "bkash" }); // bKash on the fake gateway in tests: no refund API → by hand
    const wp = ok(await get(`/v1/invoices/${w.view.invoice.id}/refundable`)).payments[0];
    const body = (cashReason?: string) => ({ category: "cancelled-test", reason: "CBC cancelled before collection", lines: [{ chargeItemId: lineOf(w.view, "test:cbc").id, amountPaisa: 45_000 }], allocations: [{ paymentId: wp.id, amountPaisa: 45_000, way: "cash", ...(cashReason ? { cashReason } : {}) }] });
    expect(ok(await post(`/v1/invoices/${w.view.invoice.id}/refunds`, body()), 422).code).toBe("payout_not_allowed");
    const c = ok(await post(`/v1/invoices/${w.view.invoice.id}/refunds`, body("no-wallet-access")), 201);
    expect(c.allocations[0]).toMatchObject({ way: "cash", cashReason: "no-wallet-access" });
  });

  it("cash leaves the payer's open shift: no shift, no cash refund", { timeout: 30_000 }, async () => {
    const { view } = await opdBill(["rbs"], { method: "cash" });
    const pay = ok(await get(`/v1/invoices/${view.invoice.id}/refundable`)).payments[0];
    const r = ok(await post(`/v1/invoices/${view.invoice.id}/refunds`, { category: "cancelled-test", reason: "RBS cancelled by the doctor", lines: [{ chargeItemId: lineOf(view, "test:rbs").id, amountPaisa: 15_000 }], allocations: [{ paymentId: pay.id, amountPaisa: 15_000, way: "cash" }] }), 201);
    ok(await approve(r.refund.id));
    // the owner has no drawer open
    expect(ok(await post(`/v1/refunds/${r.refund.id}/pay`, { rev: ok(await get(`/v1/refunds/${r.refund.id}`, "owner")).refund.rev, recipient }, "owner"), 409).code).toBe("no_open_shift");
  });
});

describe.runIf(db)("pharmacy returns (ADR 0009 addendum)", () => {
  const COMET: Med = { medicineKey: "comet", dose: "1+0+1", meal: "after", days: 5 }; // 10 tablets
  async function paidPharmacyBill(meds: Med[], key: string, qty: number) {
    const { enc, compositionId } = await signedVisit({ meds });
    const v0 = ok(await get(`/v1/pharmacy/encounters/${enc}`, "pharm"));
    const req = v0.lines.find((l: { prescribed: { key: string } }) => l.prescribed.key === key);
    const d = ok(await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: req.requestId, medicineKey: key, qty }] }, "pharm"));
    const bill = ok(await get(`/v1/invoices/${d.bill.id}`, "pharm"));
    const issued = ok(await post(`/v1/invoices/${d.bill.id}/issue`, { rev: bill.invoice.rev }, "pharm"));
    ok(await post(`/v1/invoices/${d.bill.id}/payments`, { method: "cash", amountPaisa: issued.invoice.totalPaisa, tenderedPaisa: issued.invoice.totalPaisa }, "pharm"), 201);
    return { enc, compositionId, requestId: req.requestId as string, invoiceId: d.bill.id as string, line: bill.lines[0] };
  }

  it("wrong dispense: 4 tablets into quarantine, the dispense reversed, the line reopens, the doctor is told, re-dispensed, then resold", { timeout: 40_000 }, async () => {
    const b = await paidPharmacyBill([COMET], "comet", 10);
    const rb = ok(await get(`/v1/invoices/${b.invoiceId}/refundable`, "pharm"));
    expect(rb.lines[0]).toMatchObject({ byUnits: true, controlled: false, left: { qty: 10 } });
    const body = { category: "wrong-dispense", reason: "Comet 500 given for Comet 850 — taken back", lines: [{ chargeItemId: b.line.id, units: 4 }], allocations: [{ paymentId: rb.payments[0].id, amountPaisa: 1_600, way: "cash" }] };
    expect(ok(await post(`/v1/invoices/${b.invoiceId}/refunds`, { ...body, lines: [{ chargeItemId: b.line.id, amountPaisa: 1_600 }] }, "pharm"), 422).code).toBe("line_over");
    const r = ok(await post(`/v1/invoices/${b.invoiceId}/refunds`, body, "pharm"), 201);
    expect(r.lines[0]).toMatchObject({ units: 4, totalPaisa: 1_600 });
    ok(await approve(r.refund.id));
    const paid = ok(await post(`/v1/refunds/${r.refund.id}/pay`, { rev: ok(await get(`/v1/refunds/${r.refund.id}`, "pharm")).refund.rev, recipient: { name: "Karim Uddin", phone: "01912345678", relation: "child" } }, "pharm"));
    expect(paid.view.refund.status).toBe("paid");
    // into quarantine (same batch, never the counter), and a return row reversing the dispense
    const src = (await inTenant((tx) => tx.stockBatch.findFirst({ where: { id: b.line.batch.id } })))!;
    const q = (await inTenant((tx) => tx.stockBatch.findFirst({ where: { organizationId: src.organizationId, medicineKey: "comet", batchNo: src.batchNo, location: "quarantine" } })))!;
    const back = await inTenant((tx) => tx.stockMove.findFirst({ where: { refType: "refund-line", refId: r.lines[0].id } }));
    expect(back).toMatchObject({ kind: "return", qty: 4, batchId: q.id });
    const ret = await inTenant((tx) => tx.medicationDispense.findFirst({ where: { refundLineId: r.lines[0].id } }));
    expect(ret).toMatchObject({ action: "return", qty: 4, requestId: b.requestId });
    // the line reopens: 4 to give again
    const v = ok(await get(`/v1/pharmacy/encounters/${b.enc}`, "pharm"));
    expect(v.lines[0]).toMatchObject({ status: "partial", remaining: 4 });
    // the prescribing doctor is told (a medication incident)
    const inbox = ok(await get("/v1/doctor/inbox", "doctor"));
    expect(inbox.items.find((i: { kind: string; returned: { qty: number } | null; patient: { id: string } }) => i.kind === "return-notice" && i.returned?.qty === 4)).toMatchObject({ severity: "notice", returned: { reason: "Comet 500 given for Comet 850 — taken back" } });
    // re-dispensed through the normal dispense, recorded as such
    ok(await post(`/v1/pharmacy/encounters/${b.enc}/dispense`, { compositionId: b.compositionId, lines: [{ requestId: b.requestId, medicineKey: "comet", qty: 4 }] }, "pharm"));
    const again = await inTenant((tx) => tx.medicationDispense.findFirst({ where: { encounterId: b.enc, action: "dispense" }, orderBy: { at: "desc" } }));
    expect(again?.reason).toBe("re-dispense after return");
    // the voided-bill rule: medicine still given on the bill (6 of 10) → cannot be voided
    expect(ok(await post(`/v1/invoices/${b.invoiceId}/void`, { reason: "Trying to void a pharmacy bill" }, "owner"), 409).code).toBe("has_confirmed_money");
    // resale: only "unopened, resaleable" with a reason, never by the cashier
    expect((await post("/v1/pharmacy/resale", { batchId: q.id, qty: 4, unopened: true, reason: "Strip sealed, returned the same day" }, "cashier")).statusCode).toBe(403);
    expect(ok(await post("/v1/pharmacy/resale", { batchId: q.id, qty: 4, unopened: true, reason: "short" }, "pharm"), 400).code).toBeTruthy();
    const counterBefore = (await inTenant((tx) => tx.stockBatch.findFirst({ where: { id: src.id } })))!.qtyOnHand;
    const rs = ok(await post("/v1/pharmacy/resale", { batchId: q.id, qty: 4, unopened: true, reason: "Strip sealed, returned the same day" }, "pharm"), 201);
    expect(rs.toBatchId).toBe(src.id);
    expect((await inTenant((tx) => tx.stockBatch.findFirst({ where: { id: src.id } })))!.qtyOnHand).toBe(counterBefore + 4);
    // the dashboard: refunds tile live, the incident on the leakage list (the list behind it is audited)
    const dash = ok(await get("/v1/owner/dashboard?period=today", "owner"));
    expect(dash.kpis.find((k: { key: string }) => k.key === "refunds")).toMatchObject({ comesWith: null, value: expect.any(Number) });
    expect(dash.kpis.find((k: { key: string }) => k.key === "refunds").value).toBeGreaterThanOrEqual(1_600);
    expect(dash.leakage.find((l: { kind: string }) => l.kind === "medicationIncident").count).toBeGreaterThanOrEqual(1);
    const drill = ok(await get("/v1/owner/drill?period=today&what=medicationIncident", "owner"));
    expect(drill.rows.find((x: { link: { id: string } | null }) => x.link?.id === r.refund.id)).toMatchObject({ amountPaisa: 1_600, approvedBy: { id: "u_e2e_owner" }, status: "paid" });
    const paidDrill = ok(await get("/v1/owner/drill?period=today&what=refundsPaid", "owner"));
    expect(paidDrill.rows.find((x: { id: string }) => x.id === r.refund.id)).toMatchObject({ by: { id: "u_e2e_pharm" }, approvedBy: { id: "u_e2e_owner" }, detail: expect.stringContaining("wrong-dispense") });
  });

  it("all the medicine back and all the money back: the pharmacy bill can be voided; a controlled drug's refund needs the owner", { timeout: 40_000 }, async () => {
    const SEDIL: Med = { medicineKey: "sedil", dose: "0+0+1", meal: "after", days: 5 };
    const b = await paidPharmacyBill([SEDIL], "sedil", 5);
    const rb = ok(await get(`/v1/invoices/${b.invoiceId}/refundable`, "pharm"));
    expect(rb.lines[0].controlled).toBe(true);
    const r = ok(await post(`/v1/invoices/${b.invoiceId}/refunds`, { category: "patient-request", reason: "Patient brought all five back unopened", lines: [{ chargeItemId: b.line.id, units: 5 }], allocations: [{ paymentId: rb.payments[0].id, amountPaisa: rb.lines[0].left.totalPaisa, way: "cash" }] }, "pharm"), 201);
    expect(r.refund.needsOwner).toBe(true);
    expect(ok(await approve(r.refund.id, "admin"), 403).code).toBe("owner_only");
    ok(await approve(r.refund.id, "owner"));
    ok(await post(`/v1/refunds/${r.refund.id}/pay`, { rev: ok(await get(`/v1/refunds/${r.refund.id}`, "pharm")).refund.rev, recipient: { name: "Sumaiya Akter", phone: "01612345678", relation: "self" } }, "pharm"));
    // controlled drug back to the counter: the owner's decision only
    const src = (await inTenant((tx) => tx.stockBatch.findFirst({ where: { id: b.line.batch.id } })))!;
    const q = (await inTenant((tx) => tx.stockBatch.findFirst({ where: { organizationId: src.organizationId, medicineKey: "sedil", batchNo: src.batchNo, location: "quarantine" } })))!;
    expect(ok(await post("/v1/pharmacy/resale", { batchId: q.id, qty: 5, unopened: true, reason: "Sealed, controlled register checked" }, "pharm"), 403).code).toBe("owner_only");
    const v = ok(await post(`/v1/invoices/${b.invoiceId}/void`, { reason: "Dispensed to the wrong visit" }, "owner"));
    expect(v.invoice.status).toBe("entered-in-error");
  });
});

describe.runIf(db)("Kamrul's decisions 220, 221, 223", () => {
  const COMET: Med = { medicineKey: "comet", dose: "1+0+1", meal: "after", days: 5 };
  it("220: part cash, part bKash is two refunds, each paid whole with its own voucher — never one mixed refund", { timeout: 30_000 }, async () => {
    const { view } = await opdBill(["cbc", "rbs"], { method: "cash", amountPaisa: 100_000 });
    const id = view.invoice.id;
    const p2 = ok(await post(`/v1/invoices/${id}/payments`, { method: "nagad", amountPaisa: 40_000 }), 201).payment;
    const ref = (await inTenant((tx) => tx.payment.findFirst({ where: { id: p2.id } })))!.providerRef!;
    const cb = fakeProvider()!.simulate(ref, "confirmed")!;
    await app.inject({ method: "POST", url: "/v1/payments/callback/fake", payload: cb.body, headers: cb.headers });
    const pays = ok(await get(`/v1/invoices/${id}/refundable`)).payments;
    const cash = pays.find((x: { method: string }) => x.method === "cash"), nagad = pays.find((x: { method: string }) => x.method === "nagad");
    const cbc = lineOf(view, "test:cbc"), rbs = lineOf(view, "test:rbs");
    const mixed = await post(`/v1/invoices/${id}/refunds`, { category: "cancelled-test", reason: "Both tests cancelled by the doctor", lines: [{ chargeItemId: cbc.id, amountPaisa: 45_000 }, { chargeItemId: rbs.id, amountPaisa: 15_000 }],
      allocations: [{ paymentId: cash.id, amountPaisa: 30_000, way: "cash" }, { paymentId: nagad.id, amountPaisa: 30_000, way: "manual" }] });
    expect(ok(mixed, 422).code).toBe("mixed_ways");
    const r1 = ok(await post(`/v1/invoices/${id}/refunds`, { category: "cancelled-test", reason: "CBC cancelled by the doctor", lines: [{ chargeItemId: cbc.id, amountPaisa: 45_000 }], allocations: [{ paymentId: cash.id, amountPaisa: 45_000, way: "cash" }] }), 201);
    ok(await approve(r1.refund.id));
    const v1 = ok(await post(`/v1/refunds/${r1.refund.id}/pay`, { rev: ok(await get(`/v1/refunds/${r1.refund.id}`)).refund.rev, recipient }));
    const r2 = ok(await post(`/v1/invoices/${id}/refunds`, { category: "cancelled-test", reason: "RBS cancelled by the doctor", lines: [{ chargeItemId: rbs.id, amountPaisa: 15_000 }], allocations: [{ paymentId: nagad.id, amountPaisa: 15_000, way: "manual" }] }), 201);
    ok(await approve(r2.refund.id));
    const v2 = ok(await post(`/v1/refunds/${r2.refund.id}/pay`, { rev: ok(await get(`/v1/refunds/${r2.refund.id}`)).refund.rev, recipient, reference: "NGD-RF-2201" }));
    expect([v1.outcome, v2.outcome]).toEqual(["paid", "paid"]);
    expect(v1.view.refund.voucher.number).not.toBe(v2.view.refund.voucher.number);
    // and the database itself refuses a refund going back two ways
    await expect(inTenant((tx) => tx.refundAllocation.create({ data: { tenantId: T, refundId: r2.refund.id, paymentId: cash.id, method: "cash", amountPaisa: 1, way: "cash" } }))).rejects.toThrow();
  });

  it("221: medicine back on an unpaid pharmacy bill — no money, the due goes down, a credit voucher; all back → the bill can be voided", { timeout: 40_000 }, async () => {
    const { enc, compositionId } = await signedVisit({ meds: [COMET] });
    const v0 = ok(await get(`/v1/pharmacy/encounters/${enc}`, "pharm"));
    const d = ok(await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: v0.lines[0].requestId, medicineKey: "comet", qty: 10 }] }, "pharm"));
    const bill = ok(await get(`/v1/invoices/${d.bill.id}`, "pharm"));
    const issued = ok(await post(`/v1/invoices/${d.bill.id}/issue`, { rev: bill.invoice.rev }, "pharm"));
    const line = issued.lines[0];
    expect(ok(await get(`/v1/invoices/${d.bill.id}/refundable`, "pharm"))).toMatchObject({ canReturn: true, confirmedLeftPaisa: 0 });
    const ret = (units: number, reason = "Brought back unopened before paying") => post(`/v1/invoices/${d.bill.id}/refunds`, { kind: "return", category: "patient-request", reason, lines: [{ chargeItemId: line.id, units }] }, "pharm");
    // a return takes no money back
    expect(ok(await post(`/v1/invoices/${d.bill.id}/refunds`, { kind: "return", category: "patient-request", reason: "Brought back unopened before paying", lines: [{ chargeItemId: line.id, units: 4 }], allocations: [{ paymentId: "x", amountPaisa: 1, way: "cash" }] }, "pharm"), 404).code).toBe("payment_not_found");
    const r = ok(await ret(4), 201);
    expect(r.refund).toMatchObject({ kind: "return", status: "requested", amountPaisa: 1_600 });
    expect(r.allocations).toEqual([]);
    ok(await approve(r.refund.id));
    const done = ok(await post(`/v1/refunds/${r.refund.id}/pay`, { rev: ok(await get(`/v1/refunds/${r.refund.id}`, "pharm")).refund.rev }, "pharm"));
    expect(done.view.refund).toMatchObject({ status: "paid", recipient: null, voucher: { number: expect.stringMatching(new RegExp(`^CV/${YY}/`)) } });
    const after = ok(await get(`/v1/invoices/${d.bill.id}`, "pharm"));
    expect(after.invoice).toMatchObject({ status: "issued", paidPaisa: 0, creditedPaisa: 1_600 });
    expect(after.summary.duePaisa).toBe(issued.invoice.totalPaisa - 1_600);
    expect(after.lines[0].back).toEqual({ units: 4, totalPaisa: 1_600 });
    expect((await inTenant((tx) => tx.stockMove.findFirst({ where: { refType: "refund-line", refId: r.lines[0].id } })))?.qty).toBe(4);
    expect(ok(await get(`/v1/refunds/${r.refund.id}/voucher`, "pharm")).voucher.snapshot).toMatchObject({ kind: "return", recipient: null, paidBack: [] });
    // the rest comes back too: due zero, never any money → void (ADR 0005)
    expect(ok(await post(`/v1/invoices/${d.bill.id}/void`, { reason: "All medicine returned unpaid" }, "owner"), 409).code).toBe("medicine_given");
    const r2 = ok(await ret(6), 201);
    ok(await approve(r2.refund.id));
    ok(await post(`/v1/refunds/${r2.refund.id}/pay`, { rev: ok(await get(`/v1/refunds/${r2.refund.id}`, "pharm")).refund.rev }, "pharm"));
    const zero = ok(await get(`/v1/invoices/${d.bill.id}`, "pharm"));
    expect(zero.summary.duePaisa).toBe(0);
    expect(ok(await post(`/v1/invoices/${d.bill.id}/payments`, { method: "cash", amountPaisa: 100, tenderedPaisa: 100 }, "pharm"), 409).code).toBeTruthy();
    expect(ok(await post(`/v1/invoices/${d.bill.id}/void`, { reason: "All medicine returned unpaid" }, "owner")).invoice.status).toBe("entered-in-error");
  });

  it("221: a partly returned bill is then paid for the rest — balanced at total − credited, the receipt shows the credit", { timeout: 40_000 }, async () => {
    const { enc, compositionId } = await signedVisit({ meds: [COMET] });
    const v0 = ok(await get(`/v1/pharmacy/encounters/${enc}`, "pharm"));
    const d = ok(await post(`/v1/pharmacy/encounters/${enc}/dispense`, { compositionId, lines: [{ requestId: v0.lines[0].requestId, medicineKey: "comet", qty: 10 }] }, "pharm"));
    const bill = ok(await get(`/v1/invoices/${d.bill.id}`, "pharm"));
    const issued = ok(await post(`/v1/invoices/${d.bill.id}/issue`, { rev: bill.invoice.rev }, "pharm"));
    const r = ok(await post(`/v1/invoices/${d.bill.id}/refunds`, { kind: "return", category: "wrong-dispense", reason: "Two strips were one too many", lines: [{ chargeItemId: issued.lines[0].id, units: 2 }] }, "pharm"), 201);
    ok(await approve(r.refund.id));
    ok(await post(`/v1/refunds/${r.refund.id}/pay`, { rev: ok(await get(`/v1/refunds/${r.refund.id}`, "pharm")).refund.rev }, "pharm"));
    const due = issued.invoice.totalPaisa - 800;
    const paid = ok(await post(`/v1/invoices/${d.bill.id}/payments`, { method: "cash", amountPaisa: due, tenderedPaisa: due }, "pharm"), 201);
    expect(paid.view.invoice).toMatchObject({ status: "balanced", paidPaisa: due, creditedPaisa: 800 });
    const rc = ok(await post(`/v1/invoices/${d.bill.id}/receipts`, {}, "pharm"), 201).receipt;
    expect(rc).toMatchObject({ paidPaisa: due, duePaisa: 0, snapshot: { creditedPaisa: 800 } });
    // once money is on the bill a return without refund is refused — a refund is the way
    expect(ok(await post(`/v1/invoices/${d.bill.id}/refunds`, { kind: "return", category: "patient-request", reason: "Two more brought back today", lines: [{ chargeItemId: issued.lines[0].id, units: 2 }] }, "pharm"), 409).code).toBe("money_on_bill");
  });

  it("223: the only approver at the facility decides their own request with a note — flagged self-approved, on the exceptions list", { timeout: 40_000 }, async () => {
    const owner = new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    const { view } = await opdBill(["rbs"], { method: "cash" });
    const pay = ok(await get(`/v1/invoices/${view.invoice.id}/refundable`)).payments[0];
    const r = ok(await post(`/v1/invoices/${view.invoice.id}/refunds`, { category: "cancelled-test", reason: "RBS cancelled by the doctor", lines: [{ chargeItemId: lineOf(view, "test:rbs").id, amountPaisa: 15_000 }], allocations: [{ paymentId: pay.id, amountPaisa: 15_000, way: "cash" }] }, "owner"), 201);
    // with the E2E admin there, the owner cannot approve their own request
    expect(ok(await post(`/v1/refunds/${r.refund.id}/decision`, { decision: "approve", note: "Owner approving alone" }, "owner"), 403).code).toBe("own_request");
    // the admin switched off for this test: the owner is the only approver — a note is required, then it is flagged
    await owner.user.update({ where: { id: "u_e2e_admin" }, data: { active: false } });
    try {
      expect(ok(await post(`/v1/refunds/${r.refund.id}/decision`, { decision: "approve", note: "ok" }, "owner"), 400).code).toBe("note_required");
      const a = ok(await post(`/v1/refunds/${r.refund.id}/decision`, { decision: "approve", note: "Only approver at the counter today" }, "owner"));
      expect(a.refund).toMatchObject({ status: "approved", selfApproved: true, decisionNote: "Only approver at the counter today", decidedBy: { id: "u_e2e_owner" } });
    } finally {
      await owner.user.update({ where: { id: "u_e2e_admin" }, data: { active: true } });
      await owner.$disconnect();
    }
    const audit = await inTenant((tx) => tx.auditEvent.findFirst({ where: { entity: "Refund", entityId: r.refund.id, action: "update" }, orderBy: { at: "desc" } }));
    expect(audit?.detail).toMatchObject({ selfApproved: true, flag: "self-approved" });
    const dash = ok(await get("/v1/owner/dashboard?period=today", "owner"));
    expect(dash.leakage.find((l: { kind: string }) => l.kind === "selfApproved").count).toBeGreaterThanOrEqual(1);
    const drill = ok(await get("/v1/owner/drill?period=today&what=selfApproved", "owner"));
    expect(drill.rows.find((x: { id: string }) => x.id === r.refund.id)).toMatchObject({ by: { id: "u_e2e_owner" }, approvedBy: { id: "u_e2e_owner" } });
    // the database refuses a self-decision while another approver exists (the admin is back)
    expect(await owner2((tx) => tx.$queryRaw<{ n: number }[]>`SELECT facility_approvers('o_e2e') AS n`)).toEqual([{ n: 2 }]);
  });
});

describe.runIf(db)("reconciliation → refund to patient", () => {
  it("the gateway re-confirms the case's money; a refund for exactly that; the owner who asked cannot approve it", { timeout: 30_000 }, async () => {
    const { view } = await opdBill(["cbc"]);
    const p = ok(await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "nagad", amountPaisa: 100_000 }), 201).payment;
    const ref0 = (await inTenant((tx) => tx.payment.findFirst({ where: { id: p.id } })))!.providerRef!;
    await post(`/v1/dev/fake-payments/${p.id}/failed`, {}, "cashier", null);
    const cb = fakeProvider()!.simulate(ref0, "confirmed")!;
    await app.inject({ method: "POST", url: "/v1/payments/callback/fake", payload: cb.body, headers: cb.headers });
    const item = ok(await get("/v1/reconciliation", "owner")).items.find((i: { payment: { id: string }; kind: string }) => i.payment.id === p.id && i.kind === "payment");
    expect(item).toBeTruthy();
    expect((await post(`/v1/reconciliation/${item.taskId}/refund`, { reason: "Paid after the link failed — give it back", way: "manual" }, "cashier")).statusCode).toBe(403);
    const r = ok(await post(`/v1/reconciliation/${item.taskId}/refund`, { reason: "Paid after the link failed — give it back", way: "manual" }, "owner"), 201);
    expect(r.refund).toMatchObject({ source: "reconciliation", category: "overpayment", amountPaisa: 100_000, caseTaskId: item.taskId, status: "requested" });
    expect(r.lines).toEqual([]);
    const done = ok(await get("/v1/reconciliation?status=rejected", "owner")).items.find((i: { taskId: string }) => i.taskId === item.taskId);
    expect(done.resolution).toMatchObject({ action: "refunded", refundId: r.refund.id });
    expect(ok(await approve(r.refund.id, "owner"), 403).code).toBe("own_request"); // an admin exists here (decision 223)
    ok(await approve(r.refund.id, "admin"));
    const paid = ok(await post(`/v1/refunds/${r.refund.id}/pay`, { rev: ok(await get(`/v1/refunds/${r.refund.id}`)).refund.rev, recipient, reference: "NGD-REV-1102" }));
    expect(paid.view.refund.status).toBe("paid");
    // not a credit note: the bill's refunded money is unchanged (that money was never on the bill)
    expect(ok(await get(`/v1/invoices/${view.invoice.id}`)).invoice.refundedPaisa).toBe(0);
  });
});

describe.runIf(db)("the database's own guards (ADR 0013)", () => {
  it("never a refund status changed outside the machine, a line past what is left, a refund over the confirmed money, or a deleted voucher", { timeout: 30_000 }, async () => {
    const { view } = await opdBill(["cbc", "rbs"], { method: "cash" });
    const pay = ok(await get(`/v1/invoices/${view.invoice.id}/refundable`)).payments[0];
    const r = ok(await post(`/v1/invoices/${view.invoice.id}/refunds`, { category: "cancelled-test", reason: "RBS cancelled by the doctor", lines: [{ chargeItemId: lineOf(view, "test:rbs").id, amountPaisa: 15_000 }], allocations: [{ paymentId: pay.id, amountPaisa: 15_000, way: "cash" }] }), 201);
    await expect(inTenant((tx) => tx.refund.update({ where: { id: r.refund.id }, data: { status: "approved", decidedById: "u_e2e_owner", decidedAt: new Date() } }))).rejects.toThrow(); // not through its task, not the signed-in user
    await expect(inTenant((tx) => tx.refund.update({ where: { id: r.refund.id }, data: { amountPaisa: 1 } }))).rejects.toThrow();
    await expect(inTenant((tx) => tx.refundLine.create({ data: { tenantId: T, refundId: r.refund.id, chargeItemId: lineOf(view, "test:rbs").id, netPaisa: 1, vatPaisa: 0, totalPaisa: 1 } }))).rejects.toThrow();
    await expect(inTenant((tx) => tx.refundAllocation.update({ where: { id: r.allocations[0].id }, data: { status: "paid", paidById: "u_e2e_cashier", paidAt: new Date() } }))).rejects.toThrow(); // nothing paid before approval
    await expect(inTenant((tx) => tx.refund.delete({ where: { id: r.refund.id } }))).rejects.toThrow();
    await expect(inTenant((tx) => tx.invoice.update({ where: { id: view.invoice.id }, data: { refundedPaisa: 15_000 } }))).rejects.toThrow(); // not what refunds paid out
    const anyVoucher = await inTenant((tx) => tx.refundVoucher.findFirst({ select: { id: true } }));
    if (anyVoucher) await expect(inTenant((tx) => tx.refundVoucher.update({ where: { id: anyVoucher.id }, data: { amountPaisa: 1 } }))).rejects.toThrow();
  });
});
