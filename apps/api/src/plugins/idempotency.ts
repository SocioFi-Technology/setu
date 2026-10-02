/* Every mutating route accepts Idempotency-Key; a replay returns the stored response (offline retries never double-post). */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

const memory = new Map<string, { statusCode: number; body: unknown }>();

export function idempotencyPlugin(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method) || !req.session) return;
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return;
    const id = `${req.session.tenantId}:${req.routeOptions.url}:${key}`;
    type Hit = { statusCode: number; response?: unknown; body?: unknown } | null;
    const hit: Hit = config.dbEnabled
      ? await (await import("@setu/db")).forTenant(req.session.tenantId, (tx) => tx.idempotencyKey.findUnique({ where: { tenantId_key_route: { tenantId: req.session!.tenantId, key, route: req.routeOptions.url ?? "" } } }))
      : memory.get(id) ?? null;
    if (hit) { reply.header("Idempotent-Replay", "true"); return reply.code(hit.statusCode).send(hit.response ?? hit.body); }
    (req as any).idemId = id; (req as any).idemKey = key;
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const id = (req as any).idemId as string | undefined;
    if (!id || reply.statusCode >= 500 || req.txManaged) return payload; // command() stores its key inside its own transaction
    const body = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (!config.dbEnabled) memory.set(id, { statusCode: reply.statusCode, body });
    else await (await import("@setu/db")).forTenant(req.session!.tenantId, (tx) => tx.idempotencyKey.create({ data: { tenantId: req.session!.tenantId, key: (req as any).idemKey, route: req.routeOptions.url ?? "", statusCode: reply.statusCode, response: body } }));
    return payload;
  });
}
