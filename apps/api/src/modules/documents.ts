/* Printed clinical documents (walkthrough A13, ADR 0007): the prescription (a consultation note version, kind rx) and
   the lab report version (kind lr). The rules are @setu/domain printing.ts — drafts never print (issue #19), superseded
   versions do not, copy 0 is the original and every later copy needs a reason (DUPLICATE #n). The first print makes
   the version's verify code (DocumentCode); each print is rendered once, stored through the Storage adapter and logged
   (DocumentPrint); the database re-checks all of it (migration doctor_inbox_printing). */
import { randomBytes } from "node:crypto";
import type { DocPrintRequest, DocPrintView, DsVerifyResponse, LrVerifyResponse, RxVerifyResponse } from "@setu/contracts";
import type { Tx } from "@setu/db";
import { copyCheck, labReportPrintBlockers, patientAgeYears, rxPrintBlockers, rxVerifyStatus, type DocState, type PrintBlocker } from "@setu/domain";
import { storage } from "../adapters/storage.js";
import { config } from "../config.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { dsHtml, lrHtml, rxHtml, type Lang, type Mode, type Paper, type PrintLine } from "../print/clinical.js";
import { htmlToPdf } from "../receipts/pdf.js";
import { notFound } from "./frontdesk.js";
import { labReportView } from "./lab.js";
import { compositionHere, noCareRelationship } from "./consultation.js";
import { newVerifyCode } from "./receipts.js";

export type DocKind = "rx" | "lr" | "ds";
const dash = <T extends string>(s: string) => s.replace(/_/g, "-") as T;
/** What a document's QR opens: the staff app's public pages /verify/rx/<code> and /verify/lr/<code>. */
const verifyRoot = (process.env.VERIFY_DOC_ROOT_URL ?? config.verifyBaseUrl.replace(/\/rc$/, "")).replace(/\/+$/, "");
export const docVerifyUrl = (kind: DocKind, code: string) => `${verifyRoot}/${kind}/${code}`;
const ageOf = (p: { birthDate: Date | null; approxAgeYears: number | null; approxAgeAt: Date | null }, at: Date) =>
  patientAgeYears({ birthDate: p.birthDate ? p.birthDate.toISOString().slice(0, 10) : null, approxAgeYears: p.approxAgeYears, approxAgeAt: p.approxAgeAt?.toISOString() ?? null }, at);

async function people(tx: Tx, ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = list.length ? await tx.user.findMany({ where: { id: { in: list } }, select: { id: true, nameBn: true, nameEn: true } }) : [];
  return new Map(rows.map((r) => [r.id, r]));
}
async function facility(tx: Tx, s: SessionData) {
  const o = await tx.organization.findFirst({ where: { id: s.organizationId }, select: { name: true, nameBn: true, address: true } });
  return { en: o?.name ?? "", bn: o?.nameBn ?? null, address: o?.address ?? null };
}

