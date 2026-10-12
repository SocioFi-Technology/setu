/* The Chartis mark and product lockups (ADR 0025): a C held open with the chart line running through the opening.
   Product family: Chartis Health (the company), Chartis HIS (staff app; Clinic · Lite · Pro editions), Chartis Passport
   (patient app), Chartis Link (the network). */
export const BRAND = {
  company: { en: "Chartis Health", bn: "চার্টিস হেলথ" },
  his: { en: "Chartis HIS", bn: "চার্টিস HIS" },
  passport: { en: "Chartis Passport", bn: "চার্টিস পাসপোর্ট" },
  link: { en: "Chartis Link", bn: "চার্টিস লিংক" },
} as const;
export const EDITION: Record<"clinic" | "lite" | "pro", { en: string; bn: string }> = {
  clinic: { en: "Clinic", bn: "ক্লিনিক" }, lite: { en: "Lite", bn: "লাইট" }, pro: { en: "Pro", bn: "প্রো" },
};

export function ChartisMark({ size = 28, tile = "var(--brand-primary, #0e5e52)", line = "var(--brand-accent, #2bb596)", title }: { size?: number; tile?: string; line?: string; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} style={{ flex: "none" }}>
      <rect width="48" height="48" rx="13" fill={tile} />
      <path d="M32.5 15.5 A12 12 0 1 0 32.5 32.5" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
      <polyline points="19,24 26,24 29,18 33,30 36,24 41,24" fill="none" stroke={line} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** the lockup: mark + "Chartis HIS" (+ the plan's edition) — the product name stays in Latin letters in both languages */
export function ChartisLockup({ product = "his", edition, size = 28 }: { product?: keyof typeof BRAND; edition?: string; size?: number }) {
  return (
    <span className="shell-brand" data-brand={product}>
      <ChartisMark size={size} />
      <span>{BRAND[product].en}</span>
      {edition && <span className="edition">{edition}</span>}
    </span>
  );
}
