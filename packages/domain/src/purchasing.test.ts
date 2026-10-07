import { describe, expect, it } from "vitest";
import { APPROVAL, GOODS_RECEIPT, PURCHASE_ORDER, STOCK_COUNT, TransitionError, transition } from "./machines.js";
import {
  DEFAULT_GRN_TOLERANCE, PO_APPROVAL_PAISA_SAMPLE, countDecisionBlockers, lineTolerancePaisa, priceBeyondTolerance, toleranceOk, isCountApprover, countSubmitBlockers, countVariance, grnLineBlockers, grnMoney, grnPostBlockers, poEventAfterReceipt, poSendBlockers,
  shortExpiry, supplierOwedPaisa,
} from "./purchasing.js";

const today = "2026-10-03";

describe("machines (ADR 0009)", () => {
  it("PURCHASE_ORDER: draft → sent → partially-received → received; closed short; cancelled only before goods arrive", () => {
    expect(transition("po", PURCHASE_ORDER, "draft", "send")).toBe("sent");
    expect(transition("po", PURCHASE_ORDER, "sent", "receivePart")).toBe("partially-received");
    expect(transition("po", PURCHASE_ORDER, "partially-received", "receiveAll")).toBe("received");
    expect(transition("po", PURCHASE_ORDER, "partially-received", "closeShort")).toBe("received");
    expect(transition("po", PURCHASE_ORDER, "sent", "cancel")).toBe("cancelled");
    expect(() => transition("po", PURCHASE_ORDER, "partially-received", "cancel")).toThrow(TransitionError);
    expect(() => transition("po", PURCHASE_ORDER, "received", "receivePart")).toThrow(TransitionError);
  });
  it("GOODS_RECEIPT: checking → posted | discarded; STOCK_COUNT: counting → submitted → approved | rejected", () => {
    expect(transition("grn", GOODS_RECEIPT, "checking", "post")).toBe("posted");
    expect(() => transition("grn", GOODS_RECEIPT, "posted", "discard")).toThrow(TransitionError);
    expect(transition("count", STOCK_COUNT, "submitted", "approve")).toBe("approved");
    expect(() => transition("count", STOCK_COUNT, "counting", "approve")).toThrow(TransitionError);
    // external review A6: a count left in progress at its counter's shift close is ended, never decided
    expect(transition("count", STOCK_COUNT, "counting", "abandon")).toBe("abandoned");
    // external review A6: a cancelled order's open request is withdrawn — not rejected; final
    expect(transition("approval", APPROVAL, "requested", "withdraw")).toBe("withdrawn");
    expect(() => transition("approval", APPROVAL, "approved", "withdraw")).toThrow(TransitionError);
    expect(() => transition("approval", APPROVAL, "withdrawn", "approve")).toThrow(TransitionError);
    expect(() => transition("count", STOCK_COUNT, "submitted", "abandon")).toThrow(TransitionError);
    expect(() => transition("count", STOCK_COUNT, "abandoned", "submit")).toThrow(TransitionError);
  });
});

describe("purchase orders", () => {
  const line = (qty: number, costPaisa: number) => ({ qty, costPaisa });
  it("above ৳50,000 (sample) the pharmacist asks for approval; the owner / admin sends it", () => {
    const big = [line(10_000, 600)]; // ৳60,000
    expect(PO_APPROVAL_PAISA_SAMPLE).toBe(5_000_000);
    expect(poSendBlockers({ lines: big, role: "pharmacist", approved: false })).toEqual(["approval_required"]);
    expect(poSendBlockers({ lines: big, role: "pharmacist", approved: true })).toEqual([]);
    expect(poSendBlockers({ lines: big, role: "owner", approved: false })).toEqual([]);
    expect(poSendBlockers({ lines: [line(100, 600)], role: "pharmacist", approved: false })).toEqual([]);
    expect(poSendBlockers({ lines: [], role: "owner", approved: false })).toEqual(["no_lines"]);
  });
  it("decision 179: the threshold is on the day's total to one supplier — two ৳30,000 orders the same day, the second asks", () => {
    const half = [line(5_000, 600)]; // ৳30,000
    expect(poSendBlockers({ lines: half, role: "pharmacist", approved: false, supplierDayPaisa: 0 })).toEqual([]);
    expect(poSendBlockers({ lines: half, role: "pharmacist", approved: false, supplierDayPaisa: 3_000_000 })).toEqual(["approval_required"]);
    expect(poSendBlockers({ lines: half, role: "pharmacist", approved: false, supplierDayPaisa: 2_000_000 })).toEqual([]); // exactly ৳50,000
    expect(poSendBlockers({ lines: half, role: "owner", approved: false, supplierDayPaisa: 3_000_000 })).toEqual([]);
    expect(poSendBlockers({ lines: half, role: "pharmacist", approved: true, supplierDayPaisa: 3_000_000 })).toEqual([]);
  });
  it("after a posting: all lines in full → received, otherwise partially received", () => {
    expect(poEventAfterReceipt([{ qty: 100, receivedQty: 100 }, { qty: 50, receivedQty: 50 }])).toBe("receiveAll");
    expect(poEventAfterReceipt([{ qty: 100, receivedQty: 80 }, { qty: 50, receivedQty: 50 }])).toBe("receivePart");
  });
});

