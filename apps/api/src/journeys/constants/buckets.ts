// Typed bucket-id helpers (Section 4.5). These let a journey bind its
// `trigger.event` (or an `exitOn` rule) to a per-bucket transition alias —
// `bucket:entered:<id>` / `bucket:left:<id>` — with a typo caught at COMPILE
// time. `JourneyMeta.trigger.event` is typed `string`, so without this guard an
// unbound/typo alias would compile and silently never fire.
//
// `BucketId` is the union of the ids registered in `apps/api/src/buckets/index.ts`.
// Keep it in sync with the `buckets` array (Section 9.6 checklist, step 2): when
// you add a bucket, add its id here. (`defineBucket` widens `meta.id` to `string`,
// so an array-derived `(typeof buckets)[number]["meta"]["id"]` would collapse to
// `string` and lose typo-safety — hence this explicit literal union, the
// consumer's source of truth for the typed alias helpers.)
export type BucketId = "power-users" | "trial-expiring-soon" | "went-dormant";

// Narrow-alias helpers — ONLY accept a registered BucketId, so a typo such as
// `bucketEntered("went-dorment")` is a compile error rather than a silently
// never-firing trigger. The return type is the exact literal event name.
export const bucketEntered = <T extends BucketId>(id: T) =>
  `bucket:entered:${id}` as const;

export const bucketLeft = <T extends BucketId>(id: T) =>
  `bucket:left:${id}` as const;
