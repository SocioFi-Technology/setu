/* Consultation service (slice A5). Runs inside command()/query(), so RLS scopes every read to the session's tenant;
   visits are also scoped to the session's facility and branch (encounterHere). Rules come from @setu/domain:
   - consultAccess (decision 28): only the visit's doctor (or any doctor while it is unassigned) opens it; opening as a
     doctor applies ENCOUNTER `start`; re-opening is a no-op;
   - signBlockers / rxWarnings: re-run here on the server's own data (medicine ingredients and classes copied from the
     catalogue at save time, active allergies read now) — the screen runs the same functions;
   - signDocument (ADR 0003): draft → final, or an amendment → amended while the old version is superseded in the same
     transaction. The PIN is checked inside that transaction. Nothing is "signed" until this commits. */
import type { AllergyView, CompositionView, ConsultationView, ConsultWorklist, RecordAllergyRequest, SaveDraftRequest, SignRequest } from "@setu/contracts";
import { RECENT_DONE } from "@setu/contracts";
import type { Tx } from "@setu/db";
import {
  ALLERGY, ALLERGY_CLASSES, DOCUMENT, ENCOUNTER, ORDER, aiSections, catalogMatch, consultAccess, dhakaDay, emptySections, rxQuantity, signBlockers,
  signDocument, transition, type AllergyFact, type EncounterState, type NoteSections, type RxLine, type SectionSources,
} from "@setu/domain";
import { aiDrafter, type AiContext } from "../adapters/ai.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { branchOf, criticalVisits, notFound } from "./frontdesk.js";
import { requirePin, requireUserPin } from "./pin.js";
import { encounterHere, toVitalsEncounter } from "./vitals.js";

const KIND = "consultation-note";
const dash = <T extends string>(s: string) => s.replace(/_/g, "-") as T;
/** the database spelling of a machine state (in-progress → in_progress): every status write is the transition's result */
const under = <T extends string>(s: string) => s.replace(/-/g, "_") as T;
type DbEnc = "planned" | "arrived" | "triaged" | "in_progress" | "finished" | "cancelled" | "entered_in_error";
type DbOrder = "draft" | "active" | "centre_chosen" | "accepted" | "partially_accepted" | "declined" | "in_progress" | "partially_complete" | "complete" | "revoked";
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
type DbDoc = "draft" | "queued" | "final" | "amended" | "superseded" | "entered_in_error";
const CURRENT: DbDoc[] = ["final", "amended"];
type Enc = Awaited<ReturnType<typeof encounterHere>>;
type Comp = NonNullable<Awaited<ReturnType<Tx["composition"]["findFirst"]>>>;
type AllergyRow = NonNullable<Awaited<ReturnType<Tx["allergyIntolerance"]["findFirst"]>>>;

export const noCareRelationship = () =>
  err(403, "no_care_relationship", "এই রোগীর সাথে আপনার চিকিৎসা-সম্পর্ক নেই", "No care relationship with this patient", { reason: "no-care-relationship", canRequest: false });
const stale = () => err(409, "stale", "অন্য কোথাও আগেই বদলানো হয়েছে — আবার খুলুন", "This was changed somewhere else first — reopen it");

/* ───── access ───── */
function access(e: Enc, s: SessionData) {
  const a = consultAccess(dash<EncounterState>(e.status), e.practitionerId, s.userId, s.role === "doctor");
  if (!a.allowed) {
    if (a.reason === "other-doctor") throw noCareRelationship();
    throw err(409, "encounter_closed", "এই ভিজিট বন্ধ", "This visit is closed");
  }
  return a;
}
/** A composition of a visit at this facility/branch that this doctor may work on. */
export async function compositionHere(tx: Tx, s: SessionData, id: string): Promise<{ c: Comp; e: Enc }> {
  const c = await tx.composition.findFirst({ where: { id, kind: KIND, organizationId: s.organizationId } });
  if (!c) throw notFound();
  const e = await encounterHere(tx, s, c.encounterId);
  access(e, s);
  return { c, e };
}
function requireAuthorOfDraft(c: Comp, s: SessionData) {
  if (s.role !== "doctor") throw noCareRelationship();
  if (c.status !== "draft") throw err(409, "not_draft", "স্বাক্ষরিত নোট বদলানো যায় না — সংশোধন করুন", "A signed note cannot be changed — amend it");
  if (c.authorId !== s.userId) throw noCareRelationship();
}

/* ───── views ───── */
async function people(tx: Tx, ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const rows = list.length ? await tx.user.findMany({ where: { id: { in: list } }, select: { id: true, nameBn: true, nameEn: true } }) : [];
  const m = new Map(rows.map((r) => [r.id, r]));
  return (id: string) => m.get(id) ?? { id, nameBn: "—", nameEn: "—" };
}

