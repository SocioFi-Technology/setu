/* BkashSandboxStandIn: a local stand-in for the bKash tokenized checkout sandbox (ADR 0011), for API tests and the
   hands-on until Setu has sandbox credentials. It answers the documented v2 endpoints with the documented shapes and
   keeps bKash's rules: grant + refresh at most twice an hour, a paymentId executed once whatever the result (2062 the
   second time), Completed only after the patient authorised on the hosted page. The hosted page takes the sandbox test
   wallet (OTP 123456, PIN 12121) and sends the browser to the success / failure / cancel URL. Nothing leaves the
   machine and no money moves. Never used by a running API in production (it is a separate server you start). */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const STANDIN_CREDENTIALS = { appKey: "standin-app-key", appSecret: "standin-app-secret", username: "standin-user", password: "standin-pass" };
export const STANDIN_WALLET = { wallet: "01770618575", otp: "123456", pin: "12121" };
const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
const tok = (n: number) => Array.from(randomBytes(n), (b) => ALNUM[b % ALNUM.length]).join("");

interface StandInPayment {
  paymentId: string; amount: string; payerReference: string; merchantInvoiceNumber: string; callbackURL: string; signature: string;
  state: "initiated" | "authorised" | "completed" | "spent"; trxId: string | null; payerAccount: string | null; createdAt: Date;
  /** ADR 0013: refunds made against it (refund/payment/transaction) */
  refunds: { refundTrxId: string; amount: string; sku: string; reason: string; at: Date }[];
}
export interface StandInOptions { port?: number; host?: string }

export class BkashSandboxStandIn {
  readonly payments = new Map<string, StandInPayment>();
  private tokens = new Map<string, { refresh: string; expires: number }>();
  private renewals: number[] = [];
  private blockedUntil = 0;
  /** test hooks: the next execute hangs this long (a timeout on our side) but still completes at bKash */
  slowNextExecuteMs = 0;
  /** test hook: the next create answers with this error code (e.g. "2003" process failed, "503" maintenance) */
  failNextCreate: string | null = null;
  /** test hooks (refunds): the next refund hangs this long but is still made at bKash; the next refund is refused with this code */
  slowNextRefundMs = 0;
  failNextRefund: string | null = null;
  /** calls seen, by path (tests read them) */
  readonly calls: { path: string; body: Record<string, unknown> }[] = [];
  private server: Server | null = null;
  baseUrl = "";

