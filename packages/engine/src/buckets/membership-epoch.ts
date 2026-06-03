import { bucketMemberships, type Database } from "@hogsend/db";
import { and, eq, sql } from "drizzle-orm";

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