/* ───── the documents ───── */
type Rx = NonNullable<Awaited<ReturnType<typeof rxHere>>>;
async function rxHere(tx: Tx, s: SessionData, id: string) {
  // the visit's branch and the care relationship, as the consultation screens (security review S1: another doctor's
  // note is neither previewed nor printed — a print by someone else would also take its "original")
  await compositionHere(tx, s, id);
  const c = await tx.composition.findFirst({ where: { id, organizationId: s.organizationId, kind: "consultation-note" },
    include: { conditions: { orderBy: { position: "asc" } }, medications: { orderBy: { position: "asc" } }, orders: { orderBy: { createdAt: "asc" } }, patient: true, encounter: { select: { token: true, createdAt: true } } } });
  if (!c) throw notFound();
  return c;
}
async function rxInput(tx: Tx, s: SessionData, c: Rx, mode: Mode, paper: Paper, lang: Lang, verify: { url: string; code: string } | null, print: PrintLine | null) {
  const [allergies, reg, who] = await Promise.all([
    tx.allergyIntolerance.findMany({ where: { patientId: c.patientId, status: "active" }, orderBy: { recordedAt: "asc" } }),
    // the registration as signed (ADR 0010 review), else the current one
    c.signerRegVerified !== null ? Promise.resolve({ regBody: c.signerRegBody, regNo: c.signerRegNo, regVerified: c.signerRegVerified })
      : c.signedById ? tx.practitioner.findFirst({ where: { userId: c.signedById }, select: { regBody: true, regNo: true, regVerified: true } }) : null,
    people(tx, [c.signedById, c.authorId]),
  ]);
  const doc = who.get(c.signedById ?? c.authorId);
  const sec = c.sections as { complaints?: { text: string; duration: { n: number; unit: "d" | "w" | "m" | "y" } | null }[]; exam?: Record<string, string>; advice?: string; followUp?: string };
  return rxHtml({
    lang, paper, mode, facility: await facility(tx, s),
    doctor: doc ? { en: doc.nameEn, bn: doc.nameBn, regBody: reg?.regBody ?? null, regNo: reg?.regNo ?? null, regVerified: reg?.regVerified ?? false } : null,
    patient: { nameEn: c.patient.nameEn, nameBn: c.patient.nameBn, facilityNo: c.patient.facilityNo, ageYears: ageOf(c.patient, c.signedAt ?? new Date()), sex: c.patient.sex },
    visit: { token: c.encounter.token, date: c.encounter.createdAt }, signedAt: c.signedAt, version: c.version, amended: c.status === "amended",
    allergies: allergies.map((a) => ({ labelEn: a.labelEn, labelBn: a.labelBn, reaction: a.reaction })),
    complaints: sec.complaints ?? [], exam: { general: sec.exam?.general ?? "", cvs: sec.exam?.cvs ?? "", chest: sec.exam?.chest ?? "", abdomen: sec.exam?.abdomen ?? "" },
    diagnoses: c.conditions.map((d) => ({ code: d.code, labelEn: d.labelEn, labelBn: d.labelBn, provisional: d.verificationStatus === "provisional", sample: d.codeVerification !== "verified" })),
    orders: c.orders.filter((o) => o.status !== "revoked").map((o) => ({ nameEn: o.nameEn, nameBn: o.nameBn })),
    medicines: c.medications.map((m) => ({ brand: m.brand, generic: m.generic, strength: m.strength, form: m.form, dose: m.dose, meal: m.meal, days: m.days, note: m.note, sample: m.sample })),
    replaced: c.status === "superseded" ? "superseded" : c.status === "entered_in_error" ? "withdrawn" : null,
    advice: sec.advice ?? "", followUp: sec.followUp ?? "", verify, print,
  });
}

