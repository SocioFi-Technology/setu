"use client";
/* Shared by the admin screens (phase 2 slice 3, ADR 0010; prototype Setu Admin): strings, names, money and the server's
   error in the chosen language. Who may change whom, what the checklist needs and which limits are allowed are the
   server's rules (@setu/domain admin.ts) — the screens show its answers. */
import { format } from "@setu/domain";
import { fill } from "@setu/i18n";
import { ApiFailure } from "../../lib/api";
import { useSession } from "../../lib/session";

/** Admin strings: `A("key", { n })` from the adminApp namespace; numbers in vars follow the numerals toggle. */
export function useA() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) =>
    fill(s.t("adminApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}
export function useFmt() {
  const s = useSession();
  const bn = s.numerals === "bn";
  return {
    tk: (p: number) => format.takaFromPaisa(p, { bn }),
    n: (x: number | string) => s.n(x),
    name: (p: { nameBn: string; nameEn: string | null } | null | undefined) => (p ? (s.lang === "bn" ? p.nameBn : p.nameEn ?? p.nameBn) : "—"),
    dateTime: (iso: string | null | undefined) => (iso ? format.dateTime(iso, bn) : "—"),
    date: (iso: string | null | undefined) => (iso ? format.date(iso, bn) : "—"),
  };
}
export function useErr() {
  const s = useSession(); const A = useA();
  return (e: unknown) => (e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : A("error_generic"));
}
/** A write's Idempotency-Key is kept after a network failure or a server error and renewed only after a refusal. */
export const renewKey = (e: unknown) => e instanceof ApiFailure && e.status < 500;
/** taka typed in a box → paisa (whole paisa only), or null */
export function takaToPaisa(v: string): number | null {
  const t = v.trim().replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d))).replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [a, b = ""] = t.split(".");
  return Number(a) * 100 + Number((b + "00").slice(0, 2));
}
export const paisaToInput = (p: number) => (p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2));
