/* External review C: catalog.ts had no test file of its own. The lists are samples (not for clinical use — HANDOVER gap
   12); what is tested here is their shape and the functions the API and the seed rely on. */
import { describe, expect, it } from "vitest";
import {
  CONSULT_FEE_SAMPLE_PAISA, DESK_ITEMS_SAMPLE, ICD11_SAMPLE, INPATIENT_MEDICINES_SAMPLE, MEDICINES_SAMPLE, TESTS_SAMPLE, TEST_PRICES_SAMPLE,
  allergyIngredients, catalogMatch, consultCode, priceListSample, testCode, wardMedicine,
} from "./catalog.js";

describe("catalogMatch — the API's catalogue search", () => {
  it("a case-insensitive substring over any of the fields, Bangla or English", () => {
    expect(catalogMatch("metf", "Comet", "Metformin HCl")).toBe(true);
    expect(catalogMatch("COMET", "Comet")).toBe(true);
    expect(catalogMatch("কমেট", "Comet", "কমেট")).toBe(true);
    expect(catalogMatch("  dm ", "Type 2 diabetes mellitus", "ডায়াবেটিস, sugar, DM")).toBe(true);
  });
  it("no match, an empty query and missing fields", () => {
    expect(catalogMatch("insulin", "Comet", "Metformin HCl")).toBe(false);
    expect(catalogMatch("", "Comet")).toBe(false);
    expect(catalogMatch("   ", "Comet")).toBe(false);
    expect(catalogMatch("met", null, undefined, "Metformin")).toBe(true);
  });
});

describe("the sample lists", () => {
  it("keys are unique; every ICD-11 code is marked unverified; every medicine has ingredients and a default dose", () => {
    const keys = (xs: { id?: string; key?: string; code?: string }[]) => xs.map((x) => x.id ?? x.key ?? x.code);
    for (const list of [ICD11_SAMPLE, MEDICINES_SAMPLE, INPATIENT_MEDICINES_SAMPLE, TESTS_SAMPLE, DESK_ITEMS_SAMPLE]) expect(new Set(keys(list as never)).size).toBe(list.length);
    expect(ICD11_SAMPLE.every((c) => c.verification === "unverified-prototype")).toBe(true);
    expect(MEDICINES_SAMPLE.every((m) => m.ingredients.length > 0 && /^\d\+\d\+\d$/.test(m.defaults.dose))).toBe(true);
  });
  it("allergyIngredients: every ingredient of the list once, sorted", () => {
    const a = allergyIngredients();
    expect(a).toEqual([...new Set(a)].sort());
    expect(a).toEqual(expect.arrayContaining(["metformin", "ciprofloxacin"]));
    for (const m of MEDICINES_SAMPLE) for (const i of m.ingredients) expect(a).toContain(i);
  });
  it("wardMedicine: the ward flags of an OPD or inpatient medicine; null for an unknown key", () => {
    expect(wardMedicine(MEDICINES_SAMPLE[0]!.id)).toMatchObject({ key: MEDICINES_SAMPLE[0]!.id, inpatientOnly: false });
    expect(wardMedicine(INPATIENT_MEDICINES_SAMPLE[0]!.key)).toMatchObject({ key: INPATIENT_MEDICINES_SAMPLE[0]!.key });
    expect(wardMedicine("no-such-medicine")).toBeNull();
  });
});

describe("priceListSample — the seed's sample price list", () => {
  const list = priceListSample([{ id: "u_doc", nameEn: "Dr. Test", nameBn: "ডা. টেস্ট" }]);
  it("one consultation per doctor at the sample fee, codes from consultCode", () => {
    expect(list.filter((p) => p.kind === "consultation")).toEqual([expect.objectContaining({ code: consultCode("u_doc"), refCode: "u_doc", unitPaisa: CONSULT_FEE_SAMPLE_PAISA, vatRateBp: 0 })]);
  });
  it("a test is priced only when the prototype gave it a price — never ৳0; codes from testCode", () => {
    const tests = list.filter((p) => p.kind === "test");
    expect(tests.map((t) => t.refCode).sort()).toEqual(TESTS_SAMPLE.map((t) => t.code).filter((c) => TEST_PRICES_SAMPLE[c] !== undefined).sort());
    expect(tests.every((t) => t.unitPaisa > 0 && t.code === testCode(t.refCode!))).toBe(true);
  });
  it("the desk items, whole paisa, VAT only where the list says (15% on the card and the certificate)", () => {
    const desk = list.filter((p) => p.code.startsWith("desk:"));
    expect(desk).toHaveLength(DESK_ITEMS_SAMPLE.length);
    expect(desk.every((d) => Number.isSafeInteger(d.unitPaisa) && d.unitPaisa > 0)).toBe(true);
    expect(desk.filter((d) => d.vatRateBp > 0).map((d) => d.code).sort()).toEqual(["desk:card", "desk:cert"]);
  });
});
