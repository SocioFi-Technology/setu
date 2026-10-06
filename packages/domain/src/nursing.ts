/* ADR 0016 (slice B5–B6): scan-to-verify on the MAR, intake/output, care plan tasks, the shift handover. Shift times,
   the I/O day start and the task grace are samples (facility settings) pending a clinician. */
import type { DoseOutcome, DoseSource } from "./mar.js";

/* ───── scans ───── */
/** What a scan found: nothing scanned, the right one, or why it is wrong. */
export type BandScan = "none" | "match" | "mismatch";
export type MedScan = "none" | "match" | "mismatch" | "expired" | "not-on-ward" | "empty";
export type ScanBlocker = "band_required" | "band_mismatch" | "med_required" | "med_mismatch" | "med_expired" | "med_not_on_ward" | "med_empty" | "override_reason" | "override_not_allowed";
export const OVERRIDE_REASON_MIN = 10;
export interface ScanFacts {
  outcome: DoseOutcome; source: DoseSource; highAlert: boolean; controlled: boolean;
  band: BandScan; med: MedScan;
  /** "scanner not working": allowed with a reason, never for a high-alert or controlled drug, never over a mismatch */
  overrideReason: string | null;
}
export function scanBlockers(x: ScanFacts): ScanBlocker[] {
  if (x.outcome !== "given") return [];
  const out: ScanBlocker[] = [];
  const medNeeded = x.source === "ward-stock";
  // a wrong scan is refused whatever the override says
  if (x.band === "mismatch") out.push("band_mismatch");
  if (medNeeded && x.med === "mismatch") out.push("med_mismatch");
  if (medNeeded && x.med === "expired") out.push("med_expired");
  if (medNeeded && x.med === "not-on-ward") out.push("med_not_on_ward");
  // a label of a batch with nothing left proves a shelf bin, not the dose in hand (review)
  if (medNeeded && x.med === "empty") out.push("med_empty");
  if (out.length) return out;
  const missing: ScanBlocker[] = [];
  if (x.band === "none") missing.push("band_required");
  if (medNeeded && x.med === "none") missing.push("med_required");
  if (!missing.length) return [];
  const reason = (x.overrideReason ?? "").trim();
  if (!reason) return missing;
  if (x.highAlert || x.controlled) return ["override_not_allowed", ...missing];
  if (reason.length < OVERRIDE_REASON_MIN) return ["override_reason"];
  return [];
}
/** The wristband QR: `SETU-WB1.<admissionId>.<facilityNo>.<signature>`; the signature is an HMAC of this payload. */
/** The band carries its print number: a reprint retires every earlier band (only the latest verifies — review). */
export const wristbandPayload = (admissionId: string, facilityNo: string, printNo: number) => `${admissionId}.${facilityNo}.${printNo}`;
export const wristbandCode = (admissionId: string, facilityNo: string, printNo: number, sig: string) => `SETU-WB1.${wristbandPayload(admissionId, facilityNo, printNo)}.${sig}`;
export function parseWristband(code: string): { admissionId: string; facilityNo: string; printNo: number; sig: string } | null {
  const m = /^SETU-WB1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9-]+)\.(\d{1,4})\.([A-Za-z0-9_-]+)$/i.exec(code.trim());
  return m ? { admissionId: m[1]!, facilityNo: m[2]!, printNo: Number(m[3]), sig: m[4]! } : null;
}
/** The medicine label QR on a ward batch. */
export const batchLabel = (batchId: string) => `SETU-MB1.${batchId}`;
export function parseBatchLabel(code: string): string | null {
  const m = /^SETU-MB1\.([A-Za-z0-9_-]+)$/i.exec(code.trim());
  return m ? m[1]! : null;
}

