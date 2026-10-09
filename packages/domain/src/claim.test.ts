/* ADR 0020 — claiming a facility's records in the patient app: the code as typed, and one attempt against the CLAIM
   machine (3 wrong → locked 24 h; walkthrough issue #3: only the right code links). */
import { describe, expect, it } from "vitest";
import { CLAIM_CODE_ALPHABET, claimAttempt, normalizeClaimCode, isClaimCode } from "./claim.js";

const now = new Date("2026-10-09T08:00:00Z");
const at = (h: number) => new Date(now.getTime() + h * 3600_000);

describe("normalizeClaimCode — what a patient types", () => {
  it("upper case, spaces / dashes dropped, Bangla digits read", () => {
    expect(normalizeClaimCode("7k4q2m")).toBe("7K4Q2M");
    expect(normalizeClaimCode(" 7K4-Q2M ")).toBe("7K4Q2M");
    expect(normalizeClaimCode("৭K৪Q২M")).toBe("7K4Q2M");
  });
  it("refuses what cannot be a code: wrong length, letters outside the alphabet (0 O 1 I L)", () => {
    for (const bad of ["7K4Q2", "7K4Q2MM", "7K4Q20", "OK4Q2M", "1K4Q2M", "IK4Q2M", "LK4Q2M", "", "7K4Q2!"]) expect(normalizeClaimCode(bad), bad).toBeNull();
  });
  it("the alphabet has no look-alikes", () => {
    for (const c of "01OIL") expect(CLAIM_CODE_ALPHABET.includes(c)).toBe(false);
    expect(CLAIM_CODE_ALPHABET).toHaveLength(31);
    expect(isClaimCode("7K4Q2M")).toBe(true);
  });
});

describe("claimAttempt — one proof attempt", () => {
  const pending = { status: "proof-pending" as const, tries: 0, lockedUntil: null };
  it("the right code links, whatever came before", () => {
    expect(claimAttempt(pending, true, now)).toMatchObject({ status: "linked", tries: 0, triesLeft: 3, lockedUntil: null });
    expect(claimAttempt({ ...pending, tries: 2 }, true, now)).toMatchObject({ status: "linked" });
    expect(claimAttempt({ status: "candidate", tries: 0, lockedUntil: null }, true, now)).toMatchObject({ status: "linked" });
  });
  it("a wrong code counts down: 2 left, then 1, then locked for 24 hours", () => {
    const a = claimAttempt(pending, false, now);
    expect(a).toMatchObject({ status: "proof-pending", tries: 1, triesLeft: 2, lockedUntil: null });
    const b = claimAttempt({ ...pending, tries: 1 }, false, now);
    expect(b).toMatchObject({ status: "proof-pending", tries: 2, triesLeft: 1 });
    const c = claimAttempt({ ...pending, tries: 2 }, false, now);
    expect(c).toMatchObject({ status: "locked", tries: 3, triesLeft: 0, lockedUntil: at(24) });
  });
  it("while locked nothing is tried — not even the right code", () => {
    const locked = { status: "locked" as const, tries: 3, lockedUntil: at(5) };
    expect(claimAttempt(locked, true, now)).toMatchObject({ refused: "locked", status: "locked", lockedUntil: at(5) });
    expect(claimAttempt(locked, false, now)).toMatchObject({ refused: "locked" });
  });
  it("after the 24 hours the lock lifts with fresh tries", () => {
    const expired = { status: "locked" as const, tries: 3, lockedUntil: at(-1) };
    expect(claimAttempt(expired, false, now)).toMatchObject({ status: "proof-pending", tries: 1, triesLeft: 2, lockedUntil: null });
    expect(claimAttempt(expired, true, now)).toMatchObject({ status: "linked" });
  });
  it("a closed claim (linked, not mine) takes no attempt", () => {
    expect(claimAttempt({ status: "linked", tries: 0, lockedUntil: null }, true, now)).toMatchObject({ refused: "closed" });
    expect(claimAttempt({ status: "not-mine", tries: 0, lockedUntil: null }, true, now)).toMatchObject({ refused: "closed" });
  });
});
