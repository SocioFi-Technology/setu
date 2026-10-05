import { describe, expect, it } from "vitest";
import { HIGH_ALERT_SAMPLE, wardMedicine } from "./catalog.js";
import { INDENT, MAR_DOSE, MEDICATION_ORDER, NURSING_NOTE, can, transition } from "./machines.js";
import {
  marSlotRange,
  doseBlockers, doseConsumption, doseTiming, indentLineProblems, indentNumber, indentStateAfter, isSlotOf, lineProblems, sameRegimen, slotState, slotsBetween, stopBlockers,
  type DoseFacts, type OrderFacts,
} from "./mar.js";

const at = (iso: string) => new Date(iso);
// Dhaka 06:00 / 14:00 / 22:00 = 00:00 / 08:00 / 16:00 UTC
const metro: OrderFacts = { status: "active", noteCurrent: true, patientId: "p1", encounterId: "e1", encounterOpen: true, startAt: at("2026-10-05T03:00:00Z"), times: ["06:00", "14:00", "22:00"], prn: false, prnMaxPer24h: null, medicineKey: "metronidazole", highAlert: false };
const allTicks = { patient: true, drug: true, dose: true, route: true, time: true };
const dose = (o: Partial<DoseFacts> = {}): DoseFacts => ({
  patientId: "p1", encounterId: "e1", outcome: "given", slot: at("2026-10-05T08:00:00Z"), administeredAt: at("2026-10-05T08:05:00Z"), now: at("2026-10-05T08:06:00Z"),
  checks: allTicks, reason: null, recordedSlots: [], givenLast24h: 0, nurseId: "n1", preparedById: "n1", witnessId: null, witnessRole: null, allergies: [], ...o,
});

describe("machines (ADR 0015)", () => {
  it("MAR_DOSE: a recorded dose only ever becomes entered-in-error", () => {
    expect(transition("mar", MAR_DOSE, "given", "markError")).toBe("entered-in-error");
    expect(can(MAR_DOSE, "given", "hold")).toBe(false);
    expect(can(MAR_DOSE, "entered-in-error", "give")).toBe(false);
  });
  it("MEDICATION_ORDER: active → stopped | superseded | completed, all final", () => {
    expect(transition("order", MEDICATION_ORDER, "active", "stop")).toBe("stopped");
    expect(can(MEDICATION_ORDER, "stopped", "supersede")).toBe(false);
  });
  it("INDENT: requested → partially-issued → issued; the balance can be cancelled; NURSING_NOTE active → entered-in-error", () => {
    expect(transition("indent", INDENT, "requested", "issuePart")).toBe("partially-issued");
    expect(transition("indent", INDENT, "partially-issued", "issueAll")).toBe("issued");
    expect(transition("indent", INDENT, "partially-issued", "cancel")).toBe("cancelled");
    expect(can(INDENT, "issued", "cancel")).toBe(false);
    expect(transition("note", NURSING_NOTE, "active", "markError")).toBe("entered-in-error");
  });
});

describe("inpatient order lines", () => {
  it("a scheduled IV line needs a route the drug allows, a dose, issue units and valid times", () => {
    expect(lineProblems({ medicineKey: "metronidazole", route: "iv", doseText: "500 mg IV over 30 min", doseQty: 1, times: ["06:00", "14:00", "22:00"], prn: false, prnMaxPer24h: null })).toEqual([]);
    expect(lineProblems({ medicineKey: "metronidazole", route: "oral", doseText: "500 mg", doseQty: 1, times: ["25:00"], prn: false, prnMaxPer24h: null })).toEqual(["route", "times"]);
    expect(lineProblems({ medicineKey: "nope", route: "iv", doseText: "x", doseQty: 1, times: [], prn: true, prnMaxPer24h: 4 })).toEqual(["unknown_medicine"]);
  });
  it("a PRN line has no times and a maximum per 24 h of 1–24; a multi-dose vial has no issue units per dose", () => {
    expect(lineProblems({ medicineKey: "napa", route: "oral", doseText: "1 tab", doseQty: 1, times: [], prn: true, prnMaxPer24h: 4 })).toEqual([]);
    expect(lineProblems({ medicineKey: "napa", route: "oral", doseText: "1 tab", doseQty: 1, times: ["08:00"], prn: true, prnMaxPer24h: 0 })).toEqual(["prn_with_times", "prn_max"]);
    expect(lineProblems({ medicineKey: "insulin", route: "sc", doseText: "6 IU per sliding scale", doseQty: null, times: ["06:00", "12:00", "18:00"], prn: false, prnMaxPer24h: null })).toEqual([]);
    expect(lineProblems({ medicineKey: "insulin", route: "sc", doseText: "6 IU", doseQty: 1, times: ["06:00"], prn: false, prnMaxPer24h: null })).toEqual(["dose_qty"]);
  });
  it("decision 9: the regimen carries only when drug, dose, route and frequency are unchanged", () => {
    const a = { medicineKey: "paracetamol-iv", route: "iv", doseText: "1 g IV", doseQty: 1, times: ["06:00", "12:00", "18:00"], prn: false, prnMaxPer24h: null };
    expect(sameRegimen(a, { ...a, times: ["18:00", "06:00", "12:00"] })).toBe(true);
    expect(sameRegimen(a, { ...a, doseText: "500 mg IV" })).toBe(false);
    expect(sameRegimen(a, { ...a, times: ["06:00", "18:00"] })).toBe(false);
    expect(sameRegimen(a, { ...a, route: "oral" })).toBe(false);
  });
  it("the high-alert sample: insulin, heparin, potassium chloride, morphine, pethidine; the opioids are controlled", () => {
    expect(HIGH_ALERT_SAMPLE).toEqual(["insulin", "heparin", "kcl", "morphine", "pethidine"]);
    expect(wardMedicine("morphine")).toMatchObject({ controlled: true, highAlert: true, issueUnit: "ampoule" });
    expect(wardMedicine("insulin")).toMatchObject({ multiDose: true, controlled: false });
  });
});

