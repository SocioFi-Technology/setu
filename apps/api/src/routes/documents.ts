/* Printed clinical documents (slice A12–A13, ADR 0007). A prescription (rx = a consultation note version) is printed
   from the doctor's screens (cons/signed, doc/consult); a lab report version (lr) from the lab report screen or the
   doctor's inbox. Print state and preview are reads; a print is a command (Idempotency-Key, own transaction, audited
   print / reprint) that renders and stores the PDF; the public verify pages are rate-limited, need no session and
   return only what decision D2 allows. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DocKind, DocPrintRequest, VerifyCode, type DocPrintResponse, type DocPrintView, type LrVerifyResponse, type RxVerifyResponse } from "@setu/contracts";
import { authorize } from "@setu/domain";
import { command, query } from "../command.js";
import { config } from "../config.js";
import { err, forbidden } from "../errors.js";
import { auditPublicView, lrVerify, previewPdf, printDocument, printView, rxVerify, storedPdf, type DocKind as Kind } from "../modules/documents.js";
import { requireSession } from "../plugins/session.js";
import { clientKey } from "./billing.js";

/** rx: the doctor's note screens; lr: the lab report screen or the doctor's inbox. */
const SCREENS: Record<Kind, [string, string][]> = { rx: [["cons", "signed"], ["doc", "consult"]], lr: [["lab", "report"], ["doc", "inbox"]] };
function requireKind(req: FastifyRequest, kind: Kind) {
  const s = requireSession(req);
  const d = SCREENS[kind].map(([m, x]) => authorize(s.role, s.plan, m, x));
  if (d.some((x) => x.allowed)) return s;
  throw forbidden(d.some((x) => x.reason === "role") ? "role" : (d[0]?.reason ?? "unknown"));
}
const params = z.object({ kind: DocKind, id: z.string().min(1).max(64) });
const pid = z.object({ id: z.string().min(1).max(64) });
const entity = (k: Kind) => (k === "rx" ? "Composition" : "DiagnosticReport");

export async function documentRoutes(app: FastifyInstance) {
  app.get("/v1/documents/:kind/:id/print", async (req): Promise<DocPrintView> => {
    const { kind, id } = params.parse(req.params);
    requireKind(req, kind);
    return query(req, async (tx, s) => {
      const r = await printView(tx, s, kind, id);
      return { body: r.view, audit: [{ action: "view", entity: entity(kind), entityId: id, patientId: r.patientId, detail: { purpose: "print-state" } }] };
    });
  });

  // security review S5: rendering a PDF is costly — a per-user limit on preview and print
  const perUser = { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => req.session?.userId ?? clientKey(req) } };
  app.get("/v1/documents/:kind/:id/preview", { config: perUser }, async (req, reply) => {
    const { kind, id } = params.parse(req.params);
    requireKind(req, kind);
    const q = DocPrintRequest.omit({ reason: true }).parse(req.query ?? {});
    const r = await query(req, async (tx, s) => {
      const x = await previewPdf(tx, s, kind, id, q.format, q.lang);
      return { body: x, audit: [{ action: "view", entity: entity(kind), entityId: id, patientId: x.patientId, detail: { purpose: "print-preview", format: q.format, lang: q.lang } }] };
    });
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="${kind}-preview.pdf"`).header("cache-control", "no-store").send(Buffer.from(r.bytes));
  });

  app.post("/v1/documents/:kind/:id/print", { config: { ownTx: true, ...perUser } }, async (req, reply): Promise<DocPrintResponse> => {
    const { kind, id } = params.parse(req.params);
    requireKind(req, kind);
    const body = DocPrintRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => {
      const r = await printDocument(tx, s, kind, id, body, new Date());
      const v = await printView(tx, s, kind, id);
      return { status: 201, body: { ...v.view, print: v.view.prints.find((p) => p.id === r.print.id)! }, audit: [{
        action: r.print.copy === 0 ? "print" : "reprint", entity: entity(kind), entityId: id, patientId: r.patientId,
        detail: { kind, label: r.label, copy: r.print.copy, reason: r.print.reason, format: r.print.format, lang: r.print.lang },
      }] };
    }, { txTimeoutMs: 30_000 });
  });

  app.get("/v1/documents/prints/:id/pdf", async (req, reply) => {
    const { id } = pid.parse(req.params);
    const r = await query(req, async (tx, s) => {
      const x = await storedPdf(tx, s, id);
      requireKind(req, x.kind);
      return { body: x, audit: [{ action: "view", entity: "DocumentPrint", entityId: id, patientId: x.patientId, detail: { kind: x.kind, documentId: x.documentId, copy: x.print.copy } }] };
    });
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="${r.kind}${r.print.copy ? `-DUPLICATE-${r.print.copy}` : ""}.pdf"`).header("cache-control", "no-store").send(Buffer.from(r.bytes));
  });

  /* ── public checks (the QR): no session, rate-limited, no-store ── */
  const limited = { config: { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: clientKey } } };
  app.get("/v1/verify/rx/:code", limited, async (req, reply): Promise<RxVerifyResponse> => {
    if (!config.dbEnabled) throw err(503, "db_off", "ডাটাবেস চালু নেই", "The database is not running");
    reply.header("cache-control", "no-store");
    const code = VerifyCode.safeParse((req.params as { code: string }).code.toUpperCase());
    const hit = code.success ? await rxVerify(code.data) : null;
    if (!hit) throw err(404, "not_found", "এই কোডের কোনো প্রেসক্রিপশন পাওয়া যায়নি", "No prescription found for this code");
    await auditPublicView("rx", code.data!, hit.target, req.ip);
    return hit.body;
  });
  app.get("/v1/verify/lr/:code", limited, async (req, reply): Promise<LrVerifyResponse> => {
    if (!config.dbEnabled) throw err(503, "db_off", "ডাটাবেস চালু নেই", "The database is not running");
    reply.header("cache-control", "no-store");
    const code = VerifyCode.safeParse((req.params as { code: string }).code.toUpperCase());
    const hit = code.success ? await lrVerify(code.data) : null;
    if (!hit) throw err(404, "not_found", "এই কোডের কোনো ল্যাব রিপোর্ট পাওয়া যায়নি", "No lab report found for this code");
    await auditPublicView("lr", code.data!, hit.target, req.ip);
    return hit.body;
  });
}
