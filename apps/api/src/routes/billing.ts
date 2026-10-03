/* Billing routes (slice A6–A7). Each route checks the screen it serves with `authorize` (access matrix: OPD bill =
   cashier, owner, admin, receptionist — receptionists read only; Payment = cashier, owner, admin; Approvals = owner,
   admin), runs in one transaction under RLS (command/query) and audits what it reveals or changes. Money rules and
   state changes are @setu/domain via modules/billing.ts.
   Provider callbacks have no session: the signature is checked over the raw body, the tenant comes from
   payment_ref_lookup, and the event is handled in forTenant with its own audit row. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  AddLineRequest, ApprovalQuery, NotBilledRequest, PrintRequest, ReconcileApplyRequest, ReconcileQuery, ReconcileResolveRequest, VoidRequest, type ReconcileDecisionResponse, type ReconcileList, VerifyCode, type PrintResponse, type ReceiptList, type ReceiptView, type VerifyResponse, ApproveRequest, ChargeDefinitionQuery, DiscountRequest, FakeProviderEventKind, NewPaymentRequest, RejectRequest, RevRequest, SetQtyRequest, VerifyTrxRequest,
  type ApprovalDecisionResponse, type ApprovalList, type BillingWorklist, type ChargeDefinitionList, type DiscountResponse, type InvoiceView, type PaymentResponse, type ProviderCallbackResponse,
} from "@setu/contracts";
import { authorize } from "@setu/domain";
import { z } from "zod";
import { fakeProvider, InvalidSignature, payments, providerByName, type ProviderWebhook } from "../adapters/payments/index.js";
import { command, query } from "../command.js";
import { config } from "../config.js";
import { err, forbidden } from "../errors.js";
import {
  addDeskLine, addPayment, approvalList, billingWorklist, cancelPayment, chargeDefinitions, createInvoice, decideApproval, decideReconcile, reconcileList, refreshOrders, requestNotBilled, voidInvoice, handleProviderEvent, invoiceView, removeDiscount, removeLine,
  invoiceHere, issueInvoice, requestDiscount, retryPayment, setLineQty, verifyTrx,
} from "../modules/billing.js";
import { createReceipt, printPdf, printReceipt, receiptList, receiptView } from "../modules/receipts.js";
import { requireSession } from "../plugins/session.js";

function requireBill(req: FastifyRequest, screen: "opd" | "pay" | "receipt" | "approvals" | "reconcile") {
  const s = requireSession(req);
  const d = authorize(s.role, s.plan, "bill", screen);
  if (!d.allowed) throw forbidden(d.reason ?? "unknown");
  return s;
}
type SessionRole = ReturnType<typeof requireSession>["role"];
/* Rate-limit key for the public verify page: behind the staff app's proxy (a loopback or private address) the first
   X-Forwarded-For entry is the visitor; anything else is keyed on its own address, so a direct caller cannot pick its key
   (security review A6–A7: one shared limit for every patient). */
export function clientKey(req: FastifyRequest): string {
  const fromProxy = /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:127\.)/.test(req.ip);
  const xff = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return fromProxy && first ? first : req.ip;
}
const isUnique = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

/** Handle one verified provider event under the payment's tenant. A second delivery of the same event racing the
    first loses on the unique (provider, eventId) and answers noop. */
