/* ADR 0020 — the patient app's routes (/v1/patient/*): the patient session only, never a staff one. */
import type { FastifyInstance } from "fastify";
import { ClaimProofRequest, OtpRequest, PatientSignInRequest, ShareCreate, TimelineFilter, type AccessLog, type ClaimItem, type ClaimList, type ClaimProofResponse, type DirectoryView, type OtpResponse, type PatientMe, type PatientReportView, type ShareList, type ShareView, type Timeline } from "@setu/contracts";
import { z } from "zod";
import { config } from "../config.js";
import { fakeMessenger } from "../adapters/messaging/index.js";
import { counters } from "../adapters/counters.js";
import { err } from "../errors.js";
import { accessLog, listClaims, notMine, patientMe, patientPdf, patientReport, proveClaim, sendOtp, timeline, verifyOtp } from "../modules/patient.js";
import { createShare, directory, listShares, revokeShare } from "../modules/share.js";
import { PATIENT_COOKIE, PATIENT_COOKIE_OPTIONS, clearPerson, encodePerson } from "../plugins/patientSession.js";

const dbOn = () => { if (!config.dbEnabled) throw err(503, "db_off", "ডাটাবেস চালু নেই", "The database is not running"); };

export async function patientRoutes(app: FastifyInstance) {
  app.post("/v1/patient/otp", async (req): Promise<OtpResponse> => {
    dbOn();
    const b = OtpRequest.parse(req.body);
    return { sent: true, expiresInSeconds: await sendOtp(b.phone, b.lang, req.ip) };
  });
  app.post("/v1/patient/sign-in", async (req, reply): Promise<PatientMe> => {
    dbOn();
    const b = PatientSignInRequest.parse(req.body);
    const p = await verifyOtp(b.phone, b.code);
    const session = { personId: p.id, phone: b.phone.slice(1), lang: p.lang === "en" ? "en" as const : "bn" as const, generation: p.generation };
    reply.setCookie(PATIENT_COOKIE, encodePerson(session), PATIENT_COOKIE_OPTIONS);
    req.person = session;
    return patientMe(req);
  });
  app.post("/v1/patient/sign-out", async (_req, reply) => { clearPerson(reply); return { ok: true }; });
  app.get("/v1/patient/me", async (req): Promise<PatientMe> => { dbOn(); return patientMe(req); });
  app.get("/v1/patient/claims", async (req): Promise<ClaimList> => { dbOn(); return listClaims(req); });
  app.post("/v1/patient/claims/:id/proof", async (req, reply): Promise<ClaimProofResponse> => {
    dbOn();
    const { id } = req.params as { id: string };
    return proveClaim(req, reply, id, ClaimProofRequest.parse(req.body));
  });
  app.post("/v1/patient/claims/:id/not-mine", async (req, reply): Promise<ClaimItem> => {
    dbOn();
    const { id } = req.params as { id: string };
    return notMine(req, reply, id);
  });
  app.get("/v1/patient/timeline", async (req): Promise<Timeline> => {
    dbOn();
    const f = TimelineFilter.safeParse((req.query as { filter?: string }).filter ?? "all");
    if (!f.success) throw err(400, "validation", "ফিল্টার ঠিক নয়", "Unknown filter", { field: "filter" });
    return timeline(req, f.data);
  });

  /* ── D4 (ADR 0021): a report in plain language; the original document as the patient's copy ── */
  const id = z.string().min(1).max(64);
  app.get("/v1/patient/reports/:claimId/:reportId", async (req): Promise<PatientReportView> => {
    dbOn();
    const p = z.object({ claimId: id, reportId: id }).parse(req.params);
    return patientReport(req, p.claimId, p.reportId);
  });
  app.get("/v1/patient/documents/:claimId/:kind/:docId/pdf", async (req, reply) => {
    dbOn();
    const p = z.object({ claimId: id, kind: z.enum(["lr", "rx", "ds"]), docId: id }).parse(req.params);
    const lang = (req.query as { lang?: string }).lang === "en" ? "en" : "bn";
    const bytes = await patientPdf(req, p.claimId, p.kind, p.docId, lang);
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="setu-${p.kind}.pdf"`).header("cache-control", "no-store").send(Buffer.from(bytes));
  });
  /* ── D5–D6: the directory, shares, who viewed ── */
  app.get("/v1/patient/directory", async (req): Promise<DirectoryView> => { dbOn(); return directory(req); });
  app.get("/v1/patient/shares", async (req): Promise<ShareList> => { dbOn(); return listShares(req); });
  app.post("/v1/patient/shares", async (req, reply): Promise<ShareView> => { dbOn(); return createShare(req, reply, ShareCreate.parse(req.body)); });
  app.post("/v1/patient/shares/:id/revoke", async (req, reply): Promise<ShareView> => {
    dbOn();
    return revokeShare(req, reply, z.object({ id }).parse(req.params).id);
  });
  app.get("/v1/patient/access-log", async (req): Promise<AccessLog> => {
    dbOn();
    const before = (req.query as { before?: string }).before;
    return accessLog(req, typeof before === "string" && before ? before : null);
  });

  /* the last sign-in code the fake SMS gateway "sent" to a number: dev / tests, and staging with the fake SMS
     (config.patientOtpDevRoute — never with a real gateway, never in production) */
  if (fakeMessenger() && config.patientOtpDevRoute) {
    app.get("/v1/dev/patient-otp", async (req) => {
      const phone = String((req.query as { phone?: string }).phone ?? "");
      if (!/^01[3-9]\d{8}$/.test(phone)) throw err(400, "validation", "ফোন নম্বর ঠিক নয়", "Not a phone number", { field: "phone" });
      // the code as stored for sign-in (Redis, shared by the API replicas — the fake gateway's log is per replica, so
      // staging's two replicas found it only half the time)
      const code = await counters().get(`potp:code:${phone.slice(1)}`);
      if (!code) throw err(404, "not_found", "কোড নেই", "No code sent");
      return { code: String(code) };
    });
  }
}
