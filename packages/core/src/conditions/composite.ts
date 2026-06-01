import type { CompositeCondition } from "../types/index.js";
import type { ConditionContext } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";

export async function evaluateCompositeCondition(opts: {
  condition: CompositeCondition;
  ctx: ConditionContext;
}): Promise<boolean> {
  const { condition, ctx } = opts;

  if (condition.operator === "and") {
    for (const sub of condition.conditions) {
      if (!(await evaluateCondition({ condition: sub, ctx }))) return false;
    }
    return true;
  }

  if (condition.operator === "or") {
    for (const sub of condition.conditions) {
      if (await evaluateCondition({ condition: sub, ctx })) return true;
    }
    return false;
  }

  return false;
}
