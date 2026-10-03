/* Printed clinical documents as HTML (docs/design-handoff/print-specs.md; DS 6 Print Templates §6.2; ADR 0007).
   Prescription: A5 (148 × 210 mm, margins 12/10/12/10 mm, 11/9/14 pt, QR 18 mm bottom-left) or A4 (210 × 297 mm,
   15 mm, 12/10/16 pt, QR 22 mm). Lab report: same papers. Black ink only; Bangla + English / Bangla / English.
   Modes: `print` (final, QR + verify code), `preview` (a signed version before printing: "PREVIEW — not a print", no
   QR) and `draft` (the DRAFT watermark, no QR, "Not signed" — it never reaches a printer: the print route refuses it).
   Duplicates carry "অনুলিপি · DUPLICATE #n", a 10% diagonal watermark and the reprint line. Everything from the record
   is HTML-escaped (data, never markup). */
import { format, type Interpretation } from "@setu/domain";
import { t } from "@setu/i18n";
import { esc, fonts, qrSvg } from "../receipts/template.js";

export type Lang = "both" | "bn" | "en";
export type Paper = "a5" | "a4";
export type Mode = "print" | "preview" | "draft";
export interface PrintLine { copy: number; reason: string | null; printedAt: Date; printedBy: { nameBn: string; nameEn: string } }
export interface Facility { en: string; bn: string | null; address: string | null }
export interface PatientLine { nameEn: string | null; nameBn: string; facilityNo: string; ageYears: number | null; sex: "female" | "male" | "other" }

export interface RxInput {
  lang: Lang; paper: Paper; mode: Mode; facility: Facility;
  doctor: { en: string; bn: string; regBody: string | null; regNo: string | null; regVerified: boolean } | null;
  patient: PatientLine; visit: { token: string | null; date: Date };
  signedAt: Date | null; version: number; amended: boolean;
  allergies: { labelEn: string; labelBn: string; reaction: string | null }[];
  complaints: { text: string; duration: { n: number; unit: "d" | "w" | "m" | "y" } | null }[];
  exam: { general: string; cvs: string; chest: string; abdomen: string };
  diagnoses: { code: string; labelEn: string; labelBn: string; provisional: boolean; sample: boolean }[];
  orders: { nameEn: string; nameBn: string }[];
  medicines: { brand: string; generic: string; strength: string; form: string; dose: string; meal: string; days: number; sample: boolean }[];
  advice: string; followUp: string;
  verify: { url: string; code: string } | null;
  print: PrintLine | null;
}

export interface LrInput {
  lang: Lang; paper: Paper; mode: Mode; facility: Facility; patient: PatientLine;
  report: { number: string; version: number; status: "preliminary" | "final" | "corrected" | "superseded"; testCount: number; pendingCount: number; releasedAt: Date; releasedBy: { en: string; bn: string } };
  visit: { token: string | null };
  tests: { nameEn: string; nameBn: string; results: { nameEn: string; nameBn: string; value: number; decimals: number; unit: string; flag: Interpretation | null; refLow: number | null; refHigh: number | null; refLabel: string | null; underCorrection: boolean; withdrawn: boolean }[] }[];
  pending: { nameEn: string; nameBn: string }[];
  callbacks: { analyteEn: string; name: string; at: Date }[];
  validatedBy: { en: string; bn: string; at: Date } | null;
  verify: { url: string; code: string } | null;
  print: PrintLine | null;
}

/** Shared bits: strings in the chosen language(s), Bangla digits only on a Bangla-only print, the page frame. */
function kit(lang: Lang) {
  const bnDigits = lang === "bn";
  const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? v[k]! : m));
  const L = (ns: string, key: string, v: Record<string, string> = {}) => {
    const bn = fill(t("bn", ns, key), v), en = fill(t("en", ns, key), v);
    return lang === "bn" ? bn : lang === "en" ? en : bn === en ? en : `${bn} · ${en}`;
  };
  const P = (key: string, v: Record<string, string> = {}) => esc(L("printApp", key, v));
  const rawName = (bn: string | null | undefined, en: string | null | undefined) => (lang === "bn" ? bn || en : lang === "en" ? en || bn : en && bn && en !== bn ? `${bn} · ${en}` : bn || en) ?? "";
  const name = (bn: string | null | undefined, en: string | null | undefined) => esc(rawName(bn, en));
  const num = (n: number | string) => format.digits(n, bnDigits);
  const date = (d: Date) => format.date(d, bnDigits);
  const dateTime = (d: Date) => format.dateTime(d, bnDigits);
  const sex = (s: PatientLine["sex"]) => P(`sex_${s}`);
  const age = (y: number | null) => (y == null ? "—" : P("years", { n: num(y) }));
  return { bnDigits, L, P, rawName, name, num, date, dateTime, sex, age };
}

