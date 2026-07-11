import {
  bucketMemberships,
  contacts,
  emailPreferences,
  emailSends,
  journeyStates,
  userEvents,
} from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  and,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import {
  getRuntimeSpecMeta,
  getRuntimeSpecStore,
} from "../../journeys/spec/runtime-spec-store.js";
import { rate, TRUNC_SQL } from "../../lib/metrics-sql.js";
import { errorSchema } from "../../lib/schemas.js";

const overviewRoute = createRoute({
  method: "get",
  path: "/overview",
  tags: ["Admin — Metrics"],
  summary: "System-wide overview metrics",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            totalContacts: z.number(),
            activeJourneys: z.number(),
            activeBuckets: z.number(),
            bucketMembers: z.number(),
            emailsSent24h: z.number(),
            emailsSent7d: z.number(),
            emailsSent30d: z.number(),
            bounceRate30d: z.number(),
            unsubscribeRate: z.number(),
          }),
        },
      },
      description: "System-wide summary metrics",
    },
  },
});

const journeysMetricsRoute = createRoute({
  method: "get",
  path: "/journeys",
  tags: ["Admin — Metrics"],
  summary: "Per-journey performance metrics",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            journeys: z.array(
              z.object({
                journeyId: z.string(),
                name: z.string(),
                enrolled: z.number(),
                completed: z.number(),
                failed: z.number(),
                exited: z.number(),
                active: z.number(),
                completionRate: z.number(),
                avgDurationSecs: z.number().nullable(),
              }),
            ),
          }),
        },
      },
      description: "Per-journey metrics with completion rates",
    },
  },
});

const journeyFunnelRoute = createRoute({
  method: "get",
  path: "/journeys/{id}",
  tags: ["Admin — Metrics"],
  summary: "Single journey funnel metrics",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            journeyId: z.string(),
            enrolled: z.number(),
            emailSent: z.number(),
            emailOpened: z.number(),
            emailClicked: z.number(),
            completed: z.number(),
            failed: z.number(),
            exited: z.number(),
          }),
        },
      },
      description: "Journey funnel with drop-off at each step",
    },
    404: {
      content: {
        "application/json": { schema: errorSchema },
      },
      description: "Journey not found",
    },
  },
});

const emailMetricsRoute = createRoute({
  method: "get",
  path: "/emails",
  tags: ["Admin — Metrics"],
  summary: "Per-template email metrics",
  request: {
    query: z.object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      includeUntemplated: z.enum(["true", "false"]).default("false"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            templates: z.array(
              z.object({
                templateKey: z.string(),
                sent: z.number(),
                delivered: z.number(),
                opened: z.number(),
                clicked: z.number(),
                bounced: z.number(),
                deliveryRate: z.number(),
                openRate: z.number(),
                clickRate: z.number(),
                clickToDeliveryRate: z.number(),
              }),
            ),
          }),
        },
      },
      description: "Per-template email performance metrics",
    },
  },
});

const deliverabilityRoute = createRoute({
  method: "get",
  path: "/emails/deliverability",
  tags: ["Admin — Metrics"],
  summary: "Email deliverability trends over time",
  request: {
    query: z.object({
      period: z.enum(["day", "week", "month"]).default("day"),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            points: z.array(
              z.object({
                date: z.string(),
                total: z.number(),
                delivered: z.number(),
                bounced: z.number(),
                complained: z.number(),
                deliveryRate: z.number(),
              }),
            ),
          }),
        },
      },
      description: "Time-series deliverability data",
    },
  },
});

const eventVolumeRoute = createRoute({
  method: "get",
  path: "/events",
  tags: ["Admin — Metrics"],
  summary: "Event volume by name over time",
  request: {
    query: z.object({
      granularity: z.enum(["hour", "day", "week"]).default("day"),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            events: z.array(
              z.object({
                event: z.string(),
                date: z.string(),
                count: z.number(),
              }),
            ),
          }),
        },
      },
      description: "Event volume time-series data",
    },
  },
});

const bucketsMetricsRoute = createRoute({
  method: "get",
  path: "/buckets",
  tags: ["Admin — Metrics"],
  summary: "Per-bucket membership metrics",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            buckets: z.array(
              z.object({
                bucketId: z.string(),
                name: z.string(),
                size: z.number(),
                entered: z.number(),
                left: z.number(),
                avgDwellSecs: z.number().nullable(),
              }),
            ),
          }),
        },
      },
      description: "Per-bucket size, entered/left totals, and average dwell",
    },
  },
});

