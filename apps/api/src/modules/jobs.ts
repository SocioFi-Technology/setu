/* Staging (week 2): every background job runs in exactly one API instance at a time. singleRun() takes a
   transaction-scoped advisory lock named after the job (held for the run, on one pooled connection); an instance that
   finds it held skips this turn. Each run is recorded in JobRun (start, finish, ok / error, a small summary) for
   monitoring — the job's age is "now − lastFinishedAt". Jobs: the payments, SMS, refunds, bed-day and escalation sweeps
   (every minute) and the nightly rollup (B7). */
export type JobResult<T> = { ran: false } | { ran: true; result: T };

export async function singleRun<T>(name: string, fn: () => Promise<T>, opts: { timeoutMs?: number; summary?: (r: T) => unknown } = {}): Promise<JobResult<T>> {
  const { prisma } = await import("@setu/db");
  const started = new Date();
  type Outcome = { ok: true; result: T } | { ok: false; error: unknown } | null;
  const o: Outcome = await prisma.$transaction(async (lock): Promise<Outcome> => {
    const [{ got }] = await lock.$queryRaw<{ got: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`job:${name}`})) AS got`;
    if (!got) return null;
    try { return { ok: true, result: await fn() }; } catch (e) { return { ok: false, error: e }; }
  }, { timeout: opts.timeoutMs ?? 300_000, maxWait: 10_000 });
  if (!o) {
    await prisma.jobRun.updateMany({ where: { name }, data: { skips: { increment: 1 } } }).catch(() => undefined);
    return { ran: false };
  }
  const finished = new Date();
  const detail = o.ok && opts.summary ? (opts.summary(o.result) as object) : undefined;
  const error = o.ok ? null : String((o.error as Error)?.message ?? o.error).slice(0, 500);
  await prisma.jobRun.upsert({
    where: { name },
    create: { name, lastStartedAt: started, lastFinishedAt: finished, lastOk: o.ok, lastError: error, lastDetail: detail ?? undefined, runs: 1 },
    update: { lastStartedAt: started, lastFinishedAt: finished, lastOk: o.ok, lastError: error, lastDetail: detail ?? undefined, runs: { increment: 1 } },
  }).catch(() => undefined);
  if (!o.ok) throw o.error;
  return { ran: true, result: o.result };
}

/** Monitoring: each job's last run and its age in seconds (no patient data). */
export async function jobAges(now = new Date()) {
  const { prisma } = await import("@setu/db");
  const rows = await prisma.jobRun.findMany({ orderBy: { name: "asc" } });
  return rows.map((r) => ({ name: r.name, lastFinishedAt: r.lastFinishedAt.toISOString(), ageSeconds: Math.round((now.getTime() - r.lastFinishedAt.getTime()) / 1000), lastOk: r.lastOk, lastError: r.lastError, runs: r.runs, skips: r.skips }));
}

/* Staging (week 2, session 2): the job-age alarm. Every job the server schedules, with the age past which it counts as
   stuck: the sweeps run every minute (10 minutes = nine missed turns), the nightly rollup and the host's backup once a
   day (26 hours). A job
   never recorded counts only once the server has been up longer than its limit (a fresh deploy is not an alarm). */
export const JOB_LIMITS_SECONDS: Record<string, number> = {
  payments: 600, sms: 600, refunds: 600, "bed-days": 600, escalations: 600, "nightly-rollup": 26 * 3600,
  // the host's nightly backup (infra/staging/backup.sh records its run here, ok or not)
  backup: 26 * 3600,
};
export type JobProblem = { name: string; problem: "stale" | "failing" | "missing"; ageSeconds: number | null; lastError?: string | null };
export function jobProblems(rows: { name: string; lastFinishedAt: Date; lastOk: boolean; lastError: string | null }[], now: Date, upSeconds: number): JobProblem[] {
  const out: JobProblem[] = [];
  for (const [name, limit] of Object.entries(JOB_LIMITS_SECONDS)) {
    const r = rows.find((x) => x.name === name);
    if (!r) { if (upSeconds > limit) out.push({ name, problem: "missing", ageSeconds: null }); continue; }
    const age = Math.round((now.getTime() - r.lastFinishedAt.getTime()) / 1000);
    if (age > limit) out.push({ name, problem: "stale", ageSeconds: age });
    else if (!r.lastOk) out.push({ name, problem: "failing", ageSeconds: age, lastError: r.lastError });
  }
  return out;
}
