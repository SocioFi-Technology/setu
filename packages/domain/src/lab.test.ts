import { describe, expect, it } from "vitest";
import {
  ANALYTES_SAMPLE, DELTA_LIMIT_PCT, RANGES_SAMPLE, analytesOf, callbackCheck, correctionCheck, deltaOf, isCritical, labFlag, parseLabValue, patientAgeYears, rangeFor,
  releasePlan, resultEntryCheck, revokeBlockers, samePersonAllowed, smsPlaceholdersOk, specimenNumber, labReportNumber, tubeFor, tubePlan, validateBlockers, verifyBlockers,
  decimalsOf, rejectCheck, returnBlockers, withdrawBlockers, WITHDRAWN_REASON, type ReleaseTest,
} from "./lab.js";
import { COMMUNICATION, LAB_REPORT, RESULT, TransitionError, can, transition } from "./machines.js";

const adultF = { sex: "female" as const, ageYears: 42 };
const adultM = { sex: "male" as const, ageYears: 42 };
const child = { sex: "female" as const, ageYears: 9 };
const analyte = (code: string) => ANALYTES_SAMPLE.find((a) => a.code === code)!;
const flagFor = (code: string, v: number, p = adultF) => labFlag(v, rangeFor(RANGES_SAMPLE, code, p), analyte(code));

describe("machines (ADR 0006)", () => {
  it("RESULT: entered → technical verify → clinical validation; no shortcut from preliminary to final", () => {
    expect(transition("result", RESULT, "registered", "enter")).toBe("preliminary");
    expect(transition("result", RESULT, "preliminary", "verify")).toBe("verified");
    expect(transition("result", RESULT, "verified", "validate")).toBe("final");
    expect(can(RESULT, "preliminary", "validate")).toBe(false);
    expect(can(RESULT, "registered", "verify")).toBe(false);
  });
  it("RESULT: a correction marks the old row entered-in-error from any entered state; that is terminal", () => {
    for (const from of ["preliminary", "verified", "final", "amended"] as const) expect(transition("result", RESULT, from, "markError")).toBe("entered-in-error");
    // decision 119: only a verified result can be sent back, and it goes back to preliminary (verify again)
    expect(transition("result", RESULT, "verified", "return")).toBe("preliminary");
    for (const from of ["registered", "preliminary", "final", "amended", "entered-in-error"] as const) expect(can(RESULT, from, "return")).toBe(false);
    expect(can(RESULT, "registered", "markError")).toBe(false);
    for (const ev of ["enter", "verify", "validate", "amend", "markError"] as const) expect(can(RESULT, "entered-in-error", ev)).toBe(false);
  });
  it("LAB_REPORT: every released version can only be superseded", () => {
    for (const from of ["preliminary", "final", "corrected"] as const) expect(transition("report", LAB_REPORT, from, "supersede")).toBe("superseded");
    expect(() => transition("report", LAB_REPORT, "superseded", "supersede")).toThrow(TransitionError);
  });
  it("COMMUNICATION: a failed send is retried by re-queuing the same message; delivered is terminal", () => {
    expect(transition("comm", COMMUNICATION, "preparation", "send")).toBe("in-progress");
    expect(transition("comm", COMMUNICATION, "in-progress", "fail")).toBe("failed");
    expect(transition("comm", COMMUNICATION, "failed", "retry")).toBe("preparation");
    expect(transition("comm", COMMUNICATION, "in-progress", "deliver")).toBe("completed");
    for (const ev of ["send", "deliver", "fail", "retry"] as const) expect(can(COMMUNICATION, "completed", ev)).toBe(false);
    expect(can(COMMUNICATION, "preparation", "retry")).toBe(false);
  });
});

