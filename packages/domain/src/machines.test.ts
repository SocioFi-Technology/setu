import { describe, expect, it } from "vitest";
import { ALLERGY, BED, INVOICE, REFUND, CLAIM, DISCHARGE, DOCUMENT, ENCOUNTER, ORDER, PAYMENT, TransitionError, can, transition } from "./machines.js";

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

describe("invoice (ADR 0005, ADR 0013 addendum)", () => {
  it("draft, issued and — once all money is refunded (refund.ts guards it) — partially-paid / balanced bills can be marked entered-in-error; that is terminal", () => {
    expect(transition("invoice", INVOICE, "draft", "markError")).toBe("entered-in-error");
    expect(transition("invoice", INVOICE, "issued", "markError")).toBe("entered-in-error");
    expect(transition("invoice", INVOICE, "partially-paid", "markError")).toBe("entered-in-error");
    expect(transition("invoice", INVOICE, "balanced", "markError")).toBe("entered-in-error");
    for (const from of ["cancelled", "entered-in-error"] as const) expect(can(INVOICE, from, "markError")).toBe(false);
    for (const ev of ["issue", "payPart", "payAll", "cancel", "markError"] as const) expect(can(INVOICE, "entered-in-error", ev)).toBe(false);
  });
});

describe("refund (ADR 0013)", () => {
  it("requested → approved → paid; requested → rejected; approved → withdrawn — withdrawn is not rejected, paid is final", () => {
    expect(transition("refund", REFUND, "requested", "approve")).toBe("approved");
    expect(transition("refund", REFUND, "requested", "reject")).toBe("rejected");
    expect(transition("refund", REFUND, "approved", "pay")).toBe("paid");
    expect(transition("refund", REFUND, "approved", "withdraw")).toBe("withdrawn");
    expect(can(REFUND, "requested", "pay")).toBe(false); // nothing moves before approval
    expect(can(REFUND, "requested", "withdraw")).toBe(false);
    expect(can(REFUND, "approved", "reject")).toBe(false);
    for (const end of ["paid", "rejected", "withdrawn"] as const) for (const ev of ["approve", "reject", "pay", "withdraw"] as const) expect(can(REFUND, end, ev)).toBe(false);
  });
});
