import { describe, expect, it } from "vitest";
import { DENOMINATIONS, acceptBlockers, countCheck, digitalRows, expectedCashPaisa, handOverBlockers, varianceJudgement } from "./shift.js";
import { SHIFT, can, transition } from "./machines.js";

describe("SHIFT machine (domain model, ADR 0008)", () => {
  it("open → counted → closed (hand over) → approved; recount sends it back to open from counted or closed", () => {
    expect(transition("shift", SHIFT, "open", "count")).toBe("counted");
    expect(transition("shift", SHIFT, "counted", "close")).toBe("closed");
    expect(transition("shift", SHIFT, "closed", "approve")).toBe("approved");
    expect(transition("shift", SHIFT, "closed", "recount")).toBe("open");
    expect(can(SHIFT, "approved", "recount")).toBe(false);
    expect(can(SHIFT, "open", "approve")).toBe(false);
  });
});

describe("cash count by denomination (prototype Billing › Shift close)", () => {
  it("notes 1000 … 1 taka; counted = Σ count × note, in paisa", () => {
    expect(DENOMINATIONS).toEqual([1000, 500, 200, 100, 50, 20, 10, 5, 2, 1]);
    expect(countCheck({ 1000: 40, 500: 3, 10: 7, 1: 3 })).toEqual({ ok: true, countedPaisa: (40_000 + 1_500 + 70 + 3) * 100 });
  });
  it("a count is a whole number ≥ 0 of a known note", () => {
    expect(countCheck({ 1000: -1 })).toEqual({ ok: false, error: "count_invalid", denomination: 1000 });
    expect(countCheck({ 500: 2.5 })).toEqual({ ok: false, error: "count_invalid", denomination: 500 });
    expect(countCheck({ 300: 1 } as never)).toEqual({ ok: false, error: "denomination_unknown", denomination: 300 });
    expect(countCheck({})).toEqual({ ok: true, countedPaisa: 0 });
  });
  it("security review #9: a count larger than ৳1 crore is refused (it would overflow, and no drawer holds it)", () => {
    expect(countCheck({ 1000: 10_000 })).toEqual({ ok: true, countedPaisa: 1_000_000_000 });
    expect(countCheck({ 1000: 10_001 })).toEqual({ ok: false, error: "count_too_large", denomination: 1000 });
  });
  it("expected cash = opening float + confirmed cash taken − cash refunds", () => {
    expect(expectedCashPaisa({ openingFloatPaisa: 200_000, cashInPaisa: 4_250_000, cashRefundPaisa: 50_000 })).toBe(4_400_000);
  });
});

describe("variance and hand-over (issue #24)", () => {
  it("variance = counted − expected; short, over or matched", () => {
    expect(varianceJudgement(-50_000)).toBe("short");
    expect(varianceJudgement(20_000)).toBe("over");
    expect(varianceJudgement(0)).toBe("matched");
  });
  it("a non-zero variance needs a reason (≥10 characters) to hand over; a matched count needs none", () => {
    expect(handOverBlockers({ variancePaisa: 0, reason: "" })).toEqual([]);
    expect(handOverBlockers({ variancePaisa: -50_000, reason: "" })).toEqual(["reason_required"]);
    expect(handOverBlockers({ variancePaisa: -50_000, reason: "short" })).toEqual(["reason_required"]);
    expect(handOverBlockers({ variancePaisa: -50_000, reason: "gave change twice to one patient" })).toEqual([]);
  });
  it("accepting a variance needs a note (≥10, issue #24) and an owner/admin who is not the cashier", () => {
    const base = { variancePaisa: -50_000, note: "accepted after checking the counter log", approverRole: "owner" as const, approverIsCashier: false };
    expect(acceptBlockers(base)).toEqual([]);
    expect(acceptBlockers({ ...base, note: "ok" })).toEqual(["note_required"]);
    expect(acceptBlockers({ ...base, variancePaisa: 0, note: "" })).toEqual([]);
    expect(acceptBlockers({ ...base, approverRole: "cashier" })).toContain("not_approver");
    expect(acceptBlockers({ ...base, approverIsCashier: true })).toContain("own_shift");
    expect(acceptBlockers({ ...base, approverRole: "admin" })).toEqual([]);
  });
});

describe("digital money: system vs settlement (shown, never blocking)", () => {
  it("matched / pending (no settlement entered) / mismatch with the difference", () => {
    const rows = digitalRows({ bkash: 4_130_000, nagad: 680_000, card: 2_215_000, bank: 0 }, { bkash: 4_130_000, card: 2_200_000 });
    expect(rows).toEqual([
      { method: "bkash", systemPaisa: 4_130_000, settlementPaisa: 4_130_000, state: "matched", diffPaisa: 0 },
      { method: "nagad", systemPaisa: 680_000, settlementPaisa: null, state: "pending", diffPaisa: null },
      { method: "card", systemPaisa: 2_215_000, settlementPaisa: 2_200_000, state: "mismatch", diffPaisa: -15_000 },
      { method: "bank", systemPaisa: 0, settlementPaisa: null, state: "matched", diffPaisa: 0 },
    ]);
  });
});
