import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { getConversionRegistry } from "../../lib/conversions.js";
import {
  computeJourneyLift,
  computeLiftValues,
} from "../../lib/journey-lift.js";
import { computeLift } from "../../lib/lift-stats.js";
import {
  cohortSchema,
  countsSchema,
  type DefinitionSource,
  definitionSourceSchema,
  liftVerdictSchema,
} from "./impact-schemas.js";

/**
 * GET /v1/admin/journeys/{id}/impact — the per-journey impact readout
 * (impact-experiments spec D4.4).
 *
 * FROZEN CONTRACT (phase 2b): these wire shapes ARE the Studio contract —
 * Studio mirror types (packages/studio admin-api.ts) are written
 * mechanically from them. Additive-only from here; any rename/retype needs
 * a coordinated Studio + docs change.
 *
 * Causal-language law (routes/admin/funnels.ts:16): `causal: true` appears
 * ONLY inside holdout-backed blocks; observational blocks carry
 * `causal: false`. No row-level ambiguous causal flag exists anywhere.
 */

export const goalSchema = z.object({
  /** Effective conversion definition scoping every outcome below.
   * query.definitionId beats meta.goal beats null (= any definition). */
  definitionId: z.string().nullable(),
  source: definitionSourceSchema,
  /** Registered definition's display name; null when unscoped/unknown. */
  name: z.string().nullable(),
});

export const overallSchema = z.object({
  /** Causal-language law (routes/admin/funnels.ts:16): true ONLY when a
   * held-out cohort exists to compare against. When false, `treatment` IS
   * the observational read (there is no separate observational block —
   * consumers render treatment with the observational label). */
  causal: z.boolean(),
  treatment: cohortSchema,
  control: cohortSchema,
  /** Null when control.contacts === 0 — with zero control contacts,
   * computeLift would integrate against the uniform Beta(1,1) prior and
   * print a confident-looking winProbability: an uninformed prior
   * masquerading as evidence. The impact surface refuses that.
   * (Deliberately stricter than /lift, which emits a verdict regardless.) */
  verdict: liftVerdictSchema.nullable(),
});

export const versionSchema = z.object({
  /** journey_version_hash; null = the pre-versioning bucket. Treat a new
   * hash as "possible new version" — toolchain bumps can fork it. */
  hash: z.string().nullable(),
  /** Latest-by-created_at label seen on this hash's rows. Hash is truth. */
  label: z.string().nullable(),
  firstEnrolledAt: z.string().nullable(), // ISO; null if only held_out rows
  lastEnrolledAt: z.string().nullable(),
  enrollments: z.number(), // distinct treated users, this hash, in window
  converters: z.number(),
  rate: z.number(),
  /** Contemporaneous holdout lift: control = held_out rows carrying the
   * SAME hash (stamped at diversion by the same deployed code). Null when
   * this version diverted nobody. causal: true by construction when
   * present. NOTE: version-INTERNAL lift is causal; comparing raw rates
   * ACROSS versions is observational — older versions had longer
   * post-entry conversion exposure. A salt/percent change between versions
   * can place one user in treatment under one hash and control under
   * another in the UNVERSIONED overall lift (pre-existing in /lift; hash
   * matching makes it visible, and per-version blocks are immune).
   * COMPOSITION CAVEAT: held_out rows are inserted once-ever per (user,
   * journey), so on re-entrant journeys a later version's treatment mixes
   * novices with returning veterans while its same-hash control holds
   * post-fork novices only — read multi-version re-entrant lift with that
   * skew in mind. */
  liftVsControl: z
    .object({ causal: z.literal(true), control: countsSchema })
    .extend(liftVerdictSchema.shape)
    .nullable(),
});

