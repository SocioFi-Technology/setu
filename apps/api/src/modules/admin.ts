/* Admin service (phase 2 slice 3, ADR 0010; prototype Setu Admin). Runs inside command()/query(), so RLS scopes every
   read to the tenant; the facility is the session's. Owner / admin only (the routes check adm/*; the rules here check
   who may change whom).
   - Facility and go-live: details, branch, wards with beds, settings, a test SMS; Go live only when the checklist
     (@setu/domain goLiveChecklist) is complete.
   - Users: a user is created with one role here and a one-time password (shown once, 24 h); role change, deactivate,
     reactivate and password reset bump the user's session generation, so their sessions end everywhere.
   - Price list: edited in place with an append-only ChargePriceChange row per change (the database refuses a price
     change without it); bills keep the price they were made with.
   - Audit log: filters and a CSV export (the export is itself audited and flagged). */
import { randomInt } from "node:crypto";
import type { AuditPage, AuditQuery, FacilityUpdate, FacilityView, PriceCreate, PriceHistory, PriceList, SettingsUpdate, UserCreate, UserCredentialResponse, UserList, UserView } from "@setu/contracts";
import type { Tx } from "@setu/db";
import { BED_CLASSES_SAMPLE,
  FLAGGED_ACTIONS, ONE_TIME_PASSWORD_HOURS, REG_BODY, createUserBlockers, deactivateBlockers, goLiveBlockers, goLiveChecklist, isFlagged, labelPageOk, limitProblems,
  priceChangeProblems, roleChangeBlockers, type GoLiveFacts, type Role, type UserAdminBlocker,
  smsSafeName,
  ackMinutesOk, shiftHoursOk, toleranceOk,
} from "@setu/domain";
import { messenger } from "../adapters/messaging/index.js";
import { registration } from "../adapters/registration.js";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { notFound } from "./frontdesk.js";
import { hashSecret } from "./secrets.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const APPROVERS: Role[] = ["owner", "admin"];
const BLOCK_MSG: Record<UserAdminBlocker, [string, string]> = {
  self: ["নিজের ভূমিকা বা অ্যাকাউন্ট নিজে বদলানো যায় না", "You cannot change your own role or account"],
  owner_only: ["শুধু মালিক কাউকে মালিক করতে বা মালিকের ভূমিকা বদলাতে পারেন", "Only an owner makes or changes an owner"],
  last_approver: ["প্রতিষ্ঠানে অন্তত একজন সক্রিয় মালিক বা অ্যাডমিন থাকতে হবে", "The facility must keep one active owner or admin"],
};
const blocked = (b: UserAdminBlocker[]) => { const [bn, en] = BLOCK_MSG[b[0]!]; return err(b[0] === "last_approver" ? 409 : 403, b[0]!, bn, en, { reason: "role", canRequest: false }); };

async function people(tx: Tx, ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const rows = list.length ? await tx.user.findMany({ where: { id: { in: list } }, select: { id: true, nameBn: true, nameEn: true } }) : [];
  const m = new Map(rows.map((r) => [r.id, r]));
  return (id: string) => m.get(id) ?? { id, nameBn: "—", nameEn: "—" };
}
const org = (tx: Tx, s: SessionData) => tx.organization.findFirstOrThrow({ where: { id: s.organizationId } });

