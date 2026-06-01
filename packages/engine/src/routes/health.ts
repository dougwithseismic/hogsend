import { getClientSchemaVersion, getEngineSchemaVersion } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import type { AppEnv } from "../app.js";
import { API_VERSION } from "../env.js";
import { getRedisIfConnected } from "../lib/redis.js";

const componentSchema = z.object({
  status: z.enum(["up", "down"]),
  latencyMs: z.number().optional(),
});

// Per-track schema version block. Two tracks: `engine` (bundled @hogsend/db
// migrations) and `client` (the client repo's own migrations). See
// docs/UPGRADING.md "Two-track migrations".
const trackSchema = z.object({
  applied: z.string().nullable(),
  required: z.string().nullable(),
  inSync: z.boolean(),
  pending: z.array(z.string()),
});

const healthResponseSchema = z.object({
  status: z.enum(["healthy", "degraded", "migration_pending"]),
  uptime: z.number(),
  timestamp: z.string(),
  version: z.string(),
  components: z.object({
    database: componentSchema,
    redis: componentSchema,
  }),
  schema: z.object({
    engine: trackSchema,
    client: trackSchema,
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
    const { db, clientJournal } = c.get("container");

    const [dbCheck, redisCheck, engine, client] = await Promise.all([
      checkComponent(async () => {
        await db.execute(sql`SELECT 1`);
      }),
      checkComponent(async () => {
        const redis = getRedisIfConnected();
        if (!redis) throw new Error("Not connected");
        await redis.ping();
      }),
      getEngineSchemaVersion(db),
      getClientSchemaVersion(db, clientJournal ?? { entries: [] }),
    ]);

    // `migration_pending` if EITHER track is behind. The engine track also gates
    // boot (fatal); the client track surfaces here non-fatally (client-owned).
    const inSync = engine.inSync && client.inSync;
    const allUp = dbCheck.status === "up" && redisCheck.status === "up";
    const status = !inSync
      ? ("migration_pending" as const)
      : allUp
        ? ("healthy" as const)
        : ("degraded" as const);

    return c.json(
      {
        status,
        schema: {
          engine: {
            applied: engine.applied,
            required: engine.required,
            inSync: engine.inSync,
            pending: engine.pending,
          },
          client: {
            applied: client.applied,
            required: client.required,
            inSync: client.inSync,
            pending: client.pending,
          },
        },
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
