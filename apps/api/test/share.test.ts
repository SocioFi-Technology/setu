/* Slice D4–D6 contract tests (ADR 0021) on the real database (as setu_app), E2E Test Clinic + E2E Lite Hospital:
   - D4: a released report in plain language — flags, the range bar, drafts marked draft, NOTHING but the contact-now
     line for a critical result (Kamrul 09/10/2026), the trend across visits; the patient's PDF copy (not a print copy);
   - D5: the directory; a share scoped to one report for one doctor at another facility, 30 days by default; the doctor
     reads exactly that through the consent-checked service, audited in both tenants and as an open the patient sees;
   - D6: who viewed (staff names, shared reads, break-glass labelled; the patient's own reads left out); revoke —
     idempotent, the next read refused; expiry by time and by the consents job. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { fakeMessenger } from "../src/adapters/messaging/index.js";
import { counters } from "../src/adapters/counters.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("share.test: DATABASE_URL_APP not set — D4–D6 contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const IP = `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`;
const PHONE = `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, PH = PHONE.slice(1);
const USERS = { desk: "01799000001", doctor: "01799000002", tech: "01799000005", path: "01799000006", liteDoctor: "01798000002", litePaed: "01798000003", liteDesk: "01798000001" } as const;
type Who = keyof typeof USERS;
const staff: Partial<Record<Who, string>> = {};
let cookie = "", claimId = "", rahima = "", repA = "", repB = "", sisterRep = "", rxId = "";
const owner = () => new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

const sget = (url: string, who: Who) => app.inject({ method: "GET", url, headers: { cookie: staff[who]! } });
const spost = (url: string, payload: object, who: Who) => app.inject({ method: "POST", url, payload, headers: { cookie: staff[who]!, "idempotency-key": randomUUID() } });
const ok = <R,>(r: { statusCode: number; body: string; json: () => R }, code = 200) => { expect(r.statusCode, r.body).toBe(code); return r.json(); };
const pget = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
const ppost = (url: string, payload: object, key: string = randomUUID()) => app.inject({ method: "POST", url, payload, headers: { cookie, "idempotency-key": key } });
type LV = { orders: { id: string; testCode: string; results: { id: string; status: string; flag: string | null }[] }[]; release: { observationIds: string[] }; reports: { id: string }[] };

/** a visit with a signed note ordering these tests, the results entered, verified, called back if critical, validated,
    released and sent to the app — the report's id */
