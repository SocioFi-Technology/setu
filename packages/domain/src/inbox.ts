/* The doctor's inbox (walkthrough A12, ADR 0007). Each item is a doctor-inbox Communication row written by the lab
   (report released, correction, results withdrawn, test cancelled) or by the vitals station (critical vital sign).
   The screen and the API use the same order and the same acknowledge rules. */
import type { Interpretation } from "./vitals.js";

/** substitution-notice (ADR 0009): the pharmacist gave a same-generic substitute for one of the doctor's lines. */
/** return-notice (ADR 0013): medicine given for the doctor's line came back as a wrong dispense (a medication incident). */
export type InboxKind = "report-inbox" | "correction-notice" | "results-withdrawn" | "order-cancelled" | "critical-vital" | "substitution-notice" | "return-notice";
export type InboxSeverity = "critical" | "abnormal" | "normal" | "notice";
const RANK: Record<InboxSeverity, number> = { critical: 0, abnormal: 1, normal: 2, notice: 3 };

/** Reports are graded by their worst result — values under correction included (clinical review M1); a critical
    vital is critical; a correction / withdrawal notice about a critical value is critical; other notices are notices. */
export function inboxSeverity(kind: InboxKind, flags: readonly (Interpretation | null)[]): InboxSeverity {
  if (kind === "critical-vital") return "critical";
  const critical = flags.some((f) => f === "HH" || f === "LL");
  if (kind === "correction-notice" || kind === "results-withdrawn") return critical ? "critical" : "notice";
  if (kind !== "report-inbox") return "notice";
  if (flags.some((f) => f === "HH" || f === "LL")) return "critical";
  if (flags.some((f) => f === "H" || f === "L")) return "abnormal";
  return "normal";
}

/** `resolved`: a report version a newer version replaced — the newer one is the item to review (clinical review M3). */
export type InboxSortable = { severity: InboxSeverity; at: string | Date; acknowledged: boolean; resolved?: boolean };
/** Still needs the doctor: not acknowledged and not replaced by a newer version (the unread / critical counts). */
export const isOpenItem = (x: { acknowledged: boolean; resolved?: boolean }) => !x.acknowledged && !x.resolved;
/** A12 "critical first": what still needs the doctor before what is done; worst first; newest first within a group. */
export function sortInbox<T extends InboxSortable>(items: readonly T[]): T[] {
  const ms = (x: string | Date) => (x instanceof Date ? x : new Date(x)).getTime();
  return [...items].sort((a, b) => Number(!isOpenItem(a)) - Number(!isOpenItem(b)) || RANK[a.severity] - RANK[b.severity] || ms(b.at) - ms(a.at));
}

/** Decision D1: only a released report may tell the patient (facility name only, no value). */
export const PATIENT_NOTIFY_KINDS: readonly InboxKind[] = ["report-inbox"];

export type AckBlocker = "not_recipient" | "already_acknowledged" | "superseded" | "correction_pending" | "notify_not_for_kind" | "no_mobile";
/** `superseded` / `correctionPending` describe the report the item is about; they block a report item only (a notice
    about v1 is still acknowledged after v2 — clinical review M2). A report with a value under correction waits for the
    corrected version (M1). */
export function ackBlockers(x: { isRecipient: boolean; acknowledged: boolean; superseded: boolean; correctionPending?: boolean; kind: InboxKind; notifyPatient: boolean; patientHasMobile: boolean }): AckBlocker[] {
  const out: AckBlocker[] = [];
  if (!x.isRecipient) out.push("not_recipient");
  if (x.acknowledged) out.push("already_acknowledged");
  if (x.kind === "report-inbox" && x.superseded) out.push("superseded");
  if (x.kind === "report-inbox" && x.correctionPending) out.push("correction_pending");
  if (x.notifyPatient && !PATIENT_NOTIFY_KINDS.includes(x.kind)) out.push("notify_not_for_kind");
  else if (x.notifyPatient && !x.patientHasMobile) out.push("no_mobile");
  return out;
}
