/* Slice A6–A7 contract tests on the real database (as setu_app), in the seeded E2E Test Clinic, with new synthetic
   patients whose visit the E2E doctor signs with CBC, RBS and S. Electrolytes (the walkthrough's A5 orders):
   - the bill carries the consultation fee + the three orders = ৳2,300 (230,000 paisa), all integer paisa;
   - a discount above the cashier's limit is a requested APPROVAL Task that gates issuing and paying; owner/admin
     approve, never their own request; a rejection needs a note and applies nothing;
   - issuing freezes the bill (the database refuses edits); payments: cash with change, card reference, bKash through the
     fake provider with the issue #10 "Paid by" line, retry, TrxID check, amount mismatch;
   - provider callbacks: a repeat is a no-op, a backwards one is refused, money on a superseded link goes to
     reconciliation; nothing moves out of confirmed;
   - receptionist read-only, doctor denied, another tenant finds nothing. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeProvider } from "../src/adapters/payments/index.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("billing.test: DATABASE_URL_APP not set — billing contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const cookies: Record<string, string> = {};
const T = "t_e2e";
const USERS = { desk: "01799000001", doctor: "01799000002", cashier: "01799000008", owner: "01799000009", admin: "01799000010", otherCashier: "01711000008" } as const;
type Who = keyof typeof USERS;

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of Object.entries(USERS)) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; cookies[k] = Array.isArray(c) ? c[0]! : (c as string);
  }
});
afterAll(async () => { await app.close(); });

const get = (url: string, who: Who = "cashier") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const post = (url: string, payload: object = {}, who: Who = "cashier", key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const inTenant = <R>(fn: (tx: NonNullable<typeof db>["prisma"]) => Promise<R>) => db!.forTenant(T, fn as never) as Promise<R>;

/** A new synthetic patient's visit, signed by the E2E doctor with the walkthrough's three orders (visit finished). */
async function signedVisit(sign = true) {
  const r = await post("/v1/patients", {
    nameBn: "শিলা রানী", nameEn: `Bill Patient ${RUN}`, sex: "female", dobMode: "dob", dob: "03/03/1991", phone: `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self",
    division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
  }, "desk");
  expect(r.statusCode, r.body).toBe(201);
  const enc = r.json().encounter.id as string;
  const v = (await post(`/v1/encounters/${enc}/consultation/open`, {}, "doctor")).json();
  const saved = await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: cookies.doctor!, "idempotency-key": randomUUID() }, payload: {
    rev: 1, sections: { complaints: [{ text: "Tiredness", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }],
    orders: [{ testCode: "cbc", priority: "routine" }, { testCode: "rbs", priority: "routine" }, { testCode: "elec", priority: "routine" }],
  } });
  expect(saved.statusCode, saved.body).toBe(200);
  if (sign) {
    const s = await post(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.json().rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor");
    expect(s.statusCode, s.body).toBe(200);
  }
  return { enc, patient: r.json().patient.id as string };
}
async function newBill(who: Who = "cashier") {
  const { enc, patient } = await signedVisit();
  const r = await post(`/v1/encounters/${enc}/invoice`, {}, who);
  expect(r.statusCode, r.body).toBe(201);
  return { enc, patient, view: r.json() };
}
const issue = async (id: string, rev: number) => { const r = await post(`/v1/invoices/${id}/issue`, { rev }); expect(r.statusCode, r.body).toBe(200); return r.json(); };
const fake = (paymentId: string, kind: "opened" | "confirmed" | "failed", body: object = {}) => post(`/v1/dev/fake-payments/${paymentId}/${kind}`, body, "cashier", null);
const callback = (cb: { body: string; headers: Record<string, string> }) => app.inject({ method: "POST", url: "/v1/payments/callback/fake", payload: cb.body, headers: cb.headers });
const refOf = async (paymentId: string) => (await inTenant((tx) => tx.payment.findFirst({ where: { id: paymentId } })))!;

describe.runIf(db)("A6 the bill from the finished visit", () => {
  it("consultation ৳800 + CBC ৳450 + RBS ৳150 + S. Electrolytes ৳900 = 230,000 paisa, VAT 0, every line priced", async () => {
    const { enc, view } = await newBill();
    expect(view.lines.map((l: { source: string; code: string; unitPaisa: number }) => [l.source, l.code, l.unitPaisa])).toEqual([
      ["consultation", "consult:u_e2e_doctor", 80_000], ["order", "test:cbc", 45_000], ["order", "test:rbs", 15_000], ["order", "test:elec", 90_000],
    ]);
    expect(view.invoice).toMatchObject({ status: "draft", number: null, subtotalPaisa: 230_000, discountPaisa: 0, vatPaisa: 0, totalPaisa: 230_000, paidPaisa: 0 });
    expect(view.issueBlockers).toEqual([]);
    expect(view.discountLimitPaisa).toBe(11_500);
    expect(view.encounter.id).toBe(enc);
    for (const l of view.lines) expect(Number.isInteger(l.totalPaisa)).toBe(true);
  });
  it("asking again returns the same bill (200); a replay with the same key returns the stored answer", async () => {
    const { enc } = await signedVisit();
    const key = randomUUID();
    const a = await post(`/v1/encounters/${enc}/invoice`, {}, "cashier", key);
    const b = await post(`/v1/encounters/${enc}/invoice`, {}, "cashier", key);
    const c = await post(`/v1/encounters/${enc}/invoice`);
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([201, 201, 200]);
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect(c.json().invoice.id).toBe(a.json().invoice.id);
    expect(await inTenant((tx) => tx.invoice.count({ where: { encounterId: enc } }))).toBe(1);
  });
  it("no bill before the doctor signs", async () => {
    const { enc } = await signedVisit(false);
    expect((await post(`/v1/encounters/${enc}/invoice`)).json()).toMatchObject({ code: "visit_not_finished" });
  });
  it("receptionist sees the bill but cannot make or change it; the doctor has no billing access", async () => {
    const { enc, view } = await newBill();
    expect((await get(`/v1/invoices/${view.invoice.id}`, "desk")).statusCode).toBe(200);
    expect((await post(`/v1/invoices/${view.invoice.id}/lines`, { code: "desk:card", rev: 1 }, "desk")).statusCode).toBe(403);
    expect((await post(`/v1/invoices/${view.invoice.id}/issue`, { rev: 1 }, "desk")).statusCode).toBe(403);
    expect((await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "cash", amountPaisa: 100, tenderedPaisa: 100 }, "desk")).statusCode).toBe(403);
    expect((await get(`/v1/invoices/${view.invoice.id}`, "doctor")).statusCode).toBe(403);
    expect((await post(`/v1/encounters/${enc}/invoice`, {}, "doctor")).statusCode).toBe(403);
  });
  it("another tenant's cashier finds nothing (RLS)", async () => {
    const { enc, view } = await newBill();
    expect((await get(`/v1/invoices/${view.invoice.id}`, "otherCashier")).statusCode).toBe(404);
    expect((await post(`/v1/encounters/${enc}/invoice`, {}, "otherCashier")).statusCode).toBe(404);
    expect((await post(`/v1/invoices/${view.invoice.id}/issue`, { rev: 1 }, "otherCashier")).statusCode).toBe(404);
    expect((await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "cash", amountPaisa: 100, tenderedPaisa: 100 }, "otherCashier")).statusCode).toBe(404);
    expect(await db!.forTenant("t_greenlife", (tx) => tx.invoice.count({ where: { id: view.invoice.id } }))).toBe(0);
  });
  it("desk lines: Health Passport card at 15% VAT; re-adding counts up; the doctor's orders cannot be removed", async () => {
    const { view } = await newBill();
    const id = view.invoice.id;
    let r = await post(`/v1/invoices/${id}/lines`, { code: "desk:card", rev: view.invoice.rev });
    expect(r.statusCode, r.body).toBe(200);
    r = await post(`/v1/invoices/${id}/lines`, { code: "desk:card", rev: r.json().invoice.rev });
    const card = r.json().lines.find((l: { code: string }) => l.code === "desk:card");
    expect(card).toMatchObject({ qty: 2, grossPaisa: 20_000, vatPaisa: 3_000, totalPaisa: 23_000, editable: true });
    expect(r.json().invoice).toMatchObject({ subtotalPaisa: 250_000, vatPaisa: 3_000, totalPaisa: 253_000 });
    const order = r.json().lines.find((l: { source: string }) => l.source === "order");
    expect((await post(`/v1/invoices/${id}/lines/${order.id}/remove`, { rev: r.json().invoice.rev })).json()).toMatchObject({ code: "line_locked" });
    expect((await post(`/v1/invoices/${id}/lines/${card.id}/remove`, { rev: 1 })).json()).toMatchObject({ code: "stale" });
    r = await post(`/v1/invoices/${id}/lines/${card.id}/remove`, { rev: r.json().invoice.rev });
    expect(r.json().invoice.totalPaisa).toBe(230_000);
  });
});

describe.runIf(db)("A6 discounts: an APPROVAL Task above the limit, nothing applied before approval", () => {
  it("within the cashier's limit (৳100 ≤ ৳115) applies now; line discounts sum exactly; it can be removed", async () => {
    const { view } = await newBill();
    const r = await post(`/v1/invoices/${view.invoice.id}/discount`, { mode: "amount", amountPaisa: 10_000, category: "poor", reason: "Day labourer, doctor asked", rev: view.invoice.rev });
    expect(r.json().outcome).toBe("applied");
    const v = r.json().view;
    expect(v.invoice).toMatchObject({ discountPaisa: 10_000, totalPaisa: 220_000 });
    expect(v.lines.reduce((a: number, l: { discountPaisa: number }) => a + l.discountPaisa, 0)).toBe(10_000);
    expect(v.invoice.discount).toMatchObject({ category: "poor", appliedBy: { id: "u_e2e_cashier" }, approvedBy: null });
    expect((await post(`/v1/invoices/${view.invoice.id}/lines`, { code: "desk:card", rev: v.invoice.rev })).json()).toMatchObject({ code: "discount_present" });
    const back = await post(`/v1/invoices/${view.invoice.id}/discount/remove`, { rev: v.invoice.rev });
    expect(back.json().invoice).toMatchObject({ discountPaisa: 0, totalPaisa: 230_000, discount: null });
  });
  it("৳500 above the limit: a requested Task, totals unchanged, issue and payment refused, lines locked; owner approves → ৳1,800", async () => {
    const { view } = await newBill();
    const id = view.invoice.id;
    const r = await post(`/v1/invoices/${id}/discount`, { mode: "amount", amountPaisa: 50_000, category: "doctor", reason: "Doctor's request for this patient", rev: view.invoice.rev });
    expect(r.json().outcome).toBe("approval-requested");
    const v = r.json().view;
    expect(v.invoice).toMatchObject({ discountPaisa: 0, totalPaisa: 230_000, discount: null });
    expect(v.approval).toMatchObject({ status: "requested", amountPaisa: 50_000, limitPaisa: 11_500, requestedBy: { id: "u_e2e_cashier" } });
    expect(v.issueBlockers).toEqual(["approval_pending"]);
    const issueR = await post(`/v1/invoices/${id}/issue`, { rev: v.invoice.rev });
    expect(issueR.statusCode).toBe(422);
    expect(issueR.json().blockers).toEqual([{ code: "approval_pending" }]);
    expect((await post(`/v1/invoices/${id}/payments`, { method: "cash", amountPaisa: 230_000, tenderedPaisa: 230_000 })).json()).toMatchObject({ code: "not_payable" });
    expect((await post(`/v1/invoices/${id}/lines`, { code: "desk:card", rev: v.invoice.rev })).json()).toMatchObject({ code: "approval_pending" });
    // The database refuses to issue while the Task is requested, whatever the API does.
    await expect(inTenant((tx) => tx.invoice.update({ where: { id }, data: { status: "issued", number: `X-${RUN}`, issuedAt: new Date(), issuedById: "u_e2e_cashier" } }))).rejects.toThrow(/an approval is still requested on this bill/);

    const list = (await get("/v1/approvals", "owner")).json();
    const item = list.items.find((i: { invoice: { id: string } }) => i.invoice.id === id);
    expect(item).toMatchObject({ amountPaisa: 50_000, category: "doctor", patient: { nameEn: `Bill Patient ${RUN}` } });
    expect(item.requesterToday.count).toBeGreaterThanOrEqual(1);
    expect((await get("/v1/approvals", "cashier")).statusCode).toBe(403);
    expect((await post(`/v1/approvals/${v.approval.taskId}/approve`, {}, "cashier")).statusCode).toBe(403);

    const ok = await post(`/v1/approvals/${v.approval.taskId}/approve`, { note: "OK" }, "owner");
    expect(ok.statusCode, ok.body).toBe(200);
    const after = ok.json().view;
    expect(after.invoice).toMatchObject({ discountPaisa: 50_000, totalPaisa: 180_000, discount: { appliedBy: { id: "u_e2e_cashier" }, approvedBy: { id: "u_e2e_owner" } } });
    expect(after.lines.map((l: { discountPaisa: number }) => l.discountPaisa)).toEqual([17_391, 9_783, 3_261, 19_565]);
    expect(after.issueBlockers).toEqual([]);
    expect((await post(`/v1/approvals/${v.approval.taskId}/approve`, {}, "admin")).json()).toMatchObject({ code: "invalid_transition" });
    expect((await issue(id, after.invoice.rev)).invoice.totalPaisa).toBe(180_000);
  });
  it("no one approves their own request; a rejection needs a note and applies nothing", async () => {
    const { view } = await newBill("owner");
    const id = view.invoice.id;
    const r = await post(`/v1/invoices/${id}/discount`, { mode: "percent", percentBp: 1000, category: "staff", reason: "Relative of a staff member", rev: view.invoice.rev }, "owner");
    expect(r.json().view.approval.amountPaisa).toBe(23_000);
    const task = r.json().view.approval.taskId;
    expect((await post(`/v1/approvals/${task}/approve`, {}, "owner")).json()).toMatchObject({ code: "own_request" });
    expect((await post(`/v1/approvals/${task}/reject`, { note: "no" }, "admin")).statusCode).toBe(400);
    const no = await post(`/v1/approvals/${task}/reject`, { note: "Not covered by the staff policy" }, "admin");
    expect(no.json().approval).toMatchObject({ status: "rejected", decidedBy: { id: "u_e2e_admin" }, decisionNote: "Not covered by the staff policy" });
    expect(no.json().view.invoice).toMatchObject({ discountPaisa: 0, totalPaisa: 230_000 });
    expect(no.json().view.issueBlockers).toEqual([]);
  });
  it("a discount larger than the bill is refused, never capped; a short reason is refused", async () => {
    const { view } = await newBill();
    expect((await post(`/v1/invoices/${view.invoice.id}/discount`, { mode: "amount", amountPaisa: 300_000, category: "poor", reason: "Day labourer, doctor asked", rev: view.invoice.rev })).json()).toMatchObject({ code: "discount_above_subtotal" });
    expect((await post(`/v1/invoices/${view.invoice.id}/discount`, { mode: "amount", amountPaisa: 100, category: "poor", reason: "poor", rev: view.invoice.rev })).statusCode).toBe(400);
  });
});

describe.runIf(db)("A6 issuing freezes the bill", () => {
  it("INV/yy/nnnn per facility per year; lines and totals can no longer change — not even directly in the database", async () => {
    const { view } = await newBill();
    const v = await issue(view.invoice.id, view.invoice.rev);
    expect(v.invoice.status).toBe("issued");
    expect(v.invoice.number).toMatch(/^INV\/\d{2}\/\d{4,}$/);
    expect((await post(`/v1/invoices/${view.invoice.id}/lines`, { code: "desk:card", rev: v.invoice.rev })).json()).toMatchObject({ code: "not_draft" });
    await expect(inTenant((tx) => tx.chargeItem.updateMany({ where: { invoiceId: view.invoice.id }, data: { qty: 2, grossPaisa: 0 } }))).rejects.toThrow(/lines change only in a draft/);
    await expect(inTenant((tx) => tx.invoice.update({ where: { id: view.invoice.id }, data: { discountReason: "edited later" } }))).rejects.toThrow();
    await expect(inTenant((tx) => tx.invoice.delete({ where: { id: view.invoice.id } }))).rejects.toThrow();
  });
});

describe.runIf(db)("A7 payments", () => {
  it("walkthrough A7 / issue #10: bKash ৳2,000 pending + cash ৳300 → partially paid, 'Paid by' = cash only; bKash confirms → balanced", async () => {
    const { view } = await newBill();
    const id = view.invoice.id;
    await issue(id, view.invoice.rev);
    const bk = await post(`/v1/invoices/${id}/payments`, { method: "bkash", amountPaisa: 200_000 });
    expect(bk.statusCode, bk.body).toBe(201);
    expect(bk.json().payment).toMatchObject({ method: "bkash", status: "link-sent", amountPaisa: 200_000, trxId: null });
    expect(bk.json().payment.phoneLast4).toMatch(/^\d{4}$/);
    expect(bk.json().view.summary).toEqual({ totalPaisa: 230_000, confirmedPaisa: 0, pendingPaisa: 200_000, duePaisa: 230_000, openPaisa: 30_000 });
    expect((await post(`/v1/invoices/${id}/payments`, { method: "cash", amountPaisa: 30_001, tenderedPaisa: 200_000 })).json()).toMatchObject({ code: "amount_over_open" });
    const cash = await post(`/v1/invoices/${id}/payments`, { method: "cash", amountPaisa: 30_000, tenderedPaisa: 200_000 });
    expect(cash.json().payment).toMatchObject({ status: "confirmed", changePaisa: 170_000 });
    expect(cash.json().view.invoice).toMatchObject({ status: "partially-paid", paidPaisa: 30_000 });
    expect(cash.json().view.paidBy).toEqual({ paid: [{ method: "cash", amountPaisa: 30_000 }], pending: [{ method: "bkash", amountPaisa: 200_000 }] });

    const ok = await fake(bk.json().payment.id, "confirmed");
    expect(ok.json()).toMatchObject({ delivered: true, outcome: "applied" });
    const after = (await get(`/v1/invoices/${id}`)).json();
    expect(after.invoice).toMatchObject({ status: "balanced", paidPaisa: 230_000 });
    expect(after.paidBy.paid).toEqual([{ method: "bkash", amountPaisa: 200_000, trxId: ok.json().trxId }, { method: "cash", amountPaisa: 30_000 }]);
    expect(after.paidBy.pending).toEqual([]);
    expect((await post(`/v1/invoices/${id}/payments`, { method: "cash", amountPaisa: 100, tenderedPaisa: 100 })).json()).toMatchObject({ code: "not_payable" });
  });
  it("callbacks: a repeat changes nothing, a later 'failed' or 'opened' is refused, a confirmed payment is frozen in the database", async () => {
    const { view } = await newBill();
    await issue(view.invoice.id, view.invoice.rev);
    const p = (await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "nagad", amountPaisa: 230_000 })).json().payment;
    const ref = (await refOf(p.id)).providerRef!;
    const cb = fakeProvider()!.simulate(ref, "confirmed")!;
    expect((await callback(cb)).json()).toEqual({ outcome: "applied" });
    expect((await callback(cb)).json()).toEqual({ outcome: "noop", reason: "repeat" });
    expect((await callback(fakeProvider()!.simulate(ref, "confirmed")!)).json()).toMatchObject({ outcome: "noop" });
    expect((await fake(p.id, "failed")).json()).toMatchObject({ outcome: "refused", reason: "backwards" });
    const row = await refOf(p.id);
    expect(row.status).toBe("confirmed");
    expect(await inTenant((tx) => tx.providerEvent.count({ where: { paymentId: p.id } }))).toBe(3);
    await expect(inTenant((tx) => tx.payment.update({ where: { id: p.id }, data: { status: "failed" } }))).rejects.toThrow(/confirmed payment is never changed/);
    await expect(inTenant((tx) => tx.payment.delete({ where: { id: p.id } }))).rejects.toThrow();
    expect((await get(`/v1/invoices/${view.invoice.id}`)).json().invoice).toMatchObject({ status: "balanced", paidPaisa: 230_000 });
    // two real callbacks (no session: the provider is the actor) + the dev route's event, audited as the cashier
    expect(await inTenant((tx) => tx.auditEvent.count({ where: { entity: "Payment", entityId: p.id, userId: null } }))).toBe(2);
    expect(await inTenant((tx) => tx.auditEvent.count({ where: { entity: "Payment", entityId: p.id, userId: "u_e2e_cashier", action: "provider-event" } }))).toBe(1);
  });
  it("a forged or unknown callback is refused", async () => {
    const { view } = await newBill();
    await issue(view.invoice.id, view.invoice.rev);
    const p = (await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "bkash", amountPaisa: 230_000 })).json().payment;
    const cb = fakeProvider()!.simulate((await refOf(p.id)).providerRef!, "confirmed", { deliver: true })!;
    expect((await callback({ body: cb.body, headers: { ...cb.headers, "x-fake-signature": "0".repeat(64) } })).statusCode).toBe(401);
    expect((await callback({ body: cb.body.replace("230000", "1"), headers: cb.headers })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/payments/callback/bkash", payload: cb.body, headers: cb.headers })).statusCode).toBe(404);
    const other = await fakeProvider()!.createLink({ method: "bkash", amountPaisa: 1, reference: "x", invoiceNumber: "x", phone: "1711234567" });
    expect((await callback(fakeProvider()!.simulate(other.providerRef, "confirmed")!)).statusCode).toBe(404);
    expect((await refOf(p.id)).status).toBe("link_sent");
  });
  it("failed → retry sends a new link; money later reported on the old link is refused and opens a reconciliation Task", async () => {
    const { view } = await newBill();
    await issue(view.invoice.id, view.invoice.rev);
    const p = (await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "bkash", amountPaisa: 200_000 })).json().payment;
    const oldRef = (await refOf(p.id)).providerRef!;
    expect((await fake(p.id, "opened")).json()).toMatchObject({ outcome: "applied" });
    expect((await refOf(p.id)).status).toBe("waiting_customer");
    expect((await fake(p.id, "failed")).json()).toMatchObject({ outcome: "applied" });
    let v = (await get(`/v1/invoices/${view.invoice.id}`)).json();
    expect(v.summary).toMatchObject({ pendingPaisa: 0, openPaisa: 230_000 });
    expect(v.paidBy).toEqual({ paid: [], pending: [] });
    const retry = await post(`/v1/payments/${p.id}/retry`);
    expect(retry.json().payment).toMatchObject({ status: "link-sent", attempt: 2 });
    const row = await refOf(p.id);
    expect(row.providerRef).not.toBe(oldRef);
    expect(row.supersededRefs).toEqual([oldRef]);
    expect((await callback(fakeProvider()!.simulate(oldRef, "confirmed")!)).json()).toEqual({ outcome: "refused", reason: "late-confirm" });
    expect(await inTenant((tx) => tx.task.count({ where: { kind: "payment-reconciliation", focusId: p.id, status: "requested" } }))).toBe(1);
    expect((await fake(p.id, "confirmed")).json()).toMatchObject({ outcome: "applied" });
    v = (await get(`/v1/invoices/${view.invoice.id}`)).json();
    expect(v.invoice).toMatchObject({ status: "partially-paid", paidPaisa: 200_000 });
  });
  it("a lost callback: the cashier's TrxID check confirms only the matching, full payment", async () => {
    const { view } = await newBill();
    await issue(view.invoice.id, view.invoice.rev);
    const p = (await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "bkash", amountPaisa: 230_000 })).json().payment;
    const lost = await fake(p.id, "confirmed", { deliver: false });
    expect(lost.json()).toMatchObject({ delivered: false });
    expect((await refOf(p.id)).status).toBe("link_sent");
    const trx = (await fakeProvider()!.verify({ providerRef: (await refOf(p.id)).providerRef! }))!.trxId!;
    expect((await post(`/v1/payments/${p.id}/verify-trx`, { trxId: "ZZZZZZZZZZ" })).json()).toMatchObject({ code: "trx_not_matched" });
    const ok = await post(`/v1/payments/${p.id}/verify-trx`, { trxId: trx.toLowerCase() });
    expect(ok.json().payment).toMatchObject({ status: "confirmed", trxId: trx });
    expect(ok.json().view.invoice.status).toBe("balanced");
  });
  it("an amount that differs from the payment is never confirmed; it goes to reconciliation", async () => {
    const { view } = await newBill();
    await issue(view.invoice.id, view.invoice.rev);
    const p = (await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "bkash", amountPaisa: 230_000 })).json().payment;
    expect((await fake(p.id, "confirmed", { amountPaisa: 23_000 })).json()).toMatchObject({ outcome: "refused", reason: "amount-mismatch" });
    expect((await refOf(p.id)).status).toBe("link_sent");
    expect(await inTenant((tx) => tx.task.count({ where: { kind: "payment-reconciliation", focusId: p.id } }))).toBe(1);
  });
  it("card needs a reference; cash needs enough tendered; a replayed payment is stored once; two counters cannot both take the last taka", async () => {
    const { view } = await newBill();
    const id = view.invoice.id;
    expect((await post(`/v1/invoices/${id}/payments`, { method: "cash", amountPaisa: 100, tenderedPaisa: 100 })).json()).toMatchObject({ code: "not_payable" });
    await issue(id, view.invoice.rev);
    expect((await post(`/v1/invoices/${id}/payments`, { method: "card", amountPaisa: 100_000 })).json()).toMatchObject({ code: "reference_required" });
    expect((await post(`/v1/invoices/${id}/payments`, { method: "cash", amountPaisa: 100_000, tenderedPaisa: 99_999 })).json()).toMatchObject({ code: "tendered_short" });
    const key = randomUUID();
    const a = await post(`/v1/invoices/${id}/payments`, { method: "card", amountPaisa: 100_000, reference: "AP1234" }, "cashier", key);
    const b = await post(`/v1/invoices/${id}/payments`, { method: "card", amountPaisa: 100_000, reference: "AP1234" }, "cashier", key);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect(await inTenant((tx) => tx.payment.count({ where: { invoiceId: id } }))).toBe(1);
    const [x, y] = await Promise.all([
      post(`/v1/invoices/${id}/payments`, { method: "cash", amountPaisa: 130_000, tenderedPaisa: 130_000 }),
      post(`/v1/invoices/${id}/payments`, { method: "cash", amountPaisa: 130_000, tenderedPaisa: 130_000 }, "owner"),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([201, 409]);
    expect((await get(`/v1/invoices/${id}`)).json().invoice).toMatchObject({ status: "balanced", paidPaisa: 230_000 });
  });
});

describe.runIf(db)("A6–A7 review fixes", () => {
  it("a test cannot be added at the desk (only through the doctor's order): no second CBC", async () => {
    const { view } = await newBill();
    expect((await post(`/v1/invoices/${view.invoice.id}/lines`, { code: "test:cbc", rev: view.invoice.rev })).json()).toMatchObject({ code: "no_such_item" });
    const items = (await get("/v1/charge-definitions?q=")).json().items as { kind: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.kind === "service")).toBe(true);
  });
  it("Cancel link: an unpaid link fails and frees the amount; a link the patient already paid is confirmed instead", async () => {
    const { view } = await newBill();
    await issue(view.invoice.id, view.invoice.rev);
    const a = (await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "bkash", amountPaisa: 100_000 })).json().payment;
    const c = await post(`/v1/payments/${a.id}/cancel`);
    expect(c.json().payment).toMatchObject({ status: "failed", failReason: "cancelled-by-cashier" });
    expect(c.json().view.summary).toMatchObject({ pendingPaisa: 0, openPaisa: 230_000 });
    const b = (await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "bkash", amountPaisa: 100_000 })).json().payment;
    await fake(b.id, "confirmed", { deliver: false });
    const c2 = await post(`/v1/payments/${b.id}/cancel`);
    expect(c2.json()).toMatchObject({ notice: "paid-meanwhile", payment: { status: "confirmed" } });
    expect((await post(`/v1/payments/${b.id}/cancel`)).json()).toMatchObject({ code: "not_pending" });
  });
  it("a TrxID paid on a replaced link is never applied and never 'does not match': it is reconciled", async () => {
    const { view } = await newBill();
    await issue(view.invoice.id, view.invoice.rev);
    const p = (await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "bkash", amountPaisa: 100_000 })).json().payment;
    const oldRef = (await refOf(p.id)).providerRef!;
    await fake(p.id, "failed");
    await post(`/v1/payments/${p.id}/retry`);
    fakeProvider()!.simulate(oldRef, "confirmed", { deliver: false });
    const trx = (await fakeProvider()!.verify({ providerRef: oldRef }))!.trxId!;
    const r = await post(`/v1/payments/${p.id}/verify-trx`, { trxId: trx });
    expect(r.json()).toMatchObject({ notice: "paid-on-earlier-link", payment: { status: "link-sent" } });
    expect(await inTenant((tx) => tx.task.count({ where: { kind: "payment-reconciliation", focusId: p.id } }))).toBe(1);
  });
  it("a second 'confirmed' with another TrxID on a confirmed payment is reconciled, not ignored", async () => {
    const { view } = await newBill();
    await issue(view.invoice.id, view.invoice.rev);
    const p = (await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "bkash", amountPaisa: 230_000 })).json().payment;
    const ref = (await refOf(p.id)).providerRef!;
    await callback(fakeProvider()!.simulate(ref, "confirmed")!);
    const forged = JSON.stringify({ eventId: `EV-${RUN}-2`, providerRef: ref, kind: "confirmed", trxId: "ZZZZZZZZZZ", amountPaisa: 230_000 });
    const r = await callback({ body: forged, headers: { "content-type": "application/json", "x-fake-signature": fakeProvider()!.sign(forged) } });
    expect(r.json()).toEqual({ outcome: "refused", reason: "second-payment" });
    expect(await inTenant((tx) => tx.task.count({ where: { kind: "payment-reconciliation", focusId: p.id } }))).toBe(1);
  });
  it("the fake gateway route is off unless FAKE_PAYMENTS_DEV_ROUTE=1 (never in production)", async () => {
    const { config: c } = await import("../src/config.js");
    expect(c.fakePaymentsDevRoute).toBe(true); // vitest.config sets the flag
    expect(process.env.NODE_ENV).not.toBe("production");
  });
  it("the dev route acts only on this branch's payments and audits the user who pressed it", async () => {
    const { view } = await newBill();
    await issue(view.invoice.id, view.invoice.rev);
    const p = (await post(`/v1/invoices/${view.invoice.id}/payments`, { method: "bkash", amountPaisa: 230_000 })).json().payment;
    expect((await post(`/v1/dev/fake-payments/${p.id}/confirmed`, {}, "otherCashier", null)).statusCode).toBe(404);
    await fake(p.id, "confirmed");
    const a = await inTenant((tx) => tx.auditEvent.findFirst({ where: { entity: "Payment", entityId: p.id, action: "update" }, orderBy: { at: "desc" } }));
    expect(a).toMatchObject({ userId: "u_e2e_cashier" });
    expect((a!.detail as { fakeGateway?: boolean }).fakeGateway).toBe(true);
  });
});
