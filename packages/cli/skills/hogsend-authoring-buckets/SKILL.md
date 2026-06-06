---
name: hogsend-authoring-buckets
description: Use when adding or editing a real-time audience bucket in src/buckets/ — defineBucket() with a criteria condition tree, the typed bucket.entered / bucket.left transition refs used as journey trigger/exitOn, colocated bucket.on("enter"|"leave"|"dwell") reactions (dwell fires from the reconcile cron over the EXISTING population), member access (count/has/members/iterator), time-based rolling windows + reconcile, and entryLimit. Buckets wire into BOTH createHogsendClient and createWorker.
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

A bucket is no longer JUST a membership primitive: the object `defineBucket`
returns also carries **typed transition refs**, **colocated reactions**, and a
**member-access surface**. So one bucket file is where you declare the audience,
attach the behavior, and query it.

This skill is for editing a scaffolded app's `src/buckets/` (content only). You
import `defineBucket` / `DefinedBucket` (and `sendEmail`, duration helpers) from
`@hogsend/engine`, and the condition helpers from `@hogsend/core`. You never
touch engine internals — the engine owns the registry, the reconcile cron, the
backfill, and the reaction desugar.

## Key concepts

- **`defineBucket({ meta })`** — returns a `DefinedBucket<Id>` generic over the
  id literal. `meta.criteria` is the membership predicate, authored as a
  `ConditionEval` data tree OR a fluent `(b) => b.all(...)` builder function. Same
  condition system journeys use.
- **Typed transition refs** — `bucket.entered` (`` `bucket:entered:${Id}` ``) and
  `bucket.left` (`` `bucket:left:${Id}` ``) are literal-typed off the bucket's own
  id, computed synchronously at `defineBucket` time. Drop them straight into a
  journey's `trigger.event` / `exitOn`. **These are THE way to bind a journey to a
  bucket** — typo-safe by construction, no hand-maintained union.
- **Colocated reactions** — `bucket.on("enter" | "leave" | "dwell", opts?, handler)`.
  Each desugars to a real durable journey (a `defineJourney` output) tagged with
  `sourceBucketId`, triggered by the bucket's own transition event. The handler
  gets the FULL `JourneyContext` (sleep / when / waitForEvent / guard / history /
  trigger / identify) plus kind-specific read-only extras. `.on()` returns the
  bucket, so calls chain and the reaction ships with the bucket — no separate
  registration.
- **`dwell`** — fires from the reconcile cron (cron resolution, NOT instant) for
  members who have been CONTINUOUSLY in the bucket for `{ after }` / `{ every }`.
  Its edge over `on("enter") + ctx.sleep` is that it fires for the EXISTING
  population (backfill derives a historical anchor), so on first deploy it reaches
  people already long-resident.
- **Member access** — `bucket.count()` / `bucket.has(userId)` / `bucket.members({...})`
  / `bucket.membersIterator()`. Supabase-shaped `{ data, error }` results, keyset
  cursor, hard cap 100. NEVER an unbounded array.
- **Real-time path** — on every ingested event the engine re-evaluates candidate
  buckets and writes/flips `bucket_memberships` rows, emitting transitions.
- **Time-based path** — `criteria` with a rolling `within` window (or `maxDwell`)
  can flip membership with NO inbound event; the engine-wide reconcile cron
  sweeps those leaves/joins on a cadence (default every 5 min). The same cron runs
  the `dwell` pass.
- **`entryLimit` / `entryPeriod`** — gate when a RE-join re-emits `bucket:entered`.
- **Dual wiring** — buckets thread into BOTH `createHogsendClient({ buckets })`
  (registry, real-time eval, reconcile, reaction registration) AND
  `createWorker({ buckets })` (reaction tasks + fast-expiry timer + boot backfill).
  Reactions ship automatically on `bucket.reactions` — no separate registration —
  and are `ENABLED_BUCKETS`-gated, NOT `ENABLED_JOURNEYS`-gated.

Criteria and reaction `opts` use the same 4-type condition engine (property /
event / email_engagement / composite) and the same `days()`/`hours()`/`minutes()`
duration helpers as journeys — see the hogsend-conditions skill for operator and
window semantics.

## The shape, end to end

