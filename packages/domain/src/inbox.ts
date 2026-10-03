/* The doctor's inbox (walkthrough A12, ADR 0007). Each item is a doctor-inbox Communication row written by the lab
   (report released, correction, results withdrawn, test cancelled) or by the vitals station (critical vital sign).
   The screen and the API use the same order and the same acknowledge rules. */
import type { Interpretation } from "./vitals.js";

export type InboxKind = "report-inbox" | "correction-notice" | "results-withdrawn" | "order-cancelled" | "critical-vital";
export type InboxSeverity = "critical" | "abnormal" | "normal" | "notice";
const RANK: Record<InboxSeverity, number> = { critical: 0, abnormal: 1, normal: 2, notice: 3 };

/** Notices tell the doctor something changed; reports are graded by their worst result; a critical vital is critical. */
export function inboxSeverity(kind: InboxKind, flags: readonly (Interpretation | null)[]): InboxSeverity {
  if (kind === "critical-vital") return "critical";
  if (kind !== "report-inbox") return "notice";
  if (flags.some((f) => f === "HH" || f === "LL")) return "critical";
  if (flags.some((f) => f === "H" || f === "L")) return "abnormal";
  return "normal";
}

export type InboxSortable = { severity: InboxSeverity; at: string | Date; acknowledged: boolean };
/** A12 "critical first": what still needs the doctor before what is done; worst first; newest first within a group. */
export function sortInbox<T extends InboxSortable>(items: readonly T[]): T[] {
  const ms = (x: string | Date) => (x instanceof Date ? x : new Date(x)).getTime();
  return [...items].sort((a, b) => Number(a.acknowledged) - Number(b.acknowledged) || RANK[a.severity] - RANK[b.severity] || ms(b.at) - ms(a.at));
}

/** Decision D1: only a released report may tell the patient (facility name only, no value). */
export const PATIENT_NOTIFY_KINDS: readonly InboxKind[] = ["report-inbox"];

export type AckBlocker = "not_recipient" | "already_acknowledged" | "superseded" | "notify_not_for_kind" | "no_mobile";
export function ackBlockers(x: { isRecipient: boolean; acknowledged: boolean; superseded: boolean; kind: InboxKind; notifyPatient: boolean; patientHasMobile: boolean }): AckBlocker[] {
  const out: AckBlocker[] = [];
  if (!x.isRecipient) out.push("not_recipient");
  if (x.acknowledged) out.push("already_acknowledged");
  if (x.superseded) out.push("superseded");
  if (x.notifyPatient && !PATIENT_NOTIFY_KINDS.includes(x.kind)) out.push("notify_not_for_kind");
  else if (x.notifyPatient && !x.patientHasMobile) out.push("no_mobile");
  return out;
}
