/* Slice A12–A13 contract tests: the doctor's inbox and acknowledgement (ADR 0007) on the real database (as setu_app),
   in the seeded E2E Test Clinic, with new synthetic patients whose visit the E2E doctor signs and the lab releases.
   Walkthrough A12 and decision D1:
   - a released report reaches the ordering doctor's inbox; critical first, then high/low, then normal, notices last;
   - "Seen" acknowledges once (a replay answers the same; a second acknowledgement is refused);
   - "Seen + tell patient" queues the report-reviewed SMS (facility name only) and sends it after the commit;
   - only the doctor it was sent to; another doctor gets 404, the lab 403; another tenant sees nothing;
   - notices cannot tell the patient; a superseded report version is not acknowledged;
   - a critical vital sign reaches the visit's doctor (decision 47);
   - the database refuses an acknowledgement edit and one made for someone else. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeMessenger } from "../src/adapters/messaging/index.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("doctor.test: DATABASE_URL_APP not set — inbox contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const cookies: Record<string, string> = {};
const T = "t_e2e";
const USERS = { desk: "01799000001", doctor: "01799000002", doctor2: "01799000003", nurse: "01799000004", tech: "01799000005", path: "01799000006", liteDoctor: "01733000002" } as const;
type Who = keyof typeof USERS;

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of Object.entries(USERS)) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; cookies[k] = Array.isArray(c) ? c[0]! : (c as string);
  }
});
afterAll(async () => { await app.close(); });

const get = (url: string, who: Who = "doctor") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const post = (url: string, payload: object = {}, who: Who = "doctor", key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const ok = <R>(r: { statusCode: number; body: string; json: () => R }, code = 200) => { expect(r.statusCode, r.body).toBe(code); return r.json(); };
const now = () => new Date().toISOString();

type LabView = { orders: { id: string; testCode: string; results: { id: string; status: string; flag: string | null }[] }[]; specimens: { id: string; status: string }[]; release: { observationIds: string[] }; reports: { id: string; version: number }[] };
type Item = {
  id: string; kind: string; severity: string; at: string; patient: { id: string; hasMobile: boolean; ageYears: number | null }; encounter: { id: string; token: string | null };
  report: { id: string; version: number; superseded: boolean; results: { code: string; flag: string | null; underCorrection: boolean }[] } | null;
  test: { nameEn: string } | null; vital: { code: string; value: number; flag: string | null } | null;
  acknowledged: { at: string; notifyPatient: boolean; sms: { id: string; status: string } | null } | null; canNotify: boolean;
};
type Inbox = { items: Item[]; counts: { unread: number; critical: number } };

async function newPatientVisit() {
  const r = ok<{ encounter: { id: string }; patient: { id: string } }>(await post("/v1/patients", {
    nameBn: "ইনবক্স রোগী", nameEn: `Inbox Patient ${RUN}`, sex: "female", dobMode: "dob", dob: "03/03/1991", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
    phone: `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self",
  }, "desk"), 201);
  return { enc: r.encounter.id, patient: r.patient.id };
}
async function sign(enc: string, tests: string[]) {
  const v = ok<{ draft: { id: string } }>(await post(`/v1/encounters/${enc}/consultation/open`, {}));
  const saved = await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: cookies.doctor!, "idempotency-key": randomUUID() }, payload: {
    rev: 1, sections: { complaints: [{ text: "Tiredness", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }],
    orders: tests.map((testCode) => ({ testCode, priority: "routine" })),
  } });
  expect(saved.statusCode, saved.body).toBe(200);
  ok(await post(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.json().rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }));
}
const labView = async (enc: string) => ok<LabView>(await get(`/v1/lab/visits/${enc}`, "tech"));
/** Collected, entered with `values`, verified, called back (critical), validated and released by the pathologist. */
async function released(enc: string, values: Record<string, [string, string, string?][]>) {
  let v = ok<LabView>(await post(`/v1/lab/visits/${enc}/labels`, {}, "tech"));
  for (const sp of v.specimens.filter((x) => x.status === "pending")) {
    for (const step of ["collect", "receive", "start"]) ok(await post(`/v1/lab/specimens/${sp.id}/${step}`, { at: now() }, "tech"));
  }
  v = await labView(enc);
  for (const [test, entries] of Object.entries(values)) {
    const o = v.orders.find((x) => x.testCode === test)!;
    ok(await post(`/v1/lab/orders/${o.id}/results`, { entries: entries.map(([analyteCode, value, confirm]) => ({ analyteCode, value, ...(confirm ? { confirm } : {}) })) }, "tech"), 201);
  }
  v = await labView(enc);
  const pre = v.orders.flatMap((o) => o.results.filter((r) => r.status === "preliminary").map((r) => r.id));
  ok(await post(`/v1/lab/visits/${enc}/verify`, { pin: "1234", observationIds: pre, deltaChecked: true }, "tech"));
  v = await labView(enc);
  for (const r of v.orders.flatMap((o) => o.results).filter((x) => x.status === "verified" && (x.flag === "HH" || x.flag === "LL")))
    ok(await post(`/v1/lab/observations/${r.id}/callbacks`, { outcome: "reached", recipientRole: "ordering-doctor", recipientName: "Dr. Test", via: "phone", calledAt: now(), readBack: true }, "tech"), 201);
  v = await labView(enc);
  const ver = v.orders.flatMap((o) => o.results.filter((r) => r.status === "verified").map((r) => r.id));
  ok(await post(`/v1/lab/visits/${enc}/validate`, { pin: "1234", observationIds: ver }, "path"));
  v = await labView(enc);
  return ok<LabView>(await post(`/v1/lab/visits/${enc}/release`, { observationIds: v.release.observationIds }, "path"), 201);
}
const inbox = async (who: Who = "doctor") => ok<Inbox>(await get("/v1/doctor/inbox", who));
const itemFor = (b: Inbox, enc: string, kind = "report-inbox") => b.items.find((i) => i.encounter.id === enc && i.kind === kind);