/* ───── facility and go-live ───── */
async function goLiveFacts(tx: Tx, s: SessionData): Promise<{ facts: GoLiveFacts; o: Awaited<ReturnType<typeof org>> }> {
  const o = await org(tx, s);
  const [branches, wards, doctors, defs] = await Promise.all([
    tx.location.count({ where: { organizationId: s.organizationId, kind: "branch" } }),
    tx.location.findMany({ where: { organizationId: s.organizationId, kind: "ward" }, select: { id: true, _count: { select: { children: { where: { kind: "bed" } } } } } }),
    tx.user.findMany({ where: { active: true, roles: { some: { organizationId: s.organizationId, role: "doctor" } } }, select: { id: true, practitioner: { select: { regVerified: true, regBody: true } } } }),
    tx.chargeItemDefinition.findMany({ where: { organizationId: s.organizationId, active: true }, select: { kind: true, refCode: true } }),
  ]);
  const feeFor = new Set(defs.filter((d) => d.kind === "consultation").map((d) => d.refCode));
  // the plan as the tenant holds it now (a session's copy can be stale)
  const plan = (await tx.tenant.findFirst({ where: { id: s.tenantId }, select: { plan: true } }))?.plan ?? s.plan;
  return { o, facts: {
    plan, org: { name: o.name, address: o.address, licenceNo: o.licenceNo }, branches, wardsWithBeds: wards.filter((w) => w._count.children > 0).length,
    verifiedDoctors: doctors.filter((d) => d.practitioner?.regVerified && d.practitioner.regBody === "BMDC").length, doctorsWithoutFee: doctors.filter((d) => !feeFor.has(d.id)).length,
    pricedItems: defs.length, receiptFormat: o.receiptFormat, rxFormat: o.rxFormat, paymentMethods: o.paymentMethods, smsTestedAt: iso(o.smsTestedAt),
  } };
}
export async function facilityView(tx: Tx, s: SessionData): Promise<FacilityView> {
  const { o, facts } = await goLiveFacts(tx, s);
  const [branches, wards] = await Promise.all([
    tx.location.findMany({ where: { organizationId: s.organizationId, kind: "branch" }, orderBy: { name: "asc" } }),
    tx.location.findMany({ where: { organizationId: s.organizationId, kind: "ward" }, orderBy: { name: "asc" }, include: { _count: { select: { children: { where: { kind: "bed" } } } } } }),
  ]);
  return {
    id: o.id, name: o.name, nameBn: o.nameBn, address: o.address, licenceNo: o.licenceNo, plan: facts.plan, status: o.status, liveAt: iso(o.liveAt),
    checklist: goLiveChecklist(facts),
    branches: branches.map((b) => ({ id: b.id, name: b.name, nameBn: b.nameBn })),
    wards: wards.map((w) => ({ id: w.id, name: w.name, nameBn: w.nameBn, beds: w._count.children })),
    settings: {
      cashierLimitPaisa: o.cashierDiscountLimitPaisa, cashierLimitBp: o.cashierDiscountLimitBp, approverLimitPaisa: o.approverLimitPaisa,
      labelWidthMm: o.labelWidthMm, labelHeightMm: o.labelHeightMm, receiptFormat: o.receiptFormat as "a5" | "thermal" | null, rxFormat: o.rxFormat as "a5" | "a4" | null,
      paymentMethods: o.paymentMethods as FacilityView["settings"]["paymentMethods"],
      grnToleranceBp: o.grnToleranceBp, grnTolerancePaisa: o.grnTolerancePaisa,
    },
    escalation: {
      ackMinutes: o.escalationAckMinutes, dutyDoctorIds: o.escalationDutyDoctorIds, sample: true as const,
      doctors: (await tx.practitionerRole.findMany({ where: { organizationId: s.organizationId, role: "doctor", user: { active: true } }, select: { user: { select: { id: true, nameBn: true, nameEn: true } } } })).map((r) => r.user),
    },
    shifts: { startHours: o.shiftStartHours, ioDayStartHour: o.ioDayStartHour, sample: true as const },
    sms: { testedAt: iso(o.smsTestedAt), phone: o.smsTestPhone ? `0${o.smsTestPhone}` : null, sentAt: iso(o.smsTestSentAt), awaitingConfirm: smsAwaitingConfirm(o, new Date()), error: o.smsTestError },
  };
}
export async function updateFacility(tx: Tx, s: SessionData, req: FacilityUpdate): Promise<AuditEntry[]> {
  const o = await org(tx, s);
  const data = { name: req.name, nameBn: req.nameBn || null, address: req.address || null, licenceNo: req.licenceNo || null };
  await tx.organization.update({ where: { id: o.id }, data });
  return [{ action: "update", entity: "Organization", entityId: o.id, detail: { before: { name: o.name, nameBn: o.nameBn, address: o.address, licenceNo: o.licenceNo }, after: data } }];
}
export async function addBranch(tx: Tx, s: SessionData, name: string, nameBn: string | undefined) {
  return tx.location.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, kind: "branch", name, nameBn: nameBn || null } });
}
/** A ward under the facility's first branch, with its beds (vacant), named W-1 … */
export async function addWard(tx: Tx, s: SessionData, req: { name: string; nameBn?: string; beds: number; bedClass: string }) {
  const branch = await tx.location.findFirst({ where: { organizationId: s.organizationId, kind: "branch" }, orderBy: { name: "asc" } });
  if (!branch) throw err(409, "branch_first", "আগে একটি শাখা যোগ করুন", "Add a branch first");
  const ward = await tx.location.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, parentId: branch.id, kind: "ward", name: req.name, nameBn: req.nameBn || null } });
  await tx.location.createMany({ data: Array.from({ length: req.beds }, (_, i) => ({ tenantId: s.tenantId, organizationId: s.organizationId, parentId: ward.id, kind: "bed" as const, name: `${req.name}-${i + 1}`, bedClass: req.bedClass, bedState: "vacant" as const })) });
  // ADR 0017 (review): a ward's class has a daily rate from the start — the sample rate until the owner sets it (a class
  // without one leaves its bed days unpriced, never ৳0)
  const sample = BED_CLASSES_SAMPLE.find((c) => c.key === req.bedClass);
  if (sample && !(await tx.bedClassRate.findFirst({ where: { organizationId: s.organizationId, bedClass: req.bedClass }, select: { id: true } })))
    await tx.bedClassRate.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, bedClass: sample.key, nameEn: sample.nameEn, nameBn: sample.nameBn, perDayPaisa: sample.perDayPaisa, sample: true } });
  return ward;
}
export async function updateSettings(tx: Tx, s: SessionData, req: SettingsUpdate): Promise<AuditEntry[]> {
  const o = await org(tx, s);
  const lp = limitProblems({ cashierLimitPaisa: req.cashierLimitPaisa, cashierLimitBp: req.cashierLimitBp, approverLimitPaisa: req.approverLimitPaisa });
  if (lp.length) throw err(400, lp[0]!, "অনুমোদন সীমা ঠিক নেই — ক্যাশিয়ারের সীমা অনুমোদনকারীর চেয়ে বেশি হতে পারে না, শতাংশ ৫০%-এর বেশি নয়", "Approval limits are not valid — the cashier's limit cannot be above the approver's; the percent at most 50%", { field: lp[0] === "percent_range" ? "cashierLimitBp" : "cashierLimitPaisa" });
  if (!labelPageOk(req.labelWidthMm, req.labelHeightMm)) throw err(400, "label_page", "লেবেলের মাপ ২০–১৫০ × ১৫–১৫০ মিমি", "The label page is 20–150 × 15–150 mm", { field: "labelWidthMm" });
  if (!req.paymentMethods.length) throw err(400, "payment_method_required", "অন্তত একটি পেমেন্ট মাধ্যম চালু রাখুন", "Keep at least one payment method on", { field: "paymentMethods" });
  // decision 180: the receipt price tolerance is an approval limit too (a change needs the reason, flagged)
  const tol = { grnToleranceBp: req.grnToleranceBp ?? o.grnToleranceBp, grnTolerancePaisa: req.grnTolerancePaisa ?? o.grnTolerancePaisa };
  if (!toleranceOk({ bp: tol.grnToleranceBp, paisa: tol.grnTolerancePaisa })) throw err(400, "tolerance_range", "মাল গ্রহণের দামের সীমা ০–১০% ও ০–৳১,০০০", "The receipt price tolerance is 0–10% and ৳0–1,000", { field: "grnToleranceBp" });
  const limitsChanged = o.cashierDiscountLimitPaisa !== req.cashierLimitPaisa || o.cashierDiscountLimitBp !== req.cashierLimitBp || o.approverLimitPaisa !== req.approverLimitPaisa
    || o.grnToleranceBp !== tol.grnToleranceBp || o.grnTolerancePaisa !== tol.grnTolerancePaisa;
  const reason = req.reason?.trim() ?? "";
  // ADR 0015 escalation reach: N minutes 5–120; the duty list only names active doctors of this facility
  if (req.escalationAckMinutes !== undefined && !ackMinutesOk(req.escalationAckMinutes)) throw err(400, "ack_minutes", "স্বীকৃতির সময় ৫–১২০ মিনিট", "The acknowledgement time is 5–120 minutes", { field: "escalationAckMinutes" });
  if (req.escalationDutyDoctorIds?.length) {
    const ok = new Set((await tx.practitionerRole.findMany({ where: { organizationId: s.organizationId, role: "doctor", userId: { in: req.escalationDutyDoctorIds }, user: { active: true } }, select: { userId: true } })).map((r) => r.userId));
    if (req.escalationDutyDoctorIds.some((d) => !ok.has(d))) throw err(400, "duty_doctor", "তালিকায় এই প্রতিষ্ঠানের সক্রিয় ডাক্তার রাখুন", "The duty list names active doctors of this facility", { field: "escalationDutyDoctorIds" });
  }
  if (limitsChanged && reason.length < 10) throw err(400, "reason_required", "অনুমোদন সীমা বদলানোর কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write why the approval limits change (at least 10 characters)", { field: "reason" });
  // ADR 0016 samples: 1–4 distinct shift start hours, the I/O day start 0–23
  if (req.shiftStartHours !== undefined && !shiftHoursOk(req.shiftStartHours)) throw err(400, "shift_hours", "শিফট শুরুর সময় ১–৪টি, ০–২৩ ঘণ্টা, আলাদা", "Shift starts: 1–4 different hours, 0–23", { field: "shiftStartHours" });
  const escBefore = { escalationAckMinutes: o.escalationAckMinutes, escalationDutyDoctorIds: o.escalationDutyDoctorIds, shiftStartHours: o.shiftStartHours, ioDayStartHour: o.ioDayStartHour };
  const escAfter = { escalationAckMinutes: req.escalationAckMinutes ?? o.escalationAckMinutes, escalationDutyDoctorIds: req.escalationDutyDoctorIds ? [...new Set(req.escalationDutyDoctorIds)] : o.escalationDutyDoctorIds,
    shiftStartHours: req.shiftStartHours ? [...req.shiftStartHours].sort((a, b) => a - b) : o.shiftStartHours, ioDayStartHour: req.ioDayStartHour ?? o.ioDayStartHour };
  const before = { grnToleranceBp: o.grnToleranceBp, grnTolerancePaisa: o.grnTolerancePaisa, cashierLimitPaisa: o.cashierDiscountLimitPaisa, cashierLimitBp: o.cashierDiscountLimitBp, approverLimitPaisa: o.approverLimitPaisa, labelWidthMm: o.labelWidthMm, labelHeightMm: o.labelHeightMm, receiptFormat: o.receiptFormat, rxFormat: o.rxFormat, paymentMethods: o.paymentMethods };
  const after = { ...tol, cashierLimitPaisa: req.cashierLimitPaisa, cashierLimitBp: req.cashierLimitBp, approverLimitPaisa: req.approverLimitPaisa, labelWidthMm: req.labelWidthMm, labelHeightMm: req.labelHeightMm, receiptFormat: req.receiptFormat, rxFormat: req.rxFormat, paymentMethods: [...new Set(req.paymentMethods)] };
  await tx.organization.update({ where: { id: o.id }, data: {
    cashierDiscountLimitPaisa: after.cashierLimitPaisa, cashierDiscountLimitBp: after.cashierLimitBp, approverLimitPaisa: after.approverLimitPaisa,
    labelWidthMm: after.labelWidthMm, labelHeightMm: after.labelHeightMm, receiptFormat: after.receiptFormat, rxFormat: after.rxFormat, paymentMethods: after.paymentMethods,
    ...tol, ...escAfter,
  } });
  return [{ action: "settings-change", entity: "Organization", entityId: o.id, detail: { before: { ...before, ...escBefore }, after: { ...after, ...escAfter }, reason: reason || null, limitsChanged } }];
}
/** ADR 0012: a test SMS the gateway accepted waits up to a day for the admin to confirm it arrived. */
const SMS_CONFIRM_MS = 24 * 3600_000;
const smsAwaitingConfirm = (o: { smsTestSentAt: Date | null; smsTestedAt: Date | null }, now: Date) =>
  !!o.smsTestSentAt && !o.smsTestedAt && now.getTime() - o.smsTestSentAt.getTime() < SMS_CONFIRM_MS;
