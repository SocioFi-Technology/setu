/* Consultation note rules (walkthrough A5). Pure functions shared by the consultation screen and the API:
   - who may open a visit and what opening does (decision 28; Kamrul 02/10/2026: only a doctor opening it moves the
     visit to "With doctor", through ENCOUNTER `start`; re-opening is a no-op);
   - what blocks signing (`signBlockers`): the prescription checks, the AI "I reviewed" tick, free-text allergies that
     the doctor must check themselves, and the minimum content of a note.
   Signing itself is `signDocument` (documents.ts, ADR 0003): draft → final, or → amended for an amendment. */
import type { EncounterState } from "./machines.js";
import { AMEND_REASON_MIN } from "./documents.js";
import { rxBlockers, type AllergyFact, type RxLine, type RxWarning } from "./prescription.js";
import { toEn } from "./format.js";

export type DurationUnit = "d" | "w" | "m" | "y";
export interface Complaint { text: string; duration: { n: number; unit: DurationUnit } | null }
export interface ExamFindings { general: string; cvs: string; chest: string; abdomen: string }
export interface NoteSections { complaints: Complaint[]; history: string; exam: ExamFindings; advice: string; followUp: string }
export const SECTION_KEYS = ["complaints", "history", "exam", "advice", "followUp"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
/** Rule 2: a section that took text from the AI draft keeps `ai-draft` until the doctor ticks "I reviewed" and signs. */
export type SectionSource = "provider-verified" | "ai-draft";
export type SectionSources = Partial<Record<SectionKey, SectionSource>>;
export const emptySections = (): NoteSections => ({ complaints: [], history: "", exam: { general: "", cvs: "", chest: "", abdomen: "" }, advice: "", followUp: "" });

const UNIT: Record<string, DurationUnit> = {
  d: "d", day: "d", days: "d", "দিন": "d", w: "w", wk: "w", week: "w", weeks: "w", "সপ্তাহ": "w",
  m: "m", mo: "m", month: "m", months: "m", "মাস": "m", y: "y", yr: "y", year: "y", years: "y", "বছর": "y",
};
/** "fever 3d", "জ্বর ৩ দিন", "thirst 2 months" → text + duration (prototype). No number → no duration. */
export function parseComplaint(raw: string): Complaint | null {
  const v = raw.trim();
  if (!v) return null;
  const m = toEn(v).match(/^(.*?)[\s,]*(\d{1,3})\s*(d|days?|দিন|w|wk|weeks?|সপ্তাহ|m|mo|months?|মাস|y|yr|years?|বছর)?\s*$/i);
  if (!m || !m[2] || !m[1]!.trim()) return { text: v, duration: null };
  // Keep the text as typed (Bangla digits stay Bangla): cut the same number of characters off the original.
  const text = v.slice(0, m[1]!.trim().length).trim();
  return { text, duration: { n: Number(m[2]), unit: UNIT[(m[3] ?? "d").toLowerCase()] ?? "d" } };
}

/** Opening a consultation (decision 28). `start` is applied only by a doctor, only from waiting / vitals done. */
export type ConsultAccess =
  | { allowed: true; event: "start" | null; assign: boolean; readOnly: boolean }
  | { allowed: false; reason: "other-doctor" | "not-open" };
export function consultAccess(status: EncounterState, practitionerId: string | null, userId: string, isDoctor: boolean): ConsultAccess {
  if (practitionerId && practitionerId !== userId) return { allowed: false, reason: "other-doctor" };
  if (status === "finished") return { allowed: true, event: null, assign: false, readOnly: true };
  if (status === "in-progress") return { allowed: true, event: null, assign: isDoctor && !practitionerId, readOnly: !isDoctor };
  if (status === "arrived" || status === "triaged") return isDoctor ? { allowed: true, event: "start", assign: !practitionerId, readOnly: false } : { allowed: true, event: null, assign: false, readOnly: true };
  return { allowed: false, reason: "not-open" };
}

export const aiSections = (sources: SectionSources): SectionKey[] => SECTION_KEYS.filter((k) => sources[k] === "ai-draft");

export type SignBlocker =
  | { code: "rx"; warning: RxWarning }
  | { code: "no_complaint" } | { code: "no_diagnosis" }
  | { code: "ai_review_required"; sections: SectionKey[] }
  | { code: "uncoded_allergy_check"; allergies: AllergyFact[] }
  | { code: "amend_reason" };
export interface SignCheck {
  sections: NoteSections; sources: SectionSources; diagnoses: { code: string }[]; lines: RxLine[]; allergies: AllergyFact[];
  /** the "I reviewed the text inserted from the AI draft" tick */
  aiReviewed: boolean;
  /** "I checked the medicines against the allergies that are not coded" (free-text allergies) */
  uncodedAllergiesChecked: boolean;
  /** set for an amendment (ADR 0003) */
  amendReason?: string | null; isAmendment?: boolean;
}
/** Everything that stops the Sign button (screen) and the sign route (API, 422). Empty = may sign. */
export function signBlockers(c: SignCheck): SignBlocker[] {
  const out: SignBlocker[] = rxBlockers(c.lines, c.allergies).map((warning) => ({ code: "rx" as const, warning }));
  if (!c.sections.complaints.some((x) => x.text.trim())) out.push({ code: "no_complaint" });
  if (!c.diagnoses.length) out.push({ code: "no_diagnosis" });
  const ai = aiSections(c.sources);
  if (ai.length && !c.aiReviewed) out.push({ code: "ai_review_required", sections: ai });
  const uncoded = c.allergies.filter((a) => a.kind === "other" || a.key === null);
  if (uncoded.length && c.lines.length && !c.uncodedAllergiesChecked) out.push({ code: "uncoded_allergy_check", allergies: uncoded });
  if (c.isAmendment && (c.amendReason ?? "").trim().length < AMEND_REASON_MIN) out.push({ code: "amend_reason" });
  return out;
}
