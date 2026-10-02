/* Billing contracts (slice A6–A7). Every amount on the wire is integer paisa (`Paisa`); the screen prints them through
   @setu/domain format.takaFromPaisa and never does money arithmetic of its own — totals, the discount split, VAT and
   the "Paid by" line come from @setu/domain billing.ts on the server. A bill is a draft until issued; a discount above
   the cashier's limit is an APPROVAL Task, and the bill cannot be issued (so cannot be paid) while it is requested. A
   wallet payment is Paid only when the provider confirms it; until then it is listed as pending. */
import { z } from "zod";
import { Paisa } from "./common.js";
import { VitalsEncounter } from "./vitals.js";

const Person = z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() });
const Rev = z.number().int().min(1);

export const InvoiceStatus = z.enum(["draft", "issued", "partially-paid", "balanced", "cancelled"]);
export const PaymentStatus = z.enum(["initiated", "link-sent", "waiting-customer", "confirmed", "failed"]);
export const PaymentMethod = z.enum(["cash", "card", "bank", "bkash", "nagad"]);
export const ChargeSource = z.enum(["consultation", "order", "desk"]);
export const DiscountCategory = z.enum(["poor", "staff", "doctor", "ff", "corp"]);
export const ApprovalStatus = z.enum(["requested", "approved", "rejected"]);
export const IssueBlocker = z.enum(["no_lines", "unpriced_lines", "approval_pending"]);

/* ── price list (desk items) ── */
export const ChargeDefinitionQuery = z.object({ q: z.string().trim().max(60).default("") });
export const ChargeDefinitionItem = z.object({
  code: z.string(), kind: z.enum(["consultation", "test", "service"]), nameEn: z.string(), nameBn: z.string(),
  unitPaisa: Paisa, vatRateBp: z.number().int(),
  /** the prototype's sample price list, not a real tariff */
  sample: z.boolean(),
});
export const ChargeDefinitionList = z.object({ items: z.array(ChargeDefinitionItem) });
export type ChargeDefinitionList = z.infer<typeof ChargeDefinitionList>;

/* ── the bill ── */
export const ChargeLine = z.object({
  id: z.string(), position: z.number().int(), source: ChargeSource, sourceId: z.string().nullable(), code: z.string(),
  nameEn: z.string(), nameBn: z.string(),
  /** null = no price set: shown, and blocks issuing */
  unitPaisa: Paisa.nullable(),
  qty: z.number().int().min(1).max(999), vatRateBp: z.number().int(),
  grossPaisa: Paisa, discountPaisa: Paisa, netPaisa: Paisa, vatPaisa: Paisa, totalPaisa: Paisa,
  /** only desk lines can be removed or re-counted; the consultation and the doctor's orders stay on the bill */
  editable: z.boolean(),
});
export const ApprovalView = z.object({
  taskId: z.string(), status: ApprovalStatus, amountPaisa: Paisa, category: DiscountCategory, reason: z.string(),
  subtotalPaisa: Paisa, limitPaisa: Paisa,
  requestedBy: Person, requestedAt: z.string(),
  decidedBy: Person.nullable(), decidedAt: z.string().nullable(), decisionNote: z.string().nullable(),
});
export const PaymentView = z.object({
  id: z.string(), method: PaymentMethod, status: PaymentStatus, amountPaisa: Paisa,
  tenderedPaisa: Paisa.nullable(), changePaisa: Paisa.nullable(), reference: z.string().nullable(), trxId: z.string().nullable(),
  /** wallets: last 4 digits of the number the link went to */
  phoneLast4: z.string().nullable(), linkExpiresAt: z.string().nullable(), attempt: z.number().int(), failReason: z.string().nullable(),
  createdBy: Person, createdAt: z.string(), confirmedAt: z.string().nullable(),
});
export type PaymentView = z.infer<typeof PaymentView>;
export const PaymentSummaryView = z.object({ totalPaisa: Paisa, confirmedPaisa: Paisa, pendingPaisa: Paisa, duePaisa: Paisa, openPaisa: Paisa });
export const PaidByView = z.object({
  paid: z.array(z.object({ method: PaymentMethod, amountPaisa: Paisa, trxId: z.string().optional(), reference: z.string().optional() })),
  pending: z.array(z.object({ method: PaymentMethod, amountPaisa: Paisa })),
});
export const InvoiceView = z.object({
  invoice: z.object({
    id: z.string(), status: InvoiceStatus, number: z.string().nullable(), rev: z.number().int(),
    subtotalPaisa: Paisa, discountPaisa: Paisa, netPaisa: Paisa, vatPaisa: Paisa, totalPaisa: Paisa, paidPaisa: Paisa,
    discount: z.object({ category: DiscountCategory, reason: z.string(), appliedBy: Person, appliedAt: z.string(), approvedBy: Person.nullable() }).nullable(),
    createdAt: z.string(), issuedAt: z.string().nullable(), issuedBy: Person.nullable(),
  }),
  encounter: VitalsEncounter.extend({ practitioner: Person.nullable() }),
  lines: z.array(ChargeLine),
  /** the latest discount request on this bill (requested, approved or rejected) */
  approval: ApprovalView.nullable(),
  /** the cashier's discount limit for the current subtotal */
  discountLimitPaisa: Paisa,
  issueBlockers: z.array(IssueBlocker),
  payments: z.array(PaymentView),
  summary: PaymentSummaryView,
  paidBy: PaidByView,
  seller: z.object({ nameEn: z.string(), nameBn: z.string().nullable(), vatBin: z.string().nullable(), vatBinSample: z.boolean() }),
});
export type InvoiceView = z.infer<typeof InvoiceView>;

