import { describe, expect, it } from "vitest";
import {
  blockingSteps, canDoStep, canRemind, deathRecordBlockers, dischargeOrderBlockers, doneCount, finishStep, initialStepStates, lamaBlockers, markable,
  pharmacyClearanceBlockers, startReady, summarySignBlockers, takeHomeStatus, visitFinishes, emptySummarySections, type StepStates,
} from "./discharge.js";
import { TransitionError } from "./machines.js";

describe("a normal discharge (walkthrough B9; ADR 0018)", () => {
  it("after the order: summary, pharmacy and final bill start; the patient leaves after the summary, the pharmacy and the payment", () => {
    const s = initialStepStates("normal");
    expect(s).toEqual({ order: "done", summary: "in-progress", pharmacy: "in-progress", "final-bill": "in-progress", payment: "waiting", "bed-release": "waiting" });
    expect(blockingSteps("normal", s)).toEqual(["final-bill"]);
    expect(doneCount(s)).toBe(1);
  });
  it("Kamrul, 2: the bill does not wait for the pharmacy; leaving does", () => {
    let s = finishStep("normal", initialStepStates("normal"), "final-bill");
    expect(s.payment).toBe("in-progress");
    s = finishStep("normal", finishStep("normal", s, "payment"), "summary");
    expect(s["bed-release"]).toBe("waiting");
    expect(blockingSteps("normal", s)).toEqual(["pharmacy"]);
    s = finishStep("normal", s, "pharmacy");
    expect(s["bed-release"]).toBe("in-progress");
    expect(visitFinishes(finishStep("normal", s, "bed-release"))).toBe(true);
  });
  it("events finish the summary, final bill and payment; only the pharmacy and leaving are marked done", () => {
    expect(["order", "summary", "final-bill", "payment"].map((k) => markable("normal", k as never))).toEqual([false, false, false, false]);
    expect(markable("normal", "pharmacy")).toBe(true);
    expect(markable("normal", "bed-release")).toBe(true);
  });
  it("a step is finished once; startReady leaves nothing waiting whose steps are done", () => {
    const s = finishStep("normal", initialStepStates("normal"), "summary");
    expect(() => finishStep("normal", s, "summary")).toThrow(TransitionError);
    expect(startReady("normal", { order: "done", summary: "done", pharmacy: "done", "final-bill": "done", payment: "done", "bed-release": "waiting" } as StepStates)["bed-release"]).toBe("in-progress");
  });
});

describe("LAMA and death (decisions 14, 15)", () => {
  it("LAMA: the patient leaves once the pharmacy has cleared — the bill, payment and summary follow", () => {
    const s = finishStep("lama", initialStepStates("lama"), "pharmacy");
    expect(s["bed-release"]).toBe("in-progress");
    const left = finishStep("lama", s, "bed-release");
    expect(visitFinishes(left)).toBe(false); // the bill not yet issued
    expect(visitFinishes(finishStep("lama", left, "final-bill"))).toBe(true);
  });
  it("death: no summary, no pharmacy; the body moved needs only the record; the visit finishes with the bill", () => {
    const s = initialStepStates("death");
    expect(Object.keys(s).sort()).toEqual(["bed-release", "final-bill", "order", "payment"]);
    expect(s["bed-release"]).toBe("in-progress");
    expect(() => finishStep("death", s, "summary")).toThrow();
  });
  it("LAMA record: reason, risks explained, the form signed, a witness who is not the recording doctor", () => {
    expect(lamaBlockers({ reason: "Family wants to go to Dhaka Medical", risksExplained: true, formSigned: true, witnessId: "u_nurse" }, "u_doc")).toEqual([]);
    expect(lamaBlockers({ reason: "short", risksExplained: false, formSigned: false, witnessId: null }, "u_doc")).toEqual(["reason", "risks", "form", "witness"]);
    expect(lamaBlockers({ reason: "Family wants to go to Dhaka Medical", risksExplained: true, formSigned: true, witnessId: "u_doc" }, "u_doc")).toEqual(["witness_self"]);
  });
  it("death record: the ER's checks; police when medico-legal; the time within the stay", () => {
    const admitted = new Date("2026-10-05T10:00:00+06:00"), now = new Date("2026-10-07T09:00:00+06:00");
    const ok = { timeOfDeath: "2026-10-07T08:40:00+06:00", cause: "Septic shock", medicoLegal: false, checks: ["certificate", "family"] };
    expect(deathRecordBlockers(ok, admitted, now)).toEqual([]);
    expect(deathRecordBlockers({ ...ok, medicoLegal: true }, admitted, now).map((b) => b.code)).toEqual(["police_required"]);
    expect(deathRecordBlockers({ ...ok, timeOfDeath: "2026-10-04T08:40:00+06:00" }, admitted, now).map((b) => b.field)).toEqual(["timeOfDeath"]);
    expect(deathRecordBlockers({ ...ok, checks: [] }, admitted, now).map((b) => b.field)).toEqual(["checks.certificate", "checks.family"]);
  });
});

