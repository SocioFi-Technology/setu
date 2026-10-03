import { buildApp } from "./app.js";
import { config } from "./config.js";
import { scheduleNightlyRollup } from "./routes/owner.js";

const app = await buildApp();
await app.listen({ port: config.port, host: "0.0.0.0" });
// ADR 0008: the owner dashboard's nightly rollup (00:30 Dhaka); not in tests (they import the app, not the server)
if (config.dbEnabled) scheduleNightlyRollup(app.log);
app.log.info(`Setu API on :${config.port} · db ${config.dbEnabled ? "enabled" : "disabled (set DATABASE_URL)"} · adapters ${JSON.stringify(config.adapters)}`);
