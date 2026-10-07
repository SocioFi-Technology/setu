/* Admin (phase 2 slice 3, ADR 0010; prototype Setu Admin): the go-live checklist, who may change whose role or switch a
   user off, first-sign-in password and PIN rules, approval limits, price changes and which audit events are flagged.
   The API and the screens use the same rules; the database re-checks the money ones. */
import type { Plan, Role } from "./access.js";
import { MAX_PAISA } from "./money.js";

/* ───── go-live checklist (prototype Admin › Onboarding) ───── */
export type GoLiveItem = "organization" | "branch" | "wards" | "doctor" | "price_list" | "templates" | "payment_method" | "test_sms";
export interface GoLiveFacts {
  plan: Plan;
  org: { name: string; address: string | null; licenceNo: string | null };
  branches: number;
  /** wards that hold at least one bed (needed on the hospital plans only) */
  wardsWithBeds: number;
  /** active doctors whose registration (BMDC) was verified */
  verifiedDoctors: number;
  /** active doctors without a consultation fee on the price list */
  doctorsWithoutFee: number;
  pricedItems: number;
  receiptFormat: string | null; rxFormat: string | null;
  paymentMethods: readonly string[];
  smsTestedAt: string | null;
}
export function goLiveChecklist(f: GoLiveFacts): { item: GoLiveItem; done: boolean; required: boolean }[] {
  return [
    { item: "organization", done: Boolean(f.org.name.trim() && f.org.address?.trim() && f.org.licenceNo?.trim()), required: true },
    { item: "branch", done: f.branches > 0, required: true },
    { item: "wards", done: f.wardsWithBeds > 0, required: f.plan !== "clinic" },
    { item: "doctor", done: f.verifiedDoctors > 0, required: true },
    { item: "price_list", done: f.pricedItems > 0 && f.doctorsWithoutFee === 0, required: true },
    { item: "templates", done: Boolean(f.receiptFormat && f.rxFormat), required: true },
    { item: "payment_method", done: f.paymentMethods.length > 0, required: true },
    { item: "test_sms", done: Boolean(f.smsTestedAt), required: true },
  ];
}
export const goLiveBlockers = (f: GoLiveFacts): GoLiveItem[] => goLiveChecklist(f).filter((x) => x.required && !x.done).map((x) => x.item);

/* ───── users and roles ───── */
const APPROVER: Role[] = ["owner", "admin"];
export type UserAdminBlocker = "self" | "owner_only" | "last_approver";
/** Never your own role or account; only an owner makes or unmakes an owner; a facility always keeps one active owner
    or admin (nobody can lock the facility out of its own settings). */
function common(x: { actor: { id: string; role: Role }; target: { id: string; role: Role }; touchesOwner: boolean; leavesApproverRole: boolean; activeApprovers: number }): UserAdminBlocker[] {
  const out: UserAdminBlocker[] = [];
  if (x.actor.id === x.target.id) out.push("self");
  if (x.touchesOwner && x.actor.role !== "owner") out.push("owner_only");
  if (x.leavesApproverRole && x.activeApprovers <= 1) out.push("last_approver");
  return out;
}
export function roleChangeBlockers(x: { actor: { id: string; role: Role }; target: { id: string; role: Role; active: boolean }; newRole: Role; activeApprovers: number }): UserAdminBlocker[] {
  return common({ ...x, touchesOwner: x.newRole === "owner" || x.target.role === "owner",
    leavesApproverRole: x.target.active && APPROVER.includes(x.target.role) && !APPROVER.includes(x.newRole) });
}
export function deactivateBlockers(x: { actor: { id: string; role: Role }; target: { id: string; role: Role; active: boolean }; activeApprovers: number }): UserAdminBlocker[] {
  return common({ ...x, touchesOwner: x.target.role === "owner", leavesApproverRole: x.target.active && APPROVER.includes(x.target.role) });
}
/** Creating a user: only an owner creates an owner. */
export const createUserBlockers = (actorRole: Role, role: Role): UserAdminBlocker[] => (role === "owner" && actorRole !== "owner" ? ["owner_only"] : []);

