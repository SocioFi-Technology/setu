/* Receipts (slice A6–A7 session 2). A receipt is an immutable copy of the bill at the moment it is made — lines,
   totals, confirmed payments ("Paid by") and pending wallet amounts — numbered RCPT/yy/nnnn per facility per year from
   Sequence in the same transaction (Kamrul 03/10/2026). Asking again while nothing was paid since returns the same
   receipt. Printing: the first print is the original (copy 0); every later one needs a reason and is "DUPLICATE #n";
   each print is a ReceiptPrint row + its PDF in Storage, and an AuditEvent (print / reprint). The verify code is 20
   random characters (never sequential); the public verify read shows only facility, number, date and amount. */
import { randomBytes } from "node:crypto";
import type { PrintRequest, ReceiptList, ReceiptPrintView, ReceiptSnapshot, ReceiptView } from "@setu/contracts";
import type { Tx } from "@setu/db";
import { dhakaDay } from "@setu/domain";
import { storage } from "../adapters/storage.js";
import { config } from "../config.js";
import { err } from "../errors.js";
import type { SessionData } from "../plugins/session.js";
import { htmlToPdf } from "../receipts/pdf.js";
import { receiptHtml } from "../receipts/template.js";
import { invoiceHere, invoiceView, requireWriter } from "./billing.js";
import { notFound } from "./frontdesk.js";

