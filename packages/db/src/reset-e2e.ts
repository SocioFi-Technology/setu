/* `pnpm db:reset-e2e`: puts the E2E Test Clinic's walkthrough family back to its seeded state (no links, seeded
   identity confidence, no open reviews) before a journey run. Touches only tenant t_e2e; never the demo clinic.
   Patients and visits the tests create stay in t_e2e, out of the demo clinic's queue. */
import { createHash } from "node:crypto";
import { ALLERGY, APPROVAL, ENCOUNTER, transition, type EncounterState, SHIFT } from "@setu/domain";
import { owner as db } from "./owner.ts";
import { SEED_BED_STATES } from "./wards.ts";

const T = "t_e2e";
// Runs as the database owner (RLS does not apply): only against a local database unless explicitly allowed (security review A5).
const host = (() => { try { return new URL(process.env.DATABASE_URL ?? "").hostname; } catch { return ""; } })();
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) && process.env.E2E_RESET_ALLOWED !== "1") {
  console.error(`reset-e2e refuses to run against database host "${host}" (set E2E_RESET_ALLOWED=1 for a disposable test database)`);
  process.exit(1);
}
const FAMILY: Record<string, "verified" | "unverified" | "possible_duplicate"> = {
  e2e_p_rahima: "verified", e2e_p_karim: "verified", e2e_p_sumaiya: "verified", e2e_p_ayesha: "unverified", e2e_p_rbegum: "possible_duplicate",
};

const tenant = await db.tenant.findUnique({ where: { id: T } });
if (!tenant) { console.error("E2E Test Clinic not seeded — run `pnpm db:seed` first"); process.exit(1); }
for (const [id, identityConfidence] of Object.entries(FAMILY))
  await db.patient.updateMany({ where: { id, tenantId: T }, data: { linkedToId: null, identityConfidence } });
// Open reviews on the family are closed as rejected (requested → rejected is an APPROVAL transition).
const n = await db.task.updateMany({ where: { tenantId: T, kind: "patient-link-review", status: "requested", focusId: { in: Object.keys(FAMILY) } }, data: { status: "rejected", decisionNote: "e2e reset", decidedAt: new Date() } });
// Link-anyway overrides the desk undid in earlier runs (decision 49) are marked reviewed so they leave the admin queue.
const undone = (await db.task.findMany({ where: { tenantId: T, kind: "patient-link-review", status: "approved", decisionNote: "link-anyway" } }))
  .filter((t) => { const d = (t.detail ?? {}) as { undo?: unknown; review?: unknown }; return d.undo && !d.review; });
for (const t of undone)
  await db.task.update({ where: { id: t.id }, data: { detail: { ...(t.detail as object), review: { by: "e2e-reset", at: new Date().toISOString(), outcome: "undo-reviewed", reason: "e2e reset" } } } });

/* Slice A5 (Kamrul 02/10/2026: no purge, no safety trigger switched off, not even here). Nothing is deleted:
   - allergies the journeys or a hands-on test recorded on the family are marked entered-in-error (ADR 0004, the only
     change the database allows), and Rahima's two seeded allergies are recorded again if a run marked them in error;
   - visits left open by earlier runs are closed through ENCOUNTER: waiting / vitals done → cancel, with doctor →
     markError (a test leftover, not a real visit). Every visit in t_e2e is made by a test or a hands-on check.
   Signed notes stay as they are; specs never depend on counts. The reset acts as the E2E admin and audits each change. */
