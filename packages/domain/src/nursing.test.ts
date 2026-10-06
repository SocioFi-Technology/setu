import { describe, expect, it } from "vitest";
import { CARE_TASK, HANDOVER, can, transition } from "./machines.js";
import {
  IO_MAX_ML, handoverAcceptBlockers, batchLabelCode, mod97Check, normaliseScan, wristbandCode, currentShift, ioBlockers, ioTotals, nextCareDue, parseBatchLabel, parseWristband, scanBlockers, shiftDay,
  handoverSignBlockers, taskOverdue,
} from "./nursing.js";

describe("scan-to-verify (walkthrough B5: Record locked until band + medicine scanned)", () => {
  const base = { outcome: "given" as const, source: "ward-stock" as const, highAlert: false, controlled: false, overrideReason: null as string | null };
  const ok = { band: "match" as const, med: "match" as const };
  it("given needs both scans to match", () => {
    expect(scanBlockers({ ...base, band: "none", med: "none" })).toEqual(["band_required", "med_required"]);
    expect(scanBlockers({ ...base, band: "mismatch", med: "match" })).toEqual(["band_mismatch"]);
    expect(scanBlockers({ ...base, band: "match", med: "mismatch" })).toEqual(["med_mismatch"]);
    expect(scanBlockers({ ...base, band: "match", med: "expired" })).toEqual(["med_expired"]);
    expect(scanBlockers({ ...base, band: "match", med: "not-on-ward" })).toEqual(["med_not_on_ward"]);
    expect(scanBlockers({ ...base, band: "match", med: "empty" })).toEqual(["med_empty"]);
    expect(scanBlockers({ ...base, ...ok })).toEqual([]);
  });
  it("the patient's own supply: the wristband only; held / refused / missed: no scans", () => {
    expect(scanBlockers({ ...base, source: "patient-supplied", band: "match", med: "none" })).toEqual([]);
    expect(scanBlockers({ ...base, source: "patient-supplied", band: "none", med: "none" })).toEqual(["band_required"]);
    expect(scanBlockers({ ...base, outcome: "held", band: "none", med: "none" })).toEqual([]);
  });
  it("override with a reason (≥10) when the scanner fails — never for a high-alert or controlled drug", () => {
    expect(scanBlockers({ ...base, band: "none", med: "none", overrideReason: "Scanner broken" })).toEqual([]);
    expect(scanBlockers({ ...base, band: "none", med: "none", overrideReason: "broken" })).toEqual(["override_reason"]);
    expect(scanBlockers({ ...base, highAlert: true, band: "none", med: "none", overrideReason: "Scanner broken on ward" })).toEqual(["override_not_allowed", "band_required", "med_required"]);
    expect(scanBlockers({ ...base, controlled: true, band: "match", med: "none", overrideReason: "Scanner broken on ward" })).toEqual(["override_not_allowed", "med_required"]);
    // a mismatch is never overridden
    expect(scanBlockers({ ...base, band: "mismatch", med: "none", overrideReason: "Scanner broken on ward" })).toEqual(["band_mismatch"]);
  });
  it("codes are digits only: a wedge scanner on a Bangla layout types Bangla digits, and the field reads them back", () => {
    const band = wristbandCode("0000001234", "87654321");
    expect(band).toBe("91000000123487654321");
    expect(parseWristband(band)).toEqual({ serial: "0000001234", sig: "87654321" });
    // the same keystrokes under Bijoy / Avro: Bangla digits, with the Enter the wedge adds
    const bn = band.replace(/\d/g, (d) => "০১২৩৪৫৬৭৮৯"[Number(d)]!) + "\n";
    expect(normaliseScan(bn)).toBe(band);
    expect(parseWristband(bn)).toEqual({ serial: "0000001234", sig: "87654321" });
    expect(parseWristband("92000000123487654321")).toBeNull();
    expect(parseWristband("SETU-WB1.adm.E2L-1.1.sig")).toBeNull(); // the old lettered format never parses
    const label = batchLabelCode("0000000042");
    expect(label).toMatch(/^920000000042\d{2}$/);
    expect(parseBatchLabel(label)).toEqual({ serial: "0000000042" });
    expect(parseBatchLabel(label.replace(/\d$/, (d) => String((Number(d) + 1) % 10)))).toBeNull(); // a misread check digit
    expect(parseBatchLabel(band)).toBeNull();
    expect(mod97Check("0000000042")).toHaveLength(2);
  });
});

