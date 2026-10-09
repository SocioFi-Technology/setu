/* ADR 0022 — the portable lab order (Journey E1–E2). The only code that writes across facilities for an order:
   - the ordering facility: the order made when the doctor signs network tests; the desk's choice for the patient; the
     doctor's re-order of declined tests; the decline notice it receives (as its system actor);
   - the patient (app): the choice of a centre, written in the ordering facility's tenant after the person is checked;
   - the chosen centre: its decision, and — for the accepted tests — its own patient record (name, sex, age, phone), a
     visit, and a "network-order" note whose drafted tests are signed into its active orders (the normal path: its lab
     labels, worklist and bill take them).
   The rules are @setu/domain portable.ts; PortableOrder's row-level security lets each party see only its own. */
import { randomUUID } from "node:crypto";
import type { CentreDecisionRequest, CentreOffers, ChooseCentreRequest, PortableOrderView } from "@setu/contracts";
import { ENCOUNTER, ORDER, TESTS_SAMPLE, centreOffer, decideOrder, chooseCentreProblems, patientAgeYears, portableOrderNumber, reorderable, sortOffers, transition, type CentreCatalogue, type OrderState } from "@setu/domain";
import type { Tx } from "@setu/db";
import type { AuditEntry } from "../command.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { createVisit, registerPatient } from "./frontdesk.js";
import { deliverInApp, smsPhone, smsText } from "./lab.js";

type Order = Awaited<ReturnType<Tx["portableOrder"]["findFirstOrThrow"]>> & { items: Awaited<ReturnType<Tx["portableOrderItem"]["findMany"]>> };
const dash = <T extends string>(s: string) => s.replace(/_/g, "-") as T;
const under = <T extends string>(s: string) => s.replace(/-/g, "_") as T;
const notFound = () => err(404, "not_found", "পাওয়া যায়নি", "Not found");
const yymm = (d: Date) => d.toISOString().slice(2, 4) + d.toISOString().slice(5, 7);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/* ── the view (the tracker) ── */
export function portableView(o: Order, viewer: "origin" | "centre" | "patient", canDecideHere = false, bill: PortableOrderView["bill"] = null): PortableOrderView {
  const status = dash<OrderState>(o.status) as PortableOrderView["status"];
  const steps: PortableOrderView["steps"] = [{ step: "ordered", at: o.createdAt.toISOString(), by: o.doctorEn }];
  if (o.chosenAt) steps.push({ step: "centre-chosen", at: o.chosenAt.toISOString(), by: o.chosenByKind === "desk" ? "desk" : "patient" });
  if (o.decidedAt) steps.push({ step: "decided", at: o.decidedAt.toISOString(), by: o.decidedByName });
  // E3 (ADR 0023): the centre's sample, its released report, the ordering doctor's acknowledgement
  if (o.collectedAt) steps.push({ step: "collected", at: o.collectedAt.toISOString(), by: o.centreFacilityEn });
  if (o.releasedAt) steps.push({ step: "released", at: o.releasedAt.toISOString(), by: o.centreFacilityEn });
  if (o.receivedAt) steps.push({ step: "received", at: o.receivedAt.toISOString(), by: o.doctorEn });
  return {
    id: o.id, number: o.number, status, createdAt: o.createdAt.toISOString(),
    origin: { facilityEn: o.originFacilityEn, facilityBn: o.originFacilityBn, doctorEn: o.doctorEn, doctorBn: o.doctorBn },
    patient: { nameEn: o.patientNameEn, nameBn: o.patientNameBn, sex: o.patientSex, ageYears: o.patientAgeYears, phone: viewer === "patient" ? null : o.patientPhone },
    centre: o.centreOrganizationId ? { organizationId: o.centreOrganizationId, facilityEn: o.centreFacilityEn, facilityBn: o.centreFacilityBn, collection: (o.collection ?? "centre") as "centre" | "home" } : null,
    chosenBy: (o.chosenByKind as "patient" | "desk" | null) ?? null,
    items: o.items.map((i) => ({ id: i.id, testCode: i.testCode, nameEn: i.nameEn, nameBn: i.nameBn, status: i.status as "pending" | "accepted" | "declined", declineReason: i.declineReason, notOffered: i.notOffered, unitPaisa: i.unitPaisa, reorderedToId: i.reorderedToId })),
    reorderOfId: o.reorderOfId, steps, viewer,
    canChoose: viewer !== "centre" && status === "active",
    resultReady: o.releasedAt !== null, bill: viewer === "patient" ? bill : null, centreVisitId: viewer === "centre" ? o.centreEncounterId : null,
    canDecide: viewer === "centre" && status === "centre-chosen" && canDecideHere,
    reorderable: viewer === "origin" ? reorderable(o.items.map((i) => ({ id: i.id, status: i.status, reorderedToId: i.reorderedToId }))) : [],
  };
}
const load = (tx: Tx, id: string) => tx.portableOrder.findFirst({ where: { id }, include: { items: { orderBy: { id: "asc" } } } }) as Promise<Order | null>;

