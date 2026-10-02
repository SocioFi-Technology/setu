/* The printed receipt as HTML (docs/design-handoff/print-specs.md; prototype Setu Billing › Receipt). Two papers:
   A5 VAT invoice (Mushak-6.3, 148 × 210 mm, margins 10 mm, QR 18 mm top-right) and 80 mm thermal (72 mm printable,
   QR 24 mm at the end). Black ink only. Languages: Bangla + English, Bangla, English. Every amount is stored paisa
   printed through @setu/domain format; document numbers stay in Latin digits. Duplicates carry "অনুলিপি · DUPLICATE #n",
   a 10% diagonal watermark and the reprint line. Everything from the record is HTML-escaped (data, never markup). */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { ReceiptSnapshot } from "@setu/contracts";
import { format } from "@setu/domain";
import { t } from "@setu/i18n";

export type ReceiptLangMode = "both" | "bn" | "en";
export interface PrintInfo { copy: number; reason: string | null; printedAt: Date; printedBy: { nameBn: string; nameEn: string } }
export interface TemplateInput { /** ADR 0005: the bill was voided — every copy says VOID */ voided?: boolean; snapshot: ReceiptSnapshot; number: string; createdAt: Date; verifyUrl: string; format: "a5" | "thermal"; lang: ReceiptLangMode; print: PrintInfo }

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/* Fonts: the self-hosted Noto Sans Bengali (Bangla subset) and IBM Plex Sans (Latin subset) from packages/ui, inlined
   so the renderer never fetches anything. */
const FONT_DIR = resolve(process.cwd().replace(/[\\/]apps[\\/]api$/, ""), "packages", "ui", "fonts");
let fontCss: string | null = null;
function fonts(): string {
  if (fontCss !== null) return fontCss;
  const face = (family: string, file: string, range: string) =>
    `@font-face{font-family:'${family}';font-weight:100 900;src:url(data:font/woff2;base64,${readFileSync(resolve(FONT_DIR, file)).toString("base64")}) format('woff2');unicode-range:${range};}`;
  fontCss = face("Noto Sans Bengali", "4801dbf4-01de-479f-b795-f5a8b505f71f.woff2", "U+0951-0952,U+0964-0965,U+0980-09FE,U+1CD0,U+1CD2,U+1CD5-1CD6,U+1CD8,U+1CE1,U+1CEA,U+1CED,U+1CF2,U+1CF5-1CF7,U+200C-200D,U+20B9,U+25CC,U+A8F1")
    + face("IBM Plex Sans", "2879f905-a1f3-4583-b397-b24c91250c8a.woff2", "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD");
  return fontCss;
}

/* QR: qrcode-generator (no dependencies), drawn as an SVG in black. */
const require = createRequire(import.meta.url);
const qrcode = require("qrcode-generator") as (type: number, level: "L" | "M" | "Q" | "H") => { addData(s: string): void; make(): void; createSvgTag(o: { cellSize?: number; margin?: number; scalable?: boolean }): string };
export function qrSvg(text: string): string {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

const fillT = (lang: "bn" | "en", key: string, vars: Record<string, string>) => t(lang, "billingApp", key).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));

