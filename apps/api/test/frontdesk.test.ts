/* Slice A1–A3 contract tests on the real database (as setu_app). Walkthrough steps A1–A3, issues #4 and #5, and
   cross-tenant denial. They run in the seeded E2E Test Clinic (t_e2e), never the demo clinic; everything created is
   synthetic and uniquely named per run. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("frontdesk.test: DATABASE_URL_APP not set — front desk contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const cookies: Record<string, string> = {};
let otherTenantPatientId = "";

/* Decisions in these tests change the seeded family (link, unlink, confidence); put it back before and after. */
const resetFamily = () => db!.forTenant("t_e2e", async (tx) => {
  await tx.patient.updateMany({ where: { id: { in: ["e2e_p_rahima", "e2e_p_karim", "e2e_p_sumaiya", "e2e_p_ayesha", "e2e_p_rbegum"] } }, data: { linkedToId: null } });
  await tx.patient.update({ where: { id: "e2e_p_rbegum" }, data: { identityConfidence: "possible_duplicate" } });
  await tx.patient.update({ where: { id: "e2e_p_ayesha" }, data: { identityConfidence: "unverified" } });
  await tx.patient.updateMany({ where: { id: { in: ["e2e_p_rahima", "e2e_p_karim", "e2e_p_sumaiya"] } }, data: { identityConfidence: "verified" } });
  await tx.task.updateMany({ where: { kind: "patient-link-review", status: "requested", focusId: { startsWith: "e2e_p_" } }, data: { status: "rejected", decisionNote: "test reset" } });
});

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  await resetFamily();
  for (const [k, phone] of [["desk", "01799000001"], ["doctor", "01799000002"], ["owner", "01799000009"], ["admin", "01799000010"]] as const) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; cookies[k] = Array.isArray(c) ? c[0]! : (c as string);
  }
  // A patient in another tenant, written under that tenant's own context.
  const p = await db.forTenant("t_litedemo", (tx) => tx.patient.create({ data: { tenantId: "t_litedemo", facilityNo: `MGH-X${RUN}`, nameBn: "অন্য রোগী", nameEn: `Other Tenant ${RUN}`, sex: "female", phone: "1711234567" } }));
  otherTenantPatientId = p.id;
});
afterAll(async () => {
  if (db) await resetFamily();
  // The other-tenant fixtures live in a demo tenant: remove them again so its data stays clean.
  if (db && otherTenantPatientId) await db.forTenant("t_litedemo", async (tx) => { await tx.encounter.deleteMany({ where: { patientId: otherTenantPatientId } }); await tx.patient.delete({ where: { id: otherTenantPatientId } }); });
  await app.close();
});

