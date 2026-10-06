/* The IPD running bill and the discharge checklist (ADR 0017, slice B7–B9). bill/ipd: cashier, owner, admin (Hospital
   Lite up); ipd/discharge: nurse, doctor, receptionist, admin, plus the pharmacist (step 3) and the bill's roles (4–5). */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DepositRequest, DischargeCancelRequest, InterimPrintRequest, type InterimPrintList, type IpdBillList, DischargeOrderRequest, DischargeStepDoneRequest, IpdChargeRequest, IpdPackageRequest,
  type ClassPreviewView, type DepositReceiptView, type DischargeList, type DischargeView, type IpdBillView, type PackageList,
} from "@setu/contracts";
import { attachLink } from "../modules/billing.js";
import { cancelDischarge, dischargeList, dischargeView, doneStep, orderDischarge, remindStep, takeStep } from "../modules/discharge.js";
import { addDeposit, applyPackage, billList, depositReceipt, interimPdf, interimPrints, printInterim, ipdBillView, openBill, packageList, postCharge, previewClass, requireIpdBill, withdrawCharge } from "../modules/ipdBill.js";
import { command, query } from "../command.js";
import { requireSession } from "../plugins/session.js";
import { sendLinkSms } from "./billing.js";

const pid = z.object({ id: z.string().min(1).max(64) });
const pstep = z.object({ id: z.string().min(1).max(64), key: z.string().min(1).max(20) });
const own = { config: { ownTx: true } };

