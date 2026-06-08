---
name: hogsend-authoring-destinations
description: Use when adding or editing a code-defined OUTBOUND destination in src/destinations/ — defineDestination({ meta:{id}, events, transform(envelope, ctx) -> { url, method?, headers, body, isSuccess? } | null }) from @hogsend/engine. A destination is a delivery-time transform keyed by webhook_endpoints.kind that fans the outbound event catalog (contact.*, email.*, journey.completed, bucket.*) out to a product/data tool (PostHog, Segment, Slack, a CRM, a warehouse), reusing the engine's durable retry/backoff/DLQ delivery for free. Covers the shipped presets (webhook/posthog/segment/slack), ENABLED_DESTINATION_PRESETS, per-endpoint config credentials, the null-skip and throw-is-config-error contract, and the register ritual (src/destinations/index.ts + thread destinations into createHogsendClient in BOTH src/index.ts and src/worker.ts). NOT for ad-platform CAPI (deferred to PostHog CDP).
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Authoring Hogsend destinations

A **destination** is a code-defined target for Hogsend's OUTBOUND event stream —
PostHog, Segment, Slack, a CRM, a data warehouse. You declare it with
`defineDestination()` in `src/destinations/`, the symmetric twin of
`defineWebhookSource()` on the inbound side. It is the AUTHORING layer for event
**fan-out**.

The headline fact: a destination is a **delivery-time transform**, not a new
delivery pipeline. The engine already has a durable outbound spine — every
catalog event (`contact.*`, `email.*`, `journey.completed`, `bucket.*`) is
written as a `webhook_deliveries` row and POSTed with retry / backoff / DLQ /
reaper. A destination just **rewrites the HTTP request** for an endpoint whose
`kind` matches your destination's `id`. You inherit ALL the durable delivery
machinery for free — you only write the per-vendor projection.

You are editing a **scaffolded consumer app** (content only). You import
`defineDestination` from `@hogsend/engine`; you never touch engine internals (the
registry, the delivery task, the retry machinery are all engine-owned). Relative
imports use the ESM `.js` extension.

> ⚠️ Destinations are for event **fan-out**. They are NOT the home for
> ad-platform conversion forwarding (CAPI) — that stays deferred to PostHog CDP;
> Hogsend just fires the events.

## Do you even need to write one?

Probably not. The engine ships four presets, each `defineDestination()` already:

| preset id | target | credentials (per-endpoint `config`) |
|-----------|--------|-------------------------------------|
| `webhook` | the DEFAULT signed Standard-Webhooks POST to a subscriber URL | `secret` column (a `whsec_…`) |
| `posthog` | PostHog capture endpoint | `{ apiKey, host?, eventNames? }` |
| `segment` | Segment HTTP Tracking API (`/v1/track`, Basic auth) | `{ writeKey, host?, eventNames? }` |
| `slack`   | Slack incoming webhook (formatted text block) | `{ url?, username?, iconEmoji? }` — `url` falls back to the endpoint `url` column |

`webhook` and `posthog` are **always** registered. `segment`/`slack` register when
`ENABLED_DESTINATION_PRESETS` allows them (see below). To USE a preset you create a
`webhook_endpoints` row with that `kind` and its `config` (via the admin API /
`hs.webhooks` SDK) — **no code**. Write a `defineDestination()` only for a NEW
target shape, or to OVERRIDE a preset of the same id.

## The shape

```ts
import { defineDestination } from "@hogsend/engine";

export const crm = defineDestination({
  meta: {
    id: "crm",                 // == webhook_endpoints.kind it delivers
    name: "Acme CRM",
    description: "Forward lifecycle events to Acme.",
  },
  events: ["contact.created", "email.bounced"], // catalog events it accepts
  transform(envelope, ctx) {
    // envelope = the FROZEN { id, type, timestamp, data } emitOutbound wrote.
    // ctx.endpoint = the LIVE webhook_endpoints row (url, config, secret).
    const cfg = (ctx.endpoint.config ?? {}) as { token?: string };
    if (!cfg.token) {
      // A THROW = non-retryable CONFIG error → straight to the DLQ.
      throw new Error("crm destination missing config.token");
    }
    return {
      url: "https://api.acme.example/ingest",
      method: "POST",                          // optional, defaults to POST
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({ type: envelope.type, data: envelope.data }),
      // isSuccess?: (status, bodySnippet) => boolean  — optional; default is 2xx.
    };
  },
});
```

`defineDestination({ meta, events, transform })`:

| field | required | notes |
|-------|----------|-------|
| `meta.id` | yes | The `webhook_endpoints.kind` this destination delivers. Pick a stable lowercase id; an endpoint with `kind === meta.id` routes here. Reusing a preset id (`posthog`/`segment`/`slack`) **overrides** that preset (you win on the merge). |
| `meta.name` | yes | Human label. |
| `meta.description` | no | One-liner. |
| `events` | yes | The outbound catalog events this destination accepts (`OutboundEventName[]`). Per-endpoint subscription is STILL scoped by `webhook_endpoints.event_types`, so an endpoint only ever receives what it subscribed to — `events` documents intent and is the authoring-time contract. |
| `transform` | yes | `(envelope, ctx) => { url, method?, headers, body, isSuccess? } \| null`. **Synchronous.** |

`defineDestination` is an identity/validating function (like `defineWebhookSource`)
— it returns its argument so a typo in the shape is a compile error.

## The transform contract — three outcomes

