/* ADR 0011 — bKash tokenized checkout against the local sandbox stand-in, on the real database (E2E Test Clinic):
   the payment row first, a short link and QR, the patient's return → one execute → confirmed with the TrxID; a forged
   or repeated return, a replaced, cancelled or expired link never executed; a timed-out execute settled by query; a
   gateway that refuses the link frees the amount; the sweep; the shared token (one grant, reused after a restart). */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BkashSandboxStandIn, STANDIN_CREDENTIALS } from "../src/adapters/payments/bkash-standin.js";

const standIn = new BkashSandboxStandIn();
const apiUrl = await standIn.start();
Object.assign(process.env, {
  PAYMENTS_PROVIDER: "bkash", BKASH_BASE_URL: apiUrl, BKASH_APP_KEY: STANDIN_CREDENTIALS.appKey, BKASH_APP_SECRET: STANDIN_CREDENTIALS.appSecret,
  BKASH_USERNAME: STANDIN_CREDENTIALS.username, BKASH_PASSWORD: STANDIN_CREDENTIALS.password, BKASH_TIMEOUT_MS: "1500", PUBLIC_APP_URL: "https://setu.test",
  REFUND_RELEASE_MINUTES: "0", // decision 235's 30 minutes, cut for the test
});
const { buildApp } = await import("../src/app.js");
const { config } = await import("../src/config.js");
const { BkashProvider } = await import("../src/adapters/payments/index.js");
const { sweepPayments } = await import("../src/modules/billing.js");
const { closePdfBrowser } = await import("../src/receipts/pdf.js");

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("bkash.test: DATABASE_URL_APP not set — SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const cookies: Record<string, string> = {};
const USERS = { desk: "01799000001", doctor: "01799000002", cashier: "01799000008", owner: "01799000009" } as const;
type Who = keyof typeof USERS;

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  // a fresh stand-in knows no earlier token and no earlier renewals: start this run's shared token record empty
  await db.prisma.$executeRaw`SELECT gateway_token_put('bkash', NULL, NULL, NULL, NULL, '{}'::timestamptz[])`;
  for (const [k, phone] of Object.entries(USERS)) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; cookies[k] = Array.isArray(c) ? c[0]! : (c as string);
  }
}, 60_000);
afterAll(async () => { await closePdfBrowser(); await app.close(); await standIn.stop(); });

