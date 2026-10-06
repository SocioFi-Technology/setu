/* ADR 0017 prints. The deposit receipt: a money receipt (not a VAT invoice) for one confirmed deposit on the running IPD
   bill — A5 or 80 mm, like the receipt (receipts/template.ts): languages, fonts, QR to the public check, "অনুলিপি ·
   DUPLICATE #n" with the watermark. The interim bill (decision 10): A4, "INTERIM BILL — not a final bill", no QR (print
   specs: no QR until final), the live lines by date with their tags, totals and deposits; a reprint is a DUPLICATE
   with its reason. Black ink only; everything from the record is HTML-escaped. */
import type { DepositReceiptSnapshot } from "@setu/contracts";
import { format } from "@setu/domain";
import { t } from "@setu/i18n";
import { esc, fonts, qrSvg, type PrintInfo, type ReceiptLangMode } from "./template.js";

function helpers(lang: ReceiptLangMode) {
  const bnDigits = lang === "bn";
  const fill = (str: string, vars: Record<string, string>) => str.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
  const L = (key: string, vars: Record<string, string> = {}) => {
    const bn = fill(t("bn", "billingApp", key), vars), en = fill(t("en", "billingApp", key), vars);
    return lang === "bn" ? bn : lang === "en" ? en : bn === en ? en : `${bn} · ${en}`;
  };
  const Ls = (key: string, vars: Record<string, string> = {}) =>
    lang !== "both" ? esc(L(key, vars)) : `${esc(fill(t("bn", "billingApp", key), vars))}<br>${esc(fill(t("en", "billingApp", key), vars))}`;
  const tk = (p: number) => (p < 0 ? `−${format.takaFromPaisa(-p, { bn: bnDigits })}` : format.takaFromPaisa(p, { bn: bnDigits }));
  const num = (n: number) => format.digits(n, bnDigits);
  const name = (bn: string | null | undefined, en: string | null | undefined) => (lang === "bn" ? bn || en : lang === "en" ? en || bn : en && bn && en !== bn ? `${bn} · ${en}` : bn || en) ?? "";
  const when = (d: Date | string) => format.dateTime(d, bnDigits);
  const day = (d: string) => format.date(d, bnDigits);
  return { L, Ls, tk, num, name, when, day };
}
const dupParts = (lang: ReceiptLangMode, L: (k: string) => string, num: (n: number) => string, print: PrintInfo) => ({
  dup: print.copy > 0 ? `<div class="dup">${esc(L("r_duplicate"))} #${num(print.copy)}</div>` : "",
  wm: print.copy > 0 ? `<div class="wm" aria-hidden="true">${esc(t("bn", "billingApp", "r_duplicate"))} · ${esc(t("en", "billingApp", "r_duplicate"))}</div>` : "",
});
const page = (lang: ReceiptLangMode, title: string, body: string) => `<!doctype html><html lang="${lang === "en" ? "en" : "bn"}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${fonts()}
    *{box-sizing:border-box}html,body{margin:0;padding:0;color:#000;background:#fff}
    body{font-family:'IBM Plex Sans','Noto Sans Bengali',sans-serif;line-height:1.45;position:relative}
    .num{font-variant-numeric:tabular-nums}.r{text-align:right}.c{text-align:center}.muted{color:#333}
    h1{margin:3mm 0 1mm}table{width:100%;border-collapse:collapse}td,th{padding:1px 2px;vertical-align:top;text-align:left}
    .head{display:flex;justify-content:space-between;gap:4mm;border-bottom:0.5pt solid #000;padding-bottom:2mm}
    .meta td:nth-child(odd){white-space:nowrap;padding-right:3mm}.lines thead th{border-bottom:0.5pt solid #000}.totals{margin-top:2mm}.totals tr.strong td{font-weight:700;border-top:0.5pt solid #000}
    .words{margin:2mm 0}.qr svg{width:100%;height:100%;display:block}.tag{font-size:7.5pt;border:0.5pt solid #000;border-radius:2pt;padding:0 2pt;white-space:nowrap}
    .dup{font-weight:700;letter-spacing:.5px;margin-bottom:1mm}hr{border:0;border-top:0.5pt dashed #000;margin:1.5mm 0}.day td{padding-top:2mm;font-weight:700}
    .wm{position:fixed;top:40%;left:-10%;width:120%;text-align:center;transform:rotate(-30deg);font-size:28pt;font-weight:700;color:rgba(0,0,0,.1);z-index:0;pointer-events:none}
  </style></head><body>${body}</body></html>`;

