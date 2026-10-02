import { describe, expect, it } from "vitest";
import { BED, CLAIM, DISCHARGE, DOCUMENT, PAYMENT, TransitionError, can, transition } from "./machines.js";

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
