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
pnpm --filter @growthhog/api dev

# API only (from apps/api)
cd apps/api && pnpm dev         # tsx watch with .env
cd apps/api && pnpm build       # tsup → dist/

# Tests (vitest, API workspace only)
cd apps/api && pnpm test        # vitest run (single pass)
cd apps/api && pnpm test:watch  # vitest watch mode

# First-time setup (Docker, deps, env)
pnpm setup                      # runs scripts/setup.sh

# Infrastructure (TimescaleDB on Postgres 18, Redis)
docker compose up -d            # Start postgres + redis
```

## Architecture

### Monorepo layout

- **apps/api** — Hono REST API with OpenAPI spec (Zod OpenAPI + Scalar docs at `/docs`, dev only)
- **packages/db** — Drizzle ORM schema, migrations, and seed (`@growthhog/db`). Exports raw `.ts` — no build step, bundled by consumers via tsup `noExternal`
- **packages/typescript-config** — Shared tsconfig bases (`@repo/typescript-config`)

### API patterns (apps/api)

The API uses a dependency-injection container pattern:

- `src/env.ts` — `@t3-oss/env-core` validates env vars at startup (DATABASE_URL, BETTER_AUTH_SECRET required)
- `src/container.ts` — `createContainer()` builds the DI container (env, logger, auth); passed to the app factory
- `src/lib/auth.ts` — Better Auth instance, configured from container env
- `src/app.ts` — `createApp(container)` creates the OpenAPIHono app, registers middleware and routes; container is available via `c.get("container")` in any handler
- `src/routes/index.ts` — `registerRoutes(app)` mounts versioned routers under `/v1`
- Routes use `createRoute()` + `OpenAPIHono.openapi()` with Zod schemas for request/response validation and auto-generated OpenAPI spec

When adding a new route: define the Zod schemas, create the route with `createRoute()`, implement the handler with `.openapi()`, then register it in `registerRoutes`.

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

- **TimescaleDB** (Postgres 18) via docker-compose on port 5432 (user/pass/db: `growthhog`)
- **Redis** 8 (Alpine) via docker-compose on port 6379, for caching/queues
- API default port is 3002 (configured via PORT env var)
- Node 22 required (pinned via `.node-version`)

### Deployment

- **Railway** (withSeismic team) — API + Postgres + Redis deployed to `hogsend-production.up.railway.app`
- **Cloudflare** — `hogsend.com` DNS on Cloudflare, `api.hogsend.com` CNAME → Railway
- **GitHub auto-deploy** — push to `main` triggers Railway build via GitHub integration
- **PR environments** — available in Railway project settings (focused PR environments for monorepo)
- `railway.toml` at repo root configures build (`pnpm --filter @growthhog/api build`), start (`pnpm --filter @growthhog/api start`), health check (`/v1/health`), and watch patterns
- `lefthook install` is `|| true` in the prepare script — no `.git` in CI/build environments
- tsup bundles `@growthhog/db` via `noExternal`, all npm deps resolve from `node_modules` at runtime
- `/docs` and `/openapi.json` are disabled in production (`NODE_ENV=production`)
