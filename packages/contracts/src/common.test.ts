import { describe, expect, it } from "vitest";
import { ApiError, PhoneDigits } from "./common.js";
describe("contracts", () => {
  it("phone digits accept only BD mobiles", () => {
    expect(PhoneDigits.safeParse("1711234567").success).toBe(true);
    expect(PhoneDigits.safeParse("0211234567").success).toBe(false);
  });
  it("errors carry both languages", () => {
    expect(ApiError.safeParse({ code: "x", message_bn: "ভুল", message_en: "wrong" }).success).toBe(true);
    expect(ApiError.safeParse({ code: "x", message_en: "wrong" }).success).toBe(false);
  });
});
