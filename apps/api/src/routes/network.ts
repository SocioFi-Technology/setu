/* ADR 0021 — "Shared with you" (staff app, screen net/shared): a patient's records shared with this doctor or this
   facility's doctors, read only through the consent-checked read service (modules/network.ts). */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SharedList, SharedRecords, SharedReportView } from "@setu/contracts";
import { authorize } from "@setu/domain";
import { query } from "../command.js";
import { forbidden } from "../errors.js";
import { requireSession } from "../plugins/session.js";
import { sharedList, sharedPdf, sharedRecords, sharedReport } from "../modules/network.js";

function requireShared(req: FastifyRequest) {
  const s = requireSession(req);
  const d = authorize(s.role, s.plan, "net", "shared");
  if (!d.allowed) throw forbidden(d.reason ?? "role");
  return s;
}
const id = z.string().min(1).max(64);

export async function networkRoutes(app: FastifyInstance) {
  app.get("/v1/shared", async (req): Promise<SharedList> => { requireShared(req); return query(req, (tx, s) => sharedList(tx, s)); });
  app.get("/v1/shared/:consentId", async (req): Promise<SharedRecords> => {
    requireShared(req);
    const p = z.object({ consentId: id }).parse(req.params);
    return query(req, (tx, s) => sharedRecords(tx, s, p.consentId));
  });
  app.get("/v1/shared/:consentId/reports/:tenantId/:reportId", async (req): Promise<SharedReportView> => {
    requireShared(req);
    const p = z.object({ consentId: id, tenantId: id, reportId: id }).parse(req.params);
    return query(req, (tx, s) => sharedReport(tx, s, p.consentId, p.tenantId, p.reportId));
  });
  app.get("/v1/shared/:consentId/documents/:tenantId/:kind/:docId/pdf", async (req, reply) => {
    requireShared(req);
    const p = z.object({ consentId: id, tenantId: id, kind: z.enum(["lr", "rx", "ds"]), docId: id }).parse(req.params);
    const lang = (req.query as { lang?: string }).lang === "en" ? "en" : "bn";
    const bytes = await query(req, (tx, s) => sharedPdf(tx, s, p.consentId, p.tenantId, p.kind, p.docId, lang));
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="shared-${p.kind}.pdf"`).header("cache-control", "no-store").send(Buffer.from(bytes));
  });
}
