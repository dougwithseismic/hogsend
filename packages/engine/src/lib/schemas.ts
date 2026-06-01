import { z } from "@hono/zod-openapi";

export const errorSchema = z.object({ error: z.string() });

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
});
