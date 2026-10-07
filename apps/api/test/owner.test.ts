/* Slice C1–C4 contract tests (ADR 0008) on the real database (as setu_app), in the seeded E2E Test Clinic:
   - C4 shift close: open with a float, expected = float + the cashier's confirmed cash (the owner's figure, never the
     cashier's — external review A5), count by note (stored before any variance is shown) and hand over; a variance needs
     a reason; the owner / admin (never the cashier) approves — a variance needs a note (issue #24) —
     or asks for a recount; digital money against the settlement is shown, never blocking; history kept;
   - C1–C2 owner dashboard: live today, rollup for past days, KPI changes, tiles that come with later modules say so,
     the leakage list, the list behind each number (audited with the patients it revealed);
   - roles, idempotent replay, the database refusing what the API would never send. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("owner.test: DATABASE_URL_APP not set — shift / owner contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const cookies: Record<string, string> = {};
const T = "t_e2e";
/** the short drawer of this run (issue #24 test) — the drill must show its own hand-over reason, not an earlier run's */
let varianceShiftId = "";
const USERS = { desk: "01799000001", doctor: "01799000002", cashier: "01799000008", owner: "01799000009", admin: "01799000010" } as const;
type Who = keyof typeof USERS;

const get = (url: string, who: Who = "owner") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const post = (url: string, payload: object = {}, who: Who = "cashier", key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const ok = <R>(r: { statusCode: number; body: string; json: () => R }, code = 200) => { expect(r.statusCode, r.body).toBe(code); return r.json(); };
type Shift = { id: string; status: string; live: { cashInPaisa?: number; expectedCashPaisa?: number; digital?: { method: string; systemPaisa: number }[]; payments: number } | null;
  latestCount: { countNo: number; variancePaisa: number; expectedCashPaisa?: number; countedPaisa: number; judgement: string; reason: string | null; digital?: { method: string; state: string; diffPaisa: number | null }[] } | null;
  counts: unknown[]; reviews: { decision: string; note: string | null }[]; canCount: boolean; canHandOver: boolean; canReview: boolean };

/** Count the drawer so it matches exactly: the expected cash in notes. */
const notesFor = (paisa: number) => {
  let taka = Math.round(paisa / 100); const out: Record<string, number> = {};
  for (const d of [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1]) { const k = Math.floor(taka / d); if (k) { out[String(d)] = k; taka -= k * d; } }
  return out;
};
async function finishOpenShifts() {
  const mine = ok<{ shift: Shift | null }>(await get("/v1/shifts/mine", "cashier"));
  let sh = mine.shift;
  if (!sh) return;
  // the cashier never sees the expected figure (external review A5): count nothing, hand the variance over, the owner accepts
  if (sh.status === "open") sh = ok<Shift>(await post(`/v1/shifts/${sh.id}/count`, { counts: {} }));
  if (sh.status === "counted") sh = ok<Shift>(await post(`/v1/shifts/${sh.id}/hand-over`, { reason: "closing a shift left by an earlier test run" }));
  if (sh.status === "closed") ok(await post(`/v1/shifts/${sh.id}/review`, { decision: "approve", note: "closing a shift left by an earlier test run" }, "owner"));
}
/** A finished visit with only the consultation (৳800), billed, issued and paid in cash by the E2E cashier. */
async function paidVisit(method: "cash" | "bkash" = "cash") {
  const r = ok<{ encounter: { id: string } }>(await post("/v1/patients", {
    nameBn: "শিফট রোগী", nameEn: `Shift Patient ${RUN}`, sex: "male", dobMode: "dob", dob: "01/01/1980", phone: `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self",
    division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
  }, "desk"), 201);
  const enc = r.encounter.id;
  const v = ok<{ draft: { id: string } }>(await post(`/v1/encounters/${enc}/consultation/open`, {}, "doctor"));
  const saved = await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: cookies.doctor!, "idempotency-key": randomUUID() }, payload: {
    rev: 1, sections: { complaints: [{ text: "Cough", duration: { n: 3, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }], orders: [],
  } });
  ok(await post(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.json().rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor"));
  const bill = ok<{ invoice: { id: string; rev: number; totalPaisa: number } }>(await post(`/v1/encounters/${enc}/invoice`, {}), 201);
  const iss = ok<{ invoice: { rev: number } }>(await post(`/v1/invoices/${bill.invoice.id}/issue`, { rev: bill.invoice.rev }));
  void iss;
  const pay = method === "cash"
    ? ok<{ payment: { id: string; status: string } }>(await post(`/v1/invoices/${bill.invoice.id}/payments`, { method: "cash", amountPaisa: bill.invoice.totalPaisa, tenderedPaisa: bill.invoice.totalPaisa }), 201)
    : ok<{ payment: { id: string; status: string } }>(await post(`/v1/invoices/${bill.invoice.id}/payments`, { method: "bkash", amountPaisa: bill.invoice.totalPaisa }), 201);
  if (method === "bkash") ok(await post(`/v1/dev/fake-payments/${pay.payment.id}/confirmed`, {}, "cashier", null));
  return { enc, invoiceId: bill.invoice.id, totalPaisa: bill.invoice.totalPaisa, paymentId: pay.payment.id };
}

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of Object.entries(USERS)) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; cookies[k] = Array.isArray(c) ? c[0]! : (c as string);
  }
  await finishOpenShifts();
}, 60_000);
afterAll(async () => { await app.close(); });

describe.runIf(db)("C4 shift close", () => {
  it("open with a float; the owner sees expected = float + the cashier's confirmed cash, the cashier never does; a matching count hands over at once; the owner approves", async () => {
    const opened = ok<Shift>(await post("/v1/shifts", { openingFloatPaisa: 200_000 }), 201);
    expect(opened).toMatchObject({ status: "open", canCount: true, live: { payments: 0 } });
    // external review A5: the cashier's response simply does not contain what the system expects
    expect(opened.live).toEqual({ payments: 0 });
    expect((await post("/v1/shifts", { openingFloatPaisa: 100 })).json().code).toBe("shift_unfinished");
    const paid = await paidVisit();
    const live = ok<{ shift: Shift }>(await get("/v1/shifts/mine", "cashier")).shift;
    expect(live.live).toEqual({ payments: 1 });
    expect(JSON.stringify(live)).not.toMatch(/expectedCashPaisa|cashInPaisa|systemPaisa/);
    const owners = ok<Shift>(await get(`/v1/shifts/${opened.id}`, "owner"));
    expect(owners.live).toMatchObject({ cashInPaisa: paid.totalPaisa, expectedCashPaisa: 200_000 + paid.totalPaisa });
    const closed = ok<Shift>(await post(`/v1/shifts/${opened.id}/count`, { counts: notesFor(200_000 + paid.totalPaisa) }));
    expect(closed).toMatchObject({ status: "closed", canCount: false, canHandOver: false, latestCount: { countNo: 1, variancePaisa: 0, judgement: "matched" } });
    expect(closed.latestCount!.expectedCashPaisa).toBeUndefined();
    expect((await post(`/v1/shifts/${opened.id}/review`, { decision: "approve" }, "cashier")).statusCode).toBe(403);
    const approved = ok<Shift>(await post(`/v1/shifts/${opened.id}/review`, { decision: "approve" }, "owner"));
    expect(approved).toMatchObject({ status: "approved", reviews: [{ decision: "approve", note: null }], latestCount: { expectedCashPaisa: 200_000 + paid.totalPaisa } });
  }, 60_000);

  it("external review A5: a zero-note probe is a count — stored, audited, the shift counted; no second count; the variance is handed over with a reason", async () => {
    const sh = ok<Shift>(await post("/v1/shifts", { openingFloatPaisa: 100_000 }), 201);
    const probe = ok<Shift>(await post(`/v1/shifts/${sh.id}/count`, { counts: {} }));
    expect(probe).toMatchObject({ status: "counted", canCount: false, canHandOver: true, latestCount: { countNo: 1, countedPaisa: 0, variancePaisa: -100_000, judgement: "short", reason: null } });
    const rows = await db!.forTenant(T, (tx) => tx.shiftCount.findMany({ where: { shiftId: sh.id } }));
    expect(rows).toHaveLength(1);
    const ev = await db!.forTenant(T, (tx) => tx.auditEvent.findMany({ where: { entity: "Shift", entityId: sh.id, action: "update" } }));
    expect(ev.map((e) => e.detail)).toEqual([expect.objectContaining({ event: "count", countNo: 1, countedPaisa: 0, variancePaisa: -100_000 })]);
    // the probe cannot be followed by a "real" count: the next count needs the owner's recount
    const again = await post(`/v1/shifts/${sh.id}/count`, { counts: notesFor(100_000) });
    expect([again.statusCode, again.json().code]).toEqual([409, "shift_not_open"]);
    expect((await post(`/v1/shifts/${sh.id}/review`, { decision: "approve", note: "approving before the hand-over" }, "owner")).json().code).toBe("shift_not_closed");
    expect((await post(`/v1/shifts/${sh.id}/hand-over`, {})).json()).toMatchObject({ code: "reason_required", field: "reason" });
    expect((await post(`/v1/shifts/${sh.id}/hand-over`, { reason: "short" })).json().code).toBe("reason_required");
    expect((await post(`/v1/shifts/${sh.id}/hand-over`, { reason: "I did not count the drawer" }, "owner")).statusCode).toBe(403);
    const handed = ok<Shift>(await post(`/v1/shifts/${sh.id}/hand-over`, { reason: "I did not count the drawer" }));
    expect(handed).toMatchObject({ status: "closed", canHandOver: false, latestCount: { reason: "I did not count the drawer" } });
    expect((await post(`/v1/shifts/${sh.id}/hand-over`, { reason: "I did not count the drawer" })).json().code).toBe("shift_not_counted");
    ok(await post(`/v1/shifts/${sh.id}/review`, { decision: "approve", note: "probe count, accepted for the test" }, "owner"));
  }, 60_000);

  it("issue #24: a short drawer needs a reason to hand over and a note to accept; a recount sends it back and keeps both counts", async () => {
    const sh = ok<Shift>(await post("/v1/shifts", { openingFloatPaisa: 100_000 }), 201);
    varianceShiftId = sh.id;
    const c1 = ok<Shift>(await post(`/v1/shifts/${sh.id}/count`, { counts: notesFor(100_000 - 50_000) }));
    // blind count: the variance is shown only now, after the count is stored (money-controls review M1, external review A5)
    expect(c1).toMatchObject({ status: "counted", latestCount: { variancePaisa: -50_000, judgement: "short" } });
    ok<Shift>(await post(`/v1/shifts/${sh.id}/hand-over`, { reason: "gave change twice to one patient" }));
    expect((await post(`/v1/shifts/${sh.id}/review`, { decision: "approve" }, "owner")).json().code).toBe("note_required");
    expect((await post(`/v1/shifts/${sh.id}/review`, { decision: "recount", note: "short" }, "owner")).json().code).toBe("note_required");
    const back = ok<Shift>(await post(`/v1/shifts/${sh.id}/review`, { decision: "recount", note: "count the coins box again please" }, "owner"));
    expect(back.status).toBe("open");
    const c2 = ok<Shift>(await post(`/v1/shifts/${sh.id}/count`, { counts: notesFor(100_000 - 50_000) }));
    expect(c2).toMatchObject({ status: "counted", latestCount: { countNo: 2 } });
    ok<Shift>(await post(`/v1/shifts/${sh.id}/hand-over`, { reason: "the ৳500 note was not found on recount" }));
    const done = ok<Shift>(await post(`/v1/shifts/${sh.id}/review`, { decision: "approve", note: "accepted, cashier to repay from salary" }, "admin"));
    expect(done.status).toBe("approved");
    expect(done.counts).toHaveLength(2);
    expect(done.counts.map((c) => (c as { reason: string }).reason)).toEqual(["gave change twice to one patient", "the ৳500 note was not found on recount"]);
    expect(done.reviews.map((r) => r.decision)).toEqual(["recount", "approve"]);
    const audit = await db!.forTenant(T, (tx) => tx.auditEvent.findFirst({ where: { entity: "Shift", entityId: sh.id, action: "approve" } }));
    expect(audit!.detail).toMatchObject({ variancePaisa: -50_000 });
  }, 60_000);

  it("digital money against the settlement: shown to the owner (matched / mismatch / pending), never blocking, never shown to the cashier", async () => {
    const sh = ok<Shift>(await post("/v1/shifts", { openingFloatPaisa: 0 }), 201);
    const paid = await paidVisit("bkash");
    const owners = ok<Shift>(await get(`/v1/shifts/${sh.id}`, "owner"));
    expect(owners.live!.digital!.find((d) => d.method === "bkash")!.systemPaisa).toBe(paid.totalPaisa);
    const c = ok<Shift>(await post(`/v1/shifts/${sh.id}/count`, { counts: {}, settlement: { bkash: paid.totalPaisa - 1000 } }));
    expect(c.status).toBe("closed");
    expect(c.latestCount!.digital).toBeUndefined();
    const seen = ok<Shift>(await get(`/v1/shifts/${sh.id}`, "owner"));
    expect(seen.latestCount!.digital!.find((d) => d.method === "bkash")).toMatchObject({ state: "mismatch", diffPaisa: -1000 });
    ok(await post(`/v1/shifts/${sh.id}/review`, { decision: "approve" }, "owner"));
  }, 60_000);

  it("roles and replay: the receptionist has no shift screen; a count replays with the same key; another tenant sees nothing", async () => {
    expect((await get("/v1/shifts/mine", "desk")).statusCode).toBe(403);
    expect((await get("/v1/shifts?status=closed", "cashier")).statusCode).toBe(403);
    const sh = ok<Shift>(await post("/v1/shifts", { openingFloatPaisa: 0 }), 201);
    const key = randomUUID();
    const a = ok<Shift>(await post(`/v1/shifts/${sh.id}/count`, { counts: {} }, "cashier", key));
    const b = ok<Shift>(await post(`/v1/shifts/${sh.id}/count`, { counts: {} }, "cashier", key));
    expect(b.latestCount!.countNo).toBe(a.latestCount!.countNo);
    expect((await get(`/v1/shifts/${sh.id}`, "desk")).statusCode).toBe(403);
    ok(await post(`/v1/shifts/${sh.id}/review`, { decision: "approve" }, "owner"));
  });

  it("the database refuses an edited count, a review by the cashier, accepting a variance without a note, and closing a variance without its hand-over", async () => {
    const sh = ok<Shift>(await post("/v1/shifts", { openingFloatPaisa: 100_000 }), 201);
    const c = ok<Shift>(await post(`/v1/shifts/${sh.id}/count`, { counts: notesFor(90_000) }));
    expect(c.status).toBe("counted");
    const row = await db!.forTenant(T, (tx) => tx.shiftCount.findFirst({ where: { shiftId: sh.id } }));
    // A5: counted → closed with a variance needs the hand-over row; a hand-over without a reason, or by someone else, is refused
    await expect(db!.forTenant(T, (tx) => tx.shift.updateMany({ where: { id: sh.id }, data: { status: "closed" } }), { userId: "u_e2e_cashier" })).rejects.toThrow(/handed over with its reason/);
    await expect(db!.forTenant(T, (tx) => tx.shiftHandover.create({ data: { tenantId: T, shiftId: sh.id, countId: row!.id, reason: "short", byId: "u_e2e_cashier" } }), { userId: "u_e2e_cashier" })).rejects.toThrow(/needs a reason/);
    await expect(db!.forTenant(T, (tx) => tx.shiftHandover.create({ data: { tenantId: T, shiftId: sh.id, countId: row!.id, reason: "handing over for the cashier", byId: "u_e2e_owner" } }), { userId: "u_e2e_owner" })).rejects.toThrow(/own drawer/);
    ok<Shift>(await post(`/v1/shifts/${sh.id}/hand-over`, { reason: "a ৳100 note missing from the drawer" }));
    await expect(db!.forTenant(T, (tx) => tx.shiftCount.updateMany({ where: { id: row!.id }, data: { countedPaisa: 100_000 } }), { userId: "u_e2e_cashier" })).rejects.toThrow();
    await expect(db!.forTenant(T, (tx) => tx.shiftHandover.updateMany({ where: { countId: row!.id }, data: { reason: "something else entirely" } }), { userId: "u_e2e_cashier" })).rejects.toThrow();
    await expect(db!.forTenant(T, (tx) => tx.shiftReview.create({ data: { tenantId: T, shiftId: sh.id, countId: row!.id, decision: "approve", note: "approving my own drawer", byId: "u_e2e_cashier" } }), { userId: "u_e2e_cashier" })).rejects.toThrow(/own shift/);
    await expect(db!.forTenant(T, (tx) => tx.shiftReview.create({ data: { tenantId: T, shiftId: sh.id, countId: row!.id, decision: "approve", byId: "u_e2e_owner" } }), { userId: "u_e2e_owner" })).rejects.toThrow(/note/);
    // security review #1 / #2: no approval without the owner's decision row; the latest count is never repointed
    await expect(db!.forTenant(T, (tx) => tx.shift.updateMany({ where: { id: sh.id }, data: { status: "approved" } }), { userId: "u_e2e_cashier" })).rejects.toThrow(/decision on the latest count/);
    await expect(db!.forTenant(T, (tx) => tx.shift.updateMany({ where: { id: sh.id }, data: { latestCountId: null } }), { userId: "u_e2e_cashier" })).rejects.toThrow(/latest count changes only when counting/);
    ok(await post(`/v1/shifts/${sh.id}/review`, { decision: "approve", note: "accepted after checking the log" }, "owner"));
  });
});

describe.runIf(db)("external review B11: every confirmed taka is in the count or after its window", () => {
  type Dash = { leakage: { kind: string; count: number; paisa: number }[] };
  /** On the owner's connection: hold the cashier's shift gate (as a count or a confirmation in flight would) until released;
      `heldUntil` is the database clock just before letting go. */
  function holdGate(mode: "shared" | "exclusive") {
    const o = new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    let release!: () => void; let started!: () => void; let heldUntil = new Date(0);
    const begun = new Promise<void>((r) => { started = r; });
    const done = o.$transaction(async (tx) => {
      if (mode === "shared") await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(7020, hashtext(${"u_e2e_cashier"}))`;
      else await tx.$executeRaw`SELECT pg_advisory_xact_lock(7020, hashtext(${"u_e2e_cashier"}))`;
      started();
      await new Promise<void>((r) => { release = r; });
      heldUntil = (await tx.$queryRaw<{ t: Date }[]>`SELECT clock_timestamp() AS t`)[0]!.t;
    }, { timeout: 60_000 }).finally(() => o.$disconnect());
    return { begun, done, release: () => release(), heldUntil: () => heldUntil };
  }
  it("a cash payment waits for a count in progress and is stamped after it; a count waits for a confirmation in flight", { timeout: 90_000 }, async () => {
    await finishOpenShifts();
    const sh = ok<Shift>(await post("/v1/shifts", { openingFloatPaisa: 0 }), 201);
    // a count in progress (the exclusive gate): the payment's confirmation waits, then is stamped after it
    const count = holdGate("exclusive"); await count.begun;
    const paying = paidVisit("cash");
    await new Promise((r) => setTimeout(r, 1500));
    count.release(); await count.done;
    const paid = await paying;
    const pay = await db!.forTenant(T, (tx) => tx.payment.findFirst({ where: { id: paid.paymentId } }));
    expect(pay!.confirmedAt!.getTime()).toBeGreaterThan(count.heldUntil().getTime());
    // a confirmation in flight (the shared gate): the count waits, and its window ends after it
    const confirming = holdGate("shared"); await confirming.begun;
    const counting = post(`/v1/shifts/${sh.id}/count`, { counts: {} });
    await new Promise((r) => setTimeout(r, 800));
    confirming.release(); await confirming.done;
    const c = ok<Shift>(await counting);
    const row = await db!.forTenant(T, (tx) => tx.shiftCount.findFirst({ where: { shiftId: sh.id } }));
    expect(row!.windowTo.getTime()).toBeGreaterThanOrEqual(confirming.heldUntil().getTime());
    // the payment taken before the count is in its sum
    expect(row!.cashInPaisa).toBe(paid.totalPaisa);
    expect(c.status).toBe("counted");
    // cash taken now, with the shift counted (no longer open), is outside every window: on the leakage list
    const before = ok<Dash>(await get("/v1/owner/dashboard?period=today")).leakage.find((l) => l.kind === "cashOutsideShift")!;
    const late = await paidVisit("cash");
    const after = ok<Dash>(await get("/v1/owner/dashboard?period=today")).leakage.find((l) => l.kind === "cashOutsideShift")!;
    expect(after.count).toBe(before.count + 1);
    expect(ok<{ rows: { id: string }[] }>(await get("/v1/owner/drill?period=today&what=cashOutsideShift")).rows.map((r) => r.id)).toContain(late.paymentId);
    await finishOpenShifts();
  });
  it("a shift opened before midnight: the money taken after midnight is in its count, not 'outside a shift'", { timeout: 60_000 }, async () => {
    await finishOpenShifts();
    const o = new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    // opened yesterday at 23:30 Dhaka (the guard lets a shift start in the past; who opens it is the cashier)
    const today = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
    const openedAt = new Date(Date.parse(`${today}T00:00:00+06:00`) - 30 * 60_000);
    let shId = "";
    try { shId = (await o.shift.create({ data: { tenantId: T, organizationId: "o_e2e", cashierId: "u_e2e_cashier", openingFloatPaisa: 0, openedAt, statusAt: openedAt } })).id; } finally { await o.$disconnect(); }
    const before = ok<Dash>(await get("/v1/owner/dashboard?period=today")).leakage.find((l) => l.kind === "cashOutsideShift")!;
    const paid = await paidVisit("cash");
    expect(ok<Dash>(await get("/v1/owner/dashboard?period=today")).leakage.find((l) => l.kind === "cashOutsideShift")!.count).toBe(before.count);
    expect(ok<Shift>(await get(`/v1/shifts/${shId}`, "owner")).live).toMatchObject({ cashInPaisa: expect.any(Number) });
    const c = ok<Shift>(await post(`/v1/shifts/${shId}/count`, { counts: {} }));
    expect(c.latestCount!.variancePaisa).toBeLessThanOrEqual(-paid.totalPaisa); // the after-midnight cash is expected in the drawer
    await finishOpenShifts();
  });
});

