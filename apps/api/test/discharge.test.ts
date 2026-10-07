/* Slice B10–B12 (ADR 0018) on the real database (as setu_app), E2E Lite Hospital: the final bill (deposits applied, the
   excess as a refund in the issuing transaction, the shortfall at the counter, the receipt), the discharge summary
   (Kamrul, 12: a critical result unacknowledged or an escalation open stops the signature; amend never overwrite; the
   A4 print and its QR check; the patient app's record; the take-home medicines on the pharmacy's queue), LAMA and a
   death on the ward (their step graphs, the bed released the same way), and the owner's exceptions. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { RUN, T, TICKS, client, dhakaHHMM, line, setup } from "./ward-helpers.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
let app: Awaited<ReturnType<typeof buildApp>>;
let c: ReturnType<typeof client>; let h: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { app = await buildApp(); if (!db) return; c = client(app); await c.login(); h = await setup(c); });
afterAll(async () => { await app?.close(); });
const tenant = <R>(fn: (tx: import("@setu/db").Tx) => Promise<R>, userId = "u_e2l_cashier") => db!.forTenant(T, fn, { userId });
const DAY = 864e5;
const tomorrow = () => new Date(Date.now() + 6 * 3600_000 + DAY).toISOString().slice(0, 10);
const ok = (r: { statusCode: number; body: string; json: () => any }, status = 200) => { expect(r.statusCode, r.body).toBe(status); return r.json(); };
const pkgId = async (code: string) => ((await c.get("/v1/ipd/packages", "cashier")).json().items as { id: string; code: string }[]).find((p) => p.code === code)!.id;
async function admit(extra: Record<string, unknown> = {}) {
  const ward = await h.ownWard(1);
  const beds = (await c.get("/v1/ipd/beds", "nurse")).json().wards.find((w: { name: string }) => w.name === ward).beds;
  const patientId = await h.newPatient();
  const r = ok(await c.post("/v1/ipd/admissions", { patientId, admittingDoctorId: "u_e2l_surgeon", department: "surgery", diagnosis: "Ovarian cyst for laparoscopy", bedClass: "General", bedId: beds[0].id,
    guardian: { name: "রাশেদ চৌধুরী", relationship: "husband", phone: "01711908812" }, consents: ["general", "financial", "guardian-id"], ...extra }, "desk"), 201);
  return { patientId, admissionId: r.id as string, encounterId: r.encounter.id as string, bedId: r.bed.id as string };
}
const order = async (admissionId: string) => ok(await c.post(`/v1/ipd/admissions/${admissionId}/discharge`, { advice: "Pain settled, eating normally", pin: "1234" }, "surgeon"), 201);
const view = async (admissionId: string) => ok(await c.get(`/v1/ipd/admissions/${admissionId}/discharge`, "nurse"));
const step = (v: { steps: { key: string; status: string }[] }, k: string) => v.steps.find((x) => x.key === k)!.status;
const SECTIONS = { course: "Laparoscopic cystectomy on day 1, uneventful recovery", procedures: [], followUp: { date: tomorrow(), place: "Surgery OPD room 4" }, redFlags: ["Fever above 100.4°F (38°C)"] };
async function draftSummary(admissionId: string, body: Record<string, unknown> = {}) {
  const d = ok(await c.post(`/v1/ipd/admissions/${admissionId}/summary/open`, {}, "surgeon")).draft;
  const saved = ok(await c.put(`/v1/ipd/summaries/${d.id}`, { rev: d.rev, sections: SECTIONS, diagnoses: [{ code: "GC00", verificationStatus: "confirmed" }], medicines: [{ medicineKey: "napa", dose: "1+1+1", meal: "after", days: 5 }], ...body }));
  return saved.draft as { id: string; rev: number };
}
const sign = (d: { id: string; rev: number }, pin = "1234") => c.post(`/v1/ipd/summaries/${d.id}/sign`, { rev: d.rev, pin }, "surgeon");
async function openShift() {
  const mine = ok(await c.get("/v1/shifts/mine", "cashier"));
  if (mine.shift?.status === "open") return mine.shift;
  return ok(await c.post("/v1/shifts", { openingFloatPaisa: 200_000 }, "cashier"), 201);
}

describe.runIf(db)("B10: the final bill", () => {
  it("deposits ৳60,000 on a ৳48,000 bill: issued balanced, the ৳12,000 excess a deposit-excess refund in the same transaction; never rejected; paid at the counter → the payment step done", async () => {
    const a = await admit({ packageId: await pkgId("PKG-LAP-01"), deposit: { method: "card", amountPaisa: 6_000_000, reference: "APPR 9001" } });
    // no discharge yet: refused
    expect(ok(await c.post(`/v1/ipd/bills/${a.admissionId}/issue`, {}, "cashier"), 409).code).toBe("final_not_ordered");
    await order(a.admissionId);
    expect((await c.post(`/v1/ipd/bills/${a.admissionId}/issue`, {}, "nurse")).statusCode).toBe(403);
    const b = ok(await c.post(`/v1/ipd/bills/${a.admissionId}/issue`, {}, "cashier"));
    expect(b.final).toMatchObject({ status: "balanced", depositsPaisa: 6_000_000, excessPaisa: 1_200_000, netPaidPaisa: 4_800_000, duePaisa: 0, excessRefund: { status: "requested", amountPaisa: 1_200_000, paidPaisa: 0 } });
    expect(b.final.number).toMatch(/^INV\/\d\d\/\d{4,}$/);
    expect(b.final.categories.map((x: { category: string }) => x.category)).toEqual(["package", "bed"]);
    expect(b.can).toMatchObject({ deposit: false, postCharge: false, issue: false, pay: false });
    // frozen: nothing posts after the issue (route and database); a second issue is refused
    expect(ok(await c.post(`/v1/ipd/bills/${a.admissionId}/charges`, { code: "desk:transfusion", qty: 1 }, "cashier"), 409).code).toBe("bill_final");
    expect(ok(await c.post(`/v1/ipd/bills/${a.admissionId}/issue`, {}, "cashier"), 409).code).toBe("bill_final");
    const inv = await tenant((tx) => tx.invoice.findFirst({ where: { encounterId: a.encounterId, kind: "ipd" } }));
    expect(inv).toMatchObject({ status: "balanced", excessPaisa: 1_200_000, paidPaisa: 6_000_000 });
    // the payment step waits for the excess to go back
    let v = await view(a.admissionId);
    expect(step(v, "final-bill")).toBe("done"); expect(step(v, "payment")).toBe("in-progress");
    const refund = b.final.excessRefund.id as string;
    // the owner's list shows it until paid (Kamrul, 3: it never expires)
    const dash1 = ok(await c.get("/v1/owner/dashboard?period=today", "owner"));
    expect(dash1.leakage.find((x: { kind: string }) => x.kind === "excessUnpaid").count).toBeGreaterThanOrEqual(1);
    // never rejected or withdrawn; the cashier who issued cannot approve it; the owner approves
    expect(ok(await c.post(`/v1/refunds/${refund}/decision`, { decision: "reject", note: "test: try to reject" }, "owner"), 409).code).toBe("deposit_excess");
    const ap = ok(await c.post(`/v1/refunds/${refund}/decision`, { decision: "approve" }, "owner"));
    expect(ap.refund.status).toBe("approved");
    await openShift();
    const paid = ok(await c.post(`/v1/refunds/${refund}/pay`, { rev: ap.refund.rev, recipient: { name: "রাশেদ চৌধুরী", phone: "01711908812", relation: "spouse" } }, "cashier"));
    expect(paid.outcome).toBe("paid"); expect(paid.view.refund).toMatchObject({ status: "paid", source: "deposit-excess", category: "deposit-excess" });
    v = await view(a.admissionId);
    expect(step(v, "payment")).toBe("done");
    const drill = ok(await c.get("/v1/owner/drill?period=today&what=excessUnpaid", "owner"));
    expect(drill.rows.some((r: { id: string }) => r.id === refund)).toBe(false);
  }, 60_000);
  it("no deposit: issued, the shortfall paid at the counter in two parts; the receipt groups the lines by category and shows the deposits; Mushak-6.3 once settled", async () => {
    const a = await admit();
    await order(a.admissionId);
    ok(await c.post(`/v1/ipd/bills/${a.admissionId}/charges`, { code: "desk:transfusion", qty: 1 }, "cashier"), 201);
    const b = ok(await c.post(`/v1/ipd/bills/${a.admissionId}/issue`, {}, "cashier"));
    const due = b.final.duePaisa as number;
    expect(b.final).toMatchObject({ status: "issued", depositsPaisa: 0, excessPaisa: 0, excessRefund: null });
    expect(b.can).toMatchObject({ pay: true, receipt: false });
    // nothing to receipt yet; more than due refused
    expect(ok(await c.post(`/v1/ipd/bills/${a.admissionId}/receipt`, {}, "cashier"), 409).code).toBe("nothing_paid");
    expect(ok(await c.post(`/v1/ipd/bills/${a.admissionId}/payments`, { method: "card", amountPaisa: due + 100, reference: "APPR 1" }, "cashier"), 409).code).toBe("amount_over_open");
    const p1 = ok(await c.post(`/v1/ipd/bills/${a.admissionId}/payments`, { method: "card", amountPaisa: 100_000, reference: "APPR 2" }, "cashier"), 201);
    expect(p1.final).toMatchObject({ status: "partially-paid", duePaisa: due - 100_000 });
    expect(p1.deposits.items.find((d: { amountPaisa: number }) => d.amountPaisa === 100_000).atCounter).toBe(true);
    const rc1 = ok(await c.post(`/v1/ipd/bills/${a.admissionId}/receipt`, {}, "cashier"), 201).receipt;
    expect(rc1.snapshot).toMatchObject({ paidPaisa: 100_000, duePaisa: due - 100_000, ipd: { depositsPaisa: 100_000, excessPaisa: 0 } });
    expect(rc1.snapshot.lines.map((l: { nameEn: string }) => l.nameEn)).toEqual(["Bed days", "Services"]);
    const p2 = ok(await c.post(`/v1/ipd/bills/${a.admissionId}/payments`, { method: "bank", amountPaisa: due - 100_000, reference: "EFT 77" }, "cashier"), 201);
    expect(p2.final.status).toBe("balanced");
    const rc2 = ok(await c.post(`/v1/ipd/bills/${a.admissionId}/receipt`, {}, "cashier"), 201).receipt;
    expect(rc2.snapshot).toMatchObject({ paidPaisa: due, duePaisa: 0 });
    expect(rc2.number).not.toBe(rc1.number);
    expect(step(await view(a.admissionId), "payment")).toBe("done");
  }, 60_000);
  it("the database: the bill is issued only with a discharge recorded; an excess without its refund never commits", async () => {
    const a = await admit({ deposit: { method: "card", amountPaisa: 500_000, reference: "APPR 3" } });
    const inv = (await tenant((tx) => tx.invoice.findFirst({ where: { encounterId: a.encounterId, kind: "ipd" } })))!;
    const issue = { status: "balanced" as const, number: `INV/99/${Date.now() % 1e6}`, issuedAt: new Date(), issuedById: "u_e2l_cashier", excessPaisa: 500_000 - inv.totalPaisa };
    await expect(tenant((tx) => tx.invoice.update({ where: { id: inv.id }, data: { ...issue, excessPaisa: 0 } }))).rejects.toThrow(/the excess at issue is the deposits beyond the total/);
    await expect(tenant((tx) => tx.invoice.update({ where: { id: inv.id }, data: issue }))).rejects.toThrow(/discharge is ordered/);
    await order(a.admissionId);
    await expect(tenant((tx) => tx.invoice.update({ where: { id: inv.id }, data: issue }))).rejects.toThrow(/excess deposit is assigned to its refund/);
  });
});

describe.runIf(db)("B11: the discharge summary", () => {
  it("sign blockers; refused while a critical result waits for a doctor or an escalation is open (Kamrul, 12); signed → the patient app's record, the step done", async () => {
    const a = await admit();
    expect(ok(await c.post(`/v1/ipd/admissions/${a.admissionId}/summary/open`, {}, "surgeon"), 409).code).toBe("no_discharge");
    await order(a.admissionId);
    expect((await c.post(`/v1/ipd/admissions/${a.admissionId}/summary/open`, {}, "nurse")).statusCode).toBe(403);
    // empty: every section blocks
    const d0 = ok(await c.post(`/v1/ipd/admissions/${a.admissionId}/summary/open`, {}, "surgeon")).draft;
    const r0 = ok(await sign(d0), 422);
    expect(r0.blockers.map((b: { code: string }) => b.code)).toEqual(["diagnosis_final", "course", "follow_up", "red_flags"]);
    // a ward-only medicine is not taken home
    expect(ok(await c.put(`/v1/ipd/summaries/${d0.id}`, { rev: d0.rev, sections: SECTIONS, diagnoses: [], medicines: [{ medicineKey: "ceftriaxone", dose: "1+0+1", meal: "any", days: 5 }] }), 400).fields[0].code).toMatch(/inpatient_only|unknown_medicine/);
    const d = await draftSummary(a.admissionId);
    // a critical result in the doctor's inbox, not acknowledged
    const com = await tenant((tx) => tx.communication.create({ data: { id: `com_${RUN}_${Date.now()}`, tenantId: T, organizationId: "o_e2e_lite", patientId: a.patientId, encounterId: a.encounterId, kind: "critical-vital", channel: "doctor_inbox", recipientUserId: "u_e2l_surgeon", createdById: "u_e2l_nurse" } }), "u_e2l_nurse");
    const r1 = ok(await sign(d), 422);
    expect(r1.blockers.map((b: { code: string }) => b.code)).toEqual(["critical_unacked"]);
    expect(ok(await c.get(`/v1/ipd/admissions/${a.admissionId}/summary`, "surgeon")).blockers).toEqual(["critical_unacked"]);
    ok(await c.post(`/v1/doctor/inbox/${com.id}/ack`, { notifyPatient: false }, "surgeon"));
    const s = ok(await sign(d));
    expect(s.current).toMatchObject({ version: 1, status: "final", diagnoses: [expect.objectContaining({ code: "GC00", verificationStatus: "confirmed" })], medicines: [expect.objectContaining({ medicineKey: "napa", quantity: 15 })] });
    expect(s.can).toMatchObject({ amend: true, print: true, open: false });
    const app1 = await tenant((tx) => tx.communication.findFirst({ where: { encounterId: a.encounterId, kind: "summary-available" } }));
    expect(app1).toMatchObject({ channel: "patient_app", compositionId: s.current.id, status: "completed" });
    const prov = await tenant((tx) => tx.provenance.findFirst({ where: { targetId: s.current.id } }));
    expect(prov).toMatchObject({ activity: "sign", agentId: "u_e2l_surgeon", source: "provider_verified" });
    expect(step(await view(a.admissionId), "summary")).toBe("done");
    // the take-home medicines are on the pharmacy's queue as a normal dispense
    const q = ok(await c.get("/v1/pharmacy/queue", "pharm"));
    expect(q.items.find((x: { encounter: { id: string } }) => x.encounter.id === a.encounterId)).toMatchObject({ takeHome: true, lineCount: 1, status: "to-dispense" });
    const dv = ok(await c.get(`/v1/pharmacy/encounters/${a.encounterId}`, "pharm"));
    expect(dv.composition).toMatchObject({ id: s.current.id, takeHome: true });
  }, 60_000);
  it("amend, never overwrite: v2 supersedes v1; the A4 print with its QR; the public check shows no clinical content; v1 no longer prints", async () => {
    const a = await admit();
    await order(a.admissionId);
    const v1 = ok(await sign(await draftSummary(a.admissionId))).current;
    const pr1 = ok(await c.post(`/v1/documents/ds/${v1.id}/print`, { format: "a5", lang: "both" }, "surgeon"), 201);
    expect(pr1.print).toMatchObject({ copy: 0, format: "a4" }); // the summary is A4 only
    expect((await c.get(`/v1/documents/prints/${pr1.print.id}/pdf`, "nurse")).headers["content-type"]).toBe("application/pdf");
    expect((await c.post(`/v1/ipd/summaries/${v1.id}/amend`, { reason: "ok" }, "surgeon")).statusCode).toBe(400);
    const am = ok(await c.post(`/v1/ipd/summaries/${v1.id}/amend`, { reason: "Follow-up moved to the surgeon's Thursday clinic" }, "surgeon"), 201);
    expect(am.draft).toMatchObject({ version: 2, amendsId: v1.id, medicines: [expect.objectContaining({ medicineKey: "napa" })] });
    const saved = ok(await c.put(`/v1/ipd/summaries/${am.draft.id}`, { rev: am.draft.rev, sections: { ...SECTIONS, followUp: { date: tomorrow(), place: "Surgeon's Thursday clinic" } }, diagnoses: [{ code: "GC00", verificationStatus: "confirmed" }], medicines: [] }));
    const v2 = ok(await sign(saved.draft)).current;
    expect(v2).toMatchObject({ version: 2, status: "amended", medicines: [] });
    const old = await tenant((tx) => tx.composition.findFirst({ where: { id: v1.id } }));
    expect(old).toMatchObject({ status: "superseded", supersededById: v2.id });
    expect(ok(await c.post(`/v1/documents/ds/${v1.id}/print`, { format: "a4", lang: "both", reason: "lost" }, "surgeon"), 422).code).toBe("superseded_not_printable");
    const pr2 = ok(await c.post(`/v1/documents/ds/${v2.id}/print`, { format: "a4", lang: "en" }, "nurse"), 201);
    const chk = ok(await app.inject({ method: "GET", url: `/v1/verify/ds/${pr2.verifyCode}` }));
    expect(chk).toMatchObject({ version: 2, status: "current", doctorEn: expect.any(String) });
    expect(JSON.stringify(chk)).not.toMatch(/GC00|Cystitis|napa|Laparoscopic/);
    expect(ok(await app.inject({ method: "GET", url: `/v1/verify/ds/${pr1.verifyCode}` })).status).toBe("superseded");
    // the database: a signed version is never edited
    await expect(tenant((tx) => tx.composition.update({ where: { id: v2.id }, data: { sections: {} } }), "u_e2l_surgeon")).rejects.toThrow(/never edited/);
  }, 60_000);
});

describe.runIf(db)("B12: LAMA and a death on the ward", () => {
  it("LAMA: the doctor's record with a witness; the patient leaves once the pharmacy has cleared; the visit finishes when the bill is issued", async () => {
    const a = await admit();
    const base = { reason: "Family taking her to Dhaka Medical College", risksExplained: true, formSigned: true, witnessId: "u_e2l_nurse", pin: "1234" };
    expect(ok(await c.post(`/v1/ipd/admissions/${a.admissionId}/lama`, { ...base, witnessId: "u_e2l_surgeon" }, "surgeon"), 400).code).toBe("lama_witness_self");
    expect(ok(await c.post(`/v1/ipd/admissions/${a.admissionId}/lama`, { ...base, formSigned: false }, "surgeon"), 400).code).toBe("lama_form");
    expect(ok(await c.post(`/v1/ipd/admissions/${a.admissionId}/lama`, { ...base, witnessId: "u_e2l_cashier" }, "surgeon"), 400).code).toBe("lama_witness");
    let v = ok(await c.post(`/v1/ipd/admissions/${a.admissionId}/lama`, base, "surgeon"), 201);
    expect(v.discharge).toMatchObject({ kind: "lama", record: expect.objectContaining({ witness: expect.objectContaining({ id: "u_e2l_nurse" }) }) });
    expect(v.admission.outcome).toBe("lama");
    v = ok(await c.post(`/v1/ipd/discharges/${v.discharge.id}/steps/pharmacy/done`, { pin: "1234", ownMedicines: "none" }, "pharm"));
    expect(step(v, "bed-release")).toBe("in-progress"); // no summary, no payment needed to leave
    v = ok(await c.post(`/v1/ipd/discharges/${v.discharge.id}/steps/bed-release/done`, { pin: "1234" }, "nurse"));
    expect(v.discharge.status).toBe("completed"); expect(v.admission.visitFinished).toBe(false);
    const bed = await tenant((tx) => tx.location.findFirst({ where: { id: a.bedId } }));
    expect(bed).toMatchObject({ bedState: "cleaning" }); expect(bed!.bedNote).toMatch(/^LAMA \d\d:\d\d · /);
    // the bill afterwards: the visit finishes; the summary still owed (within 24 hours) and can be signed after leaving
    ok(await c.post(`/v1/ipd/bills/${a.admissionId}/issue`, {}, "cashier"));
    v = await view(a.admissionId);
    expect(v.admission.visitFinished).toBe(true); expect(step(v, "summary")).toBe("in-progress");
    const dues = ok(await c.get("/v1/owner/drill?period=today&what=ipdOutcomeDues", "owner"));
    expect(dues.rows.some((r: { patient: { id: string } | null }) => r.patient?.id === a.patientId)).toBe(true);
    ok(await sign(await draftSummary(a.admissionId, { medicines: [] })));
    expect(step(await view(a.admissionId), "summary")).toBe("done");
  }, 60_000);
  it("death on the ward: the record stops the chart; never cancelled; no summary; the body moved with the nurse's PIN releases the bed; the final bill finishes the visit", async () => {
    const a = await admit();
    const round = await h.signRound(a.encounterId, [line("ceftriaxone", { times: [dhakaHHMM(2)] })]);
    expect(round.activeOrders.length).toBe(1);
    const tod = new Date().toISOString(); // within the stay (admitted moments ago)
    expect(ok(await c.post(`/v1/ipd/admissions/${a.admissionId}/death`, { timeOfDeath: tod, cause: "Septic shock", medicoLegal: false, checks: [], pin: "1234" }, "surgeon"), 400).code).toMatch(/^death_/);
    let v = ok(await c.post(`/v1/ipd/admissions/${a.admissionId}/death`, { timeOfDeath: tod, cause: "Septic shock", medicoLegal: false, checks: ["certificate", "family"], pin: "1234" }, "surgeon"), 201);
    expect(v.steps.map((x: { key: string; status: string }) => `${x.key}:${x.status}`)).toEqual(["order:done", "final-bill:in-progress", "payment:waiting", "bed-release:in-progress"]);
    expect(v.admission.outcome).toBe("deceased"); expect(v.can.cancel).toBe(false);
    expect(ok(await c.post(`/v1/ipd/discharges/${v.discharge.id}/cancel`, { reason: "Recorded on the wrong patient", pin: "1234" }, "surgeon"), 409).code).toBe("death_record");
    const orders = await tenant((tx) => tx.medicationRequest.findMany({ where: { encounterId: a.encounterId, kind: "inpatient" } }));
    expect(orders.every((o) => o.orderStatus === "completed")).toBe(true);
    expect(ok(await c.post(`/v1/nursing/encounters/${a.encounterId}/doses`, { requestId: orders[0]!.id, scheduledFor: null, outcome: "given", administeredAt: new Date().toISOString(), checks: TICKS }, "nurse"), 409).code).toBe("deceased");
    expect(ok(await c.post(`/v1/ipd/admissions/${a.admissionId}/summary/open`, {}, "surgeon"), 409).code).toBe("no_summary_death");
    expect((await c.post(`/v1/ipd/discharges/${v.discharge.id}/steps/bed-release/done`, { pin: "0000" }, "nurse")).statusCode).toBe(401);
    v = ok(await c.post(`/v1/ipd/discharges/${v.discharge.id}/steps/bed-release/done`, { pin: "1234" }, "nurse"));
    expect(v.discharge.status).toBe("completed"); expect(v.admission.visitFinished).toBe(false);
    const after = await tenant(async (tx) => ({ bed: await tx.location.findFirst({ where: { id: a.bedId } }), asg: await tx.bedAssignment.findFirst({ where: { encounterId: a.encounterId }, orderBy: { createdAt: "desc" } }) }));
    expect(after.bed!.bedNote).toMatch(/^Body moved \d\d:\d\d · /); expect(after.asg).toMatchObject({ status: "ended", endReason: "deceased" });
    ok(await c.post(`/v1/ipd/bills/${a.admissionId}/issue`, {}, "cashier"));
    expect((await view(a.admissionId)).admission.visitFinished).toBe(true);
  }, 60_000);
  it("cancel: never after the final bill is issued", async () => {
    const a = await admit();
    const o = await order(a.admissionId);
    ok(await c.post(`/v1/ipd/bills/${a.admissionId}/issue`, {}, "cashier"));
    expect(ok(await c.post(`/v1/ipd/discharges/${o.discharge.id}/cancel`, { reason: "Spiked a fever this morning", pin: "1234" }, "surgeon"), 409).code).toBe("bill_issued");
  });
});
