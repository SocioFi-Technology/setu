/* Gap 10 (Kamrul 07/10/2026): a write the device queued offline is sent with the user it was queued under
   (x-setu-queued-by) and the device's signature over it (x-setu-queued-sig). The server — not only the client — sends
   it on only when that user is the one signed in (else 409 queued_by_other, nothing done) and the signature is this
   user's and device's (else 400 queued_forged, audited and flagged): a planted or copied entry never reaches a route. */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { err } from "../errors.js";
import { signatureOk } from "../modules/devicekeys.js";

export function queuedPlugin(app: FastifyInstance) {
  app.addHook("preHandler", async (req) => {
    const by = req.headers["x-setu-queued-by"];
    if (by === undefined) return;
    const s = req.session;
    if (!s) return; // the route answers 401 itself
    if (typeof by !== "string" || by !== s.userId)
      throw err(409, "queued_by_other", "এই লেখা অন্য ব্যবহারকারীর সেশনে জমা হয়েছিল — পাঠানো হয়নি", "This was queued under another user's session — not sent");
    const key = req.headers["idempotency-key"], sig = req.headers["x-setu-queued-sig"];
    if (typeof key !== "string" || typeof sig !== "string" || !signatureOk(s, req.method, req.url, key, sig)) {
      if (config.dbEnabled) {
        const { forTenant } = await import("@setu/db");
        await forTenant(s.tenantId, (tx) => tx.auditEvent.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, userId: s.userId, role: s.role, action: "device-queue-refused", entity: "Device", entityId: s.device ?? null, ip: req.ip,
          detail: { route: req.routeOptions.url, method: req.method, flag: "device-queue-refused" } as object } }), { userId: s.userId });
      }
      throw err(400, "queued_forged", "এই ডিভাইসে জমা লেখাটি যাচাই হয়নি — পাঠানো হয়নি", "This queued write could not be verified on this device — not sent");
    }
  });
}
