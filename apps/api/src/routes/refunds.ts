/* Refund routes (ADR 0013). Screens: bill/refund (cashier, owner, admin) and ph/refund (pharmacist, owner, admin — the
   pharmacist sees pharmacy and OTC bills only, through invoiceHere); deciding is the owner's / admin's (bill/approvals,
   the single queue — /v1/approvals/:taskId/approve|reject also decides a refund). One transaction per request under RLS;
   every write takes an Idempotency-Key. Refunds need a connection: nothing here is ever queued on a device. A gateway
   refund is claimed in the request and sent to the gateway after the commit (`after`), its answer stored in a
   transaction of its own; the public voucher check has no session and shows facility, number, date and amount only. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { PrintRequest, ReconcileRefundRequest, RefundReleaseRequest, type RefundVoucherPrintResponse, RefundDecisionRequest, RefundListQuery, RefundPayRequest, RefundRequest, ResaleRequest, VerifyCode, type RefundableView, type RefundList, type RefundPayResponse, type RefundVoucherView, type RefundView, type VerifyResponse } from "@setu/contracts";
import { authorize } from "@setu/domain";
import { auditPublicLookup } from "../modules/documents.js";
import { command, query } from "../command.js";
import { config } from "../config.js";
import { err, forbidden } from "../errors.js";
import { askGateway, checkRefund, decideRefund, payRefund, printVoucher, refundableView, refundHere, refundList, refundView, releaseRefund, requestCaseRefund, requestRefund, resale, settleClaimed, voucherPdf, voucherView } from "../modules/refunds.js";
import { requireSession } from "../plugins/session.js";
import { clientKey } from "./billing.js";

type Need = "use" | "decide" | "case" | "resale";
/** bill/refund or ph/refund to use refunds; bill/approvals to decide; bill/reconcile for a case; ph/stock for resale. */
function requireRefund(req: FastifyRequest, need: Need) {
  const s = requireSession(req);
  const ok = need === "decide" ? authorize(s.role, s.plan, "bill", "approvals")
    : need === "case" ? authorize(s.role, s.plan, "bill", "reconcile")
    : need === "resale" ? authorize(s.role, s.plan, "ph", "stock")
    : authorize(s.role, s.plan, "bill", "refund").allowed ? authorize(s.role, s.plan, "bill", "refund") : authorize(s.role, s.plan, "ph", "refund");
  if (!ok.allowed) throw forbidden(ok.reason === "plan" ? "plan" : ok.reason === "role" ? "role" : "unknown");
  return s;
}
const pid = z.object({ id: z.string().min(1).max(80) });

