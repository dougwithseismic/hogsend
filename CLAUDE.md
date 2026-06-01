# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Hogsend** — code-first, agentic-ready lifecycle orchestration engine for teams on PostHog + Resend. Turborepo monorepo using pnpm workspaces. Full product spec lives in `docs/product-spec.md`.

## Commands

```bash
pnpm dev              # Start API via Turbo (port 3002)
pnpm build            # Build all packages/apps via Turbo
pnpm lint             # Biome check (linting + formatting)
pnpm lint:fix         # Biome auto-fix
pnpm format           # Biome format --write
pnpm check-types      # TypeScript type-checking across all workspaces

# Run API workspace directly
pnpm --filter @hogsend/api dev

# API only (from apps/api)
cd apps/api && pnpm dev         # tsx watch with .env
cd apps/api && pnpm build       # tsup → dist/

# Worker (from apps/api)
cd apps/api && hatchet worker dev              # Hatchet CLI with hot-reload (recommended for dev)
cd apps/api && pnpm worker:dev                 # tsx watch without Hatchet CLI
cd apps/api && pnpm worker                     # production: node dist/worker.js

# Tests (vitest, API workspace only)
cd apps/api && pnpm test        # vitest run (single pass)
cd apps/api && pnpm test:watch  # vitest watch mode

# Database (from packages/db)
cd packages/db && pnpm db:generate    # generate migration from schema changes
cd packages/db && pnpm db:migrate     # run migrations
cd packages/db && pnpm db:push        # push schema directly (dev shortcut)
cd packages/db && pnpm db:studio      # Drizzle Studio GUI

# First-time setup (Docker, deps, env)
pnpm setup                      # runs scripts/setup.sh

# Infrastructure (TimescaleDB, Redis, Hatchet-Lite)
docker compose up -d            # Start postgres, redis, hatchet-lite
```

## Architecture

### Monorepo layout

Hogsend is a **versioned engine consumed as a dependency**, not a fork. The framework lives in `@hogsend/engine`; `apps/api` is a thin **content-only** consumer that wires its journeys/templates/webhook-sources into the engine's factories. New apps are scaffolded with `pnpm dlx create-hogsend@latest`.

- **packages/engine** — the framework (`@hogsend/engine`): `createHogsendClient`, `createApp`, `createWorker`, `defineJourney`, `defineWebhookSource`, the ingestion + tracking pipeline, the engine-owned `createTrackedMailer`, all built-in routes + middleware, and the registries. This is the public API surface and the committed semver boundary.
- **apps/api** — the dogfood **consumer** app: content only (journeys, webhook-sources, workflows, `src/emails/` templates, constants) plus two thin entry points (`src/index.ts` HTTP, `src/worker.ts` task execution) that call the engine factories
- **packages/core** — Journey types, Zod schemas, condition evaluation engine, duration helpers, journey registry (`@hogsend/core`)
- **packages/db** — Drizzle ORM schema, migrations (two-track: engine + client), and seed (`@hogsend/db`). Exports raw `.ts` — no build step, bundled by consumers via tsup `noExternal`
- **packages/email** — render machinery only (`@hogsend/email`): `renderToHtml`/`renderToPlainText`, `getTemplate`/`createRegistry`, the `TemplateRegistry`/`TemplateDefinition` types + open `TemplateRegistryMap` (module-augmented by consumers), unsubscribe token/URL helpers. Concrete templates are NOT here — they live in the consumer's `src/emails/`
- **packages/plugin-posthog** — PostHog person property fetching (with Redis cache), event capture (`@hogsend/plugin-posthog`)
- **packages/plugin-resend** — the Resend `EmailProvider`: `createResendProvider` (the dumb provider contract — send + webhook parse/verify). Tracking, preference checks, the `email_sends` write, and rendering live in the engine's `createTrackedMailer`, not here (`@hogsend/plugin-resend`)
- **packages/create-hogsend** — the `create-hogsend` scaffolder (copies `template/`, substitutes `{{APP_NAME}}`/`{{ENGINE_VERSION}}`)
- **packages/cli** — `@hogsend/cli` (Node): `eject`/`patch` today; the planned home for the consolidated `hogsend` CLI
- **packages/typescript-config** — Shared tsconfig bases (`@repo/typescript-config`)

### Engine factories (packages/engine) + the thin consumer (apps/api)

The engine exposes a dependency-injection client and app/worker factories; the consumer (`apps/api`) wires content into them. All of the following live in `packages/engine/src/`:

