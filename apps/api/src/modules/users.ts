/* User lookup: Prisma when the database is on, else the seeded demo users from memory so `pnpm dev` works before Docker.
   Login is the only read before the tenant is known; it goes through the auth_login_lookup function. Everything after
   login reads inside forTenant, so row-level security applies. */
import { createHash } from "node:crypto";
import type { Plan, Role } from "@setu/domain";
import { config } from "../config.js";

export interface UserRecord { id: string; tenantId: string; nameBn: string; nameEn: string; phone?: string; email?: string; passwordHash: string; pinHash?: string; roles: { organizationId: string; organizationName: string; role: Role }[]; plan: Plan }
export const devHash = (s: string) => createHash("sha256").update("dev-only:" + s).digest("hex");

const DEMO: UserRecord[] = ([
  ["u_sadia", "সাদিয়া রহমান", "Sadia Rahman", "1711000001", "receptionist"],
  ["u_imran", "ডা. ইমরান কবির", "Dr. Imran Kabir", "1711000002", "doctor"],
  ["u_shirin", "শিরিন আক্তার", "Shirin Akter", "1711000004", "nurse"],
  ["u_tanvir", "তানভীর হাসান", "Tanvir Hasan", "1711000005", "labTech"],
  ["u_kanta", "ডা. কান্তা পারভীন", "Dr. Kanta Parveen", "1711000006", "pathologist"],
  ["u_jewel", "মো. জুয়েল রানা", "Md. Jewel Rana", "1711000007", "pharmacist"],
  ["u_kafia", "কাফিয়া মিয়া", "Kafia Mia", "1711000008", "cashier"],
  ["u_anwar", "আনোয়ার হোসেন", "Anwar Hossain", "1711000009", "owner"],
  ["u_admin", "অ্যাডমিন", "Admin", "1711000010", "admin"],
] as [string, string, string, string, Role][]).map(([id, nameBn, nameEn, phone, role]) => ({
  id, tenantId: "t_greenlife", nameBn, nameEn, phone, passwordHash: devHash("setu1234"), pinHash: devHash("1234"), plan: "pro" as Plan,
  roles: [{ organizationId: "o_greenlife_mirpur", organizationName: "Green Life Clinic, Mirpur", role }],
})).concat([
  /* Same plan-demo users as the seed, so the plan-lock journey runs with or without the database. */
  { id: "u_clinic_nurse", tenantId: "t_clinicdemo", nameBn: "রুনা বেগম", nameEn: "Runa Begum", phone: "1722000004", passwordHash: devHash("setu1234"), pinHash: devHash("1234"), plan: "clinic", roles: [{ organizationId: "o_clinicdemo", organizationName: "Shapla Clinic (Clinic plan demo)", role: "nurse" }] },
  { id: "u_lite_doctor", tenantId: "t_litedemo", nameBn: "ডা. ফাহিম আহমেদ", nameEn: "Dr. Fahim Ahmed", phone: "1733000002", passwordHash: devHash("setu1234"), pinHash: devHash("1234"), plan: "lite", roles: [{ organizationId: "o_litedemo", organizationName: "Meghna Hospital (Hospital Lite demo)", role: "doctor" }] },
]);

/** Login: every active user matching the phone (either stored form) or email, across tenants. The caller picks the one whose password matches. */
export async function findLoginCandidates(identifier: string): Promise<UserRecord[]> {
  const digits = identifier.replace(/\D/g, "").replace(/^880/, "").replace(/^0/, "");
  const email = identifier.includes("@") ? identifier.trim() : null;
  if (!config.dbEnabled) return DEMO.filter((u) => (digits && u.phone === digits) || (email && u.email === email));
  const { loginLookup } = await import("@setu/db");
  const rows = await loginLookup(digits ? [digits, "0" + digits] : [], email);
  return rows.map((u) => ({ id: u.id, tenantId: u.tenantId, nameBn: u.nameBn, nameEn: u.nameEn, phone: u.phone ?? undefined, email: u.email ?? undefined, passwordHash: u.passwordHash, plan: u.plan, roles: u.roles as UserRecord["roles"] }));
}

/** After login: the signed-in user, read under the session's tenant. */
export async function findUserById(tenantId: string, userId: string): Promise<UserRecord | null> {
  if (!config.dbEnabled) return DEMO.find((u) => u.id === userId && u.tenantId === tenantId) ?? null;
  const { forTenant } = await import("@setu/db");
  const u = await forTenant(tenantId, (tx) => tx.user.findFirst({ where: { id: userId, active: true }, include: { roles: { include: { organization: true } }, tenant: true } }));
  if (!u) return null;
  return { id: u.id, tenantId: u.tenantId, nameBn: u.nameBn, nameEn: u.nameEn, phone: u.phone ?? undefined, email: u.email ?? undefined, passwordHash: u.passwordHash, pinHash: u.pinHash ?? undefined, plan: u.tenant.plan, roles: u.roles.map((r) => ({ organizationId: r.organizationId, organizationName: r.organization.name, role: r.role as Role })) };
}

/** TODO(auth slice): replace devHash with argon2id. Kept simple so the scaffold runs without native deps. */
export const checkPassword = (u: UserRecord, password: string) => u.passwordHash === devHash(password);
export const checkPin = (u: UserRecord, pin: string) => Boolean(u.pinHash) && u.pinHash === devHash(pin);
