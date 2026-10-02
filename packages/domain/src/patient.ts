/* Front desk patient rules (slice A1–A3): registration validation, normalisation and the field-level duplicate
   comparison. Pure functions shared by the API (which enforces them) and the staff app (which shows them).
   The thresholds below are Setu decisions, not in the prototype — see docs/open-questions.md (A1–A3). */
import { parseDate, phone as fmtPhone, toEn } from "./format.js";

/* ───────────── normalisation ───────────── */

/** Bangladesh mobile as stored: 10 digits after +880 (e.g. 1711234567), or null when not a valid mobile. */
export const normalizePhone = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  const p = fmtPhone(raw);
  return p.valid ? p.digits : null;
};

const PREFIX = /^(md|mohd|mohammad|muhammad|mst|mosammat|মো|মোঃ|মোহাম্মদ|মুহাম্মদ|মোছাঃ|মোসাম্মৎ|মোসাঃ)\.?\s+/u;
/** For comparison only (never stored): case-folded, without dots, zero-width joiners, extra spaces or a Md./Mst. prefix. */
export const normalizeName = (s: string | null | undefined): string => {
  let n = (s ?? "").normalize("NFC").replace(/‌|‍/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i < 2 && PREFIX.test(n); i++) n = n.replace(PREFIX, "");
  return n.replace(/[.,'’`]/g, "").replace(/\s+/g, " ").trim();
};
export const hasBangla = (s: string) => /[ঀ-৿]/.test(s);

/** ISO yyyy-mm-dd for a dd/mm/yyyy (Bangla or Latin digits) that is a real calendar date, else null. */
export const parseDob = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const d = parseDate(s.trim());
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const digitsOnly = (s: string | null | undefined) => toEn(s ?? "").replace(/\D/g, "");

/** Whole years between an ISO date and `ref` (UTC). */
const yearsBetween = (iso: string, ref: Date) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  let a = ref.getUTCFullYear() - y;
  if (ref.getUTCMonth() + 1 < m || (ref.getUTCMonth() + 1 === m && ref.getUTCDate() < d)) a--;
  return a;
};

/* ───────────── registration validation ───────────── */

export type Sex = "female" | "male" | "other";
export type PhoneOwner = "self" | "family" | "other";
export type IdType = "none" | "nid" | "brn" | "passport";
export interface RegistrationInput {
  nameBn: string; nameEn?: string; sex?: Sex;
  dobMode: "dob" | "age"; dob?: string; ageYears?: string; ageMonths?: string;
  phone?: string; phoneOwner?: PhoneOwner;
  division?: string; district?: string; upazila?: string; addressLine?: string;
  guardian?: { name?: string; relationship?: string; idNo?: string };
  idType?: IdType; idNo?: string;
}
export type RegistrationErrorCode =
  | "name_bn_required" | "name_bn_script" | "sex_required" | "dob_required" | "dob_format" | "dob_future" | "dob_range"
  | "age_required" | "age_range" | "age_months_range" | "phone_required" | "phone_invalid"
  | "division_required" | "district_required" | "upazila_required" | "guardian_name_required" | "guardian_relationship_required" | "id_format";
export interface RegistrationError { field: string; code: RegistrationErrorCode }

const ID_LENGTHS: Record<Exclude<IdType, "none" | "passport">, number[]> = { nid: [10, 13, 17], brn: [17] };
export const GUARDIAN_REQUIRED_UNDER = 18;
export const MAX_AGE_YEARS = 120;

/** Age in whole years from the form (date of birth or approximate age), or null when not determinable. */
export const formAgeYears = (i: RegistrationInput, today: Date): number | null => {
  if (i.dobMode === "dob") { const iso = parseDob(i.dob); return iso ? yearsBetween(iso, today) : null; }
  const y = digitsOnly(i.ageYears);
  return y ? Number(y) : null;
};

/** Every field that blocks the save, in form order. An empty list means the form may be saved. */
export function validateRegistration(i: RegistrationInput, today: Date): RegistrationError[] {
  const e: RegistrationError[] = [];
  const add = (field: string, code: RegistrationErrorCode) => e.push({ field, code });
  const nameBn = (i.nameBn ?? "").trim();
  if (!nameBn) add("nameBn", "name_bn_required"); else if (!hasBangla(nameBn)) add("nameBn", "name_bn_script");
  if (!i.sex) add("sex", "sex_required");
  if (i.dobMode === "dob") {
    const raw = (i.dob ?? "").trim();
    const iso = parseDob(raw);
    if (!raw) add("dob", "dob_required");
    else if (!iso) add("dob", "dob_format");
    else if (new Date(iso + "T00:00:00Z") > today) add("dob", "dob_future");
    else if (yearsBetween(iso, today) > MAX_AGE_YEARS) add("dob", "dob_range");
  } else {
    const y = digitsOnly(i.ageYears), m = digitsOnly(i.ageMonths);
    if (!y) add("ageYears", "age_required"); else if (Number(y) > MAX_AGE_YEARS) add("ageYears", "age_range");
    if (m && Number(m) > 11) add("ageMonths", "age_months_range");
  }
  if (!(i.phone ?? "").trim()) add("phone", "phone_required"); else if (!normalizePhone(i.phone)) add("phone", "phone_invalid");
  if (!i.division) add("division", "division_required");
  if (!i.district) add("district", "district_required");
  if (!i.upazila) add("upazila", "upazila_required");
  const age = formAgeYears(i, today);
  if (age !== null && age >= 0 && age < GUARDIAN_REQUIRED_UNDER) {
    if (!(i.guardian?.name ?? "").trim()) add("guardianName", "guardian_name_required");
    if (!(i.guardian?.relationship ?? "").trim()) add("guardianRelationship", "guardian_relationship_required");
  }
  if (i.idType && i.idType !== "none" && i.idType !== "passport" && (i.idNo ?? "").trim()) {
    if (!/^[\d\s-]+$/.test(toEn(i.idNo!.trim())) || !ID_LENGTHS[i.idType].includes(digitsOnly(i.idNo).length)) add("idNo", "id_format");
  }
  return e;
}

/* ───────────── duplicate comparison ───────────── */

export type FieldStatus = "same" | "similar" | "different" | "missing";
export const MATCH_FIELDS = ["nameBn", "nameEn", "sex", "birth", "guardian", "phone", "address", "id"] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];
export interface MatchRecord {
  nameBn: string; nameEn?: string | null; sex?: Sex | null;
  birthDate?: string | null; approxAgeYears?: number | null; approxAgeAt?: string | null;
  guardianName?: string | null; phone?: string | null; district?: string | null; upazila?: string | null;
  nid?: string | null; birthRegNo?: string | null;
}
export interface Comparison { fields: Record<MatchField, FieldStatus>; score: number; strong: boolean; conflicts: MatchField[]; isGuardian: boolean }

