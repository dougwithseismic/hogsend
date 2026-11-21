import { userEvents } from "@hogsend/db/schema";
import { and, eq, gte, type SQL, sql } from "drizzle-orm";
import { durationToMs } from "../duration.js";
import { bySubject } from "../subject.js";
import type { EventCondition } from "../types/index.js";
import type { ConditionContext } from "./evaluate.js";

/**
 * The subject + event-name + optional window scope every event read shares.
 * Once a contact exists `bySubject` scopes by `contact_id`, which
 * `user_events_contact_event_occurred_idx` serves as one range scan; the
 * contactless arm rides `user_events_user_event_occurred_idx`.
 */
function eventScope(condition: EventCondition, ctx: ConditionContext): SQL {
  return and(
    bySubject(userEvents, {
      contactId: ctx.contactId,
      userKey: ctx.userId,
    }),
    eq(userEvents.event, condition.eventName),
    condition.within
      ? gte(
          userEvents.occurredAt,
          new Date(Date.now() - durationToMs(condition.within)),
        )
      : undefined,
  ) as SQL;
}

/**
 * The `check` decision for a given count. Single source for both readers
 * below, so the exact-count and the capped-count paths can never disagree on
 * what a count means.
 */
function matchesCount(condition: EventCondition, count: number): boolean {
  switch (condition.check) {
    case "exists":
      return count > 0;
    case "not_exists":
      return count === 0;
    case "count": {
      if (!condition.operator || condition.value === undefined) {
        return count > 0;
      }
      switch (condition.operator) {
        case "gt":
          return count > condition.value;
        case "gte":
          return count >= condition.value;
        case "lt":
          return count < condition.value;
        case "lte":
          return count <= condition.value;
        case "eq":
          return count === condition.value;
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

/**
 * Evaluate an event condition AND report the exact number of matching rows.
 *
 * Use this only when the count itself is the answer (`ctx.history.hasEvent`
 * returns it to journey authors). A yes/no decision should go through
 * {@link eventConditionMatches}, which never counts past what the comparison
 * needs.
 */
export async function evaluateEventCondition(opts: {
  condition: EventCondition;
  ctx: ConditionContext;
}): Promise<{ matched: boolean; count: number }> {
  const { condition, ctx } = opts;
  const [result] = await ctx.db
    .select({ count: sql<number>`count(*)` })
    .from(userEvents)
    .where(eventScope(condition, ctx));

  const count = Number(result?.count ?? 0);
  return { matched: matchesCount(condition, count), count };
}

/**
 * The row cap that keeps a count comparison exact (PRD 09).
 *
 * Counting at most `L = floor(value) + 1` rows decides every operator the
 * same way the full count does: below `L` the capped count IS the count, and
 * at `L` the true count is already above `value`, so `gt`/`gte` hold and
 * `lt`/`lte`/`eq` fail whether the true count is `L` or a million. A negative
 * value caps at 0 (no row can change the answer). A non-finite value gets no
 * cap, so the comparison falls back to the full count.
 */
function countCap(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value) + 1);
}

/**
 * The yes/no answer for an event condition, at the least work the check
 * allows (PRD 09). `exists` / `not_exists` (and a `count` with no operator,
 * which means "at least one") are a single `EXISTS` probe that stops at the
 * first row; a `count` comparison counts at most {@link countCap} rows. Same
 * decision as {@link evaluateEventCondition}'s `matched`, always.
 */
export async function eventConditionMatches(opts: {
  condition: EventCondition;
  ctx: ConditionContext;
}): Promise<boolean> {
  const { condition, ctx } = opts;
  const scope = eventScope(condition, ctx);

  const existence =
    condition.check === "exists" ||
    condition.check === "not_exists" ||
    (condition.check === "count" &&
      (!condition.operator || condition.value === undefined));

  if (existence) {
    const probe = ctx.db.select({ one: sql`1` }).from(userEvents).where(scope);
    const [row] = (await ctx.db.execute(
      sql`select exists (${probe}) as "found"`,
    )) as unknown as Array<{ found: boolean }>;
    return matchesCount(condition, row?.found === true ? 1 : 0);
  }

  if (condition.check !== "count" || condition.value === undefined) {
    return false;
  }

  const cap = countCap(condition.value);
  const limited =
    cap === null
      ? ctx.db.select({ one: sql`1` }).from(userEvents).where(scope)
      : ctx.db.select({ one: sql`1` }).from(userEvents).where(scope).limit(cap);
  const [result] = await ctx.db
    .select({ count: sql<number>`count(*)` })
    .from(limited.as("capped"));
  return matchesCount(condition, Number(result?.count ?? 0));
}
