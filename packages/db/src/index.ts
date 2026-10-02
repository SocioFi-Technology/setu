import { PrismaClient } from "@prisma/client";
export * from "@prisma/client";

/** One client per process. Tenant scoping is applied per request with `forTenant`. */
export const prisma = new PrismaClient();

/**
 * Runs `fn` inside a transaction with the Postgres session variable `app.tenant_id` set,
 * which the row-level-security policies read. Every request handler and every job uses this.
 */
export async function forTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx: unknown) => {
    await (tx as PrismaClient).$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId.replace(/'/g, "")}', true)`);
    return fn(tx as unknown as PrismaClient);
  });
}