/** Levenshtein distance over code points (Bangla-safe). */
export const editDistance = (a: string, b: string): number => {
  const x = [...a], y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length]!;
};

/** Same when equal after normalisation; Similar when the first word matches or at most 2 letters differ; else Different. */
export const compareNames = (a?: string | null, b?: string | null): FieldStatus => {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return "missing";
  if (x === y) return "same";
  if (x.split(" ")[0] === y.split(" ")[0] || editDistance(x, y) <= 2) return "similar";
  return "different";
};

/** Age in (fractional) years at `now`, from a date of birth or an approximate age recorded at `approxAgeAt`. */
const ageAt = (r: MatchRecord, now: Date): { years: number; exact: boolean } | null => {
  if (r.birthDate) return { years: (now.getTime() - Date.parse(r.birthDate + "T00:00:00Z")) / (365.25 * 864e5), exact: true };
  if (r.approxAgeYears != null) {
    const at = r.approxAgeAt ? Date.parse(r.approxAgeAt) : now.getTime();
    return { years: r.approxAgeYears + (now.getTime() - at) / (365.25 * 864e5), exact: false };
  }
  return null;
};
/** Same date → Same; exact dates within a year → Similar; an approximate age within 2 years → Similar; else Different. */
export const compareBirth = (a: MatchRecord, b: MatchRecord, now: Date): FieldStatus => {
  const x = ageAt(a, now), y = ageAt(b, now);
  if (!x || !y) return "missing";
  if (x.exact && y.exact) {
    if (a.birthDate === b.birthDate) return "same";
    return Math.abs(Date.parse(a.birthDate! + "T00:00:00Z") - Date.parse(b.birthDate! + "T00:00:00Z")) <= 366 * 864e5 ? "similar" : "different";
  }
  return Math.abs(x.years - y.years) <= 2 ? "similar" : "different";
};
const eqOrMissing = (a?: string | null, b?: string | null): FieldStatus => (!a || !b ? "missing" : a.trim().toLowerCase() === b.trim().toLowerCase() ? "same" : "different");