const get = (url: string, who = "desk") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const post = (url: string, payload: object, who = "desk", key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const newPhone = () => `015${String(randomInt(0, 1e8)).padStart(8, "0")}`;
const form = (over: object = {}) => ({
  nameBn: "নুসরাত জাহান", nameEn: `Nusrat Jahan ${RUN}`, sex: "female", dobMode: "dob", dob: "১২/০৭/১৯৯২", phone: newPhone(), phoneOwner: "self",
  division: "Dhaka", district: "Dhaka", upazila: "Mirpur", ...over,
});

describe.runIf(db)("A1 search", () => {
  it("phone search finds the five family members on 01711-234567 with the shared-phone warning; every spelling of the number works", async () => {
    for (const q of ["01711234567", "+880 1711-234567", "০১৭১১২৩৪৫৬৭"]) {
      const r = await get(`/v1/patients/search?q=${encodeURIComponent(q)}`);
      expect(r.statusCode).toBe(200);
      const b = r.json();
      expect(b.mode).toBe("phone");
      expect(b.items.map((i: { facilityNo: string }) => i.facilityNo).sort()).toEqual(["E2E-220311", "E2E-230150", "E2E-230982", "E2E-240117", "E2E-250044"]);
      expect(b.sharedPhone).toEqual({ phone: "1711234567", count: 5 });
      expect(b.items.find((i: { facilityNo: string }) => i.facilityNo === "E2E-230982").identityConfidence).toBe("possible-duplicate");
    }
  });
  it("Bangla name, English name and patient number; no match returns an empty list", async () => {
    const bn = (await get(`/v1/patients/search?q=${encodeURIComponent("রহিমা")}`)).json();
    expect(bn.mode).toBe("bn"); expect(bn.items.map((i: { nameEn: string }) => i.nameEn)).toEqual(expect.arrayContaining(["Rahima Khatun", "Rahima Begum"]));
    expect(bn.sharedPhone).toBeNull();
    const en = (await get("/v1/patients/search?q=karim")).json();
    expect(en.mode).toBe("en"); expect(en.items.map((i: { nameEn: string }) => i.nameEn)).toContain("Abdul Karim");
    const no = (await get("/v1/patients/search?q=E2E-2401")).json();
    expect(no.mode).toBe("patientNo");
    const nos = no.items.map((i: { facilityNo: string }) => i.facilityNo);
    expect(nos).toContain("E2E-240117"); expect(nos.every((n: string) => n.startsWith("E2E-2401"))).toBe(true);
    expect((await get("/v1/patients/search?q=zzqqxx")).json().items).toEqual([]);
  });
  it("an exact patient number comes first", async () => {
    const r = (await get("/v1/patients/search?q=E2E-240117")).json();
    expect(r.items[0].facilityNo).toBe("E2E-240117");
  });
  it("a doctor may not use front desk search (role)", async () => {
    const r = await get("/v1/patients/search?q=karim", "doctor");
    expect(r.statusCode).toBe(403); expect(r.json()).toMatchObject({ reason: "role" });
  });
  it("search writes a view audit without the query text", async () => {
    const before = await db!.forTenant("t_e2e", (tx) => tx.auditEvent.count({ where: { entity: "Patient", action: "view" } }));
    await get("/v1/patients/search?q=01711234567");
    const last = await db!.forTenant("t_e2e", (tx) => tx.auditEvent.findFirst({ where: { entity: "Patient", action: "view" }, orderBy: { at: "desc" } }));
    expect(await db!.forTenant("t_e2e", (tx) => tx.auditEvent.count({ where: { entity: "Patient", action: "view" } }))).toBe(before + 1);
    expect(JSON.stringify(last!.detail)).not.toContain("1711234567");
  });
});

describe.runIf(db)("A2 duplicate review (issue #4)", () => {
  it("Rahima Begum vs Rahima Khatun: field-level statuses, conflicts on DOB and guardian, no one-click link", async () => {
    const r = await get("/v1/patients/e2e_p_rbegum/matches");
    expect(r.statusCode).toBe(200);
    const c = r.json().candidates.find((x: { patient: { id: string } }) => x.patient.id === "e2e_p_rahima");
    expect(c.comparison.fields).toMatchObject({ phone: "same", sex: "same", birth: "different", guardian: "different" });
    expect(c.canLink).toBe(false); expect(c.canLinkAnyway).toBe(true);
    const link = await post("/v1/patients/e2e_p_rbegum/match-decisions", { decision: "link", candidateId: "e2e_p_rahima" });
    expect(link.statusCode).toBe(409); expect(link.json().code).toBe("link_has_conflicts");
  });
  it("Link anyway needs a ≥10-character reason; then links, approves the review Task, audits the reason; undo reverses it", async () => {
    const short = await post("/v1/patients/e2e_p_rbegum/match-decisions", { decision: "linkAnyway", candidateId: "e2e_p_rahima", reason: "  short  " });
    expect(short.statusCode).toBe(400); expect(short.json().code).toBe("reason_too_short");
    const ok = await post("/v1/patients/e2e_p_rbegum/match-decisions", { decision: "linkAnyway", candidateId: "e2e_p_rahima", reason: `Same woman, confirmed by husband ${RUN}` });
    expect(ok.statusCode).toBe(200);
    const b = ok.json();
    expect(b.subject.linkedToId).toBe("e2e_p_rahima"); expect(b.continueWith.id).toBe("e2e_p_rahima"); expect(b.conflicts).toEqual(expect.arrayContaining(["birth", "guardian"]));
    const task = await db!.forTenant("t_e2e", (tx) => tx.task.findFirst({ where: { id: b.taskId } }));
    expect(task).toMatchObject({ kind: "patient-link-review", status: "approved", decisionNote: "link-anyway" });
    const audit = await db!.forTenant("t_e2e", (tx) => tx.auditEvent.findFirst({ where: { entity: "Patient", entityId: "e2e_p_rbegum", action: "update" }, orderBy: { at: "desc" } }));
    expect(JSON.stringify(audit!.detail)).toContain(`confirmed by husband ${RUN}`);
    const undo = await post("/v1/patients/e2e_p_rbegum/match-decisions/undo", {});
    expect(undo.statusCode).toBe(200);
    expect(undo.json().subject).toMatchObject({ linkedToId: null, identityConfidence: "possible-duplicate" });
  });
  it("Send for review opens a requested Task; undo withdraws it (rejected)", async () => {
    const r = await post("/v1/patients/e2e_p_rbegum/match-decisions", { decision: "review", candidateId: "e2e_p_rahima", reason: "not sure" });
    expect(r.statusCode).toBe(200);
    const t1 = await db!.forTenant("t_e2e", (tx) => tx.task.findFirst({ where: { id: r.json().taskId } }));
    expect(t1!.status).toBe("requested");
    expect((await post("/v1/patients/e2e_p_rbegum/match-decisions/undo", {})).statusCode).toBe(200);
    const t2 = await db!.forTenant("t_e2e", (tx) => tx.task.findFirst({ where: { id: r.json().taskId } }));
    expect(t2).toMatchObject({ status: "rejected", decisionNote: "withdrawn" });
  });
  it("only real look-alikes are candidates: family members who merely share the phone are not", async () => {
    const ids = (await get("/v1/patients/e2e_p_rbegum/matches")).json().candidates.map((c: { patient: { id: string } }) => c.patient.id);
    expect(ids).toContain("e2e_p_rahima");
    expect(ids).not.toContain("e2e_p_sumaiya"); expect(ids).not.toContain("e2e_p_ayesha"); expect(ids).not.toContain("e2e_p_karim");
  });
  it("a child cannot be linked to the guardian's record, even with a reason", async () => {
    const r = await post("/v1/patients/e2e_p_sumaiya/match-decisions", { decision: "linkAnyway", candidateId: "e2e_p_karim", reason: "this is definitely the same person" });
    expect(r.statusCode).toBe(409); expect(r.json().code).toBe("link_blocked_guardian");
  });
});

describe.runIf(db)("decision 16: link anyway stays immediate; admin reviews afterwards", () => {
  it("an override appears in the review queue as 'override'; only an admin can unlink, with a reason; it then leaves the queue", async () => {
    const link = await post("/v1/patients/e2e_p_rbegum/match-decisions", { decision: "linkAnyway", candidateId: "e2e_p_rahima", reason: `Confirmed by husband ${RUN}` });
    expect(link.statusCode).toBe(200);
    const q1 = (await get("/v1/reviews/duplicates")).json().items;
    const item = q1.find((i: { taskId: string }) => i.taskId === link.json().taskId);
    expect(item).toMatchObject({ kind: "override", subject: { id: "e2e_p_rbegum", linkedToId: "e2e_p_rahima" }, candidate: { id: "e2e_p_rahima" }, reason: `Confirmed by husband ${RUN}` });
    expect(item.conflicts).toEqual(expect.arrayContaining(["birth", "guardian"]));

    expect((await post("/v1/patients/e2e_p_rbegum/unlink", { reason: "wrong person, different husband" })).statusCode).toBe(403); // receptionist
    expect((await post("/v1/patients/e2e_p_rbegum/unlink", { reason: "short" }, "admin")).json().code).toBe("reason_too_short");
    const un = await post("/v1/patients/e2e_p_rbegum/unlink", { reason: `Different husband on file ${RUN}` }, "admin");
    expect(un.statusCode).toBe(200);
    expect(un.json()).toMatchObject({ outcome: "unlinked", subject: { linkedToId: null, identityConfidence: "unverified" } });
    const q2 = (await get("/v1/reviews/duplicates")).json().items;
    expect(q2.map((i: { taskId: string }) => i.taskId)).not.toContain(link.json().taskId);
    // The desk's Undo cannot reach back past an admin unlink.
    expect((await post("/v1/patients/e2e_p_rbegum/match-decisions/undo", {})).json().code).toBe("nothing_to_undo");
    expect((await post("/v1/patients/e2e_p_rbegum/unlink", { reason: "again, but it is not linked" }, "admin")).json().code).toBe("not_linked");
  });
  it("an admin can keep an override: the link stays and it leaves the queue", async () => {
    const link = await post("/v1/patients/e2e_p_rbegum/match-decisions", { decision: "linkAnyway", candidateId: "e2e_p_rahima", reason: `Same woman per NID ${RUN}` });
    expect((await post(`/v1/reviews/${link.json().taskId}/keep`, {})).statusCode).toBe(403);
    const keep = await post(`/v1/reviews/${link.json().taskId}/keep`, {}, "admin");
    expect(keep.statusCode).toBe(200); expect(keep.json().subject.linkedToId).toBe("e2e_p_rahima");
    expect((await get("/v1/reviews/duplicates")).json().items.map((i: { taskId: string }) => i.taskId)).not.toContain(link.json().taskId);
    // Put the walkthrough family back as it was for the next tests.
    expect((await post("/v1/patients/e2e_p_rbegum/unlink", { reason: `test cleanup after keep ${RUN}` }, "admin")).statusCode).toBe(200);
  });
  it("send for review shows as 'review' in the queue", async () => {
    const r = await post("/v1/patients/e2e_p_rbegum/match-decisions", { decision: "review", candidateId: "e2e_p_rahima" });
    expect((await get("/v1/reviews/duplicates")).json().items.find((i: { taskId: string }) => i.taskId === r.json().taskId)).toMatchObject({ kind: "review" });
    await post("/v1/patients/e2e_p_rbegum/match-decisions/undo", {});
  });
});

describe.runIf(db)("A3 registration and visit (issue #5)", () => {
  it("an empty form is refused with 7 fields needing attention and nothing is created", async () => {
    const before = await db!.forTenant("t_e2e", (tx) => tx.patient.count());
    const r = await post("/v1/patients", { nameBn: "", dobMode: "dob", createVisit: true });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: "validation", message_en: "7 fields need attention", message_bn: "৭টি ঘর ঠিক করুন" });
    expect(r.json().fields.map((f: { field: string }) => f.field)).toEqual(["nameBn", "sex", "dob", "phone", "division", "district", "upazila"]);
    expect(await db!.forTenant("t_e2e", (tx) => tx.patient.count())).toBe(before);
  });
  it("a future date of birth and a short phone are refused", async () => {
    const r = await post("/v1/patients", form({ dob: "01/01/2030", phone: "171123" }));
    expect(r.json().fields).toEqual([{ field: "dob", code: "dob_future" }, { field: "phone", code: "phone_invalid" }]);
  });
  it("Save & create visit: new facility number, own token, waiting; a replay does not register twice", async () => {
    const key = randomUUID(); const body = form({ createVisit: true });
    const a = await post("/v1/patients", body, "desk", key);
    expect(a.statusCode).toBe(201);
    const b = a.json();
    expect(b.patient.facilityNo).toMatch(/^E2E-\d{6}$/);
    expect(b.patient).toMatchObject({ identityConfidence: "unverified", birthDate: "1992-07-12" });
    expect(b.encounter).toMatchObject({ status: "arrived", column: "waiting", patient: { id: b.patient.id } });
    expect(b.encounter.token).toMatch(/^A-\d{3,}$/);
    const replay = await post("/v1/patients", body, "desk", key);
    expect(replay.headers["idempotent-replay"]).toBe("true"); expect(replay.json().patient.id).toBe(b.patient.id);
    // A second visit the same day is refused, naming the existing token.
    const again = await post("/v1/encounters", { patientId: b.patient.id });
    expect(again.statusCode).toBe(409); expect(again.json()).toMatchObject({ code: "visit_exists", existing: { token: b.encounter.token } });
    // The queue shows the new token in Waiting.
    const q = (await get("/v1/queue")).json();
    expect(q.columns.find((c: { key: string }) => c.key === "waiting").items.map((i: { id: string }) => i.id)).toContain(b.encounter.id);
  });
  it("tokens count up per branch per day", async () => {
    const x = (await post("/v1/patients", form({ createVisit: true }))).json().encounter.tokenNo;
    const y = (await post("/v1/patients", form({ createVisit: true }))).json().encounter.tokenNo;
    expect(y).toBe(x + 1);
  });
  it("an under-18 without a guardian is refused; with one it saves and links the guardian", async () => {
    const child = form({ nameBn: "তাহসিন", nameEn: `Tahsin ${RUN}`, sex: "male", dob: "02/02/2019" });
    expect((await post("/v1/patients", child)).json().fields.map((f: { field: string }) => f.field)).toEqual(["guardianName", "guardianRelationship"]);
    const ok = await post("/v1/patients", { ...child, guardian: { name: "আব্দুল করিম", relationship: "father" } });
    expect(ok.statusCode).toBe(201); expect(ok.json().patient.guardian).toEqual({ name: "আব্দুল করিম", relationship: "father" });
  });
  it("registering someone who strongly matches an existing record flags the new record as a possible duplicate", async () => {
    // Its own patient on its own phone, so the seeded family on 01711-234567 stays at five.
    const first = form({ guardian: { name: "আব্দুল করিম", relationship: "husband" } });
    expect((await post("/v1/patients", first)).json().patient.identityConfidence).toBe("unverified");
    const again = await post("/v1/patients", first);
    expect(again.statusCode).toBe(201); expect(again.json().patient.identityConfidence).toBe("possible-duplicate");
  });
  it("a write without Idempotency-Key is refused", async () => {
    const r = await post("/v1/patients", form(), "desk", null);
    expect(r.statusCode).toBe(400); expect(r.json().code).toBe("idempotency_key_required");
  });
  it("the doctor and the owner cannot register (role)", async () => {
    expect((await post("/v1/patients", form(), "doctor")).statusCode).toBe(403);
    expect((await post("/v1/patients", form(), "owner")).statusCode).toBe(403);
  });
});

