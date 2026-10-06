import { describe, expect, it } from "vitest";
import {
  blockingSteps, canDoStep, canRemind, dischargeOrderBlockers, doneCount, finishStep, initialStepStates, pharmacyClearanceBlockers, startReady, type StepStates,
} from "./discharge.js";
import { TransitionError } from "./machines.js";

describe("the six steps (walkthrough B9)", () => {
  it("after the order: summary and pharmacy start; the final bill waits for the pharmacy; the header names the pharmacy", () => {
    const s = initialStepStates();
    expect(s).toEqual({ order: "done", summary: "in-progress", pharmacy: "in-progress", "final-bill": "waiting", payment: "waiting", "bed-release": "waiting" });
    // the prototype's state: "Blocked by Pharmacy · Md. Jewel Rana" — the summary blocks nothing yet (bed release also waits for payment)
    expect(blockingSteps(s)).toEqual(["pharmacy"]);
    expect(doneCount(s)).toBe(1);
  });
  it("the final bill needs the pharmacy first; bed release needs the summary and the payment, in either order", () => {
    let s = initialStepStates();
    expect(() => finishStep(s, "final-bill")).toThrow(TransitionError);
    s = finishStep(s, "pharmacy");
    expect(s["final-bill"]).toBe("in-progress");
    expect(blockingSteps(s)).toEqual(["final-bill"]);
    s = finishStep(finishStep(s, "final-bill"), "payment");
    expect(s["bed-release"]).toBe("waiting");
    expect(blockingSteps(s)).toEqual(["summary"]);
    s = finishStep(s, "summary");
    expect(s["bed-release"]).toBe("in-progress");
    expect(blockingSteps(s)).toEqual([]);
    s = finishStep(s, "bed-release");
    expect(doneCount(s)).toBe(6);
  });
  it("a step is finished once", () => {
    const s = finishStep(initialStepStates(), "summary");
    expect(() => finishStep(s, "summary")).toThrow(TransitionError);
  });
  it("startReady leaves nothing waiting whose steps are done", () => {
    const s = startReady({ order: "done", summary: "done", pharmacy: "done", "final-bill": "done", payment: "done", "bed-release": "waiting" } as StepStates);
    expect(s["bed-release"]).toBe("in-progress");
  });
});

describe("who does each step", () => {
  it("the owner role, or admin", () => {
    expect(canDoStep("order", "doctor")).toBe(true);
    expect(canDoStep("order", "nurse")).toBe(false);
    expect(canDoStep("pharmacy", "pharmacist")).toBe(true);
    expect(canDoStep("final-bill", "cashier")).toBe(true);
    expect(canDoStep("payment", "owner")).toBe(true);
    expect(canDoStep("payment", "nurse")).toBe(false);
    expect(canDoStep("bed-release", "nurse")).toBe(true);
    expect(canDoStep("bed-release", "receptionist")).toBe(false);
    expect(canDoStep("pharmacy", "admin")).toBe(true);
  });
});

describe("the order and the checks", () => {
  const now = new Date("2026-10-02T09:10:00+06:00");
  it("advice of 10+ characters; a target from now to 24 hours ahead", () => {
    expect(dischargeOrderBlockers({ advice: "Pain settled, eating normally", targetAt: new Date("2026-10-02T12:00:00+06:00"), now })).toEqual([]);
    expect(dischargeOrderBlockers({ advice: "ok", targetAt: new Date("2026-10-02T08:00:00+06:00"), now })).toEqual(["advice", "target_past"]);
    expect(dischargeOrderBlockers({ advice: "Pain settled, eating normally", targetAt: new Date("2026-10-03T10:00:00+06:00"), now })).toEqual(["target_far"]);
  });
  it("pharmacy clearance asks about the patient's own medicines", () => {
    expect(pharmacyClearanceBlockers({ ownMedicines: null })).toEqual(["own_medicines"]);
    expect(pharmacyClearanceBlockers({ ownMedicines: "none" })).toEqual([]);
  });
  it("remind at most every 10 minutes", () => {
    expect(canRemind(null, now)).toBe(true);
    expect(canRemind(new Date(now.getTime() - 9 * 60_000), now)).toBe(false);
    expect(canRemind(new Date(now.getTime() - 10 * 60_000), now)).toBe(true);
  });
});
