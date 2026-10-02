import { describe, expect, it } from "vitest";
import { age, ageLabel, date, dateTime, dose, parseDate, phone, taka, takaFromPaisa, time, toBn, toEn, words, wordsPaisa } from "./format.js";

describe("digits", () => {
  it("converts both ways", () => {
    expect(toBn("A-017")).toBe("A-০১৭");
    expect(toEn("০১৭১১২৩৪৫৬৭")).toBe("01711234567");
  });
});
describe("taka", () => {
  it("groups South-Asian style and hides .00", () => {
    expect(taka(125000)).toBe("৳ 1,25,000");
    expect(taka(12500000)).toBe("৳ 1,25,00,000");
    expect(taka(2415.5)).toBe("৳ 2,415.50");
    expect(taka(2415, { bn: true })).toBe("৳ ২,৪১৫");
    expect(takaFromPaisa(241550)).toBe("৳ 2,415.50");
  });
});
describe("words (receipt line)", () => {
  it("English", () => {
    expect(words(1200, "en")).toBe("One thousand two hundred taka only");
    expect(words(125000, "en")).toBe("One lakh twenty-five thousand taka only");
    expect(words(0, "en")).toBe("Zero taka only");
  });
  it("Bangla", () => {
    expect(words(1200, "bn")).toBe("এক হাজার দুই শত টাকা মাত্র");
    expect(words(2415.5, "bn")).toBe("দুই হাজার চার শত পনেরো টাকা পঞ্চাশ পয়সা মাত্র");
    expect(wordsPaisa(241_550, "bn")).toBe("দুই হাজার চার শত পনেরো টাকা পঞ্চাশ পয়সা মাত্র");
    expect(wordsPaisa(1, "en")).toBe("Zero taka and one paisa only");
    expect(() => wordsPaisa(10.5, "en")).toThrow();
  });
});
describe("dates and age", () => {
  it("formats and parses dd/mm/yyyy in either script", () => {
    expect(date(new Date(2026, 8, 29))).toBe("29/09/2026");
    expect(date(new Date(2026, 8, 29), true)).toBe("২৯/০৯/২০২৬");
    expect(parseDate("২৯/০৯/২০২৬")?.getFullYear()).toBe(2026);
    expect(parseDate("31/02/2026")).toBeNull();
  });
  it("computes age against a reference date", () => {
    const a = age(new Date(1984, 2, 15), new Date(2026, 8, 29));
    expect([a.y, a.m, a.d, a.future]).toEqual([42, 6, 14, false]);
    expect(ageLabel(a, "en")).toBe("42y 6m 14d");
    expect(age(new Date(2030, 0, 1), new Date(2026, 8, 29)).future).toBe(true);
  });
});
describe("phone", () => {
  it("normalises Bangladesh mobiles", () => {
    expect(phone("01711234567")).toEqual({ text: "+880 1711-234567", valid: true, digits: "1711234567" });
    expect(phone("+8801711234567").valid).toBe(true);
    expect(phone("০১৭১১২৩৪৫৬৭", true).text).toBe("+৮৮০ ১৭১১-২৩৪৫৬৭");
    expect(phone("0211234567").valid).toBe(false);
  });
});
describe("dose", () => {
  it("accepts 3 or 4 slot patterns", () => {
    expect(dose("১+০+১")).toMatchObject({ ok: true, perDay: 2, bn: "১+০+১" });
    expect(dose("1-0-1")).toMatchObject({ ok: true, perDay: 2 });
    expect(dose("½+½+½+½")).toMatchObject({ ok: true, perDay: 2 });
    expect(dose("1+1").ok).toBe(false);
    expect(dose("0+0+0")).toMatchObject({ ok: false, perDay: 0 }); // clinical review A5: not a dose
    expect(dose("০+০+০+০").ok).toBe(false);
  });
});
describe("time", () => {
  it("HH:mm and dd/mm/yyyy HH:mm, in Bangla or Latin digits", () => {
    const d = new Date(2026, 9, 2, 9, 5);
    expect(time(d)).toBe("09:05");
    expect(dateTime(d, true)).toBe("০২/১০/২০২৬ ০৯:০৫");
  });
});
