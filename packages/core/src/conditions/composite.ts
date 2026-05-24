import type { CompositeCondition } from "../types/index.js";
import type { ConditionContext } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";

export async function evaluateCompositeCondition(
  condition: CompositeCondition,
  ctx: ConditionContext,
): Promise<boolean> {
  if (condition.operator === "and") {
    for (const sub of condition.conditions) {
      if (!(await evaluateCondition(sub, ctx))) return false;
    }
    return true;
  }

  if (condition.operator === "or") {
    for (const sub of condition.conditions) {
      if (await evaluateCondition(sub, ctx)) return true;
    }
    return false;
  }

  return false;
}
