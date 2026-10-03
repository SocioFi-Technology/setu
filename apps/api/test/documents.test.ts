/* Slice A12–A13 contract tests: printed clinical documents (ADR 0007, walkthrough A13, issue #19) on the real database
   (as setu_app) in the seeded E2E Test Clinic, with synthetic patients:
   - a prescription prints from a signed note: copy 0 makes the verify code; a reprint needs a reason → DUPLICATE #1;
     every print audited; the stored PDF is served back;
   - a draft never prints (422 draft_not_printable) but has a DRAFT preview; a superseded version does not print and its
     QR says "a newer version exists";
   - the public verify pages: no session, initials / sex / age and medicines or results only (decision D2);
   - lab report versions print the same way; who may print what; another tenant sees nothing;
   - the database refuses a code for a draft, a print out of order, an edit. */
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { lrHtml, rxHtml, type RxInput } from "../src/print/clinical.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
if (!db) console.warn("documents.test: DATABASE_URL_APP not set — print contract tests SKIPPED");
let app: Awaited<ReturnType<typeof buildApp>>;
const RUN = randomUUID().slice(0, 6);
const cookies: Record<string, string> = {};
const T = "t_e2e";
const USERS = { desk: "01799000001", doctor: "01799000002", tech: "01799000005", path: "01799000006", liteDoctor: "01733000002" } as const;
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

const get = (url: string, who: Who | null = "doctor") => app.inject({ method: "GET", url, headers: who ? { cookie: cookies[who]! } : {} });
const post = (url: string, payload: object = {}, who: Who = "doctor", key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url, payload, headers: { cookie: cookies[who]!, ...(key ? { "idempotency-key": key } : {}) } });
const put = (url: string, payload: object, who: Who = "doctor") => app.inject({ method: "PUT", url, payload, headers: { cookie: cookies[who]!, "idempotency-key": randomUUID() } });
const ok = <R>(r: { statusCode: number; body: string; json: () => R }, code = 200) => { expect(r.statusCode, r.body).toBe(code); return r.json(); };
const now = () => new Date().toISOString();
type PrintView = { blockers: string[]; verifyCode: string | null; verifyUrl: string | null; prints: { id: string; copy: number; reason: string | null; pdfUrl: string }[]; previewUrl: string };

const NOTE = (tests: string[] = ["rbs"]) => ({
  sections: { complaints: [{ text: "Tiredness", duration: { n: 2, unit: "w" } }], history: "", exam: { general: "pale", cvs: "", chest: "", abdomen: "" }, advice: "Drink water <b>often</b>", followUp: "after 7 days" },
  sectionSources: {}, diagnoses: [{ code: "5A11", verificationStatus: "provisional" }], medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 3 }],
  orders: tests.map((testCode) => ({ testCode, priority: "routine" })),
});
async function newVisit() {
  const r = ok<{ encounter: { id: string }; patient: { id: string } }>(await post("/v1/patients", {
    nameBn: "প্রিন্ট রোগী", nameEn: `Print Patient ${RUN}`, sex: "female", dobMode: "dob", dob: "03/03/1991", phone: `019${String(randomInt(0, 1e8)).padStart(8, "0")}`, phoneOwner: "self",
    division: "Dhaka", district: "Dhaka", upazila: "Mirpur", createVisit: true,
  }, "desk"), 201);
  return { enc: r.encounter.id, patient: r.patient.id };
}
/** A draft note (not signed) for a new visit. */
async function draft(tests?: string[]) {
  const { enc, patient } = await newVisit();
  const v = ok<{ draft: { id: string } }>(await post(`/v1/encounters/${enc}/consultation/open`, {}));
  const saved = ok<{ id: string; rev: number }>(await put(`/v1/compositions/${v.draft.id}`, { rev: 1, ...NOTE(tests) }));
  return { enc, patient, id: saved.id, rev: saved.rev };
}
async function signed(tests?: string[]) {
  const d = await draft(tests);
  ok(await post(`/v1/compositions/${d.id}/sign`, { rev: d.rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }));
  return d;
}
const printState = async (kind: string, id: string, who: Who = "doctor") => ok<PrintView>(await get(`/v1/documents/${kind}/${id}/print`, who));

