/* Slice A5 contract tests on the real database (as setu_app), in the seeded E2E Test Clinic, with new synthetic patients
   (never Rahima Khatun, whom the journeys use): opening moves the visit to "with doctor" only for a doctor; the allergy
   and same-medicine checks refuse a sign with the same reasons @setu/domain gives the screen; a note is final only after
   the server checked the PIN; amending creates v2 and supersedes v1 in one transaction; signed rows are never edited;
   another doctor and another tenant are refused. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEDICINES_SAMPLE, rxBlockers, type AllergyFact, type RxLine } from "@setu/domain";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("consultation.test: DATABASE_URL_APP not set — consultation contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const cookies: Record<string, string> = {};
const T = "t_e2e";

beforeAll(async () => {
  app = await buildApp();
  if (!db) return;
  for (const [k, phone] of [["desk", "01799000001"], ["doctor", "01799000002"], ["doctor2", "01799000003"], ["nurse", "01799000004"], ["otherDoctor", "01733000002"]] as const) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { identifier: phone, password: "setu1234" } });
    const c = r.headers["set-cookie"]; cookies[k] = Array.isArray(c) ? c[0]! : (c as string);
  }
});
afterAll(async () => { await app.close(); });

type Who = "desk" | "doctor" | "doctor2" | "nurse" | "otherDoctor";
const get = (url: string, who: Who = "doctor") => app.inject({ method: "GET", url, headers: { cookie: cookies[who]! } });
const send = (method: "POST" | "PUT", url: string, payload: object, who: Who = "doctor", key: string | null = randomUUID()) =>
  app.inject({ method, url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const post = (url: string, payload: object = {}, who: Who = "doctor", key?: string | null) => send("POST", url, payload, who, key);
const put = (url: string, payload: object, who: Who = "doctor", key?: string | null) => send("PUT", url, payload, who, key);
const inTenant = <R>(fn: (tx: NonNullable<typeof db>["prisma"]) => Promise<R>) => db!.forTenant(T, fn as never) as Promise<R>;

/** A new synthetic patient registered at the desk with today's token (status arrived). */
async function newVisit() {
  const r = await post("/v1/patients", {
    nameBn: "শিলা রানী", nameEn: `Shila Rani ${RUN}`, sex: "female", dobMode: "dob", dob: "03/03/1991", phone: `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self",
    division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
  }, "desk");
  expect(r.statusCode).toBe(201);
  return { enc: r.json().encounter.id as string, patient: r.json().patient.id as string };
}
async function open(enc: string, who: Who = "doctor") {
  const r = await post(`/v1/encounters/${enc}/consultation/open`, {}, who);
  expect(r.statusCode).toBe(200);
  return r.json();
}
const note = (over: Partial<{ medications: object[]; orders: object[]; diagnoses: object[]; sectionSources: object; history: string }> = {}) => ({
  sections: { complaints: [{ text: "Burning micturition", duration: { n: 5, unit: "d" } }], history: over.history ?? "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "Plenty of water", followUp: "7 days" },
  sectionSources: over.sectionSources ?? {},
  diagnoses: over.diagnoses ?? [{ code: "GC08", verificationStatus: "provisional" }],
  medications: over.medications ?? [{ medicineKey: "ciprocin", dose: "1+0+1", meal: "after", days: 5 }],
  orders: over.orders ?? [],
});
async function save(cid: string, rev: number, body: object, who: Who = "doctor") {
  const r = await put(`/v1/compositions/${cid}`, { rev, ...body }, who);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
const sign = (cid: string, rev: number, over: object = {}, who: Who = "doctor", key?: string) =>
  post(`/v1/compositions/${cid}/sign`, { rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false, ...over }, who, key);
const recordAllergy = (patient: string, enc: string, body: object, who: Who = "doctor") => post(`/v1/patients/${patient}/allergies`, { encounterId: enc, ...body }, who);

describe.runIf(db)("A5 opening a consultation (decision 28; Kamrul 02/10/2026)", () => {
  it("a doctor opening moves the visit to with-doctor, assigns them and creates draft v1; re-opening is a no-op", async () => {
    const { enc } = await newVisit();
    const v = await open(enc);
    expect(v.encounter).toMatchObject({ status: "in-progress", practitionerId: "u_e2e_doctor" });
    expect(v.draft).toMatchObject({ version: 1, status: "draft", rev: 1 });
    const again = await open(enc);
    expect(again.draft.id).toBe(v.draft.id);
    expect(await inTenant((tx) => tx.composition.count({ where: { encounterId: enc } }))).toBe(1);
    expect(await inTenant((tx) => tx.auditEvent.count({ where: { entity: "Encounter", entityId: enc, action: "update" } }))).toBe(1);
  });
  it("a receptionist or nurse cannot open or read it, and the visit does not move", async () => {
    const { enc } = await newVisit();
    for (const who of ["desk", "nurse"] as const) {
      expect((await post(`/v1/encounters/${enc}/consultation/open`, {}, who)).statusCode).toBe(403);
      expect((await get(`/v1/encounters/${enc}/consultation`, who)).statusCode).toBe(403);
    }
    expect(await inTenant((tx) => tx.encounter.findFirst({ where: { id: enc } }))).toMatchObject({ status: "arrived", practitionerId: null });
  });
  it("another doctor gets 403 no_care_relationship on a visit already with a doctor; an unassigned one they may open", async () => {
    const { enc } = await newVisit();
    const v = await open(enc);
    for (const r of [await get(`/v1/encounters/${enc}/consultation`, "doctor2"), await post(`/v1/encounters/${enc}/consultation/open`, {}, "doctor2"), await put(`/v1/compositions/${v.draft.id}`, { rev: 1, ...note() }, "doctor2")])
      expect(r.json()).toMatchObject({ code: "no_care_relationship", reason: "no-care-relationship", canRequest: false });
    const other = await newVisit();
    expect((await open(other.enc, "doctor2")).encounter.practitionerId).toBe("u_e2e_doctor2");
  });
  it("the worklist shows unassigned and own visits, not another doctor's", async () => {
    const mine = await newVisit(); await open(mine.enc);
    const theirs = await newVisit(); await open(theirs.enc, "doctor2");
    const waiting = await newVisit();
    const ids = (await get("/v1/consultations/worklist")).json().items.map((i: { id: string }) => i.id);
    expect(ids).toEqual(expect.arrayContaining([mine.enc, waiting.enc]));
    expect(ids).not.toContain(theirs.enc);
  });
  it("another tenant's doctor finds nothing (RLS)", async () => {
    const { enc } = await newVisit();
    const v = await open(enc);
    expect((await get(`/v1/encounters/${enc}/consultation`, "otherDoctor")).statusCode).toBe(404);
    expect((await post(`/v1/encounters/${enc}/consultation/open`, {}, "otherDoctor")).statusCode).toBe(404);
    expect((await put(`/v1/compositions/${v.draft.id}`, { rev: 1, ...note() }, "otherDoctor")).statusCode).toBe(404);
    expect((await sign(v.draft.id, 1, {}, "otherDoctor")).statusCode).toBe(404);
    expect(await db!.forTenant("t_litedemo", (tx) => tx.composition.count({ where: { encounterId: enc } }))).toBe(0);
  });
});

describe.runIf(db)("A5 draft and sign (walkthrough A5, issues #16)", () => {
  it("the server copies labels and medicine data from its catalogue; unknown keys and a stale rev are refused", async () => {
    const { enc } = await newVisit();
    const v = await open(enc);
    const c = await save(v.draft.id, 1, note({ orders: [{ testCode: "cbc", priority: "routine" }, { testCode: "rbs", priority: "routine" }, { testCode: "elec", priority: "urgent" }] }));
    expect(c.diagnoses).toEqual([{ code: "GC08", labelBn: "প্রস্রাবে সংক্রমণ", labelEn: "Urinary tract infection, site not specified", codeVerification: "unverified-prototype", verificationStatus: "provisional" }]);
    expect(c.medications[0]).toMatchObject({ brand: "Ciprocin", generic: "Ciprofloxacin", ingredients: ["ciprofloxacin"], quantity: 10, sample: true });
    expect(c.orders.map((o: { nameEn: string; status: string }) => [o.nameEn, o.status])).toEqual([["CBC", "draft"], ["RBS", "draft"], ["S. Electrolytes", "draft"]]);
    expect((await put(`/v1/compositions/${v.draft.id}`, { rev: 1, ...note() })).json().code).toBe("stale");
    const bad = await put(`/v1/compositions/${v.draft.id}`, { rev: 2, ...note({ medications: [{ medicineKey: "nope", dose: "1+0+1", meal: "after", days: 5 }], diagnoses: [{ code: "ZZ99", verificationStatus: "provisional" }] }) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().fields).toEqual([{ field: "diagnoses.0", code: "unknown_code" }, { field: "medications.0", code: "unknown_medicine" }]);
  });

  it("an allergy recorded in the consultation blocks a conflicting medicine with the same reason the screen shows", async () => {
    const { enc, patient } = await newVisit();
    const v = await open(enc);
    const a = await recordAllergy(patient, enc, { kind: "class", key: "penicillin", reaction: "rash", severity: "moderate" });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ kind: "class", key: "penicillin", labelEn: "Penicillin", status: "active", source: "provider-verified", recordedBy: { id: "u_e2e_doctor" } });
    expect((await recordAllergy(patient, enc, { kind: "class", key: "penicillin", severity: "mild" })).json().code).toBe("allergy_exists");
    const c = await save(v.draft.id, 1, note({ medications: [{ medicineKey: "napa", dose: "1+1+1", meal: "after", days: 3 }, { medicineKey: "moxacil", dose: "1+1+1", meal: "after", days: 7 }] }));
    const r = await sign(c.id, c.rev);
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("sign_blocked");
    // The screen's check, run on the same lines and allergy, gives the same blocker.
    const lines: RxLine[] = c.medications.map((m: { id: string; medicineKey: string; dose: string; meal: "after"; days: number }) =>
      ({ uid: m.id, medicine: MEDICINES_SAMPLE.find((x) => x.id === m.medicineKey)!, dose: m.dose, meal: m.meal, days: m.days }));
    const facts: AllergyFact[] = [{ ...a.json(), kind: "class" }];
    const screen = rxBlockers(lines, facts).map((w) => ({ kind: w.kind, line: w.line, allergy: w.allergy?.id }));
    const server = r.json().blockers.map((b: { warning: { kind: string; line: string; allergy?: { id: string } } }) => ({ kind: b.warning.kind, line: b.warning.line, allergy: b.warning.allergy?.id }));
    expect(server).toEqual(screen);
    expect(server).toEqual([{ kind: "allergy", line: c.medications[1].id, allergy: a.json().id }]);
    expect(await inTenant((tx) => tx.composition.findFirst({ where: { id: c.id } }))).toMatchObject({ status: "draft", signedAt: null });
    expect(await inTenant((tx) => tx.encounter.findFirst({ where: { id: enc } }))).toMatchObject({ status: "in_progress" });
  });

  it("the same medicine twice (generic, not brand: Napa + Ace) blocks until Keep both", async () => {
    const { enc } = await newVisit();
    const v = await open(enc);
    const twice = [{ medicineKey: "napa", dose: "1+1+1", meal: "after", days: 3 }, { medicineKey: "ace", dose: "1+1+1", meal: "after", days: 3 }];
    let c = await save(v.draft.id, 1, note({ medications: twice }));
    const r = await sign(c.id, c.rev);
    expect(r.json().blockers).toEqual([expect.objectContaining({ code: "rx", warning: expect.objectContaining({ kind: "same-medicine", ingredient: "paracetamol", firstBrand: "Napa", actions: ["remove", "keepBoth"] }) })]);
    c = await save(c.id, c.rev, note({ medications: [twice[0]!, { ...twice[1]!, keepBoth: true }] }));
    expect((await sign(c.id, c.rev)).statusCode).toBe(200);
  });

  it("a wrong PIN refuses the sign and counts a try; the note stays a draft; the same key then signs with the right PIN", async () => {
    const { enc } = await newVisit();
    const v = await open(enc);
    const c = await save(v.draft.id, 1, note());
    const key = randomUUID();
    const wrong = await sign(c.id, c.rev, { pin: "9999" }, "doctor", key);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ code: "pin_wrong", triesLeft: 4 });
    expect(await inTenant((tx) => tx.composition.findFirst({ where: { id: c.id } }))).toMatchObject({ status: "draft" });
    const ok = await sign(c.id, c.rev, {}, "doctor", key);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().current).toMatchObject({ id: c.id, status: "final" });
  });

  it("signing: final only after the server answers; orders placed; visit finished (queue: Completed); provenance; a replay does nothing new", async () => {
    const { enc } = await newVisit();
    const v = await open(enc);
    const c = await save(v.draft.id, 1, note({ orders: [{ testCode: "cbc", priority: "routine" }, { testCode: "rbs", priority: "routine" }, { testCode: "elec", priority: "urgent" }] }));
    const key = randomUUID();
    const r = await sign(c.id, c.rev, {}, "doctor", key);
    expect(r.statusCode).toBe(200);
    const view = r.json();
    expect(view.draft).toBeNull();
    expect(view.current).toMatchObject({ id: c.id, version: 1, status: "final", signedBy: { id: "u_e2e_doctor", regVerified: false } });
    expect(view.current.orders.map((o: { nameEn: string; status: string; placed: boolean }) => [o.nameEn, o.status, o.placed])).toEqual([["CBC", "active", true], ["RBS", "active", true], ["S. Electrolytes", "active", true]]);
    expect(view.encounter.status).toBe("finished");
    const q = (await get("/v1/queue", "desk")).json();
    const completed = q.columns.find((c: { key: string }) => c.key === "done");
    expect(completed.items.find((i: { id: string }) => i.id === enc)).toMatchObject({ status: "finished" });
    const prov = await inTenant((tx) => tx.provenance.findMany({ where: { OR: [{ targetId: c.id }, { targetId: { in: [...view.current.orders.map((o: { id: string }) => o.id), ...view.current.medications.map((m: { id: string }) => m.id)] } }] } }));
    expect(prov.map((p) => p.activity).sort()).toEqual(["order", "order", "order", "prescribe", "sign"]);
    const again = await sign(c.id, c.rev, {}, "doctor", key);
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(await inTenant((tx) => tx.provenance.count({ where: { targetId: c.id, activity: "sign" } }))).toBe(1);
    // The stored idempotency record never holds the PIN.
    const stored = await inTenant((tx) => tx.idempotencyKey.findFirst({ where: { key } }));
    expect(JSON.stringify(stored)).not.toContain("1234");
    // The visit cannot be signed a second time from a new draft: there is none, and the signed version is not editable.
    expect((await put(`/v1/compositions/${c.id}`, { rev: c.rev, ...note() })).json().code).toBe("not_draft");
  });

  it("the database refuses edits to a signed note even for setu_app (rule 3)", async () => {
    const { enc } = await newVisit();
    const v = await open(enc);
    const c = await save(v.draft.id, 1, note());
    expect((await sign(c.id, c.rev)).statusCode).toBe(200);
    await expect(inTenant((tx) => tx.composition.update({ where: { id: c.id }, data: { sections: {} } }))).rejects.toThrow();
    await expect(inTenant((tx) => tx.medicationRequest.updateMany({ where: { compositionId: c.id }, data: { days: 30 } }))).rejects.toThrow();
    await expect(inTenant((tx) => tx.composition.delete({ where: { id: c.id } }))).rejects.toThrow();
  });

  it("text from the AI draft needs the 'I reviewed' tick; the draft is labelled not-a-diagnosis; review is recorded", async () => {
    const { enc } = await newVisit();
    const v = await open(enc);
    const ai = await post(`/v1/compositions/${v.draft.id}/ai-draft`, { kind: "note" });
    expect(ai.statusCode).toBe(200);
    expect(ai.json()).toMatchObject({ label: "draft-not-a-diagnosis", model: "fake-ai-v1" });
    expect(ai.json().summary[0]).toMatchObject({ textEn: "No allergies recorded — ask the patient" });
    let c = await save(v.draft.id, 1, note({ history: "Presents with burning micturition.", sectionSources: { history: "ai-draft" } }));
    // Saving again without the flag does not clear it: AI text stays ai-draft until signed with the tick (rule 2).
    c = await save(c.id, c.rev, note({ history: "Presents with burning micturition for 5 days.", sectionSources: {} }));
    expect(c.sectionSources).toEqual({ history: "ai-draft" });
    const blocked = await sign(c.id, c.rev);
    expect(blocked.json().blockers).toEqual([{ code: "ai_review_required", sections: ["history"] }]);
    const ok = await sign(c.id, c.rev, { aiReviewed: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().current.aiReviewed).toBe(true);
    expect(await inTenant((tx) => tx.provenance.findFirst({ where: { targetId: c.id, activity: "ai-draft-reviewed" } }))).toMatchObject({ source: "ai_draft", agentId: "u_e2e_doctor" });
  });

  it("a free-text allergy needs the doctor's own check before signing a prescription", async () => {
    const { enc, patient } = await newVisit();
    const v = await open(enc);
    expect((await recordAllergy(patient, enc, { kind: "other", text: "Egg", severity: "unknown" })).statusCode).toBe(201);
    const c = await save(v.draft.id, 1, note());
    expect((await sign(c.id, c.rev)).json().blockers.map((b: { code: string }) => b.code)).toEqual(["uncoded_allergy_check"]);
    expect((await sign(c.id, c.rev, { uncodedAllergiesChecked: true })).statusCode).toBe(200);
  });
});

describe.runIf(db)("A5 amend (ADR 0003)", () => {
  it("amend creates v2 as a draft; signing it makes v2 amended and v1 superseded together; v1 is unchanged", async () => {
    const { enc } = await newVisit();
    const v = await open(enc);
    const c1 = await save(v.draft.id, 1, note({ orders: [{ testCode: "cbc", priority: "routine" }] }));
    expect((await sign(c1.id, c1.rev)).statusCode).toBe(200);
    expect((await post(`/v1/compositions/${c1.id}/amend`, { reason: "abc" })).statusCode).toBe(400);
    const am = await post(`/v1/compositions/${c1.id}/amend`, { reason: "Urine C/S sensitivity — extend course" });
    expect(am.statusCode).toBe(201);
    const v2 = am.json().draft;
    expect(v2).toMatchObject({ version: 2, status: "draft", amendsId: c1.id, amendReason: "Urine C/S sensitivity — extend course" });
    expect(v2.medications.map((m: { medicineKey: string; days: number }) => [m.medicineKey, m.days])).toEqual([["ciprocin", 5]]);
    expect(am.json().current).toMatchObject({ id: c1.id, status: "final" });
    expect((await post(`/v1/compositions/${c1.id}/amend`, { reason: "second amendment" })).json().code).toBe("amendment_open");
    // An amendment keeps the orders already placed and cannot order the same test again.
    expect((await put(`/v1/compositions/${v2.id}`, { rev: 1, ...note({ orders: [{ testCode: "cbc", priority: "routine" }] }) })).json().fields).toEqual([{ field: "orders.0", code: "already_ordered" }]);
    const c2 = await save(v2.id, 1, note({ medications: [{ medicineKey: "ciprocin", dose: "1+0+1", meal: "after", days: 7 }], orders: [{ testCode: "urinecs", priority: "routine" }] }));
    expect(c2.orders.map((o: { testCode: string; placedInVersion: number; status: string }) => [o.testCode, o.placedInVersion, o.status])).toEqual([["cbc", 1, "active"], ["urinecs", 2, "draft"]]);
    const r = await sign(c2.id, c2.rev);
    expect(r.statusCode).toBe(200);
    const after = r.json();
    expect(after.current).toMatchObject({ id: v2.id, version: 2, status: "amended" });
    expect(after.history.map((h: { version: number; status: string; supersededById: string | null }) => [h.version, h.status, h.supersededById])).toEqual([[1, "superseded", v2.id], [2, "amended", null]]);
    expect(after.encounter.status).toBe("finished");
    const v1row = await inTenant((tx) => tx.composition.findFirst({ where: { id: c1.id }, include: { medications: true } }));
    expect(v1row).toMatchObject({ status: "superseded", supersededById: v2.id, signedAt: expect.any(Date) });
    expect(v1row!.medications.map((m) => m.days)).toEqual([5]);
    expect(await inTenant((tx) => tx.composition.count({ where: { encounterId: enc, status: { in: ["final", "amended"] } } }))).toBe(1);
    expect(after.current.orders.map((o: { testCode: string; status: string }) => [o.testCode, o.status])).toEqual([["cbc", "active"], ["urinecs", "active"]]);
    // A superseded version cannot be amended again.
    expect((await post(`/v1/compositions/${c1.id}/amend`, { reason: "amend the old one" })).json().code).toBe("not_current");
  });
});

describe.runIf(db)("A5 allergies (ADR 0004)", () => {
  it("entered-in-error needs a reason; the row stays visible; it no longer blocks; a second mark is refused", async () => {
    const { enc, patient } = await newVisit();
    const v = await open(enc);
    const a = (await recordAllergy(patient, enc, { kind: "substance", key: "amoxicillin", severity: "severe" })).json();
    expect(a).toMatchObject({ kind: "substance", key: "amoxicillin", labelEn: "Amoxicillin" });
    expect((await post(`/v1/allergies/${a.id}/entered-in-error`, { encounterId: enc, reason: "short" })).statusCode).toBe(400);
    const m = await post(`/v1/allergies/${a.id}/entered-in-error`, { encounterId: enc, reason: "Recorded on the wrong patient" });
    expect(m.statusCode).toBe(200);
    expect(m.json()).toMatchObject({ status: "entered-in-error", error: { reason: "Recorded on the wrong patient", by: { id: "u_e2e_doctor" } } });
    expect((await post(`/v1/allergies/${a.id}/entered-in-error`, { encounterId: enc, reason: "Recorded on the wrong patient" })).statusCode).toBe(409);
    const view = (await get(`/v1/encounters/${enc}/consultation`)).json();
    expect(view.allergies.map((x: { id: string; status: string }) => [x.id, x.status])).toEqual([[a.id, "entered-in-error"]]);
    const c = await save(v.draft.id, 1, note({ medications: [{ medicineKey: "moxacil", dose: "1+1+1", meal: "after", days: 7 }] }));
    expect((await sign(c.id, c.rev)).statusCode).toBe(200);
    await expect(inTenant((tx) => tx.allergyIntolerance.delete({ where: { id: a.id } }))).rejects.toThrow();
  });
  it("only a doctor with the visit may record one; unknown classes are refused", async () => {
    const { enc, patient } = await newVisit();
    await open(enc);
    expect((await recordAllergy(patient, enc, { kind: "class", key: "penicillin", severity: "mild" }, "doctor2")).json().code).toBe("no_care_relationship");
    expect((await recordAllergy(patient, enc, { kind: "class", key: "penicillin", severity: "mild" }, "nurse")).statusCode).toBe(403);
    expect((await recordAllergy(patient, enc, { kind: "class", key: "nsaid", severity: "mild" })).json().fields).toEqual([{ field: "key", code: "unknown_class" }]);
  });
});

describe.runIf(db)("A5 PIN lock (shared with /v1/auth/pin/verify)", () => {
  it("five wrong PINs while signing lock signing for 15 minutes (423); the note stays a draft", async () => {
    const { enc } = await newVisit();
    const v = await open(enc, "doctor2");
    const c = await save(v.draft.id, 1, note(), "doctor2");
    for (let i = 1; i < 5; i++) expect((await sign(c.id, c.rev, { pin: "0000" }, "doctor2")).json().triesLeft).toBe(5 - i);
    const locked = await sign(c.id, c.rev, { pin: "0000" }, "doctor2");
    expect(locked.statusCode).toBe(423);
    expect((await sign(c.id, c.rev, {}, "doctor2")).statusCode).toBe(423); // even the right PIN, while locked
    expect(await inTenant((tx) => tx.composition.findFirst({ where: { id: c.id } }))).toMatchObject({ status: "draft" });
  });
});
