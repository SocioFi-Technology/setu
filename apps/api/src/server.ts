import { buildApp } from "./app.js";
import { config } from "./config.js";
import { scheduleNightlyRollup } from "./routes/owner.js";

const app = await buildApp();
await app.listen({ port: config.port, host: "0.0.0.0" });
// staging (week 2): the PDF browser starts now, not inside the first print's transaction
{ const { warmPdfBrowser } = await import("./receipts/pdf.js"); warmPdfBrowser().then(() => app.log.info("pdf browser ready")).catch((e) => app.log.error({ err: e }, "pdf browser failed to start")); }
// ADR 0008: the owner dashboard's nightly rollup (00:30 Dhaka); not in tests (they import the app, not the server)
if (config.dbEnabled) scheduleNightlyRollup(app.log);
// ADR 0011 / 0012: the sweeps, every minute — payments (links never made, executes never answered) and SMS (queued too
// long → sent; sending too long → failed "it may have been sent", for a person to retry); ADR 0013: gateway refunds
// claimed and never answered are asked about (Refund Status) — never refunded again by the sweep
let sweeps: NodeJS.Timeout | undefined;
if (config.dbEnabled) {
  const { sweepPayments } = await import("./modules/billing.js");
  const { sweepSms } = await import("./modules/lab.js");
  const { sweepRefunds } = await import("./modules/refunds.js");
  const { sweepEscalations } = await import("./modules/ward.js");
  const { sweepBedDays } = await import("./modules/ipdBill.js");
  const { consentExpireDue } = await import("@setu/db");
  // staging (week 2): each sweep in one instance at a time (advisory lock), its run recorded for monitoring
  const { singleRun } = await import("./modules/jobs.js");
  const job = <T extends object>(name: string, run: () => Promise<T>, worth: (r: T) => unknown) =>
    singleRun(name, run, { summary: (r) => r }).then((x) => { if (x.ran && worth(x.result)) app.log.info({ job: name, result: x.result as object }, `${name} sweep`); }).catch((e) => app.log.error({ err: e, job: name }, `${name} sweep failed`));
  // One after another, never all at once: each holds a pooled connection for its lock while its own queries need
  // another, so five at once took a 5-connection pool (2 vCPU: Prisma's default) whole — every request stalled ~10 s
  // each minute and the sweeps failed ("Timed out fetching a new connection"; CI, 08/10/2026). A turn still running
  // when the next minute comes is not doubled.
  let turn = false;
  sweeps = setInterval(() => {
    if (turn) return;
    turn = true;
    void (async () => {
      await job("payments", () => sweepPayments(new Date()), (r) => r.failed || r.settled);
      await job("sms", () => sweepSms(new Date()), (r) => r.sent || r.interrupted);
      await job("refunds", () => sweepRefunds(new Date()), (r) => r.checked);
      // ADR 0017: the bed-day census (00:01 Dhaka), caught up every minute
      await job("bed-days", () => sweepBedDays(new Date()), (r) => r.posted);
      await job("escalations", () => sweepEscalations(new Date()), (r) => r.widened);
      // ADR 0021: patients' shares past their end → expired (reads check the end time themselves; this keeps the status true)
      await job("consents", async () => ({ expired: await consentExpireDue() }), (r) => r.expired);
    })().finally(() => { turn = false; });
  }, 60_000);
  sweeps.unref?.();
}
// staging (week 2): a rolling restart stops the old container with SIGTERM — no new sweeps, in-flight requests finish
// (app.close), then exit; the orchestrator's stop timeout (20 s in deploy.sh) is the backstop
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => {
  app.log.info({ signal: sig }, "shutting down");
  clearInterval(sweeps);
  app.close().then(() => process.exit(0), (e) => { app.log.error({ err: e }, "close failed"); process.exit(1); });
});
app.log.info(`Setu API on :${config.port} · db ${config.dbEnabled ? "enabled" : "disabled (set DATABASE_URL)"} · adapters ${JSON.stringify(config.adapters)}`);