The `transform` runs once per delivery ATTEMPT (including retries), so it must be a
**pure projection** of the envelope + endpoint — never mutate external state in it.

1. **Return an `AdapterRequest`** (`{ url, headers, body, method?, isSuccess? }`)
   → the delivery task POSTs exactly those bytes. `body` is the EXACT bytes sent
   (for the `webhook` preset they are the SIGNED bytes — never re-stringify them).
   Success is the default 2xx rule unless you supply `isSuccess`.
2. **Return `null`** → SKIP delivery for that envelope. The row is marked
   `delivered` as a successful **no-op** (no POST, no retry, no DLQ). Use this to
   filter: e.g. only forward `email.bounced` for a certain template, drop the
   rest.
3. **Throw** → a non-retryable CONFIG error (missing credential, bad shape). The
   row fast-fails straight to the dead-letter queue — it does NOT burn the retry
   budget. A bad config should fail loudly, not silently retry 8 times.

A network error / timeout / retryable HTTP status (`5xx`, `408`, `429`) is the
delivery task's job — it retries with backoff off `nextRetryAt`. You never handle
retries in a transform.

## Where credentials live

Destination credentials are **per-endpoint**, in `webhook_endpoints.config`
(a JSONB bag) — NOT env vars, NOT a fake `whsec_`. The transform reads
`ctx.endpoint.config`. This is the deliberate split from inbound presets (whose
secrets are env-gated): a destination can have many endpoints, each with its own
key, region, channel. `ENABLED_DESTINATION_PRESETS` only decides which preset
TRANSFORMS are resolvable, never supplies a credential.

## `ENABLED_DESTINATION_PRESETS` — which presets register

A process-wide env knob (same `*`/csv/`none`/absent grammar as
`ENABLED_WEBHOOK_PRESETS`), resolving which PRESET transforms are in the registry:

- absent → `webhook` + `posthog` only (the always-on set).
- `"none"` → STILL `webhook` + `posthog` (you can never disable the
  no-regression signed-POST path or the auto-seeded PostHog destination).
- a csv (e.g. `"segment,slack"`) → those, **unioned** with the always-on set.
- `"*"` → every shipped preset.

Your own `defineDestination()` destinations are NOT gated by this env — they are
always registered (they came from your `destinations` array). The env governs
PRESETS only.

## Registering a destination (the wiring ritual)

A defined destination does nothing until it is (1) exported from the barrel and
(2) threaded into `createHogsendClient` in BOTH entry points. Like buckets — and
UNLIKE lists — the wiring touches both `src/index.ts` and `src/worker.ts`, because
the durable delivery task runs in the WORKER process and resolves transforms from
the process registry `createHogsendClient` installs. **`destinations` is NOT passed
to `createWorker`** — the worker's `createHogsendClient` call installs the registry.

### 1. Export from `src/destinations/index.ts`

```ts
// src/destinations/index.ts
import type { DefinedDestination } from "@hogsend/engine";
import { crm } from "./crm.js"; // your defineDestination(), or inline it here

// All defined destinations for this app. Passed to
// createHogsendClient({ destinations }) in BOTH src/index.ts and src/worker.ts.
export const destinations: DefinedDestination[] = [crm];
```

### 2. Thread into `createHogsendClient` in `src/index.ts`

```ts
import { createApp, createHogsendClient } from "@hogsend/engine";
import { destinations } from "./destinations/index.js";
// ...templates, journeys, webhookSources...

const client = createHogsendClient({
  journeys,
  destinations,        // ← merged with the env presets; consumer wins on id collision
  email: { templates },
});
const app = createApp(client, { webhookSources });
```

### 3. Thread into `createHogsendClient` in `src/worker.ts`

```ts
import { createHogsendClient, createWorker } from "@hogsend/engine";
import { destinations } from "./destinations/index.js";

const client = createHogsendClient({
  journeys,
  destinations,        // ← same array; the WORKER's delivery task needs the registry
  email: { templates },
});
const worker = createWorker({ container: client, journeys /* …, NO destinations */ });
```

Wire `destinations` into `createHogsendClient` in BOTH files. Passing it to
`createWorker` is not an accepted option — the worker resolves the registry through
its OWN `createHogsendClient` call.

## Creating the endpoint that uses your destination

The destination is the TRANSFORM; an endpoint row is what makes it fire. Create
one with the admin API / `hs.webhooks.create` with `kind` = your destination id,
its `config` credentials, and the `eventTypes` it subscribes to. See the
**hogsend-client-sdk** / **hogsend-cli** skills for managing outbound endpoints.

## Golden rules

1. A destination is a delivery-time transform keyed by `webhook_endpoints.kind`,
   reusing the engine's durable delivery. You write the projection, not a pipeline.
2. `transform` is SYNCHRONOUS and a PURE projection (runs per attempt). Return a
   request, return `null` to skip (delivered no-op), or throw on bad config (→ DLQ).
3. Credentials live per-endpoint in `webhook_endpoints.config`, never in env.
   `ENABLED_DESTINATION_PRESETS` only governs which PRESETS register.
4. `webhook` + `posthog` presets are always on; you cannot disable them.
5. Wire `destinations` into `createHogsendClient` in BOTH `src/index.ts` AND
   `src/worker.ts`. Do NOT pass it to `createWorker`.
6. Reusing a preset id overrides that preset (consumer wins on the merge).
7. Destinations are event fan-out — NOT ad-platform CAPI (deferred to PostHog CDP).
