/* Pharmacy contracts (phase 2 slice 2, ADR 0009; prototype Setu Pharmacy): the dispense queue and a visit's dispense,
   decline, the over-the-counter sale and the stock list. Quantities are tablets / capsules; money is paisa. */
import { z } from "zod";
import { Paisa } from "./common.js";
import { InvoiceView } from "./billing.js";
import { VitalsEncounter } from "./vitals.js";

const Person = z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() });
const Qty = z.number().int().positive().max(10_000);
const Reason = z.string().trim().max(500);

export const SaleClass = z.enum(["otc", "rx", "ctrl"]);
export const BatchState = z.enum(["usable", "expired", "empty", "quarantine"]);
export const DispenseLineStatus = z.enum(["to-dispense", "partial", "dispensed", "declined", "partial-declined"]);

export const MedicineRef = z.object({
  key: z.string(), brand: z.string(), generic: z.string(), strength: z.string(), form: z.string(),
  saleClass: SaleClass, sample: z.boolean(),
});
export type MedicineRef = z.infer<typeof MedicineRef>;
export const BatchView = z.object({
  id: z.string(), batchNo: z.string(), expiry: z.string(), location: z.string(), qtyOnHand: z.number().int(),
  mrpPaisa: Paisa, vatRateBp: z.number().int(), state: BatchState, nearExpiry: z.boolean(), sample: z.boolean(),
});
export type BatchView = z.infer<typeof BatchView>;

/* ── the queue: today's visits with a signed prescription ── */
export const PharmacyBillSummary = z.object({ id: z.string(), status: z.string(), number: z.string().nullable(), totalPaisa: Paisa, paidPaisa: Paisa });
export const DispenseQueueItem = z.object({
  encounter: VitalsEncounter.extend({ practitioner: Person.nullable() }),
  signedAt: z.string(),
  lineCount: z.number().int(),
  /** to-dispense: nothing given yet; partial: some lines (or part of a line) still open; done: every line dispensed or declined */
  status: z.enum(["to-dispense", "partial", "done"]),
  bill: PharmacyBillSummary.nullable(),
});
export const DispenseQueue = z.object({ items: z.array(DispenseQueueItem) });
export type DispenseQueue = z.infer<typeof DispenseQueue>;

/* ── one visit's dispense ── */
export const DispenseGiven = z.object({
  id: z.string(), medicine: MedicineRef, qty: z.number().int(), batchNo: z.string(), expiry: z.string(),
  substitute: z.boolean(), reason: z.string().nullable(), by: Person, at: z.string(),
});
export const DispenseLine = z.object({
  requestId: z.string(), position: z.number().int(),
  prescribed: MedicineRef,
  dose: z.string(), meal: z.enum(["before", "after", "with", "any"]), days: z.number().int(), quantity: z.number().int(), note: z.string().nullable(),
  dispensedQty: z.number().int(), remaining: z.number().int(),
  declined: z.object({ reason: z.string(), by: Person, at: z.string() }).nullable(),
  status: DispenseLineStatus,
  given: z.array(DispenseGiven),
  /** FEFO for what is still open, from the counter (expired, empty and quarantined batches are never picked) */
  proposal: z.object({ allocations: z.array(z.object({ batch: BatchView, qty: z.number().int() })), shortfall: z.number().int() }),
  /** every counter batch of the prescribed medicine, expired ones included (shown blocked) */
  batches: z.array(BatchView),
  /** same-generic brands in stock; `allergy` = the patient is allergic (refused) */
  substitutes: z.array(z.object({ medicine: MedicineRef, available: z.number().int(), allergy: z.boolean() })),
  /** null when the dose cannot be read for a label (never a label without the dose) */
  label: z.object({ bn: z.string(), en: z.string() }).nullable(),
});
export type DispenseLine = z.infer<typeof DispenseLine>;
export const DispenseView = z.object({
  encounter: VitalsEncounter.extend({ practitioner: Person.nullable() }),
  composition: z.object({ id: z.string(), version: z.number().int(), status: z.enum(["final", "amended"]), signedAt: z.string() }),
  allergies: z.array(z.object({ labelBn: z.string(), labelEn: z.string(), severity: z.string() })),
  lines: z.array(DispenseLine),
  bill: PharmacyBillSummary.nullable(),
  /** the dose label's page (facility setting, default 50 × 30 mm) and the name printed on it */
  labelPage: z.object({ widthMm: z.number().int(), heightMm: z.number().int() }),
  facility: z.object({ nameEn: z.string(), nameBn: z.string().nullable() }),
});
export type DispenseView = z.infer<typeof DispenseView>;

