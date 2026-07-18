import { type Database, journeyStates } from "@hogsend/db";
import { and, eq, sql } from "drizzle-orm";
import { computeLift, type LiftVerdict } from "./lift-stats.js";

/**
 * Counts-only cohort: the /lift route merges per-currency values back in
 * (computeLiftValues); the phase-2b /impact overall block and the phase-3b
 * digest consume counts as-is.
 */
export interface LiftCohort {
  contacts: number;
  converters: number;
  rate: number;
}

export interface JourneyLiftResult {
  treatment: LiftCohort;
  control: LiftCohort;
  verdict: LiftVerdict;
}

interface LiftQueryOpts {
  db: Database;
  journeyId: string;
  since: Date;
  /** Snapshot instant; defaults to now (both bounds become no-ops). */
  asOf?: Date;
  /** Scope the outcome to one conversion definition; default any. */
  definitionId?: string;
}

/** Shared SQL fragments for one (journeyId, since, asOf, definitionId). */
function liftFragments(opts: LiftQueryOpts) {
  const asOf = opts.asOf ?? new Date();
  return {
    sinceTs: sql`${opts.since.toISOString()}::timestamptz`,
    asOfTs: sql`${asOf.toISOString()}::timestamptz`,
    definitionSql: opts.definitionId
      ? sql` and c.definition_id = ${opts.definitionId}`
      : sql``,
  };
}

/**
 * Holdout lift for one journey — the ONE implementation of the causal math
 * (routes/admin/funnels.ts:16 law). Treatment = status != 'held_out';
 * control = status = 'held_out'; outcome = ≥1 qualifying conversions row
 * with occurred_at >= the state row's created_at (intent-to-treat clock).
 *
 * `asOf` (default: now) snapshots the read: cohort rows require
 * created_at < asOf and conversions require occurred_at <= asOf. With
 * asOf = now both bounds are no-ops (future-dated rows cannot exist), so
 * the /lift route's behavior is unchanged by the extraction — pinned by a
 * regression fixture (apps/api journey-lift.test.ts).
 */
export async function computeJourneyLift(
  opts: LiftQueryOpts,
): Promise<JourneyLiftResult> {
  const { db, journeyId } = opts;
  const { sinceTs, asOfTs, definitionSql } = liftFragments(opts);

  // Outcome: the contact fired ≥1 qualifying conversion AFTER their state
  // row was created (post-assignment — the intent-to-treat clock) and at
  // or before the asOf snapshot instant.
  const convertedSql = sql`exists (
    select 1 from conversions c
    where c.user_key = ${journeyStates.userId}
      and c.occurred_at >= ${journeyStates.createdAt}
      and c.occurred_at <= ${asOfTs}${definitionSql}
  )`;

  const cohort = async (control: boolean): Promise<LiftCohort> => {
    const statusFilter = control
      ? eq(journeyStates.status, "held_out")
      : sql`${journeyStates.status} != 'held_out'`;
    const [row] = await db
      .select({
        contacts: sql<number>`count(distinct ${journeyStates.userId})::int`,
        converters: sql<number>`(count(distinct ${journeyStates.userId}) filter (where ${convertedSql}))::int`,
      })
      .from(journeyStates)
      .where(
        and(
          eq(journeyStates.journeyId, journeyId),
          sql`${journeyStates.createdAt} >= ${sinceTs}`,
          sql`${journeyStates.createdAt} < ${asOfTs}`,
          statusFilter,
        ),
      );
    const contacts = Number(row?.contacts ?? 0);
    const converters = row?.converters ?? 0;
    return {
      contacts,
      converters,
      rate: contacts > 0 ? converters / contacts : 0,
    };
  };

  const [treatment, control] = await Promise.all([cohort(false), cohort(true)]);
  return { treatment, control, verdict: computeLift({ treatment, control }) };
}

/**
 * Per-currency qualifying conversion value for both cohorts (full value,
 * not fractional credit). Kept SEPARATE from the counts helper: /lift
 * composes it into its wire shape; the digest and overview never need it.
 */
export async function computeLiftValues(opts: LiftQueryOpts): Promise<{
  treatment: Array<{ currency: string | null; value: number }>;
  control: Array<{ currency: string | null; value: number }>;
}> {
  const { db, journeyId } = opts;
  const { sinceTs, asOfTs, definitionSql } = liftFragments(opts);

  const values = async (control: boolean) => {
    const rows = await db.execute<{ currency: string | null; value: number }>(
      sql`
        select c.currency, coalesce(sum(c.value), 0)::float8 as value
        from conversions c
        where c.value is not null
          and c.occurred_at <= ${asOfTs}
          and exists (
            select 1 from journey_states js
            where js.journey_id = ${journeyId}
              and js.created_at >= ${sinceTs}
              and js.created_at < ${asOfTs}
              and ${control ? sql`js.status = 'held_out'` : sql`js.status != 'held_out'`}
              and js.user_id = c.user_key
              and c.occurred_at >= js.created_at
          )${definitionSql}
        group by c.currency
      `,
    );
    return [...rows].map((r) => ({
      currency: r.currency,
      value: Number(r.value),
    }));
  };

  const [treatment, control] = await Promise.all([values(false), values(true)]);
  return { treatment, control };
}
