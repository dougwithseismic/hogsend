# PRD 01 — apps/cloud scaffold

## Goal
A booting `apps/cloud` Next.js app in the monorepo with the Hogsend design system, its own
cloud database + migration track, a health endpoint, the cloud-worker entry, and full gate
wiring — the foundation every later PRD builds on.

## Locked decisions (this PRD)
- Next.js App Router, TypeScript, dark-only. Install with `pnpm add <pkg>@latest`.
- Package name `@hogsend/cloud`, private, port **3004** (3002=api, 3003=docs range).
- Copy `apps/docs/components/ds` primitives into `apps/cloud/components/ds` (no cross-app
  imports); trim to what compiles standalone. Tailwind config mirrors docs tokens.
- DB: Drizzle + postgres-js, schema in `apps/cloud/src/db/schema/`, migrations in
  `apps/cloud/migrations/` with own ledger table `cloud.__cloud_migrations`;
  `CLOUD_DATABASE_URL` env (local default: the compose Postgres, database `hogsend_cloud`).
- Env validation via `@t3-oss/env-core` in `apps/cloud/src/env.ts` (mirror engine pattern):
  `CLOUD_DATABASE_URL` required; everything else optional with defaults.
- `cloud-worker` entry (`src/worker.ts`) exists and boots as a plain process; Hatchet
  wiring lands in PRD 04 (worker just logs + idles until then).
- Turbo: app participates in `check-types`, `lint`, `test`, `build`, `dev`.

## EARS acceptance criteria
- WHEN `pnpm --filter @hogsend/cloud dev` runs with a reachable `CLOUD_DATABASE_URL`, the
  system SHALL serve a dark-themed placeholder dashboard at `http://localhost:3004` using ds
  primitives.
- WHEN `GET /api/health` is requested, the system SHALL return 200 with
  `{ status, db: "ok"|"error", migrations: "in_sync"|"pending" }`.
- WHEN `pnpm --filter @hogsend/cloud db:migrate` runs against an empty database, the system
  SHALL create the ledger and apply migration 0000 idempotently (second run is a no-op).
- WHEN any root gate command runs, the system SHALL pass with `apps/cloud` included.
- WHEN `NODE_ENV=production`, the system SHALL NOT serve the Scalar API-docs route (route
  exists dev-only; stub spec acceptable this PRD).

## Tasks
1. **Scaffold app + turbo wiring** — create `apps/cloud` (Next.js, Biome-clean, tsconfig
   from `@repo/typescript-config`), register in workspace, port 3004, placeholder page.
   _Boundary:_ `apps/cloud`, root workspace files. _Depends:_ —
2. **Design-system port** — copy + prune ds primitives and tokens from apps/docs; dark
   layout shell (nav rail, page frame) used by the placeholder page.
   _Boundary:_ `apps/cloud`. _Depends:_ 1
3. **Cloud DB + migrations + health** — env.ts, drizzle client, migration runner
   (`db:generate`/`db:migrate` scripts, advisory-lock like engine's), migration 0000
   (empty baseline), `/api/health` with db + migration status; vitest setup with first
   tests (health route via `app` handler, migration idempotency against local PG).
   _Boundary:_ `apps/cloud`. _Depends:_ 1
4. **cloud-worker entry + dev-only API docs stub** — `src/worker.ts` boot/log/idle with
   graceful SIGTERM; Scalar route gated off in production; `worker` + `worker:dev` scripts.
   _Boundary:_ `apps/cloud`. _Depends:_ 3

## Seams
None (local Postgres exists in compose).

## Done when
All EARS pass; gates green from repo root; placeholder dashboard screenshotted in the real
browser (no-artifacts law).

## Implementation Notes
