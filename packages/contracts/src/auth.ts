import { z } from "zod";
import { Plan, Role } from "./common.js";

export const LoginRequest = z.object({
  identifier: z.string().min(3), // phone (digits) or email
  password: z.string().min(8),
  deviceLabel: z.string().max(80).optional(),
  /** Demo only (API without a database): pretend the facility is on this plan so plan locks can be reviewed. Ignored otherwise. */
  demoPlan: Plan.optional(),
});
export const Me = z.object({
  userId: z.string(),
  nameBn: z.string(),
  nameEn: z.string(),
  tenantId: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  role: Role,
  plan: Plan,
  roles: z.array(z.object({ organizationId: z.string(), role: Role })),
  /** ADR 0010: signed in with a one-time password — set your own password and PIN before anything else */
  mustSetCredentials: z.boolean().default(false),
  /** gap 10: the keys this device keeps its drafts and queued writes with — held in memory only, never stored */
  deviceKeys: z.object({ draft: z.string(), outbox: z.string(), queue: z.string() }).optional(),
  /** external review A1: AI drafting is switched on (AI_PROVIDER ≠ off) — the consultation shows its AI panel */
  ai: z.boolean().default(true),
});
export type Me = z.infer<typeof Me>;

export const PinVerifyRequest = z.object({ pin: z.string().regex(/^\d{4}$/) });
export const PinVerifyResponse = z.object({ ok: z.boolean(), triesLeft: z.number().int().optional(), lockedUntil: z.string().optional() });

/** GET /me/capabilities — the nav is derived from this; the client never decides access alone. */
const Denial = z.enum(["role", "plan", "unknown"]);
export const CapabilityScreen = z.object({ key: z.string(), name_bn: z.string(), name_en: z.string(), icon: z.string(), allowed: z.boolean(), reason: Denial.optional(), needs: Plan.optional(), needsPatient: z.boolean(), badge: z.string().optional() });
export const CapabilityModule = z.object({ key: z.string(), name_bn: z.string(), name_en: z.string(), icon: z.string(), plan: Plan, locked: Denial.optional(), screens: z.array(CapabilityScreen) });
export const Capabilities = z.object({ modules: z.array(CapabilityModule) });
export type Capabilities = z.infer<typeof Capabilities>;
export type CapabilityModule = z.infer<typeof CapabilityModule>;
export type CapabilityScreen = z.infer<typeof CapabilityScreen>;

/** gap 10: entries the device dropped — tampered (its own key, failed the check) or foreign (another device's) */
export const DeviceDropped = z.object({ count: z.number().int().min(1).max(10_000), reason: z.enum(["tampered", "foreign"]), kinds: z.array(z.enum(["write", "draft"])).max(2) });

