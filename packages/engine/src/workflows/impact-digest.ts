import type { Database } from "@hogsend/db";
import { sql } from "drizzle-orm";
import type { Logger } from "../lib/logger.js";
import type {
  ImpactDigestEntry,
  ImpactDigestLiftEntry,
  ImpactDigestShippedEntry,
  ImpactVersionCohort,
} from "../lib/outbound.js";

const DEFAULT_WIN_PROB_THRESHOLD = 0.95;
const DEFAULT_LOOKBACK_DAYS = 7; // first-ever run window
const MAX_LOOKBACK_DAYS = 30; // clamp on the watermark
const LIFT_WINDOW_DAYS = 90; // mirrors the lift route default
const ENTRY_CAP = 50;
const CANDIDATE_CAP = 200;
const LIFT_CONCURRENCY = 5; // pool for computeJourneyLift pairs
const DAY_MS = 86_400_000;

/**
 * Structural slice of the journey registry the digest reads (goal + name).
 * `JourneyRegistry.get` (@hogsend/core registry/index.ts:32-34) satisfies
 * it; tests hand in a plain object. A registry MISS (blueprint journey,
 * removed journey) degrades to nulls — never a crash.
 */
export interface DigestRegistryLike {
  get(id: string): { goal?: string; name?: string } | undefined;
}

/**
 * Cron input. `now` is a TEST SEAM: the Hatchet cron always pushes `{}`
 * and the task falls back to `Date.now()` — legal here (this is a cron
 * task, not a journey; determinism is delivered by the daily dedupeKey).
 */
export interface ImpactDigestInput {
  now?: string;
}

/** postgres-js returns Date for timestamptz, but raw execute rows are
 * typed defensively — normalize either representation. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function subDays(date: Date, days: number): Date {
  return new Date(date.getTime() - days * DAY_MS);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Watermark → window. `since` = the last impact.digest delivery's
 * created_at (max), defaulting to a 7-day window on the first-ever run,
 * clamped to at most 30 days back. Self-healing: pruned delivery rows
 * widen the window at most to the clamp.
 */
export function deriveDigestWindow(opts: {
  lastDeliveryAt: Date | null;
  now: Date;
}): { since: Date; until: Date } {
  const until = opts.now;
  const floor = new Date(until.getTime() - MAX_LOOKBACK_DAYS * DAY_MS);
  const fallback = new Date(until.getTime() - DEFAULT_LOOKBACK_DAYS * DAY_MS);
  const raw = opts.lastDeliveryAt ?? fallback;
  const since = raw.getTime() < floor.getTime() ? floor : raw;
  return { since, until };
}

/**
 * Payload ordering + cap: lift entries first (desc |winProbability − 0.5|
 * — strongest evidence up top), then shipped (desc firstSeenAt — newest
 * change first); deterministic journeyId tiebreak; capped with a
 * `truncated` flag.
 */
export function assembleDigestEntries(opts: {
  lift: ImpactDigestLiftEntry[];
  shipped: ImpactDigestShippedEntry[];
  cap: number;
}): { entries: ImpactDigestEntry[]; truncated: boolean } {
  const lift = [...opts.lift].sort((a, b) => {
    const delta =
      Math.abs(b.winProbability - 0.5) - Math.abs(a.winProbability - 0.5);
    if (delta !== 0) return delta;
    return a.journeyId.localeCompare(b.journeyId);
  });
  const shipped = [...opts.shipped].sort((a, b) => {
    // ISO-8601 strings sort chronologically.
    const delta = b.firstSeenAt.localeCompare(a.firstSeenAt);
    if (delta !== 0) return delta;
    return a.journeyId.localeCompare(b.journeyId);
  });
  const all: ImpactDigestEntry[] = [...lift, ...shipped];
  return { entries: all.slice(0, opts.cap), truncated: all.length > opts.cap };
}

/** Tiny dependency-free promise pool (LIFT_CONCURRENCY budget). */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        await fn(items[index] as T);
      }
    },
  );
  await Promise.all(workers);
}

// Referenced by Tasks 4-5; keeps the skeleton compiling standalone.
void message;
void mapWithConcurrency;
void LIFT_WINDOW_DAYS;
void ENTRY_CAP;
void CANDIDATE_CAP;
void LIFT_CONCURRENCY;
void DEFAULT_WIN_PROB_THRESHOLD;

type HashFirstSeenRow = {
  journey_id: string;
  journey_version_hash: string;
  version_label: string | null;
  first_seen_at: Date | string;
};

