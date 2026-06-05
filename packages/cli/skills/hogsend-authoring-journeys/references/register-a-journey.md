# Registering a journey

Defining a journey is not enough — it has to be in the `journeys` array that the
client and worker receive. Both processes (HTTP API + Hatchet worker) must see
the same array: the API needs it to route ingested events, the worker needs it to
register the durable task that actually runs `run()`.

## 1. Export from `src/journeys/index.ts`

Add your journey to the `journeys` array (and re-export it for tests / direct
reference):

```ts
import type { DefinedJourney } from "@hogsend/engine";
import { activation } from "./activation.js";
import { testOnboarding } from "./test-onboarding.js";
import { welcome } from "./welcome.js";

export const journeys: DefinedJourney[] = [
  welcome,
  testOnboarding,
  activation,            // <-- your new journey
];

export { activation, testOnboarding, welcome };
```

The exported `journeys` array is the single source of truth that both entry
points consume.

## 2. It is already threaded into the client + worker

In a scaffolded app both entry points import that same array — you usually do
NOT need to touch these files, just confirm they pass `journeys`:

```ts
// src/index.ts  (HTTP API)
import { createApp, createHogsendClient } from "@hogsend/engine";
import { buckets } from "./buckets/index.js";
import { templates } from "./emails/index.js";
import { journeys } from "./journeys/index.js";
import { webhookSources } from "./webhook-sources/index.js";

const client = createHogsendClient({ journeys, buckets, email: { templates } });
const app = createApp(client, { webhookSources });
```

```ts
// src/worker.ts  (Hatchet worker — this is what runs run())
import { createHogsendClient, createWorker } from "@hogsend/engine";
import { buckets } from "./buckets/index.js";
import { templates } from "./emails/index.js";
import { journeys } from "./journeys/index.js";
import { extraWorkflows } from "./workflows/index.js";

const client = createHogsendClient({ journeys, buckets, email: { templates } });
const worker = createWorker({ container: client, journeys, buckets, extraWorkflows });
await worker.start();
```

If you build a new entry point or a test harness, the rule is: **pass the same
`journeys` array to both `createHogsendClient({ journeys })` and
`createWorker({ container, journeys })`.** A journey missing from the worker is
defined but never executes; missing from the client and ingested events won't
route to it. (`buckets` and `extraWorkflows` are the sibling content arrays the
scaffold threads through the same way — pass them when present.)

## 3. (Optional) `ENABLED_JOURNEYS`

The `ENABLED_JOURNEYS` env var filters which registered journeys actually load —
comma-separated ids, or `*` (or empty/unset) for all:

```bash
# only these two run; everything else is registered but inert
ENABLED_JOURNEYS=welcome,activation

# all journeys (default)
ENABLED_JOURNEYS=*
```

The filter matches on `meta.id`, so keep ids stable. It is applied identically
when building the registry (client) and when selecting durable tasks (worker), so
a journey is either fully on or fully off across both processes. Use it to ship a
journey's code but keep it dark until you flip the env var — distinct from
`meta.enabled: false` (code-level off) and the runtime admin toggle (see the
**hogsend-cli** skill's `journeys enable/disable`).

## Checklist for a new journey

1. New file in `src/journeys/` using `defineJourney({ meta, run })`.
2. Any new event / template keys added to `src/journeys/constants/`.
3. New email? component + registry entry under `src/emails/` for each
   `Templates.*` key you send.
4. Journey added to the `journeys` array in `src/journeys/index.ts`.
5. Confirm `src/index.ts` and `src/worker.ts` both receive that array.
6. If gating by env, add the id to `ENABLED_JOURNEYS`.

To smoke-test it end-to-end against a running instance (enroll a user, watch the
state reach `completed`), use the **hogsend-cli** skill.
