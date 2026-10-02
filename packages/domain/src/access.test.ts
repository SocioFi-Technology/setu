import { describe, expect, it } from "vitest";
import { authorize, capabilities, defaultScreen, MODULES } from "./access.js";

describe("authorize (walkthrough cases)", () => {
  it("receptionist home shows no clinical screens", () => {
    expect(authorize("receptionist", "pro", "cons", "draft")).toEqual({ allowed: false, reason: "role" });
    expect(authorize("receptionist", "clinic", "fd", "register").allowed).toBe(true);
  });
  it("Clinic plan locks IPD, nursing, ER; Lite locks OT; Pro opens all", () => {
    expect(authorize("nurse", "clinic", "ipd", "map")).toMatchObject({ allowed: false, reason: "plan", needs: "lite" });
    expect(authorize("nurse", "lite", "ipd", "map").allowed).toBe(true);
    expect(authorize("doctor", "lite", "er", "otcal")).toMatchObject({ allowed: false, reason: "plan", needs: "pro" });
    expect(authorize("doctor", "pro", "er", "otcal").allowed).toBe(true);
  });
  it("share ledger is Pro only (round-2 fix #20)", () => {
    expect(authorize("owner", "lite", "bill", "ledger").reason).toBe("plan");
    expect(authorize("owner", "pro", "bill", "ledger").allowed).toBe(true);
  });
  it("unknown screens are denied", () => {
    expect(authorize("admin", "pro", "fd", "nope").reason).toBe("unknown");
  });
});
describe("defaultScreen (round-2 fix #26)", () => {
  it("lands each role on a screen it may use", () => {
    expect(defaultScreen("pathologist", "pro", "lab")).toBe("verify");
    expect(defaultScreen("nurse", "pro", "ipd")).toBe("map");
    expect(defaultScreen("doctor", "pro", "ipd")).toBe("rounds");
    expect(defaultScreen("owner", "pro", "ipd")).toBe("report");
    expect(defaultScreen("owner", "pro", "lab")).toBe("dash");
    expect(defaultScreen("labTech", "clinic", "ipd")).toBeUndefined();
  });
});
describe("capabilities", () => {
  it("covers every module for admin on pro", () => {
    const caps = capabilities("admin", "pro");
    expect(caps.map((c) => c.key)).toEqual(MODULES.filter((m) => m.roles.includes("admin")).map((m) => m.key));
    expect(caps.flatMap((c) => c.screens).every((s) => s.allowed)).toBe(true);
  });
  it("marks a module locked by plan and keeps its screens visible with a reason", () => {
    const nur = capabilities("nurse", "clinic").find((c) => c.key === "nur");
    expect(nur?.locked).toBe("plan");
    expect(nur?.screens.every((s) => s.reason === "plan")).toBe(true);
  });
  it("matches the prototype: receptionist sees fd, bill, ipd, net", () => {
    expect(capabilities("receptionist", "pro").map((c) => c.key)).toEqual(["fd", "bill", "ipd", "net"]);
  });
});
