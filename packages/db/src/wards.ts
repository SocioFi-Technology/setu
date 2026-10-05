/* ADR 0014: the seeded wards and bed states, shared by the seed and `pnpm db:reset-e2e` (which must not import the seed). */
export const SEED_WARDS: [string, string, string, string, number, (i: number) => string][] = [
  ["er", "ER", "জরুরি বিভাগ", "ER", 4, (i) => `ER-${i + 1}`],
  ["2a", "Ward 2A", "ওয়ার্ড ২এ", "General", 6, (i) => `2A-${String(i + 1).padStart(2, "0")}`],
  ["cab", "Cabins", "কেবিন", "Cabin", 3, (i) => `Cabin ${201 + i}`],
  ["hdu", "HDU", "এইচডিইউ", "HDU", 3, (i) => `HDU-${i + 1}`],
];
/** The seeded bed states: every bed vacant except 2A-05 (cleaning) and 2A-06 (blocked, O₂ line repair). */
export const SEED_BED_STATES: Record<string, { bedState: "cleaning" | "blocked"; bedNote: string }> = {
  "2A-05": { bedState: "cleaning", bedNote: "Deep clean" }, "2A-06": { bedState: "blocked", bedNote: "O₂ line repair" },
};
