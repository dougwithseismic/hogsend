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

- **apps/api** — Hono REST API + Hatchet worker (two entry points: `src/index.ts` for HTTP, `src/worker.ts` for task execution)
- **packages/core** — Journey types, Zod schemas, condition evaluation engine, duration helpers, journey registry (`@hogsend/core`)
- **packages/db** — Drizzle ORM schema, migrations, and seed (`@hogsend/db`). Exports raw `.ts` — no build step, bundled by consumers via tsup `noExternal`
- **packages/email** — React Email templates, render helpers, unsubscribe URL generation (`@hogsend/email`)
- **packages/plugin-posthog** — PostHog person property fetching (with Redis cache), event capture (`@hogsend/plugin-posthog`)
- **packages/plugin-resend** — Resend email delivery: send, batch, tracked sends, webhook parsing/verification, email service with bounce tracking (`@hogsend/plugin-resend`)
- **packages/typescript-config** — Shared tsconfig bases (`@repo/typescript-config`)

### API patterns (apps/api)

The API uses a dependency-injection container pattern:

- `src/env.ts` — `@t3-oss/env-core` validates env vars at startup (DATABASE_URL, BETTER_AUTH_SECRET, RESEND_API_KEY required)
- `src/container.ts` — `createContainer()` builds the DI container: `{ env, logger, db, dbClient, auth, email, emailService, registry, hatchet }`. Container is set on every request via Hono middleware and accessed with `c.get("container")` in handlers
- `src/app.ts` — `createApp(container)` creates the OpenAPIHono app with middleware stack (secureHeaders, CORS, compress, requestId, request logging, error handler). Auth is mounted at `/api/auth/*` via Better Auth handler. OpenAPI docs/Scalar UI available at `/openapi.json` and `/docs` in non-production
- `src/routes/index.ts` — `registerRoutes(app)` mounts all v1 sub-routers: health, ingest, email (unsubscribe/preferences), admin (contacts/preferences), tracking (click/open), webhooks (resend/sources)
- Routes use `createRoute()` + `OpenAPIHono.openapi()` with Zod schemas for request/response validation

`AppEnv` type defines Hono context variables: `{ container, requestId, user, session }`.

When adding a new route: define Zod schemas, create the route with `createRoute()`, implement the handler with `.openapi()`, register in `registerRoutes`.

### Hatchet (workflow/task orchestration)

Hatchet handles durable task execution — email sends, journey orchestration, background jobs. The API and worker are separate processes sharing the same codebase:

- **API process** (`src/index.ts`) — serves HTTP, pushes events to Hatchet via `hatchet.events.push()`
- **Worker process** (`src/worker.ts`) — long-running process that executes Hatchet tasks. Registers `sendEmailTask` + all enabled journey tasks. Has graceful shutdown (SIGTERM/SIGINT) that stops worker, PostHog, and Redis
- **Event-driven routing** — journey tasks declare `onEvents: [trigger.event]` on their Hatchet durable task; the API pushes events and Hatchet routes them to matching tasks automatically
- **Workflows** live in `src/workflows/` — currently `send-email.ts` (the `sendEmailTask` for Resend delivery with non-retryable error handling)
- **`hatchet.yaml`** — CLI config for `hatchet worker dev` (run command, watch patterns)

When adding a new workflow task: define it in `src/workflows/`, export from `src/workflows/index.ts`, add to the `workflows` array in `src/worker.ts`.

