/* Shift close and owner dashboard routes (slice C1–C4, ADR 0008). Screens: bill/shift (cashier, owner, admin) and
   own/dash (owner, admin) from the access matrix; the services check whose shift it is and who may review it. One
   transaction per request under RLS; writes take an Idempotency-Key and replay inside their own transaction. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CountShiftRequest, DashboardQuery, DrillQuery, OpenShiftRequest, ReviewShiftRequest, ShiftListQuery, type DashboardView, type DrillView, type MyShiftResponse, type ShiftList, type ShiftView } from "@setu/contracts";
import { authorize } from "@setu/domain";
import { command, query } from "../command.js";
import { config } from "../config.js";
import { err, forbidden } from "../errors.js";
import { dashboard, drill, runNightlyRollup } from "../modules/owner.js";
import { countShift, myShift, openShift, reviewShift, shiftList, shiftView } from "../modules/shift.js";
import { requireSession } from "../plugins/session.js";

function requireScreen(req: FastifyRequest, mod: string, screen: string) {
  const s = requireSession(req);
  const d = authorize(s.role, s.plan, mod, screen);
  if (!d.allowed) throw forbidden(d.reason === "plan" ? "plan" : d.reason === "role" ? "role" : "unknown");
  return s;
}
const pid = z.object({ id: z.string().min(1).max(64) });

export async function ownerRoutes(app: FastifyInstance) {
  /* ── shift close (bill/shift) ── */
  app.get("/v1/shifts/mine", async (req): Promise<MyShiftResponse> => {
    requireScreen(req, "bill", "shift");
    return query(req, async (tx, s) => {
      const r = await myShift(tx, s, new Date());
      return { body: r, audit: [{ action: "view", entity: "Shift", entityId: r.shift?.id, detail: { purpose: "my-shift" } }] };
    });
  });
  app.post("/v1/shifts", { config: { ownTx: true } }, async (req, reply): Promise<ShiftView> => {
    requireScreen(req, "bill", "shift");
    const body = OpenShiftRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await openShift(tx, s, body.openingFloatPaisa, new Date()); return { status: 201, body: r.view, audit: r.audit }; });
  });
  app.post("/v1/shifts/:id/count", { config: { ownTx: true } }, async (req, reply): Promise<ShiftView> => {
    requireScreen(req, "bill", "shift");
    const { id } = pid.parse(req.params);
    const body = CountShiftRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await countShift(tx, s, id, body, new Date()); return { status: 200, body: r.view, audit: r.audit }; });
  });
  app.get("/v1/shifts", async (req): Promise<ShiftList> => {
    const s0 = requireScreen(req, "bill", "shift");
    if (s0.role !== "owner" && s0.role !== "admin") throw forbidden("role");
    const q = ShiftListQuery.parse(req.query);
    return query(req, async (tx, s) => {
      const items = await shiftList(tx, s, q.status, q.days, new Date());
      return { body: { items }, audit: [{ action: "view", entity: "Shift", detail: { purpose: "shift-list", status: q.status, count: items.length } }] };
    });
  });
  app.get("/v1/shifts/:id", async (req): Promise<ShiftView> => {
    requireScreen(req, "bill", "shift");
    const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => ({ body: await shiftView(tx, s, id, new Date()), audit: [{ action: "view", entity: "Shift", entityId: id }] }));
  });
  app.post("/v1/shifts/:id/review", { config: { ownTx: true } }, async (req, reply): Promise<ShiftView> => {
    requireScreen(req, "bill", "shift");
    const { id } = pid.parse(req.params);
    const body = ReviewShiftRequest.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await reviewShift(tx, s, id, body, new Date()); return { status: 200, body: r.view, audit: r.audit }; });
  });

  /* ── owner dashboard (own/dash) ── */
  app.get("/v1/owner/dashboard", async (req): Promise<DashboardView> => {
    requireScreen(req, "own", "dash");
    const q = DashboardQuery.parse(req.query);
    return query(req, async (tx, s) => ({ body: await dashboard(tx, s, q.period, new Date()), audit: [{ action: "view", entity: "OwnerDashboard", detail: { period: q.period } }] }));
  });
  app.get("/v1/owner/drill", async (req): Promise<DrillView> => {
    requireScreen(req, "own", "dash");
    const q = DrillQuery.parse(req.query);
    return query(req, async (tx, s) => { const r = await drill(tx, s, q.period, q.what, new Date()); return { body: r.view, audit: r.audit }; });
  });

  /* ── dev and tests only: run the nightly rollup now ── */
  app.post("/v1/dev/rollup/run", async (req) => {
    const s = requireSession(req);
    if (process.env.NODE_ENV === "production" || !config.dbEnabled || (s.role !== "owner" && s.role !== "admin")) throw err(404, "not_found", "পাওয়া যায়নি", "Not found");
    return runNightlyRollup(new Date());
  });
}

/** The nightly job (ADR 0008): at 00:30 Dhaka, then every 24 h. One timer per API process; the rows are upserts. */
export function scheduleNightlyRollup(log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void }) {
  const next = () => {
    const now = Date.now();
    const dhaka = new Date(now + 6 * 3600_000);
    let at = Date.UTC(dhaka.getUTCFullYear(), dhaka.getUTCMonth(), dhaka.getUTCDate(), 0, 30) - 6 * 3600_000;
    if (at <= now) at += 864e5;
    return at - now;
  };
  const run = () => {
    runNightlyRollup().then((r) => log.info(r, "nightly rollup done")).catch((e) => log.error({ err: e }, "nightly rollup failed"))
      .finally(() => { timer = setTimeout(run, next()); timer.unref?.(); });
  };
  let timer = setTimeout(run, next());
  timer.unref?.();
  return () => clearTimeout(timer);
}
