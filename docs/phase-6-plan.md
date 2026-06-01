# Phase 6 — Dogfood the Reference Deployment (IMPLEMENTATION PLAN)

> **Scope of this document:** PREP + RUNBOOK ONLY. No live cutover, no `railway`
> commands, no production/Supabase DB access. This plan tells the operator
> exactly what to do; the actual execution is a deliberate, human-gated step.
> Source of truth for the phase checklist + verify criteria:
> `docs/TODO-packages-migration.md` (Phase 6). Rationale:
> `docs/packages-migration-plan.md`. API surface: `docs/engine-boundary.md`.
> Upgrade contract: `docs/UPGRADING.md`.

---

## 0. Where we actually are (verified against current code, 2026-05-31)

Phase 6 is the last phase and depends on Phases 1–5. Phases 0 + 1 are done and
verified (engine carved, `apps/api` is a thin consumer, 102 tests + smoke
green). The following Phase 6 prerequisites are **NOT yet implemented in this
working tree** and must land before any live cutover. Verified by grep / file
reads:

- **Phase 2 (two-track migrations) NOT done.** `packages/db/src/migrate.ts` and
  `packages/db/src/version.ts` are still single-track:
  - `migrate.ts` hardcodes `migrationsFolder = ../drizzle`, the engine ledger
    `drizzle.__drizzle_migrations`, advisory lock `4812007`, `lock_timeout=10s`,
    `statement_timeout=15min`. There is no `migrateEngine()` / `migrateClient()`.
  - `version.ts` `getSchemaVersion(db)` queries only
    `drizzle.__drizzle_migrations`. No `getEngineSchemaVersion` /
    `getClientSchemaVersion`. No `__client_migrations` anywhere
    (`grep -rn "__client_migrations"` → empty).
  - `packages/engine/src/routes/health.ts` returns a single `schema` block
    (`{ applied, required, inSync, pending }`), not `{ engine, client }`.
  - `apps/api/src/index.ts` boot guard calls `getSchemaVersion(container.db)`
    once (single track).
- **Phase 3 (`create-hogsend`) NOT done.** No `packages/create-hogsend`.
- **Phase 4 (publish pipeline) NOT done.** All packages are still `0.0.1`,
  `private`/unpublished; `API_VERSION = "0.0.1"` in `packages/engine/src/env.ts`;
  no release workflow.
- **Phase 5 (eject/patch docs) NOT done.**
- **Live Railway config is still single-track + monorepo-build.** `railway.toml`
  `preDeployCommand = "pnpm --filter @hogsend/db db:migrate"`,
  `buildCommand = "pnpm --filter @hogsend/api build"`;
  `railway.worker.toml` `startCommand = "pnpm --filter @hogsend/api worker"`.

**Implication for this plan:** Phase 6 is a *runbook* that assumes Phases 2–5
have shipped and `@hogsend/engine` is published to npm at a known version. The
runbook is written so it is correct the moment those land, and it names the
exact symbols Phase 2 will introduce so there is no ambiguity at cutover.

Deployment facts (from memory `reference_deployment-infra.md`, treat as
point-in-time — re-verify at cutover): Railway project **hogsend** under
**withSeismic**; services **hogsend-api** (GitHub-connected), **Postgres**,
**Redis**, **hatchet-lite**; EU West; `hogsend-production.up.railway.app`;
custom domain `api.hogsend.com` (Cloudflare zone `hogsend.com`). Railway CLI
auth is under dougseismic.

---

## 1. Deliverables of Phase 6

1. **`docs/phase-6-dogfood-runbook.md`** (CREATED by this plan) — the precise,
   ordered, human-gated runbook the operator follows at cutover. It covers:
   pin `@hogsend/engine`; reshape `apps/api` content into the client-repo shape;
   split migrations into engine/client tracks; back up the live DB; run
   engine-then-client migrate via Railway `preDeployCommand`; verify parity
   (same journeys fire, tracked emails send, `/v1/health` both tracks `inSync`);
   prove a follow-on `pnpm up @hogsend/*` applies cleanly.
