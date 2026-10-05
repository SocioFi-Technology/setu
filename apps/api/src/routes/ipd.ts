/* IPD routes (ADR 0014, walkthrough B2–B3). ipd/map: wards and beds, ward actions (nurse, receptionist, admin);
   ipd/admit (receptionist, admin): admission requests, the desk's Admit (one transaction), cancel. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AdmissionCancelRequest, AdmitRequest, BedActionRequest, type AdmissionList, type AdmissionView, type BedBoard, type BedView } from "@setu/contracts";
import { authorize } from "@setu/domain";
import { command, query } from "../command.js";
import { err, forbidden } from "../errors.js";
import { admissionList, admissionView, admit, bedAction, bedBoard, cancelAdmission } from "../modules/ipd.js";
import { requireSession } from "../plugins/session.js";

function requireIpd(req: FastifyRequest, ...screens: ("admit" | "map")[]) {
  const s = requireSession(req);
  const d = screens.map((x) => authorize(s.role, s.plan, "ipd", x));
  if (d.some((x) => x.allowed)) return s;
  throw forbidden(d.some((x) => x.reason === "plan") ? "plan" : d.some((x) => x.reason === "role") ? "role" : "unknown");
}
const pid = z.object({ id: z.string().min(1).max(64) });

export async function ipdRoutes(app: FastifyInstance) {
  app.get("/v1/ipd/beds", async (req): Promise<BedBoard> => {
    requireIpd(req, "map", "admit");
    const { class: cls } = z.object({ class: z.string().max(40).optional() }).parse(req.query ?? {});
    return query(req, async (tx, s) => { const r = await bedBoard(tx, s, cls); return { body: r.board, audit: [{ action: "view", entity: "Location", detail: { purpose: "bed-board", patientIds: r.patientIds } }] }; });
  });
  app.post("/v1/ipd/beds/:id/actions", { config: { ownTx: true } }, async (req, reply): Promise<BedView> => {
    const s = requireIpd(req, "map");
    if (!["nurse", "receptionist", "admin"].includes(s.role)) throw err(403, "forbidden", "শয্যার কাজ ওয়ার্ড ইনচার্জ বা ডেস্কের", "Bed actions are the ward in-charge's or the desk's", { reason: "role", canRequest: false });
    const { id } = pid.parse(req.params); const body = BedActionRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s2) => { const r = await bedAction(tx, s2, id, body, new Date()); return { body: r.bed, audit: r.audit }; });
  });
  app.get("/v1/ipd/admissions", async (req): Promise<AdmissionList> => {
    requireIpd(req, "admit");
    return query(req, async (tx, s) => { const r = await admissionList(tx, s, new Date()); return { body: r.list, audit: [{ action: "view", entity: "Admission", detail: { purpose: "admission-desk", patientIds: r.patientIds } }] }; });
  });
  app.post("/v1/ipd/admissions", { config: { ownTx: true } }, async (req, reply): Promise<AdmissionView> => {
    requireIpd(req, "admit");
    const body = AdmitRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await admit(tx, s, body, new Date()); return { status: 201, body: r.view, audit: r.audit }; });
  });
  app.get("/v1/ipd/admissions/:id", async (req): Promise<AdmissionView> => {
    requireIpd(req, "admit", "map");
    const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => { const v = await admissionView(tx, s, id); return { body: v, audit: [{ action: "view", entity: "Admission", entityId: v.id, patientId: v.patient.id, detail: { purpose: "admission" } }] }; });
  });
  app.post("/v1/ipd/admissions/:id/cancel", { config: { ownTx: true } }, async (req, reply): Promise<AdmissionView> => {
    requireIpd(req, "admit");
    const { id } = pid.parse(req.params); const body = AdmissionCancelRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await cancelAdmission(tx, s, id, body.reason, new Date()); return { body: r.view, audit: r.audit }; });
  });
}
