/* ADR 0020 — the patient app's claim on a facility's records. The code printed on the receipt and the prescription is
   6 characters from an alphabet with no look-alikes; three wrong codes lock the claim for 24 hours (CLAIM machine,
   walkthrough issue #3). The server compares codes; this decides what one attempt does. */
import { CLAIM, CLAIM_LOCK_HOURS, CLAIM_MAX_TRIES, transition, type ClaimState } from "./machines.js";

export const CLAIM_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const SHAPE = new RegExp(`^[${CLAIM_CODE_ALPHABET}]{6}$`);
export const isClaimCode = (s: string) => SHAPE.test(s);
/** As typed (any case, spaces, dashes, Bangla digits) → the code, or null when it cannot be one. */
export function normalizeClaimCode(input: string): string | null {
  const s = input.replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d))).replace(/[\s-]/g, "").toUpperCase();
  return isClaimCode(s) ? s : null;
}

export interface ClaimFacts { status: ClaimState; tries: number; lockedUntil: Date | null }
export type ClaimAttempt = ClaimFacts & { triesLeft: number; refused?: "locked" | "closed" };
/** One proof attempt: `ok` = the code matched one of this facility's records on the person's phone. */
export function claimAttempt(c: ClaimFacts, ok: boolean, now: Date): ClaimAttempt {
  if (c.status === "linked" || c.status === "not-mine") return { ...c, triesLeft: 0, refused: "closed" };
  let status: ClaimState = c.status, tries = c.tries, lockedUntil = c.lockedUntil;
  if (status === "locked") {
    if (lockedUntil && lockedUntil.getTime() > now.getTime()) return { status, tries, lockedUntil, triesLeft: 0, refused: "locked" };
    status = transition("claim", CLAIM, status, "unlock"); tries = 0; lockedUntil = null;
  }
  if (status === "candidate") status = transition("claim", CLAIM, status, "startProof");
  if (ok) return { status: transition("claim", CLAIM, status, "codeOk"), tries: 0, lockedUntil: null, triesLeft: CLAIM_MAX_TRIES };
  tries += 1;
  if (tries >= CLAIM_MAX_TRIES) return { status: transition("claim", CLAIM, status, "thirdWrong"), tries: CLAIM_MAX_TRIES, lockedUntil: new Date(now.getTime() + CLAIM_LOCK_HOURS * 3600_000), triesLeft: 0 };
  return { status: transition("claim", CLAIM, status, "codeWrong"), tries, lockedUntil: null, triesLeft: CLAIM_MAX_TRIES - tries };
}
