import { userEvents } from "@hogsend/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import type { EventCondition } from "../types/index.js";
import type { ConditionContext } from "./evaluate.js";

export async function evaluateEventCondition(opts: {
  condition: EventCondition;
  ctx: ConditionContext;
}): Promise<boolean> {
  const { condition, ctx } = opts;
  const [result] = await ctx.db
    .select({ count: sql<number>`count(*)` })
    .from(userEvents)
    .where(
      and(
        eq(userEvents.userId, ctx.userId),
        eq(userEvents.event, condition.eventName),
        condition.withinHours
          ? gte(
              userEvents.occurredAt,
              new Date(Date.now() - condition.withinHours * 60 * 60 * 1000),
            )
          : undefined,
      ),
    );

  const count = Number(result?.count ?? 0);

  switch (condition.check) {
    case "exists":
      return count > 0;
    case "not_exists":
      return count === 0;
    case "count": {
      if (!condition.operator || condition.value === undefined)
        return count > 0;
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