describe.runIf(db)("queue actions go through ENCOUNTER", () => {
  it("call → next (vitals) → next (doctor); the desk can neither finish the visit nor mark no-show once with the doctor", async () => {
    const v = (await post("/v1/patients", form({ createVisit: true }))).json().encounter;
    expect(v.actions).toEqual(["call", "next", "noShow"]);
    const called = (await post(`/v1/encounters/${v.id}/actions`, { action: "call" })).json();
    expect(called.calledAt).not.toBeNull(); expect(called.status).toBe("arrived");
    expect((await post(`/v1/encounters/${v.id}/actions`, { action: "next" })).json()).toMatchObject({ status: "triaged", column: "vitals" });
    expect((await post(`/v1/encounters/${v.id}/actions`, { action: "next" })).json()).toMatchObject({ status: "in-progress", column: "withDoctor", actions: [] });
    const ns = await post(`/v1/encounters/${v.id}/actions`, { action: "noShow" });
    expect(ns.statusCode).toBe(409); expect(ns.json().code).toBe("invalid_transition");
    const fin = await post(`/v1/encounters/${v.id}/actions`, { action: "next" });
    expect(fin.statusCode).toBe(409); expect(fin.json().code).toBe("invalid_transition");
  });
  it("no-show from waiting", async () => {
    const v = (await post("/v1/patients", form({ createVisit: true }))).json().encounter;
    expect((await post(`/v1/encounters/${v.id}/actions`, { action: "noShow" })).json()).toMatchObject({ status: "cancelled", column: "noShow" });
  });
});

