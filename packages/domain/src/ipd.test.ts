import { describe, expect, it } from "vitest";
import { ADMISSION, BED, BED_ASSIGNMENT, can, transition } from "./machines.js";
import { CONSENTS, departmentForSpeciality, admissionBlockers, admissionChecklist, admissionEncounterState, admissionNumber, admissionReady, bedPickable, finishSource, guardianPhoneDigits, isAdmissionClass, occupyLeg, reserveLeg } from "./ipd.js";

describe("BED gains vacate (ADR 0014): a transfer out frees the bed into cleaning", () => {
  it("occupied → vacate → cleaning → markReady → vacant; a reservation is released, never vacated", () => {
    expect(transition("bed", BED, "occupied", "vacate")).toBe("cleaning");
    expect(transition("bed", BED, "cleaning", "markReady")).toBe("vacant");
    expect(can(BED, "reserved", "vacate")).toBe(false);
    expect(transition("bed", BED, "reserved", "release")).toBe("vacant");
  });
  it("discharge still goes through discharge-pending → leave → cleaning (walkthrough B12)", () => {
    expect(transition("bed", BED, "occupied", "startDischarge")).toBe("discharge-pending");
    expect(transition("bed", BED, "discharge-pending", "leave")).toBe("cleaning");
  });
});

describe("bed picker (walkthrough B3: cleaning beds disabled; reserved for this patient allowed)", () => {
  const me = "p1";
  it("vacant → ok; reserved for me → ok; reserved for someone else → no", () => {
    expect(bedPickable({ state: "vacant", bedClass: "General", reservedForPatientId: null }, me)).toEqual({ ok: true });
    expect(bedPickable({ state: "reserved", bedClass: "General", reservedForPatientId: me }, me)).toEqual({ ok: true });
    expect(bedPickable({ state: "reserved", bedClass: "General", reservedForPatientId: "p2" }, me)).toEqual({ ok: false, reason: "reserved-other" });
  });
  it("cleaning, blocked, occupied and discharge-pending never; a bed of another class never", () => {
    for (const state of ["cleaning", "blocked", "occupied", "discharge-pending"] as const)
      expect(bedPickable({ state, bedClass: "General", reservedForPatientId: null }, me)).toEqual({ ok: false, reason: state });
    expect(bedPickable({ state: "vacant", bedClass: "Cabin", reservedForPatientId: null }, me, "General")).toEqual({ ok: false, reason: "wrong-class" });
  });
  it("an ER bay is not an admission class", () => { expect(isAdmissionClass("ER")).toBe(false); expect(isAdmissionClass("HDU")).toBe(true); });
});

describe("admission checklist (walkthrough B3: Admit unlocks after the checklist)", () => {
  const full = { bedId: "b1", diagnosis: "Ruptured ovarian cyst? · Acute lower abdominal pain", guardianName: "রাশেদ চৌধুরী", guardianPhone: "+880 1711-908812", consents: ["general", "financial", "guardian-id"] };
  it("three consents are required: general, financial, guardian ID; the rest are optional", () => {
    expect(CONSENTS.filter((c) => c.required).map((c) => c.key)).toEqual(["general", "financial", "guardian-id"]);
  });
  it("a complete form is ready; deposit shows but never blocks (money comes with the IPD bill slice)", () => {
    expect(admissionBlockers(full)).toEqual([]);
    expect(admissionReady(full)).toBe(true);
    const dep = admissionChecklist(full).find((c) => c.key === "deposit")!;
    expect(dep.blocks).toBe(false);
  });
  it("no bed, no diagnosis, a guardian without a valid phone, and two consents missing → four blockers", () => {
    const f = { ...full, bedId: null, diagnosis: "  ", guardianPhone: "12345", consents: ["general"] };
    expect(admissionBlockers(f)).toEqual(["bed", "diagnosis", "guardian", "consents"]);
    expect(admissionChecklist(f).find((c) => c.key === "consents")?.missing).toBe(2);
  });
  it("the guardian's phone is accepted in Bangla digits (hands-on 05/10/2026) and stored as Latin digits", () => {
    expect(admissionBlockers({ ...full, guardianPhone: "০১৭১১-৯০৮৮১২" })).toEqual([]);
    expect(guardianPhoneDigits("০১৭১১-৯০৮৮১২")).toBe("01711908812");
    expect(guardianPhoneDigits("+880 1711 908812")).toBe("+8801711908812");
  });
  it("numbers are ADM/yy/nnnn in Latin digits", () => { expect(admissionNumber("26", 81)).toBe("ADM/26/0081"); });
});

describe("two-leg bed move (like a stock transfer)", () => {
  it("leg 1 reserves a vacant destination; a bed being cleaned cannot be reserved", () => {
    expect(reserveLeg("vacant")).toEqual({ destination: "reserved" });
    expect(() => reserveLeg("cleaning")).toThrow();
    expect(() => reserveLeg("reserved")).toThrow();
  });
  it("leg 2 from the ER: the reserved ward bed is occupied and the occupied bay is vacated into cleaning", () => {
    expect(occupyLeg("reserved", "occupied", "occupied")).toEqual({ destination: "occupied", source: "cleaning", sourceEvent: "vacate" });
  });
  it("a direct admission occupies a vacant bed in one go with no source; a reserved-only source is released", () => {
    expect(occupyLeg("vacant", null, null)).toEqual({ destination: "occupied", source: null, sourceEvent: null });
    expect(occupyLeg("reserved", "reserved", "reserved")).toEqual({ destination: "occupied", source: "vacant", sourceEvent: "release" });
  });
  it("the destination must be vacant or reserved: an occupied or blocked bed refuses", () => {
    expect(() => occupyLeg("occupied", null, null)).toThrow();
    expect(() => occupyLeg("blocked", null, null)).toThrow();
  });
});

describe("ADMISSION and BED_ASSIGNMENT machines (ADR 0014, review)", () => {
  it("a request is admitted or cancelled, both final; an assignment goes reserved → occupied → ended, or reserved → ended, never back", () => {
    expect(transition("admission", ADMISSION, "requested", "admit")).toBe("admitted");
    expect(transition("admission", ADMISSION, "requested", "cancel")).toBe("cancelled");
    expect(can(ADMISSION, "admitted", "cancel")).toBe(false);
    expect(transition("bed-assignment", BED_ASSIGNMENT, "reserved", "occupy")).toBe("occupied");
    expect(transition("bed-assignment", BED_ASSIGNMENT, "occupied", "end")).toBe("ended");
    expect(transition("bed-assignment", BED_ASSIGNMENT, "reserved", "end")).toBe("ended");
    expect(can(BED_ASSIGNMENT, "ended", "occupy")).toBe(false);
  });
  it("the ER admit request's department comes from the consultant's speciality as a key", () => {
    expect(departmentForSpeciality("Surgery")).toBe("surgery");
    expect(departmentForSpeciality("Obs & Gynae")).toBe("gynae");
    expect(departmentForSpeciality("Emergency medicine")).toBe("medicine");
    expect(departmentForSpeciality(null)).toBe("medicine");
  });
});

describe("the admission's encounters", () => {
  it("the IPD encounter opens in-progress through planned → arrived → in-progress; the ER visit finishes", () => {
    expect(admissionEncounterState()).toBe("in-progress");
    expect(finishSource("in-progress")).toBe("finished");
    expect(() => finishSource("arrived")).toThrow(); // an ER visit nobody saw is not admitted
  });
});
