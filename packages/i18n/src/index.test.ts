import { describe, expect, it } from "vitest";
import { NAMESPACES, missingEnglish, t } from "./index.js";
describe("i18n", () => {
  it("has the design's namespaces and falls back safely", () => {
    expect(NAMESPACES.length).toBeGreaterThan(10);
    expect(t("bn", "nope", "nope")).toBe("nope");
  });
  it("app namespaces load beside the design ones, with {placeholders}", async () => {
    const { fill } = await import("./index.js");
    expect(t("en", "frontDeskApp", "fields_need_attention")).toBe("{n} field(s) need attention");
    expect(fill(t("bn", "frontDeskApp", "fields_need_attention"), { n: "৭" })).toBe("৭টি ঘর ঠিক করুন");
  });
  it("every Bangla key has an English string (CLAUDE.md rule)", () => {
    expect(missingEnglish()).toEqual([]);
  });
});