/** Crockford base32 (no I, L, O, U): 20 characters ≈ 100 random bits. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const newVerifyCode = () => Array.from(randomBytes(20), (b) => ALPHABET[b & 31]).join("");
export const verifyUrl = (code: string) => `${config.verifyBaseUrl}/${code}`;

type Rc = NonNullable<Awaited<ReturnType<Tx["receipt"]["findFirst"]>>>;
type Pr = NonNullable<Awaited<ReturnType<Tx["receiptPrint"]["findFirst"]>>>;

async function people(tx: Tx, ids: string[]) {
  const rows = ids.length ? await tx.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, nameBn: true, nameEn: true } }) : [];
  const m = new Map(rows.map((r) => [r.id, r]));
  return (id: string) => m.get(id) ?? { id, nameBn: "—", nameEn: "—" };
}

async function receiptHere(tx: Tx, s: SessionData, id: string): Promise<Rc> {
  const r = await tx.receipt.findFirst({ where: { id, organizationId: s.organizationId } });
  if (!r) throw notFound();
  await invoiceHere(tx, s, r.invoiceId); // same facility and branch as the bill
  return r;
}

const pdfUrl = (p: Pr) => `/v1/receipts/${p.receiptId}/prints/${p.id}/pdf`;
export async function receiptView(tx: Tx, r: Rc): Promise<ReceiptView> {
  const prints = await tx.receiptPrint.findMany({ where: { receiptId: r.id }, orderBy: { copy: "asc" } });
  const who = await people(tx, prints.map((p) => p.printedById));
  return {
    receipt: {
      id: r.id, number: r.number, invoiceId: r.invoiceId, createdAt: r.createdAt.toISOString(), paidPaisa: r.paidPaisa, totalPaisa: r.totalPaisa, duePaisa: r.duePaisa,
      verifyUrl: verifyUrl(r.verifyCode), snapshot: r.snapshot as unknown as ReceiptSnapshot,
    },
    prints: prints.map((p): ReceiptPrintView => ({
      id: p.id, copy: p.copy, reason: (p.reason as ReceiptPrintView["reason"]) ?? null, format: p.format as "a5" | "thermal", lang: p.lang as "both" | "bn" | "en",
      printedBy: who(p.printedById), printedAt: p.printedAt.toISOString(), pdfUrl: pdfUrl(p),
    })),
  };
}

export async function receiptList(tx: Tx, s: SessionData, invoiceId: string): Promise<{ list: ReceiptList; patientId: string }> {
  const inv = await invoiceHere(tx, s, invoiceId);
  const rows = await tx.receipt.findMany({ where: { invoiceId: inv.id }, orderBy: { createdAt: "desc" }, include: { _count: { select: { prints: true } } } });
  return { list: { items: rows.map((r) => ({ id: r.id, number: r.number, createdAt: r.createdAt.toISOString(), paidPaisa: r.paidPaisa, duePaisa: r.duePaisa, prints: r._count.prints })) }, patientId: inv.patientId };
}

/** A receipt for the bill as it stands: needs confirmed money; the same receipt again if nothing changed since. */
export async function createReceipt(tx: Tx, s: SessionData, invoiceId: string, now: Date): Promise<{ r: Rc; created: boolean }> {
  requireWriter(s);
  const inv = await invoiceHere(tx, s, invoiceId, true);
  if (inv.paidPaisa <= 0 || (inv.status !== "partially_paid" && inv.status !== "balanced"))
    throw err(409, "nothing_paid", "নিশ্চিত পেমেন্ট নেই — রসিদ হয় না", "Nothing confirmed yet — no receipt");
  const v = await invoiceView(tx, s, inv);
  const last = await tx.receipt.findFirst({ where: { invoiceId: inv.id }, orderBy: { createdAt: "desc" } });
  // Only confirmed money makes a new receipt: a change in what is pending alone does not (review A6–A7: two valid
  // receipt numbers for the same money).
  const sameAsLast = last && last.paidPaisa === inv.paidPaisa
    && JSON.stringify((last.snapshot as unknown as ReceiptSnapshot).paidBy.paid) === JSON.stringify(v.paidBy.paid);
  if (last && sameAsLast) return { r: last, created: false };

  const org = await tx.organization.findFirst({ where: { id: s.organizationId } });
  const p = await tx.patient.findFirst({ where: { id: inv.patientId }, select: { nameBn: true, nameEn: true, facilityNo: true } });
  const me = await tx.user.findFirst({ where: { id: s.userId }, select: { nameBn: true, nameEn: true } });
  const lines = await tx.chargeItem.findMany({ where: { invoiceId: inv.id }, orderBy: { position: "asc" } });
  const rates = new Map<number, { netPaisa: number; vatPaisa: number }>();
  for (const l of lines) { const x = rates.get(l.vatRateBp) ?? { netPaisa: 0, vatPaisa: 0 }; x.netPaisa += l.netPaisa; x.vatPaisa += l.vatPaisa; rates.set(l.vatRateBp, x); }
  const snapshot: ReceiptSnapshot = {
    seller: { nameEn: org!.name, nameBn: org!.nameBn, address: org!.address, vatBin: org!.vatBin, vatBinSample: org!.vatBinSample },
    invoice: { id: inv.id, number: inv.number!, issuedAt: inv.issuedAt!.toISOString() },
    patient: { nameBn: p!.nameBn, nameEn: p!.nameEn, facilityNo: p!.facilityNo },
    lines: lines.map((l) => ({ nameBn: l.nameBn, nameEn: l.nameEn, qty: l.qty, unitPaisa: l.unitPaisa ?? 0, vatRateBp: l.vatRateBp, grossPaisa: l.grossPaisa, discountPaisa: l.discountPaisa, netPaisa: l.netPaisa, vatPaisa: l.vatPaisa, totalPaisa: l.totalPaisa, notBilledReason: l.notBilledReason })),
    subtotalPaisa: inv.subtotalPaisa, discountPaisa: inv.discountPaisa, vatPaisa: inv.vatPaisa, totalPaisa: inv.totalPaisa,
    paidPaisa: inv.paidPaisa, duePaisa: inv.totalPaisa - inv.paidPaisa,
    vatByRate: [...rates.entries()].sort((a, b) => a[0] - b[0]).map(([rateBp, x]) => ({ rateBp, ...x })),
    discount: v.invoice.discount ? { category: v.invoice.discount.category, reason: v.invoice.discount.reason, approvedBy: v.invoice.discount.approvedBy ? { nameBn: v.invoice.discount.approvedBy.nameBn, nameEn: v.invoice.discount.approvedBy.nameEn } : null } : null,
    paidBy: v.paidBy,
    cashier: { nameBn: me?.nameBn ?? "—", nameEn: me?.nameEn ?? "—" },
  };
  const yy = dhakaDay(now).slice(2, 4);
  const name = `receipt:${s.organizationId}:${yy}`;
  const seq = await tx.sequence.upsert({ where: { tenantId_name: { tenantId: s.tenantId, name } }, create: { tenantId: s.tenantId, name, value: 1 }, update: { value: { increment: 1 } } });
  const r = await tx.receipt.create({ data: {
    tenantId: s.tenantId, organizationId: s.organizationId, invoiceId: inv.id, patientId: inv.patientId, number: `RCPT/${yy}/${String(seq.value).padStart(4, "0")}`,
    verifyCode: newVerifyCode(), paidPaisa: snapshot.paidPaisa, totalPaisa: snapshot.totalPaisa, duePaisa: snapshot.duePaisa, snapshot: snapshot as object, createdById: s.userId, createdAt: now,
  } });
  return { r, created: true };
}

