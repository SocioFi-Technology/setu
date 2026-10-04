import { describe, expect, it } from "vitest";
import { bulkSmsNumber, bulkSmsOutcome, paymentLinkSmsOk } from "./sms.js";

describe("BulkSMSBD (ADR 0012)", () => {
  it("writes a Bangladesh mobile as 8801XXXXXXXXX", () => {
    expect(bulkSmsNumber("01711234567")).toBe("8801711234567");
    expect(bulkSmsNumber("1711234567")).toBe("8801711234567");
    expect(bulkSmsNumber("+8801911234567")).toBe("8801911234567");
    expect(bulkSmsNumber("01211234567")).toBeNull();
    expect(bulkSmsNumber("12345")).toBeNull();
  });
  it("202 is sent (never delivered); 1001 the number; account / balance / sender id / IP the facility's setup; else the gateway", () => {
    expect(bulkSmsOutcome(202)).toEqual({ status: "sent" });
    expect(bulkSmsOutcome("202")).toEqual({ status: "sent" });
    expect(bulkSmsOutcome(1001)).toEqual({ status: "failed", reason: "number" });
    for (const c of [1002, 1007, 1012, 1032]) expect(bulkSmsOutcome(c)).toEqual({ status: "failed", reason: "setup" });
    for (const c of [1003, 1005, 999, null]) expect(bulkSmsOutcome(c)).toEqual({ status: "failed", reason: "gateway" });
  });
  it("the payment-link template names only facility, bill number, amount and link", () => {
    expect(paymentLinkSmsOk("{facility}: bill {number}, ৳{amount} by bKash: {link}")).toBe(true);
    expect(paymentLinkSmsOk("{facility}: {patient} pay {link}")).toBe(false);
    expect(paymentLinkSmsOk("{facility}: pay now")).toBe(false);
  });
});
