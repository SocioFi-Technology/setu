/* ADR 0014: the seeded wards and bed states, shared by the seed and `pnpm db:reset-e2e` (which must not import the seed). */
export const SEED_WARDS: [string, string, string, string, number, (i: number) => string][] = [
  ["er", "ER", "জরুরি বিভাগ", "ER", 4, (i) => `ER-${i + 1}`],
  ["2a", "Ward 2A", "ওয়ার্ড ২এ", "General", 6, (i) => `2A-${String(i + 1).padStart(2, "0")}`],
  // ADR 0015: the prototype's male ward, where the walkthrough's inpatient (Shahidul Islam, 3B-05) lies
  ["3b", "Ward 3B", "ওয়ার্ড ৩বি", "General", 6, (i) => `3B-${String(i + 1).padStart(2, "0")}`],
  ["cab", "Cabins", "কেবিন", "Cabin", 3, (i) => `Cabin ${201 + i}`],
  ["hdu", "HDU", "এইচডিইউ", "HDU", 3, (i) => `HDU-${i + 1}`],
];
/** The seeded bed states: every bed vacant except 2A-05 (cleaning) and 2A-06 (blocked, O₂ line repair). */
export const SEED_BED_STATES: Record<string, { bedState: "cleaning" | "blocked"; bedNote: string }> = {
  "2A-05": { bedState: "cleaning", bedNote: "Deep clean" }, "2A-06": { bedState: "blocked", bedNote: "O₂ line repair" },
};
/* ADR 0015: the walkthrough's inpatient order set (the prototype's MAR for Shahidul Islam, 3B-05). Sample orders. */
export const SEED_ORDERS: { medicineKey: string; route: string; doseText: string; doseQty: number | null; times: string[]; prn: boolean; prnMaxPer24h: number | null }[] = [
  { medicineKey: "metronidazole", route: "iv", doseText: "500 mg IV over 30 min", doseQty: 1, times: ["06:00", "14:00", "22:00"], prn: false, prnMaxPer24h: null },
  { medicineKey: "ceftriaxone", route: "iv", doseText: "1 g IV", doseQty: 1, times: ["08:00", "20:00"], prn: false, prnMaxPer24h: null },
  { medicineKey: "pantoprazole-iv", route: "iv", doseText: "40 mg IV", doseQty: 1, times: ["08:00"], prn: false, prnMaxPer24h: null },
  { medicineKey: "insulin", route: "sc", doseText: "Soluble insulin SC by sliding scale (RBS)", doseQty: null, times: ["06:00", "12:00", "18:00"], prn: false, prnMaxPer24h: null },
  { medicineKey: "amdocal", route: "oral", doseText: "5 mg by mouth (home medicine)", doseQty: 1, times: ["08:00"], prn: false, prnMaxPer24h: null },
  { medicineKey: "napa", route: "oral", doseText: "500 mg by mouth for pain or fever", doseQty: 1, times: [], prn: true, prnMaxPer24h: 4 },
  { medicineKey: "morphine", route: "iv", doseText: "2.5 mg IV slowly for severe pain", doseQty: 1, times: [], prn: true, prnMaxPer24h: 6 },
];
/** Ward 3B's opening stock (issue units), received as the seed's opening and topped up by the E2E reset. */
export const SEED_WARD_STOCK: Record<string, number> = { metronidazole: 12, ceftriaxone: 8, "pantoprazole-iv": 6, insulin: 2, amdocal: 10, napa: 20, morphine: 5, ns: 6 };
