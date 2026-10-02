/* `pnpm db:reset-e2e`: puts the E2E Test Clinic's walkthrough family back to its seeded state (no links, seeded
   identity confidence, no open reviews) before a journey run. Touches only tenant t_e2e; never the demo clinic.
   Patients and visits the tests create stay in t_e2e, out of the demo clinic's queue. */
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
await db.$disconnect();
console.log(`E2E Test Clinic reset: walkthrough family restored, ${n.count} open review(s) closed`);