/** A test SMS through the messaging adapter (the go-live check that the sender works). Delivered (a gateway that
    confirms delivery) → done; sent (BulkSMSBD: no delivery reports) → done once the admin confirms it arrived. */
export async function smsTest(tx: Tx, s: SessionData, phone: string, now: Date): Promise<AuditEntry[]> {
  const o = await org(tx, s);
  const r = await messenger.sendSms({ messageId: `smstest_${o.id}_${now.getTime()}`, to: phone, text: `${smsSafeName(o.name)}: Setu test message. No action needed.`, tenantId: s.tenantId });
  if (r.status === "failed") {
    const [bn, en] = r.reason === "setup"
      ? ["SMS গেটওয়ে নিল না — প্রেরক আইডি, ব্যালান্স ও IP অনুমতি দেখুন", "The SMS gateway refused it — check the sender ID, the balance and the IP whitelist"]
      : r.reason === "number" ? ["এই নম্বরে SMS যায় না", "This number cannot take an SMS"]
      : r.reason === "no-answer" ? ["গেটওয়ে উত্তর দেয়নি — SMS হয়তো গেছে; ফোন দেখে আবার চেষ্টা করুন", "The gateway did not answer — it may have been sent; check the phone, then try again"]
      : ["পরীক্ষার SMS যায়নি — আবার চেষ্টা করুন", "The test SMS was not sent — try again"];
    // controls review: a failed test undoes any earlier one — go-live needs a sender that works now. Stored (not thrown)
    // so the failure commits and the checklist shows it.
    await tx.organization.update({ where: { id: o.id }, data: { smsTestSentAt: null, smsTestedAt: null, smsTestError: `${bn}\n${en}`, smsTestPhone: phone.slice(1) } });
    return [{ action: "create", entity: "SmsTest", entityId: o.id, detail: { provider: messenger.name, outcome: "failed", reason: r.reason ?? null, error: r.error } }];
  }
  await tx.organization.update({ where: { id: o.id }, data: { smsTestSentAt: now, smsTestedAt: r.status === "delivered" ? now : null, smsTestError: null, smsTestPhone: phone.slice(1) } });
  return [{ action: "create", entity: "SmsTest", entityId: o.id, detail: { provider: messenger.name, providerRef: r.providerRef, outcome: r.status } }];
}
/** The admin confirms the test SMS arrived (a gateway without delivery reports, ADR 0012). */
export async function smsTestConfirm(tx: Tx, s: SessionData, now: Date): Promise<AuditEntry[]> {
  const o = await org(tx, s);
  if (!smsAwaitingConfirm(o, now)) throw err(409, "nothing_to_confirm", "নিশ্চিত করার মতো কোনো পরীক্ষা SMS নেই — আবার পাঠান", "No test SMS is waiting to be confirmed — send one again");
  await tx.organization.update({ where: { id: o.id }, data: { smsTestedAt: now } });
  return [{ action: "update", entity: "SmsTest", entityId: o.id, detail: { event: "confirmed-arrived", sentAt: o.smsTestSentAt!.toISOString() } }];
}
export async function goLive(tx: Tx, s: SessionData, now: Date): Promise<AuditEntry[]> {
  await tx.$queryRaw`SELECT 1 FROM "Organization" WHERE "id" = ${s.organizationId} FOR UPDATE`;
  const { o, facts } = await goLiveFacts(tx, s);
  if (o.status === "live") throw err(409, "already_live", "প্রতিষ্ঠান আগেই চালু", "The facility is already live");
  const b = goLiveBlockers(facts);
  if (b.length) throw err(422, "checklist_incomplete", "চেকলিস্ট সম্পূর্ণ করুন", "Complete the checklist first", { blockers: b.map((code) => ({ code })) });
  await tx.organization.update({ where: { id: o.id }, data: { status: "live", liveAt: now } });
  return [{ action: "go-live", entity: "Organization", entityId: o.id, detail: { checklist: goLiveChecklist(facts) } }];
}

