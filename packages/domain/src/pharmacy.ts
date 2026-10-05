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
/** ADR 0013: units the patient returned count as not given — the line reopens (a wrong dispense is given again). */
export function dispenseStatus(x: { prescribed: number; dispensed: number; returned?: number; declined: boolean }): DispenseStatus {
  const given = x.dispensed - (x.returned ?? 0);
  if (given >= x.prescribed) return "dispensed";
  if (x.declined) return given > 0 ? "partial-declined" : "declined";
  return given > 0 ? "partial" : "to-dispense";
}

/** ADR 0013: returned medicine waits in quarantine; it goes back to the counter only when a pharmacist says it is
    unopened and resaleable, with a reason — never an expired batch; a controlled drug needs the owner. */
export type ResaleBlocker = "not_a_pharmacist" | "owner_only" | "not_unopened" | "reason_too_short" | "expired" | "over_quarantine";
export function resaleBlockers(x: { role: string; unopened: boolean; reason: string; expired: boolean; controlled: boolean; inQuarantine: number; qty: number }): ResaleBlocker[] {
  if (x.controlled && x.role !== "owner") return ["owner_only"];
  if (!x.controlled && x.role !== "pharmacist") return ["not_a_pharmacist"];
  if (!x.unopened) return ["not_unopened"];
  if (x.reason.trim().length < 10) return ["reason_too_short"];
  if (x.expired) return ["expired"];
  if (!Number.isSafeInteger(x.qty) || x.qty < 1 || x.qty > x.inQuarantine) return ["over_quarantine"];
  return [];
}

type Med = { id: string; ingredients: string[]; classes: string[]; strength: string; form: string };
/** Same ingredients, same strength, same form — Comet 850 is not a substitute for Comet 500 (clinical review: the label's
    "1 tablet" would be a different dose). */
export const sameGeneric = (a: Med, b: Med) => a.ingredients.length === b.ingredients.length && a.ingredients.every((i) => b.ingredients.includes(i))
  && a.strength.replace(/\s/g, "").toLowerCase() === b.strength.replace(/\s/g, "").toLowerCase() && a.form === b.form;
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
  // ADR 0015: the ward's opioids are controlled (register on issue and on giving); the other injections are Rx
  morphine: "ctrl", pethidine: "ctrl",
};
export const saleClass = (medicineKey: string): SaleClass => SALE_CLASS_SAMPLE[medicineKey] ?? "rx";
export type OtcBlocker = "rx_photo_required" | "controlled";
export function otcCheck(cls: SaleClass, hasRxPhoto: boolean): OtcBlocker[] {
  if (cls === "ctrl") return ["controlled"];
  if (cls === "rx" && !hasRxPhoto) return ["rx_photo_required"];
  return [];
}
export const isSampleMedicine = (key: string) => MEDICINES_SAMPLE.some((m) => m.id === key);

/** The dose on the label: "সকালে ১টি, রাতে ১টি · খাবারের পরে · ৩০ দিন" (Bangla digits on a Bangla label). Read through the
    same parser as the prescription (½, 0.5, 1-0-1, Bangla digits); null when it cannot be read — never a label
    without the dose (clinical review). */
const TIMES = { bn: ["সকালে", "দুপুরে", "রাতে", "ঘুমের আগে"], en: ["Morning", "Noon", "Night", "Bedtime"] };
const MEAL = { bn: { before: "খাবারের আগে", after: "খাবারের পরে", with: "খাবারের সাথে", any: "যেকোনো সময়" }, en: { before: "Before food", after: "After food", with: "With food", any: "Any time" } };
export function doseLabel(dose: string, meal: "before" | "after" | "with" | "any", daysN: number, lang: "bn" | "en"): string | null {
  const d = format.dose(dose);
  if (!d.ok) return null;
  const parts = d.parts.map((x) => (x === "½" ? 0.5 : Number(x)));
  const bn = lang === "bn";
  const count = (n: number) => (n === 0.5 ? "½" : Number.isInteger(n) ? String(n) : `${Math.floor(n)}½`);
  const times = parts.map((n, i) => (n > 0 ? (bn ? `${TIMES.bn[i]} ${format.toBn(count(n))}টি` : `${TIMES.en[i]} ${count(n)}`) : null)).filter(Boolean).join(", ");
  return `${times} · ${MEAL[lang][meal]} · ${bn ? `${format.toBn(daysN)} দিন` : `${daysN} days`}`;
}

/** Sample selling prices per tablet / capsule (paisa) for the demo batches — plausible, not a real tariff (sample). */
export const MRP_SAMPLE: Record<string, number> = {
  comet: 400, comet850: 600, ciprocin: 1500, seclo: 600, pantonix: 700, sergel: 800, napa: 120, ace: 120, moxacil: 800, fimoxyl: 800,
  cotrim: 400, azith: 3500, clopi: 1000, amdocal: 500, osartil: 800, sedil: 300,
};
