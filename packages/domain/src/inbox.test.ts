import { describe, expect, it } from "vitest";
import { ackBlockers, inboxSeverity, isOpenItem, sortInbox, PATIENT_NOTIFY_KINDS, type InboxSortable } from "./inbox.js";
import { INBOX_ITEM, TransitionError, can, transition } from "./machines.js";

describe("INBOX_ITEM machine (ADR 0007)", () => {
  it("unread → acknowledged, once; acknowledged is terminal", () => {
    expect(transition("inbox", INBOX_ITEM, "unread", "acknowledge")).toBe("acknowledged");
    expect(can(INBOX_ITEM, "acknowledged", "acknowledge")).toBe(false);
    expect(() => transition("inbox", INBOX_ITEM, "acknowledged", "acknowledge")).toThrow(TransitionError);
  });
});

describe("inbox severity", () => {
  it("a report is critical when any result is HH or LL, abnormal when H or L, else normal", () => {
    expect(inboxSeverity("report-inbox", ["N", "HH", "H"])).toBe("critical");
    expect(inboxSeverity("report-inbox", ["N", "LL"])).toBe("critical");
    expect(inboxSeverity("report-inbox", ["N", "H"])).toBe("abnormal");
    expect(inboxSeverity("report-inbox", ["L", null])).toBe("abnormal");
    expect(inboxSeverity("report-inbox", ["N", null])).toBe("normal");
    expect(inboxSeverity("report-inbox", [])).toBe("normal");
  });
  it("a critical vital sign is critical; lab notices (correction, withdrawn, cancelled) are notices unless about a critical value (M1)", () => {
    expect(inboxSeverity("critical-vital", [])).toBe("critical");
    for (const k of ["correction-notice", "results-withdrawn", "order-cancelled"] as const) expect(inboxSeverity(k, ["N"])).toBe("notice");
  });
});

describe("inbox order (A12: critical first)", () => {
  const it_ = (id: string, severity: InboxSortable["severity"], at: string, acknowledged = false): InboxSortable & { id: string } => ({ id, severity, at, acknowledged });
  it("unacknowledged before acknowledged; then critical → abnormal → normal → notice; newest first within a group", () => {
    const sorted = sortInbox([
      it_("normal-new", "normal", "2026-10-03T05:00:00Z"),
      it_("notice", "notice", "2026-10-03T06:00:00Z"),
      it_("crit-old", "critical", "2026-10-03T01:00:00Z"),
      it_("abn", "abnormal", "2026-10-03T04:00:00Z"),
      it_("crit-new", "critical", "2026-10-03T03:00:00Z"),
      it_("crit-seen", "critical", "2026-10-03T07:00:00Z", true),
      it_("normal-old", "normal", "2026-10-02T05:00:00Z"),
    ]).map((x) => x.id);
    expect(sorted).toEqual(["crit-new", "crit-old", "abn", "normal-new", "normal-old", "notice", "crit-seen"]);
  });
  it("does not change the input array", () => {
    const input = [it_("a", "normal", "2026-10-03T05:00:00Z"), it_("b", "critical", "2026-10-03T05:00:00Z")];
    sortInbox(input);
    expect(input.map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("acknowledge blockers (decision D1)", () => {
  const base = { isRecipient: true, acknowledged: false, superseded: false, kind: "report-inbox" as const, notifyPatient: false, patientHasMobile: true };
  it("the recipient acknowledges an unread, current item", () => expect(ackBlockers(base)).toEqual([]));
  it("only the doctor it was sent to", () => expect(ackBlockers({ ...base, isRecipient: false })).toContain("not_recipient"));
  it("once", () => expect(ackBlockers({ ...base, acknowledged: true })).toContain("already_acknowledged"));
  it("not a report version a newer version has replaced", () => expect(ackBlockers({ ...base, superseded: true })).toContain("superseded"));
  it("'tell patient' needs the patient's mobile on record", () => {
    expect(ackBlockers({ ...base, notifyPatient: true })).toEqual([]);
    expect(ackBlockers({ ...base, notifyPatient: true, patientHasMobile: false })).toContain("no_mobile");
  });
  it("'tell patient' only for a released report — not for notices or a vital sign", () => {
    expect(PATIENT_NOTIFY_KINDS).toEqual(["report-inbox"]);
    for (const kind of ["correction-notice", "results-withdrawn", "order-cancelled", "critical-vital"] as const) {
      expect(ackBlockers({ ...base, kind, notifyPatient: true })).toContain("notify_not_for_kind");
      expect(ackBlockers({ ...base, kind })).toEqual([]);
    }
  });
});

describe("clinical review A12–A13 (M1–M3)", () => {
  it("M1: a report keeps its worst grade while a value is under correction (the values passed include it)", () => {
    expect(inboxSeverity("report-inbox", ["N", "HH"])).toBe("critical");
  });
  it("M1: a correction or withdrawal notice about a critical value is critical; otherwise a notice", () => {
    expect(inboxSeverity("correction-notice", ["HH"])).toBe("critical");
    expect(inboxSeverity("results-withdrawn", ["LL"])).toBe("critical");
    expect(inboxSeverity("correction-notice", ["H"])).toBe("notice");
    expect(inboxSeverity("order-cancelled", ["HH"])).toBe("notice");
  });
  it("M1: no acknowledgement of a report while one of its values is under correction (wait for the corrected version)", () => {
    const base = { isRecipient: true, acknowledged: false, superseded: false, kind: "report-inbox" as const, notifyPatient: false, patientHasMobile: true };
    expect(ackBlockers({ ...base, correctionPending: true })).toContain("correction_pending");
    expect(ackBlockers({ ...base, notifyPatient: true, correctionPending: true })).toContain("correction_pending");
    expect(ackBlockers({ ...base, kind: "correction-notice", correctionPending: true })).toEqual([]);
  });
  it("M2: 'superseded' blocks a report version only — a correction notice about v1 is still acknowledged after v2", () => {
    const base = { isRecipient: true, acknowledged: false, superseded: true, kind: "correction-notice" as const, notifyPatient: false, patientHasMobile: true };
    expect(ackBlockers(base)).toEqual([]);
    expect(ackBlockers({ ...base, kind: "results-withdrawn" })).toEqual([]);
    expect(ackBlockers({ ...base, kind: "report-inbox" })).toContain("superseded");
  });
  it("M3: a superseded report version is resolved by its newer version — it sorts with the done items", () => {
    const sorted = sortInbox([
      { id: "v1", severity: "critical" as const, at: "2026-10-03T07:00:00Z", acknowledged: false, resolved: true },
      { id: "n", severity: "normal" as const, at: "2026-10-03T01:00:00Z", acknowledged: false },
    ]).map((x) => x.id);
    expect(sorted).toEqual(["n", "v1"]);
    expect(isOpenItem({ acknowledged: false, resolved: true })).toBe(false);
    expect(isOpenItem({ acknowledged: false })).toBe(true);
  });
});

