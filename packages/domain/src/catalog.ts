/* Sample clinical lists for the consultation (slice A5), copied from docs/prototype/Setu Consultation.dc.html.
   The seed loads them into each tenant's catalogue tables; the API searches those tables and the rules in
   prescription.ts read the stored ingredients and classes, never what a screen sends.

   NOT FOR CLINICAL USE — pre-pilot (HANDOVER known gap 12, decisions D2 and D3 of 02/10/2026):
   - ICD-11: the prototype's 10 codes, `verification: "unverified-prototype"`. A clinician must check every code against
     the WHO ICD-11 browser; production source = the WHO ICD-11 API or a local extract. No code was added or changed.
   - Medicines: a synthetic sample list labelled "sample". It is not a drug database: no DGDA numbers, no prices.
     Production needs a licensed database with DGDA numbers and clinician-approved allergy/interaction rules.
   - Ingredient and class keys (`amoxicillin`, `penicillin`, …) are Setu demo keys, not RxNorm/ATC codes.
   - Tests: Setu keys, not LOINC; no prices until price lists exist (decision 29, slice A6). */

export interface Icd11Entry { code: string; bn: string; en: string; aliases: string; verification: "unverified-prototype" }
export const ICD11_SAMPLE: Icd11Entry[] = ([
  ["5A11", "টাইপ ২ ডায়াবেটিস", "Type 2 diabetes mellitus", "ডায়াবেটিস, বহুমূত্র, sugar, DM"],
  ["BA00", "উচ্চ রক্তচাপ", "Essential hypertension", "প্রেসার, হাই প্রেসার, BP, HTN"],
  ["GC08", "প্রস্রাবে সংক্রমণ", "Urinary tract infection, site not specified", "প্রস্রাবে ইনফেকশন, UTI, প্রস্রাবে জ্বালা"],
  ["GC00", "মূত্রথলির প্রদাহ", "Cystitis", "cystitis, মূত্রথলি"],
  ["GB51", "কিডনির সংক্রমণ", "Acute pyelonephritis", "কিডনি ইনফেকশন, pyelonephritis"],
  ["1A07", "টাইফয়েড জ্বর", "Typhoid fever", "টাইফয়েড, typhoid, enteric"],
  ["1D20", "ডেঙ্গু জ্বর (সতর্ক লক্ষণ ছাড়া)", "Dengue without warning signs", "ডেঙ্গু, dengue"],
  ["DA22", "গ্যাস্ট্রিক / এসিডিটি", "Gastro-oesophageal reflux disease", "গ্যাস্ট্রিক, এসিডিটি, GERD, অম্বল"],
  ["3A00", "রক্তস্বল্পতা (আয়রন)", "Iron deficiency anaemia", "রক্তশূন্যতা, anaemia, anemia"],
  ["CA02", "গলা ব্যথা", "Acute pharyngitis", "গলা ব্যথা, ঠান্ডা, sore throat"],
] as const).map(([code, bn, en, aliases]) => ({ code, bn, en, aliases, verification: "unverified-prototype" as const }));

export type Meal = "before" | "after" | "with" | "any";
/** A medicine on the sample list. `ingredients`: generic ingredient keys (the same-medicine check compares these, so
    Seclo and any other omeprazole match). `classes`: demo class keys used by the allergy and duplicate-class checks. */
export interface MedicineEntry {
  id: string; brand: string; brandBn: string; generic: string; strength: string; form: "Tab." | "Cap."; manufacturer: string;
  ingredients: string[]; classes: string[]; defaults: { dose: string; meal: Meal; days: number }; sample: true;
}
type M = [string, string, string, string, string, "Tab." | "Cap.", string, string[], string[], string, Meal, number];
export const MEDICINES_SAMPLE: MedicineEntry[] = ([
  ["comet", "Comet", "কমেট", "Metformin HCl", "500 mg", "Tab.", "Square", ["metformin"], ["biguanide"], "1+0+1", "after", 30],
  ["comet850", "Comet", "কমেট", "Metformin HCl", "850 mg", "Tab.", "Square", ["metformin"], ["biguanide"], "1+0+1", "after", 30],
  ["ciprocin", "Ciprocin", "সিপ্রোসিন", "Ciprofloxacin", "500 mg", "Tab.", "Square", ["ciprofloxacin"], ["fluoroquinolone"], "1+0+1", "after", 5],
  ["seclo", "Seclo", "সেক্লো", "Omeprazole", "20 mg", "Cap.", "Square", ["omeprazole"], ["ppi"], "1+0+1", "before", 14],
  ["pantonix", "Pantonix", "প্যান্টোনিক্স", "Pantoprazole", "20 mg", "Tab.", "Incepta", ["pantoprazole"], ["ppi"], "1+0+1", "before", 14],
  ["sergel", "Sergel", "সারজেল", "Esomeprazole", "20 mg", "Cap.", "Healthcare", ["esomeprazole"], ["ppi"], "1+0+0", "before", 14],
  ["napa", "Napa", "নাপা", "Paracetamol", "500 mg", "Tab.", "Beximco", ["paracetamol"], [], "1+1+1", "after", 3],
  ["ace", "Ace", "এইস", "Paracetamol", "500 mg", "Tab.", "Square", ["paracetamol"], [], "1+1+1", "after", 3],
  ["moxacil", "Moxacil", "মক্সাসিল", "Amoxicillin", "500 mg", "Cap.", "Square", ["amoxicillin"], ["penicillin"], "1+1+1", "after", 7],
  ["fimoxyl", "Fimoxyl", "ফিমক্সিল", "Amoxicillin", "500 mg", "Cap.", "Incepta", ["amoxicillin"], ["penicillin"], "1+1+1", "after", 7],
  ["cotrim", "Cotrim DS", "কোট্রিম ডিএস", "Sulfamethoxazole + Trimethoprim", "960 mg", "Tab.", "Square", ["sulfamethoxazole", "trimethoprim"], ["sulfonamide"], "1+0+1", "after", 5],
  ["azith", "Azithrocin", "অ্যাজিথ্রোসিন", "Azithromycin", "500 mg", "Tab.", "Beximco", ["azithromycin"], ["macrolide"], "1+0+0", "before", 5],
  ["clopi", "Clopirel", "ক্লোপিরেল", "Clopidogrel", "75 mg", "Tab.", "Incepta", ["clopidogrel"], ["antiplatelet"], "0+1+0", "after", 30],
  ["amdocal", "Amdocal", "অ্যামডোক্যাল", "Amlodipine", "5 mg", "Tab.", "Beximco", ["amlodipine"], ["calcium-channel-blocker"], "0+0+1", "after", 30],
  ["osartil", "Osartil", "ওসারটিল", "Losartan Potassium", "50 mg", "Tab.", "Incepta", ["losartan"], ["arb"], "1+0+0", "after", 30],
] as M[]).map(([id, brand, brandBn, generic, strength, form, manufacturer, ingredients, classes, dose, meal, days]) =>
  ({ id, brand, brandBn, generic, strength, form, manufacturer, ingredients, classes, defaults: { dose, meal, days }, sample: true as const }));