export const variantArmSchema = z.object({
  arm: z.string(),
  enrollments: z.number(),
  converters: z.number(),
  rate: z.number(),
  /** OBSERVATIONAL engagement funnel for this arm (email_sends joined via
   * journey_state_id) — the first readout an operator asks for on a
   * subject-line test. */
  engagement: z.object({
    causal: z.literal(false),
    sends: z.number(),
    opened: z.number(),
    clicked: z.number(),
  }),
  /** Arm cohort vs the WHOLE held-out cohort (Decision B). Null when the
   * journey has no held-out contacts in the window. CONDITIONING CAVEAT:
   * an arm cohort is conditioned on the enrollment SURVIVING to the
   * ctx.variant call site (branches, exits, errors during earlier waits)
   * while the held-out cohort is unconditioned — arm-vs-holdout is cleanly
   * causal only when the variant call is unconditional near journey start;
   * arm-vs-arm is the always-clean randomized comparison. */
  liftVsControl: z
    .object({ causal: z.literal(true) })
    .extend(liftVerdictSchema.shape)
    .nullable(),
});

export const variantSchema = z.object({
  key: z.string(),
  arms: z.array(variantArmSchema),
});

export const impactResponseSchema = z.object({
  journeyId: z.string(),
  days: z.number(),
  goal: goalSchema,
  /** Authored holdout config from the registry meta; null when none or
   * when the journey is unregistered. Requires the D0 schema fix — holdout
   * MUST be read from the fixed schema/registry, never assumed. */
  holdout: z.object({ percent: z.number() }).nullable(),
  /** The CURRENT deployed definition's identity (what a fresh enrollment
   * would stamp); null when unregistered. */
  currentVersionHash: z.string().nullable(),
  currentVersionLabel: z.string().nullable(),
  overall: overallSchema,
  /** Newest version first (by first activity). */
  versions: z.array(versionSchema),
  variants: z.array(variantSchema),
});

/** timestamptz → ISO string; tolerant of driver Date/string variance. */
function toIso(value: unknown): string | null {
  if (value == null) return null;
  return new Date(value as string | Date).toISOString();
}

const errorSchema = z.object({ error: z.string() });

const impactRoute = createRoute({
  method: "get",
  path: "/{id}/impact",
  tags: ["Admin — Journeys"],
  summary: "Impact readout: holdout lift, version cohorts, variant arms",
  description:
    "Only holdout-backed blocks carry causal language; cross-version and " +
    "no-control numbers are observational. Blueprint journeys are " +
    "DB-authored and can never declare meta.goal (code-first law), so " +
    'their readout is permanently source "none" unless a definitionId ' +
    "query param is passed. A DEFINED journey excluded by ENABLED_JOURNEYS " +
    'is never registered, so it also reads as source "none".',
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      days: z.coerce.number().min(1).max(365).default(90),
      /** Scope the outcome to one conversion point.
       * Default: the journey's meta.goal; else any conversion. */
      definitionId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: impactResponseSchema } },
      description: "Per-journey impact readout with per-block causal labeling",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Journey is not registered and has no journey_states rows",
    },
  },
});

