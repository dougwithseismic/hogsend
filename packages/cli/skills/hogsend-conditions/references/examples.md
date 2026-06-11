# Copy-paste examples — `trigger.where`, `exitOn`, bucket `criteria`

Real, type-checked patterns built from the actual types and builder. Drop these
into `src/journeys/*.ts` and `src/buckets/*.ts`. Imports come from
`@hogsend/engine` / `@hogsend/core`; you never edit the engine.

---

## `trigger.where` — gate enrollment on event properties

`trigger.where` is a `PropertyCondition[]`. The conditions are AND-ed together
(`evaluatePropertyConditions` → `.every(...)`) against the TRIGGERING event's
properties. Only `property` conditions are valid here — there is no `within`,
no event count, no composite. (Need a count or a window? Put that logic in the
`run` body via `ctx.history.hasEvent`, or model it as a bucket.)

Author it either way — the builder form resolves once at `defineJourney` time
to the identical data (same machinery as bucket criteria):

```ts
// Builder form (recommended)
trigger: {
  event: Events.NPS_DETRACTOR,
  where: (b) => b.prop("score").lte(3),
},

// Multiple conditions: return an array (AND-ed)
trigger: {
  event: Events.CHECKOUT_ABANDONED,
  where: (b) => [b.prop("plan").eq("pro"), b.prop("cartValue").gte(100)],
},
```

```ts
import { days, hours } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "./constants/index.js";

export const proCheckoutAbandoned = defineJourney({
  meta: {
    id: "pro-checkout-abandoned",
    name: "Pro plan — checkout abandoned",
    enabled: true,
    trigger: {
      event: Events.CHECKOUT_ABANDONED,
      // only fire for high-value abandons
      where: [
        { type: "property", property: "plan", operator: "eq", value: "pro" },
        { type: "property", property: "cartValue", operator: "gte", value: 100 },
      ],
    },
    entryLimit: "once_per_period",
    entryPeriod: days(3),
    suppress: hours(4),
  },
  run: async (user, ctx) => {
    await ctx.sleep({ duration: hours(2), label: "nudge" });
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.CONVERSION_WINBACK_OFFER,
      subject: "Still thinking it over?",
      journeyName: user.journeyName,
    });
  },
});
```

---

## `exitOn` — leave the journey when a later event arrives

`exitOn` is an array of `{ event, where? }`. The engine matches the incoming
event name; if `where` is present it must pass (`PropertyCondition[]`, AND-ed)
for the exit to fire. Omit `where` to exit on the event name alone. The
builder form works here too: `where: (b) => b.prop("plan").eq("pro")`.

```ts
meta: {
  // ...
  exitOn: [
    // exit on any completed checkout
    { event: Events.CHECKOUT_COMPLETED },
    // exit on a subscription, but only if it's the pro plan
    {
      event: Events.SUBSCRIPTION_CREATED,
      where: [
        { type: "property", property: "plan", operator: "eq", value: "pro" },
      ],
    },
  ],
}
```

---

## Bucket `criteria` — the full condition engine

`criteria` is a single `ConditionEval` tree and accepts ALL FOUR types. Author
it with the fluent builder `(b) => ...` (preferred) or as a declarative POJO.
Both forms produce identical data. A dynamic bucket MUST have at least one
POSITIVE condition (a pure-negation tree is rejected at registration).

### Builder form (recommended)

```ts
import { days, defineBucket } from "@hogsend/engine";
import { Events } from "../journeys/constants/index.js";

// Lapsed-active: was active once, but NOT in the last 7 days.
export const wentDormant = defineBucket({
  meta: {
    id: "went-dormant",
    name: "Went dormant",
    enabled: true,
    timeBased: true,
    fastExpiry: true,
    criteria: (b) =>
      b.all(
        b.event(Events.APP_ACTIVE).exists(),                 // positive anchor
        b.event(Events.APP_ACTIVE).within(days(7)).notExists(), // windowed absence
      ),
  },
});
```

### Mixing all four types

```ts
import { days, defineBucket } from "@hogsend/engine";

export const atRiskPro = defineBucket({
  meta: {
    id: "at-risk-pro",
    name: "At-risk pro accounts",
    enabled: true,
    timeBased: true,
    criteria: (b) =>
      b.all(
        b.prop("plan").eq("pro"),                      // property
        b.event("app.active").within(days(14)).lessThan(3), // event count + window
        b.any(
          b.event("support.ticket").within(days(30)).exists(),
          // email_engagement has no builder terminal — drop the POJO in directly:
          { type: "email_engagement", templateKey: "renewal-reminder", check: "not_opened" },
        ),
      ),
  },
});
```

### Declarative form (identical result)

```ts
export const wentDormantDeclarative = defineBucket({
  meta: {
    id: "went-dormant",
    name: "Went dormant",
    enabled: true,
    timeBased: true,
    criteria: {
      type: "composite",
      operator: "and",
      conditions: [
        { type: "event", eventName: "app.active", check: "exists" },
        { type: "event", eventName: "app.active", check: "not_exists", within: days(7) },
      ],
    },
  },
});
```

---

## Reusable fragments via `criteriaBuilder`

Import the builder standalone to compose shared criteria pieces (handy in tests
or to DRY up several buckets):

```ts
import { criteriaBuilder as b, type ConditionEval } from "@hogsend/core";

const isPro: ConditionEval = b.prop("plan").eq("pro");
const wentQuiet = (window: ReturnType<typeof days>): ConditionEval =>
  b.event("app.active").within(window).notExists();

// use inside a bucket
criteria: (c) => c.all(isPro, wentQuiet(days(7))),
```

---

## Quick decision guide

- Gating who ENTERS a journey on event properties → `trigger.where`
  (`PropertyCondition[]`).
- Pulling someone OUT of a journey when a later event lands → `exitOn`
  (`{ event, where? }`, `where` is `PropertyCondition[]`).
- "Is the user in this segment right now?" with counts / windows / engagement →
  a bucket `criteria` tree (full `ConditionEval`). See the
  hogsend-authoring-buckets skill.
- A look-back check mid-journey (count or window) → `ctx.history.hasEvent` in
  the `run` body. See the hogsend-authoring-journeys skill.
- Confirm a condition is actually firing on a running instance → see the
  hogsend-cli skill.
