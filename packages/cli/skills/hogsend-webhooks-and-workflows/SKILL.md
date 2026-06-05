---
name: hogsend-webhooks-and-workflows
description: Use when adding an inbound webhook source in src/webhook-sources/ (defineWebhookSource — auth header + envKey, optional Zod schema, transform(payload, ctx) -> IngestEvent | null, served at POST /v1/webhooks/:id) or a custom Hatchet task in src/workflows/ passed as extraWorkflows (NOT workflows) to createWorker, including the idempotent batched expand→migrate→contract backfill pattern.
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Hogsend webhooks & workflows

This skill covers the two extension points a scaffolded Hogsend app uses to take
in external events and run background jobs:

1. **Webhook sources** — turn an inbound HTTP payload into an `IngestEvent` that
   flows through the engine's ingestion pipeline (and can trigger journeys).
2. **Custom Hatchet tasks** — durable background work (one-off jobs, backfills,
   cron-style maintenance) registered alongside the engine's built-in workflows.

You are editing a **content-only consumer**: you import everything from
`@hogsend/engine` (and `@hogsend/db` for tasks). Never edit engine internals.
Relative imports use the ESM `.js` extension.

## Capability map / key concepts

- **`defineWebhookSource({ meta, auth, schema?, transform })`** (from
  `@hogsend/engine`) — declares one source served at `POST /v1/webhooks/:id`.
  `auth` matches a request header against an env secret; `schema` is an optional
  Zod validator; `transform(payload, ctx)` returns an `IngestEvent | null`
  (`null` = accept-and-skip). Register sources in `src/webhook-sources/index.ts`
  and pass them to `createApp(client, { webhookSources })` in `src/index.ts`.
- **`IngestEvent`** — the shape `transform` must return:
  `{ event, userId, userEmail, properties, idempotencyKey? }`. The route feeds it
  straight into `ingestEvent()`, so a webhook can enroll users into journeys.
- **Custom Hatchet tasks** — define with `hatchet.task({ name, fn })` (or
  `hatchet.durableTask` for event-driven/long-running work), export from
  `src/workflows/index.ts` in the `extraWorkflows` array, and pass it as
  `createWorker({ ..., extraWorkflows })` — the option is **`extraWorkflows`,
  NOT `workflows`**. Never list the engine's built-ins (send-email,
  import-contacts, check-alerts, bucket tasks) — those register automatically.
- **JSON-serializable IO** — task input AND return value must serialize to JSON.
  Use specific keys or `JsonValue`-compatible types; do **not** use a
  `[key: string]: unknown` index signature.
- **Backfill pattern** — `runBatchedBackfill()` (from `@hogsend/engine`) drives a
  long data migration in small, idempotent, lock-friendly batches from inside a
  task — the supported home for bulk data changes (never inside a schema
  migration). Follow expand → migrate → contract across releases.

## Task playbooks — load the matching reference

- **Adding / editing an inbound webhook source** → load
  `references/webhook-source.md` (defineWebhookSource fields, the `transform` →
  `ingestEvent` contract, auth matching, registration + `createApp` wiring).
- **Writing a custom Hatchet task (one-off job, cron, event-driven)** → load
  `references/custom-workflow.md` (`hatchet.task`/`durableTask`,
  JSON-serializable IO, export from `index.ts`, `createWorker({ extraWorkflows })`).
- **Backfilling a new column on existing rows** → load
  `references/backfill-pattern.md` (the idempotent batched
  expand→migrate→contract job from the template example).

## Cross-skill pointers

- A webhook's `transform` only needs to emit the right `event`/`properties`;
  whether a journey then enrolls or exits is decided by trigger/exit conditions —
  see the **hogsend-conditions** skill for `where`/`exitOn`/criteria and duration
  helpers.
- To verify a webhook or task against a running instance (events landing,
  contacts upserted, journeys firing), see the **hogsend-cli** skill.
