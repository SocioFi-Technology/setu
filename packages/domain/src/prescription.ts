/* Prescription checks (walkthrough A5, issues #16 and the Penicillin case). Pure functions: the consultation screen calls
   them as the doctor types, and the sign route calls them again with the medicines and allergies read from the database
   (never the screen's copy), so the screen and the API block for the same reasons.

   Rules (prototype `warnsFor`, decisions 26 and D4, Kamrul's adjustments of 02/10/2026):
   - Allergy: an active allergy to a class the medicine belongs to, or to one of its ingredients → blocks; only Remove.
   - Same medicine: a later line sharing an ingredient (generic) with an earlier line → blocks until Remove or Keep both.
     Compared on ingredients, never on brand text (Seclo and another omeprazole are the same medicine).
   - Same class: a second, different medicine in a duplicate class (two PPIs) → blocks; only Remove.
   - Interaction (demo rule): blocks on the flagged line until acknowledged.
   - Dose and days: a dose that is not 3 or 4 parts (1+0+1, 1+1+1+1) or days outside 1–365 → blocks.
   The allergy, interaction and class data are a DEMO list (catalog.ts) — not clinical rules (pre-pilot, D3). */
import { DUPLICATE_CLASSES, INTERACTIONS_SAMPLE, type Meal } from "./catalog.js";
import { dose as parseDose } from "./format.js";

export interface RxMedicine { id: string; brand: string; generic: string; strength: string; form: string; ingredients: string[]; classes: string[] }
export interface RxLine {
  /** stable per line (the screen's key; the MedicationRequest id once saved) */
  uid: string;
  medicine: RxMedicine;
  dose: string; meal: Meal; days: number;
  /** the doctor chose "Keep both" on a same-medicine warning */
  keepBoth?: boolean;
  /** interaction rule ids acknowledged on this line */
  acks?: string[];
}
/** An active allergy as the checks see it. `other` = free text, which cannot be matched automatically. */
export interface AllergyFact {
  id: string; kind: "class" | "substance" | "other"; key: string | null; labelBn: string; labelEn: string;
  reaction?: string | null; severity?: string | null; recordedAt?: string | null; recordedBy?: { nameBn: string; nameEn: string } | null;
}

export type RxWarningKind = "allergy" | "same-medicine" | "same-class" | "interaction" | "dose-invalid" | "days-invalid";
export type RxAction = "remove" | "keepBoth" | "acknowledge" | "edit";
export interface RxWarning {
  line: string; kind: RxWarningKind; block: boolean; actions: RxAction[];
  /** allergy: the allergy that matched */
  allergy?: AllergyFact;
  /** same-medicine: the earlier line and the shared ingredient; kept = "Keep both" chosen (shown, not blocking) */
  firstLine?: string; firstBrand?: string; ingredient?: string; kept?: boolean;
  /** same-class: the class key; interaction: the rule id and its text */
  classKey?: string; ruleId?: string; textBn?: string; textEn?: string; acknowledged?: boolean;
}

export const RX_DAYS_MAX = 365;
const shares = (a: string[], b: string[]) => a.find((x) => b.includes(x));

/** Allergies that match a medicine (class or ingredient). */
export function allergyMatches(m: Pick<RxMedicine, "ingredients" | "classes">, allergies: AllergyFact[]): AllergyFact[] {
  return allergies.filter((a) => a.key !== null && ((a.kind === "class" && m.classes.includes(a.key)) || (a.kind === "substance" && m.ingredients.includes(a.key))));
}

/** Every warning on every line, in line order; allergy first within a line. */
export function rxWarnings(lines: RxLine[], allergies: AllergyFact[]): RxWarning[] {
  const out: RxWarning[] = [];
  lines.forEach((r, i) => {
    const m = r.medicine;
    for (const a of allergyMatches(m, allergies)) out.push({ line: r.uid, kind: "allergy", block: true, actions: ["remove"], allergy: a });

    const first = lines.slice(0, i).find((x) => shares(x.medicine.ingredients, m.ingredients));
    if (first) {
      const ingredient = shares(first.medicine.ingredients, m.ingredients)!;
      out.push({ line: r.uid, kind: "same-medicine", block: !r.keepBoth, kept: Boolean(r.keepBoth), actions: r.keepBoth ? ["remove"] : ["remove", "keepBoth"], firstLine: first.uid, firstBrand: first.medicine.brand, ingredient });
    } else {
      for (const c of DUPLICATE_CLASSES) {
        if (!m.classes.includes(c.key)) continue;
        const firstOfClass = lines.findIndex((x) => x.medicine.classes.includes(c.key));
        if (firstOfClass >= 0 && firstOfClass < i) out.push({ line: r.uid, kind: "same-class", block: true, actions: ["remove"], classKey: c.key, textBn: c.bn, textEn: c.en });
      }
    }

    for (const rule of INTERACTIONS_SAMPLE) {
      if (!m.ingredients.includes(rule.flagged)) continue;
      if (!lines.some((x) => x.uid !== r.uid && x.medicine.ingredients.includes(rule.with))) continue;
      const acknowledged = (r.acks ?? []).includes(rule.id);
      out.push({ line: r.uid, kind: "interaction", block: !acknowledged, acknowledged, actions: acknowledged ? [] : ["acknowledge"], ruleId: rule.id, textBn: rule.bn, textEn: rule.en });
    }

    if (!parseDose(r.dose).ok) out.push({ line: r.uid, kind: "dose-invalid", block: true, actions: ["edit"] });
    if (!Number.isInteger(r.days) || r.days < 1 || r.days > RX_DAYS_MAX) out.push({ line: r.uid, kind: "days-invalid", block: true, actions: ["edit"] });
  });
  return out;
}

export const rxBlockers = (lines: RxLine[], allergies: AllergyFact[]): RxWarning[] => rxWarnings(lines, allergies).filter((w) => w.block);

/** Tablets/capsules for the course: per-day amount × days (0 when the dose is not valid). */
export function rxQuantity(dose: string, days: number): number {
  const d = parseDose(dose);
  return d.ok && Number.isInteger(days) && days > 0 ? Math.ceil(d.perDay * days) : 0;
}
