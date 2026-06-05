# Registering + wiring a bucket (dual wiring)

A bucket only does anything once it is (1) exported from the barrel and (2)
threaded into BOTH engine factories. This is the dual wiring the SKILL keeps
warning about: `createHogsendClient` AND `createWorker`. Miss either and the
bucket is half-alive.

## 1. Export from `src/buckets/index.ts`

The barrel exports the `buckets: DefinedBucket[]` array — this is the single
list both factories consume.

```ts
// src/buckets/index.ts
import type { DefinedBucket } from "@hogsend/engine";
import { powerUsers } from "./power-users.js";
import { wentDormant } from "./went-dormant.js";

/**
 * All defined buckets for this app. Passed to createHogsendClient({ buckets })
 * and createWorker({ buckets }). Edit freely — this is your content.
 */
export const buckets: DefinedBucket[] = [powerUsers, wentDormant];

// Re-export individual buckets for direct reference (tests, custom wiring).
export { powerUsers, wentDormant };
```

Also add the new id to the `BucketId` union in
`src/journeys/constants/index.ts` (see bucket-id-aliases) — that's part of
"registering" a bucket as far as typo-safety goes.

## 2. Thread into `createHogsendClient` (the registry + real-time + reconcile)

In `src/index.ts` (the HTTP entry point), the client receives `buckets`. This
builds the `BucketRegistry`, installs it as the process singleton (so the
real-time ingest path and the reconcile cron can resolve it), and validates
every `meta` via `bucketMetaSchema.parse()`.

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

## 3. Thread into `createWorker` (fast-expiry timer + boot backfill)

In `src/worker.ts` (the task-execution entry point), BOTH the client AND the
worker get `buckets`. The client call here installs the registry for the worker
process; the `createWorker({ buckets })` call registers the per-user fast-expiry
timer task for any bucket with `fastExpiry: true`.

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
    buckets,            // ← registers fastExpiry timer task(s) for opted-in buckets
    extraWorkflows,
  });

  // ...signal handlers...
  await worker.start();
}
```

## What each side gives you

| Wiring | What it enables |
|--------|-----------------|
| `createHogsendClient({ buckets })` | Builds + installs the `BucketRegistry` singleton; validates every `meta`; powers the real-time join/leave eval inside `ingestEvent`; lets the reconcile cron resolve enabled buckets. Required in BOTH `index.ts` and `worker.ts`. |
| `createWorker({ buckets })` | Registers the single shared `bucket:arm-expiry` durable timer task — but ONLY if some enabled bucket has `fastExpiry: true`. Triggers the boot-time backfill / criteria-change re-eval. |

If you ONLY wire the client: time-based and fast-expiry leaves never run (no
worker tasks), and a new bucket is never backfilled. If you ONLY wire the worker
(client `buckets` empty): the registry is empty, so the worker's tasks resolve
nothing.

## The reconcile cron (engine-owned — you don't register it)

The engine ALWAYS registers `bucketReconcileTask` and `bucketBackfillTask` in
the worker's base workflows — you do NOT add them to `extraWorkflows`. The cron:

- runs on `BUCKET_RECONCILE_CRON` (default `*/5 * * * *`), non-cancelling (an
  overrunning sweep queues, never cancels);
- sweeps every enabled time-based / `maxDwell` dynamic bucket and emits
  `bucket:left` (and absence `bucket:entered`) for members the clock moved;
- is the authoritative backstop even when `fastExpiry` is on.

The boot backfill (`bucketBackfillTask`, kicked off by the worker on start):

- on a NEW bucket id → materializes the full member set from history WITHOUT
  emitting `bucket:entered` (no historical blast into live journeys);
- on a CHANGED `criteria` (detected via a stored hash diff) → re-evaluates: joins
  new matchers silently, and emits `bucket:left` for members who no longer match.

So: change a bucket's `criteria` and redeploy the worker → the engine
automatically reconciles existing memberships on boot. You don't run a migration.

## Enabling / disabling at load time

- `meta.enabled: false` keeps a bucket out of the registry entirely.
- The `ENABLED_BUCKETS` env var (comma-separated ids, or `*` for all) filters
  which buckets load, mirroring `ENABLED_JOURNEYS`. You can override per-call via
  `createHogsendClient({ enabledBuckets })` / `createWorker({ enabledBuckets })`.

To verify a bucket is live on a running instance (membership counts, transition
events), see the hogsend-cli skill.
