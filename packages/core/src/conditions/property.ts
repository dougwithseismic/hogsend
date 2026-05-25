import type { PropertyCondition } from "../types/index.js";
import type { ConditionContext } from "./evaluate.js";

export async function evaluatePropertyCondition(
  condition: PropertyCondition,
  ctx: ConditionContext,
): Promise<boolean> {
  let value: unknown;

  if (condition.source === "context") {
    value = ctx.journeyContext[condition.property];
  } else if (condition.source === "posthog") {
    return false;
  }

  return compareValue(value, condition.operator, condition.value);
}

function compareValue(
  actual: unknown,
  operator: PropertyCondition["operator"],
  expected: PropertyCondition["value"],
): boolean {
  switch (operator) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "gt":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual > expected
      );
    case "gte":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual >= expected
      );
    case "lt":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual < expected
      );
    case "lte":
      return (
        typeof actual === "number" &&
        typeof expected === "number" &&
        actual <= expected
      );
    case "exists":
      return actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "contains":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.includes(expected)
      );
    default:
      return false;
  }
}
