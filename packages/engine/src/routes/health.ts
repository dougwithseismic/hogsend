import {
  type Database,
  emailSends,
  getClientSchemaVersion,
  getEngineSchemaVersion,
  journeyStates,
} from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { gte, sql } from "drizzle-orm";
import type { AppEnv } from "../app.js";
import { API_VERSION } from "../env.js";
import { getRedis } from "../lib/redis.js";
import { getWorkerHeartbeat } from "../lib/worker-heartbeat.js";

const componentSchema = z.object({
  status: z.enum(["up", "down"]),
  latencyMs: z.number().optional(),
});

// Worker connectivity, derived from the Redis heartbeat. Informational only —
// the worker is a separate service, so its absence does NOT make the API
// "degraded" (that would falsely fail the API's own healthcheck).
const workerComponentSchema = z.object({
  status: z.enum(["up", "down"]),
  lastSeenAt: z.string().optional(),
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

// Recent activity counts (last 24h). Surfaces silent failures — a failed
// journey or send otherwise only shows in worker logs while health stays
// green. Informational only: counts never affect `status`, and a query
// failure degrades each count to null rather than breaking health.
const activitySchema = z.object({
  windowHours: z.number(),
  journeys: z.object({
    failed: z.number().nullable(),
    completed: z.number().nullable(),
  }),
  emails: z.object({
    failed: z.number().nullable(),
    sent: z.number().nullable(),
  }),
});

const healthResponseSchema = z.object({
  status: z.enum(["healthy", "degraded", "migration_pending"]),
  uptime: z.number(),
  timestamp: z.string(),
  version: z.string(),
  components: z.object({
    database: componentSchema,
    redis: componentSchema,
    worker: workerComponentSchema,
  }),
  schema: z.object({
    engine: trackSchema,
    client: trackSchema,
  }),
  activity: activitySchema,
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

const ACTIVITY_WINDOW_HOURS = 24;

type Activity = z.infer<typeof activitySchema>;

const NULL_ACTIVITY: Activity = {
  windowHours: ACTIVITY_WINDOW_HOURS,
  journeys: { failed: null, completed: null },
  emails: { failed: null, sent: null },
};

// Reporting must never slow the healthcheck down: an unreachable DB makes the
// COUNT queries hang on connect (the component check above answers "down"
// fast, but a fresh query can queue behind the pool), so the whole thing is
// raced against a short deadline and degrades to nulls.
const ACTIVITY_TIMEOUT_MS = 1500;

// Cheap windowed COUNTs (one FILTER query per table; the time columns are
// indexed — email_sends_created_at_idx and journey_states_updated_at_idx —
// so each prunes by index instead of seq-scanning on every healthcheck hit).
// Never throws — any failure degrades to nulls so a reporting hiccup can't
// take the healthcheck down.
async function getRecentActivity(db: Database): Promise<Activity> {
  return Promise.race([
    queryRecentActivity(db),
    new Promise<Activity>((resolve) =>
      setTimeout(() => resolve(NULL_ACTIVITY), ACTIVITY_TIMEOUT_MS).unref?.(),
    ),
  ]);
}

async function queryRecentActivity(db: Database): Promise<Activity> {
  const since = new Date(Date.now() - ACTIVITY_WINDOW_HOURS * 60 * 60 * 1000);
  try {
    const [journeyRows, emailRows] = await Promise.all([
      db
        .select({
          failed: sql<number>`count(*) filter (where ${journeyStates.status} = 'failed')`,
          completed: sql<number>`count(*) filter (where ${journeyStates.status} = 'completed')`,
        })
        .from(journeyStates)
        // updatedAt (set on every status transition) so a journey entered
        // days ago that failed/completed within the window still counts.
        .where(gte(journeyStates.updatedAt, since)),
      db
        .select({
          failed: sql<number>`count(*) filter (where ${emailSends.status} = 'failed')`,
          sent: sql<number>`count(*) filter (where ${emailSends.status} in ('sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained'))`,
        })
        .from(emailSends)
        .where(gte(emailSends.createdAt, since)),
    ]);
    return {
      windowHours: ACTIVITY_WINDOW_HOURS,
      journeys: {
        failed: Number(journeyRows[0]?.failed ?? 0),
        completed: Number(journeyRows[0]?.completed ?? 0),
      },
      emails: {
        failed: Number(emailRows[0]?.failed ?? 0),
        sent: Number(emailRows[0]?.sent ?? 0),
      },
    };
  } catch {
    return NULL_ACTIVITY;
  }
}

// A component that can't answer quickly IS down for healthcheck purposes —
// an unreachable Redis otherwise stalls the probe on ioredis reconnect
// backoff, and a connection-refused Postgres makes postgres-js retry the
// connect (default connect_timeout 30s) rather than reject, so EVERY db
// consumer in this handler must be raced against a deadline or /v1/health
// itself hangs.
const COMPONENT_TIMEOUT_MS = 1500;

// Race a read against the component deadline, degrading to `fallback`.
// Unlike checkComponent this preserves the read's value type.
async function withDeadline<T>(read: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    read,
    new Promise<T>((resolve) =>
      setTimeout(() => resolve(fallback), COMPONENT_TIMEOUT_MS).unref?.(),
    ),
  ]);
}

// Degraded schema read: the timeout means the DB didn't answer, which the
// `database` component already reports — claiming `migration_pending` on top
// of that would be spurious, so an unreadable track degrades to in-sync.
const NULL_SCHEMA = {
  required: null,
  applied: null,
  pending: [] as string[],
  inSync: true,
};

async function checkComponent(
  fn: () => Promise<void>,
): Promise<{ status: "up" | "down"; latencyMs: number }> {
  const start = performance.now();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("component check timed out")),
      COMPONENT_TIMEOUT_MS,
    ).unref?.(),
  );
  try {
    await Promise.race([fn(), timeout]);
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

    const [dbCheck, redisCheck, heartbeat, engine, client, activity] =
      await Promise.all([
        checkComponent(async () => {
          await db.execute(sql`SELECT 1`);
        }),
        checkComponent(async () => {
          // Actively probe: getRedis() lazily creates + connects the client (with
          // family:0 for Railway IPv6). The old getRedisIfConnected() only returned
          // a client if something had ALREADY created one — which nothing does when
          // PostHog is disabled — so redis always read "down" even though it was
          // reachable. ioredis buffers the ping until connected (or rejects if the
          // host is genuinely unreachable → a truthful "down").
          await getRedis().ping();
        }),
        withDeadline(getWorkerHeartbeat(), { alive: false }),
        withDeadline(getEngineSchemaVersion(db), NULL_SCHEMA),
        withDeadline(
          getClientSchemaVersion(db, clientJournal ?? { entries: [] }),
          NULL_SCHEMA,
        ),
        getRecentActivity(db),
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
          worker: {
            status: heartbeat.alive ? ("up" as const) : ("down" as const),
            lastSeenAt: heartbeat.lastSeenAt,
          },
        },
        activity,
      },
      200,
    );
  },
);
