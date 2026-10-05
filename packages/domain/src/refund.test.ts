import { describe, expect, it } from "vitest";
import { DEFAULT_BILLING_SETTINGS, voidBlockers } from "./billing.js";
import { dispenseStatus, resaleBlockers } from "./pharmacy.js";
import {
  isSelfApproval, lineLock, partOfLine, payoutWayAllowed, recipientCheck, refundApprovalBlockers, refundRequestBlockers, returnSplit, refundSummary, refundWithdrawBlockers,
  type RequestInput,
} from "./refund.js";

/* The walkthrough bill (A6: Rahima Khatun, ৳2,300 = consultation 800 + CBC 450 + RBS 150 + S. Electrolytes 900, VAT 0)
   plus a desk certificate at 15% (৳200 + ৳30) — refunds are credit notes against these lines (ADR 0013). */
const cert = { totalPaisa: 23_000, netPaisa: 20_000, vatPaisa: 3_000, qty: 1 };

describe("which lines can be refunded (performed = locked)", () => {
  it("the consultation of a finished visit and a test whose specimen was collected are locked; an uncollected or revoked test and a desk item are not", () => {
    expect(lineLock({ source: "consultation", notBilled: false, leftPaisa: 80_000 })).toBe("performed");
    expect(lineLock({ source: "order", notBilled: false, leftPaisa: 45_000, order: { state: "in-progress", collected: true } })).toBe("performed");
    expect(lineLock({ source: "order", notBilled: false, leftPaisa: 45_000, order: { state: "complete", collected: true } })).toBe("performed");
    expect(lineLock({ source: "order", notBilled: false, leftPaisa: 15_000, order: { state: "active", collected: false } })).toBeNull();
    expect(lineLock({ source: "order", notBilled: false, leftPaisa: 15_000, order: { state: "revoked", collected: false } })).toBeNull();
    expect(lineLock({ source: "desk", notBilled: false, leftPaisa: 23_000 })).toBeNull();
    expect(lineLock({ source: "dispense", notBilled: false, leftPaisa: 1_000 })).toBeNull();
  });
  it("a 'Not billed here' line, and a line already refunded in full, have nothing to refund", () => {
    expect(lineLock({ source: "order", notBilled: true, leftPaisa: 0, order: { state: "active", collected: false } })).toBe("not-billed");
    expect(lineLock({ source: "desk", notBilled: false, leftPaisa: 0 })).toBe("nothing-left");
  });
});

describe("a part of a line keeps its VAT in proportion (credit-note lines)", () => {
  it("the whole of what is left is taken exactly", () => {
    expect(partOfLine(cert, { amountPaisa: 23_000 })).toEqual({ netPaisa: 20_000, vatPaisa: 3_000, totalPaisa: 23_000, units: null });
  });
  it("৳100 of the ৳230 certificate: VAT half-up in proportion (৳13.043 → ৳13.04), then the rest takes exactly what is left", () => {
    const a = partOfLine(cert, { amountPaisa: 10_000 })!;
    expect(a).toEqual({ netPaisa: 8_696, vatPaisa: 1_304, totalPaisa: 10_000, units: null });
    const left = { totalPaisa: cert.totalPaisa - a.totalPaisa, netPaisa: cert.netPaisa - a.netPaisa, vatPaisa: cert.vatPaisa - a.vatPaisa, qty: 1 };
    expect(partOfLine(left, { amountPaisa: 13_000 })).toEqual({ netPaisa: 11_304, vatPaisa: 1_696, totalPaisa: 13_000, units: null });
  });
  it("never leaves negative net or VAT behind, even for a tiny remainder", () => {
    const tiny = { totalPaisa: 3, netPaisa: 1, vatPaisa: 2, qty: 1 };
    for (const a of [1, 2]) {
      const p = partOfLine(tiny, { amountPaisa: a })!;
      expect(p.netPaisa + p.vatPaisa).toBe(a);
      expect(p.netPaisa).toBeLessThanOrEqual(tiny.netPaisa);
      expect(p.vatPaisa).toBeLessThanOrEqual(tiny.vatPaisa);
      expect(Math.min(p.netPaisa, p.vatPaisa)).toBeGreaterThanOrEqual(0);
    }
  });
  it("a medicine line by units: 4 of 10 tablets at ৳1.13 a tablet after a discount share", () => {
    const med = { totalPaisa: 1_130, netPaisa: 1_130, vatPaisa: 0, qty: 10 };
    expect(partOfLine(med, { units: 4 })).toEqual({ netPaisa: 452, vatPaisa: 0, totalPaisa: 452, units: 4 });
    expect(partOfLine(med, { units: 10 })).toEqual({ netPaisa: 1_130, vatPaisa: 0, totalPaisa: 1_130, units: 10 });
  });
  it("more than is left, zero, fractions and amount on a medicine line are refused", () => {
    expect(partOfLine(cert, { amountPaisa: 23_001 })).toBeNull();
    expect(partOfLine(cert, { amountPaisa: 0 })).toBeNull();
    expect(partOfLine(cert, { amountPaisa: 10.5 })).toBeNull();
    expect(partOfLine({ ...cert, qty: 10 }, { units: 11 })).toBeNull();
    expect(partOfLine({ ...cert, qty: 10 }, { units: 0 })).toBeNull();
  });
});

