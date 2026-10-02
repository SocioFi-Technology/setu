/* Rule 5: every PHI-revealing request writes an AuditEvent. Routes mark themselves with `config.audit`.
   With the DB disabled (first run) events go to the log so the behaviour is visible. */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

export interface AuditMark { action: string; entity: string; entityId?: (req: any) => string | undefined; patientId?: (req: any) => string | undefined }
declare module "fastify" { interface FastifyContextConfig { audit?: AuditMark } }

export function auditPlugin(app: FastifyInstance) {
  app.addHook("onResponse", async (req, reply) => {
    const mark = req.routeOptions.config.audit;
    if (!mark || !req.session || reply.statusCode >= 400) return;
    const event = {
      tenantId: req.session.tenantId, userId: req.session.userId, role: req.session.role,
      action: mark.action, entity: mark.entity, entityId: mark.entityId?.(req), patientId: mark.patientId?.(req),
      ip: req.ip, detail: { route: req.routeOptions.url, method: req.method },
    };
    if (!config.dbEnabled) { req.log.info({ audit: event }, "audit"); return; }
    const { forTenant } = await import("@setu/db");
    await forTenant(event.tenantId, (tx) => tx.auditEvent.create({ data: event }));
  });
}