2. **Non-destructive prep applied now** (see §3): a *staged, not-yet-active*
   two-track Railway preDeploy template committed as a separate file
   (`railway.toml.phase6` and `railway.worker.toml.phase6`) plus a reusable
   backup helper script `scripts/db-backup.sh` (pg_dump wrapper, prints
   instructions, never targets a live DB unless the operator passes the URL).
   These do **not** alter the live `railway.toml` / `railway.worker.toml`.
3. **Verification checklist** mirroring the TODO Phase 6 Verify/Success.

Everything that requires production access, the live DB, or `railway` is flagged
as a **MANUAL — operator only** step in the runbook and is NOT executed here.

---

## 2. The cutover model (what "onto the consumer model" means here)

Today the reference deployment builds `@hogsend/api` *from the monorepo* and
migrates with a single `db:migrate`. The consumer model means:

- The deployed repo becomes a **thin client repo** (the `create-hogsend` output
  shape from Phase 3): owns content (`src/journeys/*`, `src/webhook-sources/*`,
  `src/workflows/*`, thin `src/index.ts` + `src/worker.ts`, `src/__tests__/*`),
  pins `@hogsend/engine@<X.Y.Z>` from npm (not `workspace:^`), and owns its
  client `migrations/` track (ledger `drizzle.__client_migrations`, per D4).
- Engine schema lives inside `@hogsend/engine` (bundled `@hogsend/db`
  migrations, ledger `drizzle.__drizzle_migrations`), versioned with the package.
- Railway `preDeployCommand` runs **engine migrate, then client migrate**.

For THIS repo (the dogfood), there are two viable cutover strategies; the
runbook documents **Strategy A** as primary and **Strategy B** as the fallback:

- **Strategy A — flip `apps/api` to a pinned engine in place.** Change
  `apps/api/package.json` `@hogsend/engine` (and the other `@hogsend/*`) from
  `workspace:^` to the published `^X.Y.Z`, add the client `migrations/` folder +
  `drizzle.client.config.ts`, repoint Railway build/start to the published-dep
  build, and deploy. Lowest churn; keeps git history; dogfoods the *upgrade*
  path directly. **Recommended.**
- **Strategy B — fresh `create-hogsend` repo + content copy.** Scaffold a new
  app with `pnpm dlx create-hogsend@latest`, copy `src/journeys`,
  `src/webhook-sources`, `src/workflows`, `src/__tests__`, env, and Railway
  configs across, point the same Railway services at the new repo. Cleanest
  proof of the scaffolder, highest churn. Documented as the fallback / future
  green-field reference.

---

## 3. Non-destructive prep that can be done SAFELY NOW (and is done by this work)

These touch only NEW files; they do not change behavior, do not touch the live
config, and keep all 102 tests green.

### 3.1 Staged two-track Railway templates (NEW files, not active)

Create `railway.toml.phase6` and `railway.worker.toml.phase6` as the
ready-to-promote two-track configs. They are inert until the operator renames
them over the live files at cutover (a MANUAL step). Content:

- `railway.toml.phase6` `[deploy].preDeployCommand`:
  `pnpm --filter @hogsend/db migrate:engine && pnpm --filter @hogsend/api migrate:client`
  (the `migrate:engine` / `migrate:client` scripts are Phase 2 deliverables —
  see §4). `buildCommand` switches from
  `pnpm --filter @hogsend/api build` to `pnpm install && pnpm --filter @hogsend/api build`
  for the published-dep client repo (no `workspace:*` resolution).
- Keep `healthcheckPath = "/v1/health"`, `healthcheckTimeout`, restart policy.
- `railway.worker.toml.phase6`: unchanged start command shape
  (`pnpm --filter @hogsend/api worker`), no healthcheck (workers don't expose a
  port — per memory `feedback_railway-deploy.md`).

### 3.2 Backup helper (NEW script, never auto-targets prod)

Create `scripts/db-backup.sh`: a `pg_dump` wrapper that REQUIRES the operator to
pass `DATABASE_URL` explicitly as `$1` (or env), refuses to run with no
argument, writes `backups/hogsend-<ISO8601>.dump` (custom format,
`pg_dump -Fc`), prints the exact `pg_restore` rollback command, and never reads
`apps/api/.env` or any default. This is the tool the runbook's "back up the
database" step (UPGRADING.md rule 1) invokes. It is safe to commit because it is
inert without an explicit URL.