- `env.ts` — `@t3-oss/env-core` validates env vars at startup (DATABASE_URL, BETTER_AUTH_SECRET, RESEND_API_KEY required)
- `container.ts` — `createHogsendClient(opts?)` builds the DI client: `{ env, logger, db, dbClient, auth, email, emailService, analytics, registry, hatchet, clientJournal }`. Options: `{ journeys?, email?: { provider?, templates? }, analytics?, enabledJourneys?, clientJournal?, overrides? }` — email config is grouped under `email` (the engine owns the cohesive templates→render→preferences→tracking→`email_sends` pipeline; the `EmailProvider` is only the swappable wire). `analytics` is top-level because the engine itself uses it. Other channels (SMS/push/Slack) are plain functions, not options. `overrides` is a small advanced/test-only hatch (`{ mailer?, auth?, hatchet?, db? }`). Returns the `HogsendClient`; set on every request via Hono middleware, read with `c.get("container")` in handlers
- `app.ts` — `createApp(client, { routes?, middleware?, webhookSources?, onError? })` creates the OpenAPIHono app with the middleware stack (secureHeaders, CORS, compress, requestId, request logging, error handler). Auth mounts at `/api/auth/*`; OpenAPI docs/Scalar UI at `/openapi.json` + `/docs` in non-production. Built-in v1 routers (health, ingest, email unsubscribe/preferences, admin, tracking click/open, webhooks) are registered by the engine; the consumer injects only `webhookSources`
- Routes use `createRoute()` + `OpenAPIHono.openapi()` with Zod schemas for request/response validation

`AppEnv` type defines Hono context variables: `{ container, requestId, user, session }` (`container` holds the `HogsendClient`).

The consumer's `apps/api/src/index.ts` is essentially `createApp(createHogsendClient({ journeys, email: { templates } }), { webhookSources })` behind a schema boot-guard; `worker.ts` is `createWorker({ container, journeys })`.

When adding a new built-in route (engine work): define Zod schemas, create the route with `createRoute()`, implement the handler with `.openapi()`, register it in the engine's `routes/index.ts`.

### Hatchet (workflow/task orchestration)

Hatchet handles durable task execution — email sends, journey orchestration, background jobs. The API and worker are separate processes sharing the same codebase:

- **API process** (`src/index.ts`) — serves HTTP, pushes events to Hatchet via `hatchet.events.push()`
- **Worker process** (`src/worker.ts`) — long-running process that executes Hatchet tasks. `createWorker({ container, journeys, enabledJourneys?, extraWorkflows? })` registers the engine's built-in tasks (`sendEmailTask`, `importContactsTask`, `checkAlertsTask`) + all enabled journey tasks + any `extraWorkflows` you pass. Graceful shutdown (SIGTERM/SIGINT) via `worker.stop()`
- **Event-driven routing** — journey tasks declare `onEvents: [trigger.event]` on their Hatchet durable task; the API pushes events and Hatchet routes them to matching tasks automatically
- **Built-in workflows** live in `packages/engine/src/workflows/` (`send-email.ts`, `import-contacts.ts`, `check-alerts.ts`). Consumers add their own custom tasks in their `src/workflows/` and pass them via `extraWorkflows`
- **`hatchet.yaml`** — CLI config for `hatchet worker dev` (run command, watch patterns)

When adding a custom workflow task (consumer): define it in your `src/workflows/`, export from `src/workflows/index.ts`, and pass it to `createWorker({ ..., extraWorkflows: [...] })` in `src/worker.ts`. (The option is `extraWorkflows`, not `workflows`.)

