import { describe, expect, it } from "vitest";
import { answerOutcome, decideReturn, isLinkCode, parseWalletAmount, walletAmount, type ReturnFacts } from "./wallet.js";

describe("wallet amounts (ADR 0011)", () => {
  it("writes paisa as the gateway's amount string", () => {
    expect(walletAmount(50_000)).toBe("500.00");
    expect(walletAmount(290)).toBe("2.90");
    expect(walletAmount(5)).toBe("0.05");
    expect(walletAmount(123_456_789)).toBe("1234567.89");
    expect(() => walletAmount(0)).toThrow();
    expect(() => walletAmount(12.5)).toThrow();
  });
  it("reads the gateway's amount without floating-point drift", () => {
    expect(parseWalletAmount("500.00")).toBe(50_000);
    expect(parseWalletAmount("500")).toBe(50_000);
    expect(parseWalletAmount("2.9")).toBe(290);
    expect(parseWalletAmount(1234.56)).toBe(123_456);
    expect(parseWalletAmount(0.29)).toBe(29);
    for (const bad of ["", "5,00", "-5", "1.234", "1e3", null, undefined, {}, NaN]) expect(parseWalletAmount(bad)).toBeNull();
  });
  it("knows its own link codes", () => {
    expect(isLinkCode("ABCDEFGH23")).toBe(true);
    expect(isLinkCode("ABCDEFGH2O")).toBe(false); // O is not used
    expect(isLinkCode("ABCDEFGH2")).toBe(false);
  });
});

describe("the patient returns from the payment page (ADR 0011)", () => {
  const ok: ReturnFacts = { status: "success", payment: "link-sent", current: true, expired: false, claimed: false, signatureOk: true };
  it("executes a current, waiting, unexpired link with the right signature — once", () => {
    expect(decideReturn(ok)).toEqual({ action: "execute" });
    expect(decideReturn({ ...ok, payment: "waiting-customer" })).toEqual({ action: "execute" });
    expect(decideReturn({ ...ok, claimed: true })).toEqual({ action: "query" });
  });
  it("never executes a replaced, cancelled or expired link, or a forged redirect", () => {
    expect(decideReturn({ ...ok, current: false })).toEqual({ action: "refuse", reason: "ended" });
    expect(decideReturn({ ...ok, payment: "failed" })).toEqual({ action: "refuse", reason: "ended" });
    expect(decideReturn({ ...ok, expired: true })).toEqual({ action: "refuse", reason: "expired" });
    expect(decideReturn({ ...ok, signatureOk: false })).toEqual({ action: "refuse", reason: "signature" });
    expect(decideReturn({ ...ok, payment: "confirmed" })).toEqual({ action: "refuse", reason: "already-paid" });
  });
  it("asks the gateway on failure or cancel", () => {
    expect(decideReturn({ ...ok, status: "cancel" })).toEqual({ action: "query" });
    expect(decideReturn({ ...ok, status: "failure", expired: true })).toEqual({ action: "query" });
  });
});

describe("an execute or query answer (ADR 0011)", () => {
  const done = { transactionStatus: "Completed", amountPaisa: 50_000, trxId: "TRX123" };
  it("confirms only Completed, in full, with a TrxID", () => {
    expect(answerOutcome(done, 50_000, true)).toEqual({ outcome: "confirm", trxId: "TRX123" });
    expect(answerOutcome({ ...done, amountPaisa: 40_000 }, 50_000, true)).toEqual({ outcome: "mismatch" });
    expect(answerOutcome({ ...done, trxId: null }, 50_000, true)).toEqual({ outcome: "fail" });
  });
  it("after an execute attempt anything else is a failed payment; a query alone may still be pending", () => {
    expect(answerOutcome({ transactionStatus: "Initiated", amountPaisa: 50_000, trxId: null }, 50_000, true)).toEqual({ outcome: "fail" });
    expect(answerOutcome(null, 50_000, true)).toEqual({ outcome: "fail" });
    expect(answerOutcome({ transactionStatus: "Initiated", amountPaisa: 50_000, trxId: null }, 50_000, false)).toEqual({ outcome: "pending" });
    expect(answerOutcome(null, 50_000, false)).toEqual({ outcome: "pending" });
  });
});
