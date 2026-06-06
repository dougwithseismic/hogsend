# Bucket Lifecycle — Implementation Design (Final)

Status: design finalized. This is the implementable spec. It folds in four adversarial
critiques; every blocker and major issue is resolved inline (search for **RESOLUTION**).
All event-name literals, idempotency keys, db columns, and guard semantics below were
verified byte-for-byte against the live engine code.

---

## 1. Overview

This adds a colocated reaction + member-access API to `defineBucket`, so a bucket is no
longer just a membership primitive but the unit you also attach behavior and queries to:

- **Typed transition refs** `bucket.entered` / `bucket.left` (literal-typed event names)
  that replace the hand-maintained `BucketId` union and the `bucketEntered`/`bucketLeft`
  string helpers — usable as `trigger` / `exitOn` values in `defineJourney`.
- **Colocated reactions** `bucket.on("enter" | "leave" | "dwell", opts?, handler)` —
  each desugars to a real durable journey (a `defineJourney` output) tagged with
  `sourceBucketId`, triggered by the bucket's own transition events. The handler gets the
  full `JourneyContext` (sleep / when / waitForEvent / guard / history / trigger /
  identify) plus reaction-specific read-only extras.
- **`dwell`** reactions that fire from the reconcile cron (cron resolution, not instant)
  over the EXISTING active population by reading `enteredAt`, idempotent across sweeps.
- **Member access** `bucket.count()` / `bucket.has(userId)` / `bucket.members({...})` plus
  an async iterator — never an unbounded array.
- **Studio grouping** — generated reaction journeys carry `sourceBucketId` so the admin
  bucket-detail view groups them under their bucket, tagged owned vs externally-bound.

`expiring` reactions are **deferred** (see Open Questions / Future).

The design's central correctness principle: a reaction is a normal `defineJourney` output.
It inherits the entire enrollment guard stack, the active-state dedup, the durable
context, and routing for free — there is no parallel execution path and no listener pile.
A second or divergent reaction to the same transition is just a hand-written
`defineJourney({ trigger: bucket.entered })`.

---

## 2. The DECIDED API (agreed, not relitigated)

```ts
// Membership primitive — now generic over the id literal, with colocated reactions
// and member access on the returned object.
const wentDormant = defineBucket({
  meta: {
    id: "went-dormant",
    name: "Went dormant",
    criteria: (b) => b.all(
      b.event("app_opened").exists(),
      b.event("app_opened").within(days(30)).notExists(),
    ),
    maxDwell: days(90),
  },
});

// 1. Typed transition refs — literal "bucket:entered:went-dormant" / "bucket:left:..."
wentDormant.entered; // "bucket:entered:went-dormant"
wentDormant.left;    // "bucket:left:went-dormant"

// Usable as trigger / exitOn:
defineJourney({ meta: { trigger: { event: wentDormant.entered }, /* ... */ } });
defineJourney({ meta: { exitOn: [{ event: wentDormant.left }], /* ... */ } });

// 2. Colocated reactions — desugar to tagged durable journeys, full JourneyContext
wentDormant
  .on("enter", async (user, ctx) => {
    if (!ctx.isFirstEntry) return;             // entryCount / isFirstEntry on ctx
    await ctx.sleep({ duration: hours(1) });
    await sendEmail({ to: user.email, template: Templates.WIN_BACK });
  })
  .on("leave", { reason: "criteria" }, async (user, ctx) => {
    // ctx.reason is "criteria" | "maxDwell" | "manual"
  })
  .on("dwell", { after: days(7) }, async (user, ctx) => {
    // fires from the cron for members continuously dormant ≥ 7 days; ctx.dwellCount
  });

// 3. Member access — never an unbounded array
const { data: total } = await wentDormant.count();          // { data, error }
const { data: isMember } = await wentDormant.has(userId);   // { data, error }
const page = await wentDormant.members({ limit: 50 });      // { data, error, count, cursor }
for await (const m of wentDormant.membersIterator()) { /* paged internally */ }
```

`.on()` returns the bucket for chaining. There is no `.subscribe()` step — registration is
declarative and happens at module load.

---

## 3. Resolved decisions (1–7)

### Decision 1 — `defineBucket` stays the primitive; reactions are colocated

`defineBucket` becomes generic over the id literal (`const Id`) so `bucket.entered` /
`bucket.left` are literal-typed. The returned object gains `entered`, `left`, `reactions`,
`count`, `has`, `members`, `membersIterator`, and `on()`. The existing `task?` slot is
reserved for the shared fast-expiry timer and is untouched; reactions live in a separate
`reactions: DefinedJourney[]` array.

### Decision 2 — typed refs replace the string helpers + the `BucketId` union

`bucket.entered` = `` `bucket:entered:${Id}` ``, `bucket.left` = `` `bucket:left:${Id}` ``,
derived from the bucket's own id. Byte-identical to `emitBucketTransition`'s
`` `bucket:${kind}:${bucket.id}` `` (verified: `lib/bucket-emit.ts:81`).

Back-compat: **deprecate for one release, do not hard-remove.** The string helpers
(`bucketEntered`/`bucketLeft`) and `BucketId` are duplicated in the scaffold and are a
published surface; a `@deprecated` shim is the release-safe path. `reactivation-dormancy.ts`
migrates to `wentDormant.left`.

> **RESOLUTION (api-critique major — ESM cycle footgun).** Importing `wentDormant.left`
> into `reactivation-dormancy.ts` from `../buckets/index.js` and reading it at
> module-eval (inside the top-level `defineJourney({ exitOn: [{ event: wentDormant.left }] }}`)
> creates a real cycle: `journeys/index → reactivation-dormancy → buckets/index →
> went-dormant → journeys/constants/index`. It happens to work only because the entry
> files import `buckets/index` before `journeys/index`. To remove the hazard, the typed
> refs are computed from the bucket id **synchronously at `defineBucket` call time** (they
> are pure string concatenation of `meta.id`, with no live cross-module value binding), and
> `reactivation-dormancy.ts` imports the bucket directly from its **leaf module**
> (`../buckets/went-dormant.js`), NOT the barrel `../buckets/index.js`. Importing the leaf
> avoids pulling the whole bucket barrel into the journey-barrel cycle. We ALSO add a
> standalone-import smoke test (Test 31) that imports each journey module in isolation and
> asserts every `trigger.event` / `exitOn[].event` is a non-empty string — converting any
> future TDZ/undefined regression into a red test rather than a journey that never fires.

### Decision 3 — `bucket.on(kind, opts?, handler)` desugars to one canonical durable journey

Each reaction is a real `defineJourney` output tagged with `sourceBucketId` and
`reactionKind`. One canonical inline reaction per transition; a divergent one is a normal
`defineJourney`. `enter` ctx exposes `entryCount` / `isFirstEntry`; `leave` ctx exposes
`reason: "criteria" | "maxDwell" | "manual"`. "Reenter" and "expired" are filters
(`firstEntryOnly`, `reason`), never separate events.

> **RESOLUTION (api-critique major — ctx mutation).** The handler ctx is built by
> **spread**, not `Object.assign` mutation of the engine's canonical ctx:
> `const reactionCtx = { ...ctx, entryCount, isFirstEntry }`. This yields a fresh object
> of type `JourneyContext & ReactionExtras<K>` without touching the object the engine
> created (which is shared/closed and could be frozen). The extras are read-only data, the
> method references are preserved by the spread.

> **RESOLUTION (api-critique minor — `normalizeOnArgs` unspecified).** Discriminate on
> `typeof a`: if `a` is a function it is the handler (opts undefined); if `a` is an object
> it is opts and `b` is the handler. For `kind === "dwell"`, opts is mandatory and must
> carry exactly one of `after` / `every` — throw a `TypeError` otherwise. Unit-tested per
> arity (Test 8b).

> **RESOLUTION (api-critique minor — `suppress: {}`).** Reaction metas set
> `suppress: { seconds: 0 }` with a comment: reactions intentionally have no re-entry
> suppression — re-entry is a filter (`entryCount`), not a cool-down. `entryLimit` is
> `"unlimited"` for the same reason.

