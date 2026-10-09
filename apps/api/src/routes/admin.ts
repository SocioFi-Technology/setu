/* Admin routes (phase 2 slice 3, ADR 0010). Screens adm/wizard (facility, go-live), adm/users, adm/masters (price list,
   settings) and adm/audit — owner and admin (access matrix). Writes take an Idempotency-Key; a one-time password is in
   the answer only, never in the stored replay. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AuditQuery, BranchCreate, DeactivateRequest, FacilityUpdate, PriceActive, PriceChange, PriceNetwork, PriceCreate, RoleChange, SettingsUpdate, SmsTestRequest, UserCreate, WardCreate,
  type AuditPage, type FacilityView, type PriceHistory, type PriceList, type UserCredentialResponse, type UserList, type UserView,
} from "@setu/contracts";
import { authorize } from "@setu/domain";
import { command, query } from "../command.js";
import { forbidden } from "../errors.js";
import {
  addBranch, addWard, auditCsv, auditPage, changePrice, changeRole, createPrice, createUser, facilityView, goLive, priceHistory, priceList, resetPassword, setActive,
  setPriceActive, setPriceNetwork, smsTest, smsTestConfirm, updateFacility, updateSettings, userList, verifyRegistration,
} from "../modules/admin.js";
import { requireSession } from "../plugins/session.js";

function requireAdm(req: FastifyRequest, screen: "wizard" | "users" | "masters" | "audit") {
  const s = requireSession(req);
  const d = authorize(s.role, s.plan, "adm", screen);
  if (!d.allowed) throw forbidden(d.reason === "plan" ? "plan" : d.reason === "role" ? "role" : "unknown");
  return s;
}
const pid = z.object({ id: z.string().min(1).max(64) });
const noOtp = (r: UserCredentialResponse): UserCredentialResponse => ({ ...r, oneTimePassword: null });

export async function adminRoutes(app: FastifyInstance) {
  /* ── facility and go-live (adm/wizard) ── */
  app.get("/v1/admin/facility", async (req): Promise<FacilityView> => {
    requireAdm(req, "wizard");
    return query(req, async (tx, s) => ({ body: await facilityView(tx, s), audit: [{ action: "view", entity: "Organization", entityId: s.organizationId }] }));
  });
  const facilityWrite = (path: string, screen: "wizard" | "masters", run: (tx: Parameters<Parameters<typeof command>[2]>[0], s: Parameters<Parameters<typeof command>[2]>[1], body: unknown) => Promise<import("../command.js").AuditEntry[]>, status = 200, txTimeoutMs?: number, limit?: { max: number; timeWindow: string }) =>
    // limit: per facility (security review: a test SMS costs money and goes to any number)
    app.post(path, { config: { ownTx: true, ...(limit ? { rateLimit: { ...limit, keyGenerator: (r: import("fastify").FastifyRequest) => `fac:${requireSession(r).organizationId}` } } : {}) } }, async (req, reply): Promise<FacilityView> => {
      requireAdm(req, screen);
      return command(req, reply, async (tx, s) => { const audit = await run(tx, s, req.body ?? {}); return { status, body: await facilityView(tx, s), audit }; }, { txTimeoutMs });
    });
  facilityWrite("/v1/admin/facility", "wizard", (tx, s, b) => updateFacility(tx, s, FacilityUpdate.parse(b)));
  facilityWrite("/v1/admin/branches", "wizard", async (tx, s, b) => { const x = BranchCreate.parse(b); const l = await addBranch(tx, s, x.name, x.nameBn); return [{ action: "create", entity: "Location", entityId: l.id, detail: { kind: "branch", name: x.name } }]; }, 201);
  facilityWrite("/v1/admin/wards", "wizard", async (tx, s, b) => { const x = WardCreate.parse(b); const w = await addWard(tx, s, x); return [{ action: "create", entity: "Location", entityId: w.id, detail: { kind: "ward", name: x.name, beds: x.beds } }]; }, 201);
  facilityWrite("/v1/admin/settings", "masters", (tx, s, b) => updateSettings(tx, s, SettingsUpdate.parse(b)));
  // the gateway answers within its 20 s timeout; the transaction outlasts it
  facilityWrite("/v1/admin/sms-test", "wizard", (tx, s, b) => smsTest(tx, s, SmsTestRequest.parse(b).phone, new Date()), 200, 30_000, { max: 3, timeWindow: "1 hour" }); // external review C: 3 an hour per facility
  facilityWrite("/v1/admin/sms-test/confirm", "wizard", (tx, s) => smsTestConfirm(tx, s, new Date()));
  facilityWrite("/v1/admin/go-live", "wizard", (tx, s) => goLive(tx, s, new Date()));

  /* ── users and roles (adm/users) ── */
  app.get("/v1/admin/users", async (req): Promise<UserList> => {
    requireAdm(req, "users");
    return query(req, async (tx, s) => { const l = await userList(tx, s); return { body: l, audit: [{ action: "view", entity: "User", detail: { purpose: "user-list", count: l.items.length } }] }; });
  });
  app.post("/v1/admin/users", { config: { ownTx: true } }, async (req, reply): Promise<UserCredentialResponse> => {
    requireAdm(req, "users");
    const body = UserCreate.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await createUser(tx, s, body, new Date()); return { status: 201, body: r.res, audit: r.audit }; }, { redact: noOtp });
  });
  app.post("/v1/admin/users/:id/role", { config: { ownTx: true } }, async (req, reply): Promise<UserView> => {
    requireAdm(req, "users");
    const { id } = pid.parse(req.params); const body = RoleChange.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await changeRole(tx, s, id, body.role, body.reason); return { status: 200, body: r.user, audit: r.audit }; });
  });
  for (const [path, active] of [["deactivate", false], ["reactivate", true]] as const) {
    app.post(`/v1/admin/users/:id/${path}`, { config: { ownTx: true } }, async (req, reply): Promise<UserView> => {
      requireAdm(req, "users");
      const { id } = pid.parse(req.params); const reason = active ? (z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {}).reason ?? "") : DeactivateRequest.parse(req.body ?? {}).reason;
      return command(req, reply, async (tx, s) => { const r = await setActive(tx, s, id, active, reason, new Date()); return { status: 200, body: r.user, audit: r.audit }; });
    });
  }
  app.post("/v1/admin/users/:id/reset-password", { config: { ownTx: true } }, async (req, reply): Promise<UserCredentialResponse> => {
    requireAdm(req, "users");
    const { id } = pid.parse(req.params);
    return command(req, reply, async (tx, s) => { const r = await resetPassword(tx, s, id, new Date()); return { status: 200, body: r.res, audit: r.audit }; }, { redact: noOtp });
  });
  app.post("/v1/admin/users/:id/verify-registration", { config: { ownTx: true } }, async (req, reply): Promise<UserView> => {
    requireAdm(req, "users");
    const { id } = pid.parse(req.params); const body = z.object({ regNo: z.string().trim().max(30).optional() }).parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const r = await verifyRegistration(tx, s, id, body.regNo); return { status: 200, body: r.user, audit: r.audit }; });
  });

  /* ── the price list (adm/masters) ── */
  app.get("/v1/admin/prices", async (req): Promise<PriceList> => {
    requireAdm(req, "masters");
    return query(req, async (tx, s) => ({ body: await priceList(tx, s), audit: [{ action: "view", entity: "ChargeItemDefinition", detail: { purpose: "price-list" } }] }));
  });
  app.post("/v1/admin/prices", { config: { ownTx: true } }, async (req, reply): Promise<PriceList> => {
    requireAdm(req, "masters");
    const body = PriceCreate.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const audit = await createPrice(tx, s, body, new Date()); return { status: 201, body: await priceList(tx, s), audit }; });
  });
  app.post("/v1/admin/prices/:id", { config: { ownTx: true } }, async (req, reply): Promise<PriceList> => {
    requireAdm(req, "masters");
    const { id } = pid.parse(req.params); const body = PriceChange.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const audit = await changePrice(tx, s, id, body, new Date()); return { status: 200, body: await priceList(tx, s), audit }; });
  });
  app.post("/v1/admin/prices/:id/active", { config: { ownTx: true } }, async (req, reply): Promise<PriceList> => {
    requireAdm(req, "masters");
    const { id } = pid.parse(req.params); const body = PriceActive.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const audit = await setPriceActive(tx, s, id, body.active, body.reason); return { status: 200, body: await priceList(tx, s), audit }; });
  });
  /* ADR 0022: a test offered to the Setu network */
  app.post("/v1/admin/prices/:id/network", { config: { ownTx: true } }, async (req, reply): Promise<PriceList> => {
    requireAdm(req, "masters");
    const { id } = pid.parse(req.params); const body = PriceNetwork.parse(req.body ?? {});
    return command(req, reply, async (tx, s) => { const audit = await setPriceNetwork(tx, s, id, body.network); return { status: 200, body: await priceList(tx, s), audit }; });
  });
  app.get("/v1/admin/prices/:id/history", async (req): Promise<PriceHistory> => {
    requireAdm(req, "masters");
    const { id } = pid.parse(req.params);
    return query(req, async (tx, s) => ({ body: await priceHistory(tx, s, id), audit: [{ action: "view", entity: "ChargePriceChange", entityId: id }] }));
  });

  /* ── the audit log (adm/audit) ── */
  app.get("/v1/admin/audit", async (req): Promise<AuditPage> => {
    requireAdm(req, "audit");
    const q = AuditQuery.parse(req.query);
    return query(req, async (tx, s) => { const p = await auditPage(tx, s, q); return { body: p, audit: [{ action: "view", entity: "AuditEvent", detail: { purpose: "audit-log", filters: { ...q, before: undefined }, count: p.items.length } }] }; });
  });
  app.get("/v1/admin/audit.csv", async (req, reply) => {
    requireAdm(req, "audit");
    const q = AuditQuery.parse(req.query);
    const r = await query(req, async (tx, s) => { const x = await auditCsv(tx, s, q); return { body: x, audit: [{ action: "export", entity: "AuditEvent", detail: { filters: { ...q, before: undefined }, rows: x.rows, truncated: x.truncated } }] }; });
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="setu-audit-${new Date().toISOString().slice(0, 10)}.csv"`).header("cache-control", "no-store").send("﻿" + r.csv);
  });
}
