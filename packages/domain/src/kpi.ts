/* Owner dashboard (journey C1, ADR 0008; prototype Setu Owner Dashboard). The ten money tiles of the prototype, which
   way is "better" for each, the period and what it is compared with, and the operations counts. Tiles whose data comes
   with a later module (pharmacy, IPD, refunds, the share ledger) say so instead of showing a number (issue #23: no
   templated figures). Days are Dhaka days (queue.ts dhakaDay). */
import { dhakaDay } from "./queue.js";

export type Period = "today" | "7d" | "30d";
export type KpiKey = "revenue" | "collections" | "dues" | "discounts" | "deposits" | "refunds" | "sharePayable" | "supplierDues" | "stockValue" | "nearExpiry";
export type OpsKey = "opdVisits" | "labTests" | "labTat" | "noShows" | "cashVariance" | "reprints";
/** up = a bigger number is better; down = smaller is better; abs = closer to zero is better */
type Better = "up" | "down" | "abs";
export const KPIS: { key: KpiKey; better: Better; comesWith?: "pharmacy" | "ipd" | "refunds" | "ledger" }[] = [
  { key: "revenue", better: "up" }, { key: "collections", better: "up" }, { key: "dues", better: "down" }, { key: "deposits", better: "up", comesWith: "ipd" },
  { key: "discounts", better: "down" }, { key: "refunds", better: "down" }, { key: "sharePayable", better: "down", comesWith: "ledger" },
  // pharmacy session 2 (ADR 0009): stock and supplier tiles are live — point-in-time values from the ledgers
  { key: "supplierDues", better: "down" }, { key: "stockValue", better: "up" }, { key: "nearExpiry", better: "down" },
];
const OPS_BETTER: Record<OpsKey, Better> = { opdVisits: "up", labTests: "up", labTat: "down", noShows: "down", cashVariance: "abs", reprints: "down" };

export function kpiChange(key: KpiKey | OpsKey, current: number, previous: number): { pct: number | null; judgement: "better" | "worse" | "same" | null } {
  const better = (KPIS.find((k) => k.key === key)?.better ?? OPS_BETTER[key as OpsKey]) as Better;
  const [c, p] = better === "abs" ? [Math.abs(current), Math.abs(previous)] : [current, previous];
  if (p === 0) return { pct: null, judgement: null };
  const pct = Math.round(((c - p) / p) * 100);
  if (c === p) return { pct: 0, judgement: "same" };
  const up = c > p;
  return { pct, judgement: (better === "up") === up ? "better" : "worse" };
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const range = (last: string, n: number) => Array.from({ length: n }, (_, i) => addDays(last, i - n + 1));

/** The Dhaka days of a period and the days it is compared with. Today is compared with the same weekday last week up
    to exactly the same moment (`previousUntil` = now − 7 days, for every metric — money-controls review M3). */
export function periodDays(period: Period, now: Date): { days: string[]; previous: string[]; uptoHour: number | null; previousUntil: Date | null } {
  const today = dhakaDay(now);
  if (period === "today") return { days: [today], previous: [addDays(today, -7)], uptoHour: (now.getUTCHours() + 6) % 24, previousUntil: new Date(now.getTime() - 7 * 864e5) };
  const n = period === "7d" ? 7 : 30;
  return { days: range(today, n), previous: range(addDays(today, -n), n), uptoHour: null, previousUntil: null };
}

/** The total of an hourly series up to and including `hour` (null = the whole day). */
export const sumUpToHour = (hours: readonly number[], hour: number | null) => hours.slice(0, hour === null ? 24 : hour + 1).reduce((a, b) => a + b, 0);
