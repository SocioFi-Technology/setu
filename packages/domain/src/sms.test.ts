import { describe, expect, it } from "vitest";
import { bulkSmsNumber, bulkSmsOutcome, paymentLinkSmsOk } from "./sms.js";

describe("BulkSMSBD (ADR 0012)", () => {
  it("stores the code with our own words, never the gateway's text; a facility name in an SMS carries no web address", async () => {
    const { bulkSmsCodeText, smsSafeName } = await import("./sms.js");
    expect(bulkSmsCodeText(1007)).toBe("BulkSMSBD 1007: balance insufficient");
    expect(bulkSmsCodeText(1016)).toBe("BulkSMSBD 1016: account or price setup");
    expect(bulkSmsCodeText("x")).toBe("BulkSMSBD ?: gateway error");
    expect(smsSafeName("Green Life — verify at http://evil.tld/x now")).toBe("Green Life — verify at now");
    expect(smsSafeName("www.bad.example Clinic")).toBe("Clinic");
  });
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
    expect(paymentLinkSmsOk("{facility}: bill {number}, ৳{amount} by bKash")).toBe(true);
    expect(paymentLinkSmsOk("{facility}: {patient} pay now")).toBe(false);
    expect(paymentLinkSmsOk("{facility}: {link}")).toBe(false);
  });
});
