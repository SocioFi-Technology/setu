import { describe, expect, it } from "vitest";
import { copyCheck, initials, labReportPrintBlockers, rxPrintBlockers, rxVerifyStatus, REPRINT_REASONS } from "./printing.js";

describe("prescription print (A13, issue #19)", () => {
  it("drafts cannot be printed — sign first (also queued offline signs)", () => {
    expect(rxPrintBlockers("draft")).toEqual(["draft_not_printable"]);
    expect(rxPrintBlockers("queued")).toEqual(["draft_not_printable"]);
  });
  it("a signed or amended version prints", () => {
    expect(rxPrintBlockers("final")).toEqual([]);
    expect(rxPrintBlockers("amended")).toEqual([]);
  });
  it("a superseded version does not print (a newer version exists); a withdrawn one never", () => {
    expect(rxPrintBlockers("superseded")).toEqual(["superseded_not_printable"]);
    expect(rxPrintBlockers("entered-in-error")).toEqual(["withdrawn_not_printable"]);
  });
});

describe("lab report print (decision D10 of A8–A11)", () => {
  it("every released version that is current prints (preliminary carries its banner)", () => {
    for (const s of ["preliminary", "final", "corrected"] as const) expect(labReportPrintBlockers(s)).toEqual([]);
  });
  it("a superseded version does not print", () => expect(labReportPrintBlockers("superseded")).toEqual(["superseded_not_printable"]));
});

describe("copies: the first is the original; later copies need a reason and are DUPLICATE #n", () => {
  it("first print: no reason", () => {
    expect(copyCheck(0, undefined)).toEqual({ copy: 0 });
    expect(copyCheck(0, "lost")).toEqual({ error: "not_printed_yet" });
  });
  it("reprint: a reason from the list", () => {
    expect(copyCheck(1, undefined)).toEqual({ error: "reprint_needs_reason" });
    expect(copyCheck(1, "lost")).toEqual({ copy: 1 });
    expect(copyCheck(3, "jam")).toEqual({ copy: 3 });
    expect(REPRINT_REASONS).toEqual(["lost", "jam", "copy"]);
  });
});

describe("verify page (decision D2)", () => {
  it("current / superseded / withdrawn from the document status", () => {
    expect(rxVerifyStatus("final")).toBe("current");
    expect(rxVerifyStatus("amended")).toBe("current");
    expect(rxVerifyStatus("superseded")).toBe("superseded");
    expect(rxVerifyStatus("entered-in-error")).toBe("withdrawn");
  });
  it("a draft has no verify page", () => expect(rxVerifyStatus("draft")).toBeNull());
  it("initials from the English name, else the Bangla; never the full name", () => {
    expect(initials("Rahima Khatun", "রহিমা খাতুন")).toBe("R. K.");
    expect(initials("  karim  uddin ahmed ", null)).toBe("K. U. A.");
    expect(initials(null, "রহিমা খাতুন")).toBe("র. খ.");
    expect(initials(null, null)).toBe("—");
  });
});
