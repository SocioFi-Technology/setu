/* ADR 0022 — the portable lab order's routes. Staff: the ordering facility (its orders, the centres, the desk's choice
   for the patient, the doctor's re-order) and the chosen centre (its queue, its decision; screen net/lab). Patient: the
   person's orders, the centres, the choice — written in the ordering facility's tenant after the person is checked. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CentreDecisionRequest, ChooseCentreRequest, type CentreOffers, type PortableList, type PortableOrderView } from "@setu/contracts";
import { authorize } from "@setu/domain";
import { command, query } from "../command.js";
import { config } from "../config.js";
import { err, forbidden } from "../errors.js";
import { requireSession } from "../plugins/session.js";
import { requirePerson } from "../plugins/patientSession.js";
import { audit, personCommand } from "../modules/patient.js";
import { billFor, centreOrder, centreQueue, choose, decide, loadPortable, offersFor, orderReport, originOrder, originOrdersOf, portableView, reorder, tellOriginIn } from "../modules/portable.js";

const id = z.string().min(1).max(64);
const sortQ = (q: unknown) => ({ sort: (q as { sort?: string }).sort === "turnaround" ? "turnaround" as const : "price" as const, collection: (q as { collection?: string }).collection === "home" ? "home" as const : "centre" as const });
function requireNet(req: FastifyRequest) {
  const s = requireSession(req);
  const d = authorize(s.role, s.plan, "net", "lab");
  if (!d.allowed) throw forbidden(d.reason ?? "role");
  return s;
}
const dbOn = () => { if (!config.dbEnabled) throw err(503, "db_off", "ডাটাবেস চালু নেই", "The database is not running"); };

export async function portableRoutes(app: FastifyInstance) {
  /* ── the ordering facility ── */
  app.get("/v1/portable-orders", async (req): Promise<PortableList> => {
    requireNet(req);
    // one patient's orders, or this facility's 50 most recent (the network screen)
    const raw = (req.query as { patientId?: string }).patientId;
    const patientId = raw ? id.parse(raw) : null;
    return query(req, async (tx, s) => ({ body: { items: (await originOrdersOf(tx, s, patientId)).map((o) => portableView(o, "origin")) }, audit: [{ action: "view", entity: "PortableOrder", patientId, detail: { purpose: "portable-list" } }] }));
  });
  /* one order: the ordering facility or the chosen centre (row-level security shows nothing else) */
  app.get("/v1/portable-orders/:id", async (req): Promise<PortableOrderView> => {
    requireNet(req);
    const p = z.object({ id }).parse(req.params);
    return query(req, async (tx, s) => {
      const o = await loadPortable(tx, p.id);
      if (!o) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
      const viewer = o.originTenantId === s.tenantId ? "origin" as const : "centre" as const;
      if (viewer === "centre" && o.centreOrganizationId !== s.organizationId) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
      return { body: portableView(o, viewer, viewer === "centre"), audit: [{ action: "view", entity: "PortableOrder", entityId: o.id, patientId: viewer === "origin" ? o.originPatientId : o.centrePatientId, detail: { number: o.number, as: viewer } }] };
    });
  });
  app.get("/v1/portable-orders/:id/centres", async (req): Promise<CentreOffers> => {
    requireNet(req);
    const p = z.object({ id }).parse(req.params); const q = sortQ(req.query);
    return query(req, async (tx, s) => ({ body: await offersFor(await originOrder(tx, s, p.id), q.sort, q.collection), audit: [] }));
  });
  /* the desk chooses for the patient (recorded as such) */
  app.post("/v1/portable-orders/:id/choose", { config: { ownTx: true } }, async (req, reply): Promise<PortableOrderView> => {
    requireNet(req);
    const p = z.object({ id }).parse(req.params); const b = ChooseCentreRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      await originOrder(tx, s, p.id);
      const r = await choose(tx, p.id, { kind: "desk", userId: s.userId }, b, new Date());
      return { body: portableView(r.order, "origin"), audit: r.audit };
    });
  });
  /* E3 (ADR 0023): the centre's report for the order — read through the order, audited at both facilities */
  app.get("/v1/portable-orders/:id/report", async (req) => {
    requireNet(req);
    const p = z.object({ id }).parse(req.params);
    return query(req, async (tx, s) => {
      const r = await orderReport(tx, s, p.id);
      return { body: { orderId: r.order.id, number: r.order.number, centreEn: r.order.centreFacilityEn, centreBn: r.order.centreFacilityBn, ...r.report }, audit: [{ action: "view", entity: "PortableOrder", entityId: r.order.id, patientId: r.order.originPatientId, detail: { purpose: "portable-result", number: r.order.number, report: r.order.resultReportId } }] };
    });
  });
  app.post("/v1/portable-orders/:id/reorder", { config: { ownTx: true } }, async (req, reply): Promise<PortableOrderView> => {
    requireNet(req);
    const p = z.object({ id }).parse(req.params);
    return command(req, reply, async (tx, s) => { const r = await reorder(tx, s, p.id, new Date()); return { status: 201, body: portableView(r.order, "origin"), audit: r.audit }; });
  });

  /* ── the chosen centre ── */
  app.get("/v1/network-orders", async (req): Promise<PortableList> => {
    requireNet(req);
    return query(req, async (tx, s) => ({ body: { items: (await centreQueue(tx, s)).map((o) => portableView(o, "centre", true)) }, audit: [{ action: "view", entity: "PortableOrder", detail: { purpose: "network-orders" } }] }));
  });
  app.post("/v1/network-orders/:id/decide", { config: { ownTx: true } }, async (req, reply): Promise<PortableOrderView> => {
    requireNet(req);
    const p = z.object({ id }).parse(req.params); const b = CentreDecisionRequest.parse(req.body);
    let tell: { origin: string; declined: string[] } | null = null;
    return command(req, reply, async (tx, s) => {
      const r = await decide(tx, s, p.id, b, new Date());
      tell = { origin: r.order.originTenantId, declined: r.declined };
      return { body: portableView(r.order, "centre", true), audit: r.audit };
    }, {
      // the ordering doctor (declined tests) and the patient are told in the ordering facility, after this commits
      after: async (body) => { if (tell) await tellOriginIn(tell.origin, body.id, tell.declined, new Date()).catch((e) => req.log.error({ err: e }, "portable: telling the ordering facility failed")); return body; },
    });
  });
  app.get("/v1/network-orders/:id", async (req): Promise<PortableOrderView> => {
    requireNet(req);
    const p = z.object({ id }).parse(req.params);
    return query(req, async (tx, s) => { const o = await centreOrder(tx, s, p.id); return { body: portableView(o, "centre", true), audit: [{ action: "view", entity: "PortableOrder", entityId: o.id, patientId: o.centrePatientId, detail: { number: o.number, as: "centre" } }] }; });
  });

  /* ── the patient ── */
  const personOrder = async (req: FastifyRequest, orderId: string) => {
    const pr = requirePerson(req);
    const { forPerson } = await import("@setu/db");
    const o = await forPerson(pr.personId, (tx) => loadPortable(tx, orderId));
    if (!o) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
    return o;
  };
  app.get("/v1/patient/portable-orders", async (req): Promise<PortableList> => {
    dbOn();
    const pr = requirePerson(req);
    const { forPerson } = await import("@setu/db");
    const rows = await forPerson(pr.personId, (tx) => tx.portableOrder.findMany({ include: { items: { orderBy: { id: "asc" } } }, orderBy: { createdAt: "desc" }, take: 50 }));
    // E3: each order's bill at the centre (the patient's own record there)
    return { items: await Promise.all(rows.map(async (o) => portableView(o as never, "patient", false, await billFor(o as never, pr.personId)))) };
  });
  app.get("/v1/patient/portable-orders/:id/centres", async (req): Promise<CentreOffers> => {
    dbOn();
    const p = z.object({ id }).parse(req.params); const q = sortQ(req.query);
    return offersFor(await personOrder(req, p.id), q.sort, q.collection);
  });
  app.post("/v1/patient/portable-orders/:id/choose", async (req, reply): Promise<PortableOrderView> => {
    dbOn();
    const p = z.object({ id }).parse(req.params); const b = ChooseCentreRequest.parse(req.body);
    const o0 = await personOrder(req, p.id);
    return personCommand(req, reply, o0.originTenantId, async (tx, person) => {
      const r = await choose(tx, p.id, { kind: "patient", personId: person.personId }, b, new Date());
      for (const a of r.audit) await audit(tx, req, o0.originTenantId, person, { action: a.action, entity: a.entity, entityId: a.entityId ?? null, patientId: a.patientId ?? null, detail: a.detail });
      return { body: portableView(r.order, "patient") };
    });
  });
}
