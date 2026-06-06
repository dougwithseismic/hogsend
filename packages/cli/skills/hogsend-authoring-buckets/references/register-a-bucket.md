# Registering + wiring a bucket (dual wiring)

A bucket only does anything once it is (1) exported from the barrel and (2)
threaded into BOTH engine factories. This is the dual wiring the SKILL keeps
warning about: `createHogsendClient` AND `createWorker`. Miss either and the
bucket is half-alive.

## 1. Export from `src/buckets/index.ts`

The barrel exports the `buckets` array — this is the single list both factories
consume. Let the array INFER its element types; do NOT annotate it
`DefinedBucket[]`. The annotation re-widens each bucket's `Id` literal back to
`string`, which would erase the literal types on `bucket.entered` / `bucket.left`
(see bucket-id-aliases).

```ts
// src/buckets/index.ts
import { powerUsers } from "./power-users.js";
import { wentDormant } from "./went-dormant.js";

/**
 * All defined buckets for this app. Passed to createHogsendClient({ buckets })
 * and createWorker({ buckets }). Edit freely — this is your content.
 * No `DefinedBucket[]` annotation — let the literal ids survive for typed refs.
 */
export const buckets = [powerUsers, wentDormant];

// Re-export individual buckets for direct reference (tests, custom wiring,
// and binding journeys to their typed `.entered` / `.left` refs).
export { powerUsers, wentDormant };
```

`createHogsendClient` / `createWorker` accept the base `DefinedBucket[]`, and a
`DefinedBucket<Id>` is assignable to `DefinedBucket`, so the inferred literal
array still type-checks at both factories — dropping the annotation is a pure
type-ergonomics win, never a wiring requirement.

That's the whole registration step. There is no separate `BucketId` union to
update anymore (the typed refs replace it — see bucket-id-aliases), and any
`.on()` reactions you attached ship automatically on the bucket (see below). You
do NOT register reactions separately.

## 2. Thread into `createHogsendClient` (registry + real-time + reconcile + reactions)

In `src/index.ts` (the HTTP entry point), the client receives `buckets`. This
builds the `BucketRegistry`, installs it as the process singleton (so the
real-time ingest path and the reconcile cron can resolve it), validates every
`meta` via `bucketMetaSchema.parse()`, and registers each bucket's `.on()`
reactions into the journey registry (so the admin/Studio feed and the dwell cron
can resolve them).

```ts
// src/index.ts
import { createApp, createHogsendClient } from "@hogsend/engine";
import { buckets } from "./buckets/index.js";
import { templates } from "./emails/index.js";
import { journeys } from "./journeys/index.js";
import { webhookSources } from "./webhook-sources/index.js";

const client = createHogsendClient({ journeys, buckets, email: { templates } });

// ...schema boot-guard...

const app = createApp(client, { webhookSources });
```

## 3. Thread into `createWorker` (reaction tasks + fast-expiry timer + boot backfill)

In `src/worker.ts` (the task-execution entry point), BOTH the client AND the
worker get `buckets`. The client call here installs the registry for the worker
process; the `createWorker({ buckets })` call registers the durable tasks every
bucket owns — its `.on()` reaction tasks, plus the per-user fast-expiry timer for
any bucket with `fastExpiry: true`.

```ts
// src/worker.ts
import { createHogsendClient, createWorker } from "@hogsend/engine";
import { buckets } from "./buckets/index.js";
import { templates } from "./emails/index.js";
import { journeys } from "./journeys/index.js";
import { extraWorkflows } from "./workflows/index.js";

async function main() {
  const client = createHogsendClient({
    journeys,
    buckets,
    email: { templates },
  });
  const worker = createWorker({
    container: client,
    journeys,
    buckets,            // ← registers reaction tasks + fastExpiry timer(s)
    extraWorkflows,
  });

  // ...signal handlers...
  await worker.start();
}
```

## Reactions ship with the bucket (no separate registration)

Every `bucket.on("enter" | "leave" | "dwell", ...)` call pushes a generated
durable journey onto `bucket.reactions`. You do NOT add reactions to the
`journeys` array, and you do NOT register them anywhere — passing `buckets` to
both factories is enough:

- the client registers each reaction's meta into the journey registry, and
- the worker registers each reaction's task.

Crucially, reactions are gated by **`ENABLED_BUCKETS`, NOT `ENABLED_JOURNEYS`**.
Their generated ids (`bucket-<id>-on-enter`, etc.) never appear in a consumer's
`ENABLED_JOURNEYS` csv, so they are selected with their owning bucket and are
absent whenever the bucket is disabled. (See the dwell/reactions section of the
main SKILL for what the reactions DO.)

## What each side gives you

| Wiring | What it enables |
|--------|-----------------|
| `createHogsendClient({ buckets })` | Builds + installs the `BucketRegistry` singleton; validates every `meta`; registers each bucket's reaction metas into the journey registry (bucket-gated); powers the real-time join/leave eval inside `ingestEvent`; lets the reconcile cron resolve enabled buckets. Required in BOTH `index.ts` and `worker.ts`. |
| `createWorker({ buckets })` | Registers each bucket's reaction tasks AND the shared fast-expiry durable timer task (the latter only if some enabled bucket has `fastExpiry: true`). Triggers the boot-time backfill / criteria-change re-eval. |

If you ONLY wire the client: reaction tasks, time-based, fast-expiry, and dwell
fires never run (no worker tasks), and a new bucket is never backfilled. If you
ONLY wire the worker (client `buckets` empty): the registry is empty, so the
worker's tasks resolve nothing.

## The reconcile cron (engine-owned — you don't register it)

The engine ALWAYS registers `bucketReconcileTask` and `bucketBackfillTask` in
the worker's base workflows — you do NOT add them to `extraWorkflows`. The cron:

- runs on `BUCKET_RECONCILE_CRON` (default `*/5 * * * *`), non-cancelling (an
  overrunning sweep queues, never cancels);
- sweeps every enabled time-based / `maxDwell` dynamic bucket and emits
  `bucket:left` (and absence `bucket:entered`) for members the clock moved;
- runs the `dwell` pass for any bucket with a `dwell` reaction (firing
  `dwell` over the continuously-resident population — see the main SKILL);
- is the authoritative backstop even when `fastExpiry` is on.

The boot backfill (`bucketBackfillTask`, kicked off by the worker on start):

- on a NEW bucket id → materializes the full member set from history WITHOUT
  emitting `bucket:entered` (no historical blast into live journeys), and derives
  the historical `dwellAnchorAt` so `dwell` can fire for the existing population;
- on a CHANGED `criteria` (detected via a stored hash diff) → re-evaluates: joins
  new matchers silently, and emits `bucket:left` for members who no longer match.

So: change a bucket's `criteria` and redeploy the worker → the engine
automatically reconciles existing memberships on boot. You don't run a migration.

## Enabling / disabling at load time

- `meta.enabled: false` keeps a bucket (and its reactions) out of the registry
  entirely.
- The `ENABLED_BUCKETS` env var (comma-separated ids, or `*` for all) filters
  which buckets load, mirroring `ENABLED_JOURNEYS`. It gates the bucket AND its
  reactions. You can override per-call via
  `createHogsendClient({ enabledBuckets })` / `createWorker({ enabledBuckets })`.

To verify a bucket is live on a running instance (membership counts, transition
events), see the hogsend-cli skill.