describe("intake / output", () => {
  const now = new Date("2026-10-06T03:00:00Z"); // 09:00 Dhaka
  it("an entry: a known route for its side, 1–5000 mL, not in the future", () => {
    expect(ioBlockers({ side: "in", route: "oral", ml: 200, at: now, now })).toEqual([]);
    expect(ioBlockers({ side: "in", route: "urine", ml: 200, at: now, now })).toEqual(["route"]);
    expect(ioBlockers({ side: "out", route: "urine", ml: 0, at: now, now })).toEqual(["ml"]);
    expect(ioBlockers({ side: "out", route: "urine", ml: IO_MAX_ML + 1, at: now, now })).toEqual(["ml"]);
    expect(ioBlockers({ side: "out", route: "drain", ml: 50, at: new Date(now.getTime() + 10 * 60_000), now })).toEqual(["future"]);
  });
  it("the shift day runs 08:00 to 08:00 Dhaka (sample)", () => {
    expect(shiftDay(new Date("2026-10-06T01:30:00Z"), 8)).toBe("2026-10-05"); // 07:30 Dhaka
    expect(shiftDay(new Date("2026-10-06T02:00:00Z"), 8)).toBe("2026-10-06"); // 08:00 Dhaka
  });
  it("totals and the balance", () => {
    expect(ioTotals([{ side: "in", ml: 500 }, { side: "in", ml: 150 }, { side: "out", ml: 900 }])).toEqual({ inMl: 650, outMl: 900, balanceMl: -250 });
  });
});

describe("care plan tasks", () => {
  it("CARE_TASK: requested → completed | cancelled, both final", () => {
    expect(transition("care-task", CARE_TASK, "requested", "complete")).toBe("completed");
    expect(can(CARE_TASK, "completed", "cancel")).toBe(false);
  });
  it("the next of a recurring task is due N hours after it was done; overdue after 30 minutes' grace (sample)", () => {
    const done = new Date("2026-10-06T04:10:00Z");
    expect(nextCareDue(done, 6)?.toISOString()).toBe("2026-10-06T10:10:00.000Z");
    expect(nextCareDue(done, null)).toBeNull();
    const due = new Date("2026-10-06T06:00:00Z");
    expect(taskOverdue({ status: "requested", dueAt: due }, new Date("2026-10-06T06:30:00Z"))).toBe(false);
    expect(taskOverdue({ status: "requested", dueAt: due }, new Date("2026-10-06T06:31:00Z"))).toBe(true);
    expect(taskOverdue({ status: "completed", dueAt: due }, new Date("2026-10-06T09:00:00Z"))).toBe(false);
  });
});

describe("the shift handover", () => {
  it("HANDOVER: draft → outgoing-signed → accepted; query returns to draft; accepted is final", () => {
    expect(transition("handover", HANDOVER, "draft", "sign")).toBe("outgoing-signed");
    expect(transition("handover", HANDOVER, "outgoing-signed", "query")).toBe("draft");
    expect(can(HANDOVER, "accepted", "query")).toBe(false);
  });
  it("shifts start 08:00, 14:00, 20:00 Dhaka (sample)", () => {
    expect(currentShift(new Date("2026-10-06T03:00:00Z"), [8, 14, 20])).toMatchObject({ day: "2026-10-06", startHour: 8 });
    expect(currentShift(new Date("2026-10-06T19:00:00Z"), [8, 14, 20])).toMatchObject({ day: "2026-10-06", startHour: 20 }); // 01:00 Dhaka on the 7th belongs to the 20:00 shift of the 6th
    expect(currentShift(new Date("2026-10-06T19:00:00Z"), [8, 14, 20]).start.toISOString()).toBe("2026-10-06T14:00:00.000Z");
  });
  it("signed by the outgoing nurse only when every patient is reviewed", () => {
    expect(handoverSignBlockers({ patients: [{ reviewed: true }, { reviewed: false }] })).toEqual(["not_all_reviewed"]);
    expect(handoverSignBlockers({ patients: [{ reviewed: true }] })).toEqual([]);
  });
  it("accepted by another nurse; every open escalation must be named in the note (bed or patient number)", () => {
    const esc = [{ bed: "3B-05", facilityNo: "E2L-240201" }];
    expect(handoverAcceptBlockers({ outgoingId: "n1", incomingId: "n1", note: "", open: [] })).toEqual(["same_nurse"]);
    expect(handoverAcceptBlockers({ outgoingId: "n1", incomingId: "n2", note: "All fine", open: esc })).toEqual(["escalation_not_named"]);
    expect(handoverAcceptBlockers({ outgoingId: "n1", incomingId: "n2", note: "3b-05 NEWS2 9 — duty doctor called again", open: esc })).toEqual([]);
    expect(handoverAcceptBlockers({ outgoingId: "n1", incomingId: "n2", note: "E2L-240201 watched hourly", open: esc })).toEqual([]);
    // whole words only (review): 2A-12 does not name 2A-1
    expect(handoverAcceptBlockers({ outgoingId: "n1", incomingId: "n2", note: "2A-12 stable", open: [{ bed: "2A-1", facilityNo: "E2L-1" }] })).toEqual(["escalation_not_named"]);
    expect(handoverAcceptBlockers({ outgoingId: "n1", incomingId: "n2", note: "2A-1: doctor called again", open: [{ bed: "2A-1", facilityNo: "E2L-1" }] })).toEqual([]);
  });
});
