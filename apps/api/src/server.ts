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
if (config.dbEnabled) {
  const { sweepPayments } = await import("./modules/billing.js");
  const { sweepSms } = await import("./modules/lab.js");
  const { sweepRefunds } = await import("./modules/refunds.js");
  const { sweepEscalations } = await import("./modules/ward.js");
  const { sweepBedDays } = await import("./modules/ipdBill.js");
  // staging (week 2): each sweep in one instance at a time (advisory lock), its run recorded for monitoring
  const { singleRun } = await import("./modules/jobs.js");
  const job = <T extends object>(name: string, run: () => Promise<T>, worth: (r: T) => unknown) =>
    singleRun(name, run, { summary: (r) => r }).then((x) => { if (x.ran && worth(x.result)) app.log.info({ job: name, result: x.result as object }, `${name} sweep`); }).catch((e) => app.log.error({ err: e, job: name }, `${name} sweep failed`));
  const t = setInterval(() => {
    void job("payments", () => sweepPayments(new Date()), (r) => r.failed || r.settled);
    void job("sms", () => sweepSms(new Date()), (r) => r.sent || r.interrupted);
    void job("refunds", () => sweepRefunds(new Date()), (r) => r.checked);
    // ADR 0017: the bed-day census (00:01 Dhaka), caught up every minute
    void job("bed-days", () => sweepBedDays(new Date()), (r) => r.posted);
    void job("escalations", () => sweepEscalations(new Date()), (r) => r.widened);
  }, 60_000);
  t.unref?.();
}
app.log.info(`Setu API on :${config.port} · db ${config.dbEnabled ? "enabled" : "disabled (set DATABASE_URL)"} · adapters ${JSON.stringify(config.adapters)}`);
