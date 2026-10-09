/* ADR 0020 — the patient app (slice D1–D3) on the real database: sign-in with an SMS code; a person sees nothing until
   a claim is proven with the code on the facility's paper; 3 wrong codes lock a claim for 24 h (issue #3); the
   timeline reads only the linked record of each linked facility, audited there. Every run uses a phone of its own
   (registered in the E2E clinic and the Lite hospital), so no earlier run's person or claims interfere. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { counters } from "../src/adapters/counters.js";
import { fakeMessenger } from "../src/adapters/messaging/index.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
// a fresh client address per run: the per-IP send limit lives in Redis for an hour
const IP = `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`;
const PHONE = `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, PH = PHONE.slice(1);
const staff: Record<string, string> = {};
let rahima = "", sister = "", lite = "", noteId = "";
const owner = () => new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of [["desk", "01799000001"], ["doctor", "01799000002"], ["liteDesk", "01798000001"]] as const) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; staff[k] = Array.isArray(c) ? c[0]! : (c as string);
  }
  const reg = async (who: string, nameEn: string, nameBn: string, visit: boolean) => {
    const r = await app.inject({ method: "POST", url: "/v1/patients", headers: { cookie: staff[who]!, "idempotency-key": randomUUID() },
      payload: { nameBn, nameEn: `${nameEn} ${RUN}`, sex: "female", dobMode: "dob", dob: "12/02/1979", phone: PHONE, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: visit } });
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as { patient: { id: string }; encounter?: { id: string } };
  };
  // two people on one phone in the E2E clinic (the shared phone the claim must tell apart), one in the Lite hospital
  const a = await reg("desk", "Rahima Khatun", "রহিমা খাতুন", true); rahima = a.patient.id;
  sister = (await reg("desk", "Sumaiya Akter", "সুমাইয়া আক্তার", true)).patient.id;
  lite = (await reg("liteDesk", "Rahima Khatun", "রহিমা খাতুন", false)).patient.id;
  // Rahima's visit: the doctor signs a prescription (the timeline shows signed documents only)
  const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload, headers: { cookie: staff.doctor!, "idempotency-key": randomUUID() } });
  const v = (await post(`/v1/encounters/${a.encounter!.id}/consultation/open`, {})).json();
  const saved = await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: staff.doctor!, "idempotency-key": randomUUID() },
    payload: { rev: 1, sections: { complaints: [{ text: "Fever", duration: { n: 3, unit: "d" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" }, sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }], orders: [] } });
  expect(saved.statusCode, saved.body).toBe(200);
  expect((await post(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.json().rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false })).statusCode).toBe(200);
  noteId = v.draft.id;
});
afterAll(async () => {
  await counters().del(`potp:send:${PH}`, `potp:tries:${PH}`, `potp:code:${PH}`);
  await app.close();
});

const lastCode = () => fakeMessenger()!.log("network").filter((m) => m.to === PHONE && m.messageId.startsWith("potp_")).at(-1)!.text.match(/\d{6}/)![0];
let cookie = "";
const as = (method: "GET" | "POST", url: string, payload?: object, key: string | null = randomUUID()) =>
  app.inject({ method, url, ...(payload ? { payload } : {}), headers: { cookie, ...(method === "POST" && key ? { "idempotency-key": key } : {}) } });
const codeOf = async (patientId: string) => {
  const o = owner();
  try { return (await o.patient.findUniqueOrThrow({ where: { id: patientId }, select: { claimCode: true } })).claimCode!; } finally { await o.$disconnect(); }
};
const wrongFor = (right: string) => (right.startsWith("2") ? "3" : "2") + right.slice(1);

describe.runIf(db)("D1 sign-in with an SMS code", () => {
  it("a code is sent with a fixed template; a wrong code counts down; the right one signs in and sets the patient cookie only", async () => {
    const s = await app.inject({ method: "POST", url: "/v1/patient/otp", remoteAddress: IP, payload: { phone: PHONE, lang: "en" } });
    expect(s.json()).toEqual({ sent: true, expiresInSeconds: 300 });
    const sms = fakeMessenger()!.log("network").filter((m) => m.to === PHONE).at(-1)!;
    expect(sms.text).toMatch(/^Setu: your code is \d{6}\. It works for 5 minutes\. Never share it\.$/);
    const wrong = await app.inject({ method: "POST", url: "/v1/patient/sign-in", payload: { phone: PHONE, code: String((Number(lastCode()) % 899_999) + 100_000 + 1) } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: "otp_wrong", triesLeft: 4 });
    const ok = await app.inject({ method: "POST", url: "/v1/patient/sign-in", payload: { phone: PHONE, code: lastCode() } });
    expect(ok.statusCode, ok.body).toBe(200);
    const set = ([] as string[]).concat(ok.headers["set-cookie"] as string | string[]);
    expect(set.some((c) => c.startsWith("setu_patient="))).toBe(true);
    expect(set.some((c) => c.startsWith("setu_session="))).toBe(false);
    cookie = set.find((c) => c.startsWith("setu_patient="))!.split(";")[0]!;
    expect(ok.json()).toMatchObject({ person: { phoneMasked: expect.stringMatching(/^019\*{5}\d{3}$/), lang: "bn" }, counts: { linked: 0, toClaim: 2 } });
    // the code works once
    expect((await app.inject({ method: "POST", url: "/v1/patient/sign-in", payload: { phone: PHONE, code: lastCode() } })).json().code).toBe("otp_expired");
  });
  it("a staff session opens no patient route, and a patient session no staff route", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/patient/me", headers: { cookie: staff.desk! } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/queue", headers: { cookie } })).statusCode).toBe(401);
  });
  it("the same answer for an unknown number; 3 sends per phone per 15 minutes", async () => {
    const other = `018${String(randomInt(0, 1e8)).padStart(8, "0")}`;
    try {
      expect((await app.inject({ method: "POST", url: "/v1/patient/otp", remoteAddress: IP, payload: { phone: other } })).json()).toEqual({ sent: true, expiresInSeconds: 300 });
      expect((await app.inject({ method: "POST", url: "/v1/patient/otp", remoteAddress: IP, payload: { phone: other } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/v1/patient/otp", remoteAddress: IP, payload: { phone: other } })).statusCode).toBe(200);
      const fourth = await app.inject({ method: "POST", url: "/v1/patient/otp", remoteAddress: IP, payload: { phone: other } });
      expect([fourth.statusCode, fourth.json().code]).toEqual([429, "otp_rate"]);
    } finally { await counters().del(`potp:send:${other.slice(1)}`, `potp:code:${other.slice(1)}`, `potp:tries:${other.slice(1)}`); }
  });
});

describe.runIf(db)("D2 claim with the code on the paper", () => {
  it("one candidate per facility with records on the phone: the facility and the month only — no name, no count", async () => {
    const r = await as("GET", "/v1/patient/claims");
    expect(r.statusCode, r.body).toBe(200);
    const items = r.json().items as { facilityEn: string; status: string; lastMonth: string; triesLeft: number }[];
    expect(items.map((i) => i.facilityEn).sort()).toEqual(["E2E Lite Hospital", "E2E Test Clinic"]);
    expect(items.every((i) => i.status === "candidate" && /^\d{4}-\d{2}$/.test(i.lastMonth) && i.triesLeft === 3)).toBe(true);
    expect(r.body).not.toContain("Rahima"); expect(r.body).not.toContain("Sumaiya"); expect(r.body).not.toContain(RUN);
    // nothing to read yet
    expect((await as("GET", "/v1/patient/timeline")).json()).toMatchObject({ items: [], facilities: 0 });
  });
  it("issue #3: wrong codes count down 2 → 1, the third locks for 24 h — even the right code is refused while locked; a replay never counts twice", async () => {
    const claims = (await as("GET", "/v1/patient/claims")).json().items as { id: string; facilityEn: string }[];
    const lc = claims.find((c) => c.facilityEn === "E2E Lite Hospital")!;
    const wrong = wrongFor(await codeOf(lite));
    const key = randomUUID();
    const a = await as("POST", `/v1/patient/claims/${lc.id}/proof`, { method: "code", code: wrong }, key);
    expect(a.json()).toMatchObject({ outcome: "wrong-code", claim: { status: "proof-pending", triesLeft: 2 } });
    const replay = await as("POST", `/v1/patient/claims/${lc.id}/proof`, { method: "code", code: wrong }, key);
    expect([replay.headers["idempotent-replay"], replay.json().claim.triesLeft]).toEqual(["true", 2]);
    expect((await as("POST", `/v1/patient/claims/${lc.id}/proof`, { method: "code", code: wrong })).json().claim.triesLeft).toBe(1);
    const third = (await as("POST", `/v1/patient/claims/${lc.id}/proof`, { method: "code", code: wrong })).json();
    expect(third).toMatchObject({ outcome: "locked", claim: { status: "locked", triesLeft: 0 } });
    expect(new Date(third.claim.lockedUntil).getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    expect((await as("POST", `/v1/patient/claims/${lc.id}/proof`, { method: "code", code: await codeOf(lite) })).json()).toMatchObject({ outcome: "locked" });
    // a code that cannot be a code is a typo, not a try
    expect((await as("POST", `/v1/patient/claims/${lc.id}/proof`, { method: "code", code: "12" })).json().code).toBe("code_format");
    // 24 hours later the lock lifts: the right code links
    const o = owner(); await o.patientClaim.update({ where: { id: lc.id }, data: { lockedUntil: new Date(Date.now() - 60_000) } }); await o.$disconnect();
    expect((await as("POST", `/v1/patient/claims/${lc.id}/proof`, { method: "code", code: (await codeOf(lite)).toLowerCase() })).json()).toMatchObject({ outcome: "linked", claim: { status: "linked" } });
  });
  it("the right code links the record it belongs to — not the family member on the same phone; provenance and audit in the facility", async () => {
    const claims = (await as("GET", "/v1/patient/claims")).json().items as { id: string; facilityEn: string }[];
    const ec = claims.find((c) => c.facilityEn === "E2E Test Clinic")!;
    const code = await codeOf(rahima);
    const r = await as("POST", `/v1/patient/claims/${ec.id}/proof`, { method: "qr", code: `https://setu.example/c/${code}` });
    expect(r.json(), r.body).toMatchObject({ outcome: "linked" });
    const o = owner();
    try {
      const c = await o.patientClaim.findUniqueOrThrow({ where: { id: ec.id } });
      expect([c.patientId, c.method]).toEqual([rahima, "qr"]);
      expect(await o.provenance.count({ where: { targetType: "Patient", targetId: rahima, activity: "patient-app-claim" } })).toBe(1);
      const audits = await o.auditEvent.findMany({ where: { tenantId: "t_e2e", entity: "PatientClaim", entityId: ec.id } });
      expect(audits.map((x) => [x.action, x.basis, (x.detail as { actor: string }).actor.startsWith("person:")])).toEqual([["claim", "patient", true]]);
      expect(await o.patientClaim.count({ where: { patientId: sister } })).toBe(0);
    } finally { await o.$disconnect(); }
    // a closed claim takes no more attempts
    expect((await as("POST", `/v1/patient/claims/${ec.id}/proof`, { method: "code", code })).json().code).toBe("claim_closed");
  });
});

describe.runIf(db)("D3 the timeline", () => {
  it("only the linked record of each linked facility: Rahima's signed prescription and visit, never the sister's; a draft never; audited in the facility", async () => {
    const t = (await as("GET", "/v1/patient/timeline")).json();
    expect(t.facilities).toBe(2);
    const keys = (t.items as { key: string; kind: string; source: string; facilityEn: string; doctorEn: string | null }[]);
    expect(keys.find((i) => i.key === `prescription:${noteId}`)).toMatchObject({ kind: "prescription", source: "provider-verified", facilityEn: "E2E Test Clinic", doctorEn: "Dr. Test" });
    expect(keys.some((i) => i.kind === "visit")).toBe(true);
    const o = owner();
    try {
      const sisterIds = (await o.encounter.findMany({ where: { patientId: sister }, select: { id: true } })).map((e) => e.id);
      expect(keys.some((i) => sisterIds.some((id) => i.key.endsWith(id)))).toBe(false);
      expect(await o.auditEvent.count({ where: { tenantId: "t_e2e", patientId: rahima, action: "view", basis: "patient" } })).toBeGreaterThan(0);
    } finally { await o.$disconnect(); }
    // the filters
    expect(((await as("GET", "/v1/patient/timeline?filter=prescriptions")).json().items as { kind: string }[]).every((i) => i.kind === "prescription")).toBe(true);
    expect((await as("GET", "/v1/patient/timeline?filter=mine")).json().items).toEqual([]);
    expect((await as("GET", "/v1/patient/timeline?filter=nope")).statusCode).toBe(400);
  });
  it("not mine and the desk: one person asks the desk (proof pending, desk), another says not mine (closed, the clinic's audit says so)", async () => {
    expect((await as("GET", "/v1/patient/me")).json().counts).toEqual({ linked: 2, toClaim: 0 });
    expect((await as("POST", "/v1/patient/sign-out")).statusCode).toBe(200);
    // a phone of its own with one record in the E2E clinic
    const p2 = `017${String(randomInt(0, 1e8)).padStart(8, "0")}`;
    const r = await app.inject({ method: "POST", url: "/v1/patients", headers: { cookie: staff.desk!, "idempotency-key": randomUUID() },
      payload: { nameBn: "করিম উদ্দিন", nameEn: `Karim Uddin ${RUN}`, sex: "male", dobMode: "dob", dob: "02/09/1975", phone: p2, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: false } });
    expect(r.statusCode, r.body).toBe(201);
    const signIn = async () => {
      await app.inject({ method: "POST", url: "/v1/patient/otp", remoteAddress: IP, payload: { phone: p2 } });
      const code = fakeMessenger()!.log("network").filter((m) => m.to === p2 && m.messageId.startsWith("potp_")).at(-1)!.text.match(/\d{6}/)![0];
      const ok = await app.inject({ method: "POST", url: "/v1/patient/sign-in", payload: { phone: p2, code } });
      cookie = ([] as string[]).concat(ok.headers["set-cookie"] as string | string[]).find((c) => c.startsWith("setu_patient="))!.split(";")[0]!;
    };
    try {
      await signIn();
      const [c] = (await as("GET", "/v1/patient/claims")).json().items as { id: string }[];
      expect((await as("POST", `/v1/patient/claims/${c!.id}/proof`, { method: "desk" })).json()).toMatchObject({ outcome: "desk-pending", claim: { status: "proof-pending", method: "desk" } });
      const nm = await as("POST", `/v1/patient/claims/${c!.id}/not-mine`);
      expect(nm.json(), nm.body).toMatchObject({ status: "not-mine" });
      expect((await as("POST", `/v1/patient/claims/${c!.id}/proof`, { method: "code", code: "7K4Q2M" })).json().code).toBe("claim_closed");
      const o = owner();
      try {
        const audits = await o.auditEvent.findMany({ where: { tenantId: "t_e2e", entity: "PatientClaim", entityId: c!.id }, orderBy: { at: "asc" } });
        expect(audits.map((x) => (x.detail as { outcome: string }).outcome)).toEqual(["desk-pending", "not-mine"]);
      } finally { await o.$disconnect(); }
      expect((await as("GET", "/v1/patient/timeline")).json()).toMatchObject({ items: [], facilities: 0 });
    } finally { await counters().del(`potp:send:${p2.slice(1)}`, `potp:code:${p2.slice(1)}`, `potp:tries:${p2.slice(1)}`); }
  });
});