describe("how the money goes back (decision 2 with Kamrul's guards)", () => {
  it("cash back as cash only", () => {
    expect(payoutWayAllowed({ method: "cash", way: "cash", gatewayRefunds: false, stage: "request" })).toBe(true);
    expect(payoutWayAllowed({ method: "cash", way: "manual", gatewayRefunds: false, stage: "request" })).toBe(false);
  });
  it("bKash through the gateway; cash only when the patient has no wallet access, or at payout after the gateway refund failed", () => {
    expect(payoutWayAllowed({ method: "bkash", way: "gateway", gatewayRefunds: true, stage: "request" })).toBe(true);
    expect(payoutWayAllowed({ method: "bkash", way: "manual", gatewayRefunds: true, stage: "request" })).toBe(false);
    expect(payoutWayAllowed({ method: "bkash", way: "cash", gatewayRefunds: true, stage: "request" })).toBe(false);
    expect(payoutWayAllowed({ method: "bkash", way: "cash", gatewayRefunds: true, stage: "request", cashReason: "no-wallet-access" })).toBe(true);
    expect(payoutWayAllowed({ method: "bkash", way: "cash", gatewayRefunds: true, stage: "request", cashReason: "gateway-failed" })).toBe(false);
    expect(payoutWayAllowed({ method: "bkash", way: "cash", gatewayRefunds: true, stage: "payout", cashReason: "gateway-failed", gatewayFailed: false })).toBe(false);
    expect(payoutWayAllowed({ method: "bkash", way: "cash", gatewayRefunds: true, stage: "payout", cashReason: "gateway-failed", gatewayFailed: true })).toBe(true);
  });
  it("a wallet whose adapter has no refund API (Nagad, the fake) is refunded by hand with a reference", () => {
    expect(payoutWayAllowed({ method: "nagad", way: "manual", gatewayRefunds: false, stage: "request" })).toBe(true);
    expect(payoutWayAllowed({ method: "nagad", way: "gateway", gatewayRefunds: false, stage: "request" })).toBe(false);
  });
  it("card / bank by hand with a reference, or in cash (the owner approves that)", () => {
    expect(payoutWayAllowed({ method: "card", way: "manual", gatewayRefunds: false, stage: "request" })).toBe(true);
    expect(payoutWayAllowed({ method: "bank", way: "cash", gatewayRefunds: false, stage: "request" })).toBe(true);
    expect(payoutWayAllowed({ method: "card", way: "gateway", gatewayRefunds: false, stage: "request" })).toBe(false);
  });
});

