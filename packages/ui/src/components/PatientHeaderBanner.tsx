import { Icon } from "./Icon";
import { Pill, type Tone } from "./Pill";
/** Compact patient context banner — the same component under the top bar in every module (round-2 fix #1:
    it shows the patient the mounted screen is about, never a default patient). */
export type IdentityConfidence = "verified" | "unverified" | "possible-duplicate" | "provisional" | "merged";
export interface BannerPatient {
  initials: string; nameBn: string; nameEn: string; ageSex: string; number: string;
  /** null = unknown, [] = NKDA */ allergies: string[] | null; identity: IdentityConfidence; payer?: string; location?: string;
}
const ID: Record<IdentityConfidence, { tone: Tone; icon: string; bn: string; en: string }> = {
  verified: { tone: "ok", icon: "shield-check", bn: "যাচাইকৃত", en: "Verified" },
  unverified: { tone: "warn", icon: "shield-alert", bn: "পরিচয় যাচাই হয়নি", en: "Identity unverified" },
  provisional: { tone: "warn", icon: "shield-alert", bn: "সাময়িক", en: "Provisional" },
  "possible-duplicate": { tone: "warn", icon: "users", bn: "সম্ভাব্য ডুপ্লিকেট", en: "Possible duplicate" },
  merged: { tone: "info", icon: "git-merge", bn: "একত্রিত রেকর্ড", en: "Merged record" },
};
export function PatientHeaderBanner({ p, lang, note }: { p: BannerPatient; lang: "bn" | "en"; note?: string }) {
  const bn = lang === "bn", L = (b: string, e: string) => (bn ? b : e);
  const id = ID[p.identity];
  const al = p.allergies === null
    ? { cls: "allergy unknown", icon: "circle-help", t: L("অ্যালার্জি অজানা", "Allergies unknown") }
    : p.allergies.length === 0
      ? { cls: "allergy none", icon: "shield-check", t: L("কোনো জানা অ্যালার্জি নেই · NKDA", "No known allergies · NKDA") }
      : { cls: "allergy", icon: "triangle-alert", t: L("অ্যালার্জি: ", "Allergy: ") + p.allergies.join(", ") };
  return (
    <div data-component="PatientHeaderBanner/compact" className="pt-banner">
      <span className="avatar" style={{ width: 28, height: 28 }}>{p.initials}</span>
      <b>{bn ? p.nameBn : p.nameEn} · {bn ? p.nameEn : p.nameBn}</b>
      <span className="t-small t-secondary num" style={{ whiteSpace: "nowrap" }}>{p.ageSex} · {p.number}{p.payer ? " · " + p.payer : ""}</span>
      <Pill tone={id.tone} icon={id.icon}>{L(id.bn, id.en)}</Pill>
      <span className={al.cls}><Icon name={al.icon} size={13} />{al.t}</span>
      {p.location && <span className="t-small t-muted" style={{ fontWeight: 500, whiteSpace: "nowrap" }}>{p.location}</span>}
      <span style={{ marginLeft: "auto" }} />
      {note && <span className="t-muted" style={{ font: "500 11px/16px var(--font-sans)", whiteSpace: "nowrap" }}>{note}</span>}
    </div>
  );
}
