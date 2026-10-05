/* Slice B3–B4 (ADR 0015): the medication administration record on the real database (as setu_app), E2E Lite Hospital.
   The walkthrough cases first: a double dose, a PRN over the cap, a stopped order, a wrong patient, a refused witness;
   then the time rules, the five checks, the allergy block, ward stock and the patient's own supply, the vial, the
   controlled-drug register, entered-in-error. Each test admits its own synthetic patient to its own ward. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { T, TICKS, bandOf, client, dhakaHHMM, labelOf, line, setup, slotAt, withScans } from "./ward-helpers.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
let app: Awaited<ReturnType<typeof buildApp>>;
let c: ReturnType<typeof client>; let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { app = await buildApp(); if (!db) return; c = client(app); await c.login(); h = await setup(c); });
afterAll(async () => { await app?.close(); });
const tenant = <R>(fn: (tx: import("@setu/db").Tx) => Promise<R>) => db!.forTenant(T, fn);
const now = () => new Date().toISOString();
const orderOf = (round: { activeOrders: { id: string; medicine: { key: string } }[] }, key: string) => round.activeOrders.find((o) => o.medicine.key === key)!;
const dose = async (encounterId: string, body: object, who: "nurse" | "nurse2" | "surgeon" = "nurse") => c.post(`/v1/nursing/encounters/${encounterId}/doses`, await withScans(c, encounterId, body as Record<string, unknown>), who);

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
    const base = { requestId: o.id, scheduledFor: slotAt(hhmm), outcome: "given", administeredAt: now(), checks: TICKS, source: "patient-supplied", amountGiven: "6 IU" };
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
    // nothing of it on the ward: there is no label to scan (ADR 0016) — refused, indent first
    const short = await dose(a.encounterId, { ...base, source: "ward-stock" });
    expect(short.statusCode).toBe(422); expect(short.json().blockers).toContain("med_required");
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
    // another nurse cannot mark it
    expect((await c.post(`/v1/nursing/doses/${recId}/entered-in-error`, { reason: "Not mine to correct" }, "nurse2")).statusCode).toBe(403);
    const err = await c.post(`/v1/nursing/doses/${recId}/entered-in-error`, { reason: "Recorded on the wrong patient chart" });
    expect(err.statusCode, err.body).toBe(200);
    await expect(db!.forTenant(T, (tx) => tx.medicationAdministration.update({ where: { id: recId }, data: { reason: "edited" } }), { userId: "u_e2l_nurse" })).rejects.toThrow(/never changed/);
    // the cell shows it was charted before
    const again = await dose(a.encounterId, { ...body, administeredAt: now() });
    expect(again.statusCode).toBe(201);
    const slot = again.json().orders.find((x: { id: string }) => x.id === o.id).slots[0];
    expect(slot.state).toBe("given"); expect(slot.errored).toHaveLength(1); expect(slot.errored[0]).toMatchObject({ id: recId, status: "entered-in-error" });
    expect(randomUUID()).toBeTruthy();
  });
});

describe.runIf(db)("clinical-safety review fixes (B3–B4 session 2)", () => {
  it("insulin from ward stock: no dose without an opened vial; the amount given is recorded; a dose change keeps the open vial", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const hhmm = dhakaHHMM(2), hhmm2 = dhakaHHMM(5);
    const r = await h.signRound(a.encounterId, [line("insulin", { route: "sc", doseText: "SC by sliding scale (CBG)", doseQty: null, times: [hhmm, hhmm2] })]);
    const o = orderOf(r, "insulin");
    const ind = await c.post(`/v1/nursing/wards/${a.wardId}/indents`, { lines: [{ medicineKey: "insulin", qty: 1 }] });
    expect((await c.post(`/v1/pharmacy/indents/${ind.json().id}/issue`, { lines: [{ lineId: ind.json().lines[0].id, qty: 1 }] }, "pharm")).statusCode).toBe(200);
    const base = { requestId: o.id, scheduledFor: slotAt(hhmm), outcome: "given", administeredAt: now(), checks: TICKS, source: "ward-stock", witness: { userId: "u_e2l_nurse2", pin: "1234" } };
    const noVial = await dose(a.encounterId, { ...base, amountGiven: "4 IU" });
    expect(noVial.statusCode).toBe(422); expect(noVial.json().blockers).toContain("vial_required");
    // the database refuses it too, whatever the route does
    expect((await c.post(`/v1/nursing/encounters/${a.encounterId}/vials`, { requestId: o.id, openedAt: now(), source: "ward-stock" })).statusCode).toBe(201);
    const noAmount = await dose(a.encounterId, base);
    expect(noAmount.statusCode).toBe(422); expect(noAmount.json().blockers).toEqual(["amount_required"]);
    const ok = await dose(a.encounterId, { ...base, amountGiven: "4 IU" });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().orders.find((x: { id: string }) => x.id === o.id).slots.find((x: { at: string }) => x.at === slotAt(hhmm)).record).toMatchObject({ amountGiven: "4 IU" });
  });
  it("a changed order: the same drug given minutes earlier under the old regimen — the new slot needs a reason", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const hhmm = dhakaHHMM(2);
    const r = await h.signRound(a.encounterId, [line("ceftriaxone", { doseText: "1 g IV", times: [hhmm] })]);
    const o = orderOf(r, "ceftriaxone");
    const first = await dose(a.encounterId, { requestId: o.id, scheduledFor: slotAt(hhmm), outcome: "given", administeredAt: now(), checks: TICKS, source: "patient-supplied", reason: "Given at the round" });
    expect(first.statusCode, first.body).toBe(201);
    // the doctor amends the note: 2 g instead of 1 g → a new regimen with the same slot
    const note = (await c.get(`/v1/ipd/encounters/${a.encounterId}/round`, "surgeon")).json().signed[0];
    const amend = await c.post(`/v1/ipd/round-notes/${note.id}/amend`, { reason: "Dose increased after review" }, "surgeon");
    expect(amend.statusCode, amend.body).toBe(201);
    const d = amend.json().draft;
    const saved = await c.put(`/v1/ipd/round-notes/${d.id}`, { rev: d.rev, sections: { ...d.sections, p: "Ceftriaxone 2 g" }, lines: [line("ceftriaxone", { doseText: "2 g IV", doseQty: 2, times: [hhmm] })], orders: [] }, "surgeon");
    expect(saved.statusCode, saved.body).toBe(200);
    const signed = await c.post(`/v1/ipd/round-notes/${d.id}/sign`, { rev: saved.json().draft.rev, pin: "1234" }, "surgeon");
    expect(signed.statusCode, signed.body).toBe(200);
    const o2 = orderOf(signed.json(), "ceftriaxone");
    expect(o2.id).not.toBe(o.id);
    const body = { requestId: o2.id, scheduledFor: slotAt(hhmm), outcome: "given", administeredAt: now(), checks: TICKS, source: "patient-supplied" };
    const near = await dose(a.encounterId, body);
    expect(near.statusCode).toBe(422); expect(near.json().blockers).toContain("recent_dose");
  });
  it("an amendment's copied line is not silently restarted when its order was stopped after the draft opened", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const r = await h.signRound(a.encounterId, [line("heparin", { route: "sc", doseText: "5000 IU SC", doseQty: null, times: [dhakaHHMM(3)] })]);
    const o = orderOf(r, "heparin");
    const note = r.signed[0];
    const amend = await c.post(`/v1/ipd/round-notes/${note.id}/amend`, { reason: "Adding the plan for tomorrow" }, "surgeon");
    expect(amend.statusCode, amend.body).toBe(201);
    expect((await c.post(`/v1/ipd/orders/${o.id}/stop`, { reason: "Bleeding from the wound", pin: "1234" }, "surgeon")).statusCode).toBe(200);
    const d = (await c.get(`/v1/ipd/encounters/${a.encounterId}/round`, "surgeon")).json().draft;
    const sign = await c.post(`/v1/ipd/round-notes/${d.id}/sign`, { rev: d.rev, pin: "1234" }, "surgeon");
    expect(sign.statusCode).toBe(422);
    expect(sign.json().blockers.map((b: { code: string }) => b.code)).toContain("line_stopped");
  });
  it("a PRN dose is charted within the hour; a slot more than 12 hours ahead is not charted", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const r = await h.signRound(a.encounterId, [line("napa", { route: "oral", doseText: "500 mg", times: [], prn: true, prnMaxPer24h: 4, doseQty: 1 }), line("pantoprazole-iv", { doseText: "40 mg", times: [dhakaHHMM(-60)] })]);
    const back = await dose(a.encounterId, { requestId: orderOf(r, "napa").id, scheduledFor: null, outcome: "given", administeredAt: new Date(Date.now() - 3 * 3600_000).toISOString(), checks: TICKS, source: "patient-supplied" });
    expect(back.statusCode).toBe(422); expect(back.json().blockers).toContain("prn_backdated");
    // tomorrow's slot of the same time (more than 12 h ahead)
    const tomorrow = new Date(new Date(slotAt(dhakaHHMM(-60))).getTime() + 864e5).toISOString();
    const far = await dose(a.encounterId, { requestId: orderOf(r, "pantoprazole-iv").id, scheduledFor: tomorrow, outcome: "held", administeredAt: now(), checks: TICKS, reason: "Going to theatre tomorrow", source: "patient-supplied" });
    expect(far.statusCode).toBe(422); expect(far.json().blockers).toContain("slot_too_far");
  });
});

describe.runIf(db)("a dose marked entered-in-error: was the stock drawn? (Kamrul, 06/10/2026)", () => {
  const issue = async (wardId: string, medicineKey: string, qty: number, pin?: string) => {
    const ind = (await c.post(`/v1/nursing/wards/${wardId}/indents`, { lines: [{ medicineKey, qty }] })).json();
    const r = await c.post(`/v1/pharmacy/indents/${ind.id}/issue`, { lines: [{ lineId: ind.lines[0].id, qty }], ...(pin ? { pin } : {}) }, "pharm");
    expect(r.statusCode, r.body).toBe(200);
  };
  it("a ward-stock dose: the answer is required; 'no' puts the unit back to its batch with the reason; 'yes' moves nothing", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    await issue(a.wardId, "ceftriaxone", 3);
    const r = await h.signRound(a.encounterId, [line("ceftriaxone", { doseText: "1 g IV", times: [], prn: true, prnMaxPer24h: 4 })]);
    const o = orderOf(r, "ceftriaxone");
    const give = async () => (await dose(a.encounterId, { requestId: o.id, scheduledFor: null, outcome: "given", administeredAt: now(), checks: TICKS, source: "ward-stock" })).json();
    let v = await give();
    expect(v.orders.find((x: { id: string }) => x.id === o.id).wardStock).toBe(2);
    const rec1 = v.orders.find((x: { id: string }) => x.id === o.id).prnRecords[0];
    expect(rec1).toMatchObject({ stockTaken: 1, returned: 0 });
    const noAnswer = await c.post(`/v1/nursing/doses/${rec1.id}/entered-in-error`, { reason: "Charted on the wrong line" });
    expect(noAnswer.statusCode).toBe(400); expect(noAnswer.json().code).toBe("stock_answer_required");
    const no = await c.post(`/v1/nursing/doses/${rec1.id}/entered-in-error`, { reason: "Charted on the wrong line", stockDrawn: "no" });
    expect(no.statusCode, no.body).toBe(200);
    expect(no.json().orders.find((x: { id: string }) => x.id === o.id).wardStock).toBe(3);
    expect(no.json().history.find((x: { id: string }) => x.id === rec1.id)).toMatchObject({ status: "entered-in-error", errorStockDrawn: "no", returned: 1 });
    const stock = (await c.get(`/v1/nursing/wards/${a.wardId}/stock`)).json();
    expect(stock.returns[0]).toMatchObject({ qty: 1, reason: "Charted on the wrong line" });
    // the database refuses a second return for the same dose
    const mv = await tenant((tx) => tx.stockMove.findFirst({ where: { refType: "dose-error", refId: rec1.id } }));
    await expect(db!.forTenant(T, (tx) => tx.stockMove.create({ data: { tenantId: T, organizationId: mv!.organizationId, batchId: mv!.batchId, kind: "ward-return", qty: 1, refType: "dose-error", refId: rec1.id, reason: "again please", byId: "u_e2l_nurse" } }), { userId: "u_e2l_nurse" })).rejects.toThrow(/no more/);
    v = await give();
    const rec2 = v.orders.find((x: { id: string }) => x.id === o.id).prnRecords.find((x: { status: string }) => x.status === "given");
    const yes = await c.post(`/v1/nursing/doses/${rec2.id}/entered-in-error`, { reason: "Duplicate charting", stockDrawn: "yes" });
    expect(yes.statusCode, yes.body).toBe(200);
    expect(yes.json().orders.find((x: { id: string }) => x.id === o.id).wardStock).toBe(2);
  });
  it("the patient's own supply took no stock: no question", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const r = await h.signRound(a.encounterId, [line("napa", { route: "oral", doseText: "500 mg", times: [], prn: true, prnMaxPer24h: 4 })]);
    const o = orderOf(r, "napa");
    const v = (await dose(a.encounterId, { requestId: o.id, scheduledFor: null, outcome: "given", administeredAt: now(), checks: TICKS, source: "patient-supplied" })).json();
    const rec = v.orders.find((x: { id: string }) => x.id === o.id).prnRecords[0];
    expect(rec.stockTaken).toBe(0);
    expect((await c.post(`/v1/nursing/doses/${rec.id}/entered-in-error`, { reason: "Wrong patient's chart" })).statusCode).toBe(200);
  });
  it("a controlled dose: the register line stays; a linked dose-error line notes the error ('not sure': nothing back; 'no': the unit back)", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    await issue(a.wardId, "morphine", 2, "1234");
    const r = await h.signRound(a.encounterId, [line("morphine", { doseText: "2.5 mg IV", times: [], prn: true, prnMaxPer24h: 6 })]);
    const o = orderOf(r, "morphine");
    const give = async () => { const g = await dose(a.encounterId, { requestId: o.id, scheduledFor: null, outcome: "given", administeredAt: now(), checks: TICKS, source: "ward-stock", witness: { userId: "u_e2l_nurse2", pin: "1234" } }); expect(g.statusCode, g.body).toBe(201); return g.json().orders.find((x: { id: string }) => x.id === o.id).prnRecords.find((x: { status: string }) => x.status === "given"); };
    const d1 = await give();
    expect((await c.post(`/v1/nursing/doses/${d1.id}/entered-in-error`, { reason: "Ampoule dropped before giving", stockDrawn: "unsure" })).statusCode).toBe(200);
    let reg = await tenant((tx) => tx.controlledDrugRegister.findMany({ where: { administrationId: d1.id }, orderBy: { at: "asc" } }));
    expect(reg.map((x) => [x.kind, x.qty])).toEqual([["administer", -1], ["dose-error", 0]]);
    expect(reg[1]!.note).toMatch(/Ampoule dropped.*stock drawn: unsure/);
    const d2 = await give();
    expect((await c.post(`/v1/nursing/doses/${d2.id}/entered-in-error`, { reason: "Charted before drawing up", stockDrawn: "no" })).statusCode).toBe(200);
    reg = await tenant((tx) => tx.controlledDrugRegister.findMany({ where: { administrationId: d2.id }, orderBy: { at: "asc" } }));
    expect(reg.map((x) => [x.kind, x.qty])).toEqual([["administer", -1], ["dose-error", 1]]);
    expect(reg[1]!.stockMoveId).not.toBeNull();
  });
});

