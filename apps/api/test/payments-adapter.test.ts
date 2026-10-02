/* FakeProvider (slice A6–A7): signed callbacks, verify by reference or TrxID, cancel before retry. No database. */
import { describe, expect, it } from "vitest";
import { FAKE_SIGNATURE_HEADER, FakeProvider, InvalidSignature } from "../src/adapters/payments/index.js";

const link = (p: FakeProvider) => p.createLink({ method: "bkash", amountPaisa: 200_000, reference: "pay_1", invoiceNumber: "INV/26/0001", phone: "1711234567" });

describe("FakeProvider", () => {
  it("creates a 15-minute link with a fresh reference each time", async () => {
    const p = new FakeProvider("s");
    const [a, b] = [await link(p), await link(p)];
    expect(a.providerRef).not.toBe(b.providerRef);
    expect(a.expiresAt.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(await p.verify({ providerRef: a.providerRef })).toEqual({ providerRef: a.providerRef, status: "pending", trxId: null, amountPaisa: 200_000 });
  });
  it("signs callbacks over the raw body; a tampered body or a wrong secret is refused", async () => {
    const p = new FakeProvider("s");
    const l = await link(p);
    const cb = p.simulate(l.providerRef, "confirmed")!;
    const ev = p.parseWebhook(cb.headers, cb.body);
    expect(ev).toMatchObject({ providerRef: l.providerRef, kind: "confirmed", amountPaisa: 200_000 });
    expect(ev.trxId).toMatch(/^[A-Z0-9]{10}$/);
    expect(() => p.parseWebhook(cb.headers, cb.body.replace("200000", "300000"))).toThrow(InvalidSignature);
    expect(() => new FakeProvider("other").parseWebhook(cb.headers, cb.body)).toThrow(InvalidSignature);
    expect(() => p.parseWebhook({ [FAKE_SIGNATURE_HEADER]: "nope" }, cb.body)).toThrow(InvalidSignature);
    expect(() => p.parseWebhook({}, cb.body)).toThrow(InvalidSignature);
  });
  it("a lost callback can still be found by its TrxID", async () => {
    const p = new FakeProvider("s");
    const l = await link(p);
    expect(p.simulate(l.providerRef, "confirmed", { deliver: false })).toBeNull();
    const st = await p.verify({ providerRef: l.providerRef });
    expect(st?.status).toBe("confirmed");
    expect(await p.verify({ trxId: st!.trxId!.toLowerCase() })).toMatchObject({ providerRef: l.providerRef, status: "confirmed" });
    expect(await p.verify({ trxId: "ZZZZZZZZZZ" })).toBeNull();
  });
  it("cancel makes an unpaid link fail; money paid on it later is still reported (for reconciliation)", async () => {
    const p = new FakeProvider("s");
    const l = await link(p);
    await p.cancel(l.providerRef);
    expect((await p.verify({ providerRef: l.providerRef }))?.status).toBe("failed");
    expect(() => p.simulate(l.providerRef, "opened")).toThrow();
    expect(p.simulate(l.providerRef, "confirmed")).not.toBeNull();
  });
});