describe.runIf(db)("A13 prescription print", () => {
  it("copy 0 makes the verify code; a reprint needs a reason and is DUPLICATE #1; both audited; the PDF is stored and served", async () => {
    const d = await signed();
    const before = await printState("rx", d.id);
    expect(before).toMatchObject({ blockers: [], verifyCode: null, prints: [] });
    const first = ok<PrintView & { print: { copy: number; reason: string | null; pdfUrl: string } }>(await post(`/v1/documents/rx/${d.id}/print`, { format: "a5", lang: "both" }), 201);
    expect(first.print).toMatchObject({ copy: 0, reason: null });
    expect(first.verifyCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(first.verifyUrl).toMatch(new RegExp(`/verify/rx/${first.verifyCode}$`));
    const pdf = await get(first.print.pdfUrl.replace(/^\/v1/, "/v1"));
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
    expect((await post(`/v1/documents/rx/${d.id}/print`, { format: "a4" })).json().code).toBe("reprint_needs_reason");
    const second = ok<PrintView & { print: { copy: number; reason: string } }>(await post(`/v1/documents/rx/${d.id}/print`, { format: "a4", lang: "bn", reason: "lost" }), 201);
    expect(second.print).toMatchObject({ copy: 1, reason: "lost" });
    expect(second.verifyCode).toBe(first.verifyCode);
    const audits = await db!.forTenant(T, (tx) => tx.auditEvent.findMany({ where: { entity: "Composition", entityId: d.id, action: { in: ["print", "reprint"] } }, orderBy: { at: "asc" } }));
    expect(audits.map((a) => a.action)).toEqual(["print", "reprint"]);
    expect(audits[1]!.detail).toMatchObject({ copy: 1, reason: "lost", format: "a4", lang: "bn" });
  });

  it("issue #19: a draft never prints (422) — the preview shows it with the DRAFT watermark and no QR", async () => {
    const d = await draft();
    expect((await printState("rx", d.id)).blockers).toEqual(["draft_not_printable"]);
    const r = await post(`/v1/documents/rx/${d.id}/print`, {});
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ code: "draft_not_printable", message_en: "Drafts cannot be printed — sign first" });
    const pre = await get(`/v1/documents/rx/${d.id}/preview?format=a5&lang=both`);
    expect(pre.statusCode).toBe(200);
    expect(pre.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
    expect(await db!.forTenant(T, (tx) => tx.documentCode.count({ where: { documentId: d.id } }))).toBe(0);
  });

  it("an amended note: v2 prints; v1 is superseded — no print, and its QR page says a newer version exists", async () => {
    const d = await signed();
    const v1 = ok<PrintView>(await post(`/v1/documents/rx/${d.id}/print`, {}), 201);
    const am = ok<{ draft: { id: string; rev: number } }>(await post(`/v1/compositions/${d.id}/amend`, { reason: "extend the course to five days" }), 201);
    const c2 = ok<{ id: string; rev: number }>(await put(`/v1/compositions/${am.draft.id}`, { rev: am.draft.rev, ...NOTE([]), medications: [{ medicineKey: "napa", dose: "1+0+1", meal: "after", days: 5 }] }));
    ok(await post(`/v1/compositions/${c2.id}/sign`, { rev: c2.rev, pin: "1234", aiReviewed: false, uncodedAllergiesChecked: false }));
    expect((await printState("rx", d.id)).blockers).toEqual(["superseded_not_printable"]);
    expect((await post(`/v1/documents/rx/${d.id}/print`, { reason: "copy" })).json().code).toBe("superseded_not_printable");
    expect(ok<{ status: string; version: number }>(await get(`/v1/verify/rx/${v1.verifyCode}`, null))).toMatchObject({ status: "superseded", version: 1 });
    const v2 = ok<PrintView>(await post(`/v1/documents/rx/${c2.id}/print`, {}), 201);
    expect(ok<{ status: string; version: number; medicines: { days: number }[] }>(await get(`/v1/verify/rx/${v2.verifyCode}`, null))).toMatchObject({ status: "current", version: 2, medicines: [{ days: 5 }] });
  });

  it("decision D2: the public prescription page needs no session and shows initials, sex, age and the medicines — no name, phone or diagnosis", async () => {
    const d = await signed();
    const code = ok<PrintView>(await post(`/v1/documents/rx/${d.id}/print`, {}), 201).verifyCode!;
    const r = await get(`/v1/verify/rx/${code.toLowerCase()}`, null);
    expect(r.headers["cache-control"]).toBe("no-store");
    const v = ok<Record<string, unknown>>(r);
    expect(v).toMatchObject({ facilityEn: "E2E Test Clinic", doctorEn: "Dr. Test", status: "current", version: 1,
      patient: { initials: `P. P. ${RUN[0]!.toUpperCase()}.`, sex: "female", ageYears: expect.any(Number) }, medicines: [{ brand: expect.any(String), dose: "1+0+1", meal: "after", days: 3 }] });
    const text = r.body;
    expect(text).not.toMatch(/Print Patient|প্রিন্ট রোগী|019\d{8}|5A11|Tiredness|pale|Drink water/);
    expect((await get("/v1/verify/rx/0000000000000000AAAA", null)).statusCode).toBe(404);
    expect((await get("/v1/verify/rx/not-a-code", null)).statusCode).toBe(404);
  });

  it("who prints: the doctor; not the receptionist or the lab; another tenant gets 404", async () => {
    const d = await signed();
    expect((await post(`/v1/documents/rx/${d.id}/print`, {}, "desk")).statusCode).toBe(403);
    expect((await post(`/v1/documents/rx/${d.id}/print`, {}, "tech")).statusCode).toBe(403);
    expect((await get(`/v1/documents/rx/${d.id}/print`, "liteDoctor")).statusCode).toBe(404);
    expect((await post(`/v1/documents/rx/${d.id}/print`, {}, "liteDoctor")).statusCode).toBe(404);
    expect((await post(`/v1/documents/rx/${d.id}/print`, {}, "doctor", null)).json().code).toBe("idempotency_key_required");
  });
});

