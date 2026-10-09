/* ADR 0021 — a lab result in plain language for the patient app. The words are i18n keys (`patientLab`), drafts written
   from the lab catalogue: shown marked "draft" until a clinician signs each analyte off (gap 12). Kamrul 09/10/2026: a
   critical result (LL / HH) gets no explanation at all — the app shows the value, the flag and "contact your doctor /
   the facility now" with the facility's phone. */
import type { LabFlag } from "./lab.js";

export interface LabPlainDef { code: string; unit: string; signedOff: boolean }
const P = (code: string, unit: string): LabPlainDef => ({ code, unit, signedOff: false });
export const LAB_PLAIN_SAMPLE: LabPlainDef[] = [
  P("hb", "unit_g_dl"), P("wbc", "unit_per_cumm"), P("plt", "unit_per_cumm"), P("rbs", "unit_mmol_l"),
  P("na", "unit_mmol_l"), P("k", "unit_mmol_l"), P("cl", "unit_mmol_l"), P("hba1c", "unit_pct"), P("creat", "unit_mg_dl"),
];

export type LabPlain =
  | { kind: "explained"; draft: boolean; what: string; unit: string; direction: string | null }
  | { kind: "critical" }
  | { kind: "none" };

/** the keys to show for one result; `direction` null = no range to compare with */
export function labPlain(code: string, flag: LabFlag | null, list: LabPlainDef[] = LAB_PLAIN_SAMPLE): LabPlain {
  if (flag === "HH" || flag === "LL") return { kind: "critical" };
  const d = list.find((x) => x.code === code);
  if (!d) return { kind: "none" };
  const direction = flag === "H" ? `${code}_high` : flag === "L" ? `${code}_low` : flag === "N" ? "in_range" : null;
  return { kind: "explained", draft: !d.signedOff, what: `${code}_what`, unit: d.unit, direction };
}

/** where the value sits on the range bar, 0..1: the reference range is the middle third; outside it the bar extends by
    one range-width each side, then clamps. null = no range. */
export function rangePosition(value: number, low: number | null, high: number | null): number | null {
  if (low === null || high === null || !(high > low)) return null;
  const x = 1 / 3 + ((value - low) / (high - low)) / 3;
  return Math.min(1, Math.max(0, x));
}
