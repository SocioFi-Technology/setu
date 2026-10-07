/* AI drafts behind an interface (CLAUDE.md: external services sit in adapters with a Fake* in dev and tests). Whatever
   the adapter returns is a DRAFT — not a diagnosis: the route labels it, records it with Provenance source `ai-draft`,
   and text the doctor inserts keeps `ai-draft` on its section until they tick "I reviewed" and sign (rule 2).
   No audio is recorded or stored (decision 34): the scribe's "Patient agreed to recording" tick is shown disabled,
   "not available yet", and no consent is stored until the lawyer's wording exists (Kamrul, 02/10/2026). */

import { config } from "../config.js";

export interface AiContext {
  complaints: { text: string; duration: { n: number; unit: string } | null }[];
  allergies: { labelBn: string; labelEn: string; reaction: string | null }[];
  diagnoses: { code: string; labelBn: string; labelEn: string; at: string }[];
  medicines: { brand: string; strength: string; dose: string }[];
  vitals: { code: string; value: number; unit: string }[];
}
export interface AiDraft {
  summary: { textBn: string; textEn: string; source: string }[];
  proposals: { history?: string; exam?: { general?: string; abdomen?: string } };
}
export interface AiDrafter { model: string; draft(kind: "previsit" | "note", ctx: AiContext): Promise<AiDraft> }

const UNIT_EN: Record<string, string> = { d: "day(s)", w: "week(s)", m: "month(s)", y: "year(s)" };
const join = (xs: string[]) => xs.join(", ");

/** Deterministic drafts built only from this patient's own stored data and what the doctor typed — it never adds a
    fact the record does not hold, so a dev/test draft cannot put another patient's sample story into a note. */
export const FakeAi: AiDrafter = {
  model: "fake-ai-v1",
  async draft(kind, ctx) {
    const summary: AiDraft["summary"] = [];
    if (ctx.allergies.length) summary.push({
      textBn: `অ্যালার্জি: ${join(ctx.allergies.map((a) => a.labelBn + (a.reaction ? ` (${a.reaction})` : "")))}`,
      textEn: `Allergies: ${join(ctx.allergies.map((a) => a.labelEn + (a.reaction ? ` (${a.reaction})` : "")))}`, source: "allergy-list" });
    else summary.push({ textBn: "অ্যালার্জির তথ্য নেই — রোগীকে জিজ্ঞেস করুন", textEn: "No allergies recorded — ask the patient", source: "allergy-list" });
    if (ctx.diagnoses.length) summary.push({ textBn: `আগের রোগনির্ণয়: ${join(ctx.diagnoses.map((d) => d.labelBn))}`, textEn: `Earlier diagnoses: ${join(ctx.diagnoses.map((d) => d.labelEn))}`, source: "signed-notes" });
    if (ctx.medicines.length) summary.push({ textBn: `চলমান ওষুধ: ${join(ctx.medicines.map((m) => `${m.brand} ${m.strength} ${m.dose}`))}`, textEn: `Current medicines: ${join(ctx.medicines.map((m) => `${m.brand} ${m.strength} ${m.dose}`))}`, source: "signed-notes" });
    if (ctx.vitals.length) summary.push({ textBn: `আজকের ভাইটাল: ${join(ctx.vitals.map((v) => `${v.code} ${v.value} ${v.unit}`))}`, textEn: `Vitals today: ${join(ctx.vitals.map((v) => `${v.code} ${v.value} ${v.unit}`))}`, source: "vitals" });
    if (kind === "previsit") return { summary, proposals: {} };
    const complaints = ctx.complaints.map((c) => c.text + (c.duration ? ` for ${c.duration.n} ${UNIT_EN[c.duration.unit] ?? ""}` : ""));
    return {
      summary,
      proposals: {
        history: complaints.length ? `Presents with ${join(complaints)}.${ctx.diagnoses.length ? ` Known ${join(ctx.diagnoses.map((d) => d.labelEn))}.` : ""}` : undefined,
        exam: { general: "To be examined — record findings." },
      },
    };
  },
};

/** The configured drafter, or null with AI_PROVIDER=off (external review A1: production never runs the fake). The Claude
    adapter (AI_PROVIDER=claude) is a later change. */
export const aiDrafter = (): AiDrafter | null => (config.adapters.ai === "off" ? null : FakeAi);
export const aiEnabled = () => aiDrafter() !== null;
