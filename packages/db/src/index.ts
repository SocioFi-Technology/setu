import { PrismaClient } from "@prisma/client";
export * from "@prisma/client";

/**
 * The API's client. It connects as `setu_app` (DATABASE_URL_APP), a role that row-level security applies to.
 * There is deliberately no fallback to DATABASE_URL: that is the owner/superuser, which ignores RLS.
 * Migrations and the seed use the owner client in `owner.ts`.
 */
const appUrl = process.env.DATABASE_URL_APP;
export const prisma: PrismaClient = appUrl
  ? new PrismaClient({ datasourceUrl: appUrl })
  : (new Proxy({}, { get() { throw new Error("DATABASE_URL_APP is not set — the API must connect as setu_app (see .env.example)"); } }) as PrismaClient);

export type Tx = PrismaClient;

/**
 * Runs `fn` inside a transaction with the Postgres session variable `app.tenant_id` set,
 * which the row-level-security policies read. Every request handler and every job uses this.
 * `userId` (a signed-in request) sets `app.user_id`: the lab guards require every "who" column the API writes to be
 * that user (security review A8–A11, L1). Jobs and provider callbacks run without one.
 */
export async function forTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, opts: { timeoutMs?: number; userId?: string } = {}): Promise<T> {
  if (!tenantId) throw new Error("forTenant: tenantId is required");
  return prisma.$transaction(async (tx: unknown) => {
    await (tx as PrismaClient).$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    if (opts.userId) await (tx as PrismaClient).$executeRaw`SELECT set_config('app.user_id', ${opts.userId}, true)`;
    return fn(tx as unknown as Tx);
  }, opts.timeoutMs ? { timeout: opts.timeoutMs, maxWait: 5_000 } : undefined);
}

export interface LoginCandidate {
  id: string; tenantId: string; nameBn: string; nameEn: string; phone: string | null; email: string | null; passwordHash: string;
  plan: "clinic" | "lite" | "pro"; roles: { organizationId: string; organizationName: string; role: string }[];
  /** ADR 0010 */
  mustChangePassword?: boolean; tempPasswordExpiresAt?: string | null; tempPasswordUsedAt?: string | null; sessionGeneration?: number;
}
/** The one pre-tenant read (login): a SECURITY DEFINER function returning only what the password check needs. */
export async function loginLookup(phones: string[], email: string | null): Promise<LoginCandidate[]> {
  const rows = await prisma.$queryRaw<{ users: LoginCandidate[] }[]>`SELECT auth_login_lookup(${phones}::text[], ${email}::text) AS users`;
  return rows[0]?.users ?? [];
}

/** The one pre-tenant read for provider callbacks (slice A6–A7): which tenant and payment a provider reference belongs
    to, and whether it is an earlier (superseded) attempt. SECURITY DEFINER; reveals nothing else. */
export async function paymentRefLookup(provider: string, providerRef: string): Promise<{ tenantId: string; paymentId: string; superseded: boolean } | null> {
  const rows = await prisma.$queryRaw<{ hit: { tenantId: string; paymentId: string; superseded: boolean } | null }[]>`SELECT payment_ref_lookup(${provider}::text, ${providerRef}::text) AS hit`;
  return rows[0]?.hit ?? null;
}

/** The public receipt verify page (slice A6–A7): facility, receipt number, date and amount for a verify code — never
    the patient. SECURITY DEFINER; the only pre-tenant read the verify route makes. */
export async function receiptVerifyLookup(code: string): Promise<{ facilityEn: string; facilityBn: string | null; number: string; createdAt: string; paidPaisa: number } | null> {
  const rows = await prisma.$queryRaw<{ hit: { facilityEn: string; facilityBn: string | null; number: string; createdAt: string; paidPaisa: number } | null }[]>`SELECT receipt_verify_lookup(${code}::text) AS hit`;
  const hit = rows[0]?.hit ?? null;
  // A timestamp inside jsonb comes back without a time zone; the column holds UTC (hands-on test 03/10/2026: the
  // verify page showed the UTC clock as Dhaka time).
  return hit ? { ...hit, createdAt: /[zZ]|[+-]\d\d:?\d\d$/.test(hit.createdAt) ? hit.createdAt : `${hit.createdAt}Z` } : null;
}

/* ── ADR 0011: wallet gateways ── */
export interface GatewayTokenRow { idToken: string; idExpiresAt: Date; refreshToken: string; refreshExpiresAt: Date }
const toToken = (h: { idToken: string; idExpiresAt: string; refreshToken: string; refreshExpiresAt: string } | null): GatewayTokenRow | null =>
  h ? { idToken: h.idToken, idExpiresAt: utc(h.idExpiresAt), refreshToken: h.refreshToken, refreshExpiresAt: utc(h.refreshExpiresAt) } : null;
const utc = (s: string) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);

/** The gateway's shared token, renewed by at most one API process at a time: under a transaction-scoped advisory lock
    `renew` sees the stored token (or null) and returns a new one to store, or null to keep it. */
export async function withGatewayToken(provider: string, renew: (current: GatewayTokenRow | null) => Promise<GatewayTokenRow | null>): Promise<GatewayTokenRow | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"gateway-token:" + provider}::text))`;
    const rows = await tx.$queryRaw<{ hit: Parameters<typeof toToken>[0] }[]>`SELECT gateway_token_get(${provider}::text) AS hit`;
    const current = toToken(rows[0]?.hit ?? null);
    const next = await renew(current);
    if (!next) return current;
    await tx.$executeRaw`SELECT gateway_token_put(${provider}::text, ${next.idToken}::text, ${next.idExpiresAt}::timestamptz, ${next.refreshToken}::text, ${next.refreshExpiresAt}::timestamptz)`;
    return next;
  }, { timeout: 45_000, maxWait: 45_000 });
}

/** The public short link: which tenant and payment a link code belongs to. SECURITY DEFINER; nothing else. */
export async function paymentLinkLookup(code: string): Promise<{ tenantId: string; paymentId: string } | null> {
  const rows = await prisma.$queryRaw<{ hit: { tenantId: string; paymentId: string } | null }[]>`SELECT payment_link_lookup(${code}::text) AS hit`;
  return rows[0]?.hit ?? null;
}

/** Wallet payments the sweep must look at (left without a link, or an execute claimed and never answered). */
export async function paymentSweepTargets(before: Date): Promise<{ tenantId: string; paymentId: string }[]> {
  const rows = await prisma.$queryRaw<{ tenant_id: string; payment_id: string }[]>`SELECT * FROM payment_sweep_targets(${before}::timestamptz)`;
  return rows.map((r) => ({ tenantId: r.tenant_id, paymentId: r.payment_id }));
}
