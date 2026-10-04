/* BkashProvider: bKash tokenized checkout, v2 (ADR 0011; developer.bka.sh read 04/10/2026). Create → the patient pays
   on bKash's page → bKash sends the patient's browser back to us → we execute (money moves here, once) → query when in
   doubt. Every call is a POST with a 30 s timeout. The token is shared through the database (grant + refresh at most
   twice an hour, or the merchant app is blocked for an hour): renewed at ≤ 5 minutes left, refresh first. Field names
   are read both ways (`paymentId` / `paymentID`, `trxId` / `trxID`, `bkashURL` / `bKashURL`) because the docs mix them. */
import { LINK_WINDOW_MINUTES, parseWalletAmount, walletAmount } from "@setu/domain";
import { GatewayError, InvalidSignature, type ExecuteAnswer, type LinkRequest, type PaymentLink, type PaymentProvider, type ProviderStatus, type ProviderWebhook } from "./provider.js";

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
type Json = Record<string | symbol, unknown>;
const HTTP = Symbol("http status");
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export class BkashProvider implements PaymentProvider {
  readonly name = "bkash";
  readonly flow = "execute" as const;
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
      const call = async (path: string, body: Json) => { renewals.push(new Date(this.now())); try { return await this.post(path, body, this.authHeaders()); } catch { return {} as Json; } };
      const ok = (r: Json) => r.statusCode === "0000" && !!str(r.id_token);
      if (budget() <= 0) return { token: cur.token, renewals, error: "bKash token: the hourly renewal limit is reached — wait before trying again" };
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
    // the token was refused (HTTP 401 / 403 — not bKash's generic 9999 "system error"): renew within the budget, ask again
    if (j[HTTP] === 401 || j[HTTP] === 403) return this.post(path, body, { authorization: await this.token(id), "x-app-key": this.cfg.appKey });
    return j;
  }
  private async post(path: string, body: Json, headers: Record<string, string>): Promise<Json> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/${path}`, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
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

  /** Money moves here, once. `settled`: bKash's own answer decides it — Completed, or a refusal of this execute (the
      paymentId is spent). A timeout, a broken answer, "already completed" or an unreachable query is not settled: the
      claim stays and the sweep asks again later (money review: never fail a payment bKash may have completed). */
  async execute(providerRef: string): Promise<ExecuteAnswer> {
    let j: Json | null = null;
    try { j = await this.api("payment/execute", { paymentId: providerRef }); }
    catch (e) { if (!(e instanceof GatewayError) || e.code === "token") throw e; } // a timeout: ask, never execute again
    const e = j ? BkashProvider.errorOf(j) : null;
    if (j && !e) { const st = BkashProvider.status(j, providerRef); return { status: st, settled: st.status === "confirmed" }; }
    const ask = async () => { try { return await this.verify({ providerRef }); } catch { return null; } };
    // bKash refused this execute outright (not authorised, insufficient balance, …): spent, unless it says Completed
    if (e && !["2062", "2117", "503", "9999"].includes(e.code)) return { status: await ask(), settled: true };
    const st = await ask();
    return { status: st, settled: st?.status === "confirmed" };
  }

  /** bKash has no cancel for a payment that was never executed: it expires; we simply never execute it. */
  async cancel(): Promise<void> {}

  /** bKash tells us through the patient's return and our execute, not by webhook. */
  parseWebhook(): ProviderWebhook { throw new InvalidSignature(); }

  async refund(): Promise<never> { throw new Error("bKash refunds come with the refunds slice"); }
}
