-- Staging (week 2): each background job's last run, for monitoring (job age) — one row per job, no patient data,
-- no tenant (a job runs for every tenant). Written by the API after each run (modules/jobs.ts).
CREATE TABLE "JobRun" (
  "name" TEXT NOT NULL PRIMARY KEY,
  "lastStartedAt" TIMESTAMP(3) NOT NULL,
  "lastFinishedAt" TIMESTAMP(3) NOT NULL,
  "lastOk" BOOLEAN NOT NULL,
  "lastError" TEXT,
  "lastDetail" JSONB,
  "runs" INTEGER NOT NULL DEFAULT 0,
  "skips" INTEGER NOT NULL DEFAULT 0
);
