import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AppEnv } from "../app.js";
import { API_VERSION } from "../env.js";

const healthResponseSchema = z.object({
  status: z.enum(["healthy", "degraded"]),
  uptime: z.number(),
  timestamp: z.string(),
  version: z.string(),
});

const healthRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Health"],
  summary: "Health check",
  responses: {
    200: {
      content: {
        "application/json": { schema: healthResponseSchema },
      },
      description: "Service is healthy",
    },
  },
});

export const healthRouter = new OpenAPIHono<AppEnv>().openapi(
  healthRoute,
  (c) => {
    return c.json(
      {
        status: "healthy" as const,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: API_VERSION,
      },
      200,
    );
  },
);