/* ───── users and roles ───── */
const OTP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const oneTimePassword = () => Array.from({ length: 10 }, () => OTP_ALPHABET[randomInt(OTP_ALPHABET.length)]).join("");
type UserRow = Awaited<ReturnType<typeof usersHere>>[number];
const usersHere = (tx: Tx, s: SessionData, ids?: string[]) => tx.user.findMany({
  where: { roles: { some: { organizationId: s.organizationId } }, ...(ids ? { id: { in: ids } } : {}) },
  include: { roles: { where: { organizationId: s.organizationId }, orderBy: { id: "asc" } }, practitioner: true }, orderBy: { nameEn: "asc" },
});
const toView = (u: UserRow): UserView => {
  const role = u.roles[0]!.role as Role;
  const body = REG_BODY[role];
  return {
    // phones are stored without the leading 0 (some older seed rows keep it)
    id: u.id, nameBn: u.nameBn, nameEn: u.nameEn, phone: u.phone ? (u.phone.startsWith("0") ? u.phone : `0${u.phone}`) : null, role, active: u.active,
    firstSignInPending: u.mustChangePassword, lastLoginAt: iso(u.lastLoginAt),
    registration: body ? { body, number: u.practitioner?.regNo ?? null, verified: Boolean(u.practitioner?.regVerified) } : null,
    deactivated: !u.active && u.deactivatedAt ? { at: u.deactivatedAt.toISOString(), reason: u.deactivatedReason ?? "" } : null,
  };
};
/** active owners / admins who have set their own password (a pending one-time password does not keep the facility open) */
const activeApprovers = (tx: Tx, s: SessionData) => tx.user.count({ where: { active: true, mustChangePassword: false, roles: { some: { organizationId: s.organizationId, role: { in: APPROVERS } } } } });
export async function userList(tx: Tx, s: SessionData): Promise<UserList> {
  return { items: (await usersHere(tx, s)).map(toView), activeApprovers: await activeApprovers(tx, s) };
}
async function userHere(tx: Tx, s: SessionData, id: string): Promise<UserRow> {
  // one user at a time per facility (two admins deactivating the last two approvers at once must not both succeed)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7020, hashtext(${s.organizationId}))`;
  const u = (await usersHere(tx, s, [id]))[0];
  if (!u) throw notFound();
  return u;
}
/** The account is the person's across the owner's facilities (one password, one PIN, one registration): an admin here
    changes it only when the person works here alone, and only an owner touches an account that is an owner anywhere
    (security review: a reset at one facility must not hand over an owner's account at another). */
