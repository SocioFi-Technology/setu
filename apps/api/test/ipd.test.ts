/* Slice B1–B2 (ADR 0014): the bed board and ward actions, the admission desk — a direct admission and the ER's
   admission request completed — in the seeded E2E Lite Hospital. The database guards (one occupant per bed, one bed
   per patient, one open inpatient encounter, the IPD bill from the admission only) are exercised through the API. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("ipd.test: DATABASE_URL_APP not set — IPD contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const T = "t_e2e_lite";
const USERS = { desk: "01798000001", doctor: "01798000002", nurse: "01798000004", surgeon: "01798000005", cashier: "01798000008", admin: "01798000010", clinicNurse: "01722000004" } as const;
const cookies: Record<string, string> = {};
beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of Object.entries(USERS)) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; cookies[k] = Array.isArray(c) ? c[0]! : (c as string);
  }
});
afterAll(async () => { await app.close(); });
const get = (url: string, who: keyof typeof USERS = "desk") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const post = (url: string, payload: object, who: keyof typeof USERS = "desk", key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const tenant = <R>(fn: (tx: import("@setu/db").Tx) => Promise<R>) => db!.forTenant(T, fn);
async function newPatient() {
  const r = await post("/v1/patients", { nameBn: "ভর্তি রোগী", nameEn: `IPD Patient ${RUN}-${randomInt(1e4)}`, sex: "female", dobMode: "dob", dob: "02/06/1995", phone: `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self", division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: false }, "desk");
  expect(r.statusCode, r.body).toBe(201);
  return r.json().patient.id as string;
}
async function ownWard(n = 2, bedClass = "General"): Promise<string[]> {
  const name = `${bedClass === "ER" ? "ERT" : "W"}${RUN}${randomInt(1e3)}`;
  const r = await post("/v1/admin/wards", { name, beds: n, bedClass }, "admin");
  expect(r.statusCode, r.body).toBe(201);
  return (await tenant((tx) => tx.location.findMany({ where: { kind: "bed", parent: { name } }, orderBy: { name: "asc" } }))).map((b) => b.id);
}
const bedState = (id: string) => tenant((tx) => tx.location.findFirst({ where: { id } })).then((b) => b!.bedState);
const GUARDIAN = { name: "রাশেদ চৌধুরী", relationship: "husband", phone: "+880 1711-908812" };
const REQUIRED = ["general", "financial", "guardian-id"];
const admitBody = (patientId: string, bedId: string | null, extra: object = {}) => ({ patientId, admittingDoctorId: "u_e2l_surgeon", department: "surgery", diagnosis: "Ruptured ovarian cyst? · Acute lower abdominal pain", bedClass: "General", bedId, guardian: GUARDIAN, consents: REQUIRED, ...extra });

describe.runIf(db)("beds (walkthrough B3 / B4 rules)", () => {
  it("the Clinic plan has no beds; the board lists the seeded wards with 2A-05 cleaning and 2A-06 blocked (reason)", async () => {
    expect((await get("/v1/ipd/beds", "clinicNurse")).json()).toMatchObject({ code: "forbidden", reason: "plan" });
    const b = await get("/v1/ipd/beds", "nurse");
    expect(b.statusCode, b.body).toBe(200);
    const beds = b.json().wards.flatMap((w: { beds: { name: string; state: string; note: string | null }[] }) => w.beds);
    expect(beds.find((x: { name: string }) => x.name === "2A-05")).toMatchObject({ state: "cleaning" });
    expect(beds.find((x: { name: string }) => x.name === "2A-06")).toMatchObject({ state: "blocked", note: "O₂ line repair" });
    expect(b.json().classes.map((c: { key: string }) => c.key)).toEqual(["General", "Cabin", "HDU", "ICU"]);
    expect(b.json().classes[0].sample).toBe(true);
  });
  it("ward actions go through BED: block needs a reason, unblock, mark ready only from cleaning; a doctor may not", async () => {
    const [b1] = await ownWard(1);
    expect((await post(`/v1/ipd/beds/${b1}/actions`, { action: "block" }, "nurse")).statusCode).toBe(400);
    const blocked = await post(`/v1/ipd/beds/${b1}/actions`, { action: "block", reason: "O₂ line repair" }, "nurse");
    expect(blocked.statusCode, blocked.body).toBe(200); expect(blocked.json()).toMatchObject({ state: "blocked", note: "O₂ line repair" });
    expect((await post(`/v1/ipd/beds/${b1}/actions`, { action: "markReady" }, "nurse")).json().code).toBe("bed_state");
    expect((await post(`/v1/ipd/beds/${b1}/actions`, { action: "unblock" }, "doctor")).statusCode).toBe(403);
    expect((await post(`/v1/ipd/beds/${b1}/actions`, { action: "unblock" }, "nurse")).json()).toMatchObject({ state: "vacant", note: null });
  });
});

describe.runIf(db)("the admission desk (walkthrough B2 → B3)", () => {
  it("the form's options: doctors with their speciality, three required consents, departments, admission classes", async () => {
    const r = await get("/v1/ipd/admissions");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().options.doctors).toEqual(expect.arrayContaining([expect.objectContaining({ id: "u_e2l_paed", speciality: "Paediatrics" })]));
    expect(r.json().options.consents.filter((c: { required: boolean }) => c.required).map((c: { key: string }) => c.key)).toEqual(REQUIRED);
    expect(r.json().options.departments.length).toBeGreaterThan(3);
    expect((await get("/v1/ipd/admissions", "doctor")).statusCode).toBe(403);
  });
  it("a direct admission is one transaction: IPD encounter in progress, bed occupied, ADM/yy/nnnn, the IPD bill draft; a replay changes nothing", async () => {
    const [bed] = await ownWard(1);
    const patientId = await newPatient();
    const key = randomUUID();
    const r = await post("/v1/ipd/admissions", admitBody(patientId, bed!), "desk", key);
    expect(r.statusCode, r.body).toBe(201);
    const v = r.json();
    expect(v).toMatchObject({ status: "admitted", source: "direct", encounter: { status: "in-progress" }, bed: { id: bed, state: "occupied", patient: { id: patientId } }, invoice: { kind: "ipd", status: "draft", number: null }, admittingDoctor: { id: "u_e2l_surgeon", speciality: "Surgery" }, guardian: { ...GUARDIAN, phone: "+8801711908812" }, consents: REQUIRED }); // the phone is stored as Latin digits, no spaces
    expect(v.number).toMatch(/^ADM\/\d{2}\/\d{4}$/);
    expect(v.encounter.token).toBe(v.number);
    expect(v.checklist.find((c: { key: string }) => c.key === "deposit")).toMatchObject({ ok: false, blocks: false });
    expect(v.legs).toEqual([expect.objectContaining({ status: "occupied" })]);
    const encs = await tenant((tx) => tx.encounter.findMany({ where: { patientId, class: "ipd" } }));
    expect(encs).toHaveLength(1);
    expect(await tenant((tx) => tx.invoice.count({ where: { encounterId: encs[0]!.id, kind: "ipd" } }))).toBe(1);
    const replay = await post("/v1/ipd/admissions", admitBody(patientId, bed!), "desk", key);
    expect(replay.statusCode).toBe(201); expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(await tenant((tx) => tx.encounter.count({ where: { patientId, class: "ipd" } }))).toBe(1);
    // the OPD bill route refuses an inpatient; the admission is on the desk's list
    const bill = await post(`/v1/encounters/${encs[0]!.id}/invoice`, {}, "cashier");
    expect(bill.statusCode).toBe(409); expect(bill.json().code).toBe("inpatient_bill");
    expect((await get("/v1/ipd/admissions")).json().admitted.some((a: { id: string }) => a.id === v.id)).toBe(true);
  });
  it("a patient cannot be admitted twice, two patients cannot share a bed, and a bed being cleaned cannot be picked", async () => {
    const [bed, bed2] = await ownWard(2);
    const p = await newPatient();
    expect((await post("/v1/ipd/admissions", admitBody(p, bed!))).statusCode).toBe(201);
    const twice = await post("/v1/ipd/admissions", admitBody(p, bed2!));
    expect(twice.statusCode).toBe(409); expect(["patient_admitted", "patient_has_bed"]).toContain(twice.json().code);
    const share = await post("/v1/ipd/admissions", admitBody(await newPatient(), bed!));
    expect(share.statusCode).toBe(409); expect(share.json().code).toBe("bed_not_free");
    await tenant((tx) => tx.location.update({ where: { id: bed2! }, data: { bedState: "cleaning" } }));
    const dirty = await post("/v1/ipd/admissions", admitBody(await newPatient(), bed2!));
    expect(dirty.statusCode).toBe(409); expect(dirty.json().message_en).toContain("being cleaned"); expect(dirty.json().message_bn).toContain("পরিষ্কার চলছে");
  });
  it("the checklist refuses in one answer: no bed, no guardian phone, a consent missing; a nurse may not admit", async () => {
    const [bed] = await ownWard(1);
    const p = await newPatient();
    const r = await post("/v1/ipd/admissions", admitBody(p, null, { guardian: { ...GUARDIAN, phone: "12" }, consents: ["general"] }));
    expect(r.statusCode).toBe(422); expect(r.json().code).toBe("admission_blocked");
    expect(r.json().blockers.map((b: { key: string }) => b.key)).toEqual(["bed", "guardian", "consents"]);
    expect(r.json().blockers.find((b: { key: string }) => b.key === "consents").missing).toBe(2);
    expect((await post("/v1/ipd/admissions", admitBody(p, bed!), "nurse")).statusCode).toBe(403);
    expect((await post("/v1/ipd/admissions", admitBody(p, bed!, { consents: ["general", "financial", "guardian-id", "voodoo"] }))).statusCode).toBe(400);
  });
  it("from the ER: the admit disposition reserved the bed (leg 1); the desk's Admit occupies it, vacates the bay, finishes the ER visit — one transfer id", async () => {
    const [bay] = await ownWard(1, "ER");
    const [bed] = await ownWard(1);
    const p = await newPatient();
    const a = await post("/v1/er/arrivals", { patientId: p, arrivalMode: "ambulance", complaint: "RTA — head injury", bayId: bay }, "nurse");
    expect(a.statusCode, a.body).toBe(201);
    const erId = a.json().item.id as string;
    await post(`/v1/er/encounters/${erId}/triage`, { level: 1 }, "nurse");
    const rev = (await get(`/v1/er/encounters/${erId}`, "doctor")).json().note.rev;
    const signed = await post(`/v1/er/encounters/${erId}/disposition`, { rev, pin: "1234", disposition: { kind: "admit", bedId: bed, consultantId: "u_e2l_surgeon", diagnosis: "Head injury, moderate (GCS 11) — RTA" } }, "doctor");
    expect(signed.statusCode, signed.body).toBe(200);
    const admissionId = signed.json().item.admission.id as string;
    const list = await get("/v1/ipd/admissions");
    expect(list.json().requested.find((x: { id: string }) => x.id === admissionId)).toMatchObject({ source: "er", bed: { id: bed, state: "reserved" }, patient: { id: p } });
    const r = await post("/v1/ipd/admissions", { admissionId, admittingDoctorId: "u_e2l_surgeon", department: "surgery", diagnosis: "Head injury, moderate (GCS 11) — RTA", bedClass: "General", bedId: bed, guardian: GUARDIAN, consents: REQUIRED });
    expect(r.statusCode, r.body).toBe(201);
    const v = r.json();
    expect(v).toMatchObject({ status: "admitted", source: "er", sourceEncounter: { id: erId, class: "er", status: "finished" }, bed: { id: bed, state: "occupied" }, invoice: { kind: "ipd", status: "draft" } });
    expect([await bedState(bay!), await bedState(bed!)]).toEqual(["cleaning", "occupied"]);
    const legs = v.legs as { bed: string; status: string; transferId: string; endReason: string | null }[];
    const move = legs.filter((l) => l.transferId === legs[legs.length - 1]!.transferId);
    expect(move.map((l) => [l.status, l.endReason])).toEqual([["ended", "occupied"], ["occupied", null]]);
    const rows = await tenant((tx) => tx.bedAssignment.findMany({ where: { patientId: p }, orderBy: { createdAt: "asc" } }));
    expect(rows.map((x) => [x.bedId, x.status, x.endReason])).toEqual([[bay, "ended", "vacated"], [bed, "ended", "occupied"], [bed, "occupied", null]]);
    expect(rows[1]!.transferId).toBe(rows[2]!.transferId);
    expect(rows[2]!.encounterId).toBe(v.encounter.id);
    expect(await tenant((tx) => tx.admission.count({ where: { id: admissionId, status: "admitted", encounterId: v.encounter.id, invoiceId: v.invoice.id } }))).toBe(1);
    // the board shows the ER visit finished with its admission; the request cannot be completed twice
    expect((await post("/v1/ipd/admissions", { admissionId, admittingDoctorId: "u_e2l_surgeon", department: "surgery", diagnosis: "x", bedClass: "General", bedId: bed, guardian: GUARDIAN, consents: REQUIRED })).json().code).toBe("admission_not_open");
  });
  it("a requested admission can be cancelled with a reason: the reserved bed is released", async () => {
    const [bed] = await ownWard(1);
    const p = await newPatient();
    const a = await post("/v1/er/arrivals", { patientId: p, arrivalMode: "walk-in", complaint: "Abdominal pain" }, "nurse");
    const erId = a.json().item.id as string;
    const rev = (await get(`/v1/er/encounters/${erId}`, "doctor")).json().note.rev;
    const signed = await post(`/v1/er/encounters/${erId}/disposition`, { rev, pin: "1234", disposition: { kind: "admit", bedId: bed, consultantId: "u_e2l_surgeon", diagnosis: "Acute abdomen" } }, "doctor");
    const admissionId = signed.json().item.admission.id as string;
    expect(await bedState(bed!)).toBe("reserved");
    expect((await post(`/v1/ipd/admissions/${admissionId}/cancel`, { reason: "x" })).statusCode).toBe(400);
    const c = await post(`/v1/ipd/admissions/${admissionId}/cancel`, { reason: "Family took the patient elsewhere" });
    expect(c.statusCode, c.body).toBe(200); expect(c.json().status).toBe("cancelled");
    expect(await bedState(bed!)).toBe("vacant");
    expect(await tenant((tx) => tx.bedAssignment.count({ where: { patientId: p, status: { in: ["reserved", "occupied"] } } }))).toBe(0);
    // review: the ER visit is not stuck — the doctor signs a new disposition as an amendment (v2); v1 is superseded
    const view = await get(`/v1/er/encounters/${erId}`, "doctor");
    expect(view.json()).toMatchObject({ canRedispose: true, note: { status: "final", version: 1 }, item: { status: "in-progress", disposition: null, admission: null } });
    expect((await post(`/v1/er/encounters/${erId}/orders`, { testCode: "cbc" }, "doctor")).json().code).toBe("note_signed"); // orders stay locked on the signed note
    const again = await post(`/v1/er/encounters/${erId}/disposition`, { rev: view.json().note.rev, pin: "1234", disposition: { kind: "discharge", advice: "Pain settled; review in OPD" } }, "doctor");
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ canRedispose: false, note: { status: "amended", version: 2 }, item: { status: "finished", disposition: { kind: "discharge" } } });
    const versions = await tenant((tx) => tx.composition.findMany({ where: { encounterId: erId, kind: "er-note" }, orderBy: { version: "asc" } }));
    expect(versions.map((v) => [v.version, v.status, v.amendsId !== null])).toEqual([[1, "superseded", false], [2, "amended", true]]);
  });
  it("a direct admission of a patient who is in the ER comes from that visit: bay vacated, visit finished, source er", async () => {
    const [bay] = await ownWard(1, "ER"); const [bed] = await ownWard(1);
    const p = await newPatient();
    const a = await post("/v1/er/arrivals", { patientId: p, arrivalMode: "walk-in", complaint: "Weakness", bayId: bay }, "nurse");
    const erId = a.json().item.id as string;
    await post(`/v1/er/encounters/${erId}/assign`, { doctorId: "u_e2l_doctor" }, "nurse");
    const r = await post("/v1/ipd/admissions", admitBody(p, bed!));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ source: "er", sourceEncounter: { id: erId, status: "finished" } });
    expect([await bedState(bay!), await bedState(bed!)]).toEqual(["cleaning", "occupied"]);
  });
});
