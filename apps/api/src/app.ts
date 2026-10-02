import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { auditPlugin } from "./plugins/audit.js";
import { idempotencyPlugin } from "./plugins/idempotency.js";
import { sessionPlugin } from "./plugins/session.js";
import { authRoutes } from "./routes/auth.js";
import { frontDeskRoutes } from "./routes/frontdesk.js";
import { metaRoutes } from "./routes/meta.js";

export async function buildApp() {
  /* Request logs never carry the query string: search terms are phone numbers and names (security review A1–A3). */
  const app = Fastify({ logger: process.env.NODE_ENV === "test" ? false : { serializers: { req: (r) => ({ method: r.method, url: (r.url ?? "").split("?")[0], id: r.id }) } } });
  await app.register(cors, { origin: [/^http:\/\/localhost:\d+$/], credentials: true });
  await app.register(cookie, { secret: config.sessionSecret });
  sessionPlugin(app);
  auditPlugin(app);
  idempotencyPlugin(app);

  app.setErrorHandler((e, req, reply) => {
    if (e instanceof HttpError) return reply.code(e.status).send(e.body);
    if (e instanceof ZodError) { const i = e.issues[0]; return reply.code(400).send({ code: "validation", message_bn: "তথ্য ঠিক করুন", message_en: i?.message ?? "Invalid input", field: i?.path.join(".") }); }
    req.log.error(e);
    return reply.code(500).send({ code: "internal", message_bn: "সার্ভারে সমস্যা হয়েছে", message_en: "Something went wrong" });
  });

  await app.register(metaRoutes);
  await app.register(authRoutes);
  await app.register(frontDeskRoutes);
  return app;
}
