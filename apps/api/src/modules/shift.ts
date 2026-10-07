/* Cashier shift close (journey C4, ADR 0008). A cashier opens a shift with a float; the server sums the cash and digital
   money that cashier confirmed at this facility since the opening; the cashier counts the drawer by note and hands
   over (a variance needs a reason); the owner or admin — never the cashier — approves (a variance needs a note, issue
   #24) or sends it back for a recount. Every count and decision is an append-only row; the database re-checks the
   arithmetic and the SHIFT transitions (migration shift_close_rollup). */
import type { CountShiftRequest, HandOverShiftRequest, ReviewShiftRequest, ShiftView } from "@setu/contracts";
import type { Tx } from "@setu/db";
import { DIGITAL_METHODS, SHIFT, acceptBlockers, countCheck, digitalRows, expectedCashPaisa, handOverBlockers, transition, varianceJudgement, type Counts, type DigitalMethod, type Role, type ShiftState } from "@setu/domain";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { notFound } from "./frontdesk.js";
import { abandonCountsAtShiftClose } from "./purchasing.js";
import { shiftGate } from "./billing.js";

type Shift = NonNullable<Awaited<ReturnType<typeof shiftRow>>>;
const shiftRow = (tx: Tx, s: SessionData, id: string) => tx.shift.findFirst({ where: { id, organizationId: s.organizationId }, include: { counts: { orderBy: { countNo: "asc" } }, reviews: { orderBy: { at: "asc" } }, handovers: true } });
const APPROVERS: Role[] = ["owner", "admin"];

async function people(tx: Tx, ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = list.length ? await tx.user.findMany({ where: { id: { in: list } }, select: { id: true, nameBn: true, nameEn: true } }) : [];
  const m = new Map(rows.map((r) => [r.id, r]));
  return (id: string) => m.get(id) ?? { id, nameBn: "—", nameEn: "—" };
}

/** What the cashier confirmed at this facility in the window: cash in, digital by method, how many payments. */
export async function takings(tx: Tx, s: SessionData, cashierId: string, from: Date, to: Date) {
  const rows = await tx.payment.groupBy({
    by: ["method"], where: { organizationId: s.organizationId, createdById: cashierId, status: "confirmed", confirmedAt: { gte: from, lte: to } },
    _sum: { amountPaisa: true }, _count: { _all: true },
  });
  const by = (m: string) => rows.find((r) => r.method === m)?._sum.amountPaisa ?? 0;
  const digital = Object.fromEntries(DIGITAL_METHODS.map((m) => [m, by(m)])) as Record<DigitalMethod, number>;
  // ADR 0013: cash this cashier paid back from the drawer in the window (closes open question 150)
  const refunds = await tx.refundAllocation.aggregate({ where: { way: "cash", status: "paid", paidById: cashierId, paidAt: { gte: from, lte: to }, refund: { organizationId: s.organizationId } }, _sum: { amountPaisa: true } });
  return { cashInPaisa: by("cash"), cashRefundPaisa: refunds._sum.amountPaisa ?? 0, digital, payments: rows.reduce((a, r) => a + r._count._all, 0) };
}

