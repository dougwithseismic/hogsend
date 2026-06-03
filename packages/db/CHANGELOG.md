# @hogsend/db

## 0.2.0

### Minor Changes

- 31e5ed7: Add Buckets — first-class, code-defined segments with real-time membership

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
    fast-expiry timers, an unconditional `maxDwell` membership TTL (force-leave N
    after joining regardless of criteria; re-entry governed by `reentry`), backfill
    - criteria-change re-evaluation, admin routes (`/v1/admin/buckets`), an optional
      off-by-default PostHog person-property sync, and `buckets` / `ENABLED_BUCKETS`
      wiring on `createHogsendClient` and `createWorker`.
  - `@hogsend/studio` — an observe-only Buckets view (size, enter/leave over time,
    which journeys a bucket feeds).
  - `create-hogsend` — the scaffold template ships a `src/buckets/` example and the
    client/worker wiring.

  All changes are additive; existing journeys, the engine factories, and consumer
  types are unaffected. Consumers pick up a new engine-track migration applied by
  the standard pre-deploy `db:migrate`.

## 0.1.0

### Minor Changes

- 94a0bd4: Timezone-aware scheduling, send windows, and per-recipient frequency capping.

  - **`createHogsendClient({ defaults })`** — new `defaults.timezone` (global fallback IANA tz), `defaults.sendWindow` (quiet-hours window auto-applied by `ctx.when`), and `defaults.frequencyCap` (per-recipient send cap enforced in the mailer; "transactional" exempt by default).
  - **`ctx.when(...)`** on the journey context — resolves a send instant in the recipient's timezone and snaps it inside the configured send window.
  - **Timezone resolution** — new `resolveTimezone` / `resolveTimezoneWithSource` / `setContactTimezone` (`@hogsend/engine`) with a precedence chain (explicit → PostHog person props → `contacts.timezone` cache → global default), plus explicit-tz validation.
  - **`@hogsend/core/schedule`** — new public schedule module (window/time/tz resolvers).
  - **`isFrequencyCapped`** + `FrequencyCapConfig` / `FrequencyCapWindow` exports.

  Includes additive migration `0009` (expand-only): a nullable `contacts.timezone` column and an `email_sends` frequency-cap index. **After upgrading, run `db:migrate`** — the boot guard reports `schema.engine.inSync` until applied. No backfill required (the tz column is an opportunistic cache below PostHog/properties in precedence).