export interface DepositPrintInput { snapshot: DepositReceiptSnapshot; number: string; createdAt: Date; verifyUrl: string; format: "a5" | "thermal"; lang: ReceiptLangMode; print: PrintInfo }
export function depositReceiptHtml(i: DepositPrintInput): string {
  const s = i.snapshot;
  const { L, Ls, tk, num, name, when } = helpers(i.lang);
  const { dup, wm } = dupParts(i.lang, L, num, i.print);
  const words = i.lang === "both"
    ? `<div>${esc(t("bn", "billingApp", "dr_words"))}: ${esc(format.wordsPaisa(s.amountPaisa, "bn"))}</div><div>${esc(t("en", "billingApp", "dr_words"))}: ${esc(format.wordsPaisa(s.amountPaisa, "en"))}</div>`
    : `<div>${esc(t(i.lang, "billingApp", "dr_words"))}: ${esc(format.wordsPaisa(s.amountPaisa, i.lang))}</div>`;
  const how = `${esc(L(`m_${s.method}`))}${s.trxId ? ` · ${esc(L("r_trx"))} <span class="num">${esc(s.trxId)}</span>` : s.reference ? ` · ${esc(L("dr_ref"))} ${esc(s.reference)}` : ""}`;
  const seller = `<b>${esc(name(s.seller.nameBn, s.seller.nameEn))}</b>${s.seller.address ? `<div class="small">${esc(s.seller.address)}</div>` : ""}`;
  const patient = `${esc(name(s.patient.nameBn, s.patient.nameEn))} · <span class="num">${esc(s.patient.facilityNo)}</span>`;
  const reprint = i.print.copy > 0
    ? Ls("r_reprinted", { n: num(i.print.copy), at: when(i.print.printedAt), name: name(i.print.printedBy.nameBn, i.print.printedBy.nameEn), reason: L(`rr_${i.print.reason}`) })
    : Ls("r_printed", { at: when(i.print.printedAt), name: name(i.print.printedBy.nameBn, i.print.printedBy.nameEn) });
  const qr = `<div class="qr">${qrSvg(i.verifyUrl)}</div>`;
  const amounts = `<table class="totals"><tr class="strong"><td>${esc(L("dr_amount"))}</td><td class="r num">${esc(tk(s.amountPaisa))}</td></tr><tr><td>${esc(L("dr_to_date"))}</td><td class="r num">${esc(tk(s.depositsToDatePaisa))}</td></tr></table>`;
  const body = i.format === "a5"
    ? `<style>@page{size:148mm 210mm;margin:10mm}body{font-size:10pt}.small{font-size:8.5pt}h1{font-size:13pt}.qr{width:18mm;height:18mm}</style>
      <header class="head"><div>${seller}</div>${qr}</header>
      <h1>${esc(L("dr_title"))}</h1>${dup}
      <table class="meta small"><tr><td>${esc(L("dr_no"))}</td><td class="num">${esc(i.number)}</td><td>${esc(L("r_date"))}</td><td class="num">${esc(when(s.paidAt))}</td></tr>
        <tr><td>${esc(L("r_patient"))}</td><td>${patient}</td><td>${esc(L("dr_adm"))}</td><td class="num">${esc(s.admission.number)}${s.admission.bed ? ` · ${esc(s.admission.bed)}` : ""}</td></tr>
        <tr><td>${esc(L("dr_method"))}</td><td colspan="3">${how}</td></tr></table>
      ${amounts}<div class="words small">${words}</div>
      <div class="small"><b>${Ls("dr_note")}</b></div>
      <div class="small" style="margin-top:2mm">${esc(L("r_cashier"))}: ${esc(name(s.cashier.nameBn, s.cashier.nameEn))}</div>
      <div class="small" style="margin-top:4mm">${esc(L("r_scan"))}</div><div class="small muted">${reprint}</div>`
    : `<style>@page{margin:3mm 4mm 6mm 4mm}body{font-size:9pt;width:72mm}.small{font-size:8pt}h1{font-size:11pt;text-align:center}.qr{width:24mm;height:24mm;margin:3mm auto 1mm}</style>
      <div class="c">${seller}</div><h1>${esc(L("dr_title"))}</h1>${dup}
      <div class="small">${esc(L("dr_no"))} <span class="num">${esc(i.number)}</span></div>
      <div class="small">${esc(L("r_date"))} <span class="num">${esc(when(s.paidAt))}</span></div>
      <div class="small">${patient}</div><div class="small">${esc(L("dr_adm"))} <span class="num">${esc(s.admission.number)}</span>${s.admission.bed ? ` · ${esc(s.admission.bed)}` : ""}</div>
      <hr><div class="small">${how}</div>${amounts}<div class="words small">${words}</div>
      <div class="small"><b>${Ls("dr_note")}</b></div>
      <div class="small">${esc(L("r_cashier"))}: ${esc(name(s.cashier.nameBn, s.cashier.nameEn))}</div>
      ${qr}<div class="c small">${esc(L("r_scan"))}</div><div class="c small muted">${reprint}</div>`;
  return page(i.lang, i.number, `${wm}${body}`);
}

