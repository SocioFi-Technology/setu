/* Printed clinical documents (walkthrough A13, ADR 0007): the prescription (a signed consultation note) and the lab
   report version. Nothing prints with a QR until it is final; drafts never print (issue #19: "Drafts cannot be
   printed — sign first"); the first print is the original, every later one needs a reason and says DUPLICATE #n. */
import type { DocState, LabReportState } from "./machines.js";

export type PrintBlocker = "draft_not_printable" | "superseded_not_printable" | "withdrawn_not_printable";

export function rxPrintBlockers(status: DocState): PrintBlocker[] {
  if (status === "draft" || status === "queued") return ["draft_not_printable"];
  if (status === "superseded") return ["superseded_not_printable"];
  if (status === "entered-in-error") return ["withdrawn_not_printable"];
  return [];
}

/** A released lab report version prints while it is current; a preliminary one carries its "n of m pending" banner. */
export function labReportPrintBlockers(status: LabReportState): PrintBlocker[] {
  return status === "superseded" ? ["superseded_not_printable"] : [];
}

/** Reprint reasons for clinical documents: lost, printer jam / unclear, an extra copy (pharmacy, another doctor). */
export const REPRINT_REASONS = ["lost", "jam", "copy"] as const;
export type ReprintReasonCode = (typeof REPRINT_REASONS)[number];

/** `printedSoFar` = copies already printed of this version. */
export function copyCheck(printedSoFar: number, reason: ReprintReasonCode | undefined): { copy: number } | { error: "reprint_needs_reason" | "not_printed_yet" } {
  if (printedSoFar > 0 && !reason) return { error: "reprint_needs_reason" };
  if (printedSoFar === 0 && reason) return { error: "not_printed_yet" };
  return { copy: printedSoFar };
}

export type VerifyStatus = "current" | "superseded" | "withdrawn";
/** What the public verify page says about a scanned prescription; a draft has none. */
export function rxVerifyStatus(status: DocState): VerifyStatus | null {
  if (status === "final" || status === "amended") return "current";
  if (status === "superseded") return "superseded";
  if (status === "entered-in-error") return "withdrawn";
  return null;
}

/** "R. K." — the verify page never shows a full name (decision D2). */
export function initials(nameEn: string | null | undefined, nameBn: string | null | undefined): string {
  const name = (nameEn ?? "").trim() || (nameBn ?? "").trim();
  if (!name) return "—";
  return name.split(/\s+/).map((w) => `${Array.from(w)[0]!.toUpperCase()}.`).join(" ");
}