describe("a refund request", () => {
  const ok: RequestInput = {
    source: "bill", kind: "refund", category: "cancelled-test", reason: "RBS not done — patient left before collection", billStatus: "balanced", openRefund: false,
    lines: [{ source: "order", lock: null, part: { netPaisa: 15_000, vatPaisa: 0, totalPaisa: 15_000, units: null } }],
    confirmedLeftPaisa: 230_000,
    allocations: [{ method: "cash", leftPaisa: 130_000, amountPaisa: 15_000, way: "cash", gatewayRefunds: false }],
  };
  it("RBS not collected, paid in cash, back in cash: nothing blocks it", () => expect(refundRequestBlockers(ok)).toEqual([]));
  it("needs a category, a reason of at least 10 characters and a line", () => {
    expect(refundRequestBlockers({ ...ok, reason: "not done" })).toContain("reason_too_short");
    expect(refundRequestBlockers({ ...ok, category: "whim" as never })).toContain("category_unknown");
    expect(refundRequestBlockers({ ...ok, lines: [] })).toContain("no_lines");
  });
  it("a performed line, a line over what is left, and a bill with another refund open are refused", () => {
    expect(refundRequestBlockers({ ...ok, lines: [{ ...ok.lines[0]!, lock: "performed" }] })).toContain("line_locked");
    expect(refundRequestBlockers({ ...ok, lines: [{ ...ok.lines[0]!, part: null }] })).toContain("line_over");
    expect(refundRequestBlockers({ ...ok, openRefund: true })).toEqual(["refund_open"]);
  });
  it("only an issued bill with money on it (not a draft, not a voided bill)", () => {
    expect(refundRequestBlockers({ ...ok, billStatus: "draft" })).toEqual(["bill_not_refundable"]);
    expect(refundRequestBlockers({ ...ok, billStatus: "entered-in-error" })).toEqual(["bill_not_refundable"]);
  });
  it("never more than the confirmed money left on the bill, nor than a payment holds, and allocations add up to the lines", () => {
    expect(refundRequestBlockers({ ...ok, confirmedLeftPaisa: 10_000 })).toContain("over_confirmed");
    expect(refundRequestBlockers({ ...ok, allocations: [{ ...ok.allocations[0]!, leftPaisa: 10_000 }] })).toContain("allocation_over");
    expect(refundRequestBlockers({ ...ok, allocations: [{ ...ok.allocations[0]!, amountPaisa: 14_000 }] })).toContain("allocation_mismatch");
    expect(refundRequestBlockers({ ...ok, allocations: [{ ...ok.allocations[0]!, way: "manual" }] })).toContain("payout_not_allowed");
  });
  it("'cancelled test' takes order lines only; 'wrong dispense' needs a medicine line; 'overpayment' only from a reconciliation case", () => {
    expect(refundRequestBlockers({ ...ok, lines: [{ ...ok.lines[0]!, source: "desk" }] })).toContain("category_line_mismatch");
    expect(refundRequestBlockers({ ...ok, category: "wrong-dispense" })).toContain("category_line_mismatch");
    expect(refundRequestBlockers({ ...ok, category: "wrong-dispense", lines: [{ ...ok.lines[0]!, source: "dispense" }] })).toEqual([]);
    expect(refundRequestBlockers({ ...ok, category: "overpayment" })).toContain("category_line_mismatch");
  });
  it("a reconciliation refund: no lines, one allocation, at most the case's amount, category overpayment", () => {
    const rc: RequestInput = { ...ok, source: "reconciliation", category: "overpayment", lines: [], confirmedLeftPaisa: 0, caseAmountPaisa: 20_000,
      allocations: [{ method: "nagad", leftPaisa: 20_000, amountPaisa: 20_000, way: "manual", gatewayRefunds: false }] };
    expect(refundRequestBlockers(rc)).toEqual([]);
    expect(refundRequestBlockers({ ...rc, allocations: [{ ...rc.allocations[0]!, amountPaisa: 20_001, leftPaisa: 20_001 }] })).toContain("over_case");
    expect(refundRequestBlockers({ ...rc, category: "patient-request" })).toContain("category_line_mismatch");
    expect(refundRequestBlockers({ ...rc, lines: ok.lines })).toContain("category_line_mismatch");
  });
});

