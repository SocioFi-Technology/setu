import { describe, expect, it } from "vitest";
import { MEDICINES_SAMPLE } from "./catalog.js";
import { allergyMatches, rxBlockers, rxQuantity, rxWarnings, type AllergyFact, type RxLine } from "./prescription.js";

const med = (id: string) => { const m = MEDICINES_SAMPLE.find((x) => x.id === id); if (!m) throw new Error(id); return m; };
let n = 0;
const line = (id: string, over: Partial<RxLine> = {}): RxLine => { const m = med(id); return { uid: `l${++n}`, medicine: m, dose: m.defaults.dose, meal: m.defaults.meal, days: m.defaults.days, ...over }; };
/* Walkthrough A5: Rahima Khatun — Penicillin (rash) and Sulfa. */
const PENICILLIN: AllergyFact = { id: "al_pen", kind: "class", key: "penicillin", labelBn: "পেনিসিলিন", labelEn: "Penicillin", reaction: "rash" };
const SULFA: AllergyFact = { id: "al_sulfa", kind: "class", key: "sulfonamide", labelBn: "সালফা", labelEn: "Sulfa drugs" };
const RAHIMA = [PENICILLIN, SULFA];

describe("allergy conflict blocks signing (walkthrough A5)", () => {
  it("Moxacil (amoxicillin, a penicillin) against a Penicillin allergy blocks, with Remove as the only action", () => {
    const l = line("moxacil");
    const w = rxWarnings([line("comet"), l], RAHIMA);
    expect(w).toEqual([expect.objectContaining({ line: l.uid, kind: "allergy", block: true, actions: ["remove"], allergy: PENICILLIN })]);
  });
  it("Cotrim DS (a sulfonamide) against a Sulfa allergy blocks", () => {
    expect(rxBlockers([line("cotrim")], RAHIMA).map((w) => [w.kind, w.allergy?.id])).toEqual([["allergy", "al_sulfa"]]);
  });
  it("a substance allergy matches the ingredient of any brand (Fimoxyl is amoxicillin too)", () => {
    const amox: AllergyFact = { id: "al_amox", kind: "substance", key: "amoxicillin", labelBn: "অ্যামোক্সিসিলিন", labelEn: "Amoxicillin" };
    expect(allergyMatches(med("fimoxyl"), [amox])).toEqual([amox]);
    expect(allergyMatches(med("napa"), [amox])).toEqual([]);
  });
  it("a free-text allergy cannot be matched automatically (it is handled by the sign check instead)", () => {
    const other: AllergyFact = { id: "al_x", kind: "other", key: null, labelBn: "ডিম", labelEn: "Egg" };
    expect(rxWarnings([line("moxacil")], [other])).toEqual([]);
  });
  it("no allergy, no allergy warning", () => {
    expect(rxWarnings([line("moxacil")], [])).toEqual([]);
  });
});

describe("same medicine already prescribed (walkthrough issue #16)", () => {
  it("Napa twice: the second line blocks until Remove or Keep both; the first line is not flagged", () => {
    const a = line("napa"), b = line("napa");
    const w = rxWarnings([a, b], []);
    expect(w).toEqual([expect.objectContaining({ line: b.uid, kind: "same-medicine", block: true, actions: ["remove", "keepBoth"], firstLine: a.uid, firstBrand: "Napa", ingredient: "paracetamol" })]);
  });
  it("compares generics, not brands: Napa then Ace (both paracetamol) is the same medicine", () => {
    expect(rxWarnings([line("napa"), line("ace")], []).map((w) => w.kind)).toEqual(["same-medicine"]);
  });
  it("Keep both clears the block but the line still shows it was kept", () => {
    const w = rxWarnings([line("napa"), line("napa", { keepBoth: true })], []);
    expect(w).toEqual([expect.objectContaining({ kind: "same-medicine", block: false, kept: true })]);
    expect(rxBlockers([line("napa"), line("napa", { keepBoth: true })], [])).toEqual([]);
  });
  it("a combination sharing one ingredient is the same medicine (any shared generic)", () => {
    const combo = { ...med("napa"), id: "x", brand: "Combo", ingredients: ["paracetamol", "caffeine"] };
    expect(rxWarnings([line("napa"), { ...line("napa"), medicine: combo }], []).map((w) => [w.kind, w.ingredient])).toEqual([["same-medicine", "paracetamol"]]);
  });
});

describe("same class", () => {
  it("Seclo then Sergel (two PPIs) blocks on the second, Remove only", () => {
    const b = line("sergel");
    expect(rxWarnings([line("seclo"), b], [])).toEqual([expect.objectContaining({ line: b.uid, kind: "same-class", block: true, actions: ["remove"], classKey: "ppi" })]);
  });
  it("the same PPI twice is reported once, as the same medicine (not also as same class)", () => {
    expect(rxWarnings([line("seclo"), line("seclo")], []).map((w) => w.kind)).toEqual(["same-medicine"]);
  });
});

describe("interaction (decision D4)", () => {
  it("Clopirel with Seclo (omeprazole) blocks on the clopidogrel line until acknowledged", () => {
    const c = line("clopi");
    const w = rxWarnings([line("seclo"), c], []);
    expect(w).toEqual([expect.objectContaining({ line: c.uid, kind: "interaction", block: true, actions: ["acknowledge"], ruleId: "clopidogrel-omeprazole" })]);
    expect(rxBlockers([line("seclo"), line("clopi", { acks: ["clopidogrel-omeprazole"] })], [])).toEqual([]);
  });
  it("is matched on the ingredient omeprazole, not the brand: Pantonix (pantoprazole) does not interact", () => {
    expect(rxWarnings([line("pantonix"), line("clopi")], [])).toEqual([]);
  });
});

describe("dose, days and quantity", () => {
  it("1+0+1 × 30 = 60; 1+1+1+1 and Bangla digits are valid; a malformed dose blocks", () => {
    expect(rxQuantity("1+0+1", 30)).toBe(60);
    expect(rxQuantity("১+০+১", 5)).toBe(10);
    expect(rxQuantity("1+1+1+1", 3)).toBe(12);
    expect(rxQuantity("½+0+½", 3)).toBe(3);
    expect(rxQuantity("abc", 3)).toBe(0);
    expect(rxBlockers([line("napa", { dose: "1+1" })], []).map((w) => w.kind)).toEqual(["dose-invalid"]);
    // Clinical review A5: a 0-tablet line (0+0+0) blocks the sign like any other invalid dose; its quantity is 0.
    expect(rxBlockers([line("napa", { dose: "0+0+0" })], []).map((w) => w.kind)).toEqual(["dose-invalid"]);
    expect(rxQuantity("0+0+0", 5)).toBe(0);
  });
  it("days must be a whole number from 1 to 365", () => {
    for (const days of [0, -1, 1.5, 366]) expect(rxBlockers([line("napa", { days })], []).map((w) => w.kind)).toEqual(["days-invalid"]);
    expect(rxBlockers([line("napa", { days: 365 })], [])).toEqual([]);
  });
});

describe("the prototype's seeded draft (Comet, Ciprocin, Seclo, Napa) for Rahima Khatun", () => {
  it("has no blockers once the duplicate Napa is gone (issue #16)", () => {
    expect(rxBlockers([line("comet"), line("ciprocin"), line("seclo"), line("napa")], RAHIMA)).toEqual([]);
  });
});