async function guardAccount(tx: Tx, s: SessionData, u: UserRow) {
  const all = await tx.practitionerRole.findMany({ where: { userId: u.id }, select: { organizationId: true, role: true } });
  if (all.some((r) => r.role === "owner") && s.role !== "owner") throw blocked(["owner_only"]);
  if (all.some((r) => r.organizationId !== s.organizationId))
    throw err(409, "works_elsewhere", "এই ব্যবহারকারী অন্য প্রতিষ্ঠানেও কাজ করেন — মালিকের সাথে কথা বলুন", "This user also works at another facility — ask the owner");
}
const actor = (s: SessionData) => ({ id: s.userId, role: s.role as Role });
const credential = (u: UserRow, otp: string, expiresAt: Date): UserCredentialResponse => ({ user: toView(u), oneTimePassword: otp, expiresAt: expiresAt.toISOString() });

export async function createUser(tx: Tx, s: SessionData, req: UserCreate, now: Date): Promise<{ res: UserCredentialResponse; audit: AuditEntry[] }> {
  const b = createUserBlockers(s.role as Role, req.role);
  if (b.length) throw blocked(b);
  const phone = req.phone.slice(1);
  if (await tx.user.findFirst({ where: { OR: [{ phone }, { phone: `0${phone}` }] }, select: { id: true } }))
    throw err(409, "phone_in_use", "এই নম্বরে আগেই একজন ব্যবহারকারী আছেন", "A user with this phone already exists", { field: "phone" });
  const body = REG_BODY[req.role];
  if (body && !req.regNo?.trim()) throw err(400, "reg_required", `${body} নিবন্ধন নম্বর লিখুন`, `Enter the ${body} registration number`, { field: "regNo" });
  const otp = oneTimePassword(), expiresAt = new Date(now.getTime() + ONE_TIME_PASSWORD_HOURS * 3600_000);
  const u = await tx.user.create({ data: { tenantId: s.tenantId, nameBn: req.nameBn, nameEn: req.nameEn, phone, passwordHash: await hashSecret(otp), mustChangePassword: true, tempPasswordExpiresAt: expiresAt } });
  await tx.practitionerRole.create({ data: { tenantId: s.tenantId, userId: u.id, organizationId: s.organizationId, role: req.role } });
  if (body) await tx.practitioner.create({ data: { tenantId: s.tenantId, userId: u.id, regBody: body, regNo: req.regNo!.trim().toUpperCase(), regVerified: false } });
  const row = (await usersHere(tx, s, [u.id]))[0]!;
  return { res: credential(row, otp, expiresAt), audit: [{ action: "create", entity: "User", entityId: u.id, detail: { role: req.role, phoneLast4: phone.slice(-4), regBody: body ?? null } }] };
}
export async function changeRole(tx: Tx, s: SessionData, id: string, role: Role, reason: string | undefined): Promise<{ user: UserView; audit: AuditEntry[] }> {
  const u = await userHere(tx, s, id);
  const current = u.roles[0]!.role as Role;
  if (current === role) throw err(409, "unchanged", "একই ভূমিকা", "That is already their role", { field: "role" });
  if (u.id !== s.userId) await guardAccount(tx, s, u);
  const b = roleChangeBlockers({ actor: actor(s), target: { id: u.id, role: current, active: u.active }, newRole: role, activeApprovers: await activeApprovers(tx, s) });
  if (b.length) throw blocked(b);
  await tx.practitionerRole.update({ where: { id: u.roles[0]!.id }, data: { role } });
  // the registration follows the role: another licensing body starts unverified (a nurse's BNMC never counts as a
  // doctor's BMDC — controls review); signed notes keep the registration they were signed with
  const body = REG_BODY[role];
  if (body && !u.practitioner) await tx.practitioner.create({ data: { tenantId: s.tenantId, userId: u.id, regBody: body, regVerified: false } });
  else if (body && u.practitioner && u.practitioner.regBody !== body) await tx.practitioner.update({ where: { id: u.practitioner.id }, data: { regBody: body, regNo: null, regVerified: false } });
  await tx.user.update({ where: { id: u.id }, data: { sessionGeneration: { increment: 1 } } });
  return { user: toView((await usersHere(tx, s, [u.id]))[0]!), audit: [{ action: "role-change", entity: "User", entityId: u.id, detail: { from: current, to: role, reason: reason?.trim() || null } }] };
}
export async function setActive(tx: Tx, s: SessionData, id: string, active: boolean, reason: string, now: Date): Promise<{ user: UserView; audit: AuditEntry[] }> {
  const u = await userHere(tx, s, id);
  if (u.active === active) throw err(409, "unchanged", active ? "আগেই সক্রিয়" : "আগেই বন্ধ", active ? "Already active" : "Already switched off");
  if (!active) {
    const b = deactivateBlockers({ actor: actor(s), target: { id: u.id, role: u.roles[0]!.role as Role, active: u.active }, activeApprovers: await activeApprovers(tx, s) });
    if (b.length) throw blocked(b);
    if (reason.trim().length < 10) throw err(400, "reason_required", "কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write a reason (at least 10 characters)", { field: "reason" });
    await guardAccount(tx, s, u);
  } else {
    if (u.id === s.userId) throw blocked(["self"]);
    // only an owner brings back an owner (security review)
    await guardAccount(tx, s, u);
  }
  await tx.user.update({ where: { id: u.id }, data: active
    ? { active: true, deactivatedAt: null, deactivatedReason: null }
    : { active: false, deactivatedAt: now, deactivatedReason: reason.trim(), sessionGeneration: { increment: 1 } } });
  return { user: toView((await usersHere(tx, s, [u.id]))[0]!), audit: [{ action: active ? "reactivate" : "deactivate", entity: "User", entityId: u.id, detail: { reason: reason.trim() || null } }] };
}
export async function resetPassword(tx: Tx, s: SessionData, id: string, now: Date): Promise<{ res: UserCredentialResponse; audit: AuditEntry[] }> {
  const u = await userHere(tx, s, id);
  if (u.id === s.userId) throw blocked(["self"]);
  await guardAccount(tx, s, u);
  if (!u.active) throw err(409, "inactive", "বন্ধ ব্যবহারকারী — আগে চালু করুন", "This user is switched off — reactivate first");
  const otp = oneTimePassword(), expiresAt = new Date(now.getTime() + ONE_TIME_PASSWORD_HOURS * 3600_000);
  await tx.user.update({ where: { id: u.id }, data: { passwordHash: await hashSecret(otp), pinHash: null, mustChangePassword: true, tempPasswordExpiresAt: expiresAt, tempPasswordUsedAt: null, sessionGeneration: { increment: 1 } } });
  return { res: credential((await usersHere(tx, s, [u.id]))[0]!, otp, expiresAt), audit: [{ action: "reset-password", entity: "User", entityId: u.id }] };
}
export async function verifyRegistration(tx: Tx, s: SessionData, id: string, regNo: string | undefined): Promise<{ user: UserView; audit: AuditEntry[] }> {
  const u = await userHere(tx, s, id);
  const body = REG_BODY[u.roles[0]!.role as Role];
  if (!body || !u.practitioner) throw err(409, "no_registration", "এই ভূমিকায় নিবন্ধন লাগে না", "This role has no registration");
  await guardAccount(tx, s, u);
  const number = (regNo?.trim().toUpperCase() || u.practitioner.regNo) ?? "";
  if (!number) throw err(400, "reg_required", `${body} নিবন্ধন নম্বর লিখুন`, `Enter the ${body} registration number`, { field: "regNo" });
  const r = await registration.verify(body, number);
  await tx.practitioner.update({ where: { id: u.practitioner.id }, data: { regNo: number, regVerified: r.status === "verified" } });
  return { user: toView((await usersHere(tx, s, [u.id]))[0]!), audit: [{ action: "update", entity: "Practitioner", entityId: u.practitioner.id, detail: { event: "verify-registration", body, regNo: number, status: r.status, provider: registration.name } }] };
}

