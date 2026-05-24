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

# First-time setup (Docker, deps, env)
pnpm setup                      # runs scripts/setup.sh

# Infrastructure (TimescaleDB, Redis, Hatchet-Lite)
docker compose up -d            # Start postgres, redis, hatchet-lite
```

## Architecture

### Monorepo layout

- **apps/api** — Hono REST API + Hatchet worker (two entry points: `src/index.ts` for HTTP, `src/worker.ts` for task execution)
- **packages/core** — Journey type definitions, Zod schemas, condition evaluation engine, journey registry (`@hogsend/core`)
- **packages/db** — Drizzle ORM schema, migrations, and seed (`@hogsend/db`). Exports raw `.ts` — no build step, bundled by consumers via tsup `noExternal`
- **packages/email** — Resend client, React Email templates, send/render helpers (`@hogsend/email`)
- **packages/typescript-config** — Shared tsconfig bases (`@repo/typescript-config`)

### API patterns (apps/api)

The API uses a dependency-injection container pattern:

- `src/env.ts` — `@t3-oss/env-core` validates env vars at startup (DATABASE_URL, BETTER_AUTH_SECRET required)
- `src/container.ts` — `createContainer()` builds the DI container (env, logger, db, auth, email, journey registry); passed to the app factory
- `src/lib/auth.ts` — Better Auth instance, configured from container env
- `src/lib/hatchet.ts` — Shared HatchetClient singleton, used by both API (to trigger tasks) and worker (to execute them)
- `src/app.ts` — `createApp(container)` creates the OpenAPIHono app, registers middleware and routes; container is available via `c.get("container")` in any handler
- `src/routes/index.ts` — `registerRoutes(app)` mounts versioned routers under `/v1`
- Routes use `createRoute()` + `OpenAPIHono.openapi()` with Zod schemas for request/response validation and auto-generated OpenAPI spec

When adding a new route: define the Zod schemas, create the route with `createRoute()`, implement the handler with `.openapi()`, then register it in `registerRoutes`.

### Hatchet (workflow/task orchestration)

Hatchet handles durable task execution — email sends, journey orchestration, background jobs. The API and worker are separate processes sharing the same codebase:

- **API process** (`src/index.ts`) — serves HTTP, triggers tasks via `hatchet.run()` / `task.runNoWait()`
- **Worker process** (`src/worker.ts`) — long-running process that executes tasks assigned by Hatchet
- **Workflows** live in `src/workflows/` — each file exports a task or workflow declaration
- **`src/workflows/index.ts`** — barrel export, registered with the worker
- **`hatchet.yaml`** — CLI config for `hatchet worker dev` (run command, watch patterns)

When adding a new task: define it in `src/workflows/`, export from `src/workflows/index.ts`, add to the `workflows` array in `src/worker.ts`.

Task input types must be JSON-serializable (extend Hatchet's `JsonObject`). Don't use `[key: string]: unknown` index signatures — use specific keys or `JsonValue`-compatible types.

### Journey system

- **Journey definitions** live in `src/journeys/` — declarative node graphs (action → wait → condition → branch)
- **`@hogsend/core`** provides types (`JourneyDefinition`, `JourneyNode`, `JourneyAction`), Zod schemas, condition evaluation, and the `JourneyRegistry`
- **Ingest endpoint** (`/v1/ingest`) stores events, checks enrollment, processes exits
- **`run-journey` durable task** walks the node graph with Hatchet's durable execution (supports multi-day sleeps via `ctx.sleepFor()`)

### Testing

Tests use vitest and live in `src/__tests__/`. The vitest config injects test env vars (DATABASE_URL, PORT, etc.) so tests don't need `.env`. Tests call `app.request()` directly against the Hono app — no HTTP server needed.

### Code style

- **Biome** for linting and formatting (not ESLint/Prettier at root level)
- 2-space indent, double quotes, semicolons always
- **Conventional Commits** enforced via `commitlint` + Lefthook `commit-msg` hook. Format: `type(scope): description` — types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Scope is optional, kebab-case. Header max 100 chars.
- **Lefthook** git hooks: `commit-msg` runs commitlint; pre-commit runs `biome check` on staged files; pre-push runs `check-types`
- API builds target Node 22, ESM-only (`"type": "module"`)
- Use `.js` extensions in relative imports within the API (ESM resolution)

### Infrastructure

- **TimescaleDB** (Postgres 18) via docker-compose on port 5434 (user/pass/db: `growthhog`)
- **Redis** 8 (Alpine) via docker-compose on port 6380, for caching/queues
- **Hatchet-Lite** via docker-compose — dashboard at `localhost:8888`, gRPC at `localhost:7077`. Default login: `admin@example.com` / `Admin123!!`. Has its own Postgres 15 instance.
- API default port is 3002 (configured via PORT env var)
- Node 22 required (pinned via `.node-version`)

### Deployment

- **Railway** (withSeismic team) — two services from same repo, plus Postgres, Redis, Hatchet-Lite
  - `hogsend-api` — HTTP API (`node dist/index.js`), health check at `/v1/health`
  - `hogsend-worker` — Hatchet worker (`node dist/worker.js`), no HTTP port, scales independently
  - `hatchet-lite` — self-hosted Hatchet engine (Docker image `ghcr.io/hatchet-dev/hatchet/hatchet-lite:latest`)
- **Cloudflare** — `hogsend.com` DNS on Cloudflare, `api.hogsend.com` CNAME → Railway
- **GitHub auto-deploy** — push to `main` triggers Railway build for both API and worker
- Both services build with `pnpm --filter @hogsend/api build` and watch `apps/api/**`, `packages/**`
- tsup bundles `@hogsend/core`, `@hogsend/db`, `@hogsend/email` via `noExternal`; npm deps resolve from `node_modules` at runtime
- `/docs` and `/openapi.json` are disabled in production (`NODE_ENV=production`)
