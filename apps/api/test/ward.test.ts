/* Slice B3–B4 (ADR 0015): the ward board, NEWS2 rounds and escalation (walkthrough B6, issue #24), nursing notes, the
   doctor's round note (B7) with amendment continuity (decision 9), the medicine list, indents and bed moves. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { T, client, dhakaHHMM, line, setup, withScans } from "./ward-helpers.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
let app: Awaited<ReturnType<typeof buildApp>>;
let c: ReturnType<typeof client>; let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { app = await buildApp(); if (!db) return; c = client(app); await c.login(); h = await setup(c); });
afterAll(async () => { await app?.close(); });
const tenant = <R>(fn: (tx: import("@setu/db").Tx) => Promise<R>) => db!.forTenant(T, fn);
const now = () => new Date().toISOString();
const B6 = { bpSys: 118, bpDia: 76, pulse: 124, temp: 102, spo2: 96, rr: 26, consciousness: "A", onOxygen: false };

describe.runIf(db)("NEWS2 rounds and escalation (walkthrough B6)", () => {
  it("the Clinic plan has no ward; the ward list and board for a nurse", async () => {
    expect((await c.get("/v1/nursing/wards", "clinicNurse")).json()).toMatchObject({ reason: "plan" });
    const w = await h.ownWard(2); const a = await h.admit(w);
    const wards = (await c.get("/v1/nursing/wards")).json().wards;
    expect(wards.find((x: { id: string }) => x.id === a.wardId)).toMatchObject({ beds: 2, occupied: 1 });
    const board = (await c.get(`/v1/nursing/wards/${a.wardId}/board`)).json();
    expect(board.rule).toMatchObject({ threshold: 5, sample: true });
    expect(board.beds[0]).toMatchObject({ encounterId: a.encounterId, news2: null, escalation: null, doses: { due: 0, overdue: 0 } });
    expect((await c.get(`/v1/nursing/wards/${a.wardId}/board`, "cashier")).statusCode).toBe(403);
  });
  it("RR 26, pulse 124, temp 102 → NEWS2 6 → escalation: a critical item in the admitting doctor's inbox, the ward banner, next obs in 15 min", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const r = await c.post(`/v1/nursing/encounters/${a.encounterId}/vitals`, { values: B6, effectiveAt: now() });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ news2: { total: 6, red: true, risk: "medium", complete: true }, escalated: true, escalation: { status: "raised", score: 6 } });
    expect(new Date(r.json().nextObsDueAt).getTime() - Date.now()).toBeLessThan(16 * 60_000);
    const inbox = (await c.get("/v1/doctor/inbox", "surgeon")).json();
    const item = inbox.items.find((i: { kind: string; patient: { id: string } }) => i.kind === "news2-escalation" && i.patient.id === a.patientId);
    expect(item).toMatchObject({ severity: "critical" });
    const board = (await c.get(`/v1/nursing/wards/${a.wardId}/board`)).json();
    expect(board.escalations).toHaveLength(1); expect(board.beds[0].news2.total).toBe(6);
    // a second high reading while it is open: no second escalation; a worse one: one more inbox item
    await c.post(`/v1/nursing/encounters/${a.encounterId}/vitals`, { values: B6, effectiveAt: now() });
    expect(await tenant((tx) => tx.escalationEvent.count({ where: { encounterId: a.encounterId } }))).toBe(1);
    await c.post(`/v1/nursing/encounters/${a.encounterId}/vitals`, { values: { ...B6, spo2: 90, onOxygen: true }, effectiveAt: now() });
    expect(await tenant((tx) => tx.communication.count({ where: { encounterId: a.encounterId, kind: "news2-escalation" } }))).toBe(2);
    expect((await tenant((tx) => tx.escalationEvent.findFirst({ where: { encounterId: a.encounterId } })))!.peakScore).toBe(11);
  });
  it("worse after the doctor was informed: back to raised, the doctor told again; a first red parameter re-notifies at the same total", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    // RR 22 (2), SpO2 94 (1), SBP 105 (1), pulse 105 (1), temp 99 F (0), alert → 5, no red
    const five = { rr: 22, spo2: 94, onOxygen: false, bpSys: 105, bpDia: 70, pulse: 105, temp: 99, consciousness: "A" };
    const esc = (await c.post(`/v1/nursing/encounters/${a.encounterId}/vitals`, { values: five, effectiveAt: now() })).json().escalation;
    expect(esc).toMatchObject({ status: "raised", score: 5, red: false });
    expect((await c.post(`/v1/nursing/escalations/${esc.id}/inform`, { spokeTo: "Dr. Surgeon", instruction: "Fluids, repeat obs" })).statusCode).toBe(200);
    // lower total (4) but a first red parameter (new confusion = 3) → told again, raised again
    const red = { ...five, rr: 18, spo2: 96, pulse: 95, bpSys: 115, consciousness: "C" };
    const r = await c.post(`/v1/nursing/encounters/${a.encounterId}/vitals`, { values: red, effectiveAt: now() });
    expect(r.json()).toMatchObject({ news2: { red: true }, escalated: true, escalation: { status: "raised" } });
    expect(await tenant((tx) => tx.communication.count({ where: { encounterId: a.encounterId, kind: "news2-escalation" } }))).toBe(2);
  });
  it("the log: inform needs whom and the instruction; resolve needs a note and comes after inform", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const esc = (await c.post(`/v1/nursing/encounters/${a.encounterId}/vitals`, { values: B6, effectiveAt: now() })).json().escalation;
    expect((await c.post(`/v1/nursing/escalations/${esc.id}/resolve`, { note: "settled" })).statusCode).toBe(409);
    expect((await c.post(`/v1/nursing/escalations/${esc.id}/inform`, { spokeTo: "", instruction: "" })).json().fields.map((f: { field: string }) => f.field)).toEqual(["spokeTo", "instruction"]);
    const inf = await c.post(`/v1/nursing/escalations/${esc.id}/inform`, { spokeTo: "Dr. Lite Surgeon", instruction: "Repeat obs q15 min, start IV fluids, review at 15:00" });
    expect(inf.statusCode, inf.body).toBe(200); expect(inf.json()).toMatchObject({ status: "doctor-informed", informedBy: { id: "u_e2l_nurse" } });
    const res = await c.post(`/v1/nursing/escalations/${esc.id}/resolve`, { note: "NEWS2 3 after fluids" }, "surgeon");
    expect(res.statusCode, res.body).toBe(200); expect(res.json().status).toBe("resolved");
  });
  it("A4 rules apply on the ward: an impossible value refuses the set; a respiratory rate of 0 is not possible; offline device time within 24 h is kept", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    expect((await c.post(`/v1/nursing/encounters/${a.encounterId}/vitals`, { values: { ...B6, temp: 994 }, effectiveAt: now() })).json().code).toBe("vitals_impossible");
    expect((await c.post(`/v1/nursing/encounters/${a.encounterId}/vitals`, { values: { ...B6, rr: 0 }, effectiveAt: now() })).json().code).toBe("vitals_impossible");
    const earlier = new Date(Date.now() - 3 * 3600_000).toISOString();
    const r = await c.post(`/v1/nursing/encounters/${a.encounterId}/vitals`, { values: { ...B6, rr: 16, pulse: 80, temp: 98.6 }, effectiveAt: earlier });
    expect(r.statusCode).toBe(201); expect(r.json().batch.effectiveAt).toBe(earlier); expect(r.json().escalated).toBe(false);
  });
});

describe.runIf(db)("nursing notes", () => {
  it("append-only: written by the nurse with device time; marked entered-in-error with a reason, never edited", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    expect((await c.post(`/v1/nursing/encounters/${a.encounterId}/notes`, { text: "ok", effectiveAt: now() })).statusCode).toBe(400);
    const n = await c.post(`/v1/nursing/encounters/${a.encounterId}/notes`, { text: "Dressing changed, small serous discharge", effectiveAt: now() });
    expect(n.statusCode, n.body).toBe(201); expect(n.json()).toMatchObject({ status: "active", writtenBy: { id: "u_e2l_nurse" } });
    const e = await c.post(`/v1/nursing/notes/${n.json().id}/entered-in-error`, { reason: "Written on the wrong patient" });
    expect(e.statusCode, e.body).toBe(200); expect(e.json().status).toBe("entered-in-error");
    await expect(db!.forTenant(T, (tx) => tx.nursingNote.update({ where: { id: n.json().id }, data: { text: "edited" } }), { userId: "u_e2l_nurse" })).rejects.toThrow(/never edited/);
    const view = (await c.get(`/v1/nursing/encounters/${a.encounterId}`)).json();
    expect(view.notes[0]).toMatchObject({ status: "entered-in-error", error: { reason: "Written on the wrong patient" } });
  });
});

describe.runIf(db)("the doctor's ward round (walkthrough B7)", () => {
  it("the worklist is by risk; a nurse may not round; the note needs the assessment or the plan; signing makes the orders active", async () => {
    const w = await h.ownWard(2); const low = await h.admit(w, 0); const high = await h.admit(w, 1);
    await c.post(`/v1/nursing/encounters/${high.encounterId}/vitals`, { values: B6, effectiveAt: now() });
    const wl = (await c.get("/v1/ipd/rounds", "surgeon")).json().items as { encounterId: string }[];
    expect(wl.findIndex((i) => i.encounterId === high.encounterId)).toBeLessThan(wl.findIndex((i) => i.encounterId === low.encounterId));
    expect((await c.get("/v1/ipd/rounds", "nurse")).statusCode).toBe(403);
    const open = (await c.post(`/v1/ipd/encounters/${low.encounterId}/round/open`, {}, "surgeon")).json().draft;
    const saved = (await c.put(`/v1/ipd/round-notes/${open.id}`, { rev: open.rev, sections: { s: "", o: "", a: "", p: "" }, lines: [line("metronidazole", { doseText: "500 mg IV" })], orders: [] })).json().draft;
    const blocked = await c.post(`/v1/ipd/round-notes/${open.id}/sign`, { rev: saved.rev, pin: "1234" }, "surgeon");
    expect(blocked.statusCode).toBe(422); expect(blocked.json().blockers.map((b: { code: string }) => b.code)).toContain("assessment_or_plan");
    const bad = await c.put(`/v1/ipd/round-notes/${open.id}`, { rev: saved.rev, sections: { s: "", o: "", a: "Infection", p: "" }, lines: [line("metronidazole", { route: "oral" })], orders: [] });
    expect(bad.statusCode).toBe(400); expect(bad.json().fields[0]).toMatchObject({ field: "lines.0", code: "route" });
  });
  it("the A5 allergy block applies to inpatient orders: an active penicillin allergy refuses a penicillin line", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    expect((await c.post(`/v1/patients/${a.patientId}/allergies`, { encounterId: a.encounterId, kind: "class", key: "penicillin", reaction: "rash", severity: "moderate" }, "surgeon")).statusCode).toBe(201);
    const open = (await c.post(`/v1/ipd/encounters/${a.encounterId}/round/open`, {}, "surgeon")).json().draft;
    const saved = (await c.put(`/v1/ipd/round-notes/${open.id}`, { rev: open.rev, sections: { s: "", o: "", a: "Chest infection", p: "Oral antibiotic" }, lines: [line("moxacil", { route: "oral", doseText: "500 mg", times: ["08:00", "16:00", "23:00"] })], orders: [] })).json().draft;
    const s = await c.post(`/v1/ipd/round-notes/${open.id}/sign`, { rev: saved.rev, pin: "1234" }, "surgeon");
    expect(s.statusCode).toBe(422); expect(s.json().blockers.some((b: { code: string; warning?: { kind: string } }) => b.code === "rx" && b.warning?.kind === "allergy")).toBe(true);
  });
  it("decision 9: an amendment keeps an unchanged line's regimen; a changed dose is a new regimen and the old line's doses stop", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const hhmm = dhakaHHMM(2);
    const v1 = await h.signRound(a.encounterId, [line("paracetamol-iv", { doseText: "1 g IV", times: [hhmm] }), line("ceftriaxone", { doseText: "1 g IV", times: [hhmm] })]);
    const p1 = v1.activeOrders.find((o: { medicine: { key: string } }) => o.medicine.key === "paracetamol-iv");
    const c1 = v1.activeOrders.find((o: { medicine: { key: string } }) => o.medicine.key === "ceftriaxone");
    const note = v1.signed[0];
    expect((await c.post(`/v1/ipd/round-notes/${note.id}/amend`, { reason: "x" }, "surgeon")).statusCode).toBe(400);
    const am = await c.post(`/v1/ipd/round-notes/${note.id}/amend`, { reason: "Paracetamol dose reduced" }, "surgeon");
    expect(am.statusCode, am.body).toBe(201);
    const d2 = am.json().draft;
    expect(d2).toMatchObject({ version: 2, amendsId: note.id }); expect(d2.lines).toHaveLength(2);
    const lines = d2.lines.map((l: Record<string, unknown>) => ({ medicineKey: l.medicineKey, route: l.route, doseText: l.medicineKey === "paracetamol-iv" ? "500 mg IV" : l.doseText, doseQty: l.doseQty, times: l.times, prn: l.prn, prnMaxPer24h: l.prnMaxPer24h }));
    const saved = (await c.put(`/v1/ipd/round-notes/${d2.id}`, { rev: d2.rev, sections: d2.sections, lines, orders: [] })).json().draft;
    const v2 = (await c.post(`/v1/ipd/round-notes/${d2.id}/sign`, { rev: saved.rev, pin: "1234" }, "surgeon")).json();
    const p2 = v2.activeOrders.find((o: { medicine: { key: string } }) => o.medicine.key === "paracetamol-iv");
    const c2 = v2.activeOrders.find((o: { medicine: { key: string } }) => o.medicine.key === "ceftriaxone");
    expect(c2.regimenId).toBe(c1.regimenId); expect(c2.id).not.toBe(c1.id);
    expect(p2.regimenId).not.toBe(p1.regimenId);
    const old = await tenant((tx) => tx.medicationRequest.findMany({ where: { id: { in: [p1.id, c1.id] } } }));
    expect(old.every((o) => o.orderStatus === "superseded")).toBe(true);
    expect(await tenant((tx) => tx.composition.findFirst({ where: { id: note.id } })).then((x) => x!.status)).toBe("superseded");
  });
  it("the ward medicine list includes injections; the OPD prescription search hides them", async () => {
    const ward = (await c.get("/v1/ipd/medicines?q=morph", "surgeon")).json().items;
    expect(ward[0]).toMatchObject({ key: "morphine", highAlert: true, controlled: true, sample: true });
    const opd = (await c.get("/v1/catalog/medicines?q=morph", "surgeon")).json().items;
    expect(opd).toEqual([]);
  });
});

describe.runIf(db)("indents and bed moves", () => {
  it("an indent: requested by the nurse, issued partly then in full by the pharmacist (store → ward, two legs), INDENT states", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    expect((await c.post(`/v1/nursing/wards/${a.wardId}/indents`, { lines: [] })).statusCode).toBe(400);
    const ind = (await c.post(`/v1/nursing/wards/${a.wardId}/indents`, { lines: [{ medicineKey: "ns", qty: 6 }, { medicineKey: "metronidazole", qty: 4 }], note: "STAT for the new admission" })).json();
    expect(ind).toMatchObject({ status: "requested" }); expect(ind.number).toMatch(/^IND\/\d{2}\/\d{4}$/);
    expect((await c.post(`/v1/pharmacy/indents/${ind.id}/issue`, { lines: [{ lineId: ind.lines[0].id, qty: 4 }] }, "nurse")).statusCode).toBe(403);
    const part = (await c.post(`/v1/pharmacy/indents/${ind.id}/issue`, { lines: [{ lineId: ind.lines[0].id, qty: 4 }] }, "pharm")).json();
    expect(part.status).toBe("partially-issued");
    expect((await c.post(`/v1/pharmacy/indents/${ind.id}/issue`, { lines: [{ lineId: ind.lines[0].id, qty: 3 }] }, "pharm")).json().code).toBe("over_request");
    const full = (await c.post(`/v1/pharmacy/indents/${ind.id}/issue`, { lines: [{ lineId: ind.lines[0].id, qty: 2 }, { lineId: ind.lines[1].id, qty: 4 }] }, "pharm")).json();
    expect(full.status).toBe("issued");
    const stock = (await c.get(`/v1/nursing/wards/${a.wardId}/stock`)).json().items;
    expect(stock.find((x: { medicineKey: string }) => x.medicineKey === "ns").qty).toBe(6);
    const moves = await tenant((tx) => tx.stockMove.findMany({ where: { refType: "indent-issue", refId: { in: (full.issues as { lineId: string }[]).map(() => "") } } }));
    expect(moves).toBeDefined();
    expect((await c.get("/v1/pharmacy/indents?status=issued", "pharm")).json().items.some((x: { id: string }) => x.id === ind.id)).toBe(true);
    const ind2 = (await c.post(`/v1/nursing/wards/${a.wardId}/indents`, { lines: [{ medicineKey: "kcl", qty: 2 }] })).json();
    const cancelled = await c.post(`/v1/indents/${ind2.id}/cancel`, { reason: "Ordered by mistake" });
    expect(cancelled.statusCode, cancelled.body).toBe(200); expect(cancelled.json().status).toBe("cancelled");
  });
  it("a bed move: reserve then arrive (leg 1, leg 2) to another ward; or now in one step; the source goes to cleaning", async () => {
    const w1 = await h.ownWard(1); const w2 = await h.ownWard(2); const a = await h.admit(w1);
    const beds2 = (await c.get("/v1/ipd/beds", "nurse")).json().wards.find((x: { name: string }) => x.name === w2).beds;
    expect((await c.post(`/v1/ipd/admissions/${a.admissionId}/transfer`, { bedId: beds2[0].id, reason: "x", mode: "reserve" })).statusCode).toBe(400);
    const res = await c.post(`/v1/ipd/admissions/${a.admissionId}/transfer`, { bedId: beds2[0].id, reason: "Closer monitoring near the station", handoverNote: "MEWS 6 at 10:30", mode: "reserve" });
    expect(res.statusCode, res.body).toBe(200);
    const st = async (id: string) => (await tenant((tx) => tx.location.findFirst({ where: { id } })))!.bedState;
    expect([await st(a.bedId), await st(beds2[0].id)]).toEqual(["occupied", "reserved"]);
    const arr = await c.post(`/v1/ipd/admissions/${a.admissionId}/transfer/arrive`, {});
    expect(arr.statusCode, arr.body).toBe(200); expect(arr.json().bed.id).toBe(beds2[0].id);
    expect([await st(a.bedId), await st(beds2[0].id)]).toEqual(["cleaning", "occupied"]);
    const now1 = await c.post(`/v1/ipd/admissions/${a.admissionId}/transfer`, { bedId: beds2[1].id, reason: "Bed nearer the window requested", mode: "now" });
    expect(now1.statusCode, now1.body).toBe(200);
    expect([await st(beds2[0].id), await st(beds2[1].id)]).toEqual(["cleaning", "occupied"]);
    const legs = await tenant((tx) => tx.bedAssignment.findMany({ where: { patientId: a.patientId }, orderBy: { createdAt: "asc" } }));
    expect(legs.filter((l) => l.status !== "ended")).toHaveLength(1);
    expect(dhakaHHMM(0)).toMatch(/^\d\d:\d\d$/);
  });
});

describe.runIf(db)("escalation reach: unacknowledged in the app within N minutes → every doctor on duty (Kamrul, 06/10/2026)", () => {
  it("raised to the doctors on duty and shown unacknowledged; a doctor's acknowledgement in the app stops it; worse restarts the clock", async () => {
    const { sweepEscalations } = await import("../src/modules/ward.js");
    const w = await h.ownWard(1); const a = await h.admit(w);
    const esc = (await c.post(`/v1/nursing/encounters/${a.encounterId}/vitals`, { values: B6, effectiveAt: now() })).json().escalation;
    expect(esc).toMatchObject({ acknowledgedAt: null, widenedAt: null, unacknowledged: false });
    const due = new Date(esc.ackDueAt).getTime() - new Date(esc.raisedAt).getTime();
    expect(due).toBe(15 * 60_000);
    // a nurse's logged call is not an acknowledgement
    expect((await c.post(`/v1/nursing/escalations/${esc.id}/inform`, { spokeTo: "Dr. Surgeon (phone)", instruction: "Coming to see" })).statusCode).toBe(200);
    await sweepEscalations(new Date(Date.now() + 10 * 60_000));
    expect((await tenant((tx) => tx.escalationEvent.findFirst({ where: { id: esc.id } })))!.widenedAt).toBeNull();
    await sweepEscalations(new Date(Date.now() + 16 * 60_000));
    const recipients = (await tenant((tx) => tx.communication.findMany({ where: { encounterId: a.encounterId, kind: "news2-escalation" }, select: { recipientUserId: true } }))).map((x) => x.recipientUserId).sort();
    expect(recipients).toEqual(expect.arrayContaining(["u_e2l_doctor", "u_e2l_paed", "u_e2l_surgeon"]));
    expect(recipients.filter((x) => x === "u_e2l_surgeon")).toHaveLength(1); // the admitting doctor is not told twice
    // external review B2: with no duty list it went to every active doctor — the owner is told to set the roster
    const org = (await tenant((tx) => tx.encounter.findFirst({ where: { id: a.encounterId }, select: { organizationId: true } })))!.organizationId;
    const list = (await tenant((tx) => tx.organization.findFirst({ where: { id: org }, select: { escalationDutyDoctorIds: true } })))?.escalationDutyDoctorIds ?? [];
    const flags = await tenant((tx) => tx.auditEvent.findMany({ where: { action: "duty-list-missing", entityId: a.encounterId } }));
    expect(flags.map((f) => (f.detail as { kind: string }).kind)).toEqual(list.length ? [] : ["news2-escalation"]);
    const board = (await c.get(`/v1/nursing/wards/${a.wardId}/board`)).json();
    expect(board.escalations[0].escalation).toMatchObject({ unacknowledged: true });
    expect(board.escalations[0].escalation.widenedAt).not.toBeNull();
    // the on-duty doctor acknowledges it in the inbox
    const inbox = (await c.get("/v1/doctor/inbox", "doctor")).json();
    const item = inbox.items.find((i: { kind: string; patient: { id: string } }) => i.kind === "news2-escalation" && i.patient.id === a.patientId);
    expect((await c.post(`/v1/doctor/inbox/${item.id}/ack`, { notifyPatient: false }, "doctor")).statusCode).toBe(200);
    const acked = (await c.get(`/v1/nursing/encounters/${a.encounterId}`)).json().escalations[0];
    expect(acked).toMatchObject({ unacknowledged: false, acknowledgedBy: { id: "u_e2l_doctor" } });
    // worse: the acknowledgement is asked for again on a fresh clock
    const worse = (await c.post(`/v1/nursing/encounters/${a.encounterId}/vitals`, { values: { ...B6, spo2: 90, onOxygen: true }, effectiveAt: now() })).json().escalation;
    expect(worse).toMatchObject({ status: "raised", acknowledgedAt: null, widenedAt: null });
    expect(new Date(worse.ackDueAt).getTime()).toBeGreaterThan(new Date(esc.ackDueAt).getTime());
  });
  it("N and the duty list are facility settings (admin); the list names only active doctors here", async () => {
    const f = (await c.get("/v1/admin/facility", "admin")).json();
    expect(f.escalation).toMatchObject({ ackMinutes: 15, dutyDoctorIds: [], sample: true });
    const base = { ...f.settings, receiptFormat: f.settings.receiptFormat ?? "a5", rxFormat: f.settings.rxFormat ?? "a5" };
    expect((await c.post("/v1/admin/settings", { ...base, escalationAckMinutes: 3 }, "admin")).statusCode).toBe(400);
    expect((await c.post("/v1/admin/settings", { ...base, escalationDutyDoctorIds: ["u_e2l_nurse"] }, "admin")).statusCode).toBe(400);
    const ok = await c.post("/v1/admin/settings", { ...base, escalationAckMinutes: 10, escalationDutyDoctorIds: ["u_e2l_doctor"] }, "admin");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().escalation).toMatchObject({ ackMinutes: 10, dutyDoctorIds: ["u_e2l_doctor"] });
    const w = await h.ownWard(1); const a = await h.admit(w);
    const esc = (await c.post(`/v1/nursing/encounters/${a.encounterId}/vitals`, { values: B6, effectiveAt: now() })).json().escalation;
    expect(new Date(esc.ackDueAt).getTime() - new Date(esc.raisedAt).getTime()).toBe(10 * 60_000);
    // restore the defaults for the other tests
    expect((await c.post("/v1/admin/settings", { ...base, escalationAckMinutes: 15, escalationDutyDoctorIds: [] }, "admin")).statusCode).toBe(200);
  });
});

describe.runIf(db)("ward stock counts (Kamrul, 06/10/2026): the nurse counts, the pharmacist or owner decides", () => {
  it("an errored dose's return shows on the ward count; a controlled variance goes on the register; the nurse cannot decide", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const issue = async (medicineKey: string, qty: number, pin?: string) => {
      const ind = (await c.post(`/v1/nursing/wards/${a.wardId}/indents`, { lines: [{ medicineKey, qty }] })).json();
      expect((await c.post(`/v1/pharmacy/indents/${ind.id}/issue`, { lines: [{ lineId: ind.lines[0].id, qty }], ...(pin ? { pin } : {}) }, "pharm")).statusCode).toBe(200);
    };
    await issue("ceftriaxone", 3); await issue("morphine", 2, "1234");
    const r = await h.signRound(a.encounterId, [line("ceftriaxone", { doseText: "1 g IV", times: [], prn: true, prnMaxPer24h: 4 })]);
    const o = r.activeOrders.find((x: { medicine: { key: string } }) => x.medicine.key === "ceftriaxone");
    const given = (await c.post(`/v1/nursing/encounters/${a.encounterId}/doses`, await withScans(c, a.encounterId, { requestId: o.id, scheduledFor: null, outcome: "given", administeredAt: now(), checks: { patient: true, drug: true, dose: true, route: true, time: true }, source: "ward-stock" }))).json();
    const rec = given.orders.find((x: { id: string }) => x.id === o.id).prnRecords[0];
    expect((await c.post(`/v1/nursing/doses/${rec.id}/entered-in-error`, { reason: "Charted on the wrong line", stockDrawn: "no" })).statusCode).toBe(200);
    // a ward is not counted through the pharmacy's count (counter / store / fridge only)
    expect((await c.post("/v1/pharmacy/counts", { location: `ward:${a.wardId}` }, "pharm")).statusCode).toBe(400);
    expect((await c.post(`/v1/nursing/wards/${a.wardId}/counts`, {}, "surgeon")).statusCode).toBe(403);
    const started = await c.post(`/v1/nursing/wards/${a.wardId}/counts`, {});
    expect(started.statusCode, started.body).toBe(201);
    let v = started.json();
    expect(v).toMatchObject({ location: `ward:${a.wardId}`, status: "counting", wardName: w, canDecide: false });
    const cef = v.lines.find((l: { medicine: { key: string } }) => l.medicine.key === "ceftriaxone");
    expect(cef.systemQty).toBe(3);
    expect(cef.returns).toEqual([expect.objectContaining({ qty: 1, reason: "Charted on the wrong line" })]);
    expect((await c.post(`/v1/nursing/wards/${a.wardId}/counts`, {})).statusCode).toBe(409); // one open count per ward
    const mor = v.lines.find((l: { medicine: { key: string } }) => l.medicine.key === "morphine");
    v = (await c.post(`/v1/nursing/counts/${v.id}/lines`, { rev: v.rev, lineId: cef.id, countedQty: 3 })).json();
    v = (await c.post(`/v1/nursing/counts/${v.id}/lines`, { rev: v.rev, lineId: mor.id, countedQty: 1, reason: "One ampoule broken on the trolley" })).json();
    const sub = await c.post(`/v1/nursing/counts/${v.id}/submit`, { rev: v.rev });
    expect(sub.statusCode, sub.body).toBe(200);
    v = sub.json();
    // the nurse has no pharmacy screen; the admin is not a ward-count approver; the pharmacist decides
    expect((await c.post(`/v1/pharmacy/counts/${v.id}/decision`, { decision: "approve" })).statusCode).toBe(403);
    expect((await c.post(`/v1/pharmacy/counts/${v.id}/decision`, { decision: "approve" }, "admin")).statusCode).toBe(403);
    expect((await c.get(`/v1/pharmacy/counts/${v.id}`, "pharm")).json().canDecide).toBe(true);
    const ok = await c.post(`/v1/pharmacy/counts/${v.id}/decision`, { decision: "approve" }, "pharm");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: "approved", decidedBy: { id: "u_e2l_pharm" }, selfApproved: false });
    const reg = await tenant((tx) => tx.controlledDrugRegister.findFirst({ where: { kind: "count-adjust", location: `ward:${a.wardId}` } }));
    expect(reg).toMatchObject({ medicineKey: "morphine", qty: -1, byId: "u_e2l_pharm", balanceAfter: 1 });
    // the next count no longer lists the return (it was on the decided count)
    const next = (await c.post(`/v1/nursing/wards/${a.wardId}/counts`, {})).json();
    expect(next.lines.find((l: { medicine: { key: string } }) => l.medicine.key === "ceftriaxone").returns).toEqual([]);
    expect((await c.get(`/v1/nursing/wards/${a.wardId}/counts`)).json().items[0]).toMatchObject({ wardName: w, status: "counting" });
  });
});

