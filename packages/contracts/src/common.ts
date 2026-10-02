import { z } from "zod";

/** Every error the API returns. Screens show message_bn by default. */
export const ApiError = z.object({
  code: z.string(),
  message_bn: z.string(),
  message_en: z.string(),
  field: z.string().optional(),
  /** For 403 on cross-facility reads (domain rule 4). */
  reason: z.string().optional(),
  canRequest: z.boolean().optional(),
  /** Validation: every field that needs attention, with a code the screen maps to its i18n message. */
  fields: z.array(z.object({ field: z.string(), code: z.string() })).optional(),
  /** Conflict (409): the existing resource, e.g. the patient's open visit today. */
  existing: z.record(z.unknown()).optional(),
  /** Sign refused (422 sign_blocked): every reason, as @setu/domain signBlockers returns them (the screen shows the same). */
  blockers: z.array(z.record(z.unknown())).optional(),
  /** Wrong signing PIN (401 pin_wrong) / locked (423 pin_locked). */
  triesLeft: z.number().int().optional(),
  lockedUntil: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

export const Role = z.enum(["receptionist", "doctor", "nurse", "labTech", "pathologist", "pharmacist", "cashier", "owner", "admin"]);
export const Plan = z.enum(["clinic", "lite", "pro"]);
export const Lang = z.enum(["bn", "en"]);

/** Bangladesh mobile as the API stores it: 10 digits after +880, e.g. 1711234567. */
export const PhoneDigits = z.string().regex(/^1[3-9]\d{8}$/, "invalid_bd_mobile");

/** Money on the wire is integer paisa. */
export const Paisa = z.number().int().nonnegative();

export const Cursor = z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(25) });
export const Page = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), next: z.string().nullable() });
