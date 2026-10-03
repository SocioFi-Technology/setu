/* Shift close and the owner dashboard (slice C1–C4, ADR 0008). The rules are @setu/domain shift.ts and kpi.ts; the API
   re-runs them and the database checks the shift's arithmetic and transitions again. Money is integer paisa. */
import { z } from "zod";

const Person = z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() });
const Paisa = z.number().int();
export const ShiftStatus = z.enum(["open", "counted", "closed", "approved"]);
export const DigitalMethod = z.enum(["bkash", "nagad", "card", "bank"]);
export const DigitalRow = z.object({ method: DigitalMethod, systemPaisa: Paisa, settlementPaisa: Paisa.nullable(), state: z.enum(["matched", "pending", "mismatch"]), diffPaisa: Paisa.nullable() });

export const ShiftCountView = z.object({
  id: z.string(), countNo: z.number().int(),
  /** taka note → how many */
  counts: z.record(z.string(), z.number().int()),
  countedPaisa: Paisa, openingFloatPaisa: Paisa, cashInPaisa: Paisa, cashRefundPaisa: Paisa, expectedCashPaisa: Paisa, variancePaisa: Paisa,
  judgement: z.enum(["short", "over", "matched"]), digital: z.array(DigitalRow), reason: z.string().nullable(),
  countedBy: Person, countedAt: z.string(), windowFrom: z.string(), windowTo: z.string(),
});
export const ShiftView = z.object({
  id: z.string(), status: ShiftStatus, cashier: Person, facilityEn: z.string(),
  openingFloatPaisa: Paisa, openedAt: z.string(), statusAt: z.string(),
  /** an open shift: what the drawer should hold now (server figures, refreshed on every read) */
  live: z.object({ cashInPaisa: Paisa, cashRefundPaisa: Paisa, expectedCashPaisa: Paisa, digital: z.array(DigitalRow), payments: z.number().int() }).nullable(),
  latestCount: ShiftCountView.nullable(),
  counts: z.array(ShiftCountView),
  reviews: z.array(z.object({ id: z.string(), decision: z.enum(["approve", "recount"]), note: z.string().nullable(), by: Person, at: z.string(), countNo: z.number().int() })),
  /** this session may count it (its cashier, while open) / review it (owner or admin, not its cashier, while closed) */
  canCount: z.boolean(), canReview: z.boolean(),
});
export type ShiftView = z.infer<typeof ShiftView>;
export const MyShiftResponse = z.object({ shift: ShiftView.nullable(), lastApproved: ShiftView.nullable() });
export type MyShiftResponse = z.infer<typeof MyShiftResponse>;
export const OpenShiftRequest = z.object({ openingFloatPaisa: Paisa.min(0).max(100_000_000) });
export type OpenShiftRequest = z.infer<typeof OpenShiftRequest>;
/** count and hand over in one step (SHIFT count + close); a variance needs a reason ≥10 */
export const CountShiftRequest = z.object({
  counts: z.record(z.string().regex(/^\d{1,4}$/), z.number().int().min(0).max(100_000)),
  settlement: z.object({ bkash: Paisa.min(0), nagad: Paisa.min(0), card: Paisa.min(0), bank: Paisa.min(0) }).partial().default({}),
  reason: z.string().max(300).optional(),
});
export type CountShiftRequest = z.infer<typeof CountShiftRequest>;
export const ReviewShiftRequest = z.object({ decision: z.enum(["approve", "recount"]), note: z.string().max(300).optional() });
export type ReviewShiftRequest = z.infer<typeof ReviewShiftRequest>;
export const ShiftListQuery = z.object({ status: z.enum(["closed", "open", "approved", "all"]).default("closed"), days: z.coerce.number().int().min(1).max(90).default(14) });
export const ShiftList = z.object({ items: z.array(ShiftView) });
export type ShiftList = z.infer<typeof ShiftList>;

/* ───── owner dashboard ───── */
export const Period = z.enum(["today", "7d", "30d"]);
export const KpiKey = z.enum(["revenue", "collections", "dues", "discounts", "deposits", "refunds", "sharePayable", "supplierDues", "stockValue", "nearExpiry"]);
export const OpsKey = z.enum(["opdVisits", "labTests", "labTat", "noShows", "cashVariance", "reprints"]);
export const LeakageKind = z.enum(["discountAbovePolicy", "reprints", "shiftVariance", "notBilledHere", "cashOutsideShift"]);
const Change = { previous: z.number().nullable(), pct: z.number().int().nullable(), judgement: z.enum(["better", "worse", "same"]).nullable() };
export const DashboardView = z.object({
  period: Period, days: z.array(z.string()), previousDays: z.array(z.string()),
  /** today: up to this Dhaka hour, compared with the same weekday last week up to the same hour */
  uptoHour: z.number().int().nullable(), asOf: z.string(),
  kpis: z.array(z.object({ key: KpiKey, value: z.number().nullable(), ...Change, comesWith: z.enum(["pharmacy", "ipd", "refunds", "ledger"]).nullable(), sub: z.string().nullable() })),
  ops: z.array(z.object({ key: OpsKey, value: z.number().nullable(), ...Change })),
  /** by hour (today) or by day: revenue (bills issued) and collected (payments confirmed), paisa */
  series: z.object({ unit: z.enum(["hour", "day"]), points: z.array(z.object({ label: z.string(), revenuePaisa: Paisa, collectedPaisa: Paisa })) }),
  byMethod: z.array(z.object({ method: z.enum(["cash", "card", "bank", "bkash", "nagad"]), paisa: Paisa })),
  leakage: z.array(z.object({ kind: LeakageKind, count: z.number().int(), paisa: Paisa, severity: z.enum(["high", "review"]) })),
  pending: z.object({ approvals: z.number().int(), shifts: z.number().int(), reconcile: z.number().int() }),
});
export type DashboardView = z.infer<typeof DashboardView>;
export const DashboardQuery = z.object({ period: Period.default("today") });
export const DrillWhat = z.enum(["revenue", "collections", "dues", "discounts", "opdVisits", "labTests", "noShows", "reprints", "shiftVariance", "discountAbovePolicy", "notBilledHere", "cashOutsideShift"]);
export const DrillQuery = z.object({ period: Period.default("today"), what: DrillWhat });
export const DrillView = z.object({
  what: DrillWhat, period: Period, totalPaisa: Paisa.nullable(), count: z.number().int(),
  rows: z.array(z.object({
    id: z.string(), at: z.string(), number: z.string().nullable(),
    patient: z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string().nullable(), facilityNo: z.string() }).nullable(),
    amountPaisa: Paisa.nullable(), by: Person.nullable(), approvedBy: Person.nullable(), detail: z.string().nullable(),
    /** where the row opens (a bill, a receipt, a shift) */
    link: z.object({ kind: z.enum(["invoice", "receipt", "shift", "visit"]), id: z.string() }).nullable(),
  })),
});
export type DrillView = z.infer<typeof DrillView>;