```ts
import { days, defineBucket, sendEmail } from "@hogsend/engine";
import { Events, Templates } from "../journeys/constants/index.js";

export const wentDormant = defineBucket({
  meta: {
    id: "went-dormant",
    name: "Went dormant",
    enabled: true,
    timeBased: true,
    fastExpiry: true,
    criteria: (b) =>
      b.all(
        b.event(Events.APP_ACTIVE).exists(),
        b.event(Events.APP_ACTIVE).within(days(7)).notExists(),
      ),
  },
});

// Colocated reaction — desugars to a durable journey owned by the bucket
// (grouped under it in Studio via sourceBucketId). `.on()` returns the bucket,
// so it ships with the bucket; no separate registration.
wentDormant.on("dwell", { after: days(30) }, async (user) => {
  await sendEmail({
    to: user.email,
    userId: user.id,
    journeyStateId: user.stateId,
    template: Templates.REACTIVATION_FINAL_NUDGE,
    subject: "Still here whenever you're ready",
    journeyName: user.journeyName,
  });
});

// Typed refs — bind a journey elsewhere to this bucket's transitions:
//   defineJourney({ meta: { trigger: { event: wentDormant.entered }, ... } })
//   defineJourney({ meta: { exitOn: [{ event: wentDormant.left }], ... } })
```

## Task playbooks — load the matching reference

- **Author / shape a bucket's `meta`** (id, criteria, time windows, entryLimit,
  dwell, fastExpiry) → `references/bucket-meta.md`
- **Bind a journey to a bucket** (the typed `bucket.entered`/`bucket.left` refs;
  the deprecated `BucketId` union + `bucketEntered`/`bucketLeft` legacy; the
  any-bucket generic `Events.BUCKET_ENTERED`/`BUCKET_LEFT`) →
  `references/bucket-id-aliases.md`
- **Decide bucket vs journey** (membership vs a one-shot durable flow; how
  `bucket:entered`/`bucket:left` drive journeys) → `references/buckets-vs-journeys.md`
- **Register + wire a bucket** (export from `src/buckets/index.ts`, thread into
  `createHogsendClient` AND `createWorker`, the reconcile cron, reaction
  registration) → `references/register-a-bucket.md`

## Colocated reactions — `bucket.on(kind, opts?, handler)`

A reaction is NOT an event-emitter listener. Each `.on()` desugars to ONE
canonical durable journey tagged `sourceBucketId` + `reactionKind`, triggered by
the bucket's own transition event. Because it IS a `defineJourney` output, it
inherits the entire enrollment guard stack, the active-state dedup (concurrent
transitions for one user serialize to a single live run), the durable context,
and event routing — there is no parallel execution path. A SECOND or DIVERGENT
reaction to the same transition is just a normal
`defineJourney({ trigger: { event: bucket.entered } })`, not a second `.on()`.