describe("goods received (prototype Purchase › Goods received)", () => {
  const L = { orderedQty: 100, alreadyReceivedQty: 0, invoicedQty: 100, receivedQty: 100, batchNo: "CM2611", expiry: "2027-12-31", costPaisa: 340, mrpPaisa: 400, orderCostPaisa: 340 };
  it("a clean line has no blockers; each check names its problem", () => {
    expect(grnLineBlockers(L, today)).toEqual([]);
    expect(grnLineBlockers({ ...L, batchNo: " " }, today)).toEqual(["batch_required"]);
    expect(grnLineBlockers({ ...L, expiry: "2026-02-30" }, today)).toEqual(["expiry_invalid"]);
    expect(grnLineBlockers({ ...L, expiry: "2026-10-02" }, today)).toEqual(["expired"]);
    expect(grnLineBlockers({ ...L, receivedQty: 101, invoicedQty: 101 }, today)).toEqual(["over_order"]);
    expect(grnLineBlockers({ ...L, receivedQty: 100, invoicedQty: 90 }, today)).toEqual(["over_invoice"]);
    expect(grnLineBlockers({ ...L, mrpPaisa: 300 }, today)).toEqual(["mrp_below_cost"]);
    expect(grnLineBlockers({ ...L, alreadyReceivedQty: 40, receivedQty: 70, invoicedQty: 70 }, today)).toEqual(["over_order"]);
  });
  it("a batch expiring within 6 months needs the owner / admin to post it", () => {
    expect(shortExpiry("2027-03-31", today)).toBe(true);
    expect(shortExpiry("2027-04-01", today)).toBe(false);
    const short = { ...L, expiry: "2027-01-31" };
    expect(grnPostBlockers({ lines: [short], role: "pharmacist", today })).toEqual(["short_expiry_needs_owner"]);
    expect(grnPostBlockers({ lines: [short], role: "owner", today })).toEqual([]);
    expect(grnPostBlockers({ lines: [], role: "owner", today })).toEqual(["no_lines"]);
  });
  it("a bill at another unit cost than the order is posted only by the owner / admin (it changes what is owed)", () => {
    expect(grnPostBlockers({ lines: [{ ...L, costPaisa: 3400, mrpPaisa: 4000 }], role: "pharmacist", today })).toEqual(["price_variance_needs_owner"]);
    expect(grnPostBlockers({ lines: [{ ...L, costPaisa: 3400, mrpPaisa: 4000 }], role: "owner", today })).toEqual([]);
  });
  it("decision 180: within min(2 %, ৳50) per line the pharmacist posts it; beyond, the owner / admin", () => {
    const T = DEFAULT_GRN_TOLERANCE;
    expect(T).toEqual({ bp: 200, paisa: 5_000 });
    // 100 × ৳3.40 = ৳340 at the order's cost: 2 % = ৳6.80 < ৳50 → ৳6.80 allowed
    expect(lineTolerancePaisa(L, T)).toBe(680);
    expect(priceBeyondTolerance({ ...L, costPaisa: 346 }, T)).toBe(false); // ৳6.00 over
    expect(priceBeyondTolerance({ ...L, costPaisa: 347 }, T)).toBe(true); // ৳7.00 over
    expect(priceBeyondTolerance({ ...L, costPaisa: 333 }, T)).toBe(true); // ৳7.00 under: a variance either way
    expect(grnPostBlockers({ lines: [{ ...L, costPaisa: 346 }], role: "pharmacist", today, tolerance: T })).toEqual([]);
    expect(grnPostBlockers({ lines: [{ ...L, costPaisa: 347 }], role: "pharmacist", today, tolerance: T })).toEqual(["price_variance_needs_owner"]);
    // a big line: 10,000 × ৳30 = ৳300,000 → 2 % = ৳6,000, capped at ৳50
    const big = { ...L, orderedQty: 10_000, invoicedQty: 10_000, receivedQty: 10_000, costPaisa: 3_000, orderCostPaisa: 3_000, mrpPaisa: 4_000 };
    expect(lineTolerancePaisa(big, T)).toBe(5_000);
    expect(priceBeyondTolerance({ ...big, costPaisa: 3_001 }, T)).toBe(true); // ৳100 over
    // no tolerance given (a facility set to zero): any difference needs the owner
    expect(grnPostBlockers({ lines: [{ ...L, costPaisa: 341 }], role: "pharmacist", today })).toEqual(["price_variance_needs_owner"]);
    expect(toleranceOk(T)).toBe(true);
    expect(toleranceOk({ bp: 1001, paisa: 0 })).toBe(false);
    expect(toleranceOk({ bp: 100, paisa: -1 })).toBe(false);
  });
  it("a short delivery becomes a debit note: billed 100 × ৳3.40, received 90 → owed ৳306, debit note ৳34", () => {
    expect(grnMoney([{ invoicedQty: 100, receivedQty: 90, costPaisa: 340 }])).toEqual({ invoicedPaisa: 34_000, debitNotePaisa: 3_400, owedPaisa: 30_600 });
    // decision 321: VAT billed on top adds to what is owed
    expect(supplierOwedPaisa([{ kind: "goods-received", amountPaisa: 10_000 }, { kind: "supplier-vat", amountPaisa: 750 }, { kind: "payment", amountPaisa: 5_000 }])).toBe(5_750);
    expect(supplierOwedPaisa([{ kind: "goods-received", amountPaisa: 34_000 }, { kind: "debit-note", amountPaisa: 3_400 }, { kind: "payment", amountPaisa: 10_000 }])).toBe(20_600);
  });
});

