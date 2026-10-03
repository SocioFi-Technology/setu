/* Pharmacy rules (phase 2 slice 2, ADR 0009; prototype Setu Pharmacy). FEFO batch picking, a prescription line's
   dispense status (prescribed ≠ dispensed ≠ what the patient says), same-generic substitution, over-the-counter gating
   and the Bangla dose label. The sale classes are the demo list's (`sample`), pending a licensed drug database (gap 12):
   OTC sells freely, Rx needs a prescription photo, controlled drugs never sell over the counter. */
import { MEDICINES_SAMPLE } from "./catalog.js";
import * as format from "./format.js";
import { allergyMatches, type AllergyFact } from "./prescription.js";

export const NEAR_EXPIRY_DAYS = 90;
export interface BatchLike { id: string; expiry: string; qty: number; location: string }
export type BatchState = "usable" | "expired" | "empty" | "quarantine";
/** expiry is the last day the batch may be used (yyyy-mm-dd, Dhaka) */
export function batchState(b: BatchLike, today: string): BatchState {
  if (b.location === "quarantine") return "quarantine";
  if (b.expiry < today) return "expired";
  if (b.qty <= 0) return "empty";
  return "usable";
}
const days = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5);
export const nearExpiry = (expiry: string, today: string) => expiry >= today && days(expiry, today) <= NEAR_EXPIRY_DAYS;

/** First expiry, first out: usable batches by expiry (then id for a stable order), as much as each holds. */
export function fefoPick(batches: readonly BatchLike[], need: number, today: string): { allocations: { batchId: string; qty: number }[]; shortfall: number } {
  const usable = batches.filter((b) => batchState(b, today) === "usable").sort((a, b) => a.expiry.localeCompare(b.expiry) || a.id.localeCompare(b.id));
  const allocations: { batchId: string; qty: number }[] = [];
  let left = need;
  for (const b of usable) {
    if (left <= 0) break;
    const q = Math.min(b.qty, left);
    allocations.push({ batchId: b.id, qty: q });
    left -= q;
  }
  return { allocations, shortfall: Math.max(0, left) };
}

export type DispenseStatus = "to-dispense" | "partial" | "dispensed" | "declined" | "partial-declined";
export function dispenseStatus(x: { prescribed: number; dispensed: number; declined: boolean }): DispenseStatus {
  if (x.dispensed >= x.prescribed) return "dispensed";
  if (x.declined) return x.dispensed > 0 ? "partial-declined" : "declined";
  return x.dispensed > 0 ? "partial" : "to-dispense";
}

type Med = { id: string; ingredients: string[]; classes: string[] };
const sameGeneric = (a: Med, b: Med) => a.ingredients.length === b.ingredients.length && a.ingredients.every((i) => b.ingredients.includes(i));
export type SubstitutionBlocker = "not_same_generic" | "reason_required" | "allergy";
export function substitutionBlockers(x: { prescribed: Med; substitute: Med; reason: string; allergies: AllergyFact[] }): SubstitutionBlocker[] {
  const out: SubstitutionBlocker[] = [];
  if (!sameGeneric(x.prescribed, x.substitute) || x.prescribed.id === x.substitute.id) out.push("not_same_generic");
  if (x.reason.trim().length < 10) out.push("reason_required");
  if (allergyMatches(x.substitute, x.allergies).length) out.push("allergy");
  return out;
}

export type SaleClass = "otc" | "rx" | "ctrl";
/** The demo list's sale classes (sample, pending clinician / DGDA classification). Anything unknown is Rx-only. */
export const SALE_CLASS_SAMPLE: Record<string, SaleClass> = {
  napa: "otc", ace: "otc", seclo: "otc", pantonix: "otc", sergel: "otc",
  comet: "rx", comet850: "rx", ciprocin: "rx", moxacil: "rx", fimoxyl: "rx", cotrim: "rx", azith: "rx", clopi: "rx", amdocal: "rx", osartil: "rx",
  sedil: "ctrl",
};
export const saleClass = (medicineKey: string): SaleClass => SALE_CLASS_SAMPLE[medicineKey] ?? "rx";
export type OtcBlocker = "rx_photo_required" | "controlled";
export function otcCheck(cls: SaleClass, hasRxPhoto: boolean): OtcBlocker[] {
  if (cls === "ctrl") return ["controlled"];
  if (cls === "rx" && !hasRxPhoto) return ["rx_photo_required"];
  return [];
}
export const isSampleMedicine = (key: string) => MEDICINES_SAMPLE.some((m) => m.id === key);

/** The dose on the label: "সকালে ১টি, রাতে ১টি · খাবারের পরে · ৩০ দিন" (Bangla digits on a Bangla label). */
const TIMES = { bn: ["সকালে", "দুপুরে", "রাতে", "ঘুমের আগে"], en: ["Morning", "Noon", "Night", "Bedtime"] };
const MEAL = { bn: { before: "খাবারের আগে", after: "খাবারের পরে", with: "খাবারের সাথে", any: "যেকোনো সময়" }, en: { before: "Before food", after: "After food", with: "With food", any: "Any time" } };
export function doseLabel(dose: string, meal: "before" | "after" | "with" | "any", daysN: number, lang: "bn" | "en"): string {
  const parts = dose.split("+").map((x) => Number(x));
  const bn = lang === "bn";
  const times = parts.map((n, i) => (n > 0 ? (bn ? `${TIMES.bn[i]} ${format.toBn(n)}টি` : `${TIMES.en[i]} ${n}`) : null)).filter(Boolean).join(", ");
  return `${times} · ${MEAL[lang][meal]} · ${bn ? `${format.toBn(daysN)} দিন` : `${daysN} days`}`;
}
