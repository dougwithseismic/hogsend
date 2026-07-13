import { attributionCredits, campaigns, conversions } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { backfillAttributionBatch } from "../../lib/attribution-backfill.js";
import { getConversionRegistry } from "../../lib/conversions.js";

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

/**
 * Influenced (impact plan §3.1) — the model-invariant COVERAGE number
 * (Dreamdata semantics): a conversion is influenced by a scope when the
 * contact had ≥1 touchpoint from it inside the window. Deliberately
 * multi-counted across scopes — it answers "which conversions did this
 * journey touch at all", never sums to total, and is presented as reach,
 * not credit.
 */
const influencedSchema = z.object({
  key: z.string(),
  /** Human label where the key is opaque (campaign name); else null. */
  label: z.string().nullable(),
  currency: z.string().nullable(),
  /** Conversions with ≥1 touch from this scope (full count, not weighted). */
  conversions: z.number(),
  /** FULL value of those conversions (not fractional credit). */
  value: z.number(),
});

/**
 * Overlap transparency (impact plan §2.3, the anti-Braze): no incumbent
 * dedupes credit across journeys/campaigns — Braze documents conversion
 * rates over 100%. Our fractional models already sum to 1 per conversion
 * (that IS the dedup); this block additionally SHOWS the overlap: how many
 * scope-claimed conversions were claimed by more than one value of the
 * grouped dimension, and what per-scope single-credit totals would add up
 * to (`scopeSummedValue` vs the real `value`).
 */
const overlapSchema = z.object({
  currency: z.string().nullable(),
  /** Conversions claimed by ≥1 non-null scope on this dimension. */
  conversions: z.number(),
  /** Subset claimed by MORE THAN ONE distinct scope. */
  multiScopeConversions: z.number(),
  /** Real conversion value across the claimed set. */
  value: z.number(),
  /** What "each scope takes full credit" reporting would sum to. */
  scopeSummedValue: z.number(),
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
            overlap: z.array(overlapSchema),
            influenced: z.array(influencedSchema),
          }),
        },
      },
      description:
        "Flat rollup rows — clients pivot into per-model breakdowns and model-comparison matrices",
    },
  },
});

/**
 * Backfill (impact plan §5.1) — batch-shaped replay of history through the
 * idempotent conversion + ledger machinery. Loop until `nextCursor` is null
 * (`hogsend attribution backfill` does exactly that). Lives here because
 * the code-first conversion registry only exists inside the API process.
 */
const backfillRoute = createRoute({
  method: "post",
  path: "/backfill",
  tags: ["Admin"],
  summary: "Backfill conversions + attribution credits from event history",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            definitionId: z.string().optional(),
            /** Only events/conversions at or after this instant. */
            since: z.string().datetime().optional(),
            /** Opaque batch cursor from the previous response. */
            cursor: z.string().optional(),
            limit: z.number().min(1).max(2000).default(500),
            /**
             * Delete-then-refill the definition's credits under CURRENT
             * window config. Requires definitionId; logged loudly.
             */
            recompute: z.boolean().default(false),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            stage: z.enum(["events", "credits"]),
            processed: z.number(),
            conversionsFired: z.number(),
            creditsWritten: z.number(),
            /** Null = backfill complete. */
            nextCursor: z.string().nullable(),
          }),
        },
      },
      description: "One processed batch; loop until nextCursor is null",
    },
    400: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "recompute without definitionId",
    },
  },
});

export const adminAttributionRouter = new OpenAPIHono<AppEnv>()
  .openapi(summaryRoute, async (c) => {
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

    // Influenced (§3.1): one row per (scope key, conversion) via DISTINCT,
    // then full conversion count + value per key. Any single model
    // enumerates the credited path; weight is ignored by construction.
    const influencedClaims = db.$with("influenced_claims").as(
      db
        .selectDistinct({
          conversionId: attributionCredits.conversionId,
          key: sql<string>`${groupCol}::text`.as("key"),
        })
        .from(attributionCredits)
        .where(
          and(
            eq(attributionCredits.model, "linear"),
            gte(attributionCredits.convertedAt, sinceTs),
            isNotNull(groupCol),
          ),
        ),
    );
    const influenced = await db
      .with(influencedClaims)
      .select({
        key: influencedClaims.key,
        currency: conversions.currency,
        conversions: count(),
        value: sql<number>`coalesce(sum(${conversions.value}), 0)::float8`,
      })
      .from(influencedClaims)
      .innerJoin(conversions, eq(conversions.id, influencedClaims.conversionId))
      .where(and(...definitionFilter))
      .groupBy(influencedClaims.key, conversions.currency);

    // Campaign keys are opaque uuids — resolve names server-side so every
    // client renders the same labels. Other dimensions are already readable.
    const labels = new Map<string, string>();
    if (groupBy === "campaign") {
      const ids = [
        ...new Set(
          [...rows.map((r) => r.key), ...influenced.map((r) => r.key)].filter(
            (k): k is string => !!k,
          ),
        ),
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

    // Overlap (§2.3): per conversion, how many distinct non-null values of
    // the grouped dimension claimed it (any single model enumerates the
    // credited path — `linear` includes every in-window touch). Unfiltered
    // by journeyId/campaignId: overlap is about the whole claiming set.
    const claims = db.$with("claims").as(
      db
        .select({
          conversionId: attributionCredits.conversionId,
          scopeCount: sql<number>`count(distinct ${groupCol})`.as(
            "scope_count",
          ),
        })
        .from(attributionCredits)
        .where(
          and(
            eq(attributionCredits.model, "linear"),
            gte(attributionCredits.convertedAt, sinceTs),
            isNotNull(groupCol),
          ),
        )
        .groupBy(attributionCredits.conversionId),
    );
    const overlap = await db
      .with(claims)
      .select({
        currency: conversions.currency,
        conversions: count(),
        multiScopeConversions: sql<number>`(count(*) filter (where ${claims.scopeCount} > 1))::int`,
        value: sql<number>`coalesce(sum(${conversions.value}), 0)::float8`,
        scopeSummedValue: sql<number>`coalesce(sum(${conversions.value} * ${claims.scopeCount}), 0)::float8`,
      })
      .from(claims)
      .innerJoin(conversions, eq(conversions.id, claims.conversionId))
      .where(and(...definitionFilter))
      .groupBy(conversions.currency);

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
        overlap: overlap.map((row) => ({
          currency: row.currency,
          conversions: Number(row.conversions),
          multiScopeConversions: row.multiScopeConversions,
          value: row.value,
          scopeSummedValue: row.scopeSummedValue,
        })),
        influenced: influenced.map((row) => ({
          key: row.key,
          label: labels.get(row.key) ?? null,
          currency: row.currency,
          conversions: Number(row.conversions),
          value: row.value,
        })),
      },
      200,
    );
  })
  .openapi(backfillRoute, async (c) => {
    const { db, logger } = c.get("container");
    const body = c.req.valid("json");
    if (body.recompute && !body.definitionId) {
      return c.json(
        { error: "recompute requires a definitionId — never blanket" },
        400,
      );
    }
    const result = await backfillAttributionBatch({
      db,
      logger,
      registry: getConversionRegistry(),
      definitionId: body.definitionId,
      since: body.since ? new Date(body.since) : undefined,
      cursor: body.cursor,
      limit: body.limit,
      recompute: body.recompute,
    });
    return c.json(result, 200);
  });