describe("slots (Dhaka times of day)", () => {
  it("06:00 / 14:00 / 22:00 Dhaka, never before the order started, never after it ended", () => {
    const s = slotsBetween({ ...metro }, at("2026-10-04T18:00:00Z"), at("2026-10-05T17:59:00Z"));
    expect(s.map((x) => x.toISOString())).toEqual(["2026-10-05T08:00:00.000Z", "2026-10-05T16:00:00.000Z"]); // 06:00 is before the 09:00 start
    expect(slotsBetween({ ...metro, endAt: at("2026-10-05T10:00:00Z") }, at("2026-10-04T18:00:00Z"), at("2026-10-05T17:59:00Z")).length).toBe(1);
    expect(isSlotOf(metro, at("2026-10-05T08:00:00Z"))).toBe(true);
    expect(isSlotOf(metro, at("2026-10-05T09:00:00Z"))).toBe(false);
  });
  it("a slot is due within ±60 min, overdue after; a dose is late / early outside the window", () => {
    expect(slotState(at("2026-10-05T08:00:00Z"), at("2026-10-05T07:10:00Z"))).toBe("due");
    expect(slotState(at("2026-10-05T08:00:00Z"), at("2026-10-05T09:01:00Z"))).toBe("overdue");
    expect(slotState(at("2026-10-05T08:00:00Z"), at("2026-10-05T06:30:00Z"))).toBe("scheduled");
    expect(doseTiming(at("2026-10-05T08:00:00Z"), at("2026-10-05T09:30:00Z"))).toBe("late");
    expect(doseTiming(null, at("2026-10-05T09:30:00Z"))).toBe("prn");
  });
});