function frame(paper: Paper, body: string, watermark: string | null) {
  const A5 = paper === "a5";
  const css = `${fonts()}
@page{size:${A5 ? "148mm 210mm" : "210mm 297mm"};margin:${A5 ? "12mm 10mm 12mm 10mm" : "15mm"}}
*{box-sizing:border-box}html,body{margin:0;color:#000;background:#fff}
body{font-family:'IBM Plex Sans','Noto Sans Bengali',sans-serif;font-size:${A5 ? 11 : 12}pt;line-height:1.35;font-variant-numeric:tabular-nums}
.small{font-size:${A5 ? 9 : 10}pt}.title{font-size:${A5 ? 14 : 16}pt;font-weight:700}
.head{display:flex;justify-content:space-between;gap:8mm;border-bottom:.5pt solid #000;padding-bottom:2mm;margin-bottom:2.5mm}
.cols{display:grid;grid-template-columns:${A5 ? "1fr 1fr" : "1fr 1fr 1fr"};gap:1mm 6mm;margin-bottom:2.5mm}
.lbl{font-size:${A5 ? 8 : 9}pt;text-transform:uppercase;letter-spacing:.02em}
h3{font-size:${A5 ? 10 : 11}pt;margin:3mm 0 1mm;font-weight:700}
ul{margin:0;padding-left:5mm}li{margin:.5mm 0}
.allergy{border:1pt solid #000;padding:1.5mm 2mm;font-weight:700;margin:2mm 0}
.rx{font-size:${A5 ? 18 : 20}pt;font-weight:700;margin:2mm 0 0}
.med{margin:1.5mm 0}.med b{font-weight:700}.med i{font-style:italic}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:1mm 1.5mm;border-bottom:.3pt solid #000;vertical-align:top}th{font-size:${A5 ? 8 : 9}pt}
.strike{text-decoration:line-through}.dna{font-weight:700}
.foot{display:flex;justify-content:space-between;align-items:flex-end;gap:6mm;margin-top:5mm;border-top:.5pt solid #000;padding-top:2mm}
.qr{display:flex;gap:2mm;align-items:flex-end}.qr svg{width:${A5 ? 18 : 22}mm;height:${A5 ? 18 : 22}mm}
.code{font-family:'IBM Plex Mono','IBM Plex Sans',monospace;letter-spacing:.03em}
.sig{text-align:right}.banner{border:1.2pt solid #000;padding:1.5mm 2mm;font-weight:700;margin-bottom:2mm}
.wm{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.wm span{transform:rotate(-30deg);font-size:${A5 ? 30 : 44}pt;font-weight:800;color:rgba(0,0,0,.1);white-space:nowrap}
.dup{font-weight:700;border:1pt solid #000;display:inline-block;padding:.5mm 2mm}`;
  // a long watermark gets a smaller size so it stays on the page (diagonal across the short side)
  const wmSize = watermark && Array.from(watermark).length > 14 ? (A5 ? 22 : 32) : (A5 ? 30 : 44);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${watermark ? `<div class="wm"><span style="font-size:${wmSize}pt">${esc(watermark)}</span></div>` : ""}${body}</body></html>`;
}

function marks(k: ReturnType<typeof kit>, mode: Mode, print: PrintLine | null) {
  const wm = mode === "draft" ? t("bn", "printApp", "draft_watermark") : mode === "preview" ? t("bn", "printApp", "preview_watermark") : print && print.copy > 0 ? `DUPLICATE #${print.copy}` : null;
  const dup = print && print.copy > 0
    ? `<div><span class="dup">${k.P("duplicate", { n: k.num(print.copy) })}</span> <span class="small">${k.P("reprint_line", { reason: k.L("printApp", `rr_${print.reason}`), name: k.rawName(print.printedBy.nameBn, print.printedBy.nameEn), at: k.dateTime(print.printedAt) })}</span></div>`
    : "";
  return { wm, dup };
}

function qrBlock(k: ReturnType<typeof kit>, verify: { url: string; code: string } | null, mode: Mode) {
  if (!verify || mode !== "print") return `<div class="small">${mode === "draft" ? k.P("draft_note") : ""}</div>`;
  const grouped = verify.code.match(/.{1,4}/g)!.join("-");
  return `<div class="qr">${qrSvg(verify.url)}<div class="small">${k.P("scan_verify")}<br><span class="code">${esc(grouped)}</span><br>${esc(verify.url.replace(/^https?:\/\//, "").replace(/\/[^/]+$/, "/…"))}</div></div>`;
}

