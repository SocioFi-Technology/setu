/* ADR 0020 — the patient app's routes (/v1/patient/*): the patient session only, never a staff one. */
import type { FastifyInstance } from "fastify";
import { ClaimProofRequest, OtpRequest, PatientSignInRequest, TimelineFilter, type ClaimItem, type ClaimList, type ClaimProofResponse, type OtpResponse, type PatientMe, type Timeline } from "@setu/contracts";
import { config } from "../config.js";
import { fakeMessenger } from "../adapters/messaging/index.js";
import { err } from "../errors.js";
import { listClaims, notMine, patientMe, proveClaim, sendOtp, timeline, verifyOtp } from "../modules/patient.js";
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

  /* dev and tests only: the last sign-in code the fake SMS gateway "sent" to a number (never with a real gateway or in
     production — the same guard as the other fake-messenger routes) */
  if (fakeMessenger() && config.fakeMessagingDevRoute) {
    app.get("/v1/dev/patient-otp", async (req) => {
      const phone = String((req.query as { phone?: string }).phone ?? "");
      const m = fakeMessenger()!.log("network").filter((x) => x.to === phone && x.messageId.startsWith("potp_")).at(-1);
      const code = m?.text.match(/\d{6}/)?.[0] ?? null;
      if (!code) throw err(404, "not_found", "কোড নেই", "No code sent");
      return { code };
    });
  }
}