The handler is `(user, ctx)` — the same signature as a journey `run`. `ctx` is
the full `JourneyContext` PLUS kind-specific read-only extras (built by spread,
so the engine's canonical ctx is never mutated):

| kind | trigger event | ctx extras | options (`opts`) |
|------|---------------|------------|------------------|
| `enter` | `bucket.entered` | `entryCount: number`, `isFirstEntry: boolean` | optional `{ firstEntryOnly? }` |
| `leave` | `bucket.left` | `reason: "criteria" \| "maxDwell" \| "manual"` | optional `{ reason? }` (a reason or array) |
| `dwell` | cron, internal `bucket:dwell:<id>:<label>` | `dwellCount: number` | **mandatory** `{ after }` XOR `{ every }` |

```ts
wentDormant
  .on("enter", { firstEntryOnly: true }, async (user, ctx) => {
    // ctx.entryCount / ctx.isFirstEntry; full JourneyContext too
    await ctx.sleep({ duration: hours(1) });
    await sendEmail({ /* ... */ });
  })
  .on("leave", { reason: "criteria" }, async (user, ctx) => {
    // ctx.reason is "criteria" | "maxDwell" | "manual"
  })
  .on("dwell", { after: days(30) }, async (user, ctx) => {
    // ctx.dwellCount — see dwell semantics below
  });
```

`firstEntryOnly` and `reason` are FILTERS, never separate events — they run
inside `run` AFTER enrollment (a filtered-out transition still writes a short
active→completed `journeyStates` row). For `dwell` you MUST pass exactly one of
`after` / `every`; passing neither or both is a `TypeError`.

## `dwell` semantics (read before using it)

`dwell` is the headline reaction. It fires from the engine-wide reconcile cron
(`bucketReconcileTask`), so it is **cron-resolution, not instant** — a fire lands
within the `BUCKET_RECONCILE_CRON` cadence (default `*/5 * * * *`).

- **Continuous membership only.** It fires while the user has been CONTINUOUSLY a
  member. A leave-then-rejoin is a NEW membership row with a fresh clock; the
  dwell counter does not carry over.
- **Fires for the EXISTING population.** This is the entire reason to reach for
  `dwell` over `on("enter") + ctx.sleep(days(30))`. The sleep variant only clocks
  users who enter AFTER you deploy it; `dwell` reads `enteredAt` (and a
  backfill-derived historical `dwellAnchorAt`) over the active set, so on first
  deploy it reaches people already long-resident rather than starting everyone's
  clock at deploy time.
- **`{ after }`** is one-shot — fires once when the member has dwelt continuously
  for the duration. **`{ every }`** is recurring, coalescing — at most one fire
  per sweep, so a multi-interval outage produces a single catch-up fire, not a
  backlog.
- **`ctx.dwellCount`** is the elapsed-interval ordinal
  (`floor((now - anchor) / interval)`), NOT a count of actual fires — it is
  gap-stable and equals the number of elapsed periods even across an outage. For
  `after` it is always `1`.
- **Idempotent** across sweeps (per-membership bookkeeping) and interop-correct
  with `maxDwell` / `fastExpiry` (a member force-left by the TTL/expiry pass is
  excluded). A bucket with `after >= maxDwell` simply never dwells (the member
  leaves first).

## Member access — never an unbounded array

The bucket object exposes a read surface over its active members. Every method is
`{ data, error }`-shaped (no throws; failures land in `error`), GDPR-joined to
live contacts, and hard-capped at 100 rows per page.

```ts
const { data: total } = await wentDormant.count();          // number | null
const { data: isMember } = await wentDormant.has(userId);   // boolean
const page = await wentDormant.members({ limit: 50 });      // { data, error, count, cursor }
for await (const m of wentDormant.membersIterator()) { /* paged internally */ }
```

- `count()` — one authoritative head-count `{ data, error }`.
- `has(userId)` — O(1) active-membership probe `{ data, error }`.
- `members({ limit?, cursor? })` — a single page `{ data, error, count, cursor }`.
  Keyset cursor on `id` (opaque UUID order, NOT chronological); `cursor` is `null`
  when exhausted. `count` here is a per-call snapshot that can drift under churn —
  use `count()` for a single authoritative number.
- `membersIterator({ pageSize? })` — the only full-population walk; bounded
  page-by-page internally (throws on a page error).

## Studio grouping

A generated reaction carries `sourceBucketId` on its journey meta, so the admin
bucket-detail view groups it UNDER its bucket, tagged `owned: true`. A journey
that binds externally via `bucket.entered` / `bucket.left` (or the generic
`Events.BUCKET_ENTERED`/`BUCKET_LEFT`) shows up there too, tagged `owned: false`.
You don't wire any of this — it falls out of the desugar tagging.

## Golden rules

1. A `kind:"dynamic"` bucket (the default) REQUIRES `criteria`, and the criteria
   must contain at least one POSITIVE leaf — pure-negation criteria are rejected
   at registration. A windowed `event(...).within(W).notExists()` counts as a
   valid (time-bounded) anchor.
2. Never reference a `bucket:*` event name inside `criteria` — it is rejected at
   registration so transition rows can never satisfy a predicate.
3. Bind journeys with the typed refs `bucket.entered` / `bucket.left` — they are
   literal-typed off the bucket id and typo-safe by construction. The
   `bucketEntered("id")`/`bucketLeft("id")` string helpers and the hand-maintained
   `BucketId` union are DEPRECATED (kept one release for back-compat). For an
   any-bucket binding, `Events.BUCKET_ENTERED` / `Events.BUCKET_LEFT` remain the
   sanctioned generic surface (not deprecated).
4. Reach for `dwell` only when you need the EXISTING population and
   cron-resolution timing is acceptable; otherwise `on("enter") + ctx.sleep` is a
   simpler per-user durable timer.
5. Member access is read-only and paged — never load all members into an array;
   use `count()`/`has()` for probes and the iterator for a full walk.
6. Wire `buckets` into BOTH factories. The client without the worker means no
   reconcile/fast-expiry/dwell and no reaction tasks; the worker without the
   client means an empty registry. Reactions ship on `bucket.reactions`
   automatically and are `ENABLED_BUCKETS`-gated.
