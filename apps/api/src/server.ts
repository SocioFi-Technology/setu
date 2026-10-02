import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = await buildApp();
await app.listen({ port: config.port, host: "0.0.0.0" });
app.log.info(`Setu API on :${config.port} · db ${config.dbEnabled ? "enabled" : "disabled (set DATABASE_URL)"} · adapters ${JSON.stringify(config.adapters)}`);
