/* Consultation routes (slice A5). Each route checks the screen it serves with `authorize` (access matrix: doctor), runs in
   one transaction under RLS (command/query) and audits what it reveals or changes. The care relationship (decision 28)
   and every state change go through @setu/domain via modules/consultation.ts. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { CatalogQuery, type AllergyOptions, type ConsultationView, type ConsultWorklist, type Icd11Search, type MedicineSearch, type TestList } from "@setu/contracts";
import { authorize } from "@setu/domain";
import { query } from "../command.js";
import { forbidden } from "../errors.js";
import { allergyOptions, consultationFor, consultWorklist, listTests, searchIcd, searchMedicines } from "../modules/consultation.js";
import { requireSession } from "../plugins/session.js";

function requireCons(req: FastifyRequest, screen = "draft") {
  const s = requireSession(req);
  const d = authorize(s.role, s.plan, "cons", screen);
  if (!d.allowed) throw forbidden(d.reason ?? "unknown");
  return s;
}

export async function consultationRoutes(app: FastifyInstance) {
  /* ── sample catalogues (no PHI) ── */
  app.get("/v1/catalog/icd11", async (req): Promise<Icd11Search> => {
    requireCons(req);
    const { q } = CatalogQuery.parse(req.query);
    return query(req, async (tx) => ({ body: { items: await searchIcd(tx, q) }, audit: [] }));
  });
  app.get("/v1/catalog/medicines", async (req): Promise<MedicineSearch> => {
    requireCons(req);
    const { q } = CatalogQuery.parse(req.query);
    return query(req, async (tx) => ({ body: { items: await searchMedicines(tx, q) }, audit: [] }));
  });
  app.get("/v1/catalog/tests", async (req): Promise<TestList> => {
    requireCons(req);
    return query(req, async (tx) => ({ body: { items: await listTests(tx) }, audit: [] }));
  });
  app.get("/v1/catalog/allergy-options", async (req): Promise<AllergyOptions> => {
    requireCons(req);
    return query(req, async (tx) => ({ body: await allergyOptions(tx), audit: [] }));
  });

  /* ── reads ── */
  app.get("/v1/consultations/worklist", async (req): Promise<ConsultWorklist> => {
    requireCons(req);
    return query(req, async (tx, s) => {
      const w = await consultWorklist(tx, s, new Date());
      return { body: w, audit: [{ action: "view", entity: "Encounter", detail: { purpose: "consult-worklist", count: w.items.length, patientIds: w.items.map((i) => i.patient.id) } }] };
    });
  });
  app.get("/v1/encounters/:id/consultation", async (req): Promise<ConsultationView> => {
    requireCons(req);
    const { id } = req.params as { id: string };
    return query(req, async (tx, s) => {
      const { e, view, revealed } = await consultationFor(tx, s, id);
      return { body: view, audit: [{ action: "view", entity: "Composition", patientId: e.patientId, detail: { encounterId: id, compositions: revealed, allergies: view.allergies.map((a) => a.id) } }] };
    });
  });
}
