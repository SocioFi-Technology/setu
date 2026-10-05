/* ADR 0015: the E2E Lite Hospital's walkthrough inpatient — Shahidul Islam admitted to Ward 3B, bed 3B-05, under the
   surgeon, with a signed ward round note carrying the prototype's order set (started a day ago, so there are slots to
   give and to miss). Shared by the seed and `pnpm db:reset-e2e` (which re-creates it fresh for every run). Written as
   the owner through the same rows the API writes; the database guards apply. */
import { randomUUID } from "node:crypto";
import { wardMedicine } from "@setu/domain";
import type { PrismaClient } from "@prisma/client";
import { SEED_ORDERS } from "./wards.ts";

export const LITE = { tenant: "t_e2e_lite", org: "o_e2e_lite", branch: "l_branch_e2e_lite" } as const;
export const INPATIENT = { patientId: "e2l_p_shahidul", bed: "3B-05", doctorId: "u_e2l_surgeon", deskId: "u_e2l_desk" } as const;

export async function seedInpatient(db: PrismaClient, now = new Date()): Promise<{ encounterId: string; admissionNumber: string }> {
  const started = new Date(now.getTime() - 24 * 3600_000);
  const day = new Date(now.getTime() + 6 * 3600_000).toISOString().slice(0, 10);
  const bed = await db.location.findFirst({ where: { tenantId: LITE.tenant, kind: "bed", name: INPATIENT.bed } });
  if (!bed) throw new Error("seedInpatient: Ward 3B is not seeded");
  return db.$transaction(async (tx) => {
    const seqName = `admission:${LITE.org}`;
    const seq = await tx.sequence.upsert({ where: { tenantId_name: { tenantId: LITE.tenant, name: seqName } }, create: { tenantId: LITE.tenant, name: seqName, value: 1 }, update: { value: { increment: 1 } } });
    const number = `ADM/${day.slice(2, 4)}/${String(seq.value).padStart(4, "0")}`;
    const enc = await tx.encounter.create({ data: {
      tenantId: LITE.tenant, organizationId: LITE.org, branchId: LITE.branch, patientId: INPATIENT.patientId, class: "ipd", status: "in_progress", visitType: "admission",
      practitionerId: INPATIENT.doctorId, token: number, tokenNo: seq.value, tokenDay: day, arrivedAt: started, statusAt: started, createdById: INPATIENT.deskId, createdAt: started,
    } });
    const adm = await tx.admission.create({ data: {
      tenantId: LITE.tenant, organizationId: LITE.org, branchId: LITE.branch, patientId: INPATIENT.patientId, encounterId: enc.id, source: "direct", status: "admitted", number,
      admittingDoctorId: INPATIENT.doctorId, department: "surgery", diagnosis: "Post-operative day 6, wound infection — on IV antibiotics", bedClass: "General", bedId: bed.id,
      guardianName: "রাশেদা ইসলাম", guardianRelationship: "wife", guardianPhone: "01811223355", consents: ["general", "financial", "guardian-id"],
      requestedById: INPATIENT.deskId, requestedAt: started, admittedById: INPATIENT.deskId, admittedAt: started,
    } });
    const inv = await tx.invoice.create({ data: { tenantId: LITE.tenant, organizationId: LITE.org, branchId: LITE.branch, patientId: INPATIENT.patientId, encounterId: enc.id, kind: "ipd", status: "draft", createdById: INPATIENT.deskId, statusAt: started } });
    await tx.admission.update({ where: { id: adm.id }, data: { invoiceId: inv.id } });
    await tx.location.update({ where: { id: bed.id }, data: { bedState: "occupied", bedNote: null } });
    await tx.bedAssignment.create({ data: { tenantId: LITE.tenant, organizationId: LITE.org, encounterId: enc.id, patientId: INPATIENT.patientId, bedId: bed.id, status: "occupied", transferId: randomUUID(), occupiedAt: started, occupiedById: INPATIENT.deskId } });
    // the signed ward round note with the order set
    const noteId = `cmp_${randomUUID()}`;
    const sections = { s: "Wound pain, no fever overnight", o: "Wound edges red, small discharge", a: "Surgical site infection, improving", p: "Continue IV antibiotics; dressing daily" };
    await tx.composition.create({ data: {
      id: noteId, tenantId: LITE.tenant, organizationId: LITE.org, branchId: LITE.branch, patientId: INPATIENT.patientId, encounterId: enc.id, kind: "progress-note", threadId: noteId,
      version: 1, status: "draft", sections: sections as object, sectionSources: {}, authorId: INPATIENT.doctorId, createdAt: started,
    } });
    for (const [i, o] of SEED_ORDERS.entries()) {
      const m = wardMedicine(o.medicineKey)!;
      const lineId = `mr_${randomUUID()}`;
      await tx.medicationRequest.create({ data: {
        id: lineId, tenantId: LITE.tenant, patientId: INPATIENT.patientId, encounterId: enc.id, compositionId: noteId, position: i, medicineKey: m.key, brand: m.brand, generic: m.generic,
        strength: m.strength, form: m.form, ingredients: m.ingredients, classes: m.classes, sample: true, dose: o.doseText, meal: "any", days: 1, quantity: 0,
        kind: "inpatient", route: o.route, doseText: o.doseText, doseQty: o.doseQty, times: o.times, prn: o.prn, prnMaxPer24h: o.prnMaxPer24h, startAt: started, regimenId: lineId,
      } });
    }
    await tx.composition.update({ where: { id: noteId }, data: { status: "final", signedAt: started, signedById: INPATIENT.doctorId } });
    await tx.provenance.create({ data: { tenantId: LITE.tenant, targetType: "Composition", targetId: noteId, activity: "sign", agentId: INPATIENT.doctorId, onBehalfOf: LITE.org, source: "provider_verified", recorded: started, detail: { seeded: true, kind: "progress-note", version: 1 } } });
    // ADR 0016: the day's intake / output so far (the prototype's entries) and two care plan tasks
    const at = (hAgo: number) => new Date(now.getTime() - hAgo * 3600_000);
    const io: [string, string, number, number][] = [["in", "iv", 500, 6], ["in", "oral", 150, 4], ["in", "oral", 200, 2], ["out", "urine", 400, 5], ["out", "drain", 80, 3], ["out", "urine", 350, 1]];
    for (const [side, route, ml, hAgo] of io) await tx.intakeOutputEntry.create({ data: { tenantId: LITE.tenant, organizationId: LITE.org, encounterId: enc.id, patientId: INPATIENT.patientId, side, route, ml, effectiveAt: at(hAgo), writtenById: "u_e2l_nurse", writtenAt: at(hAgo) } });
    const t1 = `ct_${randomUUID()}`, t2 = `ct_${randomUUID()}`;
    await tx.careTask.create({ data: { id: t1, seriesId: t1, tenantId: LITE.tenant, organizationId: LITE.org, encounterId: enc.id, patientId: INPATIENT.patientId, text: "RBS before each insulin dose", everyHours: 6, dueAt: at(-1), createdById: INPATIENT.doctorId, createdAt: started } });
    await tx.careTask.create({ data: { id: t2, seriesId: t2, tenantId: LITE.tenant, organizationId: LITE.org, encounterId: enc.id, patientId: INPATIENT.patientId, text: "Check the wound dressing and the drain", everyHours: null, dueAt: at(1), createdById: "u_e2l_nurse", createdAt: started } });
    return { encounterId: enc.id, admissionNumber: number };
  }, { timeout: 30_000 });
}