### 3.3 Runbook doc

Create `docs/phase-6-dogfood-runbook.md` (the operator-facing procedure, §5).

> NOT done now (requires Phase 2–5 or prod access): editing live `railway.toml`,
> publishing packages, running any migrate against the live DB, any `railway`
> command.

---

## 4. Exact symbols the runbook depends on (Phase 2 deliverables it references)

The runbook names these so cutover is unambiguous. They MUST exist before
running Phase 6 (they are Phase 2's job, not this plan's):

- `packages/db/src/migrate.ts` → parameterized
  `runMigrations({ migrationsFolder, migrationsTable = "__drizzle_migrations", migrationsSchema = "drizzle", lockKey })`
  plus thin wrappers `migrateEngine()` (engine `drizzle/`,
  `__drizzle_migrations`) and `migrateClient(folder)` (client `migrations/`,
  `__client_migrations`). Advisory lock keys must differ per track
  (engine `4812007`, client e.g. `4812008`) so the two `preDeploy` steps never
  self-deadlock.
- `packages/db` `package.json` scripts: `migrate:engine`, and the client repo's
  `migrate:client` (in `apps/api/package.json`, pointing at the client
  `migrations/` + `drizzle.client.config.ts`).
- `packages/db/src/version.ts` → `getEngineSchemaVersion(db)` and
  `getClientSchemaVersion(db, journal)`; keep `getSchemaVersion` as an alias of
  the engine one for back-compat.
- `packages/engine/src/routes/health.ts` → `schema: { engine: {...}, client: {...} }`,
  each `{ required, applied, pending, inSync }`; `status = "migration_pending"`
  if `!engine.inSync || !client.inSync`.
- `apps/api/src/index.ts` boot guard → assert **engine** track inSync (gates
  boot); client track is reported but does NOT gate boot (client owns it; per
  TODO Phase 2 gating-policy note).

If the runbook is executed before these exist, §5 Step 0 (preflight) fails
loudly and the operator stops.

---

## 5. Runbook structure (`docs/phase-6-dogfood-runbook.md`)

Ordered, each step tagged **[SAFE-NOW]**, **[MANUAL — operator]**, or
**[MANUAL — operator, PROD]**:

0. **Preflight gate [MANUAL — operator].** Confirm Phases 2–5 shipped:
   `@hogsend/engine@X.Y.Z` resolves on npm; `pnpm --filter @hogsend/db migrate:engine`
   and `migrate:client` scripts exist; `/v1/health` (local) shows the
   `{ engine, client }` shape. Abort if any missing.
1. **Pick a maintenance window + announce [MANUAL — operator].**
2. **Back up the live DB [MANUAL — operator, PROD].** Run
   `scripts/db-backup.sh "$PROD_DATABASE_URL"`; verify the dump file size /
   `pg_restore -l` lists objects. This is the only rollback (UPGRADING.md rule 1).
3. **Reshape content (Strategy A) [SAFE-NOW prep / MANUAL to merge].** Pin
   `@hogsend/engine` + `@hogsend/*` to `^X.Y.Z` in `apps/api/package.json`; add
   client `migrations/` + `drizzle.client.config.ts` (ledger
   `__client_migrations`); add `migrate:client` script. Run the verification gate
   locally (§6 a–d). Open a PR; do not push to prod from this agent.
4. **Promote Railway configs [MANUAL — operator].** Rename
   `railway.toml.phase6` → `railway.toml` and `railway.worker.toml.phase6` →
   `railway.worker.toml` (the two-track preDeploy). Diff-review before commit.
