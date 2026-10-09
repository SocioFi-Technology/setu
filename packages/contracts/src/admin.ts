/* Admin contracts (phase 2 slice 3, ADR 0010; prototype Setu Admin): the facility and its go-live checklist, users and
   roles, the price list with its history, settings, the audit log. Money is paisa. */
import { z } from "zod";
import { Paisa, Role } from "./common.js";

const Person = z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() });
const Reason = z.string().trim().max(500);
const Phone = z.string().regex(/^01[3-9]\d{8}$/);

/* ── facility and go-live ── */
export const GoLiveItem = z.enum(["organization", "branch", "wards", "doctor", "price_list", "templates", "payment_method", "test_sms"]);
export const PaymentMethodKey = z.enum(["cash", "card", "bank", "bkash", "nagad"]);
export const FacilityView = z.object({
  id: z.string(), name: z.string(), nameBn: z.string().nullable(), address: z.string().nullable(), licenceNo: z.string().nullable(),
  /** ADR 0021 */
  phone: z.string().nullable(), networkJoinedAt: z.string().nullable(),
  /** ADR 0022 */
  homeCollection: z.boolean(), homeCollectionFeePaisa: Paisa, networkTurnaroundHours: z.number().int(),
  plan: z.enum(["clinic", "lite", "pro"]), status: z.enum(["setup", "live"]), liveAt: z.string().nullable(),
  checklist: z.array(z.object({ item: GoLiveItem, done: z.boolean(), required: z.boolean() })),
  branches: z.array(z.object({ id: z.string(), name: z.string(), nameBn: z.string().nullable() })),
  wards: z.array(z.object({ id: z.string(), name: z.string(), nameBn: z.string().nullable(), beds: z.number().int() })),
  settings: z.object({
    cashierLimitPaisa: Paisa, cashierLimitBp: z.number().int(), approverLimitPaisa: Paisa,
    labelWidthMm: z.number().int(), labelHeightMm: z.number().int(),
    receiptFormat: z.enum(["a5", "thermal"]).nullable(), rxFormat: z.enum(["a5", "a4"]).nullable(),
    paymentMethods: z.array(PaymentMethodKey),
    /** decision 180 (external review A6): a receipt line may differ from the order by min(bp, paisa) — the pharmacist posts it */
    grnToleranceBp: z.number().int(), grnTolerancePaisa: z.number().int(),
  }),
  /** ADR 0015: escalation reach — an escalation no doctor acknowledges in the app within `ackMinutes` is raised to the
      doctors on duty (the list, or every active doctor when it is empty). Samples: a clinician decides both. */
  escalation: z.object({ ackMinutes: z.number().int(), dutyDoctorIds: z.array(z.string()), doctors: z.array(z.object({ id: z.string(), nameBn: z.string(), nameEn: z.string() })), sample: z.literal(true) }),
  /** ADR 0016 samples: shift start hours (Dhaka) and the intake/output day start */
  shifts: z.object({ startHours: z.array(z.number().int()), ioDayStartHour: z.number().int(), sample: z.literal(true) }),
  /** ADR 0012: sentAt without testedAt = the gateway accepted the test SMS and the admin has not confirmed it arrived */
  sms: z.object({ testedAt: z.string().nullable(), phone: z.string().nullable(), sentAt: z.string().nullable(), awaitingConfirm: z.boolean(), error: z.string().nullable() }),
});
export type FacilityView = z.infer<typeof FacilityView>;
export const FacilityUpdate = z.object({ name: z.string().trim().min(2).max(120), nameBn: z.string().trim().max(120).optional(), address: z.string().trim().max(300).optional(), licenceNo: z.string().trim().max(60).optional(),
  /** ADR 0021: the number the patient app tells a patient to call ("" clears it; left out: unchanged) */
  phone: z.union([z.literal(""), z.string().trim().regex(/^\+?[0-9][0-9 -]{4,18}$/)]).optional(),
  /** ADR 0021: joined the Setu network — patients can share their records with this facility's doctors (left out: unchanged) */
  network: z.boolean().optional(),
  /** ADR 0022: the network offer — home collection, its fee, the promised turnaround (left out: unchanged) */
  homeCollection: z.boolean().optional(), homeCollectionFeePaisa: Paisa.max(1_000_000).optional(), networkTurnaroundHours: z.number().int().min(1).max(720).optional() });
export const PriceNetwork = z.object({ network: z.boolean() });
export type FacilityUpdate = z.infer<typeof FacilityUpdate>;
export const BranchCreate = z.object({ name: z.string().trim().min(2).max(80), nameBn: z.string().trim().max(80).optional() });
export const WardCreate = z.object({ name: z.string().trim().min(1).max(80), nameBn: z.string().trim().max(80).optional(), beds: z.number().int().min(1).max(100), bedClass: z.string().trim().max(40).default("General") });
export const SettingsUpdate = z.object({
  cashierLimitPaisa: Paisa, cashierLimitBp: z.number().int().min(0).max(5000), approverLimitPaisa: Paisa,
  labelWidthMm: z.number().int(), labelHeightMm: z.number().int(),
  receiptFormat: z.enum(["a5", "thermal"]), rxFormat: z.enum(["a5", "a4"]),
  paymentMethods: z.array(PaymentMethodKey).max(5),
  /** required when an approval limit changes (flagged in the audit log) */
  reason: Reason.optional(),
  /** ADR 0015 escalation reach (left out: unchanged) */
  escalationAckMinutes: z.number().int().optional(),
  escalationDutyDoctorIds: z.array(z.string().max(64)).max(100).optional(),
  /** ADR 0016 (left out: unchanged) */
  shiftStartHours: z.array(z.number().int()).max(4).optional(),
  ioDayStartHour: z.number().int().min(0).max(23).optional(),
  /** decision 180 (left out: unchanged; a change needs the reason, like the approval limits) */
  grnToleranceBp: z.number().int().min(0).max(1000).optional(),
  grnTolerancePaisa: z.number().int().min(0).max(100_000).optional(),
});
export type SettingsUpdate = z.infer<typeof SettingsUpdate>;
export const SmsTestRequest = z.object({ phone: Phone });

