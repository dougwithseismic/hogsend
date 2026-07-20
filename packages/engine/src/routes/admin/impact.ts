import { ATTRIBUTION_MODELS } from "@hogsend/attribution";
import { campaigns } from "@hogsend/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { inArray, sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { computeGlobalControlReadout } from "../../lib/global-control-readout.js";
import { computeLift } from "../../lib/lift-stats.js";
import { countsSchema, liftVerdictSchema } from "./impact-schemas.js";

/**
 * GET /v1/admin/impact/overview — the program-level impact readout
 * (impact-experiments spec D4.5).
 *
 * FROZEN CONTRACT (phase 2b): these wire shapes ARE the Studio contract —
 * Studio mirror types are written mechanically from them. Additive-only
 * from here; any rename/retype needs a coordinated Studio + docs change.
 *
 * Causal-language law (routes/admin/funnels.ts:16): `causal` is nested per
 * BLOCK, never per row — `observational`/`attributed`/campaigns carry
 * `causal: false`; only holdout-backed `lift` and the computed global
 * control carry `causal: true`.
 */

export const overviewLiftSchema = z
  .object({
    causal: z.literal(true),
    control: countsSchema,
  })
  .extend(liftVerdictSchema.shape);

export const journeyRowSchema = z.object({
  journeyId: z.string(),
  /** Registry name; null for blueprint/removed-journey ids observed only
   * in journey_states or the credit ledger. */
  name: z.string().nullable(),
  registered: z.boolean(),
  versionLabel: z.string().nullable(), // latest-by-created_at in window
  goalDefinitionId: z.string().nullable(),
  /** Authored holdout percent from registry meta; null when none or
   * unregistered. Lets consumers distinguish "no holdout configured" from
   * "holdout configured, no held-out contacts in window yet". */
  holdoutPercent: z.number().nullable(),
  /** OBSERVATIONAL — enrollment funnel of the TREATED cohort only
   * (status != 'held_out'), matching the lift route's cohort split.
   * Nested so `causal` is unambiguous per block, never per row. */
  observational: z.object({
    causal: z.literal(false),
    enrollments: z.number(),
    converters: z.number(),
    rate: z.number(),
  }),
  /** OBSERVATIONAL — fractional credit from the ledger, one model. */
  attributed: z.object({
    causal: z.literal(false),
    model: z.enum(ATTRIBUTION_MODELS),
    values: z.array(
      z.object({
        currency: z.string().nullable(),
        value: z.number(), // sum(credit.value)
        conversions: z.number(), // sum(credit.weight)
      }),
    ),
  }),
  /** CAUSAL — present only where a held-out cohort exists in the window. */
  lift: overviewLiftSchema.nullable(),
});

export const campaignRowSchema = z.object({
  campaignId: z.string(),
  name: z.string(),
  status: z.string(),
  sends: z.number(),
  delivered: z.number(),
  opened: z.number(),
  clicked: z.number(),
  attributed: z.array(
    z.object({
      currency: z.string().nullable(),
      value: z.number(),
      conversions: z.number(),
    }),
  ),
});

/** Zod-4-safe: discriminated on `state` (single distinct key), NOT on a
 * duplicated `enabled: true` literal — z.discriminatedUnion("enabled",
 * [..two true branches..]) THROWS at construction on zod 4.4.3. */
export const globalControlSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("off") }),
  z.object({
    /** Assignment is ON and suppressing sends, but the readout was skipped:
     * contact population exceeds the in-request scan ceiling. Visibly
     * distinct from "off" — assignment-active-readout-absent must never
     * render as disabled. */
    state: z.literal("skipped"),
    reason: z.literal("too_many_contacts"),
    percent: z.number(),
    contactCount: z.number(),
  }),
  z
    .object({
      state: z.literal("computed"),
      causal: z.literal(true),
      percent: z.number(), // globalControlPercent() (holdout.ts:42-46)
      contactsScanned: z.number(),
      treatment: countsSchema,
      control: countsSchema,
    })
    .extend(liftVerdictSchema.shape),
]);

