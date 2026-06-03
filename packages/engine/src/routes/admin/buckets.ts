import { bucketConfigs, bucketMemberships } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { AppEnv } from "../../app.js";

const bucketSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean(),
  kind: z.enum(["dynamic", "manual"]),
  timeBased: z.boolean(),
  entryLimit: z.enum(["once", "once_per_period", "unlimited"]),
  counts: z.object({
    active: z.number(),
    left: z.number(),
  }),
});

const memberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userEmail: z.string().nullable(),
  bucketId: z.string(),
  status: z.string(),
  enteredAt: z.string(),
  leftAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  lastEvaluatedAt: z.string().nullable(),
  entryCount: z.number(),
  source: z.string().nullable(),
  context: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const errorSchema = z.object({ error: z.string() });

function serializeMember(row: typeof bucketMemberships.$inferSelect) {
  return {
    id: row.id,
    userId: row.userId,
    userEmail: row.userEmail,
    bucketId: row.bucketId,
    status: row.status,
    enteredAt: row.enteredAt.toISOString(),
    leftAt: row.leftAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() ?? null,
    entryCount: row.entryCount,
    source: row.source,
    context: (row.context ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const emptyCounts = {
  active: 0,
  left: 0,
};

// --- Route definitions ---

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin — Buckets"],
  summary: "List all buckets",
  request: {
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      enabled: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            buckets: z.array(bucketSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated bucket list",
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Admin — Buckets"],
  summary: "Get bucket detail",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            bucket: bucketSchema.extend({
              criteria: z.record(z.string(), z.unknown()).optional(),
              entryPeriod: z
                .record(z.string(), z.unknown())
                .nullable()
                .optional(),
              minDwell: z.record(z.string(), z.unknown()).nullable().optional(),
              maxDwell: z.record(z.string(), z.unknown()).nullable().optional(),
              reconcileEvery: z
                .record(z.string(), z.unknown())
                .nullable()
                .optional(),
              fastExpiry: z.boolean(),
              syncToPostHog: z.boolean(),
              feedsJourneys: z.array(
                z.object({
                  id: z.string(),
                  name: z.string(),
                  trigger: z.string(),
                }),
              ),
              recentMembers: z.array(memberSchema),
            }),
          }),
        },
      },
      description: "Bucket detail with counts, feeds, and recent members",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Bucket not found",
    },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Admin — Buckets"],
  summary: "Enable or disable a bucket",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ enabled: z.boolean() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            bucket: z.object({
              id: z.string(),
              name: z.string(),
              enabled: z.boolean(),
              updatedAt: z.string(),
            }),
          }),
        },
      },
      description: "Bucket updated",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Bucket not found",
    },
  },
});

const listMembersRoute = createRoute({
  method: "get",
  path: "/{id}/members",
  tags: ["Admin — Buckets"],
  summary: "List bucket members",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
      status: z.enum(["active", "left"]).default("active"),
      userId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            members: z.array(memberSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated bucket members",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Bucket not found",
    },
  },
});

// --- Handlers ---