describe.runIf(db)("A12 results inbox: critical first, acknowledge, tell the patient", () => {
  let critical: { enc: string; patient: string }, abnormal: { enc: string; patient: string }, normal: { enc: string; patient: string };
  beforeAll(async () => {
    critical = await newPatientVisit(); await sign(critical.enc, ["elec"]);
    await released(critical.enc, { elec: [["na", "138"], ["k", "6.9", "6.9"], ["cl", "101"]] });
    abnormal = await newPatientVisit(); await sign(abnormal.enc, ["rbs"]);
    await released(abnormal.enc, { rbs: [["rbs", "11.2"]] });
    normal = await newPatientVisit(); await sign(normal.enc, ["rbs"]);
    await released(normal.enc, { rbs: [["rbs", "5.4"]] });
  }, 120_000);

  it("each released report reaches the ordering doctor, graded by its worst result; unread critical before high before normal (newest first)", async () => {
    const b = await inbox();
    const [c, a, n] = [itemFor(b, critical.enc)!, itemFor(b, abnormal.enc)!, itemFor(b, normal.enc)!];
    expect([c.severity, a.severity, n.severity]).toEqual(["critical", "abnormal", "normal"]);
    const pos = (x: Item) => b.items.indexOf(x);
    expect(pos(c)).toBeLessThan(pos(a));
    expect(pos(a)).toBeLessThan(pos(n));
    expect(c.report!.results.find((r) => r.code === "k")!.flag).toBe("HH");
    expect(c).toMatchObject({ acknowledged: null, canNotify: true, patient: { hasMobile: true, ageYears: expect.any(Number) } });
    expect(b.counts.critical).toBeGreaterThanOrEqual(1);
    // the view is audited with the patients it revealed
    const audit = await db!.forTenant(T, (tx) => tx.auditEvent.findFirst({ where: { entity: "Communication", action: "view", userId: "u_e2e_doctor" }, orderBy: { at: "desc" } }));
    expect((audit!.detail as { patientIds: string[] }).patientIds).toEqual(expect.arrayContaining([critical.patient, abnormal.patient, normal.patient]));
  });

  it("'Seen' acknowledges once: the replay answers the same, a second acknowledgement is refused, the item moves below the unread ones", async () => {
    const id = itemFor(await inbox(), normal.enc)!.id;
    const key = randomUUID();
    const first = ok<{ item: Item }>(await post(`/v1/doctor/inbox/${id}/ack`, { notifyPatient: false }, "doctor", key));
    expect(first.item.acknowledged).toMatchObject({ notifyPatient: false, sms: null });
    expect(first.item.canNotify).toBe(false);
    const replay = ok<{ item: Item }>(await post(`/v1/doctor/inbox/${id}/ack`, { notifyPatient: false }, "doctor", key));
    expect(replay.item.acknowledged!.at).toBe(first.item.acknowledged!.at);
    expect((await post(`/v1/doctor/inbox/${id}/ack`, { notifyPatient: false })).json().code).toBe("already_acknowledged");
    const b = await inbox();
    const unreadPositions = b.items.filter((x) => !x.acknowledged).map((x) => b.items.indexOf(x));
    expect(b.items.findIndex((x) => x.id === id)).toBeGreaterThan(Math.max(...unreadPositions));
    const acks = await db!.forTenant(T, (tx) => tx.inboxAck.findMany({ where: { communicationId: id } }));
    expect(acks).toHaveLength(1);
  });

  it("'Seen + tell patient' sends the report-reviewed SMS after the commit — the facility's name only, no test, value or name", async () => {
    const id = itemFor(await inbox(), critical.enc)!.id;
    const r = ok<{ item: Item }>(await post(`/v1/doctor/inbox/${id}/ack`, { notifyPatient: true }));
    expect(r.item.acknowledged).toMatchObject({ notifyPatient: true, sms: { status: "completed" } });
    const sms = fakeMessenger()!.log().filter((m) => m.messageId === r.item.acknowledged!.sms!.id);
    expect(sms).toHaveLength(1);
    expect(sms[0]!.text).toContain("E2E Test Clinic");
    expect(sms[0]!.text).toContain("reviewed your lab report");
    expect(sms[0]!.text).not.toMatch(/potassium|6\.9|Electrolyte|Inbox Patient|critical/i);
    const audit = await db!.forTenant(T, (tx) => tx.auditEvent.findFirst({ where: { entity: "Communication", entityId: id, action: "acknowledge" } }));
    expect(audit!.detail).toMatchObject({ notifyPatient: true, kind: "report-inbox" });
  });

  it("only the doctor it was sent to: another doctor gets 404, the lab 403; another tenant's doctor sees none of it", async () => {
    const id = itemFor(await inbox(), abnormal.enc)!.id;
    expect((await post(`/v1/doctor/inbox/${id}/ack`, {}, "doctor2")).statusCode).toBe(404);
    expect((await post(`/v1/doctor/inbox/${id}/ack`, {}, "tech")).statusCode).toBe(403);
    expect((await get("/v1/doctor/inbox", "nurse")).statusCode).toBe(403);
    expect((await inbox("doctor2")).items.find((x) => x.id === id)).toBeUndefined();
    expect((await inbox("liteDoctor")).items.find((x) => x.id === id)).toBeUndefined();
    expect((await post(`/v1/doctor/inbox/${id}/ack`, {}, "liteDoctor")).statusCode).toBe(404);
    expect((await post(`/v1/doctor/inbox/${id}/ack`, {}, "doctor", null)).json().code).toBe("idempotency_key_required");
  });

  it("a correction: the notice cannot tell the patient; the superseded version is not acknowledged; the corrected version arrives as a new item", async () => {
    const v = await labView(abnormal.enc);
    const rbs = v.orders.find((o) => o.testCode === "rbs")!.results.find((r) => r.status === "final")!;
    ok(await post(`/v1/lab/observations/${rbs.id}/correct`, { value: "12.1", reason: "transcription error at entry" }, "tech"), 201);
    let b = await inbox();
    const notice = itemFor(b, abnormal.enc, "correction-notice")!;
    expect(notice.severity).toBe("notice");
    expect(notice.canNotify).toBe(false);
    expect((await post(`/v1/doctor/inbox/${notice.id}/ack`, { notifyPatient: true })).json().code).toBe("notify_not_for_kind");
    expect(itemFor(b, abnormal.enc)!.report!.results[0]!.underCorrection).toBe(true);
    // the corrected value goes through verify / validate / release again → v2; v1's item is superseded
    let lv = await labView(abnormal.enc);
    const pre = lv.orders.flatMap((o) => o.results.filter((r) => r.status === "preliminary").map((r) => r.id));
    ok(await post(`/v1/lab/visits/${abnormal.enc}/verify`, { pin: "1234", observationIds: pre, deltaChecked: true }, "tech"));
    lv = await labView(abnormal.enc);
    ok(await post(`/v1/lab/visits/${abnormal.enc}/validate`, { pin: "1234", observationIds: lv.orders.flatMap((o) => o.results.filter((r) => r.status === "verified").map((r) => r.id)) }, "path"));
    lv = await labView(abnormal.enc);
    ok(await post(`/v1/lab/visits/${abnormal.enc}/release`, { observationIds: lv.release.observationIds }, "path"), 201);
    b = await inbox();
    const reports = b.items.filter((x) => x.encounter.id === abnormal.enc && x.kind === "report-inbox");
    const v1 = reports.find((x) => x.report!.version === 1)!, v2 = reports.find((x) => x.report!.version === 2)!;
    expect(v1.report!.superseded).toBe(true);
    expect(v1.canNotify).toBe(false);
    expect((await post(`/v1/doctor/inbox/${v1.id}/ack`, {})).json().code).toBe("superseded");
    expect(v2.report!.superseded).toBe(false);
    ok(await post(`/v1/doctor/inbox/${v2.id}/ack`, {}));
  });

  it("'tell patient' needs the patient's mobile (a record without one: older data, an unknown ER patient later)", async () => {
    const p = await newPatientVisit();
    await db!.forTenant(T, (tx) => tx.patient.update({ where: { id: p.patient }, data: { phone: null } }));
    await sign(p.enc, ["rbs"]);
    await released(p.enc, { rbs: [["rbs", "6.0"]] });
    const item = itemFor(await inbox(), p.enc)!;
    expect(item).toMatchObject({ canNotify: false, patient: { hasMobile: false } });
    expect((await post(`/v1/doctor/inbox/${item.id}/ack`, { notifyPatient: true })).json().code).toBe("no_mobile");
    ok(await post(`/v1/doctor/inbox/${item.id}/ack`, { notifyPatient: false }));
  }, 60_000);
});