/* ───── intake / output ───── */
export type IoSide = "in" | "out";
export const IO_ROUTES: Record<IoSide, readonly string[]> = { in: ["oral", "iv", "ng", "other"], out: ["urine", "drain", "vomit", "stool", "ng-aspirate", "other"] };
export const IO_MAX_ML = 5000;
export const IO_DAY_START_HOUR_SAMPLE = 8;
const DHAKA_MS = 6 * 3600_000;
export function ioBlockers(x: { side: IoSide; route: string; ml: number; at: Date; now: Date }): ("route" | "ml" | "future")[] {
  const out: ("route" | "ml" | "future")[] = [];
  if (!IO_ROUTES[x.side]?.includes(x.route)) out.push("route");
  if (!Number.isInteger(x.ml) || x.ml < 1 || x.ml > IO_MAX_ML) out.push("ml");
  if (x.at.getTime() > x.now.getTime() + 2 * 60_000) out.push("future");
  return out;
}
/** The shift day an instant belongs to: the Dhaka date, the day starting at `startHour` (sample 08:00). */
export const shiftDay = (at: Date, startHour = IO_DAY_START_HOUR_SAMPLE) => new Date(at.getTime() + DHAKA_MS - startHour * 3600_000).toISOString().slice(0, 10);
/** UTC bounds of a shift day. */
export function shiftDayBounds(day: string, startHour = IO_DAY_START_HOUR_SAMPLE): { from: Date; to: Date } {
  const from = new Date(new Date(`${day}T00:00:00Z`).getTime() - DHAKA_MS + startHour * 3600_000);
  return { from, to: new Date(from.getTime() + 864e5) };
}
export const ioTotals = (entries: { side: IoSide; ml: number }[]) => {
  const inMl = entries.filter((e) => e.side === "in").reduce((a, e) => a + e.ml, 0);
  const outMl = entries.filter((e) => e.side === "out").reduce((a, e) => a + e.ml, 0);
  return { inMl, outMl, balanceMl: inMl - outMl };
};

/* ───── care plan tasks ───── */
export const CARE_TASK_GRACE_MIN_SAMPLE = 30;
export const CARE_EVERY_RANGE: [number, number] = [1, 24];
export const careTaskTextOk = (t: string) => t.trim().length >= 3 && t.length <= 300;
/** The next occurrence of a recurring task: N hours after it was done; a one-off has none. */
export const nextCareDue = (doneAt: Date, everyHours: number | null) => (everyHours ? new Date(doneAt.getTime() + everyHours * 3600_000) : null);
export const taskOverdue = (t: { status: string; dueAt: Date }, now: Date, graceMin = CARE_TASK_GRACE_MIN_SAMPLE) =>
  t.status === "requested" && now.getTime() > t.dueAt.getTime() + graceMin * 60_000;

/* ───── the shift handover ───── */
export const SHIFT_START_HOURS_SAMPLE = [8, 14, 20];
/** The shift `now` is in: its Dhaka day (the day it started) and start hour, with UTC start and end. */
export function currentShift(now: Date, startHours = SHIFT_START_HOURS_SAMPLE): { day: string; startHour: number; start: Date; end: Date } {
  const hours = [...startHours].sort((a, b) => a - b);
  const local = new Date(now.getTime() + DHAKA_MS);
  const h = local.getUTCHours() + local.getUTCMinutes() / 60;
  let day = local.toISOString().slice(0, 10);
  let startHour = [...hours].reverse().find((x) => x <= h);
  if (startHour === undefined) { startHour = hours[hours.length - 1]!; day = new Date(local.getTime() - 864e5).toISOString().slice(0, 10); }
  const start = new Date(new Date(`${day}T00:00:00Z`).getTime() - DHAKA_MS + startHour * 3600_000);
  const next = hours.find((x) => x > startHour!);
  const end = next !== undefined ? new Date(start.getTime() + (next - startHour) * 3600_000) : new Date(start.getTime() + (24 - startHour + hours[0]!) * 3600_000);
  return { day, startHour, start, end };
}
export const shiftHoursOk = (hours: number[]) => hours.length >= 1 && hours.length <= 4 && hours.every((h) => Number.isInteger(h) && h >= 0 && h <= 23) && new Set(hours).size === hours.length;
export const handoverSignBlockers = (x: { patients: { reviewed: boolean }[] }): "not_all_reviewed"[] => (x.patients.some((p) => !p.reviewed) ? ["not_all_reviewed"] : []);
/** Kamrul, 06/10/2026: every open escalation on the ward — acknowledged or not, however recent — is named in the
    acceptance note (bed or patient number, as a whole word); a clinician may relax this later, not tighten it. */
export function handoverAcceptBlockers(x: { outgoingId: string; incomingId: string; note: string; open: { bed: string; facilityNo: string }[] }): ("same_nurse" | "escalation_not_named")[] {
  const out: ("same_nurse" | "escalation_not_named")[] = [];
  if (x.outgoingId === x.incomingId) out.push("same_nurse");
  // whole words only: "2A-12" never names 2A-1 (review)
  const words = new Set(x.note.toLowerCase().split(/[^a-z0-9\u0980-\u09ff-]+/).filter(Boolean));
  if (x.open.some((e) => !words.has(e.bed.toLowerCase()) && !words.has(e.facilityNo.toLowerCase()))) out.push("escalation_not_named");
  return out;
}
export const QUERY_NOTE_MIN = 5;
