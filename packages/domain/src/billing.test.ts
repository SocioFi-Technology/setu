import { describe, expect, it } from "vitest";
import {
  allocateDiscount, approvalBlockers, billTotals, checkNewPayment, decideProviderEvent, discountDecision, discountLimit, discountToPaisa,
  divHalfUp, invoiceEventAfterConfirm, issueBlockers, paidBy, paymentSummary, type PaymentRow,
} from "./billing.js";
import { takaFromPaisa, wordsPaisa } from "./format.js";
import { PAYMENT, can } from "./machines.js";
import { vatOn } from "./money.js";

/* The walkthrough bill (Journey A6, prototype story A): the visit's consultation fee plus the three tests ordered in A5.
   Prices are the prototype's sample price list; every line is VAT-exempt. */
const WALKTHROUGH = [
  { key: "consult", unitPaisa: 80_000, qty: 1, vatRateBp: 0 },
  { key: "cbc", unitPaisa: 45_000, qty: 1, vatRateBp: 0 },
  { key: "rbs", unitPaisa: 15_000, qty: 1, vatRateBp: 0 },
  { key: "elec", unitPaisa: 90_000, qty: 1, vatRateBp: 0 },
];

describe("rounding rule: half-up to the paisa, integer arithmetic only", () => {
  it("divHalfUp rounds .5 up and everything below down", () => {
    expect(divHalfUp(15_000, 10_000)).toBe(2); // 1.5 → 2
    expect(divHalfUp(14_999, 10_000)).toBe(1);
    expect(divHalfUp(25_000, 10_000)).toBe(3); // 2.5 → 3 (not banker's rounding)
    expect(divHalfUp(0, 10_000)).toBe(0);
  });
  it("VAT on a line is half-up to the paisa: ৳10.10 at 15% = 151.5 paisa → 152", () => {
    expect(vatOn(1010, 1500)).toBe(152);
    expect(vatOn(10_000, 1500)).toBe(1500);
    expect(vatOn(80_000, 0)).toBe(0);
  });
  it("refuses fractions, negatives and unsafe numbers instead of rounding them", () => {
    expect(() => vatOn(10.5, 1500)).toThrow();
    expect(() => vatOn(-100, 1500)).toThrow();
    expect(() => billTotals([{ key: "x", unitPaisa: 99.9, qty: 1, vatRateBp: 0 }], 0)).toThrow();
    expect(() => billTotals([{ key: "x", unitPaisa: 100, qty: 0, vatRateBp: 0 }], 0)).toThrow();
    expect(() => billTotals([{ key: "x", unitPaisa: 100, qty: 1.5, vatRateBp: 0 }], 0)).toThrow();
  });
});

describe("walkthrough A6 bill — the printed total is proved before any route exists", () => {
  const t = billTotals(WALKTHROUGH, 0);
  it("lines and total are integer paisa: ৳800 + ৳450 + ৳150 + ৳900 = ৳2,300, VAT ৳0", () => {
    expect(t.lines.map((l) => l.totalPaisa)).toEqual([80_000, 45_000, 15_000, 90_000]);
    expect(t).toMatchObject({ subtotalPaisa: 230_000, discountPaisa: 0, netPaisa: 230_000, vatPaisa: 0, totalPaisa: 230_000 });
  });
  it("prints as ৳ 2,300 and in words in Bangla and English", () => {
    expect(takaFromPaisa(t.totalPaisa)).toBe("৳ 2,300");
    expect(takaFromPaisa(t.totalPaisa, { bn: true })).toBe("৳ ২,৩০০");
    expect(wordsPaisa(t.totalPaisa, "bn")).toBe("দুই হাজার তিন শত টাকা মাত্র");
    expect(wordsPaisa(t.totalPaisa, "en")).toBe("Two thousand three hundred taka only");
  });
  it("totals are the sums of the line paisa", () => {
    const s = (k: "grossPaisa" | "discountPaisa" | "netPaisa" | "vatPaisa" | "totalPaisa") => t.lines.reduce((a, l) => a + l[k], 0);
    expect([s("grossPaisa"), s("discountPaisa"), s("netPaisa"), s("vatPaisa"), s("totalPaisa")])
      .toEqual([t.subtotalPaisa, t.discountPaisa, t.netPaisa, t.vatPaisa, t.totalPaisa]);
  });
});

