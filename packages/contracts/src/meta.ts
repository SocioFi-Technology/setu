import { z } from "zod";
export const Health = z.object({ ok: z.literal(true), version: z.string(), db: z.enum(["up", "down", "skipped"]), time: z.string() });
export type Health = z.infer<typeof Health>;