export async function ipdBillRoutes(app: FastifyInstance) {
  /* ── the running bill ── */
  app.get("/v1/ipd/packages", async (req): Promise<PackageList> => query(req, async (tx, s) => ({ body: await packageList(tx, s), audit: [] })));
  // opening the bill posts what is due (a census the sweep has not reached yet)
  app.get("/v1/ipd/bills/:id", async (req): Promise<IpdBillView> => {
    requireIpdBill(requireSession(req)); const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => { const r = await openBill(tx, s, id, new Date()); return { body: r.view, audit: r.audit }; });
  });
  app.get("/v1/ipd/bills", async (req): Promise<IpdBillList> => {
    requireIpdBill(requireSession(req));
    return query(req, async (tx, s) => { const r = await billList(tx, s, new Date()); return { body: r.list, audit: [{ action: "view", entity: "Invoice", detail: { purpose: "ipd-bills", patientIds: r.patientIds } }] }; });
  });
  app.get("/v1/ipd/bills/:id/interim-prints", async (req): Promise<InterimPrintList> => {
    requireIpdBill(requireSession(req)); const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => ({ body: await interimPrints(tx, s, id), audit: [{ action: "view", entity: "InterimBillPrint", detail: { admissionId: id } }] }));
  });
  app.post("/v1/ipd/bills/:id/interim-prints", own, async (req, reply): Promise<InterimPrintList> => {
    requireIpdBill(requireSession(req)); const { id } = pid.parse(req.params); const body = InterimPrintRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => {
      const r = await printInterim(tx, s, id, body, new Date());
      return { status: 201, body: r.list, audit: [...r.synced, { action: r.copy === 0 ? "print" : "reprint", entity: "Invoice", entityId: r.invoiceId, patientId: r.patientId, detail: { kind: "interim-bill", copy: r.copy, reason: body.reason ?? null, lang: body.lang } }] };
    }, { txTimeoutMs: 30_000 });
  });
  app.get("/v1/ipd/bills/:id/interim-prints/:printId/pdf", async (req, reply) => {
    requireIpdBill(requireSession(req)); const { id, printId } = z.object({ id: z.string().max(64), printId: z.string().max(64) }).parse(req.params);
    const r = await query(req, async (tx, s) => { const x = await interimPdf(tx, s, id, printId); return { body: x, audit: [{ action: "view", entity: "InterimBillPrint", entityId: printId, patientId: x.patientId, detail: { copy: x.copy } }] }; });
    const fileName = `${r.number.replace(/\//g, "-")}-interim${r.copy ? `-DUPLICATE-${r.copy}` : ""}.pdf`;
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="${fileName}"`).header("cache-control", "no-store").send(Buffer.from(r.bytes));
  });
  app.get("/v1/ipd/bills/:id/preview", async (req): Promise<ClassPreviewView> => {
    requireIpdBill(requireSession(req)); const { id } = pid.parse(req.params); const { to } = z.object({ to: z.string().min(1).max(40) }).parse(req.query ?? {});
    return query(req, async (tx, s) => ({ body: await previewClass(tx, s, id, to, new Date()), audit: [] }));
  });
  app.post("/v1/ipd/bills/:id/charges", own, async (req, reply): Promise<IpdBillView> => {
    requireIpdBill(requireSession(req)); const { id } = pid.parse(req.params); const body = IpdChargeRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await postCharge(tx, s, id, body, new Date()); return { status: 201, body: r.view, audit: r.audit }; });
  });
  app.post("/v1/ipd/bills/:id/lines/:lineId/withdraw", own, async (req, reply): Promise<IpdBillView> => {
    requireIpdBill(requireSession(req)); const { id, lineId } = z.object({ id: z.string().max(64), lineId: z.string().max(64) }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(5).max(300) }).parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await withdrawCharge(tx, s, id, lineId, reason, new Date()); return { body: r.view, audit: r.audit }; });
  });
  app.post("/v1/ipd/bills/:id/package", own, async (req, reply): Promise<IpdBillView> => {
    requireIpdBill(requireSession(req)); const { id } = pid.parse(req.params); const body = IpdPackageRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await applyPackage(tx, s, id, body.packageId, new Date()); return { body: r.view, audit: r.audit }; });
  });
  app.post("/v1/ipd/bills/:id/deposits", own, async (req, reply): Promise<IpdBillView> => {
    requireIpdBill(requireSession(req)); const { id } = pid.parse(req.params); const body = DepositRequest.parse(req.body ?? {});
    let wallet: string | null = null;
    return command(req, reply, async (tx, s) => { const r = await addDeposit(tx, s, id, body, new Date()); if (r.wallet) wallet = r.paymentId; return { status: 201, body: r.view, audit: r.audit }; }, {
      // a wallet deposit: the link is made after the commit (ADR 0011), then the SMS to the guardian's (or patient's) phone
      after: async (view, s) => {
        if (!wallet) return view;
        try { await attachLink(s.tenantId, wallet, new Date(), s.userId); await sendLinkSms(s, wallet); } catch (e) { console.error(`deposit ${wallet}: link not made`, e); return view; }
        const { forTenant } = await import("@setu/db");
        return forTenant(s.tenantId, (tx) => ipdBillView(tx, s, id, new Date()), { userId: s.userId });
      },
    });
  });
  app.post("/v1/ipd/deposits/:id/receipt", own, async (req, reply): Promise<DepositReceiptView> => {
    requireIpdBill(requireSession(req)); const { id } = pid.parse(req.params);
    return command(req, reply, async (tx, s) => {
      const r = await depositReceipt(tx, s, id, new Date());
      return { status: r.created ? 201 : 200, body: r.view, audit: [{ action: r.created ? "create" : "view", entity: "Receipt", entityId: r.view.id, patientId: r.patientId, detail: { kind: "deposit", number: r.view.number, paymentId: id } }] };
    });
  });

  /* ── the discharge checklist ── */
  app.get("/v1/ipd/discharges", async (req): Promise<DischargeList> =>
    query(req, async (tx, s) => { const r = await dischargeList(tx, s, new Date()); return { body: r.list, audit: [{ action: "view", entity: "Discharge", detail: { purpose: "discharge-list", patientIds: r.patientIds } }] }; }));
  app.get("/v1/ipd/admissions/:id/discharge", async (req): Promise<DischargeView> => {
    const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => { const v = await dischargeView(tx, s, id, new Date()); return { body: v, audit: [{ action: "view", entity: "Discharge", entityId: v.discharge.id, patientId: v.patient.id, detail: { purpose: "discharge" } }] }; });
  });
  // the PIN is never stored, not even hashed into the idempotency record
  app.post("/v1/ipd/admissions/:id/discharge", own, async (req, reply): Promise<DischargeView> => {
    const { id } = pid.parse(req.params); const body = DischargeOrderRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await orderDischarge(tx, s, id, body, new Date()); return { status: 201, body: r.view, audit: r.audit }; }, { hashOmit: ["pin"] });
  });
  app.post("/v1/ipd/discharges/:id/cancel", own, async (req, reply): Promise<DischargeView> => {
    const { id } = pid.parse(req.params); const body = DischargeCancelRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await cancelDischarge(tx, s, id, body, new Date()); return { body: r.view, audit: r.audit }; }, { hashOmit: ["pin"] });
  });
  app.post("/v1/ipd/discharges/:id/steps/:key/take", own, async (req, reply): Promise<DischargeView> => {
    const { id, key } = pstep.parse(req.params);
    return command(req, reply, async (tx, s) => { const r = await takeStep(tx, s, id, key, new Date()); return { body: r.view, audit: r.audit }; });
  });
  app.post("/v1/ipd/discharges/:id/steps/:key/done", own, async (req, reply): Promise<DischargeView> => {
    const { id, key } = pstep.parse(req.params); const body = DischargeStepDoneRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await doneStep(tx, s, id, key, body, new Date()); return { body: r.view, audit: r.audit }; }, { hashOmit: ["pin"] });
  });
  app.post("/v1/ipd/discharges/:id/steps/:key/remind", own, async (req, reply): Promise<DischargeView> => {
    const { id, key } = pstep.parse(req.params);
    return command(req, reply, async (tx, s) => { const r = await remindStep(tx, s, id, key, new Date()); return { body: r.view, audit: r.audit }; });
  });
}