export function receiptHtml(i: TemplateInput): string {
  const s = i.snapshot;
  const bnDigits = i.lang === "bn";
  const L = (key: string, vars: Record<string, string> = {}) => {
    const fill = (str: string) => str.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
    const bn = fill(t("bn", "billingApp", key)), en = fill(t("en", "billingApp", key));
    return i.lang === "bn" ? bn : i.lang === "en" ? en : bn === en ? en : `${bn} · ${en}`;
  };
  /** A sentence in both languages goes on two lines instead of one run-on line. */
  const Ls = (key: string, vars: Record<string, string> = {}) => {
    if (i.lang !== "both") return esc(L(key, vars));
    const fill = (str: string) => str.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
    return `${esc(fill(t("bn", "billingApp", key)))}<br>${esc(fill(t("en", "billingApp", key)))}`;
  };
  const tk = (p: number) => format.takaFromPaisa(p, { bn: bnDigits });
  const num = (n: number) => format.digits(n, bnDigits);
  const name = (bn: string | null | undefined, en: string | null | undefined) => (i.lang === "bn" ? bn || en : i.lang === "en" ? en || bn : en && bn && en !== bn ? `${bn} · ${en}` : bn || en) ?? "";
  const when = (d: Date | string) => format.dateTime(d, bnDigits);
  const vatLabel = (bp: number) => (bp === 0 ? L("vat_exempt") : `${num(bp / 100)}%`);
  const method = (m: string) => L(`m_${m}`);
  const dup = i.print.copy > 0;
  const words = (lang: "bn" | "en") => format.wordsPaisa(s.paidPaisa, lang);

  const paidLine = s.paidBy.paid.map((p) => `${esc(method(p.method))} ${esc(tk(p.amountPaisa))}${p.trxId ? ` (${esc(L("r_trx"))} ${esc(p.trxId)})` : p.reference ? ` (${esc(p.reference)})` : ""}`).join(" + ") || "—";
  const pendingLine = s.paidBy.pending.map((p) => `${esc(method(p.method))} ${esc(tk(p.amountPaisa))} ${esc(L("r_pending"))}`).join(" · ");
  const discLine = s.discount && s.discountPaisa > 0
    ? (i.lang === "both"
      ? `${esc(fillT("bn", "r_disc_line", { amount: tk(s.discountPaisa), category: t("bn", "billingApp", `cat_${s.discount.category}`) }))}${s.discount.approvedBy ? ` · ${esc(fillT("bn", "r_disc_approved", { name: s.discount.approvedBy.nameBn }))}` : ""}<br>`
        + `${esc(fillT("en", "r_disc_line", { amount: tk(s.discountPaisa), category: t("en", "billingApp", `cat_${s.discount.category}`) }))}${s.discount.approvedBy ? ` · ${esc(fillT("en", "r_disc_approved", { name: s.discount.approvedBy.nameEn }))}` : ""}`
      : esc(L("r_disc_line", { amount: tk(s.discountPaisa), category: L(`cat_${s.discount.category}`) })) + (s.discount.approvedBy ? ` · ${esc(L("r_disc_approved", { name: name(s.discount.approvedBy.nameBn, s.discount.approvedBy.nameEn) }))}` : ""))
    : "";
  const reprintLine = dup
    ? Ls("r_reprinted", { n: num(i.print.copy), at: when(i.print.printedAt), name: name(i.print.printedBy.nameBn, i.print.printedBy.nameEn), reason: L(`rr_${i.print.reason}`) })
    : Ls("r_printed", { at: when(i.print.printedAt), name: name(i.print.printedBy.nameBn, i.print.printedBy.nameEn) });
  /* Mushak-6.3 (VAT invoice) is printed once per bill — on the receipt that settles it — so two part-payments never
     make two VAT invoices for one sale (review A6–A7; accountant to confirm pre-pilot). Other receipts are money
     receipts. Needs the facility's BIN. */
  const mushak = Boolean(s.seller.vatBin) && s.duePaisa === 0;
  const bin = s.seller.vatBin ? `${esc(L("r_bin"))} ${esc(s.seller.vatBin)}${s.seller.vatBinSample ? ` (${esc(L("r_sample"))})` : ""}` : "";
  const title = i.format === "a5" && mushak ? L("r_vat_invoice") : L("r_money_receipt");
  const voidMark = i.voided ? `<div class="void">${esc(t("bn", "billingApp", "r_void"))} · ${esc(t("en", "billingApp", "r_void"))}</div>` : "";
  const dupTitle = voidMark + (dup ? `<div class="dup">${esc(L("r_duplicate"))} #${num(i.print.copy)}</div>` : "");
  // decision 98: a line not billed here stays on the receipt with its reason and no amount.
  const lineName = (l: ReceiptSnapshot["lines"][number]) => esc(name(l.nameBn, l.nameEn)) + (l.notBilledReason ? ` — ${esc(L("r_not_billed", { reason: l.notBilledReason }))}` : "");
  const lineAmount = (l: ReceiptSnapshot["lines"][number]) => (l.notBilledReason ? "—" : esc(tk(l.grossPaisa)));
  const watermark = i.voided ? `<div class="wm" aria-hidden="true">${esc(t("bn", "billingApp", "r_void"))} · ${esc(t("en", "billingApp", "r_void"))}</div>` : dup ? `<div class="wm" aria-hidden="true">${esc(t("bn", "billingApp", "r_duplicate"))} · ${esc(t("en", "billingApp", "r_duplicate"))}</div>` : "";
  const totals = [
    [L("r_subtotal"), tk(s.subtotalPaisa)],
    ...(s.discountPaisa > 0 ? [[L("r_discount"), `− ${tk(s.discountPaisa)}`]] : []),
    [L("r_vat"), tk(s.vatPaisa)],
    [L("r_total"), tk(s.totalPaisa), "strong"],
    [L("r_paid"), tk(s.paidPaisa)],
    [L("r_due"), tk(s.duePaisa)],
  ].map(([k, v, cls]) => `<tr class="${cls ?? ""}"><td>${esc(k)}</td><td class="r num">${esc(v)}</td></tr>`).join("");
  // The words are of the money received on this receipt, and say so (review A6–A7).
  const wordsHtml = i.lang === "en" ? `<div>${esc(t("en", "billingApp", "r_in_words"))}: ${esc(words("en"))}</div>`
    : i.lang === "bn" ? `<div>${esc(t("bn", "billingApp", "r_in_words"))}: ${esc(words("bn"))}</div>`
    : `<div>${esc(t("bn", "billingApp", "r_in_words"))}: ${esc(words("bn"))}</div><div>${esc(t("en", "billingApp", "r_in_words"))}: ${esc(words("en"))}</div>`;
  const qr = `<div class="qr">${qrSvg(i.verifyUrl)}</div>`;

  const page = i.format === "a5"
    ? `<style>@page{size:148mm 210mm;margin:10mm}body{font-size:10pt}.small{font-size:8.5pt}h1{font-size:13pt}.qr{width:18mm;height:18mm}</style>
      <header class="head">
        <div class="seller"><b>${esc(name(s.seller.nameBn, s.seller.nameEn))}</b>${s.seller.address ? `<div class="small">${esc(s.seller.address)}</div>` : ""}${bin ? `<div class="small">${bin}</div>` : ""}</div>
        ${qr}
      </header>
      <h1>${esc(title)}</h1>${dupTitle}
      <table class="meta small"><tr><td>${esc(L("r_receipt_no"))}</td><td class="num">${esc(i.number)}</td><td>${esc(L("r_bill_no"))}</td><td class="num">${esc(s.invoice.number)}</td></tr>
        <tr><td>${esc(L("r_date"))}</td><td class="num">${esc(when(i.createdAt))}</td><td>${esc(L("r_patient"))}</td><td>${esc(name(s.patient.nameBn, s.patient.nameEn))} · <span class="num">${esc(s.patient.facilityNo)}</span></td></tr></table>
      <table class="lines"><thead><tr><th>#</th><th>${esc(L("r_service"))}</th><th class="r">${esc(L("r_vat"))}</th><th class="r">${esc(L("r_amount"))}</th></tr></thead><tbody>
        ${s.lines.map((l, n) => `<tr><td class="num">${num(n + 1)}</td><td>${lineName(l)}${l.qty > 1 ? ` <span class="num">×${num(l.qty)}</span>` : ""}</td><td class="r">${l.notBilledReason ? "—" : esc(vatLabel(l.vatRateBp))}</td><td class="r num">${lineAmount(l)}</td></tr>`).join("")}
      </tbody></table>
      <table class="totals">${totals}</table>
      ${mushak ? `<table class="vat small"><tr><th>${esc(L("r_vat_breakdown"))}</th><th class="r">${esc(L("r_amount"))}</th><th class="r">${esc(L("r_vat"))}</th></tr>${s.vatByRate.map((v) => `<tr><td>${esc(vatLabel(v.rateBp))}</td><td class="r num">${esc(tk(v.netPaisa))}</td><td class="r num">${esc(tk(v.vatPaisa))}</td></tr>`).join("")}</table>` : ""}
      <div class="words small">${wordsHtml}</div>
      <div class="small"><b>${esc(L("r_paid_by"))}:</b> ${paidLine}${pendingLine ? ` · ${pendingLine}` : ""}</div>
      ${discLine ? `<div class="small">${discLine}</div>` : ""}
      <footer class="foot small"><div>${esc(L("r_scan"))}</div><div class="sign">${esc(name(s.cashier.nameBn, s.cashier.nameEn))}<br>${esc(L("r_cashier"))}</div></footer>
      <div class="small muted">${reprintLine}</div>`
    : `<style>@page{margin:3mm 4mm 6mm 4mm}body{font-size:9pt;width:72mm}.small{font-size:8pt}h1{font-size:11pt;text-align:center}.qr{width:24mm;height:24mm;margin:3mm auto 1mm}</style>
      <div class="c"><b>${esc(name(s.seller.nameBn, s.seller.nameEn))}</b>${s.seller.address ? `<div class="small">${esc(s.seller.address)}</div>` : ""}${bin ? `<div class="small">${bin}</div>` : ""}</div>
      <h1>${esc(title)}</h1>${dupTitle}
      <div class="small">${esc(L("r_receipt_no"))} <span class="num">${esc(i.number)}</span> · ${esc(L("r_bill_no"))} <span class="num">${esc(s.invoice.number)}</span></div>
      <div class="small">${esc(L("r_date"))} <span class="num">${esc(when(i.createdAt))}</span></div>
      <div class="small">${esc(name(s.patient.nameBn, s.patient.nameEn))} · <span class="num">${esc(s.patient.facilityNo)}</span></div>
      <hr><table class="lines small">${s.lines.map((l) => `<tr><td>${lineName(l)}${l.qty > 1 ? ` ×${num(l.qty)}` : ""}</td><td class="r num">${lineAmount(l)}</td></tr>`).join("")}</table><hr>
      <table class="totals small">${totals}</table>
      <div class="words small">${wordsHtml}</div>
      <div class="small"><b>${esc(L("r_paid_by"))}:</b> ${paidLine}${pendingLine ? ` · ${pendingLine}` : ""}</div>
      ${discLine ? `<div class="small">${discLine}</div>` : ""}
      ${qr}<div class="c small">${esc(L("r_scan"))}</div>
      <div class="c small">${esc(L("r_cashier"))}: ${esc(name(s.cashier.nameBn, s.cashier.nameEn))}</div>
      <div class="c small muted">${reprintLine}</div><div class="c small">${esc(L("r_thanks"))}</div>`;

  return `<!doctype html><html lang="${i.lang === "en" ? "en" : "bn"}"><head><meta charset="utf-8"><title>${esc(i.number)}</title><style>${fonts()}
    *{box-sizing:border-box}html,body{margin:0;padding:0;color:#000;background:#fff}
    body{font-family:'IBM Plex Sans','Noto Sans Bengali',sans-serif;line-height:1.45;position:relative}
    .num{font-variant-numeric:tabular-nums}.r{text-align:right}.c{text-align:center}.muted{color:#333}
    h1{margin:3mm 0 1mm}table{width:100%;border-collapse:collapse}td,th{padding:1px 2px;vertical-align:top;text-align:left}
    .head{display:flex;justify-content:space-between;gap:4mm;border-bottom:0.5pt solid #000;padding-bottom:2mm}
    .meta td:nth-child(odd){white-space:nowrap;padding-right:3mm}.lines thead th{border-bottom:0.5pt solid #000}.totals{margin-top:2mm}.totals tr.strong td{font-weight:700;border-top:0.5pt solid #000}
    .vat{margin-top:2mm}.words{margin:2mm 0}.foot{display:flex;justify-content:space-between;margin-top:6mm}.sign{text-align:right}
    .qr svg{width:100%;height:100%;display:block}
    .void{font-weight:800;font-size:16pt;letter-spacing:2px;border:1.5pt solid #000;display:inline-block;padding:1mm 3mm;margin-bottom:1mm}.dup{font-weight:700;letter-spacing:.5px;margin-bottom:1mm}hr{border:0;border-top:0.5pt dashed #000;margin:1.5mm 0}
    .wm{position:fixed;top:40%;left:-10%;width:120%;text-align:center;transform:rotate(-30deg);font-size:28pt;font-weight:700;color:rgba(0,0,0,.1);z-index:0;pointer-events:none}
  </style></head><body>${watermark}${page}</body></html>`;
}
