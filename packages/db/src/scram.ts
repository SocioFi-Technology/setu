/* Gap 10 (pre-pilot security pass): the setu_app role's password is never sent to Postgres in clear. The SCRAM-SHA-256
   verifier Postgres would store is computed here (RFC 5802 / 7677, Postgres's 4096 iterations) and sent instead —
   `ALTER ROLE … PASSWORD 'SCRAM-SHA-256$…'` stores it as it is, so the statement (and any statement log) carries no
   password. ASCII passwords only (Postgres would SASLprep-normalise others): anything else is refused. */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  if (!/^[\x21-\x7e]+$/.test(password)) throw new Error("the role password must be printable ASCII (no spaces)");
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