/* ── users and roles ── */
export const UserView = z.object({
  id: z.string(), nameBn: z.string(), nameEn: z.string(), phone: z.string().nullable(), role: Role, active: z.boolean(),
  /** a one-time password is waiting to be replaced at the first sign-in */
  firstSignInPending: z.boolean(), lastLoginAt: z.string().nullable(),
  registration: z.object({ body: z.enum(["BMDC", "BNMC"]), number: z.string().nullable(), verified: z.boolean() }).nullable(),
  deactivated: z.object({ at: z.string(), reason: z.string() }).nullable(),
});
export type UserView = z.infer<typeof UserView>;
export const UserList = z.object({ items: z.array(UserView), activeApprovers: z.number().int() });
export type UserList = z.infer<typeof UserList>;
export const UserCreate = z.object({
  nameBn: z.string().trim().min(2).max(80), nameEn: z.string().trim().min(2).max(80), phone: Phone, role: Role,
  /** BMDC (doctor, pathologist) / BNMC (nurse) registration number */
  regNo: z.string().trim().max(30).optional(),
});
export type UserCreate = z.infer<typeof UserCreate>;
/** The one-time password is in this answer only (never stored in the idempotency record, never shown again). */
export const UserCredentialResponse = z.object({ user: UserView, oneTimePassword: z.string().nullable(), expiresAt: z.string() });
export type UserCredentialResponse = z.infer<typeof UserCredentialResponse>;
export const RoleChange = z.object({ role: Role, reason: Reason.optional() });
export const DeactivateRequest = z.object({ reason: Reason });
export const FirstSignInRequest = z.object({ password: z.string().min(1).max(128), pin: z.string().max(8) });
export type FirstSignInRequest = z.infer<typeof FirstSignInRequest>;

/* ── the price list ── */
export const PriceItem = z.object({
  id: z.string(), code: z.string(), kind: z.enum(["consultation", "test", "service", "medicine"]), nameEn: z.string(), nameBn: z.string(),
  unitPaisa: Paisa, vatRateBp: z.number().int(), active: z.boolean(), sample: z.boolean(),
  /** ADR 0022: a test offered to the Setu network (at this price) */
  network: z.boolean(),
  /** consultation: the doctor */
  doctor: Person.nullable(),
  lastChange: z.object({ at: z.string(), by: Person, oldUnitPaisa: Paisa.nullable(), reason: z.string().nullable() }).nullable(),
});
export type PriceItem = z.infer<typeof PriceItem>;
export const PriceList = z.object({ items: z.array(PriceItem), doctorsWithoutFee: z.array(Person), tests: z.array(z.object({ code: z.string(), nameEn: z.string(), nameBn: z.string(), priced: z.boolean() })) });
export type PriceList = z.infer<typeof PriceList>;
export const PriceCreate = z.object({
  kind: z.enum(["consultation", "test", "service"]),
  /** consultation: the doctor's user id; test: the orderable test code; service: none */
  ref: z.string().trim().max(64).optional(),
  nameEn: z.string().trim().min(2).max(120).optional(), nameBn: z.string().trim().min(1).max(120).optional(),
  unitPaisa: Paisa, vatRateBp: z.number().int().min(0).max(10_000).default(0),
});
export type PriceCreate = z.infer<typeof PriceCreate>;
export const PriceChange = z.object({ unitPaisa: Paisa, vatRateBp: z.number().int().min(0).max(10_000), reason: Reason });
export type PriceChange = z.infer<typeof PriceChange>;
export const PriceActive = z.object({ active: z.boolean(), reason: Reason });
export const PriceHistory = z.object({ items: z.array(z.object({ id: z.string(), at: z.string(), by: Person, oldUnitPaisa: Paisa.nullable(), newUnitPaisa: Paisa, oldVatRateBp: z.number().int().nullable(), newVatRateBp: z.number().int(), reason: z.string().nullable() })) });
export type PriceHistory = z.infer<typeof PriceHistory>;

/* ── the audit log ── */
export const AuditQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  userId: z.string().max(64).optional(), action: z.string().max(40).optional(), entity: z.string().max(60).optional(), patientId: z.string().max(64).optional(),
  flagged: z.enum(["1", "0"]).optional(),
  /** the id of the last row of the page before (older rows follow) */
  before: z.string().max(64).optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;
export const AuditRow = z.object({
  id: z.string(), at: z.string(), user: Person.nullable(), role: z.string().nullable(), action: z.string(), entity: z.string(), entityId: z.string().nullable(),
  patient: z.object({ id: z.string(), facilityNo: z.string(), nameBn: z.string(), nameEn: z.string().nullable() }).nullable(),
  ip: z.string().nullable(), route: z.string().nullable(), summary: z.string(), flagged: z.boolean(),
});
export const AuditPage = z.object({ items: z.array(AuditRow), next: z.string().nullable() });
export type AuditPage = z.infer<typeof AuditPage>;
