/* Lab routes (slice A8–A11, ADR 0006). Each route checks the screen (access matrix: role × plan) and the service checks
   the action's role (@setu/domain LAB_ROLES); one transaction per request under RLS; every write takes an
   Idempotency-Key and answers with the visit as the lab screens show it (audited, incl. earlier results revealed for
   the delta check). SMS go out after the write commits (dispatchSms), and the answer carries their new state. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CallbackRequest, CorrectRequest, DevFailNextRequest, ReturnRequest, WithdrawRequest, LabelsRequest, LabWorklistQuery, ReleaseRequest, ResultEntryRequest, RetryRequest, RevokeRequest, SendRequest,
  SpecimenRejectRequest, SpecimenStepRequest, ValidateRequest, VerifyRequest, type LabReportView, type LabVisitView, type LabWorklist, type RevokeResponse,
} from "@setu/contracts";
import { authorize } from "@setu/domain";
import { fakeMessenger } from "../adapters/messaging/index.js";
import { command, query, type AuditEntry } from "../command.js";
import { config } from "../config.js";
import { forbidden } from "../errors.js";
import {
  collectSpecimen, correctResult, dispatchSms, enterResults, labReportView, labVisitView, labWorklist, logCallback, printLabels, receiveSpecimen, rejectSpecimen, releaseReport,
  retryMessage, returnTest, revokeOrder, sendReport, startSpecimen, validateResults, verifyResults, viewAudit, withdrawTest,
} from "../modules/lab.js";
import type { Tx } from "@setu/db";
import { requireSession, type SessionData } from "../plugins/session.js";

function requireAny(req: FastifyRequest, ...screens: [string, string][]) {
  const s = requireSession(req);
  const d = screens.map(([m, x]) => authorize(s.role, s.plan, m, x));
  if (d.some((x) => x.allowed)) return s;
  throw forbidden(d.some((x) => x.reason === "role") ? "role" : (d[0]?.reason ?? "unknown"));
}
const ANY_LAB: [string, string][] = [["lab", "collect"], ["lab", "accession"], ["lab", "result"], ["lab", "verify"], ["lab", "report"], ["lab", "delivery"]];
const STAGE_SCREEN = { collect: "collect", accession: "accession", result: "result", verify: "verify", delivery: "delivery" } as const;
const pid = z.object({ id: z.string().min(1).max(64) });
const eid = z.object({ encounterId: z.string().min(1).max(64) });

type Step = { encounterId: string; audit: AuditEntry[]; dispatch?: string[] };
/** A lab write: run `fn`, then answer with the fresh visit view (and audit what it reveals) in the same transaction;
    queued SMS are sent after the commit and their new state merged into the answer. */
async function labWrite(req: FastifyRequest, reply: Parameters<typeof command>[1], purpose: string, fn: (tx: Tx, s: SessionData, now: Date) => Promise<Step>, opts: { status?: number; hashOmit?: string[] } = {}): Promise<LabVisitView> {
  let dispatch: string[] = [];
  const out = await command(req, reply, async (tx, s) => {
    const now = new Date();
    const r = await fn(tx, s, now);
    const v = await labVisitView(tx, s, r.encounterId, now);
    return { status: opts.status ?? 200, body: { view: v.view, dispatch: r.dispatch ?? [] }, audit: [...r.audit, viewAudit(v, purpose)] };
  }, { hashOmit: opts.hashOmit });
  dispatch = out.dispatch;
  if (!dispatch.length) return out.view;
  const sent = await dispatchSms(requireSession(req), dispatch, { ip: req.ip, route: req.routeOptions.url ?? "" });
  return { ...out.view, communications: out.view.communications.map((c) => (sent.has(c.id) ? { ...c, ...sent.get(c.id)! } : c)) };
}

