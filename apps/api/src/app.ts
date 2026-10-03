import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { TransitionError } from "@setu/domain";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { auditPlugin } from "./plugins/audit.js";
import { idempotencyPlugin } from "./plugins/idempotency.js";
import { sessionPlugin } from "./plugins/session.js";
import { authRoutes } from "./routes/auth.js";
import { billingRoutes } from "./routes/billing.js";
import { consultationRoutes } from "./routes/consultation.js";
import { frontDeskRoutes } from "./routes/frontdesk.js";
import { labRoutes } from "./routes/lab.js";
import { doctorRoutes } from "./routes/doctor.js";
import { documentRoutes } from "./routes/documents.js";
import { ownerRoutes } from "./routes/owner.js";
import { pharmacyRoutes } from "./routes/pharmacy.js";
import { purchasingRoutes } from "./routes/purchasing.js";
import { adminRoutes } from "./routes/admin.js";
import { metaRoutes } from "./routes/meta.js";
import { vitalsRoutes } from "./routes/vitals.js";

export async function buildApp() {
  /* Request logs never carry the query string: search terms are phone numbers and names (security review A1–A3). */
  const app = Fastify({ logger: process.env.NODE_ENV === "test" ? false : { serializers: { req: (r) => ({ method: r.method, url: (r.url ?? "").split("?")[0], id: r.id }) } } });
  await app.register(cors, { origin: [/^http:\/\/localhost:\d+$/], credentials: true });
  await app.register(cookie, { secret: config.sessionSecret });
  /* Only routes that opt in are limited (the public receipt check). */
  await app.register(rateLimit, { global: false });
  sessionPlugin(app);
  auditPlugin(app);
  idempotencyPlugin(app);

  app.setErrorHandler((e, req, reply) => {
    if (e instanceof HttpError) return reply.code(e.status).send(e.body);
    // A state machine refused the change (e.g. marking an allergy that is already entered-in-error): the caller asked
    // for something the current state does not allow — a conflict, never a 500, and never a widened table.
    if (e instanceof TransitionError) return reply.code(409).send({ code: "invalid_transition", message_bn: "এই অবস্থায় এটি করা যায় না", message_en: "Not possible in the current state", reason: `${e.machine}:${e.from}:${e.event}` });
    if (e instanceof ZodError) { const i = e.issues[0]; return reply.code(400).send({ code: "validation", message_bn: "তথ্য ঠিক করুন", message_en: i?.message ?? "Invalid input", field: i?.path.join(".") }); }
    // Fastify's own client errors (malformed or empty JSON body, unsupported media type, body too large) are the
    // caller's mistake: answer with their 4xx status in the usual error shape instead of a 500.
    const sc = (e as { statusCode?: number }).statusCode;
    if (typeof sc === "number" && sc >= 400 && sc < 500)
      return reply.code(sc).send({ code: "bad_request", message_bn: "অনুরোধটি ঠিক নেই", message_en: "The request could not be read" });
    req.log.error(e);
    return reply.code(500).send({ code: "internal", message_bn: "সার্ভারে সমস্যা হয়েছে", message_en: "Something went wrong" });
  });

  await app.register(metaRoutes);
  await app.register(authRoutes);
  await app.register(frontDeskRoutes);
  await app.register(vitalsRoutes);
  await app.register(consultationRoutes);
  await app.register(billingRoutes);
  await app.register(labRoutes);
  await app.register(pharmacyRoutes);
  await app.register(purchasingRoutes);
  await app.register(adminRoutes);
  await app.register(doctorRoutes);
  await app.register(documentRoutes);
  await app.register(ownerRoutes);
  return app;
}
