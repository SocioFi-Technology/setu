/* Slice A6–A7 session 2 contract tests: receipts are immutable copies numbered RCPT/yy/nnnn; "Paid by" lists only
   confirmed money with pending wallet amounts apart (issue #10); the first print is the original, a reprint needs a
   reason and is DUPLICATE #n, both audited, the PDF stored; the public verify route needs no session, is rate-limited
   and returns only facility, receipt number, date and amount. Plus the HTML template (escaping, duplicate marks,
   Mushak line only with a BIN). */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReceiptSnapshot } from "@setu/contracts";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { receiptHtml } from "../src/receipts/template.js";
import { closePdfBrowser } from "../src/receipts/pdf.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("receipts.test: DATABASE_URL_APP not set — receipt contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const cookies: Record<string, string> = {};
const USERS = { desk: "01799000001", doctor: "01799000002", cashier: "01799000008", otherCashier: "01711000008" } as const;
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

const get = (url: string, who: Who | null = "cashier") => app.inject({ method: "GET", url, headers: who ? { cookie: cookies[who]! } : {} });
const post = (url: string, payload: object = {}, who: Who = "cashier", key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const inTenant = <R>(fn: (tx: NonNullable<typeof db>["prisma"]) => Promise<R>) => db!.forTenant("t_e2e", fn as never) as Promise<R>;

/** An issued ৳2,300 bill (consultation + CBC, RBS, S. Electrolytes) for a new synthetic patient. */
async function issuedBill() {
  const r = await post("/v1/patients", {
    nameBn: "রসিদ রোগী", nameEn: `Receipt Patient ${RUN}`, sex: "male", dobMode: "dob", dob: "05/05/1980", phone: `018${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self",
    division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
  }, "desk");
  const enc = r.json().encounter.id as string;
  const v = (await post(`/v1/encounters/${enc}/consultation/open`, {}, "doctor")).json();
  const saved = await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: cookies.doctor!, "idempotency-key": randomUUID() }, payload: {
    rev: 1, sections: { complaints: [{ text: "Fever", duration: { n: 3, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }],
    orders: [{ testCode: "cbc", priority: "routine" }, { testCode: "rbs", priority: "routine" }, { testCode: "elec", priority: "routine" }],
  } });
  expect((await post(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.json().rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor")).statusCode).toBe(200);
  const bill = (await post(`/v1/encounters/${enc}/invoice`)).json();
  const issued = await post(`/v1/invoices/${bill.invoice.id}/issue`, { rev: bill.invoice.rev });
  expect(issued.statusCode, issued.body).toBe(200);
  return issued.json().invoice.id as string;
}

describe.runIf(db)("A7 receipts", () => {
  it("no receipt before money is confirmed; a partial receipt lists cash as paid and bKash as pending (issue #10); asking again returns it", async () => {
    const id = await issuedBill();
    expect((await post(`/v1/invoices/${id}/receipts`)).json()).toMatchObject({ code: "nothing_paid" });
    const bk = (await post(`/v1/invoices/${id}/payments`, { method: "bkash", amountPaisa: 200_000 })).json().payment;
    await post(`/v1/invoices/${id}/payments`, { method: "cash", amountPaisa: 30_000, tenderedPaisa: 50_000 });
    const a = await post(`/v1/invoices/${id}/receipts`);
    expect(a.statusCode, a.body).toBe(201);
    const rc = a.json().receipt;
    expect(rc.number).toMatch(/^RCPT\/\d{2}\/\d{4,}$/);
    expect(rc).toMatchObject({ paidPaisa: 30_000, totalPaisa: 230_000, duePaisa: 200_000 });
    expect(rc.snapshot.paidBy).toEqual({ paid: [{ method: "cash", amountPaisa: 30_000 }], pending: [{ method: "bkash", amountPaisa: 200_000 }] });
    expect(rc.snapshot.lines.map((l: { grossPaisa: number }) => l.grossPaisa)).toEqual([80_000, 45_000, 15_000, 90_000]);
    const code = rc.verifyUrl.split("/").pop();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
    const again = await post(`/v1/invoices/${id}/receipts`);
    expect(again.statusCode).toBe(200);
    expect(again.json().receipt.id).toBe(rc.id);
    // bKash confirms → the next receipt is a new one, with bKash on the paid line and its TrxID.
    const ok = (await post(`/v1/dev/fake-payments/${bk.id}/confirmed`, {}, "cashier", null)).json();
    const b = await post(`/v1/invoices/${id}/receipts`);
    expect(b.statusCode).toBe(201);
    expect(b.json().receipt.number).not.toBe(rc.number);
    expect(b.json().receipt.snapshot.paidBy).toEqual({ paid: [{ method: "bkash", amountPaisa: 200_000, trxId: ok.trxId }, { method: "cash", amountPaisa: 30_000 }], pending: [] });
    expect((await get(`/v1/invoices/${id}/receipts`)).json().items).toHaveLength(2);
  });

  it("print: the original first; a reprint needs a reason and is DUPLICATE #1; both audited; the PDF is stored; the receipt is immutable", async () => {
    const id = await issuedBill();
    await post(`/v1/invoices/${id}/payments`, { method: "cash", amountPaisa: 230_000, tenderedPaisa: 250_000 });
    const rc = (await post(`/v1/invoices/${id}/receipts`)).json().receipt;
    expect((await post(`/v1/receipts/${rc.id}/print`, { format: "a5", lang: "both", reason: "lost" })).json()).toMatchObject({ code: "not_printed_yet" });
    const first = await post(`/v1/receipts/${rc.id}/print`, { format: "a5", lang: "both" });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().print).toMatchObject({ copy: 0, reason: null, format: "a5" });
    const pdf = await get(first.json().print.pdfUrl);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await post(`/v1/receipts/${rc.id}/print`, { format: "a5", lang: "both" })).json()).toMatchObject({ code: "reprint_needs_reason" });
    const dup = await post(`/v1/receipts/${rc.id}/print`, { format: "thermal", lang: "bn", reason: "lost" });
    expect(dup.json().print).toMatchObject({ copy: 1, reason: "lost", format: "thermal" });
    expect(dup.json().view.prints.map((p: { copy: number }) => p.copy)).toEqual([0, 1]);
    expect((await get(dup.json().print.pdfUrl)).headers["content-disposition"]).toContain("DUPLICATE-1");
    const audits = await inTenant((tx) => tx.auditEvent.findMany({ where: { entity: "Receipt", entityId: rc.id, action: { in: ["print", "reprint"] } }, orderBy: { at: "asc" } }));
    expect(audits.map((a) => [a.action, (a.detail as { copy: number; reason: string | null }).copy, (a.detail as { reason: string | null }).reason])).toEqual([["print", 0, null], ["reprint", 1, "lost"]]);
    await expect(inTenant((tx) => tx.receipt.update({ where: { id: rc.id }, data: { paidPaisa: 1 } }))).rejects.toThrow();
    await expect(inTenant((tx) => tx.receiptPrint.deleteMany({ where: { receiptId: rc.id } }))).rejects.toThrow();
  });

  it("receptionist and doctor cannot see receipts; another tenant finds nothing", async () => {
    const id = await issuedBill();
    await post(`/v1/invoices/${id}/payments`, { method: "cash", amountPaisa: 230_000, tenderedPaisa: 230_000 });
    const rc = (await post(`/v1/invoices/${id}/receipts`)).json().receipt;
    expect((await get(`/v1/receipts/${rc.id}`, "desk")).statusCode).toBe(403);
    expect((await get(`/v1/receipts/${rc.id}`, "doctor")).statusCode).toBe(403);
    expect((await get(`/v1/receipts/${rc.id}`, "otherCashier")).statusCode).toBe(404);
    expect((await post(`/v1/receipts/${rc.id}/print`, { format: "a5", lang: "both" }, "otherCashier")).statusCode).toBe(404);
  });

  it("the public verify route: no session, facility / number / date / amount only — never the patient; unknown codes 404; rate-limited", async () => {
    const id = await issuedBill();
    await post(`/v1/invoices/${id}/payments`, { method: "cash", amountPaisa: 230_000, tenderedPaisa: 230_000 });
    const rc = (await post(`/v1/invoices/${id}/receipts`)).json().receipt;
    const code = rc.verifyUrl.split("/").pop();
    const r = await get(`/v1/verify/rc/${code}`, null);
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json()).sort()).toEqual(["amountPaisa", "date", "facilityBn", "facilityEn", "number"]);
    expect(r.json()).toMatchObject({ facilityEn: "E2E Test Clinic", number: rc.number, amountPaisa: 230_000 });
    expect(r.body).not.toContain("Receipt Patient");
    expect(r.body).not.toContain("E2E-");
    expect((await get(`/v1/verify/rc/${"0".repeat(20)}`, null)).statusCode).toBe(404);
    expect((await get("/v1/verify/rc/not-a-code", null)).statusCode).toBe(404);
    let limited = false;
    for (let n = 0; n < 25 && !limited; n++) limited = (await get(`/v1/verify/rc/${"1".repeat(20)}`, null)).statusCode === 429;
    expect(limited).toBe(true);
  });
});

describe("receipt template", () => {
  const snapshot: ReceiptSnapshot = {
    seller: { nameEn: "Clinic", nameBn: "ক্লিনিক", address: null, vatBin: null, vatBinSample: false },
    invoice: { id: "i", number: "INV/26/0001", issuedAt: "2026-10-03T04:00:00Z" },
    patient: { nameBn: "রোগী", nameEn: "<script>alert(1)</script>", facilityNo: "X-1" },
    lines: [{ nameBn: "CBC", nameEn: "CBC", qty: 1, unitPaisa: 45_000, vatRateBp: 0, grossPaisa: 45_000, discountPaisa: 0, netPaisa: 45_000, vatPaisa: 0, totalPaisa: 45_000 }],
    subtotalPaisa: 45_000, discountPaisa: 0, vatPaisa: 0, totalPaisa: 45_000, paidPaisa: 45_000, duePaisa: 0, vatByRate: [{ rateBp: 0, netPaisa: 45_000, vatPaisa: 0 }],
    discount: null, paidBy: { paid: [{ method: "cash", amountPaisa: 45_000 }], pending: [] }, cashier: { nameBn: "ক", nameEn: "C" },
  };
  const base = { snapshot, number: "RCPT/26/0001", createdAt: new Date("2026-10-03T04:00:00Z"), verifyUrl: "http://x/verify/rc/ABC", format: "a5" as const, lang: "both" as const };
  const printedBy = { nameBn: "ক", nameEn: "C" };
  it("escapes record text, prints amounts and words from paisa, and marks only duplicates", () => {
    const orig = receiptHtml({ ...base, print: { copy: 0, reason: null, printedAt: new Date(), printedBy } });
    expect(orig).not.toContain("<script>alert(1)</script>");
    expect(orig).toContain("&lt;script&gt;");
    expect(orig).toContain("Four hundred fifty taka only");
    expect(orig).toContain("চার শত পঞ্চাশ টাকা মাত্র");
    expect(orig).not.toContain("DUPLICATE");
    const dup = receiptHtml({ ...base, print: { copy: 2, reason: "jam", printedAt: new Date(), printedBy } });
    expect(dup).toContain("DUPLICATE #2");
    expect(dup).toContain("অনুলিপি · DUPLICATE");
    expect(dup).toContain("Printer jam");
  });
  it("prints the Mushak-6.3 title and BIN only when the facility has a BIN", () => {
    const p = { copy: 0, reason: null, printedAt: new Date(), printedBy };
    expect(receiptHtml({ ...base, print: p })).not.toContain("Mushak-6.3");
    const withBin = receiptHtml({ ...base, snapshot: { ...snapshot, seller: { ...snapshot.seller, vatBin: "000123456-0101", vatBinSample: true } }, print: p });
    expect(withBin).toContain("Mushak-6.3");
    expect(withBin).toContain("000123456-0101 (নমুনা · sample)");
  });
});