const now = new Date();
const RESET_BY = "u_e2e_admin";
const audit: { action: string; entity: string; entityId: string; patientId?: string; detail: object }[] = [];
const SEEDED_ALLERGIES = ["e2e_al_rahima_pen", "e2e_al_rahima_sulfa"];
const family = Object.keys(FAMILY);
const extra = await db.allergyIntolerance.findMany({ where: { tenantId: T, status: "active", patientId: { in: family }, id: { notIn: SEEDED_ALLERGIES } } });
for (const a of extra) {
  const to = transition("allergy", ALLERGY, "active", "markError");
  await db.allergyIntolerance.update({ where: { id: a.id }, data: { status: to.replace(/-/g, "_") as "entered_in_error", errorReason: "e2e reset: allergy recorded by a test run", errorById: RESET_BY, errorAt: now } });
  await db.provenance.create({ data: { tenantId: T, targetType: "AllergyIntolerance", targetId: a.id, activity: "allergy-entered-in-error", agentId: RESET_BY, onBehalfOf: a.organizationId, recorded: now, source: "provider_verified", reason: "e2e reset", detail: { e2eReset: true } } });
  audit.push({ action: "update", entity: "AllergyIntolerance", entityId: a.id, patientId: a.patientId, detail: { event: "markError", e2eReset: true } });
}
let restored = 0;
for (const id of SEEDED_ALLERGIES) {
  const seeded = await db.allergyIntolerance.findFirst({ where: { id, tenantId: T } });
  if (!seeded || seeded.status === "active" || seeded.tenantId !== T) continue;
  if (await db.allergyIntolerance.count({ where: { tenantId: T, patientId: seeded.patientId, status: "active", kind: seeded.kind, key: seeded.key } })) continue;
  const { id: _id, status: _s, errorReason: _r, errorById: _b, errorAt: _a, recordedAt: _t, recordedById: _w, ...copy } = seeded;
  // Recorded again by the reset account (never in the original clinician's name).
  const a = await db.allergyIntolerance.create({ data: { ...copy, tenantId: T, recordedById: RESET_BY, recordedAt: now } });
  await db.provenance.create({ data: { tenantId: T, targetType: "AllergyIntolerance", targetId: a.id, activity: "record-allergy", agentId: RESET_BY, onBehalfOf: seeded.organizationId, recorded: now, source: "provider_verified", reason: "e2e reset", detail: { e2eReset: true, restores: id } } });
  audit.push({ action: "create", entity: "AllergyIntolerance", entityId: a.id, patientId: a.patientId, detail: { restores: id, e2eReset: true } });
  restored++;
}
/* ADR 0014 (slice B1–B2): the E2E Lite hospital (and the E2E clinic, should a test put a patient on a bed there) are
   put back in one transaction, as the database checks bed state against the live assignments at commit: live bed
   assignments end ("reset"), beds return to their seeded states, requested admissions are cancelled, open ER / IPD /
   OPD visits close through ENCOUNTER, and the reviews of provisional (unknown) ER patients are closed as rejected. */
const LITE = "t_e2e_lite";
const CLOSE: Record<string, "cancel" | "markError"> = { planned: "cancel", arrived: "cancel", triaged: "cancel", in_progress: "markError" };
const open = await db.encounter.findMany({ where: { tenantId: { in: [T, LITE] }, status: { in: ["planned", "arrived", "triaged", "in_progress"] } }, select: { id: true, tenantId: true, status: true, patientId: true } });
const liveBeds = await db.bedAssignment.findMany({ where: { tenantId: { in: [T, LITE] }, status: { in: ["reserved", "occupied"] } }, select: { id: true, tenantId: true, bedId: true, patientId: true } });
const requestedAdmissions = await db.admission.findMany({ where: { tenantId: { in: [T, LITE] }, status: "requested" }, select: { id: true, tenantId: true, patientId: true } });
const beds = await db.location.findMany({ where: { tenantId: { in: [T, LITE] }, kind: "bed" }, select: { id: true, name: true, bedState: true, bedNote: true } });
const provisionalReviews = await db.task.findMany({ where: { tenantId: { in: [T, LITE] }, kind: "patient-link-review", status: "requested", reason: { startsWith: "ER provisional" } }, select: { id: true } });
let bedsReset = 0;
await db.$transaction(async (tx) => {
  for (const a of liveBeds) await tx.bedAssignment.update({ where: { id: a.id }, data: { status: "ended", endedAt: now, endedById: RESET_BY, endReason: "reset" } });
  for (const b of beds) {
    const want = SEED_BED_STATES[b.name] ?? { bedState: "vacant" as const, bedNote: null };
    if (b.bedState === want.bedState && (b.bedNote ?? null) === want.bedNote) continue;
    await tx.location.update({ where: { id: b.id }, data: want });
    bedsReset++;
  }
  for (const a of requestedAdmissions) await tx.admission.update({ where: { id: a.id }, data: { status: "cancelled", cancelledAt: now, cancelledById: RESET_BY, cancelReason: "e2e reset: test run" } });
  for (const e of open) {
    const to = transition("encounter", ENCOUNTER, e.status.replace(/_/g, "-") as EncounterState, CLOSE[e.status]!).replace(/-/g, "_");
    await tx.encounter.updateMany({ where: { id: e.id, tenantId: e.tenantId, status: e.status }, data: { status: to as "cancelled" | "entered_in_error", statusAt: now } });
    audit.push({ action: "update", entity: "Encounter", entityId: e.id, patientId: e.patientId, detail: { event: CLOSE[e.status], to, e2eReset: true } });
  }
  if (provisionalReviews.length) await tx.task.updateMany({ where: { id: { in: provisionalReviews.map((t) => t.id) } }, data: { status: "rejected", decisionNote: "e2e reset", decidedById: RESET_BY, decidedAt: now } });
});
for (const a of liveBeds) audit.push({ action: "update", entity: "BedAssignment", entityId: a.id, patientId: a.patientId, detail: { event: "end", reason: "reset", e2eReset: true } });
for (const a of requestedAdmissions) audit.push({ action: "update", entity: "Admission", entityId: a.id, patientId: a.patientId, detail: { event: "cancel", e2eReset: true } });
// the Lite family's links and confidence, like the clinic's
for (const [id, identityConfidence] of Object.entries(FAMILY))
  await db.patient.updateMany({ where: { id: id.replace(/^e2e_/, "e2l_"), tenantId: LITE }, data: { linkedToId: null, identityConfidence } });
