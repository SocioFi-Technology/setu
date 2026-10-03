/* Slice A8–A11 contract tests on the real database (as setu_app), in the seeded E2E Test Clinic (Hospital Pro: verify
   and validate need two people), with new synthetic patients whose visit the E2E doctor signs with CBC, RBS and
   S. Electrolytes (the walkthrough's A5 orders). Walkthrough and safety checks:
   - A8 tube guidance (EDTA / fluoride / plain), labels with an audited print, partial collection, reject with a reason →
     a new tube and the recollection SMS (fixed text, no results);
   - A9 entry: every analyte, non-numbers / negatives refused, a critical value typed twice, flags against the patient's
     range ("adult female range"), delta check against the previous validated result (its read audited);
   - A10 technical verify (PIN, delta tick) then clinical validation by a pathologist, locked until a reached + read-back
     call-back for the critical result (attempts do not count), never by the verifier on a Hospital plan;
   - release in versions: a critical test goes out early ("PRELIMINARY — n of m"), final when all are validated, a
     correction is a new result version and a "corrected" report version, the doctor's inbox is told;
   - A11 delivery: SMS (fixed text) and patient app per version, a failed SMS retried with the same message id;
   - ORDER revoke: the ordering doctor or the lab, reason ≥10, before collection, billing's draft refreshed;
   - roles, another tenant, idempotent replay, the database refusing an edit of a result. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeMessenger } from "../src/adapters/messaging/index.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("lab.test: DATABASE_URL_APP not set — lab contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const cookies: Record<string, string> = {};
const T = "t_e2e";
const USERS = {
  desk: "01799000001", doctor: "01799000002", doctor2: "01799000003", tech: "01799000005", path: "01799000006", cashier: "01799000008", admin: "01799000010", otherTech: "01711000005",
} as const;
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

const get = (url: string, who: Who = "tech") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const post = (url: string, payload: object = {}, who: Who = "tech", key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const inTenant = <R>(fn: (tx: NonNullable<typeof db>["prisma"]) => Promise<R>) => db!.forTenant(T, fn as never) as Promise<R>;
const now = () => new Date().toISOString();
const ok = <R>(r: { statusCode: number; body: string; json: () => R }, code = 200) => { expect(r.statusCode, r.body).toBe(code); return r.json(); };

type View = {
  encounter: { id: string }; patient: { id: string; ageYears: number | null }; samePersonAllowed: boolean; collection: string;
  tubes: { tube: string; orderIds: string[]; specimenId: string | null; recollect: boolean }[];
  specimens: { id: string; number: string; tube: string; status: string; orderIds: string[]; labelPrints: number }[];
  orders: { id: string; testCode: string; status: string; tube: string | null; specimen: { id: string; status: string } | null;
    template: { analyteCode: string; range: { low: number; high: number; label: string } | null; previous: { value: number } | null }[];
    results: { id: string; analyteCode: string; value: number; flag: string | null; status: string; range: { label: string } | null; delta: { pct: number; hit: boolean } | null; replacesId: string | null; released: boolean; callbacks: { outcome: string }[] }[] }[];
  release: { status: string; pending: number; total: number; observationIds: string[]; orderIds: string[]; blockers: string[] };
  reports: { id: string; number: string; version: number; status: string; pendingCount: number; testCount: number; supersededById: string | null }[];
  communications: { id: string; kind: string; channel: string; status: string; attempts: number; lastError: string | null; recipient: { id: string } | null; reportId: string | null; toPhone: string | null }[];
  bill: { status: string } | null;
};

/** A new synthetic woman (or a new visit for `patientId`), signed by the E2E doctor with CBC, RBS and S. Electrolytes. */
async function signedVisit(patientId?: string, tests = ["cbc", "rbs", "elec"]) {
  let enc: string, patient: string;
  if (patientId) {
    const r = ok<{ encounter: { id: string } }>(await post("/v1/encounters", { patientId }, "desk"), 201);
    enc = r.encounter.id; patient = patientId;
  } else {
    const r = ok<{ encounter: { id: string }; patient: { id: string } }>(await post("/v1/patients", {
      nameBn: "লাবনী আক্তার", nameEn: `Lab Patient ${RUN}`, sex: "female", dobMode: "dob", dob: "03/03/1991", phone: `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self",
      division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
    }, "desk"), 201);
    enc = r.encounter.id; patient = r.patient.id;
  }
  const v = ok<{ draft: { id: string } }>(await post(`/v1/encounters/${enc}/consultation/open`, {}, "doctor"));
  const saved = await app.inject({ method: "PUT", url: `/v1/compositions/${v.draft.id}`, headers: { cookie: cookies.doctor!, "idempotency-key": randomUUID() }, payload: {
    rev: 1, sections: { complaints: [{ text: "Tiredness", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" },
    sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }],
    orders: tests.map((testCode) => ({ testCode, priority: "routine" })),
  } });
  expect(saved.statusCode, saved.body).toBe(200);
  ok(await post(`/v1/compositions/${v.draft.id}/sign`, { rev: saved.json().rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }, "doctor"));
  return { enc, patient };
}
const view = async (enc: string, who: Who = "tech") => ok<View>(await get(`/v1/lab/visits/${enc}`, who));
const order = (v: View, testCode: string) => v.orders.find((o) => o.testCode === testCode)!;
/** Labels, collect, receive and start every tube the visit needs. */
async function toInProcess(enc: string) {
  let v = ok<View>(await post(`/v1/lab/visits/${enc}/labels`, {}));
  for (const sp of v.specimens.filter((x) => x.status === "pending")) {
    ok(await post(`/v1/lab/specimens/${sp.id}/collect`, { at: now() }));
    ok(await post(`/v1/lab/specimens/${sp.id}/receive`, { at: now() }));
    v = ok<View>(await post(`/v1/lab/specimens/${sp.id}/start`, { at: now() }));
  }
  return v;
}
const WALK = { cbc: [["hb", "9.6"], ["wbc", "11800"], ["plt", "245000"]], rbs: [["rbs", "11.2"]], elec: [["na", "138"], ["k", "6.9", "6.9"], ["cl", "101"]] } as const;
async function enter(enc: string, testCode: keyof typeof WALK, values = WALK[testCode]) {
  const v = await view(enc);
  return ok<View>(await post(`/v1/lab/orders/${order(v, testCode).id}/results`, { entries: values.map(([analyteCode, value, confirm]) => ({ analyteCode, value, ...(confirm ? { confirm } : {}) })) }), 201);
}
const current = (v: View, testCode: string) => order(v, testCode).results.filter((r) => r.status !== "entered-in-error");
const idsOf = (v: View, testCodes: string[], status: string) => testCodes.flatMap((t) => current(v, t).filter((r) => r.status === status).map((r) => r.id));
const verify = (enc: string, ids: string[], who: Who = "tech", extra: object = {}) => post(`/v1/lab/visits/${enc}/verify`, { pin: "1234", observationIds: ids, deltaChecked: true, ...extra }, who);
const validate = (enc: string, ids: string[], who: Who = "path") => post(`/v1/lab/visits/${enc}/validate`, { pin: "1234", observationIds: ids }, who);
const callback = (obsId: string, extra: object = {}, who: Who = "tech") =>
  post(`/v1/lab/observations/${obsId}/callbacks`, { outcome: "reached", recipientRole: "ordering-doctor", recipientName: "Dr. Test", via: "phone", calledAt: now(), readBack: true, ...extra }, who);
/** Everything entered, verified, called back and validated for the given tests. */
async function validated(enc: string, tests: (keyof typeof WALK)[]) {
  for (const t of tests) await enter(enc, t);
  let v = await view(enc);
  ok(await verify(enc, idsOf(v, tests, "preliminary")));
  v = await view(enc);
  for (const r of tests.flatMap((t) => current(v, t)).filter((r) => r.flag === "HH" || r.flag === "LL")) ok(await callback(r.id), 201);
  return ok<View>(await validate(enc, idsOf(await view(enc), tests, "verified")));
}
const release = async (enc: string, who: Who = "path") => { const v = await view(enc); return post(`/v1/lab/visits/${enc}/release`, { observationIds: v.release.observationIds }, who); };

describe.runIf(db)("A8 collection: tubes, labels, partial collection, reject", () => {
  it("the A5 orders need EDTA (CBC), fluoride (RBS) and plain (electrolytes) tubes; labels are numbered and audited; a reprint counts copies", async () => {
    const { enc, patient } = await signedVisit();
    const v0 = await view(enc);
    expect(v0.collection).toBe("pending");
    expect(Object.fromEntries(v0.orders.map((o) => [o.testCode, o.tube]))).toEqual({ cbc: "edta", rbs: "fluoride", elec: "plain" });
    expect(v0.tubes.map((t) => t.tube).sort()).toEqual(["edta", "fluoride", "plain"]);
    const v1 = ok<View>(await post(`/v1/lab/visits/${enc}/labels`, {}));
    expect(v1.specimens).toHaveLength(3);
    for (const sp of v1.specimens) expect(sp.number).toMatch(/^S-\d{4}-\d{4}$/);
    const v2 = ok<View>(await post(`/v1/lab/visits/${enc}/labels`, { tubes: ["edta"] }));
    expect(v2.specimens.find((x) => x.tube === "edta")!.labelPrints).toBe(2);
    const audits = await inTenant((tx) => tx.auditEvent.findMany({ where: { patientId: patient, entity: "Specimen" }, select: { action: true } }));
    expect(audits.map((a) => a.action).sort()).toEqual(["print", "print", "print", "reprint"]);
    // collecting one tube: partially collected; that order is in progress, the others still placed
    const edta = v2.specimens.find((x) => x.tube === "edta")!;
    const v3 = ok<View>(await post(`/v1/lab/specimens/${edta.id}/collect`, { at: now() }));
    expect(v3.collection).toBe("partial");
    expect(Object.fromEntries(v3.orders.map((o) => [o.testCode, o.status]))).toEqual({ cbc: "in-progress", rbs: "active", elec: "active" });
    // the worklist shows it under collection with 2 tubes still needed
    const w = ok<{ items: { encounter: { id: string }; collection: string; counts: { tubesNeeded: number } }[] }>(await get("/v1/lab/worklist?stage=collect"));
    expect(w.items.find((i) => i.encounter.id === enc)).toMatchObject({ collection: "partial", counts: { tubesNeeded: 2 } });
  });
  it("reject (haemolysed) → the tube is rejected, its test needs a new tube, the recollection SMS has the fixed text only", async () => {
    const { enc } = await signedVisit();
    const v = await toInProcess(enc);
    const fluoride = v.specimens.find((x) => x.tube === "fluoride")!;
    const bad = await post(`/v1/lab/specimens/${fluoride.id}/reject`, { reason: "other", note: "short", at: now() });
    expect(bad.statusCode).toBe(400);
    const r = ok<View>(await post(`/v1/lab/specimens/${fluoride.id}/reject`, { reason: "haemolysed", at: now() }));
    expect(r.specimens.find((x) => x.id === fluoride.id)!.status).toBe("rejected");
    expect(r.tubes).toEqual([{ tube: "fluoride", orderIds: [order(r, "rbs").id], specimenId: null, recollect: true }]);
    const sms = r.communications.find((c) => c.kind === "recollect")!;
    expect(sms).toMatchObject({ channel: "sms", status: "completed", attempts: 1 });
    const sent = fakeMessenger()!.log().filter((m) => m.messageId === sms.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("E2E Test Clinic");
    expect(sent[0]!.text).not.toMatch(/RBS|sugar|glucose|haemoly|Lab Patient|11\.2/i);
    // a new label for the recollection is a new tube
    const again = ok<View>(await post(`/v1/lab/visits/${enc}/labels`, {}));
    expect(again.specimens.filter((x) => x.tube === "fluoride").map((x) => x.status).sort()).toEqual(["pending", "rejected"]);
  });
  it("a step at an impossible time is refused; a step out of order is a 409", async () => {
    const { enc } = await signedVisit();
    const v = ok<View>(await post(`/v1/lab/visits/${enc}/labels`, {}));
    const sp = v.specimens[0]!;
    expect((await post(`/v1/lab/specimens/${sp.id}/collect`, { at: new Date(Date.now() + 3600_000).toISOString() })).statusCode).toBe(400);
    expect((await post(`/v1/lab/specimens/${sp.id}/receive`, { at: now() })).json().code).toBe("invalid_transition");
  });
});

describe.runIf(db)("A9 result entry", () => {
  it("walkthrough values: Hb 9.6 L against the adult female range, WBC H, K 6.9 HH typed twice; Enter-to-next is the screen's", async () => {
    const { enc } = await signedVisit();
    await toInProcess(enc);
    const v = await enter(enc, "cbc");
    const cbc = current(v, "cbc");
    expect(Object.fromEntries(cbc.map((r) => [r.analyteCode, r.flag]))).toEqual({ hb: "L", wbc: "H", plt: "N" });
    expect(cbc.find((r) => r.analyteCode === "hb")!.range!.label).toBe("adult-female");
    expect(cbc.every((r) => r.status === "preliminary")).toBe(true);
    const e = await enter(enc, "elec");
    expect(current(e, "elec").find((r) => r.analyteCode === "k")!.flag).toBe("HH");
    // the CBC tube is done once its test has results
    expect(e.specimens.find((x) => x.tube === "edta")!.status).toBe("done");
  });
  it("every analyte, numbers only, critical typed twice; results only once (then corrections); only from a tube in process", async () => {
    const { enc } = await signedVisit();
    const v0 = ok<View>(await post(`/v1/lab/visits/${enc}/labels`, {}));
    const cbcId = order(v0, "cbc").id;
    expect((await post(`/v1/lab/orders/${cbcId}/results`, { entries: [{ analyteCode: "hb", value: "9.6" }] })).json().code).toBe("specimen_not_in_process");
    await toInProcess(enc);
    const missing = await post(`/v1/lab/orders/${cbcId}/results`, { entries: [{ analyteCode: "hb", value: "9.6" }] });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().fields).toEqual([{ field: "wbc", code: "required" }, { field: "plt", code: "required" }]);
    const nan = await post(`/v1/lab/orders/${cbcId}/results`, { entries: [{ analyteCode: "hb", value: "abc" }, { analyteCode: "wbc", value: "-5" }, { analyteCode: "plt", value: "245000" }] });
    expect(nan.json().fields).toEqual([{ field: "hb", code: "not_a_number" }, { field: "wbc", code: "negative" }]);
    const elecId = order(await view(enc), "elec").id;
    const crit = await post(`/v1/lab/orders/${elecId}/results`, { entries: [{ analyteCode: "na", value: "138" }, { analyteCode: "k", value: "6.9" }, { analyteCode: "cl", value: "101" }] });
    expect(crit.json().fields).toEqual([{ field: "k", code: "confirm_required" }]);
    await enter(enc, "elec");
    expect((await post(`/v1/lab/orders/${elecId}/results`, { entries: [{ analyteCode: "na", value: "138" }, { analyteCode: "k", value: "4", }, { analyteCode: "cl", value: "101" }] })).json().code).toBe("already_entered");
  });
  it("a replay with the same Idempotency-Key returns the stored answer and writes nothing twice", async () => {
    const { enc } = await signedVisit();
    await toInProcess(enc);
    const id = order(await view(enc), "rbs").id, key = randomUUID();
    const a = await post(`/v1/lab/orders/${id}/results`, { entries: [{ analyteCode: "rbs", value: "11.2" }] }, "tech", key);
    const b = await post(`/v1/lab/orders/${id}/results`, { entries: [{ analyteCode: "rbs", value: "11.2" }] }, "tech", key);
    expect(a.statusCode).toBe(201);
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect(await inTenant((tx) => tx.observation.count({ where: { serviceRequestId: id } }))).toBe(1);
  });
  it("delta check: a second visit compares with the first visit's validated results; reading them is audited", async () => {
    const first = await signedVisit();
    await toInProcess(first.enc);
    await validated(first.enc, ["cbc", "rbs", "elec"]);
    const second = await signedVisit(first.patient);
    await toInProcess(second.enc);
    const v0 = await view(second.enc);
    expect(order(v0, "cbc").template.find((t) => t.analyteCode === "hb")!.previous).toEqual(expect.objectContaining({ value: 9.6 }));
    const v = await enter(second.enc, "cbc", [["hb", "12.1"], ["wbc", "8200"], ["plt", "260000"]]);
    const hb = current(v, "cbc").find((r) => r.analyteCode === "hb")!;
    expect(hb.delta).toEqual({ prevValue: 9.6, prevAt: expect.any(String), pct: 26, hit: true });
    expect(current(v, "cbc").find((r) => r.analyteCode === "wbc")!.delta).toBeNull(); // WBC is not delta-checked
    const audit = await inTenant((tx) => tx.auditEvent.findFirst({ where: { entityId: second.enc, action: "view" }, orderBy: { at: "desc" } }));
    expect(audit!.detail).toMatchObject({ deltaHistory: true });
    // verifying needs the "sample identity checked" tick when the delta check warned
    const ids = idsOf(v, ["cbc"], "preliminary");
    const blocked = await verify(second.enc, ids, "tech", { deltaChecked: false });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().blockers[0]).toMatchObject({ code: "delta_unchecked", observationId: hb.id });
    ok(await verify(second.enc, ids));
  });
});

describe.runIf(db)("A10 technical verify, critical call-back, clinical validation", () => {
  it("wrong PIN refuses and changes nothing; validation is locked until the call-back for K 6.9 is logged; an attempt does not unlock it", async () => {
    const { enc } = await signedVisit();
    await toInProcess(enc);
    let v = await enter(enc, "elec");
    const ids = idsOf(v, ["elec"], "preliminary");
    const wrong = await post(`/v1/lab/visits/${enc}/verify`, { pin: "9999", observationIds: ids, deltaChecked: true });
    expect(wrong.statusCode).toBe(401);
    expect(current(await view(enc), "elec").every((r) => r.status === "preliminary")).toBe(true);
    expect((await verify(enc, ids.slice(0, 1))).json().code).toBe("whole_test");
    ok(await verify(enc, ids));
    v = await view(enc);
    const k = current(v, "elec").find((r) => r.analyteCode === "k")!;
    const lab = await validate(enc, idsOf(v, ["elec"], "verified"), "tech");
    expect(lab.statusCode).toBe(403);
    const locked = await validate(enc, idsOf(v, ["elec"], "verified"));
    expect(locked.statusCode).toBe(422);
    expect(locked.json()).toMatchObject({ code: "validate_blocked", message_en: "Critical value: log the call-back first", blockers: [{ code: "callback_missing", observationId: k.id }] });
    ok(await callback(k.id, { outcome: "no-answer", readBack: false, recipientName: "Dr. Test (no answer)" }), 201);
    expect((await validate(enc, idsOf(v, ["elec"], "verified"))).statusCode).toBe(422);
    expect((await callback(k.id, { readBack: false })).json().code).toBe("read_back_required");
    expect((await callback(k.id, { calledAt: new Date(Date.now() + 3600_000).toISOString() })).json().code).toBe("time_future");
    expect((await callback(current(v, "elec").find((r) => r.analyteCode === "na")!.id)).json().code).toBe("not_critical");
    ok(await callback(k.id), 201);
    const done = ok<View>(await validate(enc, idsOf(v, ["elec"], "verified")));
    expect(current(done, "elec").every((r) => r.status === "final")).toBe(true);
    expect(current(done, "elec").find((r) => r.analyteCode === "k")!.callbacks.map((c) => c.outcome)).toEqual(["no-answer", "reached"]);
    // nothing was released by validating
    expect(done.reports).toEqual([]);
  });
  it("Hospital plan: the person who verified may not validate; a facility setting can allow it", async () => {
    const { enc } = await signedVisit();
    await toInProcess(enc);
    await enter(enc, "rbs");
    ok(await verify(enc, idsOf(await view(enc), ["rbs"], "preliminary"), "path"));
    const ids = idsOf(await view(enc), ["rbs"], "verified");
    const same = await validate(enc, ids);
    expect(same.json()).toMatchObject({ code: "validate_blocked", blockers: [{ code: "same_person" }] });
    try {
      await inTenant((tx) => tx.organization.update({ where: { id: "o_e2e" }, data: { labSamePersonAllowed: true } }));
      expect((await view(enc, "path")).samePersonAllowed).toBe(true);
      ok(await validate(enc, ids));
    } finally {
      await inTenant((tx) => tx.organization.update({ where: { id: "o_e2e" }, data: { labSamePersonAllowed: null } }));
    }
  });
});

describe.runIf(db)("release in versions (D3), corrections (D4), the doctor's inbox (D6)", () => {
  it("the critical electrolytes go out first (PRELIMINARY 1 of 3 pending... 2 of 3), then final; nothing new → refused; a stale preview → 409", async () => {
    const { enc } = await signedVisit();
    await toInProcess(enc);
    await enter(enc, "cbc");
    await validated(enc, ["elec"]);
    const stale = await post(`/v1/lab/visits/${enc}/release`, { observationIds: [current(await view(enc), "elec")[0]!.id] }, "path");
    expect(stale.statusCode).toBe(409);
    const v1 = ok<View>(await release(enc), 201);
    expect(v1.reports).toEqual([expect.objectContaining({ version: 1, status: "preliminary", pendingCount: 2, testCount: 3 })]);
    expect(v1.reports[0]!.number).toMatch(/^LR\/\d{2}\/\d{4}$/);
    expect(order(v1, "elec").status).toBe("complete");
    expect(order(v1, "cbc").status).toBe("in-progress");
    expect(v1.communications.filter((c) => c.kind === "report-inbox")).toEqual([expect.objectContaining({ channel: "doctor-inbox", status: "completed", recipient: expect.objectContaining({ id: "u_e2e_doctor" }), reportId: v1.reports[0]!.id })]);
    expect((await release(enc)).json()).toMatchObject({ code: "release_blocked", blockers: [{ code: "nothing_new" }] });
    // the rest validated → version 2 final, version 1 superseded
    const vv = await view(enc);
    ok(await verify(enc, idsOf(vv, ["cbc"], "preliminary")));
    ok(await validate(enc, idsOf(await view(enc), ["cbc"], "verified")));
    await validated(enc, ["rbs"]);
    const v2 = ok<View>(await release(enc), 201);
    expect(v2.reports.map((r) => [r.version, r.status, r.pendingCount])).toEqual([[1, "superseded", 2], [2, "final", 0]]);
    expect(v2.reports[0]!.supersededById).toBe(v2.reports[1]!.id);
    expect(v2.reports[1]!.number).toBe(v2.reports[0]!.number);
    // the released version is a snapshot
    const rep = ok<{ report: { version: number }; tests: { testCode: string }[]; pendingTests: unknown[] }>(await get(`/v1/lab/reports/${v1.reports[0]!.id}`, "path"));
    expect(rep.tests.map((t) => t.testCode)).toEqual(["elec"]);
    expect(rep.pendingTests).toHaveLength(2);
  });
  it("a correction after release: the old value entered-in-error with the reason, the doctor told, verify + validate again, version 3 Corrected", async () => {
    const { enc } = await signedVisit(undefined, ["rbs", "elec"]);
    await toInProcess(enc);
    await validated(enc, ["rbs", "elec"]);
    const v2 = ok<View>(await release(enc), 201);
    const na = current(v2, "elec").find((r) => r.analyteCode === "na")!;
    expect((await post(`/v1/lab/observations/${na.id}/correct`, { value: "128", reason: "typo" })).json().code).toBe("reason_required");
    expect((await post(`/v1/lab/observations/${na.id}/correct`, { value: "138", reason: "transcription error" })).json().code).toBe("same_value");
    expect((await post(`/v1/lab/observations/${na.id}/correct`, { value: "128", reason: "transcription error" }, "path")).statusCode).toBe(403);
    const c = ok<View>(await post(`/v1/lab/observations/${na.id}/correct`, { value: "128", reason: "transcription error" }), 201);
    const rows = order(c, "elec").results.filter((r) => r.analyteCode === "na");
    expect(rows.map((r) => [r.value, r.status, r.replacesId])).toEqual([[138, "entered-in-error", null], [128, "preliminary", na.id]]);
    expect(c.communications.find((x) => x.kind === "correction-notice")).toMatchObject({ channel: "doctor-inbox", status: "completed", recipient: expect.objectContaining({ id: "u_e2e_doctor" }) });
    // the released version marks the value as under correction (do not act on it)
    const rep = ok<{ tests: { results: { id: string; underCorrection: boolean }[] }[] }>(await get(`/v1/lab/reports/${v2.reports[0]!.id}`, "path"));
    expect(rep.tests.flatMap((t) => t.results).find((r) => r.id === na.id)!.underCorrection).toBe(true);
    // electrolytes are pending again until the corrected value is verified and validated
    expect(c.release).toMatchObject({ orderIds: [expect.any(String)], pending: 1 });
    ok(await verify(enc, idsOf(c, ["elec"], "preliminary")));
    ok(await validate(enc, idsOf(await view(enc), ["elec"], "verified")));
    const v3 = ok<View>(await release(enc), 201);
    expect(v3.reports.map((r) => r.status)).toEqual(["superseded", "corrected"]);
    // the database never changes a result's value, not even for the API's role
    await expect(inTenant((tx) => tx.observation.update({ where: { id: rows[1]!.id }, data: { value: 130 } }))).rejects.toThrow();
  });
});

describe.runIf(db)("send-back (decision 119) and withdraw results (decision 133)", () => {
  it("the pathologist returns a verified test with a reason; it waits as 'Returned' and must be verified again before validation", async () => {
    const { enc } = await signedVisit(undefined, ["rbs", "elec"]);
    await toInProcess(enc);
    await enter(enc, "rbs");
    let v = await view(enc);
    ok(await verify(enc, idsOf(v, ["rbs"], "preliminary")));
    const rbs = order(await view(enc), "rbs").id;
    expect((await post(`/v1/lab/orders/${rbs}/return`, { reason: "recheck" }, "path")).json().code).toBe("reason_required");
    expect((await post(`/v1/lab/orders/${rbs}/return`, { reason: "value does not fit the clinical note" }, "tech")).statusCode).toBe(403);
    v = ok<View>(await post(`/v1/lab/orders/${rbs}/return`, { reason: "value does not fit the clinical note" }, "path"));
    const r = current(v, "rbs")[0]! as unknown as { status: string; verifiedBy: unknown; returned: { reason: string } };
    expect(r).toMatchObject({ status: "preliminary", verifiedBy: null, returned: { reason: "value does not fit the clinical note" } });
    expect((order(v, "rbs") as unknown as { returned: { reason: string } }).returned.reason).toBe("value does not fit the clinical note");
    const w = ok<{ items: { encounter: { id: string }; returned: { reason: string }[] }[] }>(await get("/v1/lab/worklist?stage=result"));
    expect(w.items.find((i) => i.encounter.id === enc)!.returned).toEqual([expect.objectContaining({ reason: "value does not fit the clinical note" })]);
    expect((await post(`/v1/lab/orders/${rbs}/return`, { reason: "value does not fit the clinical note" }, "path")).json().code).toBe("not_verified");
    expect((await validate(enc, idsOf(v, ["rbs"], "preliminary"))).statusCode).toBe(422);
    ok(await verify(enc, idsOf(v, ["rbs"], "preliminary")));
    const done = ok<View>(await validate(enc, idsOf(await view(enc), ["rbs"], "verified")));
    expect(current(done, "rbs")[0]!.status).toBe("final");
  });
  it("withdrawing released results: entered-in-error with no replacement, the tube rejected, a new tube and the recollection SMS, the doctor told, the released version says withdrawn", async () => {
    const { enc } = await signedVisit(undefined, ["rbs", "elec"]);
    await toInProcess(enc);
    await validated(enc, ["rbs"]);
    const v1 = ok<View>(await release(enc), 201);
    const rbs = order(v1, "rbs").id;
    expect((await post(`/v1/lab/orders/${rbs}/withdraw`, { reason: "short" })).json().code).toBe("reason_required");
    expect((await post(`/v1/lab/orders/${rbs}/withdraw`, { reason: "tube belonged to another patient" }, "admin")).statusCode).toBe(403);
    const w = ok<View>(await post(`/v1/lab/orders/${rbs}/withdraw`, { reason: "tube belonged to another patient" }));
    expect(order(w, "rbs").results.map((r) => r.status)).toEqual(["entered-in-error"]);
    expect((order(w, "rbs") as unknown as { withdrawn: { reason: string } }).withdrawn.reason).toBe("tube belonged to another patient");
    expect(w.specimens.find((x) => x.tube === "fluoride")).toMatchObject({ status: "rejected" });
    expect(w.tubes).toEqual([{ tube: "fluoride", orderIds: [rbs], specimenId: null, recollect: true }]);
    expect(w.communications.find((c) => c.kind === "recollect")).toMatchObject({ channel: "sms", status: "completed" });
    expect(w.communications.find((c) => c.kind === "results-withdrawn")).toMatchObject({ channel: "doctor-inbox", recipient: expect.objectContaining({ id: "u_e2e_doctor" }) });
    const rep = ok<{ tests: { testCode: string; withdrawn: boolean; results: { withdrawn: boolean; underCorrection: boolean }[] }[] }>(await get(`/v1/lab/reports/${v1.reports[0]!.id}`, "path"));
    expect(rep.tests.find((t) => t.testCode === "rbs")).toMatchObject({ withdrawn: true, results: [{ withdrawn: true, underCorrection: true }] });
    expect((await post(`/v1/lab/orders/${rbs}/withdraw`, { reason: "tube belonged to another patient" })).json().code).toBe("nothing_to_withdraw");
    // the next version (electrolytes) is Corrected: a released value was taken back
    await validated(enc, ["elec"]);
    const v2 = ok<View>(await release(enc), 201);
    expect(v2.reports.map((r) => [r.status, r.pendingCount])).toEqual([["superseded", 1], ["corrected", 1]]);
    // the database rejects a finished tube only for a withdrawal
    const plain = v2.specimens.find((x) => x.tube === "plain")!;
    await expect(inTenant((tx) => tx.specimen.update({ where: { id: plain.id }, data: { status: "rejected", rejectedById: "u_e2e_labtech", rejectedAt: new Date(), rejectReason: "haemolysed" } }))).rejects.toThrow();
  });
});

describe.runIf(db)("fixes from the clinical-safety and security reviews", () => {
  it("clinical H1: after released results are withdrawn, a new tube can be labelled, collected and the test released again (Corrected)", async () => {
    const { enc } = await signedVisit(undefined, ["rbs"]);
    await toInProcess(enc);
    await validated(enc, ["rbs"]);
    ok(await release(enc), 201);
    const rbs = order(await view(enc), "rbs").id;
    ok(await post(`/v1/lab/orders/${rbs}/withdraw`, { reason: "tube belonged to another patient" }));
    const v = await toInProcess(enc);
    expect(v.specimens.filter((x) => x.tube === "fluoride").map((x) => x.status).sort()).toEqual(["in-process", "rejected"]);
    await validated(enc, ["rbs"]);
    const v2 = ok<View>(await release(enc), 201);
    expect(v2.reports.map((r) => r.status)).toEqual(["superseded", "corrected"]);
    expect(current(v2, "rbs").map((r) => r.status)).toEqual(["final"]);
  });
  it("clinical H2: a tube with results still current cannot be rejected (withdraw first); a tube never collected is rejected without an SMS", async () => {
    const { enc } = await signedVisit(undefined, ["rbs", "elec"]);
    await toInProcess(enc);
    await enter(enc, "rbs");
    const v = await view(enc);
    const fl = v.specimens.find((x) => x.tube === "fluoride")!;
    expect((await post(`/v1/lab/specimens/${fl.id}/reject`, { reason: "haemolysed", at: now() })).json().code).toBe("results_entered");
    const { enc: enc2 } = await signedVisit(undefined, ["rbs"]);
    const p = ok<View>(await post(`/v1/lab/visits/${enc2}/labels`, {}));
    const r = ok<View>(await post(`/v1/lab/specimens/${p.specimens[0]!.id}/reject`, { reason: "insufficient", at: now() }));
    expect(r.communications.filter((c) => c.kind === "recollect")).toEqual([]);
  });
  it("clinical H3: correcting a critical value the doctor was phoned about tells the doctor even before release", async () => {
    const { enc } = await signedVisit(undefined, ["elec"]);
    await toInProcess(enc);
    let v = await enter(enc, "elec");
    const k = current(v, "elec").find((r) => r.analyteCode === "k")!;
    ok(await callback(k.id), 201);
    v = ok<View>(await post(`/v1/lab/observations/${k.id}/correct`, { value: "4.2", reason: "wrong tube was measured" }), 201);
    expect(v.reports).toEqual([]);
    expect(v.communications.find((c) => c.kind === "correction-notice")).toMatchObject({ channel: "doctor-inbox", recipient: expect.objectContaining({ id: "u_e2e_doctor" }) });
  });
  it("clinical M2: a value with more decimals than the analyte reports is refused", async () => {
    const { enc } = await signedVisit(undefined, ["elec"]);
    await toInProcess(enc);
    const id = order(await view(enc), "elec").id;
    const r = await post(`/v1/lab/orders/${id}/results`, { entries: [{ analyteCode: "na", value: "119.6" }, { analyteCode: "k", value: "4.2" }, { analyteCode: "cl", value: "101" }] });
    expect(r.json().fields).toEqual([{ field: "na", code: "too_many_decimals" }]);
  });
  it("security M1: the lab cannot cancel an imaging order", async () => {
    const { enc } = await signedVisit(undefined, ["rbs", "cxr"]);
    const cxr = await inTenant((tx) => tx.serviceRequest.findFirst({ where: { encounterId: enc, testCode: "cxr" } }));
    expect((await post(`/v1/orders/${cxr!.id}/revoke`, { reason: "not done in this lab" }, "tech")).statusCode).toBe(403);
    expect((await post(`/v1/orders/${cxr!.id}/revoke`, { reason: "not needed after all" }, "doctor")).statusCode).toBe(200);
  });
  it("security L1: the database refuses a verification recorded in someone else's name", async () => {
    const { enc } = await signedVisit(undefined, ["rbs"]);
    await toInProcess(enc);
    const v = await enter(enc, "rbs");
    const r = current(v, "rbs")[0]!;
    // inTenant runs as setu_app without a signed-in user
    await expect(inTenant((tx) => tx.observation.update({ where: { id: r.id }, data: { status: "verified", verifiedById: "u_e2e_labtech", verifiedAt: new Date() } }))).rejects.toThrow(/someone other than the signed-in user/);
  });
  it("security L6: a step cannot be dated before the step before it", async () => {
    const { enc } = await signedVisit(undefined, ["rbs"]);
    const p = ok<View>(await post(`/v1/lab/visits/${enc}/labels`, {}));
    expect((await post(`/v1/lab/specimens/${p.specimens[0]!.id}/collect`, { at: new Date(Date.now() - 30 * 60_000).toISOString() })).json().code).toBe("time_order");
  });
  it("security M3: a message left queued by an interrupted send can be retried after a while; a fresh one is still sending", async () => {
    const { enc, patient } = await signedVisit(undefined, ["rbs"]);
    await toInProcess(enc);
    const base = { tenantId: T, organizationId: "o_e2e", patientId: patient, encounterId: enc, kind: "recollect", channel: "sms" as const, toPhone: "01911000001", templateKey: "sms_recollect", text: "E2E Test Clinic: test", createdById: "u_e2e_labtech" };
    const stuck = await inTenant((tx) => tx.communication.create({ data: { ...base, id: `com_${randomUUID()}`, createdAt: new Date(Date.now() - 5 * 60_000) } }));
    const fresh = await inTenant((tx) => tx.communication.create({ data: { ...base, id: `com_${randomUUID()}` } }));
    expect((await post(`/v1/lab/communications/${fresh.id}/retry`, {})).json().code).toBe("still_sending");
    const v = ok<View>(await post(`/v1/lab/communications/${stuck.id}/retry`, {}));
    expect(v.communications.find((c) => c.id === stuck.id)).toMatchObject({ status: "completed", attempts: 1 });
  });
  it("security M4: the dev message list shows this tenant's messages only, numbers masked", async () => {
    const r = ok<{ messages: { to: string }[] }>(await get("/v1/dev/fake-messenger/messages"));
    expect(r.messages.length).toBeGreaterThan(0);
    for (const m of r.messages) expect(m.to).toMatch(/^\d{3}\*{5}\d{3}$/);
    const other = ok<{ messages: unknown[] }>(await get("/v1/dev/fake-messenger/messages", "otherTech"));
    expect(other.messages).toEqual([]);
  });
});

describe.runIf(db)("A11 delivery per channel, retry with the same message id", () => {
  it("SMS (fixed text) and patient app for the current version; a failed SMS is retried and delivered once; a superseded version is not sent", async () => {
    const { enc } = await signedVisit(undefined, ["rbs"]);
    await toInProcess(enc);
    await validated(enc, ["rbs"]);
    const v = ok<View>(await release(enc), 201);
    const rep = v.reports[0]!.id;
    expect((await post(`/v1/lab/reports/${rep}/send`, { channel: "sms" }, "path")).statusCode).toBe(403); // delivery: lab technologist / admin
    ok(await post("/v1/dev/fake-messenger/fail-next", { n: 1 }, "tech", null));
    const failed = ok<View>(await post(`/v1/lab/reports/${rep}/send`, { channel: "sms" }));
    const sms = failed.communications.find((c) => c.kind === "report-ready")!;
    expect(sms).toMatchObject({ status: "failed", attempts: 1, lastError: "number unreachable" });
    expect((await post(`/v1/lab/reports/${rep}/send`, { channel: "sms" })).json().code).toBe("retry_instead");
    const retried = ok<View>(await post(`/v1/lab/communications/${sms.id}/retry`, {}));
    expect(retried.communications.find((c) => c.id === sms.id)).toMatchObject({ status: "completed", attempts: 2, lastError: null });
    expect(fakeMessenger()!.deliveredMessages().filter((m) => m.messageId === sms.id)).toHaveLength(1);
    const text = fakeMessenger()!.log().find((m) => m.messageId === sms.id)!.text;
    expect(text).toContain("lab report is ready");
    expect(text).not.toMatch(/11\.2|RBS|sugar|Lab Patient/i);
    expect((await post(`/v1/lab/communications/${sms.id}/retry`, {})).json().code).toBe("invalid_transition");
    expect((await post(`/v1/lab/reports/${rep}/send`, { channel: "sms" })).json().code).toBe("already_sent");
    const app_ = ok<View>(await post(`/v1/lab/reports/${rep}/send`, { channel: "patient-app" }, "admin"));
    expect(app_.communications.find((c) => c.kind === "report-app")).toMatchObject({ channel: "patient-app", status: "completed" });
    // the delivery worklist lists the visit with its current report
    const w = ok<{ items: { encounter: { id: string }; report: { status: string } | null }[] }>(await get("/v1/lab/worklist?stage=delivery"));
    expect(w.items.find((i) => i.encounter.id === enc)!.report).toMatchObject({ status: "final" });
  });
});

describe.runIf(db)("ORDER revoke (D5) and billing's order refresh (decision 99)", () => {
  it("the ordering doctor cancels RBS before collection with a reason; the draft bill drops the line; another doctor or the admin cannot", async () => {
    const { enc } = await signedVisit();
    const bill = ok<{ invoice: { id: string; totalPaisa: number } }>(await post(`/v1/encounters/${enc}/invoice`, {}, "cashier"), 201);
    expect(bill.invoice.totalPaisa).toBe(230_000);
    const rbs = order(await view(enc), "rbs").id;
    expect((await post(`/v1/orders/${rbs}/revoke`, { reason: "too short" }, "doctor")).json().code).toBe("reason_required");
    expect((await post(`/v1/orders/${rbs}/revoke`, { reason: "ordered twice by mistake" }, "doctor2")).statusCode).toBe(403);
    expect((await post(`/v1/orders/${rbs}/revoke`, { reason: "ordered twice by mistake" }, "admin")).statusCode).toBe(403);
    expect((await post(`/v1/orders/${rbs}/revoke`, { reason: "ordered twice by mistake" }, "cashier")).statusCode).toBe(403);
    const r = ok<{ order: { status: string; revoke: { reason: string } }; bill: { removed: string[]; waits: boolean } }>(await post(`/v1/orders/${rbs}/revoke`, { reason: "ordered twice by mistake" }, "doctor"));
    expect(r.order).toMatchObject({ status: "revoked", revoke: { reason: "ordered twice by mistake" } });
    expect(r.bill).toMatchObject({ removed: ["test:rbs"], waits: false });
    const inv = ok<{ invoice: { totalPaisa: number } }>(await get(`/v1/invoices/${bill.invoice.id}`, "cashier"));
    expect(inv.invoice.totalPaisa).toBe(215_000);
    const v = await view(enc);
    expect(v.tubes.map((t) => t.tube).sort()).toEqual(["edta", "plain"]);
    expect((await post(`/v1/orders/${rbs}/revoke`, { reason: "ordered twice by mistake" }, "doctor")).json().code).toBe("already_revoked");
    const audit = await inTenant((tx) => tx.auditEvent.findFirst({ where: { entity: "ServiceRequest", entityId: rbs, action: "update" } }));
    expect(audit!.detail).toMatchObject({ event: "revoke", reason: "ordered twice by mistake" });
  });
  it("the lab can cancel before collection (the doctor's inbox is told), never after a tube is collected", async () => {
    const { enc } = await signedVisit();
    const v0 = ok<View>(await post(`/v1/lab/visits/${enc}/labels`, {}));
    const cbc = order(v0, "cbc").id, elec = order(v0, "elec").id;
    ok(await post(`/v1/lab/specimens/${v0.specimens.find((x) => x.tube === "edta")!.id}/collect`, { at: now() }));
    expect((await post(`/v1/orders/${cbc}/revoke`, { reason: "patient refused the test" }, "tech")).json().code).toBe("collected");
    ok(await post(`/v1/orders/${elec}/revoke`, { reason: "analyser for electrolytes is down" }, "path"));
    const v = await view(enc);
    expect(v.communications.find((c) => c.kind === "order-cancelled")).toMatchObject({ channel: "doctor-inbox", status: "completed", recipient: expect.objectContaining({ id: "u_e2e_doctor" }) });
    // the printed plain-tube label is for a cancelled test only: collecting it is refused
    const plain = v.specimens.find((x) => x.tube === "plain")!;
    expect((await post(`/v1/lab/specimens/${plain.id}/collect`, { at: now() })).json().code).toBe("orders_cancelled");
  });
});

describe.runIf(db)("who may see and do what", () => {
  it("receptionist and doctor have no lab screens; admin views but cannot enter; another tenant finds nothing", async () => {
    const { enc } = await signedVisit();
    expect((await get(`/v1/lab/visits/${enc}`, "desk")).statusCode).toBe(403);
    expect((await get(`/v1/lab/visits/${enc}`, "doctor")).statusCode).toBe(403);
    expect((await get(`/v1/lab/visits/${enc}`, "admin")).statusCode).toBe(200);
    expect((await post(`/v1/lab/visits/${enc}/labels`, {}, "admin")).statusCode).toBe(403);
    expect((await get(`/v1/lab/visits/${enc}`, "otherTech")).statusCode).toBe(404);
    const w = ok<{ items: { encounter: { id: string } }[] }>(await get("/v1/lab/worklist?stage=collect", "otherTech"));
    expect(w.items.some((i) => i.encounter.id === enc)).toBe(false);
    expect((await post(`/v1/lab/visits/${enc}/labels`, {}, "otherTech")).statusCode).toBe(404);
  });
  it("a write without an Idempotency-Key is refused; the PIN is never stored", async () => {
    const { enc } = await signedVisit(undefined, ["rbs"]);
    expect((await post(`/v1/lab/visits/${enc}/labels`, {}, "tech", null)).statusCode).toBe(400);
    await toInProcess(enc);
    await enter(enc, "rbs");
    const key = randomUUID();
    ok(await post(`/v1/lab/visits/${enc}/verify`, { pin: "1234", observationIds: idsOf(await view(enc), ["rbs"], "preliminary"), deltaChecked: true }, "tech", key));
    const stored = await inTenant((tx) => tx.idempotencyKey.findFirst({ where: { key } }));
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain('"pin"');
  });
});