/** A one-time password works for this long; the user sets their own password and PIN at first sign-in. */
export const ONE_TIME_PASSWORD_HOURS = 24;
export type PasswordProblem = "too_short" | "needs_letter_and_digit" | "contains_phone";
export function passwordProblems(pw: string, phone: string | null): PasswordProblem[] {
  const out: PasswordProblem[] = [];
  if (pw.length < 8) out.push("too_short");
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) out.push("needs_letter_and_digit");
  const digits = (phone ?? "").replace(/\D/g, "").slice(-8);
  if (digits.length === 8 && pw.includes(digits)) out.push("contains_phone");
  return out;
}
export type PinProblem = "four_digits" | "too_simple";
export function pinProblems(pin: string): PinProblem[] {
  if (!/^\d{4}$/.test(pin)) return ["four_digits"];
  const simple = /^(\d)\1{3}$/.test(pin) || ["1234", "2345", "3456", "4567", "5678", "6789", "4321", "9876", "0123"].includes(pin);
  return simple ? ["too_simple"] : [];
}
/** Registration numbers the facility records (BMDC for doctors, BNMC for nurses); checked by the registration adapter. */
export const REG_BODY: Partial<Record<Role, "BMDC" | "BNMC">> = { doctor: "BMDC", pathologist: "BMDC", nurse: "BNMC" };

/* ───── settings and the price list ───── */
export type LimitProblem = "cashier_above_approver" | "percent_range" | "money_range" | "approver_zero";
export function limitProblems(x: { cashierLimitPaisa: number; cashierLimitBp: number; approverLimitPaisa: number }): LimitProblem[] {
  const out: LimitProblem[] = [];
  const ok = (p: number) => Number.isSafeInteger(p) && p >= 0 && p <= MAX_PAISA;
  if (!ok(x.cashierLimitPaisa) || !ok(x.approverLimitPaisa)) out.push("money_range");
  if (!Number.isInteger(x.cashierLimitBp) || x.cashierLimitBp < 0 || x.cashierLimitBp > 5000) out.push("percent_range");
  if (x.cashierLimitPaisa > x.approverLimitPaisa) out.push("cashier_above_approver");
  // with 0 nobody — the owner included — could approve any discount (controls review)
  if (x.approverLimitPaisa === 0) out.push("approver_zero");
  return out;
}
export const labelPageOk = (w: number, h: number) => Number.isInteger(w) && Number.isInteger(h) && w >= 20 && w <= 150 && h >= 15 && h <= 150;
export type PriceProblem = "reason_required" | "money_range" | "vat_range" | "unchanged";
/** A price change needs a reason (it is flagged in the audit log); bills already made keep their price. */
export function priceChangeProblems(x: { oldUnitPaisa: number | null; oldVatBp: number | null; unitPaisa: number; vatRateBp: number; reason: string }): PriceProblem[] {
  const out: PriceProblem[] = [];
  if (!Number.isSafeInteger(x.unitPaisa) || x.unitPaisa < 0 || x.unitPaisa > MAX_PAISA) out.push("money_range");
  if (!Number.isInteger(x.vatRateBp) || x.vatRateBp < 0 || x.vatRateBp > 10000) out.push("vat_range");
  if (x.oldUnitPaisa !== null && x.unitPaisa === x.oldUnitPaisa && x.vatRateBp === x.oldVatBp) out.push("unchanged");
  if (x.oldUnitPaisa !== null && x.reason.trim().length < 10) out.push("reason_required");
  return out;
}

/* ───── the audit log (prototype Admin › Audit log) ───── */
/** Events the owner should see first (the "Flags" filter): who opened what in an emergency, duplicates, voids, money
    settings, who was switched off, prices, exports of the log itself, going live. */
export const FLAGGED_ACTIONS = ["break-glass", "reprint", "void", "export", "deactivate", "reactivate", "role-change", "reset-password", "price-change", "settings-change", "go-live", /** external review A3 */ "login-failed", /** external review A6 */ "count-abandoned", /** external review B2 */ "duty-list-missing"] as const;
export type FlaggedAction = (typeof FLAGGED_ACTIONS)[number];
export const isFlagged = (action: string) => (FLAGGED_ACTIONS as readonly string[]).includes(action);
