/* Billing routes (slice A6–A7). Each route checks the screen it serves with `authorize` (access matrix: OPD bill =
   cashier, owner, admin, receptionist — receptionists read only; Payment = cashier, owner, admin; Approvals = owner,
   admin), runs in one transaction under RLS (command/query) and audits what it reveals or changes. Money rules and
   state changes are @setu/domain via modules/billing.ts.
   Provider callbacks have no session: the signature is checked over the raw body, the tenant comes from
   payment_ref_lookup, and the event is handled in forTenant with its own audit row. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  AddLineRequest, ApprovalQuery, PrintRequest, VerifyCode, type PrintResponse, type ReceiptList, type ReceiptView, type VerifyResponse, ApproveRequest, ChargeDefinitionQuery, DiscountRequest, FakeProviderEventKind, NewPaymentRequest, RejectRequest, RevRequest, SetQtyRequest, VerifyTrxRequest,
  type ApprovalDecisionResponse, type ApprovalList, type BillingWorklist, type ChargeDefinitionList, type DiscountResponse, type InvoiceView, type PaymentResponse, type ProviderCallbackResponse,
} from "@setu/contracts";
import { authorize } from "@setu/domain";
import { z } from "zod";
import { fakeProvider, InvalidSignature, payments, providerByName, type ProviderWebhook } from "../adapters/payments/index.js";
import { command, query } from "../command.js";
import { config } from "../config.js";
import { err, forbidden } from "../errors.js";
import {
  addDeskLine, addPayment, approvalList, billingWorklist, chargeDefinitions, createInvoice, decideDiscount, handleProviderEvent, invoiceView, removeDiscount, removeLine,
  invoiceHere, issueInvoice, requestDiscount, retryPayment, setLineQty, verifyTrx,
} from "../modules/billing.js";
import { createReceipt, printPdf, printReceipt, receiptList, receiptView } from "../modules/receipts.js";
import { requireSession } from "../plugins/session.js";

function requireBill(req: FastifyRequest, screen: "opd" | "pay" | "receipt" | "approvals") {
  const s = requireSession(req);
  const d = authorize(s.role, s.plan, "bill", screen);
  if (!d.allowed) throw forbidden(d.reason ?? "unknown");
  return s;
}
const isUnique = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

/** Handle one verified provider event under the payment's tenant. A second delivery of the same event racing the
    first loses on the unique (provider, eventId) and answers noop. */
async function processCallback(req: FastifyRequest, ev: ProviderWebhook): Promise<ProviderCallbackResponse> {
  if (!config.dbEnabled) throw err(503, "db_off", "ডাটাবেস চালু নেই", "The database is not running");
  const { forTenant, paymentRefLookup } = await import("@setu/db");
  const hit = await paymentRefLookup(payments.name, ev.providerRef);
  if (!hit) throw err(404, "unknown_reference", "অজানা রেফারেন্স", "Unknown reference");
  try {
    return await forTenant(hit.tenantId, async (tx) => {
      const r = await handleProviderEvent(tx, hit.tenantId, hit.paymentId, hit.superseded, ev, new Date());
      for (const a of r.audit) await tx.auditEvent.create({ data: {
        tenantId: hit.tenantId, userId: null, role: null, action: a.action, entity: a.entity, entityId: a.entityId, patientId: a.patientId, ip: req.ip,
        detail: { route: req.routeOptions.url, method: req.method, ...(a.detail ?? {}) } as object,
      } });
      return r.body;
    });
  } catch (e) {
    if (isUnique(e)) return { outcome: "noop", reason: "repeat" };
    throw e;
  }
}