5. **Baseline the engine ledger if needed [MANUAL — operator, PROD].** The live
   DB was originally `db:push`-bootstrapped in places (UPGRADING.md ledger
   gotcha). Before first two-track migrate, confirm
   `drizzle.__drizzle_migrations` row count equals the bundled engine migration
   count; if the schema already matches head but the ledger is behind, baseline
   it (mark migrations applied) rather than re-running DDL. The runbook gives the
   exact `SELECT count(*) FROM drizzle.__drizzle_migrations` check and the
   baseline procedure (copy from UPGRADING.md §3 "To adopt an existing
   push-built DB").
6. **Deploy [MANUAL — operator, PROD].** Trigger the Railway deploy (push to the
   connected branch / `railway up`). `preDeployCommand` runs engine migrate then
   client migrate before the new API boots; the boot guard asserts engine
   `inSync`.
7. **Verify parity [MANUAL — operator, PROD].** §6 e–h.
8. **Prove clean upgrade [MANUAL — operator].** In a follow-up branch run
   `pnpm up @hogsend/*`, re-run the verification gate, redeploy to a staging
   service if available; confirm engine migrate applies the new engine
   migrations and `/v1/health` returns to `inSync` with no manual merge.
9. **Rollback [MANUAL — operator, PROD].** If verify fails: redeploy the prior
   release (engine migrations are forward-only and additive, so old code runs
   against the new schema — expand/contract); only `pg_restore` the §2 backup as
   last resort (UPGRADING.md rollback policy).

---

## 6. Verification checklist (mirrors TODO Phase 6 Verify/Success)

Local gate (run before any prod step; all must be green):

- [ ] (a) `pnpm check-types`
- [ ] (b) `pnpm build`
- [ ] (c) `pnpm lint`
- [ ] (d) `pnpm --filter @hogsend/api test` (102 + Phase 2 two-track tests)

Production-parity gate (post-deploy, operator):

- [ ] (e) **Same journeys fire** — fire `test.signup` (or a known prod-safe
      trigger) and confirm the journey runs to `completed` via Hatchet dashboard
      (`localhost:8888` equivalent) / `journeyStates` + `journey:completed` event.
      Mirror of `apps/api/scripts/smoke.ts` assertions.
- [ ] (f) **Tracked emails send** — a send goes out with rewritten tracked links
      (`/v1/t/c/:id`) and an injected open pixel (`/v1/t/o/:id`); a click records a
      `link_clicks` row + sets `emailSends.clickedAt`.
- [ ] (g) **`/v1/health` both tracks `inSync`** —
      `schema.engine.inSync === true && schema.client.inSync === true`,
      `status === "healthy"` (not `migration_pending`).
- [ ] (h) **Clean upgrade** — a subsequent `pnpm up @hogsend/*` + redeploy
      applies the new engine migrations with no manual merge; `/v1/health` returns
      to `inSync`.

---

## 7. Test additions (concrete)

Phase 6 itself adds **no production code**, so its automated tests are minimal
and live alongside the existing suite. The substantive two-track tests belong to
Phase 2 (`migration-system.test.ts` extension). For Phase 6 prep:

- **`apps/api/scripts/smoke.ts` (REUSE, no change required)** is the executable
  parity proof referenced by checklist (e)+(f); the runbook points operators at
  it. If desired, add an env-guarded `SMOKE_BASE_URL` mode so the same script can
  be run against a live `/v1/...` instead of an in-process app — flagged as
  optional, not required for the plan.
- **No new vitest file is mandatory for Phase 6.** If we add one, it would be
  `apps/api/src/__tests__/railway-config.test.ts` asserting the
  `railway.toml.phase6` preDeploy string contains both `migrate:engine` and
  `migrate:client` in that order — a cheap guard that the staged config stays
  two-track. Assertion: parse the toml, expect
  `deploy.preDeployCommand` to match `/migrate:engine.*&&.*migrate:client/`.

---

## 8. Risks & sharp edges (operator must read)

- **Phase 6 cannot run until Phases 2–5 ship.** This plan + runbook are written
  ahead; the preflight gate (§5 Step 0) enforces it.
- **db:push ledger gotcha on the live DB** (UPGRADING.md §3) — the engine track
  may report `inSync:false` despite tables existing; §5 Step 5 baselines it.
  Do NOT "fix" this by running destructive DDL.
- **Cross-track coupling** — if the dogfood ever ALTERed engine tables in its
  client migrations, an engine upgrade can collide. Keep client migrations
  additive-only (TODO Phase 2 sharp edge).
- **Two advisory locks** — engine and client migrate must use different lock keys
  or the chained preDeploy can self-block.
- **Worker/api lockstep** — both Railway services build from the same repo/ref;
  deploy them together so api + worker + schema move as one unit
  (UPGRADING.md preamble).
- **No `railway`, no prod DB, no publish from this agent** — all such steps are
  MANUAL and gated.