describe("tube guidance (A8)", () => {
  it("EDTA for CBC, fluoride for RBS, plain for electrolytes (walkthrough A8)", () => {
    expect(tubeFor("cbc")).toBe("edta");
    expect(tubeFor("rbs")).toBe("fluoride");
    expect(tubeFor("elec")).toBe("plain");
    expect(tubeFor("ure")).toBe("urine");
    expect(tubeFor("cxr")).toBeNull();
  });
  it("the A5 orders need three tubes; collecting one leaves the visit partially collected", () => {
    const orders = [{ id: "o1", testCode: "cbc", status: "active" as const }, { id: "o2", testCode: "rbs", status: "active" as const }, { id: "o3", testCode: "elec", status: "active" as const }];
    const p0 = tubePlan(orders, []);
    expect(p0.tubes.map((t) => t.tube).sort()).toEqual(["edta", "fluoride", "plain"]);
    expect(p0.status).toBe("pending");
    const p1 = tubePlan([{ ...orders[0]!, status: "in-progress" }, orders[1]!, orders[2]!], [{ id: "s1", tube: "edta", status: "collected", orderIds: ["o1"] }]);
    expect(p1.status).toBe("partial");
    expect(p1.tubes.map((t) => t.tube).sort()).toEqual(["fluoride", "plain"]);
    const p2 = tubePlan(orders.map((o) => ({ ...o, status: "in-progress" as const })), [
      { id: "s1", tube: "edta", status: "in-process", orderIds: ["o1"] }, { id: "s2", tube: "fluoride", status: "received", orderIds: ["o2"] }, { id: "s3", tube: "plain", status: "collected", orderIds: ["o3"] },
    ]);
    expect(p2).toMatchObject({ status: "collected", tubes: [] });
  });
  it("tests sharing a tube share one label; a printed-but-uncollected label is reused", () => {
    const orders = [{ id: "o1", testCode: "cbc", status: "active" as const }, { id: "o2", testCode: "hba1c", status: "active" as const }];
    const p = tubePlan(orders, [{ id: "s9", tube: "edta", status: "pending", orderIds: ["o1", "o2"] }]);
    expect(p.tubes).toEqual([{ tube: "edta", orderIds: ["o1", "o2"], specimenId: "s9", recollect: false }]);
  });
  it("a rejected tube needs a new one (recollect); cancelled orders need no tube", () => {
    const orders = [{ id: "o1", testCode: "cbc", status: "in-progress" as const }, { id: "o2", testCode: "rbs", status: "revoked" as const }];
    const p = tubePlan(orders, [{ id: "s1", tube: "edta", status: "rejected", orderIds: ["o1"] }]);
    expect(p.tubes).toEqual([{ tube: "edta", orderIds: ["o1"], specimenId: null, recollect: true }]);
    expect(p.status).toBe("rejected");
    expect(tubePlan([{ id: "o2", testCode: "rbs", status: "revoked" }], []).status).toBe("none");
  });
  it("issue #28 / reject reasons: a reason from the list; 'other' needs a note of 10+ characters", () => {
    expect(rejectCheck({ reason: "haemolysed" })).toEqual([]);
    expect(rejectCheck({ reason: "other", note: "short" })).toEqual(["note_required"]);
    expect(rejectCheck({ reason: "other", note: "tube cracked in transit" })).toEqual([]);
    expect(rejectCheck({ reason: "bad" as never })).toEqual(["reason_invalid"]);
  });
  it("display numbers are Latin digits: S-yymm-nnnn and LR/yy/nnnn", () => {
    expect(specimenNumber("2610", 441)).toBe("S-2610-0441");
    expect(labReportNumber("26", 7)).toBe("LR/26/0007");
  });
});