async function lrHere(tx: Tx, s: SessionData, id: string) {
  const r = await tx.diagnosticReport.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!r) throw notFound();
  // security review S2: a doctor opens a report sent to their inbox, of a test they ordered, or of a visit they hold;
  // the lab (technologist, pathologist) keeps its access through the lab screens
  if (s.role === "doctor") {
    const mine = (await tx.communication.count({ where: { reportId: id, channel: "doctor_inbox", recipientUserId: s.userId } })) > 0
      || (await tx.serviceRequest.count({ where: { encounterId: r.encounterId, orderedById: s.userId } })) > 0
      || (await tx.encounter.findFirst({ where: { id: r.encounterId }, select: { practitionerId: true } }))?.practitionerId === s.userId;
    if (!mine) throw noCareRelationship();
  }
  return r;
}
async function lrInput(tx: Tx, s: SessionData, id: string, mode: Mode, paper: Paper, lang: Lang, verify: { url: string; code: string } | null, print: PrintLine | null) {
  const v = await labReportView(tx, s, id);
  const results = v.tests.flatMap((t) => t.results);
  const validator = results.map((x) => x.validatedBy && x.validatedAt ? { by: x.validatedBy, at: x.validatedAt } : null).filter((x) => !!x).sort((a, b) => b!.at.localeCompare(a!.at))[0] ?? null;
  return lrHtml({
    lang, paper, mode, facility: await facility(tx, s),
    patient: { nameEn: v.patient.nameEn, nameBn: v.patient.nameBn, facilityNo: v.patient.facilityNo, ageYears: v.patient.ageYears, sex: v.patient.sex },
    report: { number: v.report.number, version: v.report.version, status: v.report.status, testCount: v.report.testCount, pendingCount: v.report.pendingCount, releasedAt: new Date(v.report.releasedAt), releasedBy: { en: v.report.releasedBy.nameEn, bn: v.report.releasedBy.nameBn } },
    visit: { token: v.encounter.token },
    tests: v.tests.map((t) => ({ nameEn: t.nameEn, nameBn: t.nameBn, results: t.results.map((x) => ({
      nameEn: x.nameEn, nameBn: x.nameBn, value: x.value, decimals: x.decimals, unit: x.unit, flag: x.flag, refLow: x.range?.low ?? null, refHigh: x.range?.high ?? null, refLabel: x.range?.label ?? null,
      underCorrection: x.underCorrection, withdrawn: x.withdrawn })) })),
    pending: v.pendingTests.map((p) => ({ nameEn: p.nameEn, nameBn: p.nameBn })),
    callbacks: results.flatMap((x) => x.callbacks.filter((c) => c.outcome === "reached").map((c) => ({ analyteEn: x.nameEn, name: c.recipientName, at: new Date(c.calledAt) }))),
    validatedBy: validator ? { en: validator.by.nameEn, bn: validator.by.nameBn, at: new Date(validator.at) } : null,
    verify, print,
  });
}

/* ADR 0018 (B11): the discharge summary — A4 only; a doctor or admin (ipd/summary) or a nurse (ipd/discharge) of this facility */
async function dsHere(tx: Tx, s: SessionData, id: string) {
  const c = await tx.composition.findFirst({ where: { id, organizationId: s.organizationId, kind: "discharge-summary" },
    include: { conditions: { orderBy: { position: "asc" } }, medications: { orderBy: { position: "asc" } }, patient: true } });
  if (!c) throw notFound();
  // a draft is previewed by its author only (review)
  if (c.status === "draft" && c.authorId !== s.userId) throw notFound();
  return c;
}
async function dsInput(tx: Tx, s: SessionData, id: string, mode: Mode, lang: Lang, verify: { url: string; code: string } | null, print: PrintLine | null) {
  const c = await dsHere(tx, s, id);
  const a = await tx.admission.findFirst({ where: { encounterId: c.encounterId } });
  const [allergies, reg, who, bed, d] = await Promise.all([
    tx.allergyIntolerance.findMany({ where: { patientId: c.patientId, status: "active" }, orderBy: { recordedAt: "asc" } }),
    c.signerRegVerified !== null ? Promise.resolve({ regBody: c.signerRegBody, regNo: c.signerRegNo, regVerified: c.signerRegVerified })
      : c.signedById ? tx.practitioner.findFirst({ where: { userId: c.signedById }, select: { regBody: true, regNo: true, regVerified: true } }) : null,
    people(tx, [c.signedById, c.authorId, a?.admittingDoctorId]),
    a ? tx.location.findFirst({ where: { id: a.bedId }, include: { parent: { select: { name: true } } } }) : null,
    a ? tx.discharge.findFirst({ where: { admissionId: a.id, status: { in: ["ordered", "completed"] } } }) : null,
  ]);
  const doc = who.get(c.signedById ?? c.authorId);
  const con = a ? who.get(a.admittingDoctorId) : undefined;
  const sec = c.sections as { course?: string; procedures?: { name: string; date: string; surgeon: string }[]; followUp?: { date: string | null; place: string }; redFlags?: string[] };
  return dsHtml({
    lang, mode, facility: await facility(tx, s),
    doctor: doc ? { en: doc.nameEn, bn: doc.nameBn, regBody: reg?.regBody ?? null, regNo: reg?.regNo ?? null, regVerified: reg?.regVerified ?? false } : null,
    patient: { nameEn: c.patient.nameEn, nameBn: c.patient.nameBn, facilityNo: c.patient.facilityNo, ageYears: ageOf(c.patient, c.signedAt ?? new Date()), sex: c.patient.sex },
    admission: { number: a?.number ?? "", admittedAt: a?.admittedAt ?? c.createdAt, dischargedAt: a?.dischargedAt ?? null, ward: bed?.parent?.name ?? null, bed: bed?.name ?? null, consultant: con ? { en: con.nameEn, bn: con.nameBn } : null },
    lama: d?.kind === "lama", signedAt: c.signedAt, version: c.version, amended: c.status === "amended", replaced: c.status === "superseded" || c.status === "entered_in_error",
    allergies: allergies.map((x) => ({ labelEn: x.labelEn, labelBn: x.labelBn, reaction: x.reaction })),
    diagnoses: c.conditions.map((x) => ({ code: x.code, labelEn: x.labelEn, labelBn: x.labelBn, provisional: x.verificationStatus === "provisional", sample: x.codeVerification !== "verified" })),
    course: sec.course ?? "", procedures: sec.procedures ?? [],
    medicines: c.medications.map((m) => ({ brand: m.brand, generic: m.generic, strength: m.strength, form: m.form, dose: m.dose, meal: m.meal, days: m.days, note: m.note, sample: m.sample })),
    followUp: sec.followUp ?? { date: null, place: "" }, redFlags: sec.redFlags ?? [], advice: d?.kind === "normal" ? d.advice : "",
    verify, print,
  });
}