export const bucketsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db, bucketRegistry } = c.get("container");
    const { limit, offset, enabled } = c.req.valid("query");

    const allBuckets = bucketRegistry.getAll();
    const bucketIds = allBuckets.map((b) => b.id);

    const [configs, statusCounts] = await Promise.all([
      bucketIds.length > 0
        ? db
            .select()
            .from(bucketConfigs)
            .where(inArray(bucketConfigs.bucketId, bucketIds))
        : Promise.resolve([]),
      bucketIds.length > 0
        ? db
            .select({
              bucketId: bucketMemberships.bucketId,
              status: bucketMemberships.status,
              count: count(),
            })
            .from(bucketMemberships)
            .where(
              and(
                inArray(bucketMemberships.bucketId, bucketIds),
                isNull(bucketMemberships.deletedAt),
              ),
            )
            .groupBy(bucketMemberships.bucketId, bucketMemberships.status)
        : Promise.resolve([]),
    ]);

    const configMap = new Map(
      configs.map((cfg) => [cfg.bucketId, cfg.enabled]),
    );
    const countsMap = new Map<string, typeof emptyCounts>();
    for (const row of statusCounts) {
      const existing = countsMap.get(row.bucketId) ?? { ...emptyCounts };
      existing[row.status as keyof typeof emptyCounts] = row.count;
      countsMap.set(row.bucketId, existing);
    }

    const result = allBuckets.map((b) => {
      const dbEnabled = configMap.get(b.id);
      const effectiveEnabled = dbEnabled !== undefined ? dbEnabled : b.enabled;
      return {
        id: b.id,
        name: b.name,
        description: b.description,
        enabled: effectiveEnabled,
        kind: b.kind ?? "dynamic",
        timeBased: b.timeBased ?? false,
        entryLimit: b.entryLimit ?? "unlimited",
        counts: countsMap.get(b.id) ?? { ...emptyCounts },
      };
    });

    const filtered =
      enabled !== undefined
        ? result.filter((b) => b.enabled === (enabled === "true"))
        : result;

    const total = filtered.length;
    const paged = filtered.slice(offset, offset + limit);

    return c.json({ buckets: paged, total, limit, offset }, 200);
  })
  .openapi(getRoute, async (c) => {
    const { db, bucketRegistry, registry } = c.get("container");
    const { id } = c.req.valid("param");

    const meta = bucketRegistry.get(id);
    if (!meta) {
      return c.json({ error: "Bucket not found" }, 404);
    }

    const [configs, statusCounts, recentRows] = await Promise.all([
      db
        .select()
        .from(bucketConfigs)
        .where(eq(bucketConfigs.bucketId, id))
        .limit(1),
      db
        .select({
          status: bucketMemberships.status,
          count: count(),
        })
        .from(bucketMemberships)
        .where(
          and(
            eq(bucketMemberships.bucketId, id),
            isNull(bucketMemberships.deletedAt),
          ),
        )
        .groupBy(bucketMemberships.status),
      db
        .select()
        .from(bucketMemberships)
        .where(
          and(
            eq(bucketMemberships.bucketId, id),
            eq(bucketMemberships.status, "active"),
            isNull(bucketMemberships.deletedAt),
          ),
        )
        .orderBy(desc(bucketMemberships.enteredAt))
        .limit(10),
    ]);

    const dbEnabled = configs[0]?.enabled;
    const effectiveEnabled = dbEnabled !== undefined ? dbEnabled : meta.enabled;

    const counts = { ...emptyCounts };
    for (const row of statusCounts) {
      counts[row.status as keyof typeof emptyCounts] = row.count;
    }

    // Which journeys this bucket feeds — cross-reference the bucket's emitted
    // transition events against the journey registry's trigger index. A journey
    // bound to the per-bucket alias `bucket:entered:<id>` (the recommended,
    // narrowly-routed binding) or the generic `bucket:entered` is woken by this
    // bucket's joins.
    const feedEvents = [
      `bucket:entered:${id}`,
      `bucket:left:${id}`,
      "bucket:entered",
      "bucket:left",
    ];
    const feedsMap = new Map<
      string,
      { id: string; name: string; trigger: string }
    >();
    for (const evt of feedEvents) {
      for (const journey of registry.getByTriggerEvent(evt)) {
        feedsMap.set(journey.id, {
          id: journey.id,
          name: journey.name,
          trigger: evt,
        });
      }
    }

    return c.json(
      {
        bucket: {
          id: meta.id,
          name: meta.name,
          description: meta.description,
          enabled: effectiveEnabled,
          kind: meta.kind ?? "dynamic",
          timeBased: meta.timeBased ?? false,
          entryLimit: meta.entryLimit ?? "unlimited",
          criteria: meta.criteria as Record<string, unknown> | undefined,
          entryPeriod: meta.entryPeriod as Record<string, unknown> | undefined,
          minDwell: meta.minDwell as Record<string, unknown> | undefined,
          maxDwell: meta.maxDwell as Record<string, unknown> | undefined,
          reconcileEvery: meta.reconcileEvery as
            | Record<string, unknown>
            | undefined,
          fastExpiry: meta.fastExpiry ?? false,
          syncToPostHog: meta.syncToPostHog ?? false,
          counts,
          feedsJourneys: Array.from(feedsMap.values()),
          recentMembers: recentRows.map(serializeMember),
        },
      },
      200,
    );
  })
  .openapi(patchRoute, async (c) => {
    const { db, bucketRegistry } = c.get("container");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const meta = bucketRegistry.get(id);
    if (!meta) {
      return c.json({ error: "Bucket not found" }, 404);
    }

    const [config] = await db
      .insert(bucketConfigs)
      .values({ bucketId: id, enabled: body.enabled })
      .onConflictDoUpdate({
        target: [bucketConfigs.bucketId],
        set: { enabled: body.enabled, updatedAt: new Date() },
      })
      .returning();

    if (!config) {
      throw new Error("Failed to upsert bucket config");
    }

    return c.json(
      {
        bucket: {
          id: meta.id,
          name: meta.name,
          enabled: config.enabled,
          updatedAt: config.updatedAt.toISOString(),
        },
      },
      200,
    );
  })
  .openapi(listMembersRoute, async (c) => {
    const { db, bucketRegistry } = c.get("container");
    const { id } = c.req.valid("param");
    const { limit, offset, status, userId } = c.req.valid("query");

    if (!bucketRegistry.has(id)) {
      return c.json({ error: "Bucket not found" }, 404);
    }

    const conditions = [
      eq(bucketMemberships.bucketId, id),
      eq(bucketMemberships.status, status),
      isNull(bucketMemberships.deletedAt),
    ];
    if (userId) {
      conditions.push(eq(bucketMemberships.userId, userId));
    }

    const where = and(...conditions);

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(bucketMemberships)
        .where(where)
        .orderBy(desc(bucketMemberships.enteredAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(bucketMemberships).where(where),
    ]);

    return c.json(
      {
        members: rows.map(serializeMember),
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
      },
      200,
    );
  });