export const BillingWorklist = z.object({
  items: z.array(z.object({
    encounter: VitalsEncounter.extend({ practitioner: Person.nullable() }),
    invoice: z.object({ id: z.string(), status: InvoiceStatus, number: z.string().nullable(), totalPaisa: Paisa, paidPaisa: Paisa, approvalPending: z.boolean() }).nullable(),
  })),
});
export type BillingWorklist = z.infer<typeof BillingWorklist>;

/* ── edits (draft only; `rev` is check-and-set) ── */
export const AddLineRequest = z.object({ code: z.string().min(1).max(80), qty: z.number().int().min(1).max(999).default(1), rev: Rev });
export const SetQtyRequest = z.object({ qty: z.number().int().min(1).max(999), rev: Rev });
export const RevRequest = z.object({ rev: Rev });
export const DiscountRequest = z.object({
  mode: z.enum(["amount", "percent"]),
  /** mode amount: the discount in paisa */
  amountPaisa: Paisa.optional(),
  /** mode percent: basis points of the subtotal (1000 = 10%), converted to paisa once, half-up */
  percentBp: z.number().int().min(0).max(10_000).optional(),
  category: DiscountCategory,
  reason: z.string().trim().min(10).max(300),
  rev: Rev,
}).refine((d) => (d.mode === "amount" ? d.amountPaisa !== undefined : d.percentBp !== undefined), { message: "amount_or_percent_required", path: ["amountPaisa"] });
export type DiscountRequest = z.infer<typeof DiscountRequest>;
export const DiscountResponse = z.object({ outcome: z.enum(["applied", "approval-requested"]), view: InvoiceView });
export type DiscountResponse = z.infer<typeof DiscountResponse>;

/* ── approvals (owner / admin) ── */
export const ApprovalQuery = z.object({ status: ApprovalStatus.default("requested") });
export const ApprovalItem = ApprovalView.extend({
  invoice: z.object({ id: z.string(), status: InvoiceStatus, number: z.string().nullable(), subtotalPaisa: Paisa, totalPaisa: Paisa }),
  patient: VitalsEncounter.shape.patient,
  /** leak signal: the requester's discount requests today (count and paisa) */
  requesterToday: z.object({ count: z.number().int(), totalPaisa: Paisa }),
});
export type ApprovalItem = z.infer<typeof ApprovalItem>;
export const ApprovalList = z.object({ items: z.array(ApprovalItem) });
export type ApprovalList = z.infer<typeof ApprovalList>;
export const ApproveRequest = z.object({ note: z.string().trim().max(300).optional() });
export const RejectRequest = z.object({ note: z.string().trim().min(10).max(300) });
export const ApprovalDecisionResponse = z.object({ approval: ApprovalItem, view: InvoiceView });
export type ApprovalDecisionResponse = z.infer<typeof ApprovalDecisionResponse>;

/* ── payments ── */
export const NewPaymentRequest = z.object({
  method: PaymentMethod,
  amountPaisa: Paisa,
  /** cash: what the patient handed over (change = tendered − amount) */
  tenderedPaisa: Paisa.optional(),
  /** card approval code or bank reference */
  reference: z.string().trim().max(60).optional(),
});
export type NewPaymentRequest = z.infer<typeof NewPaymentRequest>;
export const VerifyTrxRequest = z.object({ trxId: z.string().trim().regex(/^[A-Z0-9]{8,20}$/i, "invalid_trx_id") });
export const PaymentResponse = z.object({
  payment: PaymentView, view: InvoiceView,
  /** paid-on-earlier-link: a TrxID paid on a replaced link — the owner reconciles it, do not ask for the money again;
      paid-meanwhile: "Cancel link" found the money had arrived, so the payment was confirmed instead */
  notice: z.enum(["paid-on-earlier-link", "paid-meanwhile"]).optional(),
});
export type PaymentResponse = z.infer<typeof PaymentResponse>;