export async function toAllergyView(tx: Tx, rows: AllergyRow[]): Promise<AllergyView[]> {
  const who = await people(tx, rows.flatMap((r) => [r.recordedById, r.errorById]));
  return rows.map((r) => ({
    id: r.id, kind: r.kind, key: r.key, labelBn: r.labelBn, labelEn: r.labelEn, reaction: r.reaction, severity: r.severity,
    status: dash<"active">(r.status), recordedAt: r.recordedAt.toISOString(), recordedBy: who(r.recordedById), source: "provider-verified" as const,
    error: r.status === "entered_in_error" && r.errorReason && r.errorAt && r.errorById ? { reason: r.errorReason, at: r.errorAt.toISOString(), by: who(r.errorById) } : null,
  }));
}
const allergyRows = (tx: Tx, patientId: string) => tx.allergyIntolerance.findMany({ where: { patientId }, orderBy: [{ status: "asc" }, { recordedAt: "asc" }] });
export const toAllergyFact = (a: AllergyRow | AllergyView): AllergyFact =>
  ({ id: a.id, kind: a.kind, key: a.key, labelBn: a.labelBn, labelEn: a.labelEn, reaction: a.reaction, severity: a.severity });
export async function activeAllergyFacts(tx: Tx, patientId: string): Promise<AllergyFact[]> {
  return (await tx.allergyIntolerance.findMany({ where: { patientId, status: "active" } })).map(toAllergyFact);
}

