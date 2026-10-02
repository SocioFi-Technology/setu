import { describe, expect, it } from "vitest";
import { ICD11_SAMPLE, MEDICINES_SAMPLE, TESTS_SAMPLE, catalogMatch } from "./catalog.js";
import { consultAccess, emptySections, parseComplaint, signBlockers, type SignCheck } from "./consultation.js";
import type { AllergyFact, RxLine } from "./prescription.js";

const moxacil = MEDICINES_SAMPLE.find((m) => m.id === "moxacil")!;
const napa = MEDICINES_SAMPLE.find((m) => m.id === "napa")!;
const rx = (m: typeof napa, uid: string): RxLine => ({ uid, medicine: m, dose: m.defaults.dose, meal: m.defaults.meal, days: m.defaults.days });
const PEN: AllergyFact = { id: "al_pen", kind: "class", key: "penicillin", labelBn: "পেনিসিলিন", labelEn: "Penicillin", reaction: "rash" };
const ready = (over: Partial<SignCheck> = {}): SignCheck => ({
  sections: { ...emptySections(), complaints: [{ text: "Burning micturition", duration: { n: 5, unit: "d" } }] },
  sources: {}, diagnoses: [{ code: "GC08" }], lines: [rx(napa, "a")], allergies: [PEN], aiReviewed: false, uncodedAllergiesChecked: false, ...over,
});

describe("sign blockers (walkthrough A5)", () => {
  it("a complete note with no conflict may be signed", () => {
    expect(signBlockers(ready())).toEqual([]);
  });
  it("the Penicillin conflict blocks signing", () => {
    expect(signBlockers(ready({ lines: [rx(moxacil, "m")] })).map((b) => b.code === "rx" ? b.warning.kind : b.code)).toEqual(["allergy"]);
  });
  it("the same medicine twice blocks until Keep both (issue #16)", () => {
    expect(signBlockers(ready({ lines: [rx(napa, "a"), rx(napa, "b")] }))).toHaveLength(1);
    expect(signBlockers(ready({ lines: [rx(napa, "a"), { ...rx(napa, "b"), keepBoth: true }] }))).toEqual([]);
  });
  it("text inserted from the AI draft needs the 'I reviewed' tick (rule 2)", () => {
    expect(signBlockers(ready({ sources: { history: "ai-draft", exam: "ai-draft" } }))).toEqual([{ code: "ai_review_required", sections: ["history", "exam"] }]);
    expect(signBlockers(ready({ sources: { history: "ai-draft" }, aiReviewed: true }))).toEqual([]);
    expect(signBlockers(ready({ sources: { history: "provider-verified" } }))).toEqual([]);
  });
  it("a free-text allergy needs the doctor's own check when anything is prescribed", () => {
    const egg: AllergyFact = { id: "al_egg", kind: "other", key: null, labelBn: "ডিম", labelEn: "Egg" };
    expect(signBlockers(ready({ allergies: [egg] })).map((b) => b.code)).toEqual(["uncoded_allergy_check"]);
    expect(signBlockers(ready({ allergies: [egg], uncodedAllergiesChecked: true }))).toEqual([]);
    expect(signBlockers(ready({ allergies: [egg], lines: [] }))).toEqual([]);
  });
  it("a note needs a complaint and a diagnosis (a provisional one is enough)", () => {
    expect(signBlockers(ready({ sections: emptySections(), diagnoses: [] })).map((b) => b.code)).toEqual(["no_complaint", "no_diagnosis"]);
  });
  it("an amendment needs a reason of at least 5 characters (ADR 0003)", () => {
    expect(signBlockers(ready({ isAmendment: true, amendReason: "abc" })).map((b) => b.code)).toEqual(["amend_reason"]);
    expect(signBlockers(ready({ isAmendment: true, amendReason: "Urine C/S sensitivity" }))).toEqual([]);
  });
});

describe("opening a consultation (decision 28; Kamrul 02/10/2026)", () => {
  it("a doctor opening a waiting or vitals-done visit starts it and is assigned", () => {
    expect(consultAccess("arrived", null, "u1", true)).toEqual({ allowed: true, event: "start", assign: true, readOnly: false });
    expect(consultAccess("triaged", "u1", "u1", true)).toEqual({ allowed: true, event: "start", assign: false, readOnly: false });
  });
  it("re-opening a visit already with this doctor is a no-op", () => {
    expect(consultAccess("in-progress", "u1", "u1", true)).toEqual({ allowed: true, event: null, assign: false, readOnly: false });
  });
  it("someone who is not a doctor never starts the visit", () => {
    expect(consultAccess("triaged", null, "u2", false)).toEqual({ allowed: true, event: null, assign: false, readOnly: true });
  });
  it("another doctor's visit is refused; a closed visit cannot be opened; a finished one is read-only", () => {
    expect(consultAccess("in-progress", "u1", "u2", true)).toEqual({ allowed: false, reason: "other-doctor" });
    expect(consultAccess("cancelled", null, "u2", true)).toEqual({ allowed: false, reason: "not-open" });
    expect(consultAccess("finished", "u1", "u1", true)).toMatchObject({ allowed: true, event: null, readOnly: true });
  });
});

describe("complaints (prototype quick entry)", () => {
  it("reads a duration in English or Bangla", () => {
    expect(parseComplaint("fever 3d")).toEqual({ text: "fever", duration: { n: 3, unit: "d" } });
    expect(parseComplaint("excessive thirst 2 months")).toEqual({ text: "excessive thirst", duration: { n: 2, unit: "m" } });
    expect(parseComplaint("জ্বর ৩ দিন")).toEqual({ text: "জ্বর", duration: { n: 3, unit: "d" } });
    expect(parseComplaint("কাশি, ২ সপ্তাহ")).toEqual({ text: "কাশি", duration: { n: 2, unit: "w" } });
  });
  it("text without a number has no duration; empty is nothing", () => {
    expect(parseComplaint("burning micturition")).toEqual({ text: "burning micturition", duration: null });
    expect(parseComplaint("   ")).toBeNull();
  });
});

describe("sample catalogues (labelled, never invented)", () => {
  it("ICD-11 has the prototype's 10 codes, all unverified, searchable in Bangla and English", () => {
    expect(ICD11_SAMPLE).toHaveLength(10);
    expect(ICD11_SAMPLE.every((c) => c.verification === "unverified-prototype")).toBe(true);
    const find = (q: string) => ICD11_SAMPLE.filter((c) => catalogMatch(q, c.code, c.bn, c.en, c.aliases)).map((c) => c.code);
    expect(find("diabetes")).toEqual(["5A11"]);
    expect(find("ডায়াবেটিস")).toEqual(["5A11"]);
    expect(find("প্রেসার")).toEqual(["BA00"]);
    expect(find("uti")).toContain("GC08");
    expect(find("")).toEqual([]);
  });
  it("every medicine is labelled sample; CBC, RBS and S. Electrolytes can be ordered (A6 bills them)", () => {
    expect(MEDICINES_SAMPLE.every((m) => m.sample && m.ingredients.length > 0)).toBe(true);
    expect(TESTS_SAMPLE.map((t) => t.nameEn)).toEqual(expect.arrayContaining(["CBC", "RBS", "S. Electrolytes"]));
  });
});
