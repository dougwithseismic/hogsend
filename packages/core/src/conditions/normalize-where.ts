import type { PropertyCondition } from "../types/conditions.js";
import type { JourneyWhere } from "../types/journey.js";
import { criteriaBuilder } from "./builder.js";

/**
 * Resolve a `JourneyWhere` (a declarative `PropertyCondition[]` OR a builder
 * function) to its stored `PropertyCondition[]` — a one-shot, definition-time
 * call. A declarative array passes straight through; a builder fn is invoked
 * ONCE with the criteria builder so conditions stay introspectable data
 * everywhere downstream. Returns `undefined` for an absent where so callers can
 * take a fast path.
 *
 * Shared by `defineJourney` (trigger/exit `where` normalization) and
 * `ctx.waitForEvent`'s `where` so both speak the exact same predicate model.
 */
export function normalizeWhere(
  where: JourneyWhere | undefined,
): PropertyCondition[] | undefined {
  if (where === undefined) return undefined;
  if (typeof where !== "function") return where;
  const resolved = where(criteriaBuilder);
  return Array.isArray(resolved) ? resolved : [resolved];
}
