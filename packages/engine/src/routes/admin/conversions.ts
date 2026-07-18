import { contacts, conversionDispatches, conversions } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";

/**
 * Admin conversions API (docs/revenue-attribution-plan.md §5b.2) — fired
 * conversion points and their per-destination delivery state. Answers the
 * operator question "did the ad platform actually receive the sale?".
 */

const dispatchSchema = z.object({
  destinationId: z.string(),
  status: z.string(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  deliveredAt: z.string().nullable(),
});

const conversionSchema = z.object({
  id: z.string(),
  definitionId: z.string(),
  contactId: z.string(),
  contactEmail: z.string().nullable(),
  value: z.number().nullable(),
  currency: z.string().nullable(),
  /** The definition's declared scope (ConversionMeta.scope), if any. */
  scopeJourneyId: z.string().nullable(),
  scopeCampaignId: z.string().nullable(),
  occurredAt: z.string(),
  dispatches: z.array(dispatchSchema),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin"],
  summary: "List fired conversions with delivery state",
  request: {
    query: z.object({
      definitionId: z.string().optional(),
      /** Filter by the definition's declared scope (ConversionMeta.scope). */
      journeyId: z.string().optional(),
      campaignId: z.string().optional(),
      /** Only conversions with at least one dispatch in this status. */
      dispatchStatus: z.enum(["pending", "delivered", "failed"]).optional(),
      sort: z
        .enum(["occurredAt", "value", "definitionId"])
        .default("occurredAt"),
      dir: z.enum(["asc", "desc"]).default("desc"),
      limit: z.coerce.number().min(1).max(200).default(50),
      offset: z.coerce.number().min(0).default(0),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            conversions: z.array(conversionSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated fired conversions, newest first",
    },
  },
});

const statsSchema = z.object({
  /** Per-definition firing counts (30d window + lifetime). */
  definitions: z.array(
    z.object({
      definitionId: z.string(),
      count30d: z.number(),
      countLifetime: z.number(),
      lastFiredAt: z.string().nullable(),
    }),
  ),
  /** Per-destination delivery health across all dispatches. */
  destinations: z.array(
    z.object({
      destinationId: z.string(),
      pending: z.number(),
      delivered: z.number(),
      failed: z.number(),
    }),
  ),
});

const statsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Admin"],
  summary: "Conversion firing counts + destination delivery health",
  responses: {
    200: {
      content: { "application/json": { schema: statsSchema } },
      description: "Definition and destination summaries",
    },
  },
});

const timingSchema = z.object({
  definitionId: z.string(),
  /** What each subject is anchored on: a journey enrollment or an event. */
  anchor: z.object({
    type: z.enum(["journey", "event"]),
    id: z.string(),
  }),
  days: z.number(),
  /** Subjects anchored in the window (denominator). */
  anchored: z.number(),
  /** Subjects that fired the conversion at/after their anchor (numerator). */
  converted: z.number(),
  /** converted / anchored (0 when nobody was anchored). */
  rate: z.number(),
  /** How many converted within N days of the anchor (cumulative buckets). */
  convertedWithin: z.object({
    d1: z.number(),
    d7: z.number(),
    d14: z.number(),
    d30: z.number(),
  }),
  /** Median days from anchor to first conversion among converters. */
  medianDays: z.number().nullable(),
  /** 90th-percentile days from anchor to first conversion among converters. */
  p90Days: z.number().nullable(),
  /**
   * Always true — anchoring on an enrollment/event self-selects engaged
   * contacts, so "how long after" is association, not causation. Holdouts
   * are the causal instrument (mirrors the funnels report).
   */
  correlational: z.literal(true),
});

const timingRoute = createRoute({
  method: "get",
  path: "/timing",
  tags: ["Admin"],
  summary: "Time-to-conversion distribution after an anchor (correlational)",
  request: {
    query: z.object({
      /** The conversion definition to measure the latency of. */
      definitionId: z.string(),
      /** Anchor each subject on a journey enrollment or an event. */
      anchorType: z.enum(["journey", "event"]),
      /** The journey id (anchorType=journey) or event name (anchorType=event). */
      anchorId: z.string(),
      days: z.coerce.number().min(1).max(365).default(90),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: timingSchema } },
      description:
        "Conversion rate + latency percentiles + within-N-day buckets, anchored on an enrollment or event",
    },
  },
});