/* ───── the price list ───── */
export async function priceList(tx: Tx, s: SessionData): Promise<PriceList> {
  const defs = await tx.chargeItemDefinition.findMany({ where: { organizationId: s.organizationId }, orderBy: [{ kind: "asc" }, { nameEn: "asc" }] });
  const changes = await tx.chargePriceChange.findMany({ where: { definitionId: { in: defs.map((d) => d.id) } }, orderBy: { at: "desc" } });
  const last = new Map<string, (typeof changes)[number]>();
  for (const c of changes) if (!last.has(c.definitionId)) last.set(c.definitionId, c);
  const doctors = await tx.user.findMany({ where: { active: true, roles: { some: { organizationId: s.organizationId, role: "doctor" } } }, select: { id: true, nameBn: true, nameEn: true } });
  const who = await people(tx, [...changes.map((c) => c.byId), ...defs.map((d) => (d.kind === "consultation" ? d.refCode : null))]);
  const tests = await tx.orderableTest.findMany({ where: { active: true }, select: { code: true, nameEn: true, nameBn: true }, orderBy: { nameEn: "asc" } });
  const priced = new Set(defs.filter((d) => d.kind === "test" && d.active).map((d) => d.refCode));
  const fee = new Set(defs.filter((d) => d.kind === "consultation" && d.active).map((d) => d.refCode));
  return {
    items: defs.map((d) => {
      const c = last.get(d.id);
      return { id: d.id, code: d.code, kind: d.kind, nameEn: d.nameEn, nameBn: d.nameBn, unitPaisa: d.unitPaisa, vatRateBp: d.vatRateBp, active: d.active, sample: d.sample,
        doctor: d.kind === "consultation" && d.refCode ? who(d.refCode) : null,
        lastChange: c ? { at: c.at.toISOString(), by: who(c.byId), oldUnitPaisa: c.oldUnitPaisa, reason: c.reason } : null };
    }),
    doctorsWithoutFee: doctors.filter((d) => !fee.has(d.id)),
    tests: tests.map((t) => ({ ...t, priced: priced.has(t.code) })),
  };
}
async function history(tx: Tx, s: SessionData, d: { id: string; code: string }, oldU: number | null, oldV: number | null, newU: number, newV: number, reason: string | null, now: Date) {
  await tx.chargePriceChange.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, definitionId: d.id, code: d.code, oldUnitPaisa: oldU, newUnitPaisa: newU, oldVatRateBp: oldV, newVatRateBp: newV, reason, byId: s.userId, at: now } });
}
export async function createPrice(tx: Tx, s: SessionData, req: PriceCreate, now: Date): Promise<AuditEntry[]> {
  let code: string, nameEn: string, nameBn: string, refCode: string | null = null;
  if (req.kind === "consultation") {
    const doc = await tx.user.findFirst({ where: { id: req.ref ?? "", roles: { some: { organizationId: s.organizationId, role: "doctor" } } } });
    if (!doc) throw err(404, "doctor_not_found", "এই ডাক্তার এই প্রতিষ্ঠানে নেই", "This doctor is not at this facility", { field: "ref" });
    code = `consult:${doc.id}`; refCode = doc.id; nameEn = `Consultation — ${doc.nameEn}`; nameBn = `পরামর্শ — ${doc.nameBn}`;
  } else if (req.kind === "test") {
    const t = await tx.orderableTest.findFirst({ where: { code: req.ref ?? "", active: true } });
    if (!t) throw err(404, "test_not_found", "এই পরীক্ষা তালিকায় নেই", "This test is not on the list", { field: "ref" });
    code = `test:${t.code}`; refCode = t.code; nameEn = t.nameEn; nameBn = t.nameBn;
  } else {
    if (!req.nameEn || !req.nameBn) throw err(400, "name_required", "সেবার নাম বাংলা ও ইংরেজিতে লিখুন", "Enter the service name in Bangla and English", { field: "nameEn" });
    nameEn = req.nameEn; nameBn = req.nameBn;
    // a readable slug plus a short random part: two similar names (or a Bangla-only one) never collide
    code = `svc:${req.nameEn.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "item"}-${randomInt(36 ** 4).toString(36).padStart(4, "0")}`;
  }
  const p = priceChangeProblems({ oldUnitPaisa: null, oldVatBp: null, unitPaisa: req.unitPaisa, vatRateBp: req.vatRateBp, reason: "" });
  if (p.length) throw err(400, p[0]!, "মূল্য ঠিক নেই", "The price is not valid", { field: "unitPaisa" });
  if (await tx.chargeItemDefinition.findFirst({ where: { organizationId: s.organizationId, code }, select: { id: true } }))
    throw err(409, "already_priced", "এটি আগেই মূল্যতালিকায় আছে — দাম বদলাতে সেটি খুলুন", "This is already on the price list — open it to change the price", { field: "ref" });
  const d = await tx.chargeItemDefinition.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, code, kind: req.kind, refCode, nameEn, nameBn, unitPaisa: req.unitPaisa, vatRateBp: req.vatRateBp, sample: false } });
  await history(tx, s, d, null, null, req.unitPaisa, req.vatRateBp, null, now);
  return [{ action: "create", entity: "ChargeItemDefinition", entityId: d.id, detail: { code, unitPaisa: req.unitPaisa, vatRateBp: req.vatRateBp } }];
}
export async function changePrice(tx: Tx, s: SessionData, id: string, req: { unitPaisa: number; vatRateBp: number; reason: string }, now: Date): Promise<AuditEntry[]> {
  await tx.$queryRaw`SELECT 1 FROM "ChargeItemDefinition" WHERE "id" = ${id} FOR UPDATE`;
  const d = await tx.chargeItemDefinition.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!d) throw notFound();
  const p = priceChangeProblems({ oldUnitPaisa: d.unitPaisa, oldVatBp: d.vatRateBp, unitPaisa: req.unitPaisa, vatRateBp: req.vatRateBp, reason: req.reason });
  if (p.length) {
    const [bn, en] = p[0] === "reason_required" ? ["দাম বদলানোর কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write why the price changes (at least 10 characters)"] : p[0] === "unchanged" ? ["দাম বদলায়নি", "The price did not change"] : ["মূল্য ঠিক নেই", "The price is not valid"];
    throw err(p[0] === "unchanged" ? 409 : 400, p[0]!, bn, en, { field: p[0] === "reason_required" ? "reason" : "unitPaisa" });
  }
  await tx.chargeItemDefinition.update({ where: { id: d.id }, data: { unitPaisa: req.unitPaisa, vatRateBp: req.vatRateBp, sample: false } });
  await history(tx, s, d, d.unitPaisa, d.vatRateBp, req.unitPaisa, req.vatRateBp, req.reason.trim(), now);
  return [{ action: "price-change", entity: "ChargeItemDefinition", entityId: d.id, detail: { code: d.code, from: { unitPaisa: d.unitPaisa, vatRateBp: d.vatRateBp }, to: { unitPaisa: req.unitPaisa, vatRateBp: req.vatRateBp }, reason: req.reason.trim() } }];
}
export async function setPriceActive(tx: Tx, s: SessionData, id: string, active: boolean, reason: string): Promise<AuditEntry[]> {
  const d = await tx.chargeItemDefinition.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!d) throw notFound();
  if (reason.trim().length < 10) throw err(400, "reason_required", "কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write a reason (at least 10 characters)", { field: "reason" });
  if (!active && d.kind === "consultation" && d.refCode && (await tx.user.findFirst({ where: { id: d.refCode, active: true }, select: { id: true } })))
    throw err(409, "doctor_active", "ডাক্তার সক্রিয় — তাঁর ফি বন্ধ করলে নতুন বিলে মূল্য থাকবে না; ফি বদলান বা আগে ডাক্তারকে বন্ধ করুন", "The doctor is active — their new bills would have no price; change the fee, or switch the doctor off first");
  await tx.chargeItemDefinition.update({ where: { id: d.id }, data: { active } });
  return [{ action: "price-change", entity: "ChargeItemDefinition", entityId: d.id, detail: { code: d.code, active, reason: reason.trim() } }];
}
export async function priceHistory(tx: Tx, s: SessionData, id: string): Promise<PriceHistory> {
  const d = await tx.chargeItemDefinition.findFirst({ where: { id, organizationId: s.organizationId }, select: { id: true } });
  if (!d) throw notFound();
  const rows = await tx.chargePriceChange.findMany({ where: { definitionId: d.id }, orderBy: { at: "desc" }, take: 100 });
  const who = await people(tx, rows.map((r) => r.byId));
  return { items: rows.map((r) => ({ id: r.id, at: r.at.toISOString(), by: who(r.byId), oldUnitPaisa: r.oldUnitPaisa, newUnitPaisa: r.newUnitPaisa, oldVatRateBp: r.oldVatRateBp, newVatRateBp: r.newVatRateBp, reason: r.reason })) };
}

