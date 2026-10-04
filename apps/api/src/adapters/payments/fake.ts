/* FakeProvider: a stand-in for bKash / Nagad in dev and tests. It keeps its links in memory (an API restart forgets
   them: a link from before the restart can only be retried) and signs its callbacks with HMAC-SHA256 over the raw
   body, like a real gateway. Nothing is sent anywhere and no money moves. `simulate` plays the customer's side: open
   the link, pay, or fail — with or without the callback reaching us (a lost callback is what "or TrxID" is for). */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ProviderEventKind } from "@setu/domain";
import { InvalidSignature, type LinkRequest, type PaymentLink, type PaymentProvider, type ProviderStatus, type ProviderWebhook } from "./provider.js";

export const FAKE_SIGNATURE_HEADER = "x-fake-signature";
const LINK_MINUTES = 15;
const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const token = (n: number) => Array.from(randomBytes(n), (b) => ALNUM[b % ALNUM.length]).join("");

interface FakeLink { providerRef: string; amountPaisa: number; reference: string; status: ProviderStatus["status"]; trxId: string | null; cancelled: boolean }

export class FakeProvider implements PaymentProvider {
  readonly name = "fake";
  readonly flow = "callback" as const;
  private links = new Map<string, FakeLink>();
  constructor(private secret: string) {}

  async createLink(req: LinkRequest): Promise<PaymentLink> {
    const providerRef = "FK" + token(16);
    this.links.set(providerRef, { providerRef, amountPaisa: req.amountPaisa, reference: req.reference, status: "pending", trxId: null, cancelled: false });
    return { providerRef, url: `https://pay.fake.setu.example/l/${providerRef}`, expiresAt: new Date(Date.now() + LINK_MINUTES * 60_000) };
  }

  async verify(q: { providerRef: string } | { trxId: string }): Promise<ProviderStatus | null> {
    const l = "providerRef" in q ? this.links.get(q.providerRef) : [...this.links.values()].find((x) => x.trxId !== null && x.trxId === q.trxId.toUpperCase());
    return l ? { providerRef: l.providerRef, status: l.status, trxId: l.trxId, amountPaisa: l.amountPaisa } : null;
  }

  async cancel(providerRef: string): Promise<void> {
    const l = this.links.get(providerRef);
    if (l && l.status !== "confirmed") { l.cancelled = true; l.status = "failed"; }
  }

  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): ProviderWebhook {
    const sig = headers[FAKE_SIGNATURE_HEADER];
    if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) throw new InvalidSignature();
    const want = Buffer.from(this.sign(rawBody), "hex");
    if (!timingSafeEqual(want, Buffer.from(sig, "hex"))) throw new InvalidSignature();
    const b = JSON.parse(rawBody) as Partial<ProviderWebhook>;
    if (typeof b.eventId !== "string" || typeof b.providerRef !== "string" || !["opened", "confirmed", "failed"].includes(b.kind as string)) throw new InvalidSignature();
    return { eventId: b.eventId, providerRef: b.providerRef, kind: b.kind as ProviderEventKind, trxId: b.trxId ?? null, amountPaisa: b.amountPaisa ?? null };
  }

  async execute(): Promise<never> { throw new Error("the fake gateway reports payments by callback; nothing to execute"); }

  async refund(): Promise<never> { throw new Error("refunds are not part of slice A6–A7"); }

  sign(rawBody: string): string { return createHmac("sha256", this.secret).update(rawBody).digest("hex"); }

  /** The customer's side. Returns the signed callback the gateway would send (body + headers), or null when the
      callback is "lost" (`deliver: false`) — the payment then shows up only through a TrxID check. `amountPaisa`
      overrides what the customer paid (tests of a mismatch). */
  simulate(providerRef: string, kind: ProviderEventKind, o: { deliver?: boolean; amountPaisa?: number; eventId?: string } = {}): { body: string; headers: Record<string, string>; trxId: string | null } | null {
    const l = this.links.get(providerRef);
    if (!l) throw new Error(`fake provider: unknown link ${providerRef}`);
    if (l.cancelled && kind !== "confirmed") throw new Error(`fake provider: link ${providerRef} was cancelled`);
    if (kind === "opened" && l.status === "pending") l.status = "opened";
    if (kind === "failed" && l.status !== "confirmed") l.status = "failed";
    if (kind === "confirmed") { l.status = "confirmed"; l.trxId ??= token(10); if (o.amountPaisa !== undefined) l.amountPaisa = o.amountPaisa; }
    if (o.deliver === false) return null;
    const body = JSON.stringify({ eventId: o.eventId ?? "EV" + token(16), providerRef, kind, trxId: kind === "confirmed" ? l.trxId : null, amountPaisa: kind === "confirmed" ? l.amountPaisa : null });
    return { body, headers: { "content-type": "application/json", [FAKE_SIGNATURE_HEADER]: this.sign(body) }, trxId: l.trxId };
  }
}