describe.runIf(db)("lab report print (decision D10 of A8–A11)", () => {
  it("a released version prints for the lab and the doctor; its QR page shows the results; a superseded version does not print", async () => {
    const d = await signed(["rbs"]);
    let v = ok<{ specimens: { id: string; status: string }[] }>(await post(`/v1/lab/visits/${d.enc}/labels`, {}, "tech"));
    for (const sp of v.specimens.filter((x) => x.status === "pending")) for (const step of ["collect", "receive", "start"]) ok(await post(`/v1/lab/specimens/${sp.id}/${step}`, { at: now() }, "tech"));
    type LV = { orders: { id: string; results: { id: string; status: string }[] }[]; release: { observationIds: string[] }; reports: { id: string; version: number }[] };
    let lv = ok<LV>(await get(`/v1/lab/visits/${d.enc}`, "tech"));
    ok(await post(`/v1/lab/orders/${lv.orders[0]!.id}/results`, { entries: [{ analyteCode: "rbs", value: "11.2" }] }, "tech"), 201);
    lv = ok<LV>(await get(`/v1/lab/visits/${d.enc}`, "tech"));
    ok(await post(`/v1/lab/visits/${d.enc}/verify`, { pin: "1234", observationIds: lv.orders[0]!.results.map((r) => r.id), deltaChecked: true }, "tech"));
    ok(await post(`/v1/lab/visits/${d.enc}/validate`, { pin: "1234", observationIds: lv.orders[0]!.results.map((r) => r.id) }, "path"));
    lv = ok<LV>(await get(`/v1/lab/visits/${d.enc}`, "tech"));
    lv = ok<LV>(await post(`/v1/lab/visits/${d.enc}/release`, { observationIds: lv.release.observationIds }, "path"), 201);
    const rep = lv.reports[0]!.id;
    const p = ok<PrintView>(await post(`/v1/documents/lr/${rep}/print`, { format: "a4" }, "tech"), 201);
    expect(ok<PrintView>(await post(`/v1/documents/lr/${rep}/print`, { reason: "copy" }, "doctor"), 201).prints.map((x) => x.copy)).toEqual([0, 1]);
    expect((await post(`/v1/documents/lr/${rep}/print`, { reason: "copy" }, "desk")).statusCode).toBe(403);
    const pub = ok<{ status: string; reportStatus: string; patient: { initials: string }; results: { code: string; value: number; flag: string; underCorrection: boolean }[] }>(await get(`/v1/verify/lr/${p.verifyCode}`, null));
    expect(pub).toMatchObject({ status: "current", reportStatus: "final", patient: { initials: `P. P. ${RUN[0]!.toUpperCase()}.` }, results: [{ code: "rbs", value: 11.2, flag: "H", underCorrection: false }] });
    // a correction released as v2 supersedes v1: v1 no longer prints; its page says superseded and marks the value
    lv = ok<LV>(await get(`/v1/lab/visits/${d.enc}`, "tech"));
    const obs = lv.orders[0]!.results.find((r) => r.status === "final")!;
    ok(await post(`/v1/lab/observations/${obs.id}/correct`, { value: "12.1", reason: "transcription error at entry" }, "tech"), 201);
    lv = ok<LV>(await get(`/v1/lab/visits/${d.enc}`, "tech"));
    const pre = lv.orders[0]!.results.filter((r) => r.status === "preliminary").map((r) => r.id);
    ok(await post(`/v1/lab/visits/${d.enc}/verify`, { pin: "1234", observationIds: pre, deltaChecked: true }, "tech"));
    ok(await post(`/v1/lab/visits/${d.enc}/validate`, { pin: "1234", observationIds: pre }, "path"));
    lv = ok<LV>(await get(`/v1/lab/visits/${d.enc}`, "tech"));
    ok(await post(`/v1/lab/visits/${d.enc}/release`, { observationIds: lv.release.observationIds }, "path"), 201);
    expect((await post(`/v1/documents/lr/${rep}/print`, { reason: "copy" }, "tech")).json().code).toBe("superseded_not_printable");
    expect(ok<{ status: string; results: { underCorrection: boolean }[] }>(await get(`/v1/verify/lr/${p.verifyCode}`, null))).toMatchObject({ status: "superseded", results: [{ underCorrection: true }] });
  }, 60_000);
});