export interface InterimLine { serviceDay: string; nameEn: string; nameBn: string; tag: string; qty: number; unitPaisa: number | null; totalPaisa: number; credit: boolean }
export interface InterimPrintInput {
  seller: { nameEn: string; nameBn: string | null; address: string | null };
  patient: { nameBn: string; nameEn: string; facilityNo: string }; admission: { number: string; admittedAt: Date; bed: string | null; bedClass: string; dayNo: number; doctor: { nameBn: string; nameEn: string } };
  packageName: { nameEn: string; nameBn: string } | null;
  lines: InterimLine[]; totals: { packagePaisa: number; excludedPaisa: number; totalPaisa: number };
  deposits: { method: string; amountPaisa: number; at: Date; trxId: string | null }[]; depositsPaisa: number; balancePaisa: number;
  asOf: Date; lang: ReceiptLangMode; print: PrintInfo;
}
export function interimBillHtml(i: InterimPrintInput): string {
  const { L, Ls, tk, num, name, when, day } = helpers(i.lang);
  const { dup, wm } = dupParts(i.lang, L, num, i.print);
  const byDay = new Map<string, InterimLine[]>();
  for (const l of i.lines) byDay.set(l.serviceDay, [...(byDay.get(l.serviceDay) ?? []), l]);
  const rows = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, ls]) =>
    `<tr class="day"><td colspan="5">${esc(day(d))}</td></tr>` + ls.map((l) =>
      `<tr><td>${esc(name(l.nameBn, l.nameEn))}${l.credit ? ` (${esc(L("ib_credit"))})` : ""}</td><td><span class="tag">${esc(L(`ib_tag_${l.tag}`))}</span></td><td class="r num">${esc(num(l.qty))}</td><td class="r num">${l.unitPaisa === null ? "—" : esc(tk(l.unitPaisa))}</td><td class="r num">${esc(tk(l.totalPaisa))}</td></tr>`).join("")).join("");
  const deps = i.deposits.map((d) => `<tr><td class="num">${esc(when(d.at))}</td><td>${esc(L(`m_${d.method}`))}${d.trxId ? ` · <span class="num">${esc(d.trxId)}</span>` : ""}</td><td class="r num">${esc(tk(d.amountPaisa))}</td></tr>`).join("");
  const reprint = i.print.copy > 0
    ? Ls("r_reprinted", { n: num(i.print.copy), at: when(i.print.printedAt), name: name(i.print.printedBy.nameBn, i.print.printedBy.nameEn), reason: L(`rr_${i.print.reason}`) })
    : Ls("r_printed", { at: when(i.print.printedAt), name: name(i.print.printedBy.nameBn, i.print.printedBy.nameEn) });
  const a = i.admission;
  const body = `<style>@page{size:210mm 297mm;margin:12mm}body{font-size:9.5pt}.small{font-size:8.5pt}h1{font-size:14pt}</style>
    <header class="head"><div><b>${esc(name(i.seller.nameBn, i.seller.nameEn))}</b>${i.seller.address ? `<div class="small">${esc(i.seller.address)}</div>` : ""}</div>
      <div class="small r">${esc(L("ib_p_as_of", { at: when(i.asOf) }))}</div></header>
    <h1>${esc(L("ib_p_title"))}</h1>${dup}
    <table class="meta small">
      <tr><td>${esc(L("r_patient"))}</td><td>${esc(name(i.patient.nameBn, i.patient.nameEn))} · <span class="num">${esc(i.patient.facilityNo)}</span></td><td>${esc(L("dr_adm"))}</td><td class="num">${esc(a.number)}</td></tr>
      <tr><td>${esc(L("ib_admitted"))}</td><td class="num">${esc(when(a.admittedAt))} · ${esc(L("ib_day", { n: num(a.dayNo) }))}</td><td>${esc(L("ib_bed"))}</td><td>${esc(a.bed ?? "—")} · ${esc(a.bedClass)}</td></tr>
      <tr><td>${esc(L("ib_package"))}</td><td>${i.packageName ? esc(name(i.packageName.nameBn, i.packageName.nameEn)) : esc(L("ib_no_package"))}</td><td>${esc(L("ib_doctor"))}</td><td>${esc(name(a.doctor.nameBn, a.doctor.nameEn))}</td></tr>
    </table>
    <table class="lines" style="margin-top:3mm"><thead><tr><th>${esc(L("ib_col_item"))}</th><th>${esc(L("ib_col_tag"))}</th><th class="r">${esc(L("ib_col_qty"))}</th><th class="r">${esc(L("ib_col_rate"))}</th><th class="r">${esc(L("ib_col_amount"))}</th></tr></thead><tbody>${rows}</tbody></table>
    <table class="totals" style="width:60%;margin-left:40%">
      <tr><td>${esc(L("ib_t_package"))}</td><td class="r num">${esc(tk(i.totals.packagePaisa))}</td></tr>
      <tr><td>${esc(L("ib_t_excluded"))}</td><td class="r num">${esc(tk(i.totals.excludedPaisa))}</td></tr>
      <tr class="strong"><td>${esc(L("ib_t_share"))}</td><td class="r num">${esc(tk(i.totals.totalPaisa))}</td></tr>
      <tr><td>${esc(L("ib_t_deposits"))} (−)</td><td class="r num">${esc(tk(i.depositsPaisa))}</td></tr>
      <tr class="strong"><td>${esc(L(i.balancePaisa < 0 ? "ib_t_due" : "ib_t_balance"))}</td><td class="r num">${esc(tk(Math.abs(i.balancePaisa)))}</td></tr>
    </table>
    ${deps ? `<h2 class="small" style="margin:4mm 0 1mm">${esc(L("ib_deposits"))}</h2><table class="small">${deps}</table>` : ""}
    <div class="small" style="margin-top:4mm"><b>${Ls("ib_p_note")}</b></div>
    <div class="small muted" style="margin-top:2mm">${reprint}</div>`;
  return page(i.lang, `${a.number} interim`, `${wm}${body}`);
}