### Decision 4 — `dwell` via the reconcile cron, idempotent, continuous-membership-gated

`bucket.on("dwell", { after } | { every }, handler)` fires from `bucketReconcileTask` at
cron resolution, reading `enteredAt` over the EXISTING active population — its unique value
over `on("enter") + ctx.sleep`. It interoperates with `maxDwell`/fastExpiry and is
idempotent across sweeps. See §6 for the full mechanism and the three blocker resolutions
(emit path, retry-loss, first-deploy `enteredAt`).

### Decision 5 — generated reactions carry `sourceBucketId`; Studio groups them

Reaction metas carry `sourceBucketId` + `reactionKind` (+ `dwellSchedule` for dwell). The
admin bucket-detail route discovers owned reactions by `sourceBucketId` and surfaces
externally-bound journeys via the existing alias cross-reference, tagged `owned: false`.

> **RESOLUTION (worker-critique blocker — schema strip).** `JourneyRegistry.register` runs
> `journeyMetaSchema.parse` (verified `core/registry/index.ts:15`), a plain `z.object`
> that STRIPS unknown keys. The new fields MUST be added to `journeyMetaSchema` or the
> dwell-cron lookup AND Studio grouping silently break. They are added (§7) with a
> round-trip regression test (Test 13b).

### Decision 6 — member access: `count` / `has` / `members` / iterator, never unbounded

Supabase-shaped `{ data, error, count, cursor }`, keyset cursor on `id`, hard cap 100. See
§8 and its db-injection / churn resolutions.

### Decision 7 — `expiring` deferred

Not in this build. Documented as future in Open Questions.

---

## 4. `defineBucket` generic + the reaction/access surface

File: `packages/engine/src/buckets/define-bucket.ts` (rewrite of the type surface; the
runtime criteria-resolution stays identical).

```ts
import type { DurationObject } from "@hogsend/core";
import { type CriteriaBuilder, criteriaBuilder } from "@hogsend/core";
import type { BucketMeta, ConditionEval } from "@hogsend/core/types";
import type { DefinedJourney } from "../journeys/define-journey.js";
import type { hatchet } from "../lib/hatchet.js";
import {
  type BucketOnHandler,
  buildBucketReaction,
  normalizeOnArgs,
} from "./bucket-reactions.js";
import { type BucketAccessor, createBucketAccessor } from "./bucket-access.js";

export type CriteriaInput =
  | ConditionEval
  | ((b: CriteriaBuilder) => ConditionEval);

export type BucketMetaInput<Id extends string = string> = Omit<
  BucketMeta,
  "criteria" | "id"
> & { id: Id; criteria?: CriteriaInput };

export type DwellOptions =
  | { after: DurationObject; every?: never }
  | { every: DurationObject; after?: never };

export interface DefinedBucket<Id extends string = string> {
  meta: BucketMeta;
  readonly entered: `bucket:entered:${Id}`;
  readonly left: `bucket:left:${Id}`;
  /** Reserved for the shared fast-expiry timer (selectBucketTasks). */
  task?: ReturnType<typeof hatchet.durableTask>;
  /** Reaction journeys generated by `.on()`. Read by the worker + container. */
  reactions: DefinedJourney[];
  count: BucketAccessor["count"];
  has: BucketAccessor["has"];
  members: BucketAccessor["members"];
  membersIterator: BucketAccessor["membersIterator"];
  on(kind: "enter", handler: BucketOnHandler<"enter">): DefinedBucket<Id>;
  on(kind: "enter", opts: EnterOptions, handler: BucketOnHandler<"enter">): DefinedBucket<Id>;
  on(kind: "leave", handler: BucketOnHandler<"leave">): DefinedBucket<Id>;
  on(kind: "leave", opts: LeaveOptions, handler: BucketOnHandler<"leave">): DefinedBucket<Id>;
  on(kind: "dwell", opts: DwellOptions, handler: BucketOnHandler<"dwell">): DefinedBucket<Id>;
}

export function defineBucket<const Id extends string>(options: {
  meta: BucketMetaInput<Id>;
}): DefinedBucket<Id> {
  const { criteria, ...rest } = options.meta;
  const meta: BucketMeta = {
    ...rest,
    criteria: typeof criteria === "function" ? criteria(criteriaBuilder) : criteria,
  };

  // Pure string derivation — synchronous, no cross-module value binding (the cycle
  // resolution): entered/left are stable the instant defineBucket returns.
  const entered = `bucket:entered:${meta.id}` as `bucket:entered:${Id}`;
  const left = `bucket:left:${meta.id}` as `bucket:left:${Id}`;
  const reactions: DefinedJourney[] = [];
  const accessor = createBucketAccessor(meta.id);

  const bucket: DefinedBucket<Id> = {
    meta,
    entered,
    left,
    reactions,
    count: accessor.count,
    has: accessor.has,
    members: accessor.members,
    membersIterator: accessor.membersIterator,
    on(kind: "enter" | "leave" | "dwell", a: unknown, b?: unknown) {
      const { opts, handler } = normalizeOnArgs(kind, a, b);
      reactions.push(
        buildBucketReaction({ bucket: bucket as DefinedBucket, kind, opts, handler }),
      );
      return bucket;
    },
  };
  return bucket;
}
```

`createWorker` / `createHogsendClient` accept the base `DefinedBucket[]`, and
`DefinedBucket<Id>` is assignable to `DefinedBucket`, so a literal-typed array still
type-checks. Reactions are read off `bucket.reactions` at runtime regardless of the static
id literal — **dropping the `DefinedBucket[]` annotation in the consumer is a type-ergonomics
improvement (to keep literal `entered`/`left`), NOT a worker-wiring requirement.**

---

## 5. `bucket.on()` desugar (`bucket-reactions.ts`, NEW)

File: `packages/engine/src/buckets/bucket-reactions.ts`.

```ts
export type BucketLeaveReason = "criteria" | "maxDwell" | "manual";

export interface EnterOptions { firstEntryOnly?: boolean }
export interface LeaveOptions { reason?: BucketLeaveReason | BucketLeaveReason[] }

export type ReactionExtras<K> = K extends "enter"
  ? { entryCount: number; isFirstEntry: boolean }
  : K extends "leave"
    ? { reason: BucketLeaveReason }
    : { dwellCount: number };

export type BucketReactionCtx<K extends "enter" | "leave" | "dwell"> =
  JourneyContext & ReactionExtras<K>;

export type BucketOnHandler<K extends "enter" | "leave" | "dwell"> = (
  user: JourneyUser,
  ctx: BucketReactionCtx<K>,
) => Promise<void>;
```

### 5.1 Derived ids + dwell label

```
enter → `bucket-${id}-on-enter`
leave → `bucket-${id}-on-leave`
dwell → `bucket-${id}-on-dwell-${dwellLabel}`
```

`dwellLabel = after-<ms>` or `every-<ms>` (`durationToMs`). Stable across boots (Hatchet
keys workflows by `journey-${id}`) and unique per schedule, so a bucket may carry both an
`after` and an `every` dwell.

### 5.2 Trigger wiring

| kind  | trigger.event                          | fires via                                  |
|-------|----------------------------------------|--------------------------------------------|
| enter | `bucket.entered` (`bucket:entered:<id>`) | `emitBucketTransition` alias (always)     |
| leave | `bucket.left` (`bucket:left:<id>`)      | `emitBucketTransition` alias (always)     |
| dwell | `bucket:dwell:<id>:<dwellLabel>`        | the reconcile cron, via `emitBucketTransition` (§6) |

The dwell event name is `bucket:`-prefixed, so `checkBucketMembership` recursion-guards it
(returns `[]` for `bucket:`-prefixed events — verified `check-membership.ts:74`). The label
disambiguates two dwell reactions on one bucket.

### 5.3 `buildBucketReaction`

