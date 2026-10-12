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

/* ── ADR 0024: proof at the reception desk, and the QR printed beside the code ── */
/** the desk code the app shows: the claim-code alphabet, 6 characters, valid 7 days (the patient may get a new one) */
export const DESK_CODE_DAYS = 7;
export const deskCodeUntil = (from: Date) => new Date(from.getTime() + DESK_CODE_DAYS * 864e5);
export const DESK_DOCUMENTS = ["nid", "birth-reg"] as const;
export type DeskDocument = (typeof DESK_DOCUMENTS)[number];
/** What the reception may do with a claim it found by its desk code: confirm (→ linked) or refuse (→ candidate, the
    patient chooses again). Only a claim waiting for the desk, with a code still valid. */
export function deskDecision(c: { status: ClaimState; method: string | null; deskCodeUntil: Date | null }, decision: "confirm" | "refuse", now: Date): { status: ClaimState } | { refused: "not-waiting" | "expired" } {
  if (c.status !== "proof-pending" || c.method !== "desk") return { refused: "not-waiting" };
  if (!c.deskCodeUntil || c.deskCodeUntil.getTime() <= now.getTime()) return { refused: "expired" };
  return { status: transition("claim", CLAIM, c.status, decision === "confirm" ? "deskOk" : "deskRefused") };
}
/** The claim QR printed on receipts and prescriptions: the patient app's claim page with the facility and the code. */
export const claimQrUrl = (patientAppUrl: string, tenantId: string, code: string) =>
  `${patientAppUrl.replace(/\/+$/, "")}/claim?t=${encodeURIComponent(tenantId)}&c=${code}`;
/** A scanned QR → the facility and the code, ONLY when it is Setu's claim QR (a document's verify QR is not: reading its
    tail as a code would cost the patient a try at the wrong facility). */
export function readClaimQr(raw: string): { tenantId: string; code: string } | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (!/\/claim\/?$/.test(u.pathname)) return null;
  const t = u.searchParams.get("t"), c = normalizeClaimCode(u.searchParams.get("c") ?? "");
  return t && /^[A-Za-z0-9_-]{1,64}$/.test(t) && c ? { tenantId: t, code: c } : null;
}