describe("ranges and flags (A9, decision D1)", () => {
  it("the walkthrough values: Hb 9.6 L, WBC 11800 H, K 6.9 HH (critical), Na 138 N", () => {
    expect(flagFor("hb", 9.6)).toBe("L");
    expect(flagFor("wbc", 11800)).toBe("H");
    expect(flagFor("k", 6.9)).toBe("HH");
    expect(isCritical(flagFor("k", 6.9))).toBe(true);
    expect(flagFor("na", 138)).toBe("N");
    expect(flagFor("rbs", 11.2)).toBe("H");
  });
  it("range ends are inside the range; critical thresholds are strict (prototype '<7', '>6.2')", () => {
    expect(flagFor("hb", 12.0)).toBe("N");
    expect(flagFor("hb", 15.5)).toBe("N");
    expect(flagFor("k", 6.2)).toBe("H");
    expect(flagFor("hb", 7)).toBe("L");
    expect(flagFor("hb", 6.9)).toBe("LL");
  });
  it("Hb has only an adult female range: a man gets no range and no H/L, but critical still applies", () => {
    expect(rangeFor(RANGES_SAMPLE, "hb", adultF)).toMatchObject({ low: 12, high: 15.5, label: "adult-female" });
    expect(rangeFor(RANGES_SAMPLE, "hb", adultM)).toBeNull();
    expect(flagFor("hb", 9.6, adultM)).toBeNull();
    expect(flagFor("hb", 6.5, adultM)).toBe("LL");
  });
  it("under 18 (and unknown age) there is no range in the sample list; critical thresholds (adult) still apply", () => {
    expect(rangeFor(RANGES_SAMPLE, "na", child)).toBeNull();
    expect(rangeFor(RANGES_SAMPLE, "na", { sex: "female", ageYears: null })).toBeNull();
    expect(flagFor("na", 150, child)).toBeNull();
    expect(flagFor("k", 6.9, child)).toBe("HH");
    expect(rangeFor(RANGES_SAMPLE, "na", adultM)).toMatchObject({ label: "adult" });
  });
  it("every seeded analyte and range is a sample pending clinician sign-off", () => {
    expect(ANALYTES_SAMPLE.every((a) => a.sample)).toBe(true);
    expect(RANGES_SAMPLE.every((r) => r.sample)).toBe(true);
    expect(analytesOf("cbc").map((a) => a.code)).toEqual(["hb", "wbc", "plt"]);
    expect(analytesOf("elec").map((a) => a.code)).toEqual(["na", "k", "cl"]);
    expect(analytesOf("lipid")).toEqual([]);
  });
  it("age at collection from a date of birth or an approximate age", () => {
    const at = new Date("2026-10-03T05:00:00Z");
    expect(patientAgeYears({ birthDate: "1984-10-04", approxAgeYears: null, approxAgeAt: null }, at)).toBe(41);
    expect(patientAgeYears({ birthDate: null, approxAgeYears: 42, approxAgeAt: "2025-09-01T00:00:00Z" }, at)).toBe(43);
    expect(patientAgeYears({ birthDate: null, approxAgeYears: null, approxAgeAt: null }, at)).toBeNull();
  });
});

describe("result entry (A9, decision D2)", () => {
  const cbc = analytesOf("cbc");
  const rf = (code: string) => rangeFor(RANGES_SAMPLE, code, adultF);
  it("non-numbers and negatives are refused; Bangla digits are read", () => {
    expect(parseLabValue("৯.৬")).toEqual({ ok: true, value: 9.6 });
    expect(parseLabValue("abc")).toEqual({ ok: false, code: "not_a_number" });
    expect(parseLabValue("11,800")).toEqual({ ok: false, code: "not_a_number" });
    expect(parseLabValue("-1")).toEqual({ ok: false, code: "negative" });
    expect(parseLabValue(" ")).toEqual({ ok: false, code: "required" });
  });
  it("every analyte of the test needs a value", () => {
    const r = resultEntryCheck(cbc, [{ analyteCode: "hb", raw: "9.6" }], rf);
    expect(r.errors).toEqual([{ field: "wbc", code: "required" }, { field: "plt", code: "required" }]);
  });
  it("a critical value must be typed twice, the same", () => {
    const elec = analytesOf("elec");
    const base = [{ analyteCode: "na", raw: "138" }, { analyteCode: "cl", raw: "101" }];
    expect(resultEntryCheck(elec, [...base, { analyteCode: "k", raw: "6.9" }], rf).errors).toEqual([{ field: "k", code: "confirm_required" }]);
    expect(resultEntryCheck(elec, [...base, { analyteCode: "k", raw: "6.9", confirm: "9.6" }], rf).errors).toEqual([{ field: "k", code: "confirm_mismatch" }]);
    const ok = resultEntryCheck(elec, [...base, { analyteCode: "k", raw: "6.9", confirm: "6.90" }], rf);
    expect(ok.errors).toEqual([]);
    expect(ok.values.find((v) => v.analyteCode === "k")).toMatchObject({ value: 6.9, flag: "HH" });
  });
  it("clinical review M2: no more decimals than the analyte reports (Na 119.6 would show as 120 next to 'critical <120')", () => {
    const elec = analytesOf("elec");
    const r = resultEntryCheck(elec, [{ analyteCode: "na", raw: "119.6" }, { analyteCode: "k", raw: "4.25" }, { analyteCode: "cl", raw: "101" }], rf);
    expect(r.errors).toEqual([{ field: "na", code: "too_many_decimals" }, { field: "k", code: "too_many_decimals" }]);
    expect(decimalsOf("৪.২")).toBe(1);
    expect(decimalsOf("138")).toBe(0);
  });
  it("unknown or repeated analytes are refused", () => {
    const r = resultEntryCheck(cbc, [{ analyteCode: "hb", raw: "9" }, { analyteCode: "hb", raw: "9" }, { analyteCode: "wbc", raw: "8000" }, { analyteCode: "plt", raw: "200000" }, { analyteCode: "k", raw: "4" }], rf);
    expect(r.errors).toEqual([{ field: "hb", code: "duplicate" }, { field: "k", code: "unknown_analyte" }]);
  });
  it("delta check: Hb and K beyond 20% of the previous result warn; WBC is not checked", () => {
    expect(DELTA_LIMIT_PCT).toBe(20);
    expect(deltaOf(9.6, 12.1, analyte("hb"))).toEqual({ pct: -21, hit: true });
    expect(deltaOf(6.9, 4.6, analyte("k"))).toEqual({ pct: 50, hit: true });
    expect(deltaOf(138, 137, analyte("na"))).toEqual({ pct: 1, hit: false });
    expect(deltaOf(11800, 8200, analyte("wbc"))).toBeNull();
    expect(deltaOf(5, null, analyte("k"))).toBeNull();
  });
});