```ts
export function buildBucketReaction(args: {
  bucket: DefinedBucket;
  kind: "enter" | "leave" | "dwell";
  opts: EnterOptions | LeaveOptions | DwellOptions | undefined;
  handler: BucketOnHandler<"enter" | "leave" | "dwell">;
}): DefinedJourney {
  const { bucket, kind, opts, handler } = args;
  const triggerEvent =
    kind === "enter" ? bucket.entered
    : kind === "leave" ? bucket.left
    : `bucket:dwell:${bucket.meta.id}:${dwellLabel(opts as DwellOptions)}`;

  const meta: JourneyMeta = {
    id: reactionJourneyId(bucket.meta.id, kind, opts),
    name: `${bucket.meta.name} — on ${kind}`,
    enabled: bucket.meta.enabled,
    trigger: { event: triggerEvent },
    entryLimit: "unlimited",          // re-entry is a FILTER, never gated here
    suppress: { seconds: 0 },         // reactions have no cool-down
    sourceBucketId: bucket.meta.id,   // §7 tagging
    reactionKind: kind,               // §7 tagging
    ...(kind === "dwell"
      ? { dwellSchedule: parseDwellSchedule(opts as DwellOptions) }
      : {}),
  };

  return defineJourney({
    meta,
    run: async (user, ctx) => {
      const p = user.properties;
      if (kind === "enter") {
        const entryCount = Number(p.entryCount ?? 1);
        const isFirstEntry = entryCount === 1;
        if ((opts as EnterOptions)?.firstEntryOnly && !isFirstEntry) return;
        await handler(user, { ...ctx, entryCount, isFirstEntry });  // spread, not mutate
      } else if (kind === "leave") {
        const reason = (p.reason as BucketLeaveReason) ?? "criteria";
        const want = (opts as LeaveOptions)?.reason;
        if (want && !asArray(want).includes(reason)) return;
        await handler(user, { ...ctx, reason });
      } else {
        const dwellCount = Number(p.dwellCount ?? 1);
        await handler(user, { ...ctx, dwellCount });
      }
    },
  });
}
```

Because the reaction IS a `defineJourney` output, it inherits the full guard chain
(`meta.enabled` → admin override → `trigger.where` → `checkEntryLimit` → email-prefs →
already-active dedup → `journeyStates` row → `createJourneyContext`) and the active-state
dedup that serializes concurrent transitions for the same user to one live run. The
`firstEntryOnly` / `reason` filters run inside `run` AFTER enrollment (so a filtered-out
event still writes a short `journeyStates` row that immediately completes — acceptable; it
keeps the `reason`-array support and is simpler than a `trigger.where` encoding).

---

## 6. `dwell` in the reconcile cron

`dwell` fires from `bucketReconcileTask` (`workflows/bucket-reconcile.ts`), which already
runs the per-bucket criteria/TTL passes and reads the journey-registry singleton.

### 6.1 Emit path — route through `emitBucketTransition`, NOT raw `hatchet.events.push`

