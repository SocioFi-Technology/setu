"use client";
/* The bed picker (walkthrough B3): beds by ward, filtered by class; vacant and reserved-for-this-patient beds can be
   picked, cleaning / blocked / occupied never (the reason is written on the card, never colour alone). Shared by the
   ER's admit disposition and the admission desk; the later bed map builds on it. */
import { fill } from "@setu/i18n";
import { Pill, Segmented, type Tone } from "@setu/ui";
import { useSession } from "../../lib/session";

export interface PickBed { id: string; name: string; ward: string; wardBn: string | null; bedClass: string; state: string; pickable: boolean; reason: string | null; mine?: boolean }
export const BED_TONE: Record<string, Tone> = { vacant: "ok", reserved: "pend", occupied: "info", "discharge-pending": "warn", cleaning: "neu", blocked: "off" };
export function useI() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) =>
    fill(s.t("ipdApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}
export function BedPicker({ beds, value, onPick, classes, cls, onClass, disabled }: { beds: PickBed[]; value: string | null; onPick: (id: string) => void; classes: { key: string; nameBn: string; nameEn: string }[]; cls: string; onClass: (c: string) => void; disabled?: boolean }) {
  const s = useSession(); const I = useI();
  const shown = beds.filter((b) => !cls || b.bedClass === cls);
  const wards = [...new Set(shown.map((b) => b.ward))];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }} data-testid="bed-picker">
      <Segmented value={cls} options={[{ value: "", label: s.t("erApp", "bed_class_all") }, ...classes.map((c) => ({ value: c.key, label: s.lang === "bn" ? c.nameBn : c.nameEn }))]} onChange={onClass} label={I("bed_class")} />
      <span className="t-small t-muted">{I("bed_note")}</span>
      {shown.length === 0 && <span className="t-small t-secondary" data-testid="no-bed">{I("no_bed_in_class")}</span>}
      {wards.map((w) => (
        <div key={w} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <b className="t-small">{s.lang === "bn" ? shown.find((b) => b.ward === w)?.wardBn ?? w : w}</b>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
            {shown.filter((b) => b.ward === w).map((b) => {
              const on = b.id === value;
              return (
                <button key={b.id} type="button" className="card" data-bed={b.name} data-bed-id={b.id} data-bed-state={b.state} data-pickable={b.pickable ? "1" : "0"} aria-pressed={on} disabled={disabled || !b.pickable} onClick={() => onPick(b.id)}
                  style={{ textAlign: "left", padding: 10, display: "flex", flexDirection: "column", gap: 4, cursor: b.pickable && !disabled ? "pointer" : "not-allowed", opacity: b.pickable ? 1 : 0.6, outline: on ? "2px solid var(--brand-primary)" : undefined, background: on ? "var(--brand-primary-subtle)" : undefined }}>
                  <span style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "center" }}><b className="num">{b.name}</b><Pill tone={BED_TONE[b.state] ?? "neu"}>{I(`st_${b.state}`)}</Pill></span>
                  <span className="t-small t-muted">{b.bedClass}{b.pickable ? (b.state === "reserved" ? ` · ${I("reserved_for_you")}` : "") : ` · ${I(`reason_${b.reason ?? b.state}`)}`}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