describe("verify, call-back, validate (A10)", () => {
  const prelim = (id: string, flag: "N" | "HH" | "LL" | "H" | null = "N", deltaHit = false) => ({ id, status: "preliminary" as const, flag, verifiedById: null, deltaHit });
  const verified = (id: string, flag: "N" | "HH" | "LL" | "H" | null = "N", by = "u_tech") => ({ id, status: "verified" as const, flag, verifiedById: by, deltaHit: false });
  it("technical verify: lab technologist or pathologist; delta hits need the sample-identity tick", () => {
    expect(verifyBlockers({ role: "labTech", results: [prelim("a")], deltaChecked: false })).toEqual([]);
    expect(verifyBlockers({ role: "admin", results: [prelim("a")], deltaChecked: false })).toEqual([{ code: "role" }]);
    expect(verifyBlockers({ role: "labTech", results: [prelim("a", "L", true)], deltaChecked: false })).toEqual([{ code: "delta_unchecked", observationId: "a" }]);
    expect(verifyBlockers({ role: "labTech", results: [verified("a")], deltaChecked: false })).toEqual([{ code: "not_preliminary", observationId: "a" }]);
    expect(verifyBlockers({ role: "labTech", results: [], deltaChecked: false })).toEqual([{ code: "nothing_to_verify" }]);
  });
  it("validation is locked until the critical call-back is logged (walkthrough A10)", () => {
    const results = [verified("na"), verified("k", "HH")];
    const base = { role: "pathologist" as const, userId: "u_path", samePersonAllowed: false, results };
    expect(validateBlockers({ ...base, callbacks: [] })).toEqual([{ code: "callback_missing", observationId: "k" }]);
    // an attempt that reached no one does not unblock
    expect(validateBlockers({ ...base, callbacks: [{ observationId: "k", outcome: "no-answer", readBack: false }] })).toEqual([{ code: "callback_missing", observationId: "k" }]);
    // a call-back for another (e.g. the replaced) observation does not count
    expect(validateBlockers({ ...base, callbacks: [{ observationId: "k-old", outcome: "reached", readBack: true }] })).toEqual([{ code: "callback_missing", observationId: "k" }]);
    expect(validateBlockers({ ...base, callbacks: [{ observationId: "k", outcome: "reached", readBack: true }] })).toEqual([]);
    expect(validateBlockers({ ...base, results: [verified("hb", "LL")], callbacks: [] })).toEqual([{ code: "callback_missing", observationId: "hb" }]);
  });
  it("only a pathologist validates, only verified results, and never the verifier on a Hospital plan", () => {
    const cb = [{ observationId: "k", outcome: "reached" as const, readBack: true }];
    expect(validateBlockers({ role: "labTech", userId: "u_tech", samePersonAllowed: true, results: [verified("a")], callbacks: cb })).toEqual([{ code: "role" }]);
    expect(validateBlockers({ role: "pathologist", userId: "u_path", samePersonAllowed: false, results: [prelim("a")], callbacks: [] })).toEqual([{ code: "not_verified", observationId: "a" }]);
    expect(validateBlockers({ role: "pathologist", userId: "u_path", samePersonAllowed: false, results: [verified("a", "N", "u_path")], callbacks: [] })).toEqual([{ code: "same_person", observationId: "a" }]);
    expect(validateBlockers({ role: "pathologist", userId: "u_path", samePersonAllowed: true, results: [verified("a", "N", "u_path")], callbacks: [] })).toEqual([]);
    expect(validateBlockers({ role: "pathologist", userId: "u_path", samePersonAllowed: false, results: [], callbacks: [] })).toEqual([{ code: "nothing_to_validate" }]);
  });
  it("same person: allowed on the Clinic plan by default, not on Hospital Lite / Pro; a facility setting wins", () => {
    expect(samePersonAllowed("clinic", null)).toBe(true);
    expect(samePersonAllowed("lite", null)).toBe(false);
    expect(samePersonAllowed("pro", null)).toBe(false);
    expect(samePersonAllowed("pro", true)).toBe(true);
    expect(samePersonAllowed("clinic", false)).toBe(false);
  });
  it("a call-back record: role and name of the person reached, the time (not in the future, not before the result), read-back ticked", () => {
    const now = new Date("2026-10-03T04:10:00Z"), enteredAt = new Date("2026-10-03T04:00:00Z");
    const ok = { outcome: "reached" as const, recipientRole: "ordering-doctor" as const, recipientName: "Dr. Test", at: new Date("2026-10-03T04:05:00Z"), via: "phone" as const, readBack: true, now, enteredAt };
    expect(callbackCheck(ok)).toEqual([]);
    expect(callbackCheck({ ...ok, readBack: false })).toEqual(["read_back_required"]);
    expect(callbackCheck({ ...ok, recipientName: " " })).toEqual(["name_required"]);
    expect(callbackCheck({ ...ok, at: new Date("2026-10-03T04:30:00Z") })).toEqual(["time_future"]);
    expect(callbackCheck({ ...ok, at: new Date("2026-10-03T03:00:00Z") })).toEqual(["time_before_result"]);
    expect(callbackCheck({ ...ok, recipientRole: "nurse" as never })).toEqual(["recipient_role_invalid"]);
    // an attempt: logged with who was tried, never with a read-back
    expect(callbackCheck({ ...ok, outcome: "no-answer", readBack: false })).toEqual([]);
    expect(callbackCheck({ ...ok, outcome: "no-answer", readBack: true })).toEqual(["read_back_without_answer"]);
  });
});