async function released(patientId: string, values: Record<string, [string, string, string?][]>): Promise<{ rep: string; note: string }> {
  const enc = ok<{ encounter: { id: string } }>(await spost("/v1/encounters", { patientId }, "desk"), 201).encounter.id;
  const v = ok<{ draft: { id: string } }>(await spost(`/v1/encounters/${enc}/consultation/open`, {}, "doctor"));
  const saved = ok<{ rev: number }>(await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: staff.doctor!, "idempotency-key": randomUUID() }, payload: {
    rev: 1, sections: { complaints: [{ text: "Thirst", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }],
    orders: Object.keys(values).map((testCode) => ({ testCode, priority: "routine" })) } }));
  ok(await spost(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor"));
  const lab = ok<{ specimens: { id: string; status: string }[] }>(await spost(`/v1/lab/visits/${enc}/labels`, {}, "tech"));
  for (const sp of lab.specimens.filter((x) => x.status === "pending")) for (const step of ["collect", "receive", "start"]) ok(await spost(`/v1/lab/specimens/${sp.id}/${step}`, { at: new Date().toISOString() }, "tech"));
  let lv = ok<LV>(await sget(`/v1/lab/visits/${enc}`, "tech"));
  for (const o of lv.orders) ok(await spost(`/v1/lab/orders/${o.id}/results`, { entries: values[o.testCode]!.map(([analyteCode, value, confirm]) => ({ analyteCode, value, ...(confirm ? { confirm } : {}) })) }, "tech"), 201);
  lv = ok<LV>(await sget(`/v1/lab/visits/${enc}`, "tech"));
  lv = ok<LV>(await spost(`/v1/lab/visits/${enc}/verify`, { pin: "1234", observationIds: lv.orders.flatMap((o) => o.results.map((r) => r.id)), deltaChecked: true }, "tech"));
  for (const r of lv.orders.flatMap((o) => o.results).filter((r) => r.flag === "HH" || r.flag === "LL"))
    ok(await spost(`/v1/lab/observations/${r.id}/callbacks`, { outcome: "reached", recipientRole: "ordering-doctor", recipientName: "Dr. Test", via: "phone", calledAt: new Date().toISOString(), readBack: true }, "tech"), 201);
  lv = ok<LV>(await spost(`/v1/lab/visits/${enc}/validate`, { pin: "1234", observationIds: lv.orders.flatMap((o) => o.results.map((r) => r.id)) }, "path"));
  lv = ok<LV>(await spost(`/v1/lab/visits/${enc}/release`, { observationIds: lv.release.observationIds }, "path"), 201);
  const rep = lv.reports.at(-1)!.id;
  ok(await spost(`/v1/lab/reports/${rep}/send`, { channel: "patient-app" }, "tech"));
  return { rep, note: v.draft.id };
}

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of Object.entries(USERS)) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; staff[k as Who] = Array.isArray(c) ? c[0]! : (c as string);
  }
  const reg = async (nameEn: string, nameBn: string) => ok<{ patient: { id: string } }>(await spost("/v1/patients", { nameBn, nameEn: `${nameEn} ${RUN}`, sex: "female", dobMode: "dob", dob: "12/02/1979", phone: PHONE, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: false }, "desk"), 201).patient.id;
  rahima = await reg("Nasrin Akter", "নাসরিন আক্তার");
  const sister = await reg("Sumaiya Akter", "সুমাইয়া আক্তার");
  // two HbA1c results for the trend; the second visit also has the critical potassium of the walkthrough
  repA = (await released(rahima, { hba1c: [["hba1c", "6.8"]] })).rep;
  const b = await released(rahima, { hba1c: [["hba1c", "7.4"]], elec: [["na", "138"], ["k", "6.9", "6.9"], ["cl", "101"]] });
  repB = b.rep; rxId = b.note;
  sisterRep = (await released(sister, { hba1c: [["hba1c", "5.2"]] })).rep;
  // the person signs in and proves Rahima's record with her code
  await app.inject({ method: "POST", url: "/v1/patient/otp", remoteAddress: IP, payload: { phone: PHONE, lang: "en" } });
  const code = fakeMessenger()!.log("network").filter((m) => m.to === PHONE).at(-1)!.text.match(/\d{6}/)![0];
  const si = await app.inject({ method: "POST", url: "/v1/patient/sign-in", payload: { phone: PHONE, code } });
  cookie = ([] as string[]).concat(si.headers["set-cookie"] as string | string[]).find((c) => c.startsWith("setu_patient="))!.split(";")[0]!;
  const claims = ok<{ items: { id: string }[] }>(await pget("/v1/patient/claims"));
  claimId = claims.items[0]!.id;
  const o = owner();
  const claimCode = (await o.patient.findUniqueOrThrow({ where: { id: rahima }, select: { claimCode: true } })).claimCode!;
  await o.$disconnect();
  expect(ok<{ outcome: string }>(await ppost(`/v1/patient/claims/${claimId}/proof`, { method: "code", code: claimCode })).outcome).toBe("linked");
}, 120_000);
afterAll(async () => {
  await counters().del(`potp:send:${PH}`, `potp:tries:${PH}`, `potp:code:${PH}`);
  await app.close();
});

type Report = { report: { number: string; facilityPhone: string | null; currentId: string }; tests: { nameEn: string; results: { code: string; value: number; flag: string | null; position: number | null; plain: { kind: string; draft?: boolean; direction?: string | null }; trend: { value: number; current: boolean }[] }[] }[] };
const result = (r: Report, code: string) => r.tests.flatMap((t) => t.results).find((x) => x.code === code)!;