async function processCallback(req: FastifyRequest, ev: ProviderWebhook, actor: { userId: string; role: SessionRole } | null = null): Promise<ProviderCallbackResponse> {
  if (!config.dbEnabled) throw err(503, "db_off", "ডাটাবেস চালু নেই", "The database is not running");
  const { forTenant, paymentRefLookup } = await import("@setu/db");
  const hit = await paymentRefLookup(payments.name, ev.providerRef);
  if (!hit) throw err(404, "unknown_reference", "অজানা রেফারেন্স", "Unknown reference");
  try {
    return await forTenant(hit.tenantId, async (tx) => {
      const r = await handleProviderEvent(tx, hit.tenantId, hit.paymentId, hit.superseded, ev, new Date());
      for (const a of r.audit) await tx.auditEvent.create({ data: {
        tenantId: hit.tenantId, userId: actor?.userId ?? null, role: actor?.role ?? null, action: a.action, entity: a.entity, entityId: a.entityId, patientId: a.patientId, ip: req.ip,
        detail: { route: req.routeOptions.url, method: req.method, ...(a.detail ?? {}), ...(actor ? { simulatedBy: actor.userId, fakeGateway: true } : {}) } as object,
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
      const synced = r.sync && r.sync.removed.length + r.sync.added.length > 0;
      return { status: r.created ? 201 : 200, body: view, audit: r.created
        ? [{ action: "create", entity: "Invoice", entityId: r.inv.id, patientId: r.patientId, detail: { encounterId: id, lines: view.lines.map((l) => ({ source: l.source, code: l.code, unitPaisa: l.unitPaisa })), totalPaisa: view.invoice.totalPaisa } }]
        : [{ action: "view", entity: "Invoice", entityId: r.inv.id, patientId: r.patientId },
           ...(synced ? [{ action: "update", entity: "Invoice", entityId: r.inv.id, patientId: r.patientId, detail: { event: "refresh-orders", removed: r.sync!.removed, added: r.sync!.added, totalPaisa: view.invoice.totalPaisa } }] : [])] };
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

  /* ── follow-ups (ADR 0005) ── */
  app.post("/v1/invoices/:id/lines/:lineId/not-billed", { config: { ownTx: true } }, async (req, reply): Promise<InvoiceView> => {
    requireBill(req, "opd");
    const { id, lineId } = req.params as { id: string; lineId: string };
    const body = NotBilledRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await requestNotBilled(tx, s, id, lineId, body.reason, body.rev, new Date());
      return { body: await invoiceView(tx, s, r.inv), audit: [{ action: "create", entity: "Task", entityId: r.taskId, patientId: r.inv.patientId, detail: { kind: "bill-elsewhere", invoiceId: id, lineId, code: r.line.code, reason: body.reason } }] };
    });
  });
  app.post("/v1/invoices/:id/refresh-orders", { config: { ownTx: true } }, async (req, reply): Promise<InvoiceView> => {
    requireBill(req, "opd");
    const { id } = req.params as { id: string };
    const { rev } = RevRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await refreshOrders(tx, s, id, rev);
      return { body: await invoiceView(tx, s, r.inv), audit: r.changed ? [{ action: "update", entity: "Invoice", entityId: id, patientId: r.inv.patientId, detail: { event: "refresh-orders", removed: r.sync.removed, added: r.sync.added, totalPaisa: r.inv.totalPaisa } }] : [] };
    });
  });
  app.post("/v1/invoices/:id/void", { config: { ownTx: true } }, async (req, reply): Promise<InvoiceView> => {
    requireBill(req, "opd");
    const { id } = req.params as { id: string };
    const { reason } = VoidRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const inv = await voidInvoice(tx, s, id, reason, new Date());
      return { body: await invoiceView(tx, s, inv), audit: [{ action: "update", entity: "Invoice", entityId: id, patientId: inv.patientId, detail: { event: "void", reason, number: inv.number } }] };
    });
  });
  app.get("/v1/reconciliation", async (req): Promise<ReconcileList> => {
    requireBill(req, "reconcile");
    const { status } = ReconcileQuery.parse(req.query);
    return query(req, async (tx, s) => {
      const list = await reconcileList(tx, s, status);
      return { body: list, audit: [{ action: "view", entity: "Task", detail: { purpose: "payment-reconciliation", status, count: list.items.length, patientIds: list.items.flatMap((i) => (i.patient ? [i.patient.id] : [])) } }] };
    });
  });
  for (const action of ["apply", "resolve"] as const) {
    app.post(`/v1/reconciliation/:id/${action}`, { config: { ownTx: true } }, async (req, reply): Promise<ReconcileDecisionResponse> => {
      requireBill(req, "reconcile");
      const { id } = req.params as { id: string };
      const { note } = action === "apply" ? ReconcileApplyRequest.parse(req.body ?? {}) : ReconcileResolveRequest.parse(req.body);
      return command(req, reply, async (tx, s) => {
        const r = await decideReconcile(tx, s, id, action, note, new Date());
        return { body: { item: r.item }, audit: [
          { action: "update", entity: "Task", entityId: id, patientId: r.patientId, detail: { kind: "payment-reconciliation", event: action, paymentId: r.item.payment.id, invoiceId: r.invoiceId, note: note ?? null } },
          ...(action === "apply" ? [{ action: "update", entity: "Payment", entityId: r.item.payment.id, patientId: r.patientId, detail: { event: "confirm-by-reconciliation", taskId: id, trxId: r.item.reported.trxId, newerLinkCancelled: true } }] : []),
        ] };
      });
    });
  }

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
        const r = await decideApproval(tx, s, id, decision, note, new Date());
        return { body: { approval: r.item, view: await invoiceView(tx, s, r.inv) }, audit: [
          { action: "update", entity: "Task", entityId: id, patientId: r.inv.patientId, detail: { event: decision, kind: r.item.kind, invoiceId: r.inv.id, amountPaisa: r.item.amountPaisa, lineId: r.item.line?.id ?? null, note: note ?? null } },
          ...(decision === "approve" ? [{ action: "update", entity: "Invoice", entityId: r.inv.id, patientId: r.inv.patientId, detail: r.item.kind === "bill-elsewhere"
            ? { notBilledHere: r.item.line?.id ?? null, reason: r.item.reason, taskId: id }
            : { discount: "applied-after-approval", taskId: id, amountPaisa: r.item.amountPaisa } }] : []),
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
  app.post("/v1/payments/:id/cancel", { config: { ownTx: true } }, async (req, reply): Promise<PaymentResponse> => {
    requireBill(req, "pay");
    const { id } = req.params as { id: string };
    return command(req, reply, async (tx, s) => {
      const r = await cancelPayment(tx, s, id, new Date());
      const view = await invoiceView(tx, s, r.inv);
      return { body: { payment: view.payments.find((p) => p.id === id)!, view, ...(r.outcome === "confirmed" ? { notice: "paid-meanwhile" as const } : {}) }, audit: [{ action: "update", entity: "Payment", entityId: id, patientId: r.inv.patientId, detail: { event: "cancel-link", outcome: r.outcome } }] };
    });
  });
  app.post("/v1/payments/:id/verify-trx", { config: { ownTx: true } }, async (req, reply): Promise<PaymentResponse> => {
    requireBill(req, "pay");
    const { id } = req.params as { id: string };
    const { trxId } = VerifyTrxRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await verifyTrx(tx, s, id, trxId.toUpperCase(), new Date());
      const view = await invoiceView(tx, s, r.inv);
      return { body: { payment: view.payments.find((p) => p.id === id)!, view, ...(r.outcome === "earlier-link" ? { notice: "paid-on-earlier-link" as const } : {}) }, audit: [{ action: "update", entity: "Payment", entityId: id, patientId: r.inv.patientId, detail: { event: "verify-trx", outcome: r.outcome } }] };
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
    }, { txTimeoutMs: 30_000 });
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
  app.get("/v1/verify/rc/:code", { config: { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: clientKey } } }, async (req, reply): Promise<VerifyResponse> => {
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
  if (fakeProvider() && config.fakePaymentsDevRoute) {
    app.post("/v1/dev/fake-payments/:id/:kind", async (req) => {
      requireBill(req, "pay");
      const { id, kind } = z.object({ id: z.string(), kind: FakeProviderEventKind }).parse(req.params);
      const o = z.object({ deliver: z.boolean().default(true), amountPaisa: z.number().int().positive().optional() }).parse(req.body ?? {});
      const s0 = requireSession(req);
      const ref = await query(req, async (tx, s) => {
        const p = await tx.payment.findFirst({ where: { id, organizationId: s.organizationId }, select: { providerRef: true, invoiceId: true } });
        if (p) await invoiceHere(tx, s, p.invoiceId); // this facility and branch only
        return { body: p?.providerRef ?? null, audit: [] };
      });
      if (!ref) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
      const cb = fakeProvider()!.simulate(ref, kind, { deliver: o.deliver, amountPaisa: o.amountPaisa });
      // A "lost" callback: nothing reaches the API; the TrxID is what the patient would read on their phone.
      if (!cb) return { delivered: false, trxId: (await fakeProvider()!.verify({ providerRef: ref }))?.trxId ?? null };
      const ev = fakeProvider()!.parseWebhook(cb.headers, cb.body);
      return { delivered: true, trxId: cb.trxId, ...(await processCallback(req, ev, { userId: s0.userId, role: s0.role })) };
    });
  }
}
