/* ADR 0021 — a lab result in plain language for the patient (Kamrul 09/10/2026): drafts from the lab catalogue, marked
   draft; NEVER for a critical result until a clinician signs the wording off — then only the value, the flag and
   "contact your doctor / the facility now". */
import { describe, expect, it } from "vitest";
import { LAB_PLAIN_SAMPLE, labPlain, rangePosition } from "./labPlain.js";
import { ANALYTES_SAMPLE } from "./lab.js";

describe("labPlain", () => {
  it("every analyte in the catalogue has a draft (what it measures, its unit, low and high)", () => {
    for (const a of ANALYTES_SAMPLE) {
      const p = LAB_PLAIN_SAMPLE.find((x) => x.code === a.code);
      expect(p, a.code).toBeDefined();
      expect(p!.signedOff, a.code).toBe(false);
    }
  });
  it("normal / high / low: the what-it-measures key, the unit key and one direction sentence, marked draft", () => {
    expect(labPlain("hba1c", "H")).toEqual({ kind: "explained", draft: true, what: "hba1c_what", unit: "unit_pct", direction: "hba1c_high" });
    expect(labPlain("hb", "L")).toEqual({ kind: "explained", draft: true, what: "hb_what", unit: "unit_g_dl", direction: "hb_low" });
    expect(labPlain("na", "N")).toEqual({ kind: "explained", draft: true, what: "na_what", unit: "unit_mmol_l", direction: "in_range" });
    expect(labPlain("k", null)).toEqual({ kind: "explained", draft: true, what: "k_what", unit: "unit_mmol_l", direction: null });
  });
  it("a critical result (LL / HH) gets no explanation at all — only the contact-now line", () => {
    expect(labPlain("k", "HH")).toEqual({ kind: "critical" });
    expect(labPlain("hb", "LL")).toEqual({ kind: "critical" });
  });
  it("critical stays wording-free even if a draft were signed off (the clinician's sign-off is a later decision per analyte)", () => {
    expect(labPlain("k", "HH", [{ code: "k", unit: "unit_mmol_l", signedOff: true }])).toEqual({ kind: "critical" });
  });
  it("an analyte with no draft: nothing explained, never a guess", () => {
    expect(labPlain("tsh", "H")).toEqual({ kind: "none" });
  });
});

describe("rangePosition — where the value sits on the bar (the range is the middle third)", () => {
  it("the low end at 1/3, the high end at 2/3, inside in between", () => {
    expect(rangePosition(4.0, 4.0, 5.6)).toBeCloseTo(1 / 3);
    expect(rangePosition(5.6, 4.0, 5.6)).toBeCloseTo(2 / 3);
    expect(rangePosition(4.8, 4.0, 5.6)).toBeCloseTo(0.5);
  });
  it("outside the range: proportionally beyond, clamped to the bar", () => {
    expect(rangePosition(7.2, 4.0, 5.6)).toBeCloseTo(1);
    expect(rangePosition(100, 4.0, 5.6)).toBe(1);
    expect(rangePosition(-50, 4.0, 5.6)).toBe(0);
  });
  it("no range: null (the bar says so)", () => {
    expect(rangePosition(5, null, null)).toBeNull();
    expect(rangePosition(5, 3, 3)).toBeNull();
  });
});
