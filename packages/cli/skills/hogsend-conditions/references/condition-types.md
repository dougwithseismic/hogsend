# Condition types — exact shapes & operators

The condition system is the `ConditionEval` discriminated union from
`@hogsend/core` (re-exported by `@hogsend/engine`). Every condition is a plain
POJO discriminated by `type`. This is the canonical reference for the shapes,
operators, and how the engine evaluates each.

```ts
import type {
  ConditionEval,
  PropertyCondition,
  EventCondition,
  EmailEngagementCondition,
  CompositeCondition,
} from "@hogsend/core/types";
```

```ts
type ConditionEval =
  | PropertyCondition
  | EventCondition
  | EmailEngagementCondition
  | CompositeCondition;
```

---

## 1. `property` — `PropertyCondition`

Compares a single property value against an expected `value`.

```ts
interface PropertyCondition {
  type: "property";
  property: string;
  operator:
    | "eq"
    | "neq"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "exists"
    | "not_exists"
    | "contains";
  value?: string | number | boolean;
}
```

Operator semantics (from `conditions/property.ts`):

| operator | meaning | value type | notes |
|----------|---------|------------|-------|
| `eq` | `actual === value` | string \| number \| boolean | strict equality |
| `neq` | `actual !== value` | string \| number \| boolean | |
| `gt` / `gte` / `lt` / `lte` | numeric comparison | number | both sides must be `number`, else `false` |
| `exists` | value is not `undefined`/`null` | omit `value` | |
| `not_exists` | value is `undefined`/`null` | omit `value` | |
| `contains` | `actual.includes(value)` | string | both sides must be `string`, else `false` |

```ts
// Examples (declarative POJOs)
{ type: "property", property: "plan", operator: "eq", value: "pro" }
{ type: "property", property: "seats", operator: "gte", value: 5 }
{ type: "property", property: "company", operator: "exists" }
{ type: "property", property: "email", operator: "contains", value: "@acme.com" }
```

Used directly by `trigger.where` and `exitOn[].where` (both are
`PropertyCondition[]`, AND-ed via `evaluatePropertyConditions` — see
`references/examples.md`).

---

## 2. `event` — `EventCondition`

Counts occurrences of `eventName`, optionally inside a rolling `within` window,
and applies a `check`. This is the only type with a time window.

```ts
import type { DurationObject } from "@hogsend/core";

interface EventCondition {
  type: "event";
  eventName: string;
  check: "exists" | "not_exists" | "count";
  operator?: "gt" | "gte" | "lt" | "lte" | "eq"; // only with check:"count"
  value?: number;                                 // only with check:"count"
  within?: DurationObject;                        // rolling window, e.g. days(7)
}
```

How it evaluates (`conditions/event.ts`): it counts rows in `userEvents` for
the user matching `eventName`, restricted to `occurredAt >= now - within` when
`within` is set, then:

| `check` | matches when |
|---------|--------------|
| `exists` | `count > 0` |
| `not_exists` | `count === 0` |
| `count` + `operator`/`value` | `count <op> value` (`gt`/`gte`/`lt`/`lte`/`eq`) |
| `count` with no `operator`/`value` | falls back to `count > 0` |

`within` makes the condition time-based: in a bucket, a windowed event leg is
what the reconcile cron sweeps. See the hogsend-authoring-buckets skill for the
reconcile implications.

```ts
// Declarative
{ type: "event", eventName: "app.active", check: "exists" }
{ type: "event", eventName: "app.active", check: "not_exists", within: days(7) }
{ type: "event", eventName: "purchase", check: "count", operator: "gte", value: 3 }
```

---

## 3. `email_engagement` — `EmailEngagementCondition`

Checks the open/click state of the MOST RECENT send of a given template to the
user.

```ts
interface EmailEngagementCondition {
  type: "email_engagement";
  templateKey: string;
  check: "opened" | "clicked" | "not_opened" | "not_clicked";
}
```

