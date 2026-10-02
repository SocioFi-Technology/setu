import type { ReactNode } from "react";
import { Icon } from "./Icon";
/** Status pill. Tones match the prototype's P() helper: ok warn bad info neu pend final crit high draft off. Always text + icon (never colour alone). */
export type Tone = "ok" | "warn" | "bad" | "info" | "neu" | "pend" | "final" | "crit" | "high" | "draft" | "off";
export function Pill({ tone = "neu", icon, children }: { tone?: Tone; icon?: string; children: ReactNode }) {
  return <span className={`pill${tone !== "neu" ? ` pill-${tone}` : ""}`}>{icon && <Icon name={icon} size={12} />}{children}</span>;
}
export function CountBadge({ n }: { n: string | number }) { return <span className="badge-count num">{n}</span>; }
