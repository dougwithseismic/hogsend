import type { DurationObject } from "../duration.js";
import type {
  CompositeCondition,
  ConditionEval,
  EventCondition,
  PropertyCondition,
} from "../types/conditions.js";

type CountOperator = NonNullable<EventCondition["operator"]>;

/** Fluent property predicate. Each terminal returns a plain PropertyCondition. */
export interface PropertyMatcher {
  eq(value: string | number | boolean): PropertyCondition;
  neq(value: string | number | boolean): PropertyCondition;
  gt(value: number): PropertyCondition;
  gte(value: number): PropertyCondition;
  lt(value: number): PropertyCondition;
  lte(value: number): PropertyCondition;
  contains(value: string | number | boolean): PropertyCondition;
  exists(): PropertyCondition;
  notExists(): PropertyCondition;
}

/**
 * Fluent event predicate. The optional `.within(window)` precedes the terminal
 * (`b.event("x").within(days(7)).notExists()`) so every terminal still returns a
 * clean EventCondition POJO — no wrapper objects to unwrap.
 */
export interface EventMatcher {
  /** Constrain to a rolling window — this is what makes a bucket time-based. */
  within(window: DurationObject): EventMatcher;
  exists(): EventCondition;
  notExists(): EventCondition;
  count(operator: CountOperator, value: number): EventCondition;
  atLeast(value: number): EventCondition;
  moreThan(value: number): EventCondition;
  atMost(value: number): EventCondition;
  lessThan(value: number): EventCondition;
  exactly(value: number): EventCondition;
}

/**
 * The fluent builder passed to a `defineBucket` criteria function. Every terminal
 * returns a plain `ConditionEval` POJO — byte-identical to the declarative form —
 * so the registry indexes, schema validation, reconcile cron, and Studio all keep
 * working unchanged. The function runs ONCE, at bucket-definition time; it never
 * executes per-user, so criteria stays introspectable data.
 */
export interface CriteriaBuilder {
  prop(property: string): PropertyMatcher;
  event(eventName: string): EventMatcher;
  /** Composite AND over the given conditions. */
  all(...conditions: ConditionEval[]): CompositeCondition;
  /** Composite OR over the given conditions. */
  any(...conditions: ConditionEval[]): CompositeCondition;
}

class PropertyMatcherImpl implements PropertyMatcher {
  private readonly property: string;
  constructor(property: string) {
    this.property = property;
  }
  private make(
    operator: PropertyCondition["operator"],
    value?: string | number | boolean,
  ): PropertyCondition {
    return {
      type: "property",
      property: this.property,
      operator,
      ...(value !== undefined ? { value } : {}),
    };
  }
  eq(value: string | number | boolean): PropertyCondition {
    return this.make("eq", value);
  }
  neq(value: string | number | boolean): PropertyCondition {
    return this.make("neq", value);
  }
  gt(value: number): PropertyCondition {
    return this.make("gt", value);
  }
  gte(value: number): PropertyCondition {
    return this.make("gte", value);
  }
  lt(value: number): PropertyCondition {
    return this.make("lt", value);
  }
  lte(value: number): PropertyCondition {
    return this.make("lte", value);
  }
  contains(value: string | number | boolean): PropertyCondition {
    return this.make("contains", value);
  }
  exists(): PropertyCondition {
    return this.make("exists");
  }
  notExists(): PropertyCondition {
    return this.make("not_exists");
  }
}

class EventMatcherImpl implements EventMatcher {
  private readonly eventName: string;
  private readonly window?: DurationObject;
  constructor(eventName: string, window?: DurationObject) {
    this.eventName = eventName;
    this.window = window;
  }
  within(window: DurationObject): EventMatcher {
    return new EventMatcherImpl(this.eventName, window);
  }
  private make(
    check: EventCondition["check"],
    operator?: CountOperator,
    value?: number,
  ): EventCondition {
    return {
      type: "event",
      eventName: this.eventName,
      check,
      ...(operator !== undefined ? { operator } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(this.window !== undefined ? { within: this.window } : {}),
    };
  }
  exists(): EventCondition {
    return this.make("exists");
  }
  notExists(): EventCondition {
    return this.make("not_exists");
  }
  count(operator: CountOperator, value: number): EventCondition {
    return this.make("count", operator, value);
  }
  atLeast(value: number): EventCondition {
    return this.make("count", "gte", value);
  }
  moreThan(value: number): EventCondition {
    return this.make("count", "gt", value);
  }
  atMost(value: number): EventCondition {
    return this.make("count", "lte", value);
  }
  lessThan(value: number): EventCondition {
    return this.make("count", "lt", value);
  }
  exactly(value: number): EventCondition {
    return this.make("count", "eq", value);
  }
}

/**
 * The default {@link CriteriaBuilder} instance. `defineBucket` passes this to a
 * criteria function and stores the returned `ConditionEval`. Exported so it can
 * also be used standalone (e.g. composing reusable criteria fragments in tests).
 */
export const criteriaBuilder: CriteriaBuilder = {
  prop: (property) => new PropertyMatcherImpl(property),
  event: (eventName) => new EventMatcherImpl(eventName),
  all: (...conditions) => ({ type: "composite", operator: "and", conditions }),
  any: (...conditions) => ({ type: "composite", operator: "or", conditions }),
};