export async function billingRoutes(app: FastifyInstance) {
  /* ── reads ── */
  app.get("/v1/billing/worklist", async (req): Promise<BillingWorklist> => {
    requireBill(req, "opd");
    return query(req, async (tx, s) => {
      const w = await billingWorklist(tx, s, new Date());
      return { body: w, audit: [{ action: "view", entity: "Encounter", detail: { purpose: "billing-worklist", count: w.items.length, patientIds: w.items.map((i) => i.encounter.patient.id) } }] };
    });
  });
  app.get("/v1/charge-definitions", async (req): Promise<ChargeDefinitionList> => {
    requireBill(req, "opd");
    const { q } = ChargeDefinitionQuery.parse(req.query);
    return query(req, async (tx, s) => ({ body: await chargeDefinitions(tx, s, q), audit: [] }));
  });
  app.get("/v1/invoices/:id", async (req): Promise<InvoiceView> => {
    requireBill(req, "opd");
    const { id } = req.params as { id: string };
    return query(req, async (tx, s) => {
      const inv = await invoiceHere(tx, s, id);
      return { body: await invoiceView(tx, s, inv), audit: [{ action: "view", entity: "Invoice", entityId: id, patientId: inv.patientId }] };
    });
  });

  /* ── the draft bill (Idempotency-Key required) ── */
  app.post("/v1/encounters/:id/invoice", { config: { ownTx: true } }, async (req, reply): Promise<InvoiceView> => {
    requireBill(req, "opd");
    const { id } = req.params as { id: string };
    return command(req, reply, async (tx, s) => {
      const r = await createInvoice(tx, s, id, new Date());
      const view = await invoiceView(tx, s, r.inv);
      return { status: r.created ? 201 : 200, body: view, audit: r.created
        ? [{ action: "create", entity: "Invoice", entityId: r.inv.id, patientId: r.patientId, detail: { encounterId: id, lines: view.lines.map((l) => ({ source: l.source, code: l.code, unitPaisa: l.unitPaisa })), totalPaisa: view.invoice.totalPaisa } }]
        : [{ action: "view", entity: "Invoice", entityId: r.inv.id, patientId: r.patientId }] };
    });
  });
  app.post("/v1/invoices/:id/lines", { config: { ownTx: true } }, async (req, reply): Promise<InvoiceView> => {
    requireBill(req, "opd");
    const { id } = req.params as { id: string };
    const body = AddLineRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const inv = await addDeskLine(tx, s, id, body.code, body.qty, body.rev);
      return { body: await invoiceView(tx, s, inv), audit: [{ action: "update", entity: "Invoice", entityId: id, patientId: inv.patientId, detail: { addLine: body.code, qty: body.qty, totalPaisa: inv.totalPaisa } }] };
    });
  });
  app.post("/v1/invoices/:id/lines/:lineId/qty", { config: { ownTx: true } }, async (req, reply): Promise<InvoiceView> => {
    requireBill(req, "opd");
    const { id, lineId } = req.params as { id: string; lineId: string };
    const body = SetQtyRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const inv = await setLineQty(tx, s, id, lineId, body.qty, body.rev);
      return { body: await invoiceView(tx, s, inv), audit: [{ action: "update", entity: "Invoice", entityId: id, patientId: inv.patientId, detail: { line: lineId, qty: body.qty, totalPaisa: inv.totalPaisa } }] };
    });
  });
  app.post("/v1/invoices/:id/lines/:lineId/remove", { config: { ownTx: true } }, async (req, reply): Promise<InvoiceView> => {
    requireBill(req, "opd");
    const { id, lineId } = req.params as { id: string; lineId: string };
    const { rev } = RevRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await removeLine(tx, s, id, lineId, rev);
      return { body: await invoiceView(tx, s, r.inv), audit: [{ action: "update", entity: "Invoice", entityId: id, patientId: r.inv.patientId, detail: { removeLine: r.line.code, qty: r.line.qty, totalPaisa: r.inv.totalPaisa } }] };
    });
  });
  app.post("/v1/invoices/:id/discount", { config: { ownTx: true } }, async (req, reply): Promise<DiscountResponse> => {
    requireBill(req, "opd");
    const { id } = req.params as { id: string };
    const body = DiscountRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await requestDiscount(tx, s, id, body, new Date());
      const detail = { amountPaisa: r.amountPaisa, category: body.category, reason: body.reason };
      return { body: { outcome: r.outcome, view: await invoiceView(tx, s, r.inv) }, audit: r.outcome === "applied"
        ? [{ action: "update", entity: "Invoice", entityId: id, patientId: r.inv.patientId, detail: { discount: "applied-within-limit", ...detail } }]
        : [{ action: "create", entity: "Task", entityId: r.taskId!, patientId: r.inv.patientId, detail: { kind: "discount-approval", invoiceId: id, ...detail } }] };
    });
  });
  app.post("/v1/invoices/:id/discount/remove", { config: { ownTx: true } }, async (req, reply): Promise<InvoiceView> => {
    requireBill(req, "opd");
    const { id } = req.params as { id: string };
    const { rev } = RevRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const inv = await removeDiscount(tx, s, id, rev);
      return { body: await invoiceView(tx, s, inv), audit: [{ action: "update", entity: "Invoice", entityId: id, patientId: inv.patientId, detail: { discount: "removed" } }] };
    });
  });
  app.post("/v1/invoices/:id/issue", { config: { ownTx: true } }, async (req, reply): Promise<InvoiceView> => {
    requireBill(req, "opd");
    const { id } = req.params as { id: string };
    const { rev } = RevRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const inv = await issueInvoice(tx, s, id, rev, new Date());
      return { body: await invoiceView(tx, s, inv), audit: [{ action: "update", entity: "Invoice", entityId: id, patientId: inv.patientId, detail: { event: "issue", number: inv.number, totalPaisa: inv.totalPaisa } }] };
    });
  });

  /* ── approvals (owner / admin) ── */
  app.get("/v1/approvals", async (req): Promise<ApprovalList> => {
    requireBill(req, "approvals");
    const { status } = ApprovalQuery.parse(req.query);
    return query(req, async (tx, s) => {
      const list = await approvalList(tx, s, status, new Date());
      return { body: list, audit: [{ action: "view", entity: "Task", detail: { purpose: "discount-approvals", status, count: list.items.length, patientIds: list.items.map((i) => i.patient.id) } }] };
    });
  });
  for (const decision of ["approve", "reject"] as const) {
    app.post(`/v1/approvals/:id/${decision}`, { config: { ownTx: true } }, async (req, reply): Promise<ApprovalDecisionResponse> => {
      requireBill(req, "approvals");
      const { id } = req.params as { id: string };
      const { note } = decision === "approve" ? ApproveRequest.parse(req.body ?? {}) : RejectRequest.parse(req.body);
      return command(req, reply, async (tx, s) => {
        const r = await decideDiscount(tx, s, id, decision, note, new Date());
        return { body: { approval: r.item, view: await invoiceView(tx, s, r.inv) }, audit: [
          { action: "update", entity: "Task", entityId: id, patientId: r.inv.patientId, detail: { event: decision, invoiceId: r.inv.id, amountPaisa: r.item.amountPaisa, note: note ?? null } },
          ...(decision === "approve" ? [{ action: "update", entity: "Invoice", entityId: r.inv.id, patientId: r.inv.patientId, detail: { discount: "applied-after-approval", taskId: id, amountPaisa: r.item.amountPaisa } }] : []),
        ] };
      });
    });
  }

  /* ── payments ── */
  app.post("/v1/invoices/:id/payments", { config: { ownTx: true } }, async (req, reply): Promise<PaymentResponse> => {
    requireBill(req, "pay");
    const { id } = req.params as { id: string };
    const body = NewPaymentRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await addPayment(tx, s, id, body, new Date());
      const view = await invoiceView(tx, s, r.inv);
      return { status: 201, body: { payment: view.payments.find((p) => p.id === r.payment.id)!, view }, audit: [
        { action: "create", entity: "Payment", entityId: r.payment.id, patientId: r.inv.patientId, detail: { method: body.method, amountPaisa: body.amountPaisa, status: r.payment.status, invoiceStatus: r.inv.status } },
      ] };
    });
  });
  app.post("/v1/payments/:id/retry", { config: { ownTx: true } }, async (req, reply): Promise<PaymentResponse> => {
    requireBill(req, "pay");
    const { id } = req.params as { id: string };
    return command(req, reply, async (tx, s) => {
      const r = await retryPayment(tx, s, id, new Date());
      const view = await invoiceView(tx, s, r.inv);
      return { body: { payment: view.payments.find((p) => p.id === id)!, view }, audit: [{ action: "update", entity: "Payment", entityId: id, patientId: r.inv.patientId, detail: { event: "retry", attempt: r.payment.attempt } }] };
    });
  });
  app.post("/v1/payments/:id/verify-trx", { config: { ownTx: true } }, async (req, reply): Promise<PaymentResponse> => {
    requireBill(req, "pay");
    const { id } = req.params as { id: string };
    const { trxId } = VerifyTrxRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await verifyTrx(tx, s, id, trxId.toUpperCase(), new Date());
      const view = await invoiceView(tx, s, r.inv);
      return { body: { payment: view.payments.find((p) => p.id === id)!, view }, audit: [{ action: "update", entity: "Payment", entityId: id, patientId: r.inv.patientId, detail: { event: "verify-trx", outcome: r.outcome } }] };
    });
  });

  /* ── receipts (cashier, owner, admin) ── */
  app.get("/v1/invoices/:id/receipts", async (req): Promise<ReceiptList> => {
    requireBill(req, "receipt");
    const { id } = req.params as { id: string };
    return query(req, async (tx, s) => {
      const r = await receiptList(tx, s, id);
      return { body: r.list, audit: [{ action: "view", entity: "Receipt", patientId: r.patientId, detail: { invoiceId: id, count: r.list.items.length } }] };
    });
  });
  app.post("/v1/invoices/:id/receipts", { config: { ownTx: true } }, async (req, reply): Promise<ReceiptView> => {
    requireBill(req, "receipt");
    const { id } = req.params as { id: string };
    return command(req, reply, async (tx, s) => {
      const r = await createReceipt(tx, s, id, new Date());
      return { status: r.created ? 201 : 200, body: await receiptView(tx, r.r), audit: [{ action: r.created ? "create" : "view", entity: "Receipt", entityId: r.r.id, patientId: r.r.patientId, detail: { invoiceId: id, number: r.r.number, paidPaisa: r.r.paidPaisa } }] };
    });
  });
  app.get("/v1/receipts/:id", async (req): Promise<ReceiptView> => {
    requireBill(req, "receipt");
    const { id } = req.params as { id: string };
    return query(req, async (tx, s) => {
      const r = await tx.receipt.findFirst({ where: { id, organizationId: s.organizationId } });
      if (!r) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
      await invoiceHere(tx, s, r.invoiceId);
      return { body: await receiptView(tx, r), audit: [{ action: "view", entity: "Receipt", entityId: id, patientId: r.patientId }] };
    });
  });
  app.post("/v1/receipts/:id/print", { config: { ownTx: true } }, async (req, reply): Promise<PrintResponse> => {
    requireBill(req, "receipt");
    const { id } = req.params as { id: string };
    const body = PrintRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => {
      const r = await printReceipt(tx, s, id, body, new Date());
      const view = await receiptView(tx, r.r);
      return { status: 201, body: { print: view.prints.find((p) => p.id === r.print.id)!, view }, audit: [{
        action: r.print.copy === 0 ? "print" : "reprint", entity: "Receipt", entityId: id, patientId: r.r.patientId,
        detail: { number: r.r.number, copy: r.print.copy, reason: r.print.reason, format: r.print.format, lang: r.print.lang },
      }] };
    });
  });
  app.get("/v1/receipts/:id/prints/:printId/pdf", async (req, reply) => {
    requireBill(req, "receipt");
    const { id, printId } = req.params as { id: string; printId: string };
    const r = await query(req, async (tx, s) => {
      const x = await printPdf(tx, s, id, printId);
      return { body: x, audit: [{ action: "view", entity: "ReceiptPrint", entityId: printId, patientId: x.r.patientId, detail: { receiptId: id, copy: x.print.copy } }] };
    });
    const fileName = `${r.r.number.replace(/\//g, "-")}${r.print.copy ? `-DUPLICATE-${r.print.copy}` : ""}.pdf`;
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="${fileName}"`).header("cache-control", "no-store").send(Buffer.from(r.bytes));
  });

  /* ── public receipt check (the QR): no session, rate-limited, facility / number / date / amount only ── */
  app.get("/v1/verify/rc/:code", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply): Promise<VerifyResponse> => {
    const code = VerifyCode.safeParse((req.params as { code: string }).code.toUpperCase());
    if (!config.dbEnabled) throw err(503, "db_off", "ডাটাবেস চালু নেই", "The database is not running");
    reply.header("cache-control", "no-store");
    const hit = code.success ? await (await import("@setu/db")).receiptVerifyLookup(code.data) : null;
    if (!hit) throw err(404, "not_found", "এই কোডের কোনো রসিদ পাওয়া যায়নি", "No receipt found for this code");
    return { facilityEn: hit.facilityEn, facilityBn: hit.facilityBn, number: hit.number, date: new Date(hit.createdAt).toISOString(), amountPaisa: hit.paidPaisa };
  });

  /* ── provider callbacks: raw body for the signature, no session ── */
  await app.register(async (sub) => {
    sub.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 16_384 }, (_req, body, done) => done(null, body));
    sub.post("/v1/payments/callback/:provider", async (req): Promise<ProviderCallbackResponse> => {
      const { provider } = req.params as { provider: string };
      const p = providerByName(provider);
      if (!p) throw err(404, "unknown_provider", "অজানা প্রদানকারী", "Unknown provider");
      let ev: ProviderWebhook;
      try { ev = p.parseWebhook(req.headers, typeof req.body === "string" ? req.body : ""); }
      catch (e) { if (e instanceof InvalidSignature || e instanceof SyntaxError) throw err(401, "invalid_signature", "স্বাক্ষর মেলেনি", "Invalid signature"); throw e; }
      return processCallback(req, ev);
    });
  });

  /* ── dev and tests only: play the customer's side of the fake provider (never with a real provider or in production) ── */
  if (fakeProvider() && process.env.NODE_ENV !== "production") {
    app.post("/v1/dev/fake-payments/:id/:kind", async (req) => {
      requireBill(req, "pay");
      const { id, kind } = z.object({ id: z.string(), kind: FakeProviderEventKind }).parse(req.params);
      const o = z.object({ deliver: z.boolean().default(true), amountPaisa: z.number().int().positive().optional() }).parse(req.body ?? {});
      const ref = await query(req, async (tx, s) => {
        const p = await tx.payment.findFirst({ where: { id, organizationId: s.organizationId }, select: { providerRef: true } });
        return { body: p?.providerRef ?? null, audit: [] };
      });
      if (!ref) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
      const cb = fakeProvider()!.simulate(ref, kind, { deliver: o.deliver, amountPaisa: o.amountPaisa });
      if (!cb) return { delivered: false };
      const ev = fakeProvider()!.parseWebhook(cb.headers, cb.body);
      return { delivered: true, trxId: cb.trxId, ...(await processCallback(req, ev)) };
    });
  }
}
