import { describe, expect, it } from "vitest";
import { ESCALATION, can, transition } from "./machines.js";
import { NEWS2_THRESHOLD_SAMPLE, ackDueAt, ackMinutesOk, escalationUnacknowledged, onDutyDoctors, informBlockers, news2, nextObsMinutes, noteOk, rrPossible, shouldEscalate } from "./ward.js";

describe("NEWS2 (RCP 2017, scale 1) — sample, pending clinician sign-off", () => {
  it("a well adult scores 0 and is complete", () => {
    const r = news2({ rr: 16, spo2: 98, onOxygen: false, sbp: 124, pulse: 76, consciousness: "A", tempF: 98.4 });
    expect(r).toMatchObject({ total: 0, complete: true, red: false, risk: "low" });
  });
  it("walkthrough B6: RR 26, pulse 124, temp 102 °F → 3 + 2 + 1 = 6, medium risk, escalates; next obs in 15 min (issue #24)", () => {
    const r = news2({ rr: 26, spo2: 96, onOxygen: false, sbp: 118, pulse: 124, consciousness: "A", tempF: 102 });
    expect(r.parts).toMatchObject({ rr: 3, pulse: 2, temp: 1, spo2: 0, sbp: 0, oxygen: 0, consciousness: 0 });
    expect(r.total).toBe(6); expect(r.risk).toBe("medium"); expect(r.red).toBe(true);
    expect(shouldEscalate(r)).toBe(true);
    expect(nextObsMinutes(r)).toBe(15);
  });
  it("band edges: SpO₂ 91 → 3, 93 → 2, 95 → 1; SBP 90 → 3, 220 → 3; pulse 40 → 3, 131 → 3; new confusion → 3; oxygen → 2", () => {
    expect(news2({ spo2: 91 }).parts.spo2).toBe(3); expect(news2({ spo2: 93 }).parts.spo2).toBe(2); expect(news2({ spo2: 95 }).parts.spo2).toBe(1);
    expect(news2({ sbp: 90 }).parts.sbp).toBe(3); expect(news2({ sbp: 220 }).parts.sbp).toBe(3); expect(news2({ sbp: 111 }).parts.sbp).toBe(0);
    expect(news2({ pulse: 40 }).parts.pulse).toBe(3); expect(news2({ pulse: 131 }).parts.pulse).toBe(3);
    expect(news2({ consciousness: "C" }).parts.consciousness).toBe(3);
    expect(news2({ onOxygen: true }).parts.oxygen).toBe(2);
    expect(news2({ tempF: 95 }).parts.temp).toBe(3); // 35.0 °C
  });
  it("the red score alone escalates (a single parameter of 3, total 3); a total of 4 without a red score does not", () => {
    const red = news2({ rr: 7, spo2: 97, sbp: 120, pulse: 80, consciousness: "A", tempF: 98.6 });
    expect(red.total).toBe(3); expect(red.red).toBe(true); expect(red.risk).toBe("low-medium");
    expect(shouldEscalate(red)).toBe(true);
    const four = news2({ rr: 22, spo2: 95, sbp: 108, pulse: 80, consciousness: "A", tempF: 98.6 });
    expect(four.total).toBe(4); expect(four.red).toBe(false);
    expect(shouldEscalate(four)).toBe(false); expect(nextObsMinutes(four)).toBe(240);
    expect(NEWS2_THRESHOLD_SAMPLE).toBe(5);
  });
  it("a partial set says what is missing and still escalates when it already reaches the threshold", () => {
    const r = news2({ rr: 30, pulse: 135 });
    expect(r.complete).toBe(false); expect(r.missing).toEqual(["spo2", "sbp", "consciousness", "temp"]);
    expect(shouldEscalate(r)).toBe(true);
  });
  it("0 → 12 h, 1–4 → 4 h", () => { expect(nextObsMinutes({ total: 0, red: false })).toBe(720); expect(nextObsMinutes({ total: 2, red: false })).toBe(240); });
  it("respiratory rate outside 1–80 is not possible", () => { expect(rrPossible(0)).toBe(false); expect(rrPossible(81)).toBe(false); expect(rrPossible(26)).toBe(true); });
});
describe("escalation log (walkthrough B6: 'spoke to' and the instruction are required)", () => {
  it("raised → doctor-informed only with who and the instruction; → resolved", () => {
    expect(informBlockers({ spokeTo: "", instruction: "" })).toEqual(["spoke_to", "instruction"]);
    expect(informBlockers({ spokeTo: "Dr. Lite Surgeon", instruction: "Repeat obs q15 min, start IV fluids" })).toEqual([]);
    expect(transition("escalation", ESCALATION, "raised", "inform")).toBe("doctor-informed");
    expect(can(ESCALATION, "raised", "resolve")).toBe(false);
    // review: worse after the doctor was informed → raised again (a new contact is logged)
    expect(transition("escalation", ESCALATION, "doctor-informed", "worsen")).toBe("raised");
    expect(can(ESCALATION, "resolved", "worsen")).toBe(false);
  });
  it("a nursing note is 3–4000 characters", () => { expect(noteOk("ok")).toBe(false); expect(noteOk("Patient settled, eating well")).toBe(true); });
});
describe("the ward round note (walkthrough B7)", async () => {
  const { emptyRoundNote, roundNoteBlockers } = await import("./ward.js");
  it("is signed with at least the assessment or the plan", () => {
    expect(roundNoteBlockers(emptyRoundNote())).toEqual(["assessment_or_plan"]);
    expect(roundNoteBlockers({ ...emptyRoundNote(), p: "Continue IV antibiotics" })).toEqual([]);
  });
});

describe("escalation reach — unacknowledged in the app within N minutes (sample 15)", () => {
  const raised = new Date("2026-10-06T01:00:00Z");
  it("falls due N minutes after the raise; a nurse's logged call does not count, a doctor's acknowledgement does", () => {
    const due = ackDueAt(raised, 15);
    expect(due.toISOString()).toBe("2026-10-06T01:15:00.000Z");
    expect(escalationUnacknowledged({ status: "raised", acknowledgedAt: null, ackDueAt: due }, new Date("2026-10-06T01:14:59Z"))).toBe(false);
    expect(escalationUnacknowledged({ status: "doctor-informed", acknowledgedAt: null, ackDueAt: due }, new Date("2026-10-06T01:15:00Z"))).toBe(true);
    expect(escalationUnacknowledged({ status: "raised", acknowledgedAt: new Date("2026-10-06T01:10:00Z"), ackDueAt: due }, new Date("2026-10-06T02:00:00Z"))).toBe(false);
    expect(escalationUnacknowledged({ status: "resolved", acknowledgedAt: null, ackDueAt: due }, new Date("2026-10-06T02:00:00Z"))).toBe(false);
  });
  it("N is a facility setting within 5–120 minutes", () => {
    expect(ackMinutesOk(15)).toBe(true); expect(ackMinutesOk(4)).toBe(false); expect(ackMinutesOk(121)).toBe(false); expect(ackMinutesOk(7.5)).toBe(false);
  });
  it("on duty: the facility's list (active doctors only), else every active doctor", () => {
    expect(onDutyDoctors(["d1", "d2", "d3"], [])).toEqual(["d1", "d2", "d3"]);
    expect(onDutyDoctors(["d1", "d2", "d3"], ["d2", "gone"])).toEqual(["d2"]);
    expect(onDutyDoctors(["d1"], ["gone"])).toEqual(["d1"]); // a list with nobody active falls back to everyone
  });
});

