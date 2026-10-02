/* `pnpm db:migrate [prisma migrate dev args]`: runs Prisma migrate as the owner, then (unless --create-only) sets the
   setu_app password from DATABASE_URL_APP so no password is ever written into a migration. */
import { spawnSync } from "node:child_process";
import { owner } from "./owner.ts";

const args = process.argv.slice(2);
const quoted = args.map((a) => (/^[\w.=:-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
const r = spawnSync(`prisma migrate dev ${quoted}`, { stdio: "inherit", shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);
if (args.includes("--create-only")) process.exit(0);

const appUrl = process.env.DATABASE_URL_APP;
if (!appUrl) { console.error("DATABASE_URL_APP is not set in .env — the API cannot connect. See .env.example."); process.exit(1); }
const u = new URL(appUrl);
if (decodeURIComponent(u.username) !== "setu_app") { console.error("DATABASE_URL_APP must connect as setu_app"); process.exit(1); }
const password = decodeURIComponent(u.password);
if (password.length < 8) { console.error("DATABASE_URL_APP password must be at least 8 characters"); process.exit(1); }
await owner.$executeRawUnsafe(`ALTER ROLE setu_app PASSWORD '${password.replace(/'/g, "''")}'`);
await owner.$disconnect();
console.log("setu_app password set from DATABASE_URL_APP");
