/* The printed refund voucher (ADR 0013) — RF/yy/nnnn when money went back, a credit voucher CV/yy/nnnn when medicine came
   back on an unpaid bill (decision 221: no money). Same papers, languages, fonts, QR and duplicate rules as the receipt
   (receipts/template.ts): A5 or 80 mm, Bangla + English / Bangla / English, "অনুলিপি · DUPLICATE #n" with a 10% watermark.
   The credit-note lines carry their VAT (the accountant's credit note; the Mushak form is on the pre-pilot list). Who took
   the money — name, mobile, relationship — prints above a signature line. Everything from the record is HTML-escaped. */
import type { RefundVoucherSnapshot } from "@setu/contracts";
import { format } from "@setu/domain";
import { t } from "@setu/i18n";
import { esc, fonts, qrSvg, type PrintInfo, type ReceiptLangMode } from "./template.js";

export interface VoucherInput { snapshot: RefundVoucherSnapshot; number: string; createdAt: Date; verifyUrl: string; format: "a5" | "thermal"; lang: ReceiptLangMode; print: PrintInfo }

export function voucherHtml(i: VoucherInput): string {
  const s = i.snapshot;
  const credit = s.kind === "return";
  const bnDigits = i.lang === "bn";
  const fill = (str: string, vars: Record<string, string>) => str.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
  const L = (key: string, vars: Record<string, string> = {}) => {
    const bn = fill(t("bn", "billingApp", key), vars), en = fill(t("en", "billingApp", key), vars);
    return i.lang === "bn" ? bn : i.lang === "en" ? en : bn === en ? en : `${bn} · ${en}`;
  };
  const Ls = (key: string, vars: Record<string, string> = {}) =>
    i.lang !== "both" ? esc(L(key, vars)) : `${esc(fill(t("bn", "billingApp", key), vars))}<br>${esc(fill(t("en", "billingApp", key), vars))}`;
  const tk = (p: number) => format.takaFromPaisa(p, { bn: bnDigits });
  const num = (n: number) => format.digits(n, bnDigits);
  const name = (bn: string | null | undefined, en: string | null | undefined) => (i.lang === "bn" ? bn || en : i.lang === "en" ? en || bn : en && bn && en !== bn ? `${bn} · ${en}` : bn || en) ?? "";
  const who = (p: { nameBn: string; nameEn: string }) => name(p.nameBn, p.nameEn);
  const when = (d: Date | string) => format.dateTime(d, bnDigits);
  const vatLabel = (bp: number) => (bp === 0 ? L("vat_exempt") : `${num(bp / 100)}%`);
  const dup = i.print.copy > 0;
  const title = credit ? L("v_credit_title") : L("v_refund_title");
  const dupTitle = dup ? `<div class="dup">${esc(L("r_duplicate"))} #${num(i.print.copy)}</div>` : "";
  const watermark = dup ? `<div class="wm" aria-hidden="true">${esc(t("bn", "billingApp", "r_duplicate"))} · ${esc(t("en", "billingApp", "r_duplicate"))}</div>` : "";
  const party = s.patient ? `${esc(name(s.patient.nameBn, s.patient.nameEn))}${s.patient.facilityNo ? ` · <span class="num">${esc(s.patient.facilityNo)}</span>` : ""}` : esc(s.buyer?.name ?? L("walk_in"));
  const words = (lang: "bn" | "en") => format.wordsPaisa(s.amountPaisa, lang);
  const wordsKey = credit ? "v_credit_words" : "v_in_words";
  const wordsHtml = i.lang === "both"
    ? `<div>${esc(t("bn", "billingApp", wordsKey))}: ${esc(words("bn"))}</div><div>${esc(t("en", "billingApp", wordsKey))}: ${esc(words("en"))}</div>`
    : `<div>${esc(t(i.lang, "billingApp", wordsKey))}: ${esc(words(i.lang))}</div>`;
  const lineRows = s.lines.map((l, n) => `<tr><td class="num">${num(n + 1)}</td><td>${esc(name(l.nameBn, l.nameEn))}${l.units ? ` <span class="num">×${num(l.units)}</span>` : ""}</td><td class="r">${esc(vatLabel(l.vatRateBp))}</td><td class="r num">${esc(tk(l.netPaisa))}</td><td class="r num">${esc(tk(l.vatPaisa))}</td><td class="r num">${esc(tk(l.totalPaisa))}</td></tr>`).join("");
  const way = (w: string) => L(`v_way_${w}`);
  // the way it went back, and the payment it came from when that differs (cash paid back as cash says it once)
  const paidBack = s.paidBack.map((p) => `${esc(way(p.way))}${p.way === "cash" && p.method === "cash" ? "" : ` · ${esc(L(`m_${p.method}`))}`} ${esc(tk(p.amountPaisa))}${p.refundTrxId ? ` (${esc(L("v_refund_trx"))} ${esc(p.refundTrxId)})` : p.reference ? ` (${esc(L("v_ref"))} ${esc(p.reference)})` : ""}${p.originalTrxId ? ` · ${esc(L("v_original_trx"))} ${esc(p.originalTrxId)}` : ""}`).join("<br>");
  const people = `${esc(L("v_requested"))}: ${esc(who(s.requestedBy))} · ${esc(L("v_approved"))}: ${esc(who(s.approvedBy))}${s.selfApproved ? ` (${esc(L("v_self"))})` : ""} · ${esc(L(credit ? "v_recorded_by" : "v_paid_by"))}: ${esc(who(s.paidBy))}`;
  const recipient = s.recipient
    ? `<div class="recv"><div>${esc(L("v_received_by"))}: <b>${esc(s.recipient.name)}</b> · <span class="num">${esc(format.phone(s.recipient.phone, bnDigits).text)}</span> · ${esc(L("v_relation"))}: ${esc(L(`rf_rel_${s.recipient.relation}`))}</div><div class="sigline">${esc(L("v_sign"))}</div></div>`
    : "";
  const reprintLine = dup
    ? Ls("r_reprinted", { n: num(i.print.copy), at: when(i.print.printedAt), name: name(i.print.printedBy.nameBn, i.print.printedBy.nameEn), reason: L(`rr_${i.print.reason}`) })
    : Ls("r_printed", { at: when(i.print.printedAt), name: name(i.print.printedBy.nameBn, i.print.printedBy.nameEn) });
  const qr = `<div class="qr">${qrSvg(i.verifyUrl)}</div>`;
  const totals = `<table class="totals"><tr><td>${esc(L("v_net"))}</td><td class="r num">${esc(tk(s.netPaisa))}</td></tr><tr><td>${esc(L("r_vat"))}</td><td class="r num">${esc(tk(s.vatPaisa))}</td></tr>`
    + `<tr class="strong"><td>${esc(L(credit ? "rf_credit_total" : "rf_total"))}</td><td class="r num">${esc(tk(s.amountPaisa))}</td></tr></table>`;
  const meta = `<table class="meta small"><tr><td>${esc(L("v_no"))}</td><td class="num">${esc(i.number)}</td><td>${esc(L("r_bill_no"))}</td><td class="num">${esc(s.invoice.number ?? "—")}</td></tr>
      <tr><td>${esc(L("r_date"))}</td><td class="num">${esc(when(i.createdAt))}</td><td>${esc(L("r_patient"))}</td><td>${party}</td></tr>
      <tr><td>${esc(L("rf_category"))}</td><td>${esc(L(`rf_cat_${s.category}`))}</td><td>${esc(L("v_reason"))}</td><td>${esc(s.reason)}</td></tr></table>`;
  const seller = `<b>${esc(name(s.seller.nameBn, s.seller.nameEn))}</b>${s.seller.address ? `<div class="small">${esc(s.seller.address)}</div>` : ""}${s.seller.vatBin ? `<div class="small">${esc(L("r_bin"))} ${esc(s.seller.vatBin)}${s.seller.vatBinSample ? ` (${esc(L("r_sample"))})` : ""}</div>` : ""}`;

  const page = i.format === "a5"
    ? `<style>@page{size:148mm 210mm;margin:10mm}body{font-size:10pt}.small{font-size:8.5pt}h1{font-size:13pt}.qr{width:18mm;height:18mm}</style>
      <header class="head"><div>${seller}</div>${qr}</header>
      <h1>${esc(title)}</h1>${dupTitle}${meta}
      ${s.lines.length ? `<table class="lines"><thead><tr><th>#</th><th>${esc(L(credit ? "v_credit_lines" : "r_service"))}</th><th class="r">${esc(L("v_vat_rate"))}</th><th class="r">${esc(L("v_net"))}</th><th class="r">${esc(L("r_vat"))}</th><th class="r">${esc(L("r_total"))}</th></tr></thead><tbody>${lineRows}</tbody></table>` : ""}
      ${totals}
      <div class="words small">${wordsHtml}</div>
      ${credit ? `<div class="small"><b>${Ls("v_credit_note")}</b></div>` : `<div class="small"><b>${esc(L("v_paid_back"))}:</b><br>${paidBack}</div>`}
      <div class="small" style="margin-top:2mm">${people}</div>
      ${recipient}
      <footer class="foot small"><div>${esc(L("r_scan"))}</div></footer>
      <div class="small muted">${reprintLine}</div>`
    : `<style>@page{margin:3mm 4mm 6mm 4mm}body{font-size:9pt;width:72mm}.small{font-size:8pt}h1{font-size:11pt;text-align:center}.qr{width:24mm;height:24mm;margin:3mm auto 1mm}</style>
      <div class="c">${seller}</div>
      <h1>${esc(title)}</h1>${dupTitle}
      <div class="small">${esc(L("v_no"))} <span class="num">${esc(i.number)}</span> · ${esc(L("r_bill_no"))} <span class="num">${esc(s.invoice.number ?? "—")}</span></div>
      <div class="small">${esc(L("r_date"))} <span class="num">${esc(when(i.createdAt))}</span></div>
      <div class="small">${party}</div>
      <div class="small">${esc(L(`rf_cat_${s.category}`))} — ${esc(s.reason)}</div>
      <hr><table class="lines small">${s.lines.map((l) => `<tr><td>${esc(name(l.nameBn, l.nameEn))}${l.units ? ` ×${num(l.units)}` : ""}</td><td class="r num">${esc(tk(l.totalPaisa))}</td></tr>`).join("")}</table><hr>
      ${totals}
      <div class="words small">${wordsHtml}</div>
      ${credit ? `<div class="small"><b>${Ls("v_credit_note")}</b></div>` : `<div class="small"><b>${esc(L("v_paid_back"))}:</b><br>${paidBack}</div>`}
      <div class="small">${people}</div>
      ${recipient}
      ${qr}<div class="c small">${esc(L("r_scan"))}</div>
      <div class="c small muted">${reprintLine}</div>`;

  return `<!doctype html><html lang="${i.lang === "en" ? "en" : "bn"}"><head><meta charset="utf-8"><title>${esc(i.number)}</title><style>${fonts()}
    *{box-sizing:border-box}html,body{margin:0;padding:0;color:#000;background:#fff}
    body{font-family:'IBM Plex Sans','Noto Sans Bengali',sans-serif;line-height:1.45;position:relative}
    .num{font-variant-numeric:tabular-nums}.r{text-align:right}.c{text-align:center}.muted{color:#333}
    h1{margin:3mm 0 1mm}table{width:100%;border-collapse:collapse}td,th{padding:1px 2px;vertical-align:top;text-align:left}
    .head{display:flex;justify-content:space-between;gap:4mm;border-bottom:0.5pt solid #000;padding-bottom:2mm}
    .meta td:nth-child(odd){white-space:nowrap;padding-right:3mm}.lines thead th{border-bottom:0.5pt solid #000}.totals{margin-top:2mm}.totals tr.strong td{font-weight:700;border-top:0.5pt solid #000}
    .words{margin:2mm 0}.foot{display:flex;justify-content:space-between;margin-top:4mm}
    .recv{margin-top:5mm}.sigline{margin-top:12mm;border-top:0.5pt solid #000;width:60%;padding-top:1mm}
    .qr svg{width:100%;height:100%;display:block}
    .dup{font-weight:700;letter-spacing:.5px;margin-bottom:1mm}hr{border:0;border-top:0.5pt dashed #000;margin:1.5mm 0}
    .wm{position:fixed;top:40%;left:-10%;width:120%;text-align:center;transform:rotate(-30deg);font-size:28pt;font-weight:700;color:rgba(0,0,0,.1);z-index:0;pointer-events:none}
  </style></head><body>${watermark}${page}</body></html>`;
}