export const overviewResponseSchema = z.object({
  days: z.number(),
  model: z.enum(ATTRIBUTION_MODELS),
  rankedBy: z.literal("converters"),
  journeys: z.array(journeyRowSchema),
  campaigns: z.object({
    causal: z.literal(false), // correlational-only, whole section
    rows: z.array(campaignRowSchema),
  }),
  globalControl: globalControlSchema,
});

const overviewRoute = createRoute({
  method: "get",
  path: "/overview",
  tags: ["Admin — Impact"],
  summary: "Program-level impact: journeys, campaigns, global control",
  description:
    "Journeys union in-window journey_states with in-window attribution " +
    "credits (a journey with credits but no fresh enrollments still " +
    "appears). Campaigns are correlational-only — no lift, no win " +
    "probability, ever. The computed global-control block is a " +
    "cross-sectional randomized comparison: outcome window " +
    "occurred_at >= since for BOTH buckets — random assignment keeps it " +
    "causal, window symmetry keeps it fair.",
  request: {
    query: z.object({
      days: z.coerce.number().min(1).max(365).default(90),
      model: z.enum(ATTRIBUTION_MODELS).default("linear"),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: overviewResponseSchema } },
      description: "Program-level readout with per-block causal labeling",
    },
  },
});

/** Bounded concurrency for the per-journey goal-refinement queries. */
const LIFT_CONCURRENCY = 5;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

type BaseRollupRow = {
  journey_id: string;
  version_label: string | null;
  enrollments: number;
  converters: number;
  control_contacts: number;
  control_converters: number;
};

