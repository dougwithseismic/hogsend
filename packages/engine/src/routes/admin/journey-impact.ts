import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import type { AppEnv } from "../../app.js";
import { getConversionRegistry } from "../../lib/conversions.js";
import {
  computeJourneyLift,
  computeLiftValues,
} from "../../lib/journey-lift.js";
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
   * matching makes it visible, and per-version blocks are immune). */
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

    // Tasks 2–3 of the 2b plan replace these with the grouped
    // version-cohort and variant-arm queries.
    const versions: z.infer<typeof versionSchema>[] = [];
    const variants: z.infer<typeof variantSchema>[] = [];

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
