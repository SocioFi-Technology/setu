/* Shift close (journey C4, ADR 0008; prototype Setu Billing › Shift close). The cashier counts the drawer by note,
   the system knows what cash it confirmed; a variance needs a reason to hand over and a note to accept (issue #24).
   Digital money (bKash, Nagad, card, bank) is shown against what the cashier reads from the settlement — never
   blocking. Amounts are integer paisa. The SHIFT machine is in machines.ts. */
import type { Role } from "./access.js";

export const DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;
export type Denomination = (typeof DENOMINATIONS)[number];
export type Counts = Partial<Record<Denomination, number>>;

export function countCheck(counts: Counts): { ok: true; countedPaisa: number } | { ok: false; error: "count_invalid" | "denomination_unknown"; denomination: number } {
  let paisa = 0;
  for (const [k, n] of Object.entries(counts)) {
    const d = Number(k);
    if (!(DENOMINATIONS as readonly number[]).includes(d)) return { ok: false, error: "denomination_unknown", denomination: d };
    if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 100_000) return { ok: false, error: "count_invalid", denomination: d };
    paisa += d * 100 * (n as number);
  }
  return { ok: true, countedPaisa: paisa };
}

export const expectedCashPaisa = (x: { openingFloatPaisa: number; cashInPaisa: number; cashRefundPaisa: number }) => x.openingFloatPaisa + x.cashInPaisa - x.cashRefundPaisa;
export const varianceJudgement = (variancePaisa: number): "short" | "over" | "matched" => (variancePaisa < 0 ? "short" : variancePaisa > 0 ? "over" : "matched");

/** Every reason and note in Setu is at least 10 characters (open question 87). */
export const SHIFT_REASON_MIN = 10;
export function handOverBlockers(x: { variancePaisa: number; reason: string }): "reason_required"[] {
  return x.variancePaisa !== 0 && x.reason.trim().length < SHIFT_REASON_MIN ? ["reason_required"] : [];
}

/** Owner or admin, not the cashier of this shift (decision: no manager role — owner/admin approve). */
export const SHIFT_APPROVERS: readonly Role[] = ["owner", "admin"];
export type AcceptBlocker = "note_required" | "not_approver" | "own_shift";
export function acceptBlockers(x: { variancePaisa: number; note: string; approverRole: Role; approverIsCashier: boolean }): AcceptBlocker[] {
  const out: AcceptBlocker[] = [];
  if (!SHIFT_APPROVERS.includes(x.approverRole)) out.push("not_approver");
  if (x.approverIsCashier) out.push("own_shift");
  if (x.variancePaisa !== 0 && x.note.trim().length < SHIFT_REASON_MIN) out.push("note_required");
  return out;
}

export const DIGITAL_METHODS = ["bkash", "nagad", "card", "bank"] as const;
export type DigitalMethod = (typeof DIGITAL_METHODS)[number];
export interface DigitalRow { method: DigitalMethod; systemPaisa: number; settlementPaisa: number | null; state: "matched" | "pending" | "mismatch"; diffPaisa: number | null }
/** Nothing taken by a method and nothing entered = matched; money taken but no settlement entered yet = pending. */
export function digitalRows(system: Partial<Record<DigitalMethod, number>>, settlement: Partial<Record<DigitalMethod, number>>): DigitalRow[] {
  return DIGITAL_METHODS.map((method) => {
    const sys = system[method] ?? 0, set = settlement[method];
    if (set === undefined) return { method, systemPaisa: sys, settlementPaisa: null, state: sys === 0 ? "matched" : "pending", diffPaisa: sys === 0 ? 0 : null };
    return { method, systemPaisa: sys, settlementPaisa: set, state: set === sys ? "matched" : "mismatch", diffPaisa: set - sys };
  });
}