/* ── E1: the order, made when the doctor signs network tests ── */
/** in the signing transaction (the ordering facility): one portable order for the note's network tests, and the
    patient told (an SMS of the fixed template, and the app) */
export async function makeFromSign(tx: Tx, s: SessionData, e: { id: string; patientId: string }, compositionId: string, now: Date, reorderOfId: string | null = null, onlyServiceRequestIds?: string[]): Promise<{ order: Order | null; audit: AuditEntry[] }> {
  // the note's network tests; a re-order names its tests (an amended note may have placed them in earlier versions)
  const srs = await tx.serviceRequest.findMany({ where: { performer: "network", status: "active", patientId: e.patientId, ...(onlyServiceRequestIds ? { id: { in: onlyServiceRequestIds } } : { compositionId }) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  if (!srs.length) return { order: null, audit: [] };
  const { nextPortableNumber } = await import("@setu/db");
  const [p, org, doc] = await Promise.all([
    tx.patient.findFirstOrThrow({ where: { id: e.patientId } }),
    tx.organization.findFirstOrThrow({ where: { id: s.organizationId }, select: { name: true, nameBn: true } }),
    tx.user.findFirstOrThrow({ where: { id: s.userId }, select: { nameEn: true, nameBn: true } }),
  ]);
  const o = await tx.portableOrder.create({ data: {
    number: portableOrderNumber(yymm(now), await nextPortableNumber(tx)),
    originTenantId: s.tenantId, originOrganizationId: s.organizationId, originPatientId: p.id, originEncounterId: e.id, orderedById: s.userId,
    originFacilityEn: org.name, originFacilityBn: org.nameBn, doctorEn: doc.nameEn, doctorBn: doc.nameBn,
    patientNameEn: p.nameEn, patientNameBn: p.nameBn, patientSex: p.sex, patientPhone: p.phone ? `0${p.phone}` : null,
    patientAgeYears: patientAgeYears({ birthDate: p.birthDate?.toISOString().slice(0, 10) ?? null, approxAgeYears: p.approxAgeYears, approxAgeAt: p.approxAgeAt?.toISOString() ?? null }, now),
    status: "active", statusAt: now, reorderOfId,
    items: { create: srs.map((r) => ({ originServiceRequestId: r.id, testCode: r.testCode, nameEn: r.nameEn, nameBn: r.nameBn })) },
  }, include: { items: { orderBy: { id: "asc" } } } }) as Order;
  const audit: AuditEntry[] = [{ action: "create", entity: "PortableOrder", entityId: o.id, patientId: p.id, detail: { number: o.number, tests: srs.map((r) => r.testCode), reorderOf: reorderOfId } }];
  // the patient is told: the app, and an SMS of the fixed template (no test names) — sent by the SMS sweep
  await deliverInApp(tx, s, { patientId: p.id, encounterId: e.id }, { kind: "portable-order", channel: "patient_app", serviceRequestId: srs[0]!.id }, now);
  const to = smsPhone(p.phone);
  if (to) {
    const { templateKey, text } = await smsText(tx, s, "portable-order");
    const id = `com_${randomUUID()}`;
    await tx.communication.create({ data: { id, tenantId: s.tenantId, organizationId: s.organizationId, patientId: p.id, encounterId: e.id, kind: "portable-order", channel: "sms", toPhone: to, templateKey, text, serviceRequestId: srs[0]!.id, createdById: s.userId } });
    audit.push({ action: "create", entity: "Communication", entityId: id, patientId: p.id, detail: { kind: "portable-order", channel: "sms" } });
  }
  return { order: o, audit };
}

/* ── the centres and the choice ── */
const catalogueOf = (c: Awaited<ReturnType<typeof import("@setu/db")["networkCentres"]>>[number]): CentreCatalogue =>
  ({ organizationId: c.organizationId, nameEn: c.nameEn, tests: c.tests, homeCollection: c.homeCollection, homeCollectionFeePaisa: c.homeCollectionFeePaisa, turnaroundHours: c.turnaroundHours });
export async function offersFor(o: Order, sort: "price" | "turnaround", collection: "centre" | "home"): Promise<CentreOffers> {
  const { networkCentres } = await import("@setu/db");
  const centres = await networkCentres();
  const items = o.items.filter((i) => i.status === "pending").map((i) => ({ id: i.id, testCode: i.testCode }));
  const offers = sortOffers(centres.map((c) => centreOffer(items, catalogueOf(c), collection)), sort);
  return { orderId: o.id, sort, collection, centres: offers.map((x) => {
    const c = centres.find((y) => y.organizationId === x.organizationId)!;
    return { tenantId: c.tenantId, organizationId: c.organizationId, nameEn: c.nameEn, nameBn: c.nameBn, area: c.area, homeCollection: c.homeCollection, homeCollectionFeePaisa: c.homeCollectionFeePaisa, turnaroundHours: c.turnaroundHours,
      offered: x.offered, notOffered: x.notOffered, testsPaisa: x.testsPaisa, homeFeePaisa: x.homeFeePaisa, totalPaisa: x.totalPaisa };
  }) };
}
/** the choice — in the ordering facility's tenant (the patient's is checked before; the desk's is for the patient) */
export async function choose(tx: Tx, orderId: string, by: { kind: "patient"; personId: string } | { kind: "desk"; userId: string }, b: ChooseCentreRequest, now: Date): Promise<{ order: Order; audit: AuditEntry[] }> {
  await tx.$queryRaw`SELECT 1 FROM "PortableOrder" WHERE "id" = ${orderId} FOR UPDATE`;
  const o = await load(tx, orderId);
  if (!o) throw notFound();
  const { networkCentres } = await import("@setu/db");
  const c = (await networkCentres()).find((x) => x.organizationId === b.organizationId);
  if (!c) throw err(400, "centre", "এই কেন্দ্র সেতু নেটওয়ার্কে নেই", "This centre is not in the Setu network", { field: "organizationId" });
  const offer = centreOffer(o.items.map((i) => ({ id: i.id, testCode: i.testCode })), catalogueOf(c), b.collection);
  if (b.collection === "home" && !c.homeCollection) throw err(400, "no_home_collection", "এই কেন্দ্র বাড়ি থেকে নমুনা নেয় না", "This centre does not collect at home", { field: "collection" });
  const bad = chooseCentreProblems(dash<OrderState>(o.status), offer);
  if (bad.includes("not_waiting")) throw err(409, "not_waiting", "এই অর্ডারের কেন্দ্র আগেই বাছাই করা হয়েছে", "A centre was already chosen for this order");
  if (bad.includes("nothing_offered")) throw err(400, "nothing_offered", "এই কেন্দ্র এই পরীক্ষাগুলোর কোনোটিই করে না", "This centre offers none of these tests", { field: "organizationId" });
  const to = transition("order", ORDER, "active", "chooseCentre");
  for (const x of offer.offered) await tx.portableOrderItem.update({ where: { id: x.itemId }, data: { unitPaisa: x.unitPaisa } });
  await tx.portableOrder.update({ where: { id: o.id }, data: {
    status: under<"centre_chosen">(to), statusAt: now, centreTenantId: c.tenantId, centreOrganizationId: c.organizationId, centreFacilityEn: c.nameEn, centreFacilityBn: c.nameBn, homeFeePaisa: offer.homeFeePaisa,
    collection: b.collection, chosenAt: now, chosenByKind: by.kind, chosenBy: by.kind === "patient" ? `person:${by.personId}` : by.userId,
  } });
  return { order: (await load(tx, o.id))!, audit: [{ action: "update", entity: "PortableOrder", entityId: o.id, patientId: o.originPatientId,
    basis: by.kind === "patient" ? "patient" : undefined, detail: { event: "chooseCentre", centre: c.nameEn, collection: b.collection, by: by.kind, offered: offer.offered.length, notOffered: offer.notOffered.length, totalPaisa: offer.totalPaisa } }] };
}

/* ── E2: the chosen centre ── */
const LAB_ROLES = ["labTech", "pathologist", "admin", "owner"];
/** orders that chose this facility (RLS: the centre reads those only), newest first */
export async function centreQueue(tx: Tx, s: SessionData): Promise<Order[]> {
  return tx.portableOrder.findMany({ where: { centreTenantId: s.tenantId, centreOrganizationId: s.organizationId }, include: { items: { orderBy: { id: "asc" } } }, orderBy: { chosenAt: "desc" }, take: 50 }) as Promise<Order[]>;
}
export async function centreOrder(tx: Tx, s: SessionData, id: string): Promise<Order> {
  const o = await load(tx, id);
  if (!o || o.centreTenantId !== s.tenantId || o.centreOrganizationId !== s.organizationId) throw notFound();
  return o;
}
/** the centre's decision: validated by the domain; the accepted tests become this centre's own orders (its patient
    record with name, sex, age and phone; a visit; a network-order note signed by the deciding technologist) */
export async function decide(tx: Tx, s: SessionData, id: string, b: CentreDecisionRequest, now: Date): Promise<{ order: Order; audit: AuditEntry[]; declined: string[] }> {
  if (!LAB_ROLES.includes(s.role)) throw err(403, "forbidden", "এই কাজটি ল্যাবের", "The lab decides network orders", { reason: "role", canRequest: false });
  await tx.$queryRaw`SELECT 1 FROM "PortableOrder" WHERE "id" = ${id} FOR UPDATE`;
  const o = await centreOrder(tx, s, id);
  const d = decideOrder(dash<OrderState>(o.status), o.items.map((i) => ({ id: i.id, offered: i.unitPaisa !== null })), b.items);
  if (!d.ok) {
    if (d.problems.some((p) => p.code === "not_waiting")) throw err(409, "not_waiting", "এই অর্ডারের সিদ্ধান্ত আগেই নেওয়া হয়েছে", "This order was already decided");
    throw err(400, "validation", "প্রতিটি পরীক্ষা নিন বা কারণসহ (অন্তত ১০ অক্ষর) ফেরত দিন", "Accept each test or decline it with a reason (at least 10 characters)", { fields: d.problems.map((p) => ({ field: p.itemId ?? "items", code: p.code })) });
  }
  const audit: AuditEntry[] = [];
  const accepted = d.items.filter((x) => x.accept);
  let centrePatientId: string | null = null, centreEncounterId: string | null = null;
  const srByItem = new Map<string, string>();
  if (accepted.length) {
    // the centre's patient record: name, sex, age and phone only — marked with the order's number
    const p = await registerPatient(tx, s, { nameBn: o.patientNameBn, nameEn: o.patientNameEn ?? undefined, sex: o.patientSex as "female" | "male" | "other", dobMode: "age",
      ageYears: o.patientAgeYears !== null ? String(o.patientAgeYears) : undefined, phone: o.patientPhone ?? undefined }, now);
    await tx.patient.update({ where: { id: p.id }, data: { networkOrigin: o.number } });
    centrePatientId = p.id;
    const v = await createVisit(tx, s, p.id, "new", now);
    centreEncounterId = v.encounter.id;
    // a lab-only visit: nothing waits for a doctor here — started and finished at once (ENCOUNTER), so its bill can be made
    const started = transition("encounter", ENCOUNTER, "arrived", "start"), finished = transition("encounter", ENCOUNTER, started, "finish");
    await tx.encounter.update({ where: { id: centreEncounterId }, data: { status: under<"in_progress">(started), statusAt: now } });
    await tx.encounter.update({ where: { id: centreEncounterId }, data: { status: under<"finished">(finished), statusAt: now } });
    // ADR 0023 (Kamrul): the centre's record is the same person's — linked to them (the order proves it), so the result
    // reaches their history; one record per facility as for any claim
    const { personOfRecord } = await import("@setu/db");
    const personId = o.chosenBy?.startsWith("person:") ? o.chosenBy.slice(7) : await personOfRecord(o.originTenantId, o.originPatientId);
    if (personId) {
      const claim = await tx.patientClaim.findFirst({ where: { tenantId: s.tenantId, personId } });
      if (!claim) await tx.patientClaim.create({ data: { tenantId: s.tenantId, personId, status: "linked", method: "network-order", patientId: p.id, linkedAt: now, statusAt: now } });
      else if (claim.status !== "linked") await tx.patientClaim.update({ where: { id: claim.id }, data: { status: "linked", method: "network-order", patientId: p.id, linkedAt: now, statusAt: now, tries: 0, lockedUntil: null } });
      audit.push({ action: "claim", entity: "PatientClaim", patientId: p.id, detail: { method: "network-order", order: o.number, outcome: claim?.status === "linked" ? "already-linked" : "linked" } });
    }
    const enc = (await tx.encounter.findFirstOrThrow({ where: { id: centreEncounterId } }));
    // the network order as this centre's note: drafted tests, signed by the deciding technologist → active orders
    const note = await tx.composition.create({ data: {
      tenantId: s.tenantId, organizationId: s.organizationId, branchId: enc.branchId, patientId: p.id, encounterId: enc.id, kind: "network-order", version: 1,
      sections: { portableOrderId: o.id, number: o.number, orderedBy: { en: o.doctorEn, bn: o.doctorBn }, from: { en: o.originFacilityEn, bn: o.originFacilityBn } } as object, sectionSources: {} as object, authorId: s.userId,
    } });
    for (const x of accepted) {
      const item = o.items.find((i) => i.id === x.itemId)!;
      const t = TESTS_SAMPLE.find((y) => y.code === item.testCode);
      const sr = await tx.serviceRequest.create({ data: {
        tenantId: s.tenantId, organizationId: s.organizationId, branchId: enc.branchId, patientId: p.id, encounterId: enc.id, compositionId: note.id,
        testCode: item.testCode, nameEn: item.nameEn, nameBn: item.nameBn, group: t?.group ?? "lab", priority: "routine", note: o.number, orderedById: s.userId,
      } });
      srByItem.set(x.itemId, sr.id);
    }
    await tx.composition.update({ where: { id: note.id }, data: { status: "final", signedAt: now, signedById: s.userId } });
    await tx.serviceRequest.updateMany({ where: { compositionId: note.id, status: "draft" }, data: { status: under<"active">(transition("order", ORDER, "draft", "order")), orderedAt: now, statusAt: now } });
    audit.push({ action: "create", entity: "Patient", entityId: p.id, patientId: p.id, detail: { networkOrigin: o.number } },
      { action: "create", entity: "ServiceRequest", entityId: note.id, patientId: p.id, detail: { networkOrder: o.number, tests: accepted.map((x) => o.items.find((i) => i.id === x.itemId)!.testCode) } });
  }
  for (const x of d.items) await tx.portableOrderItem.update({ where: { id: x.itemId }, data: {
    status: x.accept ? "accepted" : "declined", declineReason: x.accept ? null : x.reason, notOffered: x.notOffered ?? false, centreServiceRequestId: srByItem.get(x.itemId) ?? null } });
  const me = await tx.user.findFirst({ where: { id: s.userId }, select: { nameEn: true } });
  await tx.portableOrder.update({ where: { id: o.id }, data: { status: under<"accepted">(d.status), statusAt: now, decidedAt: now, decidedById: s.userId, decidedByName: `${me?.nameEn ?? s.nameEn} · ${o.centreFacilityEn ?? ""}`, centrePatientId, centreEncounterId } });
  audit.push({ action: "update", entity: "PortableOrder", entityId: o.id, patientId: centrePatientId, detail: { event: "decide", number: o.number, status: d.status, accepted: accepted.length, declined: d.items.length - accepted.length } });
  return { order: (await load(tx, o.id))!, audit, declined: d.items.filter((x) => !x.accept).map((x) => x.itemId) };
}
/** after the centre's decision commits: the ordering doctor is told of each declined test (their inbox), the patient of
    the outcome (the app) — written in the ordering facility's tenant as its system actor */
export async function tellOriginIn(originTenantId: string, orderId: string, declined: string[], now: Date) {
  const { forTenant, systemActor } = await import("@setu/db");
  await forTenant(originTenantId, async (tx) => {
    const o = await load(tx, orderId);
    if (!o) return;
    const s = { tenantId: o.originTenantId, organizationId: o.originOrganizationId, userId: systemActor(o.originTenantId) } as SessionData;
    for (const itemId of declined) {
      const it = o.items.find((i) => i.id === itemId)!;
      await deliverInApp(tx, s, { patientId: o.originPatientId, encounterId: o.originEncounterId }, { kind: "portable-declined", channel: "doctor_inbox", recipientUserId: o.orderedById, serviceRequestId: it.originServiceRequestId }, now);
    }
    await deliverInApp(tx, s, { patientId: o.originPatientId, encounterId: o.originEncounterId }, { kind: "portable-decided", channel: "patient_app", serviceRequestId: o.items[0]!.originServiceRequestId }, now);
    await tx.auditEvent.create({ data: { tenantId: o.originTenantId, organizationId: o.originOrganizationId, userId: s.userId, action: "update", entity: "PortableOrder", entityId: o.id, patientId: o.originPatientId,
      detail: { event: "centre-decided", number: o.number, status: dash(o.status), declined: declined.length, centre: o.centreFacilityEn } as object } });
  }, { system: true });
}

/* ── re-ordering declined tests elsewhere (the ordering doctor) ── */
export async function reorder(tx: Tx, s: SessionData, id: string, now: Date): Promise<{ order: Order; audit: AuditEntry[] }> {
  if (s.role !== "doctor") throw err(403, "forbidden", "শুধু ডাক্তার আবার অর্ডার দিতে পারেন", "Only a doctor re-orders", { reason: "role", canRequest: false });
  await tx.$queryRaw`SELECT 1 FROM "PortableOrder" WHERE "id" = ${id} FOR UPDATE`;
  const o = await load(tx, id);
  if (!o || o.originTenantId !== s.tenantId || o.originOrganizationId !== s.organizationId) throw notFound();
  const ids = reorderable(o.items.map((i) => ({ id: i.id, status: i.status, reorderedToId: i.reorderedToId })));
  if (!ids.length) throw err(409, "nothing_to_reorder", "আবার অর্ডার দেওয়ার মতো কিছু নেই", "Nothing to re-order");
  const items = o.items.filter((i) => ids.includes(i.id));
  const srs = await tx.serviceRequest.findMany({ where: { id: { in: items.map((i) => i.originServiceRequestId) } }, select: { id: true, compositionId: true } });
  const made = await makeFromSign(tx, s, { id: o.originEncounterId, patientId: o.originPatientId }, srs[0]!.compositionId, now, o.id, srs.map((x) => x.id));
  if (!made.order) throw err(409, "nothing_to_reorder", "আবার অর্ডার দেওয়ার মতো কিছু নেই", "Nothing to re-order");
  for (const i of items) await tx.portableOrderItem.update({ where: { id: i.id }, data: { reorderedToId: made.order.id } });
  return { order: made.order, audit: [...made.audit, { action: "update", entity: "PortableOrder", entityId: o.id, patientId: o.originPatientId, detail: { event: "reorder", to: made.order.number, tests: items.map((i) => i.testCode) } }] };
}

/* ── the ordering facility's reads ── */
export async function originOrder(tx: Tx, s: SessionData, id: string): Promise<Order> {
  const o = await load(tx, id);
  if (!o || o.originTenantId !== s.tenantId) throw notFound();
  return o;
}
export const originOrdersOf = (tx: Tx, s: SessionData, patientId: string | null) =>
  tx.portableOrder.findMany({ where: { originTenantId: s.tenantId, originOrganizationId: s.organizationId, ...(patientId ? { originPatientId: patientId } : {}) }, include: { items: { orderBy: { id: "asc" } } }, orderBy: { createdAt: "desc" }, take: 50 }) as Promise<Order[]>;
export { load as loadPortable };

/* ── E3 (ADR 0023): results back ── */
/** after a lab write commits at a centre: a network-order visit records its progress on the order (collected; released
    with the current report), and a new or corrected release tells the ordering doctor (inbox) and the patient (app) —
    in the ordering facility, as its system actor. Anything else: nothing. */
export async function progressAfterLab(tenantId: string, encounterId: string, now: Date): Promise<void> {
  const { forTenant } = await import("@setu/db");
  const news = await forTenant(tenantId, async (tx) => {
    const note = await tx.composition.findFirst({ where: { encounterId, kind: "network-order" }, select: { sections: true } });
    const orderId = (note?.sections as { portableOrderId?: string } | null)?.portableOrderId;
    if (!orderId) return null;
    const o = await load(tx, orderId);
    if (!o || o.centreTenantId !== tenantId || !["accepted", "partially_accepted"].includes(o.status)) return null;
    const srIds = o.items.map((i) => i.centreServiceRequestId).filter((x): x is string => !!x);
    const collected = await tx.specimen.count({ where: { encounterId, status: { notIn: ["pending", "rejected"] }, orders: { some: { serviceRequestId: { in: srIds } } } } }) > 0;
    const report = await tx.diagnosticReport.findFirst({ where: { encounterId, supersededById: null }, orderBy: { version: "desc" }, select: { id: true, releasedAt: true } });
    const data: { collectedAt?: Date; releasedAt?: Date; resultReportId?: string } = {};
    if ((collected || report) && !o.collectedAt) data.collectedAt = now;
    if (report && !o.releasedAt) { data.releasedAt = report.releasedAt; data.resultReportId = report.id; }
    else if (report && o.resultReportId !== report.id) data.resultReportId = report.id;
    if (!Object.keys(data).length) return null;
    await tx.portableOrder.update({ where: { id: o.id }, data });
    return data.resultReportId ? { o, reportId: data.resultReportId, corrected: !!o.resultReportId } : null;
  }, { system: true });
  if (!news) return;
  await forTenant(news.o.originTenantId, async (tx) => {
    const o = news.o;
    const s = { tenantId: o.originTenantId, organizationId: o.originOrganizationId, userId: (await import("@setu/db")).systemActor(o.originTenantId) } as SessionData;
    const sr = o.items.find((i) => i.status === "accepted")?.originServiceRequestId ?? o.items[0]!.originServiceRequestId;
    await deliverInApp(tx, s, { patientId: o.originPatientId, encounterId: o.originEncounterId }, { kind: "portable-result", channel: "doctor_inbox", recipientUserId: o.orderedById, serviceRequestId: sr }, now);
    await deliverInApp(tx, s, { patientId: o.originPatientId, encounterId: o.originEncounterId }, { kind: "portable-result", channel: "patient_app", serviceRequestId: sr }, now);
    await tx.auditEvent.create({ data: { tenantId: o.originTenantId, organizationId: o.originOrganizationId, userId: s.userId, action: "update", entity: "PortableOrder", entityId: o.id, patientId: o.originPatientId,
      detail: { event: news.corrected ? "result-corrected" : "result-released", number: o.number, centre: o.centreFacilityEn } as object } });
  }, { system: true });
}

/** the centre's report for an order, read by the ordering facility through the order itself (only that report, only
    while the order names it) — audited at the centre too (basis portable-order) */
export async function orderReport(tx: Tx, s: SessionData, id: string) {
  const o = await originOrder(tx, s, id);
  if (!o.resultReportId || !o.centreTenantId || !o.centrePatientId) throw err(404, "no_result", "এখনো ফলাফল আসেনি", "No result yet");
  const { forTenant } = await import("@setu/db");
  const { reportIn } = await import("./records.js");
  const who = await tx.user.findFirst({ where: { id: s.userId }, select: { nameEn: true, nameBn: true } });
  const core = await forTenant(o.centreTenantId, async (c) => {
    const r = await reportIn(c, o.centrePatientId!, o.resultReportId!);
    await c.auditEvent.create({ data: { tenantId: o.centreTenantId!, userId: s.userId, role: s.role, action: "view", entity: "DiagnosticReport", entityId: o.resultReportId!, patientId: o.centrePatientId, basis: "portable-order",
      detail: { order: o.number, reader: { nameEn: who?.nameEn ?? s.nameEn, nameBn: who?.nameBn ?? s.nameBn, role: s.role, facilityEn: o.originFacilityEn, facilityBn: o.originFacilityBn }, readerTenantId: s.tenantId } as object } });
    return r;
  }, { system: true });
  return { order: o, report: core };
}

/** the ordering doctor acknowledged the result (their inbox): the order is received; the patient is told (the app) */
export async function receivedByDoctor(tx: Tx, s: SessionData, originServiceRequestId: string, now: Date): Promise<AuditEntry[]> {
  const item = await tx.portableOrderItem.findFirst({ where: { originServiceRequestId, order: { originTenantId: s.tenantId, releasedAt: { not: null }, receivedAt: null } }, include: { order: true }, orderBy: { id: "desc" } });
  if (!item) return [];
  const o = item.order;
  await tx.portableOrder.update({ where: { id: o.id }, data: { receivedAt: now, receivedById: s.userId } });
  await deliverInApp(tx, s, { patientId: o.originPatientId, encounterId: o.originEncounterId }, { kind: "portable-received", channel: "patient_app", serviceRequestId: originServiceRequestId }, now);
  return [{ action: "update", entity: "PortableOrder", entityId: o.id, patientId: o.originPatientId, detail: { event: "received", number: o.number } }];
}

/** the patient's view of the centre's bill (their linked record there): total, paid, the bKash link the centre sent */
export async function billFor(o: Order, personId: string): Promise<PortableOrderView["bill"]> {
  if (!o.centreTenantId || !o.centreEncounterId || !o.centrePatientId) return null;
  const { forTenant, personOfRecord } = await import("@setu/db");
  if ((await personOfRecord(o.centreTenantId, o.centrePatientId)) !== personId) return null;
  const { config } = await import("../config.js");
  return forTenant(o.centreTenantId, async (tx) => {
    const inv = await tx.invoice.findFirst({ where: { encounterId: o.centreEncounterId!, kind: "opd", status: { notIn: ["entered_in_error", "cancelled"] } }, orderBy: { createdAt: "desc" } });
    if (!inv) return { totalPaisa: o.items.reduce((a, i) => a + (i.status === "accepted" ? i.unitPaisa ?? 0 : 0), 0) + o.homeFeePaisa, paidPaisa: 0, status: "not-billed", homeFeePaisa: o.homeFeePaisa, payUrl: null };
    const link = await tx.payment.findFirst({ where: { invoiceId: inv.id, method: "bkash", status: { in: ["link_sent", "waiting_customer"] }, linkCode: { not: null } }, orderBy: { createdAt: "desc" } });
    return { totalPaisa: inv.totalPaisa, paidPaisa: inv.paidPaisa, status: inv.status, homeFeePaisa: o.homeFeePaisa, payUrl: link?.linkCode ? `${config.publicAppUrl}/p/${link.linkCode}` : null };
  }, { system: true });
}
