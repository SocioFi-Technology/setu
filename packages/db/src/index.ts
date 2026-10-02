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
 */
export async function forTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!tenantId) throw new Error("forTenant: tenantId is required");
  return prisma.$transaction(async (tx: unknown) => {
    await (tx as PrismaClient).$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx as unknown as Tx);
  });
}

export interface LoginCandidate {
  id: string; tenantId: string; nameBn: string; nameEn: string; phone: string | null; email: string | null; passwordHash: string;
  plan: "clinic" | "lite" | "pro"; roles: { organizationId: string; organizationName: string; role: string }[];
}
/** The one pre-tenant read (login): a SECURITY DEFINER function returning only what the password check needs. */
export async function loginLookup(phones: string[], email: string | null): Promise<LoginCandidate[]> {
  const rows = await prisma.$queryRaw<{ users: LoginCandidate[] }[]>`SELECT auth_login_lookup(${phones}::text[], ${email}::text) AS users`;
  return rows[0]?.users ?? [];
}