/* Decision 110 (Kamrul 03/10/2026): payment-reconciliation cases left open by earlier automated runs are resolved as
   the E2E owner with the note "test run" (APPROVAL requested → rejected, the same outcome as the owner's "resolve with
   a note"). Nothing is applied and no money moves. */
const RECONCILE_BY = "u_e2e_owner";
const cases = await db.task.findMany({ where: { tenantId: T, kind: "payment-reconciliation", status: "requested" } });
for (const t of cases) {
  const status = transition("approval", APPROVAL, "requested", "reject");
  const resolution = { action: "resolved", note: "test run", by: RECONCILE_BY, at: now.toISOString() };
  const u = await db.task.updateMany({ where: { id: t.id, tenantId: T, status: "requested" }, data: { status, decidedById: RECONCILE_BY, decidedAt: now, decisionNote: "test run", detail: { ...((t.detail ?? {}) as object), resolution } } });
  if (u.count) await db.auditEvent.create({ data: { tenantId: T, userId: RECONCILE_BY, role: "owner", at: now, action: "update", entity: "Task", entityId: t.id, detail: { route: "pnpm db:reset-e2e", event: "reject", resolution: "resolved", note: "test run", e2eReset: true } } });
}
/* ADR 0013: refunds left requested by earlier runs are rejected ("e2e reset: test run") through their approval task, by
   the E2E owner — or the E2E admin when the owner asked; approved ones not yet paid out are withdrawn. Owner checks of
   manual refunds are resolved with the same note. Nothing is paid and no stock moves. */
const openRefunds = await db.refund.findMany({ where: { tenantId: T, status: { in: ["requested", "approved"] } }, include: { allocations: true } });
let refundsClosed = 0;
for (const r of openRefunds) {
  const by = r.requestedById === RECONCILE_BY ? RESET_BY : RECONCILE_BY;
  if (r.status === "requested") {
    await db.task.updateMany({ where: { id: r.approvalTaskId!, status: "requested" }, data: { status: "rejected", decidedById: by, decidedAt: now, decisionNote: "e2e reset: test run" } });
    await db.refund.update({ where: { id: r.id }, data: { status: "rejected", decidedById: by, decidedAt: now, decisionNote: "e2e reset: test run", statusAt: now, rev: { increment: 1 } } });
  } else if (r.allocations.every((a) => a.status === "open" && !a.gatewayFailedAt)) {
    await db.refund.update({ where: { id: r.id }, data: { status: "withdrawn", withdrawnById: by, withdrawnAt: now, withdrawNote: "e2e reset: test run", statusAt: now, rev: { increment: 1 } } });
  } else continue;
  audit.push({ action: "update", entity: "Refund", entityId: r.id, patientId: r.patientId ?? undefined, detail: { event: r.status === "requested" ? "reject" : "withdraw", note: "e2e reset: test run", e2eReset: true } });
  refundsClosed++;
}
const refundChecks = await db.task.updateMany({ where: { tenantId: T, kind: "refund-reconciliation", status: "requested" }, data: { status: "rejected", decidedById: RECONCILE_BY, decidedAt: now, decisionNote: "e2e reset: test run" } });
/* ADR 0008: shifts left unfinished by earlier automated runs are counted (as matching) and approved as the E2E owner
   with the note "e2e reset: test run" — through the same SHIFT steps and append-only rows; nothing is deleted. */
