/* `pnpm db:migrate [prisma migrate dev args]`: runs Prisma migrate as the owner, then (unless --create-only) sets the
   setu_app password from DATABASE_URL_APP so no password is ever written into a migration (gap 10: sent as a SCRAM
   verifier, never in clear). */
import { spawnSync } from "node:child_process";
import { owner } from "./owner.ts";
import { setAppPassword } from "./set-app-password.ts";

const args = process.argv.slice(2);
const quoted = args.map((a) => (/^[\w.=:-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
const r = spawnSync(`prisma migrate dev ${quoted}`, { stdio: "inherit", shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);
if (args.includes("--create-only")) process.exit(0);

// gap 10: the password goes as a SCRAM-SHA-256 verifier, never in clear (set-app-password.ts)
try { await setAppPassword(); } catch (e) { console.error(String((e as Error).message)); await owner.$disconnect(); process.exit(1); }
await owner.$disconnect();
console.log("setu_app password set from DATABASE_URL_APP (as a SCRAM-SHA-256 verifier)");
