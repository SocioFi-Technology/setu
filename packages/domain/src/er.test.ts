import { describe, expect, it } from "vitest";
import { BED, ENCOUNTER, can, transition } from "./machines.js";
import {
  CARE_ORDERS_SAMPLE, TRIAGE_SCALE, TRIAGE_SCALE_SAMPLE, UNTRIAGED_TARGET_MINUTES, assignTransition, bayTake, boardOrder, closesOnSign, dispositionBlockers,
  awaitingCountersign, erToken, isProtocolOrder, paediatricPrompt, triageLevel, triageOverdue, triageTransition, unknownPatientName, waitedMinutes,
} from "./er.js";

describe("triage scale (sample, pending clinician sign-off)", () => {
  it("five levels with the prototype's targets: immediate, 10, 30, 60, 120 minutes; flagged sample", () => {
    expect(TRIAGE_SCALE.map((l) => [l.level, l.targetMinutes])).toEqual([[1, 0], [2, 10], [3, 30], [4, 60], [5, 120]]);
    expect(TRIAGE_SCALE_SAMPLE).toBe(true);
    expect(triageLevel(3)?.nameEn).toBe("Level 3 · Urgent");
    expect(triageLevel(6)).toBeNull();
  });
});

describe("overdue flags (walkthrough B1: ⚠ on unassigned patients past target)", () => {
  it("level 3 waited 51 min, unassigned → overdue; the same wait with a doctor → not", () => {
    expect(triageOverdue(3, 51, false)).toBe(true);
    expect(triageOverdue(3, 51, true)).toBe(false);
    expect(triageOverdue(3, 30, false)).toBe(false);
  });
  it("level 1 is overdue the first minute nobody is assigned; level 5 waits two hours", () => {
    expect(triageOverdue(1, 1, false)).toBe(true);
    expect(triageOverdue(5, 86, false)).toBe(false);
    expect(triageOverdue(5, 121, false)).toBe(true);
  });
  it("an untriaged arrival is overdue after the untriaged target", () => {
    expect(UNTRIAGED_TARGET_MINUTES).toBe(10);
    expect(triageOverdue(null, 9, false)).toBe(false);
    expect(triageOverdue(null, 11, false)).toBe(true);
  });
  it("waited minutes never go negative (device clocks)", () => {
    expect(waitedMinutes("2026-10-05T10:00:00Z", new Date("2026-10-05T10:51:30Z"))).toBe(51);
    expect(waitedMinutes("2026-10-05T10:00:00Z", new Date("2026-10-05T09:59:00Z"))).toBe(0);
  });
});

describe("board order (prototype: by level, then longest wait)", () => {
  it("untriaged first, then level 1 → 5, longest wait first within a level", () => {
    const rows = [
      { id: "E-22", level: 5, waited: 86, arrivedAt: "a" }, { id: "E-24", level: 3, waited: 51, arrivedAt: "b" }, { id: "E-25", level: 3, waited: 31, arrivedAt: "c" },
      { id: "E-27", level: 1, waited: 4, arrivedAt: "d" }, { id: "E-29", level: null, waited: 2, arrivedAt: "e" },
    ];
    expect(boardOrder(rows).map((r) => r.id)).toEqual(["E-29", "E-27", "E-24", "E-25", "E-22"]);
  });
});

describe("assigning a doctor (walkthrough issue #24)", () => {
  it("an adult assigned to a paediatrician needs a prompt; a child does not; a surgeon never", () => {
    expect(paediatricPrompt("Paediatrics", 40)).toBe(true);
    expect(paediatricPrompt("শিশু বিশেষজ্ঞ", 18)).toBe(true);
    expect(paediatricPrompt("Paediatrics", 9)).toBe(false);
    expect(paediatricPrompt("Surgery", 40)).toBe(false);
    expect(paediatricPrompt(null, 40)).toBe(false);
    expect(paediatricPrompt("Paediatrics", null)).toBe(false);
  });
});