/**
 * All-time cohort of one (journey, hash) version. Reuses the lift route's
 * outcome semantics exactly: treatment-only (`status != 'held_out'`),
 * EXISTS with the per-row ITT clock (`occurred_at >= created_at`),
 * goal-conditional `definition_id` append, snapshot-bounded at `until`.
 * Label pick is latest-by-created_at (the array_agg form — max() is
 * lexicographic and shows stale labels after a label-only rename).
 */
async function versionCohort(opts: {
  db: Database;
  journeyId: string;
  hash: string;
  goal: string | null;
  until: Date;
}): Promise<ImpactVersionCohort> {
  const { db, journeyId, hash, goal, until } = opts;
  const untilTs = sql`${until.toISOString()}::timestamptz`;
  const goalCond = goal === null ? sql`` : sql` and c.definition_id = ${goal}`;
  const rows = [
    ...(await db.execute<{
      enrollments: number;
      converters: number;
      first_seen_at: Date | string | null;
      version_label: string | null;
    }>(sql`
      select
        count(distinct js.user_id)
          filter (where js.status != 'held_out')::int as enrollments,
        (count(distinct js.user_id)
          filter (where js.status != 'held_out' and exists (
            select 1 from conversions c
            where c.user_key = js.user_id
              and c.occurred_at >= js.created_at
              and c.occurred_at <= ${untilTs}${goalCond}
        )))::int as converters,
        min(js.created_at) as first_seen_at,
        (array_agg(js.journey_version_label order by js.created_at desc)
           filter (where js.journey_version_label is not null))[1]
          as version_label
      from journey_states js
      where js.journey_id = ${journeyId}
        and js.journey_version_hash = ${hash}
        and js.deleted_at is null
    `)),
  ];
  const row = rows[0];
  const enrollments = Number(row?.enrollments ?? 0);
  const converters = Number(row?.converters ?? 0);
  const firstSeen = row?.first_seen_at ? toDate(row.first_seen_at) : until;
  return {
    versionHash: hash,
    versionLabel: row?.version_label ?? null,
    enrollmentsAllTime: enrollments,
    converters,
    conversionRate: enrollments > 0 ? converters / enrollments : 0,
    firstSeenAt: firstSeen.toISOString(),
    exposureDays: Math.max(
      0,
      Math.floor((until.getTime() - firstSeen.getTime()) / DAY_MS),
    ),
  };
}

/**
 * Detection A — "you shipped a change" (causal: false). Two queries, not
 * one (a window-filtered GROUP BY cannot supply earlier hashes' first-seen),
 * plus the label pass: a (journey, label) pair first observed in-window
 * whose hash first-seen PREDATES the window is a label-only change — the
 * first-class "shipped" signal for template reworks the hash cannot see.
 * Inert until Decision A's columns fill (the IS NOT NULL filter); blueprint
 * enrollments are covered automatically (this reads journey_states, not the
 * code registry). Consumers MUST treat a new hash as "possible new
 * version" — toolchain bumps can fork it with zero content change.
 */
