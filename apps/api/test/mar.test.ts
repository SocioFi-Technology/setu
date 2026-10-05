/* Slice B3–B4 (ADR 0015): the medication administration record on the real database (as setu_app), E2E Lite Hospital.
   The walkthrough cases first: a double dose, a PRN over the cap, a stopped order, a wrong patient, a refused witness;
   then the time rules, the five checks, the allergy block, ward stock and the patient's own supply, the vial, the
   controlled-drug register, entered-in-error. Each test admits its own synthetic patient to its own ward. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { T, TICKS, client, dhakaHHMM, line, setup, slotAt } from "./ward-helpers.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
let app: Awaited<ReturnType<typeof buildApp>>;
let c: ReturnType<typeof client>; let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { app = await buildApp(); if (!db) return; c = client(app); await c.login(); h = await setup(c); });
afterAll(async () => { await app?.close(); });
const tenant = <R>(fn: (tx: import("@setu/db").Tx) => Promise<R>) => db!.forTenant(T, fn);
const now = () => new Date().toISOString();
const orderOf = (round: { activeOrders: { id: string; medicine: { key: string } }[] }, key: string) => round.activeOrders.find((o) => o.medicine.key === key)!;
const dose = (encounterId: string, body: object, who: "nurse" | "nurse2" | "surgeon" = "nurse") => c.post(`/v1/nursing/encounters/${encounterId}/doses`, body, who);

describe.runIf(db)("the walkthrough cases (B5)", () => {
  it("a double dose: the same slot twice is refused", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const hhmm = dhakaHHMM(2);
    const r = await h.signRound(a.encounterId, [line("metronidazole", { doseText: "500 mg IV", times: [hhmm] })]);
    const o = orderOf(r, "metronidazole");
    const body = { requestId: o.id, scheduledFor: slotAt(hhmm), outcome: "given", administeredAt: now(), checks: TICKS, source: "patient-supplied" };
    const first = await dose(a.encounterId, body);
    expect(first.statusCode, first.body).toBe(201);
    const twice = await dose(a.encounterId, { ...body, administeredAt: now() });
    expect(twice.statusCode).toBe(422); expect(twice.json().blockers).toContain("slot_recorded");
  });
  it("a PRN over the cap: max 2 in 24 h — the third is refused", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const r = await h.signRound(a.encounterId, [line("napa", { route: "oral", doseText: "500 mg", times: [], prn: true, prnMaxPer24h: 2 })]);
    const o = orderOf(r, "napa");
    const body = () => ({ requestId: o.id, scheduledFor: null, outcome: "given", administeredAt: now(), checks: TICKS, source: "patient-supplied" });
    expect((await dose(a.encounterId, body())).statusCode).toBe(201);
    expect((await dose(a.encounterId, body())).statusCode).toBe(201);
    const third = await dose(a.encounterId, body());
    expect(third.statusCode).toBe(422); expect(third.json().blockers).toEqual(["prn_cap"]);
  });
  it("a stopped order takes no dose — the route refuses and so does the database", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const hhmm = dhakaHHMM(2);
    const r = await h.signRound(a.encounterId, [line("ceftriaxone", { doseText: "1 g IV", times: [hhmm] })]);
    const o = orderOf(r, "ceftriaxone");
    expect((await c.post(`/v1/ipd/orders/${o.id}/stop`, { reason: "x", pin: "1234" }, "surgeon")).statusCode).toBe(400);
    expect((await c.post(`/v1/ipd/orders/${o.id}/stop`, { reason: "Culture sensitive to another drug", pin: "1234" }, "nurse")).statusCode).toBe(403);
    const stop = await c.post(`/v1/ipd/orders/${o.id}/stop`, { reason: "Culture sensitive to another drug", pin: "1234" }, "surgeon");
    expect(stop.statusCode, stop.body).toBe(200);
    const d = await dose(a.encounterId, { requestId: o.id, scheduledFor: slotAt(hhmm), outcome: "given", administeredAt: now(), checks: TICKS, source: "patient-supplied" });
    expect(d.statusCode).toBe(422); expect(d.json().blockers).toContain("order_not_active");
    const mar = (await c.get(`/v1/nursing/encounters/${a.encounterId}/mar`)).json();
    expect(mar.orders.find((x: { id: string }) => x.id === o.id)).toMatchObject({ status: "stopped", slots: [] });
    await expect(db!.forTenant(T, (tx) => tx.medicationAdministration.create({ data: {
      tenantId: T, organizationId: "o_e2e_lite", encounterId: a.encounterId, patientId: a.patientId, requestId: o.id, regimenId: o.id, medicineKey: "ceftriaxone", scheduledFor: new Date(slotAt(hhmm)),
      status: "given", administeredAt: new Date(), administeredById: "u_e2l_nurse", preparedById: "u_e2l_nurse", checkPatient: true, checkDrug: true, checkDose: true, checkRoute: true, checkTime: true,
      timing: "on-time", route: "iv", doseText: "1 g IV", doseQty: 1, source: "patient-supplied" } }), { userId: "u_e2l_nurse" })).rejects.toThrow(/only an active order takes a dose/);
  });
  it("a wrong patient: another patient's order on this patient's MAR is refused — route and database", async () => {
    const w = await h.ownWard(2); const a = await h.admit(w, 0); const b = await h.admit(w, 1);
    const hhmm = dhakaHHMM(2);
    const rb = await h.signRound(b.encounterId, [line("metronidazole", { doseText: "500 mg IV", times: [hhmm] })]);
    const ob = orderOf(rb, "metronidazole");
    const d = await dose(a.encounterId, { requestId: ob.id, scheduledFor: slotAt(hhmm), outcome: "given", administeredAt: now(), checks: TICKS, source: "patient-supplied" });
    expect(d.statusCode).toBe(422); expect(d.json().blockers).toContain("wrong_patient");
    await expect(db!.forTenant(T, (tx) => tx.medicationAdministration.create({ data: {
      tenantId: T, organizationId: "o_e2e_lite", encounterId: a.encounterId, patientId: a.patientId, requestId: ob.id, regimenId: ob.id, medicineKey: "metronidazole", scheduledFor: new Date(slotAt(hhmm)),
      status: "given", administeredAt: new Date(), administeredById: "u_e2l_nurse", preparedById: "u_e2l_nurse", checkPatient: true, checkDrug: true, checkDose: true, checkRoute: true, checkTime: true,
      timing: "on-time", route: "iv", doseText: "500 mg IV", doseQty: 1, source: "patient-supplied" } }), { userId: "u_e2l_nurse" })).rejects.toThrow(/another patient/);
  });
  it("a witness refused: high-alert insulin — no witness, the giver as witness, a wrong witness PIN; then a second nurse's PIN, and a doctor may witness too", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const hhmm = dhakaHHMM(2), hhmm2 = dhakaHHMM(4);
    const r = await h.signRound(a.encounterId, [line("insulin", { route: "sc", doseText: "6 IU SC by sliding scale", doseQty: null, times: [hhmm, hhmm2] })]);
    const o = orderOf(r, "insulin");
    const base = { requestId: o.id, scheduledFor: slotAt(hhmm), outcome: "given", administeredAt: now(), checks: TICKS, source: "patient-supplied" };
    expect((await dose(a.encounterId, base)).json().blockers).toEqual(["witness_required"]);
    expect((await dose(a.encounterId, { ...base, witness: { userId: "u_e2l_nurse", pin: "1234" } })).json().blockers).toEqual(["witness_self"]);
    const wrong = await dose(a.encounterId, { ...base, witness: { userId: "u_e2l_nurse2", pin: "0000" } });
    expect(wrong.statusCode).toBe(401); expect(wrong.json()).toMatchObject({ code: "witness_pin_wrong" });
    expect(await tenant((tx) => tx.medicationAdministration.count({ where: { requestId: o.id } }))).toBe(0);
    const ok = await dose(a.encounterId, { ...base, witness: { userId: "u_e2l_nurse2", pin: "1234" } });
    expect(ok.statusCode, ok.body).toBe(201);
    const rec = ok.json().orders.find((x: { id: string }) => x.id === o.id).slots.find((s: { at: string }) => s.at === slotAt(hhmm)).record;
    expect(rec).toMatchObject({ status: "given", witness: { id: "u_e2l_nurse2" }, by: { id: "u_e2l_nurse" } });
    const byDoctor = await dose(a.encounterId, { ...base, scheduledFor: slotAt(hhmm2), administeredAt: now(), witness: { userId: "u_e2l_surgeon", pin: "1234" } });
    expect(byDoctor.statusCode, byDoctor.body).toBe(201);
  });
});

describe.runIf(db)("time, checks, reasons, allergy", () => {
  it("never in the future; given needs all five ticks; held needs a reason; missed only after the window (route and database)", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const hhmm = dhakaHHMM(2);
    const r = await h.signRound(a.encounterId, [line("metronidazole", { doseText: "500 mg IV", times: [hhmm] })]);
    const o = orderOf(r, "metronidazole");
    const base = { requestId: o.id, scheduledFor: slotAt(hhmm), outcome: "given", administeredAt: now(), checks: TICKS, source: "patient-supplied" };
    expect((await dose(a.encounterId, { ...base, administeredAt: new Date(Date.now() + 10 * 60_000).toISOString() })).json().blockers).toContain("future_time");
    expect((await dose(a.encounterId, { ...base, checks: { ...TICKS, route: false } })).json().blockers).toEqual(["checks_incomplete"]);
    expect((await dose(a.encounterId, { ...base, outcome: "held" })).json().blockers).toEqual(["reason_required"]);
    expect((await dose(a.encounterId, { ...base, outcome: "missed", reason: "Patient off the ward" })).json().blockers).toEqual(["missed_too_early"]);
    const held = await dose(a.encounterId, { ...base, outcome: "held", reason: "Nil by mouth for theatre" });
    expect(held.statusCode, held.body).toBe(201);
    expect(held.json().orders.find((x: { id: string }) => x.id === o.id).slots[0]).toMatchObject({ state: "held", record: { reason: "Nil by mouth for theatre" } });
    expect((await c.post(`/v1/nursing/encounters/${a.encounterId}/doses`, base, "surgeon")).statusCode).toBe(403);
  });
  it("an allergy recorded after the order blocks giving it until the doctor reviews", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const hhmm = dhakaHHMM(2);
    const r = await h.signRound(a.encounterId, [line("metronidazole", { doseText: "500 mg IV", times: [hhmm] })]);
    const o = orderOf(r, "metronidazole");
    const al = await c.post(`/v1/patients/${a.patientId}/allergies`, { encounterId: a.encounterId, kind: "substance", key: "metronidazole", reaction: "rash", severity: "moderate" }, "surgeon");
    expect(al.statusCode, al.body).toBe(201);
    const mar = (await c.get(`/v1/nursing/encounters/${a.encounterId}/mar`)).json();
    expect(mar.orders.find((x: { id: string }) => x.id === o.id).allergyBlock).toBe(true);
    const d = await dose(a.encounterId, { requestId: o.id, scheduledFor: slotAt(hhmm), outcome: "given", administeredAt: now(), checks: TICKS, source: "patient-supplied" });
    expect(d.json().blockers).toContain("allergy");
    // holding it (not giving) is still recorded
    expect((await dose(a.encounterId, { requestId: o.id, scheduledFor: slotAt(hhmm), outcome: "held", administeredAt: now(), checks: TICKS, reason: "Allergy reported — doctor informed" })).statusCode).toBe(201);
  });
});

describe.runIf(db)("stock, vials, the register, corrections", () => {
  it("ward stock: short → refused (indent first); the patient's own supply is recorded as such and moves no stock; after an indent the dose takes its units", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const hhmm = dhakaHHMM(2), hhmm2 = dhakaHHMM(4);
    const r = await h.signRound(a.encounterId, [line("ceftriaxone", { doseText: "1 g IV", times: [hhmm, hhmm2] })]);
    const o = orderOf(r, "ceftriaxone");
    const base = { requestId: o.id, scheduledFor: slotAt(hhmm), outcome: "given", administeredAt: now(), checks: TICKS };
    const short = await dose(a.encounterId, { ...base, source: "ward-stock" });
    expect(short.statusCode).toBe(409); expect(short.json().code).toBe("stock_short");
    const own = await dose(a.encounterId, { ...base, source: "patient-supplied" });
    expect(own.statusCode, own.body).toBe(201);
    expect(own.json().orders.find((x: { id: string }) => x.id === o.id).slots[0].record).toMatchObject({ source: "patient-supplied" });
    // the nurse requests 3 vials; the pharmacist issues them; the next dose takes one from the ward
    const ind = await c.post(`/v1/nursing/wards/${a.wardId}/indents`, { lines: [{ medicineKey: "ceftriaxone", qty: 3 }] });
    expect(ind.statusCode, ind.body).toBe(201);
    const iss = await c.post(`/v1/pharmacy/indents/${ind.json().id}/issue`, { lines: [{ lineId: ind.json().lines[0].id, qty: 3 }] }, "pharm");
    expect(iss.statusCode, iss.body).toBe(200); expect(iss.json().status).toBe("issued");
    const next = await dose(a.encounterId, { ...base, scheduledFor: slotAt(hhmm2), administeredAt: now(), source: "ward-stock" });
    expect(next.statusCode, next.body).toBe(201);
    expect(next.json().orders.find((x: { id: string }) => x.id === o.id).wardStock).toBe(2);
  });
  it("a multi-dose vial: opened-at recorded (one vial out of the ward); the MAR shows it", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const r = await h.signRound(a.encounterId, [line("insulin", { route: "sc", doseText: "6 IU SC", doseQty: null, times: [dhakaHHMM(2)] })]);
    const o = orderOf(r, "insulin");
    const v = await c.post(`/v1/nursing/encounters/${a.encounterId}/vials`, { requestId: o.id, openedAt: now(), source: "patient-supplied" });
    expect(v.statusCode, v.body).toBe(201);
    expect(v.json().orders.find((x: { id: string }) => x.id === o.id).vial).toMatchObject({ by: { id: "u_e2l_nurse" }, source: "patient-supplied" });
    const metro = await h.signRound(a.encounterId, [line("metronidazole", { doseText: "500 mg", times: [dhakaHHMM(3)] })]);
    expect((await c.post(`/v1/nursing/encounters/${a.encounterId}/vials`, { requestId: orderOf(metro, "metronidazole").id, openedAt: now() })).statusCode).toBe(422);
  });
  it("a controlled drug: the issue needs the pharmacist's PIN and writes a register line; giving it writes one with the witness", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const ind = (await c.post(`/v1/nursing/wards/${a.wardId}/indents`, { lines: [{ medicineKey: "morphine", qty: 2 }] })).json();
    const noPin = await c.post(`/v1/pharmacy/indents/${ind.id}/issue`, { lines: [{ lineId: ind.lines[0].id, qty: 2 }] }, "pharm");
    expect(noPin.statusCode).toBe(422); expect(noPin.json().code).toBe("pin_required");
    expect((await c.post(`/v1/pharmacy/indents/${ind.id}/issue`, { lines: [{ lineId: ind.lines[0].id, qty: 2 }], pin: "0000" }, "pharm")).statusCode).toBe(401);
    const ok = await c.post(`/v1/pharmacy/indents/${ind.id}/issue`, { lines: [{ lineId: ind.lines[0].id, qty: 2 }], pin: "1234" }, "pharm");
    expect(ok.statusCode, ok.body).toBe(200);
    const reg = await tenant((tx) => tx.controlledDrugRegister.findMany({ where: { indentId: ind.id } }));
    expect(reg).toHaveLength(1); expect(reg[0]).toMatchObject({ kind: "issue", qty: 2, byId: "u_e2l_pharm", medicineKey: "morphine" });
    const r = await h.signRound(a.encounterId, [line("morphine", { doseText: "2.5 mg IV", times: [], prn: true, prnMaxPer24h: 6 })]);
    const o = orderOf(r, "morphine");
    const given = await dose(a.encounterId, { requestId: o.id, scheduledFor: null, outcome: "given", administeredAt: now(), checks: TICKS, source: "ward-stock", witness: { userId: "u_e2l_nurse2", pin: "1234" } });
    expect(given.statusCode, given.body).toBe(201);
    const adm = await tenant((tx) => tx.controlledDrugRegister.findFirst({ where: { encounterId: a.encounterId, kind: "administer" } }));
    expect(adm).toMatchObject({ qty: -1, witnessId: "u_e2l_nurse2", byId: "u_e2l_nurse", balanceAfter: 1 });
  });
  it("a wrong record is marked entered-in-error with a reason (never edited); the slot can then be recorded again", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const hhmm = dhakaHHMM(2);
    const r = await h.signRound(a.encounterId, [line("metronidazole", { doseText: "500 mg IV", times: [hhmm] })]);
    const o = orderOf(r, "metronidazole");
    const body = { requestId: o.id, scheduledFor: slotAt(hhmm), outcome: "given", administeredAt: now(), checks: TICKS, source: "patient-supplied" };
    const recId = (await dose(a.encounterId, body)).json().orders.find((x: { id: string }) => x.id === o.id).slots[0].record.id;
    expect((await c.post(`/v1/nursing/doses/${recId}/entered-in-error`, { reason: "x" })).statusCode).toBe(400);
    const err = await c.post(`/v1/nursing/doses/${recId}/entered-in-error`, { reason: "Recorded on the wrong patient chart" });
    expect(err.statusCode, err.body).toBe(200);
    await expect(db!.forTenant(T, (tx) => tx.medicationAdministration.update({ where: { id: recId }, data: { reason: "edited" } }), { userId: "u_e2l_nurse" })).rejects.toThrow(/never changed/);
    expect((await dose(a.encounterId, { ...body, administeredAt: now() })).statusCode).toBe(201);
    expect(randomUUID()).toBeTruthy();
  });
});
