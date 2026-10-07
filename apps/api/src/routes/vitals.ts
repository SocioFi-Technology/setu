/* Vitals routes (slice A4). The vitals station (fd/vitals: nurse, receptionist) records; the doctor's consultation
   screens read the same view (session 2). Each route runs in one transaction under RLS and audits what it reveals. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { VitalsBatchRequest, type VitalsBatchResponse, type VitalsView, type VitalsWorklist } from "@setu/contracts";
import { authorize } from "@setu/domain";
import { command, query } from "../command.js";
import { forbidden } from "../errors.js";
import { recordVitals, vitalsView, vitalsWorklist } from "../modules/vitals.js";
import { requireSession } from "../plugins/session.js";

function requireAny(req: FastifyRequest, ...screens: [string, string][]) {
  const s = requireSession(req);
  const d = screens.map(([m, x]) => authorize(s.role, s.plan, m, x));
  if (d.some((x) => x.allowed)) return s;
  throw forbidden(d.some((x) => x.reason === "role") ? "role" : (d[0]?.reason ?? "unknown"));
}

export async function vitalsRoutes(app: FastifyInstance) {
  app.get("/v1/vitals/worklist", async (req): Promise<VitalsWorklist> => {
    requireAny(req, ["fd", "vitals"]);
    return query(req, async (tx, s) => {
      const w = await vitalsWorklist(tx, s, new Date());
      return { body: w, audit: [{ action: "view", entity: "Encounter", detail: { purpose: "vitals-worklist", count: w.items.length, patientIds: w.items.map((i) => i.patient.id) } }] };
    });
  });

  app.get("/v1/encounters/:id/vitals", async (req): Promise<VitalsView> => {
    requireAny(req, ["fd", "vitals"], ["cons", "draft"]);
    const { id } = req.params as { id: string };
    return query(req, async (tx, s) => {
      const { previousBatches, ...v } = await vitalsView(tx, s, id);
      return { body: v, audit: [{ action: "view", entity: "Observation", entityId: v.current?.batchId, patientId: v.encounter.patient.id, detail: { purpose: "vitals", encounterId: id, previousBatches } }] };
    });
  });

  app.post("/v1/encounters/:id/vitals", { config: { ownTx: true } }, async (req, reply): Promise<VitalsBatchResponse> => {
    requireAny(req, ["fd", "vitals"]);
    const { id } = req.params as { id: string };
    const body = VitalsBatchRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await recordVitals(tx, s, id, body, new Date());
      const pid = r.encounter.patient.id;
      return {
        status: 201, body: { encounter: r.encounter, batch: r.batch },
        audit: [
          { action: "create", entity: "Observation", entityId: r.batch.batchId, patientId: pid, detail: { encounterId: id, count: r.batch.observations.length, outOfRange: r.assessment.outOfRange, critical: r.assessment.critical } },
          ...(r.from === "arrived" ? [{ action: "update", entity: "Encounter", entityId: id, patientId: pid, detail: { event: "triage", from: r.from, to: r.encounter.status } }] : []),
          ...r.audit,
        ],
      };
    });
  });
}