/** Provider callback answer. 200 for every well-signed event, so the gateway stops retrying: `applied` moved the
    payment on; `noop` = already in that state (a repeat changes nothing); `refused` = out of order or backwards, recorded
    and not applied. */
export const ProviderCallbackResponse = z.object({ outcome: z.enum(["applied", "noop", "refused"]), reason: z.string().optional() });
export type ProviderCallbackResponse = z.infer<typeof ProviderCallbackResponse>;
export const FakeProviderEventKind = z.enum(["opened", "confirmed", "failed"]);

/* ── receipts (session 2). A receipt is an immutable copy of what is printed; prints are logged (copy 0 = original,
   n ≥ 1 = DUPLICATE #n with a reason). The public verify page shows only facility, receipt number, date, amount. ── */
export const ReceiptLang = z.enum(["both", "bn", "en"]);
export const ReceiptFormat = z.enum(["a5", "thermal"]);
export const ReprintReason = z.enum(["lost", "jam", "corp", "ins"]);
export const ReceiptSnapshot = z.object({
  seller: z.object({ nameEn: z.string(), nameBn: z.string().nullable(), address: z.string().nullable(), vatBin: z.string().nullable(), vatBinSample: z.boolean() }),
  invoice: z.object({ id: z.string(), number: z.string(), issuedAt: z.string() }),
  patient: z.object({ nameBn: z.string(), nameEn: z.string().nullable(), facilityNo: z.string() }),
  lines: z.array(z.object({
    nameBn: z.string(), nameEn: z.string(), qty: z.number().int(), unitPaisa: Paisa, vatRateBp: z.number().int(),
    grossPaisa: Paisa, discountPaisa: Paisa, netPaisa: Paisa, vatPaisa: Paisa, totalPaisa: Paisa,
  })),
  subtotalPaisa: Paisa, discountPaisa: Paisa, vatPaisa: Paisa, totalPaisa: Paisa, paidPaisa: Paisa, duePaisa: Paisa,
  /** sums of line paisa per VAT rate (Mushak-6.3 breakdown) */
  vatByRate: z.array(z.object({ rateBp: z.number().int(), netPaisa: Paisa, vatPaisa: Paisa })),
  discount: z.object({ category: DiscountCategory, reason: z.string(), approvedBy: z.object({ nameBn: z.string(), nameEn: z.string() }).nullable() }).nullable(),
  paidBy: PaidByView,
  cashier: z.object({ nameBn: z.string(), nameEn: z.string() }),
});
export type ReceiptSnapshot = z.infer<typeof ReceiptSnapshot>;
export const ReceiptPrintView = z.object({
  id: z.string(), copy: z.number().int(), reason: ReprintReason.nullable(), format: ReceiptFormat, lang: ReceiptLang,
  printedBy: Person, printedAt: z.string(), pdfUrl: z.string(),
});
export type ReceiptPrintView = z.infer<typeof ReceiptPrintView>;
export const ReceiptView = z.object({
  receipt: z.object({
    id: z.string(), number: z.string(), invoiceId: z.string(), createdAt: z.string(), paidPaisa: Paisa, totalPaisa: Paisa, duePaisa: Paisa,
    /** what the QR encodes */
    verifyUrl: z.string(),
    snapshot: ReceiptSnapshot,
  }),
  prints: z.array(ReceiptPrintView),
});
export type ReceiptView = z.infer<typeof ReceiptView>;
export const ReceiptList = z.object({ items: z.array(z.object({ id: z.string(), number: z.string(), createdAt: z.string(), paidPaisa: Paisa, duePaisa: Paisa, prints: z.number().int() })) });
export type ReceiptList = z.infer<typeof ReceiptList>;
export const PrintRequest = z.object({ format: ReceiptFormat.default("a5"), lang: ReceiptLang.default("both"), reason: ReprintReason.optional() });
export type PrintRequest = z.infer<typeof PrintRequest>;
export const PrintResponse = z.object({ print: ReceiptPrintView, view: ReceiptView });
export type PrintResponse = z.infer<typeof PrintResponse>;
export const VerifyCode = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{16,40}$/);
export const VerifyResponse = z.object({ facilityEn: z.string(), facilityBn: z.string().nullable(), number: z.string(), date: z.string(), amountPaisa: Paisa });
export type VerifyResponse = z.infer<typeof VerifyResponse>;