/* ───── the audit log ───── */
const PAGE = 100, EXPORT_MAX = 5000;
/** events written as an update with this kind, flagged like the flagged actions (a bill void: update + event void) */
const FLAGGED_EVENTS = ["void"];
const dayStart = (d: string) => new Date(`${d}T00:00:00+06:00`);
/** This facility's events; the owner also sees the tenant-level ones (no facility: sign-ins, public QR checks). The
    "Flags" filter matches the flagged actions and the events written as an update of that kind (a bill void). */
function auditWhere(s: SessionData, q: AuditQuery) {
  const and: object[] = [
    s.role === "owner" ? { OR: [{ organizationId: s.organizationId }, { organizationId: null }] } : { organizationId: s.organizationId },
  ];
  if (q.from || q.to) and.push({ at: { ...(q.from ? { gte: dayStart(q.from) } : {}), ...(q.to ? { lt: new Date(dayStart(q.to).getTime() + 864e5) } : {}) } });
  if (q.userId) and.push({ userId: q.userId });
  if (q.action) and.push({ action: q.action });
  if (q.entity) and.push({ entity: q.entity });
  if (q.patientId) and.push({ patientId: q.patientId });
  if (q.flagged === "1") and.push({ OR: [{ action: { in: [...FLAGGED_ACTIONS] as string[] } }, ...FLAGGED_EVENTS.map((e) => ({ detail: { path: ["event"], equals: e } }))] });
  return { AND: and };
}
/** The detail a person reading the log needs beside the action and the record (which the screen names in its own
    language): the event, purpose, kind, reason or note as written — never a clinical value. */
