import { TOUCHPOINT_EVENTS } from "@hogsend/core";
import { funnelProgress } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AppEnv } from "../../app.js";

/**
 * Event-funnel progression + velocity report (impact plan §3.4) — reads the
 * `funnel_progress` projection (event-ladder funnels, §3.3). CRM funnels are
 * covered by the deals dashboard; this is the B2C sibling.
 *
 * Every number here is CORRELATIONAL (design decision 4): exposure is "the
 * contact had ≥1 touchpoint from the scope before reaching the next stage",
 * which self-selects engaged contacts. The response says so; only Phase-4
 * holdout output may use causal language.
 */

const cohortSchema = z.object({
  /** Contacts who reached the `from` stage inside the window. */
  entered: z.number(),
  /** Subset who went on to reach the `to` stage. */
  converted: z.number(),
  /** converted / entered (0 when nobody entered). */
  rate: z.number(),
  /** Median days from `from` to `to` among converters; null when none. */
  medianDays: z.number().nullable(),
});

const transitionSchema = z.object({
  from: z.string(),
  to: z.string(),
  all: cohortSchema,
  /** Present only when a scope filter was given. */
  exposed: cohortSchema.optional(),
  unexposed: cohortSchema.optional(),
});

const progressionRoute = createRoute({
  method: "get",
  path: "/{funnelId}/progression",
  tags: ["Admin"],
  summary: "Event-funnel progression + velocity (correlational)",
  request: {
    params: z.object({ funnelId: z.string() }),
    query: z.object({
      days: z.coerce.number().min(1).max(365).default(90),
      /** Exposure scope: touches stamped with this journey. */
      journeyId: z.string().optional(),
      /** Exposure scope: touches stamped with this campaign. */
      campaignId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            funnelId: z.string(),
            days: z.number(),
            stages: z.array(
              z.object({
                stage: z.string(),
                rank: z.number(),
                /** Contacts who first-reached this stage in the window. */
                reached: z.number(),
              }),
            ),
            transitions: z.array(transitionSchema),
            /**
             * Always true — exposed-vs-unexposed splits are association,
             * not causation (self-selection: engaged contacts both click
             * and convert more). Holdouts are the causal instrument.
             */
            correlational: z.literal(true),
          }),
        },
      },
      description:
        "Per-stage reach and per-transition conversion + velocity, optionally split by scope exposure",
    },
    404: {
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
      description: "Unknown funnel",
    },
  },
});

export const adminFunnelsRouter = new OpenAPIHono<AppEnv>().openapi(
  progressionRoute,
  async (c) => {
    const { db, funnels } = c.get("container");
    const { funnelId } = c.req.valid("param");
    const { days, journeyId, campaignId } = c.req.valid("query");
    const funnel = funnels.get(funnelId);
    if (!funnel) {
      return c.json({ error: `Unknown funnel "${funnelId}"` }, 404);
    }

    const since = new Date(
      Date.now() - days * 24 * 60 * 60 * 1000,
    ).toISOString();
    const sinceTs = sql`${since}::timestamptz`;

    const stageRows = await db
      .select({
        stage: funnelProgress.stage,
        rank: funnelProgress.stageRank,
        reached: count(),
      })
      .from(funnelProgress)
      .where(
        and(
          eq(funnelProgress.funnelId, funnelId),
          gte(funnelProgress.reachedAt, sinceTs),
        ),
      )
      .groupBy(funnelProgress.stage, funnelProgress.stageRank);
    const reachedByStage = new Map(
      stageRows.map((row) => [row.stage, Number(row.reached)]),
    );
    const stages = funnel.ladder.stages.map((stage, rank) => ({
      stage,
      rank,
      reached: reachedByStage.get(stage) ?? 0,
    }));

    // Per adjacent transition: LEFT JOIN the contact's next-stage row, then
    // aggregate counts + median velocity, split by scope exposure when a
    // scope was given. Stage ladders are short, so one query per transition
    // stays cheap and each stays a plain indexed join.
    const next = alias(funnelProgress, "next_stage");
    const scopeKey = journeyId ? "journeyId" : campaignId ? "campaignId" : null;
    const scopeValue = journeyId ?? campaignId ?? null;
    const touchEventList = sql.join(
      TOUCHPOINT_EVENTS.map((event) => sql`${event}`),
      sql`, `,
    );
    // Exposure: ≥1 stamped touchpoint BEFORE the outcome instant (the next
    // stage's reach, or now for non-converters) — association framing.
    const exposed = scopeKey
      ? sql`exists (
          select 1 from user_events ue
          where ue.user_id = ${funnelProgress.userKey}
            and ue.event in (${touchEventList})
            and ue.properties->>${sql.raw(`'${scopeKey}'`)} = ${scopeValue}
            and ue.occurred_at <= coalesce(${next.reachedAt}, now())
        )`
      : null;

    const medianDaysExpr = (filter?: ReturnType<typeof sql>) =>
      sql<
        number | null
      >`(percentile_cont(0.5) within group (order by extract(epoch from (${next.reachedAt} - ${funnelProgress.reachedAt})) / 86400) filter (where ${next.id} is not null${filter ? sql` and ${filter}` : sql``}))::float8`;

    const transitions = [];
    for (let i = 0; i < funnel.ladder.stages.length - 1; i++) {
      const from = funnel.ladder.stages[i] as string;
      const to = funnel.ladder.stages[i + 1] as string;
      const [row] = await db
        .select({
          entered: count(),
          converted: sql<number>`count(${next.id})::int`,
          medianDays: medianDaysExpr(),
          ...(exposed
            ? {
                exposedEntered: sql<number>`(count(*) filter (where ${exposed}))::int`,
                exposedConverted: sql<number>`(count(${next.id}) filter (where ${exposed}))::int`,
                exposedMedianDays: medianDaysExpr(exposed),
                unexposedMedianDays: medianDaysExpr(sql`not ${exposed}`),
              }
            : {}),
        })
        .from(funnelProgress)
        .leftJoin(
          next,
          and(
            eq(next.contactId, funnelProgress.contactId),
            eq(next.funnelId, funnelProgress.funnelId),
            eq(next.stage, to),
            gte(next.reachedAt, funnelProgress.reachedAt),
          ),
        )
        .where(
          and(
            eq(funnelProgress.funnelId, funnelId),
            eq(funnelProgress.stage, from),
            gte(funnelProgress.reachedAt, sinceTs),
          ),
        );

      const entered = Number(row?.entered ?? 0);
      const converted = row?.converted ?? 0;
      const cohort = (n: number, k: number, median: number | null) => ({
        entered: n,
        converted: k,
        rate: n > 0 ? k / n : 0,
        medianDays: median,
      });
      transitions.push({
        from,
        to,
        all: cohort(entered, converted, row?.medianDays ?? null),
        ...(exposed && row
          ? {
              exposed: cohort(
                row.exposedEntered ?? 0,
                row.exposedConverted ?? 0,
                row.exposedMedianDays ?? null,
              ),
              unexposed: cohort(
                entered - (row.exposedEntered ?? 0),
                converted - (row.exposedConverted ?? 0),
                row.unexposedMedianDays ?? null,
              ),
            }
          : {}),
      });
    }

    return c.json(
      { funnelId, days, stages, transitions, correlational: true as const },
      200,
    );
  },
);
