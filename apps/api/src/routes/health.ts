import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import type { AppEnv } from "../app.js";
import { API_VERSION } from "../env.js";
import { getRedisIfConnected } from "../lib/redis.js";

const componentSchema = z.object({
  status: z.enum(["up", "down"]),
  latencyMs: z.number().optional(),
});

const healthResponseSchema = z.object({
  status: z.enum(["healthy", "degraded"]),
  uptime: z.number(),
  timestamp: z.string(),
  version: z.string(),
  components: z.object({
    database: componentSchema,
    redis: componentSchema,
  }),
});

const healthRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Health"],
  summary: "Health check with component status",
  responses: {
    200: {
      content: {
        "application/json": { schema: healthResponseSchema },
      },
      description: "Service health status",
    },
  },
});

async function checkComponent(
  fn: () => Promise<void>,
): Promise<{ status: "up" | "down"; latencyMs: number }> {
  const start = performance.now();
  try {
    await fn();
    return {
      status: "up",
      latencyMs: Math.round(performance.now() - start),
    };
  } catch {
    return {
      status: "down",
      latencyMs: Math.round(performance.now() - start),
    };
  }
}

export const healthRouter = new OpenAPIHono<AppEnv>().openapi(
  healthRoute,
  async (c) => {
    const { db } = c.get("container");

    const [dbCheck, redisCheck] = await Promise.all([
      checkComponent(async () => {
        await db.execute(sql`SELECT 1`);
      }),
      checkComponent(async () => {
        const redis = getRedisIfConnected();
        if (!redis) throw new Error("Not connected");
        await redis.ping();
      }),
    ]);

    const allUp = dbCheck.status === "up" && redisCheck.status === "up";

    return c.json(
      {
        status: allUp ? ("healthy" as const) : ("degraded" as const),
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        version: API_VERSION,
        components: {
          database: dbCheck,
          redis: redisCheck,
        },
      },
      200,
    );
  },
);
