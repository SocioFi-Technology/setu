/* Slice B1–B2 (ADR 0014) contract tests on the real database (as setu_app), in the seeded E2E Lite Hospital (plan
   Hospital Lite, 017980000xx): arrival (a registered patient, an unknown one), the triage board, assignment with the
   paediatric prompt, STAT lab orders, care orders, the signed disposition. Synthetic patients only; every test makes
   its own ER ward of bays through the admin masters so runs never collide. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("er.test: DATABASE_URL_APP not set — ER contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const T = "t_e2e_lite";
const USERS = { desk: "01798000001", doctor: "01798000002", paed: "01798000003", nurse: "01798000004", surgeon: "01798000005", tech: "01798000006", admin: "01798000010", clinicNurse: "01722000004", otherDoctor: "01799000002" } as const;
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

const get = (url: string, who: keyof typeof USERS = "nurse") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const post = (url: string, payload: object, who: keyof typeof USERS = "nurse", key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const put = (url: string, payload: object, who: keyof typeof USERS = "nurse") => app.inject({ method: "PUT", url, payload, headers: { cookie: cookies[who]!, "idempotency-key": randomUUID() } });
const tenant = <R>(fn: (tx: import("@setu/db").Tx) => Promise<R>) => db!.forTenant(T, fn);
/** A synthetic adult patient, registered at the desk without a visit. */
async function newPatient(ageDob = "02/02/1986") {
  const child = Number(ageDob.slice(-4)) > 2008; // a child is registered with a guardian
  const r = await post("/v1/patients", { nameBn: "জরুরি রোগী", nameEn: `ER Patient ${RUN}-${randomInt(1e4)}`, sex: "female", dobMode: "dob", dob: ageDob, phone: `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: child ? "guardian" : "self", ...(child ? { guardian: { name: "আব্দুল করিম", relationship: "father" } } : {}), division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: false }, "desk");
  expect(r.statusCode, r.body).toBe(201);
  return r.json().patient.id as string;
}
/** An ER ward of this test's own bays (through the admin masters), so runs never share a bay. */
async function ownBays(n = 2): Promise<string[]> {
  const name = `ERT${RUN}${randomInt(1e3)}`;
  const r = await post("/v1/admin/wards", { name, beds: n, bedClass: "ER" }, "admin");
  expect(r.statusCode, r.body).toBe(201);
  const beds = await tenant((tx) => tx.location.findMany({ where: { kind: "bed", parent: { name } }, orderBy: { name: "asc" } }));
  return beds.map((b) => b.id);
}
async function ownWardBeds(n = 2, bedClass = "General"): Promise<string[]> {
  const name = `W${RUN}${randomInt(1e3)}`;
  const r = await post("/v1/admin/wards", { name, beds: n, bedClass }, "admin");
  expect(r.statusCode, r.body).toBe(201);
  return (await tenant((tx) => tx.location.findMany({ where: { kind: "bed", parent: { name } }, orderBy: { name: "asc" } }))).map((b) => b.id);
}
const bedState = (id: string) => tenant((tx) => tx.location.findFirst({ where: { id } })).then((b) => b!.bedState);
async function arrival(o: { patientId?: string; bayId?: string; unknown?: object; who?: keyof typeof USERS } = {}) {
  const patientId = o.unknown ? undefined : o.patientId ?? (await newPatient());
  const r = await post("/v1/er/arrivals", { ...(patientId ? { patientId } : { unknown: o.unknown }), arrivalMode: "walk-in", complaint: "Chest pain 40 min, sweating", ...(o.bayId ? { bayId: o.bayId } : {}) }, o.who ?? "nurse");
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as { item: { id: string; token: string; status: string; bay: { id: string } | null; provisional: boolean }; patient: { id: string; nameEn: string; identityConfidence: string }; review: boolean };
}

describe.runIf(db)("B1 arrival and the triage board", () => {
  it("the Clinic plan has no ER (plan lock), and the desk cannot register an arrival (role)", async () => {
    expect((await get("/v1/er/board", "clinicNurse")).json()).toMatchObject({ code: "forbidden", reason: "plan" });
    expect((await post("/v1/er/arrivals", { patientId: "x", arrivalMode: "walk-in", complaint: "pain" }, "desk")).statusCode).toBe(403);
  });
  it("a registered patient arrives on a bay: token E-nnn, status arrived, the bay occupied with one assignment; a second arrival is refused", async () => {
    const [bay] = await ownBays(1);
    const a = await arrival({ bayId: bay });
    expect(a.item.token).toMatch(/^E-\d{3,}$/);
    expect(a.item).toMatchObject({ status: "arrived", bay: { id: bay }, provisional: false });
    expect(await bedState(bay)).toBe("occupied");
    expect(await tenant((tx) => tx.bedAssignment.count({ where: { encounterId: a.item.id, status: "occupied" } }))).toBe(1);
    const again = await post("/v1/er/arrivals", { patientId: a.patient.id, arrivalMode: "ambulance", complaint: "again" });
    expect(again.statusCode).toBe(409); expect(again.json().code).toBe("er_visit_exists");
    // the ER visit is not on the OPD queue, and the desk may still give the same patient an OPD token today
    const q = await get("/v1/queue", "desk");
    expect(q.json().columns.flatMap((c: { items: { id: string }[] }) => c.items).some((i) => i.id === a.item.id)).toBe(false);
    expect((await post("/v1/encounters", { patientId: a.patient.id }, "desk")).statusCode).toBe(201);
    const board = await get("/v1/er/board");
    const row = board.json().items.find((i: { id: string }) => i.id === a.item.id);
    expect(row).toMatchObject({ level: null, overdue: false, doctor: null, complaint: "Chest pain 40 min, sweating" });
    expect(board.json().scale).toMatchObject({ sample: true, note: { en: "Pending clinician sign-off (sample scale)" }, untriagedTargetMinutes: 10 });
    expect(board.json().scale.levels.map((l: { targetMinutes: number }) => l.targetMinutes)).toEqual([0, 10, 30, 60, 120]);
  });
  it("an unknown patient gets a quick provisional registration that lands on the desk's review queue, and blocks nothing", async () => {
    const a = await arrival({ unknown: { sex: "male", approxAgeYears: 40, features: "Scar left forearm, blue shirt" } });
    expect(a.review).toBe(true);
    expect(a.patient).toMatchObject({ nameEn: "Unknown male ~40y", identityConfidence: "provisional" });
    expect(a.item.provisional).toBe(true);
    const reviews = await get("/v1/reviews/duplicates", "desk");
    const item = reviews.json().items.find((i: { subject: { id: string } }) => i.subject.id === a.patient.id);
    expect(item).toMatchObject({ kind: "review", candidate: null });
    expect(item.reason).toMatch(/ER provisional/);
    expect((await post(`/v1/er/encounters/${a.item.id}/triage`, { level: 1 })).statusCode).toBe(200);
  });
  it("triage: level 2 moves the visit to triaged (target 10 min); re-triage keeps the state; a level outside 1–5 is refused", async () => {
    const a = await arrival();
    const r = await post(`/v1/er/encounters/${a.item.id}/triage`, { level: 2 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: "triaged", level: 2, targetMinutes: 10 });
    const r2 = await post(`/v1/er/encounters/${a.item.id}/triage`, { level: 1 });
    expect(r2.json()).toMatchObject({ status: "triaged", level: 1, targetMinutes: 0 });
    expect((await post(`/v1/er/encounters/${a.item.id}/triage`, { level: 6 })).statusCode).toBe(400);
    const board = await get("/v1/er/board");
    expect(board.json().counts.byLevel["1"]).toBeGreaterThanOrEqual(1);
  });
  it("a bay change at triage is a move: the old bay goes to cleaning, the new one is occupied, one transfer id; leaving the bay vacates it", async () => {
    const [b1, b2] = await ownBays(2);
    const a = await arrival({ bayId: b1 });
    const r = await post(`/v1/er/encounters/${a.item.id}/triage`, { level: 3, bayId: b2 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().bay.id).toBe(b2);
    expect([await bedState(b1!), await bedState(b2!)]).toEqual(["cleaning", "occupied"]);
    const rows = await tenant((tx) => tx.bedAssignment.findMany({ where: { encounterId: a.item.id }, orderBy: { createdAt: "asc" } }));
    expect(rows.map((x) => [x.bedId, x.status, x.endReason])).toEqual([[b1, "ended", "vacated"], [b2, "occupied", null]]);
    expect(new Set(rows.map((x) => x.transferId)).size).toBe(1);
    const r2 = await post(`/v1/er/encounters/${a.item.id}/triage`, { level: 3, bayId: null });
    expect(r2.json().bay).toBeNull();
    expect(await bedState(b2!)).toBe("cleaning");
  });
  it("assign: an adult to the paediatrician needs an explicit continue (issue #24); the visit is then in progress and off the OPD worklists", async () => {
    const a = await arrival();
    const r = await post(`/v1/er/encounters/${a.item.id}/assign`, { doctorId: "u_e2l_paed" });
    expect(r.statusCode).toBe(422); expect(r.json().code).toBe("paediatric_confirm");
    const ok = await post(`/v1/er/encounters/${a.item.id}/assign`, { doctorId: "u_e2l_paed", paediatricOk: true });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: "in-progress", doctor: { id: "u_e2l_paed", paediatric: true } });
    const re = await post(`/v1/er/encounters/${a.item.id}/assign`, { doctorId: "u_e2l_doctor" });
    expect(re.json()).toMatchObject({ status: "in-progress", doctor: { id: "u_e2l_doctor" } });
    const wl = await get("/v1/consultations/worklist", "doctor");
    expect(wl.json().items.some((i: { id: string }) => i.id === a.item.id)).toBe(false);
    expect((await post(`/v1/er/encounters/${a.item.id}/assign`, { doctorId: "u_e2l_nurse" })).statusCode).toBe(400);
    // a child to the paediatrician needs no prompt
    const child = await arrival({ patientId: await newPatient("02/02/2019") });
    expect((await post(`/v1/er/encounters/${child.item.id}/assign`, { doctorId: "u_e2l_paed" })).statusCode).toBe(200);
  });
  it("vitals on an ER visit never move its status (the ER is triaged with a level)", async () => {
    const a = await arrival();
    const v = await post(`/v1/encounters/${a.item.id}/vitals`, { values: { bpSys: 90, bpDia: 60, pulse: 124, spo2: 92 }, effectiveAt: new Date().toISOString() });
    expect(v.statusCode, v.body).toBe(201);
    expect(v.json().encounter.status).toBe("arrived");
    const row = (await get("/v1/er/board")).json().items.find((i: { id: string }) => i.id === a.item.id);
    expect(row.vitals).toBe("BP 90/60 · HR 124 · SpO₂ 92%");
  });
  it("another tenant's doctor sees nothing of this ER", async () => {
    const a = await arrival();
    expect((await get(`/v1/er/encounters/${a.item.id}`, "otherDoctor")).statusCode).toBe(404);
    expect((await post(`/v1/er/encounters/${a.item.id}/triage`, { level: 1 }, "otherDoctor")).statusCode).toBe(404);
  });
});

describe.runIf(db)("B2 orders and the signed disposition", () => {
  it("one tap places a STAT lab order, active at once and at the top of the lab's collection worklist; twice is refused", async () => {
    const a = await arrival();
    const r = await post(`/v1/er/encounters/${a.item.id}/orders`, { testCode: "cbc" }, "doctor");
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().orders).toEqual([expect.objectContaining({ testCode: "cbc", priority: "stat", status: "active", orderedBy: { id: "u_e2l_doctor", nameBn: expect.any(String), nameEn: "Dr. Lite Emergency" } })]);
    expect(r.json()).toMatchObject({ sample: true, note: { status: "draft" } });
    expect((await post(`/v1/er/encounters/${a.item.id}/orders`, { testCode: "cbc" }, "doctor")).json().code).toBe("already_ordered");
    expect((await post(`/v1/er/encounters/${a.item.id}/orders`, { testCode: "nope" }, "doctor")).statusCode).toBe(400);
    const wl = await get("/v1/lab/worklist?stage=collect", "tech");
    expect(wl.statusCode, wl.body).toBe(200);
    const items = wl.json().items as { encounter: { id: string }; priority: string }[];
    const idx = items.findIndex((i) => i.encounter.id === a.item.id);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(items[idx]!.priority).toBe("stat");
    expect(items.slice(0, idx).every((i) => i.priority === "stat")).toBe(true);
  });
  it("decision 243: a nurse's order is a protocol order awaiting the doctor (note and lab worklist); the doctor's sign countersigns it", async () => {
    const [bay] = await ownBays(1);
    const a = await arrival({ bayId: bay });
    const r = await post(`/v1/er/encounters/${a.item.id}/orders`, { testCode: "cbc" }, "nurse");
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().orders[0]).toMatchObject({ protocol: true, countersigned: null });
    expect(r.json().awaitingCountersign).toBe(1);
    const care = await post(`/v1/er/encounters/${a.item.id}/care-orders`, { key: "o2", on: true }, "nurse");
    expect(care.json().careOrders.find((c: { key: string }) => c.key === "o2")).toMatchObject({ on: true, protocol: true, countersigned: null });
    expect(care.json().awaitingCountersign).toBe(2);
    const doc = await post(`/v1/er/encounters/${a.item.id}/orders`, { testCode: "rbs" }, "doctor");
    expect(doc.json().orders.find((o: { testCode: string }) => o.testCode === "rbs")).toMatchObject({ protocol: false, countersigned: null });
    const wl = await get("/v1/lab/worklist?stage=collect", "tech");
    const item = wl.json().items.find((i: { encounter: { id: string } }) => i.encounter.id === a.item.id);
    expect(item.tests.find((t: { testCode: string }) => t.testCode === "cbc").awaitingDoctor).toBe(true);
    expect(item.tests.find((t: { testCode: string }) => t.testCode === "rbs").awaitingDoctor).toBe(false);
    const visit = await get(`/v1/lab/visits/${a.item.id}`, "tech");
    expect(visit.json().orders.find((o: { testCode: string }) => o.testCode === "cbc")).toMatchObject({ protocol: true, countersigned: null });
    // the doctor's discharge sign countersigns every open protocol order (recorded: who, when)
    const rev = care.json().note.rev;
    const signed = await post(`/v1/er/encounters/${a.item.id}/disposition`, { rev, pin: "1234", disposition: { kind: "discharge", advice: "Rest; return if worse" } }, "doctor");
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json().awaitingCountersign).toBe(0);
    expect(signed.json().orders.find((o: { testCode: string }) => o.testCode === "cbc").countersigned).toMatchObject({ by: { id: "u_e2l_doctor" } });
    expect(signed.json().careOrders.find((c: { key: string }) => c.key === "o2").countersigned).toMatchObject({ by: { id: "u_e2l_doctor" } });
    expect((await get("/v1/lab/worklist?stage=collect", "tech")).json().items.find((i: { encounter: { id: string } }) => i.encounter.id === a.item.id).tests.every((t: { awaitingDoctor: boolean }) => !t.awaitingDoctor)).toBe(true);
    // a countersignature never changes (database)
    const row = await tenant((tx) => tx.serviceRequest.findFirst({ where: { encounterId: a.item.id, testCode: "cbc" } }));
    await expect(tenant((tx) => tx.serviceRequest.update({ where: { id: row!.id }, data: { countersignedById: "u_e2l_paed" } }))).rejects.toThrow(/countersignature never changes/);
  });
  it("decision 240: the nurse marks a bay ready (cleaning → vacant); a vacant bay refuses", async () => {
    const [bay] = await ownBays(1);
    const a = await arrival({ bayId: bay });
    await post(`/v1/er/encounters/${a.item.id}/triage`, { level: 4, bayId: null }); // leaves the bay → cleaning
    expect(await bedState(bay!)).toBe("cleaning");
    const r = await post(`/v1/er/bays/${bay}/ready`, {});
    expect(r.statusCode, r.body).toBe(200); expect(r.json()).toMatchObject({ id: bay, state: "vacant" });
    expect((await post(`/v1/er/bays/${bay}/ready`, {})).json().code).toBe("bed_state");
    expect((await post(`/v1/er/bays/${bay}/ready`, {}, "desk")).statusCode).toBe(403);
  });
  it("decisions 248 / 253: the family's phone and the brought-by phone are optional, normalised, patient-reported; the provisional record still goes to review", async () => {
    const a = await post("/v1/er/arrivals", { unknown: { sex: "female", approxAgeYears: 60, phone: "০১৭১১-৯০৮৮১২" }, arrivalMode: "public", broughtBy: "Neighbour", broughtByPhone: "+880 1811 223344", complaint: "Fall at home" });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json().patient).toMatchObject({ phone: "1711908812", phoneOwner: "family", identityConfidence: "provisional" });
    expect(a.json().item.broughtByPhone).toBe("1811223344");
    expect(a.json().review).toBe(true);
    const prov = await tenant((tx) => tx.provenance.findMany({ where: { targetType: "Patient", targetId: a.json().patient.id } }));
    expect(prov.map((p) => [p.activity, p.source]).sort()).toEqual([["phone-reported", "patient_reported"], ["register-provisional", "provider_verified"]]);
    const bad = await post("/v1/er/arrivals", { unknown: { sex: "male", approxAgeYears: 30, phone: "12345" }, arrivalMode: "walk-in", complaint: "Cough" });
    expect(bad.statusCode).toBe(400); expect(bad.json().code).toBe("phone_invalid");
  });
  it("care orders (sample list) toggle on the note; notes save with the rev; a stale rev is refused", async () => {
    const a = await arrival();
    const on = await post(`/v1/er/encounters/${a.item.id}/care-orders`, { key: "ct", on: true }, "doctor");
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().careOrders.find((c: { key: string }) => c.key === "ct")).toMatchObject({ on: true, nameEn: "CT head (non-contrast)" });
    const off = await post(`/v1/er/encounters/${a.item.id}/care-orders`, { key: "ct", on: false }, "doctor");
    expect(off.json().careOrders.find((c: { key: string }) => c.key === "ct").on).toBe(false);
    expect((await post(`/v1/er/encounters/${a.item.id}/care-orders`, { key: "mri", on: true }, "doctor")).statusCode).toBe(400);
    const rev = off.json().note.rev as number;
    const saved = await put(`/v1/er/encounters/${a.item.id}/notes`, { rev, notes: "GCS 11, pupils equal" }, "doctor");
    expect(saved.statusCode, saved.body).toBe(200); expect(saved.json().note).toMatchObject({ notes: "GCS 11, pupils equal", rev: rev + 1 });
    expect((await put(`/v1/er/encounters/${a.item.id}/notes`, { rev, notes: "late" }, "doctor")).statusCode).toBe(409);
  });
  it("admit: the doctor signs with the PIN — the ward bed is reserved (leg 1) and an admission is requested; the note is final", async () => {
    const [bay] = await ownBays(1);
    const [bed, cleaningBed] = await ownWardBeds(2);
    await tenant((tx) => tx.location.update({ where: { id: cleaningBed! }, data: { bedState: "cleaning" } }));
    const a = await arrival({ bayId: bay });
    const view = (await get(`/v1/er/encounters/${a.item.id}`, "doctor")).json();
    expect(view.beds.find((b: { id: string }) => b.id === cleaningBed)).toMatchObject({ pickable: false, reason: "cleaning" });
    expect(view.beds.find((b: { id: string }) => b.id === bed)).toMatchObject({ pickable: true, state: "vacant" });
    const rev = view.note.rev as number;
    const admit = (bedId: string | null, pin = "1234") => ({ rev, pin, disposition: { kind: "admit", bedId, consultantId: "u_e2l_surgeon", diagnosis: "Head injury, moderate (GCS 11) — RTA" } });
    expect((await post(`/v1/er/encounters/${a.item.id}/disposition`, admit(bed!), "nurse")).statusCode).toBe(403);
    expect((await post(`/v1/er/encounters/${a.item.id}/disposition`, admit(bed!, "0000"), "doctor")).statusCode).toBe(401);
    const blocked = await post(`/v1/er/encounters/${a.item.id}/disposition`, admit(null), "doctor");
    expect(blocked.statusCode).toBe(422); expect(blocked.json().blockers).toEqual([{ field: "bedId", code: "required" }]);
    const busy = await post(`/v1/er/encounters/${a.item.id}/disposition`, admit(cleaningBed!), "doctor");
    expect(busy.statusCode).toBe(409); expect(busy.json().code).toBe("bed_not_free");
    const r = await post(`/v1/er/encounters/${a.item.id}/disposition`, admit(bed!), "doctor");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().note).toMatchObject({ status: "final", signedBy: { id: "u_e2l_doctor" } });
    expect(r.json().item).toMatchObject({ status: "in-progress", doctor: { id: "u_e2l_doctor" }, disposition: { kind: "admit" }, admission: { status: "requested", bed: { id: bed } } });
    expect(await bedState(bed!)).toBe("reserved");
    expect(await bedState(bay!)).toBe("occupied"); // the patient is still in the ER until the desk admits
    const res = await tenant((tx) => tx.bedAssignment.findFirst({ where: { bedId: bed!, status: "reserved" } }));
    expect(res).toMatchObject({ patientId: a.patient.id, reservedById: "u_e2l_doctor" });
    expect(await tenant((tx) => tx.admission.count({ where: { sourceEncounterId: a.item.id, status: "requested", bedId: bed!, admittingDoctorId: "u_e2l_surgeon" } }))).toBe(1);
    // signed: no more orders; the same bed cannot be picked for someone else
    expect((await post(`/v1/er/encounters/${a.item.id}/orders`, { testCode: "rbs" }, "doctor")).json().code).toBe("note_signed");
    const other = await arrival();
    const v2 = (await get(`/v1/er/encounters/${other.item.id}`, "doctor")).json();
    expect(v2.beds.find((b: { id: string }) => b.id === bed)).toMatchObject({ pickable: false, reason: "reserved-other" });
    const taken = await post(`/v1/er/encounters/${other.item.id}/disposition`, { rev: v2.note.rev, pin: "1234", disposition: { kind: "admit", bedId: bed, consultantId: "u_e2l_surgeon", diagnosis: "Acute abdomen" } }, "doctor");
    expect(taken.statusCode).toBe(409);
  });
  it("discharge closes the visit the moment it is signed and vacates the bay into cleaning", async () => {
    const [bay] = await ownBays(1);
    const a = await arrival({ bayId: bay });
    const rev = (await get(`/v1/er/encounters/${a.item.id}`, "doctor")).json().note.rev;
    const r = await post(`/v1/er/encounters/${a.item.id}/disposition`, { rev, pin: "1234", disposition: { kind: "discharge", advice: "Rest; return if headache or vomiting", followUp: "OPD Surgery in 3 days" } }, "doctor");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().item).toMatchObject({ status: "finished", disposition: { kind: "discharge" }, bay: null });
    expect(await bedState(bay!)).toBe("cleaning");
    expect((await post(`/v1/er/encounters/${a.item.id}/triage`, { level: 2 })).json().code).toBe("encounter_closed");
  });
  it("death: medico-legal needs the police informed before signing; signed, the visit is closed", async () => {
    const a = await arrival();
    const rev = (await get(`/v1/er/encounters/${a.item.id}`, "doctor")).json().note.rev;
    const base = { kind: "death", timeOfDeath: new Date().toISOString(), cause: "Severe traumatic brain injury", medicoLegal: true };
    const no = await post(`/v1/er/encounters/${a.item.id}/disposition`, { rev, pin: "1234", disposition: { ...base, checks: ["certificate", "family"] } }, "doctor");
    expect(no.statusCode).toBe(422); expect(no.json().blockers).toEqual([{ field: "checks.police", code: "police_required" }]);
    const yes = await post(`/v1/er/encounters/${a.item.id}/disposition`, { rev, pin: "1234", disposition: { ...base, checks: ["certificate", "family", "police"] } }, "doctor");
    expect(yes.statusCode, yes.body).toBe(200);
    expect(yes.json().item).toMatchObject({ status: "finished", disposition: { kind: "death" } });
  });
});
