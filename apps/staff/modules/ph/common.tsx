"use client";
/* Shared by the pharmacy screens (phase 2 slice 2, ADR 0009; prototype Setu Pharmacy): strings, money, the medicine name
   with its sale class, a batch with its state (expired / near expiry as text + icon, never colour alone), and the
   "needs the server" note. Every rule (FEFO, substitution, sale class, what may be posted or approved) comes from
   @setu/domain or the server — the screens only show what the server answered. */
import type { BatchView, MedicineRef } from "@setu/contracts";
import { format } from "@setu/domain";
import { fill } from "@setu/i18n";
import { Callout, Pill, type Tone } from "@setu/ui";
import { ApiFailure } from "../../lib/api";
import { useSession } from "../../lib/session";

/** Pharmacy strings: `P("key", { n })` from the pharmApp namespace; numbers in vars follow the numerals toggle. */
export function useP() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) =>
    fill(s.t("pharmApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}
export function useFmt() {
  const s = useSession();
  const bn = s.numerals === "bn";
  return {
    tk: (p: number) => format.takaFromPaisa(p, { bn }),
    n: (x: number) => s.n(x),
    name: (p: { nameBn: string; nameEn: string | null } | null | undefined) => (p ? (s.lang === "bn" ? p.nameBn : p.nameEn ?? p.nameBn) : "—"),
    time: (iso: string | null | undefined) => (iso ? format.time(iso, bn) : "—"),
    date: (iso: string | null | undefined) => (iso ? format.date(iso, bn) : "—"),
    dateTime: (iso: string | null | undefined) => (iso ? format.dateTime(iso, bn) : "—"),
    /** an expiry day (yyyy-mm-dd) as dd/mm/yyyy */
    day: (d: string) => s.n(d.split("-").reverse().join("/")),
  };
}
/** The server's message in the chosen language. */
export function useErr() {
  const s = useSession(); const P = useP();
  return (e: unknown) => (e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : P("error_generic"));
}
/** taka typed in a box → paisa (whole paisa only), or null */
export function takaToPaisa(v: string): number | null {
  const t = v.trim().replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d)));
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [a, b = ""] = t.split(".");
  return Number(a) * 100 + Number((b + "00").slice(0, 2));
}
export const toInt = (v: string): number | null => { const t = v.trim().replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d))); return /^\d+$/.test(t) ? Number(t) : null; };

const CLASS_TONE: Record<MedicineRef["saleClass"], Tone> = { otc: "ok", rx: "info", ctrl: "bad" };
export function ClassPill({ c }: { c: MedicineRef["saleClass"] }) {
  const P = useP();
  return <span data-sale-class={c}><Pill tone={CLASS_TONE[c]} icon={c === "ctrl" ? "lock" : c === "rx" ? "file-text" : "shopping-bag"}>{P(`class_${c}`)}</Pill></span>;
}
export function MedName({ m, strong = true }: { m: MedicineRef; strong?: boolean }) {
  const P = useP();
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", minWidth: 0 }}>
      <span>{strong ? <b>{m.brand} {m.strength}</b> : <>{m.brand} {m.strength}</>} <span className="t-small t-muted">{m.form}</span></span>
      <span className="t-small t-secondary">{m.generic}{m.sample ? ` · ${P("sample")}` : ""}</span>
    </span>
  );
}
const STATE_TONE: Record<BatchView["state"], Tone> = { usable: "ok", expired: "bad", empty: "off", quarantine: "warn" };
const STATE_ICON: Record<BatchView["state"], string> = { usable: "check", expired: "ban", empty: "circle-dashed", quarantine: "shield-alert" };
/** A batch's state as text + icon; near expiry adds a warning pill. */
export function BatchState({ b }: { b: Pick<BatchView, "state" | "nearExpiry"> }) {
  const P = useP();
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }} data-batch-state={b.state}>
      <Pill tone={STATE_TONE[b.state]} icon={STATE_ICON[b.state]}>{P(`batch_${b.state}`)}</Pill>
      {b.nearExpiry && b.state === "usable" && <Pill tone="warn" icon="hourglass">{P("near_expiry")}</Pill>}
    </span>
  );
}
/** Dispensing, sales, purchasing and counts move stock and money: they need the server (no offline queue). */
export function NeedsServer() {
  const s = useSession(); const P = useP();
  return s.online ? null : <Callout tone="warn" icon="cloud-off" data-testid="needs-server">{P("needs_server")}</Callout>;
}
