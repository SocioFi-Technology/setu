/* Admin session 1 contract tests on the real database (as setu_app), ADR 0010:
   - G1 onboarding: the E2E New Clinic (in setup) completes its checklist — details, branch, ward with beds, a doctor
     with a one-time password and a verified BMDC number, the doctor's fee, formats, payment methods, a test SMS — and
     goes live (refused before; flagged in the audit log);
   - G2 users: a cashier is created with a one-time password (never in the stored replay), signs in to a setup-only
     session, sets a password and PIN; deactivation and a password reset end the user's sessions everywhere; only an
     owner makes an owner; never yourself;
   - G3 masters: a price change needs a reason, keeps drafts at their price ("price changed since"), and the database
     refuses a change without its history row; approval limits need a reason and are flagged; a payment method that is
     switched off is refused;
   - G4 the audit log: flagged filter and a CSV export that is itself audited;
   - who may: the cashier and another tenant are refused. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("admin.test: DATABASE_URL_APP not set — admin contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const T = "t_e2e";
const cookies: Record<string, string> = {};
const USERS = { newadmin: "01799000011", owner: "01799000009", admin: "01799000010", cashier: "01799000008", desk: "01799000001", doctor: "01799000002", otherAdmin: "01711000010" } as const;
const phone = () => `019${String(randomInt(0, 1e8)).padStart(8, "0")}`;

async function login(identifier: string, password = "setu1234") {
  const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier, password } });
  const c = r.headers["set-cookie"];
  return { r, cookie: Array.isArray(c) ? c[0]! : (c as string | undefined) ?? "" };
}
beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  // the setup facility starts from scratch each run (as pnpm reset-e2e does)
  const { execSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  execSync("pnpm --filter @setu/db reset-e2e", { cwd: fileURLToPath(new URL("../../..", import.meta.url)), stdio: "ignore" });
  for (const [k, p] of Object.entries(USERS)) cookies[k] = (await login(p)).cookie;
});
afterAll(async () => { await app.close(); });

const get = (url: string, who: string) => app.inject({ method: "GET", url, headers: { cookie: cookies[who] ?? who } });
const post = (url: string, payload: object, who: string, key: string = randomUUID()) => app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who] ?? who, "idempotency-key": key } });
const ok = async (r: Promise<{ statusCode: number; body: string; json: () => any }>, status = 200) => { const x = await r; expect(x.statusCode, x.body).toBe(status); return x.json(); }; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.runIf(db)("G1 onboarding → go live", () => {
  it("the checklist blocks go-live until complete; then live (once), flagged in the audit log", { timeout: 30_000 }, async () => {
    let f = await ok(get("/v1/admin/facility", "newadmin"));
    expect(f).toMatchObject({ status: "setup", liveAt: null, plan: "pro" });
    const early = await post("/v1/admin/go-live", {}, "newadmin");
    expect([early.statusCode, early.json().code]).toEqual([422, "checklist_incomplete"]);
    expect(early.json().blockers.map((b: { code: string }) => b.code)).toEqual(["organization", "branch", "wards", "doctor", "price_list", "templates", "payment_method", "test_sms"]);

    f = await ok(post("/v1/admin/facility", { name: "E2E New Clinic", nameBn: "ই২ই নতুন ক্লিনিক", address: "Road 4, Uttara, Dhaka", licenceNo: `DGHS-${RUN}` }, "newadmin"));
    expect((await post("/v1/admin/wards", { name: "Ward A", beds: 4 }, "newadmin")).json().code).toBe("branch_first");
    f = await ok(post("/v1/admin/branches", { name: "Uttara branch", nameBn: "উত্তরা শাখা" }, "newadmin"), 201);
    f = await ok(post("/v1/admin/wards", { name: "Ward A", beds: 4 }, "newadmin"), 201);
    expect(f.wards).toEqual([expect.objectContaining({ name: "Ward A", beds: 4 })]);

    // a doctor: a one-time password, a BMDC number checked by the registration adapter
    const key = randomUUID(), docPhone = phone();
    const docBody = { nameBn: "ডা. নতুন", nameEn: `Dr. New ${RUN}`, phone: docPhone, role: "doctor", regNo: "A-52817" };
    const doc = await ok(post("/v1/admin/users", docBody, "newadmin", key), 201);
    expect(doc.oneTimePassword).toMatch(/^[A-Za-z2-9]{10}$/);
    expect(doc.user).toMatchObject({ role: "doctor", firstSignInPending: true, registration: { body: "BMDC", number: "A-52817", verified: false } });
    // a replay answers the stored response — which never holds the one-time password
    const replay = await post("/v1/admin/users", docBody, "newadmin", key);
    expect([replay.statusCode, replay.headers["idempotent-replay"], replay.json().user.id, replay.json().oneTimePassword]).toEqual([201, "true", doc.user.id, null]);
    const stored = await db!.forTenant(T, (tx) => tx.idempotencyKey.findFirst({ where: { key } }));
    expect(JSON.stringify(stored?.response)).not.toContain(doc.oneTimePassword);
    const bad = await ok(post(`/v1/admin/users/${doc.user.id}/verify-registration`, { regNo: "A-52000" }, "newadmin"));
    expect(bad.registration.verified).toBe(false);
    const good = await ok(post(`/v1/admin/users/${doc.user.id}/verify-registration`, { regNo: "A-52817" }, "newadmin"));
    expect(good.registration.verified).toBe(true);

    // the price list: the doctor has no fee until one is added
    let prices = await ok(get("/v1/admin/prices", "newadmin"));
    expect(prices.doctorsWithoutFee.map((d: { id: string }) => d.id)).toContain(doc.user.id);
    prices = await ok(post("/v1/admin/prices", { kind: "consultation", ref: doc.user.id, unitPaisa: 70_000 }, "newadmin"), 201);
    expect(prices.doctorsWithoutFee).toEqual([]);
    prices = await ok(post("/v1/admin/prices", { kind: "test", ref: "cbc", unitPaisa: 45_000 }, "newadmin"), 201);
    expect((await post("/v1/admin/prices", { kind: "test", ref: "cbc", unitPaisa: 45_000 }, "newadmin")).json().code).toBe("already_priced");

    const settings = { cashierLimitPaisa: 50_000, cashierLimitBp: 500, approverLimitPaisa: 1_000_000, labelWidthMm: 50, labelHeightMm: 30, receiptFormat: "thermal", rxFormat: "a5", paymentMethods: ["cash", "bkash"] };
    f = await ok(post("/v1/admin/settings", settings, "newadmin"));
    expect(f.settings).toMatchObject({ receiptFormat: "thermal", paymentMethods: ["cash", "bkash"] });
    f = await ok(post("/v1/admin/sms-test", { phone: "01712345678" }, "newadmin"));
    expect(f.sms.testedAt).toEqual(expect.any(String));
    expect(f.checklist.every((c: { done: boolean; required: boolean }) => c.done || !c.required)).toBe(true);

    // external review B4: through the ORGANIZATION machine — two go-lives at once make one
    const since = new Date();
    const both = await Promise.all([post("/v1/admin/go-live", {}, "newadmin"), post("/v1/admin/go-live", {}, "newadmin")]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.statusCode === 409)!.json().code).toBe("already_live");
    f = both.find((r) => r.statusCode === 200)!.json();
    expect(f).toMatchObject({ status: "live", liveAt: expect.any(String) });
    expect((await post("/v1/admin/go-live", {}, "newadmin")).json().code).toBe("already_live");
    expect((await db!.forTenant(T, (tx) => tx.auditEvent.findMany({ where: { action: "go-live", entityId: "o_e2e_new", at: { gte: since } } })))).toHaveLength(1);
    const flagged = await ok(get("/v1/admin/audit?flagged=1", "newadmin"));
    expect(flagged.items.map((x: { action: string }) => x.action)).toContain("go-live");
    // the database keeps a live facility live
    await expect(db!.forTenant(T, (tx) => tx.organization.update({ where: { id: "o_e2e_new" }, data: { status: "setup" } }), { userId: "u_e2e_newadmin" })).rejects.toThrow(/never goes back/);
  });
});

describe.runIf(db)("G2 users: one-time password, first sign-in, sessions end", () => {
  it("cashier: setup session until a password and PIN are set; deactivation and a reset end the sessions", { timeout: 30_000 }, async () => {
    const p = phone();
    const c = await ok(post("/v1/admin/users", { nameBn: "নতুন ক্যাশিয়ার", nameEn: `Cashier ${RUN}`, phone: p, role: "cashier" }, "newadmin"), 201);
    const first = await login(p, c.oneTimePassword);
    expect(first.r.statusCode, first.r.body).toBe(200);
    expect(first.r.json().mustSetCredentials).toBe(true);
    // a one-time password works for one sign-in only
    const twice = await login(p, c.oneTimePassword);
    expect([twice.r.statusCode, twice.r.json().code]).toEqual([401, "otp_used"]);
    const blocked = await get("/v1/billing/worklist", first.cookie);
    expect([blocked.statusCode, blocked.json().code]).toEqual([403, "setup_required"]);
    const weak = await post("/v1/auth/first-sign-in", { password: "short", pin: "1111" }, first.cookie);
    expect([weak.statusCode, weak.json().code]).toEqual([400, "too_short"]);
    // external review B5: through command() — a key is required; a replay after success finds the one-time session
    // ended (it never re-issues a session); one audit event; the stored request hash leaves the password and PIN out
    const noKey = await app.inject({ method: "POST", url: "/v1/auth/first-sign-in", payload: { password: "greenlife7", pin: "2580" }, headers: { cookie: first.cookie } });
    expect([noKey.statusCode, noKey.json().code]).toEqual([400, "idempotency_key_required"]);
    const fsKey = randomUUID();
    const set = await post("/v1/auth/first-sign-in", { password: "greenlife7", pin: "2580" }, first.cookie, fsKey);
    expect(set.statusCode, set.body).toBe(200);
    const replayed = await post("/v1/auth/first-sign-in", { password: "greenlife7", pin: "2580" }, first.cookie, fsKey);
    expect([replayed.statusCode, replayed.json().code]).toEqual([401, "session_ended"]);
    expect(replayed.headers["set-cookie"]).toBeUndefined();
    const stored = await db!.forTenant(T, (tx) => tx.idempotencyKey.findFirst({ where: { key: fsKey } }));
    expect(JSON.stringify(stored!.response)).not.toMatch(/greenlife7|2580/);
    expect(await db!.forTenant(T, (tx) => tx.auditEvent.count({ where: { action: "first-sign-in", entityId: c.user.id } }))).toBe(1);
    const sc = set.headers["set-cookie"]; const cookie = Array.isArray(sc) ? sc[0]! : (sc as string);
    expect((await get("/v1/billing/worklist", cookie)).statusCode).toBe(200);
    expect((await get("/v1/billing/worklist", first.cookie)).json().code).toBe("setup_required");
    expect((await login(p, c.oneTimePassword)).r.statusCode).toBe(401); // the one-time password no longer works
    const normal = await login(p, "greenlife7");
    expect(normal.r.json().mustSetCredentials).toBe(false);

    // a reset: a new one-time password; every session of the user ends
    const reset = await ok(post(`/v1/admin/users/${c.user.id}/reset-password`, {}, "newadmin"));
    expect(reset.oneTimePassword).toMatch(/^[A-Za-z2-9]{10}$/);
    expect([(await get("/v1/billing/worklist", normal.cookie)).statusCode, (await get("/v1/billing/worklist", normal.cookie)).json().code]).toEqual([401, "session_ended"]);
    expect((await get("/v1/me", normal.cookie)).statusCode).toBe(401);

    // deactivation (with a reason): signed out everywhere; reactivation lets them sign in again
    const again = await login(p, reset.oneTimePassword);
    const off = await post(`/v1/admin/users/${c.user.id}/deactivate`, { reason: "short" }, "newadmin");
    expect([off.statusCode, off.json().code]).toEqual([400, "reason_required"]);
    const done = await ok(post(`/v1/admin/users/${c.user.id}/deactivate`, { reason: "Left the clinic on 04/10/2026" }, "newadmin"));
    expect(done).toMatchObject({ active: false, deactivated: { reason: "Left the clinic on 04/10/2026" } });
    expect((await get("/v1/me", again.cookie)).statusCode).toBe(401);
    expect((await login(p, reset.oneTimePassword)).r.statusCode).toBe(401);
    await ok(post(`/v1/admin/users/${c.user.id}/reactivate`, {}, "newadmin"));
    const fresh = await ok(post(`/v1/admin/users/${c.user.id}/reset-password`, {}, "newadmin"));
    expect((await login(p, fresh.oneTimePassword)).r.statusCode).toBe(200);
  });

  it("an admin never resets, switches off or brings back an owner (the account is the owner's everywhere)", async () => {
    const owner = (await ok(get("/v1/admin/users", "admin"))).items.find((u: { phone: string }) => u.phone === USERS.owner);
    expect((await post(`/v1/admin/users/${owner.id}/reset-password`, {}, "admin")).json().code).toBe("owner_only");
    expect((await post(`/v1/admin/users/${owner.id}/deactivate`, { reason: "testing the owner rule" }, "admin")).json().code).toBe("owner_only");
  });
  it("never yourself; only an owner makes an owner; a role change ends the user's sessions", async () => {
    const me = (await ok(get("/v1/admin/users", "newadmin"))).items.find((u: { phone: string }) => u.phone === USERS.newadmin);
    expect((await post(`/v1/admin/users/${me.id}/deactivate`, { reason: "testing myself out" }, "newadmin")).json().code).toBe("self");
    expect((await post(`/v1/admin/users/${me.id}/role`, { role: "cashier" }, "newadmin")).json().code).toBe("self");
    expect((await post("/v1/admin/users", { nameBn: "মালিক", nameEn: "Owner Two", phone: phone(), role: "owner" }, "newadmin")).json().code).toBe("owner_only");
    const p = phone();
    const n = await ok(post("/v1/admin/users", { nameBn: "নার্স", nameEn: `Nurse ${RUN}`, phone: p, role: "nurse", regNo: "B-12345" }, "newadmin"), 201);
    const s1 = await login(p, n.oneTimePassword);
    const set = await post("/v1/auth/first-sign-in", { password: "nurse2026x", pin: "8642" }, s1.cookie);
    const sc = set.headers["set-cookie"]; const cookie = Array.isArray(sc) ? sc[0]! : (sc as string);
    expect((await get("/v1/me", cookie)).statusCode).toBe(200);
    const ch = await ok(post(`/v1/admin/users/${n.user.id}/role`, { role: "receptionist", reason: "Moved to the front desk" }, "newadmin"));
    expect(ch.role).toBe("receptionist");
    expect((await get("/v1/me", cookie)).statusCode).toBe(401);
  });
});

describe.runIf(db)("G3 masters and settings", () => {
  it("a price change needs a reason, keeps the draft's price (price changed since), and the database insists on the history", { timeout: 30_000 }, async () => {
    const created = await ok(post("/v1/admin/prices", { kind: "service", nameEn: `Admin test service ${RUN}`, nameBn: "অ্যাডমিন টেস্ট সেবা", unitPaisa: 20_000 }, "owner"), 201);
    const item = created.items.find((i: { nameEn: string }) => i.nameEn === `Admin test service ${RUN}`);
    // a draft bill with that service, made before the change
    const reg = await ok(post("/v1/patients", { nameBn: "মূল্য রোগী", nameEn: `Price ${RUN}`, sex: "male", dobMode: "dob", dob: "01/01/1980", phone: phone(), phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true }, "desk"), 201);
    const v = await ok(post(`/v1/encounters/${reg.encounter.id}/consultation/open`, {}, "doctor"));
    const saved = await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: cookies.doctor!, "idempotency-key": randomUUID() }, payload: { rev: 1, sections: { complaints: [{ text: "Check-up", duration: { n: 1, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" }, sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [], orders: [] } });
    await ok(post(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.json().rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor"));
    const bill = await ok(post(`/v1/encounters/${reg.encounter.id}/invoice`, {}, "cashier"), 201);
    const withLine = await ok(post(`/v1/invoices/${bill.invoice.id}/lines`, { code: item.code, qty: 1, rev: bill.invoice.rev }, "cashier"));
    expect(withLine.lines.find((l: { code: string }) => l.code === item.code)).toMatchObject({ unitPaisa: 20_000, currentUnitPaisa: null });

    const noReason = await post(`/v1/admin/prices/${item.id}`, { unitPaisa: 25_000, vatRateBp: 0, reason: "up" }, "owner");
    expect([noReason.statusCode, noReason.json().code]).toEqual([400, "reason_required"]);
    await ok(post(`/v1/admin/prices/${item.id}`, { unitPaisa: 25_000, vatRateBp: 0, reason: "Supplies cost more since October" }, "owner"));
    const after = await ok(get(`/v1/invoices/${bill.invoice.id}`, "cashier"));
    expect(after.lines.find((l: { code: string }) => l.code === item.code)).toMatchObject({ unitPaisa: 20_000, currentUnitPaisa: 25_000 });
    const hist = await ok(get(`/v1/admin/prices/${item.id}/history`, "owner"));
    expect(hist.items.map((h: { oldUnitPaisa: number | null; newUnitPaisa: number }) => [h.oldUnitPaisa, h.newUnitPaisa])).toEqual([[20_000, 25_000], [null, 20_000]]);
    await expect(db!.forTenant(T, (tx) => tx.chargeItemDefinition.update({ where: { id: item.id }, data: { unitPaisa: 1 } }), { userId: "u_e2e_owner" })).rejects.toThrow(/history row/);
    // more of the same service after the change: a new line at the new price (the old one keeps its own)
    const more = await ok(post(`/v1/invoices/${bill.invoice.id}/lines`, { code: item.code, qty: 1, rev: after.invoice.rev }, "cashier"));
    expect(more.lines.filter((l: { code: string }) => l.code === item.code).map((l: { unitPaisa: number }) => l.unitPaisa).sort()).toEqual([20_000, 25_000]);

    // a payment method switched off is refused (and the facility's methods restored after)
    const f = await ok(get("/v1/admin/facility", "owner"));
    await ok(post("/v1/admin/settings", { ...f.settings, paymentMethods: f.settings.paymentMethods.filter((m: string) => m !== "card") }, "owner"));
    try {
      const issued = await ok(post(`/v1/invoices/${bill.invoice.id}/issue`, { rev: more.invoice.rev }, "cashier"));
      const card = await post(`/v1/invoices/${bill.invoice.id}/payments`, { method: "card", amountPaisa: issued.invoice.totalPaisa, reference: "VISA-1234" }, "cashier");
      expect([card.statusCode, card.json().code]).toEqual([422, "method_off"]);
    } finally { await ok(post("/v1/admin/settings", { ...f.settings }, "owner")); }
  });

  it("approval limits need a reason and are flagged; a payment method switched off is refused", async () => {
    const f = await ok(get("/v1/admin/facility", "owner"));
    const base = { ...f.settings };
    const noReason = await post("/v1/admin/settings", { ...base, cashierLimitPaisa: 60_000 }, "owner");
    expect([noReason.statusCode, noReason.json().code]).toEqual([400, "reason_required"]);
    const above = await post("/v1/admin/settings", { ...base, cashierLimitPaisa: 2_000_000, reason: "Testing the limit rule" }, "owner");
    expect([above.statusCode, above.json().code]).toEqual([400, "cashier_above_approver"]);
    await ok(post("/v1/admin/settings", { ...base, cashierLimitPaisa: 60_000, reason: "Busier desk this month" }, "owner"));
    await ok(post("/v1/admin/settings", { ...base, reason: "Back to the usual limit" }, "owner"));
    const flagged = await ok(get("/v1/admin/audit?flagged=1&action=settings-change", "owner"));
    expect(flagged.items.length).toBeGreaterThanOrEqual(2);
    expect(flagged.items[0]).toMatchObject({ action: "settings-change", flagged: true });

    // the E2E New Clinic takes cash and bKash only: a card payment is refused there
    const methods = (await ok(get("/v1/admin/facility", "newadmin"))).settings.paymentMethods;
    expect(methods).not.toContain("card");
  });
});

describe.runIf(db)("G4 the audit log, and who may", () => {
  it("pages, filters by flag, exports CSV (the export is itself flagged)", async () => {
    const page = await ok(get("/v1/admin/audit", "owner"));
    expect(page.items.length).toBeGreaterThan(0);
    if (page.next) { const p2 = await ok(get(`/v1/admin/audit?before=${page.next}`, "owner")); expect(p2.items[0].id).not.toBe(page.items[0].id); }
    const csv = await get("/v1/admin/audit.csv?flagged=1", "owner");
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\r\n")[0]).toContain("at,user,role,action,entity");
    const exp = await ok(get("/v1/admin/audit?action=export", "owner"));
    expect(exp.items[0]).toMatchObject({ action: "export", flagged: true });
    // a bill void is written as an update with event "void" — it is flagged too, and the filters combine
    const voids = await ok(get("/v1/admin/audit?flagged=1&action=update", "owner"));
    expect(voids.items.length).toBeGreaterThan(0);
    expect(voids.items.every((x: { action: string; flagged: boolean; summary: string }) => x.action === "update" && x.flagged && x.summary.includes("void"))).toBe(true);
  });
  it("one facility's admin sees only that facility's events", async () => {
    const theirs = await ok(get("/v1/admin/audit?action=settings-change", "newadmin"));
    const ours = await ok(get("/v1/admin/audit?action=settings-change", "owner"));
    const ids = new Set(theirs.items.map((x: { id: string }) => x.id));
    expect(ours.items.some((x: { id: string }) => ids.has(x.id))).toBe(false);
  });
  it("the cashier is refused; another tenant's admin finds nothing", async () => {
    expect((await get("/v1/admin/users", "cashier")).statusCode).toBe(403);
    const ours = (await ok(get("/v1/admin/users", "owner"))).items[0];
    expect((await post(`/v1/admin/users/${ours.id}/deactivate`, { reason: "not mine to switch off" }, "otherAdmin")).statusCode).toBe(404);
  });
});
