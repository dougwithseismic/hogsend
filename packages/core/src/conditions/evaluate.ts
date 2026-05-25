import type { Database } from "@hogsend/db";
import type { ConditionEval } from "../types/index.js";
import { evaluateCompositeCondition } from "./composite.js";
import { evaluateEmailEngagementCondition } from "./email-engagement.js";
import { evaluateEventCondition } from "./event.js";
import { evaluatePropertyCondition } from "./property.js";

export interface ConditionContext {
  db: Database;
  userId: string;
  journeyContext: Record<string, unknown>;
  getPostHogProperties?: (userId: string) => Promise<Record<string, unknown>>;
}

export async function evaluateCondition(
  condition: ConditionEval,
  ctx: ConditionContext,
): Promise<boolean> {
  switch (condition.type) {
    case "property":
      return evaluatePropertyCondition(condition, ctx);
    case "event":
      return evaluateEventCondition(condition, ctx);
    case "email_engagement":
      return evaluateEmailEngagementCondition(condition, ctx);
    case "composite":
      return evaluateCompositeCondition(condition, ctx);
    default:
      return false;
  }
}
