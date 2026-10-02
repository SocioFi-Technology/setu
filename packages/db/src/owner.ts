import { PrismaClient } from "@prisma/client";

/**
 * Owner connection (DATABASE_URL). Only for the seed and maintenance scripts — never import this from the API:
 * the owner bypasses row-level security.
 */
export const owner = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
