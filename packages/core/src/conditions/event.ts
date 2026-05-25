import { userEvents } from "@hogsend/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { durationToMs } from "../duration.js";
import type { EventCondition } from "../types/index.js";
import type { ConditionContext } from "./evaluate.js";

export async function evaluateEventCondition(opts: {
  condition: EventCondition;
  ctx: ConditionContext;
}): Promise<{ matched: boolean; count: number }> {
  const { condition, ctx } = opts;
  const [result] = await ctx.db
    .select({ count: sql<number>`count(*)` })
    .from(userEvents)
    .where(
      and(
        eq(userEvents.userId, ctx.userId),
        eq(userEvents.event, condition.eventName),
        condition.within
          ? gte(
              userEvents.occurredAt,
              new Date(Date.now() - durationToMs(condition.within)),
            )
          : undefined,
      ),
    );

  const count = Number(result?.count ?? 0);

  let matched: boolean;
  switch (condition.check) {
    case "exists":
      matched = count > 0;
      break;
    case "not_exists":
      matched = count === 0;
      break;
    case "count": {
      if (!condition.operator || condition.value === undefined) {
        matched = count > 0;
      } else {
        switch (condition.operator) {
          case "gt":
            matched = count > condition.value;
            break;
          case "gte":
            matched = count >= condition.value;
            break;
          case "lt":
            matched = count < condition.value;
            break;
          case "lte":
            matched = count <= condition.value;
            break;
          case "eq":
            matched = count === condition.value;
            break;
          default:
            matched = false;
        }
      }
      break;
    }
    default:
      matched = false;
  }

  return { matched, count };
}
