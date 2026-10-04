import { buildApp } from "./app.js";
import { config } from "./config.js";
import { scheduleNightlyRollup } from "./routes/owner.js";

const app = await buildApp();
await app.listen({ port: config.port, host: "0.0.0.0" });
// ADR 0008: the owner dashboard's nightly rollup (00:30 Dhaka); not in tests (they import the app, not the server)
if (config.dbEnabled) scheduleNightlyRollup(app.log);
// ADR 0011: the payments sweep (links never made, executes never answered), every minute
if (config.dbEnabled) {
  const { sweepPayments } = await import("./modules/billing.js");
  const t = setInterval(() => { sweepPayments(new Date()).then((r) => { if (r.failed || r.settled) app.log.info(r, "payments sweep"); }).catch((e) => app.log.error({ err: e }, "payments sweep failed")); }, 60_000);
  t.unref?.();
}
app.log.info(`Setu API on :${config.port} · db ${config.dbEnabled ? "enabled" : "disabled (set DATABASE_URL)"} · adapters ${JSON.stringify(config.adapters)}`);