describe("corrections (decision D4)", () => {
  it("a correction needs a reason of 10+ characters and a different value; an entered-in-error result cannot be corrected again", () => {
    expect(correctionCheck({ status: "final", oldValue: 128, newValue: 138, reason: "transcription error" })).toEqual([]);
    expect(correctionCheck({ status: "final", oldValue: 128, newValue: 138, reason: "typo" })).toEqual(["reason_required"]);
    expect(correctionCheck({ status: "verified", oldValue: 128, newValue: 128, reason: "transcription error" })).toEqual(["same_value"]);
    expect(correctionCheck({ status: "entered-in-error", oldValue: 128, newValue: 138, reason: "transcription error" })).toEqual(["not_current"]);
  });
});

describe("release (decision D3)", () => {
  const r = (id: string, status: "preliminary" | "verified" | "final" | "entered-in-error", replacesId: string | null = null) => ({ id, status, replacesId });
  const cbcFinal: ReleaseTest = { orderId: "cbc", revoked: false, analyteCount: 3, results: [r("hb", "final"), r("wbc", "final"), r("plt", "final")] };
  const rbsFinal: ReleaseTest = { orderId: "rbs", revoked: false, analyteCount: 1, results: [r("rbs", "final")] };
  const elecWaiting: ReleaseTest = { orderId: "elec", revoked: false, analyteCount: 3, results: [] };
  it("validated tests release early as PRELIMINARY — n of m pending", () => {
    const p = releasePlan({ tests: [cbcFinal, rbsFinal, elecWaiting], lastReleased: [], everReleased: [] });
    expect(p).toMatchObject({ status: "preliminary", pending: 1, total: 3, orderIds: ["cbc", "rbs"], blockers: [] });
    expect(p.observationIds.sort()).toEqual(["hb", "plt", "rbs", "wbc"]);
  });
  it("a critical result never waits on another tube: K alone can go out while CBC is still being verified", () => {
    const elecFinal: ReleaseTest = { orderId: "elec", revoked: false, analyteCount: 3, results: [r("na", "final"), r("k", "final"), r("cl", "final")] };
    const cbcVerified: ReleaseTest = { orderId: "cbc", revoked: false, analyteCount: 3, results: [r("hb", "verified"), r("wbc", "verified"), r("plt", "verified")] };
    const p = releasePlan({ tests: [cbcVerified, elecFinal], lastReleased: [], everReleased: [] });
    expect(p).toMatchObject({ status: "preliminary", pending: 1, total: 2, orderIds: ["elec"], blockers: [] });
  });
  it("final when every test not cancelled is validated; cancelled tests do not count", () => {
    const revoked: ReleaseTest = { orderId: "hba1c", revoked: true, analyteCount: 1, results: [] };
    const p = releasePlan({ tests: [cbcFinal, rbsFinal, revoked], lastReleased: ["hb", "wbc", "plt"], everReleased: ["hb", "wbc", "plt"] });
    expect(p).toMatchObject({ status: "final", pending: 0, total: 2, blockers: [] });
  });
  it("nothing validated, or nothing new since the last version → no release", () => {
    expect(releasePlan({ tests: [elecWaiting], lastReleased: [], everReleased: [] }).blockers).toEqual(["nothing_validated"]);
    expect(releasePlan({ tests: [cbcFinal], lastReleased: ["hb", "wbc", "plt"], everReleased: ["hb", "wbc", "plt"] }).blockers).toEqual(["nothing_new"]);
  });
  it("a test is not released while one of its results is under correction; the version is Corrected (a released value changed)", () => {
    const cbcCorrecting: ReleaseTest = { orderId: "cbc", revoked: false, analyteCount: 3, results: [r("hb", "entered-in-error"), r("hb2", "preliminary", "hb"), r("wbc", "final"), r("plt", "final")] };
    const p = releasePlan({ tests: [cbcCorrecting, rbsFinal], lastReleased: ["hb", "wbc", "plt"], everReleased: ["hb", "wbc", "plt"] });
    expect(p).toMatchObject({ orderIds: ["rbs"], pending: 1, status: "corrected" });
  });
  it("decision 133: a withdrawn test (results entered-in-error, no replacement) is pending; later versions are Corrected", () => {
    const cbcWithdrawn: ReleaseTest = { orderId: "cbc", revoked: false, analyteCount: 3, results: [r("hb", "entered-in-error"), r("wbc", "entered-in-error"), r("plt", "entered-in-error")] };
    expect(releasePlan({ tests: [cbcWithdrawn, rbsFinal], lastReleased: ["hb", "wbc", "plt"], everReleased: ["hb", "wbc", "plt"] })).toMatchObject({ orderIds: ["rbs"], pending: 1, status: "corrected" });
    const redone: ReleaseTest = { ...cbcWithdrawn, results: [...cbcWithdrawn.results, r("hb3", "final"), r("wbc3", "final"), r("plt3", "final")] };
    expect(releasePlan({ tests: [redone, rbsFinal], lastReleased: ["rbs"], everReleased: ["hb", "wbc", "plt", "rbs"] })).toMatchObject({ pending: 0, status: "corrected", blockers: [] });
  });
  it("a version that replaces a released result is Corrected (even if other tests are still pending)", () => {
    const cbcCorrected: ReleaseTest = { orderId: "cbc", revoked: false, analyteCount: 3, results: [r("hb", "entered-in-error"), r("hb2", "final", "hb"), r("wbc", "final"), r("plt", "final")] };
    expect(releasePlan({ tests: [cbcCorrected, rbsFinal], lastReleased: ["hb", "wbc", "plt", "rbs"], everReleased: ["hb", "wbc", "plt", "rbs"] })).toMatchObject({ status: "corrected", pending: 0, blockers: [] });
    expect(releasePlan({ tests: [cbcCorrected, elecWaiting], lastReleased: ["hb", "wbc", "plt"], everReleased: ["hb", "wbc", "plt"] })).toMatchObject({ status: "corrected", pending: 1 });
    // a correction of a value that was never released is an ordinary release
    expect(releasePlan({ tests: [cbcCorrected], lastReleased: [], everReleased: [] })).toMatchObject({ status: "final" });
  });
  it("a correction of a correction still counts as correcting a released result", () => {
    const t: ReleaseTest = { orderId: "rbs", revoked: false, analyteCount: 1, results: [r("a", "entered-in-error"), r("b", "entered-in-error", "a"), r("c", "final", "b")] };
    expect(releasePlan({ tests: [t], lastReleased: ["a"], everReleased: ["a"] }).status).toBe("corrected");
  });
});