async function viewOf(tx: Tx, s: SessionData, sh: Shift, now: Date): Promise<ShiftView> {
  const who = await people(tx, [sh.cashierId, ...sh.counts.map((c) => c.countedById), ...sh.reviews.map((r) => r.byId)]);
  const org = await tx.organization.findFirst({ where: { id: sh.organizationId }, select: { name: true } });
  // external review A5 (blind count): what the system expected is the owner's / admin's to see — never the cashier's
  const figures = APPROVERS.includes(s.role as Role) && sh.cashierId !== s.userId;
  const handover = new Map(sh.handovers.map((h) => [h.countId, h.reason]));
  const counts = sh.counts.map((c) => ({
    id: c.id, countNo: c.countNo, counts: c.counts as Record<string, number>, countedPaisa: c.countedPaisa, openingFloatPaisa: c.openingFloatPaisa,
    ...(figures ? { cashInPaisa: c.cashInPaisa, cashRefundPaisa: c.cashRefundPaisa, expectedCashPaisa: c.expectedCashPaisa,
      digital: digitalRows(c.digitalSystem as Record<DigitalMethod, number>, c.digitalSettlement as Partial<Record<DigitalMethod, number>>) } : {}),
    variancePaisa: c.variancePaisa, judgement: varianceJudgement(c.variancePaisa),
    reason: c.reason ?? handover.get(c.id) ?? null, countedBy: who(c.countedById), countedAt: c.countedAt.toISOString(), windowFrom: c.windowFrom.toISOString(), windowTo: c.windowTo.toISOString(),
  }));
  let live: ShiftView["live"] = null;
  if (sh.status === "open") {
    const t = await takings(tx, s, sh.cashierId, sh.openedAt, now);
    live = figures
      ? { cashInPaisa: t.cashInPaisa, cashRefundPaisa: t.cashRefundPaisa, expectedCashPaisa: expectedCashPaisa({ openingFloatPaisa: sh.openingFloatPaisa, cashInPaisa: t.cashInPaisa, cashRefundPaisa: t.cashRefundPaisa }), digital: digitalRows(t.digital, {}), payments: t.payments }
      : { payments: t.payments };
  }
  const countNo = new Map(sh.counts.map((c) => [c.id, c.countNo]));
  return {
    id: sh.id, status: sh.status, cashier: who(sh.cashierId), facilityEn: org?.name ?? "", openingFloatPaisa: sh.openingFloatPaisa,
    openedAt: sh.openedAt.toISOString(), statusAt: sh.statusAt.toISOString(), live,
    latestCount: counts.find((c) => c.id === sh.latestCountId) ?? null, counts,
    reviews: sh.reviews.map((r) => ({ id: r.id, decision: r.decision as "approve" | "recount", note: r.note, by: who(r.byId), at: r.at.toISOString(), countNo: countNo.get(r.countId) ?? 0 })),
    canCount: sh.status === "open" && sh.cashierId === s.userId,
    canHandOver: sh.status === "counted" && sh.cashierId === s.userId,
    canReview: sh.status === "closed" && sh.cashierId !== s.userId && APPROVERS.includes(s.role as Role),
  };
}

export async function myShift(tx: Tx, s: SessionData, now: Date) {
  const cur = await tx.shift.findFirst({ where: { organizationId: s.organizationId, cashierId: s.userId, status: { not: "approved" } } });
  const last = await tx.shift.findFirst({ where: { organizationId: s.organizationId, cashierId: s.userId, status: "approved" }, orderBy: { statusAt: "desc" } });
  return {
    shift: cur ? await viewOf(tx, s, (await shiftRow(tx, s, cur.id))!, now) : null,
    lastApproved: last ? await viewOf(tx, s, (await shiftRow(tx, s, last.id))!, now) : null,
  };
}

export async function openShift(tx: Tx, s: SessionData, openingFloatPaisa: number, now: Date): Promise<{ view: ShiftView; audit: AuditEntry[] }> {
  const existing = await tx.shift.findFirst({ where: { organizationId: s.organizationId, cashierId: s.userId, status: { not: "approved" } }, select: { id: true } });
  if (existing) throw err(409, "shift_unfinished", "আগের শিফট এখনো শেষ হয়নি — গণনা ও হস্তান্তর করুন", "Your previous shift is not finished — count and hand it over first", { field: "shift" });
  const sh = await tx.shift.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, cashierId: s.userId, openingFloatPaisa, openedAt: now, statusAt: now } });
  return { view: await viewOf(tx, s, (await shiftRow(tx, s, sh.id))!, now), audit: [{ action: "create", entity: "Shift", entityId: sh.id, detail: { openingFloatPaisa } }] };
}

/** Count by note (external review A5, blind count): the count is stored and the shift moves open → counted before any
    variance is shown — the answer is the first time the cashier sees it, so a probe count is a count (audited). A
    matched count is handed over at once (counted → closed); a variance waits for its reason (handOverShift). */
