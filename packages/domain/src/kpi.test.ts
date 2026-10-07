import { describe, expect, it } from "vitest";
import { KPIS, kpiChange, medianMinutes, periodDays, sumUpToHour } from "./kpi.js";

describe("periods and what they are compared with (Dhaka days)", () => {
  // 03/10/2026 14:30 Dhaka = 08:30 UTC, a Saturday
  const now = new Date("2026-10-03T08:30:00Z");
  it("today is compared with the same weekday last week, up to the same hour", () => {
    expect(periodDays("today", now)).toEqual({ days: ["2026-10-03"], previous: ["2026-09-26"], uptoHour: 14, previousUntil: new Date("2026-09-26T08:30:00Z") });
  });
  it("7 days = today and the 6 before, against the 7 before those; 30 days likewise", () => {
    const p = periodDays("7d", now);
    expect(p.days).toEqual(["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(p.previous[0]).toBe("2026-09-20");
    expect(p.previous[6]).toBe("2026-09-26");
    expect(p.uptoHour).toBeNull();
    const m = periodDays("30d", now);
    expect(m.days).toHaveLength(30);
    expect(m.days[0]).toBe("2026-09-04");
    expect(m.previous).toHaveLength(30);
    expect(m.previous[29]).toBe("2026-09-03");
  });
  it("a partial day sums its hours up to the given hour", () => {
    const hours = Array.from({ length: 24 }, (_, h) => h * 10);
    expect(sumUpToHour(hours, 2)).toBe(0 + 10 + 20);
    expect(sumUpToHour(hours, null)).toBe(hours.reduce((a, b) => a + b, 0));
  });
});

describe("KPI change and its judgement (issue #23: real, varied changes)", () => {
  it("percent change rounded; up is better for revenue, worse for dues and discounts", () => {
    expect(kpiChange("revenue", 340_000, 350_000)).toEqual({ pct: -3, judgement: "worse" });
    expect(kpiChange("collections", 120, 100)).toEqual({ pct: 20, judgement: "better" });
    expect(kpiChange("dues", 37_300, 33_300)).toEqual({ pct: 12, judgement: "worse" });
    expect(kpiChange("discounts", 12_300, 10_400)).toEqual({ pct: 18, judgement: "worse" });
    expect(kpiChange("labTat", 50, 60)).toEqual({ pct: -17, judgement: "better" });
  });
  it("no change → same; nothing before → no percent", () => {
    expect(kpiChange("revenue", 100, 100)).toEqual({ pct: 0, judgement: "same" });
    expect(kpiChange("revenue", 100, 0)).toEqual({ pct: null, judgement: null });
    expect(kpiChange("revenue", 0, 0)).toEqual({ pct: null, judgement: null });
  });
  it("the cash variance is judged on its size, not its sign", () => {
    expect(kpiChange("cashVariance", -200, -500)).toEqual({ pct: -60, judgement: "better" });
  });
  it("tiles whose data comes with a later module say so instead of showing a number", () => {
    const later = KPIS.filter((k) => k.comesWith).map((k) => [k.key, k.comesWith]);
    expect(later).toEqual([["deposits", "ipd"], ["sharePayable", "ledger"]]);
    // pharmacy session 2: the stock and supplier tiles are live
    expect(KPIS.filter((k) => !k.comesWith).map((k) => k.key)).toEqual(["revenue", "collections", "dues", "discounts", "refunds", "supplierDues", "stockValue", "nearExpiry"]);
  });
});

describe("lab turnaround (external review B7: the median ADR 0008 names)", () => {
  it("the median of every test in the period, not the mean and not the median of daily medians", () => {
    // day 1: 30, 40, 400 (a mean of 157); day 2: 50
    expect(medianMinutes([[30, 40, 400], [50]])).toBe(45);
    expect(medianMinutes([[400, 30, 40]])).toBe(40);
    expect(medianMinutes([[30, 40, 400], [50], [60]])).toBe(50);
    expect(medianMinutes([[], undefined])).toBeNull();
  });
});

