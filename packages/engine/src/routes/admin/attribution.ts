import { attributionCredits, conversions } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, eq, gte, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";

/**
 * Admin attribution API (docs/revenue-attribution-plan.md §6.2) — reads over
 * the credit ledger. Every model was persisted at conversion time, so model
 * comparison is a GROUP BY, not a re-computation.
 */

const rowSchema = z.object({
  model: z.string(),
  channel: z.string(),
  currency: z.string().nullable(),
  /** Sum of credited value (weight × conversion value), this currency. */
  value: z.number(),
  /** Sum of weights — "how many conversions" this channel earned. */
  conversions: z.number(),
  /** Number of credited touchpoints. */
  touches: z.number(),
});

const summaryRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin"],
  summary: "Attribution credit rollup (model × channel × currency)",
  request: {
    query: z.object({
      days: z.coerce.number().min(1).max(365).default(90),
      /** Scope to one conversion point. */
      definitionId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            days: z.number(),
            rows: z.array(rowSchema),
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
    const { days, definitionId } = c.req.valid("query");
    const since = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    ).toISOString();

    const filters = [
      gte(attributionCredits.convertedAt, sql`${since}::timestamptz`),
      ...(definitionId ? [eq(conversions.definitionId, definitionId)] : []),
    ];

    const rows = await db
      .select({
        model: attributionCredits.model,
        channel: attributionCredits.channel,
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
      .where(and(...filters))
      .groupBy(
        attributionCredits.model,
        attributionCredits.channel,
        attributionCredits.currency,
      );

    return c.json(
      {
        days,
        rows: rows.map((row) => ({
          model: row.model,
          channel: row.channel,
          currency: row.currency,
          value: row.value,
          conversions: row.conversions,
          touches: Number(row.touches),
        })),
      },
      200,
    );
  },
);
