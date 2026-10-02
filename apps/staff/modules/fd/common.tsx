"use client";
/* Shared by the front desk screens (slice A1–A3): strings, labels, the banner patient, the address lists. */
import type { PatientSummary, QueueItem } from "@setu/contracts";
import { fill } from "@setu/i18n";
import type { BannerPatient, Tone } from "@setu/ui";
import { useSession } from "../../lib/session";

/** Register-form prefill handed over from search (sessionStorage, read once). */
export const PREFILL_KEY = "setu.fd.prefill";
export function takePrefill(): { phone?: string; nameBn?: string; nameEn?: string } {
  try { const v = sessionStorage.getItem(PREFILL_KEY); sessionStorage.removeItem(PREFILL_KEY); return v ? JSON.parse(v) : {}; } catch { return {}; }
}

/** Front desk strings: `T("key", { n })` from the frontDeskApp namespace; numbers in vars follow the numerals toggle. */
export function useT() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) =>
    fill(s.t("frontDeskApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}

type Agey = Pick<PatientSummary, "birthDate" | "approxAgeYears" | "approxAgeAt">;
/** Age in whole years now, and whether it is approximate. */
export function ageOf(p: Agey, now = new Date()): { y: number; approx: boolean } | null {
  if (p.birthDate) {
    const [y, m, d] = p.birthDate.split("-").map(Number) as [number, number, number];
    let a = now.getFullYear() - y;
    if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) a--;
    return { y: a, approx: false };
  }
  if (p.approxAgeYears != null) {
    const extra = p.approxAgeAt ? Math.floor((now.getTime() - Date.parse(p.approxAgeAt)) / (365.25 * 864e5)) : 0;
    return { y: p.approxAgeYears + Math.max(0, extra), approx: true };
  }
  return null;
}
export function useLabels() {
  const T = useT();
  return {
    age: (p: Agey) => { const a = ageOf(p); return a ? T(a.approx ? "approx_years_short" : "years_short", { n: a.y }) : "—"; },
    sex: (x: string) => T(`sex_${x}`),
    rel: (r: string | null | undefined) => (r ? (T(`rel_${r}`) === `rel_${r}` ? r : T(`rel_${r}`)) : "—"),
    phone: (d: string | null) => (d ? `0${d.slice(0, 4)}-${d.slice(4)}` : "—"),
  };
}

export const initials = (en: string | null, bn: string) =>
  (en ?? "").split(/\s+/).filter((w) => w && !/^(md|mst)\.?$/i.test(w)).map((w) => w[0]!.toUpperCase()).slice(0, 2).join("") || bn.slice(0, 1);

/** The shell's patient banner for a front desk patient. Allergies are not known at the desk (null = unknown). */
export function toBanner(p: Pick<PatientSummary, "nameBn" | "nameEn" | "facilityNo" | "sex" | "birthDate" | "approxAgeYears" | "approxAgeAt" | "identityConfidence">, ageSex: string): BannerPatient {
  return { initials: initials(p.nameEn, p.nameBn), nameBn: p.nameBn, nameEn: p.nameEn ?? "", ageSex, number: p.facilityNo, allergies: null, identity: p.identityConfidence };
}
export const bannerOf = (p: QueueItem["patient"] | PatientSummary, L: ReturnType<typeof useLabels>) => toBanner(p, `${L.age(p)} ${L.sex(p.sex)}`);

/** Flags shown on a result row, most important first. */
export function flagsOf(p: PatientSummary): { key: string; tone: Tone; icon: string }[] {
  const out: { key: string; tone: Tone; icon: string }[] = [];
  if (p.identityConfidence === "possible-duplicate") out.push({ key: "flag_dup", tone: "warn", icon: "users" });
  const a = ageOf(p);
  if (a && a.y < 18 && p.guardian) out.push({ key: "flag_child", tone: "info", icon: "baby" });
  if (a?.approx) out.push({ key: "flag_approx", tone: "neu", icon: "circle-help" });
  if (p.identityConfidence === "verified") out.push({ key: "flag_verified", tone: "ok", icon: "shield-check" });
  if (p.identityConfidence === "unverified") out.push({ key: "flag_unverified", tone: "neu", icon: "shield-alert" });
  if (p.identityConfidence === "provisional") out.push({ key: "flag_provisional", tone: "warn", icon: "shield-alert" });
  return out;
}

/* Division → district → upazila (the prototype's list). Values are stored in English; labels are bilingual. */
type Place = [value: string, bn: string];
export const PLACES: Record<string, { bn: string; districts: Record<string, { bn: string; upazilas: Place[] }> }> = {
  Dhaka: { bn: "ঢাকা", districts: {
    Dhaka: { bn: "ঢাকা", upazilas: [["Mirpur", "মিরপুর"], ["Pallabi", "পল্লবী"], ["Dhanmondi", "ধানমন্ডি"], ["Uttara", "উত্তরা"], ["Savar", "সাভার"]] },
    Gazipur: { bn: "গাজীপুর", upazilas: [["Gazipur Sadar", "গাজীপুর সদর"], ["Kaliakair", "কালিয়াকৈর"], ["Tongi", "টঙ্গী"]] },
  } },
  Chattogram: { bn: "চট্টগ্রাম", districts: {
    Chattogram: { bn: "চট্টগ্রাম", upazilas: [["Panchlaish", "পাঁচলাইশ"], ["Kotwali", "কোতোয়ালী"], ["Hathazari", "হাটহাজারী"], ["Patiya", "পটিয়া"]] },
    "Cox's Bazar": { bn: "কক্সবাজার", upazilas: [["Cox's Bazar Sadar", "কক্সবাজার সদর"], ["Teknaf", "টেকনাফ"]] },
  } },
  Sylhet: { bn: "সিলেট", districts: {
    Sylhet: { bn: "সিলেট", upazilas: [["Sylhet Sadar", "সিলেট সদর"], ["Beanibazar", "বিয়ানীবাজার"]] },
    Moulvibazar: { bn: "মৌলভীবাজার", upazilas: [["Sreemangal", "শ্রীমঙ্গল"], ["Kulaura", "কুলাউড়া"]] },
  } },
};
export const placeLabel = (value: string, bn: string, lang: "bn" | "en") => (lang === "bn" ? `${bn} · ${value}` : value);

/** Bangladesh mobile operator from the 3rd digit after 01 (prototype rule). */
export const operatorOf = (digits10: string) => ({ "3": "Grameenphone", "7": "Grameenphone", "4": "Banglalink", "9": "Banglalink", "6": "Airtel", "8": "Robi", "5": "Teletalk" } as Record<string, string>)[digits10[1] ?? ""] ?? "";
