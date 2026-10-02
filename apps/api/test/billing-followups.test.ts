/* Billing follow-ups (ADR 0005) on the real database, E2E Test Clinic, new synthetic patients signed by the E2E doctor:
   - "Not billed here" (decision 98): APPROVAL Task kind bill-elsewhere on an unpriced order line; nothing excluded
     before approval, issue blocked while requested, no self-approval; approved → outside totals, on the receipt with
     its reason; the order stays active;
   - void (INVOICE entered-in-error): owner/admin, reason, never with confirmed money or a pending link; number kept;
     a new bill records what it replaces and the voided one shows its replacement once issued;
   - payment reconciliation (owner): apply only on a provider-confirmed match with a pending payment; otherwise
     resolve with a note; never a silent apply;
   - order refresh on a draft bill. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeProvider } from "../src/adapters/payments/index.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { closePdfBrowser } from "../src/receipts/pdf.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("billing-followups.test: DATABASE_URL_APP not set — SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const cookies: Record<string, string> = {};
const USERS = { desk: "01799000001", doctor: "01799000002", cashier: "01799000008", owner: "01799000009", admin: "01799000010" } as const;
type Who = keyof typeof USERS;

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of Object.entries(USERS)) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; cookies[k] = Array.isArray(c) ? c[0]! : (c as string);
  }
}, 60_000);
afterAll(async () => { await closePdfBrowser(); await app.close(); });

const get = (url: string, who: Who = "cashier") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const post = (url: string, payload: object = {}, who: Who = "cashier", key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const inTenant = <R>(fn: (tx: NonNullable<typeof db>["prisma"]) => Promise<R>) => db!.forTenant("t_e2e", fn as never) as Promise<R>;

/** A signed visit with these orders (SGPT has no price in the sample list). */
async function signedVisit(orders: string[] = ["cbc", "rbs", "elec"]) {
  const r = await post("/v1/patients", {
    nameBn: "ফলো-আপ রোগী", nameEn: `Followup ${RUN}`, sex: "female", dobMode: "dob", dob: "04/04/1984", phone: `017${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self",
    division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
  }, "desk");
  expect(r.statusCode, r.body).toBe(201);
  const enc = r.json().encounter.id as string;
  const v = (await post(`/v1/encounters/${enc}/consultation/open`, {}, "doctor")).json();
  const saved = await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: cookies.doctor!, "idempotency-key": randomUUID() }, payload: {
    rev: 1, sections: { complaints: [{ text: "Fatigue", duration: { n: 1, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }],
    orders: orders.map((testCode) => ({ testCode, priority: "routine" })),
  } });
  expect(saved.statusCode, saved.body).toBe(200);
  expect((await post(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.json().rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor")).statusCode).toBe(200);
  return enc;
}
async function bill(orders?: string[]) {
  const enc = await signedVisit(orders);
  const r = await post(`/v1/encounters/${enc}/invoice`);
  expect(r.statusCode, r.body).toBe(201);
  return { enc, view: r.json() };
}
const issue = async (id: string, rev: number) => { const r = await post(`/v1/invoices/${id}/issue`, { rev }); expect(r.statusCode, r.body).toBe(200); return r.json(); };
const lineOf = (view: { lines: { code: string; id: string }[] }, code: string) => view.lines.find((l) => l.code === code)!;

describe.runIf(db)("decision 98: Not billed here", () => {
  it("only an unpriced order line, with a reason; a requested Task blocks issue and locks lines; owner approves → excluded, the order stays active", async () => {
    const { view } = await bill(["cbc", "sgpt"]);
    const id = view.invoice.id;
    const sgpt = lineOf(view, "test:sgpt");
    expect(sgpt.unitPaisa).toBeNull();
    expect(view.issueBlockers).toEqual(["unpriced_lines"]);
    expect((await post(`/v1/invoices/${id}/lines/${lineOf(view, "consult:u_e2e_doctor").id}/not-billed`, { reason: "Billed at the partner lab", rev: view.invoice.rev })).json()).toMatchObject({ code: "not_an_order_line" });
    expect((await post(`/v1/invoices/${id}/lines/${lineOf(view, "test:cbc").id}/not-billed`, { reason: "Billed at the partner lab", rev: view.invoice.rev })).json()).toMatchObject({ code: "line_has_price" });
    expect((await post(`/v1/invoices/${id}/lines/${sgpt.id}/not-billed`, { reason: "lab", rev: view.invoice.rev })).statusCode).toBe(400);
    const r = await post(`/v1/invoices/${id}/lines/${sgpt.id}/not-billed`, { reason: "Sent to the partner lab, billed there", rev: view.invoice.rev });
    expect(r.statusCode, r.body).toBe(200);
    const v = r.json();
    expect(v.lineApprovals[0]).toMatchObject({ lineId: sgpt.id, status: "requested", requestedBy: { id: "u_e2e_cashier" } });
    expect(v.lines.find((l: { id: string }) => l.id === sgpt.id).notBilled).toBeNull();
    expect(v.issueBlockers).toEqual(["unpriced_lines", "approval_pending"]);
    expect((await post(`/v1/invoices/${id}/lines`, { code: "desk:card", rev: v.invoice.rev })).json()).toMatchObject({ code: "approval_pending" });
    await expect(inTenant((tx) => tx.chargeItem.update({ where: { id: sgpt.id }, data: { notBilledReason: "x".repeat(12), notBilledAt: new Date() } }))).resolves.toBeTruthy(); // reason alone does not exclude (no Task id) …
    await expect(inTenant((tx) => tx.chargeItem.update({ where: { id: lineOf(view, "test:cbc").id }, data: { notBilledTaskId: "t", notBilledReason: "x".repeat(12), notBilledAt: new Date() } }))).rejects.toThrow(); // … and a priced line can never be excluded
    await inTenant((tx) => tx.chargeItem.update({ where: { id: sgpt.id }, data: { notBilledReason: null, notBilledAt: null } }));

    const list = (await get("/v1/approvals", "owner")).json().items;
    const item = list.find((i: { line: { id: string } | null }) => i.line?.id === sgpt.id);
    expect(item).toMatchObject({ kind: "bill-elsewhere", amountPaisa: 0, category: null, reason: "Sent to the partner lab, billed there", line: { nameEn: "SGPT" } });
    expect((await post(`/v1/approvals/${item.taskId}/approve`, {}, "cashier")).statusCode).toBe(403);
    const ok = await post(`/v1/approvals/${item.taskId}/approve`, {}, "owner");
    expect(ok.statusCode, ok.body).toBe(200);
    const after = ok.json().view;
    expect(after.lines.find((l: { id: string }) => l.id === sgpt.id).notBilled).toMatchObject({ reason: "Sent to the partner lab, billed there", approvedBy: { id: "u_e2e_owner" } });
    expect(after.issueBlockers).toEqual([]);
    expect(after.invoice).toMatchObject({ subtotalPaisa: 125_000, totalPaisa: 125_000 });
    const issued = await issue(id, after.invoice.rev);
    expect(issued.invoice.status).toBe("issued");
    const order = await inTenant((tx) => tx.serviceRequest.findFirst({ where: { id: sgpt.sourceId } }));
    expect(order?.status).toBe("active");
    // the receipt keeps the line with its reason and no amount
    await post(`/v1/invoices/${id}/payments`, { method: "cash", amountPaisa: 125_000, tenderedPaisa: 125_000 });
    const rc = (await post(`/v1/invoices/${id}/receipts`)).json().receipt;
    expect(rc.snapshot.lines.find((l: { nameEn: string }) => l.nameEn === "SGPT")).toMatchObject({ notBilledReason: "Sent to the partner lab, billed there", grossPaisa: 0 });
  });
  it("rejected: nothing changes and the line still blocks; nobody approves their own request", async () => {
    const { view } = await bill(["sgpt"]);
    const sgpt = lineOf(view, "test:sgpt");
    const v = (await post(`/v1/invoices/${view.invoice.id}/lines/${sgpt.id}/not-billed`, { reason: "Patient will test elsewhere", rev: view.invoice.rev }, "owner")).json();
    const taskId = v.lineApprovals[0].taskId;
    expect((await post(`/v1/approvals/${taskId}/approve`, {}, "owner")).json()).toMatchObject({ code: "own_request" });
    const no = await post(`/v1/approvals/${taskId}/reject`, { note: "Price it in the master list first" }, "admin");
    expect(no.json().view.lines.find((l: { id: string }) => l.id === sgpt.id).notBilled).toBeNull();
    expect(no.json().view.issueBlockers).toEqual(["unpriced_lines"]);
  });
});

describe.runIf(db)("void (INVOICE entered-in-error, ADR 0005)", () => {
  it("owner/admin with a reason; refused while a link is pending or money is confirmed; the number stays; a replacement records the chain", async () => {
    const { enc, view } = await bill();
    const issued = await issue(view.invoice.id, view.invoice.rev);
    const number = issued.invoice.number;
    const link = (await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "bkash", amountPaisa: 100_000 })).json().payment;
    expect((await post(`/v1/invoices/${view.invoice.id}/void`, { reason: "Wrong patient was billed" }, "cashier")).statusCode).toBe(403);
    expect((await post(`/v1/invoices/${view.invoice.id}/void`, { reason: "wrong" }, "owner")).statusCode).toBe(400);
    expect((await post(`/v1/invoices/${view.invoice.id}/void`, { reason: "Wrong patient was billed" }, "owner")).json()).toMatchObject({ code: "link_pending" });
    await post(`/v1/payments/${link.id}/cancel`);
    const v = await post(`/v1/invoices/${view.invoice.id}/void`, { reason: "Wrong patient was billed" }, "owner");
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().invoice).toMatchObject({ status: "entered-in-error", number, void: { reason: "Wrong patient was billed", by: { id: "u_e2e_owner" } }, replacedBy: null });
    expect((await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "cash", amountPaisa: 100, tenderedPaisa: 100 })).json()).toMatchObject({ code: "not_payable" });
    await expect(inTenant((tx) => tx.invoice.update({ where: { id: view.invoice.id }, data: { voidReason: "edited afterwards ok" } }))).rejects.toThrow(/voided bill is never changed/);
    await expect(inTenant((tx) => tx.invoice.delete({ where: { id: view.invoice.id } }))).rejects.toThrow();
    // a new bill for the visit records what it replaces; once issued, the voided bill shows "Replaced by"
    const nb = await post(`/v1/encounters/${enc}/invoice`);
    expect(nb.statusCode).toBe(201);
    expect(nb.json().invoice).toMatchObject({ status: "draft", replaces: { id: view.invoice.id, number } });
    const ni = await issue(nb.json().invoice.id, nb.json().invoice.rev);
    expect(ni.invoice.number).not.toBe(number);
    const old = (await get(`/v1/invoices/${view.invoice.id}`)).json();
    expect(old.invoice.replacedBy).toEqual({ id: nb.json().invoice.id, number: ni.invoice.number });
  });
  it("a bill with confirmed money cannot be voided (refunds come later); a draft can (no number)", async () => {
    const { view } = await bill();
    await issue(view.invoice.id, view.invoice.rev);
    await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "cash", amountPaisa: 30_000, tenderedPaisa: 30_000 });
    expect((await post(`/v1/invoices/${view.invoice.id}/void`, { reason: "Wrong patient was billed" }, "admin")).json()).toMatchObject({ code: "has_confirmed_money" });
    const d = await bill();
    const v = await post(`/v1/invoices/${d.view.invoice.id}/void`, { reason: "Opened on the wrong visit" }, "admin");
    expect(v.json().invoice).toMatchObject({ status: "entered-in-error", number: null });
  });
});

describe.runIf(db)("payment reconciliation (owner)", () => {
  async function lateMoneyOnReplacedLink() {
    const { view } = await bill();
    await issue(view.invoice.id, view.invoice.rev);
    const p = (await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "bkash", amountPaisa: 100_000 })).json().payment;
    const ref0 = (await inTenant((tx) => tx.payment.findFirst({ where: { id: p.id } })))!.providerRef!;
    await post(`/v1/dev/fake-payments/${p.id}/failed`, {}, "cashier", null);
    await post(`/v1/payments/${p.id}/retry`);
    const cb = fakeProvider()!.simulate(ref0, "confirmed")!;
    expect((await app.inject({ method: "POST", url: "/v1/payments/callback/fake", payload: cb.body, headers: cb.headers })).json()).toEqual({ outcome: "refused", reason: "late-confirm" });
    return { view, p, ref0, trx: cb.trxId! };
  }
  it("apply: the provider confirms the same amount and TrxID for the still-pending payment → confirmed, the newer link cancelled", async () => {
    const { view, p, trx } = await lateMoneyOnReplacedLink();
    expect((await get("/v1/reconciliation", "cashier")).statusCode).toBe(403);
    expect((await get("/v1/reconciliation", "admin")).statusCode).toBe(403);
    const item = (await get("/v1/reconciliation", "owner")).json().items.find((i: { payment: { id: string } }) => i.payment.id === p.id);
    expect(item).toMatchObject({ status: "requested", reported: { trxId: trx, amountPaisa: 100_000 }, payment: { status: "link-sent", amountPaisa: 100_000 }, applyBlockers: [] });
    const newRef = (await inTenant((tx) => tx.payment.findFirst({ where: { id: p.id } })))!.providerRef!;
    const r = await post(`/v1/reconciliation/${item.taskId}/apply`, { note: "Paid on the first link" }, "owner");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().item).toMatchObject({ status: "approved", payment: { status: "confirmed", trxId: trx }, resolution: { action: "applied", by: { id: "u_e2e_owner" } } });
    expect((await fakeProvider()!.verify({ providerRef: newRef }))?.status).toBe("failed");
    expect((await get(`/v1/invoices/${view.invoice.id}`)).json().invoice).toMatchObject({ status: "partially-paid", paidPaisa: 100_000 });
    expect((await post(`/v1/reconciliation/${item.taskId}/apply`, {}, "owner")).json()).toMatchObject({ code: "invalid_transition" });
  });
  it("an amount that differs is never applied: resolve with a note; nothing changes on the payment", async () => {
    const { view } = await bill();
    await issue(view.invoice.id, view.invoice.rev);
    const p = (await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "bkash", amountPaisa: 230_000 })).json().payment;
    await post(`/v1/dev/fake-payments/${p.id}/confirmed`, { amountPaisa: 23_000 }, "cashier", null);
    const item = (await get("/v1/reconciliation", "owner")).json().items.find((i: { payment: { id: string } }) => i.payment.id === p.id);
    expect(item.applyBlockers).toEqual(["amount_mismatch"]);
    const no = await post(`/v1/reconciliation/${item.taskId}/apply`, {}, "owner");
    expect(no.statusCode).toBe(422);
    expect(no.json().blockers).toEqual([{ code: "amount_mismatch" }]);
    expect((await post(`/v1/reconciliation/${item.taskId}/resolve`, { note: "short" }, "owner")).statusCode).toBe(400);
    const ok = await post(`/v1/reconciliation/${item.taskId}/resolve`, { note: "Called the patient; refund through bKash support" }, "owner");
    expect(ok.json().item).toMatchObject({ status: "rejected", resolution: { action: "resolved", note: "Called the patient; refund through bKash support" }, payment: { status: "link-sent" } });
  });
});

describe.runIf(db)("order refresh on a draft bill (decision 99)", () => {
  it("ORDER revoke (lab slice) drops the line from the draft at once; with a discount the refresh waits and Issue is blocked", async () => {
    const { enc, view } = await bill();
    const rbs = lineOf(view, "test:rbs");
    const rv = await post(`/v1/orders/${rbs.sourceId}/revoke`, { reason: "ordered twice by mistake" }, "doctor");
    expect(rv.json().bill).toMatchObject({ invoiceId: view.invoice.id, removed: ["test:rbs"], waits: false });
    const fresh = (await get(`/v1/invoices/${view.invoice.id}`)).json();
    expect(fresh.ordersChanged).toBe(false);
    const open = (await post(`/v1/encounters/${enc}/invoice`)).json();
    expect(open.lines.map((l: { code: string }) => l.code)).toEqual(["consult:u_e2e_doctor", "test:cbc", "test:elec"]);
    expect(open.invoice.totalPaisa).toBe(215_000);
    expect(open.ordersChanged).toBe(false);
    // with a discount on the bill nothing is recalculated silently
    const d = (await post(`/v1/invoices/${view.invoice.id}/discount`, { mode: "amount", amountPaisa: 10_000, category: "poor", reason: "Day labourer, doctor asked", rev: open.invoice.rev })).json().view;
    const cbc = lineOf(d, "test:cbc");
    const rv2 = await post(`/v1/orders/${cbc.sourceId}/revoke`, { reason: "patient already did it elsewhere" }, "doctor");
    expect(rv2.json().bill).toMatchObject({ removed: [], waits: true });
    const reopened = (await post(`/v1/encounters/${enc}/invoice`)).json();
    expect(reopened.lines.map((l: { code: string }) => l.code)).toContain("test:cbc");
    expect(reopened.issueBlockers).toContain("orders_changed");
    expect((await post(`/v1/invoices/${view.invoice.id}/issue`, { rev: reopened.invoice.rev })).json().blockers).toEqual([{ code: "orders_changed" }]);
    expect((await post(`/v1/invoices/${view.invoice.id}/refresh-orders`, { rev: reopened.invoice.rev })).json()).toMatchObject({ code: "discount_present" });
  });
});

describe.runIf(db)("review fixes (security + money)", () => {
  it("no retry on a voided bill (API and database); void is refused while an approval waits", async () => {
    const { view } = await bill(["cbc", "sgpt"]);
    const sgpt = lineOf(view, "test:sgpt");
    await post(`/v1/invoices/${view.invoice.id}/lines/${sgpt.id}/not-billed`, { reason: "Sent to the partner lab, billed there", rev: view.invoice.rev });
    expect((await post(`/v1/invoices/${view.invoice.id}/void`, { reason: "Opened on the wrong visit" }, "owner")).json()).toMatchObject({ code: "approval_pending" });
    const b = await bill();
    await issue(b.view.invoice.id, b.view.invoice.rev);
    const p = (await post(`/v1/invoices/${b.view.invoice.id}/payments`, { method: "bkash", amountPaisa: 100_000 })).json().payment;
    await post(`/v1/payments/${p.id}/cancel`);
    expect((await post(`/v1/invoices/${b.view.invoice.id}/void`, { reason: "Billed on the wrong visit" }, "owner")).statusCode).toBe(200);
    expect((await post(`/v1/payments/${p.id}/retry`)).json()).toMatchObject({ code: "not_payable" });
    await expect(inTenant((tx) => tx.payment.update({ where: { id: p.id }, data: { status: "initiated", attempt: 2 } }))).rejects.toThrow(/not retried/);
  });
  it("while a reconciliation is open: the bill says so, its links cannot be cancelled and it cannot be voided; a repeated callback for applied money is a no-op", async () => {
    const { view } = await bill();
    await issue(view.invoice.id, view.invoice.rev);
    const p = (await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "bkash", amountPaisa: 100_000 })).json().payment;
    const ref0 = (await inTenant((tx) => tx.payment.findFirst({ where: { id: p.id } })))!.providerRef!;
    await post(`/v1/dev/fake-payments/${p.id}/failed`, {}, "cashier", null);
    await post(`/v1/payments/${p.id}/retry`);
    fakeProvider()!.simulate(ref0, "confirmed", { deliver: false });
    const trx = (await fakeProvider()!.verify({ providerRef: ref0 }))!.trxId!;
    await post(`/v1/payments/${p.id}/verify-trx`, { trxId: trx });
    await post(`/v1/payments/${p.id}/verify-trx`, { trxId: trx }); // entered twice → still one case
    expect(await inTenant((tx) => tx.task.count({ where: { kind: "payment-reconciliation", focusId: p.id } }))).toBe(1);
    expect((await get(`/v1/invoices/${view.invoice.id}`)).json().reconciling).toBe(true);
    expect((await post(`/v1/payments/${p.id}/cancel`)).json()).toMatchObject({ code: "reconciliation_open" });
    const item = (await get("/v1/reconciliation", "owner")).json().items.find((i: { payment: { id: string } }) => i.payment.id === p.id);
    await post(`/v1/reconciliation/${item.taskId}/apply`, {}, "owner");
    expect((await get(`/v1/invoices/${view.invoice.id}`)).json().reconciling).toBe(false);
    // the gateway's own callback for that old link arrives late: money already applied, not new money
    const cb = fakeProvider()!.simulate(ref0, "confirmed")!;
    expect((await app.inject({ method: "POST", url: "/v1/payments/callback/fake", payload: cb.body, headers: cb.headers })).json()).toEqual({ outcome: "noop", reason: "already-applied" });
    expect(await inTenant((tx) => tx.task.count({ where: { kind: "payment-reconciliation", focusId: p.id } }))).toBe(1);
  });
  it("the database refuses a 'not billed here' without an approved Task for that line, and a replacement that is not an issued bill of the same visit", async () => {
    const { view } = await bill(["sgpt"]);
    const sgpt = lineOf(view, "test:sgpt");
    await expect(inTenant((tx) => tx.chargeItem.update({ where: { id: sgpt.id }, data: { notBilledTaskId: "made-up", notBilledReason: "Sent to the partner lab", notBilledAt: new Date() } }))).rejects.toThrow(/approved bill-elsewhere/);
    const v = await post(`/v1/invoices/${view.invoice.id}/void`, { reason: "Opened on the wrong visit" }, "owner");
    expect(v.statusCode).toBe(200);
    const other = await bill();
    await expect(inTenant((tx) => tx.invoice.update({ where: { id: view.invoice.id }, data: { replacedById: other.view.invoice.id } }))).rejects.toThrow(/voided bill is never changed/);
  });
  it("A voided, its replacement B voided, then C issued: both A and B show 'Replaced by C'; reopening a draft audits which order lines changed", async () => {
    const { enc, view: a } = await bill();
    await post(`/v1/invoices/${a.invoice.id}/void`, { reason: "Opened on the wrong visit" }, "owner");
    const b = (await post(`/v1/encounters/${enc}/invoice`)).json();
    await post(`/v1/invoices/${b.invoice.id}/void`, { reason: "Opened twice by mistake" }, "owner");
    const c = (await post(`/v1/encounters/${enc}/invoice`)).json();
    const rbs = lineOf(c, "test:rbs");
    expect((await post(`/v1/orders/${rbs.sourceId}/revoke`, { reason: "ordered twice by mistake" }, "doctor")).statusCode).toBe(200);
    const reopened = (await post(`/v1/encounters/${enc}/invoice`)).json();
    const audit = await inTenant((tx) => tx.auditEvent.findFirst({ where: { entity: "Invoice", entityId: c.invoice.id, action: "update" }, orderBy: { at: "desc" } }));
    expect(audit?.detail).toMatchObject({ event: "refresh-orders", removed: ["test:rbs"], added: [] });
    const ci = await issue(c.invoice.id, reopened.invoice.rev);
    for (const id of [a.invoice.id, b.invoice.id]) expect((await get(`/v1/invoices/${id}`)).json().invoice.replacedBy).toEqual({ id: c.invoice.id, number: ci.invoice.number });
  });
});
