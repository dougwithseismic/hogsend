# Authoring a bucket's `meta`

A bucket is `defineBucket({ meta })`. The `meta` (a `BucketMeta`) is the whole
declaration — the engine derives everything (registry indexes, reconcile
behavior, Studio size) from it. This is the field-by-field guide.

```ts
import { defineBucket } from "@hogsend/engine";
import { days } from "@hogsend/core";
import { Events } from "../journeys/constants/index.js";

export const powerUsers = defineBucket({
  meta: {
    id: "power-users",                 // also the alias suffix: bucket:entered:power-users
    name: "Power users",
    description: "Used the key feature 10+ times in the last 30 days.",
    enabled: true,
    timeBased: true,                    // rolling window → reconcile owns the leave
    entryLimit: "once_per_period",
    entryPeriod: { hours: 24 * 7 },     // 7-day cooldown before a re-emit
    criteria: {
      type: "event",
      eventName: Events.FEATURE_USED,
      check: "count",
      operator: "gte",
      value: 10,
      within: days(30),                 // makes the bucket time-based
    },
  },
});
```

## The fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` (required) | Stable identity AND the alias suffix. Changing it makes a NEW bucket. Keep it in the `BucketId` union (see bucket-id-aliases). |
| `name` | `string` (required) | Human label, surfaced in Studio + the emitted `bucketName`. |
| `description` | `string?` | Free text. |
| `enabled` | `boolean` (required) | Static load-time on/off (guard #1), mirrors a journey's `enabled`. A disabled bucket is not registered. |
| `kind` | `"dynamic" \| "manual"?` | Defaults `"dynamic"`. `"manual"` is REJECTED at registration in v1 — always use dynamic + `criteria`. |
| `criteria` | `ConditionEval?` | The membership predicate. REQUIRED for dynamic buckets. |
| `entryLimit` | `"once" \| "once_per_period" \| "unlimited"?` | Defaults `"unlimited"`. Gates re-EMISSION of `bucket:entered` on a re-join. |
| `entryPeriod` | `DurationObject?` | The cooldown for `"once_per_period"`: re-emit only once this elapses since the prior LEAVE. |
| `minDwell` | `DurationObject?` | Anti-flap floor: defer (never drop) `bucket:left` until membership is at least this old. |
| `maxDwell` | `DurationObject?` | Unconditional membership TTL: force-leave N after join REGARDLESS of criteria. |
| `timeBased` | `boolean?` | Marks that a clock (not an event) can flip membership. Inferred from a `within` window if omitted; set it explicitly for clarity. |
| `reconcileEvery` | `DurationObject?` | Advisory cadence surfaced in Studio (one engine-wide cron sweeps all time-based buckets; this is informational). |
| `reconcileJoins` | `boolean?` | Tri-state. `false` = hard off; `true` = explicit on; `undefined` = inferred on only for safe absence shapes. See "Time-based" below. |
| `fastExpiry` | `boolean?` | Opt-in per-user durable timer for sub-second absence leaves. Defaults `false`; cron is the backstop. Requires worker wiring. |
| `syncToPostHog` | `boolean?` | Mirror membership to a PostHog person property on join/leave. Off by default; no-op without `POSTHOG_API_KEY`. |
| `postHogPropertyKey` | `string?` | Override the synced property name (default `hogsend_bucket_<id>`). |

## `criteria` — two authoring forms

Both forms produce the SAME `ConditionEval` data. The builder runs ONCE at
definition time and is resolved to declarative data by `defineBucket`, so the
registry / schema / reconcile only ever see the canonical tree.

**Declarative tree** (a `ConditionEval`):

```ts
criteria: {
  type: "composite",
  operator: "and",
  conditions: [
    { type: "property", property: "plan", operator: "eq", value: "pro" },
    {
      type: "event",
      eventName: Events.FEATURE_USED,
      check: "count",
      operator: "gte",
      value: 5,
      within: days(14),
    },
  ],
}
```

**Fluent builder** — `criteria` accepts `(b: CriteriaBuilder) => ConditionEval`:

```ts
criteria: (b) =>
  b.all(
    b.prop("plan").eq("pro"),
    b.event(Events.FEATURE_USED).within(days(14)).atLeast(5),
  ),
```

Builder surface: `b.prop(name)` → `.eq/.neq/.gt/.gte/.lt/.lte/.contains/.exists/.notExists`;
`b.event(name)` → optional `.within(window)` then a terminal
`.exists()/.notExists()/.count(op, n)/.atLeast(n)/.moreThan(n)/.atMost(n)/.lessThan(n)/.exactly(n)`;
`b.all(...)`/`b.any(...)` for AND/OR composites.

For the full operator table, window semantics, and how `event` count/within
windows evaluate, see the hogsend-conditions skill — bucket criteria are the
exact same condition system.

## Registration validation (fail-fast rules)

`BucketRegistry.register()` runs `bucketMetaSchema.parse()`, so these throw at
client/worker boot, not silently:

- **At least one positive leaf.** A dynamic bucket whose every leaf is negative
  (`property neq`/`not_exists`, `event not_exists` with NO `within`,
  `email_engagement not_opened`/`not_clicked`) is degenerate. Exception: an
  `event ... not_exists` WITH a `within` window is a valid time-bounded dormancy
  anchor and counts as legitimate.
- **No reserved event names.** No `EventCondition.eventName` may start with
  `bucket:` — transition rows must never satisfy a predicate.
- **No `email_engagement` in v1.** Engagement conditions are not allowed in
  bucket criteria (they ARE allowed in journey conditions).
- **`maxDwell >= minDwell`** when both are set.
- **`kind:"manual"` is rejected.** Use `kind:"dynamic"`.

## Time-based buckets (rolling windows + reconcile)

A `within` window means a user can fall OUT with no inbound event (the window
just rolls past). The real-time path structurally can't catch that, so the
engine-wide reconcile cron sweeps every time-based dynamic bucket and leaves
members whose criteria no longer hold.

- **Leaves** are handled automatically for any time-based bucket — no extra
  config. The 30-day `power-users` example above leaves a user the moment they
  drop below 10 uses in the trailing 30 days, swept by the cron.
- **Absence joins** (a user who STOPPED doing X fires no event) need the cron to
  materialize the join. `reconcileJoins` is INFERRED on for the two safe
  set-based absence shapes — a single windowed `event(X).within(W).notExists()`,
  and the lapsed-active composite `all(event(X).exists(), event(X).within(W).notExists())`.
  Any other absence-containing composite (OR-of-absence, absence mixed with
  property/count) needs an explicit `reconcileJoins: true`.
- **`maxDwell`** is a hard time-box independent of criteria — pair with
  `entryLimit:"once"`/`"once_per_period"` for "in for exactly N then out", or
  leave the default `"unlimited"` for a periodic flush (re-join on next
  qualifying event).
- **`fastExpiry: true`** arms a per-user durable timer so the leave lands
  sub-second instead of waiting for the next cron tick. It needs the bucket
  wired into `createWorker` (see register-a-bucket); the cron is still the
  authoritative backstop.

Reconcile cadence is the `BUCKET_RECONCILE_CRON` env var (default `*/5 * * * *`),
so time-based exits land within that cadence, not to-the-second.