> **RESOLUTION (dwell-critique blockers 1 + 2 — bypass + retry-loss).** The original design
> pushed the dwell event with a raw `hatchet.events.push` and a stamp-then-push order under
> `retries: 1`. That (a) wrote no `userEvents` row, so the dwell event was invisible to
> `ctx.history.hasEvent`, journey `exitOn` (`checkExits` only sees ingest-routed events),
> and analytics — diverging from enter/leave; and (b) lost fires on crash between stamp and
> push. **Both are fixed by routing the dwell emission through `emitBucketTransition` /
> `ingestEvent` with a deterministic `idempotencyKey`, exactly like enter/left.** This:
> - writes a `userEvents` row (history/exitOn/analytics parity),
> - rides the `userEvents` idempotency short-circuit (verified `bucket-emit.ts:85`) so a
>   retry that recomputes the same key is absorbed by `onConflictDoNothing`,
> - lets us **push-first, then stamp** (at-least-once with dedup) instead of stamp-first,
>   eliminating the lost-fire window.
>
> `emitBucketTransition` gains a third transition kind, `"dwell"`, which emits
> `bucket:dwell:<id>:<dwellLabel>` (so the reaction's `onEvents` matches) with a
> deterministic key `` `bucket:<id>:<userId>:dwell:<dwellLabel>:<ordinal>` `` where
> `ordinal` is derived from the membership so a retry recomputes the identical key:
> - `after`: `ordinal = 1` (one-shot — a retry recomputes key `...:after-<ms>:1`, deduped).
> - `every`: `ordinal = floor((sweepInstant - enteredAt) / offsetMs)` — the interval index,
>   stable for a given sweep instant so a same-sweep retry recomputes it. The sweep instant
>   is captured once at the top of the dwell pass and reused (not `Date.now()` per row), so
>   a retry of the SAME run recomputes the SAME ordinal.

The dwell `dwellState` stamp (§6.2) is then **defense-in-depth across DIFFERENT sweeps**,
not the primary correctness guarantee. The `userEvents` dedup is the backstop within a
sweep retry.

> **RESOLUTION (dwell-critique minor — CAS overstated).** Documented: sweep-level
> serialization (`GROUP_ROUND_ROBIN maxRuns:1`, verified `bucket-reconcile.ts:80-86`) is
> the primary no-duplicate guarantee; the `idempotencyKey`/`userEvents` dedup handles the
> intra-sweep retry; the `dwellState` stamp handles the inter-sweep "already fired this
> membership" gate; the `status='active'` clause in the stamp UPDATE makes leave/fastExpiry
> interop correct (a row flipped to `left` between SELECT and UPDATE no-ops).

### 6.2 Schema — per-membership dwell bookkeeping

File: `packages/db/src/schema/bucket-memberships.ts`.

```ts
// Per-membership dwell bookkeeping. JSON map keyed by dwellLabel → ISO of last dwell
// fire for THIS continuous membership. A re-join is a NEW row (empty map). NULL/{} = never.
dwellState: jsonb("dwell_state").$type<Record<string, string>>().default({}),
```

Indexes added in the same migration:

```ts
// dwell continuous-member scan anchor
index("bucket_memberships_dwell_idx").on(table.bucketId, table.status, table.enteredAt),
// keyset member-access pagination (ordered by id)
index("bucket_memberships_bucket_id_status_id_idx").on(table.bucketId, table.status, table.id),
// every-dwell oldest-served-first ordering (see §6.5)
index("bucket_memberships_dwell_lastfired_idx").on(table.bucketId, table.status, table.lastEvaluatedAt),
```

Additive + nullable — safe. Generate via `cd packages/db && pnpm db:generate` (engine
track).

### 6.3 First-deploy `enteredAt` — the existing-population honesty fix

> **RESOLUTION (dwell-critique blocker 3 — `enteredAt` is deploy-time for backfilled
> members).** Verified: `backfillJoins` (`bucket-backfill.ts`) and `reconcileJoinOne`
> insert membership rows WITHOUT setting `enteredAt`, so it defaults to `now()`. For a
> brand-new bucket's first-time backfill, the ENTIRE historical cohort gets
> `enteredAt ≈ backfill instant`. The dwell gate (`enteredAt <= now - offset`) would then
> not fire for a 7-day-dwell bucket until 7 days after deploy — defeating dwell's stated
> "fires for the existing population". **Fix: backfill the historical anchor.** The
> first-time backfill already computes a per-matcher set; for the absence (lapsed) and
> event/count shapes it can derive a meaningful anchor from the matcher's qualifying-event
> history. Concretely:
> - Add `backfillJoins` to set `enteredAt` to a **derived historical instant** per matcher
>   where one exists cheaply: for a windowed criterion, the boundary of the qualifying
>   window (e.g. for `went-dormant` = `lastEventAt`, the last `app_opened`, which is when
>   they BECAME dormant). For shapes with no cheap per-matcher timestamp, `enteredAt`
>   stays `now()` and we accept "clock starts at backfill" for that shape.
> - This is a **batched** computation (one `GROUP BY max(occurredAt)` per chunk over the
>   matcher set, mirroring the existing `priorCounts` GROUP BY in `backfillJoins`), never
>   per-user serial queries.
>
> Because this touches the backfill matcher path, it is scoped as: the engine sets a new
> nullable `dwellAnchorAt` column = the derived historical instant (falling back to
> `enteredAt` when not derivable), and the dwell gate reads **`coalesce(dwellAnchorAt,
> enteredAt)`**. Keeping it a separate column avoids changing the meaning of `enteredAt`
> (which `minDwell`, `maxDwellAt`, and the criteria cron all key on) — a strictly additive
> change. The live join path (`handleJoin`) leaves `dwellAnchorAt` NULL, so for users who
> join AFTER deploy the dwell clock correctly starts at their real `enteredAt`.

Add to §6.2's migration:

```ts
// Historical dwell anchor for backfilled members (NULL for live joins → use enteredAt).
dwellAnchorAt: timestamp("dwell_anchor_at", { withTimezone: true }),
```

If the human decides the backfill-anchor derivation is out of scope for this build, the
fallback is documented in Open Questions: ship dwell measuring age-since-`enteredAt`, and
state plainly that on first deploy the dwell clock starts at backfill time. The
`dwellAnchorAt` column + `coalesce` is the chosen path here.

### 6.4 The dwell pass + the widened gate

> **RESOLUTION (worker-critique major — gate widening hand-waved, `dwellReactionsExistFor`
> undefined).** Specified concretely. At the top of each `for (const bucket of
> registry.getEnabled())` iteration, compute:
> ```ts
> const hasDwell = journeyRegistry
>   .getAll()
>   .some((j) => j.sourceBucketId === bucket.id && j.reactionKind === "dwell");
> ```
> Change the early-continue from `if (!timeBased && !bucket.maxDwell) continue;` to
> `if (!timeBased && !bucket.maxDwell && !hasDwell) continue;`. Keep the criteria pass
> behind `if (timeBased)` and the TTL pass behind `if (bucket.maxDwell)` exactly as today,
> so a **dwell-only** bucket falls through and runs ONLY the dwell pass. The dwell pass runs
> AFTER the TTL pass in the same iteration (ordering is load-bearing — see maxDwell interop
> below). Regression-guarded by Test 22.

```ts
// inside the per-bucket iteration, after the maxDwell TTL pass:
if (hasDwell) {
  const dwellReactions = journeyRegistry
    .getAll()
    .filter((j) => j.sourceBucketId === bucket.id && j.reactionKind === "dwell");
  reconciled += await reconcileBucketDwell({ db, logger, journeyRegistry, bucket, dwellReactions });
}
```

### 6.5 `reconcileBucketDwell`

```ts
async function reconcileBucketDwell(opts: {
  db: Database; logger: Logger;
  journeyRegistry: ReturnType<typeof getJourneyRegistrySingleton>;
  bucket: BucketMeta; dwellReactions: JourneyMeta[];
}): Promise<number> {
  const { db, journeyRegistry, bucket, dwellReactions } = opts;

  // First-deploy quiet window: do not blast the pre-existing/backfilled population
  // before the first-time backfill has settled (reuse the existing guard).
  if (await firstTimeBackfillIncomplete(db, bucket)) return 0;

  const sweepInstant = Date.now();           // captured ONCE; reused for the ordinal
  let fired = 0;

  for (const reaction of dwellReactions) {
    const { label, after, every } = reaction.dwellSchedule!;  // ms, present for dwell
    const offsetMs = after ?? every!;
    const cutoff = new Date(sweepInstant - offsetMs);

    // Continuous-member gate. coalesce(dwellAnchorAt, enteredAt) is the dwell clock.
    // ORDER BY lastEvaluatedAt asc nulls first → oldest-served-first so a busy `every`
    // bucket cannot starve members past BATCH_SIZE (resolution below).
    const candidates = await db
      .select({
        id: bucketMemberships.id, userId: bucketMemberships.userId,
        userEmail: bucketMemberships.userEmail, entryCount: bucketMemberships.entryCount,
        anchor: sql`coalesce(${bucketMemberships.dwellAnchorAt}, ${bucketMemberships.enteredAt})`,
        dwellState: bucketMemberships.dwellState,
      })
      .from(bucketMemberships)
      .innerJoin(contacts, eq(contacts.externalId, bucketMemberships.userId))
      .where(and(
        eq(bucketMemberships.bucketId, bucket.id),
        eq(bucketMemberships.status, "active"),
        isNull(bucketMemberships.deletedAt),
        isNull(contacts.deletedAt),
        lte(sql`coalesce(${bucketMemberships.dwellAnchorAt}, ${bucketMemberships.enteredAt})`, cutoff),
      ))
      .orderBy(sql`${bucketMemberships.lastEvaluatedAt} asc nulls first`)
      .limit(BATCH_SIZE);

    if (candidates.length >= BATCH_SIZE) {
      // visibility for the bounded scan, mirroring reconcileBucketJoins' Fix #3 log
      opts.logger.warn("Bucket dwell pass bounded to BATCH_SIZE/tick", {
        bucketId: bucket.id, label, batchSize: BATCH_SIZE,
      });
    }

    for (const m of candidates) {
      const state = (m.dwellState ?? {}) as Record<string, string>;
      const lastFired = state[label] ? Date.parse(state[label]) : null;

      if (after != null) {
        if (lastFired != null) continue;                     // one-shot already fired
      } else {
        const since = lastFired ?? (m.anchor as Date).getTime();
        if (sweepInstant - since < offsetMs) continue;       // every: not yet due
      }

      // Ordinal: deterministic per (membership, sweepInstant) so a retry recomputes it.
      const ordinal = after != null
        ? 1
        : Math.floor((sweepInstant - (m.anchor as Date).getTime()) / offsetMs);

      // PUSH FIRST (at-least-once; idempotencyKey + userEvents dedup absorb retries),
      // THEN stamp. emitBucketTransition handles the userEvents/exitOn/analytics parity.
      await emitBucketTransition({
        db, registry: journeyRegistry, hatchet, logger: opts.logger,
        kind: "dwell", bucket, userId: m.userId, userEmail: m.userEmail,
        epoch: m.entryCount, source: "reconcile",
        dwellLabel: label, dwellOrdinal: ordinal,   // → key & event name
      });

      // Stamp the membership (inter-sweep gate). status='active' clause = leave interop.
      await db.update(bucketMemberships)
        .set({
          dwellState: sql`jsonb_set(coalesce(${bucketMemberships.dwellState}, '{}'::jsonb), ${`{${label}}`}, ${`"${new Date(sweepInstant).toISOString()}"`}::jsonb)`,
          lastEvaluatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(bucketMemberships.id, m.id),
          eq(bucketMemberships.status, "active"),
        ));
      fired += 1;
    }
  }
  return fired;
}
```

**Interop, restated and resolved:**

- **maxDwell interop** — the TTL pass (`reconcileBucketTtlLeaves`) runs EARLIER in the same
  iteration and force-leaves members past `maxDwellAt`; they are `status='left'` by the
  dwell pass, so the `status='active'` filter excludes them. A bucket with
  `after >= maxDwell` simply never dwells (member leaves first) — documented, mirrors
  `minDwell <= maxDwell`.
- **fastExpiry interop** — a fast-expiry leave flips `status='left'` via its own CAS; the
  dwell scan's `status='active'` filter excludes it.
- **idempotency across sweeps** — `dwellState[label]` gates `after` (fire once) and paces
  `every` (`since = lastFired`); the `userEvents` dedup absorbs intra-sweep retries.
- **`every` re-arms** by comparing `sweepInstant - lastFired >= offsetMs`.

> **RESOLUTION (dwell-critique major — `every` coalescing / `dwellCount` semantics).**
> Documented explicitly: `every` is **fires-at-most-once-per-sweep, coalescing** — after a
> multi-interval outage only one catch-up fire happens. `dwellCount` is defined as the
> **deterministic interval ordinal** `floor((sweepInstant - anchor) / offsetMs)`, NOT the
> count of fires — so it equals elapsed `every` periods even across a gap, which is the
> intuitive consumer meaning and is gap-stable. (For `after`, `dwellCount` is always 1.)

> **RESOLUTION (dwell-critique major — BATCH_SIZE starvation on busy `every`).** Candidates
> are ordered `lastEvaluatedAt asc nulls first` (oldest-served-first), like
> `reconcileCompositeLeaves`, and the stamp bumps `lastEvaluatedAt`, so the cursor advances
> and the oldest-unserved members are picked next sweep — no permanent starvation of
> member 501+. A new index (`bucket_memberships_dwell_lastfired_idx`) serves this ordering.
> Hitting BATCH_SIZE is logged once per sweep (visibility, not silent).

### 6.6 `emitBucketTransition` dwell extension

File: `packages/engine/src/lib/bucket-emit.ts`.

- `BucketTransitionKind` gains `"dwell"`.
- Add params `reason?: BucketLeaveReason`, `dwellLabel?: string`, `dwellOrdinal?: number`.
- Event name: `entered`/`left` keep `` `bucket:${kind}:${bucket.id}` ``; dwell emits
  `` `bucket:dwell:${bucket.id}:${dwellLabel}` ``.
- `idempotencyKey`: keep `` `bucket:${id}:${userId}:${kind}:${epoch}` `` for enter/leave;
  dwell uses `` `bucket:${id}:${userId}:dwell:${dwellLabel}:${dwellOrdinal}` ``.
- `properties`: add `entryCount: epoch` always; add `reason` when `kind === "left"` and a
  reason is provided; add `dwellCount: dwellOrdinal` when `kind === "dwell"`.

All three (`entryCount`, `reason`, `dwellCount`) are primitives and survive the ingest
serializer (`string|number|boolean|null` filter — verified `ingestion.ts`).

### 6.7 `reason` at each leave producer

- `check-membership.ts` `handleLeave` (real-time criteria flip) → `reason: "criteria"`.
- `bucket-reconcile.ts` criteria leaves (`reconcileBucketLeaves` / `reconcileCompositeLeaves`
  via `bulkLeave`) → `reason: "criteria"`.
- `bucket-reconcile.ts` `reconcileBucketTtlLeaves` (via `bulkLeave`) → `reason: "maxDwell"`.
- `bucketExpiryTask` (fast-expiry, a criteria re-confirm) → `reason: "criteria"`.
- `bucket-backfill.ts` `reevalLeaves` → `reason: "criteria"` (criteria changed).
- Future manual force-leave → `reason: "manual"`.

`bulkLeave` gains a `reason: BucketLeaveReason` param; the TTL caller passes `"maxDwell"`,
the criteria callers pass `"criteria"`. `enter`'s `isFirstEntry` is derived in the reaction
`run` (`entryCount === 1`), not emitted separately.

---

## 7. `sourceBucketId` + Studio grouping

### 7.1 `JourneyMeta` + schema

File: `packages/core/src/types/journey.ts`:

```ts
export interface JourneyMeta {
  // ...existing...
  sourceBucketId?: string;
  reactionKind?: "enter" | "leave" | "dwell";
  dwellSchedule?: { label: string; after?: number; every?: number };
}
```

File: `packages/core/src/schemas/journey.schema.ts` — add matching optional fields to
`journeyMetaSchema` (the blocker resolution from Decision 5):

```ts
sourceBucketId: z.string().optional(),
reactionKind: z.enum(["enter", "leave", "dwell"]).optional(),
dwellSchedule: z.object({
  label: z.string(),
  after: z.number().optional(),
  every: z.number().optional(),
}).optional(),
```

Without these, `JourneyRegistry.register`'s `journeyMetaSchema.parse` strips them and both
the dwell-cron lookup and Studio grouping break. Round-trip regression test = Test 13b.

### 7.2 Admin route (`routes/admin/buckets.ts`, `getRoute` handler)

Discover owned reactions by `sourceBucketId`; surface external bindings via the existing
alias cross-reference, tagged `owned: false`:

```ts
const feedsMap = new Map<string, {
  id: string; name: string; trigger: string; sourceBucketId: string | null; owned: boolean;
}>();

// Owned reactions: scan the journey registry for sourceBucketId === id.
for (const j of registry.getAll().filter((j) => j.sourceBucketId === id)) {
  feedsMap.set(j.id, { id: j.id, name: j.name, trigger: j.trigger.event,
    sourceBucketId: id, owned: true });
}
// External bindings: the existing alias + generic cross-reference (owned wins).
const feedEvents = [`bucket:entered:${id}`, `bucket:left:${id}`, "bucket:entered", "bucket:left"];
for (const evt of feedEvents) {
  for (const journey of registry.getByTriggerEvent(evt)) {
    if (feedsMap.has(journey.id)) continue;
    feedsMap.set(journey.id, { id: journey.id, name: journey.name, trigger: evt,
      sourceBucketId: journey.sourceBucketId ?? null, owned: false });
  }
}
```

Extend the `feedsJourneys` zod schema with `sourceBucketId: z.string().nullable()` and
`owned: z.boolean()`.

### 7.3 Studio

- `packages/studio/src/lib/admin-api.ts` — extend `BucketFeedJourney` with
  `sourceBucketId: string | null; owned: boolean`.
- `packages/studio/src/views/buckets-view.tsx` `BucketFeeds` — render owned reactions with
  an "owned" badge (reuse the `FreshnessBadge` pattern), external ones plain; update the
  empty-state copy from `bucketEntered("id")` to the typed-ref guidance.

---

## 8. Member access (`bucket-access.ts`, NEW)

File: `packages/engine/src/buckets/bucket-access.ts`.

> **RESOLUTION (access-critique major — db path + `overrides.db` seam).** The original claim
> "uses `getDb()`, the same singleton check-membership relies on" is wrong:
> `check-membership` takes `db` as a param and `bucket-reconcile` calls `createDatabase`
> directly; only `define-journey` uses `getDb()`. The accessor is built at module-load (no
> container yet), so it defaults to `getDb()` — which is exactly what the desugared reaction
> journeys already run on (`define-journey.ts:51`), so it is consistent with the path that
> calls these accessors most. **To honor `overrides.db` in tests, `createBucketAccessor`
> takes an optional `dbResolver`** (`() => Database`), defaulting to `getDb`; the container
> wires the accessors to its own `db` by re-binding them when it builds the bucket registry
> (so `overrides.db` flows through). The `getDb()` default is documented as bypassing the
> container, and a test pins accessor + `overrides.db` semantics (Test 28b).

```ts
import { bucketMemberships, contacts, type Database } from "@hogsend/db";
import { and, count as countFn, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "../lib/db.js";

const MAX_PAGE = 100;     // mirrors listMembersRoute z.max(100)
const DEFAULT_PAGE = 50;

export interface BucketMemberRow { /* serialized membership row */ }

export interface MembersResult {
  data: BucketMemberRow[];
  error: Error | null;
  count: number | null;   // per-call snapshot total (see churn note)
  cursor: string | null;  // keyset continuation (last row id), null when exhausted
}

export interface BucketAccessor {
  count(): Promise<{ data: number | null; error: Error | null }>;
  has(userId: string): Promise<{ data: boolean; error: Error | null }>;
  members(opts?: { limit?: number; cursor?: string }): Promise<MembersResult>;
  membersIterator(opts?: { pageSize?: number }): AsyncIterableIterator<BucketMemberRow>;
}

export function createBucketAccessor(
  bucketId: string,
  dbResolver: () => Database = getDb,   // overrides.db seam
): BucketAccessor { /* count / has / members / membersIterator as below */ }
```

Behavior:
- **`count()`** — head-count over active, non-deleted members joined to live contacts
  (GDPR). `{ data, error }`.
- **`has(userId)`** — `findFirst` on the partial active unique index
  (`uq_user_bucket_active`), O(1). `{ data, error }`.
- **`members({ limit, cursor })`** — keyset cursor on `id` (UUID, unique, stable — NOT
  `enteredAt`, which ties on `defaultNow`). `limit + 1` peek detects `hasMore`; `cursor` is
  the last `id`; hard cap `MAX_PAGE`. Returns `{ data, error, count, cursor }`. No-throw —
  `error` carries failures.
- **`membersIterator({ pageSize })`** — composes `members()` page-by-page; the only
  full-population traversal, internally bounded; throws on a page error.

All three `innerJoin contacts` + `isNull(deletedAt)` (GDPR parity with every reconcile/admin
query). Export `createBucketAccessor` / `MembersResult` / `BucketMemberRow` from
`packages/engine/src/index.ts`.

> **RESOLUTION (access-critique minor — count drift / iterator recompute).** Documented:
> `members().count` is a **per-call snapshot**, not a consistent paginated total; under
> churn the head-count can differ page-to-page. The keyset cursor itself is churn-safe.
> `membersIterator` recomputes the head-count per page (acceptable; the standalone
> `count()` is the way to get a single authoritative number).

> **RESOLUTION (access-critique minor — UUID order is opaque).** Documented: `members()` /
> the iterator return rows in **opaque cursor order** (UUID `id` asc), NOT chronological. A
> chronological walk would need a separate `(enteredAt, id)` keyset — out of scope for this
> build.

> **RESOLUTION (access-critique minor — `count` name collision).** The drizzle `count` is
> imported as `countFn`; the spec calls out the two distinct count shapes (`bucket.count()`
> returns `{ data, error }`; `members().count` returns `number | null`).

---

## 9. Worker + container wiring

> **RESOLUTION (worker-critique blocker — `ENABLED_JOURNEYS` csv drops reaction tasks).**
> Reactions are **bucket-owned**, gated by `ENABLED_BUCKETS`, and MUST stay OUT of the
> `journeys[]` array (which `selectJourneyTasks` filters by `ENABLED_JOURNEYS`). Reaction
> ids (`bucket-<id>-on-enter`) never appear in a consumer's `ENABLED_JOURNEYS` csv, so
> folding them into `journeys[]` would drop every reaction whenever `ENABLED_JOURNEYS` is a
> csv. Two `ENABLED_BUCKETS`-gated selectors are added and wired directly.

File: `packages/engine/src/buckets/registry.ts` — add:

```ts
export function selectBucketReactionTasks(
  buckets: DefinedBucket[], enabledFilter?: string,
): NonNullable<DefinedBucket["task"]>[] {
  const enabled = parseEnabledFilter(enabledFilter);
  const tasks = buckets
    .filter((b) => enabled === "*" || enabled.has(b.meta.id))
    .flatMap((b) => b.reactions.map((r) => r.task));
  assertNoReactionIdCollisions(buckets, enabled);   // see resolution below
  return tasks as NonNullable<DefinedBucket["task"]>[];
}

export function collectBucketReactionJourneys(
  buckets: DefinedBucket[], enabledFilter?: string,
): DefinedJourney[] {
  const enabled = parseEnabledFilter(enabledFilter);
  return buckets
    .filter((b) => enabled === "*" || enabled.has(b.meta.id))
    .flatMap((b) => b.reactions);
}
```

> **RESOLUTION (worker-critique major — Hatchet workflow-NAME collision).** Reaction tasks
> register under `journey-${meta.id}`. Two buckets sharing an id, or a user journey named
> `bucket-<id>-on-enter`, collide silently (register-last-wins) or throw on boot.
> `assertNoReactionIdCollisions` builds a `Set` of generated reaction ids and throws a
> descriptive build-time error on any duplicate, or on a reaction id colliding with a user
> journey id in `opts.journeys`. Loud boot failure instead of a silent drop. Test 14b.

File: `packages/engine/src/worker.ts`:

```ts
import { selectBucketReactionTasks, selectBucketTasks } from "./buckets/registry.js";
// ...
const bucketReactionTasks = selectBucketReactionTasks(opts.buckets ?? [], enabledBuckets);

const baseWorkflows = [
  sendEmailTask, importContactsTask, checkAlertsTask,
  bucketReconcileTask, bucketBackfillTask,
  ...journeyTasks, ...bucketTasks, ...bucketReactionTasks,
];
```

> **RESOLUTION (worker-critique major — `reportWorkerReady` mis-count).** The
> `builtinTasks` arithmetic (`worker.ts:97-98`) subtracts only `journeyTasks` and
> `bucketTasks`. Update to also subtract `bucketReactionTasks` and pass
> `bucketReactionTasks: bucketReactionTasks.length`:
> ```ts
> reportWorkerReady({
>   client: container,
>   journeyTasks: journeyTasks.length,
>   bucketTasks: bucketTasks.length,
>   bucketReactionTasks: bucketReactionTasks.length,
>   builtinTasks: baseWorkflows.length - journeyTasks.length - bucketTasks.length - bucketReactionTasks.length,
> });
> ```
> Verify `lib/boot.ts` `reportWorkerReady` renders the new field without NaN.

> **RESOLUTION (worker-critique minor — `extraWorkflows` cast).** After wiring, run
> `pnpm check-types`; if spreading `...bucketReactionTasks` widens `baseWorkflows`' inferred
> element type awkwardly against `hatchet.worker({ workflows })`, type `baseWorkflows`
> explicitly as the hatchet task array type rather than relying on inference.

File: `packages/engine/src/container.ts` — register reaction metas into the journey
registry AFTER `buildJourneyRegistry`, bypassing the `ENABLED_JOURNEYS` filter (they were
already `ENABLED_BUCKETS`-gated):

```ts
import { collectBucketReactionJourneys } from "./buckets/registry.js";
// ...after buildJourneyRegistry + buildBucketRegistry...
const reactionJourneys = collectBucketReactionJourneys(
  opts.buckets ?? [], opts.enabledBuckets ?? env.ENABLED_BUCKETS,
);
for (const j of reactionJourneys) registry.register(j.meta);  // bucket-gated, not journey-gated
```

Both API and worker call `createHogsendClient`, so the journey-registry singleton carries
reaction metas in both processes (needed for the admin `feedsJourneys` and the dwell-cron
lookup). **No `apps/api` change is required** — `index.ts` / `worker.ts` already pass
`buckets` to both factories.

Two load-bearing notes for the implementer:
1. Reaction enablement follows `ENABLED_BUCKETS` in BOTH the worker selector and the
   container registry registration.
2. The new `JourneyMeta` fields MUST be in `journeyMetaSchema` (§7.1) or `register`'s
   `parse` strips them.

---

## 10. Back-compat: typed refs replace string helpers

### 10.1 Consumer

`apps/api/src/buckets/index.ts` — drop the `DefinedBucket[]` annotation (it re-widens the
id) and let the array infer:

```ts
export const buckets = [powerUsers, trialExpiringSoon, wentDormant];
export { powerUsers, trialExpiringSoon, wentDormant };
```

`apps/api/src/journeys/constants/buckets.ts` — deprecate, do not remove:

```ts
/** @deprecated Use `wentDormant.entered` / `wentDormant.left` typed refs. */
export type BucketId = "power-users" | "trial-expiring-soon" | "went-dormant";
/** @deprecated Use `bucket.entered` (e.g. `wentDormant.entered`). */
export const bucketEntered = <T extends BucketId>(id: T) => `bucket:entered:${id}` as const;
/** @deprecated Use `bucket.left` (e.g. `wentDormant.left`). */
export const bucketLeft = <T extends BucketId>(id: T) => `bucket:left:${id}` as const;
```

`apps/api/src/journeys/reactivation-dormancy.ts` — migrate, importing the **leaf** bucket
module (cycle resolution from Decision 2):

```ts
// before
import { bucketLeft, Events, Templates } from "./constants/index.js";
// ...
{ event: bucketLeft("went-dormant") },

// after
import { Events, Templates } from "./constants/index.js";
import { wentDormant } from "../buckets/went-dormant.js";   // leaf, not ../buckets/index.js
// ...
{ event: wentDormant.left },   // "bucket:left:went-dormant" — byte-identical
```

### 10.2 Generic-form story

> **RESOLUTION (api-critique minor — generic forms orphaned).** The typed refs cover only
> the per-bucket ALIAS. `Events.BUCKET_ENTERED` / `Events.BUCKET_LEFT` (the "any bucket"
> generic constants, verified `events.ts:35-36`) remain the sanctioned generic-binding
> surface and are NOT deprecated. Document the distinction next to the new typed refs and in
> the authoring skill + Studio empty-state copy: per-bucket = `bucket.entered`/`.left`;
> any-bucket = `Events.BUCKET_ENTERED`/`BUCKET_LEFT`.

### 10.3 Scaffold (release discipline)

`packages/create-hogsend/template/src/journeys/constants/index.ts` +
`template/src/buckets/index.ts` — mirror the deprecation JSDoc and drop the `DefinedBucket[]`
annotation. Per the release skill, bump `ENGINE_VERSION`, keep all scaffold packages on the
engine minor line, and verify a real `create-hogsend` install.

---

## 11. NEW files

| File | Purpose |
|---|---|
| `packages/engine/src/buckets/bucket-reactions.ts` | `buildBucketReaction`, `reactionJourneyId`, `dwellLabel`, `parseDwellSchedule`, `normalizeOnArgs`, `asArray`, `EnterOptions`/`LeaveOptions`/`DwellOptions`, `BucketLeaveReason`, `BucketReactionCtx`, `BucketOnHandler` — the desugar core. |
| `packages/engine/src/buckets/bucket-access.ts` | `createBucketAccessor` + `count`/`has`/`members`/`membersIterator`, `MembersResult`, `BucketMemberRow`, hard cap, keyset cursor, `dbResolver` seam. |
| `apps/api/src/__tests__/bucket-reactions.test.ts` | `.on()` desugar, typed refs, filters, registration, collision, standalone-import smoke. |
| `apps/api/src/__tests__/bucket-dwell.test.ts` | Cron dwell: existing-population, continuous gate, idempotency, `every`, maxDwell interop, first-deploy quiet window, anchor. |
| `apps/api/src/__tests__/bucket-access.test.ts` | `count`/`has`/`members`/iterator/cap/error/overrides.db. |
| `packages/db/migrations/<gen>_bucket_dwell_state.sql` | Generated by `db:generate` — `dwell_state` jsonb, `dwell_anchor_at` timestamp, three indexes. |

## 12. MODIFIED files (per-file change notes)

| File | Change |
|---|---|
| `packages/engine/src/buckets/define-bucket.ts` | `const Id` generic; `entered`/`left` literal refs (synchronous, no cross-module binding); `reactions[]`; `count`/`has`/`members`/`membersIterator`; `on()` overloads; `DwellOptions`. |
| `packages/engine/src/buckets/registry.ts` | Add `selectBucketReactionTasks` + `collectBucketReactionJourneys` (ENABLED_BUCKETS-gated) + `assertNoReactionIdCollisions`. |
| `packages/engine/src/worker.ts` | Register `...bucketReactionTasks` in `baseWorkflows`; fix `builtinTasks` arithmetic; add `bucketReactionTasks` count to `reportWorkerReady`. |
| `packages/engine/src/container.ts` | Register reaction metas into the journey registry (bucket-gated, after `buildJourneyRegistry`); re-bind accessors to container `db` for `overrides.db`. |
| `packages/engine/src/lib/bucket-emit.ts` | `"dwell"` kind; `reason?`/`dwellLabel?`/`dwellOrdinal?` params; dwell event name + key; `entryCount`/`reason`/`dwellCount` on properties. |
| `packages/engine/src/buckets/check-membership.ts` | `handleLeave` passes `reason: "criteria"`. |
| `packages/engine/src/workflows/bucket-reconcile.ts` | Widen early-continue with `hasDwell`; add `reconcileBucketDwell` (push-first emit, oldest-served ordering, anchor coalesce); `bulkLeave` gains `reason`; TTL passes `"maxDwell"`, criteria passes `"criteria"`; fast-expiry passes `"criteria"`; reuse `firstTimeBackfillIncomplete` in dwell. |
| `packages/engine/src/workflows/bucket-backfill.ts` | Derive + set `dwellAnchorAt` on backfilled rows (batched per chunk); `reevalLeaves` passes `reason: "criteria"`. |
| `packages/engine/src/index.ts` | Export `createBucketAccessor`/`MembersResult`/`BucketMemberRow`, `BucketLeaveReason`, `DwellOptions`, `selectBucketReactionTasks`, `collectBucketReactionJourneys`. |
| `packages/core/src/types/journey.ts` | Add `sourceBucketId?`, `reactionKind?`, `dwellSchedule?`. |
| `packages/core/src/schemas/journey.schema.ts` | Add matching optional zod fields (else `parse` strips them). |
| `packages/db/src/schema/bucket-memberships.ts` | Add `dwellState` jsonb, `dwellAnchorAt` timestamp, and three indexes. |
| `packages/engine/src/routes/admin/buckets.ts` | `feedsJourneys` discovered by `sourceBucketId`; add `sourceBucketId`/`owned` to schema. |
| `packages/studio/src/lib/admin-api.ts` | Extend `BucketFeedJourney` with `sourceBucketId`/`owned`. |
| `packages/studio/src/views/buckets-view.tsx` | Owned-reaction badge; update empty-state copy (typed refs + generic-form distinction). |
| `apps/api/src/buckets/index.ts` | Drop `DefinedBucket[]` annotation. |
| `apps/api/src/journeys/constants/buckets.ts` | `@deprecated` JSDoc on `BucketId`/`bucketEntered`/`bucketLeft`. |
| `apps/api/src/journeys/reactivation-dormancy.ts` | `bucketLeft("went-dormant")` → `wentDormant.left` (import from the leaf module). |
| `packages/create-hogsend/template/src/journeys/constants/index.ts` + `template/src/buckets/index.ts` | Mirror deprecation + annotation drop; bump `ENGINE_VERSION`. |

---

## 13. TEST PLAN

Conventions (from `buckets.test.ts` / `bucket-reconcile.test.ts`): set
`process.env.DATABASE_URL = postgresql://growthhog:growthhog@localhost:5434/growthhog` at
top of file; `vi.mock` Hatchet BEFORE dynamic `await import`; `RUN`-namespace all ids;
assert on `pushSpy` (what would route) not live execution; `beforeEach` install registry
singletons, `afterEach` reset. Reaction/dwell tests use the dual mock
(`../../../../packages/engine/src/lib/hatchet.ts` + `../lib/hatchet.js`) with `vi.hoisted`
and `...config` spread.

### Unit — `bucket-reactions.test.ts`
1. Typed refs literal value: `wentDormant.entered === "bucket:entered:went-dormant"`,
   `.left === "bucket:left:went-dormant"`; value-equal to deprecated `bucketLeft("went-dormant")`.
2. `.on()` returns the bucket (chaining); `reactions.length` increments per call.
3. enter desugar: `DefinedJourney` with `trigger.event === bucket.entered`,
   `id === "bucket-<id>-on-enter"`, `entryLimit:"unlimited"`, `suppress:{seconds:0}`,
   `sourceBucketId`/`reactionKind:"enter"` set, `task.onEvents === [bucket.entered]`.
4. leave desugar: `trigger.event === bucket.left`, id `-on-leave`.
5. dwell desugar id stability: `on("dwell",{after:days(7)})` → trigger
   `bucket:dwell:<id>:after-604800000`, id `bucket-<id>-on-dwell-after-604800000`;
   `dwellSchedule` set; two dwell reactions (after + every) get distinct ids/events.
6. enter filter `firstEntryOnly`: `run` with `entryCount=2` + `firstEntryOnly:true` → handler
   NOT called; `entryCount=1` → called, `ctx.isFirstEntry===true`.
7. leave filter `reason`: `run` with `reason="criteria"` + `opts.reason:"maxDwell"` → skipped;
   matching → called, `ctx.reason==="maxDwell"`; array form `reason:["criteria","maxDwell"]`.
8. ctx is full JourneyContext (spread, not mutated): assert `ctx.sleep`/`when`/`waitForEvent`/
   `guard`/`history`/`trigger` present; and the engine's canonical ctx object is NOT mutated
   (extras only on the handler's ctx).
8b. `normalizeOnArgs` arities: `on("enter",h)`, `on("enter",opts,h)`, `on("dwell",opts,h)`
   resolve correctly; `on("dwell")` with missing/ambiguous opts throws `TypeError`.

### Unit — emit + reason threading (extend `buckets.test.ts`)
9. `entryCount` on emit: a real-time join via `check()` → `bucket:entered:<id>` carries
   `properties.entryCount === 1`.
10. `reason` on real-time leave: criteria leave → `bucket:left:<id>` has `reason:"criteria"`.
11. `reason` on TTL leave: drive `reconcileBucketTtlLeaves` (backdate `maxDwellAt`) → emitted
    leave has `reason:"maxDwell"`.

### Integration — registration (`bucket-reactions.test.ts`)
12. container registration: `createHogsendClient({ buckets:[withReaction] })`;
    `registry.getByTriggerEvent("bucket:entered:<id>")` includes the reaction meta with
    `sourceBucketId`.
13. worker selection: `selectBucketReactionTasks([withReaction], "*")` returns the task;
    `collectBucketReactionJourneys` returns its `DefinedJourney`.
13b. schema round-trip (the blocker guard): register a dwell reaction meta through
    `JourneyRegistry.register`; assert `getAll()[0].dwellSchedule` / `sourceBucketId` /
    `reactionKind` survive (not stripped).
14. ENABLED_BUCKETS gating: with `enabledBuckets="other-bucket"`, the reaction is absent from
    both selectors AND from the registry; AND with `enabledJourneys="someOtherJourney"` (csv)
    + `enabledBuckets="*"`, `selectBucketReactionTasks` returns the task and
    `registry.getByTriggerEvent("bucket:entered:<id>")` includes it (the highest-value
    worker-wiring test — proves reactions are bucket-gated not journey-gated).
14b. id collision: two buckets sharing an id, or a user journey named
    `bucket-<id>-on-enter`, throws from `assertNoReactionIdCollisions`.
15. admin feedsJourneys (`app.request`): `GET /v1/admin/buckets/<id>` returns the owned
    reaction with `owned:true, sourceBucketId:<id>`; an external
    `defineJourney({trigger: bucket.entered})` appears with `owned:false`.

### Integration — dwell cron (`bucket-dwell.test.ts`, dual mock, `runReconcile = task.fn()`)
16. existing-population fire: seed N active members with backdated `enteredAt` older than
    `after`; persist `criteriaHash`; `runReconcile()` → one `bucket:dwell:<id>:after-<ms>`
    push per member with `properties.dwellCount===1`, routed through `emitBucketTransition`
    (assert a `userEvents` row was written too — exitOn/history parity).
17. idempotency across sweeps (`after`): second `runReconcile()` → zero additional dwell
    pushes (`dwellState[label]` set).
17b. intra-sweep retry dedup: invoke `runReconcile()` twice with the SAME `sweepInstant`
    seam → the `idempotencyKey` recomputes identically and the second emit is deduped by
    `userEvents` (no second `bucket:dwell` userEvents row).
18. continuous-membership gate: a member force-left (`status='left'`) between sweeps does NOT
    dwell; a re-joined member (new row, fresh `enteredAt`, empty `dwellState`) does NOT fire
    until backdated past `after`.
19. maxDwell interop: bucket with `maxDwell < after` → member is TTL-left earlier in the
    sweep, dwell never fires.
20. `every` re-arms + coalescing: dwell `{every:hours(1)}`, backdate anchor 2h; first sweep
    fires (`dwellCount` = interval ordinal); set `dwellState` 30m ago → next sweep no-fire;
    90m ago → fires again; a multi-interval backdate (3h) → exactly ONE catch-up fire with
    `dwellCount` reflecting the elapsed-period ordinal (coalescing semantics).
21. first-deploy quiet window: `criteriaHash` null (or first-time job in flight) →
    `runReconcile()` skips the dwell pass (no pushes).
22. dwell-only bucket reaches the pass: a bucket with no `timeBased`/`maxDwell` but a dwell
    reaction is NOT early-continued (widened-gate regression guard).
22b. anchor honesty: backfilled member with `dwellAnchorAt` = a historical instant older than
    `after` fires on the FIRST eligible sweep (not `after` after deploy); a backfilled member
    with NULL `dwellAnchorAt` falls back to `enteredAt`.

### Integration — member access (`bucket-access.test.ts`)
23. `count()`: 3 active + 2 left → `data===3`; soft-deleted contact excluded (GDPR join).
24. `has()`: active → true; left → false; non-member → false.
25. `members()` pagination: 5 active, `limit:2` → `data.length===2`, `count===5`, `cursor`
    set; follow cursor twice → exhausts, final `cursor===null`; no overlap/no gap (keyset).
26. hard cap: `members({limit:1000})` → at most `MAX_PAGE` rows.
27. async iterator: `for await (... membersIterator({pageSize:2}))` yields all 5 exactly once.
28. error contract: force a db error → `{ error }` populated, no throw.
28b. `overrides.db` seam: a client built with `overrides.db` has its accessors hit the
    injected db (via `dbResolver` re-bind), not the `getDb()` singleton.

### Integration — exitOn migration (`reactivation-dormancy`)
29. value-equality guard: `reactivationDormancy.meta.exitOn` contains
    `{ event: "bucket:left:went-dormant" }` after the migration — proves `wentDormant.left`
    is byte-identical and the bucket-leave→exitOn path is unchanged.

### Type-level (`*.test-d.ts` / inline `expectTypeOf`)
30. literal preservation:
    `expectTypeOf(wentDormant.entered).toEqualTypeOf<"bucket:entered:went-dormant">()`.

### Cycle / standalone-import smoke (`bucket-reactions.test.ts`)
31. import each journey module in isolation (no barrel) and assert every `trigger.event` /
    `exitOn[].event` is a non-empty string — guards the ESM-cycle / TDZ regression.

---

## 14. Open questions for human

1. **Backfill `dwellAnchorAt` derivation scope.** §6.3 commits to a new nullable
   `dwellAnchorAt` column set by the first-time backfill (so dwell fires for the genuinely
   long-dormant population immediately, not `after` days after deploy). The derivation is
   cheap and batched only for windowed/event criteria (e.g. `max(occurredAt)` of the
   qualifying event = "when they became dormant"). For composite/property shapes with no
   cheap per-matcher timestamp, `dwellAnchorAt` stays NULL and dwell measures from
   `enteredAt` (= backfill time). **Is the windowed/event anchor derivation in scope for
   this build, or do we ship dwell measuring age-since-`enteredAt` and document the
   first-deploy clock-start caveat?** (The spec implements the column + coalesce either way;
   only the backfill-side derivation is the question.)

2. **Filtered reactions still write a `journeyStates` row.** `firstEntryOnly` / `reason`
   filters run inside `run` AFTER enrollment, so a filtered-out transition writes a short
   active→completed `journeyStates` row. This keeps `reason`-array support and the full guard
   stack simple, at the cost of churn rows in Studio for filtered transitions. Acceptable, or
   should filters be pushed into `trigger.where` to avoid the row (loses array-of-reasons and
   complicates the encoding)?

3. **`expiring` reactions (deferred).** A future `bucket.on("expiring", { before }, ...)`
   would fire ahead of a `maxDwell`/fastExpiry leave (a pre-leave warning). It is explicitly
   out of this build. Confirm it should be designed against the same cron + `dwellState`-style
   bookkeeping when we pick it up, or whether it belongs to the durable per-user timer path.

4. **`dwellCount` semantics for `every`.** The spec defines `dwellCount` as the deterministic
   interval ordinal `floor((sweepInstant - anchor) / offsetMs)` (gap-stable, equals elapsed
   periods), NOT the count of actual fires (which coalesces across outages). Confirm that's
   the meaning consumers want, vs. a monotonic "this is the Nth time we fired".
