import { contacts, deals } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";

/**
 * Admin deals API (docs/revenue-attribution-plan.md §4b.1) — the ledger view
 * over the `deals` projection: filterable list for the Studio pipeline board
 * + the revenue stats block (per-currency, never cross-summed). Stages are
 * the deployment's configured ladder (`client.crmLadder`), not a fixed enum.
 */

const dealSchema = z.object({
  id: z.string(),
  provider: z.string(),
  externalId: z.string(),
  contactId: z.string(),
  contactEmail: z.string().nullable(),
  pipelineId: z.string().nullable(),
  stageId: z.string().nullable(),
  canonicalStage: z.string(),
  value: z.number().nullable(),
  currency: z.string().nullable(),
  quotedAt: z.string().nullable(),
  soldAt: z.string().nullable(),
  lostAt: z.string().nullable(),
  lastStageAt: z.string().nullable(),
  createdAt: z.string(),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin"],
  summary: "List deals (the revenue ledger)",
  request: {
    query: z.object({
      // Plain string: valid stages are the deployment's configured ladder.
      stage: z.string().optional(),
      provider: z.string().optional(),
      minValue: z.coerce.number().optional(),
      maxValue: z.coerce.number().optional(),
      since: z.string().datetime().optional(),
      limit: z.coerce.number().min(1).max(200).default(50),
      offset: z.coerce.number().min(0).default(0),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            deals: z.array(dealSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: "Paginated deals, newest stage activity first",
    },
  },
});

const statsSchema = z.object({
  /** The configured ladder in rank order, `lost` last — render columns in
   * THIS order. */
  stageOrder: z.array(z.string()),
  /** Counts per canonical stage (current projection state). */
  stages: z.record(z.string(), z.number()),
  /** Per-currency money blocks — never summed across currencies. */
  currencies: z.array(
    z.object({
      currency: z.string().nullable(),
      soldRevenue30d: z.number(),
      soldRevenueLifetime: z.number(),
      soldCount30d: z.number(),
      soldCountLifetime: z.number(),
      openPipelineValue: z.number(),
      openPipelineCount: z.number(),
      averageOrderValue: z.number().nullable(),
    }),
  ),
  /** Mean sold-deal cycle time in hours (created → soldAt), lifetime. */
  avgTimeToCloseHours: z.number().nullable(),
});

const statsRoute = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Admin"],
  summary: "Revenue stats over the deals ledger",
  responses: {
    200: {
      content: { "application/json": { schema: statsSchema } },
      description: "Front-and-center revenue numbers",
    },
  },
});

function dealFilters(query: {
  stage?: string;
  provider?: string;
  minValue?: number;
  maxValue?: number;
  since?: string;
}) {
  return [
    ...(query.stage ? [eq(deals.canonicalStage, query.stage)] : []),
    ...(query.provider ? [eq(deals.provider, query.provider)] : []),
    ...(query.minValue !== undefined ? [gte(deals.value, query.minValue)] : []),
    ...(query.maxValue !== undefined ? [lte(deals.value, query.maxValue)] : []),
    ...(query.since ? [gte(deals.lastStageAt, new Date(query.since))] : []),
  ];
}

export const adminDealsRouter = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db } = c.get("container");
    const query = c.req.valid("query");
    const filters = dealFilters(query);
    const where = filters.length > 0 ? and(...filters) : undefined;

    const [rows, totalRows] = await Promise.all([
      db
        .select({
          deal: deals,
          contactEmail: contacts.email,
        })
        .from(deals)
        .leftJoin(contacts, eq(deals.contactId, contacts.id))
        .where(where)
        .orderBy(desc(deals.lastStageAt), desc(deals.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ total: count() }).from(deals).where(where),
    ]);

    return c.json(
      {
        deals: rows.map(({ deal, contactEmail }) => ({
          id: deal.id,
          provider: deal.provider,
          externalId: deal.externalId,
          contactId: deal.contactId,
          contactEmail,
          pipelineId: deal.pipelineId,
          stageId: deal.stageId,
          canonicalStage: deal.canonicalStage,
          value: deal.value,
          currency: deal.currency,
          quotedAt: deal.quotedAt?.toISOString() ?? null,
          soldAt: deal.soldAt?.toISOString() ?? null,
          lostAt: deal.lostAt?.toISOString() ?? null,
          lastStageAt: deal.lastStageAt?.toISOString() ?? null,
          createdAt: deal.createdAt.toISOString(),
        })),
        total: totalRows[0]?.total ?? 0,
        limit: query.limit,
        offset: query.offset,
      },
      200,
    );
  })
  .openapi(statsRoute, async (c) => {
    const { db, crmLadder } = c.get("container");
    // ISO string + explicit cast: a raw Date param inside a sql`` fragment
    // serializes as a JS date string postgres cannot parse.
    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const [stageRows, currencyRows, cycleRows] = await Promise.all([
      db
        .select({ stage: deals.canonicalStage, n: count() })
        .from(deals)
        .groupBy(deals.canonicalStage),
      db
        .select({
          currency: deals.currency,
          soldRevenue30d: sql<number>`coalesce(sum(${deals.value}) filter (where ${deals.soldAt} >= ${thirtyDaysAgo}::timestamptz), 0)::float8`,
          soldRevenueLifetime: sql<number>`coalesce(sum(${deals.value}) filter (where ${deals.soldAt} is not null), 0)::float8`,
          soldCount30d: sql<number>`count(*) filter (where ${deals.soldAt} >= ${thirtyDaysAgo}::timestamptz)::int`,
          soldCountLifetime: sql<number>`count(*) filter (where ${deals.soldAt} is not null)::int`,
          openPipelineValue: sql<number>`coalesce(sum(${deals.value}) filter (where ${deals.soldAt} is null and ${deals.canonicalStage} != 'lost'), 0)::float8`,
          openPipelineCount: sql<number>`count(*) filter (where ${deals.soldAt} is null and ${deals.canonicalStage} != 'lost')::int`,
        })
        .from(deals)
        .groupBy(deals.currency),
      db
        .select({
          avgHours: sql<
            number | null
          >`avg(extract(epoch from (${deals.soldAt} - ${deals.createdAt})) / 3600)::float8`,
        })
        .from(deals)
        .where(sql`${deals.soldAt} is not null`),
    ]);

    const stageOrder = [...crmLadder.stages, "lost"];
    const stages: Record<string, number> = {};
    for (const stage of stageOrder) {
      stages[stage] = 0;
    }
    for (const row of stageRows) stages[row.stage] = Number(row.n);

    return c.json(
      {
        stageOrder,
        stages,
        currencies: currencyRows
          .map((row) => ({
            currency: row.currency,
            soldRevenue30d: row.soldRevenue30d,
            soldRevenueLifetime: row.soldRevenueLifetime,
            soldCount30d: row.soldCount30d,
            soldCountLifetime: row.soldCountLifetime,
            openPipelineValue: row.openPipelineValue,
            openPipelineCount: row.openPipelineCount,
            averageOrderValue:
              row.soldCountLifetime > 0
                ? row.soldRevenueLifetime / row.soldCountLifetime
                : null,
          }))
          .sort((a, b) => b.soldRevenueLifetime - a.soldRevenueLifetime),
        avgTimeToCloseHours: cycleRows[0]?.avgHours ?? null,
      },
      200,
    );
  });