export const DispenseRequest = z.object({
  compositionId: z.string().min(1).max(64),
  lines: z.array(z.object({
    requestId: z.string().min(1).max(64),
    /** the prescribed medicine, or a same-generic substitute (then `reason`, at least 10 characters) */
    medicineKey: z.string().min(1).max(64),
    qty: Qty,
    reason: Reason.optional(),
  })).min(1).max(30),
});
export type DispenseRequest = z.infer<typeof DispenseRequest>;
export const DeclineRequest = z.object({ compositionId: z.string().min(1).max(64), requestId: z.string().min(1).max(64), reason: Reason });
export type DeclineRequest = z.infer<typeof DeclineRequest>;
/** Dose labels are printed by the browser; the server records each print first (an audited PHI print). */
export const LabelPrintRequest = z.object({ requestIds: z.array(z.string().min(1).max(64)).min(1).max(30) });
export type LabelPrintRequest = z.infer<typeof LabelPrintRequest>;
export const LabelPrintResponse = z.object({ printedAt: z.string(), labels: z.number().int() });
export type LabelPrintResponse = z.infer<typeof LabelPrintResponse>;

/* ── over the counter ── */
export const OtcCreateRequest = z.object({
  buyerName: z.string().trim().min(1).max(80).optional(),
  /** 01XXXXXXXXX — needed only for a bKash / Nagad link */
  buyerPhone: z.string().regex(/^01[3-9]\d{8}$/).optional(),
});
export type OtcCreateRequest = z.infer<typeof OtcCreateRequest>;
export const OtcLineRequest = z.object({ rev: z.number().int(), medicineKey: z.string().min(1).max(64), qty: Qty });
export type OtcLineRequest = z.infer<typeof OtcLineRequest>;
export const OtcRevRequest = z.object({ rev: z.number().int() });
/** A prescription photo for prescription-only items: JPEG or PNG, at most 3 MB. */
export const RxPhotoRequest = z.object({ rev: z.number().int(), contentType: z.enum(["image/jpeg", "image/png"]), dataBase64: z.string().min(16).max(4_200_000) });
export type RxPhotoRequest = z.infer<typeof RxPhotoRequest>;
export const OtcView = z.object({
  bill: InvoiceView,
  rxPhoto: z.boolean(),
  /** what stops issuing now: rx_photo_required (a prescription-only line without a photo), controlled, stock_short */
  blockers: z.array(z.object({ code: z.enum(["rx_photo_required", "controlled", "stock_short", "no_lines"]), lineId: z.string().nullable() })),
});
export type OtcView = z.infer<typeof OtcView>;

/* ── stock (read) ── */
export const StockQuery = z.object({ q: z.string().trim().max(60).default(""), filter: z.enum(["all", "near-expiry", "expired", "low"]).default("all") });
export const StockItem = z.object({
  medicine: MedicineRef,
  /** usable (not expired, not quarantined) at the counter and in the store */
  counterQty: z.number().int(), storeQty: z.number().int(),
  nearExpiryQty: z.number().int(), expiredQty: z.number().int(),
  /** fewer usable at the counter than the low-stock level (sample) */
  low: z.boolean(),
  batches: z.array(BatchView),
});
export const StockList = z.object({ items: z.array(StockItem), today: z.string() });
export type StockList = z.infer<typeof StockList>;
