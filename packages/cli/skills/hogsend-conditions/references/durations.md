# Durations — `DurationObject` & the helpers

Every "how long" in Hogsend is a `DurationObject`, never a magic string. You
build them with `days()`, `hours()`, `minutes()` from `@hogsend/core`
(re-exported by `@hogsend/engine`).

```ts
import { days, hours, minutes } from "@hogsend/core";
// or, alongside engine factories:
import { days, hours, minutes } from "@hogsend/engine";
```

## The shape

```ts
interface DurationObject {
  readonly hours?: number;
  readonly minutes?: number;
  readonly seconds?: number;
}
```

## The helpers (exact definitions)

```ts
days(n)    // => { hours: n * 24 }   — yes, days are expressed as hours
hours(n)   // => { hours: n }
minutes(n) // => { minutes: n }
```

So `days(7)` is `{ hours: 168 }`. There is no `days` field on `DurationObject`
— `days()` normalizes to `hours`. Don't hand-write the object; the helpers keep
intent readable and are what the codebase uses everywhere.

`durationToMs(d)` is the conversion used internally
(`hours*3_600_000 + minutes*60_000 + seconds*1_000`). You rarely call it
directly; it backs `ctx.sleep` and the `within` window math.

## Where durations are valid

A `DurationObject` is accepted anywhere the engine measures elapsed/remaining
time. The main spots a consumer touches:

| Location | Field | What it means |
|----------|-------|---------------|
| Journey meta | `suppress` | global cool-off after this journey runs |
| Journey meta | `entryPeriod` | window for `entryLimit: "once_per_period"` |
| Journey `run` | `ctx.sleep({ duration })` | durable wait inside a journey |
| Journey `run` | `ctx.history.hasEvent({ within })` | look-back window for an event check |
| Condition | `EventCondition.within` | rolling window on an `event` condition |
| Bucket meta | `entryPeriod` | window for the bucket's `entryLimit` |
| Bucket meta | `minDwell` / `maxDwell` | membership debounce floor / unconditional TTL |
| Bucket meta | `reconcileEvery` | advisory reconcile cadence (Studio display) |

```ts
// Journey meta
meta: {
  // ...
  entryLimit: "once_per_period",
  entryPeriod: days(3),
  suppress: hours(4),
}

// Inside run()
await ctx.sleep({ duration: hours(2), label: "initial-followup" });
const { found } = await ctx.history.hasEvent({
  userId: user.id,
  event: Events.CHECKOUT_COMPLETED,
  within: hours(26),
});

// On an event condition (bucket criteria)
{ type: "event", eventName: "app.active", check: "not_exists", within: days(7) }
```

## Composing values

The helpers each return a single-field object, so to express "90 minutes" use
`minutes(90)`, not `hours(1)` plus `minutes(30)` — there's no add helper. Pick
the largest single unit that reads cleanly:

```ts
minutes(90)   // 90 minutes
hours(36)     // a day and a half
days(14)      // two weeks
```

For the surfaces that consume these (journey orchestration, bucket dwell,
condition windows), see the hogsend-authoring-journeys and
hogsend-authoring-buckets skills.
