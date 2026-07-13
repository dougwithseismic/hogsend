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
  });
