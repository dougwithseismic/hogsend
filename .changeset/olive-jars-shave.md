---
"@hogsend/core": minor
"@hogsend/engine": minor
---

`defineJourney` triggers now accept the bucket OBJECT, not just its event name:

```ts
const powerUsers = defineBucket({ meta: { id: "power-users", ... } });

defineJourney({
  meta: { ...meta, trigger: { bucket: powerUsers } },
  run,
});
```

This is a second spelling of the fix `trigger: { event: bucket.entered }`
already delivers, not a replacement for it — both resolve a real binding, so
both turn a renamed bucket into a build failure instead of a journey that
silently never fires. `{ bucket }` reads as the intent ("this journey is driven
by this bucket") and cannot be half-applied: `BucketTriggerRef.entered` is typed
`` `bucket:entered:${string}` ``, so a hand-rolled `{ entered: "user.created" }`
or a runtime-computed string is a compile error, and `defineJourney` re-checks
the same prefix at runtime for JS callers. Hand-authored string triggers are
untouched.

The sugar is resolved once, inside `defineJourney`, before the version hash is
computed — a desugared journey hashes byte-identically to the hand-authored
form, and the stored `JourneyMeta.trigger` stays the same plain `{ event }` the
registry, Hatchet routing, blueprints and Studio have always read. Declaring
both `event` and `bucket`, or neither, throws.

One thing that has NOT changed and is easy to get wrong: `trigger.where` still
narrows on the TRIGGERING EVENT's own properties. For a bucket transition that
payload is `bucketId`, `bucketName`, `userId`, `transition`, `source`,
`entryCount` (plus `reason` on a leave, `dwellCount` on a dwell) — not the
person's properties. `where: (b) => b.prop("plan").eq("pro")` on a bucket
trigger compiles and enrolls nobody. Person predicates belong in the bucket's
own `criteria`.