/* ───── print state, preview, print ───── */
async function blockersOf(tx: Tx, s: SessionData, kind: DocKind, id: string): Promise<{ blockers: PrintBlocker[]; patientId: string; label: string }> {
  if (kind === "rx") {
    const c = await rxHere(tx, s, id);
    return { blockers: rxPrintBlockers(dash<DocState>(c.status)), patientId: c.patientId, label: `v${c.version}` };
  }
  if (kind === "ds") {
    const c = await dsHere(tx, s, id);
    return { blockers: rxPrintBlockers(dash<DocState>(c.status)), patientId: c.patientId, label: `ds v${c.version}` };
  }
  const r = await lrHere(tx, s, id);
  return { blockers: labReportPrintBlockers(r.supersededById ? "superseded" : r.status), patientId: r.patientId, label: `${r.number} v${r.version}` };
}

export async function printView(tx: Tx, s: SessionData, kind: DocKind, id: string): Promise<{ view: DocPrintView; patientId: string }> {
  const b = await blockersOf(tx, s, kind, id);
  const code = await tx.documentCode.findFirst({ where: { kind, documentId: id }, include: { prints: { orderBy: { copy: "asc" } } } });
  const who = await people(tx, code?.prints.map((p) => p.printedById) ?? []);
  return {
    patientId: b.patientId,
    view: {
      kind, documentId: id, blockers: b.blockers,
      verifyCode: code?.verifyCode ?? null, verifyUrl: code ? docVerifyUrl(kind, code.verifyCode) : null,
      prints: (code?.prints ?? []).map((p) => ({
        id: p.id, copy: p.copy, reason: (p.reason ?? null) as "lost" | "jam" | "copy" | null, format: p.format as "a5" | "a4", lang: p.lang as Lang, printedAt: p.printedAt.toISOString(),
        printedBy: who.get(p.printedById) ? { id: p.printedById, nameBn: who.get(p.printedById)!.nameBn, nameEn: who.get(p.printedById)!.nameEn } : { id: p.printedById, nameBn: "—", nameEn: "—" },
        pdfUrl: `/v1/documents/prints/${p.id}/pdf`,
      })),
      previewUrl: `/v1/documents/${kind}/${id}/preview`,
    },
  };
}

