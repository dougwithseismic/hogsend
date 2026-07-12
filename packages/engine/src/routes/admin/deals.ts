import { contacts, deals } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
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
      /** Contact email substring match. */
      search: z.string().optional(),
      minValue: z.coerce.number().optional(),
      maxValue: z.coerce.number().optional(),
      since: z.string().datetime().optional(),
      sort: z
        .enum([
          "lastStageAt",
          "value",
          "stage",
          "provider",
          "contactEmail",
          "quotedAt",
          "soldAt",
          "createdAt",
        ])
        .default("lastStageAt"),
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
  /**
   * TRUE funnel counts: deals that reached each ladder stage OR went
   * further (monotonic rank ≥ stage rank; lost deals count at the rank they
   * got to). Always non-increasing down the ladder.
   */
  reached: z.record(z.string(), z.number()),
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

const seriesPoint = z.object({ date: z.string(), value: z.number() });

const timeseriesSchema = z.object({
  days: z.number(),
  /** Daily sold revenue per currency; sparse (days with sales only). */
  revenue: z.array(
    z.object({
      currency: z.string().nullable(),
      points: z.array(seriesPoint),
    }),
  ),
  /** Currency-agnostic daily activity counts; sparse. */
  counts: z.object({
    sold: z.array(seriesPoint),
    quoted: z.array(seriesPoint),
    created: z.array(seriesPoint),
  }),
});

const timeseriesRoute = createRoute({
  method: "get",
  path: "/timeseries",
  tags: ["Admin"],
  summary: "Daily deal metrics (the dashboard chart series)",
  request: {
    query: z.object({
      days: z.coerce.number().min(7).max(180).default(60),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: timeseriesSchema } },
      description:
        "Sparse daily points: sold revenue per currency + sold/quoted/created counts",
    },
  },
});

function dealFilters(query: {
  stage?: string;
  provider?: string;
  search?: string;
  minValue?: number;
  maxValue?: number;
  since?: string;
}) {
  return [
    ...(query.stage ? [eq(deals.canonicalStage, query.stage)] : []),
    ...(query.provider ? [eq(deals.provider, query.provider)] : []),
    // EXISTS keeps the count query join-free. LIKE metachars in the input
    // are escaped so "first_last" doesn't wildcard-match "firstXlast".
    ...(query.search
      ? [
          sql`exists (select 1 from contacts c where c.id = ${deals.contactId} and c.email ilike ${`%${query.search.replace(/[\\%_]/g, "\\$&")}%`} escape '\\')`,
        ]
      : []),
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

    // Whitelisted sort columns (stage sorts by rank, not alphabetically).
    const sortColumns = {
      lastStageAt: deals.lastStageAt,
      value: deals.value,
      stage: deals.stageRank,
      provider: deals.provider,
      contactEmail: contacts.email,
      quotedAt: deals.quotedAt,
      soldAt: deals.soldAt,
      createdAt: deals.createdAt,
    } as const;
    const sortCol = sortColumns[query.sort];
    const primary = query.dir === "asc" ? asc(sortCol) : desc(sortCol);

    const [rows, totalRows] = await Promise.all([
      db
        .select({
          deal: deals,
          contactEmail: contacts.email,
        })
        .from(deals)
        .leftJoin(contacts, eq(deals.contactId, contacts.id))
        .where(where)
        .orderBy(primary, desc(deals.createdAt))
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
  .openapi(timeseriesRoute, async (c) => {
    const { db } = c.get("container");
    const { days } = c.req.valid("query");
    // Window starts at the FIRST bucket's UTC midnight (today − days-1) so
    // every fetched point has a client-side day key — no orphaned edge day.
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    const since = start.toISOString();

    // Day buckets in UTC everywhere ('YYYY-MM-DD' via AT TIME ZONE 'UTC') so
    // the client's UTC zero-fill always finds the keys, whatever the DB
    // session timezone is.
    const dayOf = (col: AnyPgColumn) =>
      sql<string>`to_char(date_trunc('day', ${col} at time zone 'UTC'), 'YYYY-MM-DD')`;
    const bucketCounts = (col: AnyPgColumn) =>
      db
        .select({ day: dayOf(col), n: count() })
        .from(deals)
        .where(sql`${col} is not null and ${col} >= ${since}::timestamptz`)
        .groupBy(dayOf(col))
        .orderBy(dayOf(col));

    const [revenueRows, soldRows, quotedRows, createdRows] = await Promise.all([
      db
        .select({
          currency: deals.currency,
          day: dayOf(deals.soldAt),
          value: sql<number>`coalesce(sum(${deals.value}), 0)::float8`,
        })
        .from(deals)
        .where(
          sql`${deals.soldAt} is not null and ${deals.soldAt} >= ${since}::timestamptz`,
        )
        .groupBy(deals.currency, dayOf(deals.soldAt))
        .orderBy(dayOf(deals.soldAt)),
      bucketCounts(deals.soldAt),
      bucketCounts(deals.quotedAt),
      bucketCounts(deals.createdAt),
    ]);

    const byCurrency = new Map<
      string | null,
      Array<{ date: string; value: number }>
    >();
    for (const row of revenueRows) {
      const list = byCurrency.get(row.currency) ?? [];
      list.push({ date: row.day, value: row.value });
      byCurrency.set(row.currency, list);
    }
    const toPoints = (rows: Array<{ day: string; n: number }>) =>
      rows.map((row) => ({ date: row.day, value: Number(row.n) }));

    return c.json(
      {
        days,
        revenue: [...byCurrency.entries()].map(([currency, points]) => ({
          currency,
          points,
        })),
        counts: {
          sold: toPoints(soldRows),
          quoted: toPoints(quotedRows),
          created: toPoints(createdRows),
        },
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

    const [stageRows, rankRows, currencyRows, cycleRows] = await Promise.all([
      db
        .select({ stage: deals.canonicalStage, n: count() })
        .from(deals)
        .groupBy(deals.canonicalStage),
      db
        .select({ rank: deals.stageRank, n: count() })
        .from(deals)
        .groupBy(deals.stageRank),
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

    // reached[stage_i] = deals whose monotonic rank got to i or beyond.
    const reached: Record<string, number> = {};
    crmLadder.stages.forEach((stage, i) => {
      reached[stage] = rankRows.reduce(
        (sum, row) => (row.rank >= i ? sum + Number(row.n) : sum),
        0,
      );
    });

    return c.json(
      {
        stageOrder,
        stages,
        reached,
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