/** Allergy classes a doctor can record (demo keys the sample medicines carry). Any ingredient key can also be recorded
    as a substance. Anything else is recorded as free text and cannot be checked automatically. */
export const ALLERGY_CLASSES: { key: string; bn: string; en: string }[] = [
  { key: "penicillin", bn: "পেনিসিলিন", en: "Penicillin" },
  { key: "sulfonamide", bn: "সালফা", en: "Sulfa drugs" },
];
export const allergyIngredients = (): string[] => [...new Set(MEDICINES_SAMPLE.flatMap((m) => m.ingredients))].sort();

/** Demo interaction rule from the prototype (decision D4): blocks signing until acknowledged on the flagged line.
    Matched on ingredients (omeprazole), not on the brand Seclo. Whether esomeprazole should match too is for a
    clinician (open question 53). */
export interface InteractionRule { id: string; flagged: string; with: string; bn: string; en: string }
export const INTERACTIONS_SAMPLE: InteractionRule[] = [
  { id: "clopidogrel-omeprazole", flagged: "clopidogrel", with: "omeprazole",
    bn: "ক্লোপিডোগ্রেল + ওমিপ্রাজল — ওমিপ্রাজল ক্লোপিডোগ্রেলের কার্যকারিতা কমাতে পারে। প্যান্টোপ্রাজল বিবেচনা করুন।",
    en: "Clopidogrel + Omeprazole — omeprazole can reduce clopidogrel's antiplatelet effect. Consider Pantoprazole." },
];
/** Classes where two different medicines together are a duplicate (prototype: two PPIs). */
export const DUPLICATE_CLASSES: { key: string; bn: string; en: string }[] = [
  { key: "ppi", bn: "দুটি প্রোটন-পাম্প ইনহিবিটর একসাথে দেওয়া হয়েছে।", en: "Two proton-pump inhibitors are prescribed together." },
];

export type TestGroup = "lab" | "imaging" | "other";
/** Orderable tests. Names stay in English in both languages (as written on Bangladeshi request slips; open question 55). */
export interface TestEntry { code: string; nameEn: string; nameBn: string; group: TestGroup }
export const TESTS_SAMPLE: TestEntry[] = ([
  ["cbc", "CBC", "lab"], ["rbs", "RBS", "lab"], ["hba1c", "HbA1c", "lab"], ["lipid", "Lipid profile", "lab"],
  ["creat", "S. Creatinine", "lab"], ["elec", "S. Electrolytes", "lab"], ["ure", "Urine R/E", "lab"], ["urinecs", "Urine C/S", "lab"],
  ["tsh", "TSH", "lab"], ["sgpt", "SGPT", "lab"],
  ["cxr", "X-ray chest PA", "imaging"], ["usgwa", "USG whole abdomen", "imaging"], ["usgkub", "USG KUB", "imaging"],
  ["ecg", "ECG", "other"], ["echo", "Echocardiogram", "other"], ["fundus", "Fundoscopy", "other"],
] as [string, string, TestGroup][]).map(([code, nameEn, group]) => ({ code, nameEn, nameBn: nameEn, group }));

/** The search the API runs over a catalogue (lowercase substring over the given fields; Bangla or English). */
export function catalogMatch(q: string, ...fields: (string | null | undefined)[]): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return false;
  return fields.filter(Boolean).join(" ").toLowerCase().includes(t);
}