describe("send-back and withdrawal (decisions 119, 133)", () => {
  const v = { status: "verified" as const }, p = { status: "preliminary" as const }, e = { status: "entered-in-error" as const }, f = { status: "final" as const };
  it("only the pathologist returns a test, only when every current result is verified, with a reason of 10+ characters", () => {
    expect(returnBlockers({ role: "pathologist", results: [v, v, e], reason: "Hb does not fit the film" })).toEqual([]);
    expect(returnBlockers({ role: "labTech", results: [v], reason: "Hb does not fit the film" })).toEqual(["role"]);
    expect(returnBlockers({ role: "pathologist", results: [v, p], reason: "Hb does not fit the film" })).toEqual(["not_verified"]);
    expect(returnBlockers({ role: "pathologist", results: [f], reason: "too short" })).toEqual(["not_verified", "reason_required"]);
  });
  it("withdraw: lab technologist or pathologist, a reason, and something to withdraw", () => {
    expect(withdrawBlockers({ role: "labTech", results: [f, f], reason: "tube belonged to another patient" })).toEqual([]);
    expect(withdrawBlockers({ role: "pathologist", results: [p], reason: "tube belonged to another patient" })).toEqual([]);
    expect(withdrawBlockers({ role: "doctor", results: [f], reason: "tube belonged to another patient" })).toEqual(["role"]);
    expect(withdrawBlockers({ role: "labTech", results: [e], reason: "short" })).toEqual(["nothing_to_withdraw", "reason_required"]);
  });
  it("after a withdrawal the test needs a new tube (recollect) even though the order is complete; tests on that tube with results keep them", () => {
    const orders = [{ id: "o1", testCode: "cbc", status: "complete" as const, hasResults: false }, { id: "o2", testCode: "hba1c", status: "complete" as const, hasResults: true }];
    const p2 = tubePlan(orders, [{ id: "s1", tube: "edta", status: "rejected", orderIds: ["o1", "o2"] }]);
    expect(p2.tubes).toEqual([{ tube: "edta", orderIds: ["o1"], specimenId: null, recollect: true }]);
    expect(WITHDRAWN_REASON).toBe("results-withdrawn");
  });
});