describe.runIf(db)("cross-tenant denial", () => {
  it("another tenant's patient is invisible: not in search, 404 for matches, decisions and visits", async () => {
    const s = (await get("/v1/patients/search?q=01711234567")).json();
    expect(s.items.map((i: { id: string }) => i.id)).not.toContain(otherTenantPatientId);
    expect((await get(`/v1/patients/search?q=${encodeURIComponent(`Other Tenant ${RUN}`)}`)).json().items).toEqual([]);
    expect((await get(`/v1/patients/${otherTenantPatientId}/matches`)).statusCode).toBe(404);
    expect((await post(`/v1/patients/e2e_p_rbegum/match-decisions`, { decision: "review", candidateId: otherTenantPatientId })).statusCode).toBe(404);
    expect((await post("/v1/encounters", { patientId: otherTenantPatientId })).statusCode).toBe(404);
  });
  it("another tenant's encounter cannot be moved", async () => {
    const e = await db!.forTenant("t_litedemo", (tx) => tx.encounter.create({ data: {
      tenantId: "t_litedemo", organizationId: "o_litedemo", branchId: "l_branch_t_litedemo", patientId: otherTenantPatientId, status: "arrived",
      token: "A-999", tokenNo: 900000 + randomInt(0, 99999), tokenDay: "2000-01-01", createdById: "u_lite_doctor",
    } }));
    expect((await post(`/v1/encounters/${e.id}/actions`, { action: "next" })).statusCode).toBe(404);
  });
});
