/* ADR 0023 (E4) — another clinic's view of the history: sensitive never (sample list), current medicines, active
   problems, blood group, access requests. */
import { describe, expect, it } from "vitest";
import { ACCESS_REQUEST_WAIT_DAYS, accessRequestProblems, answerRequest, isActiveProblem, isBloodGroup, isCurrentMedicine, isSensitiveCondition, isSensitiveMedicine, itemKindsFor, newestPerKey } from "./history.js";

const now = new Date("2026-10-10T06:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 864e5);

describe("sensitive categories (sample list) — never shown, never hinted", () => {
  it("mental health (chapter 06), HIV (1C6x), sexually transmitted infections (1A6x–1A9x), sexual health (HA), abortion (JA0x)", () => {
    for (const c of ["6A70", "6B00", "6C40", "1C62", "1A60", "1A90", "HA00", "JA00", "6e20"]) expect(isSensitiveCondition(c), c).toBe(true);
  });
  it("everything else is not: diabetes, hypertension, UTI, typhoid, dengue", () => {
    for (const c of ["5A11", "BA00", "GC08", "1A07", "1D20", "3A00"]) expect(isSensitiveCondition(c), c).toBe(false);
  });
  it("medicines whose class reveals one (antiretroviral, antipsychotic, antidepressant)", () => {
    expect(isSensitiveMedicine(["antiretroviral"])).toBe(true);
    expect(isSensitiveMedicine(["antidepressant", "ssri"])).toBe(true);
    expect(isSensitiveMedicine(["ppi"])).toBe(false);
  });
});

describe("current medicines and active problems", () => {
  it("an outpatient line within its days from the signing; an inpatient order while active", () => {
    expect(isCurrentMedicine({ kind: "opd", days: 30, orderStatus: "active", signedAt: daysAgo(10) }, now)).toBe(true);
    expect(isCurrentMedicine({ kind: "opd", days: 5, orderStatus: "active", signedAt: daysAgo(10) }, now)).toBe(false);
    expect(isCurrentMedicine({ kind: "opd", days: 5, orderStatus: "active", signedAt: null }, now)).toBe(false);
    expect(isCurrentMedicine({ kind: "inpatient", days: 0, orderStatus: "active", signedAt: daysAgo(400) }, now)).toBe(true);
    expect(isCurrentMedicine({ kind: "inpatient", days: 0, orderStatus: "stopped", signedAt: daysAgo(1) }, now)).toBe(false);
  });
  it("a diagnosis of a signed note in the last 180 days is active", () => {
    expect(isActiveProblem(daysAgo(179), now)).toBe(true);
    expect(isActiveProblem(daysAgo(181), now)).toBe(false);
    expect(isActiveProblem(null, now)).toBe(false);
  });
  it("the newest per key, newest first", () => {
    const rows = [{ k: "5A11", at: daysAgo(30) }, { k: "BA00", at: daysAgo(5) }, { k: "5A11", at: daysAgo(2) }];
    expect(newestPerKey(rows, (r) => r.k, (r) => r.at).map((r) => [r.k, r.at])).toEqual([["5A11", daysAgo(2)], ["BA00", daysAgo(5)]]);
  });
  it("blood group: the eight, nothing else", () => {
    expect(isBloodGroup("O+")).toBe(true);
    expect(isBloodGroup("AB-")).toBe(true);
    expect(isBloodGroup("C+")).toBe(false);
    expect(isBloodGroup("o+")).toBe(false);
  });
});

describe("access requests", () => {
  it("kinds from the list (no repeats), today's visit or 30 days, a reason of 10+ characters", () => {
    expect(accessRequestProblems({ kinds: ["reports", "summaries"], period: "24h", reason: "First visit, diabetes follow-up" })).toEqual([]);
    expect(accessRequestProblems({ kinds: [], period: "24h", reason: "First visit, diabetes" })).toEqual(["kinds"]);
    expect(accessRequestProblems({ kinds: ["reports", "reports"], period: "24h", reason: "First visit, diabetes" })).toEqual(["kinds"]);
    expect(accessRequestProblems({ kinds: ["sensitive"], period: "24h", reason: "First visit, diabetes" })).toEqual(["kinds"]);
    expect(accessRequestProblems({ kinds: ["reports"], period: "1y", reason: "short" })).toEqual(["period", "reason"]);
  });
  it("the kinds open their history items", () => {
    expect(itemKindsFor(["reports", "visits"]).sort()).toEqual(["admission", "report", "visit"]);
  });
  it("the patient answers once; an unanswered request expires after 7 days", () => {
    expect(answerRequest("sent", daysAgo(1), "approve", now)).toEqual({ state: "granted" });
    expect(answerRequest("sent", daysAgo(1), "deny", now)).toEqual({ state: "denied" });
    expect(answerRequest("granted", daysAgo(1), "deny", now)).toEqual({ state: "granted", refused: "answered" });
    expect(answerRequest("sent", daysAgo(ACCESS_REQUEST_WAIT_DAYS + 1), "approve", now)).toEqual({ state: "expired", refused: "expired" });
  });
});