describe("one refund = one payout method (Kamrul, decision 220)", () => {
  const base: RequestInput = {
    source: "bill", kind: "refund", category: "patient-request", reason: "Patient asked for the card fee back", billStatus: "balanced", openRefund: false,
    lines: [{ source: "desk", lock: null, part: { netPaisa: 30_000, vatPaisa: 0, totalPaisa: 30_000, units: null } }], confirmedLeftPaisa: 230_000,
    allocations: [{ method: "cash", leftPaisa: 20_000, amountPaisa: 20_000, way: "cash", gatewayRefunds: false }, { method: "cash", leftPaisa: 10_000, amountPaisa: 10_000, way: "cash", gatewayRefunds: false }],
  };
  it("two cash payments back in cash: one refund", () => expect(refundRequestBlockers(base)).toEqual([]));
  it("part cash, part bKash: two refunds, never one", () => {
    expect(refundRequestBlockers({ ...base, allocations: [base.allocations[0]!, { method: "bkash", leftPaisa: 10_000, amountPaisa: 10_000, way: "gateway", gatewayRefunds: true }] })).toContain("mixed_ways");
  });
  it("a gateway refund goes back against one payment (one call, paid whole)", () => {
    const gw = { method: "bkash" as const, leftPaisa: 15_000, amountPaisa: 15_000, way: "gateway" as const, gatewayRefunds: true };
    expect(refundRequestBlockers({ ...base, allocations: [gw, gw] })).toContain("gateway_one_payment");
  });
});

describe("a return on a pharmacy bill with a due (Kamrul, decisions 221 and 233)", () => {
  const med = (totalPaisa: number, units: number) => ({ source: "dispense" as const, lock: null, part: { netPaisa: totalPaisa, vatPaisa: 0, totalPaisa, units } });
  const ret: RequestInput = {
    source: "bill", kind: "return", category: "patient-request", reason: "Brought back unopened before paying", billStatus: "issued", openRefund: false,
    lines: [med(1_600, 4)], confirmedLeftPaisa: 0, duePaisa: 4_000, pendingPayments: 0, allocations: [],
  };
  it("233: credit = min(value, due), refund = the rest", () => {
    expect(returnSplit(1_600, 4_000)).toEqual({ creditPaisa: 1_600, refundPaisa: 0 });
    expect(returnSplit(100_000, 50_000)).toEqual({ creditPaisa: 50_000, refundPaisa: 50_000 }); // ৳1,000 back on a ৳1,000 bill half paid
    expect(returnSplit(30_000, 0)).toEqual({ creditPaisa: 0, refundPaisa: 30_000 });
  });
  it("nothing paid: the whole value is a credit, no allocations", () => {
    expect(refundRequestBlockers(ret)).toEqual([]);
    expect(refundRequestBlockers({ ...ret, allocations: [{ method: "cash", leftPaisa: 0, amountPaisa: 1_600, way: "cash", gatewayRefunds: false }] })).toContain("return_takes_no_money");
  });
  it("233: a ৳1,000 bill half paid, all ten tablets back — ৳500 credited, ৳500 refunded from the cash paid, one request", () => {
    const half: RequestInput = { ...ret, billStatus: "partially-paid", lines: [med(100_000, 10)], duePaisa: 50_000, confirmedLeftPaisa: 50_000,
      allocations: [{ method: "cash", leftPaisa: 50_000, amountPaisa: 50_000, way: "cash", gatewayRefunds: false }] };
    expect(refundRequestBlockers(half)).toEqual([]);
    expect(refundRequestBlockers({ ...half, allocations: [] })).toContain("no_allocations");
    expect(refundRequestBlockers({ ...half, allocations: [{ ...half.allocations[0]!, amountPaisa: 40_000 }] })).toContain("allocation_mismatch");
    expect(refundRequestBlockers({ ...half, confirmedLeftPaisa: 10_000 })).toContain("over_confirmed");
    expect(refundRequestBlockers({ ...half, allocations: [{ ...half.allocations[0]!, way: "manual" }] })).toContain("payout_not_allowed");
  });
  it("nothing due (fully paid): a refund, not a return; a pending payment waits; medicine only; no services", () => {
    expect(refundRequestBlockers({ ...ret, duePaisa: 0 })).toEqual(["money_on_bill"]);
    expect(refundRequestBlockers({ ...ret, pendingPayments: 1 })).toEqual(["payment_pending"]);
    expect(refundRequestBlockers({ ...ret, lines: [{ source: "desk", lock: null, part: { netPaisa: 100, vatPaisa: 0, totalPaisa: 100, units: null } }] })).toContain("category_line_mismatch");
    expect(refundRequestBlockers({ ...ret, billStatus: "draft" })).toEqual(["bill_not_refundable"]);
    expect(refundRequestBlockers({ ...ret, category: "cancelled-test" })).toContain("category_line_mismatch");
  });
});

