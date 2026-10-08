/* External review C — bKash token handling against a scripted fake gateway (no database): a 401 is renewed and asked
   again only when it is a token refusal; a 401 carrying a business answer goes back to the caller (execute then asks
   the query — never executes twice); with the hourly renewal budget spent, a token that has not expired is still used. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BkashProvider, type TokenState, type TokenStore } from "../src/adapters/payments/bkash.js";

type Reply = { status: number; body: Record<string, unknown> };
let server: Server; let base = "";
const calls: { path: string; auth: string | undefined }[] = [];
const script = new Map<string, Reply[]>(); // path → replies, first used first; the last one repeats
let grants = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
      const path = (req.url ?? "").replace(/^\//, "");
      calls.push({ path, auth: req.headers.authorization });
      let r: Reply;
      if (path.startsWith("auth/")) { grants++; r = { status: 200, body: { statusCode: "0000", id_token: `tok-${grants}`, refresh_token: "ref", expires_in: 3600 } }; }
      else { const q = script.get(path) ?? []; r = (q.length > 1 ? q.shift() : q[0]) ?? { status: 404, body: {} }; }
      res.writeHead(r.status, { "content-type": "application/json" }); res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

let state: TokenState;
const store: TokenStore = async (renew) => { const r = await renew(state); if (r) state = { token: r.token, renewals: r.renewals }; return r ?? state; };
const provider = (now = Date.now) => new BkashProvider({ baseUrl: base, appKey: "k", appSecret: "s", username: "u", password: "p", callbackUrl: "https://setu.test/r", timeoutMs: 2000 }, store, now);
const completed = { status: 200, body: { statusCode: "0000", paymentID: "PAY1", trxID: "TRX1", transactionStatus: "Completed", amount: "100.00" } };
beforeEach(() => { calls.length = 0; script.clear(); grants = 0; state = { token: null, renewals: [] }; });
const n = (path: string) => calls.filter((c) => c.path === path).length;

describe("bKash token refusals (external review C)", () => {
  it("a 401 that is a token refusal: renewed once and asked again with the new token", async () => {
    script.set("payment/query", []);
    script.set("query/payment", [{ status: 401, body: { statusCode: "9999", statusMessage: "Invalid or expired token" } }, completed]);
    const st = await provider().ask("PAY1");
    expect(st).toMatchObject({ status: "confirmed", trxId: "TRX1" });
    expect(n("query/payment")).toBe(2);
    const q = calls.filter((c) => c.path === "query/payment");
    expect(q[0]!.auth).not.toBe(q[1]!.auth); // the second ask carries the renewed token
  });
  it("a 401 carrying a payment answer is not a token refusal: execute is sent once, then bKash's query decides", async () => {
    script.set("payment/execute", [{ status: 401, body: { paymentID: "PAY1", statusCode: "2056", statusMessage: "Unauthorized" } }]);
    script.set("query/payment", [completed]);
    const ex = await provider().execute("PAY1");
    expect(n("payment/execute")).toBe(1);
    expect(n("query/payment")).toBe(1);
    expect(ex.status).toMatchObject({ status: "confirmed", trxId: "TRX1" });
  });
  it("a 403 page without a token message (a proxy, a firewall) is not retried", async () => {
    script.set("query/payment", [{ status: 403, body: { error: "blocked by policy" } }]);
    expect(await provider().ask("PAY1")).not.toMatchObject({ status: "confirmed" });
    expect(n("query/payment")).toBe(1);
  });
});

describe("bKash token budget (external review C)", () => {
  it("the hourly budget spent: a token due for renewal but not expired is used until it expires; an expired one is refused", async () => {
    const t0 = Date.now();
    const twoAgo = [new Date(t0 - 10 * 60_000), new Date(t0 - 5 * 60_000)]; // two renewals this hour = the budget
    state = { token: { idToken: "old", idExpiresAt: new Date(t0 + 2 * 60_000), refreshToken: "ref", refreshExpiresAt: new Date(t0 + 864e5) }, renewals: twoAgo };
    script.set("query/payment", [completed]);
    expect(await provider(() => t0).ask("PAY1")).toMatchObject({ status: "confirmed" });
    expect(calls.find((c) => c.path === "query/payment")!.auth).toBe("old");
    expect(grants).toBe(0);
    // three minutes later the token has expired and the budget is still spent: refused locally, bKash is not called
    calls.length = 0;
    expect(await provider(() => t0 + 3 * 60_000).ask("PAY1")).toBe("unknown");
    expect(n("query/payment")).toBe(0);
    expect(grants).toBe(0);
  });
});