describe.runIf(db)("ADR 0007 database guards (printing)", () => {
  it("no code for a draft; prints in order only; codes and prints never edited", async () => {
    const d = await draft();
    await expect(db!.forTenant(T, (tx) => tx.documentCode.create({ data: { tenantId: T, organizationId: "o_e2e", kind: "rx", documentId: d.id, verifyCode: "ABCDEFGHJKMNPQRSTVWX", createdById: "u_e2e_doctor" } }), { userId: "u_e2e_doctor" }))
      .rejects.toThrow();
    const s = await signed();
    const p = ok<PrintView>(await post(`/v1/documents/rx/${s.id}/print`, {}), 201);
    const code = await db!.forTenant(T, (tx) => tx.documentCode.findFirst({ where: { documentId: s.id } }));
    await expect(db!.forTenant(T, (tx) => tx.documentPrint.create({ data: { tenantId: T, codeId: code!.id, copy: 3, reason: "lost", format: "a5", lang: "both", storageKey: "x", printedById: "u_e2e_doctor" } }), { userId: "u_e2e_doctor" }))
      .rejects.toThrow(/out of order/);
    await expect(db!.forTenant(T, (tx) => tx.documentPrint.updateMany({ where: { id: p.prints[0]!.id }, data: { reason: "jam" } }), { userId: "u_e2e_doctor" })).rejects.toThrow();
    await expect(db!.forTenant(T, (tx) => tx.documentCode.deleteMany({ where: { id: code!.id } }), { userId: "u_e2e_doctor" })).rejects.toThrow();
  });
});