function summary(e: { detail: unknown }): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  return [d.event, d.purpose, d.kind, d.reason, d.note].filter((x): x is string => typeof x === "string" && x.length > 0).join(" · ").slice(0, 200);
}
async function auditRows(tx: Tx, s: SessionData, q: AuditQuery, take: number) {
  const cursor = q.before ? await tx.auditEvent.findFirst({ where: { id: q.before }, select: { at: true, id: true } }) : null;
  const where = { AND: [auditWhere(s, q), ...(cursor ? [{ OR: [{ at: { lt: cursor.at } }, { at: cursor.at, id: { lt: cursor.id } }] }] : [])] };
  const rows = await tx.auditEvent.findMany({ where, orderBy: [{ at: "desc" }, { id: "desc" }], take: take + 1 });
  const users = await people(tx, rows.map((r) => r.userId));
  const pats = new Map((await tx.patient.findMany({ where: { id: { in: rows.flatMap((r) => (r.patientId ? [r.patientId] : [])) } }, select: { id: true, facilityNo: true, nameBn: true, nameEn: true } })).map((p) => [p.id, p]));
  const items = rows.slice(0, take).map((r) => ({
    id: r.id, at: r.at.toISOString(), user: r.userId ? users(r.userId) : null, role: r.role, action: r.action, entity: r.entity, entityId: r.entityId,
    patient: r.patientId ? pats.get(r.patientId) ?? null : null, ip: r.ip, route: ((r.detail ?? {}) as { route?: string }).route ?? null,
    summary: summary(r), flagged: isFlagged(r.action) || FLAGGED_EVENTS.includes(((r.detail ?? {}) as { event?: string }).event ?? ""),
  }));
  return { items, more: rows.length > take };
}
export async function auditPage(tx: Tx, s: SessionData, q: AuditQuery): Promise<AuditPage> {
  const r = await auditRows(tx, s, q, PAGE);
  return { items: r.items, next: r.more ? r.items[r.items.length - 1]!.id : null };
}
const csvCell = (v: unknown) => { const t = v === null || v === undefined ? "" : String(v); const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t; return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
/** CSV of the filtered log (at most 5,000 rows, newest first); formula-looking cells are neutralised. */
export async function auditCsv(tx: Tx, s: SessionData, q: AuditQuery): Promise<{ csv: string; rows: number; truncated: boolean }> {
  const r = await auditRows(tx, s, { ...q, before: undefined }, EXPORT_MAX);
  const head = ["at", "user", "role", "action", "entity", "entityId", "patient", "ip", "route", "summary", "flagged"];
  const lines = r.items.map((x) => [x.at, x.user?.nameEn ?? "", x.role ?? "", x.action, x.entity, x.entityId ?? "", x.patient?.facilityNo ?? "", x.ip ?? "", x.route ?? "", x.summary, x.flagged ? "yes" : ""].map(csvCell).join(","));
  return { csv: [head.join(","), ...lines].join("\r\n") + "\r\n", rows: r.items.length, truncated: r.more };
}
