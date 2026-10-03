"use client";
/* Shared by the billing screens (slice A6–A7): strings, money and names, status tones, the patient banner. Every amount
   arrives as integer paisa and is printed through @setu/domain format — the screens never add or round money. */
import type { InvoiceView } from "@setu/contracts";
import { format } from "@setu/domain";
import { fill } from "@setu/i18n";
import type { Tone } from "@setu/ui";
import { ApiFailure, bill } from "../../lib/api";
import { useSession } from "../../lib/session";
import { bannerOf, useLabels } from "../fd/common";

/** Billing strings: `B("key", { n })` from the billingApp namespace; numbers in vars follow the numerals toggle. */
export function useB() {
  const s = useSession();
  return (key: string, vars: Record<string, string | number> = {}) =>
    fill(s.t("billingApp", key), Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? s.n(v) : v])));
}
export function useMoney() {
  const s = useSession();
  const bn = s.numerals === "bn";
  return {
    tk: (p: number) => format.takaFromPaisa(p, { bn }),
    name: (p: { nameBn: string; nameEn: string | null } | null | undefined) => (p ? (s.lang === "bn" ? p.nameBn : p.nameEn ?? p.nameBn) : "—"),
    time: (iso: string | null | undefined) => (iso ? format.time(iso, bn) : "—"),
    dateTime: (iso: string | null | undefined) => (iso ? format.dateTime(iso, bn) : "—"),
    words: (p: number) => format.wordsPaisa(p, s.lang),
  };
}
export const INVOICE_TONE: Record<InvoiceView["invoice"]["status"], Tone> = { draft: "draft", issued: "warn", "partially-paid": "pend", balanced: "ok", cancelled: "off", "entered-in-error": "off" };
export const PAY_TONE: Record<string, Tone> = { initiated: "pend", "link-sent": "pend", "waiting-customer": "pend", confirmed: "ok", failed: "bad" };
export const WRITERS = ["cashier", "owner", "admin"];

export function useBanner() {
  const s = useSession(); const L = useLabels();
  return (v: InvoiceView | null) => s.setPatient(v?.encounter ? bannerOf(v.encounter.patient, L) : null);
}
/** Where a bill lives (ADR 0009): the OPD bill screen, the visit's dispense at the pharmacy, or the OTC sale. */
export const billHome = (v: Pick<InvoiceView, "invoice" | "encounter">) =>
  v.invoice.kind === "opd" ? `/m/bill/opd?inv=${encodeURIComponent(v.invoice.id)}`
  : v.invoice.kind === "pharmacy" && v.encounter ? `/m/ph/dispense?enc=${encodeURIComponent(v.encounter.id)}`
  : `/m/ph/otc?inv=${encodeURIComponent(v.invoice.id)}`;
/** Back to a bill known only by its id (receipts): asks the server which kind it is. */
export async function goToBill(push: (href: string) => void, invoiceId: string) {
  try { push(billHome(await bill.view(invoiceId))); } catch { push(`/m/bill/opd?inv=${encodeURIComponent(invoiceId)}`); }
}
/** The server's message in the chosen language. */
export function useErr() {
  const s = useSession(); const B = useB();
  return (e: unknown) => (e instanceof ApiFailure ? s.L(e.body.message_bn, e.body.message_en) : B("error_generic"));
}