How it evaluates (`conditions/email-engagement.ts`): finds the latest
`emailSends` row for the user + `templateKey`. If there is NO send, every check
returns `false`. Otherwise:

| `check` | matches when |
|---------|--------------|
| `opened` | `openedAt` is set |
| `clicked` | `clickedAt` is set |
| `not_opened` | `openedAt` is null |
| `not_clicked` | `clickedAt` is null |

`templateKey` is a key from your `src/emails/` template registry (the same
values you use in `Templates`).

```ts
{ type: "email_engagement", templateKey: "welcome", check: "not_opened" }
```

---

## 4. `composite` — `CompositeCondition`

AND / OR over child `ConditionEval`s. Children can themselves be composites
(nest freely).

```ts
interface CompositeCondition {
  type: "composite";
  operator: "and" | "or";
  conditions: ConditionEval[];
}
```

Short-circuit semantics (`conditions/composite.ts`): `and` returns `false` on
the first child that fails; `or` returns `true` on the first child that passes.

```ts
{
  type: "composite",
  operator: "and",
  conditions: [
    { type: "property", property: "plan", operator: "eq", value: "trial" },
    { type: "event", eventName: "app.active", check: "not_exists", within: days(7) },
  ],
}
```

---

## The fluent builder (bucket `criteria` only)

`defineBucket`'s `criteria` accepts either a `ConditionEval` POJO OR a function
`(b) => ConditionEval`, where `b` is the `CriteriaBuilder`. The builder runs
ONCE at definition time and returns the same POJO — it never executes per user.
You can also import `criteriaBuilder` standalone to compose reusable fragments.

```ts
import { criteriaBuilder } from "@hogsend/core";
```

```ts
interface CriteriaBuilder {
  prop(property: string): PropertyMatcher;
  event(eventName: string): EventMatcher;
  all(...conditions: ConditionEval[]): CompositeCondition; // composite "and"
  any(...conditions: ConditionEval[]): CompositeCondition; // composite "or"
}
```

`PropertyMatcher` terminals → `PropertyCondition`:

```ts
b.prop("plan").eq("pro")          // operator "eq"
b.prop("plan").neq("free")        // "neq"
b.prop("seats").gt(5)             // "gt"
b.prop("seats").gte(5)            // "gte"
b.prop("seats").lt(10)            // "lt"
b.prop("seats").lte(10)           // "lte"
b.prop("email").contains("@acme") // "contains"
b.prop("company").exists()        // "exists"
b.prop("company").notExists()     // "not_exists"
```

`EventMatcher` — optional `.within(window)` precedes the terminal; terminals →
`EventCondition`:

```ts
b.event("app.active").exists()                       // check "exists"
b.event("app.active").within(days(7)).notExists()    // check "not_exists" + window
b.event("purchase").count("gte", 3)                  // check "count", operator "gte"
b.event("purchase").atLeast(3)                       // count gte 3
b.event("purchase").moreThan(3)                      // count gt 3
b.event("purchase").atMost(3)                        // count lte 3
b.event("purchase").lessThan(3)                      // count lt 3
b.event("purchase").exactly(3)                       // count eq 3
```

There is no builder terminal for `email_engagement` — author those as POJOs
inside `b.all(...)` / `b.any(...)` when you need them.

---

## How conditions are evaluated

`evaluateCondition({ condition, ctx })` (`conditions/evaluate.ts`) is the engine
entry point; it dispatches on `condition.type`. The `ctx` is a
`ConditionContext`:

```ts
interface ConditionContext {
  db: Database;                          // event/engagement legs query this
  userId: string;
  journeyContext: Record<string, unknown>; // property legs read from here
}
```

You normally do NOT call `evaluateCondition` yourself — the engine runs it for
bucket `criteria`. For `trigger.where` / `exitOn[].where`, the engine uses
`evaluatePropertyConditions({ conditions, properties })`, which AND-s a
`PropertyCondition[]` against an event's properties (`.every(...)`). Knowing
which evaluator runs tells you which condition types a surface accepts (see
`references/examples.md`).