const unfinished = await db.shift.findMany({ where: { tenantId: T, status: { not: "approved" } } });
for (const sh of unfinished) {
  let latest = sh.latestCountId;
  if (sh.status === "open") {
    const [cash] = await db.$queryRaw<{ paisa: bigint | null }[]>`SELECT sum("amountPaisa") AS paisa FROM "Payment" WHERE "tenantId" = ${T} AND "organizationId" = ${sh.organizationId}
      AND "createdById" = ${sh.cashierId} AND "status" = 'confirmed' AND "method" = 'cash' AND "confirmedAt" >= ${sh.openedAt} AND "confirmedAt" <= ${now}`;
    const cashIn = Number(cash?.paisa ?? 0), expected = sh.openingFloatPaisa + cashIn;
    const n = await db.shiftCount.count({ where: { shiftId: sh.id } });
    const c = await db.shiftCount.create({ data: { tenantId: T, shiftId: sh.id, countNo: n + 1, counts: {}, countedPaisa: expected, openingFloatPaisa: sh.openingFloatPaisa, cashInPaisa: cashIn,
      expectedCashPaisa: expected, variancePaisa: 0, digitalSystem: {}, digitalSettlement: {}, reason: "e2e reset: test run", windowFrom: sh.openedAt, windowTo: now, countedById: sh.cashierId, countedAt: now } });
    await db.shift.update({ where: { id: sh.id }, data: { status: transition("shift", SHIFT, "open", "count"), latestCountId: c.id, statusAt: now } });
    await db.shift.update({ where: { id: sh.id }, data: { status: transition("shift", SHIFT, "counted", "close"), statusAt: now } });
    latest = c.id;
  } else if (sh.status === "counted") {
    await db.shift.update({ where: { id: sh.id }, data: { status: transition("shift", SHIFT, "counted", "close"), statusAt: now } });
  }
  await db.shiftReview.create({ data: { tenantId: T, shiftId: sh.id, countId: latest!, decision: "approve", note: "e2e reset: test run", byId: RECONCILE_BY, at: now } });
  await db.shift.update({ where: { id: sh.id }, data: { status: transition("shift", SHIFT, "closed", "approve"), statusAt: now } });
  await db.auditEvent.create({ data: { tenantId: T, userId: RECONCILE_BY, role: "owner", at: now, action: "approve", entity: "Shift", entityId: sh.id, detail: { route: "pnpm db:reset-e2e", note: "e2e reset: test run", e2eReset: true } } });
}
/* ADR 0009: stock used up by earlier automated runs is topped back up to each sample batch's opening quantity with an
   `adjust` move ("e2e reset: test run") — the ledger stays append-only and the batch still equals the sum of its moves. */
const opening = await db.stockMove.groupBy({ by: ["batchId"], where: { tenantId: T, refType: "seed" }, _sum: { qty: true } });
const batches = new Map((await db.stockBatch.findMany({ where: { tenantId: T, sample: true } })).map((b) => [b.id, b]));
let toppedUp = 0;
for (const o of opening) {
  const b = batches.get(o.batchId);
  const want = o._sum.qty ?? 0;
  if (!b || b.qtyOnHand === want) continue;
  await db.stockMove.create({ data: { tenantId: T, organizationId: b.organizationId, batchId: b.id, kind: "adjust", qty: want - b.qtyOnHand, refType: "e2e-reset", reason: "e2e reset: test run", byId: RESET_BY } });
  toppedUp++;
}
/* ADR 0009 (pharmacy session 3): stock counts left open by earlier runs are finished as counted = expected and rejected
   by the E2E owner ("e2e reset: test run" — nothing adjusted), so a new count of that location can start; goods
   receipts left in checking are discarded (nothing posted). */
const openCounts = await db.stockCount.findMany({ where: { tenantId: T, status: { in: ["counting", "submitted"] } } });
for (const c of openCounts) {
  if (c.status === "counting") {
    for (const l of await db.stockCountLine.findMany({ where: { countId: c.id } })) await db.stockCountLine.update({ where: { id: l.id }, data: { countedQty: l.systemQty, reason: null } });
    await db.stockCount.update({ where: { id: c.id }, data: { status: "submitted", submittedAt: now, statusAt: now, rev: { increment: 1 } } });
  }
  await db.stockCount.update({ where: { id: c.id }, data: { status: "rejected", decidedById: RECONCILE_BY, decidedAt: now, decisionNote: "e2e reset: test run", statusAt: now, rev: { increment: 1 } } });
}
const openGrns = await db.goodsReceipt.updateMany({ where: { tenantId: T, status: "checking" }, data: { status: "discarded", statusAt: now } });
/* ADR 0010: the E2E setup facility goes back into setup so the onboarding journey runs again — details, branches,
   wards and the price list cleared; users the tests created there are switched off and lose their role (their audit
   and price history stay). */
