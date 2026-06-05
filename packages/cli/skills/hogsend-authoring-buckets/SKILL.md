---
name: hogsend-authoring-buckets
description: Use when adding or editing a real-time audience bucket in src/buckets/ — defineBucket() with a criteria condition tree, time-based rolling windows + reconcile, entryLimit, the hand-maintained BucketId literal-union typo-safety ritual, and binding journeys to bucket:entered / bucket:left triggers. Buckets wire into BOTH createHogsendClient and createWorker.
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Authoring Hogsend buckets

A **bucket** is a real-time, code-defined group of users — the peer of a
journey. A user JOINS the moment their data satisfies `meta.criteria` and LEAVES
when it stops. Each transition fires `bucket:entered:<id>` / `bucket:left:<id>`
through the same ingestion spine a journey trigger binds to, so buckets are how
you turn "who is in this audience right now" into "start/stop a flow".

This skill is for editing a scaffolded app's `src/buckets/` (content only). You
import `defineBucket` / `DefinedBucket` from `@hogsend/engine` and the condition
helpers / duration helpers from `@hogsend/core`. You never touch engine
internals — the engine owns the registry, the reconcile cron, and the backfill.

## Key concepts

- **`defineBucket({ meta })`** — returns a `DefinedBucket`. `meta.criteria` is the
  membership predicate, authored as a `ConditionEval` data tree OR a fluent
  `(b) => b.all(...)` builder function. Same condition system journeys use.
- **Real-time path** — on every ingested event the engine re-evaluates candidate
  buckets and writes/flips `bucket_memberships` rows, emitting transitions.
- **Time-based path** — `criteria` with a rolling `within` window (or `maxDwell`)
  can flip membership with NO inbound event; the engine-wide reconcile cron
  sweeps those leaves/joins on a cadence (default every 5 min).
- **`entryLimit` / `entryPeriod`** — gate when a RE-join re-emits `bucket:entered`.
- **The `BucketId` ritual** — a hand-maintained literal union in
  `src/journeys/constants/index.ts` plus `bucketEntered`/`bucketLeft` helpers that
  make a typo'd trigger binding a COMPILE error.
- **Dual wiring** — buckets thread into BOTH `createHogsendClient({ buckets })`
  (registry, real-time eval, reconcile) AND `createWorker({ buckets })`
  (fast-expiry timer task + boot backfill).

Criteria use the same 4-type condition engine (property / event /
email_engagement / composite) and the same `days()`/`hours()`/`minutes()`
duration helpers as journeys — see the hogsend-conditions skill for operator and
window semantics.

## Task playbooks — load the matching reference

- **Author / shape a bucket's `meta`** (id, criteria, time windows, entryLimit,
  dwell, fastExpiry) → `references/bucket-meta.md`
- **Keep trigger names typo-safe** (the `BucketId` union + `bucketEntered`/
  `bucketLeft` alias ritual and why it exists) → `references/bucket-id-aliases.md`
- **Decide bucket vs journey** (membership vs a one-shot durable flow; how
  `bucket:entered`/`bucket:left` drive journeys) → `references/buckets-vs-journeys.md`
- **Register + wire a bucket** (export from `src/buckets/index.ts`, thread into
  `createHogsendClient` AND `createWorker`, the reconcile cron) →
  `references/register-a-bucket.md`

## Golden rules

1. A `kind:"dynamic"` bucket (the default) REQUIRES `criteria`, and the criteria
   must contain at least one POSITIVE leaf — pure-negation criteria are rejected
   at registration. A windowed `event(...).within(W).notExists()` counts as a
   valid (time-bounded) anchor.
2. Never reference a `bucket:*` event name inside `criteria` — it is rejected at
   registration so transition rows can never satisfy a predicate.
3. Add the new id to the `BucketId` union the moment you add the bucket. Without
   it, a journey can bind to a misspelled alias that silently never fires.
4. Wire `buckets` into BOTH factories. The client without the worker means no
   reconcile/fast-expiry; the worker without the client means an empty registry.
