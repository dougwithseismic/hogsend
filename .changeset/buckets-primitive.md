---
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/engine": minor
"@hogsend/studio": minor
"create-hogsend": minor
---

Add Buckets — first-class, code-defined segments with real-time membership

`defineBucket()` introduces named membership groups as a peer primitive to
journeys. A user joins a bucket the moment their data satisfies its criteria and
leaves when it stops; each transition emits `bucket:entered` / `bucket:left`
(plus per-bucket aliases `bucket:entered:<id>` / `bucket:left:<id>`) through the
ingest pipeline, so a bucket join/leave can trigger a journey via the journey's
`trigger.event` (Hatchet `onEvents`). Criteria reuse the existing `@hogsend/core`
condition engine.

- `@hogsend/core` — `BucketMeta`, `bucketMetaSchema`, and `BucketRegistry`
  (event/property indexes for candidate narrowing).
- `@hogsend/db` — `bucket_memberships` (re-entry-safe partial unique active
  index) and `bucket_configs` tables on the engine migration track.
- `@hogsend/engine` — `defineBucket`, real-time inclusion/exclusion evaluation
  inside the ingest pipeline (recursion-guarded, transition-only emission), an
  engine-owned cron reconciliation for time-based/absence leaves, opt-in
  fast-expiry timers, backfill + criteria-change re-evaluation, admin routes
  (`/v1/admin/buckets`), an optional off-by-default PostHog person-property sync,
  and `buckets` / `ENABLED_BUCKETS` wiring on `createHogsendClient` and
  `createWorker`.
- `@hogsend/studio` — an observe-only Buckets view (size, enter/leave over time,
  which journeys a bucket feeds).
- `create-hogsend` — the scaffold template ships a `src/buckets/` example and the
  client/worker wiring.

All changes are additive; existing journeys, the engine factories, and consumer
types are unaffected. Consumers pick up a new engine-track migration applied by
the standard pre-deploy `db:migrate`.