describe.runIf(db)("D4 a report in plain language", () => {
  it("the history marks the app notice unread; opening the report reads it", async () => {
    const tl = ok<{ items: { recordId: string; unread: boolean; encounterId: string | null }[] }>(await pget("/v1/patient/timeline?filter=reports"));
    expect(tl.items.find((i) => i.recordId === repB)).toMatchObject({ unread: true });
    ok(await pget(`/v1/patient/reports/${claimId}/${repB}`));
    const again = ok<{ items: { recordId: string; unread: boolean }[] }>(await pget("/v1/patient/timeline?filter=reports"));
    expect(again.items.find((i) => i.recordId === repB)!.unread).toBe(false);
    expect(again.items.find((i) => i.recordId === repA)!.unread).toBe(true);
  });
  it("high HbA1c: flag, bar past the range, a draft explanation; the trend 6.8 → 7.4 from both visits", async () => {
    const r = ok<Report>(await pget(`/v1/patient/reports/${claimId}/${repB}`));
    const h = result(r, "hba1c");
    expect(h).toMatchObject({ value: 7.4, flag: "H", plain: { kind: "explained", draft: true, direction: "hba1c_high" } });
    expect(h.position).toBeGreaterThan(2 / 3);
    expect(h.trend.map((p) => [p.value, p.current])).toEqual([[6.8, false], [7.4, true]]);
  });
  it("critical potassium: no explanation at all — the facility's phone for the contact-now line", async () => {
    const r = ok<Report>(await pget(`/v1/patient/reports/${claimId}/${repB}`));
    expect(result(r, "k")).toMatchObject({ value: 6.9, flag: "HH", plain: { kind: "critical" } });
    expect(r.report.facilityPhone).toBe("01700-000103");
    expect(result(r, "na")).toMatchObject({ flag: "N", plain: { kind: "explained", direction: "in_range" } });
  });
  it("the database lets a notice be marked read once, alone — never with another change, never an SMS", async () => {
    const o = owner();
    try {
      const app1 = await o.communication.findFirstOrThrow({ where: { reportId: repA, channel: "patient_app" } });
      await expect(o.communication.update({ where: { id: app1.id }, data: { readAt: new Date(), attempts: app1.attempts + 1 } })).rejects.toThrow(/marked read, once/);
      const read = await o.communication.findFirstOrThrow({ where: { reportId: repB, channel: "patient_app" } });
      await expect(o.communication.update({ where: { id: read.id }, data: { readAt: new Date() } })).rejects.toThrow(/marked read, once/);
      const sms = await o.communication.findFirst({ where: { patientId: rahima, channel: "sms" } });
      if (sms) await expect(o.communication.update({ where: { id: sms.id }, data: { readAt: new Date() } })).rejects.toThrow(/marked read, once/);
    } finally { await o.$disconnect(); }
  });
  it("the sister's report through Rahima's claim: not found (never a hint)", async () => {
    expect((await pget(`/v1/patient/reports/${claimId}/${sisterRep}`)).statusCode).toBe(404);
    expect((await pget(`/v1/patient/documents/${claimId}/lr/${sisterRep}/pdf`)).statusCode).toBe(404);
  });
  it("the PDF is the patient's copy: a real verify code, no facility print copy; audited as a patient print", async () => {
    const r = await pget(`/v1/patient/documents/${claimId}/lr/${repB}/pdf`);
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
    const rx = await pget(`/v1/patient/documents/${claimId}/rx/${rxId}/pdf?lang=en`);
    expect(rx.statusCode, rx.body.slice(0, 200)).toBe(200);
    const facts = await db!.forTenant("t_e2e", async (tx) => ({
      code: await tx.documentCode.findFirst({ where: { kind: "lr", documentId: repB }, include: { prints: true } }),
      audit: await tx.auditEvent.findMany({ where: { entityId: repB, action: "print", basis: "patient" } }),
    }));
    expect(facts.code?.verifyCode).toMatch(/.{16,}/);
    expect(facts.code?.prints).toHaveLength(0);
    expect(facts.audit).toHaveLength(1);
  });
});