const get = (url: string, who: Who | null = "cashier") => app.inject({ method: "GET", url, headers: who ? { cookie: cookies[who]! } : {} });
const post = (url: string, payload: object = {}, who: Who = "cashier", key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const inTenant = <R>(fn: (tx: NonNullable<typeof db>["prisma"]) => Promise<R>) => db!.forTenant("t_e2e", fn as never) as Promise<R>;

/** An issued bill for a new patient (consultation only) and its total. */
async function issuedBill() {
  const r = await post("/v1/patients", {
    nameBn: "বিকাশ রোগী", nameEn: `Bkash ${RUN}`, sex: "male", dobMode: "dob", dob: "05/05/1985", phone: `017${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self",
    division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
  }, "desk");
  expect(r.statusCode, r.body).toBe(201);
  const enc = r.json().encounter.id as string;
  const v = (await post(`/v1/encounters/${enc}/consultation/open`, {}, "doctor")).json();
  const saved = await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: cookies.doctor!, "idempotency-key": randomUUID() }, payload: {
    rev: 1, sections: { complaints: [{ text: "Cough", duration: { n: 3, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [], orders: [],
  } });
  expect(saved.statusCode, saved.body).toBe(200);
  expect((await post(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.json().rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor")).statusCode).toBe(200);
  const b = (await post(`/v1/encounters/${enc}/invoice`)).json();
  const issued = await post(`/v1/invoices/${b.invoice.id}/issue`, { rev: b.invoice.rev });
  expect(issued.statusCode, issued.body).toBe(200);
  return { id: b.invoice.id as string, total: issued.json().invoice.totalPaisa as number };
}
async function bkashPayment(amount?: number) {
  const b = await issuedBill();
  const r = await post(`/v1/invoices/${b.id}/payments`, { method: "bkash", amountPaisa: amount ?? b.total });
  expect(r.statusCode, r.body).toBe(201);
  return { bill: b, payment: r.json().payment, view: r.json().view };
}
const row = (id: string) => inTenant((tx) => tx.payment.findFirst({ where: { id } }));
/** follow the patient's return; answers the /pay/result parameters */
async function returnWith(paymentId: string, status: "success" | "failure" | "cancel", signature?: string) {
  const p = (await row(paymentId))!;
  const q = new URLSearchParams({ paymentID: p.providerRef!, status, signature: signature ?? p.providerSignature! });
  const r = await get(`/v1/payments/return/bkash?${q}`, null);
  expect(r.statusCode, r.body).toBe(303);
  const to = new URL(r.headers.location as string);
  expect(to.origin + to.pathname).toBe("https://setu.test/pay/result");
  return Object.fromEntries(to.searchParams);
}
const creds = { appKey: STANDIN_CREDENTIALS.appKey, appSecret: STANDIN_CREDENTIALS.appSecret, username: STANDIN_CREDENTIALS.username, password: STANDIN_CREDENTIALS.password };
/** another API process: its own provider, the same stored token */
const outside = () => new BkashProvider({ baseUrl: apiUrl, ...creds, callbackUrl: "https://setu.test/x" }, async (renew) => db!.withGatewayToken("bkash", renew));
const executes = (ref: string) => standIn.calls.filter((c) => c.path === "payment/execute" && c.body.paymentId === ref).length;

describe.runIf(db)("ADR 0011 bKash tokenized checkout", () => {
  it("the payment is committed first, then the link: a short link and its QR; the short link opens bKash's page", async () => {
    const { payment } = await bkashPayment();
    expect(payment).toMatchObject({ method: "bkash", status: "link-sent", gateway: "execute", executing: false });
    expect(payment.payUrl).toMatch(/^https:\/\/setu\.test\/p\/[A-Z2-9]{10}$/);
    const p = (await row(payment.id))!;
    expect(p.providerRef).toMatch(/^TR0011/);
    const create = standIn.calls.filter((c) => c.path === "payment/create").at(-1)!.body;
    expect(create).toMatchObject({ currency: "BDT", intent: "sale", amount: `${p.amountPaisa / 100}.00`, payerReference: p.phone ? `0${p.phone}` : expect.any(String) });
    expect(String(create.callbackURL)).toBe("https://setu.test/api/v1/payments/return/bkash");
    const code = payment.payUrl.split("/p/")[1];
    const go = await get(`/v1/pay/${code}`, null);
    expect(go.statusCode).toBe(302);
    expect(go.headers.location).toBe(p.linkUrl);
    const qr = await get(`/v1/payments/${payment.id}/qr.svg`);
    expect(qr.statusCode).toBe(200);
    expect(qr.headers["content-type"]).toContain("image/svg+xml");
    // external review B8: reading the QR is a read of the patient's payment — audited
    const qa = await inTenant((tx) => tx.auditEvent.findFirst({ where: { entity: "Payment", entityId: payment.id, action: "view" }, orderBy: { at: "desc" } }));
    expect(qa).toMatchObject({ patientId: p.patientId, detail: expect.objectContaining({ purpose: "payment-qr" }) });
    expect((await get(`/v1/pay/ABCDEFGH23`, null)).headers.location).toContain("o=unknown");
  });

  it("review C: a replayed payment request answers with the link that was made (payUrl), not the answer before it; one link", async () => {
    const b = await issuedBill();
    const key = randomUUID();
    const first = await post(`/v1/invoices/${b.id}/payments`, { method: "bkash", amountPaisa: b.total }, "cashier", key);
    expect(first.statusCode, first.body).toBe(201);
    const creates = standIn.calls.filter((c) => c.path === "payment/create").length;
    const again = await post(`/v1/invoices/${b.id}/payments`, { method: "bkash", amountPaisa: b.total }, "cashier", key);
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(again.json().payment.payUrl).toMatch(/^https:\/\/setu\.test\/p\/[A-Z2-9]{10}$/);
    expect(again.json().payment.payUrl).toBe(first.json().payment.payUrl);
    expect(standIn.calls.filter((c) => c.path === "payment/create").length).toBe(creates); // the replay made no new link
  });
  it("the patient pays: one execute, confirmed with the TrxID, the bill balanced; a repeated return executes nothing", async () => {
    const { payment, bill } = await bkashPayment();
    const p = (await row(payment.id))!;
    standIn.authorise(p.providerRef!);
    const r = await returnWith(payment.id, "success");
    expect(r.o).toBe("paid");
    expect(Object.keys(r).sort()).toEqual(["c", "o"]); // nothing else rides in the URL
    const shown = (await get(`/v1/pay/${r.c}/result`, null)).json();
    expect(shown).toMatchObject({ outcome: "paid", amountPaisa: bill.total, facilityEn: expect.any(String) });
    expect(shown.trxId).toMatch(/^TRX/);
    r.trx = shown.trxId;
    const after = (await row(payment.id))!;
    expect(after).toMatchObject({ status: "confirmed", trxId: r.trx, confirmedById: null });
    expect((await inTenant((tx) => tx.invoice.findFirst({ where: { id: bill.id } })))!.status).toBe("balanced");
    expect((await returnWith(payment.id, "success")).o).toBe("paid");
    expect(executes(p.providerRef!)).toBe(1);
    // the short link now says paid; the TrxID check agrees
    const code = (await row(payment.id))!.linkCode!;
    expect((await get(`/v1/pay/${code}`, null)).headers.location).toContain("o=paid");
    expect((await post(`/v1/payments/${payment.id}/verify-trx`, { trxId: r.trx })).json().payment.status).toBe("confirmed");
  });

  it("a forged return (wrong signature) is never executed; the payment keeps waiting", async () => {
    const { payment } = await bkashPayment();
    const p = (await row(payment.id))!;
    standIn.authorise(p.providerRef!);
    expect((await returnWith(payment.id, "success", "FORGED0000")).o).toBe("unknown");
    expect(executes(p.providerRef!)).toBe(0);
    expect((await row(payment.id))!.status).toBe("link_sent");
  });

  it("the patient cancels on bKash's page: not paid, the amount is free again", async () => {
    const { payment, bill } = await bkashPayment();
    expect((await returnWith(payment.id, "cancel")).o).toBe("not-paid");
    expect((await row(payment.id))!).toMatchObject({ status: "failed", failReason: "not-paid" });
    const cash = await post(`/v1/invoices/${bill.id}/payments`, { method: "cash", amountPaisa: bill.total, tenderedPaisa: bill.total });
    expect(cash.statusCode, cash.body).toBe(201);
  });

  it("a replaced link is never executed, even if the patient authorised it; the new link pays", async () => {
    const { payment } = await bkashPayment();
    expect((await returnWith(payment.id, "failure")).o).toBe("not-paid");
    const old = (await row(payment.id))!;
    const retry = await post(`/v1/payments/${payment.id}/retry`);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().payment).toMatchObject({ status: "link-sent", attempt: 2 });
    const now = (await row(payment.id))!;
    expect(now.providerRef).not.toBe(old.providerRef);
    expect(now.linkCode).not.toBe(old.linkCode);
    // the old link: authorised late, its return refused, nothing executed; its short link has ended
    standIn.authorise(old.providerRef!);
    const q = new URLSearchParams({ paymentID: old.providerRef!, status: "success", signature: old.providerSignature! });
    expect((await get(`/v1/payments/return/bkash?${q}`, null)).headers.location).toContain("o=ended");
    expect(executes(old.providerRef!)).toBe(0);
    expect((await get(`/v1/pay/${old.linkCode}`, null)).headers.location).toContain("o=ended"); // ended, never "not found"
    standIn.authorise(now.providerRef!);
    expect((await returnWith(payment.id, "success")).o).toBe("paid");
  });

  it("an expired link is not executed", async () => {
    const { payment } = await bkashPayment();
    const p = (await row(payment.id))!;
    await inTenant((tx) => tx.payment.update({ where: { id: p.id }, data: { linkExpiresAt: new Date(Date.now() - 60_000) } }));
    standIn.authorise(p.providerRef!);
    expect((await returnWith(payment.id, "success")).o).toBe("expired");
    expect(executes(p.providerRef!)).toBe(0);
  });

  it("an execute that times out is settled by a query: confirmed, never executed twice", async () => {
    const { payment } = await bkashPayment();
    const p = (await row(payment.id))!;
    standIn.authorise(p.providerRef!);
    standIn.slowNextExecuteMs = 2500; // our timeout is 1.5 s; bKash still completes it
    const r = await returnWith(payment.id, "success");
    expect(r.o).toBe("paid");
    expect(executes(p.providerRef!)).toBe(1);
    expect((await row(payment.id))!.status).toBe("confirmed");
  });

  it("review A4: bKash refuses the execute and the query cannot reach bKash — the payment stays pending, claimed; the sweep decides it once bKash answers", async () => {
    const { payment } = await bkashPayment();
    const p = (await row(payment.id))!;
    standIn.authorise(p.providerRef!);
    standIn.failNextExecute = "2056"; standIn.queryDownNext = 1;
    const r = await returnWith(payment.id, "success");
    expect(r.o).toBe("pending");
    const after = (await row(payment.id))!;
    expect(after.status).not.toBe("failed"); expect(after.executeClaimedAt).not.toBeNull();
    // a claim younger than the execute bound is left alone by the sweep (even asked with no "stuck" window at all)
    await sweepPayments(new Date(), 0);
    expect((await row(payment.id))!.status).not.toBe("failed");
    // past the bound, bKash answers the query (never executed → Initiated): now it is decided
    await inTenant((tx) => tx.payment.update({ where: { id: p.id }, data: { executeClaimedAt: new Date(Date.now() - 6 * 60_000) } }));
    await sweepPayments(new Date());
    expect((await row(payment.id))!).toMatchObject({ status: "failed", failReason: "not-paid" });
    expect(executes(p.providerRef!)).toBe(1);
  });
  it("review A4: Completed without a TrxID goes to the owner's reconciliation — never failed", async () => {
    const { payment } = await bkashPayment();
    const p = (await row(payment.id))!;
    standIn.authorise(p.providerRef!);
    standIn.noTrxIdNext = true;
    const r = await returnWith(payment.id, "success");
    expect(r.o).toBe("pending");
    const after = (await row(payment.id))!;
    expect(after.status).not.toBe("failed"); expect(after.executeClaimedAt).toBeNull();
    const task = await inTenant((tx) => tx.task.findFirst({ where: { kind: "payment-reconciliation", focusId: p.id } }));
    expect(task).toMatchObject({ status: "requested", reason: "completed by the provider without a transaction ID" });
    // review C: a repeated return does not execute it a second time
    expect((await returnWith(payment.id, "success")).o).toBe("pending");
    expect(executes(p.providerRef!)).toBe(1);
  });
  it("review A4: two returns at the same moment execute once", async () => {
    const { payment } = await bkashPayment();
    const p = (await row(payment.id))!;
    standIn.authorise(p.providerRef!);
    const q = new URLSearchParams({ paymentID: p.providerRef!, status: "success", signature: p.providerSignature! });
    const [a, b] = await Promise.all([get(`/v1/payments/return/bkash?${q}`, null), get(`/v1/payments/return/bkash?${q}`, null)]);
    expect([a.statusCode, b.statusCode]).toEqual([303, 303]);
    expect(executes(p.providerRef!)).toBe(1);
    expect((await row(payment.id))!.status).toBe("confirmed");
  });

  /** A payment whose execute reached bKash and completed there while its answer never reached us (the API stopped after
      the claim): the claim is past the execute bound; bKash holds it Completed with a TrxID. */
  async function completedUnheard() {
    const { payment, bill } = await bkashPayment();
    const p = (await row(payment.id))!;
    standIn.authorise(p.providerRef!);
    await inTenant((tx) => tx.payment.update({ where: { id: p.id }, data: { executeClaimedAt: new Date(Date.now() - 6 * 60_000) } }));
    const ans = await outside().execute(p.providerRef!);
    expect(ans.status).toMatchObject({ status: "confirmed", amountPaisa: p.amountPaisa });
    expect((await row(p.id))!.status).toBe("link_sent"); // we never heard it
    return { p, bill, trxId: ans.status!.trxId! };
  }
  const settledOnce = async (paymentId: string, ref: string, bill: { id: string; total: number }) => {
    const inv = (await inTenant((tx) => tx.invoice.findFirst({ where: { id: bill.id } })))!;
    expect(inv).toMatchObject({ status: "balanced", paidPaisa: bill.total }); // counted once, never twice
    expect(await inTenant((tx) => tx.payment.count({ where: { invoiceId: bill.id } }))).toBe(1);
    expect(await inTenant((tx) => tx.providerEvent.count({ where: { eventId: `execute:${ref}` } }))).toBe(1);
    const applied = await inTenant((tx) => tx.auditEvent.findMany({ where: { entity: "Payment", entityId: paymentId, action: "update" } }));
    expect(applied.filter((a) => (a.detail as { outcome?: string }).outcome === "applied")).toHaveLength(1);
    expect(await inTenant((tx) => tx.receipt.count({ where: { invoiceId: bill.id } }))).toBe(0); // a receipt is made only when asked for
    expect(await inTenant((tx) => tx.task.count({ where: { kind: "payment-reconciliation", focusId: paymentId } }))).toBe(0);
  };
  it("review C: the sweep confirms a payment bKash completed whose answer never reached us — with the TrxID, the bill paid, executed once", async () => {
    const { p, bill, trxId } = await completedUnheard();
    await sweepPayments(new Date());
    expect((await row(p.id))!).toMatchObject({ status: "confirmed", trxId, confirmedById: null });
    expect(executes(p.providerRef!)).toBe(1); // the sweep only asks (query) — it never executes
    expect(standIn.calls.filter((c) => c.path === "query/payment" && c.body.paymentId === p.providerRef).length).toBeGreaterThanOrEqual(1);
    await settledOnce(p.id, p.providerRef!, bill);
    // a later sweep finds nothing left to do for it
    await sweepPayments(new Date());
    await settledOnce(p.id, p.providerRef!, bill);
  });
  it("review C: two overlapping sweeps at the same moment settle that payment once", async () => {
    const { p, bill, trxId } = await completedUnheard();
    const now = new Date();
    await Promise.all([sweepPayments(now), sweepPayments(now)]);
    expect((await row(p.id))!).toMatchObject({ status: "confirmed", trxId });
    expect(executes(p.providerRef!)).toBe(1);
    await settledOnce(p.id, p.providerRef!, bill);
  });
  it("review C: bKash answers the execute with another amount than the payment — never confirmed; the owner's reconciliation", async () => {
    const { payment, bill } = await bkashPayment();
    const p = (await row(payment.id))!;
    standIn.authorise(p.providerRef!);
    // bKash reports ৳1 less than the payment asked for (the stand-in answers its stored amount)
    standIn.payments.get(p.providerRef!)!.amount = ((p.amountPaisa - 100) / 100).toFixed(2);
    expect((await returnWith(payment.id, "success")).o).toBe("pending");
    expect(executes(p.providerRef!)).toBe(1);
    const after = (await row(payment.id))!;
    expect(after).toMatchObject({ status: "link_sent", trxId: null, executeClaimedAt: null });
    const tasks = await inTenant((tx) => tx.task.findMany({ where: { kind: "payment-reconciliation", focusId: p.id } }));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "requested", reason: "amount reported by the provider differs from the payment", detail: expect.objectContaining({ amountPaisa: p.amountPaisa - 100, paymentAmountPaisa: p.amountPaisa }) });
    expect(await inTenant((tx) => tx.providerEvent.findFirst({ where: { eventId: `execute:${p.providerRef}` } }))).toMatchObject({ outcome: "refused", reason: "amount-mismatch" });
    expect((await inTenant((tx) => tx.invoice.findFirst({ where: { id: bill.id } })))!).toMatchObject({ paidPaisa: 0 });
    expect((await inTenant((tx) => tx.invoice.findFirst({ where: { id: bill.id } })))!.status).not.toBe("balanced");
    // a repeated "success" return (the patient reloads bKash's page) executes nothing again — the execute was decided
    expect((await returnWith(payment.id, "success")).o).toBe("pending");
    expect(executes(p.providerRef!)).toBe(1);
    expect((await row(payment.id))!.executeClaimedAt).toBeNull();
    // the sweep does not confirm it afterwards (even with a claim past the execute bound, bKash asked again)
    await inTenant((tx) => tx.payment.update({ where: { id: p.id }, data: { executeClaimedAt: new Date(Date.now() - 6 * 60_000) } }));
    await sweepPayments(new Date());
    expect((await row(payment.id))!).toMatchObject({ status: "link_sent", trxId: null });
    expect(executes(p.providerRef!)).toBe(1);
    expect(await inTenant((tx) => tx.task.count({ where: { kind: "payment-reconciliation", focusId: p.id } }))).toBe(1);
  });
  it("while an execute is under way the cashier cannot cancel; one never answered is settled by the sweep", async () => {
    const { payment } = await bkashPayment();
    const p = (await row(payment.id))!;
    await inTenant((tx) => tx.payment.update({ where: { id: p.id }, data: { executeClaimedAt: new Date(Date.now() - 6 * 60_000) } }));
    const c = await post(`/v1/payments/${payment.id}/cancel`);
    expect(c.statusCode).toBe(409);
    expect(c.json().code).toBe("executing");
    expect((await get(`/v1/invoices/${(await row(payment.id))!.invoiceId}`)).json().payments.find((x: { id: string }) => x.id === payment.id).executing).toBe(true);
    await sweepPayments(new Date());
    expect((await row(payment.id))!).toMatchObject({ status: "failed", failReason: "not-paid" }); // bKash never completed it
  });

  it("a gateway that refuses the link fails the payment and frees the amount; a link never made is failed by the sweep", async () => {
    standIn.failNextCreate = "2003";
    const { payment, bill } = await bkashPayment();
    expect(payment).toMatchObject({ status: "failed", failReason: "gateway-error", payUrl: null });
    const second = await post(`/v1/invoices/${bill.id}/payments`, { method: "cash", amountPaisa: bill.total, tenderedPaisa: bill.total });
    expect(second.statusCode, second.body).toBe(201);
    // the API stopped between the commit and the gateway: initiated, no link, 6 minutes old
    const b2 = await issuedBill();
    const pat = (await inTenant((tx) => tx.invoice.findFirst({ where: { id: b2.id }, select: { patientId: true } })))!.patientId;
    const stuck = await inTenant((tx) => tx.payment.create({ data: { tenantId: "t_e2e", organizationId: "o_e2e", invoiceId: b2.id, patientId: pat, method: "bkash", status: "initiated", amountPaisa: b2.total, provider: "bkash", phone: "1712345678", createdById: "u_e2e_cashier", statusAt: new Date(Date.now() - 6 * 60_000) } }));
    await sweepPayments(new Date());
    expect((await row(stuck.id))!).toMatchObject({ status: "failed", failReason: "gateway-error" });
  });

  it("money review: bKash completing a payment we had failed is never lost — the TrxID check opens the owner's reconciliation", async () => {
    const { payment } = await bkashPayment();
    expect((await returnWith(payment.id, "cancel")).o).toBe("not-paid");
    const p = (await row(payment.id))!;
    // somehow executed at bKash anyway (e.g. an execute in flight when it was failed)
    standIn.authorise(p.providerRef!);
    const ans = await outside().execute(p.providerRef!);
    expect(ans.status?.status).toBe("confirmed");
    const r = await post(`/v1/payments/${payment.id}/verify-trx`, { trxId: ans.status!.trxId });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().notice).toBe("paid-on-earlier-link");
    expect(await inTenant((tx) => tx.task.count({ where: { kind: "payment-reconciliation", focusId: payment.id, status: "requested" } }))).toBe(1);
  });

  it("money review: past two renewals an hour the provider refuses locally instead of calling bKash", async () => {
    const calls = () => standIn.calls.filter((c) => c.path.startsWith("auth/")).length;
    const before = calls();
    const now = new Date();
    const p = new BkashProvider({ baseUrl: apiUrl, ...creds, callbackUrl: "https://setu.test/x" },
      async (renew) => { const out = await renew({ token: null, renewals: [now, now] }); return out ?? { token: null, renewals: [] }; });
    await expect(p.createLink({ method: "bkash", amountPaisa: 100, reference: "r", invoiceNumber: "I", phone: "1712345678", attempt: 1 })).rejects.toThrow(/renewal limit/);
    expect(calls()).toBe(before);
  });

  it("one token for every process: a restarted provider reuses the stored token; a refused token is renewed once", async () => {
    const grants = () => standIn.calls.filter((c) => c.path.startsWith("auth/")).length;
    const before = grants();
    expect(before).toBeLessThanOrEqual(2); // this whole file: one grant (plus one renewal if a stored token was stale)
    const fresh = outside();
    const link = await fresh.createLink({ method: "bkash", amountPaisa: 12_345, reference: "ref-token-test", invoiceNumber: "INV/T", phone: "1712345678", attempt: 1 });
    expect(link.providerRef).toMatch(/^TR0011/);
    expect(grants()).toBe(before);
  });
});

/* ADR 0013 — bKash refunds (developer.bka.sh v2 Refund / Refund Status) against the stand-in: partial refunds within what
   was paid, refusals that moved nothing, and an unanswered refund settled by Refund Status — never sent twice. */
describe.runIf(db)("ADR 0013 bKash refund", () => {
  const quick = () => new BkashProvider({ baseUrl: apiUrl, ...creds, callbackUrl: "https://setu.test/x", timeoutMs: 400 }, async (renew) => db!.withGatewayToken("bkash", renew));
  /** a completed ৳amount bKash payment at the stand-in: paymentId and TrxID */
  async function paid(amountPaisa: number) {
    const p = outside();
    const link = await p.createLink({ method: "bkash", amountPaisa, reference: `rf-${randomUUID()}`, invoiceNumber: "INV/RF", phone: "1712345678", attempt: 1 });
    standIn.authorise(link.providerRef);
    const ex = await p.execute(link.providerRef);
    expect(ex.status?.status).toBe("confirmed");
    return { providerRef: link.providerRef, trxId: ex.status!.trxId! };
  }
  const refunds = (ref: string) => standIn.calls.filter((c) => c.path === "refund/payment/transaction" && c.body.paymentId === ref).length;

  it("partial refunds up to what was paid; one more paisa is refused and nothing moves", async () => {
    const pay = await paid(50_000);
    const p = outside();
    const a = await p.refund({ ...pay, amountPaisa: 10_000, sku: "alloc-a", reason: "cancelled-test", known: [] });
    expect(a).toMatchObject({ status: "completed", code: null });
    expect(a.refundTrxId).toMatch(/^RF/);
    expect(standIn.calls.at(-1)!.body).toMatchObject({ paymentId: pay.providerRef, trxId: pay.trxId, refundAmount: "100.00", sku: "alloc-a", reason: "cancelled-test" });
    const b = await p.refund({ ...pay, amountPaisa: 40_000, sku: "alloc-b", reason: "patient-request", known: [a.refundTrxId!] });
    expect(b.status).toBe("completed");
    expect(await p.refund({ ...pay, amountPaisa: 1, sku: "alloc-c", reason: "other", known: [a.refundTrxId!, b.refundTrxId!] })).toEqual({ status: "refused", refundTrxId: null, code: "2072" });
    const list = await p.refundStatus(pay);
    expect(list!.map((r) => [r.refundTrxId, r.amountPaisa, r.completed])).toEqual([[a.refundTrxId, 10_000, true], [b.refundTrxId, 40_000, true]]);
  });

  it("a wrong TrxID and a payment never completed are refused; the same amount again within 10 minutes is unknown, not refused", async () => {
    const pay = await paid(30_000);
    const p = outside();
    expect((await p.refund({ ...pay, trxId: "TRXWRONG1", amountPaisa: 5_000, sku: "s", reason: "other", known: [] })).code).toBe("2077");
    const first = await p.refund({ ...pay, amountPaisa: 5_000, sku: "s1", reason: "other", known: [] });
    expect(first.status).toBe("completed");
    // decision 227: an undocumented answer (here a duplicate) is "unknown — ask Refund Status", never refunded or failed;
    // the status shows only the refund we already hold
    expect(await p.refund({ ...pay, amountPaisa: 5_000, sku: "s2", reason: "other", known: [first.refundTrxId!] })).toEqual({ status: "unknown", refundTrxId: null, code: "2901" });
    const link = await p.createLink({ method: "bkash", amountPaisa: 1_000, reference: `rf-${randomUUID()}`, invoiceNumber: "INV/RF", phone: "1712345678", attempt: 1 });
    expect((await p.refund({ providerRef: link.providerRef, trxId: "TRXNONE01", amountPaisa: 1_000, sku: "s", reason: "other", known: [] })).code).toBe("2127");
  });

  it("no answer in time: Refund Status finds the refund bKash made — completed, never refunded twice", async () => {
    const pay = await paid(20_000);
    standIn.slowNextRefundMs = 1_200;
    const r = await quick().refund({ ...pay, amountPaisa: 7_500, sku: "slow", reason: "other", known: [] });
    expect(r.status).toBe("completed");
    expect(refunds(pay.providerRef)).toBe(1);
    expect((await outside().refundStatus(pay))!.map((x) => x.refundTrxId)).toEqual([r.refundTrxId]);
  });

  it("review: a refund status we cannot read is unknown — never \"nothing was refunded\" (so nobody pays again)", async () => {
    const pay = await paid(10_000);
    standIn.slowNextRefundMs = 1_200; // bKash refunds, we hear nothing …
    standIn.brokenNextStatus = true; // … and the status answer is unreadable
    expect(await quick().refund({ ...pay, amountPaisa: 2_000, sku: "broken", reason: "other", known: [] })).toMatchObject({ status: "unknown", refundTrxId: null });
    standIn.brokenNextStatus = true;
    await expect(outside().refundStatus(pay)).rejects.toThrow(/cannot read|no refund list/);
  });

  it("an unclear answer with nothing new at bKash stays unknown (a person decides; no automatic resend)", async () => {
    const pay = await paid(20_000);
    const p = outside();
    const done = await p.refund({ ...pay, amountPaisa: 2_000, sku: "x", reason: "other", known: [] });
    standIn.failNextRefund = "503";
    // the earlier refund is ours already (known): bKash shows nothing new, so this one is not taken as done
    expect(await p.refund({ ...pay, amountPaisa: 2_000, sku: "y", reason: "other", known: [done.refundTrxId!] })).toEqual({ status: "unknown", refundTrxId: null, code: "503" });
    expect(refunds(pay.providerRef)).toBe(2);
  });

  it("the fake gateway has no refund API: refunds through it are made by hand", async () => {
    const { FakeProvider } = await import("../src/adapters/payments/index.js");
    const f = new FakeProvider("x");
    expect(f.refundSupport).toBe("manual");
    expect(outside().refundSupport).toBe("gateway");
  });
});

/* ADR 0013 — a bKash payment refunded through the routes: claimed in the request, refunded at the stand-in after the
   commit, paid with the refund TrxID and a voucher; a refusal leaves the allocation open with why, and then — only then —
   cash is allowed ("gateway-failed"). */
describe.runIf(db)("ADR 0013 bKash refund through the routes", () => {
  /** an issued bill (consultation + a desk card ৳… ) paid in full by bKash at the stand-in */
  async function paidByBkash() {
    const b = await issuedBillWithDesk();
    const r = await post(`/v1/invoices/${b.id}/payments`, { method: "bkash", amountPaisa: b.total });
    expect(r.statusCode, r.body).toBe(201);
    const p = (await row(r.json().payment.id))!;
    standIn.authorise(p.providerRef!);
    expect((await returnWith(p.id, "success")).o).toBe("paid");
    return { ...b, paymentId: p.id, providerRef: p.providerRef! };
  }
  async function issuedBillWithDesk() {
    const r = await post("/v1/patients", {
      nameBn: "বিকাশ ফেরত", nameEn: `Bkash Refund ${RUN}`, sex: "female", dobMode: "dob", dob: "06/06/1986", phone: `017${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self",
      division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
    }, "desk");
    const enc = r.json().encounter.id as string;
    const v = (await post(`/v1/encounters/${enc}/consultation/open`, {}, "doctor")).json();
    const saved = await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: cookies.doctor!, "idempotency-key": randomUUID() }, payload: {
      rev: 1, sections: { complaints: [{ text: "Cough", duration: { n: 3, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
      sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [], orders: [],
    } });
    await post(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.json().rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor");
    const b0 = (await post(`/v1/encounters/${enc}/invoice`)).json();
    const b1 = await post(`/v1/invoices/${b0.invoice.id}/lines`, { code: "desk:card", rev: b0.invoice.rev });
    expect(b1.statusCode, b1.body).toBe(200);
    const issued = await post(`/v1/invoices/${b0.invoice.id}/issue`, { rev: b1.json().invoice.rev });
    expect(issued.statusCode, issued.body).toBe(200);
    const card = issued.json().lines.find((l: { code: string }) => l.code === "desk:card");
    return { id: b0.invoice.id as string, total: issued.json().invoice.totalPaisa as number, card: card as { id: string; totalPaisa: number } };
  }
  async function approvedRefund(b: Awaited<ReturnType<typeof paidByBkash>>) {
    const rb = (await get(`/v1/invoices/${b.id}/refundable`)).json();
    expect(rb.payments[0]).toMatchObject({ method: "bkash", gatewayRefunds: true, ways: ["cash", "gateway"] });
    const r = await post(`/v1/invoices/${b.id}/refunds`, { category: "patient-request", reason: "Card not needed — patient already has one", lines: [{ chargeItemId: b.card.id, amountPaisa: b.card.totalPaisa }], allocations: [{ paymentId: b.paymentId, amountPaisa: b.card.totalPaisa, way: "gateway" }] });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().refund.id as string;
    const ok = await post(`/v1/refunds/${id}/decision`, { decision: "approve" }, "owner");
    expect(ok.statusCode, ok.body).toBe(200);
    return { id, rev: ok.json().refund.rev as number, alloc: ok.json().allocations[0].id as string };
  }
  const recipient = { name: "Nusrat Jahan", phone: "01711223344", relation: "self" };

  it("paid back to the wallet: claimed, refunded at bKash after the commit, a voucher with the refund TrxID", async () => {
    const b = await paidByBkash();
    const r = await approvedRefund(b);
    const before = standIn.calls.filter((c) => c.path === "refund/payment/transaction").length;
    const paid = await post(`/v1/refunds/${r.id}/pay`, { rev: r.rev, recipient });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({ outcome: "paid", view: { refund: { status: "paid", voucher: { number: expect.stringMatching(/^RF\//) } }, allocations: [{ status: "paid", way: "gateway", refundTrxId: expect.stringMatching(/^RF/) }] } });
    const call = standIn.calls.filter((c) => c.path === "refund/payment/transaction").at(-1)!;
    expect(standIn.calls.filter((c) => c.path === "refund/payment/transaction").length).toBe(before + 1);
    expect(call.body).toMatchObject({ paymentId: b.providerRef, sku: r.alloc, reason: "patient-request" });
    expect((await inTenant((tx) => tx.invoice.findFirst({ where: { id: b.id } })))!.refundedPaisa).toBe(b.card.totalPaisa);
  });

  it("bKash refuses: the allocation stays open with why; cash only now, with the reason gateway-failed", async () => {
    const b = await paidByBkash();
    const r = await approvedRefund(b);
    standIn.failNextRefund = "2023"; // the merchant's balance is too low
    const first = await post(`/v1/refunds/${r.id}/pay`, { rev: r.rev, recipient });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ outcome: "failed", view: { refund: { status: "approved" }, allocations: [{ status: "open", gatewayFailed: true, failReason: "gateway refused (2023)" }] } });
    // the cashier needs a drawer for cash
    const mine = (await get("/v1/shifts/mine")).json();
    if (!mine.shift || mine.shift.status !== "open") expect((await post("/v1/shifts", { openingFloatPaisa: 100_000 })).statusCode).toBe(201);
    const rev = (await get(`/v1/refunds/${r.id}`)).json().refund.rev;
    const cash = await post(`/v1/refunds/${r.id}/pay`, { rev, recipient, switchToCash: true });
    expect(cash.statusCode, cash.body).toBe(200);
    expect(cash.json().view.allocations[0]).toMatchObject({ status: "paid", way: "cash", cashReason: "gateway-failed" });
  });

  it("an unclear answer leaves it claimed; the sweep asks Refund Status (never refunds again) and after 15 minutes hands it back to a person", async () => {
    const { sweepRefunds } = await import("../src/modules/refunds.js");
    const b = await paidByBkash();
    const r = await approvedRefund(b);
    standIn.failNextRefund = "503";
    const paid = await post(`/v1/refunds/${r.id}/pay`, { rev: r.rev, recipient });
    expect(paid.json()).toMatchObject({ outcome: "paying", view: { allocations: [{ status: "paying" }], can: { check: true, pay: false } } });
    const sent = () => standIn.calls.filter((c) => c.path === "refund/payment/transaction" && c.body.sku === r.alloc).length;
    expect(sent()).toBe(1);
    await sweepRefunds(new Date(Date.now() + 3 * 60_000));
    expect((await get(`/v1/refunds/${r.id}`)).json().allocations[0].status).toBe("paying");
    await sweepRefunds(new Date(Date.now() + 16 * 60_000));
    expect((await get(`/v1/refunds/${r.id}`)).json().allocations[0]).toMatchObject({ status: "open", gatewayFailed: true, failReason: "no refund found at the gateway" });
    expect(sent()).toBe(1);
    // bKash made it after all (shows up later): a person's retry finds it by Refund Status and sends nothing again
    standIn.payments.get(b.providerRef)!.refunds.push({ refundTrxId: "RFLATE0001", amount: (b.card.totalPaisa / 100).toFixed(2), sku: r.alloc, reason: "patient-request", at: new Date() });
    const rev = (await get(`/v1/refunds/${r.id}`)).json().refund.rev;
    const retry = await post(`/v1/refunds/${r.id}/pay`, { rev, recipient });
    expect(retry.json().view.allocations[0]).toMatchObject({ status: "paid", refundTrxId: "RFLATE0001" });
    expect(sent()).toBe(1);
  });

  it("235: the owner settles a refund stuck 'processing' from the portal — not refunded hands it back; refunded pays it with the TrxID; both audited and checked", async () => {
    const stuck = async () => {
      const b = await paidByBkash();
      const r = await approvedRefund(b);
      standIn.failNextRefund = "503";
      expect((await post(`/v1/refunds/${r.id}/pay`, { rev: r.rev, recipient })).json().outcome).toBe("paying");
      return { b, r };
    };
    const one = await stuck();
    // only the owner, with a note
    expect((await post(`/v1/refunds/${one.r.id}/release`, { outcome: "not-refunded", note: "Portal shows no refund for this payment" })).statusCode).toBe(403);
    expect((await post(`/v1/refunds/${one.r.id}/release`, { outcome: "not-refunded", note: "short" }, "owner")).statusCode).toBe(400);
    const back = await post(`/v1/refunds/${one.r.id}/release`, { outcome: "not-refunded", note: "Portal shows no refund for this payment" }, "owner");
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toMatchObject({ refund: { status: "approved" }, allocations: [{ status: "open", gatewayFailed: true, needsReconciliation: true, reconciled: "waiting" }], can: { pay: true } });
    expect(back.json().allocations[0].failReason).toContain("not refunded");
    const two = await stuck();
    expect((await post(`/v1/refunds/${two.r.id}/release`, { outcome: "refunded", note: "Portal: refund completed at 16:02" }, "owner")).json().code).toBe("trx_required");
    const done = await post(`/v1/refunds/${two.r.id}/release`, { outcome: "refunded", note: "Portal: refund completed at 16:02", refundTrxId: "rfportal01" }, "owner");
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ refund: { status: "paid", voucher: { number: expect.stringMatching(/^RF\//) } }, allocations: [{ status: "paid", refundTrxId: "RFPORTAL01", needsReconciliation: true }] });
    const checks = await inTenant((tx) => tx.task.count({ where: { kind: "refund-reconciliation", status: "requested", focusId: { in: [back.json().allocations[0].id, done.json().allocations[0].id] } } }));
    expect(checks).toBe(2);
    const audit = await inTenant((tx) => tx.auditEvent.findMany({ where: { entity: "RefundAllocation", detail: { path: ["event"], equals: "owner-release" } } }));
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it("no answer from bKash in time: the refund made there is found by Refund Status — paid once", async () => {
    const b = await paidByBkash();
    const r = await approvedRefund(b);
    standIn.slowNextRefundMs = 2_500; // longer than BKASH_TIMEOUT_MS (1.5 s): bKash refunds, we hear nothing
    const paid = await post(`/v1/refunds/${r.id}/pay`, { rev: r.rev, recipient });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().view.allocations[0]).toMatchObject({ status: "paid", refundTrxId: expect.stringMatching(/^RF/) });
    expect(standIn.payments.get(b.providerRef)!.refunds.length).toBe(1);
  });
});

describe.runIf(db)("external review B6: the gateway's tokens are stored encrypted; the token lock is bounded", () => {
  const owner = () => new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  it("the stored bKash token is ciphertext (AES-GCM) and opens to the token bKash accepts", async () => {
    await bkashPayment(); // a payment needs the token: granted (or refreshed) and stored
    const o = owner();
    try {
      const raw = (await o.gatewayToken.findUnique({ where: { provider: "bkash" } }))!;
      expect(raw.idToken).toMatch(/^enc:v1:/);
      expect(raw.refreshToken).toMatch(/^enc:v1:/);
      expect(db!.openToken(raw.idToken!)).not.toMatch(/^enc:v1:/);
      // tampered ciphertext is refused, never used
      const bad = raw.idToken!.slice(0, -2) + (raw.idToken!.endsWith("A") ? "BB" : "AA");
      expect(() => db!.openToken(bad)).toThrow();
    } finally { await o.$disconnect(); }
  });
  it("a token stored in clear before B6 is still read, and is encrypted on its next write", async () => {
    const o = owner();
    const provider = `b6-${randomUUID().slice(0, 6)}`;
    try {
      const exp = new Date(Date.now() + 3600_000);
      await o.gatewayToken.create({ data: { provider, idToken: "plain-id-token", idExpiresAt: exp, refreshToken: "plain-refresh", refreshExpiresAt: exp, updatedAt: new Date() } });
      const read = await db!.withGatewayToken(provider, async () => null);
      expect(read.token).toMatchObject({ idToken: "plain-id-token", refreshToken: "plain-refresh" });
      await db!.withGatewayToken(provider, async (cur) => ({ ...cur, token: { ...cur.token!, idToken: "next-id-token" } }));
      const raw = (await o.gatewayToken.findUnique({ where: { provider } }))!;
      expect(raw.idToken).toMatch(/^enc:v1:/);
      expect(raw.refreshToken).toMatch(/^enc:v1:/);
      expect((await db!.withGatewayToken(provider, async () => null)).token).toMatchObject({ idToken: "next-id-token", refreshToken: "plain-refresh" });
    } finally { await o.gatewayToken.deleteMany({ where: { provider } }); await o.$disconnect(); }
  });
  it("while another process holds the token lock, a caller waits at most lockMs and gets the stored token without renewing", async () => {
    const o = owner();
    const provider = `b6-${randomUUID().slice(0, 6)}`;
    try {
      const exp = new Date(Date.now() + 3600_000);
      await db!.withGatewayToken(provider, async (cur) => ({ ...cur, token: { idToken: "held-id", idExpiresAt: exp, refreshToken: "held-refresh", refreshExpiresAt: exp } }));
      let release!: () => void;
      const held = o.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"gateway-token:" + provider}::text))`;
        await new Promise<void>((r) => { release = r; });
      }, { timeout: 20_000 });
      await new Promise((r) => setTimeout(r, 200));
      let renewed = false;
      const t0 = Date.now();
      const got = await db!.withGatewayToken(provider, async () => { renewed = true; return null; }, { lockMs: 300 });
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(renewed).toBe(false);
      expect(got.token).toMatchObject({ idToken: "held-id" });
      release(); await held;
    } finally { await o.gatewayToken.deleteMany({ where: { provider } }); await o.$disconnect(); }
  });
});