export const adminConversionsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const query = c.req.valid("query");

    const filters = [
      ...(query.definitionId
        ? [eq(conversions.definitionId, query.definitionId)]
        : []),
      ...(query.journeyId
        ? [eq(conversions.scopeJourneyId, query.journeyId)]
        : []),
      ...(query.campaignId
        ? [eq(conversions.scopeCampaignId, query.campaignId)]
        : []),
      ...(query.dispatchStatus
        ? [
            sql`exists (select 1 from conversion_dispatches d where d.conversion_id = ${conversions.id} and d.status = ${query.dispatchStatus})`,
          ]
        : []),
    ];
    const where = filters.length > 0 ? and(...filters) : undefined;

    const sortColumns = {
      occurredAt: conversions.occurredAt,
      value: conversions.value,
      definitionId: conversions.definitionId,
    } as const;
    const sortCol = sortColumns[query.sort];

    const [rows, totalRows] = await Promise.all([
      db
        .select({ conversion: conversions, contactEmail: contacts.email })
        .from(conversions)
        .leftJoin(contacts, eq(conversions.contactId, contacts.id))
        .where(where)
        .orderBy(
          query.dir === "asc" ? asc(sortCol) : desc(sortCol),
          desc(conversions.occurredAt),
        )
        .limit(query.limit)
        .offset(query.offset),
      db.select({ total: count() }).from(conversions).where(where),
    ]);

    // One IN query for the page's dispatches beats a per-row join explosion.
    const ids = rows.map((r) => r.conversion.id);
    const dispatchRows =
      ids.length > 0
        ? await db
            .select()
            .from(conversionDispatches)
            .where(
              sql`${conversionDispatches.conversionId} in (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            )
        : [];
    const dispatchesByConversion = new Map<
      string,
      (typeof dispatchRows)[number][]
    >();
    for (const d of dispatchRows) {
      const list = dispatchesByConversion.get(d.conversionId) ?? [];
      list.push(d);
      dispatchesByConversion.set(d.conversionId, list);
    }

    return c.json(
      {
        conversions: rows.map(({ conversion, contactEmail }) => ({
          id: conversion.id,
          definitionId: conversion.definitionId,
          contactId: conversion.contactId,
          contactEmail,
          value: conversion.value,
          currency: conversion.currency,
          scopeJourneyId: conversion.scopeJourneyId,
          scopeCampaignId: conversion.scopeCampaignId,
          occurredAt: conversion.occurredAt.toISOString(),
          dispatches: (dispatchesByConversion.get(conversion.id) ?? []).map(
            (d) => ({
              destinationId: d.destinationId,
              status: d.status,
              attempts: d.attempts,
              lastError: d.lastError,
              deliveredAt: d.deliveredAt?.toISOString() ?? null,
            }),
          ),
        })),
        total: totalRows[0]?.total ?? 0,
        limit: query.limit,
        offset: query.offset,
      },
      200,
    );
  })
  .openapi(statsRoute, async (c) => {
    const { db } = c.get("container");
    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const [definitionRows, destinationRows] = await Promise.all([
      db
        .select({
          definitionId: conversions.definitionId,
          count30d: sql<number>`count(*) filter (where ${conversions.occurredAt} >= ${thirtyDaysAgo}::timestamptz)::int`,
          countLifetime: count(),
          lastFiredAt: sql<string | null>`max(${conversions.occurredAt})`,
        })
        .from(conversions)
        .groupBy(conversions.definitionId),
      db
        .select({
          destinationId: conversionDispatches.destinationId,
          pending: sql<number>`count(*) filter (where ${conversionDispatches.status} = 'pending')::int`,
          delivered: sql<number>`count(*) filter (where ${conversionDispatches.status} = 'delivered')::int`,
          failed: sql<number>`count(*) filter (where ${conversionDispatches.status} = 'failed')::int`,
        })
        .from(conversionDispatches)
        .groupBy(conversionDispatches.destinationId),
    ]);

    return c.json(
      {
        definitions: definitionRows
          .map((row) => ({
            definitionId: row.definitionId,
            count30d: row.count30d,
            countLifetime: Number(row.countLifetime),
            lastFiredAt: row.lastFiredAt
              ? new Date(row.lastFiredAt).toISOString()
              : null,
          }))
          .sort((a, b) => b.count30d - a.count30d),
        destinations: destinationRows,
      },
      200,
    );
  })
  .openapi(timingRoute, async (c) => {
    const { db } = c.get("container");
    const { definitionId, anchorType, anchorId, days } = c.req.valid("query");
    const since = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Per subject: the anchor instant + its subject key. A journey subject is
    // one enrollment row (created_at); an event subject is a contact's FIRST
    // occurrence of the named event in the window.
    const subjects =
      anchorType === "journey"
        ? sql`
            select js.created_at as anchor_at, js.user_id as subject_key
            from journey_states js
            where js.journey_id = ${anchorId}
              and js.created_at >= ${since}::timestamptz`
        : sql`
            select min(ue.occurred_at) as anchor_at, ue.user_id as subject_key
            from user_events ue
            where ue.event = ${anchorId}
              and ue.occurred_at >= ${since}::timestamptz
            group by ue.user_id`;

    // For each subject, the first conversion of this definition at/after the
    // anchor (correlated scalar). Latency = first_conv - anchor_at.
    const latencyDays = sql`extract(epoch from (s.first_conv - s.anchor_at)) / 86400`;
    const rows = await db.execute(sql`
      select
        (count(*))::int as anchored,
        (count(s.first_conv))::int as converted,
        (count(*) filter (where s.first_conv <= s.anchor_at + interval '1 day'))::int as w1,
        (count(*) filter (where s.first_conv <= s.anchor_at + interval '7 days'))::int as w7,
        (count(*) filter (where s.first_conv <= s.anchor_at + interval '14 days'))::int as w14,
        (count(*) filter (where s.first_conv <= s.anchor_at + interval '30 days'))::int as w30,
        percentile_cont(0.5) within group (order by ${latencyDays})
          filter (where s.first_conv is not null) as median_days,
        percentile_cont(0.9) within group (order by ${latencyDays})
          filter (where s.first_conv is not null) as p90_days
      from (
        select
          subj.anchor_at,
          (
            select min(c.occurred_at)
            from conversions c
            where c.user_key = subj.subject_key
              and c.definition_id = ${definitionId}
              and c.occurred_at >= subj.anchor_at
          ) as first_conv
        from (${subjects}) subj
      ) s`);

    const [row = {}] = rows as unknown as Record<string, unknown>[];
    const num = (v: unknown) => Number(v ?? 0);
    const nullableNum = (v: unknown) => (v == null ? null : Number(v));
    const anchored = num(row.anchored);
    const converted = num(row.converted);

    return c.json(
      {
        definitionId,
        anchor: { type: anchorType, id: anchorId },
        days,
        anchored,
        converted,
        rate: anchored > 0 ? converted / anchored : 0,
        convertedWithin: {
          d1: num(row.w1),
          d7: num(row.w7),
          d14: num(row.w14),
          d30: num(row.w30),
        },
        medianDays: nullableNum(row.median_days),
        p90Days: nullableNum(row.p90_days),
        correlational: true as const,
      },
      200,
    );
  });
