/* `pnpm db:reset-e2e`: puts the E2E Test Clinic's walkthrough family back to its seeded state (no links, seeded
   identity confidence, no open reviews) before a journey run. Touches only tenant t_e2e; never the demo clinic.
   Patients and visits the tests create stay in t_e2e, out of the demo clinic's queue. */
import { ALLERGY, ENCOUNTER, transition, type EncounterState } from "@setu/domain";
import { owner as db } from "./owner.ts";

const T = "t_e2e";
const FAMILY: Record<string, "verified" | "unverified" | "possible_duplicate"> = {
  e2e_p_rahima: "verified", e2e_p_karim: "verified", e2e_p_sumaiya: "verified", e2e_p_ayesha: "unverified", e2e_p_rbegum: "possible_duplicate",
};

const tenant = await db.tenant.findUnique({ where: { id: T } });
if (!tenant) { console.error("E2E Test Clinic not seeded — run `pnpm db:seed` first"); process.exit(1); }
for (const [id, identityConfidence] of Object.entries(FAMILY))
  await db.patient.updateMany({ where: { id, tenantId: T }, data: { linkedToId: null, identityConfidence } });
// Open reviews on the family are closed as rejected (requested → rejected is an APPROVAL transition).
const n = await db.task.updateMany({ where: { tenantId: T, kind: "patient-link-review", status: "requested", focusId: { in: Object.keys(FAMILY) } }, data: { status: "rejected", decisionNote: "e2e reset", decidedAt: new Date() } });
// Link-anyway overrides the desk undid in earlier runs (decision 49) are marked reviewed so they leave the admin queue.
const undone = (await db.task.findMany({ where: { tenantId: T, kind: "patient-link-review", status: "approved", decisionNote: "link-anyway" } }))
  .filter((t) => { const d = (t.detail ?? {}) as { undo?: unknown; review?: unknown }; return d.undo && !d.review; });
for (const t of undone)
  await db.task.update({ where: { id: t.id }, data: { detail: { ...(t.detail as object), review: { by: "e2e-reset", at: new Date().toISOString(), outcome: "undo-reviewed", reason: "e2e reset" } } } });

/* Slice A5 (Kamrul 02/10/2026: no purge, no safety trigger switched off, not even here). Nothing is deleted:
   - allergies the journeys or a hands-on test recorded on the family are marked entered-in-error (ADR 0004, the only
     change the database allows), and Rahima's two seeded allergies are recorded again if a run marked them in error;
   - visits left open by earlier runs are closed through ENCOUNTER: waiting / vitals done → cancel, with doctor →
     markError (a test leftover, not a real visit). Signed notes stay as they are; specs never depend on counts. */
const now = new Date();
const RESET_BY = "u_e2e_admin";
const SEEDED_ALLERGIES = ["e2e_al_rahima_pen", "e2e_al_rahima_sulfa"];
const family = Object.keys(FAMILY);
const extra = await db.allergyIntolerance.findMany({ where: { tenantId: T, status: "active", patientId: { in: family }, id: { notIn: SEEDED_ALLERGIES } } });
for (const a of extra) {
  const to = transition("allergy", ALLERGY, "active", "markError");
  await db.allergyIntolerance.update({ where: { id: a.id }, data: { status: to.replace(/-/g, "_") as "entered_in_error", errorReason: "e2e reset: allergy recorded by a test run", errorById: RESET_BY, errorAt: now } });
  await db.provenance.create({ data: { tenantId: T, targetType: "AllergyIntolerance", targetId: a.id, activity: "allergy-entered-in-error", agentId: RESET_BY, onBehalfOf: a.organizationId, recorded: now, source: "provider_verified", reason: "e2e reset", detail: { e2eReset: true } } });
}
let restored = 0;
for (const id of SEEDED_ALLERGIES) {
  const seeded = await db.allergyIntolerance.findUnique({ where: { id } });
  if (!seeded || seeded.status === "active") continue;
  if (await db.allergyIntolerance.count({ where: { tenantId: T, patientId: seeded.patientId, status: "active", kind: seeded.kind, key: seeded.key } })) continue;
  const { id: _id, status: _s, errorReason: _r, errorById: _b, errorAt: _a, recordedAt: _t, ...copy } = seeded;
  const a = await db.allergyIntolerance.create({ data: { ...copy, recordedAt: now } });
  await db.provenance.create({ data: { tenantId: T, targetType: "AllergyIntolerance", targetId: a.id, activity: "record-allergy", agentId: seeded.recordedById, onBehalfOf: seeded.organizationId, recorded: now, source: "provider_verified", detail: { e2eReset: true, restores: id } } });
  restored++;
}
const CLOSE: Record<string, "cancel" | "markError"> = { arrived: "cancel", triaged: "cancel", in_progress: "markError" };
const open = await db.encounter.findMany({ where: { tenantId: T, status: { in: ["arrived", "triaged", "in_progress"] } }, select: { id: true, status: true } });
for (const e of open) {
  const to = transition("encounter", ENCOUNTER, e.status.replace(/_/g, "-") as EncounterState, CLOSE[e.status]!).replace(/-/g, "_");
  await db.encounter.updateMany({ where: { id: e.id, status: e.status }, data: { status: to as "cancelled" | "entered_in_error", statusAt: now } });
}
await db.$disconnect();
console.log(`E2E Test Clinic reset: walkthrough family restored, ${n.count} open review(s) closed, ${undone.length} undone override(s) marked reviewed, ${extra.length} test allerg(ies) marked entered-in-error, ${restored} seeded allerg(ies) recorded again, ${open.length} leftover visit(s) closed`);
