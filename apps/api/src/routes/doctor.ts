/* Doctor's inbox routes (slice A12–A13, ADR 0007). The screen is doc/inbox (access matrix: doctor, every plan); the
   service checks the role and that the item was sent to the signed-in doctor. One transaction per request under RLS;
   the acknowledgement takes an Idempotency-Key; the "report reviewed" SMS goes out after the commit (dispatchSms) and
   its new state is merged into the answer — a sending problem never turns the stored acknowledgement into an error. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AckRequest, InboxQuery, type AckResponse, type InboxView } from "@setu/contracts";
import { authorize } from "@setu/domain";
import { command, query } from "../command.js";
import { forbidden } from "../errors.js";
import { acknowledge, inboxView } from "../modules/doctor.js";
import { dispatchSms } from "../modules/lab.js";
import { requireSession } from "../plugins/session.js";

function requireScreen(req: FastifyRequest, mod: string, screen: string) {
  const s = requireSession(req);
  const d = authorize(s.role, s.plan, mod, screen);
  if (!d.allowed) throw forbidden(d.reason === "plan" ? "plan" : d.reason === "role" ? "role" : "unknown");
  return s;
}
const pid = z.object({ id: z.string().min(1).max(64) });

export async function doctorRoutes(app: FastifyInstance) {
  app.get("/v1/doctor/inbox", async (req): Promise<InboxView> => {
    requireScreen(req, "doc", "inbox");
    const { days } = InboxQuery.parse(req.query);
    return query(req, async (tx, s) => {
      const r = await inboxView(tx, s, days, new Date());
      return { body: r.view, audit: r.audit };
    });
  });

  app.post("/v1/doctor/inbox/:id/ack", { config: { ownTx: true } }, async (req, reply): Promise<AckResponse> => {
    const s = requireScreen(req, "doc", "inbox");
    const { id } = pid.parse(req.params);
    const body = AckRequest.parse(req.body ?? {});
    const out = await command(req, reply, async (tx, sess) => {
      const r = await acknowledge(tx, sess, id, body, new Date());
      return { status: 200, body: { item: r.item, dispatch: r.dispatch }, audit: r.audit };
    });
    if (!out.dispatch.length) return { item: out.item };
    const sent = await dispatchSms(s, out.dispatch, { ip: req.ip, route: req.routeOptions.url ?? "" }).catch((e) => { req.log.error(e); return new Map(); });
    const ack = out.item.acknowledged;
    const m = ack?.sms ? sent.get(ack.sms.id) : undefined;
    return { item: m && ack?.sms ? { ...out.item, acknowledged: { ...ack, sms: { ...ack.sms, status: m.status, lastError: m.lastError } } } : out.item };
  });
}