describe("bill-level discount split across lines (largest remainder, decision of 03/10/2026)", () => {
  it("৳500 on the ৳2,300 walkthrough bill: line discounts sum to exactly 50,000 paisa", () => {
    // exact shares 17391.30 · 9782.61 · 3260.87 · 19565.22 → floors leave 2 paisa, which go to RBS (.87) then CBC (.61)
    expect(allocateDiscount([80_000, 45_000, 15_000, 90_000], 50_000)).toEqual([17_391, 9_783, 3_261, 19_565]);
    const t = billTotals(WALKTHROUGH, 50_000);
    expect(t.lines.map((l) => l.netPaisa)).toEqual([62_609, 35_217, 11_739, 70_435]);
    expect(t).toMatchObject({ subtotalPaisa: 230_000, discountPaisa: 50_000, vatPaisa: 0, totalPaisa: 180_000 });
    expect(takaFromPaisa(t.totalPaisa)).toBe("৳ 1,800");
  });
  it("3 equal lines, ৳1 discount: naive per-line rounding gives 99 paisa (drift 1); largest remainder gives 100, ties by line order", () => {
    const naive = [100, 100, 100].map((g) => Math.round((g * 100) / 300));
    expect(naive.reduce((a, b) => a + b, 0)).toBe(99);
    expect(allocateDiscount([100, 100, 100], 100)).toEqual([34, 33, 33]);
  });
  it("3 lines of ৳10.10 at 15%: VAT per line (152 × 3 = 456) — never re-rounded from the bill (454.5 → 455)", () => {
    const t = billTotals([1, 2, 3].map((i) => ({ key: `l${i}`, unitPaisa: 1010, qty: 1, vatRateBp: 1500 })), 0);
    expect(t.lines.map((l) => l.vatPaisa)).toEqual([152, 152, 152]);
    expect(t.vatPaisa).toBe(456);
    expect(t.totalPaisa).toBe(3030 + 456);
  });
  it("VAT is charged per line after its share of the discount (prototype's other sample bill: ৳3,411.59, not ৳3,415)", () => {
    const lines = [
      ["consult", 80_000, 0], ["cbc", 45_000, 0], ["hba1c", 110_000, 0], ["lipid", 120_000, 0], ["creat", 50_000, 0], ["ure", 25_000, 0], ["card", 10_000, 1500],
    ].map(([key, unitPaisa, vatRateBp]) => ({ key: key as string, unitPaisa: unitPaisa as number, qty: 1, vatRateBp: vatRateBp as number }));
    const t = billTotals(lines, 100_000);
    const card = t.lines.find((l) => l.key === "card")!;
    expect(card).toMatchObject({ grossPaisa: 10_000, discountPaisa: 2_273, netPaisa: 7_727, vatPaisa: 1_159 });
    expect(t).toMatchObject({ subtotalPaisa: 440_000, discountPaisa: 100_000, vatPaisa: 1_159, totalPaisa: 341_159 });
  });
  it("a discount larger than the subtotal is refused, never capped", () => {
    expect(() => allocateDiscount([80_000], 80_001)).toThrow();
    expect(() => billTotals(WALKTHROUGH, 300_000)).toThrow();
  });
  it("percent discounts become paisa once, half-up", () => {
    expect(discountToPaisa({ mode: "percent", bp: 1000 }, 230_000)).toBe(23_000);
    expect(discountToPaisa({ mode: "percent", bp: 333 }, 1_000)).toBe(33); // 33.3 → 33
    expect(discountToPaisa({ mode: "percent", bp: 350 }, 1_000)).toBe(35); // 35.0
    expect(discountToPaisa({ mode: "percent", bp: 50 }, 100)).toBe(1); // 0.5 → 1
    expect(discountToPaisa({ mode: "amount", paisa: 50_000 }, 230_000)).toBe(50_000);
    expect(() => discountToPaisa({ mode: "percent", bp: 10_001 }, 1_000)).toThrow();
  });
});

