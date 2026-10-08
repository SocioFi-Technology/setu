/* BkashProvider: bKash tokenized checkout, v2 (ADR 0011; developer.bka.sh read 04/10/2026). Create → the patient pays
   on bKash's page → bKash sends the patient's browser back to us → we execute (money moves here, once) → query when in
   doubt. Every call is a POST with a 30 s timeout. The token is shared through the database (grant + refresh at most
   twice an hour, or the merchant app is blocked for an hour): renewed at ≤ 5 minutes left, refresh first. Field names
   are read both ways (`paymentId` / `paymentID`, `trxId` / `trxID`, `bkashURL` / `bKashURL`) because the docs mix them. */
import { LINK_WINDOW_MINUTES, parseWalletAmount, walletAmount } from "@setu/domain";
import { GatewayError, InvalidSignature, type ExecuteAnswer, type LinkRequest, type PaymentLink, type PaymentProvider, type ProviderStatus, type ProviderWebhook, type RefundAnswer, type RefundCall, type RefundRecord } from "./provider.js";

export interface BkashConfig {
  /** e.g. https://tokenized.sandbox.bka.sh/v2/tokenized-checkout */
  baseUrl: string;
  appKey: string;
  appSecret: string;
  username: string;
  password: string;
  /** where bKash sends the patient back: <public API>/v1/payments/return/bkash */
  callbackUrl: string;
  timeoutMs?: number;
  /** production: the payment page must be bKash's own (the short link redirects the patient there) */
  linkHost?: RegExp;
}
export interface TokenRow { idToken: string; idExpiresAt: Date; refreshToken: string; refreshExpiresAt: Date }
export interface TokenState { token: TokenRow | null; renewals: Date[] }
/** Shared token storage: `renew` runs under a lock with the stored state and returns the state to store (or null). */
export type TokenStore = <R extends TokenState>(renew: (current: TokenState) => Promise<R | null>) => Promise<TokenState | R>;
/** bKash blocks the merchant app for an hour after a third grant / refresh in an hour: we stop at two (ours, counted). */
export const RENEWALS_PER_HOUR = 2;

