/* Slice B5–B6 (ADR 0016) on the real database (as setu_app), E2E Lite Hospital. The walkthrough first — B5 "due dose,
   two scans, Given; Held needs reason": Record locked until the wristband and the medicine label are scanned; a wrong
   band or label is refused and audited; "scanner not working" with a reason, never for a high-alert or controlled
   drug (counted per nurse on the owner's exceptions). Then intake / output, care plan tasks and the shift handover
   (signed when every patient is reviewed; accepted by another nurse; an unacknowledged escalation named in the note). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { T, TICKS, bandOf, client, dhakaHHMM, labelOf, line, setup, slotAt } from "./ward-helpers.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
let app: Awaited<ReturnType<typeof buildApp>>;
let c: ReturnType<typeof client>; let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { app = await buildApp(); if (!db) return; c = client(app); await c.login(); h = await setup(c); });
afterAll(async () => { await app?.close(); });
const tenant = <R>(fn: (tx: import("@setu/db").Tx) => Promise<R>) => db!.forTenant(T, fn);
const now = () => new Date().toISOString();
const orderOf = (round: { activeOrders: { id: string; medicine: { key: string } }[] }, key: string) => round.activeOrders.find((o) => o.medicine.key === key)!;
const raw = (encounterId: string, body: object, who: "nurse" | "nurse2" = "nurse") => c.post(`/v1/nursing/encounters/${encounterId}/doses`, body, who);
const issue = async (wardId: string, medicineKey: string, qty: number, pin?: string) => {
  const ind = (await c.post(`/v1/nursing/wards/${wardId}/indents`, { lines: [{ medicineKey, qty }] })).json();
  const r = await c.post(`/v1/pharmacy/indents/${ind.id}/issue`, { lines: [{ lineId: ind.lines[0].id, qty }], ...(pin ? { pin } : {}) }, "pharm");
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};

describe.runIf(db)("B5: Record locked until the wristband and the medicine are scanned", () => {
  it("no scan → refused; the right band and label → given, recorded with the batch scanned; held needs no scan", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const iss = await issue(a.wardId, "ceftriaxone", 2);
    expect(iss.issues[0].label).toMatch(/^SETU-MB1\./);
    const hhmm = dhakaHHMM(2), hhmm2 = dhakaHHMM(4);
    const r = await h.signRound(a.encounterId, [line("ceftriaxone", { doseText: "1 g IV", times: [hhmm, hhmm2] })]);
    const o = orderOf(r, "ceftriaxone");
    const base = { requestId: o.id, scheduledFor: slotAt(hhmm), outcome: "given", administeredAt: now(), checks: TICKS, source: "ward-stock" };
    const none = await raw(a.encounterId, base);
    expect(none.statusCode).toBe(422); expect(none.json().blockers).toEqual(expect.arrayContaining(["band_required", "med_required"]));
    const band = await bandOf(c, a.encounterId), med = (await labelOf(a.encounterId, o.id))!;
    const onlyBand = await raw(a.encounterId, { ...base, scan: { band } });
    expect(onlyBand.json().blockers).toEqual(["med_required"]);
    const ok = await raw(a.encounterId, { ...base, scan: { band, med } });
    expect(ok.statusCode, ok.body).toBe(201);
    const rec = ok.json().orders.find((x: { id: string }) => x.id === o.id).slots.find((x: { at: string }) => x.at === slotAt(hhmm)).record;
    expect(rec.scan).toMatchObject({ band: true, medBatchId: med.slice(9), override: null });
    // held: no scan needed
    expect((await raw(a.encounterId, { requestId: o.id, scheduledFor: slotAt(hhmm2), outcome: "held", administeredAt: now(), checks: TICKS, reason: "NPO for theatre", source: "ward-stock" })).statusCode).toBe(201);
  });
  it("a wrong band (another patient's, or forged) and a wrong label are refused — and audited", async () => {
    const w = await h.ownWard(2); const a = await h.admit(w, 0); const b = await h.admit(w, 1);
    await issue(a.wardId, "ceftriaxone", 2); await issue(a.wardId, "pantoprazole-iv", 1);
    const r = await h.signRound(a.encounterId, [line("ceftriaxone", { doseText: "1 g IV", times: [dhakaHHMM(2)] })]);
    const o = orderOf(r, "ceftriaxone");
    const base = { requestId: o.id, scheduledFor: slotAt(dhakaHHMM(2)), outcome: "given", administeredAt: now(), checks: TICKS, source: "ward-stock" };
    const med = (await labelOf(a.encounterId, o.id))!;
    const otherBand = await bandOf(c, b.encounterId);
    const wrongPatient = await raw(a.encounterId, { ...base, scan: { band: otherBand, med } });
    expect(wrongPatient.statusCode).toBe(422); expect(wrongPatient.json().blockers).toContain("band_mismatch");
    const mine = await bandOf(c, a.encounterId);
    const forged = mine.replace(/\.[^.]+$/, ".AAAAAAAAAAAAAAAAAAAAAA");
    expect((await raw(a.encounterId, { ...base, scan: { band: forged, med } })).json().blockers).toContain("band_mismatch");
    const panto = await tenant((tx) => tx.stockBatch.findFirst({ where: { location: `ward:${a.wardId}`, medicineKey: "pantoprazole-iv" } }));
    expect((await raw(a.encounterId, { ...base, scan: { band: mine, med: `SETU-MB1.${panto!.id}` } })).json().blockers).toContain("med_mismatch");
    // even the override cannot pass a wrong scan
    expect((await raw(a.encounterId, { ...base, scan: { band: otherBand, overrideReason: "Scanner is broken today" } })).json().blockers).toContain("band_mismatch");
    const audited = await tenant((tx) => tx.auditEvent.count({ where: { entity: "MedicationAdministration", entityId: o.id, detail: { path: ["event"], equals: "scan-mismatch" } } }));
    expect(audited).toBeGreaterThanOrEqual(3);
    expect(await tenant((tx) => tx.medicationAdministration.count({ where: { requestId: o.id } }))).toBe(0);
  });
  it("'scanner not working': with a reason (≥10), flagged; never for a high-alert or controlled drug; the database insists", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    await issue(a.wardId, "ceftriaxone", 2); await issue(a.wardId, "morphine", 2, "1234");
    const r = await h.signRound(a.encounterId, [line("ceftriaxone", { doseText: "1 g IV", times: [dhakaHHMM(2)] }), line("morphine", { doseText: "2.5 mg IV", times: [], prn: true, prnMaxPer24h: 6 })]);
    const cef = orderOf(r, "ceftriaxone"), mor = orderOf(r, "morphine");
    const base = { requestId: cef.id, scheduledFor: slotAt(dhakaHHMM(2)), outcome: "given", administeredAt: now(), checks: TICKS, source: "ward-stock" };
    expect((await raw(a.encounterId, { ...base, scan: { overrideReason: "broken" } })).json().blockers).toEqual(["override_reason"]);
    const ok = await raw(a.encounterId, { ...base, scan: { overrideReason: "Scanner battery flat, checked the band by eye" } });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().orders.find((x: { id: string }) => x.id === cef.id).slots[0].record.scan).toMatchObject({ band: false, override: "Scanner battery flat, checked the band by eye" });
    const morph = await raw(a.encounterId, { requestId: mor.id, scheduledFor: null, outcome: "given", administeredAt: now(), checks: TICKS, source: "ward-stock", witness: { userId: "u_e2l_nurse2", pin: "1234" }, scan: { overrideReason: "Scanner battery flat on the ward" } });
    expect(morph.statusCode).toBe(422); expect(morph.json().blockers).toEqual(expect.arrayContaining(["override_not_allowed", "band_required", "med_required"]));
    // the database refuses an override on a controlled drug, and a given dose with neither scans nor a reason
    const row = await tenant((tx) => tx.medicationAdministration.findFirst({ where: { requestId: cef.id } }));
    await expect(db!.forTenant(T, (tx) => tx.medicationAdministration.create({ data: { ...row!, id: "ma_test_noscan", scheduledFor: null, timing: "prn", scanOverrideReason: null, scanBandAt: null, scanMedBatchId: null, requestId: mor.id, regimenId: mor.regimenId, medicineKey: "morphine", highAlert: true, controlled: true, witnessedById: "u_e2l_nurse2", witnessedAt: new Date(), doseText: "2.5 mg IV", route: "iv", stockRef: null } as never }), { userId: "u_e2l_nurse" })).rejects.toThrow(/scanned|override/);
    // the owner's exceptions: scan overrides per nurse
    const dash = (await c.get("/v1/owner/dashboard?period=today", "owner")).json();
    expect(dash.leakage.find((l: { kind: string }) => l.kind === "scanOverride").count).toBeGreaterThanOrEqual(1);
    const drill = (await c.get("/v1/owner/drill?what=scanOverride&period=today", "owner")).json();
    expect(drill.rows.find((x: { by: { id: string } }) => x.by.id === "u_e2l_nurse")).toBeTruthy();
  });
  it("the patient's own supply: the wristband only; a reprint of the band needs a reason", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const r = await h.signRound(a.encounterId, [line("napa", { route: "oral", doseText: "500 mg", times: [], prn: true, prnMaxPer24h: 4 })]);
    const o = orderOf(r, "napa");
    const first = await c.post(`/v1/nursing/encounters/${a.encounterId}/wristband`, {});
    expect(first.statusCode, first.body).toBe(201); expect(first.json()).toMatchObject({ printedBefore: 0 });
    expect((await c.post(`/v1/nursing/encounters/${a.encounterId}/wristband`, {})).statusCode).toBe(400);
    const again = await c.post(`/v1/nursing/encounters/${a.encounterId}/wristband`, { reason: "Band wet and torn" });
    expect(again.statusCode).toBe(201); expect(again.json().code).not.toBe(first.json().code);
    // the reprint retires the first band (a spare kept at the station never verifies — review)
    const old = await raw(a.encounterId, { requestId: o.id, scheduledFor: null, outcome: "given", administeredAt: now(), checks: TICKS, source: "patient-supplied", scan: { band: first.json().code } });
    expect(old.statusCode).toBe(422); expect(old.json().blockers).toContain("band_mismatch");
    const own = await raw(a.encounterId, { requestId: o.id, scheduledFor: null, outcome: "given", administeredAt: now(), checks: TICKS, source: "patient-supplied", scan: { band: again.json().code } });
    expect(own.statusCode, own.body).toBe(201);
    // the owner's exceptions count doses from the patient's own supply, per nurse
    const drill = (await c.get("/v1/owner/drill?what=ownSupply&period=today", "owner")).json();
    expect(drill.rows.find((x: { by: { id: string } }) => x.by.id === "u_e2l_nurse")).toBeTruthy();
  });
});

describe.runIf(db)("intake / output and care plan tasks", () => {
  it("entries per shift day with the balance; append-only; the writer marks a wrong one; the ward card shows 24 h", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    for (const e of [{ side: "in", route: "iv", ml: 500 }, { side: "in", route: "oral", ml: 200 }, { side: "out", route: "urine", ml: 900 }])
      expect((await c.post(`/v1/nursing/encounters/${a.encounterId}/io`, { ...e, effectiveAt: now() })).statusCode).toBe(201);
    expect((await c.post(`/v1/nursing/encounters/${a.encounterId}/io`, { side: "in", route: "urine", ml: 100, effectiveAt: now() })).statusCode).toBe(400);
    expect((await c.post(`/v1/nursing/encounters/${a.encounterId}/io`, { side: "out", route: "drain", ml: 0, effectiveAt: now() })).statusCode).toBe(400);
    let v = (await c.get(`/v1/nursing/encounters/${a.encounterId}/io`)).json();
    expect(v.totals).toEqual({ inMl: 700, outMl: 900, balanceMl: -200 });
    const oral = v.entries.find((x: { route: string }) => x.route === "oral");
    expect((await c.post(`/v1/nursing/io/${oral.id}/entered-in-error`, { reason: "Wrong patient's cup" }, "nurse2")).statusCode).toBe(403);
    expect((await c.post(`/v1/nursing/io/${oral.id}/entered-in-error`, { reason: "Wrong patient's cup" })).statusCode).toBe(200);
    v = (await c.get(`/v1/nursing/encounters/${a.encounterId}/io`)).json();
    expect(v.totals.balanceMl).toBe(-400);
    const board = (await c.get(`/v1/nursing/wards/${a.wardId}/board`)).json();
    expect(board.beds[0].ioBalance24hMl).toBe(-400);
    await expect(db!.forTenant(T, (tx) => tx.intakeOutputEntry.update({ where: { id: oral.id }, data: { ml: 50 } }), { userId: "u_e2l_nurse" })).rejects.toThrow(/never changed/);
  });
  it("a doctor or nurse writes a task; only a nurse ticks it; a recurring one comes back N hours after; overdue on the card", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    const past = new Date(Date.now() - 2 * 3600_000).toISOString();
    expect((await c.post(`/v1/nursing/encounters/${a.encounterId}/tasks`, { text: "Platelets 6-hourly", everyHours: 6, dueAt: past }, "surgeon")).statusCode).toBe(201);
    let l = (await c.post(`/v1/nursing/encounters/${a.encounterId}/tasks`, { text: "Change the dressing", everyHours: null, dueAt: now() })).json();
    expect(l.open).toHaveLength(2);
    expect((await c.get(`/v1/nursing/wards/${a.wardId}/board`)).json().beds[0].tasksOverdue).toBe(1);
    const plt = l.open.find((t: { text: string }) => t.text.startsWith("Platelets"));
    expect(plt.overdue).toBe(true);
    expect((await c.post(`/v1/nursing/tasks/${plt.id}/complete`, {}, "surgeon")).statusCode).toBe(403);
    l = (await c.post(`/v1/nursing/tasks/${plt.id}/complete`, {})).json();
    const next = l.open.find((t: { text: string }) => t.text.startsWith("Platelets"));
    expect(new Date(next.dueAt).getTime() - Date.now()).toBeGreaterThan(5.9 * 3600_000);
    expect(l.done[0]).toMatchObject({ status: "completed", completedBy: { id: "u_e2l_nurse" } });
    const dressing = l.open.find((t: { text: string }) => t.text.startsWith("Change"));
    expect((await c.post(`/v1/nursing/tasks/${dressing.id}/cancel`, { reason: "x" })).statusCode).toBe(400);
    expect((await c.post(`/v1/nursing/tasks/${dressing.id}/cancel`, { reason: "Wound left open by surgeon" })).statusCode).toBe(200);
    expect((await c.get(`/v1/ipd/encounters/${a.encounterId}/round`, "surgeon")).json().tasks.map((t: { text: string }) => t.text)).toEqual(["Platelets 6-hourly"]);
  });
});

describe.runIf(db)("the shift handover", () => {
  it("every patient reviewed before signing; another nurse accepts with her PIN; an unacknowledged escalation must be named", async () => {
    const { sweepEscalations } = await import("../src/modules/ward.js");
    const w = await h.ownWard(2); const a = await h.admit(w, 0); const b = await h.admit(w, 1);
    // an escalation on a, past its acknowledgement time (raised to the doctors on duty)
    await c.post(`/v1/nursing/encounters/${a.encounterId}/vitals`, { values: { bpSys: 118, bpDia: 76, pulse: 124, temp: 102, spo2: 96, rr: 26, consciousness: "A", onOxygen: false }, effectiveAt: now() });
    await sweepEscalations(new Date(Date.now() + 16 * 60_000));
    expect((await c.get(`/v1/nursing/wards/${a.wardId}/handover`)).json()).toMatchObject({ handover: null });
    let v = (await c.post(`/v1/nursing/wards/${a.wardId}/handover`, {})).json();
    expect(v.status).toBe("draft");
    expect(v.patients).toHaveLength(2);
    const pa = v.patients.find((p: { encounterId: string }) => p.encounterId === a.encounterId);
    expect(pa.news2.total).toBe(6); expect(pa.escalation.unacknowledged).toBe(true);
    expect(v.unacknowledged).toEqual([expect.objectContaining({ bed: pa.bed })]);
    v = (await c.put(`/v1/nursing/handovers/${v.id}/patients/${a.encounterId}`, { rev: v.rev, sbar: { s: "NEWS2 6, febrile", b: "Post-op day 2", a: "Possible sepsis", r: "Hourly obs, chase cultures" }, reviewed: true }, "nurse")).json();
    const early = await c.post(`/v1/nursing/handovers/${v.id}/sign`, { rev: v.rev, pin: "1234" });
    expect(early.statusCode).toBe(422); expect(early.json().code).toBe("not_all_reviewed");
    expect((await c.put(`/v1/nursing/handovers/${v.id}/patients/${b.encounterId}`, { rev: v.rev, reviewed: true }, "nurse2")).statusCode).toBe(403);
    v = (await c.put(`/v1/nursing/handovers/${v.id}/patients/${b.encounterId}`, { rev: v.rev, reviewed: true }, "nurse")).json();
    const signed = await c.post(`/v1/nursing/handovers/${v.id}/sign`, { rev: v.rev, pin: "1234" });
    expect(signed.statusCode, signed.body).toBe(200);
    v = signed.json();
    expect(v.status).toBe("outgoing-signed");
    expect((await c.post(`/v1/nursing/handovers/${v.id}/accept`, { rev: v.rev, pin: "1234", note: "ok" })).statusCode).toBe(403); // own
    const unnamed = await c.post(`/v1/nursing/handovers/${v.id}/accept`, { rev: v.rev, pin: "1234", note: "All taken over" }, "nurse2");
    expect(unnamed.statusCode).toBe(422); expect(unnamed.json().code).toBe("escalation_not_named");
    const wrongPin = await c.post(`/v1/nursing/handovers/${v.id}/accept`, { rev: v.rev, pin: "0000", note: `${pa.bed} NEWS2 6 unacknowledged — duty doctor called` }, "nurse2");
    expect(wrongPin.statusCode).toBe(401);
    const ok = await c.post(`/v1/nursing/handovers/${v.id}/accept`, { rev: v.rev, pin: "1234", note: `${pa.bed} NEWS2 6 unacknowledged — duty doctor called` }, "nurse2");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: "accepted", incoming: { id: "u_e2l_nurse2" } });
    // the sheet as handed over (frozen); the ward is now held by the incoming nurse; accepted never changes
    expect(ok.json().patients.find((p: { encounterId: string }) => p.encounterId === a.encounterId).sbar.r).toBe("Hourly obs, chase cultures");
    expect((await c.get(`/v1/nursing/wards/${a.wardId}/board`)).json().onDuty).toMatchObject({ nurse: { id: "u_e2l_nurse2" } });
    await expect(db!.forTenant(T, (tx) => tx.handover.update({ where: { id: v.id }, data: { acceptNote: "edited" } }), { userId: "u_e2l_nurse2" })).rejects.toThrow(/never changes/);
  });
  it("the incoming nurse can query a signed handover back to draft with a note", async () => {
    const w = await h.ownWard(1); const a = await h.admit(w);
    let v = (await c.post(`/v1/nursing/wards/${a.wardId}/handover`, {})).json();
    v = (await c.put(`/v1/nursing/handovers/${v.id}/patients/${a.encounterId}`, { rev: v.rev, reviewed: true }, "nurse")).json();
    v = (await c.post(`/v1/nursing/handovers/${v.id}/sign`, { rev: v.rev, pin: "1234" })).json();
    expect((await c.post(`/v1/nursing/handovers/${v.id}/query`, { rev: v.rev, note: "x" }, "nurse2")).statusCode).toBe(400);
    const q = await c.post(`/v1/nursing/handovers/${v.id}/query`, { rev: v.rev, note: "What is the plan for the drain?" }, "nurse2");
    expect(q.statusCode, q.body).toBe(200);
    expect(q.json()).toMatchObject({ status: "draft", query: { note: "What is the plan for the drain?", by: { id: "u_e2l_nurse2" } } });
  });
  it("a patient admitted while the sheet is a draft joins it unreviewed (signing waits); one admitted after signing blocks acceptance", async () => {
    const w = await h.ownWard(3); const a = await h.admit(w, 0);
    let v = (await c.post(`/v1/nursing/wards/${a.wardId}/handover`, {})).json();
    v = (await c.put(`/v1/nursing/handovers/${v.id}/patients/${a.encounterId}`, { rev: v.rev, reviewed: true }, "nurse")).json();
    const b = await h.admit(w, 1);
    const g = (await c.get(`/v1/nursing/wards/${a.wardId}/handover`)).json().handover;
    expect(g.patients.find((p: { encounterId: string }) => p.encounterId === b.encounterId)).toMatchObject({ reviewed: false, onWard: true });
    expect(g.signBlockers).toEqual(["not_all_reviewed"]);
    expect((await c.post(`/v1/nursing/handovers/${v.id}/sign`, { rev: g.rev, pin: "1234" })).statusCode).toBe(422);
    v = (await c.put(`/v1/nursing/handovers/${v.id}/patients/${b.encounterId}`, { rev: g.rev, reviewed: true }, "nurse")).json();
    v = (await c.post(`/v1/nursing/handovers/${v.id}/sign`, { rev: v.rev, pin: "1234" })).json();
    expect(v.status).toBe("outgoing-signed");
    await h.admit(w, 2);
    const acc = await c.post(`/v1/nursing/handovers/${v.id}/accept`, { rev: v.rev, pin: "1234", note: "ok" }, "nurse2");
    expect(acc.statusCode).toBe(409); expect(acc.json().code).toBe("sheet_outdated");
    // the signed sheet stays in hand for the ward (whatever the clock shift) and opening returns it, never a second sheet
    expect((await c.get(`/v1/nursing/wards/${a.wardId}/handover`)).json().handover.id).toBe(v.id);
    expect((await c.post(`/v1/nursing/wards/${a.wardId}/handover`, {}, "nurse2")).json().id).toBe(v.id);
  });
});