describe("discount limit and approval (APPROVAL Task; nothing applied before approved)", () => {
  const settings = { cashierLimitPaisa: 50_000, cashierLimitBp: 500, approverLimitPaisa: 1_000_000 };
  it("cashier limit = lower of ৳500 and 5% of the subtotal: ৳115 on the walkthrough bill", () => {
    expect(discountLimit(230_000, settings)).toBe(11_500);
    expect(discountLimit(4_400_000, settings)).toBe(50_000);
  });
  it("within the limit applies now; above it needs approval; a reason (≥10 characters) and a category are required", () => {
    const base = { subtotalPaisa: 230_000, category: "poor" as const, reason: "Day labourer, doctor asked", settings };
    expect(discountDecision({ ...base, discountPaisa: 11_500 })).toEqual({ ok: true, kind: "within-limit", limitPaisa: 11_500 });
    expect(discountDecision({ ...base, discountPaisa: 50_000 })).toEqual({ ok: true, kind: "needs-approval", limitPaisa: 11_500 });
    expect(discountDecision({ ...base, discountPaisa: 50_000, reason: "poor" })).toMatchObject({ ok: false, code: "reason_too_short" });
    expect(discountDecision({ ...base, discountPaisa: 0 })).toMatchObject({ ok: false, code: "discount_not_positive" });
    expect(discountDecision({ ...base, discountPaisa: 230_001 })).toMatchObject({ ok: false, code: "discount_above_subtotal" });
  });
  it("owner or admin approves — never their own request, never above the approver limit", () => {
    const req = { requestedById: "u_cashier", amountPaisa: 50_000, settings };
    expect(approvalBlockers({ ...req, approverId: "u_owner", approverRole: "owner" })).toEqual([]);
    expect(approvalBlockers({ ...req, approverId: "u_admin", approverRole: "admin" })).toEqual([]);
    expect(approvalBlockers({ ...req, approverId: "u_cashier2", approverRole: "cashier" })).toEqual(["not_an_approver"]);
    expect(approvalBlockers({ ...req, requestedById: "u_owner", approverId: "u_owner", approverRole: "owner" })).toEqual(["own_request"]);
    expect(approvalBlockers({ ...req, amountPaisa: 1_000_001, approverId: "u_owner", approverRole: "owner" })).toEqual(["above_approver_limit"]);
  });
  it("a bill is issued (and so can be paid) only with lines, all priced, and no discount approval still requested", () => {
    expect(issueBlockers({ lineCount: 4, unpricedCount: 0, pendingApproval: false })).toEqual([]);
    expect(issueBlockers({ lineCount: 4, unpricedCount: 0, pendingApproval: true })).toEqual(["approval_pending"]);
    expect(issueBlockers({ lineCount: 4, unpricedCount: 1, pendingApproval: false })).toEqual(["unpriced_lines"]);
    expect(issueBlockers({ lineCount: 0, unpricedCount: 0, pendingApproval: false })).toEqual(["no_lines"]);
  });
});

describe("payments (walkthrough A7, issue #10)", () => {
  const TOTAL = 230_000;
  const bkashPending: PaymentRow = { id: "p1", method: "bkash", amountPaisa: 200_000, status: "link-sent" };
  const cash: PaymentRow = { id: "p2", method: "cash", amountPaisa: 30_000, status: "confirmed" };

  it("PAYMENT has no transition out of confirmed", () => {
    for (const e of ["sendLink", "customerOpened", "confirm", "fail", "retry"] as const) expect(can(PAYMENT, "confirmed", e)).toBe(false);
  });
  it("a pending wallet amount is reserved: cash can take only what is left (৳300), never more", () => {
    const s = paymentSummary(TOTAL, [bkashPending]);
    expect(s).toEqual({ totalPaisa: TOTAL, confirmedPaisa: 0, pendingPaisa: 200_000, duePaisa: TOTAL, openPaisa: 30_000 });
    expect(checkNewPayment(s, { method: "cash", amountPaisa: 30_000, tenderedPaisa: 200_000 })).toEqual({ ok: true, changePaisa: 170_000 });
    expect(checkNewPayment(s, { method: "cash", amountPaisa: 30_001, tenderedPaisa: 200_000 })).toMatchObject({ ok: false, code: "amount_over_open" });
  });
  it("cash needs tendered ≥ amount; card and bank need a reference; amounts are positive integer paisa", () => {
    const s = paymentSummary(TOTAL, []);
    expect(checkNewPayment(s, { method: "cash", amountPaisa: 30_000, tenderedPaisa: 29_999 })).toMatchObject({ ok: false, code: "tendered_short" });
    expect(checkNewPayment(s, { method: "card", amountPaisa: 30_000 })).toMatchObject({ ok: false, code: "reference_required" });
    expect(checkNewPayment(s, { method: "bank", amountPaisa: 30_000, reference: "  " })).toMatchObject({ ok: false, code: "reference_required" });
    expect(checkNewPayment(s, { method: "card", amountPaisa: 30_000, reference: "AP1234" })).toEqual({ ok: true, changePaisa: 0 });
    expect(checkNewPayment(s, { method: "bkash", amountPaisa: 0 })).toMatchObject({ ok: false, code: "amount_not_positive" });
    expect(checkNewPayment(s, { method: "bkash", amountPaisa: 100.5 })).toMatchObject({ ok: false, code: "amount_not_positive" });
  });
  it("issue #10: 'Paid by' lists only confirmed money; the pending bKash is marked pending; the bill is partially paid", () => {
    const rows = [bkashPending, cash];
    expect(paidBy(rows)).toEqual({ paid: [{ method: "cash", amountPaisa: 30_000 }], pending: [{ method: "bkash", amountPaisa: 200_000 }] });
    const s = paymentSummary(TOTAL, rows);
    expect(s).toMatchObject({ confirmedPaisa: 30_000, duePaisa: 200_000 });
    expect(invoiceEventAfterConfirm(TOTAL, s.confirmedPaisa)).toBe("payPart");
  });
  it("when bKash confirms, it joins the paid line with its TrxID and the bill is balanced", () => {
    const rows: PaymentRow[] = [{ ...bkashPending, status: "confirmed", trxId: "9KD72HX1QA" }, cash];
    expect(paidBy(rows)).toEqual({ paid: [{ method: "bkash", amountPaisa: 200_000, trxId: "9KD72HX1QA" }, { method: "cash", amountPaisa: 30_000 }], pending: [] });
    expect(invoiceEventAfterConfirm(TOTAL, paymentSummary(TOTAL, rows).confirmedPaisa)).toBe("payAll");
  });
  it("a failed wallet payment is neither paid nor pending, and frees its amount", () => {
    const rows: PaymentRow[] = [{ ...bkashPending, status: "failed" }];
    expect(paidBy(rows)).toEqual({ paid: [], pending: [] });
    expect(paymentSummary(TOTAL, rows).openPaisa).toBe(TOTAL);
  });
  it("confirming more than the total is impossible by construction, and is refused if it ever happens", () => {
    expect(() => invoiceEventAfterConfirm(TOTAL, TOTAL + 1)).toThrow();
  });
});

