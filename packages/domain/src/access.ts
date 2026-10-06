/* Roles × screens × plans. Generated from the prototype's nav model (docs/prototype/Setu Staff App.dc.html),
   which matches docs/design-handoff/shell-roles-plans.md. The client never decides access alone:
   GET /me/capabilities is computed with the same functions. */
import matrix from "./access-matrix.json" with { type: "json" };

export type Role = "receptionist" | "doctor" | "nurse" | "labTech" | "pathologist" | "pharmacist" | "cashier" | "owner" | "admin";
export type Plan = "clinic" | "lite" | "pro";
export interface Screen { key: string; name_bn: string; name_en: string; icon: string; roles: Role[]; plan: Plan; needsPatient: boolean; badge?: string }
export interface Module { key: string; name_bn: string; name_en: string; icon: string; plan: Plan; roles: Role[]; screens: Screen[] }

export const ROLES = matrix.roles as Role[];
export const PLANS = matrix.plans as Plan[];
export const MODULES = matrix.modules as Module[];
export const PLAN_NAME: Record<Plan, string> = { clinic: "Clinic", lite: "Hospital Lite", pro: "Hospital Pro" };
export const PLAN_RANK: Record<Plan, number> = { clinic: 0, lite: 1, pro: 2 };
export const ROLE_NAME: Record<Role, { bn: string; en: string }> = {
  receptionist: { bn: "রিসেপশন", en: "Receptionist" }, doctor: { bn: "ডাক্তার", en: "Doctor" }, nurse: { bn: "নার্স", en: "Nurse" },
  labTech: { bn: "ল্যাব টেকনোলজিস্ট", en: "Lab technologist" }, pathologist: { bn: "প্যাথলজিস্ট", en: "Pathologist" }, pharmacist: { bn: "ফার্মাসিস্ট", en: "Pharmacist" },
  cashier: { bn: "ক্যাশিয়ার", en: "Cashier" }, owner: { bn: "মালিক", en: "Owner" }, admin: { bn: "অ্যাডমিন", en: "Admin" },
};

export type Denial = "role" | "plan" | "unknown";
export interface Decision { allowed: boolean; reason?: Denial; /** plan needed when reason = plan */ needs?: Plan }

/** Can this role, on this plan, open this screen? Plan denial wins over role denial so the UI shows the lock. */
export function authorize(role: Role, plan: Plan, moduleKey: string, screenKey: string): Decision {
  const mod = MODULES.find((m) => m.key === moduleKey);
  const scr = mod?.screens.find((s) => s.key === screenKey);
  if (!mod || !scr) return { allowed: false, reason: "unknown" };
  if (PLAN_RANK[plan] < PLAN_RANK[scr.plan]) return { allowed: false, reason: "plan", needs: scr.plan };
  if (!mod.roles.includes(role) || !scr.roles.includes(role)) return { allowed: false, reason: "role" };
  return { allowed: true };
}

/** ADR 0014: `ipd` is the inpatient running bill, opened by the admission (its screen: bill/ipd, ADR 0017). */
export type BillKind = "opd" | "pharmacy" | "otc" | "ipd";
/** ADR 0009: which bills this role may open and take money on. Billing (bill/opd) sees every kind; the pharmacist
    (pharmacy screens) sees only the pharmacy and over-the-counter bills — never an OPD bill. */
export function billKindsFor(role: Role, plan: Plan): BillKind[] {
  // ADR 0017: the IPD running bill's payments (deposits, their links) for whoever has the IPD bill screen (Hospital Lite up)
  if (authorize(role, plan, "bill", "opd").allowed) return authorize(role, plan, "bill", "ipd").allowed ? ["opd", "pharmacy", "otc", "ipd"] : ["opd", "pharmacy", "otc"];
  if (authorize(role, plan, "ph", "otc").allowed) return ["pharmacy", "otc"];
  return [];
}
/** ADR 0008 + 0009: who holds a drawer shift — billing's shift screen, or the pharmacy counter's (ph/shift). */
export const holdsShift = (role: Role, plan: Plan) => authorize(role, plan, "bill", "shift").allowed || authorize(role, plan, "ph", "shift").allowed;

export interface CapabilityScreen { key: string; name_bn: string; name_en: string; icon: string; allowed: boolean; reason?: Denial; needs?: Plan; needsPatient: boolean; badge?: string }
export interface Capability { key: string; name_bn: string; name_en: string; icon: string; plan: Plan; locked?: Denial; screens: CapabilityScreen[] }

/** What the nav shows: modules the role may see; screens the role can't use are omitted, plan-locked ones stay with a reason. */
export function capabilities(role: Role, plan: Plan): Capability[] {
  return MODULES.filter((m) => m.roles.includes(role)).map((m) => {
    const screens = m.screens.filter((s) => s.roles.includes(role)).map((s) => {
      const d = authorize(role, plan, m.key, s.key);
      return { key: s.key, name_bn: s.name_bn, name_en: s.name_en, icon: s.icon, allowed: d.allowed, reason: d.reason, needs: d.needs, needsPatient: s.needsPatient, badge: s.badge };
    });
    const locked = PLAN_RANK[plan] < PLAN_RANK[m.plan] ? ("plan" as const) : undefined;
    return { key: m.key, name_bn: m.name_bn, name_en: m.name_en, icon: m.icon, plan: m.plan, locked, screens };
  });
}

/** Where a role prefers to land in a module (prototype DEF table, round-2 fix #26). Falls back to the first allowed screen. */
const PREFERRED: Partial<Record<Role, Record<string, string>>> = {
  doctor: { ipd: "rounds" }, nurse: { ipd: "map" }, owner: { ipd: "report", lab: "dash" }, pathologist: { lab: "verify" },
};
export function defaultScreen(role: Role, plan: Plan, moduleKey: string): string | undefined {
  const pref = PREFERRED[role]?.[moduleKey];
  if (pref && authorize(role, plan, moduleKey, pref).allowed) return pref;
  return MODULES.find((m) => m.key === moduleKey)?.screens.find((s) => authorize(role, plan, moduleKey, s.key).allowed)?.key;
}