export const impactOverviewRouter = new OpenAPIHono<AppEnv>().openapi(
  overviewRoute,
  async (c) => {
    const { db, registry } = c.get("container");
    const { days, model } = c.req.valid("query");
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const sinceTs = sql`${since.toISOString()}::timestamptz`;

    // (a) Journey base rollup — one grouped query, any-definition outcome,
    // latest-by-created_at version label. No deleted_at filter (matches the
    // /lift cohort SQL precedent).
    const baseRows = await db.execute<BaseRollupRow>(sql`
      select
        js.journey_id,
        (array_agg(js.journey_version_label order by js.created_at desc)
           filter (where js.journey_version_label is not null))[1]
          as version_label,
        count(distinct js.user_id)
          filter (where js.status != 'held_out')::int as enrollments,
        (count(distinct js.user_id) filter (where js.status != 'held_out'
          and exists (
            select 1 from conversions c
            where c.user_key = js.user_id
              and c.occurred_at >= js.created_at
        )))::int as converters,
        count(distinct js.user_id)
          filter (where js.status = 'held_out')::int as control_contacts,
        (count(distinct js.user_id) filter (where js.status = 'held_out'
          and exists (
            select 1 from conversions c
            where c.user_key = js.user_id
              and c.occurred_at >= js.created_at
        )))::int as control_converters
      from journey_states js
      where js.created_at >= ${sinceTs}
      group by js.journey_id
    `);
    const baseById = new Map<string, BaseRollupRow>(
      [...baseRows].map((r) => [r.journey_id, r]),
    );

    // (c) Attributed value — one grouped ledger query, ONE model.
    const creditRows = await db.execute<{
      journey_id: string;
      currency: string | null;
      value: number;
      conversions: number;
    }>(sql`
      select journey_id, currency,
             coalesce(sum(value), 0)::float8 as value,
             sum(weight)::float8 as conversions
      from attribution_credits
      where model = ${model}
        and converted_at >= ${sinceTs}
        and journey_id is not null
      group by journey_id, currency
    `);
    const creditsByJourney = new Map<
      string,
      Array<{ currency: string | null; value: number; conversions: number }>
    >();
    for (const r of [...creditRows]) {
      const list = creditsByJourney.get(r.journey_id) ?? [];
      list.push({
        currency: r.currency,
        value: Number(r.value),
        conversions: Number(r.conversions),
      });
      creditsByJourney.set(r.journey_id, list);
    }

    // Union of journey ids from (a) AND (c) — a journey with in-window
    // credits but zero in-window state rows still appears.
    const journeyIds = [
      ...new Set([...baseById.keys(), ...creditsByJourney.keys()]),
    ];

    // (b) Goal refinement — for ids whose registry meta declares a goal,
    // re-run the aggregate WITH `js.journey_id = id` in the WHERE (per
    // journey, never a full re-scan) and the goal's definition_id in both
    // EXISTS. Goal-scoped converters REPLACE the any-definition counts for
    // that row only; enrollments/control_contacts are definition-free.
    const goalIds = journeyIds.filter((jid) => registry.get(jid)?.goal);
    const refined = new Map<
      string,
      { converters: number; control_converters: number }
    >();
    for (const group of chunk(goalIds, LIFT_CONCURRENCY)) {
      await Promise.all(
        group.map(async (jid) => {
          const goal = registry.get(jid)?.goal;
          if (!goal) return;
          const rows = await db.execute<{
            converters: number;
            control_converters: number;
          }>(sql`
            select
              (count(distinct js.user_id)
                filter (where js.status != 'held_out' and exists (
                  select 1 from conversions c
                  where c.user_key = js.user_id
                    and c.occurred_at >= js.created_at
                    and c.definition_id = ${goal}
              )))::int as converters,
              (count(distinct js.user_id)
                filter (where js.status = 'held_out' and exists (
                  select 1 from conversions c
                  where c.user_key = js.user_id
                    and c.occurred_at >= js.created_at
                    and c.definition_id = ${goal}
              )))::int as control_converters
            from journey_states js
            where js.journey_id = ${jid}
              and js.created_at >= ${sinceTs}
          `);
          const row = [...rows][0];
          if (row) {
            refined.set(jid, {
              converters: Number(row.converters),
              control_converters: Number(row.control_converters),
            });
          }
        }),
      );
    }

    const journeyRows = journeyIds.map((jid) => {
      const meta = registry.get(jid);
      const base = baseById.get(jid);
      const goalCounts = refined.get(jid);
      const enrollments = Number(base?.enrollments ?? 0);
      const converters =
        goalCounts?.converters ?? Number(base?.converters ?? 0);
      const controlContacts = Number(base?.control_contacts ?? 0);
      const controlConverters =
        goalCounts?.control_converters ?? Number(base?.control_converters ?? 0);
      return {
        journeyId: jid,
        name: meta?.name ?? null,
        registered: meta !== undefined,
        versionLabel: base?.version_label ?? null,
        goalDefinitionId: meta?.goal ?? null,
        holdoutPercent: meta?.holdout?.percent ?? null,
        observational: {
          causal: false as const,
          enrollments,
          converters,
          rate: enrollments > 0 ? converters / enrollments : 0,
        },
        attributed: {
          causal: false as const,
          model,
          values: creditsByJourney.get(jid) ?? [],
        },
        lift:
          controlContacts > 0
            ? {
                causal: true as const,
                control: {
                  contacts: controlContacts,
                  converters: controlConverters,
                  rate:
                    controlContacts > 0
                      ? controlConverters / controlContacts
                      : 0,
                },
                ...computeLift({
                  treatment: { contacts: enrollments, converters },
                  control: {
                    contacts: controlContacts,
                    converters: controlConverters,
                  },
                }),
              }
            : null,
      };
    });
    journeyRows.sort(
      (a, b) =>
        b.observational.converters - a.observational.converters ||
        b.observational.enrollments - a.observational.enrollments ||
        (a.journeyId < b.journeyId ? -1 : a.journeyId > b.journeyId ? 1 : 0),
    );

    // (d) Campaigns — correlational only, ACTIVITY-windowed enumeration:
    // ids come from the in-window email_sends campaign_id rollup ∪ in-window
    // attribution_credits.campaign_id (NOT "newest 50 created in window" —
    // that drops older-but-active multi-step/scheduled campaigns whose
    // sends fall inside the window). Cap 50 by send volume desc. The
    // indexed campaign_id column is the attribution (stamped at send time,
    // backfilled from legacy idempotency keys by migration 0051) — never
    // key parsing. Suppressed/blocked rows carry the FK but were never
    // dispatched (they write no idempotency key), so they stay out of the
    // funnel.
    const [campaignSendRows, campaignCreditRows] = await Promise.all([
      db.execute<{
        campaign_id: string;
        sends: number;
        delivered: number;
        opened: number;
        clicked: number;
      }>(sql`
        select campaign_id::text as campaign_id,
          count(*)::int as sends,
          count(delivered_at)::int as delivered,
          count(opened_at)::int as opened,
          count(clicked_at)::int as clicked
        from email_sends
        where campaign_id is not null
          and idempotency_key is not null
          and created_at >= ${sinceTs}
        group by 1
      `),
      db.execute<{
        campaign_id: string;
        currency: string | null;
        value: number;
        conversions: number;
      }>(sql`
        select campaign_id::text as campaign_id, currency,
               coalesce(sum(value), 0)::float8 as value,
               sum(weight)::float8 as conversions
        from attribution_credits
        where model = ${model}
          and converted_at >= ${sinceTs}
          and campaign_id is not null
        group by campaign_id, currency
      `),
    ]);

    const sendsByCampaign = new Map(
      [...campaignSendRows].map((r) => [
        r.campaign_id,
        {
          sends: Number(r.sends),
          delivered: Number(r.delivered),
          opened: Number(r.opened),
          clicked: Number(r.clicked),
        },
      ]),
    );
    const creditsByCampaign = new Map<
      string,
      Array<{ currency: string | null; value: number; conversions: number }>
    >();
    for (const r of [...campaignCreditRows]) {
      const list = creditsByCampaign.get(r.campaign_id) ?? [];
      list.push({
        currency: r.currency,
        value: Number(r.value),
        conversions: Number(r.conversions),
      });
      creditsByCampaign.set(r.campaign_id, list);
    }

    const campaignIds = [
      ...new Set([...sendsByCampaign.keys(), ...creditsByCampaign.keys()]),
    ]
      .sort(
        (a, b) =>
          (sendsByCampaign.get(b)?.sends ?? 0) -
          (sendsByCampaign.get(a)?.sends ?? 0),
      )
      .slice(0, 50);

    const campaignInfo =
      campaignIds.length > 0
        ? await db
            .select({
              id: campaigns.id,
              name: campaigns.name,
              status: campaigns.status,
            })
            .from(campaigns)
            .where(inArray(campaigns.id, campaignIds))
        : [];
    const infoById = new Map(campaignInfo.map((r) => [r.id, r]));

    // Ids with no campaigns row (hard-deleted) are dropped — name/status
    // are unknowable and the wire contract requires both.
    const campaignRows = campaignIds.flatMap((cid) => {
      const info = infoById.get(cid);
      if (!info) return [];
      const funnel = sendsByCampaign.get(cid) ?? {
        sends: 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
      };
      return [
        {
          campaignId: cid,
          name: info.name,
          status: info.status,
          ...funnel,
          attributed: creditsByCampaign.get(cid) ?? [],
        },
      ];
    });
    // (e) Global control — JS re-hash, batched keyset pagination; the
    // three-state result is the wire block verbatim.
    const globalControl = await computeGlobalControlReadout({ db, since });

    return c.json(
      {
        days,
        model,
        rankedBy: "converters" as const,
        journeys: journeyRows,
        campaigns: { causal: false as const, rows: campaignRows },
        globalControl,
      },
      200,
    );
  },
);
