"use client";
/* Shared by the consultation screens (slice A5): strings, the editable form and its mapping to the API, the banner. */
import type { AllergyView, CompositionView, ConsultationView, MedicineSearch, SaveDraftRequest } from "@setu/contracts";
import type { AllergyFact, NoteSections, RxLine, SectionSources } from "@setu/domain";
import { format } from "@setu/domain";
import { fill } from "@setu/i18n";
import type { BannerPatient } from "@setu/ui";
import { useSession } from "../../lib/session";
import { bannerOf, useLabels } from "../fd/common";

/** Consultation strings: `C("key", { n })` from the consultApp namespace; numbers in vars follow the numerals toggle. */
export function useC() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) =>
    fill(s.t("consultApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}
export function useFmt() {
  const s = useSession();
  const bn = s.numerals === "bn";
  return {
    name: (p: { nameBn: string; nameEn: string | null } | null | undefined) => (p ? (s.lang === "bn" ? p.nameBn : p.nameEn ?? p.nameBn) : "—"),
    dateTime: (iso: string | null | undefined) => (iso ? format.dateTime(iso, bn) : "—"),
    time: (iso: string | null | undefined) => (iso ? format.time(iso, bn) : "—"),
    date: (iso: string | null | undefined) => (iso ? format.date(iso, bn) : "—"),
  };
}

export type Medicine = Pick<MedicineSearch["items"][number], "key" | "brand" | "generic" | "strength" | "form" | "ingredients" | "classes"> & { brandBn?: string };
export interface Line { uid: string; medicine: Medicine; dose: string; meal: "before" | "after" | "with" | "any"; days: number; note: string; keepBoth: boolean; acks: string[] }
export interface Dx { code: string; labelBn: string; labelEn: string; codeVerification: string; verificationStatus: "provisional" | "confirmed" }
export interface Order { testCode: string; nameEn: string; nameBn: string; group: string; priority: "routine" | "urgent" | "stat"; note: string; placed: boolean; placedInVersion: number }
/** What the doctor is editing. The server copies labels and medicine data from its own catalogues; this copy is for the screen. */
export interface Form { sections: NoteSections; sources: SectionSources; diagnoses: Dx[]; lines: Line[]; orders: Order[] }

export const formOf = (c: CompositionView): Form => ({
  sections: c.sections, sources: c.sectionSources,
  diagnoses: c.diagnoses.map((d) => ({ ...d })),
  lines: c.medications.map((m) => ({
    uid: m.id, medicine: { key: m.medicineKey, brand: m.brand, generic: m.generic, strength: m.strength, form: m.form, ingredients: m.ingredients, classes: m.classes },
    dose: m.dose, meal: m.meal, days: m.days, note: m.note ?? "", keepBoth: m.keepBoth, acks: m.acks,
  })),
  orders: c.orders.filter((o) => o.status !== "revoked").map((o) => ({ testCode: o.testCode, nameEn: o.nameEn, nameBn: o.nameBn, group: o.group, priority: o.priority, note: o.note ?? "", placed: o.placed, placedInVersion: o.placedInVersion })),
});

/** The save body: keys only (labels and medicine data come from the server's catalogues); only this version's new orders. */
export const bodyOf = (f: Form): Omit<SaveDraftRequest, "rev"> => ({
  sections: f.sections, sectionSources: f.sources,
  diagnoses: f.diagnoses.map((d) => ({ code: d.code, verificationStatus: d.verificationStatus })),
  medications: f.lines.map((l) => ({ medicineKey: l.medicine.key, dose: l.dose, meal: l.meal, days: l.days, ...(l.note.trim() ? { note: l.note.trim() } : {}), ...(l.keepBoth ? { keepBoth: true } : {}), ...(l.acks.length ? { acks: l.acks } : {}) })),
  orders: f.orders.filter((o) => !o.placed).map((o) => ({ testCode: o.testCode, priority: o.priority, ...(o.note.trim() ? { note: o.note.trim() } : {}) })),
});

/** The prescription as the @setu/domain checks see it (the same functions the sign route runs on the server's data). */
export const rxLinesOf = (lines: Line[]): RxLine[] =>
  lines.map((l) => ({ uid: l.uid, medicine: { id: l.medicine.key, brand: l.medicine.brand, generic: l.medicine.generic, strength: l.medicine.strength, form: l.medicine.form, ingredients: l.medicine.ingredients, classes: l.medicine.classes }, dose: l.dose, meal: l.meal, days: l.days, keepBoth: l.keepBoth, acks: l.acks }));
export const activeAllergies = (a: AllergyView[]) => a.filter((x) => x.status === "active");
export const factsOf = (a: AllergyView[]): AllergyFact[] =>
  activeAllergies(a).map((x) => ({ id: x.id, kind: x.kind, key: x.key, labelBn: x.labelBn, labelEn: x.labelEn, reaction: x.reaction, severity: x.severity }));

/** The shell's banner for the visit's patient. No active allergy = "unknown" (null), never NKDA (open question 52). */
export function useBanner() {
  const s = useSession(); const L = useLabels();
  return (v: ConsultationView): BannerPatient => {
    const al = activeAllergies(v.allergies);
    return { ...bannerOf(v.encounter.patient, L), allergies: al.length ? al.map((a) => (s.lang === "bn" ? a.labelBn : a.labelEn)) : null };
  };
}

export const consUrl = (screen: "draft" | "signed" | "amended", encounterId?: string) => `/m/cons/${screen}${encounterId ? `?enc=${encodeURIComponent(encounterId)}` : ""}`;