Task input types must be JSON-serializable (extend Hatchet's `JsonObject`). Don't use `[key: string]: unknown` index signatures — use specific keys or `JsonValue`-compatible types.

### Journey system

Journeys use a code-first `defineJourney()` pattern — each journey is its own Hatchet durable task with TypeScript control flow:

- **`defineJourney({ meta, run })`** (engine: `packages/engine/src/journeys/define-journey.ts`, imported as `import { defineJourney } from "@hogsend/engine"`) — accepts `JourneyMeta` (trigger, entryLimit, exitOn, suppress) and a `run` function `(user: JourneyUser, ctx: JourneyContext) => Promise<void>`. Returns `{ meta, task }` where task is the Hatchet durable task. Includes an active-state guard that prevents concurrent enrollment in the same journey
- **Event-driven triggers** — each journey declares `onEvents: [trigger.event]`; when the ingest endpoint pushes an event, Hatchet routes it to matching journeys
- **Enrollment guards** — checked inside the task before `run()` executes, in order: (1) `meta.enabled` flag, (2) `evaluateTriggerConditions()` against event properties if `trigger.where` is set, (3) `checkEntryLimit()` enforcing once/once_per_period/unlimited, (4) `checkEmailPreferences()` for unsubscribed users. Ineligible events return `{ status: "skipped", reason }` without creating state
- **State tracking** — on entry, a `journeyStates` row is created with status "active". On completion → "completed" + `journey:completed` event. On error → "failed" + `journey:failed` event
- **`JourneyContext`** (engine: `packages/engine/src/journeys/journey-context.ts`) provides only durable execution primitives:
  - `ctx.sleep({ duration, label? })` — Hatchet durable sleep; sets state to "waiting", resumes to "active"; returns `{ sleptAt, resumedAt }`
  - `ctx.checkpoint(label)` — updates `currentNodeId` in journeyStates for observability
  - `ctx.trigger({ event, userId, properties? })` — pushes event through the full ingest pipeline (stores, routes to Hatchet, processes exitOn). Enables cross-journey triggers
  - `ctx.identify(properties)` — sets person properties on PostHog for the current user (no-op without `POSTHOG_API_KEY`)
  - `ctx.guard.isSubscribed()` — checks if user is still subscribed (useful after long sleeps)
  - `ctx.history.hasEvent({ userId, event, within? })` — check if event occurred, returns `{ found, count }`
  - `ctx.history.journey({ userId, journeyId })` — check journey completion history, returns `{ completed, lastCompletedAt, entryCount }`
  - `ctx.history.email({ email, template })` — check email send history, returns `{ sent, lastSentAt, count }`
  - `ctx.posthog.capture({ event, properties? })` — fire a custom PostHog event for the current user (no-op without `POSTHOG_API_KEY`)
- **Service integrations are standalone imports**, not on the context. Email: `sendEmail()` from `@hogsend/engine` (engine `lib/email.ts`). PostHog: `getPostHog()` from `@hogsend/engine`. All functions follow single-object-in, result-object-out pattern
- **Duration helpers** — `days()`, `hours()`, `minutes()` from `@hogsend/core` (re-exported by `@hogsend/engine`) replace magic duration strings
- **Constants** — `Events` and `Templates` live in the **consumer's** `src/journeys/constants/` — `as const` typed values replacing magic strings. `Templates` keys must match the consumer's `src/emails/registry.ts` + `templates.d.ts` augmentation
- **Journey registry** — `JourneyRegistry` class (from `@hogsend/core`) indexes journeys by ID and by trigger event. `ENABLED_JOURNEYS` env var (comma-separated IDs or `*` for all) controls which journeys are loaded

When adding a new journey (consumer): add event/template constants to `src/journeys/constants/`, create a file in `src/journeys/` using `defineJourney()` (imported from `@hogsend/engine`) with duration helpers and constant imports, import it in `src/journeys/index.ts` and add to the `journeys` array. If it sends a new email, add the template to `src/emails/` (component + `registry.ts` entry + `templates.d.ts` augmentation).

### Webhook source system

Generic webhook ingestion via `defineWebhookSource()` (engine: `packages/engine/src/webhook-sources/define-webhook-source.ts`, imported from `@hogsend/engine`). Each source declares metadata, auth (header + env key), optional Zod schema for validation, and a `transform(payload, ctx) → IngestEvent | null` function. Consumers register their sources in their own `src/webhook-sources/index.ts` and pass them to `createApp(client, { webhookSources })`; they're served at `POST /v1/webhooks/:sourceId`. The transform result feeds directly into `ingestEvent()`, so any webhook source can trigger journeys.

When adding a new webhook source (consumer): create a file in your `src/webhook-sources/` using `defineWebhookSource()`, add it to `src/webhook-sources/index.ts`.

### Ingestion pipeline

`ingestEvent()` (engine: `packages/engine/src/lib/ingestion.ts`) is the central event processing function used by both the ingest endpoint and webhook sources. It: (1) stores the event in `userEvents`, (2) pushes to Hatchet (which routes to matching journey tasks), (3) checks exit conditions on active journeys for the user, (4) upserts the contact record. Exit conditions are evaluated by matching event name against `exitOn` rules in journey metadata and applying property conditions.

### Email tracking (link clicks + opens)

First-party link click and email open tracking. All tracking code is engine-owned (`packages/engine/src/...`); outgoing email HTML is rewritten before reaching the provider:

- `lib/tracking.ts` — `prepareTrackedHtml()` calls `rewriteLinks()` (extracts URLs, bulk-inserts `tracked_links`, single-pass regex replace with redirect URLs) then `injectOpenPixel()` (appends 1x1 GIF `<img>` before `</body>`). Skips unsubscribe/preference links
- `routes/tracking/click.ts` — `GET /v1/t/c/:id` records `link_clicks` row, increments `clickCount`, sets `emailSends.clickedAt` (first click only via `WHERE clickedAt IS NULL`), 302 redirects to original URL, then fire-and-forget pushes `email.link_clicked` event through ingest + PostHog
- `routes/tracking/open.ts` — `GET /v1/t/o/:id` sets `emailSends.openedAt` (first open only), returns 1x1 transparent GIF with `no-store` cache headers, then fire-and-forget pushes `email.opened` event through ingest + PostHog
- `lib/tracking-events.ts` — `resolveEmailSendContext()` (single LEFT JOIN to get userId/templateKey from emailSends + journeyStates) and `pushTrackingEvent()` (fires PostHog capture + ingestEvent for a tracking event)
- Tracking is part of the engine-owned `createTrackedMailer` (`lib/mailer.ts`): it renders the template, checks preferences, calls `prepareTrackedHtml` (tracking domain = `API_PUBLIC_URL`), writes the `email_sends` row, then calls `provider.send(...)`. The provider (`createResendProvider`) is a dumb `EmailProvider`, so tracking comes along regardless of which provider you supply. Analytics is initialized once by `createHogsendClient` and passed to tracking endpoints
- DB tables: `tracked_links` (one row per unique URL per email), `link_clicks` (one row per click, with IP + user agent)

Full documentation: `docs/tracking.md`

### Condition evaluation engine

`@hogsend/core` provides a composable condition system (`evaluateCondition()`) supporting four types: `property` (property operator checks), `event` (event existence with optional time window), `email_engagement` (open/click tracking via emailSends/linkClicks), and `composite` (AND/OR composition). Used by enrollment guards, journey context event checks, and exit conditions.

### Testing

Tests use vitest and live in `apps/api/src/__tests__/`. The vitest config injects test env vars (DATABASE_URL, PORT, etc.) so tests don't need `.env`. Tests call `app.request()` directly against the Hono app — no HTTP server needed.

### Code style

- **Biome** for linting and formatting (not ESLint/Prettier)
- 2-space indent, double quotes, semicolons always, 80-char line width
- **Conventional Commits** enforced via `commitlint` + Lefthook `commit-msg` hook. Format: `type(scope): description` — types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Scope is optional, kebab-case. Header max 100 chars
- **Lefthook** git hooks: `commit-msg` runs commitlint; pre-commit runs `biome check` on staged files; pre-push runs `check-types`
- API builds target Node 22, ESM-only (`"type": "module"`)
- Use `.js` extensions in relative imports within the API (ESM resolution)

### Infrastructure

- **TimescaleDB** (Postgres 18) via docker-compose on port 5434 (user/pass/db: `growthhog`)
- **Redis** 8 (Alpine) via docker-compose on port 6380, for PostHog property caching
- **Hatchet-Lite** via docker-compose — dashboard at `localhost:8888`, gRPC at `localhost:7077`. Default login: `admin@example.com` / `Admin123!!`. Has its own Postgres 15 instance
- API default port is 3002 (configured via PORT env var)
- Node 22 required (pinned via `.node-version`)

### Deployment

- **Railway** (withSeismic team) — two services from same repo, plus Postgres, Redis, Hatchet-Lite
  - `hogsend-api` (`railway.toml`) — HTTP API, health check at `/v1/health`, pre-deploy runs `db:migrate`
  - `hogsend-worker` (`railway.worker.toml`) — Hatchet worker, no HTTP port, scales independently
  - `hatchet-lite` — self-hosted Hatchet engine (Docker image)
- **Cloudflare** — `hogsend.com` DNS on Cloudflare, `api.hogsend.com` CNAME → Railway
- **GitHub auto-deploy** — push to `main` triggers Railway build for both API and worker
- tsup bundles all `@hogsend/*` packages via `noExternal`; npm deps resolve from `node_modules` at runtime
- `/docs` and `/openapi.json` are disabled in production (`NODE_ENV=production`)