describe("recording a dose — the walkthrough cases (B5)", () => {
  it("a dose on time, all five ticks, by the nurse, is allowed", () => { expect(doseBlockers(metro, dose())).toEqual([]); });
  it("a double dose: the slot already has a record → refused", () => {
    expect(doseBlockers(metro, dose({ recordedSlots: [at("2026-10-05T08:00:00Z").getTime()] }))).toContain("slot_recorded");
  });
  it("a PRN over the cap: paracetamol max 4 in 24 h, the fifth is refused", () => {
    const prn = { ...metro, medicineKey: "napa", times: [], prn: true, prnMaxPer24h: 4 };
    expect(doseBlockers(prn, dose({ slot: null, givenLast24h: 3 }))).toEqual([]);
    expect(doseBlockers(prn, dose({ slot: null, givenLast24h: 4 }))).toEqual(["prn_cap"]);
  });
  it("a stopped order (or one whose note was superseded) takes no dose", () => {
    expect(doseBlockers({ ...metro, status: "stopped" }, dose())).toContain("order_not_active");
    expect(doseBlockers({ ...metro, noteCurrent: false }, dose())).toContain("order_not_active");
  });
  it("a wrong patient: the order is another patient's (or another visit's) → refused", () => {
    expect(doseBlockers(metro, dose({ patientId: "p2" }))).toContain("wrong_patient");
    expect(doseBlockers(metro, dose({ encounterId: "e2" }))).toContain("wrong_patient");
  });
  it("a witness refused: high-alert insulin without a witness, with the giving or preparing nurse as witness, or a cashier", () => {
    const ins = { ...metro, medicineKey: "insulin", highAlert: true, times: ["06:00", "12:00", "18:00"] };
    const s = { slot: at("2026-10-05T06:00:00Z"), administeredAt: at("2026-10-05T06:02:00Z"), now: at("2026-10-05T06:03:00Z") };
    expect(doseBlockers(ins, dose(s))).toEqual(["witness_required"]);
    expect(doseBlockers(ins, dose({ ...s, witnessId: "n1", witnessRole: "nurse" }))).toEqual(["witness_self"]);
    expect(doseBlockers(ins, dose({ ...s, preparedById: "n3", witnessId: "n3", witnessRole: "nurse" }))).toEqual(["witness_self"]);
    expect(doseBlockers(ins, dose({ ...s, witnessId: "c1", witnessRole: "cashier" }))).toEqual(["witness_role"]);
    expect(doseBlockers(ins, dose({ ...s, witnessId: "d1", witnessRole: "doctor" }))).toEqual([]);
  });
  it("a controlled drug that is not on the high-alert list is witnessed too (its register line records the witness)", () => {
    const dz = { ...metro, medicineKey: "sedil", controlled: true };
    expect(doseBlockers(dz, dose())).toEqual(["witness_required"]);
  });
  it("never in the future; never before the order started", () => {
    expect(doseBlockers(metro, dose({ administeredAt: at("2026-10-05T08:30:00Z"), now: at("2026-10-05T08:06:00Z") }))).toContain("future_time");
    expect(doseBlockers(metro, dose({ slot: null, administeredAt: at("2026-10-05T02:00:00Z") }))).toContain("before_start");
  });
  it("given needs all five ticks; late needs a reason; held / refused / missed need a reason; missed only after the window", () => {
    expect(doseBlockers(metro, dose({ checks: { ...{ patient: true, drug: true, dose: true, route: false, time: true } } }))).toEqual(["checks_incomplete"]);
    expect(doseBlockers(metro, dose({ administeredAt: at("2026-10-05T09:30:00Z"), now: at("2026-10-05T09:31:00Z") }))).toEqual(["reason_required"]);
    expect(doseBlockers(metro, dose({ administeredAt: at("2026-10-05T09:30:00Z"), now: at("2026-10-05T09:31:00Z"), reason: "Patient in X-ray" }))).toEqual([]);
    expect(doseBlockers(metro, dose({ outcome: "held", checks: { patient: false, drug: false, dose: false, route: false, time: false } }))).toEqual(["reason_required"]);
    expect(doseBlockers(metro, dose({ outcome: "missed", reason: "Patient off the ward", now: at("2026-10-05T08:30:00Z") }))).toEqual(["missed_too_early"]);
    expect(doseBlockers(metro, dose({ outcome: "missed", reason: "Patient off the ward", now: at("2026-10-05T09:30:00Z") }))).toEqual([]);
  });
  it("a scheduled order needs its slot; a PRN never has one and is never 'missed'", () => {
    expect(doseBlockers(metro, dose({ slot: null }))).toContain("slot_required");
    expect(doseBlockers(metro, dose({ slot: at("2026-10-05T09:00:00Z") }))).toContain("not_a_slot");
    const prn = { ...metro, times: [], prn: true, prnMaxPer24h: 4 };
    expect(doseBlockers(prn, dose({ outcome: "missed", slot: null, reason: "not needed today" }))).toContain("prn_outcome");
  });
  it("an allergy recorded after the order blocks giving it (penicillin class, here a cephalosporin is not a match; metronidazole ingredient is)", () => {
    expect(doseBlockers(metro, dose({ allergies: [{ id: "a1", kind: "substance", key: "metronidazole", labelBn: "মেট্রোনিডাজল", labelEn: "Metronidazole" }] }))).toContain("allergy");
  });
});

describe("stock and indents", () => {
  it("a unit-dose drug consumes its issue units; a multi-dose vial and the patient's own supply consume none", () => {
    expect(doseConsumption({ multiDose: false }, 2, "ward-stock")).toBe(2);
    expect(doseConsumption({ multiDose: true }, null, "ward-stock")).toBe(0);
    expect(doseConsumption({ multiDose: false }, 1, "patient-supplied")).toBe(0);
  });
  it("stopping needs a doctor, an active order and a reason", () => {
    expect(stopBlockers({ status: "active", role: "nurse", reason: "x" })).toEqual(["doctor_only", "reason"]);
    expect(stopBlockers({ status: "stopped", role: "doctor", reason: "Course complete" })).toEqual(["not_active"]);
  });
  it("indent lines: known medicines, 1–500, no duplicates; the state after an issue; IND/yy/nnnn", () => {
    expect(indentLineProblems([])).toEqual(["empty"]);
    expect(indentLineProblems([{ medicineKey: "ceftriaxone", qty: 4 }, { medicineKey: "ceftriaxone", qty: 0 }]).sort()).toEqual(["duplicate", "qty"]);
    expect(indentStateAfter([{ requested: 6, issued: 6 }, { requested: 6, issued: 4 }])).toBe("partially-issued");
    expect(indentStateAfter([{ requested: 6, issued: 6 }])).toBe("issued");
    expect(indentNumber("26", 412)).toBe("IND/26/0412");
  });
});