describe.runIf(db)("decision 47: a critical vital sign reaches the visit's doctor", () => {
  it("a nurse records SpO2 88 on a visit the doctor has opened → a critical-vital item for that doctor only", async () => {
    const p = await newPatientVisit();
    ok(await post(`/v1/encounters/${p.enc}/consultation/open`, {}));
    ok(await post(`/v1/encounters/${p.enc}/vitals`, { values: { spo2: 88 }, effectiveAt: now() }, "nurse"), 201);
    const item = itemFor(await inbox(), p.enc, "critical-vital")!;
    expect(item).toMatchObject({ severity: "critical", vital: { code: expect.any(String), value: 88, flag: "LL" }, canNotify: false, report: null });
    expect(itemFor(await inbox("doctor2"), p.enc, "critical-vital")).toBeUndefined();
    ok(await post(`/v1/doctor/inbox/${item.id}/ack`, {}));
  });
  it("no doctor on the visit yet → no inbox item (the queue card still shows the flag)", async () => {
    const p = await newPatientVisit();
    ok(await post(`/v1/encounters/${p.enc}/vitals`, { values: { spo2: 88 }, effectiveAt: now() }, "nurse"), 201);
    const n = await db!.forTenant(T, (tx) => tx.communication.count({ where: { encounterId: p.enc, kind: "critical-vital" } }));
    expect(n).toBe(0);
  });
});