describe("order cancellation (decision D5)", () => {
  const base = { orderStatus: "active" as const, role: "doctor", userId: "u_doc", orderedById: "u_doc", reason: "ordered for the wrong visit" };
  it("the ordering doctor, the lab technologist or the pathologist, with a reason of 10+ characters", () => {
    expect(revokeBlockers(base)).toEqual([]);
    expect(revokeBlockers({ ...base, role: "labTech", userId: "u_tech" })).toEqual([]);
    expect(revokeBlockers({ ...base, role: "pathologist", userId: "u_path" })).toEqual([]);
    expect(revokeBlockers({ ...base, userId: "u_doc2" })).toEqual(["not_ordering_doctor"]);
    expect(revokeBlockers({ ...base, role: "admin", userId: "u_admin" })).toEqual(["role"]);
    expect(revokeBlockers({ ...base, reason: "wrong" })).toEqual(["reason_required"]);
  });
  it("only before the first tube is collected", () => {
    expect(revokeBlockers({ ...base, orderStatus: "in-progress" })).toEqual(["collected"]);
    expect(revokeBlockers({ ...base, orderStatus: "complete" })).toEqual(["collected"]);
    expect(revokeBlockers({ ...base, orderStatus: "revoked" })).toEqual(["already_revoked"]);
    expect(revokeBlockers({ ...base, orderStatus: "draft" })).toEqual(["not_placed"]);
  });
});

describe("SMS templates", () => {
  it("only the facility name may be filled in (no values, tests, diagnosis or patient name)", () => {
    expect(smsPlaceholdersOk("{facility}: your lab report is ready.")).toBe(true);
    expect(smsPlaceholdersOk("{facility}: {patient}, your report is ready.")).toBe(false);
    expect(smsPlaceholdersOk("{facility}: K {value}")).toBe(false);
  });
});
