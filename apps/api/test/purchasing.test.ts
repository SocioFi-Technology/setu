/* Pharmacy session 2 contract tests on the real database (as setu_app), in the seeded E2E Test Clinic (ADR 0009):
   - P5: a purchase order to a sample supplier is sent; goods arrive short and are posted → stock in the store batch,
     the order partially received, the supplier owed the billed amount less a debit note; a batch expiring within 6
     months is posted only by the owner; the rest of the order is closed short; refusals at the counter;
   - above ৳50,000 (sample) the pharmacist asks; the owner approves (and so sends) — never their own request;
   - supplier payments: owner / admin only, never more than is owed;
   - store → counter transfer as a pair of moves; an expired batch never goes to the counter;
   - P6: a count with a variance needs a reason; the owner (not the counter) approves → an adjust move;
   - the owner's stock tiles and their drill-downs; the database keeps the ledgers append-only;
   - external review A6 (decisions 179–186): one supplier's day of orders toward the limit; the receipt price tolerance
     per facility; the supplier's VAT / AIT as data; a count left open at its counter's shift close; the PO cancel path. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("purchasing.test: DATABASE_URL_APP not set — purchasing contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6).toUpperCase();
const cookies: Record<string, string> = {};
const T = "t_e2e";
const USERS = { pharm: "01799000007", owner: "01799000009", admin: "01799000010", doctor: "01799000002", otherPharm: "01711000007" } as const;
type Who = keyof typeof USERS;
const day = (n: number) => new Date(Date.now() + 6 * 3600_000 + n * 864e5).toISOString().slice(0, 10);
let supplierId = "";

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of Object.entries(USERS)) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; cookies[k] = Array.isArray(c) ? c[0]! : (c as string);
  }
  // a supplier of this run's own: decision 179 sums one supplier's orders of the day, so the sample supplier would
  // collect every run's orders and make a later run ask for approval
  supplierId = (await ok(post("/v1/pharmacy/suppliers", { name: `Test Supplier ${RUN}` }), 201)).supplier.id;
});
afterAll(async () => { await app.close(); });

const get = (url: string, who: Who = "pharm") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const post = (url: string, payload: object = {}, who: Who = "pharm", key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const ok = async (r: Promise<{ statusCode: number; body: string; json: () => any }>, status = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(status); return x.json(); }; // eslint-disable-line @typescript-eslint/no-explicit-any
const inTenant = <R>(fn: (tx: NonNullable<typeof db>["prisma"]) => Promise<R>) => db!.forTenant(T, fn as never) as Promise<R>;
const owed = async () => (await ok(get(`/v1/pharmacy/suppliers/${supplierId}`))).supplier.owedPaisa as number;

async function sentOrder(lines: { medicineKey: string; qty: number; costPaisa: number }[]) {
  let po = await ok(post("/v1/pharmacy/purchase-orders", { supplierId, note: `test ${RUN}` }), 201);
  for (const l of lines) po = await ok(post(`/v1/pharmacy/purchase-orders/${po.id}/lines`, { rev: po.rev, ...l }));
  return ok(post(`/v1/pharmacy/purchase-orders/${po.id}/send`, { rev: po.rev }));
}

describe.runIf(db)("P5 purchase order → goods received", () => {
  it("send → receive short (debit note) → owner posts a short-expiry batch → close short; refusals", { timeout: 30_000 }, async () => {
    const po = await sentOrder([{ medicineKey: "comet", qty: 1000, costPaisa: 340 }, { medicineKey: "amdocal", qty: 500, costPaisa: 100 }]);
    expect(po).toMatchObject({ status: "sent", number: expect.stringMatching(/^PO\/\d{2}\/\d{4}$/), totalPaisa: 390_000, sentBy: { nameEn: "Test Pharmacist" } });
    const [comet, amdocal] = po.lines as { id: string }[];
    const owedBefore = await owed();

    let g = await ok(post("/v1/pharmacy/goods-receipts", { orderId: po.id, supplierInvoiceNo: `INV-${RUN}` }), 201);
    const line = (x: object) => post(`/v1/pharmacy/goods-receipts/${g.id}/lines`, { rev: g.rev, orderLineId: comet!.id, batchNo: `CM${RUN}`, expiry: day(700), invoicedQty: 1000, receivedQty: 900, costPaisa: 340, mrpPaisa: 400, location: "store", ...x });
    for (const [x, code] of [[{ expiry: day(-1) }, "expired"], [{ invoicedQty: 1001, receivedQty: 1001 }, "over_order"], [{ mrpPaisa: 300 }, "mrp_below_cost"], [{ receivedQty: 950, invoicedQty: 900 }, "over_invoice"]] as const) {
      const r = await line(x);
      expect([r.statusCode, r.json().code], JSON.stringify(x)).toEqual([422, code]);
    }
    g = await ok(line({}));
    expect(g.money).toEqual({ invoicedPaisa: 340_000, debitNotePaisa: 34_000, owedPaisa: 306_000 });
    expect(g.postBlockers).toEqual([]);
    g = await ok(post(`/v1/pharmacy/goods-receipts/${g.id}/post`, { rev: g.rev }));
    expect(g).toMatchObject({ status: "posted", number: expect.stringMatching(/^GRN\//), postedBy: { nameEn: "Test Pharmacist" } });
    const batch = await inTenant((tx) => tx.stockBatch.findFirst({ where: { batchNo: `CM${RUN}`, location: "store" } }));
    expect(batch).toMatchObject({ medicineKey: "comet", qtyOnHand: 900, costPaisa: 340, mrpPaisa: 400, expiry: day(700) });
    expect(await owed()).toBe(owedBefore + 306_000);
    const ledger = (await ok(get(`/v1/pharmacy/suppliers/${supplierId}`))).entries.slice(0, 2).map((e: { kind: string; amountPaisa: number }) => [e.kind, e.amountPaisa]);
    expect(ledger).toEqual(expect.arrayContaining([["goods-received", 340_000], ["debit-note", 34_000]]));
    expect((await ok(get(`/v1/pharmacy/purchase-orders/${po.id}`))).status).toBe("partially-received");
    // a posted receipt never changes, even in the database
    await expect(inTenant((tx) => tx.goodsReceiptLine.updateMany({ where: { receiptId: g.id }, data: { receivedQty: 1 } }))).rejects.toThrow(/never change/);

    // a batch expiring within 6 months: the pharmacist cannot post it; the owner can
    let g2 = await ok(post("/v1/pharmacy/goods-receipts", { orderId: po.id }), 201);
    g2 = await ok(post(`/v1/pharmacy/goods-receipts/${g2.id}/lines`, { rev: g2.rev, orderLineId: amdocal!.id, batchNo: `AM${RUN}`, expiry: day(80), invoicedQty: 500, receivedQty: 500, costPaisa: 100, mrpPaisa: 120, location: "store" }));
    expect(g2.lines[0].shortExpiry).toBe(true);
    expect(g2.postBlockers).toEqual(["short_expiry_needs_owner"]);
    const pharmPost = await post(`/v1/pharmacy/goods-receipts/${g2.id}/post`, { rev: g2.rev });
    expect([pharmPost.statusCode, pharmPost.json().code]).toEqual([403, "short_expiry_needs_owner"]);
    const appr = await ok(get("/v1/pharmacy/approvals", "owner"));
    expect(appr.receipts.map((r: { id: string }) => r.id)).toContain(g2.id);
    g2 = await ok(post(`/v1/pharmacy/goods-receipts/${g2.id}/post`, { rev: g2.rev, note: "Short expiry accepted — fast mover" }, "owner"));
    expect(g2.postedBy.nameEn).toBe("Test Owner");

    // the same supplier bill cannot be posted twice; a bill at another unit cost than the order needs the owner
    let g3 = await ok(post("/v1/pharmacy/goods-receipts", { orderId: po.id, supplierInvoiceNo: `INV-${RUN}` }), 201);
    g3 = await ok(post(`/v1/pharmacy/goods-receipts/${g3.id}/lines`, { rev: g3.rev, orderLineId: comet!.id, batchNo: `CX${RUN}`, expiry: day(700), invoicedQty: 10, receivedQty: 10, costPaisa: 3400, mrpPaisa: 4000, location: "store" }));
    expect(g3.lines[0]).toMatchObject({ priceVariance: true, orderCostPaisa: 340 });
    const variance = await post(`/v1/pharmacy/goods-receipts/${g3.id}/post`, { rev: g3.rev });
    expect([variance.statusCode, variance.json().code]).toEqual([403, "price_variance_needs_owner"]);
    const twice = await post(`/v1/pharmacy/goods-receipts/${g3.id}/post`, { rev: g3.rev }, "owner");
    expect([twice.statusCode, twice.json().code]).toEqual([409, "conflict"]);
    await ok(post(`/v1/pharmacy/goods-receipts/${g3.id}/discard`, { rev: g3.rev }));

    // the rest of Comet will not come: cancelling is refused once goods arrived; close it short with a reason
    let o = await ok(get(`/v1/pharmacy/purchase-orders/${po.id}`));
    const cancel = await post(`/v1/pharmacy/purchase-orders/${po.id}/cancel`, { rev: o.rev, reason: "Supplier cannot deliver" });
    expect([cancel.statusCode, cancel.json().code]).toEqual([409, "goods_arrived"]);
    o = await ok(post(`/v1/pharmacy/purchase-orders/${po.id}/close-short`, { rev: o.rev, reason: "Supplier out of Comet until next month" }));
    expect(o).toMatchObject({ status: "received", endReason: "Supplier out of Comet until next month" });
    expect(o.lines.map((l: { receivedQty: number }) => l.receivedQty)).toEqual([900, 500]);
  });

  it("above ৳50,000 the pharmacist asks; the owner approves and so sends it; a rejection needs a note", async () => {
    let po = await ok(post("/v1/pharmacy/purchase-orders", { supplierId }), 201);
    po = await ok(post(`/v1/pharmacy/purchase-orders/${po.id}/lines`, { rev: po.rev, medicineKey: "azith", qty: 2000, costPaisa: 3000 })); // ৳60,000
    expect(po.sendBlockers).toEqual(["approval_required"]);
    const asked = await post(`/v1/pharmacy/purchase-orders/${po.id}/send`, { rev: po.rev });
    expect(asked.statusCode, asked.body).toBe(202);
    expect(asked.json()).toMatchObject({ status: "draft", number: null, approval: { status: "requested" }, sendBlockers: ["approval_pending"] });
    const locked = await post(`/v1/pharmacy/purchase-orders/${po.id}/lines`, { rev: po.rev, medicineKey: "napa", qty: 1, costPaisa: 100 });
    expect([locked.statusCode, locked.json().code]).toEqual([409, "approval_pending"]);
    expect((await post(`/v1/pharmacy/purchase-orders/${po.id}/approval`, { decision: "approve" })).statusCode).toBe(403);
    expect((await ok(get("/v1/pharmacy/approvals", "owner"))).orders.map((x: { order: { id: string } }) => x.order.id)).toContain(po.id);
    const noNote = await post(`/v1/pharmacy/purchase-orders/${po.id}/approval`, { decision: "reject", note: "no" }, "owner");
    expect([noNote.statusCode, noNote.json().code]).toEqual([400, "note_required"]);
    const sent = await ok(post(`/v1/pharmacy/purchase-orders/${po.id}/approval`, { decision: "approve" }, "owner"));
    expect(sent).toMatchObject({ status: "sent", number: expect.stringMatching(/^PO\//), sentBy: { nameEn: "Test Owner" }, approval: { status: "approved", decidedBy: { nameEn: "Test Owner" } } });
    // nothing arrived: it can be cancelled with a reason
    const c = await ok(post(`/v1/pharmacy/purchase-orders/${po.id}/cancel`, { rev: sent.rev, reason: "Ordered from another supplier" }));
    expect(c.status).toBe("cancelled");
  });

  it("supplier payments: owner / admin only, never more than is owed", async () => {
    const due = await owed();
    expect((await post(`/v1/pharmacy/suppliers/${supplierId}/payments`, { amountPaisa: 100, note: "cash" })).statusCode).toBe(403);
    const over = await post(`/v1/pharmacy/suppliers/${supplierId}/payments`, { amountPaisa: due + 1, note: "cheque 001" }, "owner");
    expect([over.statusCode, over.json().code]).toEqual([409, "over_owed"]);
    const paid = await ok(post(`/v1/pharmacy/suppliers/${supplierId}/payments`, { amountPaisa: 10_000, note: `cheque ${RUN}` }, "owner"), 201);
    expect(paid.supplier.owedPaisa).toBe(due - 10_000);
    await expect(inTenant((tx) => tx.supplierEntry.updateMany({ where: { supplierId }, data: { amountPaisa: 1 } }))).rejects.toThrow();
  });
});

describe.runIf(db)("store → counter, and P6 count", () => {
  it("a transfer is a pair of moves on the same batch; an expired batch never goes to the counter", async () => {
    const store = (await inTenant((tx) => tx.stockBatch.findFirst({ where: { medicineKey: "seclo", location: "store", qtyOnHand: { gte: 10 } } })))!;
    const counterBefore = (await inTenant((tx) => tx.stockBatch.findFirst({ where: { medicineKey: "seclo", batchNo: store.batchNo, location: "counter" } })))?.qtyOnHand ?? 0;
    const r = await ok(post("/v1/pharmacy/transfers", { batchId: store.id, qty: 10, to: "counter" }), 201);
    const dest = (await inTenant((tx) => tx.stockBatch.findFirst({ where: { id: r.to } })))!;
    expect(dest).toMatchObject({ medicineKey: "seclo", batchNo: store.batchNo, location: "counter", expiry: store.expiry, mrpPaisa: store.mrpPaisa, qtyOnHand: counterBefore + 10 });
    expect((await inTenant((tx) => tx.stockBatch.findFirst({ where: { id: store.id } })))!.qtyOnHand).toBe(store.qtyOnHand - 10);
    const expired = (await inTenant((tx) => tx.stockBatch.findFirst({ where: { batchNo: "NP2504", location: "counter" } })))!;
    const x = await post("/v1/pharmacy/transfers", { batchId: expired.id, qty: 1, to: "fridge" });
    expect([x.statusCode, x.json().code]).toEqual([409, "expired"]);
  });

  it("count the fridge: a variance needs a reason; the counter cannot approve; the owner approves → adjust move", { timeout: 30_000 }, async () => {
    // leftovers of an earlier run: finish and reject them so one count per location can start
    for (const c of await inTenant((tx) => tx.stockCount.findMany({ where: { location: "fridge", status: { in: ["counting", "submitted"] } } }))) {
      let v = await ok(get(`/v1/pharmacy/counts/${c.id}`));
      if (v.status === "counting") {
        for (const l of v.lines) v = await ok(post(`/v1/pharmacy/counts/${c.id}/lines`, { rev: v.rev, lineId: l.id, countedQty: l.systemQty }));
        v = await ok(post(`/v1/pharmacy/counts/${c.id}/submit`, { rev: v.rev }));
      }
      await ok(post(`/v1/pharmacy/counts/${c.id}/decision`, { decision: "reject", note: "leftover from an earlier test run" }, "owner"));
    }
    // something in the fridge to count
    const store = (await inTenant((tx) => tx.stockBatch.findFirst({ where: { medicineKey: "pantonix", location: "store", qtyOnHand: { gte: 20 } } })))!;
    const moved = await ok(post("/v1/pharmacy/transfers", { batchId: store.id, qty: 20, to: "fridge" }), 201);
    let c = await ok(post("/v1/pharmacy/counts", { location: "fridge" }), 201);
    expect((await post("/v1/pharmacy/counts", { location: "fridge" })).json().code).toBe("count_open");
    const target = c.lines.find((l: { batch: { id: string } }) => l.batch.id === moved.to)!;
    // the counter keeps working while the count is open: 5 go back to the store before this batch is counted
    await ok(post("/v1/pharmacy/transfers", { batchId: moved.to, qty: 5, to: "store" }), 201);
    c = await ok(get(`/v1/pharmacy/counts/${c.id}`));
    const before = c.lines.find((l: { id: string }) => l.id === target.id).systemQty as number; // expected on the shelf now
    expect(before).toBe(target.systemQty - 5);
    for (const l of c.lines) c = await ok(post(`/v1/pharmacy/counts/${c.id}/lines`, { rev: c.rev, lineId: l.id, countedQty: l.id === target.id ? before - 2 : l.systemQty }));
    const noReason = await post(`/v1/pharmacy/counts/${c.id}/submit`, { rev: c.rev });
    expect([noReason.statusCode, noReason.json().code]).toEqual([422, "reason_required"]);
    c = await ok(post(`/v1/pharmacy/counts/${c.id}/lines`, { rev: c.rev, lineId: target.id, countedQty: before - 2, reason: "Two strips damaged in the fridge" }));
    expect(c.varianceValuePaisa).toBe(2 * store.costPaisa);
    c = await ok(post(`/v1/pharmacy/counts/${c.id}/submit`, { rev: c.rev }));
    expect(c).toMatchObject({ status: "submitted", canDecide: false });
    expect((await post(`/v1/pharmacy/counts/${c.id}/decision`, { decision: "approve" })).statusCode).toBe(403);
    expect((await ok(get("/v1/pharmacy/approvals", "owner"))).counts.map((x: { id: string }) => x.id)).toContain(c.id);
    const qtyBefore = (await inTenant((tx) => tx.stockBatch.findFirst({ where: { id: moved.to } })))!.qtyOnHand;
    c = await ok(post(`/v1/pharmacy/counts/${c.id}/decision`, { decision: "approve", note: "ok" }, "owner"));
    expect(c).toMatchObject({ status: "approved", decidedBy: { nameEn: "Test Owner" } });
    expect((await inTenant((tx) => tx.stockBatch.findFirst({ where: { id: moved.to } })))!.qtyOnHand).toBe(qtyBefore - 2);
    const adj = await inTenant((tx) => tx.stockMove.findMany({ where: { refType: "count", refId: c.id } }));
    expect(adj.map((m) => [m.kind, m.qty])).toEqual([["adjust", -2]]); // not −7: the 5 moved during the count are not taken twice
  });
});

describe.runIf(db)("the database backs every stock move and supplier entry (checked at commit)", () => {
  it("refuses a receive without a posted receipt line, an adjustment without an approved count, a lone transfer leg, a payment by the pharmacist", async () => {
    const b = (await inTenant((tx) => tx.stockBatch.findFirst({ where: { medicineKey: "ace", location: "store" } })))!;
    const as = (fn: (tx: NonNullable<typeof db>["prisma"]) => Promise<unknown>) => db!.forTenant(T, fn as never, { userId: "u_e2e_pharm" });
    await expect(as((tx) => tx.stockMove.create({ data: { tenantId: T, organizationId: b.organizationId, batchId: b.id, kind: "receive", qty: 100, refType: "seed", byId: "u_e2e_pharm" } }))).rejects.toThrow(/posted goods-receipt line/);
    await expect(as((tx) => tx.stockMove.create({ data: { tenantId: T, organizationId: b.organizationId, batchId: b.id, kind: "adjust", qty: 100, refType: "x", reason: "found extra stock today", byId: "u_e2e_pharm" } }))).rejects.toThrow(/approved count/);
    await expect(as((tx) => tx.stockMove.create({ data: { tenantId: T, organizationId: b.organizationId, batchId: b.id, kind: "transfer", qty: 100, refType: "transfer", refId: "tr_x", byId: "u_e2e_pharm" } }))).rejects.toThrow(/two legs/);
    await expect(as((tx) => tx.supplierEntry.create({ data: { tenantId: T, organizationId: b.organizationId, supplierId, kind: "payment", amountPaisa: 1, byId: "u_e2e_pharm" } }))).rejects.toThrow(/owner or an admin/);
  });
});

describe.runIf(db)("owner stock tiles and who may", () => {
  it("stock value, near-expiry and supplier dues are live, with the batches / suppliers behind them", async () => {
    const d = await ok(get("/v1/owner/dashboard?period=7d", "owner"));
    const k = (key: string) => d.kpis.find((x: { key: string }) => x.key === key);
    expect(k("stockValue")).toMatchObject({ comesWith: null, value: expect.any(Number) });
    expect(k("stockValue").value).toBeGreaterThan(0);
    expect(k("supplierDues").value).toBeGreaterThan(0);
    const near = await ok(get("/v1/owner/drill?period=7d&what=nearExpiry", "owner"));
    expect(near.rows.map((r: { number: string }) => r.number)).toContain(`AM${RUN}`);
    const dues = await ok(get("/v1/owner/drill?period=7d&what=supplierDues", "owner"));
    expect(dues.rows.map((r: { number: string }) => r.number)).toContain(`Test Supplier ${RUN}`);
  });
  it("one approval queue: the pharmacy kinds by status, and the dashboard's pending count includes them", async () => {
    const waiting = await ok(get("/v1/pharmacy/approvals?status=requested", "owner"));
    const approved = await ok(get("/v1/pharmacy/approvals?status=approved", "owner"));
    expect(approved.orders.every((x: { approval: { status: string } }) => x.approval.status === "approved")).toBe(true);
    expect(approved.counts.every((c: { status: string }) => c.status === "approved")).toBe(true);
    expect(approved.receipts.every((r: { postedBy: unknown; reasons: string[] }) => r.postedBy && r.reasons.length > 0)).toBe(true);
    const d = await ok(get("/v1/owner/dashboard?period=today", "owner"));
    expect(d.pending.approvals).toBeGreaterThanOrEqual(waiting.orders.length + waiting.counts.length + waiting.receipts.length);
  });
  it("the doctor is denied; another tenant's pharmacist finds nothing", async () => {
    expect((await get("/v1/pharmacy/suppliers", "doctor")).statusCode).toBe(403);
    expect((await get(`/v1/pharmacy/suppliers/${supplierId}`, "otherPharm")).statusCode).toBe(404);
    expect((await get("/v1/pharmacy/approvals")).statusCode).toBe(403);
  });
});

describe.runIf(db)("external review A6: purchasing decisions 179–186", () => {
  const order = async (sup: string, lines: { medicineKey: string; qty: number; costPaisa: number }[], who: Who = "pharm") => {
    let po = await ok(post("/v1/pharmacy/purchase-orders", { supplierId: sup }, who), 201);
    for (const l of lines) po = await ok(post(`/v1/pharmacy/purchase-orders/${po.id}/lines`, { rev: po.rev, ...l }, who));
    return po;
  };
  it("179: two ৳30,000 orders to one supplier the same day — the second asks the owner; another supplier is not affected; an approved order is not counted again", { timeout: 30_000 }, async () => {
    const split = (await ok(post("/v1/pharmacy/suppliers", { name: `Split Supplier ${RUN}` }), 201)).supplier.id;
    const other = (await ok(post("/v1/pharmacy/suppliers", { name: `Other Supplier ${RUN}` }), 201)).supplier.id;
    const half = [{ medicineKey: "azith", qty: 1000, costPaisa: 3000 }]; // ৳30,000
    const a = await order(split, half);
    expect(a).toMatchObject({ sendBlockers: [], supplierDayPaisa: 0 });
    expect(await ok(post(`/v1/pharmacy/purchase-orders/${a.id}/send`, { rev: a.rev }))).toMatchObject({ status: "sent" });
    const b = await order(split, half);
    expect(b).toMatchObject({ sendBlockers: ["approval_required"], supplierDayPaisa: 3_000_000 });
    const asked = await post(`/v1/pharmacy/purchase-orders/${b.id}/send`, { rev: b.rev });
    expect(asked.statusCode, asked.body).toBe(202);
    const task = await inTenant((tx) => tx.task.findFirst({ where: { kind: "purchase-approval", focusId: b.id } }));
    const aSent = await ok(get(`/v1/pharmacy/purchase-orders/${a.id}`));
    // the review: the request names the earlier orders the limit counted
    expect(task!.detail).toMatchObject({ totalPaisa: 3_000_000, supplierDayPaisa: 3_000_000, earlierOrders: [{ id: a.id, number: aSent.number, totalPaisa: 3_000_000 }] });
    expect(task!.reason).toContain(aSent.number);
    expect((await ok(get("/v1/pharmacy/approvals", "owner"))).orders.find((x: { order: { id: string } }) => x.order.id === b.id).approval.earlierOrders).toEqual([{ id: a.id, number: aSent.number, totalPaisa: 3_000_000 }]);
    // the same ৳30,000 to another supplier goes without asking
    const c = await order(other, half);
    expect(await ok(post(`/v1/pharmacy/purchase-orders/${c.id}/send`, { rev: c.rev }))).toMatchObject({ status: "sent" });
    // the owner approves (and so sends) the second; a later ৳1,000 order counts only the unapproved ৳30,000
    await ok(post(`/v1/pharmacy/purchase-orders/${b.id}/approval`, { decision: "approve" }, "owner"));
    const d = await order(split, [{ medicineKey: "napa", qty: 1000, costPaisa: 100 }]);
    expect(d).toMatchObject({ sendBlockers: [], supplierDayPaisa: 3_000_000 });
    // ৳25,000 more would make ৳55,000 unapproved today: it asks — and cancelled, its request is withdrawn (nobody rejected it)
    const e = await order(split, [{ medicineKey: "azith", qty: 834, costPaisa: 3000 }]);
    expect(e.sendBlockers).toEqual(["approval_required"]);
    expect((await post(`/v1/pharmacy/purchase-orders/${e.id}/send`, { rev: e.rev })).statusCode).toBe(202);
    const cancelled = await ok(post(`/v1/pharmacy/purchase-orders/${e.id}/cancel`, { rev: e.rev, reason: "Not needed after all, ordered less" }));
    expect(cancelled).toMatchObject({ status: "cancelled", approval: { status: "withdrawn", note: "order cancelled: Not needed after all, ordered less", decidedBy: { nameEn: "Test Pharmacist" } } });
    // the database: a withdrawal says why, and a withdrawn request is final
    const t2 = await inTenant((tx) => tx.task.findFirst({ where: { kind: "purchase-approval", focusId: e.id } }));
    await expect(db!.forTenant(T, (tx) => tx.task.updateMany({ where: { id: t2!.id }, data: { status: "approved" } }), { userId: "u_e2e_owner" })).rejects.toThrow(/final/);
    const f = await order(split, [{ medicineKey: "azith", qty: 834, costPaisa: 3000 }]);
    expect((await post(`/v1/pharmacy/purchase-orders/${f.id}/send`, { rev: f.rev })).statusCode).toBe(202);
    const t3 = await inTenant((tx) => tx.task.findFirst({ where: { kind: "purchase-approval", focusId: f.id } }));
    await expect(db!.forTenant(T, (tx) => tx.task.updateMany({ where: { id: t3!.id }, data: { status: "withdrawn", decidedById: "u_e2e_pharm", decidedAt: new Date(), decisionNote: "short" } }), { userId: "u_e2e_pharm" })).rejects.toThrow(/says why/);
    await ok(post(`/v1/pharmacy/purchase-orders/${f.id}/cancel`, { rev: f.rev, reason: "Asked by mistake, cancelling it" }));
  });

  it("181 (the review): each supplier says how its bills show VAT; a receipt keeps the flag it was posted with", { timeout: 30_000 }, async () => {
    const sup = (await ok(post("/v1/pharmacy/suppliers", { name: `VAT Supplier ${RUN}`, vatTreatment: "on-top" }), 201)).supplier;
    expect(sup.vatTreatment).toBe("on-top");
    expect((await ok(post("/v1/pharmacy/suppliers", { name: `Plain Supplier ${RUN}` }), 201)).supplier.vatTreatment).toBe("included");
    const po = await order(sup.id, [{ medicineKey: "napa", qty: 100, costPaisa: 100 }]);
    const sent = await ok(post(`/v1/pharmacy/purchase-orders/${po.id}/send`, { rev: po.rev }));
    let g = await ok(post("/v1/pharmacy/goods-receipts", { orderId: po.id, supplierInvoiceNo: `VAT-${RUN}` }), 201);
    g = await ok(post(`/v1/pharmacy/goods-receipts/${g.id}/lines`, { rev: g.rev, orderLineId: sent.lines[0].id, batchNo: `NV${RUN}`, expiry: day(700), invoicedQty: 100, receivedQty: 100, costPaisa: 100, mrpPaisa: 120, location: "store" }));
    expect(g.supplierVatTreatment).toBe("on-top");
    g = await ok(post(`/v1/pharmacy/goods-receipts/${g.id}/post`, { rev: g.rev, supplierVatPaisa: 750 }));
    expect(g).toMatchObject({ status: "posted", supplierVatTreatment: "on-top", supplierVatPaisa: 750, money: { owedPaisa: 10_000 } });
    // the flag is the owner's / admin's to change (audited); the posted receipt keeps the one it was posted with
    expect((await post(`/v1/pharmacy/suppliers/${sup.id}/vat`, { vatTreatment: "exempt" })).statusCode).toBe(403);
    expect((await ok(post(`/v1/pharmacy/suppliers/${sup.id}/vat`, { vatTreatment: "exempt" }, "owner"))).supplier.vatTreatment).toBe("exempt");
    expect((await ok(get(`/v1/pharmacy/goods-receipts/${g.id}`))).supplierVatTreatment).toBe("on-top");
    const ev = await inTenant((tx) => tx.auditEvent.findFirst({ where: { entity: "Supplier", entityId: sup.id, action: "update" } }));
    expect(ev!.detail).toMatchObject({ event: "vat-treatment", before: "on-top", after: "exempt" });
    await expect(inTenant((tx) => tx.supplier.updateMany({ where: { id: sup.id }, data: { vatTreatment: "zero" } }))).rejects.toThrow();
  });

  it("180 / 181: within min(2 %, ৳50) per line the pharmacist posts a price difference; beyond it the owner; the supplier's VAT / AIT recorded, not owed", { timeout: 30_000 }, async () => {
    const f = await ok(get("/v1/admin/facility", "owner"));
    expect(f.settings).toMatchObject({ grnToleranceBp: 200, grnTolerancePaisa: 5_000 });
    const po = await order(supplierId, [{ medicineKey: "comet", qty: 200, costPaisa: 340 }]); // 100 at a time: 2 % of ৳340 = ৳6.80
    const sent = await ok(post(`/v1/pharmacy/purchase-orders/${po.id}/send`, { rev: po.rev }));
    const lineId = sent.lines[0].id;
    const receipt = async (batch: string, costPaisa: number) => {
      const g = await ok(post("/v1/pharmacy/goods-receipts", { orderId: po.id, supplierInvoiceNo: `TOL-${batch}` }), 201);
      return ok(post(`/v1/pharmacy/goods-receipts/${g.id}/lines`, { rev: g.rev, orderLineId: lineId, batchNo: batch, expiry: day(700), invoicedQty: 100, receivedQty: 100, costPaisa, mrpPaisa: 400, location: "store" }));
    };
    const owedBefore = await owed();
    // ৳3.46 a tablet: ৳6 over on the line, within ৳6.80 — the pharmacist posts it
    let g = await receipt(`T1${RUN}`, 346);
    expect(g.lines[0]).toMatchObject({ priceVariance: true, priceBeyondTolerance: false, tolerancePaisa: 680 });
    expect(g.postBlockers).toEqual([]);
    g = await ok(post(`/v1/pharmacy/goods-receipts/${g.id}/post`, { rev: g.rev, supplierVatPaisa: 1_500, supplierAitPaisa: 300 }));
    expect(g).toMatchObject({ status: "posted", supplierVatPaisa: 1_500, supplierAitPaisa: 300, money: { owedPaisa: 34_600 } });
    expect(await owed()).toBe(owedBefore + 34_600); // VAT / AIT are data, not owed
    const audit = (await inTenant((tx) => tx.auditEvent.findMany({ where: { entity: "GoodsReceipt", entityId: g.id, action: "update" } }))).find((x) => (x.detail as { event?: string }).event === "post");
    expect(audit!.detail).toMatchObject({ supplierVatPaisa: 1_500, supplierAitPaisa: 300, lines: [expect.objectContaining({ withinTolerance: true })] });
    await expect(inTenant((tx) => tx.goodsReceipt.updateMany({ where: { id: g.id }, data: { supplierVatPaisa: 0 } }))).rejects.toThrow(/never changes/);
    // ৳3.47: ৳7 over — the owner's
    let g2 = await receipt(`T2${RUN}`, 347);
    expect(g2.lines[0]).toMatchObject({ priceBeyondTolerance: true });
    expect(g2.postBlockers).toEqual(["price_variance_needs_owner"]);
    const refused = await post(`/v1/pharmacy/goods-receipts/${g2.id}/post`, { rev: g2.rev });
    expect([refused.statusCode, refused.json().code]).toEqual([403, "price_variance_needs_owner"]);
    expect((await ok(get("/v1/pharmacy/approvals?status=requested", "owner"))).receipts.map((r: { id: string }) => r.id)).toContain(g2.id);
    // the facility's tolerance is an approval limit: a change needs the reason; at 0 % the ৳6 difference is the owner's too
    const noReason = await post("/v1/admin/settings", { ...f.settings, grnToleranceBp: 0 }, "owner");
    expect([noReason.statusCode, noReason.json().code]).toEqual([400, "reason_required"]);
    expect((await post("/v1/admin/settings", { ...f.settings, grnToleranceBp: 1001, reason: "testing the range" }, "owner")).statusCode).toBe(400);
    await ok(post("/v1/admin/settings", { ...f.settings, grnToleranceBp: 0, reason: "no price differences this month" }, "owner"));
    try {
      const g3 = await receipt(`T3${RUN}`, 341);
      expect(g3.postBlockers).toEqual(["price_variance_needs_owner"]);
      await ok(post(`/v1/pharmacy/goods-receipts/${g3.id}/discard`, { rev: g3.rev }));
    } finally { await ok(post("/v1/admin/settings", { ...f.settings, reason: "back to the sample tolerance" }, "owner")); }
    g2 = await ok(post(`/v1/pharmacy/goods-receipts/${g2.id}/post`, { rev: g2.rev }, "owner"));
    expect(g2.status).toBe("posted");
  });

  it("a stock count still being entered when the counter's shift closes is ended with the reason, flagged on the owner's exceptions list; nothing moves", { timeout: 40_000 }, async () => {
    // the counter is free: open counts left by earlier runs are rejected on the owner's connection
    const owner = new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    try {
      for (const c of await owner.stockCount.findMany({ where: { tenantId: T, location: "counter", status: { in: ["counting", "submitted"] } } })) {
        if (c.status === "counting") await owner.stockCount.update({ where: { id: c.id }, data: { status: "submitted", submittedAt: new Date(), rev: { increment: 1 } } });
        await owner.stockCount.update({ where: { id: c.id }, data: { status: "rejected", decidedById: "u_e2e_admin", decidedAt: new Date(), decisionNote: "leftover from an earlier test run", rev: { increment: 1 } } });
      }
    } finally { await owner.$disconnect(); }
    // the pharmacist's drawer: whatever an earlier run left is closed; a fresh shift with no float
    const mine = await ok(get("/v1/shifts/mine"));
    let sh = mine.shift;
    if (sh?.status === "open") sh = await ok(post(`/v1/shifts/${sh.id}/count`, { counts: {} }));
    if (sh?.status === "counted") sh = await ok(post(`/v1/shifts/${sh.id}/hand-over`, { reason: "closing a shift left by an earlier test run" }));
    if (sh?.status === "closed") await ok(post(`/v1/shifts/${sh.id}/review`, { decision: "approve", note: "closing a shift left by an earlier test run" }, "owner"));
    sh = await ok(post("/v1/shifts", { openingFloatPaisa: 0 }), 201);
    let c = await ok(post("/v1/pharmacy/counts", { location: "counter" }), 201);
    c = await ok(get(`/v1/pharmacy/counts/${c.id}`));
    c = await ok(post(`/v1/pharmacy/counts/${c.id}/lines`, { rev: c.rev, lineId: c.lines[0].id, countedQty: c.lines[0].systemQty + 5, reason: "five more found behind the shelf" }));
    const movesBefore = await inTenant((tx) => tx.stockMove.count({ where: { refType: "count", refId: c.id } }));
    // the drawer matches (nothing taken): handed over at once — and the open count ends with it
    const closed = await ok(post(`/v1/shifts/${sh.id}/count`, { counts: {} }));
    expect(closed.status).toBe("closed");
    const ended = await ok(get(`/v1/pharmacy/counts/${c.id}`));
    expect(ended).toMatchObject({ status: "abandoned", decidedBy: { nameEn: "Test Pharmacist" }, decisionNote: expect.stringContaining("shift"), selfApproved: false, canDecide: false });
    expect(await inTenant((tx) => tx.stockMove.count({ where: { refType: "count", refId: c.id } }))).toBe(movesBefore);
    const ev = await inTenant((tx) => tx.auditEvent.findFirst({ where: { action: "count-abandoned", entityId: c.id } }));
    expect(ev!.detail).toMatchObject({ location: "counter", shiftId: sh.id, linesCounted: 1, flag: "count-abandoned" });
    // the owner: the exceptions list and the drill behind it; the flagged audit log
    const d = await ok(get("/v1/owner/dashboard?period=today", "owner"));
    expect(d.leakage.find((l: { kind: string }) => l.kind === "countAbandoned").count).toBeGreaterThanOrEqual(1);
    const drill = await ok(get("/v1/owner/drill?period=today&what=countAbandoned", "owner"));
    expect(drill.rows.find((r: { id: string }) => r.id === c.id)).toMatchObject({ link: { kind: "count", id: c.id }, status: "abandoned", by: { nameEn: "Test Pharmacist" } });
    const flagged = await ok(get("/v1/admin/audit?action=count-abandoned&flagged=1", "owner"));
    expect(flagged.items.some((x: { entityId: string }) => x.entityId === c.id)).toBe(true);
    // the counter can be counted again; an ended count never changes, and only its counter ends one (with a reason)
    expect((await ok(get("/v1/pharmacy/counts?status=counting&location=counter"))).items.map((x: { id: string }) => x.id)).not.toContain(c.id);
    await expect(inTenant((tx) => tx.stockCount.updateMany({ where: { id: c.id }, data: { decisionNote: "something else entirely" } }))).rejects.toThrow(/never changes/);
    const other = await ok(post("/v1/pharmacy/counts", { location: "counter" }), 201);
    await expect(db!.forTenant(T, (tx) => tx.stockCount.updateMany({ where: { id: other.id }, data: { status: "abandoned", decidedById: "u_e2e_owner", decidedAt: new Date(), decisionNote: "ending someone else's count" } }), { userId: "u_e2e_owner" })).rejects.toThrow(/own shift close/);
    await expect(db!.forTenant(T, (tx) => tx.stockCount.updateMany({ where: { id: other.id }, data: { status: "abandoned", decidedById: "u_e2e_pharm", decidedAt: new Date(), decisionNote: "short" } }), { userId: "u_e2e_pharm" })).rejects.toThrow(/says why/);
    // and this one ends at the next shift close too (leaves the counter free for the next run)
    await ok(post(`/v1/shifts/${sh.id}/review`, { decision: "approve" }, "owner"));
    const sh2 = await ok(post("/v1/shifts", { openingFloatPaisa: 0 }), 201);
    expect((await ok(post(`/v1/shifts/${sh2.id}/count`, { counts: {} }))).status).toBe("closed");
    expect((await ok(get(`/v1/pharmacy/counts/${other.id}`))).status).toBe("abandoned");
    await ok(post(`/v1/shifts/${sh2.id}/review`, { decision: "approve" }, "owner"));
  });
});

describe.runIf(db)("external review B9: the count snapshot and the last units", () => {
  /** On the owner's connection: a transfer pair (fridge → store) left uncommitted until `release` — another session's
      move in flight, holding the fridge batch's row lock. `at` may be set earlier than now (a clock that ran behind). */
  function inFlight(from: { id: string; batchNo: string; medicineKey: string; organizationId: string }, to: { id: string }, qty: number, at = new Date()) {
    const o = new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    let release!: () => void; let started!: () => void;
    const begun = new Promise<void>((r) => { started = r; });
    const done = o.$transaction(async (tx) => {
      const ref = `tr_b9_${randomUUID()}`;
      await tx.stockMove.create({ data: { tenantId: T, organizationId: from.organizationId, batchId: from.id, kind: "transfer", qty: -qty, refType: "transfer", refId: ref, byId: "u_e2e_pharm", at } });
      await tx.stockMove.create({ data: { tenantId: T, organizationId: from.organizationId, batchId: to.id, kind: "transfer", qty, refType: "transfer", refId: ref, byId: "u_e2e_pharm", at } });
      started();
      await new Promise<void>((r) => { release = r; });
    }, { timeout: 20_000 }).finally(() => o.$disconnect());
    return { begun, done, release: () => release() };
  }
  /** A fridge batch holding `n` (moved from the store through the API), and its store twin. */
  async function fridgeBatch(n: number) {
    const store = (await inTenant((tx) => tx.stockBatch.findFirst({ where: { medicineKey: "pantonix", location: "store", qtyOnHand: { gte: n + 5 } } })))!;
    const r = await ok(post("/v1/pharmacy/transfers", { batchId: store.id, qty: n, to: "fridge" }), 201);
    return { fridge: (await inTenant((tx) => tx.stockBatch.findFirst({ where: { id: r.to } })))!, store };
  }

  it("two takes of the last units at once: the database refuses one and the caller gets 409 stock_short, never a 500", { timeout: 30_000 }, async () => {
    const { fridge, store } = await fridgeBatch(3);
    const all = fridge.qtyOnHand;
    const other = inFlight(fridge, store, all); // someone else is taking every unit
    await other.begun;
    const mine = post("/v1/pharmacy/transfers", { batchId: fridge.id, qty: all, to: "counter" }); // read the old quantity, waits on the lock
    await new Promise((r) => setTimeout(r, 400));
    other.release(); await other.done;
    const r = await mine;
    expect([r.statusCode, r.json().code]).toEqual([409, "stock_short"]);
    expect((await inTenant((tx) => tx.stockBatch.findFirst({ where: { id: fridge.id } })))!.qtyOnHand).toBe(0);
  });

  it("a count started while a move is in flight (stamped earlier): the move is counted as since the snapshot — no false variance", { timeout: 40_000 }, async () => {
    // the fridge is free: open counts left by earlier runs are rejected on the owner's connection
    const o = new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    try {
      for (const c of await o.stockCount.findMany({ where: { tenantId: T, location: "fridge", status: { in: ["counting", "submitted"] } } })) {
        if (c.status === "counting") await o.stockCount.update({ where: { id: c.id }, data: { status: "submitted", submittedAt: new Date(), rev: { increment: 1 } } });
        await o.stockCount.update({ where: { id: c.id }, data: { status: "rejected", decidedById: "u_e2e_admin", decidedAt: new Date(), decisionNote: "leftover from an earlier test run", rev: { increment: 1 } } });
      }
    } finally { await o.$disconnect(); }
    const { fridge, store } = await fridgeBatch(4);
    const before = fridge.qtyOnHand;
    const move = inFlight(fridge, store, 1, new Date(Date.now() - 60_000)); // committed after the snapshot, stamped a minute earlier
    await move.begun;
    let c = await ok(post("/v1/pharmacy/counts", { location: "fridge" }), 201);
    move.release(); await move.done;
    c = await ok(get(`/v1/pharmacy/counts/${c.id}`));
    const line = c.lines.find((l: { batch: { id: string } }) => l.batch.id === fridge.id);
    expect(line.systemQty).toBe(before - 1); // the snapshot's quantity plus what moved since
    // the shelf really holds one less: counted so, no variance (by wall-clock it looked like one missing)
    c = await ok(post(`/v1/pharmacy/counts/${c.id}/lines`, { rev: c.rev, lineId: line.id, countedQty: before - 1 }));
    expect(c.lines.find((l: { id: string }) => l.id === line.id).variance).toBe(0);
    const row = await inTenant((tx) => tx.stockCountLine.findFirst({ where: { id: line.id } }));
    expect(row).toMatchObject({ systemQty: before, sinceSeq: fridge.moveSeq, countedSeq: fridge.moveSeq + 1 }); // + the in-flight move
    // the move numbers follow the batch: 1, 2, … without gaps, the database's own
    const seqs = (await inTenant((tx) => tx.stockMove.findMany({ where: { batchId: fridge.id }, orderBy: { batchSeq: "asc" }, select: { batchSeq: true } }))).map((m) => m.batchSeq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    // the rest counted as the system says; approved — the in-flight move is not adjusted a second time
    const movesBefore = await inTenant((tx) => tx.stockMove.count({ where: { refType: "count", refId: c.id } }));
    for (const l of c.lines.filter((x: { countedQty: number | null }) => x.countedQty === null)) c = await ok(post(`/v1/pharmacy/counts/${c.id}/lines`, { rev: c.rev, lineId: l.id, countedQty: l.systemQty }));
    c = await ok(post(`/v1/pharmacy/counts/${c.id}/submit`, { rev: c.rev }));
    const done = await ok(post(`/v1/pharmacy/counts/${c.id}/decision`, { decision: "approve" }, "owner"));
    expect(done.status).toBe("approved");
    expect(await inTenant((tx) => tx.stockMove.count({ where: { refType: "count", refId: c.id } }))).toBe(movesBefore); // nothing to adjust
    expect((await inTenant((tx) => tx.stockBatch.findFirst({ where: { id: fridge.id } })))!.qtyOnHand).toBe(before - 1);
  });
});