describe("who does each step", () => {
  it("the owner role, or admin", () => {
    expect(canDoStep("normal", "order", "doctor")).toBe(true);
    expect(canDoStep("normal", "pharmacy", "pharmacist")).toBe(true);
    expect(canDoStep("normal", "pharmacy", "nurse")).toBe(false);
    expect(canDoStep("normal", "bed-release", "nurse")).toBe(true);
    expect(canDoStep("death", "bed-release", "receptionist")).toBe(false);
    expect(canDoStep("normal", "pharmacy", "admin")).toBe(true);
  });
});

describe("the order, the checks, the summary (B11)", () => {
  const now = new Date("2026-10-02T09:10:00+06:00");
  it("advice of 10+ characters; a target from now to 24 hours ahead", () => {
    expect(dischargeOrderBlockers({ advice: "Pain settled, eating normally", targetAt: new Date("2026-10-02T12:00:00+06:00"), now })).toEqual([]);
    expect(dischargeOrderBlockers({ advice: "ok", targetAt: new Date("2026-10-02T08:00:00+06:00"), now })).toEqual(["advice", "target_past"]);
  });
  it("pharmacy clearance asks about the patient's own medicines; remind at most every 10 minutes", () => {
    expect(pharmacyClearanceBlockers({ ownMedicines: null })).toEqual(["own_medicines"]);
    expect(canRemind(new Date(now.getTime() - 9 * 60_000), now)).toBe(false);
  });
  it("sign the summary: a final diagnosis, the course, a follow-up date, a red flag — and never with a critical result unacknowledged or an escalation open (Kamrul, 12)", () => {
    const sections = { course: "Laparoscopic cystectomy on day 1, uneventful recovery", procedures: [], followUp: { date: "2026-10-12", place: "Surgery OPD room 4" }, redFlags: ["Fever above 100.4°F"] };
    const base = { sections, finalDiagnoses: 1, today: "2026-10-07", criticalUnacked: 0, openEscalations: 0, rxBlocking: 0 };
    expect(summarySignBlockers(base)).toEqual([]);
    expect(summarySignBlockers({ ...base, sections: emptySummarySections(), finalDiagnoses: 0 })).toEqual(["diagnosis_final", "course", "follow_up", "red_flags"]);
    expect(summarySignBlockers({ ...base, criticalUnacked: 1, openEscalations: 1, rxBlocking: 2 })).toEqual(["critical_unacked", "escalation_open", "rx_warnings"]);
    expect(summarySignBlockers({ ...base, sections: { ...sections, followUp: { date: "2026-10-06", place: "" } } })).toEqual(["follow_up"]);
  });
});

describe("the take-home medicines (Kamrul, 304)", () => {
  const signedAt = new Date("2026-10-07T10:00:00+06:00");
  const at = (h: number) => new Date(signedAt.getTime() + h * 36e5);
  it("waiting, partial, dispensed or declined while on the queue; after 3 days what was not given is 'not collected', never dropped", () => {
    expect(takeHomeStatus({ prescribed: 15, given: 0, declined: false, signedAt, now: at(2) })).toBe("waiting");
    expect(takeHomeStatus({ prescribed: 15, given: 5, declined: false, signedAt, now: at(2) })).toBe("partial");
    expect(takeHomeStatus({ prescribed: 15, given: 15, declined: false, signedAt, now: at(100) })).toBe("dispensed");
    expect(takeHomeStatus({ prescribed: 15, given: 0, declined: true, signedAt, now: at(100) })).toBe("declined");
    expect(takeHomeStatus({ prescribed: 15, given: 0, declined: false, signedAt, now: at(71) })).toBe("waiting");
    expect(takeHomeStatus({ prescribed: 15, given: 0, declined: false, signedAt, now: at(72) })).toBe("not-collected");
    expect(takeHomeStatus({ prescribed: 15, given: 5, declined: false, signedAt, now: at(80) })).toBe("not-collected");
  });
});
