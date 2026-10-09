/* Slice E1–E2 contract tests (ADR 0022) on the real database (as setu_app): the E2E Test Clinic orders, the E2E Lite
   Hospital and Green Life are network centres.
   - E1: signing network tests makes one portable order (the patient told: SMS of the fixed template, the app); the
     clinic's own lab and bill never take them; the patient sees the order and the centres (more tests offered first,
     their prices, home collection); no centre sees it before it is chosen; the patient chooses;
   - E2: the chosen centre (only it) decides — a reason of 10+ characters per declined test, a test it does not offer
     declined for that; the accepted tests become the centre's own orders (its patient record: name, sex, age, phone);
     the ordering doctor's inbox names each declined test with the reason; re-order elsewhere once; the desk chooses
     for the patient; nothing is decided twice. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { counters } from "../src/adapters/counters.js";
import { fakeMessenger } from "../src/adapters/messaging/index.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("portable.test: DATABASE_URL_APP not set — E1–E2 contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const IP = `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`;
const PHONE = `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, PH = PHONE.slice(1);
const USERS = { desk: "01799000001", doctor: "01799000002", tech: "01799000005", cashier: "01799000008", liteCashier: "01798000008", liteTech: "01798000006", liteDoctor: "01798000002", glTech: "01711000005" } as const;
type Who = keyof typeof USERS;
const staff: Partial<Record<Who, string>> = {};
let cookie = "", patientId = "", enc = "", orderId = "";
const owner = () => new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

const sget = (url: string, who: Who) => app.inject({ method: "GET", url, headers: { cookie: staff[who]! } });
const spost = (url: string, payload: object, who: Who, key: string = randomUUID()) => app.inject({ method: "POST", url, payload, headers: { cookie: staff[who]!, "idempotency-key": key } });
const ok = <R,>(r: { statusCode: number; body: string; json: () => R }, code = 200) => { expect(r.statusCode, r.body).toBe(code); return r.json(); };
const pget = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
const ppost = (url: string, payload: object) => app.inject({ method: "POST", url, payload, headers: { cookie, "idempotency-key": randomUUID() } });
type Order = { id: string; number: string; status: string; items: { id: string; testCode: string; status: string; declineReason: string | null; notOffered: boolean; unitPaisa: number | null; reorderedToId: string | null }[]; centre: { organizationId: string; collection: string } | null; chosenBy: string | null; reorderable: string[]; patient: { phone: string | null } };

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of Object.entries(USERS)) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; staff[k as Who] = Array.isArray(c) ? c[0]! : (c as string);
  }
  const reg = ok<{ patient: { id: string; claimCode?: string }; encounter: { id: string } }>(await spost("/v1/patients", { nameBn: "নাসরিন আক্তার", nameEn: `Nasrin Akter ${RUN}`, sex: "female", dobMode: "dob", dob: "12/02/1979", phone: PHONE, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true }, "desk"), 201);
  patientId = reg.patient.id; enc = reg.encounter.id;
  // the doctor: CBC, HbA1c and USG at a network centre; RBS here
  const v = ok<{ draft: { id: string } }>(await spost(`/v1/encounters/${enc}/consultation/open`, {}, "doctor"));
  const saved = ok<{ rev: number }>(await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: staff.doctor!, "idempotency-key": randomUUID() }, payload: {
    rev: 1, sections: { complaints: [{ text: "Thirst", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [],
    orders: [{ testCode: "cbc", priority: "routine", performer: "network" }, { testCode: "hba1c", priority: "routine", performer: "network" }, { testCode: "usgwa", priority: "routine", performer: "network" }, { testCode: "rbs", priority: "routine" }] } }));
  ok(await spost(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor"));
  // the patient signs in and links the record
  await app.inject({ method: "POST", url: "/v1/patient/otp", remoteAddress: IP, payload: { phone: PHONE, lang: "en" } });
  const code = fakeMessenger()!.log("network").filter((m) => m.to === PHONE).at(-1)!.text.match(/\d{6}/)![0];
  const si = await app.inject({ method: "POST", url: "/v1/patient/sign-in", payload: { phone: PHONE, code } });
  cookie = ([] as string[]).concat(si.headers["set-cookie"] as string | string[]).find((c) => c.startsWith("setu_patient="))!.split(";")[0]!;
  const claim = ok<{ items: { id: string; facilityEn: string | null }[] }>(await pget("/v1/patient/claims")).items.find((c) => c.facilityEn?.startsWith("E2E Test"))!;
  const o = owner();
  const cc = (await o.patient.findUniqueOrThrow({ where: { id: patientId }, select: { claimCode: true } })).claimCode!;
  await o.$disconnect();
  expect(ok<{ outcome: string }>(await ppost(`/v1/patient/claims/${claim.id}/proof`, { method: "code", code: cc })).outcome).toBe("linked");
}, 120_000);
afterAll(async () => { await counters().del(`potp:send:${PH}`, `potp:tries:${PH}`, `potp:code:${PH}`); await app.close(); });

describe.runIf(db)("E1 the doctor orders, the patient picks a centre", () => {
  it("one portable order for the three network tests; the patient told by SMS (no test names) and the app", async () => {
    const list = ok<{ items: Order[] }>(await sget(`/v1/portable-orders?patientId=${patientId}`, "doctor"));
    expect(list.items).toHaveLength(1);
    const o = list.items[0]!; orderId = o.id;
    expect(o.number).toMatch(/^LO-\d{4}-\d{4,}$/);
    expect(o.status).toBe("active");
    expect(o.items.map((i) => i.testCode)).toEqual(["cbc", "hba1c", "usgwa"]);
    const comms = await db!.forTenant("t_e2e", (tx) => tx.communication.findMany({ where: { patientId, kind: "portable-order" } }));
    expect(comms.map((c) => c.channel).sort()).toEqual(["patient_app", "sms"]);
    // the fixed template: the facility's name ("E2E Test Clinic" has a digit of its own) and nothing clinical
    const sms = comms.find((c) => c.channel === "sms")!.text!.replace(/E2E Test Clinic|ই২ই টেস্ট ক্লিনিক/g, "");
    expect(sms).not.toMatch(/cbc|hba1c|usg|[0-9০-৯]/i);
  });
  it("the clinic's own lab and bill take only the in-house RBS", async () => {
    const lab = ok<{ orders: { testCode: string }[] }>(await sget(`/v1/lab/visits/${enc}`, "tech"));
    expect(lab.orders.map((o) => o.testCode)).toEqual(["rbs"]);
    const bill = ok<{ lines: { code?: string; nameEn: string }[] }>(await spost(`/v1/encounters/${enc}/invoice`, {}, "cashier"), 201);
    expect(bill.lines.map((l) => l.nameEn)).not.toEqual(expect.arrayContaining(["CBC"]));
    expect(bill.lines.some((l) => /HbA1c|USG/.test(l.nameEn))).toBe(false);
    expect(bill.lines.some((l) => l.nameEn === "RBS")).toBe(true);
  });
  it("no centre sees the order before it is chosen", async () => {
    expect((await sget(`/v1/portable-orders/${orderId}`, "liteTech")).statusCode).toBe(404);
    expect(ok<{ items: { id: string }[] }>(await sget("/v1/network-orders", "liteTech")).items.some((x) => x.id === orderId)).toBe(false);
  });
  it("the patient sees the order and the centres: more tests offered first, their prices, home collection", async () => {
    const mine = ok<{ items: Order[] }>(await pget("/v1/patient/portable-orders"));
    expect(mine.items.map((x) => x.id)).toContain(orderId);
    expect(mine.items.find((x) => x.id === orderId)!.patient.phone).toBeNull();
    const c = ok<{ centres: { organizationId: string; offered: { testCode: string }[]; notOffered: string[]; totalPaisa: number; homeFeePaisa: number }[] }>(await pget(`/v1/patient/portable-orders/${orderId}/centres?sort=price&collection=home`));
    expect(c.centres.map((x) => x.organizationId)).toEqual(["o_e2e_lite"]);
    const atCentre = ok<{ centres: { organizationId: string; offered: { testCode: string }[]; totalPaisa: number }[] }>(await pget(`/v1/patient/portable-orders/${orderId}/centres?sort=price`));
    expect(atCentre.centres[0]!.offered).toHaveLength(3);
    expect(atCentre.centres.map((x) => x.organizationId)).toContain("o_e2e_lite");
    expect(atCentre.centres.map((x) => x.organizationId)).not.toContain("o_e2e");
    const lite = c.centres[0]!;
    expect(lite.offered.map((x) => x.testCode)).toEqual(["cbc", "hba1c"]);
    expect(lite.homeFeePaisa).toBe(20_000);
  });
  it("the patient chooses the Lite hospital, home collection; the prices are fixed on the order; only once", async () => {
    const o = ok<Order>(await ppost(`/v1/patient/portable-orders/${orderId}/choose`, { organizationId: "o_e2e_lite", collection: "home" }));
    expect(o).toMatchObject({ status: "centre-chosen", chosenBy: "patient", centre: { organizationId: "o_e2e_lite", collection: "home" } });
    expect(o.items.map((i) => [i.testCode, i.unitPaisa !== null])).toEqual([["cbc", true], ["hba1c", true], ["usgwa", false]]);
    expect(ok<{ code: string }>(await ppost(`/v1/patient/portable-orders/${orderId}/choose`, { organizationId: "o_greenlife_mirpur" }), 409).code).toBe("not_waiting");
    const audit = await db!.forTenant("t_e2e", (tx) => tx.auditEvent.findMany({ where: { entity: "PortableOrder", entityId: orderId, basis: "patient" } }));
    expect(audit.length).toBe(1);
  });
});

describe.runIf(db)("E2 the chosen centre accepts part", () => {
  it("only the chosen centre sees it; another centre does not", async () => {
    expect(ok<{ items: { id: string }[] }>(await sget("/v1/network-orders", "liteTech")).items.some((x) => x.id === orderId)).toBe(true);
    expect((await sget(`/v1/portable-orders/${orderId}`, "glTech")).statusCode).toBe(404);
  });
  it("refused: a declined test without a 10-character reason; a doctor at the centre cannot decide", async () => {
    const items = ok<Order>(await sget(`/v1/network-orders/${orderId}`, "liteTech")).items;
    const [cbc, hba1c] = [items.find((i) => i.testCode === "cbc")!, items.find((i) => i.testCode === "hba1c")!];
    expect((await spost(`/v1/network-orders/${orderId}/decide`, { items: [{ itemId: cbc.id, accept: true }, { itemId: hba1c.id, accept: false, reason: "busy" }] }, "liteTech")).statusCode).toBe(400);
    expect((await spost(`/v1/network-orders/${orderId}/decide`, { items: [{ itemId: cbc.id, accept: true }, { itemId: hba1c.id, accept: true }] }, "liteDoctor")).statusCode).toBe(403);
  });
  it("CBC accepted, HbA1c declined with a reason, USG not offered → partially-accepted; CBC becomes the centre's own order", async () => {
    const items = ok<Order>(await sget(`/v1/network-orders/${orderId}`, "liteTech")).items;
    const [cbc, hba1c] = [items.find((i) => i.testCode === "cbc")!, items.find((i) => i.testCode === "hba1c")!];
    const o = ok<Order>(await spost(`/v1/network-orders/${orderId}/decide`, { items: [{ itemId: cbc.id, accept: true }, { itemId: hba1c.id, accept: false, reason: "Analyser for HbA1c under repair this week" }] }, "liteTech"));
    expect(o.status).toBe("partially-accepted");
    expect(o.items.map((i) => [i.testCode, i.status, i.notOffered])).toEqual([["cbc", "accepted", false], ["hba1c", "declined", false], ["usgwa", "declined", true]]);
    const centre = await db!.forTenant("t_e2e_lite", async (tx) => {
      const p = await tx.patient.findFirst({ where: { networkOrigin: (await tx.portableOrder.findFirstOrThrow({ where: { id: orderId } })).number } });
      const srs = p ? await tx.serviceRequest.findMany({ where: { patientId: p.id } }) : [];
      return { p, srs };
    });
    expect(centre.p).toMatchObject({ nameBn: "নাসরিন আক্তার", sex: "female", phone: PH, nid: null, addressLine: null });
    expect(centre.srs.map((r) => [r.testCode, r.status, r.performer])).toEqual([["cbc", "active", "in-house"]]);
    expect((await spost(`/v1/network-orders/${orderId}/decide`, { items: [{ itemId: cbc.id, accept: true }] }, "liteTech")).statusCode).toBe(409);
  });
  it("the centre's bill (E3): the accepted test at its price and the home collection fee — no consultation", async () => {
    const enc = await db!.forTenant("t_e2e_lite", async (tx) => (await tx.portableOrder.findFirstOrThrow({ where: { id: orderId } })).centreEncounterId!);
    const bill = ok<{ lines: { code: string; unitPaisa: number | null }[] }>(await spost(`/v1/encounters/${enc}/invoice`, {}, "liteCashier"), 201);
    expect(bill.lines.map((l) => [l.code, l.unitPaisa])).toEqual([["desk:home-collection", 20_000], ["test:cbc", expect.any(Number)]]);
  });
  it("the ordering doctor's inbox names each declined test, the centre and the reason", async () => {
    const inbox = ok<{ items: { kind: string; test: { nameEn: string } | null; portable: { number: string; centreEn: string | null; reason: string | null; notOffered: boolean } | null }[] }>(await sget("/v1/doctor/inbox", "doctor"));
    const number = ok<Order>(await sget(`/v1/portable-orders/${orderId}`, "doctor")).number;
    const mine = inbox.items.filter((i) => i.kind === "portable-declined" && i.portable?.number === number);
    expect(mine.map((i) => [i.test!.nameEn, i.portable!.reason, i.portable!.notOffered]).sort()).toEqual([["HbA1c", "Analyser for HbA1c under repair this week", false], ["USG whole abdomen", null, true]]);
    expect(mine.every((i) => i.portable!.centreEn === "E2E Lite Hospital")).toBe(true);
  });
  it("re-order the declined tests elsewhere (once); the desk chooses for the patient; it reaches only that centre", async () => {
    const again = ok<Order>(await spost(`/v1/portable-orders/${orderId}/reorder`, {}, "doctor"), 201);
    expect(again.items.map((i) => i.testCode)).toEqual(["hba1c", "usgwa"]);
    expect((await spost(`/v1/portable-orders/${orderId}/reorder`, {}, "doctor")).statusCode).toBe(409);
    const first = ok<Order>(await sget(`/v1/portable-orders/${orderId}`, "doctor"));
    expect(first.items.filter((i) => i.reorderedToId === again.id).map((i) => i.testCode)).toEqual(["hba1c", "usgwa"]);
    const chosen = ok<Order>(await spost(`/v1/portable-orders/${again.id}/choose`, { organizationId: "o_greenlife_mirpur", collection: "centre" }, "desk"));
    expect(chosen).toMatchObject({ status: "centre-chosen", chosenBy: "desk" });
    expect((await sget(`/v1/portable-orders/${again.id}`, "liteTech")).statusCode).toBe(404);
  });
});
