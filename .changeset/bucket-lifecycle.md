---
"@hogsend/engine": minor
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/email": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/studio": minor
"create-hogsend": minor
---

Bucket lifecycle: colocated reactions + member access on `defineBucket`

- Typed transition refs `bucket.entered` / `bucket.left` (literal-typed off the
  bucket's own id) usable directly as journey `trigger` / `exitOn` values.
- Colocated reactions `bucket.on("enter" | "leave" | "dwell", opts?, handler)`
  that desugar to tagged durable journeys with the full `JourneyContext`.
- `dwell` reactions driven by the reconcile cron over the existing active
  population, with a historical `dwellAnchorAt` derived during backfill so dwell
  fires for the genuinely long-dwelling population on first deploy.
- Member access `bucket.count()` / `has()` / `members()` / `membersIterator()`.
- Studio groups generated reactions under their bucket via `sourceBucketId`.

Deprecates (kept for one release) the hand-maintained `BucketId` union and the
`bucketEntered` / `bucketLeft` string helpers in favour of the typed refs. The
scaffold drops the re-widening `DefinedBucket[]` annotation so literal ids infer.