/** The on-screen preview: a draft shows the DRAFT watermark, a printable version "PREVIEW — not a print"; never a QR. */
export async function previewPdf(tx: Tx, s: SessionData, kind: DocKind, id: string, paper: Paper, lang: Lang): Promise<{ bytes: Uint8Array; patientId: string }> {
  const b = await blockersOf(tx, s, kind, id);
  const mode: Mode = b.blockers.includes("draft_not_printable") ? "draft" : "preview";
  const html = kind === "rx" ? await rxInput(tx, s, await rxHere(tx, s, id), mode, paper, lang, null, null) : kind === "ds" ? await dsInput(tx, s, id, mode, lang, null, null) : await lrInput(tx, s, id, mode, paper, lang, null, null);
  return { bytes: await htmlToPdf(html, kind === "ds" ? "a4" : paper), patientId: b.patientId };
}

const BLOCKED: Record<PrintBlocker, [string, string]> = {
  draft_not_printable: ["খসড়া প্রিন্ট করা যায় না — আগে স্বাক্ষর করুন", "Drafts cannot be printed — sign first"],
  superseded_not_printable: ["এর নতুন সংস্করণ আছে — নতুনটি প্রিন্ট করুন", "A newer version exists — print that one"],
  withdrawn_not_printable: ["এই নথি বাতিল — প্রিন্ট করা যায় না", "This document was withdrawn — it cannot be printed"],
};

export async function printDocument(tx: Tx, s: SessionData, kind: DocKind, id: string, req: DocPrintRequest, now: Date) {
  const b = await blockersOf(tx, s, kind, id);
  if (b.blockers.length) { const k = b.blockers[0]!; throw err(422, k, BLOCKED[k][0], BLOCKED[k][1]); }
  // two prints of the same version wait for each other (setu_app has no UPDATE on DocumentCode, so no row lock: an
  // advisory lock for this transaction, taken before the first print makes the code — security review S4)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7007, hashtext(${`${kind}:${id}`}))`;
  let code = await tx.documentCode.findFirst({ where: { kind, documentId: id } });
  if (!code) code = await tx.documentCode.create({ data: { tenantId: s.tenantId, organizationId: s.organizationId, kind, documentId: id, verifyCode: newVerifyCode(), createdById: s.userId } });
  const printed = await tx.documentPrint.count({ where: { codeId: code.id } });
  const c = copyCheck(printed, req.reason);
  if ("error" in c) throw c.error === "reprint_needs_reason"
    ? err(409, "reprint_needs_reason", "আবার প্রিন্টের কারণ বেছে নিন", "Choose a reason to reprint", { field: "reason" })
    : err(409, "not_printed_yet", "মূল কপি এখনও প্রিন্ট হয়নি", "The original has not been printed yet", { field: "reason" });
  const me = await tx.user.findFirst({ where: { id: s.userId }, select: { nameBn: true, nameEn: true } });
  const line: PrintLine = { copy: c.copy, reason: req.reason ?? null, printedAt: now, printedBy: { nameBn: me?.nameBn ?? "—", nameEn: me?.nameEn ?? "—" } };
  const verify = { url: docVerifyUrl(kind, code.verifyCode), code: code.verifyCode };
  const paper = kind === "ds" ? "a4" : req.format; // the discharge summary is A4 only
  const html = kind === "rx" ? await rxInput(tx, s, await rxHere(tx, s, id), "print", paper, req.lang, verify, line) : kind === "ds" ? await dsInput(tx, s, id, "print", req.lang, verify, line) : await lrInput(tx, s, id, "print", paper, req.lang, verify, line);
  const pdf = await htmlToPdf(html, paper);
  const storageKey = `tenants/${s.tenantId}/documents/${kind}/${id}/${c.copy}-${paper}-${req.lang}-${randomBytes(4).toString("hex")}.pdf`;
  const print = await tx.documentPrint.create({ data: { tenantId: s.tenantId, codeId: code.id, copy: c.copy, reason: req.reason ?? null, format: paper, lang: req.lang, storageKey, printedById: s.userId, printedAt: now } });
  await storage.put(storageKey, pdf, "application/pdf");
  return { print, patientId: b.patientId, label: b.label };
}

