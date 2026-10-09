/* Slice E3 contract tests (ADR 0023) on the real database (as setu_app): the E2E Test Clinic orders, Green Life
   Mirpur is the chosen centre (it has a technologist and a pathologist).
   - accepting finishes the centre's lab-only visit and links its record to the same person (the order proves it);
   - the centre's bill: no consultation line, the tests at its prices; the patient sees the total and the bKash link the
     centre's cashier sent;
   - collected and released reach the order's tracker; the ordering doctor's inbox gets the result; the report opens
     through the order only (another facility: not found), audited at the centre; acknowledging marks it received and
     tells the patient; the report is in the patient's history (the centre's record is theirs). */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { counters } from "../src/adapters/counters.js";
import { fakeMessenger } from "../src/adapters/messaging/index.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("portable-results.test: DATABASE_URL_APP not set — E3 contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const IP = `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`;
const PHONE = `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, PH = PHONE.slice(1);
const USERS = { desk: "01799000001", doctor: "01799000002", glTech: "01711000005", glPath: "01711000006", glCashier: "01711000008", liteDoctor: "01798000002" } as const;
type Who = keyof typeof USERS;
const staff: Partial<Record<Who, string>> = {};
let cookie = "", patientId = "", orderId = "", centreEnc = "";
const owner = () => new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
const sget = (url: string, who: Who) => app.inject({ method: "GET", url, headers: { cookie: staff[who]! } });
const spost = (url: string, payload: object, who: Who) => app.inject({ method: "POST", url, payload, headers: { cookie: staff[who]!, "idempotency-key": randomUUID() } });
const ok = <R,>(r: { statusCode: number; body: string; json: () => R }, code = 200) => { expect(r.statusCode, r.body).toBe(code); return r.json(); };
const pget = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
const ppost = (url: string, payload: object) => app.inject({ method: "POST", url, payload, headers: { cookie, "idempotency-key": randomUUID() } });
type Order = { id: string; number: string; status: string; resultReady: boolean; steps: { step: string }[]; items: { id: string; testCode: string; status: string }[]; bill: { totalPaisa: number; paidPaisa: number; status: string; payUrl: string | null } | null };
type LV = { specimens: { id: string; status: string }[]; orders: { id: string; testCode: string; results: { id: string }[] }[]; release: { observationIds: string[] }; reports: { id: string }[] };

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of Object.entries(USERS)) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; staff[k as Who] = Array.isArray(c) ? c[0]! : (c as string);
  }
  const reg = ok<{ patient: { id: string }; encounter: { id: string } }>(await spost("/v1/patients", { nameBn: "নাসরিন আক্তার", nameEn: `Nasrin Akter ${RUN}`, sex: "female", dobMode: "dob", dob: "12/02/1979", phone: PHONE, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true }, "desk"), 201);
  patientId = reg.patient.id;
  const v = ok<{ draft: { id: string } }>(await spost(`/v1/encounters/${reg.encounter.id}/consultation/open`, {}, "doctor"));
  const saved = ok<{ rev: number }>(await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: staff.doctor!, "idempotency-key": randomUUID() }, payload: {
    rev: 1, sections: { complaints: [{ text: "Thirst", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [],
    orders: [{ testCode: "cbc", priority: "routine", performer: "network" }, { testCode: "rbs", priority: "routine", performer: "network" }] } }));
  ok(await spost(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor"));
  orderId = ok<{ items: { id: string }[] }>(await sget(`/v1/portable-orders?patientId=${patientId}`, "doctor")).items[0]!.id;
  // the patient signs in, links the clinic's record, chooses Green Life
  await app.inject({ method: "POST", url: "/v1/patient/otp", remoteAddress: IP, payload: { phone: PHONE, lang: "en" } });
  const code = fakeMessenger()!.log("network").filter((m) => m.to === PHONE).at(-1)!.text.match(/\d{6}/)![0];
  const si = await app.inject({ method: "POST", url: "/v1/patient/sign-in", payload: { phone: PHONE, code } });
  cookie = ([] as string[]).concat(si.headers["set-cookie"] as string | string[]).find((c) => c.startsWith("setu_patient="))!.split(";")[0]!;
  const claim = ok<{ items: { id: string; facilityEn: string | null }[] }>(await pget("/v1/patient/claims")).items.find((c) => c.facilityEn?.startsWith("E2E Test"))!;
  const o = owner();
  const cc = (await o.patient.findUniqueOrThrow({ where: { id: patientId }, select: { claimCode: true } })).claimCode!;
  await o.$disconnect();
  ok(await ppost(`/v1/patient/claims/${claim.id}/proof`, { method: "code", code: cc }));
  ok(await ppost(`/v1/patient/portable-orders/${orderId}/choose`, { organizationId: "o_greenlife_mirpur", collection: "centre" }));
}, 120_000);
afterAll(async () => { await counters().del(`potp:send:${PH}`, `potp:tries:${PH}`, `potp:code:${PH}`); await app.close(); });

describe.runIf(db)("E3 at the centre: the visit, the person, the bill", () => {
  it("accepting finishes the centre's lab-only visit and links its record to the same person", async () => {
    const items = ok<Order>(await sget(`/v1/network-orders/${orderId}`, "glTech")).items;
    const o = ok<Order & { }>(await spost(`/v1/network-orders/${orderId}/decide`, { items: items.map((i) => ({ itemId: i.id, accept: true })) }, "glTech"));
    expect(o.status).toBe("accepted");
    const facts = await db!.forTenant("t_greenlife", async (tx) => {
      const p = await tx.portableOrder.findFirstOrThrow({ where: { id: orderId } });
      const e = await tx.encounter.findFirstOrThrow({ where: { id: p.centreEncounterId! } });
      const claim = await tx.patientClaim.findFirst({ where: { patientId: p.centrePatientId! } });
      return { e, claim };
    });
    centreEnc = facts.e.id;
    expect(facts.e.status).toBe("finished");
    expect(facts.claim).toMatchObject({ status: "linked", method: "network-order" });
  });
  it("the centre's bill: no consultation, the two tests at its prices; the patient sees the total, then the bKash link", async () => {
    const before = ok<{ items: Order[] }>(await pget("/v1/patient/portable-orders")).items.find((x) => x.id === orderId)!;
    expect(before.bill).toMatchObject({ status: "not-billed", payUrl: null });
    const bill = ok<{ invoice: { id: string; rev: number; totalPaisa: number }; lines: { code: string; source?: string }[] }>(await spost(`/v1/encounters/${centreEnc}/invoice`, {}, "glCashier"), 201);
    expect(bill.lines.map((l) => l.code).sort()).toEqual(["test:cbc", "test:rbs"]);
    expect(bill.invoice.totalPaisa).toBe(before.bill!.totalPaisa);
    ok(await spost(`/v1/invoices/${bill.invoice.id}/issue`, { rev: bill.invoice.rev }, "glCashier"));
    const mine = ok<{ shift: { status: string } | null }>(await sget("/v1/shifts/mine", "glCashier"));
    if (!mine.shift || mine.shift.status !== "open") ok(await spost("/v1/shifts", { openingFloatPaisa: 100_000 }, "glCashier"), 201);
    ok(await spost(`/v1/invoices/${bill.invoice.id}/payments`, { method: "bkash", amountPaisa: bill.invoice.totalPaisa }, "glCashier"), 201);
    const after = ok<{ items: Order[] }>(await pget("/v1/patient/portable-orders")).items.find((x) => x.id === orderId)!;
    expect(after.bill).toMatchObject({ status: "issued", paidPaisa: 0 });
    expect(after.bill!.payUrl).toMatch(/\/p\/[A-Za-z0-9_-]+$/);
  });
});

describe.runIf(db)("E3 results back", () => {
  it("collected and released reach the tracker; the doctor's inbox gets the result", async () => {
    const lab = ok<LV>(await spost(`/v1/lab/visits/${centreEnc}/labels`, {}, "glTech"));
    for (const sp of lab.specimens.filter((x) => x.status === "pending")) for (const step of ["collect", "receive", "start"]) ok(await spost(`/v1/lab/specimens/${sp.id}/${step}`, { at: new Date().toISOString() }, "glTech"));
    expect(ok<Order>(await sget(`/v1/portable-orders/${orderId}`, "doctor")).steps.map((x) => x.step)).toContain("collected");
    let lv = ok<LV>(await sget(`/v1/lab/visits/${centreEnc}`, "glTech"));
    const VALUES: Record<string, [string, string][]> = { cbc: [["hb", "11.2"], ["wbc", "8000"], ["plt", "250000"]], rbs: [["rbs", "6.1"]] };
    for (const o of lv.orders) ok(await spost(`/v1/lab/orders/${o.id}/results`, { entries: VALUES[o.testCode]!.map(([analyteCode, value]) => ({ analyteCode, value })) }, "glTech"), 201);
    lv = ok<LV>(await sget(`/v1/lab/visits/${centreEnc}`, "glTech"));
    lv = ok<LV>(await spost(`/v1/lab/visits/${centreEnc}/verify`, { pin: "1234", observationIds: lv.orders.flatMap((o) => o.results.map((r) => r.id)), deltaChecked: true }, "glTech"));
    lv = ok<LV>(await spost(`/v1/lab/visits/${centreEnc}/validate`, { pin: "1234", observationIds: lv.orders.flatMap((o) => o.results.map((r) => r.id)) }, "glPath"));
    ok(await spost(`/v1/lab/visits/${centreEnc}/release`, { observationIds: lv.release.observationIds }, "glPath"), 201);
    const o = ok<Order>(await sget(`/v1/portable-orders/${orderId}`, "doctor"));
    expect(o.resultReady).toBe(true);
    expect(o.steps.map((x) => x.step)).toEqual(["ordered", "centre-chosen", "decided", "collected", "released"]);
    const inbox = ok<{ items: { kind: string; portable: { orderId: string } | null }[] }>(await sget("/v1/doctor/inbox", "doctor"));
    expect(inbox.items.some((i) => i.kind === "portable-result" && i.portable?.orderId === orderId)).toBe(true);
  });
  it("the report opens through the order only, audited at the centre; nobody else reads it", async () => {
    const r = ok<{ number: string; tests: { results: { code: string; value: number }[] }[] }>(await sget(`/v1/portable-orders/${orderId}/report`, "doctor"));
    expect(r.tests.flatMap((t) => t.results).find((x) => x.code === "hb")?.value).toBe(11.2);
    expect((await sget(`/v1/portable-orders/${orderId}/report`, "liteDoctor")).statusCode).toBe(404);
    const audit = await db!.forTenant("t_greenlife", (tx) => tx.auditEvent.findMany({ where: { basis: "portable-order", action: "view" }, orderBy: { at: "desc" }, take: 5 }));
    expect(audit.some((a) => (a.detail as { reader?: { facilityEn: string } }).reader?.facilityEn === "E2E Test Clinic")).toBe(true);
  });
  it("the doctor acknowledges: received; the patient is told; the report is in the patient's history", async () => {
    const inbox = ok<{ items: { id: string; kind: string; portable: { orderId: string } | null }[] }>(await sget("/v1/doctor/inbox", "doctor"));
    const item = inbox.items.find((i) => i.kind === "portable-result" && i.portable?.orderId === orderId)!;
    ok(await spost(`/v1/doctor/inbox/${item.id}/ack`, { notifyPatient: false }, "doctor"));
    const o = ok<Order>(await sget(`/v1/portable-orders/${orderId}`, "doctor"));
    expect(o.steps.map((x) => x.step)).toContain("received");
    const told = await db!.forTenant("t_e2e", (tx) => tx.communication.count({ where: { patientId, kind: "portable-received", channel: "patient_app" } }));
    expect(told).toBe(1);
    const tl = ok<{ items: { kind: string; facilityEn: string | null }[] }>(await pget("/v1/patient/timeline?filter=reports"));
    expect(tl.items.some((i) => i.kind === "report" && i.facilityEn === "Green Life Clinic, Mirpur")).toBe(true);
  });
});
