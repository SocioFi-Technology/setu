"use client";
/* Shared by the ER screens (ADR 0014): strings, the banner for an ER patient (allergies from the visit view when
   known), level pills from the sample scale, time helpers. */
import type { ErBoardItem, ErVisitView } from "@setu/contracts";
import { format, waitedMinutes } from "@setu/domain";
import { fill } from "@setu/i18n";
import { Pill, type BannerPatient, type Tone } from "@setu/ui";
import { ApiFailure } from "../../lib/api";
import { useSession } from "../../lib/session";
import { toBanner, useLabels } from "../fd/common";

export function useE() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) =>
    fill(s.t("erApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}
export function useErr() {
  const s = useSession(); const E = useE();
  return (e: unknown) => (e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : E("error_generic"));
}
export const LEVEL_TONE: Record<string, Tone> = { crit: "crit", bad: "bad", warn: "warn", info: "info", neu: "neu" };
export function LevelPill({ level, scale }: { level: number | null; scale: ErBoardItem extends never ? never : { levels: { level: number; nameBn: string; nameEn: string; tone: string; icon: string }[] } }) {
  const s = useSession(); const E = useE();
  const l = scale.levels.find((x) => x.level === level);
  if (!l) return <span data-level="none"><Pill tone="neu" icon="circle-dashed">{E("untriaged")}</Pill></span>;
  return <span data-level={l.level}><Pill tone={LEVEL_TONE[l.tone] ?? "neu"} icon={l.icon}>{s.lang === "bn" ? l.nameBn : l.nameEn}</Pill></span>;
}
/** The shell banner for an ER patient: location = the bay, allergies when the visit view knows them. */
export function erBanner(item: ErBoardItem, L: ReturnType<typeof useLabels>, allergies?: ErVisitView["allergies"], lang: "bn" | "en" = "bn"): BannerPatient {
  const b = toBanner(item.patient, `${L.age(item.patient)} ${L.sex(item.patient.sex)}`);
  return { ...b, location: item.bay ? `ER · ${item.bay.name}` : "ER", allergies: allergies ? allergies.filter((a) => a.status === "active").map((a) => (lang === "bn" ? a.labelBn : a.labelEn)) : null };
}
export const waitedNow = (item: ErBoardItem) => waitedMinutes(item.arrivedAt, new Date());
export const hhmm = (iso: string | null | undefined, bn: boolean) => (iso ? format.time(iso, bn) : "—");
export { useLabels };
