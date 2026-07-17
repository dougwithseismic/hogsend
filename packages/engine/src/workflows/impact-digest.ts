import type { Database } from "@hogsend/db";
import { sql } from "drizzle-orm";
import type { Logger } from "../lib/logger.js";
import type {
  ImpactDigestEntry,
  ImpactDigestLiftEntry,
  ImpactDigestShippedEntry,
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

// Referenced by Tasks 3-5; keeps the skeleton compiling standalone.
void sql;
void message;
void mapWithConcurrency;
void LIFT_WINDOW_DAYS;
void ENTRY_CAP;
void CANDIDATE_CAP;
void LIFT_CONCURRENCY;
void DEFAULT_WIN_PROB_THRESHOLD;

export type { Database, Logger };