describe("marSlotRange — every dose the board counts is on the MAR", () => {
  const dayStart = new Date("2026-10-05T18:00:00Z"); // 6 Oct 00:00 Dhaka
  it("just after midnight today: the last 24 hours are included (yesterday 22:00 is visible)", () => {
    const r = marSlotRange(dayStart, new Date("2026-10-05T18:54:00Z"));
    expect(r.from.toISOString()).toBe("2026-10-04T18:54:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-06T17:59:59.999Z");
    const slot22 = new Date("2026-10-05T16:00:00Z"); // 5 Oct 22:00 Dhaka
    expect(slot22 >= r.from && slot22 <= r.to).toBe(true);
  });
  it("an earlier day shows just that day", () => {
    const r = marSlotRange(dayStart, new Date("2026-10-08T06:00:00Z"));
    expect(r.from.getTime()).toBe(dayStart.getTime());
  });
});

describe("review fixes (clinical safety, B3–B4 session 2)", () => {
  const insulin: OrderFacts = { ...metro, medicineKey: "insulin", highAlert: true, multiDose: true, times: ["06:00", "12:00", "18:00"] };
  const witnessed = { witnessId: "n2", witnessRole: "nurse" } as const;
  it("a multi-dose drug from ward stock is not given without an opened vial", () => {
    const s = at("2026-10-05T06:00:00Z");
    expect(doseBlockers(insulin, dose({ slot: s, administeredAt: s, now: s, ...witnessed, amountGiven: "6 IU", vialOpen: false }))).toContain("vial_required");
    expect(doseBlockers(insulin, dose({ slot: s, administeredAt: s, now: s, ...witnessed, amountGiven: "6 IU", vialOpen: true }))).toEqual([]);
    // the patient's own pen or vial needs no ward vial
    expect(doseBlockers(insulin, dose({ slot: s, administeredAt: s, now: s, ...witnessed, amountGiven: "6 IU", vialOpen: false, source: "patient-supplied" }))).toEqual([]);
  });
  it("a multi-dose drug records the amount actually given (sliding scale: the units)", () => {
    const s = at("2026-10-05T06:00:00Z");
    expect(doseBlockers(insulin, dose({ slot: s, administeredAt: s, now: s, ...witnessed, vialOpen: true, amountGiven: " " }))).toContain("amount_required");
    expect(doseBlockers(insulin, dose({ slot: s, administeredAt: s, now: s, outcome: "held", reason: "CBG 4.8, scale nil", vialOpen: true }))).not.toContain("amount_required");
  });
  it("the same drug given minutes earlier under the previous regimen: a new slot needs a reason", () => {
    expect(doseBlockers(metro, dose({ earlierGivenNear: true }))).toContain("recent_dose");
    expect(doseBlockers(metro, dose({ earlierGivenNear: true, reason: "Dose increased by the doctor, top-up agreed" }))).toEqual([]);
  });
  it("a PRN dose is charted within the window, never backdated beyond it (the 24-hour cap counts backwards)", () => {
    const prn: OrderFacts = { ...metro, times: [], prn: true, prnMaxPer24h: 4 };
    expect(doseBlockers(prn, dose({ slot: null, administeredAt: at("2026-10-05T06:00:00Z"), now: at("2026-10-05T08:06:00Z") }))).toContain("prn_backdated");
    expect(doseBlockers(prn, dose({ slot: null, administeredAt: at("2026-10-05T07:30:00Z"), now: at("2026-10-05T08:06:00Z") }))).toEqual([]);
  });
  it("a slot more than 12 hours ahead is not charted (held / refused before due stays possible within the shift)", () => {
    const far = at("2026-10-06T08:00:00Z");
    expect(doseBlockers(metro, dose({ slot: far, outcome: "held", reason: "Patient going to theatre" }))).toContain("slot_too_far");
    expect(doseBlockers(metro, dose({ slot: at("2026-10-05T16:00:00Z"), outcome: "held", reason: "Patient going to theatre" }))).not.toContain("slot_too_far");
  });
});
