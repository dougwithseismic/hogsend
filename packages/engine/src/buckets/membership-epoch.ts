import {
  type BucketMeta,
  type ConditionEval,
  type DurationObject,
  durationToMs,
  type EventCondition,
} from "@hogsend/core";
import { bucketMemberships, type Database } from "@hogsend/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * The reserved prefix every bucket transition event carries. Single source of
 * truth shared by the ingest recursion guard (`checkBucketMembership`) and the
 * fast-expiry arming event (`bucket:arm-expiry`).
 */
export const BUCKET_EVENT_PREFIX = "bucket:";

/**
 * The count of ALL prior memberships (active + left, NO status filter) for a
 * (userId, bucketId) pair. This is the single source for the entryCount-ordinal
 * rule (Section 6.3 / 8.2): the next epoch is `1 + countPriorMemberships(...)`,
 * and the same count drives the entryLimit gate. Both the real-time join path
 * (`handleJoin`) and the reconcile-discovered join path (`reconcileJoinOne`)
 * call this so the ordinal can never drift between the two writers.
 *
 * The predicate MUST stay status-agnostic — narrowing it (e.g. to active-only)
 * would corrupt entryCount and the entryLimit cooldown.
 */
export async function countPriorMemberships(
  db: Database,
  bucketId: string,
  userId: string,
): Promise<number> {
  const [counted] = await db
    .select({ priorCount: sql<number>`count(*)::int` })
    .from(bucketMemberships)
    .where(
      and(
        eq(bucketMemberships.userId, userId),
        eq(bucketMemberships.bucketId, bucketId),
      ),
    );
  return Number(counted?.priorCount ?? 0);
}

/**
 * Find the first `EventCondition.within` rolling window in a criteria tree
 * (depth-first). Returns null when no event leg carries a window. The single
 * source for the membership-expiry / fastExpiry deadline math — shared so the
 * three membership writers (real-time join, reconcile join, backfill join) can
 * never disagree on which window drives `expiresAt`.
 */
export function firstWithin(criteria: ConditionEval): DurationObject | null {
  if (criteria.type === "event" && criteria.within) {
    return criteria.within;
  }
  if (criteria.type === "composite") {
    for (const child of criteria.conditions) {
      const found = firstWithin(child);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The persisted membership-expiry / fastExpiry arming deadline. Non-time-based,
 * non-fastExpiry buckets have no deadline (returns null). Time-based / fastExpiry
 * buckets that carry a single `within` window get `now + within`; the reconcile
 * cron and fastExpiry timer own the actual leave.
 *
 * Centralized so the real-time join (check-membership.ts), the reconcile-discovered
 * join (bucket-reconcile.ts), and the backfill join (bucket-backfill.ts) compute
 * the SAME deadline — a divergence here would let a membership-writer arm a window
 * the cron/timer disagrees with.
 */
export function computeExpiresAt(bucket: BucketMeta): Date | null {
  if (!bucket.criteria) return null;
  if (!bucket.timeBased && !bucket.fastExpiry) return null;
  const within = firstWithin(bucket.criteria);
  if (!within) return null;
  return new Date(Date.now() + durationToMs(within));
}

/**
 * The unconditional max-dwell TTL deadline, stamped once on JOIN. null when the
 * bucket has no `maxDwell`; the TTL sweep filters `isNotNull(maxDwellAt)`, so an
 * unset value is never force-left. Shared by all three join writers so the TTL
 * stamp is computed identically.
 */
export function computeMaxDwellAt(bucket: BucketMeta): Date | null {
  return bucket.maxDwell
    ? new Date(Date.now() + durationToMs(bucket.maxDwell))
    : null;
}

/**
 * The shared windowed event-count operator comparison kernel (`gt/gte/lt/lte/eq`).
 * Returns the boolean of `count <operator> value`, or null for an unrecognized
 * operator so each caller keeps its own default (the leave/match wrappers below).
 * This is the single source for the count-operator math the reconcile SHOULD-LEAVE
 * and the backfill MATCH paths both depend on.
 */
function compareCount(
  operator: NonNullable<EventCondition["operator"]>,
  count: number,
  value: number,
): boolean | null {
  switch (operator) {
    case "gt":
      return count > value;
    case "gte":
      return count >= value;
    case "lt":
      return count < value;
    case "lte":
      return count <= value;
    case "eq":
      return count === value;
    default:
      return null;
  }
}

/**
 * True when a windowed `count` satisfies the (exists/not_exists/count) event
 * criterion — the POSITIVE "is a member by this windowed count" decision. Shared
 * by the backfill matcher path (selectEventMatchers' positive branch). Behavior is
 * identical to the prior local `matchesCount`: a `count` check with no
 * operator/value (or an unrecognized operator) falls back to `count > 0` / `false`
 * respectively.
 */
export function matchesEventCount(
  criteria: EventCondition,
  count: number,
): boolean {
  switch (criteria.check) {
    case "exists":
      return count > 0;
    case "not_exists":
      return count === 0;
    case "count": {
      if (!criteria.operator || criteria.value === undefined) return count > 0;
      const result = compareCount(criteria.operator, count, criteria.value);
      return result ?? false;
    }
    default:
      return false;
  }
}

/**
 * The SHOULD-LEAVE decision from a windowed count, per criterion shape — a member
 * leaves when the criterion is NO LONGER satisfied. Shared by the reconcile
 * cron's set-based leave path. Behavior is identical to the prior local
 * `shouldLeaveByCount`: it is the per-shape NEGATION of {@link matchesEventCount}
 * for `exists`/`count`, an event-reappeared check for `not_exists`, and preserves
 * the `count` `default → false` for an unrecognized operator.
 */
export function shouldLeaveByCount(
  criteria: EventCondition,
  windowedCount: number,
): boolean {
  switch (criteria.check) {
    case "not_exists":
      // Absence bucket: SHOULD LEAVE when an event REAPPEARS in the window.
      return windowedCount > 0;
    case "exists":
      // Positive existence: SHOULD LEAVE when NOT EXISTS in the window.
      return windowedCount === 0;
    case "count": {
      // SHOULD LEAVE when the windowed count NO LONGER satisfies the operator.
      if (!criteria.operator || criteria.value === undefined) {
        return windowedCount === 0;
      }
      const result = compareCount(
        criteria.operator,
        windowedCount,
        criteria.value,
      );
      return result == null ? false : !result;
    }
    default:
      return false;
  }
}
