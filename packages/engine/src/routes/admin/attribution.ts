import { attributionCredits, campaigns, conversions } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, eq, gte, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";

/**
 * Admin attribution API (docs/revenue-attribution-plan.md §6.2, extended by
 * docs/attribution-impact-plan.md §1.5) — reads over the credit ledger.
 * Every model was persisted at conversion time, so model comparison is a
 * GROUP BY, not a re-computation — and since the ledger carries
 * journey/campaign/template scope, "revenue by journey" is too.
 */

const GROUP_DIMENSIONS = [
  "channel",
  "journey",
  "campaign",
  "template",
] as const;
type GroupDimension = (typeof GROUP_DIMENSIONS)[number];

const rowSchema = z.object({
  model: z.string(),
  /**
   * The grouped dimension's value — channel name, journey id, campaign id,
   * or template key. Null = credits carrying no scope on that dimension
   * (e.g. a transactional-send click under groupBy=journey).
   */
  key: z.string().nullable(),
  /** Human label where the key is opaque (campaign name); else null. */
  label: z.string().nullable(),
  /** Back-compat mirror of `key`, present only when groupBy=channel. */
  channel: z.string().optional(),
  currency: z.string().nullable(),
  /** Sum of credited value (weight × conversion value), this currency. */
  value: z.number(),
  /** Sum of weights — "how many conversions" this key earned. */
  conversions: z.number(),
  /** Number of credited touchpoints. */
  touches: z.number(),
});

/**
 * Coverage — the ledger only divides conversions that HAD a touchpoint path,
 * so credited value is a subset of fired conversion value. Reporting both
 * keeps the delta (direct / imported / pre-tracking conversions) explicit
 * instead of silently missing. Scoped by `definitionId` only — the
 * journeyId/campaignId row filters do NOT narrow totals (a conversion is not
 * "inside" a journey; its touches are).
 */
const totalsSchema = z.object({
  currency: z.string().nullable(),
  /** Total fired conversion value in the window (this currency). */
  value: z.number(),
  conversions: z.number(),
  /** Subset with at least one credit row — i.e. a touchpoint path. */
  attributedValue: z.number(),
  attributedConversions: z.number(),
});

const summaryRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin"],
  summary: "Attribution credit rollup (model × dimension × currency)",
  request: {
    query: z.object({
      days: z.coerce.number().min(1).max(365).default(90),
      /** Scope to one conversion point. */
      definitionId: z.string().optional(),
      /** The dimension credits are grouped by (impact plan §1.5). */
      groupBy: z.enum(GROUP_DIMENSIONS).default("channel"),
      /** Only credits whose touchpoint belongs to this journey. */
      journeyId: z.string().optional(),
      /** Only credits whose touchpoint belongs to this campaign. */
      campaignId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            days: z.number(),
            groupBy: z.enum(GROUP_DIMENSIONS),
            rows: z.array(rowSchema),
            totals: z.array(totalsSchema),
          }),
        },
      },
      description:
        "Flat rollup rows — clients pivot into per-model breakdowns and model-comparison matrices",
    },
  },
});

export const adminAttributionRouter = new OpenAPIHono<AppEnv>().openapi(
  summaryRoute,
  async (c) => {
    const { db } = c.get("container");
    const { days, definitionId, groupBy, journeyId, campaignId } =
      c.req.valid("query");
    const since = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    ).toISOString();
    const sinceTs = sql`${since}::timestamptz`;
    const definitionFilter = definitionId
      ? [eq(conversions.definitionId, definitionId)]
      : [];
    const scopeFilters = [
      ...(journeyId ? [eq(attributionCredits.journeyId, journeyId)] : []),
      ...(campaignId ? [eq(attributionCredits.campaignId, campaignId)] : []),
    ];

    const groupColumns = {
      channel: attributionCredits.channel,
      journey: attributionCredits.journeyId,
      campaign: attributionCredits.campaignId,
      template: attributionCredits.templateKey,
    } satisfies Record<GroupDimension, unknown>;
    const groupCol = groupColumns[groupBy];

    const rows = await db
      .select({
        model: attributionCredits.model,
        key: sql<string | null>`${groupCol}::text`,
        currency: attributionCredits.currency,
        value: sql<number>`coalesce(sum(${attributionCredits.value}), 0)::float8`,
        conversions: sql<number>`coalesce(sum(${attributionCredits.weight}), 0)::float8`,
        touches: count(),
      })
      .from(attributionCredits)
      .innerJoin(
        conversions,
        eq(attributionCredits.conversionId, conversions.id),
      )
      .where(
        and(
          gte(attributionCredits.convertedAt, sinceTs),
          ...definitionFilter,
          ...scopeFilters,
        ),
      )
      .groupBy(
        attributionCredits.model,
        sql`${groupCol}`,
        attributionCredits.currency,
      );

    // Campaign keys are opaque uuids — resolve names server-side so every
    // client renders the same labels. Other dimensions are already readable.
    const labels = new Map<string, string>();
    if (groupBy === "campaign") {
      const ids = [
        ...new Set(rows.map((r) => r.key).filter((k): k is string => !!k)),
      ];
      if (ids.length > 0) {
        const named = await db
          .select({ id: campaigns.id, name: campaigns.name })
          .from(campaigns)
          .where(
            sql`${campaigns.id} in (${sql.join(
              ids.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`,
          );
        for (const row of named) labels.set(row.id, row.name);
      }
    }

    const credited = sql`exists (select 1 from ${attributionCredits} where ${attributionCredits.conversionId} = ${conversions.id})`;
    const totals = await db
      .select({
        currency: conversions.currency,
        value: sql<number>`coalesce(sum(${conversions.value}), 0)::float8`,
        conversions: count(),
        attributedValue: sql<number>`coalesce(sum(${conversions.value}) filter (where ${credited}), 0)::float8`,
        attributedConversions: sql<number>`(count(*) filter (where ${credited}))::int`,
      })
      .from(conversions)
      .where(and(gte(conversions.occurredAt, sinceTs), ...definitionFilter))
      .groupBy(conversions.currency);

    return c.json(
      {
        days,
        groupBy,
        rows: rows.map((row) => ({
          model: row.model,
          key: row.key,
          label: (row.key ? labels.get(row.key) : undefined) ?? null,
          ...(groupBy === "channel" && row.key ? { channel: row.key } : {}),
          currency: row.currency,
          value: row.value,
          conversions: row.conversions,
          touches: Number(row.touches),
        })),
        totals: totals.map((row) => ({
          currency: row.currency,
          value: row.value,
          conversions: Number(row.conversions),
          attributedValue: row.attributedValue,
          attributedConversions: Number(row.attributedConversions),
        })),
      },
      200,
    );
  },
);
