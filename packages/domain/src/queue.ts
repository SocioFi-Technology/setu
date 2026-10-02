/* Front desk queue (slice A1–A3). The token is an attribute of the Encounter, numbered from a per-branch daily Sequence;
   the board is a view of ENCOUNTER states — it has no state machine of its own (decision 02/10/2026). */
import type { EncounterEvent, EncounterState } from "./machines.js";

/** "A-017": prefix A, at least three Latin digits (CLAUDE.md: display numbers are always Latin). */
export const formatToken = (n: number): string => `A-${String(n).padStart(3, "0")}`;

/** The token day: the calendar date in Asia/Dhaka (UTC+6, no daylight saving). */
export const dhakaDay = (now: Date): string => new Date(now.getTime() + 6 * 3600_000).toISOString().slice(0, 10);
export const tokenSequenceName = (branchId: string, day: string) => `token:${branchId}:${day}`;

export type QueueColumn = "waiting" | "vitals" | "withDoctor" | "done" | "noShow";
export const QUEUE_COLUMNS: { key: QueueColumn; state: EncounterState }[] = [
  { key: "waiting", state: "arrived" },
  { key: "vitals", state: "triaged" },
  { key: "withDoctor", state: "in-progress" },
  { key: "done", state: "finished" },
  { key: "noShow", state: "cancelled" },
];
export const columnOf = (s: EncounterState): QueueColumn | null => QUEUE_COLUMNS.find((c) => c.state === s)?.key ?? null;

export type QueueActionKey = "next" | "noShow";
/** What the board offers for a token in state `s`. Each is an ENCOUNTER event; the API applies it through `transition`. */
export const queueActions = (s: EncounterState): { key: QueueActionKey; event: EncounterEvent }[] => {
  switch (s) {
    case "arrived": return [{ key: "next", event: "triage" }, { key: "noShow", event: "cancel" }];
    case "triaged": return [{ key: "next", event: "start" }, { key: "noShow", event: "cancel" }];
    case "in-progress": return [{ key: "next", event: "finish" }];
    default: return [];
  }
};

/** The front desk may move a token up to "with doctor" or mark a no-show; finishing a visit is the doctor's step
    (consultation, slice A4–A5), not the desk's (clinical review A1–A3). */
export const frontDeskActions = (s: EncounterState) => queueActions(s).filter((a) => a.event !== "finish");
