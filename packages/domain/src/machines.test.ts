import { describe, expect, it } from "vitest";
import { ALLERGY, BED, CLAIM, DISCHARGE, DOCUMENT, ENCOUNTER, ORDER, PAYMENT, TransitionError, can, transition } from "./machines.js";

describe("document", () => {
  it("offline sign is queued, never final, until the server acks (rule 1)", () => {
    const q = transition("doc", DOCUMENT, "draft", "offlineSign");
    expect(q).toBe("queued");
    expect(can(DOCUMENT, q, "amend")).toBe(false);
    expect(transition("doc", DOCUMENT, q, "serverAck")).toBe("final");
  });
  it("amend never overwrites: final → amended, old version superseded (rule 3)", () => {
    expect(transition("doc", DOCUMENT, "final", "amend")).toBe("amended");
    expect(transition("doc", DOCUMENT, "final", "supersede")).toBe("superseded");
    expect(() => transition("doc", DOCUMENT, "superseded", "amend")).toThrow(TransitionError);
  });
  it("ADR 0003: an amendment is a new draft that signs to amended; the version it amends is superseded", () => {
    expect(transition("doc", DOCUMENT, "draft", "signAmendment")).toBe("amended");
    expect(transition("doc", DOCUMENT, "final", "supersede")).toBe("superseded");
    expect(transition("doc", DOCUMENT, "amended", "supersede")).toBe("superseded"); // v3 amends v2
    for (const from of ["queued", "final", "amended", "superseded", "entered-in-error"] as const)
      expect(can(DOCUMENT, from, "signAmendment")).toBe(false);
    for (const ev of ["sign", "signAmendment", "amend", "supersede", "markError", "serverAck", "offlineSign"] as const) {
      expect(can(DOCUMENT, "superseded", ev)).toBe(false);
      expect(can(DOCUMENT, "entered-in-error", ev)).toBe(false);
    }
  });
});
describe("allergy (ADR 0004)", () => {
  it("an active allergy can only be marked entered-in-error; that is terminal", () => {
    expect(transition("allergy", ALLERGY, "active", "markError")).toBe("entered-in-error");
    expect(can(ALLERGY, "entered-in-error", "markError")).toBe(false);
  });
});
describe("consultation flow (slice A5)", () => {
  it("opening moves a waiting or vitals-done visit to with-doctor; signing finishes it; orders go draft → active", () => {
    expect(transition("encounter", ENCOUNTER, "arrived", "start")).toBe("in-progress");
    expect(transition("encounter", ENCOUNTER, "triaged", "start")).toBe("in-progress");
    expect(can(ENCOUNTER, "in-progress", "start")).toBe(false); // re-opening is a no-op in the route, not a transition
    expect(transition("encounter", ENCOUNTER, "in-progress", "finish")).toBe("finished");
    expect(can(ENCOUNTER, "triaged", "finish")).toBe(false);
    expect(transition("order", ORDER, "draft", "order")).toBe("active");
  });
});
describe("discharge (walkthrough B9/B10)", () => {
  it("final bill needs pharmacy clearance first", () => {
    expect(can(DISCHARGE, "summary-signed", "finalBill")).toBe(false);
    const s = transition("discharge", DISCHARGE, "summary-signed", "clearPharmacy");
    expect(transition("discharge", DISCHARGE, s, "finalBill")).toBe("final-bill");
  });
});
describe("bed (walkthrough B12)", () => {
  it("cleaning → mark ready → vacant", () => {
    expect(transition("bed", BED, "cleaning", "markReady")).toBe("vacant");
    expect(() => transition("bed", BED, "cleaning", "occupy")).toThrow();
  });
});
describe("payment (walkthrough A7)", () => {
  it("failed links can be retried; confirmed is terminal", () => {
    expect(transition("pay", PAYMENT, "link-sent", "fail")).toBe("failed");
    expect(transition("pay", PAYMENT, "failed", "retry")).toBe("initiated");
    expect(can(PAYMENT, "confirmed", "fail")).toBe(false);
  });
});
describe("claim (round-2 fix #3)", () => {
  it("wrong codes stay in proof-pending; the third locks", () => {
    let s = transition("claim", CLAIM, "candidate", "startProof");
    s = transition("claim", CLAIM, s, "codeWrong");
    s = transition("claim", CLAIM, s, "codeWrong");
    s = transition("claim", CLAIM, s, "thirdWrong");
    expect(s).toBe("locked");
    expect(can(CLAIM, s, "codeOk")).toBe(false);
  });
});