export async function refundRoutes(app: FastifyInstance) {
  app.get("/v1/invoices/:id/refundable", async (req): Promise<RefundableView> => {
    requireRefund(req, "use");
    const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => {
      const v = await refundableView(tx, s, id);
      return { body: v, audit: [{ action: "view", entity: "Invoice", entityId: id, patientId: v.patient?.id ?? null, detail: { purpose: "refundable" } }] };
    });
  });

  app.post("/v1/invoices/:id/refunds", { config: { ownTx: true } }, async (req, reply): Promise<RefundView> => {
    requireRefund(req, "use");
    const { id } = pid.parse(req.params);
    const body = RefundRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await requestRefund(tx, s, id, body, new Date());
      return { status: 201, body: await refundView(tx, s, r.r), audit: r.audit };
    });
  });

  app.get("/v1/refunds", async (req): Promise<RefundList> => {
    requireRefund(req, "use");
    const q = RefundListQuery.parse(req.query);
    return query(req, async (tx, s) => {
      const list = await refundList(tx, s, q, new Date());
      return { body: list, audit: [{ action: "view", entity: "Refund", detail: { purpose: "refund-list", status: q.status, count: list.items.length, patientIds: list.items.flatMap((i) => (i.patient ? [i.patient.id] : [])) } }] };
    });
  });

  app.get("/v1/refunds/:id", async (req): Promise<RefundView> => {
    const s0 = requireSession(req);
    // the owner / admin open a refund from the Approvals queue too
    if (!authorize(s0.role, s0.plan, "bill", "approvals").allowed) requireRefund(req, "use");
    const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => {
      const v = await refundView(tx, s, await refundHere(tx, s, id));
      return { body: v, audit: [{ action: "view", entity: "Refund", entityId: id, patientId: v.patient?.id ?? null }] };
    });
  });

  app.post("/v1/refunds/:id/decision", { config: { ownTx: true } }, async (req, reply): Promise<RefundView> => {
    requireRefund(req, "decide");
    const { id } = pid.parse(req.params);
    const body = RefundDecisionRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await decideRefund(tx, s, id, body, new Date());
      return { body: await refundView(tx, s, r.r), audit: r.audit };
    });
  });

  app.post("/v1/refunds/:id/pay", { config: { ownTx: true } }, async (req, reply): Promise<RefundPayResponse> => {
    requireRefund(req, "use");
    const { id } = pid.parse(req.params);
    const body = RefundPayRequest.parse(req.body);
    let claimed: string[] = [];
    return command(req, reply, async (tx, s) => {
      const r = await payRefund(tx, s, id, body, new Date());
      claimed = r.claimed;
      const view = await refundView(tx, s, r.r);
      return { body: { outcome: (view.refund.status === "paid" ? "paid" : "paying") as RefundPayResponse["outcome"], view }, audit: r.audit };
    }, {
      // ADR 0013: the gateway is called only after the claim committed; its answer is what the cashier sees
      after: async (body, s) => {
        if (!claimed.length) return body;
        await settleClaimed(s.tenantId, s.organizationId, claimed, new Date(), s.userId);
        const { forTenant } = await import("@setu/db");
        const view = await forTenant(s.tenantId, async (tx) => refundView(tx, s, await refundHere(tx, s, id)), { userId: s.userId });
        return { outcome: view.refund.status === "paid" ? "paid" : view.allocations.some((a) => a.status === "paying") ? "paying" : "failed", view };
      },
    });
  });

  app.post("/v1/refunds/:id/check", { config: { ownTx: true } }, async (req, reply): Promise<RefundView> => {
    requireRefund(req, "use");
    const { id } = pid.parse(req.params);
    let paying: { id: string }[] = [];
    return command(req, reply, async (tx, s) => {
      paying = (await checkRefund(tx, s, id)).allocations;
      const view = await refundView(tx, s, await refundHere(tx, s, id));
      return { body: view, audit: [{ action: "view", entity: "Refund", entityId: id, patientId: view.patient?.id ?? null, detail: { event: "gateway-check", allocations: paying.map((a) => a.id) } }] };
    }, {
      after: async (_body, s) => {
        for (const a of paying) await askGateway(s.tenantId, s.organizationId, a.id, new Date(), s.userId);
        const { forTenant } = await import("@setu/db");
        return forTenant(s.tenantId, async (tx) => refundView(tx, s, await refundHere(tx, s, id)), { userId: s.userId });
      },
    });
  });

  /* decision 235: the owner settles a gateway refund stuck "processing" from what the bKash merchant portal shows */
  app.post("/v1/refunds/:id/release", { config: { ownTx: true } }, async (req, reply): Promise<RefundView> => {
    requireRefund(req, "case"); // the owner's queue
    const { id } = pid.parse(req.params);
    const body = RefundReleaseRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await releaseRefund(tx, s, id, body, new Date());
      return { body: await refundView(tx, s, r.r), audit: r.audit };
    });
  });

  app.get("/v1/refunds/:id/voucher", async (req): Promise<RefundVoucherView> => {
    const s0 = requireSession(req);
    if (!authorize(s0.role, s0.plan, "bill", "approvals").allowed) requireRefund(req, "use");
    const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => {
      const v = await voucherView(tx, s, id);
      return { body: v, audit: [{ action: "view", entity: "RefundVoucher", entityId: v.voucher.id, patientId: (await refundHere(tx, s, id)).patientId, detail: { refundId: id, number: v.voucher.number } }] };
    });
  });

  app.post("/v1/refunds/:id/voucher/print", { config: { ownTx: true } }, async (req, reply): Promise<RefundVoucherPrintResponse> => {
    requireRefund(req, "use");
    const { id } = pid.parse(req.params);
    const body = PrintRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => {
      const p = await printVoucher(tx, s, id, body, new Date());
      const view = await voucherView(tx, s, id);
      return { status: 201, body: { print: view.prints.find((x) => x.id === p.print.id)!, view }, audit: [{
        action: p.print.copy === 0 ? "print" : "reprint", entity: "RefundVoucher", entityId: p.voucher.id, patientId: p.patientId,
        detail: { number: p.voucher.number, copy: p.print.copy, reason: p.print.reason, format: p.print.format, lang: p.print.lang },
      }] };
    }, { txTimeoutMs: 30_000 });
  });
  app.get("/v1/refunds/:id/voucher/prints/:printId/pdf", async (req, reply) => {
    requireRefund(req, "use");
    const { id, printId } = z.object({ id: z.string().min(1).max(80), printId: z.string().min(1).max(80) }).parse(req.params);
    const r = await query(req, async (tx, s) => {
      const x = await voucherPdf(tx, s, id, printId);
      return { body: x, audit: [{ action: "view", entity: "RefundVoucherPrint", entityId: printId, patientId: x.patientId, detail: { refundId: id, copy: x.print.copy } }] };
    });
    const fileName = `${r.print.voucher.number.replace(/\//g, "-")}${r.print.copy ? `-DUPLICATE-${r.print.copy}` : ""}.pdf`;
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="${fileName}"`).header("cache-control", "no-store").send(Buffer.from(r.bytes));
  });

  /* ── reconciliation → refund to patient (owner) ── */
  app.post("/v1/reconciliation/:id/refund", { config: { ownTx: true } }, async (req, reply): Promise<RefundView> => {
    requireRefund(req, "case");
    const { id } = pid.parse(req.params);
    const body = ReconcileRefundRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await requestCaseRefund(tx, s, id, body, new Date());
      return { status: 201, body: await refundView(tx, s, r.r), audit: r.audit };
    });
  });

  /* ── pharmacy: quarantine → counter ── */
  app.post("/v1/pharmacy/resale", { config: { ownTx: true } }, async (req, reply) => {
    requireRefund(req, "resale");
    const body = ResaleRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await resale(tx, s, body, new Date());
      return { status: 201, body: r.body, audit: r.audit };
    });
  });

  /* ── public voucher check (the QR): no session, rate-limited, facility / number / date / amount only ── */
  app.get("/v1/verify/rf/:code", { config: { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: clientKey } } }, async (req, reply): Promise<VerifyResponse> => {
    const code = VerifyCode.safeParse((req.params as { code: string }).code.toUpperCase());
    if (!config.dbEnabled) throw err(503, "db_off", "ডাটাবেস চালু নেই", "The database is not running");
    reply.header("cache-control", "no-store");
    const hit = code.success ? await (await import("@setu/db")).refundVerifyLookup(code.data) : null;
    if (!hit) throw err(404, "not_found", "এই কোডের কোনো রিফান্ড ভাউচার পাওয়া যায়নি", "No refund voucher found for this code");
    await auditPublicLookup(hit.target, "RefundVoucher", code.data!, req.ip); // external review B8
    return { facilityEn: hit.facilityEn, facilityBn: hit.facilityBn, number: hit.number, date: new Date(hit.createdAt).toISOString(), amountPaisa: hit.amountPaisa };
  });
}