describe("approving a refund (same rules as a discount, ADR 0013)", () => {
  const base = { approverId: "u-owner", approverRole: "owner", requestedById: "u-cashier", amountPaisa: 15_000, settings: DEFAULT_BILLING_SETTINGS, controlled: false, cardBankCash: false };
  it("owner or admin, never their own request, within the approver's limit", () => {
    expect(refundApprovalBlockers(base)).toEqual([]);
    expect(refundApprovalBlockers({ ...base, approverRole: "admin" })).toEqual([]);
    expect(refundApprovalBlockers({ ...base, approverRole: "cashier" })).toEqual(["not_an_approver"]);
    expect(refundApprovalBlockers({ ...base, requestedById: "u-owner" })).toEqual(["own_request"]);
    expect(refundApprovalBlockers({ ...base, amountPaisa: 1_000_001 })).toEqual(["above_approver_limit"]);
  });
  it("Kamrul, decision 223: the requester approves only when they are the facility's only approver — with a note, flagged", () => {
    expect(refundApprovalBlockers({ ...base, requestedById: "u-owner", onlyApprover: true, note: "I am the only approver here" })).toEqual([]);
    expect(refundApprovalBlockers({ ...base, requestedById: "u-owner", onlyApprover: true, note: "ok" })).toEqual(["note_required"]);
    expect(refundApprovalBlockers({ ...base, requestedById: "u-owner", onlyApprover: false, note: "I am the only approver here" })).toEqual(["own_request"]);
    expect(isSelfApproval({ approverId: "u-owner", requestedById: "u-owner" })).toBe(true);
  });
  it("a controlled drug, or card / bank money paid back in cash, needs the owner — not an admin", () => {
    expect(refundApprovalBlockers({ ...base, approverRole: "admin", controlled: true })).toEqual(["owner_only"]);
    expect(refundApprovalBlockers({ ...base, approverRole: "admin", cardBankCash: true })).toEqual(["owner_only"]);
    expect(refundApprovalBlockers({ ...base, controlled: true, cardBankCash: true })).toEqual([]);
  });
});

describe("withdrawing an approved refund", () => {
  it("owner / admin with a note, only before any part was paid out", () => {
    expect(refundWithdrawBlockers({ role: "owner", note: "Patient did not come back", anyPaid: false })).toEqual([]);
    expect(refundWithdrawBlockers({ role: "cashier", note: "Patient did not come back", anyPaid: false })).toEqual(["not_an_approver"]);
    expect(refundWithdrawBlockers({ role: "admin", note: "no", anyPaid: false })).toEqual(["note_too_short"]);
    expect(refundWithdrawBlockers({ role: "admin", note: "Patient did not come back", anyPaid: true })).toEqual(["part_paid"]);
  });
});

