/* `pnpm db:set-app-password`: sets the setu_app role's password from DATABASE_URL_APP — as a SCRAM-SHA-256 verifier,
   never the password itself (gap 10). `pnpm db:migrate` runs it after migrating; a deploy host that runs
   `prisma migrate deploy` runs it on its own. */
import { pathToFileURL } from "node:url";
import { owner } from "./owner.ts";
import { scramVerifier } from "./scram.ts";

export async function setAppPassword(): Promise<void> {
  const appUrl = process.env.DATABASE_URL_APP;
  if (!appUrl) throw new Error("DATABASE_URL_APP is not set in .env — the API cannot connect. See .env.example.");
  const u = new URL(appUrl);
  if (decodeURIComponent(u.username) !== "setu_app") throw new Error("DATABASE_URL_APP must connect as setu_app");
  const password = decodeURIComponent(u.password);
  if (password.length < 8) throw new Error("DATABASE_URL_APP password must be at least 8 characters");
  const verifier = scramVerifier(password);
  // the verifier is base64 and "$:" only — nothing to escape; still checked before it goes into the statement
  if (!/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) throw new Error("unexpected verifier");
  await owner.$executeRawUnsafe(`ALTER ROLE setu_app PASSWORD '${verifier}'`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setAppPassword().then(() => { console.log("setu_app password set from DATABASE_URL_APP (as a SCRAM-SHA-256 verifier)"); return owner.$disconnect(); })
    .catch(async (e) => { console.error(String((e as Error).message)); await owner.$disconnect(); process.exit(1); });
}
