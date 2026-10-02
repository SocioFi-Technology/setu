/* Slice A4 contract tests on the real database (as setu_app), in the seeded E2E Test Clinic: impossible values are
   refused, abnormal ones stored with their interpretation, the first batch moves the visit to "vitals done", and
   another tenant's nurse sees nothing. Synthetic patients only. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("vitals.test: DATABASE_URL_APP not set — vitals contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const cookies: Record<string, string> = {};

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of [["desk", "01799000001"], ["doctor", "01799000002"], ["nurse", "01799000004"], ["otherNurse", "01722000004"]] as const) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; cookies[k] = Array.isArray(c) ? c[0]! : (c as string);
  }
});
afterAll(async () => { await app.close(); });

const get = (url: string, who = "nurse") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const post = (url: string, payload: object, who = "nurse", key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const now = () => new Date().toISOString();
/** A new synthetic patient registered at the desk with today's token. */
async function newVisit() {
  const r = await post("/v1/patients", {
    nameBn: "মিতা রানী", nameEn: `Mita Rani ${RUN}`, sex: "female", dobMode: "dob", dob: "02/02/1990", phone: `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self",
    division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
  }, "desk");
  expect(r.statusCode).toBe(201);
  return r.json().encounter.id as string;
}

describe.runIf(db)("A4 vitals: impossible values are refused, abnormal ones warn (walkthrough A4)", () => {
  it("an impossible value refuses the whole batch with the field named; nothing is stored and the visit stays waiting", async () => {
    const enc = await newVisit();
    const r = await post(`/v1/encounters/${enc}/vitals`, { values: { bpSys: 150, bpDia: 95, temp: 994, spo2: 101 }, effectiveAt: now() });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: "vitals_impossible", message_en: "2 value(s) not possible — re-measure" });
    expect(r.json().fields).toEqual([{ field: "temp", code: "temp_impossible" }, { field: "spo2", code: "spo2_over_100" }]);
    expect(await db!.forTenant("t_e2e", (tx) => tx.observation.count({ where: { encounterId: enc } }))).toBe(0);
    expect((await get(`/v1/encounters/${enc}/vitals`)).json()).toMatchObject({ encounter: { status: "arrived" }, current: null });
  });
  it("nothing entered is refused", async () => {
    const enc = await newVisit();
    expect((await post(`/v1/encounters/${enc}/vitals`, { values: {}, effectiveAt: now() })).json().code).toBe("vitals_empty");
  });
  it("abnormal values are stored final with H/HH flags and BMI; the visit moves to vitals done; a replay does not store twice", async () => {
    const enc = await newVisit();
    const key = randomUUID();
    const body = { values: { bpSys: 150, bpDia: 95, pulse: 124, temp: 99.4, spo2: 98, rbs: 11.2, rbsMode: "random", weight: 58, height: 152 }, effectiveAt: now(), deviceLabel: "VT-02" };
    const r = await post(`/v1/encounters/${enc}/vitals`, body, "nurse", key);
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b.encounter.status).toBe("triaged");
    const byCode = Object.fromEntries(b.batch.observations.map((o: { code: string }) => [o.code, o]));
    expect(byCode["bp-systolic"]).toMatchObject({ value: 150, unit: "mmHg", interpretation: "H" });
    expect(byCode["pulse"]).toMatchObject({ value: 124, interpretation: "HH" });
    expect(byCode["blood-glucose"]).toMatchObject({ value: 11.2, method: "random", interpretation: "H" });
    expect(byCode["bmi"]).toMatchObject({ value: 25.1, method: "calculated" });
    expect(b.batch).toMatchObject({ source: "provider-verified", recordedBy: { nameEn: "Test Nurse", role: "nurse" } });
    const again = await post(`/v1/encounters/${enc}/vitals`, body, "nurse", key);
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(again.json().batch.batchId).toBe(b.batch.batchId);
    expect(await db!.forTenant("t_e2e", (tx) => tx.observation.count({ where: { encounterId: enc } }))).toBe(9);
    const prov = await db!.forTenant("t_e2e", (tx) => tx.provenance.findFirst({ where: { targetType: "Observation", targetId: b.batch.batchId } }));
    expect(prov).toMatchObject({ activity: "record-vitals", source: "provider_verified", agentId: "u_e2e_nurse" });
    const audit = await db!.forTenant("t_e2e", (tx) => tx.auditEvent.findFirst({ where: { entity: "Observation", entityId: b.batch.batchId, action: "create" } }));
    expect(audit).toBeTruthy();
    // A second measurement later in the same visit is a new batch, not an edit.
    const re = await post(`/v1/encounters/${enc}/vitals`, { values: { bpSys: 142, bpDia: 92 }, effectiveAt: now() });
    expect(re.statusCode).toBe(201);
    expect((await get(`/v1/encounters/${enc}/vitals`)).json().current.batchId).toBe(re.json().batch.batchId);
  });
  it("the view shows the previous values (Rahima Khatun: BP 145/90 on 12/08/2026) and the worklist lists the visit", async () => {
    await db!.forTenant("t_e2e", (tx) => tx.encounter.updateMany({ where: { patientId: "e2e_p_rahima", status: { in: ["arrived", "triaged", "in_progress"] } }, data: { status: "cancelled", cancelReason: "test reset" } }));
    const v = await post("/v1/encounters", { patientId: "e2e_p_rahima" }, "desk");
    expect(v.statusCode).toBe(201);
    const view = (await get(`/v1/encounters/${v.json().encounter.id}/vitals`)).json();
    const prev = Object.fromEntries(view.previous.map((o: { code: string; value: number }) => [o.code, o]));
    // The newest value from any earlier visit: the seeded 12/08/2026 visit (145/90), or a later one if the journeys ran today.
    const latest = await db!.forTenant("t_e2e", (tx) => tx.observation.findFirst({ where: { patientId: "e2e_p_rahima", code: "bp-systolic", encounterId: { not: v.json().encounter.id } }, orderBy: { effectiveAt: "desc" } }));
    expect(prev["bp-systolic"]).toMatchObject({ value: latest!.value, effectiveAt: latest!.effectiveAt.toISOString() });
    expect(await db!.forTenant("t_e2e", (tx) => tx.observation.count({ where: { batchId: "e2e_vb_rahima_20260812", code: "bp-systolic", value: 145 } }))).toBe(1);
    expect(view.previous.every((o: { effectiveAt: string }) => Date.parse(o.effectiveAt) <= Date.now())).toBe(true);
    const wl = (await get("/v1/vitals/worklist")).json();
    expect(wl.items.find((i: { id: string }) => i.id === v.json().encounter.id)).toMatchObject({ token: v.json().encounter.token, hasVitals: false });
    await post(`/v1/encounters/${v.json().encounter.id}/actions`, { action: "noShow" }, "desk");
  });
  it("clinical review: 150/80 flags only the systolic; glucose 25–40 needs a re-checked tick; > 40 is read as mg/dL", async () => {
    const enc = await newVisit();
    const r = await post(`/v1/encounters/${enc}/vitals`, { values: { bpSys: 150, bpDia: 80 }, effectiveAt: now() });
    const byCode = Object.fromEntries(r.json().batch.observations.map((o: { code: string }) => [o.code, o]));
    expect(byCode["bp-systolic"].interpretation).toBe("H");
    expect(byCode["bp-diastolic"].interpretation).toBe("N");
    const noTick = await post(`/v1/encounters/${enc}/vitals`, { values: { rbs: 40 }, effectiveAt: now() });
    expect(noTick.statusCode).toBe(400); expect(noTick.json()).toMatchObject({ code: "vitals_confirm", fields: [{ field: "rbs", code: "confirm_required" }] });
    const ticked = await post(`/v1/encounters/${enc}/vitals`, { values: { rbs: 40 }, confirmed: ["rbs"], effectiveAt: now() });
    expect(ticked.statusCode).toBe(201);
    expect(ticked.json().batch.observations[0]).toMatchObject({ code: "blood-glucose", interpretation: "HH" });
    expect((await post(`/v1/encounters/${enc}/vitals`, { values: { rbs: 180 }, effectiveAt: now() })).json().fields).toEqual([{ field: "rbs", code: "rbs_mgdl" }]);
  });
  it("the current batch is the most recently measured one, even if an older offline batch syncs later", async () => {
    const enc = await newVisit();
    const newer = await post(`/v1/encounters/${enc}/vitals`, { values: { pulse: 90 }, effectiveAt: now() });
    await post(`/v1/encounters/${enc}/vitals`, { values: { pulse: 70 }, effectiveAt: new Date(Date.now() - 30 * 60_000).toISOString() });
    expect((await get(`/v1/encounters/${enc}/vitals`)).json().current.batchId).toBe(newer.json().batch.batchId);
  });
  it("a measurement time far in the future is refused (device clock)", async () => {
    const enc = await newVisit();
    const r = await post(`/v1/encounters/${enc}/vitals`, { values: { pulse: 80 }, effectiveAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(r.json().code).toBe("effective_at_range");
  });
  it("a closed visit takes no vitals", async () => {
    const enc = await newVisit();
    await post(`/v1/encounters/${enc}/actions`, { action: "noShow" }, "desk");
    expect((await post(`/v1/encounters/${enc}/vitals`, { values: { pulse: 80 }, effectiveAt: now() })).json().code).toBe("encounter_closed");
  });
  it("the receptionist may record vitals (access matrix); the doctor may read them but not record", async () => {
    const enc = await newVisit();
    expect((await post(`/v1/encounters/${enc}/vitals`, { values: { pulse: 80 }, effectiveAt: now() }, "desk")).statusCode).toBe(201);
    const d = await post(`/v1/encounters/${enc}/vitals`, { values: { pulse: 82 }, effectiveAt: now() }, "doctor");
    expect(d.statusCode).toBe(403); expect(d.json()).toMatchObject({ reason: "role" });
    expect((await get(`/v1/encounters/${enc}/vitals`, "doctor")).statusCode).toBe(200);
    expect((await get("/v1/vitals/worklist", "doctor")).statusCode).toBe(403);
  });
  it("a write without Idempotency-Key is refused", async () => {
    const enc = await newVisit();
    expect((await post(`/v1/encounters/${enc}/vitals`, { values: { pulse: 80 }, effectiveAt: now() }, "nurse", null)).json().code).toBe("idempotency_key_required");
  });
  it("observations are append-only for the API role", async () => {
    const enc = await newVisit();
    await post(`/v1/encounters/${enc}/vitals`, { values: { pulse: 80 }, effectiveAt: now() });
    await expect(db!.forTenant("t_e2e", (tx) => tx.observation.updateMany({ where: { encounterId: enc }, data: { value: 81 } }))).rejects.toThrow();
    await expect(db!.forTenant("t_e2e", (tx) => tx.observation.deleteMany({ where: { encounterId: enc } }))).rejects.toThrow();
  });
});

describe.runIf(db)("A4 vitals: cross-tenant denial", () => {
  it("another tenant's nurse cannot read or record this clinic's visit, and does not see it on the worklist", async () => {
    const enc = await newVisit();
    expect((await get(`/v1/encounters/${enc}/vitals`, "otherNurse")).statusCode).toBe(404);
    expect((await post(`/v1/encounters/${enc}/vitals`, { values: { pulse: 80 }, effectiveAt: now() }, "otherNurse")).statusCode).toBe(404);
    expect((await get("/v1/vitals/worklist", "otherNurse")).json().items.map((i: { id: string }) => i.id)).not.toContain(enc);
    expect(await db!.forTenant("t_e2e", (tx) => tx.observation.count({ where: { encounterId: enc } }))).toBe(0);
  });
  it("under another tenant's context the rows are invisible (RLS)", async () => {
    const enc = await newVisit();
    await post(`/v1/encounters/${enc}/vitals`, { values: { pulse: 80 }, effectiveAt: now() });
    expect(await db!.forTenant("t_clinicdemo", (tx) => tx.observation.count({ where: { encounterId: enc } }))).toBe(0);
  });
});
