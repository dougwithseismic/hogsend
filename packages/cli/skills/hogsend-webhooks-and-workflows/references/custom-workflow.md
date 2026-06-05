# Reference: custom Hatchet tasks (`extraWorkflows`)

Custom tasks are durable background jobs you own — one-off maintenance, backfills,
cron-style work, or event-driven side effects. They run in the **worker** process
alongside the engine's built-in workflows. You define them in `src/workflows/`,
export them from `src/workflows/index.ts`, and the scaffold passes them to
`createWorker({ container, journeys, extraWorkflows })`.

The option is **`extraWorkflows` — NOT `workflows`.** The engine registers its own
built-ins (`send-email`, `import-contacts`, `check-alerts`, and the bucket tasks)
automatically; `extraWorkflows` is *additive*. Never list a built-in there.

## Defining a task

Import the shared `hatchet` client from `@hogsend/engine`. Two flavours:

- `hatchet.task({ name, fn })` — a plain task you trigger explicitly (one-off
  jobs, backfills, anything kicked off from the dashboard or via `hatchet.events`).
- `hatchet.durableTask({ name, onEvents, fn })` — long-running / event-driven work
  (this is what journeys use under the hood). Declare `onEvents: [eventName]` to
  have Hatchet route ingested events to the task automatically.

### JSON-serializable IO (hard requirement)

A task's **input** and **return value** must serialize to JSON.

- Use specific, named keys (`{ jobId: string; format: string }`) or
  `JsonValue`-compatible types.
- Do **NOT** use a `[key: string]: unknown` index signature on the input type.
- Return a plain object (or a small JSON-safe value) so Hatchet can store the
  task output — return `void`/`undefined` if there's nothing to report.

```ts
import { hatchet } from "@hogsend/engine";

// input + return are both plain, named-key JSON objects
export const reindexSearchTask = hatchet.task({
  name: "reindex-search",
  retries: 2,
  executionTimeout: "30m",
  fn: async (input: { since: string; dryRun: boolean }) => {
    // ... do the work ...
    return { reindexed: 0, skipped: 0, dryRun: input.dryRun };
  },
});
```

The engine's own `import-contacts` task is a faithful template for a parameterized
job — a named-key input, batched processing, and a JSON return:

```ts
export const importContactsTask = hatchet.task({
  name: "import-contacts",
  retries: 0,
  executionTimeout: "600s",
  fn: async (input: { jobId: string; data: string; format: string }) => {
    // ...batched upserts...
    return { status: "completed", processed, failed };
  },
});
```

### Event-driven variant

If the task should run whenever a particular event is ingested, use a durable task
with `onEvents`. The input arrives as the ingested event payload
(`userId` / `userEmail` / scalar `properties`):

```ts
import { hatchet } from "@hogsend/engine";

export const onSignupAuditTask = hatchet.durableTask({
  name: "on-signup-audit",
  onEvents: ["user.signed_up"],
  executionTimeout: "10m",
  retries: 1,
  fn: async (input: {
    userId: string;
    userEmail: string;
    properties: Record<string, string | number | boolean | null>;
  }) => {
    // side effect; return a JSON-safe summary (or nothing)
    return { audited: input.userId };
  },
});
```

> For normal lifecycle messaging, prefer a journey (`defineJourney`) over a raw
> durable task — journeys give you enrollment guards, state tracking, durable
> sleeps and exit conditions for free. Reach for a custom durable task only when
> you need orchestration the journey system doesn't model.

## Accessing the database inside a task

Tasks run in the worker and are constructed at module load, so they don't receive
the request `container`. Open a connection inside `fn` with `createDatabase` from
`@hogsend/db` and **always close it** in a `finally`:

```ts
import { createDatabase } from "@hogsend/db";
import { createLogger, hatchet } from "@hogsend/engine";

export const nightlyCleanupTask = hatchet.task({
  name: "nightly-cleanup",
  fn: async () => {
    const { db, client } = createDatabase({ url: process.env.DATABASE_URL ?? "" });
    const logger = createLogger(process.env.LOG_LEVEL ?? "info");
    try {
      // ...work with db...
      return { ok: true };
    } finally {
      await client.end({ timeout: 5 });
    }
  },
});
```

## Wiring it up (two edits)

### 1. Export from `src/workflows/index.ts`

List only YOUR tasks here — the engine adds its built-ins itself:

```ts
import { backfillExampleTask } from "./backfill-example.js";
import { nightlyCleanupTask } from "./nightly-cleanup.js";

export const extraWorkflows = [backfillExampleTask, nightlyCleanupTask];
```

### 2. Confirm `src/worker.ts` passes it

The scaffold already does this — the key detail is the option name:

```ts
const worker = createWorker({
  container: client,
  journeys,
  buckets,
  extraWorkflows, // <-- NOT `workflows`
});
```

`createWorker` builds the worker as `[...engine built-ins, ...journeyTasks,
...bucketTasks, ...extraWorkflows]`. After editing, restart the worker
(`hatchet worker dev` or `pnpm worker:dev`) so the new task registers.

## Authoring a new task — checklist

1. Create `src/workflows/<name>.ts` exporting `hatchet.task({...})` (or
   `hatchet.durableTask` for event-driven/long-running work).
2. Type the input with named keys (no `[key: string]: unknown`); return JSON-safe
   data.
3. Open `createDatabase(...)` inside `fn` and close it in `finally`.
4. Add the export to the `extraWorkflows` array in `src/workflows/index.ts`.
5. Restart the worker; trigger the task (Hatchet dashboard or `hatchet.events`).