describe("who received the money (required at payout)", () => {
  it("name, a Bangladesh mobile number and the relationship to the patient", () => {
    expect(recipientCheck({ name: "Rashed Chowdhury", phone: "01711908812", relation: "spouse" })).toEqual({ ok: true, phone: "1711908812" });
    expect(recipientCheck({ name: "রাশেদ", phone: "০১৭১১৯০৮৮১২", relation: "spouse" })).toEqual({ ok: true, phone: "1711908812" });
    expect(recipientCheck({ name: "Rashed", phone: "+880 1711-908812", relation: "self" })).toEqual({ ok: true, phone: "1711908812" });
    expect(recipientCheck({ name: " ", phone: "01711908812", relation: "self" })).toEqual({ ok: false, field: "name" });
    expect(recipientCheck({ name: "Rashed", phone: "0171190881", relation: "self" })).toEqual({ ok: false, field: "phone" });
    expect(recipientCheck({ name: "Rashed", phone: "01211908812", relation: "self" })).toEqual({ ok: false, field: "phone" });
    expect(recipientCheck({ name: "Rashed", phone: "01711908812", relation: "neighbour" as never })).toEqual({ ok: false, field: "relation" });
  });
});

describe("the bill after refunds", () => {
  it("what can still be refunded = confirmed − refunds paid or open; nothing left = voidable", () => {
    expect(refundSummary({ confirmedPaisa: 230_000, paidRefundsPaisa: 15_000, openRefundsPaisa: 0 })).toEqual({ refundedPaisa: 15_000, refundablePaisa: 215_000, netPaisa: 215_000 });
    expect(refundSummary({ confirmedPaisa: 230_000, paidRefundsPaisa: 15_000, openRefundsPaisa: 45_000 }).refundablePaisa).toBe(170_000);
  });
  it("void (ADR 0005 addendum): a bill with money is voidable only when all of it was refunded, no refund is open and all medicine came back", () => {
    const ok = { role: "owner", status: "balanced" as const, confirmedPaisa: 230_000, refundedPaisa: 230_000, pendingPayments: 0, reason: "Billed to the wrong patient" };
    expect(voidBlockers(ok)).toEqual([]);
    expect(voidBlockers({ ...ok, refundedPaisa: 215_000 })).toEqual(["has_confirmed_money"]);
    expect(voidBlockers({ ...ok, openRefunds: 1 })).toEqual(["refund_open"]);
    expect(voidBlockers({ ...ok, unreturnedMedicine: 1 })).toEqual(["medicine_given"]);
    expect(voidBlockers({ ...ok, status: "partially-paid", confirmedPaisa: 100_000, refundedPaisa: 100_000 })).toEqual([]);
  });
});

describe("pharmacy returns (ADR 0009 addendum)", () => {
  it("returned units reopen the prescription line", () => {
    expect(dispenseStatus({ prescribed: 10, dispensed: 10, declined: false })).toBe("dispensed");
    expect(dispenseStatus({ prescribed: 10, dispensed: 10, returned: 10, declined: false })).toBe("to-dispense");
    expect(dispenseStatus({ prescribed: 10, dispensed: 10, returned: 4, declined: false })).toBe("partial");
  });
  it("quarantine → counter only with the pharmacist's 'unopened, resaleable' and a reason; never expired; controlled → the owner", () => {
    const ok = { role: "pharmacist", unopened: true, reason: "Strip sealed, returned same day", expired: false, controlled: false, inQuarantine: 4, qty: 4 };
    expect(resaleBlockers(ok)).toEqual([]);
    expect(resaleBlockers({ ...ok, unopened: false })).toEqual(["not_unopened"]);
    expect(resaleBlockers({ ...ok, reason: "fine" })).toEqual(["reason_too_short"]);
    expect(resaleBlockers({ ...ok, expired: true })).toEqual(["expired"]);
    expect(resaleBlockers({ ...ok, qty: 5 })).toEqual(["over_quarantine"]);
    expect(resaleBlockers({ ...ok, role: "cashier" })).toEqual(["not_a_pharmacist"]);
    expect(resaleBlockers({ ...ok, controlled: true })).toEqual(["owner_only"]);
    expect(resaleBlockers({ ...ok, controlled: true, role: "owner" })).toEqual([]);
  });
});
