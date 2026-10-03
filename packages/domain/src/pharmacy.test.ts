import { describe, expect, it } from "vitest";
import { MEDICINES_SAMPLE } from "./catalog.js";
import { batchState, dispenseStatus, doseLabel, fefoPick, nearExpiry, otcCheck, saleClass, substitutionBlockers, NEAR_EXPIRY_DAYS } from "./pharmacy.js";

const today = "2026-10-03";
const B = (id: string, expiry: string, qty: number, location = "counter") => ({ id, expiry, qty, location });

describe("FEFO (first expiry, first out) — prototype Pharmacy › Dispense", () => {
  it("takes the earliest-expiring usable batch first and splits across batches when one is short", () => {
    const r = fefoPick([B("late", "2027-04-30", 400), B("early", "2026-11-30", 60), B("mid", "2027-01-31", 10)], 75, today);
    expect(r).toEqual({ allocations: [{ batchId: "early", qty: 60 }, { batchId: "mid", qty: 10 }, { batchId: "late", qty: 5 }], shortfall: 0 });
  });
  it("never takes an expired batch, an empty one or one in quarantine; what is missing is the shortfall", () => {
    const r = fefoPick([B("exp", "2026-10-02", 100), B("empty", "2026-12-01", 0), B("q", "2027-01-01", 50, "quarantine"), B("ok", "2027-02-01", 20)], 30, today);
    expect(r).toEqual({ allocations: [{ batchId: "ok", qty: 20 }], shortfall: 10 });
  });
  it("a batch that expires today is still usable; one that expired yesterday is blocked", () => {
    expect(batchState(B("a", "2026-10-03", 5), today)).toBe("usable");
    expect(batchState(B("a", "2026-10-02", 5), today)).toBe("expired");
    expect(batchState(B("a", "2027-10-02", 0), today)).toBe("empty");
    expect(batchState(B("a", "2027-10-02", 5, "quarantine"), today)).toBe("quarantine");
  });
  it("near expiry = within 90 days (stock filter)", () => {
    expect(NEAR_EXPIRY_DAYS).toBe(90);
    expect(nearExpiry("2026-12-31", today)).toBe(true);
    expect(nearExpiry("2027-01-02", today)).toBe(false);
    expect(nearExpiry("2026-10-01", today)).toBe(false); // already expired is not "near"
  });
});

describe("a prescription line's dispense status (prescribed ≠ dispensed)", () => {
  it("to dispense / partial (the rest stays open) / dispensed / declined", () => {
    expect(dispenseStatus({ prescribed: 60, dispensed: 0, declined: false })).toBe("to-dispense");
    expect(dispenseStatus({ prescribed: 60, dispensed: 20, declined: false })).toBe("partial");
    expect(dispenseStatus({ prescribed: 60, dispensed: 60, declined: false })).toBe("dispensed");
    expect(dispenseStatus({ prescribed: 60, dispensed: 0, declined: true })).toBe("declined");
    expect(dispenseStatus({ prescribed: 60, dispensed: 20, declined: true })).toBe("partial-declined");
  });
});

describe("substitution (same generic, a reason, never against an allergy)", () => {
  const med = (id: string) => MEDICINES_SAMPLE.find((m) => m.id === id)!;
  it("another brand of the same generic, with a reason of at least 10 characters", () => {
    expect(substitutionBlockers({ prescribed: med("napa"), substitute: med("ace"), reason: "Napa out of stock today", allergies: [] })).toEqual([]);
    expect(substitutionBlockers({ prescribed: med("napa"), substitute: med("ace"), reason: "none", allergies: [] })).toEqual(["reason_required"]);
  });
  it("a different generic is not a substitute (the doctor decides that)", () => {
    expect(substitutionBlockers({ prescribed: med("seclo"), substitute: med("pantonix"), reason: "Seclo out of stock today", allergies: [] })).toEqual(["not_same_generic"]);
  });
  it("a substitute the patient is allergic to is refused", () => {
    const allergies = [{ id: "a", kind: "class" as const, key: "penicillin", labelBn: "পেনিসিলিন", labelEn: "Penicillin", reaction: null, severity: "moderate" as const }];
    expect(substitutionBlockers({ prescribed: med("moxacil"), substitute: med("fimoxyl"), reason: "Moxacil out of stock", allergies })).toContain("allergy");
  });
});

describe("over the counter (prototype Pharmacy › OTC sale)", () => {
  it("OTC items sell; prescription-only items need a prescription photo; controlled drugs never sell over the counter", () => {
    expect(saleClass("napa")).toBe("otc");
    expect(saleClass("moxacil")).toBe("rx");
    expect(saleClass("sedil")).toBe("ctrl");
    expect(otcCheck("otc", false)).toEqual([]);
    expect(otcCheck("rx", false)).toEqual(["rx_photo_required"]);
    expect(otcCheck("rx", true)).toEqual([]);
    expect(otcCheck("ctrl", true)).toEqual(["controlled"]);
  });
  it("an unknown medicine is treated as prescription-only", () => expect(saleClass("not-on-the-list")).toBe("rx"));
});

describe("the Bangla dose label (50 × 30 mm)", () => {
  it("names the times with a count, skips the zeros, then meal and days — Bangla digits on a Bangla label", () => {
    expect(doseLabel("1+0+1", "after", 30, "bn")).toBe("সকালে ১টি, রাতে ১টি · খাবারের পরে · ৩০ দিন");
    expect(doseLabel("1+1+1", "before", 5, "bn")).toBe("সকালে ১টি, দুপুরে ১টি, রাতে ১টি · খাবারের আগে · ৫ দিন");
    expect(doseLabel("0+0+1+1", "any", 7, "bn")).toBe("রাতে ১টি, ঘুমের আগে ১টি · যেকোনো সময় · ৭ দিন");
    expect(doseLabel("1+0+1", "after", 30, "en")).toBe("Morning 1, Night 1 · After food · 30 days");
  });
});
