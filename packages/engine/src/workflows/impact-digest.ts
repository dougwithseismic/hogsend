import { ConcurrencyLimitStrategy } from "@hatchet-dev/typescript-sdk/v1/index.js";
import {
  createDatabase,
  type Database,
  webhookDeliveries,
  webhookEndpoints,
} from "@hogsend/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getJourneyRegistrySingleton } from "../journeys/registry-singleton.js";
import { hatchet } from "../lib/hatchet.js";
import { computeJourneyLift } from "../lib/journey-lift.js";
import { createLogger, type Logger } from "../lib/logger.js";
import {
  emitOutbound,
  type ImpactDigestEntry,
  type ImpactDigestLiftEntry,
  type ImpactDigestShippedEntry,
  type ImpactVersionCohort,
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

/**
 * Detection B — "working / hurting" (causal: true). Candidates = journeys
 * with held-out rows inside the 90-day lift window, capped at
 * CANDIDATE_CAP (warned when hit). Per candidate the unified helper runs
 * two snapshots through a LIFT_CONCURRENCY pool: `now` (asOf = until) and
 * — only when the frozen payload has no answer — `prev` (asOf = since).
 *
 * FROZEN-PAYLOAD OVERRIDE (the drift hole): `prev` is the LAST digest's
 * as-REPORTED winProbability when available. Late-arriving/backfilled
 * conversions can otherwise retroactively flip last week's probability
 * across T, silently swallowing a real crossing or re-reporting one
 * already sent. The recompute remains the fallback for journeys absent
 * from the last payload.
 *
 * Crossing (not level) semantics — no weekly re-nag; the down side is
 * included deliberately. Suppression is absolute; smallSample rides.
 */
export async function detectLiftCrossings(opts: {
  db: Database;
  since: Date;
  until: Date;
  threshold: number;
  registry?: DigestRegistryLike;
  previousWinProbabilities?: Map<string, number>;
  logger?: Logger;
}): Promise<{ entries: ImpactDigestLiftEntry[] }> {
  const {
    db,
    since,
    until,
    threshold,
    registry,
    previousWinProbabilities,
    logger,
  } = opts;

  const candidateRows = [
    ...(await db.execute<{ journey_id: string }>(sql`
      select distinct journey_id
      from journey_states
      where status = 'held_out' and deleted_at is null
        and created_at >= ${subDays(until, LIFT_WINDOW_DAYS).toISOString()}::timestamptz
      order by journey_id asc
      limit ${CANDIDATE_CAP + 1}
    `)),
  ];
  let candidates = candidateRows.map((r) => r.journey_id);
  if (candidates.length > CANDIDATE_CAP) {
    logger?.warn(
      "impact-digest: lift candidate cap hit — ids beyond the cap are skipped this run",
      { cap: CANDIDATE_CAP },
    );
    candidates = candidates.slice(0, CANDIDATE_CAP);
  }

  const entries: ImpactDigestLiftEntry[] = [];
  await mapWithConcurrency(candidates, LIFT_CONCURRENCY, async (journeyId) => {
    const meta = registry?.get(journeyId);
    const goal = meta?.goal;
    const now = await computeJourneyLift({
      db,
      journeyId,
      definitionId: goal,
      since: subDays(until, LIFT_WINDOW_DAYS),
      asOf: until,
    });
    const winProbability = now.verdict.winProbability;
    // Suppression is absolute; and a probability strictly inside
    // (1−T, T) cannot be a crossing — skip before paying for `prev`.
    if (now.verdict.suppressed || winProbability === null) return;
    if (winProbability < threshold && winProbability > 1 - threshold) {
      return;
    }

    let prev: number | null;
    if (previousWinProbabilities?.has(journeyId)) {
      prev = previousWinProbabilities.get(journeyId) ?? null;
    } else {
      const prevResult = await computeJourneyLift({
        db,
        journeyId,
        definitionId: goal,
        since: subDays(since, LIFT_WINDOW_DAYS),
        asOf: since,
      });
      prev = prevResult.verdict.winProbability;
    }

    let direction: "up" | "down" | null = null;
    if (winProbability >= threshold && (prev === null || prev < threshold)) {
      direction = "up";
    } else if (
      winProbability <= 1 - threshold &&
      (prev === null || prev > 1 - threshold)
    ) {
      direction = "down";
    }
    if (direction === null) return;

    entries.push({
      kind: "lift",
      causal: true,
      journeyId,
      journeyName: meta?.name ?? null,
      goalDefinitionId: goal ?? null,
      windowDays: LIFT_WINDOW_DAYS,
      direction,
      treatment: now.treatment,
      control: now.control,
      liftPercent: now.verdict.liftPercent,
      winProbability,
      previousWinProbability: prev,
      smallSample: now.verdict.smallSample,
    });
  });

  // Pool completion order is nondeterministic — stabilize.
  entries.sort((a, b) => a.journeyId.localeCompare(b.journeyId));
  return { entries };
}

/**
 * Compose Detection A (+ label pass) and Detection B, then order + cap.
 * Each detection degrades independently (per-section try/catch — the
 * check-alerts posture): a failed section logs and yields zero entries of
 * its kind rather than killing the whole digest.
 */
export async function buildImpactDigest(opts: {
  db: Database;
  since: Date;
  until: Date;
  threshold: number;
  registry?: DigestRegistryLike;
  previousWinProbabilities?: Map<string, number>;
  logger?: Logger;
}): Promise<{ entries: ImpactDigestEntry[]; truncated: boolean }> {
  let shipped: ImpactDigestShippedEntry[] = [];
  try {
    shipped = (await detectShippedVersions(opts)).entries;
  } catch (err) {
    opts.logger?.warn(
      "impact-digest: shipped-version detection failed — degrading to lift entries only",
      { error: message(err) },
    );
  }
  let lift: ImpactDigestLiftEntry[] = [];
  try {
    lift = (await detectLiftCrossings(opts)).entries;
  } catch (err) {
    opts.logger?.warn(
      "impact-digest: lift-crossing detection failed — degrading to shipped entries only",
      { error: message(err) },
    );
  }
  return assembleDigestEntries({ lift, shipped, cap: ENTRY_CAP });
}

/**
 * The as-REPORTED winProbability set from the latest impact.digest
 * delivery — webhook_deliveries.payload holds the frozen envelope
 * (lib/outbound.ts:390-408), so this reads what subscribers were actually
 * told last time. detectLiftCrossings falls back to a live recompute only
 * for journeys absent from it.
 */
async function readPreviousWinProbabilities(
  db: Database,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const rows = await db
    .select({ payload: webhookDeliveries.payload })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.eventType, "impact.digest"))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(1);
  const envelope = rows[0]?.payload as
    | { data?: { entries?: unknown[] } }
    | undefined;
  for (const entry of envelope?.data?.entries ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as {
      kind?: unknown;
      journeyId?: unknown;
      winProbability?: unknown;
    };
    if (candidate.kind !== "lift") continue;
    if (
      typeof candidate.journeyId === "string" &&
      typeof candidate.winProbability === "number"
    ) {
      map.set(candidate.journeyId, candidate.winProbability);
    }
  }
  return map;
}