/** The original print, or a duplicate with a reason. The PDF is rendered, stored once, and logged. */
export async function printReceipt(tx: Tx, s: SessionData, receiptId: string, req: PrintRequest, now: Date): Promise<{ r: Rc; print: Pr }> {
  requireWriter(s);
  const r0 = await receiptHere(tx, s, receiptId);
  // Receipts cannot be locked FOR UPDATE (setu_app has no UPDATE on them): the bill's row lock serialises two prints,
  // and the unique (receiptId, copy) is the backstop.
  await invoiceHere(tx, s, r0.invoiceId, true);
  const copy = await tx.receiptPrint.count({ where: { receiptId: r0.id } });
  if (copy > 0 && !req.reason) throw err(409, "reprint_needs_reason", "আবার প্রিন্টের কারণ বেছে নিন", "Choose a reason to reprint", { field: "reason" });
  if (copy === 0 && req.reason) throw err(409, "not_printed_yet", "মূল রসিদ এখনও প্রিন্ট হয়নি", "The original has not been printed yet", { field: "reason" });
  const me = await tx.user.findFirst({ where: { id: s.userId }, select: { nameBn: true, nameEn: true } });
  const bill = await tx.invoice.findFirst({ where: { id: r0.invoiceId }, select: { status: true } });
  const html = receiptHtml({ voided: bill?.status === "entered_in_error",
    snapshot: r0.snapshot as unknown as ReceiptSnapshot, number: r0.number, createdAt: r0.createdAt, verifyUrl: verifyUrl(r0.verifyCode), format: req.format, lang: req.lang,
    print: { copy, reason: req.reason ?? null, printedAt: now, printedBy: { nameBn: me?.nameBn ?? "—", nameEn: me?.nameEn ?? "—" } },
  });
  const pdf = await htmlToPdf(html, req.format);
  const storageKey = `tenants/${s.tenantId}/receipts/${r0.id}/${copy}-${req.format}-${req.lang}-${randomBytes(4).toString("hex")}.pdf`;
  const print = await tx.receiptPrint.create({ data: { tenantId: s.tenantId, receiptId: r0.id, copy, reason: req.reason ?? null, format: req.format, lang: req.lang, storageKey, printedById: s.userId, printedAt: now } });
  await storage.put(storageKey, pdf, "application/pdf");
  return { r: r0, print };
}

export async function printPdf(tx: Tx, s: SessionData, receiptId: string, printId: string): Promise<{ bytes: Uint8Array; print: Pr; r: Rc }> {
  const r = await receiptHere(tx, s, receiptId);
  const print = await tx.receiptPrint.findFirst({ where: { id: printId, receiptId: r.id } });
  if (!print) throw notFound();
  const bytes = await storage.get(print.storageKey);
  if (!bytes) throw err(410, "file_missing", "ফাইলটি পাওয়া যায়নি", "The stored file is missing");
  return { bytes, print, r };
}

