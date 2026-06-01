import {
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
import { errorSchema } from "../../lib/schemas.js";

const TRUNC_SQL = {
  hour: sql`'hour'`,
  day: sql`'day'`,
  week: sql`'week'`,
  month: sql`'month'`,
} as const;

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
    const bounceRate30d = sent30d > 0 ? bounced30d / sent30d : 0;
    const unsubscribeRate = totalPrefs > 0 ? unsubscribed / totalPrefs : 0;

    return c.json(
      {
        totalContacts: contactsTotal,
        activeJourneys,
        emailsSent24h: emails24h,
        emailsSent7d: emails7d,
        emailsSent30d: sent30d,
        bounceRate30d: Math.round(bounceRate30d * 10000) / 10000,
        unsubscribeRate: Math.round(unsubscribeRate * 10000) / 10000,
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

    const allJourneys = registry.getAll();
    const journeys = allJourneys.map((j) => {
      const counts = countMap.get(j.id) ?? {};
      const enrolled =
        (counts.active ?? 0) +
        (counts.waiting ?? 0) +
        (counts.completed ?? 0) +
        (counts.failed ?? 0) +
        (counts.exited ?? 0);
      const completed = counts.completed ?? 0;
      const completionRate = enrolled > 0 ? completed / enrolled : 0;

      return {
        journeyId: j.id,
        name: j.name,
        enrolled,
        completed,
        failed: counts.failed ?? 0,
        exited: counts.exited ?? 0,
        active: (counts.active ?? 0) + (counts.waiting ?? 0),
        completionRate: Math.round(completionRate * 10000) / 10000,
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

    const journey = registry.get(id);
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
      .where(isNotNull(emailSends.templateKey))
      .groupBy(emailSends.templateKey);

    const templates = rows.map((row) => {
      const sent = Number(row.sent);
      const delivered = Number(row.delivered);
      const opened = Number(row.opened);
      const clicked = Number(row.clicked);
      return {
        templateKey: row.templateKey ?? "",
        sent,
        delivered,
        opened,
        clicked,
        bounced: Number(row.bounced),
        deliveryRate:
          sent > 0 ? Math.round((delivered / sent) * 10000) / 10000 : 0,
        openRate:
          delivered > 0 ? Math.round((opened / delivered) * 10000) / 10000 : 0,
        clickRate:
          opened > 0 ? Math.round((clicked / opened) * 10000) / 10000 : 0,
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
        deliveryRate:
          total > 0 ? Math.round((delivered / total) * 10000) / 10000 : 0,
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
  });
