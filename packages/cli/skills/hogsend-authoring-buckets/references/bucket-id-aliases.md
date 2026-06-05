# The `BucketId` union + `bucketEntered` / `bucketLeft` ritual

When a user joins or leaves a bucket the engine emits a per-bucket ALIAS event:
`bucket:entered:<id>` / `bucket:left:<id>` (e.g. `bucket:entered:power-users`).
Journeys bind to those alias strings via `trigger.event`. The problem: a
journey's `trigger.event` is typed `string`, so a misspelled alias compiles fine
and the journey just silently never fires.

The fix is a hand-maintained literal union plus two typed helper functions, in
the CONSUMER's `src/journeys/constants/index.ts`. This is the ritual you MUST
keep in sync whenever you add or rename a bucket.

## The constants block

```ts
// src/journeys/constants/index.ts

/**
 * The union of bucket ids registered in src/buckets/index.ts. Keep this in sync
 * with the `buckets` array — it is what makes the alias helpers catch a typo at
 * COMPILE time.
 */
export type BucketId = "power-users";

// Narrow-alias helpers — ONLY accept a registered BucketId, so a typo such as
// bucketEntered("power-uesrs") is a compile error rather than a silently
// never-firing trigger. The return type is the EXACT literal event name, so it
// drops straight into a journey's trigger.event / exitOn rule.
export const bucketEntered = <T extends BucketId>(id: T) =>
  `bucket:entered:${id}` as const;

export const bucketLeft = <T extends BucketId>(id: T) =>
  `bucket:left:${id}` as const;
```

When you add a second bucket, the union grows by hand:

```ts
export type BucketId = "power-users" | "went-dormant";
```

## Why it MUST be a hand-written literal union

You might be tempted to derive the union from the `buckets` array:

```ts
// DON'T — this collapses to `string` and loses all typo-safety.
type BucketId = (typeof buckets)[number]["meta"]["id"];
```

`defineBucket` widens `meta.id` to `string` (`BucketMeta.id: string`), so an
array-derived union evaluates to `string`. Then `bucketEntered("anything")`
type-checks, and the whole guard is gone. The explicit literal union is the
source of truth precisely because it can't be widened.

## How journeys consume the helpers

The helpers return the exact literal, so they drop straight into a journey's
`trigger.event` (and `exitOn`):

```ts
import { hours } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { bucketEntered, bucketLeft, Templates } from "./constants/index.js";

export const winback = defineJourney({
  meta: {
    id: "winback",
    name: "Win-back",
    enabled: true,
    // Enroll the moment a user lands in the went-dormant bucket.
    trigger: { event: bucketEntered("went-dormant") },
    entryLimit: "once_per_period",
    // `suppress` is REQUIRED on every JourneyMeta — the re-entry cool-down.
    suppress: hours(24),
    // Pull them out the instant they re-activate (leave the bucket).
    exitOn: [{ event: bucketLeft("went-dormant") }],
  },
  run: async (user) => {
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: Templates.ACTIVATION_NUDGE,
      subject: "We miss you",
      journeyName: user.journeyName,
    });
  },
});
```

A typo'd id — `bucketEntered("went-dorment")` — is now a compile error.

## Generic forms vs aliases

The constants file also defines the GENERIC events:

```ts
export const Events = {
  // ...
  BUCKET_ENTERED: "bucket:entered",
  BUCKET_LEFT: "bucket:left",
} as const;
```

These fire for ANY bucket. The engine only emits the generic `bucket:entered` /
`bucket:left` when a journey actually binds to it (otherwise it's not written at
all). Prefer the narrowly-routed per-bucket aliases (`bucketEntered(id)`) for
real journey bindings — bind to the generic forms only if you genuinely want
"any bucket transition" routing.

## The checklist when adding a bucket

1. Add the `defineBucket(...)` in `src/buckets/`.
2. Add its `meta.id` literal to the `BucketId` union.
3. Register it in `src/buckets/index.ts` (see register-a-bucket).
4. Bind journeys with `bucketEntered("<id>")` / `bucketLeft("<id>")`.