export const journeyImpactRouter = new OpenAPIHono<AppEnv>().openapi(
  impactRoute,
  async (c) => {
    const { db, registry } = c.get("container");
    const { id } = c.req.valid("param");
    const { days, definitionId: queryDefinitionId } = c.req.valid("query");
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // 1. Goal resolution — explicit query param > meta.goal > any.
    // registry.get(id) is undefined for (a) blueprint/removed journeys with
    // historical states and (b) DEFINED journeys excluded by the
    // ENABLED_JOURNEYS csv — both keep the any-definition behavior and
    // report source "none".
    const meta = registry.get(id);
    const goal = meta?.goal;
    const definitionId = queryDefinitionId ?? goal;
    const source: DefinitionSource = queryDefinitionId
      ? "query"
      : goal
        ? "goal"
        : "none";
    const name = definitionId
      ? (getConversionRegistry()
          ?.getAll()
          .find((d) => d.meta.id === definitionId)?.meta.name ?? null)
      : null;

    // 2. 404 guard — unregistered AND no states ever (covers blueprint
    // enrollments and removed journeys; the route never 404s a journey
    // that has data).
    if (!meta) {
      const guardRows = await db.execute<{ count: number }>(
        sql`select count(*)::int as count
            from journey_states
            where journey_id = ${id}`,
      );
      if (([...guardRows][0]?.count ?? 0) === 0) {
        return c.json({ error: "Journey not found" }, 404);
      }
    }

    // 3. Overall — the ONE implementation of the causal math (2a helper).
    const [liftResult, values] = await Promise.all([
      computeJourneyLift({ db, journeyId: id, since, definitionId }),
      computeLiftValues({ db, journeyId: id, since, definitionId }),
    ]);
    const causal = liftResult.control.contacts > 0;
    const overall = {
      causal,
      treatment: { ...liftResult.treatment, value: values.treatment },
      control: { ...liftResult.control, value: values.control },
      verdict: causal ? liftResult.verdict : null,
    };

    // 4. Versions — ONE grouped query; control matched by SAME hash, not a
    // date-range slice: (a) exact even when two code versions run
    // concurrently (blue-green — date windows would cross-contaminate);
    // (b) survives gaps and low-traffic versions; (c) treatment and control
    // share the identical exposure period by construction. The per-row ITT
    // clock (occurred_at >= created_at) equalizes post-assignment exposure
    // within the version. Label pick is latest-by-created_at (array_agg
    // form) — max() is lexicographic and shows stale labels after a
    // label-only rename (the label is excluded from the hash).
    const definitionSql = definitionId
      ? sql` and c.definition_id = ${definitionId}`
      : sql``;
    const sinceTs = sql`${since.toISOString()}::timestamptz`;
    const versionRows = await db.execute<{
      hash: string | null;
      label: string | null;
      first_enrolled_at: string | Date | null;
      last_enrolled_at: string | Date | null;
      enrollments: number;
      converters: number;
      control_contacts: number;
      control_converters: number;
    }>(sql`
      select
        js.journey_version_hash as hash,
        (array_agg(js.journey_version_label order by js.created_at desc)
           filter (where js.journey_version_label is not null))[1] as label,
        min(js.created_at) filter (where js.status != 'held_out')
          as first_enrolled_at,
        max(js.created_at) filter (where js.status != 'held_out')
          as last_enrolled_at,
        count(distinct js.user_id)
          filter (where js.status != 'held_out')::int as enrollments,
        (count(distinct js.user_id) filter (where js.status != 'held_out'
          and exists (
            select 1 from conversions c
            where c.user_key = js.user_id
              and c.occurred_at >= js.created_at${definitionSql}
        )))::int as converters,
        count(distinct js.user_id)
          filter (where js.status = 'held_out')::int as control_contacts,
        (count(distinct js.user_id) filter (where js.status = 'held_out'
          and exists (
            select 1 from conversions c
            where c.user_key = js.user_id
              and c.occurred_at >= js.created_at${definitionSql}
        )))::int as control_converters
      from journey_states js
      where js.journey_id = ${id}
        and js.created_at >= ${sinceTs}
      group by js.journey_version_hash
      order by min(js.created_at) desc
    `);

    const versions = [...versionRows].map((r) => {
      const enrollments = Number(r.enrollments);
      const converters = Number(r.converters);
      const controlContacts = Number(r.control_contacts);
      const controlConverters = Number(r.control_converters);
      return {
        hash: r.hash,
        label: r.label,
        firstEnrolledAt: toIso(r.first_enrolled_at),
        lastEnrolledAt: toIso(r.last_enrolled_at),
        enrollments,
        converters,
        rate: enrollments > 0 ? converters / enrollments : 0,
        liftVsControl:
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

    // 5. Variants — arms enumerated FROM DATA (a removed arm still reports
    // its historical cohort; injection is closed at the seeding strip, 1d).
    // jsonb_each_text unwraps the recordOnce-stored JSON string values to
    // bare text (record-once.ts:93). held_out rows never run run() so never
    // carry variants (the status filter is belt-and-suspenders). Rows
    // enrolled before an experiment shipped have no arm — excluded by the
    // `?` operator filter, so arm cohorts may sum < treatment total.
    // Control for EVERY arm = the overall held-out cohort (Decision B).
    const [variantCountRows, engagementRows] = await Promise.all([
      db.execute<{
        variant_key: string;
        arm: string;
        enrollments: number;
        converters: number;
      }>(sql`
        select
          v.key as variant_key,
          v.arm as arm,
          count(distinct js.user_id)::int as enrollments,
          (count(distinct js.user_id) filter (where exists (
            select 1 from conversions c
            where c.user_key = js.user_id
              and c.occurred_at >= js.created_at${definitionSql}
          )))::int as converters
        from journey_states js
        cross join lateral
          jsonb_each_text(js.context -> '__variants__') as v(key, arm)
        where js.journey_id = ${id}
          and js.created_at >= ${sinceTs}
          and js.status != 'held_out'
          and js.context ? '__variants__'
        group by v.key, v.arm
        order by v.key, v.arm
      `),
      db.execute<{
        variant_key: string;
        arm: string;
        sends: number;
        opened: number;
        clicked: number;
      }>(sql`
        select v.key as variant_key, v.arm as arm,
               count(es.id)::int as sends,
               count(es.opened_at)::int as opened,
               count(es.clicked_at)::int as clicked
        from journey_states js
        cross join lateral
          jsonb_each_text(js.context -> '__variants__') as v(key, arm)
        join email_sends es on es.journey_state_id = js.id
        where js.journey_id = ${id}
          and js.created_at >= ${sinceTs}
          and js.status != 'held_out'
          and js.context ? '__variants__'
        group by v.key, v.arm
      `),
    ]);

    const engagementByArm = new Map(
      [...engagementRows].map((r) => [
        `${r.variant_key}:${r.arm}`,
        {
          sends: Number(r.sends),
          opened: Number(r.opened),
          clicked: Number(r.clicked),
        },
      ]),
    );
    const controlCounts = {
      contacts: liftResult.control.contacts,
      converters: liftResult.control.converters,
    };
    const armsByKey = new Map<string, z.infer<typeof variantArmSchema>[]>();
    for (const r of [...variantCountRows]) {
      const enrollments = Number(r.enrollments);
      const converters = Number(r.converters);
      const engagement = engagementByArm.get(`${r.variant_key}:${r.arm}`) ?? {
        sends: 0,
        opened: 0,
        clicked: 0,
      };
      const arm = {
        arm: r.arm,
        enrollments,
        converters,
        rate: enrollments > 0 ? converters / enrollments : 0,
        engagement: { causal: false as const, ...engagement },
        liftVsControl:
          controlCounts.contacts > 0
            ? {
                causal: true as const,
                ...computeLift({
                  treatment: { contacts: enrollments, converters },
                  control: controlCounts,
                }),
              }
            : null,
      };
      const list = armsByKey.get(r.variant_key) ?? [];
      list.push(arm);
      armsByKey.set(r.variant_key, list);
    }
    // SQL already ordered by (key, arm); Map preserves insertion order.
    const variants = [...armsByKey.entries()].map(([key, arms]) => ({
      key,
      arms,
    }));

    return c.json(
      {
        journeyId: id,
        days,
        goal: { definitionId: definitionId ?? null, source, name },
        holdout: meta?.holdout ? { percent: meta.holdout.percent } : null,
        currentVersionHash: meta?.versionHash ?? null,
        currentVersionLabel: meta?.version ?? null,
        overall,
        versions,
        variants,
      },
      200,
    );
  },
);
