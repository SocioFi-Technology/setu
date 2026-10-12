/* ADR 0024 contract tests on the real database (as setu_app): E2E Test Clinic (a mother and a daughter on one phone)
   and E2E Lite Hospital (the mother's record there).
   - the desk: the app gets a desk code (only its hash is stored); the reception finds the claim by it — this
     facility's records on the app's phone only, the phone masked — and links the record after checking a document,
     or could not verify (back to the patient); a new code retires the old; another facility's desk cannot use it;
     wrong codes are limited; a locked claim may still go to the desk;
   - the claim QR: only Setu's claim QR is read (a verify QR costs no try); the facility in it picks the claim. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimQrUrl } from "@setu/domain";
import type { ClaimList, ClaimProofResponse, DeskClaimView } from "@setu/contracts";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { fakeMessenger } from "../src/adapters/messaging/index.js";
import { counters } from "../src/adapters/counters.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("desk-claim.test: DATABASE_URL_APP not set — ADR 0024 contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const IP = `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 255)}`;
const PHONE = `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, PH = PHONE.slice(1);
const USERS = { desk: "01799000001", doctor: "01799000002", liteDesk: "01798000001" } as const;
type Who = keyof typeof USERS;
const staff: Partial<Record<Who, string>> = {};
let cookie = "", personId = "", mother = "", daughter = "", liteRec = "", clinicTenant = "", liteTenant = "", clinicClaim = "", liteClaim = "";
const owner = () => new db!.PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

const sget = (url: string, who: Who) => app.inject({ method: "GET", url, headers: { cookie: staff[who]! } });
const spost = (url: string, payload: object, who: Who) => app.inject({ method: "POST", url, payload, headers: { cookie: staff[who]!, "idempotency-key": randomUUID() } });
const ok = <R,>(r: { statusCode: number; body: string; json: () => R }, code = 200) => { expect(r.statusCode, r.body).toBe(code); return r.json(); };
const pget = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
const ppost = (url: string, payload: object) => app.inject({ method: "POST", url, payload, headers: { cookie, "idempotency-key": randomUUID() } });
const claims = async () => ok<ClaimList>(await pget("/v1/patient/claims")).items;
const toDesk = async (claimId: string) => ok<ClaimProofResponse>(await ppost(`/v1/patient/claims/${claimId}/proof`, { method: "desk" }));
const clearLimits = () => counters().del("deskcode:u_e2e_desk", "deskcode:u_e2l_desk", `pclaim:${personId}`);

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of Object.entries(USERS)) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; staff[k as Who] = Array.isArray(c) ? c[0]! : (c as string);
  }
  const reg = async (who: Who, nameEn: string, nameBn: string, dob: string) => ok<{ patient: { id: string } }>(await spost("/v1/patients", { nameBn, nameEn: `${nameEn} ${RUN}`, sex: "female", dobMode: "dob", dob, phone: PHONE, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: false }, who), 201).patient.id;
  mother = await reg("desk", "Rokeya Begum", "রোকেয়া বেগম", "03/05/1970");
  daughter = await reg("desk", "Mitu Akter", "মিতু আক্তার", "14/08/2001");
  liteRec = await reg("liteDesk", "Rokeya Begum", "রোকেয়া বেগম", "03/05/1970");
  const o = owner();
  clinicTenant = (await o.patient.findUniqueOrThrow({ where: { id: mother }, select: { tenantId: true } })).tenantId;
  liteTenant = (await o.patient.findUniqueOrThrow({ where: { id: liteRec }, select: { tenantId: true } })).tenantId;
  await o.$disconnect();
  await app.inject({ method: "POST", url: "/v1/patient/otp", remoteAddress: IP, payload: { phone: PHONE, lang: "en" } });
  const code = fakeMessenger()!.log("network").filter((m) => m.to === PHONE).at(-1)!.text.match(/\d{6}/)![0];
  const si = await app.inject({ method: "POST", url: "/v1/patient/sign-in", payload: { phone: PHONE, code } });
  cookie = ([] as string[]).concat(si.headers["set-cookie"] as string | string[]).find((c) => c.startsWith("setu_patient="))!.split(";")[0]!;
  personId = ok<{ person: { id: string } }>(await pget("/v1/patient/me")).person.id;
  const items = await claims();
  const o2 = owner();
  const rows = await o2.patientClaim.findMany({ where: { personId }, select: { id: true, tenantId: true } });
  await o2.$disconnect();
  clinicClaim = rows.find((r) => r.tenantId === clinicTenant)!.id;
  liteClaim = rows.find((r) => r.tenantId === liteTenant)!.id;
  expect(items.map((i) => i.id).sort()).toEqual([clinicClaim, liteClaim].sort());
  await clearLimits();
}, 120_000);
afterAll(async () => {
  await clearLimits();
  await counters().del(`potp:send:${PH}`, `potp:tries:${PH}`, `potp:code:${PH}`);
  await app.close();
});

describe.skipIf(!db)("ADR 0024 — the reception desk", () => {
  let code = "";
  it("choosing the desk gives the app a code (7 days); the table keeps only its hash", async () => {
    const r = await toDesk(clinicClaim);
    expect(r.outcome).toBe("desk-pending");
    expect(r.deskCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    expect(r.claim).toMatchObject({ status: "proof-pending", method: "desk", deskCodeUntil: expect.any(String) });
    expect(new Date(r.claim.deskCodeUntil!).getTime() - Date.now()).toBeGreaterThan(6.9 * 864e5);
    code = r.deskCode!;
    const o = owner();
    const row = await o.patientClaim.findUniqueOrThrow({ where: { id: clinicClaim } });
    await o.$disconnect();
    expect(row.deskCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it("the reception finds it by the code (as typed): the phone masked, only this facility's records on that phone", async () => {
    const v = ok<DeskClaimView>(await spost("/v1/claims/desk/lookup", { code: `${code.slice(0, 3).toLowerCase()}-${code.slice(3)}` }, "desk"));
    expect(v.claimId).toBe(clinicClaim);
    expect(v.phoneMasked).toBe(`0${PH.slice(0, 2)}*****${PH.slice(-3)}`);
    expect(v.records.map((r) => r.patientId).sort()).toEqual([mother, daughter].sort());
    expect(v.records.find((r) => r.patientId === daughter)).toMatchObject({ ageYears: expect.any(Number), facilityNo: expect.any(String) });
    // another facility's desk cannot use it; a doctor has no such screen; a wrong code finds nothing
    expect((await spost("/v1/claims/desk/lookup", { code }, "liteDesk")).statusCode).toBe(404);
    expect((await spost("/v1/claims/desk/lookup", { code }, "doctor")).statusCode).toBe(403);
    const wrong = await spost("/v1/claims/desk/lookup", { code: code.startsWith("2") ? `3${code.slice(1)}` : `2${code.slice(1)}` }, "desk");
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json()).toMatchObject({ code: "desk_code" });
  });

  it("a new code retires the old one", async () => {
    const r = await toDesk(clinicClaim);
    expect(r.deskCode).not.toBe(code);
    expect((await spost("/v1/claims/desk/lookup", { code }, "desk")).statusCode).toBe(404);
    code = r.deskCode!;
    expect(ok<DeskClaimView>(await spost("/v1/claims/desk/lookup", { code }, "desk")).claimId).toBe(clinicClaim);
  });

  it("links only a record on the app's phone, after a document is checked: the patient's history opens; provenance and audit say who", async () => {
    const other = await spost("/v1/claims/desk/confirm", { code, patientId: liteRec, document: "nid" }, "desk");
    expect(other.statusCode).toBe(400);
    expect((await spost("/v1/claims/desk/confirm", { code, patientId: mother, document: "passport" }, "desk")).statusCode).toBe(400);
    expect(ok<{ outcome: string; facilityNo: string }>(await spost("/v1/claims/desk/confirm", { code, patientId: mother, document: "nid" }, "desk"))).toMatchObject({ outcome: "linked", facilityNo: expect.any(String) });
    expect((await claims()).find((c) => c.id === clinicClaim)).toMatchObject({ status: "linked", method: "desk", deskCodeUntil: null });
    expect(ok<{ facilities: number }>(await pget("/v1/patient/timeline")).facilities).toBe(1);
    const o = owner();
    const [row, prov, ev] = await Promise.all([
      o.patientClaim.findUniqueOrThrow({ where: { id: clinicClaim } }),
      o.provenance.findFirst({ where: { targetId: mother, activity: "patient-app-claim" }, orderBy: { recorded: "desc" } }),
      o.auditEvent.findFirst({ where: { entityId: clinicClaim, action: "claim", userId: "u_e2e_desk" }, orderBy: { at: "desc" } }),
    ]);
    await o.$disconnect();
    expect(row).toMatchObject({ patientId: mother, deskDocument: "nid", deskById: "u_e2e_desk", deskCodeHash: null });
    expect(prov).toMatchObject({ agentId: "u_e2e_desk", onBehalfOf: `person:${personId}`, source: "desk_decision" });
    expect(ev?.detail).toMatchObject({ method: "desk", outcome: "linked", document: "nid" });
    // the code is spent
    expect((await spost("/v1/claims/desk/lookup", { code }, "desk")).statusCode).toBe(404);
  });

  it("a claim locked by wrong codes may go to the desk; could not verify → back to the patient, who is told", async () => {
    for (let n = 0; n < 3; n++) await ppost(`/v1/patient/claims/${liteClaim}/proof`, { method: "code", code: "ZZZZZZ" });
    expect((await claims()).find((c) => c.id === liteClaim)?.status).toBe("locked");
    const r = await toDesk(liteClaim);
    expect(r.claim).toMatchObject({ status: "proof-pending", method: "desk" });
    expect(ok<{ outcome: string }>(await spost("/v1/claims/desk/refuse", { code: r.deskCode! }, "liteDesk")).outcome).toBe("refused");
    expect((await claims()).find((c) => c.id === liteClaim)).toMatchObject({ status: "candidate", deskRefused: true });
  });

  it("wrong codes are limited per receptionist", async () => {
    for (let n = 0; n < 10; n++) await spost("/v1/claims/desk/lookup", { code: "ZZZZZZ" }, "liteDesk");
    expect((await spost("/v1/claims/desk/lookup", { code: "ZZZZZZ" }, "liteDesk")).statusCode).toBe(429);
    await clearLimits();
  });
});

describe.skipIf(!db)("ADR 0024 — the claim QR", () => {
  it("a verify QR or any other text is refused before a try is counted", async () => {
    for (const qr of ["https://setu.example.com/verify/rc/7K4Q2M", "7K4Q2M"]) {
      const r = await ppost("/v1/patient/claims/qr", { qr });
      expect(r.statusCode, qr).toBe(400);
      expect(r.json()).toMatchObject({ code: "not_claim_qr" });
    }
    expect((await ppost(`/v1/patient/claims/${liteClaim}/proof`, { method: "qr", code: "https://setu.example.com/verify/rc/7K4Q2M" })).statusCode).toBe(400);
    // another facility's claim QR does not count at this claim
    expect((await ppost(`/v1/patient/claims/${liteClaim}/proof`, { method: "qr", code: claimQrUrl("https://x.example/patient", clinicTenant, "7K4Q2M") })).statusCode).toBe(400);
    expect((await claims()).find((c) => c.id === liteClaim)?.triesLeft).toBe(3);
  });

  it("the claim QR names the facility: its claim is proven with the code in it", async () => {
    const o = owner();
    const cc = (await o.patient.findUniqueOrThrow({ where: { id: liteRec }, select: { claimCode: true } })).claimCode!;
    await o.$disconnect();
    const r = ok<ClaimProofResponse>(await ppost("/v1/patient/claims/qr", { qr: claimQrUrl(config.patientAppUrl, liteTenant, cc) }));
    expect(r).toMatchObject({ outcome: "linked", claim: { id: liteClaim, status: "linked", method: "qr" } });
  });
});