const RENEW_AT_MS = 5 * 60_000;
/** a grant / refresh call inside the token lock is cut off after this (external review B6) */
const TOKEN_CALL_MS = 10_000;
type Json = Record<string | symbol, unknown>;
const HTTP = Symbol("http status");
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export class BkashProvider implements PaymentProvider {
  readonly name = "bkash";
  readonly flow = "execute" as const;
  readonly refundSupport = "gateway" as const;
  private cached: TokenRow | null = null;
  constructor(private cfg: BkashConfig, private store: TokenStore, private now: () => number = Date.now) {}

  /* ── the token ── */
  private fresh = (t: TokenRow | null): boolean => !!t && t.idExpiresAt.getTime() - this.now() > RENEW_AT_MS;
  /** `rejected`: a token bKash just refused — renewed even if not yet due (still within the hourly budget). Every grant
      and refresh call is recorded, failed ones too; past the budget we refuse locally rather than get blocked. */
  private async token(rejected?: string): Promise<string> {
    if (this.cached && this.fresh(this.cached) && this.cached.idToken !== rejected) return this.cached.idToken;
    const out = await this.store(async (cur) => {
      if (cur.token && this.fresh(cur.token) && cur.token.idToken !== rejected) return null; // another process renewed it
      const renewals = cur.renewals.filter((d) => this.now() - d.getTime() < 3600_000);
      const budget = () => RENEWALS_PER_HOUR - renewals.length;
      // external review B6: the token calls are short (they run inside the token lock) — at most 10 s each
      const call = async (path: string, body: Json) => { renewals.push(new Date(this.now())); try { return await this.post(path, body, this.authHeaders(), TOKEN_CALL_MS); } catch { return {} as Json; } };
      const ok = (r: Json) => r.statusCode === "0000" && !!str(r.id_token);
      // the budget is spent: a token that has not expired yet (only due for renewal) is still used until it does —
      // unless bKash has just refused it (external review C)
      const usable = !!cur.token && cur.token.idExpiresAt.getTime() > this.now() && cur.token.idToken !== rejected;
      if (budget() <= 0) return { token: cur.token, renewals, error: usable ? null : "bKash token: the hourly renewal limit is reached — wait before trying again" };
      const keys = { app_key: this.cfg.appKey, app_secret: this.cfg.appSecret };
      const t = cur.token, canRefresh = !!t && t.refreshExpiresAt.getTime() - this.now() > RENEW_AT_MS;
      let r = canRefresh ? await call("auth/refresh-token", { ...keys, refresh_token: t!.refreshToken }) : await call("auth/grant-token", keys);
      let refreshed = canRefresh;
      if (canRefresh && !ok(r) && budget() > 0) { r = await call("auth/grant-token", keys); refreshed = false; } // a refused refresh: one grant
      const id = str(r.id_token), refresh = str(r.refresh_token) ?? (refreshed ? t!.refreshToken : null);
      if (!ok(r) || !id || !refresh) return { token: cur.token, renewals, error: `bKash token: ${String(r.statusMessage ?? "no answer")}` };
      const life = typeof r.expires_in === "number" ? r.expires_in : Number(r.expires_in ?? 3600);
      return { renewals, error: null, token: {
        idToken: id, idExpiresAt: new Date(this.now() + (Number.isFinite(life) ? life : 3600) * 1000), refreshToken: refresh,
        // a refresh keeps the refresh token's own 30 days; a grant starts them
        refreshExpiresAt: refreshed && refresh === t!.refreshToken ? t!.refreshExpiresAt : new Date(this.now() + 30 * 864e5 - 3600_000),
      } };
    });
    const error = "error" in out ? (out as { error: string | null }).error : null;
    if (error) throw new GatewayError("token", error);
    if (!out.token || (!this.fresh(out.token) && out.token.idExpiresAt.getTime() <= this.now())) throw new GatewayError("token", "bKash token unavailable");
    this.cached = out.token;
    return out.token.idToken;
  }
  private authHeaders() { return { username: this.cfg.username, password: this.cfg.password }; }
  private async api(path: string, body: Json): Promise<Json> {
    const id = await this.token();
    const j = await this.post(path, body, { authorization: id, "x-app-key": this.cfg.appKey });
    // the token was refused: renew within the budget and ask again — only for an answer that is a token refusal and
    // nothing else (external review C). A 401 / 403 that carries a payment, a TrxID or a transaction status goes back to
    // the caller, which asks bKash's query (execute) or Refund Status (refund) — never sends a money call twice.
    if (BkashProvider.tokenRefused(j)) return this.post(path, body, { authorization: await this.token(id), "x-app-key": this.cfg.appKey });
    return j;
  }
  /** HTTP 401 / 403 whose body is only a refusal of the token (no business answer in it). bKash's exact shape is
      confirmed against the sandbox (open question 207); this accepts the documented message forms. */
  static tokenRefused(j: Json): boolean {
    if (j[HTTP] !== 401 && j[HTTP] !== 403) return false;
    const business = ["paymentID", "paymentId", "trxID", "trxId", "refundTrxID", "refundTrxId", "transactionStatus", "refundTransactionStatus", "amount"].some((k) => j[k] !== undefined && j[k] !== null && j[k] !== "");
    if (business) return false;
    const msg = `${String(j.statusMessage ?? "")} ${String(j.message ?? "")} ${String(j.errorMessage ?? "")}`;
    return /token|unauthori[sz]ed|expired|forbidden|not authenticated/i.test(msg);
  }
  private async post(path: string, body: Json, headers: Record<string, string>, capMs?: number): Promise<Json> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/${path}`, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(this.cfg.timeoutMs ?? 30_000, capMs ?? Infinity)),
      });
    } catch (e) {
      throw new GatewayError("unreachable", `bKash ${path}: ${(e as Error).name === "TimeoutError" ? "timed out" : "unreachable"}`);
    }
    const text = await res.text();
    let j: Json;
    try { j = JSON.parse(text) as Json; } catch { throw new GatewayError(`http-${res.status}`, `bKash ${path}: HTTP ${res.status}`); }
    if (typeof j !== "object" || j === null) throw new GatewayError(`http-${res.status}`, `bKash ${path}: HTTP ${res.status}`);
    Object.defineProperty(j, HTTP, { value: res.status, enumerable: false });
    return j;
  }
  /** The payment APIs' error shape: { internalCode, externalCode, errorMessageEn } (older: statusCode ≠ 0000). */
  private static errorOf(j: Json): GatewayError | null {
    const code = str(j.externalCode) ?? str(j.errorCode) ?? (j.statusCode && j.statusCode !== "0000" ? String(j.statusCode) : null);
    return code ? new GatewayError(code, `bKash ${code}: ${String(j.errorMessageEn ?? j.errorMessage ?? j.statusMessage ?? "error")}`) : null;
  }
  private static status(j: Json, fallbackRef: string): ProviderStatus {
    const ts = str(j.transactionStatus);
    return {
      providerRef: str(j.paymentId) ?? str(j.paymentID) ?? fallbackRef,
      status: ts === "Completed" ? "confirmed" : "pending",
      trxId: str(j.trxId) ?? str(j.trxID),
      amountPaisa: parseWalletAmount(j.amount) ?? 0,
    };
  }

  /* ── the interface ── */
  async createLink(req: LinkRequest): Promise<PaymentLink> {
    const j = await this.api("payment/create", {
      payerReference: `0${req.phone}`, callbackURL: this.cfg.callbackUrl, amount: walletAmount(req.amountPaisa), currency: "BDT", intent: "sale",
      // one merchant invoice number per attempt (a retry is a new bKash payment)
      merchantInvoiceNumber: `${req.invoiceNumber || "SETU"}-${req.reference.slice(-12)}-${req.attempt}`.replace(/&/g, ""),
    });
    const e = BkashProvider.errorOf(j);
    const providerRef = str(j.paymentId) ?? str(j.paymentID), url = str(j.bkashURL) ?? str(j.bKashURL);
    if (e) throw e;
    if (!providerRef || !url) throw new GatewayError("create", "bKash create: no paymentId or bkashURL");
    let host = "";
    try { const u = new URL(url); host = u.protocol === "https:" || !this.cfg.linkHost ? u.hostname : ""; } catch { /* not a URL */ }
    if (!host || (this.cfg.linkHost && !this.cfg.linkHost.test(host))) throw new GatewayError("create", "bKash create: the payment page is not on bKash's host");
    if (parseWalletAmount(j.amount) !== null && parseWalletAmount(j.amount) !== req.amountPaisa) throw new GatewayError("amount", "bKash create: the amount came back different");
    return { providerRef, url, expiresAt: new Date(this.now() + LINK_WINDOW_MINUTES * 60_000), signature: str(j.signature) };
  }

  async verify(q: { providerRef: string } | { trxId: string }): Promise<ProviderStatus | null> {
    // Search by TrxID does not say which payment it was (no paymentId): the API checks a TrxID against a payment's own
    // references instead (ADR 0011).
    if (!("providerRef" in q)) return null;
    const j = await this.api("query/payment", { paymentId: q.providerRef });
    const e = BkashProvider.errorOf(j);
    if (e) { if (e.code === "2002") return null; throw e; }
    return BkashProvider.status(j, q.providerRef);
  }

  /** The query after an execute: bKash's answer, "unknown" (no such payment / no answer we can read) or "unreachable"
      (timeout, network) — external review A4: only the first is an answer. */
  async ask(providerRef: string): Promise<ProviderStatus | "unknown" | "unreachable"> {
    try { return (await this.verify({ providerRef })) ?? "unknown"; }
    catch (e) { return e instanceof GatewayError && (e.code === "unreachable" || e.code.startsWith("http-")) ? "unreachable" : "unknown"; }
  }
  /** Money moves here, once. `settled`: bKash's own answer decides it — Completed, or a refusal of this execute (the
      paymentId is spent). A timeout, a broken answer, "already completed" or an unreachable query is not settled: the
      claim stays and the sweep asks again later (money review: never fail a payment bKash may have completed). */
  async execute(providerRef: string): Promise<ExecuteAnswer> {
    let j: Json | null = null;
    try { j = await this.api("payment/execute", { paymentId: providerRef }); }
    catch (e) { if (!(e instanceof GatewayError) || e.code === "token") throw e; } // a timeout: ask, never execute again
    const e = j ? BkashProvider.errorOf(j) : null;
    if (j && !e) { const st = BkashProvider.status(j, providerRef); return { status: st, settled: st.status === "confirmed" }; }
    const q = await this.ask(providerRef);
    // external review A4: settled only on a definite answer from bKash's query — an unreachable or unknown query never
    // fails a payment (the claim stays; the sweep asks again)
    if (typeof q === "string") return { status: null, settled: false };
    // bKash refused this execute outright (not authorised, insufficient balance, …): spent — the query decides it
    if (e && !["2062", "2117", "503", "9999"].includes(e.code)) return { status: q, settled: true };
    return { status: q, settled: q.status === "confirmed" };
  }

  /** bKash has no cancel for a payment that was never executed: it expires; we simply never execute it. */
  async cancel(): Promise<void> {}

  /** bKash tells us through the patient's return and our execute, not by webhook. */
  parseWebhook(): ProviderWebhook { throw new InvalidSignature(); }

  /* ── refunds (ADR 0013; developer.bka.sh v2 Refund / Refund Status, read 05/10/2026) ── */
  /** Refund codes after which nothing moved (bKash said no): the window (2071), the amount (2072), SKU / reason (2073,
      2075, 2076, 2078), cannot be reversed (2074), TrxID (2077), not permitted (2080–2082), merchant balance (2023), not
      yet completed (2127), unknown payment (2002). Anything else — a timeout, 503 / 9999, a broken answer, or a code we
      do not recognise (a duplicate refund, an 11th refund: undocumented) — may have refunded: ask Refund Status, and it
      is neither refunded nor failed until that answers (Kamrul, decision 227 — the lesson of the execute path). A
      duplicate answer for money we already recorded as paid changes nothing: only an allocation still "paying" is
      settled by an answer. */
  private static readonly REFUSED = new Set(["2002", "2023", "2071", "2072", "2073", "2074", "2075", "2076", "2077", "2078", "2080", "2081", "2082", "2127"]);
  async refund(req: RefundCall): Promise<RefundAnswer> {
    let j: Json | null = null;
    try {
      j = await this.api("refund/payment/transaction", { paymentId: req.providerRef, trxId: req.trxId, refundAmount: walletAmount(req.amountPaisa), sku: req.sku.slice(0, 255), reason: req.reason.slice(0, 255) });
    } catch (e) { if (!(e instanceof GatewayError) || e.code === "token") throw e; }
    const e = j ? BkashProvider.errorOf(j) : null;
    const refundTrxId = j ? str(j.refundTrxId) ?? str(j.refundTrxID) : null;
    if (j && !e && str(j.refundTransactionStatus) === "Completed" && refundTrxId) {
      if (parseWalletAmount(j.refundAmount) !== null && parseWalletAmount(j.refundAmount) !== req.amountPaisa) return { status: "unknown", refundTrxId: null, code: "amount" };
      return { status: "completed", refundTrxId, code: null };
    }
    if (e && BkashProvider.REFUSED.has(e.code)) return { status: "refused", refundTrxId: null, code: e.code };
    return this.findRefund(req, e?.code ?? "no-answer");
  }
  /** After an unclear answer: a completed refund of this payment for this amount that we have not recorded yet. */
  private async findRefund(req: RefundCall, why: string): Promise<RefundAnswer> {
    let list: RefundRecord[] | null = null;
    try { list = await this.refundStatus({ providerRef: req.providerRef, trxId: req.trxId }); } catch { /* still unknown */ }
    const hit = list?.find((r) => r.completed && r.amountPaisa === req.amountPaisa && !req.known.includes(r.refundTrxId));
    return hit ? { status: "completed", refundTrxId: hit.refundTrxId, code: null } : { status: "unknown", refundTrxId: null, code: why };
  }
  async refundStatus(q: { providerRef: string; trxId: string }): Promise<RefundRecord[] | null> {
    const j = await this.api("refund/payment/status", { paymentId: q.providerRef, trxId: q.trxId });
    const e = BkashProvider.errorOf(j);
    if (e) { if (["2002", "2077", "3045"].includes(e.code)) return null; throw e; }
    // Review: an answer we cannot read is not "nothing was refunded" — it throws (unknown), so nobody is told to pay again.
    // Field names are read both ways, as for payments (the docs mix them).
    const list = j.refundTransactions ?? j.refundTransaction;
    if (!Array.isArray(list)) throw new GatewayError("status-shape", "bKash refund status: no refund list in the answer");
    return (list as Json[]).map((r) => {
      const id = str(r.refundTrxId) ?? str(r.refundTrxID), amt = parseWalletAmount(r.refundAmount);
      if (!id || amt === null) throw new GatewayError("status-shape", "bKash refund status: a refund row we cannot read");
      return { refundTrxId: id, amountPaisa: amt, completed: str(r.refundTransactionStatus) === "Completed", completedAt: str(r.completedTime) };
    });
  }
}