describe.runIf(db)("C1–C2 owner dashboard", () => {
  type Dash = { kpis: { key: string; value: number | null; comesWith: string | null; pct: number | null; judgement: string | null }[]; ops: { key: string; value: number | null }[];
    series: { unit: string; points: { label: string }[] }; leakage: { kind: string; count: number; paisa: number }[]; pending: { shifts: number; staleShifts: number }; uptoHour: number | null; byMethod: { method: string; paisa: number }[];
    cash: { shortPaisa: number; overPaisa: number; shiftsWithVariance: number }; missingDays: string[] };
  it("today is live: revenue and collections include today's bills; later modules' tiles say so; leakage counts today's variance", async () => {
    const d = ok<Dash>(await get("/v1/owner/dashboard?period=today"));
    const v = (k: string) => d.kpis.find((x) => x.key === k)!;
    expect(v("revenue").value).toBeGreaterThan(0);
    expect(v("collections").value).toBeGreaterThan(0);
    for (const k of ["deposits", "sharePayable"]) expect(v(k)).toMatchObject({ value: null, comesWith: expect.any(String) });
    // pharmacy session 2: live from the stock and supplier ledgers (the seeded sample stock has a value)
    for (const k of ["refunds", "supplierDues", "stockValue", "nearExpiry"]) expect(v(k)).toMatchObject({ value: expect.any(Number), comesWith: null });
    expect(v("stockValue")!.value).toBeGreaterThan(0);
    expect(d.series.unit).toBe("hour");
    expect(d.series.points).toHaveLength(d.uptoHour! + 1);
    expect(d.ops.find((o) => o.key === "opdVisits")!.value).toBeGreaterThan(0);
    expect(d.leakage.find((l) => l.kind === "shiftVariance")!.count).toBeGreaterThan(0);
    // money-controls review H3: short and over are kept apart; the leakage figure is the size of both
    expect(d.cash.shortPaisa).toBeGreaterThanOrEqual(50_000);
    expect(d.leakage.find((l) => l.kind === "shiftVariance")!.paisa).toBe(d.cash.shortPaisa + d.cash.overPaisa);
    expect(d.pending.staleShifts).toBeGreaterThanOrEqual(0);
    expect(d.byMethod.find((m) => m.method === "cash")!.paisa).toBeGreaterThan(0);
  });
  it("external review B7: two nightly runs at once — one runs, the other skips; the lab turnaround is the period's median", async () => {
    const { runNightlyRollup, ROLLUP_VERSION, computeDay } = await import("../src/modules/owner.js");
    const both = await Promise.all([runNightlyRollup(new Date(), 2, T), runNightlyRollup(new Date(), 2, T)]);
    expect(both.filter((r) => r.skipped)).toHaveLength(1);
    expect(both.find((r) => !r.skipped)).toMatchObject({ days: 2, failed: 0 });
    // the 7-day tile is the median over every test released in those days (stored per test), never a mean
    const d = ok<Dash & { ops: { key: string; value: number | null }[] }>(await get("/v1/owner/dashboard?period=7d"));
    const rows = await db!.forTenant(T, (tx) => tx.dailyRollup.findMany({ where: { organizationId: "o_e2e", version: ROLLUP_VERSION } }));
    const { medianMinutes, periodDays } = await import("@setu/domain");
    const days = periodDays("7d", new Date()).days;
    const today = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
    const lists = days.filter((x) => x !== today).map((x) => (rows.find((r) => r.day === x)?.metrics as { labTatMinutes?: number[] } | undefined)?.labTatMinutes);
    expect(rows.every((r) => Array.isArray((r.metrics as { labTatMinutes?: unknown }).labTatMinutes))).toBe(true);
    const live = await db!.forTenant(T, (tx) => computeDay(tx, "o_e2e", today)); // today is live, never stored
    expect(d.ops.find((o) => o.key === "labTat")!.value).toBe(medianMinutes([...lists, live.labTatMinutes]));
  });
  it("7 and 30 days: one point per day; the nightly job stores finished days (never today)", async () => {
    const r = ok<{ days: number; failed: number }>(await post("/v1/dev/rollup/run", {}, "owner", null));
    expect(r).toMatchObject({ days: 35, failed: 0 });
    const d = ok<Dash>(await get("/v1/owner/dashboard?period=7d"));
    expect(d.series).toMatchObject({ unit: "day" });
    expect(d.series.points).toHaveLength(7);
    const rows = await db!.forTenant(T, (tx) => tx.dailyRollup.findMany({ where: { organizationId: "o_e2e" } }));
    const today = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
    expect(rows.length).toBeGreaterThanOrEqual(7);
    expect(rows.some((x) => x.day === today)).toBe(false);
    expect((await get("/v1/owner/dashboard?period=30d")).statusCode).toBe(200);
  }, 60_000);
  it("the list behind a number: today's collections with patients, audited; the shift variance with who and why", async () => {
    const c = ok<{ count: number; totalPaisa: number; truncated: boolean; rows: { patient: { id: string } | null; amountPaisa: number; by: { id: string } | null }[] }>(await get("/v1/owner/drill?period=today&what=collections"));
    expect(c.count).toBeGreaterThan(0);
    // money-controls review M4: the drill's total is the tile's figure, over every row
    const tile = ok<{ kpis: { key: string; value: number }[] }>(await get("/v1/owner/dashboard?period=today")).kpis.find((k) => k.key === "collections")!.value;
    expect(c.totalPaisa).toBe(tile);
    expect(c.truncated).toBe(c.count > c.rows.length);
    expect(c.rows[0]!.patient).not.toBeNull();
    const a = await db!.forTenant(T, (tx) => tx.auditEvent.findFirst({ where: { entity: "OwnerDrill", userId: "u_e2e_owner" }, orderBy: { at: "desc" } }));
    expect((a!.detail as { patientIds: string[] }).patientIds.length).toBeGreaterThan(0);
    const sv = ok<{ rows: { amountPaisa: number; by: { id: string }; approvedBy: { id: string }; detail: string }[] }>(await get("/v1/owner/drill?period=today&what=shiftVariance"));
    // external review A5: the reason is the hand-over's (the count itself no longer carries one)
    expect(sv.rows.find((r) => (r as { id?: string }).id === varianceShiftId)).toMatchObject({ amountPaisa: -50_000, by: { id: "u_e2e_cashier" }, detail: expect.stringMatching(/^the ৳500 note was not found on recount — accepted, cashier to repay/) });
  });
  it("external review B10: the list behind a number pages — no row twice or missed, the total over every row; another facility sees none of it", { timeout: 60_000 }, async () => {
    type DV = { count: number; totalPaisa: number | null; truncated: boolean; nextCursor: string | null; rows: { id: string; at: string }[] };
    const first = ok<DV>(await get("/v1/owner/drill?period=7d&what=collections"));
    expect(first.count).toBeGreaterThan(2);
    const size = Math.min(200, Math.max(2, Math.ceil(first.count / 5))); // about five pages (pages of at most 200)
    const seen: string[] = []; let cursor: string | null = null; let pages = 0;
    do {
      const pg: DV = ok<DV>(await get(`/v1/owner/drill?period=7d&what=collections&limit=${size}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
      expect(pg).toMatchObject({ count: first.count, totalPaisa: first.totalPaisa }); // totals never change with the page
      expect(pg.rows.length).toBeLessThanOrEqual(size);
      expect(pg.truncated).toBe(pg.nextCursor !== null);
      seen.push(...pg.rows.map((r) => r.id)); cursor = pg.nextCursor; pages++;
    } while (cursor && pages < 200);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(first.count);
    expect(pages).toBeGreaterThan(1);
    if (first.count <= 200) expect(seen).toEqual(ok<DV>(await get("/v1/owner/drill?period=7d&what=collections&limit=200")).rows.map((r) => r.id)); // the order of one big page
    // a list built here (ranked by amount) pages by position
    const sup = ok<DV>(await get("/v1/owner/drill?period=7d&what=stockValue&limit=1"));
    if (sup.count > 1) {
      const p2 = ok<DV>(await get(`/v1/owner/drill?period=7d&what=stockValue&limit=1&cursor=${encodeURIComponent(sup.nextCursor!)}`));
      expect(p2.rows[0]!.id).not.toBe(sup.rows[0]!.id);
    }
    expect((await get("/v1/owner/drill?period=7d&what=collections&cursor=not-a-cursor")).json().code).toBe("bad_cursor");
    expect((await get("/v1/owner/drill?period=7d&what=collections&limit=500")).statusCode).toBe(400);
    // the owner of another facility (the Lite hospital) sees none of these rows
    const lite = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: "01798000009", password: "setu1234" } });
    const lc = [lite.headers["set-cookie"]].flat()[0] as string;
    const theirs = ok<DV>(await app.inject({ method: "GET", url: "/v1/owner/drill?period=7d&what=collections&limit=200", headers: { cookie: lc } }));
    expect(theirs.rows.some((r) => seen.includes(r.id))).toBe(false);
  });
  it("cash taken outside a shift is on the leakage list", async () => {
    await finishOpenShifts();
    const before = ok<Dash>(await get("/v1/owner/dashboard?period=today")).leakage.find((l) => l.kind === "cashOutsideShift")!;
    await paidVisit("cash");
    const after = ok<Dash>(await get("/v1/owner/dashboard?period=today")).leakage.find((l) => l.kind === "cashOutsideShift")!;
    expect(after.count).toBe(before.count + 1);
  }, 60_000);
  it("only the owner and admin see the dashboard", async () => {
    expect((await get("/v1/owner/dashboard", "cashier")).statusCode).toBe(403);
    expect((await get("/v1/owner/dashboard", "admin")).statusCode).toBe(200);
    expect((await get("/v1/owner/drill?what=revenue", "doctor")).statusCode).toBe(403);
  });
});
