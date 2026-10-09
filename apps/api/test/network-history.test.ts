/* Slice E4 contract tests (ADR 0023) on the real database (as setu_app): E2E Test Clinic holds a person's earlier
   visits; E2E Lite Hospital is the other clinic the person now visits.
   - by policy (no request): active allergies, current medicines, active problems, blood group from the OTHER linked
     facility — with facility, author and date; a visit with a sensitive condition (sample list) is dropped whole, never
     hinted; the owner facility audits the read and the patient sees it in "who viewed";
   - only a linked record (never a match by phone); doctors only; "network sharing" off → nothing by policy;
   - access request: kinds, period, reason ≥ 10 → the patient app and an SMS of the fixed template; one waiting at a
     time; the patient approves once → a share of those kinds to that doctor, sensitive never; deny; expiry after 7 days;
   - blood group recorded on the record (doctor, nurse, lab; not the desk). */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NetworkHistory, PatientAccessRequests, SharedList, SharedRecords } from "@setu/contracts";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { fakeMessenger } from "../src/adapters/messaging/index.js";
import { counters } from "../src/adapters/counters.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("network-history.test: DATABASE_URL_APP not set — E4 contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const IP = `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`;
const PHONE = `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, PH = PHONE.slice(1);
const USERS = { desk: "01799000001", doctor: "01799000002", nurse: "01799000004", liteDesk: "01798000001", liteDoctor: "01798000002", litePaed: "01798000003", liteOwner: "01798000009" } as const;
type Who = keyof typeof USERS;
const staff: Partial<Record<Who, string>> = {};
let cookie = "", clinicRec = "", liteRec = "", sensitiveNote = "", plainNote = "", sensitiveVisit = "";
const owner = () => new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

const sget = (url: string, who: Who) => app.inject({ method: "GET", url, headers: { cookie: staff[who]! } });
const spost = (url: string, payload: object, who: Who) => app.inject({ method: "POST", url, payload, headers: { cookie: staff[who]!, "idempotency-key": randomUUID() } });
const ok = <R,>(r: { statusCode: number; body: string; json: () => R }, code = 200) => { expect(r.statusCode, r.body).toBe(code); return r.json(); };
const pget = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
const ppost = (url: string, payload: object, key: string = randomUUID()) => app.inject({ method: "POST", url, payload, headers: { cookie, "idempotency-key": key } });
const history = async (who: Who = "liteDoctor") => ok<NetworkHistory>(await sget(`/v1/network/history/${liteRec}`, who));

/** a finished visit at the clinic with a signed note: these diagnoses and medicines — the visit and the note */
async function visit(patientId: string, diagnoses: string[], medications: { medicineKey: string; days: number }[], beforeSign?: (enc: string, note: string) => Promise<void>) {
  const enc = ok<{ encounter: { id: string } }>(await spost("/v1/encounters", { patientId }, "desk"), 201).encounter.id;
  const v = ok<{ draft: { id: string } }>(await spost(`/v1/encounters/${enc}/consultation/open`, {}, "doctor"));
  const saved = ok<{ rev: number }>(await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: staff.doctor!, "idempotency-key": randomUUID() }, payload: {
    rev: 1, sections: { complaints: [{ text: "Follow-up", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: diagnoses.map((code) => ({ code, verificationStatus: "provisional" })), medications: medications.map((m) => ({ ...m, dose: "1+0+1", meal: "after" })), orders: [] } }));
  if (beforeSign) await beforeSign(enc, v.draft.id);
  ok(await spost(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor"));
  return { enc, note: v.draft.id };
}
/** the person proves a record with its printed code */
async function claimAt(tenantId: string, patientId: string) {
  const o = owner();
  const code = (await o.patient.findUniqueOrThrow({ where: { id: patientId }, select: { claimCode: true } })).claimCode!;
  await o.$disconnect();
  const claims = ok<{ items: { id: string; facilityEn: string | null; status: string }[] }>(await pget("/v1/patient/claims"));
  for (const c of claims.items.filter((x) => x.status !== "linked")) {
    const r = await ppost(`/v1/patient/claims/${c.id}/proof`, { method: "code", code });
    if (r.statusCode === 200 && r.json<{ outcome: string }>().outcome === "linked") return;
  }
  throw new Error(`no claim at ${tenantId} took the code`);
}

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of Object.entries(USERS)) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; staff[k as Who] = Array.isArray(c) ? c[0]! : (c as string);
  }
  const reg = async (who: Who) => ok<{ patient: { id: string } }>(await spost("/v1/patients", { nameBn: "হালিমা বেগম", nameEn: `Halima Begum ${RUN}`, sex: "female", dobMode: "dob", dob: "03/05/1968", phone: PHONE, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: false }, who), 201).patient.id;
  clinicRec = await reg("desk");
  liteRec = await reg("liteDesk");
  // the clinic: diabetes on metformin for 30 days; hypertension; and a visit whose note carries a sensitive condition
  const a = await visit(clinicRec, ["5A11"], [{ medicineKey: "comet", days: 30 }]);
  plainNote = a.note;
  ok(await spost(`/v1/patients/${clinicRec}/allergies`, { encounterId: a.enc, kind: "class", key: "penicillin", reaction: "rash", severity: "moderate" }, "doctor"), 201);
  await visit(clinicRec, ["BA00"], [{ medicineKey: "seclo", days: 14 }]);
  // the sample catalogue has no sensitive code (gap 12): the condition is written into the draft as a facility whose
  // list has it would, then the note is signed
  const s = await visit(clinicRec, ["GC08"], [{ medicineKey: "ciprocin", days: 5 }], async (enc, note) => {
    const o = owner();
    const c0 = await o.condition.findFirstOrThrow({ where: { compositionId: note } });
    await o.condition.create({ data: { tenantId: c0.tenantId, patientId: clinicRec, encounterId: enc, compositionId: note, position: 9, code: "6A70", codeVerification: "unverified-prototype", labelBn: "বিষণ্ণতা", labelEn: "Single episode depressive disorder" } });
    await o.$disconnect();
  });
  sensitiveNote = s.note; sensitiveVisit = s.enc;
  ok(await spost(`/v1/patients/${clinicRec}/blood-group`, { bloodGroup: "O+" }, "nurse"));
  // the person signs in and links the clinic's record only (the Lite record waits)
  await app.inject({ method: "POST", url: "/v1/patient/otp", remoteAddress: IP, payload: { phone: PHONE, lang: "en" } });
  const code = fakeMessenger()!.log("network").filter((m) => m.to === PHONE).at(-1)!.text.match(/\d{6}/)![0];
  const si = await app.inject({ method: "POST", url: "/v1/patient/sign-in", payload: { phone: PHONE, code } });
  cookie = ([] as string[]).concat(si.headers["set-cookie"] as string | string[]).find((c) => c.startsWith("setu_patient="))!.split(";")[0]!;
  await claimAt("clinic", clinicRec);
}, 120_000);
afterAll(async () => {
  await counters().del(`potp:send:${PH}`, `potp:tries:${PH}`, `potp:code:${PH}`);
  await app.close();
});

describe.skipIf(!db)("E4 by policy — another clinic's view", () => {
  it("a record not linked to a Setu person shows nothing — never a match by the same phone", async () => {
    const h = await history();
    expect(h).toMatchObject({ linked: false, sharing: false, facilities: 0, allergies: [], medicines: [], problems: [], bloodGroups: [] });
  });

  it("linked: allergies, current medicines, active problems, blood group from the clinic — each with facility, author, date; the sensitive visit dropped whole", async () => {
    await claimAt("lite", liteRec);
    const h = await history();
    expect(h).toMatchObject({ linked: true, sharing: true, facilities: 1 });
    expect(h.problems.map((p) => p.code).sort()).toEqual(["5A11", "BA00"]);
    expect(h.medicines.map((m) => m.generic).sort()).toEqual(["Metformin HCl", "Omeprazole"]);
    expect(h.allergies.map((a) => a.labelEn)).toEqual([expect.stringMatching(/penicillin/i)]);
    expect(h.bloodGroups).toEqual([expect.objectContaining({ value: "O+", authorEn: "Test Nurse", source: "provider-verified" })]);
    for (const row of [...h.problems, ...h.medicines, ...h.allergies]) expect(row).toMatchObject({ facilityEn: expect.any(String), authorEn: "Dr. Test", source: "provider-verified" });
    // never hinted: no code, no medicine, no count of the sensitive visit anywhere in the answer
    expect(JSON.stringify(h)).not.toMatch(/6A70|GC08|Ciprofloxacin|depress/i);
  });

  it("the clinic's audit records the read with the reader; the patient sees it in who viewed", async () => {
    const o = owner();
    const ev = await o.auditEvent.findFirst({ where: { patientId: clinicRec, basis: "network-policy" }, orderBy: { at: "desc" } });
    await o.$disconnect();
    expect(ev?.detail).toMatchObject({ reader: { nameEn: "Dr. Lite Emergency", role: "doctor" }, counts: { problems: 2, medicines: 2, allergies: 1, bloodGroups: 1 } });
    const log = ok<{ items: { kind: string; nameEn: string | null }[] }>(await pget("/v1/patient/access-log"));
    expect(log.items.some((i) => i.kind === "shared" && i.nameEn === "Dr. Lite Emergency")).toBe(true);
  });

  it("doctors only: the desk has no such screen; the owner is refused", async () => {
    expect((await sget(`/v1/network/history/${liteRec}`, "liteDesk")).statusCode).toBe(403);
    const r = await sget(`/v1/network/history/${liteRec}`, "liteOwner");
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ code: "doctors_only" });
  });

  it("network sharing off: nothing by policy (the setting says so); on again: back", async () => {
    expect(ok<{ person: { networkSharing: boolean } }>(await ppost("/v1/patient/network-sharing", { on: false })).person.networkSharing).toBe(false);
    expect(await history()).toMatchObject({ linked: true, sharing: false, facilities: 0, allergies: [], medicines: [], problems: [], bloodGroups: [] });
    expect(ok<{ person: { networkSharing: boolean } }>(await ppost("/v1/patient/network-sharing", { on: true })).person.networkSharing).toBe(true);
    expect((await history()).problems).toHaveLength(2);
  });
});

describe.skipIf(!db)("E4 access requests", () => {
  let reqId = "";
  it("refuses a short reason or no kinds; makes one: the patient app and an SMS of the fixed template (nothing clinical)", async () => {
    expect((await spost("/v1/network/access-requests", { patientId: liteRec, kinds: ["visits"], period: "24h", reason: "short" }, "liteDoctor")).statusCode).toBe(400);
    expect((await spost("/v1/network/access-requests", { patientId: liteRec, kinds: [], period: "24h", reason: "Chest pain, earlier ECGs" }, "liteDoctor")).statusCode).toBe(400);
    const r = ok<{ id: string; state: string }>(await spost("/v1/network/access-requests", { patientId: liteRec, kinds: ["prescriptions", "visits"], period: "24h", reason: "Chest pain today; earlier treatment" }, "liteDoctor"), 201);
    expect(r.state).toBe("sent");
    reqId = r.id;
    const o = owner();
    const sms = await o.communication.findFirst({ where: { patientId: liteRec, kind: "access-request", channel: "sms" } });
    await o.$disconnect();
    expect(sms?.toPhone).toBe(PHONE);
    expect(sms?.text).toContain("E2E Lite");
    expect(sms?.text).not.toMatch(/Chest|Lite Emergency/);
    // one waiting at a time from this doctor
    expect((await spost("/v1/network/access-requests", { patientId: liteRec, kinds: ["visits"], period: "24h", reason: "Asking again, please" }, "liteDoctor")).statusCode).toBe(409);
    expect((await history()).requests[0]).toMatchObject({ id: reqId, state: "sent" });
  });

  it("the patient sees the doctor, the facility, the kinds and the reason; approves once — a share of those kinds to that doctor", async () => {
    const list = ok<PatientAccessRequests>(await pget("/v1/patient/access-requests"));
    expect(list.items[0]).toMatchObject({ id: reqId, doctorEn: "Dr. Lite Emergency", kinds: ["prescriptions", "visits"], period: "24h", reason: "Chest pain today; earlier treatment", state: "sent" });
    const key = randomUUID();
    const a = ok<{ state: string; consentId: string }>(await ppost(`/v1/patient/access-requests/${reqId}/answer`, { answer: "approve" }, key));
    expect(a.state).toBe("granted");
    // a retried tap answers the same; the other answer is refused
    expect(ok<{ consentId: string }>(await ppost(`/v1/patient/access-requests/${reqId}/answer`, { answer: "approve" }, key)).consentId).toBe(a.consentId);
    expect((await ppost(`/v1/patient/access-requests/${reqId}/answer`, { answer: "deny" })).statusCode).toBe(409);
    const shares = ok<{ items: { id: string; kinds: string[]; grantee: { doctorEn: string | null } }[] }>(await pget("/v1/patient/shares"));
    expect(shares.items.find((x) => x.id === a.consentId)).toMatchObject({ kinds: ["prescription", "visit", "admission"], grantee: { doctorEn: "Dr. Lite Emergency" } });
    expect((await history()).requests[0]).toMatchObject({ id: reqId, state: "granted", consentId: a.consentId });
  });

  it("the doctor reads only those kinds, never the sensitive visit; another doctor there reads nothing", async () => {
    const consentId = (await history()).requests[0]!.consentId!;
    const mine = ok<SharedList>(await sget("/v1/shared", "liteDoctor"));
    expect(mine.items.find((i) => i.consentId === consentId)?.kinds).toEqual(["prescription", "visit", "admission"]);
    const recs = ok<SharedRecords>(await sget(`/v1/shared/${consentId}`, "liteDoctor"));
    expect(new Set(recs.items.map((i) => i.kind))).toEqual(new Set(["prescription", "visit"]));
    expect(recs.items.some((i) => i.recordId === plainNote)).toBe(true);
    expect(recs.items.some((i) => i.recordId === sensitiveNote || i.recordId === sensitiveVisit || i.encounterId === sensitiveVisit)).toBe(false);
    const clinicTenant = recs.items.find((i) => i.recordId === plainNote)!.ownerTenantId;
    expect((await sget(`/v1/shared/${consentId}/documents/${clinicTenant}/rx/${plainNote}/pdf`, "liteDoctor")).statusCode).toBe(200);
    const hidden = await sget(`/v1/shared/${consentId}/documents/${clinicTenant}/rx/${sensitiveNote}/pdf`, "liteDoctor");
    expect(hidden.statusCode).toBe(403);
    expect(hidden.json()).toMatchObject({ reason: "out-of-scope" });
    expect((await sget(`/v1/shared/${consentId}`, "litePaed")).statusCode).toBe(403);
  });

  it("deny; a request unanswered for 7 days expires and cannot be approved", async () => {
    const d = ok<{ id: string }>(await spost("/v1/network/access-requests", { patientId: liteRec, kinds: ["reports"], period: "30d", reason: "Earlier HbA1c results please" }, "liteDoctor"), 201);
    expect(ok<{ state: string; consentId: string | null }>(await ppost(`/v1/patient/access-requests/${d.id}/answer`, { answer: "deny" }))).toMatchObject({ state: "denied", consentId: null });
    const o = owner();
    const old = await o.accessRequest.findUniqueOrThrow({ where: { id: d.id } });
    const stale = await o.accessRequest.create({ data: { ...old, id: `areq_${randomUUID().replace(/-/g, "")}`, state: "sent", answeredAt: null, consentId: null, createdAt: new Date(Date.now() - 8 * 864e5) } });
    // answered once: the database refuses a second answer however it is written
    await expect(o.accessRequest.update({ where: { id: d.id }, data: { state: "granted" } })).rejects.toThrow(/answered once/);
    await o.$disconnect();
    const r = await ppost(`/v1/patient/access-requests/${stale.id}/answer`, { answer: "approve" });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: "request_expired" });
    const list = ok<PatientAccessRequests>(await pget("/v1/patient/access-requests"));
    expect(list.items.find((x) => x.id === stale.id)?.state).toBe("expired");
  });
});

describe.skipIf(!db)("E4 blood group on the record", () => {
  it("a doctor, nurse or lab records it (who and when); the desk cannot; only the eight groups", async () => {
    expect(ok<{ bloodGroup: string }>(await spost(`/v1/patients/${liteRec}/blood-group`, { bloodGroup: "A-" }, "liteDoctor")).bloodGroup).toBe("A-");
    expect((await spost(`/v1/patients/${liteRec}/blood-group`, { bloodGroup: "A+" }, "liteDesk")).statusCode).toBe(403);
    expect((await spost(`/v1/patients/${liteRec}/blood-group`, { bloodGroup: "C+" }, "liteDoctor")).statusCode).toBe(400);
    expect((await history()).own).toMatchObject({ bloodGroup: "A-", bloodGroupAt: expect.any(String) });
  });
});