export async function labRoutes(app: FastifyInstance) {
  app.get("/v1/lab/worklist", async (req): Promise<LabWorklist> => {
    const { stage } = LabWorklistQuery.parse(req.query);
    requireAny(req, ["lab", STAGE_SCREEN[stage]]);
    return query(req, async (tx, s) => {
      const w = await labWorklist(tx, s, stage);
      return { body: w, audit: [{ action: "view", entity: "Encounter", detail: { purpose: `lab-worklist-${stage}`, count: w.items.length, patientIds: w.items.map((i) => i.patient.id) } }] };
    });
  });

  app.get("/v1/lab/visits/:encounterId", async (req): Promise<LabVisitView> => {
    requireAny(req, ...ANY_LAB);
    const { encounterId } = eid.parse(req.params);
    return query(req, async (tx, s) => {
      const v = await labVisitView(tx, s, encounterId);
      return { body: v.view, audit: [viewAudit(v, "lab-visit")] };
    });
  });

  app.get("/v1/lab/reports/:id", async (req): Promise<LabReportView> => {
    requireAny(req, ["lab", "report"], ["lab", "verify"], ["lab", "delivery"]);
    const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => {
      const r = await labReportView(tx, s, id);
      return { body: r, audit: [{ action: "view", entity: "DiagnosticReport", entityId: id, patientId: r.patient.id, basis: "lab", detail: { purpose: "lab-report", number: r.report.number, version: r.report.version } }] };
    });
  });

  /* ── A8: labels, collection, accession, rejection ── */
  app.post("/v1/lab/visits/:encounterId/labels", { config: { ownTx: true } }, async (req, reply) => {
    requireAny(req, ["lab", "collect"]);
    const { encounterId } = eid.parse(req.params);
    const body = LabelsRequest.parse(req.body ?? {});
    return labWrite(req, reply, "lab-labels", (tx, s, now) => printLabels(tx, s, encounterId, body.tubes, now));
  });
  app.post("/v1/lab/specimens/:id/collect", { config: { ownTx: true } }, async (req, reply) => {
    requireAny(req, ["lab", "collect"]);
    const { id } = pid.parse(req.params);
    const body = SpecimenStepRequest.parse(req.body);
    return labWrite(req, reply, "lab-collect", (tx, s, now) => collectSpecimen(tx, s, id, body.at, now));
  });
  app.post("/v1/lab/specimens/:id/receive", { config: { ownTx: true } }, async (req, reply) => {
    requireAny(req, ["lab", "accession"]);
    const { id } = pid.parse(req.params);
    const body = SpecimenStepRequest.parse(req.body);
    return labWrite(req, reply, "lab-receive", (tx, s, now) => receiveSpecimen(tx, s, id, body.at, now));
  });
  app.post("/v1/lab/specimens/:id/start", { config: { ownTx: true } }, async (req, reply) => {
    requireAny(req, ["lab", "accession"]);
    const { id } = pid.parse(req.params);
    const body = SpecimenStepRequest.parse(req.body);
    return labWrite(req, reply, "lab-start", (tx, s, now) => startSpecimen(tx, s, id, body.at, now));
  });
  app.post("/v1/lab/specimens/:id/reject", { config: { ownTx: true } }, async (req, reply) => {
    requireAny(req, ["lab", "collect"], ["lab", "accession"]);
    const { id } = pid.parse(req.params);
    const body = SpecimenRejectRequest.parse(req.body);
    return labWrite(req, reply, "lab-reject", (tx, s, now) => rejectSpecimen(tx, s, id, body, now));
  });

  /* ── A9: results and corrections ── */
  app.post("/v1/lab/orders/:id/results", { config: { ownTx: true } }, async (req, reply) => {
    requireAny(req, ["lab", "result"]);
    const { id } = pid.parse(req.params);
    const body = ResultEntryRequest.parse(req.body);
    return labWrite(req, reply, "lab-results", (tx, s, now) => enterResults(tx, s, id, body, now), { status: 201 });
  });
  app.post("/v1/lab/observations/:id/correct", { config: { ownTx: true } }, async (req, reply) => {
    requireAny(req, ["lab", "result"]);
    const { id } = pid.parse(req.params);
    const body = CorrectRequest.parse(req.body);
    return labWrite(req, reply, "lab-correct", (tx, s, now) => correctResult(tx, s, id, body, now), { status: 201 });
  });

  /* ── send-back (decision 119) and withdraw results (decision 133) ── */
  app.post("/v1/lab/orders/:id/return", { config: { ownTx: true } }, async (req, reply) => {
    requireAny(req, ["lab", "verify"]);
    const { id } = pid.parse(req.params);
    const body = ReturnRequest.parse(req.body);
    return labWrite(req, reply, "lab-return", (tx, s, now) => returnTest(tx, s, id, body.reason, now));
  });
  app.post("/v1/lab/orders/:id/withdraw", { config: { ownTx: true } }, async (req, reply) => {
    requireAny(req, ["lab", "result"], ["lab", "verify"]);
    const { id } = pid.parse(req.params);
    const body = WithdrawRequest.parse(req.body);
    return labWrite(req, reply, "lab-withdraw", (tx, s, now) => withdrawTest(tx, s, id, body.reason, now));
  });

  /* ── A10: verify, call-back, validate, release ── */
  app.post("/v1/lab/visits/:encounterId/verify", { config: { ownTx: true } }, async (req, reply) => {
    requireAny(req, ["lab", "verify"]);
    const { encounterId } = eid.parse(req.params);
    const body = VerifyRequest.parse(req.body);
    return labWrite(req, reply, "lab-verify", (tx, s, now) => verifyResults(tx, s, encounterId, body, now), { hashOmit: ["pin"] });
  });
  app.post("/v1/lab/observations/:id/callbacks", { config: { ownTx: true } }, async (req, reply) => {
    requireAny(req, ["lab", "verify"]);
    const { id } = pid.parse(req.params);
    const body = CallbackRequest.parse(req.body);
    return labWrite(req, reply, "lab-callback", (tx, s, now) => logCallback(tx, s, id, body, now), { status: 201 });
  });
  app.post("/v1/lab/visits/:encounterId/validate", { config: { ownTx: true } }, async (req, reply) => {
    requireAny(req, ["lab", "verify"]);
    const { encounterId } = eid.parse(req.params);
    const body = ValidateRequest.parse(req.body);
    return labWrite(req, reply, "lab-validate", (tx, s, now) => validateResults(tx, s, encounterId, body, now), { hashOmit: ["pin"] });
  });
  app.post("/v1/lab/visits/:encounterId/release", { config: { ownTx: true } }, async (req, reply) => {
    requireAny(req, ["lab", "verify"], ["lab", "report"]);
    const { encounterId } = eid.parse(req.params);
    const body = ReleaseRequest.parse(req.body);
    return labWrite(req, reply, "lab-release", (tx, s, now) => releaseReport(tx, s, encounterId, body, now), { status: 201 });
  });

  /* ── A11: delivery ── */
  app.post("/v1/lab/reports/:id/send", { config: { ownTx: true } }, async (req, reply) => {
    requireAny(req, ["lab", "delivery"]);
    const { id } = pid.parse(req.params);
    const body = SendRequest.parse(req.body);
    return labWrite(req, reply, "lab-send", (tx, s, now) => sendReport(tx, s, id, body.channel, now));
  });
  app.post("/v1/lab/communications/:id/retry", { config: { ownTx: true } }, async (req, reply) => {
    requireAny(req, ["lab", "delivery"]);
    const { id } = pid.parse(req.params);
    RetryRequest.parse(req.body ?? {});
    return labWrite(req, reply, "lab-retry", (tx, s, now) => retryMessage(tx, s, id, now));
  });

  /* ── ORDER revoke (D5): the ordering doctor, the lab technologist or the pathologist ── */
  app.post("/v1/orders/:id/revoke", { config: { ownTx: true } }, async (req, reply): Promise<RevokeResponse> => {
    requireAny(req, ["cons", "draft"], ["lab", "collect"], ["lab", "verify"]);
    const { id } = pid.parse(req.params);
    const body = RevokeRequest.parse(req.body);
    return command(req, reply, async (tx, s) => {
      const r = await revokeOrder(tx, s, id, body.reason, new Date());
      return { body: r.body, audit: r.audit };
    });
  });

  /* ── dev and tests only: the fake SMS gateway (never with a real gateway or in production) ── */
  if (fakeMessenger() && config.fakeMessagingDevRoute) {
    app.post("/v1/dev/fake-messenger/fail-next", async (req) => {
      requireAny(req, ...ANY_LAB);
      const { n } = DevFailNextRequest.parse(req.body ?? {});
      fakeMessenger()!.failNext(n ?? 1);
      return { failing: n ?? 1 };
    });
    app.get("/v1/dev/fake-messenger/messages", async (req) => {
      requireAny(req, ...ANY_LAB);
      return { messages: fakeMessenger()!.log().map((m) => ({ messageId: m.messageId, to: m.to, text: m.text, outcome: m.outcome, at: m.at.toISOString() })) };
    });
  }
}
