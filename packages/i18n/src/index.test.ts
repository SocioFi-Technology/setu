import { describe, expect, it } from "vitest";
import { NAMESPACES, missingEnglish, t } from "./index.js";
describe("i18n", () => {
  it("has the design's namespaces and falls back safely", () => {
    expect(NAMESPACES.length).toBeGreaterThan(10);
    expect(t("bn", "nope", "nope")).toBe("nope");
  });
  it("every Bangla key has an English string (CLAUDE.md rule)", () => {
    expect(missingEnglish()).toEqual([]);
  });
});