describe.runIf(db)("ADR 0007 database guards", () => {
  it("an acknowledgement is never edited or deleted, and never made for an item sent to someone else", async () => {
    const p = await newPatientVisit();
    await sign(p.enc, ["rbs"]);
    await released(p.enc, { rbs: [["rbs", "5.9"]] });
    const item = itemFor(await inbox(), p.enc)!;
    ok(await post(`/v1/doctor/inbox/${item.id}/ack`, {}));
    await expect(db!.forTenant(T, (tx) => tx.inboxAck.updateMany({ where: { communicationId: item.id }, data: { notifyPatient: true } }), { userId: "u_e2e_doctor" })).rejects.toThrow();
    await expect(db!.forTenant(T, (tx) => tx.inboxAck.deleteMany({ where: { communicationId: item.id } }), { userId: "u_e2e_doctor" })).rejects.toThrow();
    const q = await newPatientVisit();
    await sign(q.enc, ["rbs"]);
    await released(q.enc, { rbs: [["rbs", "5.8"]] });
    const other = itemFor(await inbox(), q.enc)!;
    await expect(db!.forTenant(T, (tx) => tx.inboxAck.create({ data: { tenantId: T, communicationId: other.id, ackedById: "u_e2e_doctor2" } }), { userId: "u_e2e_doctor2" }))
      .rejects.toThrow(/only the doctor the item was sent to/);
  }, 90_000);
});
