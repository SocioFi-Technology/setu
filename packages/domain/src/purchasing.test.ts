import { describe, expect, it } from "vitest";
import { GOODS_RECEIPT, PURCHASE_ORDER, STOCK_COUNT, TransitionError, transition } from "./machines.js";
import {
  PO_APPROVAL_PAISA_SAMPLE, countDecisionBlockers, countSubmitBlockers, countVariance, grnLineBlockers, grnMoney, grnPostBlockers, poEventAfterReceipt, poSendBlockers,
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
  it("a short delivery becomes a debit note: billed 100 × ৳3.40, received 90 → owed ৳306, debit note ৳34", () => {
    expect(grnMoney([{ invoicedQty: 100, receivedQty: 90, costPaisa: 340 }])).toEqual({ invoicedPaisa: 34_000, debitNotePaisa: 3_400, owedPaisa: 30_600 });
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