export async function detectShippedVersions(opts: {
  db: Database;
  since: Date;
  until: Date;
  registry?: DigestRegistryLike;
  logger?: Logger;
}): Promise<{ entries: ImpactDigestShippedEntry[] }> {
  const { db, since, until, registry } = opts;
  const sinceTs = sql`${since.toISOString()}::timestamptz`;
  const untilTs = sql`${until.toISOString()}::timestamptz`;

  // 1. (journey, hash) pairs first observed inside the window.
  const inWindow = [
    ...(await db.execute<HashFirstSeenRow>(sql`
      select journey_id, journey_version_hash,
             (array_agg(journey_version_label order by created_at desc)
                filter (where journey_version_label is not null))[1]
               as version_label,
             min(created_at) as first_seen_at
      from journey_states
      where journey_version_hash is not null and deleted_at is null
      group by journey_id, journey_version_hash
      having min(created_at) >= ${sinceTs} and min(created_at) < ${untilTs}
    `)),
  ];

  // 1b. (journey, label) pairs first observed inside the window, with the
  // hash carried by the EARLIEST row of the pair (label-only-change probe).
  const labelRows = [
    ...(await db.execute<{
      journey_id: string;
      version_label: string;
      first_seen_at: Date | string;
      hash: string | null;
    }>(sql`
      select journey_id, journey_version_label as version_label,
             min(created_at) as first_seen_at,
             (array_agg(journey_version_hash order by created_at asc))[1]
               as hash
      from journey_states
      where journey_version_label is not null
        and journey_version_hash is not null
        and deleted_at is null
      group by journey_id, journey_version_label
      having min(created_at) >= ${sinceTs} and min(created_at) < ${untilTs}
    `)),
  ];

  const affectedIds = [
    ...new Set([
      ...inWindow.map((r) => r.journey_id),
      ...labelRows.map((r) => r.journey_id),
    ]),
  ];
  if (affectedIds.length === 0) return { entries: [] };

  // 2. All-time first-seen per (journey, hash) for the affected journeys —
  // classifies new_journey vs new_version and picks `previous`.
  const idList = sql.join(
    affectedIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const allTime = [
    ...(await db.execute<HashFirstSeenRow>(sql`
      select journey_id, journey_version_hash,
             (array_agg(journey_version_label order by created_at desc)
                filter (where journey_version_label is not null))[1]
               as version_label,
             min(created_at) as first_seen_at
      from journey_states
      where journey_id in (${idList})
        and journey_version_hash is not null
        and deleted_at is null
      group by journey_id, journey_version_hash
    `)),
  ];

  const entries: ImpactDigestShippedEntry[] = [];

  // Hash pass: new_journey / new_version.
  for (const row of inWindow) {
    const meta = registry?.get(row.journey_id);
    const goal = meta?.goal ?? null;
    const firstSeen = toDate(row.first_seen_at);
    const earlier = allTime
      .filter(
        (a) =>
          a.journey_id === row.journey_id &&
          a.journey_version_hash !== row.journey_version_hash &&
          toDate(a.first_seen_at).getTime() < firstSeen.getTime(),
      )
      .sort(
        (a, b) =>
          toDate(b.first_seen_at).getTime() - toDate(a.first_seen_at).getTime(),
      );
    const previousHash = earlier[0]?.journey_version_hash ?? null;
    const current = await versionCohort({
      db,
      journeyId: row.journey_id,
      hash: row.journey_version_hash,
      goal,
      until,
    });
    const previous =
      previousHash === null
        ? null
        : await versionCohort({
            db,
            journeyId: row.journey_id,
            hash: previousHash,
            goal,
            until,
          });
    entries.push({
      kind: "shipped",
      causal: false,
      journeyId: row.journey_id,
      journeyName: meta?.name ?? null,
      versionHash: row.journey_version_hash,
      versionLabel: row.version_label ?? null,
      change: previousHash === null ? "new_journey" : "new_version",
      previousVersionLabel: null,
      firstSeenAt: firstSeen.toISOString(),
      goalDefinitionId: goal,
      current,
      previous,
    });
  }

  // Label pass: new_label (same content hash, fresh label).
  for (const row of labelRows) {
    if (row.hash === null) continue;
    const hashFirst = allTime.find(
      (a) =>
        a.journey_id === row.journey_id && a.journey_version_hash === row.hash,
    );
    // Hash unseen, or itself new in-window → already reported above.
    if (
      !hashFirst ||
      toDate(hashFirst.first_seen_at).getTime() >= since.getTime()
    ) {
      continue;
    }
    const meta = registry?.get(row.journey_id);
    const goal = meta?.goal ?? null;
    const prevLabelRows = [
      ...(await db.execute<{ prev_label: string | null }>(sql`
        select (array_agg(journey_version_label order by created_at desc)
                  filter (where journey_version_label is not null))[1]
                 as prev_label
        from journey_states
        where journey_id = ${row.journey_id}
          and created_at < ${sinceTs}
          and deleted_at is null
      `)),
    ];
    entries.push({
      kind: "shipped",
      causal: false,
      journeyId: row.journey_id,
      journeyName: meta?.name ?? null,
      versionHash: row.hash,
      versionLabel: row.version_label,
      change: "new_label",
      previousVersionLabel: prevLabelRows[0]?.prev_label ?? null,
      firstSeenAt: toDate(row.first_seen_at).toISOString(),
      goalDefinitionId: goal,
      current: await versionCohort({
        db,
        journeyId: row.journey_id,
        hash: row.hash,
        goal,
        until,
      }),
      previous: null,
    });
  }

  entries.sort(
    (a, b) =>
      a.journeyId.localeCompare(b.journeyId) ||
      a.versionHash.localeCompare(b.versionHash),
  );
  return { entries };
}