describe("provider callbacks: a repeat is a no-op, an out-of-order one is refused", () => {
  it("applies the forward moves", () => {
    expect(decideProviderEvent("link-sent", "opened")).toEqual({ outcome: "apply", event: "customerOpened", next: "waiting-customer" });
    expect(decideProviderEvent("link-sent", "confirmed")).toEqual({ outcome: "apply", event: "confirm", next: "confirmed" });
    expect(decideProviderEvent("waiting-customer", "confirmed")).toEqual({ outcome: "apply", event: "confirm", next: "confirmed" });
    expect(decideProviderEvent("waiting-customer", "failed")).toEqual({ outcome: "apply", event: "fail", next: "failed" });
  });
  it("a repeated callback changes nothing", () => {
    expect(decideProviderEvent("confirmed", "confirmed")).toEqual({ outcome: "noop" });
    expect(decideProviderEvent("failed", "failed")).toEqual({ outcome: "noop" });
    expect(decideProviderEvent("waiting-customer", "opened")).toEqual({ outcome: "noop" });
  });
  it("never moves a payment backwards", () => {
    expect(decideProviderEvent("confirmed", "failed")).toEqual({ outcome: "refused", reason: "backwards" });
    expect(decideProviderEvent("confirmed", "opened")).toEqual({ outcome: "refused", reason: "backwards" });
    expect(decideProviderEvent("failed", "opened")).toEqual({ outcome: "refused", reason: "backwards" });
  });
  it("money reported on a failed payment is refused here and goes to reconciliation (never applied silently)", () => {
    expect(decideProviderEvent("failed", "confirmed")).toEqual({ outcome: "refused", reason: "late-confirm" });
  });
  it("an event before the link was sent is out of order", () => {
    expect(decideProviderEvent("initiated", "opened")).toEqual({ outcome: "refused", reason: "out-of-order" });
  });
});

describe("typed amounts → paisa (no floating point)", () => {
  it("parses taka with up to 2 decimals, Bangla digits and grouping", async () => {
    const { parseTaka, parsePercentBp } = await import("./money.js");
    expect(parseTaka("2,300")).toBe(230_000);
    expect(parseTaka("৫০০.৫০")).toBe(50_050);
    expect(parseTaka("500.5")).toBe(50_050);
    expect(parseTaka("0.07")).toBe(7);
    expect(parseTaka("1.005")).toBeNull();
    expect(parseTaka("-5")).toBeNull();
    expect(parseTaka("abc")).toBeNull();
    expect(parseTaka("")).toBeNull();
    expect(parsePercentBp("10")).toBe(1000);
    expect(parsePercentBp("2.5")).toBe(250);
    expect(parsePercentBp("100.01")).toBeNull();
  });
});