Task input types must be JSON-serializable (extend Hatchet's `JsonObject`). Don't use `[key: string]: unknown` index signatures — use specific keys or `JsonValue`-compatible types.

### Journey system

Journeys use a code-first `defineJourney()` pattern — each journey is its own Hatchet durable task with TypeScript control flow:

- **`defineJourney({ meta, run })`** in `src/journeys/define-journey.ts` — accepts `JourneyMeta` (trigger, entryLimit, exitOn, suppress) and a `run` function `(user: JourneyUser, ctx: JourneyContext) => Promise<void>`. Returns `{ meta, task }` where task is the Hatchet durable task. Includes an active-state guard that prevents concurrent enrollment in the same journey
- **Event-driven triggers** — each journey declares `onEvents: [trigger.event]`; when the ingest endpoint pushes an event, Hatchet routes it to matching journeys
- **Enrollment guards** — checked inside the task before `run()` executes, in order: (1) `meta.enabled` flag, (2) `evaluateTriggerConditions()` against event properties if `trigger.where` is set, (3) `checkEntryLimit()` enforcing once/once_per_period/unlimited, (4) `checkEmailPreferences()` for unsubscribed users. Ineligible events return `{ status: "skipped", reason }` without creating state
- **State tracking** — on entry, a `journeyStates` row is created with status "active". On completion → "completed" + `journey:completed` event. On error → "failed" + `journey:failed` event
- **`JourneyContext`** (`src/journeys/journey-context.ts`) provides only durable execution primitives:
  - `ctx.sleep({ duration, label? })` — Hatchet durable sleep; sets state to "waiting", resumes to "active"; returns `{ sleptAt, resumedAt }`
  - `ctx.checkpoint(label)` — updates `currentNodeId` in journeyStates for observability
  - `ctx.trigger({ event, userId, properties? })` — pushes event through the full ingest pipeline (stores, routes to Hatchet, processes exitOn). Enables cross-journey triggers
  - `ctx.guard.isSubscribed()` — checks if user is still subscribed (useful after long sleeps)
  - `ctx.history.hasEvent({ userId, event, within? })` — check if event occurred, returns `{ found, count }`
  - `ctx.history.journey({ userId, journeyId })` — check journey completion history, returns `{ completed, lastCompletedAt, entryCount }`
  - `ctx.history.email({ email, template })` — check email send history, returns `{ sent, lastSentAt, count }`
- **Service integrations are standalone imports**, not on the context. Email: `sendEmail()` from `src/lib/email.ts`. PostHog: `getPostHog()` from `src/lib/posthog.ts`. All functions follow single-object-in, result-object-out pattern
- **Duration helpers** — `days()`, `hours()`, `minutes()` from `@hogsend/core` replace magic duration strings
- **Constants** — `Events` and `Templates` in `src/journeys/constants/` replace magic string literals with `as const` typed values
- **Journey registry** — `JourneyRegistry` class (from `@hogsend/core`) indexes journeys by ID and by trigger event. `ENABLED_JOURNEYS` env var (comma-separated IDs or `*` for all) controls which journeys are loaded

When adding a new journey: add event/template constants to `src/journeys/constants/`, create a file in `src/journeys/` using `defineJourney()` with duration helpers and constant imports, import it in `src/journeys/index.ts` and add to the `allJourneys` array.

### Webhook source system

Generic webhook ingestion via `defineWebhookSource()` in `src/webhook-sources/define-webhook-source.ts`. Each source declares metadata, auth (header + env key), optional Zod schema for validation, and a `transform(payload, ctx) → IngestEvent | null` function. Sources are registered in `src/webhook-sources/index.ts` and served at `POST /v1/webhooks/:sourceId`. The transform result feeds directly into `ingestEvent()`, so any webhook source can trigger journeys.

When adding a new webhook source: create a file in `src/webhook-sources/` using `defineWebhookSource()`, add it to `src/webhook-sources/index.ts`.

### Ingestion pipeline

`ingestEvent()` in `src/lib/ingestion.ts` is the central event processing function used by both the ingest endpoint and webhook sources. It: (1) stores the event in `userEvents`, (2) pushes to Hatchet (which routes to matching journey tasks), (3) checks exit conditions on active journeys for the user, (4) upserts the contact record. Exit conditions are evaluated by matching event name against `exitOn` rules in journey metadata and applying property conditions.

### Email tracking (link clicks + opens)

First-party link click and email open tracking. Outgoing email HTML is rewritten before reaching Resend:

- `src/lib/tracking.ts` — `prepareTrackedHtml()` calls `rewriteLinks()` (extracts URLs, bulk-inserts `tracked_links`, single-pass regex replace with redirect URLs) then `injectOpenPixel()` (appends 1x1 GIF `<img>` before `</body>`). Skips unsubscribe/preference links
- `src/routes/tracking/click.ts` — `GET /v1/t/c/:id` records `link_clicks` row, increments `clickCount`, sets `emailSends.clickedAt` (first click only via `WHERE clickedAt IS NULL`), 302 redirects to original URL
- `src/routes/tracking/open.ts` — `GET /v1/t/o/:id` sets `emailSends.openedAt` (first open only), returns 1x1 transparent GIF with `no-store` cache headers
- Tracking is wired into the email pipeline via DI: `prepareTrackedHtml` is injected into `createEmailService()` in `src/container.ts`, using `API_PUBLIC_URL` as the tracking domain
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