async function toCompositionView(tx: Tx, c: Comp): Promise<CompositionView> {
  const [conditions, meds, chain] = await Promise.all([
    tx.condition.findMany({ where: { compositionId: c.id }, orderBy: { position: "asc" } }),
    tx.medicationRequest.findMany({ where: { compositionId: c.id }, orderBy: { position: "asc" } }),
    tx.composition.findMany({ where: { encounterId: c.encounterId, kind: KIND, version: { lte: c.version } }, select: { id: true, version: true } }),
  ]);
  const versionOf = new Map(chain.map((x) => [x.id, x.version]));
  // one save writes its orders together (same createdAt): the cuid keeps the order they were written in
  const orders = await tx.serviceRequest.findMany({ where: { compositionId: { in: chain.map((x) => x.id) } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const who = await people(tx, [c.authorId, c.signedById]);
  // a signed version shows the registration it was signed with (ADR 0010 review); a draft has no signer yet
  const reg = c.signerRegVerified !== null ? { regBody: c.signerRegBody, regNo: c.signerRegNo, regVerified: c.signerRegVerified }
    : c.signedById ? await tx.practitioner.findFirst({ where: { userId: c.signedById }, select: { regBody: true, regNo: true, regVerified: true } }) : null;
  return {
    id: c.id, version: c.version, status: dash<CompositionView["status"]>(c.status), rev: c.rev,
    amendsId: c.amendsId, supersededById: c.supersededById, amendReason: c.amendReason,
    sections: c.sections as unknown as NoteSections, sectionSources: c.sectionSources as SectionSources,
    diagnoses: conditions.map((d) => ({ code: d.code, labelBn: d.labelBn, labelEn: d.labelEn, codeVerification: d.codeVerification, verificationStatus: d.verificationStatus })),
    medications: meds.map((m) => ({ id: m.id, position: m.position, medicineKey: m.medicineKey, brand: m.brand, generic: m.generic, strength: m.strength, form: m.form, ingredients: m.ingredients, classes: m.classes, sample: m.sample, dose: m.dose, meal: m.meal, days: m.days, quantity: m.quantity, note: m.note, keepBoth: m.keepBoth, acks: m.acks })),
    orders: orders.map((o) => ({ id: o.id, testCode: o.testCode, nameEn: o.nameEn, nameBn: o.nameBn, group: o.group, priority: o.priority, status: dash<CompositionView["orders"][number]["status"]>(o.status), note: o.note, performer: o.performer as "in-house" | "network", placedInVersion: versionOf.get(o.compositionId) ?? c.version, placed: o.status !== "draft" })),
    author: who(c.authorId),
    signedAt: iso(c.signedAt),
    signedBy: c.signedById ? { ...who(c.signedById), regBody: reg?.regBody ?? null, regNo: reg?.regNo ?? null, regVerified: reg?.regVerified ?? false } : null,
    aiReviewed: c.aiReviewed, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(),
  };
}

/** The visit's note versions with the context the doctor needs. Returns ids revealed, for the view audit. */
export async function consultationView(tx: Tx, s: SessionData, e: Enc): Promise<{ view: ConsultationView; revealed: string[] }> {
  const comps = await tx.composition.findMany({ where: { encounterId: e.id, kind: KIND }, orderBy: { version: "asc" } });
  const current = comps.find((c) => CURRENT.includes(c.status as DbDoc)) ?? null;
  const draft = comps.find((c) => c.status === "draft") ?? null;
  const allergies = await toAllergyView(tx, await allergyRows(tx, e.patientId));
  // Earlier visits' current notes in this tenant (one patient record per tenant, decision 21; other tenants never — RLS).
  const earlier = await tx.composition.findMany({ where: { patientId: e.patientId, kind: KIND, status: { in: CURRENT }, encounterId: { not: e.id } }, orderBy: { signedAt: "desc" }, take: 10 });
  const last = earlier[0];
  const lastMeds = last ? await tx.medicationRequest.findMany({ where: { compositionId: last.id }, orderBy: { position: "asc" } }) : [];
  const pastConds = earlier.length ? await tx.condition.findMany({ where: { compositionId: { in: earlier.map((x) => x.id) } } }) : [];
  const signedAt = new Map(earlier.map((x) => [x.id, x.signedAt]));
  const seen = new Set<string>();
  const pastDiagnoses = pastConds
    .sort((a, b) => (signedAt.get(b.compositionId)?.getTime() ?? 0) - (signedAt.get(a.compositionId)?.getTime() ?? 0))
    .filter((d) => (seen.has(d.code) ? false : (seen.add(d.code), true)))
    .map((d) => ({ code: d.code, labelBn: d.labelBn, labelEn: d.labelEn, codeVerification: d.codeVerification, verificationStatus: d.verificationStatus, at: iso(signedAt.get(d.compositionId)) ?? "" }));
  const view: ConsultationView = {
    encounter: { ...toVitalsEncounter(e), practitionerId: e.practitionerId },
    readOnly: s.role !== "doctor",
    current: current ? await toCompositionView(tx, current) : null,
    draft: draft ? await toCompositionView(tx, draft) : null,
    history: comps.filter((c) => c.status !== "draft").map((c) => ({ id: c.id, version: c.version, status: dash<ConsultationView["history"][number]["status"]>(c.status), signedAt: iso(c.signedAt), amendReason: c.amendReason, supersededById: c.supersededById })),
    allergies,
    currentMedicines: last ? lastMeds.map((m) => ({ brand: m.brand, generic: m.generic, strength: m.strength, form: m.form, dose: m.dose, meal: m.meal, days: m.days, prescribedAt: iso(last.signedAt) ?? "" })) : [],
    pastDiagnoses,
    criticalVitals: (await criticalVisits(tx, [e.id])).has(e.id),
  };
  return { view, revealed: [...comps.map((c) => c.id), ...earlier.map((c) => c.id)] };
}

export async function consultationFor(tx: Tx, s: SessionData, encounterId: string) {
  const e = await encounterHere(tx, s, encounterId);
  access(e, s);
  return { e, ...(await consultationView(tx, s, e)) };
}

export async function consultWorklist(tx: Tx, s: SessionData, now: Date, all = false): Promise<ConsultWorklist> {
  const branch = await branchOf(tx, s);
  const day = dhakaDay(now);
  const here = { organizationId: s.organizationId, branchId: branch.id, tokenDay: day, class: "opd" as const };
  const active = await tx.encounter.findMany({
    where: { ...here, OR: [
      { status: { in: ["arrived", "triaged"] }, practitionerId: null },
      { status: { in: ["arrived", "triaged", "in_progress"] }, practitionerId: s.userId },
      { status: "in_progress", practitionerId: null },
    ] },
    include: { patient: true }, orderBy: { tokenNo: "asc" },
  });
  // this doctor's seen visits: the latest RECENT_DONE unless all (staging load check, ADR 0019); the count is complete
  const seenWhere = { ...here, status: "finished" as const, practitionerId: s.userId };
  const seen = await tx.encounter.findMany({ where: seenWhere, include: { patient: true }, orderBy: { statusAt: "desc" }, ...(all ? {} : { take: RECENT_DONE }) });
  const doneTotal = all ? seen.length : await tx.encounter.count({ where: seenWhere });
  const rows = [...active, ...seen].sort((a, b) => a.tokenNo - b.tokenNo);
  const ids = rows.map((r) => r.id);
  const critical = await criticalVisits(tx, ids);
  const comps = ids.length ? await tx.composition.findMany({ where: { encounterId: { in: ids }, kind: KIND }, select: { encounterId: true, status: true } }) : [];
  return {
    day, doneTotal,
    items: rows.map((e) => ({
      ...toVitalsEncounter(e as Enc), practitionerId: e.practitionerId, mine: e.practitionerId === s.userId, critical: critical.has(e.id),
      hasDraft: comps.some((c) => c.encounterId === e.id && c.status === "draft"),
      signed: comps.some((c) => c.encounterId === e.id && CURRENT.includes(c.status as DbDoc)),
    })),
  };
}

/* ───── catalogues (sample) ───── */
export async function searchIcd(tx: Tx, q: string) {
  const rows = await tx.icd11Code.findMany({ orderBy: { code: "asc" } });
  return rows.filter((c) => catalogMatch(q, c.code, c.bn, c.en, c.aliases)).slice(0, 5).map((c) => ({ code: c.code, bn: c.bn, en: c.en, verification: c.verification }));
}
const toMedicineItem = (m: NonNullable<Awaited<ReturnType<Tx["medicine"]["findFirst"]>>>) => ({
  key: m.key, brand: m.brand, brandBn: m.brandBn, generic: m.generic, strength: m.strength, form: m.form, manufacturer: m.manufacturer,
  ingredients: m.ingredients, classes: m.classes, defaults: { dose: m.defaultDose, meal: m.defaultMeal, days: m.defaultDays }, sample: m.sample,
});
export async function searchMedicines(tx: Tx, q: string) {
  // ADR 0015: injections and infusions for inpatient orders are not prescribed in OPD
  const rows = await tx.medicine.findMany({ where: { active: true, inpatientOnly: false }, orderBy: [{ brand: "asc" }, { strength: "asc" }] });
  return rows.filter((m) => catalogMatch(q, m.brand, m.brandBn, m.generic)).slice(0, 7).map(toMedicineItem);
}
export async function listTests(tx: Tx) {
  return (await tx.orderableTest.findMany({ where: { active: true }, orderBy: { id: "asc" } })).map((t) => ({ code: t.code, nameEn: t.nameEn, nameBn: t.nameBn, group: t.group as "lab" | "imaging" | "other" }));
}
async function ingredientKeys(tx: Tx) {
  return [...new Set((await tx.medicine.findMany({ where: { active: true }, select: { ingredients: true } })).flatMap((m) => m.ingredients))].sort();
}
export async function allergyOptions(tx: Tx) { return { classes: ALLERGY_CLASSES, ingredients: await ingredientKeys(tx) }; }

/* ───── open ───── */
/** Opening as a doctor: waiting / vitals done → with doctor (ENCOUNTER `start`), assigns the doctor, creates draft v1
    if the visit has no note yet. Re-opening changes nothing. Returns what changed, for the audit. */
export async function openConsultation(tx: Tx, s: SessionData, encounterId: string, now: Date) {
  const e = await encounterHere(tx, s, encounterId);
  const a = access(e, s);
  const changed: { started?: { from: EncounterState; to: EncounterState }; assigned?: boolean; draftId?: string } = {};
  if (!a.readOnly) {
    const from = dash<EncounterState>(e.status);
    if (a.event === "start") {
      const to = transition("encounter", ENCOUNTER, from, "start");
      const n = await tx.encounter.updateMany({ where: { id: e.id, status: e.status, OR: [{ practitionerId: null }, { practitionerId: s.userId }] }, data: { status: under<DbEnc>(to), statusAt: now, practitionerId: s.userId } });
      if (n.count === 1) { changed.started = { from, to }; changed.assigned = a.assign; }
      else {
        // Two opens at once (a double click; React's dev mode runs the effect twice): when this doctor's own open won,
        // this one is the ordinary re-open (a no-op). Anyone else's change is still a 409.
        const won = await encounterHere(tx, s, e.id);
        if (!(won.status === "in_progress" && won.practitionerId === s.userId)) throw stale();
      }
    } else if (a.assign) {
      const n = await tx.encounter.updateMany({ where: { id: e.id, status: e.status, practitionerId: null }, data: { practitionerId: s.userId } });
      if (n.count !== 1) throw stale();
      changed.assigned = true;
    }
    if (!(await tx.composition.count({ where: { encounterId: e.id, kind: KIND } }))) {
      const c = await tx.composition.create({ data: {
        tenantId: s.tenantId, organizationId: s.organizationId, branchId: e.branchId, patientId: e.patientId, encounterId: e.id, kind: KIND,
        version: 1, status: "draft", sections: emptySections() as object, sectionSources: {}, authorId: s.userId,
      } });
      changed.draftId = c.id;
    }
  }
  const after = await encounterHere(tx, s, e.id);
  return { e: after, changed, ...(await consultationView(tx, s, after)) };
}

/* ───── save draft ───── */
type FieldErr = { field: string; code: string };
const invalid = (fields: FieldErr[]) => err(400, "validation", "তথ্য ঠিক করুন", `${fields.length} item(s) need attention`, { field: fields[0]?.field, fields });

export async function saveDraft(tx: Tx, s: SessionData, id: string, body: SaveDraftRequest) {
  const { c, e } = await compositionHere(tx, s, id);
  requireAuthorOfDraft(c, s);
  if (body.rev !== c.rev) throw stale();
  const fields: FieldErr[] = [];

  const codes = body.diagnoses.map((d) => d.code);
  const icd = new Map((await tx.icd11Code.findMany({ where: { code: { in: codes } } })).map((x) => [x.code, x]));
  body.diagnoses.forEach((d, i) => { if (!icd.has(d.code)) fields.push({ field: `diagnoses.${i}`, code: "unknown_code" }); if (codes.indexOf(d.code) !== i) fields.push({ field: `diagnoses.${i}`, code: "duplicate" }); });

  const keys = body.medications.map((m) => m.medicineKey);
  const meds = new Map((await tx.medicine.findMany({ where: { key: { in: keys }, active: true } })).map((m) => [m.key, m]));
  body.medications.forEach((m, i) => { if (!meds.has(m.medicineKey)) fields.push({ field: `medications.${i}`, code: "unknown_medicine" }); });

  const tests = new Map((await tx.orderableTest.findMany({ where: { code: { in: body.orders.map((o) => o.testCode) }, active: true } })).map((t) => [t.code, t]));
  // Orders placed by an earlier version of this note stay; the same test cannot be ordered twice in one visit.
  const placed = new Set((await tx.serviceRequest.findMany({ where: { encounterId: e.id, compositionId: { not: c.id }, status: { not: "revoked" } }, select: { testCode: true } })).map((o) => o.testCode));
  const testCodes = body.orders.map((o) => o.testCode);
  body.orders.forEach((o, i) => {
    if (!tests.has(o.testCode)) fields.push({ field: `orders.${i}`, code: "unknown_test" });
    else if (placed.has(o.testCode) || testCodes.indexOf(o.testCode) !== i) fields.push({ field: `orders.${i}`, code: "already_ordered" });
  });
  if (fields.length) throw invalid(fields);

  // Rule 2: a section that took AI text stays ai-draft for this version until it is signed with "I reviewed".
  const stored = c.sectionSources as SectionSources;
  const sources: SectionSources = { ...body.sectionSources };
  for (const k of aiSections(stored)) sources[k] = "ai-draft";

  const n = await tx.composition.updateMany({ where: { id: c.id, status: "draft", rev: c.rev }, data: { rev: c.rev + 1, sections: body.sections as object, sectionSources: sources as object } });
  if (n.count !== 1) throw stale();
  const base = { tenantId: s.tenantId, patientId: e.patientId, encounterId: e.id, compositionId: c.id };
  await tx.condition.deleteMany({ where: { compositionId: c.id } });
  await tx.medicationRequest.deleteMany({ where: { compositionId: c.id } });
  await tx.serviceRequest.deleteMany({ where: { compositionId: c.id, status: "draft" } });
  await tx.condition.createMany({ data: body.diagnoses.map((d, i) => { const x = icd.get(d.code)!; return { ...base, position: i, code: x.code, codeVerification: x.verification, labelBn: x.bn, labelEn: x.en, verificationStatus: d.verificationStatus }; }) });
  await tx.medicationRequest.createMany({ data: body.medications.map((m, i) => {
    const x = meds.get(m.medicineKey)!;
    return { ...base, position: i, medicineKey: x.key, brand: x.brand, generic: x.generic, strength: x.strength, form: x.form, ingredients: x.ingredients, classes: x.classes, sample: x.sample,
      dose: m.dose, meal: m.meal, days: m.days, quantity: rxQuantity(m.dose, m.days), note: m.note || null, keepBoth: Boolean(m.keepBoth), acks: m.acks ?? [] };
  }) });
  await tx.serviceRequest.createMany({ data: body.orders.map((o) => { const t = tests.get(o.testCode)!; return {
    ...base, organizationId: s.organizationId, branchId: e.branchId, testCode: t.code, nameEn: t.nameEn, nameBn: t.nameBn, group: t.group, priority: o.priority, note: o.note || null, orderedById: s.userId,
    // ADR 0022: a network test — the patient chooses a network centre; this facility's lab and bill never take it
    performer: o.performer ?? "in-house",
  }; }) });
  const after = (await tx.composition.findFirst({ where: { id: c.id } }))!;
  return { e, composition: await toCompositionView(tx, after) };
}

/* ───── sign ───── */
const linesOf = (meds: Awaited<ReturnType<Tx["medicationRequest"]["findMany"]>>): RxLine[] =>
  meds.map((m) => ({ uid: m.id, medicine: { id: m.medicineKey, brand: m.brand, generic: m.generic, strength: m.strength, form: m.form, ingredients: m.ingredients, classes: m.classes }, dose: m.dose, meal: m.meal, days: m.days, keepBoth: m.keepBoth, acks: m.acks }));

export async function signComposition(tx: Tx, s: SessionData, id: string, body: SignRequest, now: Date) {
  const { c, e } = await compositionHere(tx, s, id);
  requireAuthorOfDraft(c, s);
  // The PIN is checked first, inside this transaction: a wrong PIN refuses everything (and counts as a try).
  await requireUserPin(tx, s.userId, body.pin);
  if (body.rev !== c.rev) throw stale(); // sign exactly the version the doctor saw

  const [conditions, meds, allergies] = await Promise.all([
    tx.condition.findMany({ where: { compositionId: c.id } }),
    tx.medicationRequest.findMany({ where: { compositionId: c.id }, orderBy: { position: "asc" } }),
    activeAllergyFacts(tx, e.patientId),
  ]);
  const sources = c.sectionSources as SectionSources;
  const isAmendment = Boolean(c.amendsId);
  const blockers = signBlockers({
    sections: c.sections as unknown as NoteSections, sources, diagnoses: conditions, lines: linesOf(meds), allergies,
    aiReviewed: body.aiReviewed, uncodedAllergiesChecked: body.uncodedAllergiesChecked, isAmendment, amendReason: c.amendReason,
  });
  if (blockers.length)
    throw err(422, "sign_blocked", `${blockers.length}টি সতর্কতা ঠিক করুন — স্বাক্ষর হয়নি`, `Resolve ${blockers.length} warning(s) — not signed`, { blockers: blockers as unknown as Record<string, unknown>[] });

  const to = signDocument({ status: dash(c.status), amendsId: c.amendsId, amendReason: c.amendReason });
  const audit: { action: string; entity: string; entityId?: string; patientId?: string | null; basis?: string; detail?: Record<string, unknown> }[] = [];
  // ADR 0003: supersede the version this one amends first (the one-current index allows only one current version).
  if (c.amendsId) {
    const v1 = await tx.composition.findFirst({ where: { id: c.amendsId } });
    if (!v1 || !CURRENT.includes(v1.status as DbDoc) || v1.supersededById) throw stale();
    const v1to = transition("document", DOCUMENT, dash(v1.status), "supersede");
    const n = await tx.composition.updateMany({ where: { id: v1.id, status: v1.status, supersededById: null }, data: { status: v1to as DbDoc, supersededById: c.id } });
    if (n.count !== 1) throw stale();
    audit.push({ action: "update", entity: "Composition", entityId: v1.id, detail: { event: "supersede", from: dash(v1.status), to: v1to, by: c.id } });
  }
  const signed = await tx.composition.updateMany({ where: { id: c.id, status: "draft", rev: c.rev }, data: {
    status: to as DbDoc, signedAt: now, signedById: s.userId, aiReviewed: body.aiReviewed && aiSections(sources).length > 0, uncodedAllergiesChecked: body.uncodedAllergiesChecked,
  } });
  if (signed.count !== 1) throw stale();
  audit.push({ action: "sign", entity: "Composition", entityId: c.id, detail: { version: c.version, from: "draft", to, amends: c.amendsId } });

  // This version's orders are placed: ORDER draft → active.
  const drafts = await tx.serviceRequest.findMany({ where: { compositionId: c.id, status: "draft" }, select: { id: true } });
  if (drafts.length) {
    const ordered = transition("order", ORDER, "draft", "order");
    await tx.serviceRequest.updateMany({ where: { compositionId: c.id, status: "draft" }, data: { status: under<DbOrder>(ordered), orderedAt: now, statusAt: now } });
    // ADR 0022: the version's network tests make one portable order; the patient chooses a network centre
    const { makeFromSign } = await import("./portable.js");
    audit.push(...(await makeFromSign(tx, s, { id: e.id, patientId: e.patientId }, c.id, now)).audit);
  }

  // Decision 31: signing the first version finishes the visit (ENCOUNTER finish), so the A6 bill attaches to it.
  let encounterEvent: { from: EncounterState; to: EncounterState } | null = null;
  const from = dash<EncounterState>(e.status);
  if (!isAmendment) {
    const encTo = transition("encounter", ENCOUNTER, from, "finish"); // only from with-doctor; anything else refuses the sign
    const n = await tx.encounter.updateMany({ where: { id: e.id, status: e.status }, data: { status: under<DbEnc>(encTo), statusAt: now } });
    if (n.count !== 1) throw stale();
    encounterEvent = { from, to: encTo };
    audit.push({ action: "update", entity: "Encounter", entityId: e.id, detail: { event: "finish", from, to: encTo } });
  }

  // Rule 2: Provenance for the note and each item, and for each AI section the doctor reviewed.
  const prov = (targetType: string, targetId: string, activity: string, source: "provider_verified" | "ai_draft", detail: Record<string, unknown> = {}) =>
    ({ tenantId: s.tenantId, targetType, targetId, activity, agentId: s.userId, onBehalfOf: s.organizationId, recorded: now, source, detail: { compositionId: c.id, version: c.version, ...detail } as object });
  const orderIds = drafts.map((o) => o.id);
  await tx.provenance.createMany({ data: [
    prov("Composition", c.id, c.amendsId ? "sign-amendment" : "sign", "provider_verified", { status: to }),
    ...conditions.map((x) => prov("Condition", x.id, "diagnose", "provider_verified", { code: x.code, codeVerification: x.codeVerification, verificationStatus: x.verificationStatus })),
    ...meds.map((x) => prov("MedicationRequest", x.id, "prescribe", "provider_verified", { medicineKey: x.medicineKey, sample: x.sample })),
    ...orderIds.map((oid) => prov("ServiceRequest", oid, "order", "provider_verified")),
    ...aiSections(sources).map((k) => prov("Composition", c.id, "ai-draft-reviewed", "ai_draft", { section: k, reviewedBy: s.userId })),
  ] });

  const after = await encounterHere(tx, s, e.id);
  return { e: after, to, encounterEvent, audit, ...(await consultationView(tx, s, after)) };
}

/* ───── amend ───── */
export async function amendComposition(tx: Tx, s: SessionData, id: string, reason: string) {
  const { c, e } = await compositionHere(tx, s, id);
  if (s.role !== "doctor") throw noCareRelationship();
  if (!CURRENT.includes(c.status as DbDoc) || c.supersededById) throw err(409, "not_current", "শুধু বর্তমান স্বাক্ষরিত সংস্করণ সংশোধন করা যায়", "Only the current signed version can be amended");
  if (await tx.composition.count({ where: { encounterId: c.encounterId, kind: KIND, status: "draft" } }))
    throw err(409, "amendment_open", "এই নোটের একটি সংশোধন খসড়া আগেই খোলা আছে", "An amendment draft is already open for this note");
  // v+1 starts as a copy of the signed version. Text the doctor reviewed and signed is now theirs (provider-verified).
  const v2 = await tx.composition.create({ data: {
    tenantId: s.tenantId, organizationId: c.organizationId, branchId: c.branchId, patientId: c.patientId, encounterId: c.encounterId, kind: KIND,
    version: c.version + 1, status: "draft", amendsId: c.id, amendReason: reason.trim(), sections: c.sections as object, sectionSources: {}, authorId: s.userId,
  } });
  const base = { tenantId: s.tenantId, patientId: c.patientId, encounterId: c.encounterId, compositionId: v2.id };
  const conds = await tx.condition.findMany({ where: { compositionId: c.id }, orderBy: { position: "asc" } });
  const meds = await tx.medicationRequest.findMany({ where: { compositionId: c.id }, orderBy: { position: "asc" } });
  await tx.condition.createMany({ data: conds.map(({ id: _id, createdAt: _c, compositionId: _p, ...x }) => ({ ...x, ...base })) });
  await tx.medicationRequest.createMany({ data: meds.map(({ id: _id, createdAt: _c, compositionId: _p, ...x }) => ({ ...x, ...base })) });
  return { e, draftId: v2.id, ...(await consultationView(tx, s, e)) };
}

/* ───── AI draft ───── */
export async function aiDraft(tx: Tx, s: SessionData, id: string, kind: "previsit" | "note", now: Date) {
  const { c, e } = await compositionHere(tx, s, id);
  requireAuthorOfDraft(c, s);
  const { view } = await consultationView(tx, s, e);
  const latest = await tx.observation.findFirst({ where: { encounterId: e.id, category: "vital-signs", status: { not: "entered_in_error" } }, orderBy: [{ effectiveAt: "desc" }] });
  const vitals = latest ? await tx.observation.findMany({ where: { batchId: latest.batchId }, orderBy: { code: "asc" } }) : [];
  const ctx: AiContext = {
    complaints: (c.sections as unknown as NoteSections).complaints,
    allergies: view.allergies.filter((a) => a.status === "active"),
    diagnoses: view.pastDiagnoses,
    medicines: view.currentMedicines,
    vitals: vitals.map((o) => ({ code: o.code, value: o.value, unit: o.unit })),
  };
  const ai = aiDrafter();
  if (!ai) throw err(404, "ai_off", "এই প্রতিষ্ঠানে এআই খসড়া চালু নেই", "AI drafting is not switched on here");
  const out = await ai.draft(kind, ctx);
  await tx.provenance.create({ data: { tenantId: s.tenantId, targetType: "Composition", targetId: c.id, activity: "ai-draft-generated", agentId: s.userId, onBehalfOf: s.organizationId, recorded: now, source: "ai_draft", detail: { kind, model: ai.model } } });
  return { e, c, model: ai.model, out };
}

/* ───── allergies (ADR 0004) ───── */
async function allergyVisit(tx: Tx, s: SessionData, encounterId: string, patientId: string) {
  if (s.role !== "doctor") throw noCareRelationship();
  const e = await encounterHere(tx, s, encounterId);
  access(e, s);
  if (e.patientId !== patientId) throw notFound();
  return e;
}

export async function recordAllergy(tx: Tx, s: SessionData, patientId: string, body: RecordAllergyRequest, now: Date) {
  const e = await allergyVisit(tx, s, body.encounterId, patientId);
  let key: string | null = null, labelBn: string, labelEn: string;
  if (body.kind === "class") {
    const c = ALLERGY_CLASSES.find((x) => x.key === body.key);
    if (!c) throw invalid([{ field: "key", code: "unknown_class" }]);
    key = c.key; labelBn = c.bn; labelEn = c.en;
  } else if (body.kind === "substance") {
    if (!body.key || !(await ingredientKeys(tx)).includes(body.key)) throw invalid([{ field: "key", code: "unknown_substance" }]);
    key = body.key; labelEn = body.key.charAt(0).toUpperCase() + body.key.slice(1); labelBn = labelEn; // no Bangla ingredient names yet (open question)
  } else {
    if (!body.text) throw invalid([{ field: "text", code: "required" }]);
    labelBn = body.text; labelEn = body.text;
  }
  const dup = key
    ? await tx.allergyIntolerance.findFirst({ where: { patientId, status: "active", kind: body.kind, key } })
    : await tx.allergyIntolerance.findFirst({ where: { patientId, status: "active", kind: "other", labelEn: { equals: labelEn, mode: "insensitive" } } });
  if (dup) throw err(409, "allergy_exists", "এই অ্যালার্জি আগেই লেখা আছে", "This allergy is already recorded", { existing: { id: dup.id } });
  const a = await tx.allergyIntolerance.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, patientId, encounterId: e.id, kind: body.kind, key, labelBn, labelEn,
    reaction: body.reaction || null, severity: body.severity, recordedById: s.userId, recordedAt: now,
  } });
  await tx.provenance.create({ data: { tenantId: s.tenantId, targetType: "AllergyIntolerance", targetId: a.id, activity: "record-allergy", agentId: s.userId, onBehalfOf: s.organizationId, recorded: now, source: "provider_verified", detail: { encounterId: e.id, kind: body.kind, key } } });
  return { allergy: (await toAllergyView(tx, [a]))[0]!, encounterId: e.id };
}

export async function markAllergyError(tx: Tx, s: SessionData, id: string, encounterId: string, reason: string, now: Date) {
  const a = await tx.allergyIntolerance.findFirst({ where: { id } });
  if (!a) throw notFound();
  await allergyVisit(tx, s, encounterId, a.patientId);
  const to = transition("allergy", ALLERGY, dash<"active">(a.status), "markError");
  const n = await tx.allergyIntolerance.updateMany({ where: { id, status: "active" }, data: { status: under<"active" | "entered_in_error">(to), errorReason: reason.trim(), errorById: s.userId, errorAt: now } });
  if (n.count !== 1) throw stale();
  await tx.provenance.create({ data: { tenantId: s.tenantId, targetType: "AllergyIntolerance", targetId: id, activity: "allergy-entered-in-error", agentId: s.userId, onBehalfOf: s.organizationId, recorded: now, source: "provider_verified", reason: reason.trim(), detail: { encounterId, to } } });
  const after = (await tx.allergyIntolerance.findFirst({ where: { id } }))!;
  return (await toAllergyView(tx, [after]))[0]!;
}
