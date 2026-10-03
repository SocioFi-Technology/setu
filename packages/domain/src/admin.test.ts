import { describe, expect, it } from "vitest";
import { createUserBlockers, deactivateBlockers, goLiveBlockers, goLiveChecklist, isFlagged, labelPageOk, limitProblems, passwordProblems, pinProblems, priceChangeProblems, roleChangeBlockers, type GoLiveFacts } from "./admin.js";

const ready: GoLiveFacts = {
  plan: "clinic", org: { name: "Shapla Clinic", address: "House 4, Road 2, Mirpur", licenceNo: "DGHS-123" }, branches: 1, wardsWithBeds: 0,
  verifiedDoctors: 1, doctorsWithoutFee: 0, pricedItems: 5, receiptFormat: "a5", rxFormat: "a5", paymentMethods: ["cash"], smsTestedAt: "2026-10-04T05:00:00Z",
};

describe("go-live checklist (prototype Admin › Onboarding)", () => {
  it("a complete Clinic-plan facility can go live; wards are needed only on the hospital plans", () => {
    expect(goLiveBlockers(ready)).toEqual([]);
    expect(goLiveChecklist(ready).find((x) => x.item === "wards")).toMatchObject({ required: false });
    expect(goLiveBlockers({ ...ready, plan: "lite" })).toEqual(["wards"]);
    expect(goLiveBlockers({ ...ready, plan: "lite", wardsWithBeds: 1 })).toEqual([]);
  });
  it("each missing item blocks, in the prototype's order", () => {
    expect(goLiveBlockers({ ...ready, org: { ...ready.org, licenceNo: null }, verifiedDoctors: 0, paymentMethods: [], smsTestedAt: null })).toEqual(["organization", "doctor", "payment_method", "test_sms"]);
    expect(goLiveBlockers({ ...ready, doctorsWithoutFee: 1 })).toEqual(["price_list"]);
    expect(goLiveBlockers({ ...ready, rxFormat: null })).toEqual(["templates"]);
  });
});

describe("users and roles", () => {
  const owner = { id: "o", role: "owner" as const }, admin = { id: "a", role: "admin" as const };
  it("never yourself; only an owner makes or unmakes an owner", () => {
    expect(roleChangeBlockers({ actor: admin, target: { id: "a", role: "admin", active: true }, newRole: "cashier", activeApprovers: 3 })).toContain("self");
    expect(roleChangeBlockers({ actor: admin, target: { id: "c", role: "cashier", active: true }, newRole: "owner", activeApprovers: 2 })).toEqual(["owner_only"]);
    expect(roleChangeBlockers({ actor: owner, target: { id: "c", role: "cashier", active: true }, newRole: "owner", activeApprovers: 2 })).toEqual([]);
    expect(createUserBlockers("admin", "owner")).toEqual(["owner_only"]);
    expect(createUserBlockers("admin", "pharmacist")).toEqual([]);
  });
  it("the facility always keeps one active owner or admin", () => {
    expect(deactivateBlockers({ actor: owner, target: { id: "a", role: "admin", active: true }, activeApprovers: 1 })).toEqual(["last_approver"]);
    expect(deactivateBlockers({ actor: owner, target: { id: "a", role: "admin", active: true }, activeApprovers: 2 })).toEqual([]);
    expect(roleChangeBlockers({ actor: owner, target: { id: "a", role: "admin", active: true }, newRole: "cashier", activeApprovers: 1 })).toEqual(["last_approver"]);
    expect(deactivateBlockers({ actor: admin, target: { id: "c", role: "cashier", active: true }, activeApprovers: 1 })).toEqual([]);
  });
  it("first sign-in: a password of 8+ with a letter and a digit, not the phone; a 4-digit PIN that is not trivial", () => {
    expect(passwordProblems("abc", null)).toEqual(["too_short", "needs_letter_and_digit"]);
    expect(passwordProblems("greenlife7", "1712345678")).toEqual([]);
    expect(passwordProblems("x12345678", "1712345678")).toEqual(["contains_phone"]);
    expect(pinProblems("12a4")).toEqual(["four_digits"]);
    expect(pinProblems("1111")).toEqual(["too_simple"]);
    expect(pinProblems("1234")).toEqual(["too_simple"]);
    expect(pinProblems("2580")).toEqual([]);
  });
});

describe("settings, prices, audit flags", () => {
  it("approval limits: the cashier's limit never above the approver's; percent at most 50%", () => {
    expect(limitProblems({ cashierLimitPaisa: 50_000, cashierLimitBp: 500, approverLimitPaisa: 1_000_000 })).toEqual([]);
    expect(limitProblems({ cashierLimitPaisa: 2_000_000, cashierLimitBp: 500, approverLimitPaisa: 1_000_000 })).toEqual(["cashier_above_approver"]);
    expect(limitProblems({ cashierLimitPaisa: 50_000, cashierLimitBp: 6000, approverLimitPaisa: 1_000_000 })).toEqual(["percent_range"]);
    expect(labelPageOk(50, 30)).toBe(true);
    expect(labelPageOk(10, 30)).toBe(false);
  });
  it("a price change needs a reason; a new item does not; no change is not a change", () => {
    expect(priceChangeProblems({ oldUnitPaisa: 45_000, oldVatBp: 0, unitPaisa: 50_000, vatRateBp: 0, reason: "short" })).toEqual(["reason_required"]);
    expect(priceChangeProblems({ oldUnitPaisa: 45_000, oldVatBp: 0, unitPaisa: 45_000, vatRateBp: 0, reason: "Reagent cost went up" })).toEqual(["unchanged"]);
    expect(priceChangeProblems({ oldUnitPaisa: null, oldVatBp: null, unitPaisa: 30_000, vatRateBp: 0, reason: "" })).toEqual([]);
  });
  it("flags what the owner should see first", () => {
    for (const a of ["break-glass", "reprint", "void", "export", "deactivate", "price-change", "settings-change", "go-live"]) expect(isFlagged(a)).toBe(true);
    for (const a of ["view", "create", "login"]) expect(isFlagged(a)).toBe(false);
  });
});