export function rxHtml(i: RxInput): string {
  const k = kit(i.lang);
  const { wm, dup } = marks(k, i.mode, i.print);
  const durT = (d: RxInput["complaints"][number]["duration"]) => (d ? ` — ${esc(k.L("consultApp", `dur_${d.unit}`, { n: k.num(d.n) }))}` : "");
  const exam = (["general", "cvs", "chest", "abdomen"] as const).filter((x) => i.exam[x].trim()).map((x) => `<li>${esc(k.L("consultApp", `exam_${x}`))}: ${esc(i.exam[x])}</li>`).join("");
  const reg = i.doctor?.regNo ? esc(k.L("consultApp", i.doctor.regVerified ? "reg_verified" : "reg_unverified", { body: i.doctor.regBody ?? "BMDC", no: i.doctor.regNo })) : "";
  const meds = i.medicines.map((m, n) => `<div class="med">${k.num(n + 1)}. <b>${esc(m.form)} ${esc(m.brand)} ${esc(m.strength)}</b> <i>(${esc(m.generic)})</i><br>`
    + `&nbsp;&nbsp;&nbsp;${esc(k.num(m.dose))} · ${esc(k.L("consultApp", `meal_${m.meal}`))} · ${esc(k.L("printApp", "days_n", { n: k.num(m.days) }))}</div>`).join("");
  const body = `
<div class="head"><div><div class="title">${k.name(i.facility.bn, i.facility.en)}</div>${i.facility.address ? `<div class="small">${esc(i.facility.address)}</div>` : ""}</div>
<div style="text-align:right">${i.doctor ? `<b>${k.name(i.doctor.bn, i.doctor.en)}</b><br><span class="small">${reg}</span>` : ""}</div></div>
${dup}
<div class="cols">
<div><span class="lbl">${k.P("patient")}</span><br><b>${k.name(i.patient.nameBn, i.patient.nameEn)}</b></div>
<div><span class="lbl">${k.P("age_sex")}</span><br>${k.age(i.patient.ageYears)} · ${k.sex(i.patient.sex)}</div>
<div><span class="lbl">${k.P("patient_no")}</span><br>${esc(i.patient.facilityNo)}</div>
<div><span class="lbl">${k.P("date")}</span><br>${k.date(i.signedAt ?? i.visit.date)}${i.visit.token ? ` · ${esc(i.visit.token)}` : ""}</div>
</div>
<div class="allergy">${k.P("allergy")}: ${i.allergies.length ? i.allergies.map((a) => `${k.name(a.labelBn, a.labelEn)}${a.reaction ? ` (${esc(a.reaction)})` : ""}`).join(", ") : k.P("allergy_unknown")}</div>
${i.amended ? `<div class="small"><b>${k.P("amended_v", { n: k.num(i.version) })}</b></div>` : ""}
<div style="display:grid;grid-template-columns:${i.paper === "a5" ? "38%" : "34%"} 1fr;gap:5mm">
<div>
${i.complaints.length ? `<h3>${k.P("cc")}</h3><ul>${i.complaints.map((c) => `<li>${esc(c.text)}${durT(c.duration)}</li>`).join("")}</ul>` : ""}
${exam ? `<h3>${k.P("oe")}</h3><ul>${exam}</ul>` : ""}
${i.diagnoses.length ? `<h3>${k.P("dx")}</h3><ul>${i.diagnoses.map((d) => `<li>${esc(d.code)} ${k.name(d.labelBn, d.labelEn)}${d.provisional ? ` <span class="small">(${k.P("provisional")})</span>` : ""}</li>`).join("")}</ul>` : ""}
${i.orders.length ? `<h3>${k.P("ix")}</h3><ul>${i.orders.map((o) => `<li>${k.name(o.nameBn, o.nameEn)}</li>`).join("")}</ul>` : ""}
</div>
<div>
<div class="rx">℞</div>${meds}
${i.advice.trim() ? `<h3>${k.P("advice")}</h3><div>${esc(i.advice)}</div>` : ""}
${i.followUp.trim() ? `<h3>${k.P("follow_up")}</h3><div>${esc(i.followUp)}</div>` : ""}
</div></div>
<div class="foot">${qrBlock(k, i.verify, i.mode)}
<div class="sig">${i.mode === "draft" || !i.signedAt ? `<b>${k.P("not_signed")}</b>` : `<b>${k.P("digitally_signed")}</b><br>${i.doctor ? k.name(i.doctor.bn, i.doctor.en) : ""}<br><span class="small">${k.P("signed_on")} ${k.dateTime(i.signedAt)}</span>`}</div></div>
<div class="small" style="margin-top:2mm">${i.medicines.some((m) => m.sample) ? k.P("rx_sample") : ""}${i.diagnoses.some((d) => d.sample) ? ` · ${k.P("dx_sample")}` : ""}</div>`;
  return frame(i.paper, body, wm);
}

