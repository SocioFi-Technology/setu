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
import {
  FLAGGED_ACTIONS, ONE_TIME_PASSWORD_HOURS, REG_BODY, createUserBlockers, deactivateBlockers, goLiveBlockers, goLiveChecklist, isFlagged, labelPageOk, limitProblems,
  priceChangeProblems, roleChangeBlockers, type GoLiveFacts, type Role, type UserAdminBlocker,
} from "@setu/domain";
import { messenger } from "../adapters/messaging/index.js";
import { registration } from "../adapters/registration.js";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { notFound } from "./frontdesk.js";
import { devHash } from "./users.js";

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
    tx.user.findMany({ where: { active: true, roles: { some: { organizationId: s.organizationId, role: "doctor" } } }, select: { id: true, practitioner: { select: { regVerified: true } } } }),
    tx.chargeItemDefinition.findMany({ where: { organizationId: s.organizationId, active: true }, select: { kind: true, refCode: true } }),
  ]);
  const feeFor = new Set(defs.filter((d) => d.kind === "consultation").map((d) => d.refCode));
  return { o, facts: {
    plan: s.plan, org: { name: o.name, address: o.address, licenceNo: o.licenceNo }, branches, wardsWithBeds: wards.filter((w) => w._count.children > 0).length,
    verifiedDoctors: doctors.filter((d) => d.practitioner?.regVerified).length, doctorsWithoutFee: doctors.filter((d) => !feeFor.has(d.id)).length,
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
    id: o.id, name: o.name, nameBn: o.nameBn, address: o.address, licenceNo: o.licenceNo, plan: s.plan, status: o.status, liveAt: iso(o.liveAt),
    checklist: goLiveChecklist(facts),
    branches: branches.map((b) => ({ id: b.id, name: b.name, nameBn: b.nameBn })),
    wards: wards.map((w) => ({ id: w.id, name: w.name, nameBn: w.nameBn, beds: w._count.children })),
    settings: {
      cashierLimitPaisa: o.cashierDiscountLimitPaisa, cashierLimitBp: o.cashierDiscountLimitBp, approverLimitPaisa: o.approverLimitPaisa,
      labelWidthMm: o.labelWidthMm, labelHeightMm: o.labelHeightMm, receiptFormat: o.receiptFormat as "a5" | "thermal" | null, rxFormat: o.rxFormat as "a5" | "a4" | null,
      paymentMethods: o.paymentMethods as FacilityView["settings"]["paymentMethods"],
    },
    sms: { testedAt: iso(o.smsTestedAt), phone: o.smsTestPhone ? `0${o.smsTestPhone}` : null },
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
  return ward;
}
export async function updateSettings(tx: Tx, s: SessionData, req: SettingsUpdate): Promise<AuditEntry[]> {
  const o = await org(tx, s);
  const lp = limitProblems({ cashierLimitPaisa: req.cashierLimitPaisa, cashierLimitBp: req.cashierLimitBp, approverLimitPaisa: req.approverLimitPaisa });
  if (lp.length) throw err(400, lp[0]!, "অনুমোদন সীমা ঠিক নেই — ক্যাশিয়ারের সীমা অনুমোদনকারীর চেয়ে বেশি হতে পারে না, শতাংশ ৫০%-এর বেশি নয়", "Approval limits are not valid — the cashier's limit cannot be above the approver's; the percent at most 50%", { field: lp[0] === "percent_range" ? "cashierLimitBp" : "cashierLimitPaisa" });
  if (!labelPageOk(req.labelWidthMm, req.labelHeightMm)) throw err(400, "label_page", "লেবেলের মাপ ২০–১৫০ × ১৫–১৫০ মিমি", "The label page is 20–150 × 15–150 mm", { field: "labelWidthMm" });
  if (!req.paymentMethods.length) throw err(400, "payment_method_required", "অন্তত একটি পেমেন্ট মাধ্যম চালু রাখুন", "Keep at least one payment method on", { field: "paymentMethods" });
  const limitsChanged = o.cashierDiscountLimitPaisa !== req.cashierLimitPaisa || o.cashierDiscountLimitBp !== req.cashierLimitBp || o.approverLimitPaisa !== req.approverLimitPaisa;
  const reason = req.reason?.trim() ?? "";
  if (limitsChanged && reason.length < 10) throw err(400, "reason_required", "অনুমোদন সীমা বদলানোর কারণ লিখুন (অন্তত ১০ অক্ষর)", "Write why the approval limits change (at least 10 characters)", { field: "reason" });
  const before = { cashierLimitPaisa: o.cashierDiscountLimitPaisa, cashierLimitBp: o.cashierDiscountLimitBp, approverLimitPaisa: o.approverLimitPaisa, labelWidthMm: o.labelWidthMm, labelHeightMm: o.labelHeightMm, receiptFormat: o.receiptFormat, rxFormat: o.rxFormat, paymentMethods: o.paymentMethods };
  const after = { cashierLimitPaisa: req.cashierLimitPaisa, cashierLimitBp: req.cashierLimitBp, approverLimitPaisa: req.approverLimitPaisa, labelWidthMm: req.labelWidthMm, labelHeightMm: req.labelHeightMm, receiptFormat: req.receiptFormat, rxFormat: req.rxFormat, paymentMethods: [...new Set(req.paymentMethods)] };
  await tx.organization.update({ where: { id: o.id }, data: {
    cashierDiscountLimitPaisa: after.cashierLimitPaisa, cashierDiscountLimitBp: after.cashierLimitBp, approverLimitPaisa: after.approverLimitPaisa,
    labelWidthMm: after.labelWidthMm, labelHeightMm: after.labelHeightMm, receiptFormat: after.receiptFormat, rxFormat: after.rxFormat, paymentMethods: after.paymentMethods,
  } });
  return [{ action: "settings-change", entity: "Organization", entityId: o.id, detail: { before, after, reason: reason || null, limitsChanged } }];
}
/** A test SMS through the messaging adapter (the go-live check that the sender works). */
export async function smsTest(tx: Tx, s: SessionData, phone: string, now: Date): Promise<AuditEntry[]> {
  const o = await org(tx, s);
  const r = await messenger.sendSms({ messageId: `smstest_${o.id}_${now.getTime()}`, to: phone, text: `${o.name}: Setu test message. No action needed.`, tenantId: s.tenantId });
  if (r.status !== "delivered") throw err(502, "sms_failed", "পরীক্ষার SMS যায়নি — আবার চেষ্টা করুন", "The test SMS was not delivered — try again", { field: "phone" });
  await tx.organization.update({ where: { id: o.id }, data: { smsTestedAt: now, smsTestPhone: phone.slice(1) } });
  return [{ action: "create", entity: "SmsTest", entityId: o.id, detail: { provider: messenger.name, providerRef: r.providerRef } }];
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
  include: { roles: { where: { organizationId: s.organizationId } }, practitioner: true }, orderBy: { nameEn: "asc" },
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
const activeApprovers = (tx: Tx, s: SessionData) => tx.user.count({ where: { active: true, roles: { some: { organizationId: s.organizationId, role: { in: APPROVERS } } } } });
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
  const u = await tx.user.create({ data: { tenantId: s.tenantId, nameBn: req.nameBn, nameEn: req.nameEn, phone, passwordHash: devHash(otp), mustChangePassword: true, tempPasswordExpiresAt: expiresAt } });
  await tx.practitionerRole.create({ data: { tenantId: s.tenantId, userId: u.id, organizationId: s.organizationId, role: req.role } });
  if (body) await tx.practitioner.create({ data: { tenantId: s.tenantId, userId: u.id, regBody: body, regNo: req.regNo!.trim().toUpperCase(), regVerified: false } });
  const row = (await usersHere(tx, s, [u.id]))[0]!;
  return { res: credential(row, otp, expiresAt), audit: [{ action: "create", entity: "User", entityId: u.id, detail: { role: req.role, phoneLast4: phone.slice(-4), regBody: body ?? null } }] };
}
export async function changeRole(tx: Tx, s: SessionData, id: string, role: Role, reason: string | undefined): Promise<{ user: UserView; audit: AuditEntry[] }> {
  const u = await userHere(tx, s, id);
  const current = u.roles[0]!.role as Role;
  if (current === role) throw err(409, "unchanged", "একই ভূমিকা", "That is already their role", { field: "role" });
  const b = roleChangeBlockers({ actor: actor(s), target: { id: u.id, role: current, active: u.active }, newRole: role, activeApprovers: await activeApprovers(tx, s) });
  if (b.length) throw blocked(b);
  await tx.practitionerRole.update({ where: { id: u.roles[0]!.id }, data: { role } });
  const body = REG_BODY[role];
  if (body && !u.practitioner) await tx.practitioner.create({ data: { tenantId: s.tenantId, userId: u.id, regBody: body, regVerified: false } });
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
    // a user who also works at another facility of this owner is switched off there by that facility's admin
    if (await tx.practitionerRole.findFirst({ where: { userId: u.id, organizationId: { not: s.organizationId } }, select: { id: true } }))
      throw err(409, "works_elsewhere", "এই ব্যবহারকারী অন্য প্রতিষ্ঠানেও কাজ করেন", "This user also works at another facility");
  } else if (u.id === s.userId) throw blocked(["self"]);
  await tx.user.update({ where: { id: u.id }, data: active
    ? { active: true, deactivatedAt: null, deactivatedReason: null }
    : { active: false, deactivatedAt: now, deactivatedReason: reason.trim(), sessionGeneration: { increment: 1 } } });
  return { user: toView((await usersHere(tx, s, [u.id]))[0]!), audit: [{ action: active ? "reactivate" : "deactivate", entity: "User", entityId: u.id, detail: { reason: reason.trim() || null } }] };
}
export async function resetPassword(tx: Tx, s: SessionData, id: string, now: Date): Promise<{ res: UserCredentialResponse; audit: AuditEntry[] }> {
  const u = await userHere(tx, s, id);
  if (u.id === s.userId) throw blocked(["self"]);
  if ((u.roles[0]!.role as Role) === "owner" && s.role !== "owner") throw blocked(["owner_only"]);
  if (!u.active) throw err(409, "inactive", "বন্ধ ব্যবহারকারী — আগে চালু করুন", "This user is switched off — reactivate first");
  const otp = oneTimePassword(), expiresAt = new Date(now.getTime() + ONE_TIME_PASSWORD_HOURS * 3600_000);
  await tx.user.update({ where: { id: u.id }, data: { passwordHash: devHash(otp), pinHash: null, mustChangePassword: true, tempPasswordExpiresAt: expiresAt, sessionGeneration: { increment: 1 } } });
  return { res: credential((await usersHere(tx, s, [u.id]))[0]!, otp, expiresAt), audit: [{ action: "reset-password", entity: "User", entityId: u.id }] };
}
export async function verifyRegistration(tx: Tx, s: SessionData, id: string, regNo: string | undefined): Promise<{ user: UserView; audit: AuditEntry[] }> {
  const u = await userHere(tx, s, id);
  const body = REG_BODY[u.roles[0]!.role as Role];
  if (!body || !u.practitioner) throw err(409, "no_registration", "এই ভূমিকায় নিবন্ধন লাগে না", "This role has no registration");
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
    code = `svc:${req.nameEn.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;
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
const dayStart = (d: string) => new Date(`${d}T00:00:00+06:00`);
function auditWhere(q: AuditQuery) {
  return {
    ...(q.from || q.to ? { at: { ...(q.from ? { gte: dayStart(q.from) } : {}), ...(q.to ? { lt: new Date(dayStart(q.to).getTime() + 864e5) } : {}) } } : {}),
    ...(q.userId ? { userId: q.userId } : {}), ...(q.action ? { action: q.action } : {}), ...(q.entity ? { entity: q.entity } : {}), ...(q.patientId ? { patientId: q.patientId } : {}),
    ...(q.flagged === "1" ? { action: { in: [...FLAGGED_ACTIONS] as string[] } } : {}),
  };
}
/** One line for a person reading the log (never a clinical value — the detail stays in the record). */
function summary(e: { action: string; entity: string; detail: unknown }): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  const bits = [d.event, d.purpose, d.kind, d.reason, d.note].filter((x): x is string => typeof x === "string" && x.length > 0);
  return [`${e.action} ${e.entity}`, ...bits].join(" · ").slice(0, 200);
}
async function auditRows(tx: Tx, q: AuditQuery, take: number) {
  const cursor = q.before ? await tx.auditEvent.findFirst({ where: { id: q.before }, select: { at: true, id: true } }) : null;
  const where = { ...auditWhere(q), ...(cursor ? { OR: [{ at: { lt: cursor.at } }, { at: cursor.at, id: { lt: cursor.id } }] } : {}) };
  const rows = await tx.auditEvent.findMany({ where, orderBy: [{ at: "desc" }, { id: "desc" }], take: take + 1 });
  const users = await people(tx, rows.map((r) => r.userId));
  const pats = new Map((await tx.patient.findMany({ where: { id: { in: rows.flatMap((r) => (r.patientId ? [r.patientId] : [])) } }, select: { id: true, facilityNo: true, nameBn: true, nameEn: true } })).map((p) => [p.id, p]));
  const items = rows.slice(0, take).map((r) => ({
    id: r.id, at: r.at.toISOString(), user: r.userId ? users(r.userId) : null, role: r.role, action: r.action, entity: r.entity, entityId: r.entityId,
    patient: r.patientId ? pats.get(r.patientId) ?? null : null, ip: r.ip, route: ((r.detail ?? {}) as { route?: string }).route ?? null,
    summary: summary(r), flagged: isFlagged(r.action),
  }));
  return { items, more: rows.length > take };
}
export async function auditPage(tx: Tx, q: AuditQuery): Promise<AuditPage> {
  const r = await auditRows(tx, q, PAGE);
  return { items: r.items, next: r.more ? r.items[r.items.length - 1]!.id : null };
}
const csvCell = (v: unknown) => { const t = v === null || v === undefined ? "" : String(v); const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t; return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
/** CSV of the filtered log (at most 5,000 rows, newest first); formula-looking cells are neutralised. */
export async function auditCsv(tx: Tx, q: AuditQuery): Promise<{ csv: string; rows: number; truncated: boolean }> {
  const r = await auditRows(tx, { ...q, before: undefined }, EXPORT_MAX);
  const head = ["at", "user", "role", "action", "entity", "entityId", "patient", "ip", "route", "summary", "flagged"];
  const lines = r.items.map((x) => [x.at, x.user?.nameEn ?? "", x.role ?? "", x.action, x.entity, x.entityId ?? "", x.patient?.facilityNo ?? "", x.ip ?? "", x.route ?? "", x.summary, x.flagged ? "yes" : ""].map(csvCell).join(","));
  return { csv: [head.join(","), ...lines].join("\r\n") + "\r\n", rows: r.items.length, truncated: r.more };
}