const bucketTrendRoute = createRoute({
  method: "get",
  path: "/buckets/{id}",
  tags: ["Admin — Metrics"],
  summary: "Single bucket size-over-time and entered/left trend",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      period: z.enum(["day", "week", "month"]).default("day"),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            bucketId: z.string(),
            size: z.number(),
            points: z.array(
              z.object({
                date: z.string(),
                entered: z.number(),
                left: z.number(),
              }),
            ),
          }),
        },
      },
      description: "Bucket entered/left time-series with current size",
    },
    404: {
      content: {
        "application/json": { schema: errorSchema },
      },
      description: "Bucket not found",
    },
  },
});

export const metricsRouter = new OpenAPIHono<AppEnv>()
  .openapi(overviewRoute, async (c) => {
    const { db } = c.get("container");

    const now = new Date();
    const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      contactsTotal,
      activeJourneys,
      activeBucketsRows,
      bucketMembers,
      emails24h,
      emails7d,
      emails30d,
      bounced30d,
      totalPrefs,
      unsubscribed,
    ] = await Promise.all([
      db
        .select({ count: count() })
        .from(contacts)
        .where(isNull(contacts.deletedAt))
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: count() })
        .from(journeyStates)
        .where(
          and(
            inArray(journeyStates.status, ["active", "waiting"]),
            isNull(journeyStates.deletedAt),
          ),
        )
        .then((r) => r[0]?.count ?? 0),
      // Distinct buckets with at least one active member.
      db
        .selectDistinct({ bucketId: bucketMemberships.bucketId })
        .from(bucketMemberships)
        .where(
          and(
            inArray(bucketMemberships.status, ["active"]),
            isNull(bucketMemberships.deletedAt),
          ),
        ),
      // Total active memberships across all buckets.
      db
        .select({ count: count() })
        .from(bucketMemberships)
        .where(
          and(
            inArray(bucketMemberships.status, ["active"]),
            isNull(bucketMemberships.deletedAt),
          ),
        )
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: count() })
        .from(emailSends)
        .where(and(isNotNull(emailSends.sentAt), gte(emailSends.sentAt, h24)))
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: count() })
        .from(emailSends)
        .where(and(isNotNull(emailSends.sentAt), gte(emailSends.sentAt, d7)))
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: count() })
        .from(emailSends)
        .where(and(isNotNull(emailSends.sentAt), gte(emailSends.sentAt, d30)))
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: count() })
        .from(emailSends)
        .where(
          and(eq(emailSends.status, "bounced"), gte(emailSends.createdAt, d30)),
        )
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: count() })
        .from(emailPreferences)
        .then((r) => r[0]?.count ?? 0),
      db
        .select({ count: count() })
        .from(emailPreferences)
        .where(eq(emailPreferences.unsubscribedAll, true))
        .then((r) => r[0]?.count ?? 0),
    ]);

    const sent30d = emails30d;

    return c.json(
      {
        totalContacts: contactsTotal,
        activeJourneys,
        activeBuckets: activeBucketsRows.length,
        bucketMembers,
        emailsSent24h: emails24h,
        emailsSent7d: emails7d,
        emailsSent30d: sent30d,
        bounceRate30d: rate(bounced30d, sent30d),
        unsubscribeRate: rate(unsubscribed, totalPrefs),
      },
      200,
    );
  })
  .openapi(journeysMetricsRoute, async (c) => {
    const { db, registry } = c.get("container");

    const [statusCounts, durations] = await Promise.all([
      db
        .select({
          journeyId: journeyStates.journeyId,
          status: journeyStates.status,
          count: count(),
        })
        .from(journeyStates)
        .where(isNull(journeyStates.deletedAt))
        .groupBy(journeyStates.journeyId, journeyStates.status),
      db
        .select({
          journeyId: journeyStates.journeyId,
          avgDuration: sql<number>`avg(extract(epoch from (coalesce(${journeyStates.completedAt}, ${journeyStates.exitedAt}) - ${journeyStates.createdAt})))`,
        })
        .from(journeyStates)
        .where(
          and(
            inArray(journeyStates.status, ["completed", "exited"]),
            isNull(journeyStates.deletedAt),
          ),
        )
        .groupBy(journeyStates.journeyId),
    ]);

    const countMap = new Map<string, Record<string, number>>();
    for (const row of statusCounts) {
      const entry = countMap.get(row.journeyId) ?? {};
      entry[row.status] = row.count;
      countMap.set(row.journeyId, entry);
    }

    const durationMap = new Map<string, number>();
    for (const row of durations) {
      if (row.avgDuration != null) {
        durationMap.set(row.journeyId, row.avgDuration);
      }
    }

    // Boot-time journeys PLUS runtime-added DB specs (in the runtime store,
    // not yet in the registry) — Studio's Journeys list renders THIS response,
    // so a just-created journey must appear here without a restart.
    await getRuntimeSpecStore()
      .refreshIfStale(db, Date.now(), 5000)
      .catch(() => {});
    const runtimeOnly = getRuntimeSpecStore()
      .all()
      .filter((s) => !registry.has(s.spec.id))
      .map((s) => ({ id: s.spec.id, ...s.spec.meta }));
    const allJourneys = [...registry.getAll(), ...runtimeOnly];
    const journeys = allJourneys.map((j) => {
      const counts = countMap.get(j.id) ?? {};
      const enrolled =
        (counts.active ?? 0) +
        (counts.waiting ?? 0) +
        (counts.completed ?? 0) +
        (counts.failed ?? 0) +
        (counts.exited ?? 0);
      const completed = counts.completed ?? 0;

      return {
        journeyId: j.id,
        name: j.name,
        enrolled,
        completed,
        failed: counts.failed ?? 0,
        exited: counts.exited ?? 0,
        active: (counts.active ?? 0) + (counts.waiting ?? 0),
        completionRate: rate(completed, enrolled),
        avgDurationSecs: durationMap.has(j.id)
          ? Math.round(durationMap.get(j.id) ?? 0)
          : null,
      };
    });

    return c.json({ journeys }, 200);
  })
  .openapi(journeyFunnelRoute, async (c) => {
    const { db, registry } = c.get("container");
    const { id } = c.req.valid("param");

    // Runtime-added DB specs live in the runtime store until the next boot
    // registers them — fall back so a just-created journey reads immediately.
    const journey = registry.get(id) ?? getRuntimeSpecMeta(id);
    if (!journey) {
      return c.json({ error: "Journey not found" }, 404);
    }

    const [stateCounts, emailCounts] = await Promise.all([
      db
        .select({
          status: journeyStates.status,
          count: count(),
        })
        .from(journeyStates)
        .where(
          and(eq(journeyStates.journeyId, id), isNull(journeyStates.deletedAt)),
        )
        .groupBy(journeyStates.status),
      db
        .select({
          sent: sql<number>`count(*) filter (where ${emailSends.sentAt} is not null)`,
          opened: sql<number>`count(*) filter (where ${emailSends.openedAt} is not null)`,
          clicked: sql<number>`count(*) filter (where ${emailSends.clickedAt} is not null)`,
        })
        .from(emailSends)
        .innerJoin(
          journeyStates,
          eq(emailSends.journeyStateId, journeyStates.id),
        )
        .where(
          and(eq(journeyStates.journeyId, id), isNull(journeyStates.deletedAt)),
        ),
    ]);

    const counts: Record<string, number> = {};
    for (const row of stateCounts) {
      counts[row.status] = row.count;
    }

    const enrolled =
      (counts.active ?? 0) +
      (counts.waiting ?? 0) +
      (counts.completed ?? 0) +
      (counts.failed ?? 0) +
      (counts.exited ?? 0);

    const emails = emailCounts[0] ?? { sent: 0, opened: 0, clicked: 0 };

    return c.json(
      {
        journeyId: id,
        enrolled,
        emailSent: Number(emails.sent),
        emailOpened: Number(emails.opened),
        emailClicked: Number(emails.clicked),
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        exited: counts.exited ?? 0,
      },
      200,
    );
  })
  .openapi(emailMetricsRoute, async (c) => {
    const { db } = c.get("container");
    const { from, to, includeUntemplated } = c.req.valid("query");

    const conditions = [];
    if (includeUntemplated !== "true")
      conditions.push(isNotNull(emailSends.templateKey));
    if (from) conditions.push(gte(emailSends.createdAt, new Date(from)));
    if (to) conditions.push(lte(emailSends.createdAt, new Date(to)));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        templateKey: emailSends.templateKey,
        sent: sql<number>`count(*) filter (where ${emailSends.sentAt} is not null)`,
        delivered: sql<number>`count(*) filter (where ${emailSends.status} = 'delivered' or ${emailSends.deliveredAt} is not null)`,
        opened: sql<number>`count(*) filter (where ${emailSends.openedAt} is not null)`,
        clicked: sql<number>`count(*) filter (where ${emailSends.clickedAt} is not null)`,
        bounced: sql<number>`count(*) filter (where ${emailSends.status} = 'bounced')`,
      })
      .from(emailSends)
      .where(where)
      .groupBy(emailSends.templateKey);

    const templates = rows.map((row) => {
      const sent = Number(row.sent);
      const delivered = Number(row.delivered);
      const opened = Number(row.opened);
      const clicked = Number(row.clicked);
      // Open-rate denominator falls back to sent when delivered-webhooks aren't
      // firing, so opens aren't silently zeroed.
      const openDenominator = delivered > 0 ? delivered : sent;
      return {
        templateKey: row.templateKey ?? "(none)",
        sent,
        delivered,
        opened,
        clicked,
        bounced: Number(row.bounced),
        deliveryRate: rate(delivered, sent),
        openRate: rate(opened, openDenominator),
        clickRate: rate(clicked, opened),
        clickToDeliveryRate: rate(clicked, delivered),
      };
    });

    return c.json({ templates }, 200);
  })
  .openapi(deliverabilityRoute, async (c) => {
    const { db } = c.get("container");
    const { period, from, to } = c.req.valid("query");

    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fromDate = from ? new Date(from) : defaultFrom;
    const toDate = to ? new Date(to) : now;

    const rows = await db
      .select({
        date: sql<string>`date_trunc(${TRUNC_SQL[period]}, ${emailSends.createdAt})::text`,
        total: count(),
        delivered: sql<number>`count(*) filter (where ${emailSends.status} = 'delivered' or ${emailSends.deliveredAt} is not null)`,
        bounced: sql<number>`count(*) filter (where ${emailSends.status} = 'bounced')`,
        complained: sql<number>`count(*) filter (where ${emailSends.status} = 'complained')`,
      })
      .from(emailSends)
      .where(
        and(
          gte(emailSends.createdAt, fromDate),
          lte(emailSends.createdAt, toDate),
        ),
      )
      .groupBy(sql`date_trunc(${TRUNC_SQL[period]}, ${emailSends.createdAt})`)
      .orderBy(sql`date_trunc(${TRUNC_SQL[period]}, ${emailSends.createdAt})`);

    const points = rows.map((row) => {
      const total = row.total;
      const delivered = Number(row.delivered);
      return {
        date: row.date,
        total,
        delivered,
        bounced: Number(row.bounced),
        complained: Number(row.complained),
        deliveryRate: rate(delivered, total),
      };
    });

    return c.json({ points }, 200);
  })
  .openapi(eventVolumeRoute, async (c) => {
    const { db } = c.get("container");
    const { granularity, from, to } = c.req.valid("query");

    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fromDate = from ? new Date(from) : defaultFrom;
    const toDate = to ? new Date(to) : now;

    const rows = await db
      .select({
        event: userEvents.event,
        date: sql<string>`date_trunc(${TRUNC_SQL[granularity]}, ${userEvents.occurredAt})::text`,
        count: count(),
      })
      .from(userEvents)
      .where(
        and(
          gte(userEvents.occurredAt, fromDate),
          lte(userEvents.occurredAt, toDate),
        ),
      )
      .groupBy(
        userEvents.event,
        sql`date_trunc(${TRUNC_SQL[granularity]}, ${userEvents.occurredAt})`,
      )
      .orderBy(
        sql`date_trunc(${TRUNC_SQL[granularity]}, ${userEvents.occurredAt})`,
        userEvents.event,
      )
      .limit(10000);

    const events = rows.map((row) => ({
      event: row.event,
      date: row.date,
      count: row.count,
    }));

    return c.json({ events }, 200);
  })
  .openapi(bucketsMetricsRoute, async (c) => {
    const { db, bucketRegistry } = c.get("container");

    const [sizes, totals, dwell] = await Promise.all([
      // Current size = active, non-deleted memberships per bucket.
      db
        .select({
          bucketId: bucketMemberships.bucketId,
          size: count(),
        })
        .from(bucketMemberships)
        .where(
          and(
            eq(bucketMemberships.status, "active"),
            isNull(bucketMemberships.deletedAt),
          ),
        )
        .groupBy(bucketMemberships.bucketId),
      // Total entered = all rows; total left = rows that have flipped to "left".
      db
        .select({
          bucketId: bucketMemberships.bucketId,
          entered: count(),
          left: sql<number>`count(*) filter (where ${bucketMemberships.status} = 'left')`,
        })
        .from(bucketMemberships)
        .where(isNull(bucketMemberships.deletedAt))
        .groupBy(bucketMemberships.bucketId),
      // Average dwell — seconds between entry and leave (or now, if still active).
      db
        .select({
          bucketId: bucketMemberships.bucketId,
          avgDwell: sql<number>`avg(extract(epoch from (coalesce(${bucketMemberships.leftAt}, now()) - ${bucketMemberships.enteredAt})))`,
        })
        .from(bucketMemberships)
        .where(isNull(bucketMemberships.deletedAt))
        .groupBy(bucketMemberships.bucketId),
    ]);

    const sizeMap = new Map(sizes.map((r) => [r.bucketId, r.size]));
    const totalsMap = new Map(
      totals.map((r) => [
        r.bucketId,
        { entered: Number(r.entered), left: Number(r.left) },
      ]),
    );
    const dwellMap = new Map<string, number>();
    for (const row of dwell) {
      if (row.avgDwell != null) {
        dwellMap.set(row.bucketId, Number(row.avgDwell));
      }
    }

    const buckets = bucketRegistry.getAll().map((b) => {
      const t = totalsMap.get(b.id) ?? { entered: 0, left: 0 };
      return {
        bucketId: b.id,
        name: b.name,
        size: sizeMap.get(b.id) ?? 0,
        entered: t.entered,
        left: t.left,
        avgDwellSecs: dwellMap.has(b.id)
          ? Math.round(dwellMap.get(b.id) ?? 0)
          : null,
      };
    });

    return c.json({ buckets }, 200);
  })
  .openapi(bucketTrendRoute, async (c) => {
    const { db, bucketRegistry } = c.get("container");
    const { id } = c.req.valid("param");
    const { period, from, to } = c.req.valid("query");

    if (!bucketRegistry.has(id)) {
      return c.json({ error: "Bucket not found" }, 404);
    }

    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fromDate = from ? new Date(from) : defaultFrom;
    const toDate = to ? new Date(to) : now;

    const [size, enteredRows, leftRows] = await Promise.all([
      db
        .select({ count: count() })
        .from(bucketMemberships)
        .where(
          and(
            eq(bucketMemberships.bucketId, id),
            eq(bucketMemberships.status, "active"),
            isNull(bucketMemberships.deletedAt),
          ),
        )
        .then((r) => r[0]?.count ?? 0),
      // Joins over time, bucketed on enteredAt.
      db
        .select({
          date: sql<string>`date_trunc(${TRUNC_SQL[period]}, ${bucketMemberships.enteredAt})::text`,
          count: count(),
        })
        .from(bucketMemberships)
        .where(
          and(
            eq(bucketMemberships.bucketId, id),
            isNull(bucketMemberships.deletedAt),
            gte(bucketMemberships.enteredAt, fromDate),
            lte(bucketMemberships.enteredAt, toDate),
          ),
        )
        .groupBy(
          sql`date_trunc(${TRUNC_SQL[period]}, ${bucketMemberships.enteredAt})`,
        )
        .orderBy(
          sql`date_trunc(${TRUNC_SQL[period]}, ${bucketMemberships.enteredAt})`,
        ),
      // Leaves over time, bucketed on leftAt (only flipped rows have a leftAt).
      db
        .select({
          date: sql<string>`date_trunc(${TRUNC_SQL[period]}, ${bucketMemberships.leftAt})::text`,
          count: count(),
        })
        .from(bucketMemberships)
        .where(
          and(
            eq(bucketMemberships.bucketId, id),
            isNull(bucketMemberships.deletedAt),
            isNotNull(bucketMemberships.leftAt),
            gte(bucketMemberships.leftAt, fromDate),
            lte(bucketMemberships.leftAt, toDate),
          ),
        )
        .groupBy(
          sql`date_trunc(${TRUNC_SQL[period]}, ${bucketMemberships.leftAt})`,
        )
        .orderBy(
          sql`date_trunc(${TRUNC_SQL[period]}, ${bucketMemberships.leftAt})`,
        ),
    ]);

    const pointMap = new Map<string, { entered: number; left: number }>();
    for (const row of enteredRows) {
      const entry = pointMap.get(row.date) ?? { entered: 0, left: 0 };
      entry.entered = row.count;
      pointMap.set(row.date, entry);
    }
    for (const row of leftRows) {
      const entry = pointMap.get(row.date) ?? { entered: 0, left: 0 };
      entry.left = row.count;
      pointMap.set(row.date, entry);
    }

    const points = Array.from(pointMap.entries())
      .map(([date, v]) => ({ date, entered: v.entered, left: v.left }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return c.json({ bucketId: id, size, points }, 200);
  });