export function lrHtml(i: LrInput): string {
  const k = kit(i.lang);
  const { wm, dup } = marks(k, i.mode, i.print);
  const lab = (key: string, v: Record<string, string> = {}) => esc(k.L("labApp", key, v));
  const banner = i.report.status === "preliminary" ? lab("wm_preliminary", { n: k.num(i.report.pendingCount), m: k.num(i.report.testCount) })
    : i.report.status === "corrected" ? lab("wm_corrected") : lab("wm_final");
  const val = (v: number, d: number) => k.num(v.toFixed(d));
  const rows = i.tests.map((tst) => `<tr><td colspan="4"><b>${k.name(tst.nameBn, tst.nameEn)}</b></td></tr>` + tst.results.map((r) => {
    const off = r.underCorrection || r.withdrawn;
    const range = r.refLow != null && r.refHigh != null ? `${val(r.refLow, r.decimals)}–${val(r.refHigh, r.decimals)}${r.refLabel ? ` · ${lab(`range_${r.refLabel}`)}` : ""}` : lab("range_none");
    return `<tr><td>${k.name(r.nameBn, r.nameEn)}</td><td${off ? ' class="strike"' : ""}><b>${val(r.value, r.decimals)}</b> ${esc(r.unit)}</td>`
      + `<td>${r.flag ? lab(`flag_${r.flag}`) : "—"}${off ? `<br><span class="dna">${lab(r.withdrawn ? "withdrawn_dna" : "under_correction_dna")}</span>` : ""}</td><td class="small">${range}</td></tr>`;
  }).join("")).join("");
  const body = `
<div class="head"><div><div class="title">${k.name(i.facility.bn, i.facility.en)}</div>${i.facility.address ? `<div class="small">${esc(i.facility.address)}</div>` : ""}</div>
<div style="text-align:right"><b>${k.P("lr_title")}</b><br><span class="code">${esc(i.report.number)}</span> · v${k.num(i.report.version)}</div></div>
${dup}
<div class="banner">${banner}</div>
<div class="cols">
<div><span class="lbl">${k.P("patient")}</span><br><b>${k.name(i.patient.nameBn, i.patient.nameEn)}</b></div>
<div><span class="lbl">${k.P("age_sex")}</span><br>${k.age(i.patient.ageYears)} · ${k.sex(i.patient.sex)}</div>
<div><span class="lbl">${k.P("patient_no")}</span><br>${esc(i.patient.facilityNo)}${i.visit.token ? ` · ${esc(i.visit.token)}` : ""}</div>
<div><span class="lbl">${k.P("date")}</span><br>${k.dateTime(i.report.releasedAt)}</div>
</div>
<table><thead><tr><th>${lab("col_test")}</th><th>${lab("col_result")}</th><th>${lab("col_flag")}</th><th>${lab("col_ref")}</th></tr></thead><tbody>${rows}</tbody></table>
${i.pending.length ? `<p><b>${lab("pending_tests")}</b> ${i.pending.map((p) => k.name(p.nameBn, p.nameEn)).join(", ")}</p>` : ""}
${i.callbacks.length ? `<p class="small">${i.callbacks.map((c) => `${esc(c.analyteEn)}: ${esc(c.name)} · ${k.dateTime(c.at)}`).join(" · ")}</p>` : ""}
<div class="foot">${qrBlock(k, i.verify, i.mode)}
<div class="sig">${i.validatedBy ? `<b>${k.P("digitally_signed")}</b><br>${k.name(i.validatedBy.bn, i.validatedBy.en)}<br>` : ""}<span class="small">${k.P("released_by", { name: k.rawName(i.report.releasedBy.bn, i.report.releasedBy.en), at: k.dateTime(i.report.releasedAt) })}</span></div></div>
<div class="small" style="margin-top:2mm">${lab("sample_ranges_note")}</div>`;
  return frame(i.paper, body, wm);
}