export async function storedPdf(tx: Tx, s: SessionData, printId: string) {
  const p = await tx.documentPrint.findFirst({ where: { id: printId }, include: { code: true } });
  if (!p || p.code.organizationId !== s.organizationId) throw notFound();
  const b = await blockersOf(tx, s, p.code.kind as DocKind, p.code.documentId);
  // clinical review M5: a stored copy of a replaced or withdrawn version is not handed out again (it would print as a
  // clean original); the record stays, the QR page says what happened
  if (b.blockers.length) { const k = b.blockers[0]!; throw err(409, k, BLOCKED[k][0], BLOCKED[k][1]); }
  // external review B1: a lab report version stays current when a value on it is withdrawn or put under correction — a
  // copy printed before that shows the value clean (no strike, no "do not act on it"); it is not handed out again.
  // A copy printed after the change already shows it. Print a new copy instead.
  if (p.code.kind === "lr" && (await changedSince(tx, p.code.documentId, p.printedAt)))
    throw err(409, "content_changed", "এই কপি প্রিন্টের পরে একটি ফল সংশোধন বা প্রত্যাহার করা হয়েছে — নতুন কপি প্রিন্ট করুন", "A result was corrected or withdrawn after this copy was printed — print a new copy");
  const bytes = await storage.get(p.storageKey);
  if (!bytes) throw err(410, "file_missing", "ফাইলটি পাওয়া যায়নি", "The stored file is missing");
  return { bytes, print: p, kind: p.code.kind as DocKind, documentId: p.code.documentId, patientId: b.patientId };
}

/** A result on the report was withdrawn or put under correction after `at` (a row without the time counts as changed). */
async function changedSince(tx: Tx, reportId: string, at: Date) {
  const ids = (await tx.diagnosticReportResult.findMany({ where: { reportId }, select: { observationId: true } })).map((r) => r.observationId);
  const errored = ids.length ? await tx.observation.findMany({ where: { id: { in: ids }, status: "entered_in_error" }, select: { errorAt: true, statusAt: true } }) : [];
  return errored.some((o) => { const t = o.errorAt ?? o.statusAt; return !t || t > at; });
}

/* ───── public verify (no session): the SECURITY DEFINER lookups return only what decision D2 allows ───── */
type Raw = { birthDate: string | null; approxAgeYears: number | null; approxAgeAt: string | null; initials: string; sex: "female" | "male" | "other" };
const utc = (x: string) => (/[zZ]|[+-]\d\d:?\d\d$/.test(x) ? x : `${x}Z`);
const patientOf = (r: Raw, at: Date) => ({ initials: r.initials, sex: r.sex, ageYears: patientAgeYears({ birthDate: r.birthDate, approxAgeYears: r.approxAgeYears, approxAgeAt: r.approxAgeAt ? utc(r.approxAgeAt) : null }, at) });

