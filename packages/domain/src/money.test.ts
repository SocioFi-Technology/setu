/* External review C: money.ts had no test file of its own (vatOn / divHalfUp were tested from billing.test). Every
   amount is whole paisa; nothing here may use floating point to land on a paisa. */
import { describe, expect, it } from "vitest";
import { MAX_PAISA, assertPaisa, divHalfUp, paisaToInput, parsePercentBp, parseTaka, sum, taka, toTaka, vatOn } from "./money.js";

describe("parseTaka — what a cashier types → whole paisa", () => {
  it("whole taka, one or two decimals, commas, spaces, the taka sign and Bangla digits", () => {
    expect(parseTaka("2300")).toBe(230_000);
    expect(parseTaka("2,300")).toBe(230_000);
    expect(parseTaka("500.5")).toBe(50_050);
    expect(parseTaka("500.05")).toBe(50_005);
    expect(parseTaka(" ৳ 1,250.75 ")).toBe(125_075);
    expect(parseTaka("৫০০.৫০")).toBe(50_050);
    expect(parseTaka("0")).toBe(0);
  });
  it("refuses what is not an amount: three decimals, letters, a minus, empty, above the ceiling", () => {
    for (const bad of ["500.505", "12a", "-5", "", ".5", "5.", "1e3", "99999999.99"]) expect(parseTaka(bad), bad).toBeNull();
    expect(parseTaka("10000000")).toBe(MAX_PAISA); // ৳1 crore is the ceiling, allowed
    expect(parseTaka("10000000.01")).toBeNull();
  });
  it("never floats: 0.29 is 29 paisa (0.29 * 100 in floating point is 28.999…)", () => {
    expect(parseTaka("0.29")).toBe(29);
    expect(parseTaka("1.15")).toBe(115);
  });
});

describe("parsePercentBp — a percent → basis points", () => {
  it("whole and decimal percents, a % sign, Bangla digits", () => {
    expect(parsePercentBp("10")).toBe(1000);
    expect(parsePercentBp("2.5")).toBe(250);
    expect(parsePercentBp("12.75 %")).toBe(1275);
    expect(parsePercentBp("১৫")).toBe(1500);
    expect(parsePercentBp("100")).toBe(10_000);
  });
  it("refuses above 100, three decimals, negatives and text", () => {
    for (const bad of ["100.01", "101", "2.555", "-1", "ten", ""]) expect(parsePercentBp(bad), bad).toBeNull();
  });
});

describe("paisaToInput and the bounds", () => {
  it("paisa → the text an amount box shows, from integers only", () => {
    expect(paisaToInput(230_000)).toBe("2300");
    expect(paisaToInput(50_050)).toBe("500.50");
    expect(paisaToInput(5)).toBe("0.05");
    expect(paisaToInput(0)).toBe("0");
    for (const p of [1, 99, 100, 12_345, MAX_PAISA]) expect(parseTaka(paisaToInput(p))).toBe(p); // a round trip
  });
  it("assertPaisa refuses fractions, negatives, NaN and amounts above ৳1 crore", () => {
    expect(assertPaisa(0)).toBe(0);
    expect(assertPaisa(MAX_PAISA)).toBe(MAX_PAISA);
    for (const bad of [0.5, -1, Number.NaN, MAX_PAISA + 1, Infinity]) expect(() => assertPaisa(bad), String(bad)).toThrow(RangeError);
    expect(() => paisaToInput(-100)).toThrow(RangeError);
  });
  it("divHalfUp: half rounds up, below half down; guards its inputs", () => {
    expect(divHalfUp(5, 10)).toBe(1);
    expect(divHalfUp(4, 10)).toBe(0);
    expect(divHalfUp(15, 10)).toBe(2);
    expect(divHalfUp(0, 7)).toBe(0);
    for (const [n, d] of [[-1, 2], [1, 0], [1.5, 2], [1, -2]]) expect(() => divHalfUp(n!, d!)).toThrow(RangeError);
  });
  it("vatOn: basis points on a whole-paisa net, half-up; rates outside 0–100% refused", () => {
    expect(vatOn(10_000, 1500)).toBe(1500);
    expect(vatOn(333, 1500)).toBe(50); // 49.95 → 50
    expect(vatOn(331, 1500)).toBe(50); // 49.65 → 50
    expect(vatOn(330, 1500)).toBe(50); // 49.5 → 50
    expect(vatOn(329, 1500)).toBe(49); // 49.35 → 49
    expect(vatOn(12_345, 0)).toBe(0);
    for (const r of [-1, 10_001, 7.5]) expect(() => vatOn(1000, r)).toThrow(RangeError);
  });
  it("taka / toTaka / sum", () => {
    expect(taka(12.34)).toBe(1234);
    expect(toTaka(1234)).toBe(12.34);
    expect(sum([100, 250, 0])).toBe(350);
    expect(sum([])).toBe(0);
  });
});
