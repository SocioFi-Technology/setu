/* ADR 0012 — SMS through BulkSMSBD, against the local stand-in, on the real database (E2E Test Clinic): "sent" is never
   "delivered"; the key travels in the POST body; the gateway's codes; a timeout is "it may have been sent"; the
   payment link by SMS (and again); the sweep for stuck messages (open question 124); the admin's test SMS waits for
   "it arrived". The payment gateway stays the fake here. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BulkSmsBdStandIn, STANDIN_SMS } from "../src/adapters/messaging/bulksmsbd-standin.js";

const standIn = new BulkSmsBdStandIn();
const smsUrl = await standIn.start();
Object.assign(process.env, { SMS_PROVIDER: "bulksmsbd", BULKSMSBD_URL: smsUrl, BULKSMSBD_API_KEY: STANDIN_SMS.apiKey, BULKSMSBD_SENDER_ID: STANDIN_SMS.senderId, BULKSMSBD_TIMEOUT_MS: "1500", LINK_SMS_GAP_MS: "1200", PUBLIC_APP_URL: "https://setu.test", PAYMENTS_PROVIDER: "fake" });
const { buildApp } = await import("../src/app.js");
const { config } = await import("../src/config.js");
const { BulkSmsBdMessenger } = await import("../src/adapters/messaging/index.js");
const { sweepSms } = await import("../src/modules/lab.js");
const { paymentLinkSmsOk, SMS_MAYBE_SENT } = await import("@setu/domain");
const { t } = await import("@setu/i18n");
const { closePdfBrowser } = await import("../src/receipts/pdf.js");

const db = config.dbEnabled ? await import("@setu/db") : null;
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const cookies: Record<string, string> = {};
const USERS = { desk: "01799000001", doctor: "01799000002", cashier: "01799000008", newadmin: "01799000011" } as const;
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

const get = (url: string, who: Who = "cashier") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const post = (url: string, payload: object = {}, who: Who = "cashier") => app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, "idempotency-key": randomUUID() } });
const inTenant = <R>(fn: (tx: NonNullable<typeof db>["prisma"]) => Promise<R>) => db!.forTenant("t_e2e", fn as never) as Promise<R>;

async function issuedBill(phone: string) {
  const r = await post("/v1/patients", { nameBn: "এসএমএস রোগী", nameEn: `Sms Patient ${RUN}`, sex: "female", dobMode: "dob", dob: "06/06/1986", phone, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true }, "desk");
  expect(r.statusCode, r.body).toBe(201);
  const enc = r.json().encounter.id as string;
  const v = (await post(`/v1/encounters/${enc}/consultation/open`, {}, "doctor")).json();
  const saved = await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: cookies.doctor!, "idempotency-key": randomUUID() }, payload: {
    rev: 1, sections: { complaints: [{ text: "Fever", duration: { n: 2, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [], orders: [],
  } });
  expect((await post(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.json().rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor")).statusCode).toBe(200);
  const b = (await post(`/v1/encounters/${enc}/invoice`)).json();
  const issued = await post(`/v1/invoices/${b.invoice.id}/issue`, { rev: b.invoice.rev });
  expect(issued.statusCode, issued.body).toBe(200);
  return { id: b.invoice.id as string, total: issued.json().invoice.totalPaisa as number };
}
const mobile = () => `017${String(randomInt(0, 1e8)).padStart(8, "0")}`;

describe("BulkSmsBdMessenger (ADR 0012)", () => {
  const m = new BulkSmsBdMessenger({ url: smsUrl, apiKey: STANDIN_SMS.apiKey, senderId: STANDIN_SMS.senderId, timeoutMs: 1500 });
  it("202 is sent — never delivered; the number goes as 8801…; the payment-link template names no patient", async () => {
    expect(m.confirmsDelivery).toBe(false);
    const r = await m.sendSms({ messageId: "x1", to: "01711234567", text: "Clinic: test" });
    expect(r).toMatchObject({ status: "sent" });
    expect(standIn.messages.at(-1)).toMatchObject({ number: "8801711234567", message: "Clinic: test" });
    for (const lang of ["bn", "en"] as const) expect(paymentLinkSmsOk(t(lang, "billingApp", "sms_payment_link"))).toBe(true);
  });
  it("the gateway's codes: the number, the facility's setup, a timeout that may have been sent", async () => {
    expect(await m.sendSms({ messageId: "x2", to: "12345", text: "x" })).toMatchObject({ status: "failed", reason: "number" });
    standIn.nextCodes.push(1007);
    expect(await m.sendSms({ messageId: "x3", to: "01711234567", text: "x" })).toMatchObject({ status: "failed", reason: "setup", error: expect.stringContaining("1007") });
    standIn.slowNextMs = 2500;
    const slow = await m.sendSms({ messageId: "x4", to: "01711234567", text: "x" });
    expect(slow).toMatchObject({ status: "failed", reason: "no-answer" });
    expect(slow.status === "failed" && slow.error).toContain(SMS_MAYBE_SENT);
    const wrong = new BulkSmsBdMessenger({ url: smsUrl, apiKey: "wrong", senderId: STANDIN_SMS.senderId });
    expect(await wrong.sendSms({ messageId: "x5", to: "01711234567", text: "x" })).toMatchObject({ status: "failed", reason: "setup" });
  });
});

describe.runIf(db)("ADR 0012 on the real stack", () => {
  it("the payment link goes by SMS (facility, bill, amount, short link — no patient name); 'sent', not delivered; send again", { timeout: 30_000 }, async () => {
    const phone = mobile();
    const b = await issuedBill(phone);
    const r = await post(`/v1/invoices/${b.id}/payments`, { method: "bkash", amountPaisa: b.total });
    expect(r.statusCode, r.body).toBe(201);
    const p = r.json().payment;
    expect(p.linkSms).toMatchObject({ status: "completed", deliveryConfirmed: false, toLast4: phone.slice(-4) });
    expect(p.canSms).toBe(true);
    const got = standIn.to(phone);
    expect(got).toHaveLength(1);
    const code = (await inTenant((tx) => tx.payment.findFirst({ where: { id: p.id } })))!.linkCode!;
    expect(got[0]!.message.endsWith(`\nhttps://setu.test/p/${code}`)).toBe(true);
    expect(got[0]!.message.split("https://").length).toBe(2); // the link once
    expect(got[0]!.message).toContain(String(b.total / 100));
    expect(got[0]!.message).not.toContain("Sms Patient");
    const soon = await post(`/v1/payments/${p.id}/send-sms`);
    expect(soon.statusCode).toBe(429); // a minute apart (shortened here)
    const wait = () => new Promise((ok) => setTimeout(ok, 1300));
    await wait();
    const again = await post(`/v1/payments/${p.id}/send-sms`);
    expect(again.statusCode, again.body).toBe(200);
    expect(standIn.to(phone)).toHaveLength(2);
    // the gateway refuses (no balance): failed with its reason, Send again works once it is fixed
    standIn.nextCodes.push(1007);
    await wait();
    const refused = (await post(`/v1/payments/${p.id}/send-sms`)).json().payment;
    expect(refused.linkSms).toMatchObject({ status: "failed", lastError: "BulkSMSBD 1007: balance insufficient" }); // our words, not the gateway's
    await wait();
    expect((await post(`/v1/payments/${p.id}/send-sms`)).json().payment.linkSms.status).toBe("completed");
    await wait();
    expect((await post(`/v1/payments/${p.id}/send-sms`)).statusCode).toBe(200); // the fifth
    await wait();
    expect((await post(`/v1/payments/${p.id}/send-sms`)).json().code).toBe("sms_limit"); // five per payment
    // none of them is ever marked delivered: the gateway cannot know
    const comms = await inTenant((tx) => tx.communication.findMany({ where: { paymentId: p.id }, orderBy: { createdAt: "asc" } }));
    expect(comms.map((c) => [c.kind, c.status, c.deliveryConfirmed])).toEqual([["payment-link", "completed", false], ["payment-link", "completed", false], ["payment-link", "failed", false], ["payment-link", "completed", false], ["payment-link", "completed", false]]);
    // a retried payment: the first SMS's link now says "ended", not "not found"
    await post(`/v1/payments/${p.id}/cancel`);
    await post(`/v1/payments/${p.id}/retry`);
    const r1 = (await app.inject({ method: "GET", url: `/v1/pay/${code}/result` })).json();
    expect(r1.outcome).toBe("ended");
  });

  it("the sweep: queued too long → sent; sending too long → failed 'it may have been sent' (never resent by itself)", async () => {
    const phone = mobile();
    const b = await issuedBill(phone);
    const inv = (await inTenant((tx) => tx.invoice.findFirst({ where: { id: b.id } })))!;
    const make = (id: string) => inTenant((tx) => tx.communication.create({ data: { id, tenantId: "t_e2e", organizationId: "o_e2e", patientId: inv.patientId!, encounterId: inv.encounterId, kind: "report-ready", channel: "sms", toPhone: phone, templateKey: "sms_report_ready", text: "E2E Test Clinic: sweep test", createdById: "u_e2e_cashier", statusAt: new Date(Date.now() - 5 * 60_000) } }));
    const queued = `com_sweepq_${RUN}`, sending = `com_sweeps_${RUN}`;
    await make(queued); await make(sending);
    await inTenant((tx) => tx.communication.update({ where: { id: sending }, data: { status: "in_progress", attempts: 1, sentAt: new Date(Date.now() - 5 * 60_000) } }));
    const before = standIn.to(phone).length;
    await sweepSms(new Date());
    const [q, s] = await inTenant((tx) => Promise.all([tx.communication.findFirst({ where: { id: queued } }), tx.communication.findFirst({ where: { id: sending } })]));
    expect(q).toMatchObject({ status: "completed", deliveryConfirmed: false, attempts: 1 });
    expect(s).toMatchObject({ status: "failed", lastError: SMS_MAYBE_SENT, attempts: 1 });
    expect(standIn.to(phone).length).toBe(before + 1); // only the queued one went out
  });

  it("the sweep never sends a payment link that is no longer the payment's, nor a message queued too long", async () => {
    const phone = mobile();
    const b = await issuedBill(phone);
    const inv = (await inTenant((tx) => tx.invoice.findFirst({ where: { id: b.id } })))!;
    const old = `com_sweepold_${RUN}`, link = `com_sweeplink_${RUN}`;
    const pay = (await post(`/v1/invoices/${b.id}/payments`, { method: "bkash", amountPaisa: b.total })).json().payment;
    await post(`/v1/payments/${pay.id}/cancel`);
    await inTenant(async (tx) => {
      await tx.communication.create({ data: { id: old, tenantId: "t_e2e", organizationId: "o_e2e", patientId: inv.patientId!, encounterId: inv.encounterId, kind: "report-ready", channel: "sms", toPhone: phone, templateKey: "sms_report_ready", text: "x", createdById: "u_e2e_cashier", createdAt: new Date(Date.now() - 40 * 60_000), statusAt: new Date(Date.now() - 40 * 60_000) } });
      await tx.communication.create({ data: { id: link, tenantId: "t_e2e", organizationId: "o_e2e", patientId: inv.patientId!, encounterId: inv.encounterId, kind: "payment-link", channel: "sms", toPhone: phone, templateKey: "sms_payment_link", text: "pay https://setu.test/p/OLDCODE234", paymentId: pay.id, createdById: "u_e2e_cashier", statusAt: new Date(Date.now() - 5 * 60_000) } });
    });
    const before = standIn.to(phone).length;
    await sweepSms(new Date());
    const [o, l] = await inTenant((tx) => Promise.all([tx.communication.findFirst({ where: { id: old } }), tx.communication.findFirst({ where: { id: link } })]));
    expect(o).toMatchObject({ status: "failed", lastError: "not sent — too old" });
    expect(l).toMatchObject({ status: "failed", lastError: "not sent — the payment link has changed" });
    expect(standIn.to(phone).length).toBe(before);
  });

  it("the admin's test SMS through a gateway without delivery reports waits for 'it arrived'", async () => {
    const r = await post("/v1/admin/sms-test", { phone: "01712345678" }, "newadmin");
    expect(r.statusCode, r.body).toBe(200);
    const f = r.json();
    expect(f.sms).toMatchObject({ awaitingConfirm: true, testedAt: null });
    expect(f.checklist.find((c: { item: string }) => c.item === "test_sms").done).toBe(false);
    const ok = await post("/v1/admin/sms-test/confirm", {}, "newadmin");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().checklist.find((c: { item: string }) => c.item === "test_sms").done).toBe(true);
    expect((await post("/v1/admin/sms-test/confirm", {}, "newadmin")).statusCode).toBe(409);
    standIn.nextCodes.push(1032);
    // a failed test undoes the earlier one (controls review): go-live needs a sender that works now
    const refused = await post("/v1/admin/sms-test", { phone: "01712345678" }, "newadmin");
    expect(refused.statusCode, refused.body).toBe(200);
    expect(refused.json().sms).toMatchObject({ testedAt: null, sentAt: null, awaitingConfirm: false, error: expect.stringContaining("IP whitelist") });
    expect(refused.json().checklist.find((c: { item: string }) => c.item === "test_sms").done).toBe(false);
    expect((await post("/v1/admin/sms-test/confirm", {}, "newadmin")).statusCode).toBe(409);
  });
});
