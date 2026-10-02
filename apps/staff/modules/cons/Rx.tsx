"use client";
/* Prescription builder (walkthrough A5, issues #9 and #16). The warnings come from @setu/domain rxWarnings as the doctor
   types — the sign route runs the same function on the server's own copy of the medicines and allergies, so the screen
   and the API block for the same reasons. "/" focuses the medicine search (the shell leaves "/" to this module). */
import { forwardRef, useEffect, useMemo, useState } from "react";
import type { AllergyView, MedicineSearch } from "@setu/contracts";
import { allergyMatches, rxQuantity, rxWarnings, type RxWarning } from "@setu/domain";
import { Button, Pill } from "@setu/ui";
import { cons } from "../../lib/api";
import { useSession } from "../../lib/session";
import { factsOf, rxLinesOf, useC, type Line } from "./common";

type Hit = MedicineSearch["items"][number];
const MEALS = ["before", "after", "with", "any"] as const;

export const RxBuilder = forwardRef<HTMLInputElement, { lines: Line[]; allergies: AllergyView[]; disabled: boolean; onChange: (l: Line[]) => void }>(
  function RxBuilder({ lines, allergies, disabled, onChange }, searchRef) {
    const s = useSession(); const C = useC();
    const facts = useMemo(() => factsOf(allergies), [allergies]);
    const warnings = useMemo(() => rxWarnings(rxLinesOf(lines), facts), [lines, facts]);
    const [q, setQ] = useState(""); const [hits, setHits] = useState<Hit[] | null>(null); const [active, setActive] = useState(0);
    useEffect(() => {
      if (!q.trim()) { setHits(null); return; }
      const t = window.setTimeout(() => { cons.medicines(q.trim()).then((r) => { setHits(r.items); setActive(0); }).catch(() => setHits([])); }, 150);
      return () => window.clearTimeout(t);
    }, [q]);
    const add = (m: Hit) => {
      onChange([...lines, {
        uid: crypto.randomUUID(), medicine: { key: m.key, brand: m.brand, brandBn: m.brandBn, generic: m.generic, strength: m.strength, form: m.form, ingredients: m.ingredients, classes: m.classes },
        dose: m.defaults.dose, meal: m.defaults.meal, days: m.defaults.days, note: "", keepBoth: false, acks: [],
      }]);
      setQ(""); setHits(null);
    };
    const set = (uid: string, patch: Partial<Line>) => onChange(lines.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));
    const act = (w: RxWarning, a: string) => {
      if (a === "remove") onChange(lines.filter((l) => l.uid !== w.line));
      else if (a === "keepBoth") set(w.line, { keepBoth: true });
      else if (a === "acknowledge" && w.ruleId) { const l = lines.find((x) => x.uid === w.line); if (l) set(w.line, { acks: [...new Set([...l.acks, w.ruleId])] }); }
    };

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {!disabled && (
          <div style={{ position: "relative" }}>
            <input ref={searchRef} className="input" name="rx-search" data-testid="rx-search" style={{ width: "100%" }} placeholder={C("rx_ph")} aria-label={C("rx_ph")}
              value={q} onChange={(e) => setQ(e.target.value)} aria-expanded={hits ? "true" : "false"} aria-controls="rx-hits" role="combobox"
              onKeyDown={(e) => {
                if (e.key === "Escape") { setQ(""); setHits(null); }
                else if (e.key === "ArrowDown" && hits?.length) { e.preventDefault(); setActive((i) => Math.min(i + 1, hits.length - 1)); }
                else if (e.key === "ArrowUp" && hits?.length) { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
                else if (e.key === "Enter" && hits?.[active]) { e.preventDefault(); add(hits[active]!); }
              }} />
            {hits && (
              <div id="rx-hits" role="listbox" aria-label={C("sec_rx")} className="card" style={{ display: "flex", flexDirection: "column", marginTop: 4, padding: 4 }}>
                {hits.length === 0 ? <span className="t-small t-muted" style={{ padding: 8 }}>{C("rx_no_match")}</span> : hits.map((m, i) => {
                  const al = allergyMatches(m, facts);
                  return (
                    <button key={m.key} type="button" role="option" aria-selected={i === active} data-medicine={m.key} className="btn btn-ghost"
                      style={{ justifyContent: "flex-start", height: "auto", padding: "6px 8px", textAlign: "left", gap: 8, background: i === active ? "var(--surface-sunken)" : undefined }}
                      onMouseEnter={() => setActive(i)} onClick={() => add(m)}>
                      <b>{m.form} {m.brand} {m.strength}</b>{s.lang === "bn" && m.brandBn && <span className="t-small">{m.brandBn}</span>}
                      <span className="t-small t-muted">{m.generic} · {m.manufacturer}</span>
                      {al.length > 0 && <Pill tone="bad" icon="triangle-alert">{s.L(al[0]!.labelBn, al[0]!.labelEn)}</Pill>}
                    </button>
                  );
                })}
                <span className="t-small t-muted" style={{ padding: "4px 8px" }}>{C("rx_keys")}</span>
              </div>
            )}
          </div>
        )}

        {lines.length === 0 ? <span className="t-small t-muted">{C("rx_none")}</span> : lines.map((l, n) => {
          const ws = warnings.filter((w) => w.line === l.uid);
          return (
            <div key={l.uid} data-rx-line={l.medicine.key} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0", borderTop: n ? "1px solid var(--border-subtle)" : undefined }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className="t-muted num">{s.n(n + 1)}.</span>
                <span style={{ display: "flex", flexDirection: "column", minWidth: 160, flex: "1 1 160px" }}>
                  <b>{l.medicine.form} {l.medicine.brand} {l.medicine.strength}</b>
                  <span className="t-small t-muted">{l.medicine.generic}</span>
                </span>
                <label className="field" style={{ width: 96 }}>
                  <span className="t-small t-secondary">{C("rx_dose")}</span>
                  <input className="input num" name="rx-dose" disabled={disabled} value={l.dose} onChange={(e) => set(l.uid, { dose: e.target.value })} aria-invalid={ws.some((w) => w.kind === "dose-invalid") ? "true" : undefined} />
                </label>
                <label className="field" style={{ width: 140 }}>
                  <span className="t-small t-secondary">{C("rx_meal")}</span>
                  <select className="input" name="rx-meal" disabled={disabled} value={l.meal} onChange={(e) => set(l.uid, { meal: e.target.value as Line["meal"] })}>
                    {MEALS.map((m) => <option key={m} value={m}>{C(`meal_${m}`)}</option>)}
                  </select>
                </label>
                <label className="field" style={{ width: 72 }}>
                  <span className="t-small t-secondary">{C("rx_days")}</span>
                  <input className="input num" name="rx-days" inputMode="numeric" disabled={disabled} value={Number.isFinite(l.days) && l.days > 0 ? String(l.days) : ""}
                    onChange={(e) => set(l.uid, { days: Number.parseInt(e.target.value.replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d))), 10) || 0 })}
                    aria-invalid={ws.some((w) => w.kind === "days-invalid") ? "true" : undefined} />
                </label>
                <span style={{ display: "flex", flexDirection: "column", width: 56 }}>
                  <span className="t-small t-secondary">{C("rx_qty")}</span>
                  <b className="num">{s.n(rxQuantity(l.dose, l.days) || "—")}</b>
                </span>
                {!disabled && <Button size="sm" variant="ghost" icon="x" aria-label={`${C("remove")} ${l.medicine.brand}`} onClick={() => onChange(lines.filter((x) => x.uid !== l.uid))}>{C("remove")}</Button>}
              </div>
              <input className="input" name="rx-note" style={{ width: "100%" }} placeholder={C("rx_note")} aria-label={C("rx_note")} disabled={disabled} value={l.note} onChange={(e) => set(l.uid, { note: e.target.value })} />
              {ws.map((w, i) => (
                <div key={i} data-warning={w.kind} data-blocking={w.block ? "true" : "false"} role={w.block ? "alert" : undefined}
                  className={w.block ? "callout callout-bad" : "callout"} style={{ padding: "8px 10px", alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ flex: "1 1 240px" }}>{warningText(w, l, C, s.L)}</span>
                  {!disabled && w.actions.filter((a) => a !== "edit").map((a) => (
                    <Button key={a} size="sm" variant={a === "remove" ? "danger" : "default"} onClick={() => act(w, a)}>{C(a === "keepBoth" ? "keep_both" : a)}</Button>
                  ))}
                </div>
              ))}
            </div>
          );
        })}
        <span className="t-small t-muted" data-testid="rx-sample">{C("rx_sample")}</span>
        <span className="t-small t-muted" data-testid="rx-dose-formats">{C("rx_dose_formats")}</span>
      </div>
    );
  });

/** Brand names stay as written on the prescription (English), in both languages. */
export function warningText(w: RxWarning, l: Pick<Line, "medicine">, C: ReturnType<typeof useC>, L: (bn: string, en: string) => string): string {
  const ingredient = w.ingredient ? w.ingredient.charAt(0).toUpperCase() + w.ingredient.slice(1) : "";
  switch (w.kind) {
    case "allergy": return C("w_allergy", { allergy: L(w.allergy!.labelBn, w.allergy!.labelEn), brand: l.medicine.brand });
    case "same-medicine": return w.kept ? C("w_same_kept", { ingredient }) : C("w_same", { first: w.firstBrand ?? "", ingredient });
    case "same-class": return L(w.textBn ?? "", w.textEn ?? "");
    case "interaction": return w.acknowledged ? `${C("w_ack_done")} — ${L(w.textBn ?? "", w.textEn ?? "")}` : L(w.textBn ?? "", w.textEn ?? "");
    case "dose-invalid": return C("w_dose");
    case "days-invalid": return C("w_days");
  }
}
