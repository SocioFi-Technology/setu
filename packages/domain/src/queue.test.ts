import { describe, expect, it } from "vitest";
import { ENCOUNTER, can } from "./machines.js";
import { QUEUE_COLUMNS, columnOf, dhakaDay, formatToken, queueActions } from "./queue.js";

describe("daily token (walkthrough A3)", () => {
  it("formats as A-017 in Latin digits", () => {
    expect(formatToken(17)).toBe("A-017");
    expect(formatToken(1)).toBe("A-001");
    expect(formatToken(1234)).toBe("A-1234");
  });
  it("the day rolls over at midnight in Dhaka (UTC+6), not UTC", () => {
    expect(dhakaDay(new Date("2026-10-01T17:59:00Z"))).toBe("2026-10-01");
    expect(dhakaDay(new Date("2026-10-01T18:00:00Z"))).toBe("2026-10-02");
  });
});

describe("queue board is a view of ENCOUNTER (no machine of its own)", () => {
  it("columns map to encounter states", () => {
    expect(QUEUE_COLUMNS.map((c) => [c.key, c.state])).toEqual([
      ["waiting", "arrived"], ["vitals", "triaged"], ["withDoctor", "in-progress"], ["done", "finished"], ["noShow", "cancelled"],
    ]);
    expect(columnOf("planned")).toBeNull();
    expect(columnOf("entered-in-error")).toBeNull();
  });
  it("every queue action is an allowed ENCOUNTER transition from that column", () => {
    for (const c of QUEUE_COLUMNS) for (const a of queueActions(c.state)) expect(can(ENCOUNTER, c.state, a.event)).toBe(true);
  });
  it("waiting: next goes to vitals, and the patient can be marked no-show; finished and no-show are terminal on the board", () => {
    expect(queueActions("arrived").map((a) => a.key)).toEqual(["next", "noShow"]);
    expect(queueActions("arrived")[0]!.event).toBe("triage");
    expect(queueActions("triaged").map((a) => a.event)).toEqual(["start", "cancel"]);
    expect(queueActions("in-progress").map((a) => a.event)).toEqual(["finish"]);
    expect(queueActions("finished")).toEqual([]);
    expect(queueActions("cancelled")).toEqual([]);
  });
});