// the E2E Test Clinic's money settings back to the seeded values (a test that stopped halfway must not change billing's)
await db.organization.update({ where: { id: "o_e2e" }, data: { cashierDiscountLimitPaisa: 50_000, cashierDiscountLimitBp: 500, approverLimitPaisa: 1_000_000, paymentMethods: ["cash", "card", "bank", "bkash", "nagad"], labelWidthMm: 50, labelHeightMm: 30 } });
const NEW = "o_e2e_new", NEW_ADMIN = "u_e2e_newadmin";
await db.organization.update({ where: { id: NEW }, data: { status: "setup", liveAt: null, address: null, licenceNo: null, receiptFormat: null, rxFormat: null, paymentMethods: [], smsTestedAt: null, smsTestSentAt: null, smsTestPhone: null } });
for (const kind of ["bed", "room", "ward", "department", "branch"] as const) await db.location.deleteMany({ where: { organizationId: NEW, kind } });
await db.chargeItemDefinition.deleteMany({ where: { organizationId: NEW } });
const testUsers = (await db.practitionerRole.findMany({ where: { organizationId: NEW, userId: { not: NEW_ADMIN } }, select: { userId: true } })).map((r) => r.userId);
await db.practitionerRole.deleteMany({ where: { organizationId: NEW, userId: { not: NEW_ADMIN } } });
await db.user.updateMany({ where: { id: { in: testUsers }, roles: { none: {} } }, data: { active: false, deactivatedAt: now, deactivatedReason: "e2e reset: test run", sessionGeneration: { increment: 1 } } });
await db.user.update({ where: { id: NEW_ADMIN }, data: { active: true, mustChangePassword: false, tempPasswordExpiresAt: null, passwordHash: createHash("sha256").update("dev-only:setu1234").digest("hex"), pinHash: createHash("sha256").update("dev-only:2580").digest("hex") } });
if (audit.length) await db.auditEvent.createMany({ data: audit.map((a) => ({ tenantId: T, userId: RESET_BY, role: "admin" as const, at: now, ...a, detail: { route: "pnpm db:reset-e2e", ...a.detail } })) });
// the Lite hospital's resets are audited there, as its admin (its rows carry its tenant under RLS)
const liteAudit = audit.filter((a) => (a.entity === "Encounter" && open.some((e) => e.id === a.entityId && e.tenantId === LITE)) || (a.entity === "BedAssignment" && liveBeds.some((b) => b.id === a.entityId && b.tenantId === LITE)) || (a.entity === "Admission" && requestedAdmissions.some((b) => b.id === a.entityId && b.tenantId === LITE)));
if (liteAudit.length) await db.auditEvent.createMany({ data: liteAudit.map((a) => ({ tenantId: LITE, userId: "u_e2l_admin", role: "admin" as const, at: now, ...a, detail: { route: "pnpm db:reset-e2e", ...a.detail } })) });
await db.$disconnect();
console.log(`E2E Test Clinic reset: walkthrough family restored, ${n.count} open review(s) closed, ${undone.length} undone override(s) marked reviewed, ${extra.length} test allerg(ies) marked entered-in-error, ${restored} seeded allerg(ies) recorded again, ${open.length} leftover visit(s) closed, ${liveBeds.length} bed assignment(s) ended and ${bedsReset} bed(s) put back, ${requestedAdmissions.length} admission request(s) cancelled, ${provisionalReviews.length} provisional review(s) closed, ${cases.length} reconciliation case(s) resolved "test run", ${refundsClosed} open refund(s) closed and ${refundChecks.count} refund check(s) resolved "test run", ${unfinished.length} unfinished shift(s) approved "test run", ${toppedUp} stock batch(es) topped up, ${openCounts.length} open count(s) rejected, ${openGrns.count} goods receipt(s) discarded, E2E New Clinic back in setup (${testUsers.length} test user(s) switched off)`);