/**
 * The weekly impact digest cron (impact experiments D5). Read-only except
 * the emit; no email/SMS (rendering the digest is a subscriber choice);
 * inert without subscribers — the opt-in is an endpoint subscribing to
 * impact.digest, NOT an env var. Registered in worker.ts baseWorkflows.
 *
 * REPLAY-LAW NOTE: this is a CRON task, not a journey — Date.now() is
 * legal; determinism is delivered by the UTC-day dedupeKey plus
 * emitOutbound's onConflictDoNothing fan-out on (endpointId, dedupeKey).
 * That index is a plain uniqueIndex relying on NULL-distinctness, NOT a
 * partial index — do not add a WHERE predicate to it.
 *
 * Documented consequence of the day-keyed dedupe: at most one digest per
 * endpoint per UTC day, even on a sub-daily cron. The cross-midnight
 * retry edge is self-healing (a retry re-reads the watermark; the window
 * collapses to minutes and is almost surely empty → no emit).
 */
export const impactDigestTask = hatchet.task({
  name: "impact-digest",
  // Mondays 09:00 UTC by default. Read raw off process.env at module load
  // (the bucket-reconcile pattern); declared in env.ts for the
  // validated-env contract.
  onCrons: [process.env.IMPACT_DIGEST_CRON ?? "0 9 * * 1"],
  retries: 1,
  // Budget: 200 candidates × 2 lift snapshots × 2 count queries ≈ 800
  // queries at pool 5 — fits with room.
  executionTimeout: "300s",
  concurrency: {
    expression: "'impact-digest'",
    maxRuns: 1,
    limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
  },
  fn: async (
    input: ImpactDigestInput = {},
  ): Promise<{
    emitted: boolean;
    reason?: string;
    entries?: number;
    since?: string;
    until?: string;
  }> => {
    // Cron runs have no request container — self-bootstrap (check-alerts).
    const { db } = createDatabase({ url: process.env.DATABASE_URL ?? "" });
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");

    // (1) Subscriber pre-check — THE opt-in gate, one indexed query with
    // the EXACT predicate emitOutbound uses (lib/outbound.ts:376-385).
    let subscribers: Array<{ id: string }>;
    try {
      subscribers = await db
        .select({ id: webhookEndpoints.id })
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.disabled, false),
            isNull(webhookEndpoints.organizationId),
            sql`${webhookEndpoints.eventTypes} @> ${JSON.stringify([
              "impact.digest",
            ])}::jsonb`,
          ),
        )
        .limit(1);
    } catch (err) {
      logger.warn("impact-digest: subscriber pre-check failed", {
        error: message(err),
      });
      return { emitted: false, reason: "subscriber_check_failed" };
    }
    if (subscribers.length === 0) {
      return { emitted: false, reason: "no_subscribers" };
    }

    // (2) Watermark off our own delivery rows (no new storage).
    // `input.now` is a test seam; the cron always pushes {}.
    const parsedNow = input.now ? new Date(input.now) : new Date();
    const now = Number.isNaN(parsedNow.getTime()) ? new Date() : parsedNow;
    let lastDeliveryAt: Date | null = null;
    try {
      const rows = await db
        .select({
          last: sql<Date | string | null>`max(${webhookDeliveries.createdAt})`,
        })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.eventType, "impact.digest"));
      const raw = rows[0]?.last ?? null;
      lastDeliveryAt = raw ? toDate(raw) : null;
    } catch (err) {
      logger.warn("impact-digest: watermark read failed", {
        error: message(err),
      });
      return { emitted: false, reason: "watermark_failed" };
    }
    const { since, until } = deriveDigestWindow({ lastDeliveryAt, now });

    // (3) Registry singleton (set by createHogsendClient in both API and
    // worker); degrade to unregistered lookups, never crash.
    let registry: DigestRegistryLike | undefined;
    try {
      registry = getJourneyRegistrySingleton();
    } catch {
      registry = undefined;
    }

    // (4) Frozen prev-winProbability set from the LAST digest delivery.
    let previousWinProbabilities: Map<string, number> | undefined;
    try {
      previousWinProbabilities = await readPreviousWinProbabilities(db);
    } catch (err) {
      logger.warn("impact-digest: previous payload read failed", {
        error: message(err),
      });
      previousWinProbabilities = undefined;
    }

    const threshold = Math.min(
      0.999,
      Math.max(
        0.5,
        Number(process.env.IMPACT_DIGEST_WIN_PROB) ||
          DEFAULT_WIN_PROB_THRESHOLD,
      ),
    );

    // (5) Detections (each degrades internally).
    const { entries, truncated } = await buildImpactDigest({
      db,
      since,
      until,
      threshold,
      registry,
      previousWinProbabilities,
      logger,
    });

    // (6) An empty digest is never emitted; the watermark intentionally
    // does not advance (no delivery row is written).
    if (entries.length === 0) {
      return {
        emitted: false,
        reason: "no_entries",
        since: since.toISOString(),
        until: until.toISOString(),
      };
    }

    // (7) Emit through the spine. emitOutbound never throws; per-endpoint
    // fan-out dedupe is onConflictDoNothing on (endpointId, dedupeKey).
    const periodKey = until.toISOString().slice(0, 10);
    await emitOutbound({
      db,
      hatchet,
      logger,
      event: "impact.digest",
      payload: {
        periodKey,
        since: since.toISOString(),
        until: until.toISOString(),
        entries,
        truncated,
      },
      dedupeKey: `impact.digest:${periodKey}`,
    });
    return {
      emitted: true,
      entries: entries.length,
      since: since.toISOString(),
      until: until.toISOString(),
    };
  },
});
