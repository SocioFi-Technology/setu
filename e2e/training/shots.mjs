// Runs the walkthroughs into e2e/training/shots/<walk>/ (dev servers on STAFF_URL, seeded data). The bKash and SMS
// walks need the API in stand-in mode (walk-bkash.mjs / walk-sms.mjs headers) — run them by name when it is.
//   node e2e/training/shots.mjs [walk-desk walk-cash …]
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url)), E2E = join(HERE, "..");
const DEFAULT = ["walk-desk", "walk-cash", "walk-doc", "walk-lab", "walk-pharm", "walk-ward", "walk-b5b6", "walk-er", "walk-ipdbill", "walk-discharge", "walk-refund", "walk-owner", "walk-admin"];
const walks = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
const failed = [];
for (const w of walks) {
  const out = join(HERE, "shots", w); rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  const t = Date.now();
  const r = spawnSync("node", [`${w}.mjs`, out], { cwd: E2E, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 600_000 });
  const saved = (r.stdout.match(/saved /g) ?? []).length;
  console.log(`${w}: ${r.status === 0 ? "ok" : "FAILED"} — ${saved} screenshots, ${Math.round((Date.now() - t) / 1000)} s`);
  if (r.status !== 0) { failed.push(w); console.log(r.stderr.split("\n").filter((l) => /Error|error|Timeout|waiting for/.test(l)).slice(0, 4).join("\n")); }
}
if (failed.length) { console.log("failed:", failed.join(", ")); process.exit(1); }