export async function countShift(tx: Tx, s: SessionData, id: string, req: CountShiftRequest, now: Date): Promise<{ view: ShiftView; audit: AuditEntry[] }> {
  await tx.$executeRaw`SELECT 1 FROM "Shift" WHERE "id" = ${id} FOR UPDATE`;
  const sh = await shiftRow(tx, s, id);
  if (!sh) throw notFound();
  if (sh.cashierId !== s.userId) throw err(403, "forbidden", "শুধু নিজের ড্রয়ার গণনা করা যায়", "Only the shift's cashier counts its drawer", { reason: "role", canRequest: false });
  if (sh.status !== "open") throw err(409, "shift_not_open", "এই শিফট গণনার অবস্থায় নেই", "This shift is not open for counting");
  const counts = Object.fromEntries(Object.entries(req.counts).map(([k, v]) => [Number(k), v])) as Counts;
  const c = countCheck(counts);
  if (!c.ok) throw err(400, c.error, c.error === "count_too_large" ? "গণনা অস্বাভাবিক বড় — আবার দেখুন" : "নোটের সংখ্যা ঠিক নেই", c.error === "count_too_large" ? "The count is implausibly large — check it" : "A note count is not valid", { field: `counts.${c.denomination}` });
  // external review B11: confirmations in flight finish first; later ones wait for this count and are stamped after
  // its window — the window ends at the database clock read once the gate is held
  const windowTo = await shiftGate(tx, sh.cashierId, "exclusive");
  const t = await takings(tx, s, sh.cashierId, sh.openedAt, windowTo);
  const expected = expectedCashPaisa({ openingFloatPaisa: sh.openingFloatPaisa, cashInPaisa: t.cashInPaisa, cashRefundPaisa: t.cashRefundPaisa });
  const variance = c.countedPaisa - expected;
  const countNo = sh.counts.length + 1;
  const row = await tx.shiftCount.create({ data: {
    tenantId: s.tenantId, shiftId: sh.id, countNo, counts: Object.fromEntries(Object.entries(counts).filter(([, n]) => (n ?? 0) > 0)) as object,
    countedPaisa: c.countedPaisa, openingFloatPaisa: sh.openingFloatPaisa, cashInPaisa: t.cashInPaisa, cashRefundPaisa: t.cashRefundPaisa, expectedCashPaisa: expected, variancePaisa: variance,
    digitalSystem: t.digital as object, digitalSettlement: req.settlement as object, reason: null,
    windowFrom: sh.openedAt, windowTo, countedById: s.userId, countedAt: now,
  } });
  const counted = transition("SHIFT", SHIFT, "open", "count");
  const n = await tx.shift.updateMany({ where: { id: sh.id, status: "open" }, data: { status: counted, latestCountId: row.id, statusAt: now } });
  if (n.count !== 1) throw err(409, "stale", "অন্য কোথাও আগেই বদলেছে — আবার দেখুন", "This changed somewhere else first — refresh");
  const audit: AuditEntry[] = [{ action: "update", entity: "Shift", entityId: sh.id, detail: { event: "count", countNo, countedPaisa: c.countedPaisa, expectedCashPaisa: expected, variancePaisa: variance } }];
  if (variance === 0) {
    await tx.shiftHandover.create({ data: { tenantId: s.tenantId, shiftId: sh.id, countId: row.id, reason: null, byId: s.userId, at: now } });
    await tx.shift.update({ where: { id: sh.id }, data: { status: transition("SHIFT", SHIFT, counted, "close"), statusAt: now } });
    audit.push({ action: "update", entity: "Shift", entityId: sh.id, detail: { event: "hand-over", countNo } }, ...await abandonCountsAtShiftClose(tx, s, sh.id, now));
  }
  return { view: await viewOf(tx, s, (await shiftRow(tx, s, sh.id))!, now), audit };
}

/** The hand-over of a counted shift with a variance (SHIFT counted → closed): the reason, after the variance was shown. */
export async function handOverShift(tx: Tx, s: SessionData, id: string, req: HandOverShiftRequest, now: Date): Promise<{ view: ShiftView; audit: AuditEntry[] }> {
  await tx.$executeRaw`SELECT 1 FROM "Shift" WHERE "id" = ${id} FOR UPDATE`;
  const sh = await shiftRow(tx, s, id);
  if (!sh) throw notFound();
  if (sh.cashierId !== s.userId) throw err(403, "forbidden", "শুধু নিজের ড্রয়ার হস্তান্তর করা যায়", "Only the shift's cashier hands its drawer over", { reason: "role", canRequest: false });
  if (sh.status !== "counted") throw err(409, "shift_not_counted", "এই শিফট হস্তান্তরের অবস্থায় নেই", "This shift is not counted and waiting for its hand-over");
  const c = sh.counts.find((x) => x.id === sh.latestCountId)!;
  const reason = req.reason?.trim() ?? "";
  if (handOverBlockers({ variancePaisa: c.variancePaisa, reason }).length)
    throw err(400, "reason_required", "গরমিল আছে — কারণ লিখুন (অন্তত ১০ অক্ষর)", "There is a variance — give a reason (at least 10 characters)", { field: "reason" });
  await tx.shiftHandover.create({ data: { tenantId: s.tenantId, shiftId: sh.id, countId: c.id, reason: reason || null, byId: s.userId, at: now } });
  const n = await tx.shift.updateMany({ where: { id: sh.id, status: "counted" }, data: { status: transition("SHIFT", SHIFT, "counted", "close"), statusAt: now } });
  if (n.count !== 1) throw err(409, "stale", "অন্য কোথাও আগেই বদলেছে — আবার দেখুন", "This changed somewhere else first — refresh");
  const abandoned = await abandonCountsAtShiftClose(tx, s, sh.id, now);
  return { view: await viewOf(tx, s, (await shiftRow(tx, s, sh.id))!, now), audit: [{ action: "update", entity: "Shift", entityId: sh.id, detail: { event: "hand-over", countNo: c.countNo, variancePaisa: c.variancePaisa, reason } }, ...abandoned] };
}

