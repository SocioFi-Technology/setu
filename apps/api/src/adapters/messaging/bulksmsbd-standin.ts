/* BulkSmsBdStandIn (ADR 0012): a local stand-in of BulkSMSBD's /api/smsapi for API tests and the hands-on. It checks the
   fields like the real one (1003 missing, 1001 bad number, 1002 wrong sender id, 1007 no balance), answers 202 and
   keeps every accepted message; GET /inbox shows them as a phone would (newest first). Nothing is sent anywhere. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const STANDIN_SMS = { apiKey: "standin-sms-key", senderId: "8809601000000" };
export interface StandInSms { at: Date; number: string; senderId: string; message: string; id: number }

export class BulkSmsBdStandIn {
  readonly messages: StandInSms[] = [];
  /** test hooks: answer the next sends with this code (e.g. 1007 balance) / hang this long (a timeout on our side) */
  nextCodes: number[] = [];
  slowNextMs = 0;
  private server: Server | null = null;
  baseUrl = "";
  private seq = 1000;

  async start(o: { port?: number; host?: string } = {}): Promise<string> {
    this.server = createServer((req, res) => { void this.handle(req, res).catch(() => { res.statusCode = 500; res.end(); }); });
    await new Promise<void>((ok) => this.server!.listen(o.port ?? 0, o.host ?? "127.0.0.1", () => ok()));
    const a = this.server.address();
    this.baseUrl = `http://${o.host ?? "127.0.0.1"}:${typeof a === "object" && a ? a.port : o.port}`;
    return `${this.baseUrl}/api/smsapi`;
  }
  async stop() { await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok())); }
  /** the messages one number received, oldest first */
  to(phone01: string) { return this.messages.filter((m) => m.number === `88${phone01}`); }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.baseUrl);
    if (req.method === "GET" && url.pathname === "/inbox") return this.inbox(res, url.searchParams.get("n"));
    if (url.pathname !== "/api/smsapi") { res.statusCode = 404; return res.end(); }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const q = req.method === "POST" ? new URLSearchParams(Buffer.concat(chunks).toString("utf8")) : url.searchParams;
    const json = (j: object) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(j)); };
    const fail = (code: number, msg: string) => json({ response_code: code, success_message: "", error_message: msg });
    // the forced answer belongs to this request even if it is slow (a test's next hook must not be taken by a late one)
    const forced = this.nextCodes.shift();
    if (this.slowNextMs) { const ms = this.slowNextMs; this.slowNextMs = 0; await new Promise((ok) => setTimeout(ok, ms)); }
    if (forced && forced !== 202) return fail(forced, forced === 1007 ? "Balance Insufficient" : forced === 1032 ? "ip Not whitelisted" : "Error");
    const [key, number, sender, message] = ["api_key", "number", "senderid", "message"].map((k) => q.get(k) ?? "");
    if (!key || !number || !sender || !message || !q.get("type")) return fail(1003, "Please Required all fields, or Contact Your System Administrator");
    if (key !== STANDIN_SMS.apiKey) return fail(1011, "User Id not found");
    if (sender !== STANDIN_SMS.senderId) return fail(1002, "sender id not correct/sender id is disabled");
    if (!/^8801[3-9]\d{8}$/.test(number)) return fail(1001, "Invalid Number");
    const id = this.seq++;
    this.messages.push({ at: new Date(), number, senderId: sender, message, id });
    return json({ response_code: 202, message_id: id, success_message: "SMS Submitted Successfully", error_message: "" });
  }

  private inbox(res: ServerResponse, n: string | null) {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    const list = this.messages.filter((m) => !n || m.number.endsWith(n.replace(/^0/, ""))).slice().reverse();
    const link = (s: string) => esc(s).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" data-testid="sms-link">$1</a>');
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>SMS inbox (stand-in)</title>
<style>body{font-family:system-ui;max-width:380px;margin:16px auto;padding:0 12px;background:#f3f4f6}.m{background:#fff;border-radius:12px;padding:10px 12px;margin:10px 0;white-space:pre-wrap;line-height:1.5}.h{color:#6b7280;font-size:12px}</style></head>
<body><h3>SMS inbox — local stand-in${n ? ` · ${esc(n)}` : ""}</h3><p class="h">Not a phone. What BulkSMSBD's stand-in accepted; nothing was sent.</p>
${list.map((m) => `<div class="m" data-testid="sms"><div class="h">${esc(m.senderId)} → +${esc(m.number)} · ${m.at.toISOString().slice(11, 19)} UTC</div>${link(m.message)}</div>`).join("") || "<p>No messages.</p>"}</body></html>`);
  }
}
