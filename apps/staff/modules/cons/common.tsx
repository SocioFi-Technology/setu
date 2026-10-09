"use client";
/* Shared by the consultation screens (slice A5): strings, the editable form and its mapping to the API, the banner. */
import { createContext, useContext } from "react";
import { SaveDraftRequest, type AllergyView, type CompositionView, type ConsultationView, type MedicineSearch } from "@setu/contracts";
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
/** performer (ADR 0022): in-house, or a Setu network centre the patient picks */
export interface Order { testCode: string; nameEn: string; nameBn: string; group: string; priority: "routine" | "urgent" | "stat"; note: string; placed: boolean; placedInVersion: number; performer?: "in-house" | "network" }
/** What the doctor is editing. The server copies labels and medicine data from its own catalogues; this copy is for the screen. */
export interface Form { sections: NoteSections; sources: SectionSources; diagnoses: Dx[]; lines: Line[]; orders: Order[] }

export const formOf = (c: CompositionView): Form => ({
  sections: c.sections, sources: c.sectionSources,
  diagnoses: c.diagnoses.map((d) => ({ ...d })),
  lines: c.medications.map((m) => ({
    uid: m.id, medicine: { key: m.medicineKey, brand: m.brand, generic: m.generic, strength: m.strength, form: m.form, ingredients: m.ingredients, classes: m.classes },
    dose: m.dose, meal: m.meal, days: m.days, note: m.note ?? "", keepBoth: m.keepBoth, acks: m.acks,
  })),
  orders: c.orders.filter((o) => o.status !== "revoked").map((o) => ({ testCode: o.testCode, nameEn: o.nameEn, nameBn: o.nameBn, group: o.group, priority: o.priority, note: o.note ?? "", placed: o.placed, placedInVersion: o.placedInVersion, performer: o.performer })),
});

/** The save body: keys only (labels and medicine data come from the server's catalogues); only this version's new orders. */
export const bodyOf = (f: Form): Omit<SaveDraftRequest, "rev"> => ({
  sections: f.sections, sectionSources: f.sources,
  diagnoses: f.diagnoses.map((d) => ({ code: d.code, verificationStatus: d.verificationStatus })),
  medications: f.lines.map((l) => ({ medicineKey: l.medicine.key, dose: l.dose, meal: l.meal, days: l.days, ...(l.note.trim() ? { note: l.note.trim() } : {}), ...(l.keepBoth ? { keepBoth: true } : {}), ...(l.acks.length ? { acks: l.acks } : {}) })),
  orders: f.orders.filter((o) => !o.placed).map((o) => ({ testCode: o.testCode, priority: o.priority, performer: o.performer ?? "in-house", ...(o.note.trim() ? { note: o.note.trim() } : {}) })),
});

/** A device copy read back from localStorage is untrusted (security review A5): only a well-formed form is loaded. */
export function isForm(x: unknown): x is Form {
  const f = x as Form | null;
  return Boolean(f && typeof f === "object" && f.sections && Array.isArray(f.sections.complaints) && typeof f.sections.history === "string"
    && f.sections.exam && typeof f.sections.advice === "string" && typeof f.sections.followUp === "string" && f.sources && typeof f.sources === "object"
    && Array.isArray(f.diagnoses) && Array.isArray(f.orders) && Array.isArray(f.lines)
    && f.lines.every((l) => l && typeof l.uid === "string" && l.medicine && typeof l.medicine.key === "string" && Array.isArray(l.medicine.ingredients) && Array.isArray(l.medicine.classes))
    && SaveDraftRequest.omit({ rev: true }).safeParse(bodyOf(f)).success);
}
/** Which parts of the note differ between two copies (string keys of the section titles). */
export function changedParts(a: Form, b: Form): string[] {
  const x = bodyOf(a), y = bodyOf(b), same = (p: unknown, q: unknown) => JSON.stringify(p) === JSON.stringify(q);
  const out: string[] = [];
  if (!same(x.sections.complaints, y.sections.complaints)) out.push("sec_complaints");
  if (!same(x.sections.history, y.sections.history)) out.push("sec_history");
  if (!same(x.sections.exam, y.sections.exam)) out.push("sec_exam");
  if (!same(x.diagnoses, y.diagnoses)) out.push("sec_dx");
  if (!same(x.orders, y.orders)) out.push("sec_orders");
  if (!same(x.medications, y.medications)) out.push("sec_rx");
  if (!same(x.sections.advice, y.sections.advice)) out.push("sec_advice");
  if (!same(x.sections.followUp, y.sections.followUp)) out.push("sec_followup");
  return out;
}

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

/** Where the note editor sends the doctor: the desk screens (cons/*) or the doctor app (doc/*, slice A12–A13), which
    also lays the editor out for a phone (sticky name + allergy strip, "Sign & send", room for the tab bar). */
export interface ConsNav { phone: boolean; list: () => string; draft: (encounterId: string) => string; signed: (encounterId: string) => string }
export const DESK_NAV: ConsNav = { phone: false, list: () => consUrl("draft"), draft: (e) => consUrl("draft", e), signed: (e) => consUrl("signed", e) };
export const ConsNavContext = createContext<ConsNav>(DESK_NAV);
export const useConsNav = () => useContext(ConsNavContext);