describe("print templates (no database)", () => {
  const base: RxInput = {
    lang: "both", paper: "a5", mode: "print", facility: { en: "Green Life Clinic", bn: "গ্রিন লাইফ ক্লিনিক", address: null },
    doctor: { en: "Dr. Test", bn: "ডা. টেস্ট", regBody: "BMDC", regNo: "A-52817", regVerified: false },
    patient: { nameEn: "Rahima Khatun", nameBn: "রহিমা খাতুন", facilityNo: "GLC-240117", ageYears: 42, sex: "female" }, visit: { token: "A-017", date: new Date("2026-10-03T04:00:00Z") },
    signedAt: new Date("2026-10-03T04:30:00Z"), version: 1, amended: false,
    allergies: [{ labelEn: "Penicillin", labelBn: "পেনিসিলিন", reaction: "rash" }], complaints: [{ text: "Fever", duration: { n: 3, unit: "d" } }],
    exam: { general: "", cvs: "", chest: "", abdomen: "" }, diagnoses: [{ code: "5A11", labelEn: "Type 2 diabetes mellitus", labelBn: "টাইপ ২ ডায়াবেটিস", provisional: true, sample: true }],
    orders: [{ nameEn: "CBC", nameBn: "সিবিসি" }], medicines: [{ brand: "Comet", generic: "Metformin", strength: "500 mg", form: "Tab.", dose: "1+0+1", meal: "after", days: 30, sample: true }],
    advice: "<script>alert(1)</script>", followUp: "", verify: { url: "http://localhost:3000/verify/rx/ABCDEFGHJKMNPQRSTVWX", code: "ABCDEFGHJKMNPQRSTVWX" }, print: null,
  };
  it("a print has the QR, the grouped code, the allergy line, 'Digitally signed', the sample notes; record text is escaped", () => {
    const h = rxHtml(base);
    expect(h).toContain("<svg");
    expect(h).toContain("ABCD-EFGH-JKMN-PQRS-TVWX");
    expect(h).toMatch(/ALLERGY[^<]*: পেনিসিলিন · Penicillin \(rash\)/);
    expect(h).toContain("BMDC A-52817 · not verified");
    expect(h).toContain("Digitally signed");
    expect(h).toContain("Sample medicine list (prototype)");
    expect(h).not.toContain("<script>alert(1)</script>");
    expect(h).toContain("&lt;script&gt;");
    expect(h).toContain("size:148mm 210mm");
  });
  it("a draft: the DRAFT watermark, no QR, 'Not signed', 'Drafts cannot be printed — sign first'", () => {
    const h = rxHtml({ ...base, mode: "draft", verify: null, signedAt: null });
    expect(h).toContain("খসড়া — বৈধ নয় · DRAFT");
    expect(h).not.toContain("<svg");
    expect(h).toContain("Not signed");
    expect(h).toContain("Drafts cannot be printed — sign first");
  });
  it("a reprint: DUPLICATE #2 mark, watermark and the reprint line; A4 paper", () => {
    const h = rxHtml({ ...base, paper: "a4", print: { copy: 2, reason: "jam", printedAt: new Date("2026-10-03T05:00:00Z"), printedBy: { nameBn: "ডা. টেস্ট", nameEn: "Dr. Test" } } });
    expect(h).toContain("অনুলিপি · DUPLICATE #2");
    expect(h).toContain("Printer jam / unclear");
    expect(h).toContain("size:210mm 297mm");
  });
  it("Bangla only: Bangla digits and labels", () => {
    const h = rxHtml({ ...base, lang: "bn" });
    expect(h).toContain("৪২ বছর");
    expect(h).toContain("৩০ দিন");
  });
  it("lab report: PRELIMINARY banner, a value under correction struck with 'do not act on it'", () => {
    const h = lrHtml({ lang: "en", paper: "a5", mode: "print", facility: base.facility, patient: base.patient, visit: { token: "A-017" },
      report: { number: "LR/26/0008", version: 1, status: "preliminary", testCount: 3, pendingCount: 1, releasedAt: new Date(), releasedBy: { en: "Dr. Path", bn: "ডা. প্যাথ" } },
      tests: [{ nameEn: "S. Electrolytes", nameBn: "ইলেক্ট্রোলাইট", results: [{ nameEn: "S. Potassium", nameBn: "পটাশিয়াম", value: 6.9, decimals: 1, unit: "mmol/L", flag: "HH", refLow: 3.5, refHigh: 5.1, refLabel: "adult", underCorrection: true, withdrawn: false }] }],
      pending: [{ nameEn: "CBC", nameBn: "সিবিসি" }], callbacks: [], validatedBy: null, verify: base.verify, print: null });
    expect(h).toContain("PRELIMINARY — 1 of 3 tests pending");
    expect(h).toContain("HH · Critical high");
    expect(h).toContain("Under correction — do not act on it");
    expect(h).toContain('class="strike"');
    expect(h).toContain("3.5–5.1 · adult range");
  });
});
