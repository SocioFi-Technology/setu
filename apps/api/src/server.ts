import { buildApp } from "./app.js";
import { config } from "./config.js";
import { scheduleNightlyRollup } from "./routes/owner.js";

const app = await buildApp();
await app.listen({ port: config.port, host: "0.0.0.0" });
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
  const t = setInterval(() => {
    sweepPayments(new Date()).then((r) => { if (r.failed || r.settled) app.log.info(r, "payments sweep"); }).catch((e) => app.log.error({ err: e }, "payments sweep failed"));
    sweepSms(new Date()).then((r) => { if (r.sent || r.interrupted) app.log.info(r, "sms sweep"); }).catch((e) => app.log.error({ err: e }, "sms sweep failed"));
    sweepRefunds(new Date()).then((r) => { if (r.checked) app.log.info(r, "refunds sweep"); }).catch((e) => app.log.error({ err: e }, "refunds sweep failed"));
    // ADR 0017: the bed-day census (00:01 Dhaka), caught up every minute
    sweepBedDays(new Date()).then((r) => { if (r.posted) app.log.info(r, "bed-day sweep"); }).catch((e) => app.log.error({ err: e }, "bed-day sweep failed"));
    sweepEscalations(new Date()).then((r) => { if (r.widened) app.log.info(r, "escalation sweep"); }).catch((e) => app.log.error({ err: e }, "escalation sweep failed"));
  }, 60_000);
  t.unref?.();
}
app.log.info(`Setu API on :${config.port} · db ${config.dbEnabled ? "enabled" : "disabled (set DATABASE_URL)"} · adapters ${JSON.stringify(config.adapters)}`);
