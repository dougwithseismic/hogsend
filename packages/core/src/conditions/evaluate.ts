import type { Database } from "@hogsend/db";
import type { ConditionEval } from "../types/index.js";
import { evaluateCompositeCondition } from "./composite.js";
import { evaluateEmailEngagementCondition } from "./email-engagement.js";
import { evaluateEventCondition } from "./event.js";
import { evaluatePropertyCondition } from "./property.js";

export interface ConditionContext {
  db: Database;
  userId: string;
  /**
   * The contact's email, for `email_engagement` leaves (they look up
   * `email_sends.to_email`, which is an address — NOT `userId`, which is the
   * contactKey external_id/anonymous_id/id). When omitted the evaluator falls
   * back to `userId` for backward-compat with callers that pre-date this field;
   * pass it explicitly (even `null`) on any path that evaluates
   * `email_engagement` for a non-email `userId` (e.g. flag targeting).
   */
  email?: string | null;
  journeyContext: Record<string, unknown>;
}

export async function evaluateCondition(opts: {
  condition: ConditionEval;
  ctx: ConditionContext;
}): Promise<boolean> {
  const { condition, ctx } = opts;

  switch (condition.type) {
    case "property":
      return evaluatePropertyCondition({ condition, ctx });
    case "event": {
      const result = await evaluateEventCondition({ condition, ctx });
      return result.matched;
    }
    case "email_engagement":
      return evaluateEmailEngagementCondition({ condition, ctx });
    case "channel_identity":
      // Evaluated as bulk SQL on the campaign wave path (engine); there is no
      // per-user implementation and core must not grow contact-table access
      // for one.
      throw new Error(
        "channel_identity conditions are bulk-only in v1 (campaign waves) — not supported by the per-user evaluator.",
      );
    case "composite":
      return evaluateCompositeCondition({ condition, ctx });
    default:
      return false;
  }
}
