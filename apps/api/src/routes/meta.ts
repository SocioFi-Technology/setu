import type { FastifyInstance } from "fastify";
import type { Health } from "@setu/contracts";
import { config } from "../config.js";

export async function metaRoutes(app: FastifyInstance) {
  app.get("/health", async (): Promise<Health> => {
    let db: Health["db"] = "skipped";
    if (config.dbEnabled) {
      try { const { prisma } = await import("@setu/db"); await prisma.$queryRaw`SELECT 1`; db = "up"; } catch { db = "down"; }
    }
    return { ok: true, version: config.version, db, time: new Date().toISOString() };
  });
}