/** Writes the audit row of a public QR view (no user): the patient can list it among the events about them. */
export async function auditPublicView(kind: DocKind, code: string, t: VerifyTarget, ip: string) {
  const { forTenant } = await import("@setu/db");
  await forTenant(t.tenantId, (tx) => tx.auditEvent.create({ data: {
    tenantId: t.tenantId, userId: null, role: null, action: "view", entity: kind === "lr" ? "DiagnosticReport" : "Composition", entityId: t.documentId, patientId: t.patientId, ip,
    basis: "public-verify", detail: { purpose: "public-verify", kind, code: code.slice(0, 4) } as object,
  } }));
}
/** Who to audit a public view against (security review S3): kept on the server, never in the answer. */
export interface VerifyTarget { tenantId: string; patientId: string; documentId: string }
export async function rxVerify(code: string): Promise<{ body: RxVerifyResponse; target: VerifyTarget } | null> {
  const { prisma } = await import("@setu/db");
  const rows = await prisma.$queryRaw<{ hit: (Raw & Record<string, unknown>) | null }[]>`SELECT rx_verify_lookup(${code}::text) AS hit`;
  const h = rows[0]?.hit as (Raw & VerifyTarget & { facilityEn: string; facilityBn: string | null; doctorEn: string | null; doctorBn: string | null; regBody: string | null; regNo: string | null; regVerified: boolean; signedAt: string | null; version: number; status: string; medicines: RxVerifyResponse["medicines"] }) | null;
  if (!h) return null;
  const status = rxVerifyStatus(h.status as DocState);
  if (!status) return null;
  const signedAt = h.signedAt ? new Date(utc(h.signedAt)) : null;
  return {
    target: { tenantId: h.tenantId, patientId: h.patientId, documentId: h.documentId },
    body: {
      facilityEn: h.facilityEn, facilityBn: h.facilityBn, doctorEn: h.doctorEn, doctorBn: h.doctorBn, regBody: h.regBody, regNo: h.regNo, regVerified: h.regVerified,
      signedAt: signedAt?.toISOString() ?? null, version: h.version, status, patient: patientOf(h, signedAt ?? new Date()),
      // external review B3: a withdrawn prescription's medicines are not shown to whoever holds the paper
      medicines: status === "withdrawn" ? [] : h.medicines.map((m) => ({ ...m, note: m.note ?? null, sample: !!m.sample })),
    },
  };
}

export async function lrVerify(code: string): Promise<{ body: LrVerifyResponse; target: VerifyTarget } | null> {
  const { prisma } = await import("@setu/db");
  const rows = await prisma.$queryRaw<{ hit: (Raw & Record<string, unknown>) | null }[]>`SELECT lr_verify_lookup(${code}::text) AS hit`;
  const h = rows[0]?.hit as (Raw & VerifyTarget & { facilityEn: string; facilityBn: string | null; number: string; version: number; status: LrVerifyResponse["reportStatus"]; superseded: boolean; releasedAt: string; testCount: number; pendingCount: number; results: LrVerifyResponse["results"] }) | null;
  if (!h) return null;
  const releasedAt = new Date(utc(h.releasedAt));
  return {
    target: { tenantId: h.tenantId, patientId: h.patientId, documentId: h.documentId },
    body: {
      facilityEn: h.facilityEn, facilityBn: h.facilityBn, number: h.number, version: h.version, reportStatus: h.status, status: h.superseded ? "superseded" : "current",
      releasedAt: releasedAt.toISOString(), testCount: h.testCount, pendingCount: h.pendingCount, patient: patientOf(h, releasedAt),
      results: h.results.map((x) => ({ ...x, decimals: x.decimals ?? 1, nameEn: x.nameEn ?? x.code, nameBn: x.nameBn ?? x.code, withdrawn: !!x.withdrawn })),
    },
  };
}

export async function dsVerify(code: string): Promise<{ body: DsVerifyResponse; target: VerifyTarget } | null> {
  const { prisma } = await import("@setu/db");
  const rows = await prisma.$queryRaw<{ hit: (Raw & Record<string, unknown>) | null }[]>`SELECT ds_verify_lookup(${code}::text) AS hit`;
  const h = rows[0]?.hit as (Raw & VerifyTarget & { facilityEn: string; facilityBn: string | null; doctorEn: string | null; doctorBn: string | null; regBody: string | null; regNo: string | null; regVerified: boolean; signedAt: string | null; version: number; status: string }) | null;
  if (!h) return null;
  const status = rxVerifyStatus(h.status as DocState);
  if (!status) return null;
  const signedAt = h.signedAt ? new Date(utc(h.signedAt)) : null;
  return {
    target: { tenantId: h.tenantId, patientId: h.patientId, documentId: h.documentId },
    body: { facilityEn: h.facilityEn, facilityBn: h.facilityBn, doctorEn: h.doctorEn, doctorBn: h.doctorBn, regBody: h.regBody, regNo: h.regNo, regVerified: h.regVerified,
      signedAt: signedAt?.toISOString() ?? null, version: h.version, status, patient: patientOf(h, signedAt ?? new Date()) },
  };
}