describe("stock counts (prototype Count & adjust)", () => {
  it("every batch counted; a variance needs a reason; stock moves by counted − system once approved", () => {
    expect(countSubmitBlockers([{ systemQty: 60, countedQty: null, reason: null }])).toEqual(["not_counted"]);
    expect(countSubmitBlockers([{ systemQty: 60, countedQty: 58, reason: "two" }])).toEqual(["reason_required"]);
    expect(countSubmitBlockers([{ systemQty: 60, countedQty: 58, reason: "Two strips damaged by water" }, { systemQty: 10, countedQty: 10, reason: null }])).toEqual([]);
    expect(countVariance([{ systemQty: 60, countedQty: 58, reason: "x" }, { systemQty: 10, countedQty: 12, reason: "x" }])).toEqual([-2, 2]);
  });
  it("only the owner / admin decides, never their own count; a rejection needs a note", () => {
    expect(countDecisionBlockers({ role: "pharmacist", isCounter: false, decision: "approve", note: "" })).toEqual(["not_approver"]);
    expect(countDecisionBlockers({ role: "owner", isCounter: true, decision: "approve", note: "" })).toEqual(["own_count"]);
    // decision 234 (= 223): the only approver may decide their own count, with a note
    expect(countDecisionBlockers({ role: "owner", isCounter: true, decision: "approve", note: "", onlyApprover: true })).toEqual(["note_required"]);
    expect(countDecisionBlockers({ role: "owner", isCounter: true, decision: "approve", note: "Only approver at this facility", onlyApprover: true })).toEqual([]);
    expect(countDecisionBlockers({ role: "owner", isCounter: true, decision: "approve", note: "Only approver at this facility", onlyApprover: false })).toEqual(["own_count"]);
    expect(countDecisionBlockers({ role: "admin", isCounter: false, decision: "reject", note: "recount" })).toEqual(["note_required"]);
    expect(countDecisionBlockers({ role: "owner", isCounter: false, decision: "approve", note: "" })).toEqual([]);
  });
});

describe("ward stock counts (Kamrul, 06/10/2026)", () => {
  it("a ward count is decided by the pharmacist or the owner; the store keeps the owner / admin", () => {
    expect(isCountApprover("pharmacist", "ward:w3b")).toBe(true);
    expect(isCountApprover("owner", "ward:w3b")).toBe(true);
    expect(isCountApprover("nurse", "ward:w3b")).toBe(false);
    expect(isCountApprover("admin", "ward:w3b")).toBe(false);
    expect(isCountApprover("pharmacist", "store")).toBe(false);
    expect(countDecisionBlockers({ role: "pharmacist", isCounter: false, decision: "approve", note: "", location: "ward:w3b" })).toEqual([]);
    expect(countDecisionBlockers({ role: "nurse", isCounter: true, decision: "approve", note: "", location: "ward:w3b" })).toEqual(["not_approver", "own_count"]);
    // the same self-approval rule: the counter decides only as the only approver, with a note
    expect(countDecisionBlockers({ role: "pharmacist", isCounter: true, decision: "approve", note: "short", onlyApprover: true, location: "ward:w3b" })).toEqual(["note_required"]);
  });
});