export function compareRecords(subject: MatchRecord, candidate: MatchRecord, now: Date): Comparison {
  const address: FieldStatus = !subject.district || !candidate.district ? "missing"
    : subject.district.toLowerCase() !== candidate.district.toLowerCase() ? "different"
    : subject.upazila && candidate.upazila && subject.upazila.toLowerCase() === candidate.upazila.toLowerCase() ? "same" : "similar";
  const id: FieldStatus = subject.nid && candidate.nid ? eqOrMissing(digitsOnly(subject.nid), digitsOnly(candidate.nid))
    : subject.birthRegNo && candidate.birthRegNo ? eqOrMissing(digitsOnly(subject.birthRegNo), digitsOnly(candidate.birthRegNo)) : "missing";
  const fields: Record<MatchField, FieldStatus> = {
    nameBn: compareNames(subject.nameBn, candidate.nameBn),
    nameEn: compareNames(subject.nameEn, candidate.nameEn),
    sex: eqOrMissing(subject.sex, candidate.sex),
    birth: compareBirth(subject, candidate, now),
    guardian: compareNames(subject.guardianName, candidate.guardianName),
    phone: eqOrMissing(subject.phone, candidate.phone),
    address, id,
  };
  // The candidate is the subject's guardian (a child on a parent's phone): never the same person.
  const g = subject.guardianName ? [compareNames(subject.guardianName, candidate.nameBn), compareNames(subject.guardianName, candidate.nameEn)] : [];
  const isGuardian = g.includes("same");
  const score = MATCH_FIELDS.filter((f) => fields[f] === "same").length;
  return { fields, score, strong: score >= 6, conflicts: MATCH_FIELDS.filter((f) => fields[f] === "different"), isGuardian };
}

export const LINK_REASON_MIN = 10;
/** One click "Same person — link" only when nothing conflicts (walkthrough issue #4). */
export const canLinkDirectly = (c: Comparison) => !c.isGuardian && c.conflicts.length === 0;
/** "Link anyway": only for a conflicting candidate that is not the guardian, with a reason of ≥10 characters. */
export const linkAnywayAllowed = (c: Comparison, reason: string | null | undefined) =>
  !c.isGuardian && c.conflicts.length > 0 && (reason ?? "").trim().length >= LINK_REASON_MIN;
/** A record worth showing as a possible match: same phone or ID, or a name that agrees with a birth that agrees. */
export const isCandidate = (c: Comparison) =>
  c.fields.phone === "same" || c.fields.id === "same" ||
  ((c.fields.nameBn === "same" || c.fields.nameEn === "same" || c.fields.nameBn === "similar" || c.fields.nameEn === "similar") && (c.fields.birth === "same" || c.fields.birth === "similar"));