describe.runIf(db)("D5–D6 share one report with a doctor at another facility; revoke; who viewed", () => {
  let shareId = "";
  it("the directory lists network facilities and their doctors, names only", async () => {
    const d = ok<{ facilities: { organizationId: string; doctors: { userId: string; nameEn: string }[] }[] }>(await pget("/v1/patient/directory"));
    const lite = d.facilities.find((f) => f.organizationId === "o_e2e_lite")!;
    expect(lite.doctors.map((x) => x.userId)).toContain("u_e2l_doctor");
    expect(Object.keys(lite.doctors[0]!).sort()).toEqual(["nameBn", "nameEn", "userId"]);
    expect(d.facilities.some((f) => f.organizationId === "o_greenlife_uttara")).toBe(false);
  });
  it("refused: a record not hers, a facility outside the network, an unknown period", async () => {
    expect((await ppost("/v1/patient/shares", { scope: { kind: "report", claimId, reportId: sisterRep }, grantee: { organizationId: "o_e2e_lite", userId: "u_e2l_doctor" } })).statusCode).toBe(404);
    expect(ok<{ code: string }>(await ppost("/v1/patient/shares", { scope: { kind: "all" }, grantee: { organizationId: "o_greenlife_uttara", userId: null } }), 400).code).toBe("grantee");
    expect((await ppost("/v1/patient/shares", { period: "1y", scope: { kind: "all" }, grantee: { organizationId: "o_e2e_lite", userId: null } })).statusCode).toBe(400);
  });
  it("report B to Dr. Lite Emergency: 30 days by default; the clinic's audit hears of it", async () => {
    const s = ok<{ id: string; status: string; period: string; startsAt: string; endsAt: string; scope: { kind: string; number: string | null }; grantee: { doctorEn: string | null } }>(
      await ppost("/v1/patient/shares", { scope: { kind: "report", claimId, reportId: repB }, grantee: { organizationId: "o_e2e_lite", userId: "u_e2l_doctor" } }), 201);
    shareId = s.id;
    expect(s).toMatchObject({ status: "active", period: "30d", scope: { kind: "report" }, grantee: { doctorEn: "Dr. Lite Emergency" } });
    expect(Date.parse(s.endsAt) - Date.parse(s.startsAt)).toBe(30 * 24 * 3600_000);
    const told = await db!.forTenant("t_e2e", (tx) => tx.auditEvent.findMany({ where: { entity: "Consent", entityId: shareId, action: "share" } }));
    expect(told).toHaveLength(1);
  });
  it("the doctor reads exactly that report — the trend shows nothing outside the share; other records refused", async () => {
    const list = ok<{ items: { consentId: string; patient: { nameEn: string } }[] }>(await sget("/v1/shared", "liteDoctor"));
    expect(list.items.find((i) => i.consentId === shareId)?.patient.nameEn).toBe(`Nasrin Akter ${RUN}`);
    const recs = ok<{ items: { recordId: string; ownerTenantId: string }[] }>(await sget(`/v1/shared/${shareId}`, "liteDoctor"));
    expect(recs.items.map((i) => i.recordId)).toEqual([repB]);
    const r = ok<Report>(await sget(`/v1/shared/${shareId}/reports/t_e2e/${repB}`, "liteDoctor"));
    expect(result(r, "hba1c").trend.map((p) => p.value)).toEqual([7.4]);
    const out = await sget(`/v1/shared/${shareId}/reports/t_e2e/${repA}`, "liteDoctor");
    expect(out.statusCode).toBe(403);
    expect(out.json()).toMatchObject({ reason: "out-of-scope", canRequest: false });
    expect((await sget(`/v1/shared/${shareId}/documents/t_e2e/rx/${rxId}/pdf`, "liteDoctor")).statusCode).toBe(403);
    const pdf = await sget(`/v1/shared/${shareId}/documents/t_e2e/lr/${repB}/pdf`, "liteDoctor");
    expect(pdf.statusCode).toBe(200);
  });
  it("nobody else: another doctor there, the receptionist there, a doctor at the patient's own clinic", async () => {
    expect(ok<{ reason: string }>(await sget(`/v1/shared/${shareId}`, "litePaed"), 403).reason).toBe("not-grantee");
    expect((await sget(`/v1/shared/${shareId}`, "liteDesk")).statusCode).toBe(403);
    expect((await sget(`/v1/shared/${shareId}`, "doctor")).statusCode).toBe(404);
  });
  it("audited in both tenants; the patient sees who opened it and when", async () => {
    const ownerRows = await db!.forTenant("t_e2e", (tx) => tx.auditEvent.findMany({ where: { basis: "patient-share", patientId: rahima } }));
    expect(ownerRows.some((a) => a.entity === "DiagnosticReport" && a.entityId === repB && (a.detail as { reader?: { nameEn: string } }).reader?.nameEn === "Dr. Lite Emergency")).toBe(true);
    const granteeRows = await db!.forTenant("t_e2e_lite", (tx) => tx.auditEvent.findMany({ where: { basis: "patient-share", entityId: repB } }));
    expect(granteeRows.length).toBeGreaterThan(0);
    const shares = ok<{ items: { id: string; opens: { nameEn: string; facilityEn: string; itemKind: string }[] }[] }>(await pget("/v1/patient/shares"));
    const opens = shares.items.find((x) => x.id === shareId)!.opens;
    expect(opens.map((o) => o.itemKind)).toEqual(expect.arrayContaining(["records", "report"]));
    expect(opens.every((o) => o.nameEn === "Dr. Lite Emergency" && o.facilityEn === "E2E Lite Hospital")).toBe(true);
  });
  it("who viewed: staff by name and role, the shared reads, break-glass labelled; the patient's own reads left out", async () => {
    const o = owner();
    await o.auditEvent.create({ data: { tenantId: "t_e2e", action: "break-glass", entity: "Patient", entityId: rahima, patientId: rahima, basis: "emergency", userId: "u_e2e_doctor", role: "doctor", detail: { reason: "unconscious in ER, no relative reachable" } } });
    await o.$disconnect();
    const log = ok<{ items: { kind: string; nameEn: string | null; role: string | null; facilityEn: string | null; reason: string | null }[] }>(await pget("/v1/patient/access-log"));
    expect(log.items.some((x) => x.kind === "shared" && x.nameEn === "Dr. Lite Emergency" && x.facilityEn === "E2E Lite Hospital")).toBe(true);
    expect(log.items.some((x) => x.kind === "view" && x.nameEn !== null && x.role !== null && x.facilityEn === "E2E Test Clinic")).toBe(true);
    expect(log.items.find((x) => x.kind === "break-glass")).toMatchObject({ reason: "unconscious in ER, no relative reachable" });
    expect(log.items.every((x) => x.nameEn !== null || x.kind === "break-glass")).toBe(true);
  });
  it("revoke: two taps' worth — the retried tap answers the same; the doctor's next read is refused", async () => {
    const key = randomUUID();
    const a = ok<{ status: string; revokedAt: string }>(await ppost(`/v1/patient/shares/${shareId}/revoke`, {}, key));
    expect(a.status).toBe("revoked");
    const replay = await ppost(`/v1/patient/shares/${shareId}/revoke`, {}, key);
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(ok<{ status: string }>(await ppost(`/v1/patient/shares/${shareId}/revoke`, {})).status).toBe("revoked");
    expect(ok<{ reason: string }>(await sget(`/v1/shared/${shareId}/reports/t_e2e/${repB}`, "liteDoctor"), 403).reason).toBe("revoked");
    expect(ok<{ items: { consentId: string }[] }>(await sget("/v1/shared", "liteDoctor")).items.some((i) => i.consentId === shareId)).toBe(false);
  });
  it("\"all\" for 24 h to the facility: any doctor there reads both reports, the full trend; past its end it reads nothing, and the job marks it expired", async () => {
    const s = ok<{ id: string; period: string }>(await ppost("/v1/patient/shares", { period: "24h", scope: { kind: "all" }, grantee: { organizationId: "o_e2e_lite", userId: null } }), 201);
    const recs = ok<{ items: { recordId: string }[] }>(await sget(`/v1/shared/${s.id}`, "litePaed"));
    expect(recs.items.map((i) => i.recordId)).toEqual(expect.arrayContaining([repA, repB, rxId]));
    expect(recs.items.map((i) => i.recordId)).not.toContain(sisterRep);
    const r = ok<Report>(await sget(`/v1/shared/${s.id}/reports/t_e2e/${repB}`, "litePaed"));
    expect(result(r, "hba1c").trend.map((p) => p.value)).toEqual([6.8, 7.4]);
    const o = owner();
    await o.consent.update({ where: { id: s.id }, data: { endsAt: new Date(Date.now() - 1000), startsAt: new Date(Date.now() - 2000) } });
    await o.$disconnect();
    expect(ok<{ reason: string }>(await sget(`/v1/shared/${s.id}`, "litePaed"), 403).reason).toBe("expired");
    expect(await db!.consentExpireDue()).toBeGreaterThanOrEqual(1);
    const mine = ok<{ items: { id: string; status: string }[] }>(await pget("/v1/patient/shares"));
    expect(mine.items.find((x) => x.id === s.id)!.status).toBe("expired");
    expect(ok<{ code: string }>(await ppost(`/v1/patient/shares/${s.id}/revoke`, {}), 409).code).toBe("share_ended");
  });
});