export async function reviewShift(tx: Tx, s: SessionData, id: string, req: ReviewShiftRequest, now: Date): Promise<{ view: ShiftView; audit: AuditEntry[] }> {
  await tx.$executeRaw`SELECT 1 FROM "Shift" WHERE "id" = ${id} FOR UPDATE`;
  const sh = await shiftRow(tx, s, id);
  if (!sh) throw notFound();
  if (sh.status !== "closed" || !sh.latestCountId) throw err(409, "shift_not_closed", "এই শিফট হস্তান্তর হয়নি", "This shift has not been handed over");
  const count = sh.counts.find((c) => c.id === sh.latestCountId)!;
  const note = req.note?.trim() ?? "";
  if (req.decision === "approve") {
    const b = acceptBlockers({ variancePaisa: count.variancePaisa, note, approverRole: s.role as Role, approverIsCashier: sh.cashierId === s.userId });
    if (b.includes("not_approver") || b.includes("own_shift")) throw err(403, b.includes("own_shift") ? "own_shift" : "forbidden", "নিজের শিফট নিজে অনুমোদন করা যায় না / ভূমিকায় নেই", b.includes("own_shift") ? "You cannot approve your own shift" : "Only the owner or admin approves a shift", { reason: "role", canRequest: false });
    if (b.includes("note_required")) throw err(422, "note_required", "গরমিল মেনে নিতে নোট লিখুন (অন্তত ১০ অক্ষর)", "Accepting a variance needs a note (at least 10 characters)", { field: "note" });
  } else {
    if (!APPROVERS.includes(s.role as Role) || sh.cashierId === s.userId) throw err(403, "forbidden", "শুধু মালিক বা অ্যাডমিন আবার গণনা চাইতে পারেন", "Only the owner or admin asks for a recount", { reason: "role", canRequest: false });
    if (note.length < 10) throw err(422, "note_required", "আবার গণনার কারণ লিখুন (অন্তত ১০ অক্ষর)", "Say why it needs a recount (at least 10 characters)", { field: "note" });
  }
  await tx.shiftReview.create({ data: { tenantId: s.tenantId, shiftId: sh.id, countId: count.id, decision: req.decision, note: note || null, byId: s.userId, at: now } });
  const to = transition("SHIFT", SHIFT, "closed" as ShiftState, req.decision === "approve" ? "approve" : "recount");
  const n = await tx.shift.updateMany({ where: { id: sh.id, status: "closed" }, data: { status: to, statusAt: now } });
  if (n.count !== 1) throw err(409, "stale", "অন্য কোথাও আগেই বদলেছে — আবার দেখুন", "This changed somewhere else first — refresh");
  return { view: await viewOf(tx, s, (await shiftRow(tx, s, sh.id))!, now), audit: [{ action: req.decision === "approve" ? "approve" : "update", entity: "Shift", entityId: sh.id, detail: { event: req.decision, countNo: count.countNo, variancePaisa: count.variancePaisa, note: note || null } }] };
}

export async function shiftList(tx: Tx, s: SessionData, status: "closed" | "open" | "approved" | "all", days: number, now: Date) {
  const rows = await tx.shift.findMany({
    where: { organizationId: s.organizationId, ...(status === "all" ? {} : { status }), statusAt: { gte: new Date(now.getTime() - days * 864e5) } },
    orderBy: { statusAt: "desc" }, take: 100, select: { id: true },
  });
  return Promise.all(rows.map(async (r) => viewOf(tx, s, (await shiftRow(tx, s, r.id))!, now)));
}

export async function shiftView(tx: Tx, s: SessionData, id: string, now: Date) {
  const sh = await shiftRow(tx, s, id);
  if (!sh) throw notFound();
  // a cashier sees their own shifts; the owner / admin see every shift at the facility
  if (sh.cashierId !== s.userId && !APPROVERS.includes(s.role as Role)) throw notFound();
  return viewOf(tx, s, sh, now);
}