describe("ER visit through ENCOUNTER (no new event, ADR 0014)", () => {
  it("arrival is 'arrived'; triage moves it to triaged once, re-triage keeps the state", () => {
    expect(transition("encounter", ENCOUNTER, "planned", "arrive")).toBe("arrived");
    expect(triageTransition("arrived")).toBe("triaged");
    expect(triageTransition("triaged")).toBe("triaged");
    expect(triageTransition("in-progress")).toBe("in-progress");
    expect(() => triageTransition("finished")).toThrow();
  });
  it("assigning a doctor starts the visit from arrived or triaged; a second assignment keeps it; a closed visit refuses", () => {
    expect(assignTransition("arrived")).toBe("in-progress");
    expect(assignTransition("triaged")).toBe("in-progress");
    expect(assignTransition("in-progress")).toBe("in-progress");
    expect(() => assignTransition("cancelled")).toThrow();
  });
  it("a signed discharge / refer / death closes the visit; admit waits for the desk", () => {
    expect(closesOnSign("discharge")).toBe(true); expect(closesOnSign("refer")).toBe(true); expect(closesOnSign("death")).toBe(true);
    expect(closesOnSign("admit")).toBe(false);
    expect(can(ENCOUNTER, "in-progress", "finish")).toBe(true);
  });
  it("tokens are E-nnn in Latin digits", () => { expect(erToken(27)).toBe("E-027"); expect(erToken(1234)).toBe("E-1234"); });
  it("a bay is taken straight away (vacant → occupied); a bay being cleaned cannot be", () => {
    expect(bayTake("vacant")).toBe("occupied");
    expect(() => bayTake("cleaning")).toThrow();
    expect(can(BED, "blocked", "occupy")).toBe(false);
  });
});

describe("disposition (walkthrough B2: sign disposition)", () => {
  it("admit needs the bed, the consultant and the admitting diagnosis", () => {
    expect(dispositionBlockers({ kind: "admit" }).map((b) => b.field)).toEqual(["bedId", "consultantId", "diagnosis"]);
    expect(dispositionBlockers({ kind: "admit", bedId: "b1", consultantId: "u1", diagnosis: "Head injury, moderate (GCS 11) — RTA" })).toEqual([]);
  });
  it("discharge needs advice; refer needs the destination and a reason", () => {
    expect(dispositionBlockers({ kind: "discharge" })).toEqual([{ field: "advice", code: "required" }]);
    expect(dispositionBlockers({ kind: "refer", referTo: "Nodi General Hospital" })).toEqual([{ field: "referReason", code: "required" }]);
  });
  it("death: certificate drafted and family informed always; police informed before signing when medico-legal (prototype)", () => {
    const base = { kind: "death" as const, timeOfDeath: "2026-10-05T08:48:00Z", cause: "Severe traumatic brain injury" };
    expect(dispositionBlockers({ ...base, checks: [] }).map((b) => b.code)).toEqual(["required", "required"]);
    expect(dispositionBlockers({ ...base, medicoLegal: true, checks: ["certificate", "family"] })).toEqual([{ field: "checks.police", code: "police_required" }]);
    expect(dispositionBlockers({ ...base, medicoLegal: true, checks: ["certificate", "family", "police"] })).toEqual([]);
  });
});

describe("protocol orders (decision 243)", () => {
  it("a nurse's order is a protocol order; the doctor's is not; open protocol orders wait for the countersignature", () => {
    expect(isProtocolOrder("nurse")).toBe(true); expect(isProtocolOrder("doctor")).toBe(false);
    const orders = [{ id: "a", protocol: true, countersignedAt: null }, { id: "b", protocol: true, countersignedAt: "2026-10-05T10:00:00Z" }, { id: "c", protocol: false, countersignedAt: null }];
    expect(awaitingCountersign(orders).map((o) => o.id)).toEqual(["a"]);
  });
});

describe("unknown patient (quick provisional registration)", () => {
  it("is named by sex and approximate age until the desk resolves the identity", () => {
    expect(unknownPatientName("male", 40)).toEqual({ bn: "অজ্ঞাত পুরুষ ~40ব", en: "Unknown male ~40y" });
    expect(unknownPatientName("other", null)).toEqual({ bn: "অজ্ঞাত ব্যক্তি", en: "Unknown person" });
  });
  it("the care-order list is a sample (non-lab STAT items are note lines)", () => {
    expect(CARE_ORDERS_SAMPLE.map((c) => c.key)).toContain("ct");
  });
});
