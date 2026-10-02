import { describe, expect, it } from "vitest";
import { signDocument } from "./documents.js";
import { TransitionError } from "./machines.js";

describe("signing a clinical document (ADR 0003)", () => {
  it("a first version signs to final; an amendment with a reason signs to amended", () => {
    expect(signDocument({ status: "draft", amendsId: null })).toBe("final");
    expect(signDocument({ status: "draft", amendsId: "doc_v1", amendReason: "dose corrected" })).toBe("amended");
  });
  it("an amendment without a reason (≥5 characters) cannot be signed", () => {
    expect(() => signDocument({ status: "draft", amendsId: "doc_v1", amendReason: " ab " })).toThrow(TransitionError);
  });
  it("only drafts can be signed", () => {
    for (const status of ["final", "amended", "superseded", "entered-in-error", "queued"] as const) {
      expect(() => signDocument({ status, amendsId: null })).toThrow(TransitionError);
      expect(() => signDocument({ status, amendsId: "doc_v1", amendReason: "dose corrected" })).toThrow(TransitionError);
    }
  });
});
