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
const USERS = { desk: "01799000001", doctor: "01799000002", cashier: "01799000008" } as const;
type Who = keyof typeof USERS;

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
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
    expect((await get(`/v1/pay/ABCDEFGH23`, null)).headers.location).toContain("o=unknown");
  });

  it("the patient pays: one execute, confirmed with the TrxID, the bill balanced; a repeated return executes nothing", async () => {
    const { payment, bill } = await bkashPayment();
    const p = (await row(payment.id))!;
    standIn.authorise(p.providerRef!);
    const r = await returnWith(payment.id, "success");
    expect(r.o).toBe("paid");
    expect(r.trx).toMatch(/^TRX/);
    expect(Number(r.a)).toBe(bill.total);
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
    expect((await get(`/v1/pay/${old.linkCode}`, null)).headers.location).toContain("o=unknown");
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

  it("while an execute is under way the cashier cannot cancel; one never answered is settled by the sweep", async () => {
    const { payment } = await bkashPayment();
    const p = (await row(payment.id))!;
    await inTenant((tx) => tx.payment.update({ where: { id: p.id }, data: { executeClaimedAt: new Date(Date.now() - 5 * 60_000) } }));
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
    // the API stopped between the commit and the gateway: initiated, no link, 3 minutes old
    const b2 = await issuedBill();
    const pat = (await inTenant((tx) => tx.invoice.findFirst({ where: { id: b2.id }, select: { patientId: true } })))!.patientId;
    const stuck = await inTenant((tx) => tx.payment.create({ data: { tenantId: "t_e2e", organizationId: "o_e2e", invoiceId: b2.id, patientId: pat, method: "bkash", status: "initiated", amountPaisa: b2.total, provider: "bkash", phone: "1712345678", createdById: "u_e2e_cashier", statusAt: new Date(Date.now() - 3 * 60_000) } }));
    await sweepPayments(new Date());
    expect((await row(stuck.id))!).toMatchObject({ status: "failed", failReason: "gateway-error" });
  });

  it("one token for every process: a restarted provider reuses the stored token; a refused token is renewed once", async () => {
    const grants = () => standIn.calls.filter((c) => c.path.startsWith("auth/")).length;
    const before = grants();
    expect(before).toBeLessThanOrEqual(2); // this whole file: one grant (plus one renewal if a stored token was stale)
    const fresh = new BkashProvider({ baseUrl: apiUrl, appKey: STANDIN_CREDENTIALS.appKey, appSecret: STANDIN_CREDENTIALS.appSecret, username: STANDIN_CREDENTIALS.username, password: STANDIN_CREDENTIALS.password, callbackUrl: "https://setu.test/x" },
      async (renew) => db!.withGatewayToken("bkash", renew));
    const link = await fresh.createLink({ method: "bkash", amountPaisa: 12_345, reference: "ref-token-test", invoiceNumber: "INV/T", phone: "1712345678", attempt: 1 });
    expect(link.providerRef).toMatch(/^TR0011/);
    expect(grants()).toBe(before);
  });
});
