/* Staging (week 2): a background job runs in one API instance at a time, and each run is recorded for monitoring. */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";

const db = config.dbEnabled ? await import("@setu/db") : null;
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app?.close(); });

describe.runIf(db)("single-instance jobs (staging)", () => {
  it("two instances at once: one runs, the other skips; the run is recorded with its summary", async () => {
    const { singleRun } = await import("../src/modules/jobs.js");
    const name = `test-${randomBytes(3).toString("hex")}`;
    let runs = 0;
    const work = () => singleRun(name, async () => { runs++; await new Promise((r) => setTimeout(r, 400)); return { posted: 3 }; }, { summary: (r) => r });
    expect((await work()).ran).toBe(true); // the job's first run (its row; a skip is counted on the row)
    const [a, b] = await Promise.all([work(), work()]);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
    expect(runs).toBe(2);
    const row = await db!.prisma.jobRun.findUnique({ where: { name } });
    expect(row).toMatchObject({ lastOk: true, lastError: null, runs: 2, skips: 1, lastDetail: { posted: 3 } });
    expect(row!.lastFinishedAt.getTime()).toBeGreaterThanOrEqual(row!.lastStartedAt.getTime() + 350);
    // once the first is done the next turn runs again
    expect((await work()).ran).toBe(true);
    await db!.prisma.jobRun.delete({ where: { name } });
  });
  it("a failing run is recorded (not ok, the error) and the error still reaches the caller", async () => {
    const { singleRun } = await import("../src/modules/jobs.js");
    const name = `test-${randomBytes(3).toString("hex")}`;
    await expect(singleRun(name, async () => { throw new Error("gateway down"); })).rejects.toThrow("gateway down");
    expect(await db!.prisma.jobRun.findUnique({ where: { name } })).toMatchObject({ lastOk: false, lastError: "gateway down", runs: 1 });
    await db!.prisma.jobRun.delete({ where: { name } });
  });
  it("/health/jobs lists each job's age for monitoring — no session, no patient data", async () => {
    const { singleRun } = await import("../src/modules/jobs.js");
    const name = `test-${randomBytes(3).toString("hex")}`;
    await singleRun(name, async () => ({ ok: 1 }));
    const r = await app.inject({ method: "GET", url: "/health/jobs" });
    expect(r.statusCode).toBe(200);
    const j = r.json().jobs.find((x: { name: string }) => x.name === name);
    expect(j).toMatchObject({ lastOk: true, runs: 1 });
    expect(j.ageSeconds).toBeLessThan(10);
    await db!.prisma.jobRun.delete({ where: { name } });
  });
  it("the job-age check: stale past its limit, failing on a bad last run, missing only once the server has been up that long", async () => {
    const { jobProblems, JOB_LIMITS_SECONDS } = await import("../src/modules/jobs.js");
    const now = new Date("2026-10-08T12:00:00Z");
    const ago = (s: number) => new Date(now.getTime() - s * 1000);
    const fresh = Object.keys(JOB_LIMITS_SECONDS).map((name) => ({ name, lastFinishedAt: ago(30), lastOk: true, lastError: null }));
    expect(jobProblems(fresh, now, 99_999)).toEqual([]);
    const rows = fresh.map((r) => r.name === "sms" ? { ...r, lastFinishedAt: ago(601) } : r.name === "refunds" ? { ...r, lastOk: false, lastError: "boom" } : r);
    expect(jobProblems(rows, now, 99_999)).toEqual([
      { name: "sms", problem: "stale", ageSeconds: 601 },
      { name: "refunds", problem: "failing", ageSeconds: 30, lastError: "boom" },
    ]);
    // the nightly rollup: 25 h old is fine, 27 h is stale
    expect(jobProblems(fresh.map((r) => r.name === "nightly-rollup" ? { ...r, lastFinishedAt: ago(25 * 3600) } : r), now, 99_999)).toEqual([]);
    expect(jobProblems(fresh.map((r) => r.name === "nightly-rollup" ? { ...r, lastFinishedAt: ago(27 * 3600) } : r), now, 99_999)[0]).toMatchObject({ name: "nightly-rollup", problem: "stale" });
    // never recorded: no alarm right after a deploy, an alarm once the server has been up past the limit
    const noRollup = fresh.filter((r) => r.name !== "nightly-rollup");
    expect(jobProblems(noRollup, now, 3600)).toEqual([]);
    expect(jobProblems(noRollup, now, 27 * 3600)).toEqual([{ name: "nightly-rollup", problem: "missing", ageSeconds: null }]);
  });
  it("/health/jobs/ok answers the monitor: 200 or 503 with the problems, names and ages only", async () => {
    const r = await app.inject({ method: "GET", url: "/health/jobs/ok" });
    expect([200, 503]).toContain(r.statusCode);
    expect(r.json()).toHaveProperty("ok", r.statusCode === 200);
  });
});
