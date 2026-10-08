import type { FastifyInstance } from "fastify";
import type { Health } from "@setu/contracts";
import { config } from "../config.js";
import { counters } from "../adapters/counters.js";
import { pdfWarming } from "../receipts/pdf.js";

export async function metaRoutes(app: FastifyInstance) {
  app.get("/health", async (): Promise<Health> => {
    let db: Health["db"] = "skipped";
    if (config.dbEnabled) {
      try { const { prisma } = await import("@setu/db"); await prisma.$queryRaw`SELECT 1`; db = "up"; } catch { db = "down"; }
    }
    return { ok: true, version: config.version, db, time: new Date().toISOString() };
  });
  /* Staging (week 2): monitoring — each background job's last run and its age (no patient data). */
  app.get("/health/jobs", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    if (!config.dbEnabled) return { jobs: [] };
    const { jobAges } = await import("../modules/jobs.js");
    return { jobs: await jobAges() };
  });
  /* Staging (week 2, session 2): for the uptime monitor's job-age check — 200 while every scheduled job ran recently and
     its last run was ok, 503 with the problems otherwise (job names and ages only). */
  app.get("/health/jobs/ok", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    if (!config.dbEnabled) return { ok: true, problems: [] };
    const { prisma } = await import("@setu/db");
    const { jobProblems, walArchiveProblem } = await import("../modules/jobs.js");
    const problems = jobProblems(await prisma.jobRun.findMany(), new Date(), process.uptime());
    const [arc] = await prisma.$queryRaw<{ mode: string; lastArchivedAt: Date | null; lastFailedAt: Date | null }[]>`
      SELECT current_setting('archive_mode') AS mode, last_archived_time AS "lastArchivedAt", last_failed_time AS "lastFailedAt" FROM pg_stat_archiver`;
    const wal = arc ? walArchiveProblem(arc, new Date(), process.uptime()) : null;
    if (wal) problems.push(wal);
    return reply.code(problems.length ? 503 : 200).send({ ok: !problems.length, problems });
  });
  /* Staging (week 2): ready to take traffic — the database and the counter store (Redis) both answer. 503 otherwise, so
     the orchestrator holds traffic (and a rolling restart waits) until it is. Says nothing else. */
  app.get("/ready", async (_req, reply) => {
    let db = !config.dbEnabled;
    if (config.dbEnabled) { try { const { prisma } = await import("@setu/db"); await prisma.$queryRaw`SELECT 1`; db = true; } catch { db = false; } }
    const redis = await counters().ping();
    const pdf = !pdfWarming(); // the server's PDF warm-up has finished (or never ran: tests)
    reply.header("cache-control", "no-store");
    return reply.code(db && redis && pdf ? 200 : 503).send({ ready: db && redis && pdf, db, redis, pdf });
  });
}
