/* Consultation routes (slice A5). Each route checks the screen it serves with `authorize` (access matrix: doctor), runs in
   one transaction under RLS (command/query) and audits what it reveals or changes. The care relationship (decision 28)
   and every state change go through @setu/domain via modules/consultation.ts. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  AiDraftRequest, AmendRequest, CatalogQuery, MarkAllergyErrorRequest, RecordAllergyRequest, SaveDraftRequest, SignRequest,
  type AiDraftResponse, type AllergyOptions, type AllergyView, type CompositionView, type ConsultationView, type ConsultWorklist, type Icd11Search, type MedicineSearch, type TestList,
} from "@setu/contracts";
import { authorize } from "@setu/domain";
import { command, query } from "../command.js";
import { forbidden } from "../errors.js";
import {
  aiDraft, allergyOptions, amendComposition, consultationFor, consultWorklist, listTests, markAllergyError, openConsultation, recordAllergy, saveDraft,
  searchIcd, searchMedicines, signComposition,
} from "../modules/consultation.js";
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
      const w = await consultWorklist(tx, s, new Date(), (req.query as { all?: string }).all === "1");
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

  /* ── writes (Idempotency-Key required) ── */
  app.post("/v1/encounters/:id/consultation/open", { config: { ownTx: true } }, async (req, reply): Promise<ConsultationView> => {
    requireCons(req);
    const { id } = req.params as { id: string };
    return command(req, reply, async (tx, s) => {
      const r = await openConsultation(tx, s, id, new Date());
      const pid = r.e.patientId;
      return { body: r.view, audit: [
        { action: "view", entity: "Composition", patientId: pid, detail: { encounterId: id, compositions: r.revealed, allergies: r.view.allergies.map((a) => a.id) } },
        ...(r.changed.started || r.changed.assigned ? [{ action: "update", entity: "Encounter", entityId: id, patientId: pid, detail: { event: r.changed.started ? "start" : "assign", ...r.changed.started, assigned: r.changed.assigned ?? false } }] : []),
        ...(r.changed.draftId ? [{ action: "create", entity: "Composition", entityId: r.changed.draftId, patientId: pid, detail: { encounterId: id, version: 1 } }] : []),
      ] };
    });
  });

  app.put("/v1/compositions/:id", { config: { ownTx: true } }, async (req, reply): Promise<CompositionView> => {
    requireCons(req);
    const { id } = req.params as { id: string };
    const body = SaveDraftRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await saveDraft(tx, s, id, body);
      return { body: r.composition, audit: [{ action: "update", entity: "Composition", entityId: id, patientId: r.e.patientId, detail: { rev: r.composition.rev, diagnoses: body.diagnoses.length, medications: body.medications.length, orders: body.orders.length } }] };
    });
  });

  app.post("/v1/compositions/:id/sign", { config: { ownTx: true } }, async (req, reply): Promise<ConsultationView> => {
    requireCons(req);
    const { id } = req.params as { id: string };
    const body = SignRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await signComposition(tx, s, id, body, new Date());
      return { body: r.view, audit: r.audit.map((a) => ({ ...a, patientId: r.e.patientId })) };
    }, { hashOmit: ["pin"] });
  });

  app.post("/v1/compositions/:id/amend", { config: { ownTx: true } }, async (req, reply): Promise<ConsultationView> => {
    requireCons(req, "amended");
    const { id } = req.params as { id: string };
    const { reason } = AmendRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await amendComposition(tx, s, id, reason);
      return { status: 201, body: r.view, audit: [{ action: "create", entity: "Composition", entityId: r.draftId, patientId: r.e.patientId, detail: { amends: id, reason } }] };
    });
  });

  app.post("/v1/compositions/:id/ai-draft", { config: { ownTx: true } }, async (req, reply): Promise<AiDraftResponse> => {
    requireCons(req);
    const { id } = req.params as { id: string };
    const { kind } = AiDraftRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await aiDraft(tx, s, id, kind, new Date());
      return {
        body: { kind, label: "draft-not-a-diagnosis", model: r.model, summary: r.out.summary, proposals: r.out.proposals },
        audit: [{ action: "create", entity: "AiDraft", entityId: id, patientId: r.e.patientId, detail: { kind, model: r.model } }],
      };
    });
  });

  app.post("/v1/patients/:id/allergies", { config: { ownTx: true } }, async (req, reply): Promise<AllergyView> => {
    requireCons(req);
    const { id } = req.params as { id: string };
    const body = RecordAllergyRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await recordAllergy(tx, s, id, body, new Date());
      return { status: 201, body: r.allergy, audit: [{ action: "create", entity: "AllergyIntolerance", entityId: r.allergy.id, patientId: id, detail: { encounterId: r.encounterId, kind: body.kind, key: r.allergy.key, severity: body.severity } }] };
    });
  });

  app.post("/v1/allergies/:id/entered-in-error", { config: { ownTx: true } }, async (req, reply): Promise<AllergyView> => {
    requireCons(req);
    const { id } = req.params as { id: string };
    const { encounterId, reason } = MarkAllergyErrorRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const a = await markAllergyError(tx, s, id, encounterId, reason, new Date());
      const pid = (await tx.allergyIntolerance.findFirst({ where: { id }, select: { patientId: true } }))!.patientId;
      return { body: a, audit: [{ action: "update", entity: "AllergyIntolerance", entityId: id, patientId: pid, detail: { event: "markError", encounterId, reason } }] };
    });
  });
}
