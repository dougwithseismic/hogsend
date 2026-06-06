# Binding a journey to a bucket — typed refs (and the deprecated ritual)

When a user joins or leaves a bucket the engine emits a per-bucket ALIAS event:
`bucket:entered:<id>` / `bucket:left:<id>` (e.g. `bucket:entered:power-users`).
Journeys bind to those alias strings via `trigger.event`. The problem: a
journey's `trigger.event` is typed `string`, so a misspelled alias compiles fine
and the journey just silently never fires.

The fix is no longer a hand-maintained union — it is built into the bucket
object. `defineBucket` is generic over the id literal (`DefinedBucket<Id>`), so
the bucket exposes two **typed transition refs** computed synchronously at
`defineBucket` time:

```ts
wentDormant.entered; // typed `"bucket:entered:went-dormant"`
wentDormant.left;    // typed `"bucket:left:went-dormant"`
```

These are literal-typed off the bucket's own `meta.id`, so binding to them is
typo-safe by construction — there is nothing to keep in sync. This is THE way to
bind a journey to a bucket.

## Use the typed refs in `trigger.event` / `exitOn`

Import the bucket and read `.entered` / `.left` directly:

```ts
import { hours } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";
import { wentDormant } from "../buckets/went-dormant.js"; // leaf module — see below
import { Templates } from "./constants/index.js";

export const winback = defineJourney({
  meta: {
    id: "winback",
    name: "Win-back",
    enabled: true,
    // Enroll the moment a user lands in the went-dormant bucket.
    trigger: { event: wentDormant.entered },
    entryLimit: "once_per_period",
    // `suppress` is REQUIRED on every JourneyMeta — the re-entry cool-down.
    suppress: hours(24),
    // Pull them out the instant they re-activate (leave the bucket).
    exitOn: [{ event: wentDormant.left }],
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

The refs are byte-identical to the alias the engine emits, so this is a drop-in
for the old helper return value — only typo-safer. A typo'd ref —
`wentDormant.entred` — is now a compile error.

## Import the bucket from its LEAF module, not the barrel

When you read `wentDormant.left` at module-eval inside a top-level
`defineJourney({ exitOn: [{ event: wentDormant.left }] })`, importing the bucket
from the `../buckets/index.js` barrel creates a real ESM cycle
(`journeys/index → this-journey → buckets/index → went-dormant → journeys/constants`).
Import the bucket from its **leaf module** (`../buckets/went-dormant.js`)
instead — that keeps the whole bucket barrel out of the journey-barrel cycle. The
refs themselves are safe to read at module-eval because they are pure string
concatenation of `meta.id` with no live cross-module value binding, but the leaf
import keeps the cycle from forming at all.

## Generic forms vs per-bucket refs

The constants file also defines the GENERIC events:

```ts
export const Events = {
  // ...
  BUCKET_ENTERED: "bucket:entered",
  BUCKET_LEFT: "bucket:left",
} as const;
```

These fire for ANY bucket and are the **sanctioned generic-binding surface — NOT
deprecated**. The engine only emits the generic `bucket:entered` / `bucket:left`
when a journey actually binds to it (otherwise it's not written at all). The rule:

- **Per-bucket** (this audience specifically) → `bucket.entered` / `bucket.left`.
- **Any-bucket** (any transition, whichever bucket) → `Events.BUCKET_ENTERED` /
  `Events.BUCKET_LEFT`.

## DEPRECATED — the `BucketId` union + `bucketEntered`/`bucketLeft` helpers

The old path was a hand-maintained literal union plus two helper functions in
`src/journeys/constants/`:

```ts
/** @deprecated Use the typed ref `bucket.entered` / `bucket.left`. */
export type BucketId = "power-users" | "went-dormant";
/** @deprecated Use `bucket.entered` (e.g. `wentDormant.entered`). */
export const bucketEntered = <T extends BucketId>(id: T) =>
  `bucket:entered:${id}` as const;
/** @deprecated Use `bucket.left` (e.g. `wentDormant.left`). */
export const bucketLeft = <T extends BucketId>(id: T) =>
  `bucket:left:${id}` as const;
```

These are **deprecated and kept for ONE release for back-compat, then removed.**
They still work and return the byte-identical alias, but they require you to
hand-maintain the `BucketId` union in lockstep with the `buckets` array — exactly
the chore the typed refs eliminate. Do NOT reach for them in new code; migrate
existing `bucketEntered("id")` / `bucketLeft("id")` bindings to `bucket.entered` /
`bucket.left` (importing the bucket from its leaf module).

> Why the union could never just be derived from the array:
> `defineBucket` widens `meta.id` to `string` on the base `DefinedBucket` type, so
> `(typeof buckets)[number]["meta"]["id"]` collapses to `string` and loses all
> typo-safety. The typed refs sidestep this entirely by keeping the `Id` literal
> on `DefinedBucket<Id>` and deriving the ref type from it — provided the consumer
> doesn't re-widen the array with a `DefinedBucket[]` annotation (see
> register-a-bucket).

## The checklist when adding a bucket

1. Add the `defineBucket(...)` in `src/buckets/`.
2. Register it in `src/buckets/index.ts` (see register-a-bucket).
3. Bind journeys with the typed refs `bucket.entered` / `bucket.left` (import the
   bucket from its leaf module), or `Events.BUCKET_ENTERED`/`BUCKET_LEFT` for an
   any-bucket binding.