  async start(o: StandInOptions = {}): Promise<string> {
    this.server = createServer((req, res) => { void this.handle(req, res).catch(() => { res.statusCode = 500; res.end(); }); });
    await new Promise<void>((ok) => this.server!.listen(o.port ?? 0, o.host ?? "127.0.0.1", () => ok()));
    const a = this.server.address();
    this.baseUrl = `http://${o.host ?? "127.0.0.1"}:${typeof a === "object" && a ? a.port : o.port}`;
    return this.apiUrl;
  }
  get apiUrl() { return `${this.baseUrl}/v2/tokenized-checkout`; }
  async stop() { await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok())); }

  /** The patient authorises on the hosted page (tests): returns the URL bKash would send the browser to. */
  authorise(paymentId: string): string {
    const p = this.payments.get(paymentId);
    if (!p) throw new Error(`stand-in: unknown payment ${paymentId}`);
    if (p.state === "initiated") { p.state = "authorised"; p.payerAccount = STANDIN_WALLET.wallet; }
    return this.redirect(p, "success");
  }
  redirect(p: StandInPayment, status: "success" | "failure" | "cancel") {
    const u = new URL(p.callbackURL);
    u.searchParams.set("paymentID", p.paymentId); u.searchParams.set("status", status); u.searchParams.set("signature", p.signature);
    return u.toString();
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    if ((req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  private json(res: ServerResponse, j: unknown, status = 200) { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(j)); }
  private fail(res: ServerResponse, code: string, en: string, internal = "error") { this.json(res, { internalCode: internal, externalCode: code, errorMessageEn: en, errorMessageBn: null }); }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const path = url.pathname;
    if (req.method === "GET" && path.startsWith("/checkout/")) return this.page(res, path.slice("/checkout/".length));
    if (req.method === "POST" && path.startsWith("/checkout/")) return this.pay(req, res, path.slice("/checkout/".length));
    if (req.method !== "POST" || !path.startsWith("/v2/tokenized-checkout/")) { res.statusCode = 404; return res.end(); }
    const op = path.slice("/v2/tokenized-checkout/".length);
    const b = await this.body(req);
    this.calls.push({ path: op, body: b });

    if (op === "auth/grant-token" || op === "auth/refresh-token") {
      const now = Date.now();
      if (now < this.blockedUntil) return this.json(res, { statusCode: "9999", statusMessage: "Too many token requests — blocked for an hour" });
      this.renewals = this.renewals.filter((t) => now - t < 3600_000);
      if (this.renewals.length >= 2) { this.blockedUntil = now + 3600_000; return this.json(res, { statusCode: "9999", statusMessage: "Too many token requests — blocked for an hour" }); }
      if (req.headers.username !== STANDIN_CREDENTIALS.username || req.headers.password !== STANDIN_CREDENTIALS.password || b.app_key !== STANDIN_CREDENTIALS.appKey || b.app_secret !== STANDIN_CREDENTIALS.appSecret)
        return this.json(res, { statusCode: "9999", statusMessage: "Invalid or unrecognized access credentials" });
      if (op === "auth/refresh-token" && ![...this.tokens.values()].some((t) => t.refresh === b.refresh_token)) return this.json(res, { statusCode: "9999", statusMessage: "System error" });
      this.renewals.push(now);
      const id = "ID" + tok(24), refresh = op === "auth/refresh-token" ? String(b.refresh_token) : "RF" + tok(24);
      this.tokens.set(id, { refresh, expires: now + 3600_000 });
      return this.json(res, { statusCode: "0000", statusMessage: "Successful", token_type: "Bearer", id_token: id, refresh_token: refresh, expires_in: 3600 });
    }

    const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const t = this.tokens.get(auth);
    if (req.headers["x-app-key"] !== STANDIN_CREDENTIALS.appKey) return this.fail(res, "2001", "Invalid App Key");
    if (!t || t.expires < Date.now()) return this.json(res, { statusCode: "9999", statusMessage: "Invalid or expired token" }, 401);

    if (op === "payment/create") {
      if (this.failNextCreate) { const c = this.failNextCreate; this.failNextCreate = null; return this.fail(res, c, "Process failed"); }
      for (const f of ["payerReference", "callbackURL", "amount", "currency", "intent", "merchantInvoiceNumber"]) if (!b[f]) return this.fail(res, "2065", "Mandatory field missing");
      if (b.currency !== "BDT") return this.fail(res, "2007", "Invalid currency.", "invalid_currency");
      if (!/^\d+(\.\d{1,2})?$/.test(String(b.amount)) || Number(b.amount) <= 0) return this.fail(res, "2006", "Invalid amount");
      if (String(b.merchantInvoiceNumber).includes("&") || String(b.merchantInvoiceNumber).length > 255) return this.fail(res, "2031", "Invalid merchant invoice number");
      const paymentId = "TR0011" + tok(16), signature = tok(10);
      const p: StandInPayment = { paymentId, amount: String(b.amount), payerReference: String(b.payerReference), merchantInvoiceNumber: String(b.merchantInvoiceNumber), callbackURL: String(b.callbackURL), signature, state: "initiated", trxId: null, payerAccount: null, createdAt: new Date(), refunds: [] };
      this.payments.set(paymentId, p);
      return this.json(res, {
        paymentId, bkashURL: `${this.baseUrl}/checkout/${paymentId}?mode=0011&apiVersion=v2`, callbackURL: p.callbackURL,
        successCallbackURL: this.redirect(p, "success"), failureCallbackURL: this.redirect(p, "failure"), cancelledCallbackURL: this.redirect(p, "cancel"),
        amount: p.amount, intent: "sale", currency: "BDT", paymentCreateTime: p.createdAt.toISOString(), transactionStatus: "Initiated", merchantInvoiceNumber: p.merchantInvoiceNumber, signature,
      });
    }
    const p = this.payments.get(String(b.paymentId ?? b.paymentID ?? ""));
    if (op === "payment/execute") {
      if (!p) return this.fail(res, "2002", "Invalid Payment ID");
      if (p.state === "completed" || p.state === "spent") return this.fail(res, "2062", "The payment has already been completed", "payment_already_completed");
      if (p.state !== "authorised") { p.state = "spent"; return this.fail(res, "2056", "Invalid Payment State"); }
      p.state = "completed"; p.trxId = "TRX" + tok(7);
      if (this.slowNextExecuteMs) { const ms = this.slowNextExecuteMs; this.slowNextExecuteMs = 0; await new Promise((ok) => setTimeout(ok, ms)); }
      return this.json(res, { paymentId: p.paymentId, trxId: p.trxId, transactionStatus: "Completed", amount: p.amount, currency: "BDT", intent: "sale", paymentExecuteTime: new Date().toISOString(), merchantInvoiceNumber: p.merchantInvoiceNumber, payerType: "Customer", payerReference: p.payerReference, payerAccount: p.payerAccount, maxRefundableAmount: p.amount });
    }
    if (op === "query/payment") {
      if (!p) return this.fail(res, "2002", "Invalid Payment ID");
      const done = p.state === "completed";
      return this.json(res, { paymentId: p.paymentId, verificationStatus: done ? "Complete" : "Incomplete", payerReference: p.payerReference, payerAccount: p.payerAccount, trxId: p.trxId ?? "", amount: p.amount, currency: "BDT", intent: "sale", merchantInvoice: p.merchantInvoiceNumber, transactionStatus: done ? "Completed" : "Initiated" });
    }
    /* Refund (ADR 0013, developer.bka.sh v2 read 05/10/2026): up to 10 partial refunds per transaction within the
       refundable amount and 60 days; no duplicate within 10 minutes. The documented codes are used; which code bKash
       gives a duplicate or an 11th refund is not documented — the stand-in answers "2901", a code the adapter does not
       know, which it must treat as "unknown — ask Refund Status" (Kamrul, decision 227). */
    if (op === "refund/payment/transaction") {
      if (this.failNextRefund) { const c = this.failNextRefund; this.failNextRefund = null; return this.fail(res, c, "Refund refused"); }
      if (!p) return this.fail(res, "2002", "Invalid Payment ID");
      if (p.state !== "completed") return this.fail(res, "2127", "Transaction not yet completed");
      if (b.trxId !== p.trxId) return this.fail(res, "2077", "Invalid TrxID");
      if (!b.sku) return this.fail(res, "2073", "Invalid SKU");
      if (String(b.sku).length > 255) return this.fail(res, "2075", "SKU Character Limit Exceeded");
      if (!b.reason) return this.fail(res, "2078", "Invalid Reason");
      if (String(b.reason).length > 255) return this.fail(res, "2076", "Reason Character Limit Exceeded");
      const cents = (v: string) => Math.round(Number(v) * 100);
      if (!/^\d+(\.\d{1,2})?$/.test(String(b.refundAmount)) || cents(String(b.refundAmount)) <= 0) return this.fail(res, "2072", "Refund amount not valid", "refund_amount_exceed_payment_amount");
      const done = p.refunds.reduce((a, r) => a + cents(r.amount), 0);
      if (done + cents(String(b.refundAmount)) > cents(p.amount)) return this.fail(res, "2072", "Refund amount not valid", "refund_amount_exceed_payment_amount");
      if (Date.now() - p.createdAt.getTime() > 60 * 864e5) return this.fail(res, "2071", "Refund after 60 days not allowed");
      if (p.refunds.length >= 10 || p.refunds.some((r) => r.amount === Number(b.refundAmount).toFixed(2) && Date.now() - r.at.getTime() < 10 * 60_000))
        return this.fail(res, "2901", "Duplicate refund request");
      const r = { refundTrxId: "RF" + tok(8), amount: Number(b.refundAmount).toFixed(2), sku: String(b.sku), reason: String(b.reason), at: new Date() };
      p.refunds.push(r);
      if (this.slowNextRefundMs) { const ms = this.slowNextRefundMs; this.slowNextRefundMs = 0; await new Promise((ok) => setTimeout(ok, ms)); }
      return this.json(res, { originalTrxId: p.trxId, refundTrxId: r.refundTrxId, refundTransactionStatus: "Completed", originalTrxAmount: p.amount, refundAmount: r.amount, currency: "BDT", completedTime: r.at.toISOString(), sku: r.sku, reason: r.reason });
    }
    if (op === "refund/payment/status") {
      if (!p) return this.fail(res, "2002", "Invalid Payment ID");
      if (b.trxId !== p.trxId) return this.fail(res, "3045", "Invalid TrxID", "ERROR_REFUND_TRANSACTION_ID_MISMATCH");
      return this.json(res, { originalTrxId: p.trxId, originalTrxAmount: p.amount, originalTrxCompletedTime: p.createdAt.toISOString(),
        refundTransactions: p.refunds.map((r) => ({ refundTrxId: r.refundTrxId, refundTransactionStatus: "Completed", refundAmount: r.amount, completedTime: r.at.toISOString() })) });
    }
    if (op === "general/search-transaction") {
      const hit = [...this.payments.values()].find((x) => x.trxId && x.trxId === b.trxId);
      if (!hit) return this.fail(res, "2002", "Invalid transaction ID");
      return this.json(res, { trxId: hit.trxId, transactionStatus: "Completed", amount: hit.amount, currency: "BDT", payerAccount: `88${hit.payerAccount}`, transactionType: "bKash Tokenized Checkout via API" });
    }
    res.statusCode = 404; res.end();
  }

  /* ── the hosted payment page (what the patient sees) ── */
  private page(res: ServerResponse, paymentId: string) {
    const p = this.payments.get(paymentId);
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (!p || p.state !== "initiated") { res.statusCode = 404; return res.end("<p>This payment is no longer available.</p>"); }
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>bKash (stand-in)</title>
<style>body{font-family:system-ui;max-width:360px;margin:24px auto;padding:0 16px}h1{color:#e2136e;font-size:20px}label{display:block;margin:10px 0 4px}input{width:100%;padding:8px;font-size:16px}button{margin-top:14px;padding:10px 14px;font-size:16px}.pay{background:#e2136e;color:#fff;border:0}.note{color:#666;font-size:13px}</style></head>
<body><h1>bKash checkout — local stand-in</h1><p class="note">Not bKash. A local stand-in of the sandbox; no money moves.</p>
<p>Merchant invoice <b>${p.merchantInvoiceNumber.replace(/[<>&"]/g, "")}</b><br>Amount <b data-testid="standin-amount">৳${p.amount}</b></p>
<form method="post" action="/checkout/${p.paymentId}">
<label>Wallet number<input name="wallet" data-testid="standin-wallet" value="${STANDIN_WALLET.wallet}"></label>
<label>Verification code (OTP)<input name="otp" data-testid="standin-otp" value=""></label>
<label>PIN<input name="pin" type="password" data-testid="standin-pin" value=""></label>
<button class="pay" name="action" value="pay" data-testid="standin-pay">Confirm</button>
<button name="action" value="cancel" data-testid="standin-cancel">Close</button>
</form></body></html>`);
  }
  private async pay(req: IncomingMessage, res: ServerResponse, paymentId: string) {
    const p = this.payments.get(paymentId);
    const b = await this.body(req);
    if (!p || p.state !== "initiated") { res.statusCode = 404; return res.end("This payment is no longer available."); }
    let to: string;
    if (b.action === "cancel") to = this.redirect(p, "cancel");
    else if (b.otp === STANDIN_WALLET.otp && b.pin === STANDIN_WALLET.pin) { p.state = "authorised"; p.payerAccount = String(b.wallet ?? STANDIN_WALLET.wallet); to = this.redirect(p, "success"); }
    else to = this.redirect(p, "failure");
    res.statusCode = 302; res.setHeader("location", to); res.end();
  }
}
