# Phase 6 — Dogfood Cutover Runbook (operator-facing)

> **What this is.** The precise, ordered, human-gated procedure for moving the
> production reference deployment (`hogsend.com` / `api.hogsend.com`) from the
> forkable-monorepo model onto the **consumer (client-repo) model**: a thin app
> that pins a published `@hogsend/engine@X.Y.Z`, owns only its content
> (journeys / webhook-sources / workflows / tests), and runs **two migration
> tracks** (engine then client) at deploy.
>
> **What this is NOT.** This document does not execute anything against
> production. Every step that touches the live DB, Railway, or npm is tagged
> **[MANUAL — operator]** or **[MANUAL — operator, PROD]** and is performed by a
> human with the appropriate access. The agent that produced this runbook ran
> **no** `railway` command, **no** publish, and **no** migrate against any live
> database.
>
> **Source-of-truth siblings.** Phase plan: `docs/phase-6-plan.md`. Upgrade
> contract: `docs/UPGRADING.md` (read it — it is the contract). API boundary:
> `docs/engine-boundary.md`. How versions are cut: `docs/RELEASING.md`.

---

## Step legend

| Tag | Meaning |
| --- | --- |
| **[SAFE-NOW]** | Non-destructive; already done in this repo or runnable locally with no prod impact. |
| **[MANUAL — operator]** | A human runs it; no live DB, but it is a real change (config promote, npm, PR merge). |
| **[MANUAL — operator, PROD]** | A human runs it against production / the live DB. Highest care. |

---

## What is already prepared (committed, inert)

These exist in the repo right now and change **no** deploy behavior until the
operator promotes them:

- `railway.toml.phase6` / `railway.worker.toml.phase6` — staged two-track
  Railway configs. Promoted by **rename** at Step 4. The live `railway.toml` /
  `railway.worker.toml` are untouched.
- `scripts/db-backup.sh` — `pg_dump -Fc` wrapper used at Step 2. Inert: refuses
  to run without an explicit `DATABASE_URL`; never reads `apps/api/.env`.
- `apps/api/scripts/smoke.ts` + `pnpm --filter @hogsend/api smoke` — the
  executable parity proof reused at Step 7 (checklist e + f).
- `apps/api/src/__tests__/railway-config.test.ts` — guards that the staged
  config keeps engine-before-client ordering and a port-less worker.

The two-track migration engine itself (the symbols this runbook depends on) is
**already implemented** in the working tree — see "Dependency map" below.

---

## Dependency map — symbols this runbook relies on (verify at Step 0)

The cutover is unambiguous because the two-track machinery already exists:

- `packages/db/src/migrate.ts`
  - `migrateEngine(databaseUrl)` — engine track: bundled `@hogsend/db/drizzle`
    folder → ledger `drizzle.__drizzle_migrations`, advisory lock `4812007`,
    `lock_timeout=10s`, `statement_timeout=15min`.
  - `migrateClient(databaseUrl, folder, journal)` — client track: the client
    repo's `migrations/` folder → ledger `drizzle.__client_migrations`.
  - `migrateTrack(opts)` — the shared, parameterized runner both wrap.
  - CLI entrypoints: `db:migrate` (engine) and `db:migrate:client`
    (`migrate-client.ts`, reads `CLIENT_MIGRATIONS_FOLDER`).
- `packages/db/src/version.ts`
  - `getEngineSchemaVersion(db)` and `getClientSchemaVersion(db, journal)`,
    each returning `{ required, applied, pending, inSync }` (count-based).
  - `getSchemaVersion(db)` kept as a back-compat alias of the engine probe.
  - Ledger constants: `ENGINE_MIGRATIONS_TABLE = "__drizzle_migrations"`,
    `CLIENT_MIGRATIONS_TABLE = "__client_migrations"` (both in schema `drizzle`).
- `packages/engine/src/routes/health.ts` — `schema: { engine, client }`, each a
  track block; `status = "migration_pending"` if `!engine.inSync ||
  !client.inSync`.
- `apps/api/src/index.ts` — boot guard asserts the **engine** track `inSync`
  (fatal if behind). The client track is reported via `/v1/health` but does NOT
  gate boot (client-owned; UPGRADING.md "Boot gating policy").

> **The single advisory-lock note (read this).** Today both tracks share lock
> `4812007` (see `migrate.ts` `ADVISORY_LOCK_KEY`). Because the chained
> `preDeployCommand` runs the two CLI processes **sequentially** — engine
> migrate acquires + releases + `client.end()` before client migrate starts —
> they never overlap, so the shared key serializes (the desired behavior) rather
> than self-deadlocking. **If a future change ever runs both tracks inside one
> process / one connection, give the client track a distinct key (e.g.
> `4812008`) first.** As long as `db:migrate` and `db:migrate:client` stay
> separate processes, the current shared key is correct.

---

## Step 0 — Preflight gate [MANUAL — operator]

**Abort the cutover if any check fails.** Phase 6 assumes Phases 2–5 have
shipped and `@hogsend/engine` is published.

```bash
# (0a) The target engine version resolves on npm.
npm view @hogsend/engine@X.Y.Z version          # X.Y.Z = the version you're pinning
npm view @hogsend/db@X.Y.Z version
npm view @hogsend/core@X.Y.Z version

# (0b) The two migrate CLIs exist and run (against a LOCAL/throwaway DB only).
pnpm --filter @hogsend/db db:migrate --help 2>/dev/null || \
  echo "engine migrate entrypoint present (tsx src/migrate.ts)"
pnpm --filter @hogsend/db db:migrate:client --help 2>/dev/null || \
  echo "client migrate shim present (tsx src/migrate-client.ts)"

# (0c) Local /v1/health shows the two-track shape {engine, client}.
#      Boot the app locally (SKIP_SCHEMA_CHECK=true for a db:push dev DB):
SKIP_SCHEMA_CHECK=true pnpm --filter @hogsend/api dev &   # then:
curl -s localhost:3002/v1/health | jq '.schema | keys'    # => ["client","engine"]
```

Expected at (0c): `["client","engine"]`, and each track is an object with
`required`/`applied`/`inSync`/`pending`.

If `@hogsend/engine@X.Y.Z` does **not** resolve on npm (Phase 4 not done), or
`/v1/health` shows a single `schema` block (Phase 2 not done), **STOP** — the
prerequisites are not in place.

---

## Step 1 — Maintenance window + announce [MANUAL — operator]

- Pick a low-traffic window. Journeys mid-sleep and queued Hatchet sends will
  execute **old code against the new schema** during the deploy — this is the
  expand/contract contract (UPGRADING.md rule 2). It is safe only because engine
  migrations are additive/forward-compatible. Confirm the target version's
  CHANGELOG has no ⚠️ breaking note that violates this.
- Announce the window. Note that `api.hogsend.com` may briefly 503 during the
  Railway healthcheck cutover.

---

## Step 2 — Back up the live DB [MANUAL — operator, PROD]

This is the **only** rollback (UPGRADING.md rule 1).

```bash
# Pass the prod URL EXPLICITLY. The script refuses to guess.
scripts/db-backup.sh "$PROD_DATABASE_URL"
```

Verify the dump before proceeding:

```bash
ls -lh backups/hogsend-*.dump          # non-trivial size
pg_restore -l backups/hogsend-<stamp>.dump | head   # lists tables/indexes
```

Keep the printed `pg_restore --clean --if-exists ...` rollback command handy
(Step 9). Do not proceed until the dump is verified.

---

## Step 3 — Reshape content to the consumer model (Strategy A) [MANUAL — operator]

> **Strategy A (primary): flip `apps/api` to a pinned engine in place.** Lowest
> churn, keeps git history, dogfoods the upgrade path directly. **Strategy B
> (fallback)** — scaffold fresh with `pnpm dlx create-hogsend@latest` and copy
> content across — is documented at the end; use it only if A is blocked.

Do this on a branch and open a PR (do **not** push to the prod branch from a
non-operator). All edits are local until merged.

1. **Pin published `@hogsend/*` instead of `workspace:^`.** In
   `apps/api/package.json`, change every `@hogsend/*` dependency
   (`@hogsend/engine`, `@hogsend/core`, `@hogsend/db`, `@hogsend/email`,
   `@hogsend/plugin-posthog`, `@hogsend/plugin-resend`) from `"workspace:^"` to
   `"^X.Y.Z"`. Use `pnpm` to write the ranges — never hand-edit:
   ```bash
   pnpm --filter @hogsend/api add \
     @hogsend/engine@X.Y.Z @hogsend/core@X.Y.Z @hogsend/db@X.Y.Z \
     @hogsend/email@X.Y.Z @hogsend/plugin-posthog@X.Y.Z @hogsend/plugin-resend@X.Y.Z
   ```
2. **Add the client migration track** (the consumer owns this; it is empty to
   start — additive-only forever, per UPGRADING.md cross-track rule):
   - Create `apps/api/migrations/` (the client `migrations/` folder).
   - Add `apps/api/drizzle.client.config.ts` pointing Drizzle at
     `./migrations` with `migrationsTable: "__client_migrations"`,
     `migrationsSchema: "drizzle"`, and the same `schema` glob the engine uses
     for diffing the client's own tables.
   - Add a `migrate:client` script to `apps/api/package.json` that invokes the
     client track against `apps/api/migrations` (it can shell out to the
     engine's `db:migrate:client` with `CLIENT_MIGRATIONS_FOLDER` pointed at the
     repo's `migrations/`, or call `migrateClient()` directly). The staged
     `railway.toml.phase6` already runs `db:migrate:client`, which reads
     `CLIENT_MIGRATIONS_FOLDER`; set that service env var to the absolute path
     of `apps/api/migrations` at Step 4.
   - An **empty** client track is trivially in sync (`required: null`,
     `inSync: true`) — `/v1/health` `schema.client` will report empty and never
     trip `migration_pending`. That is the expected steady state for this
     dogfood until it authors its first client migration.
3. **Run the local verification gate (§ checklist a–d).** Must be green before
   the PR is mergeable.
4. **Open the PR.** Diff-review. Merge is the operator's call; the agent does
   not push to prod.

---

## Step 4 — Promote the Railway configs [MANUAL — operator]

At cutover, replace the live single-track configs with the staged two-track
ones (committed at Step 3's PR), and set the client-folder env var:

```bash
git mv railway.toml.phase6 railway.toml
git mv railway.worker.toml.phase6 railway.worker.toml
git diff --staged railway.toml railway.worker.toml   # review the two-track preDeploy
```

Then, on the Railway **hogsend-api** service, set:

```
CLIENT_MIGRATIONS_FOLDER = /app/apps/api/migrations   # absolute path in the deployed image
```

Confirm the promoted `railway.toml` `preDeployCommand` is:

```
pnpm --filter @hogsend/db db:migrate && pnpm --filter @hogsend/db db:migrate:client
```

(engine first, then client — order is load-bearing; see Dependency map).

---

## Step 5 — Baseline the engine ledger if the db:push gotcha applies [MANUAL — operator, PROD]

The live DB was bootstrapped partly via `db:push`, so its
`drizzle.__drizzle_migrations` ledger may be **behind** the bundled engine
migrations even though every table physically exists (UPGRADING.md §3 "the
migration ledger" gotcha). If so, the boot guard would refuse to start despite a
correct schema. **Do NOT fix this by re-running destructive DDL.** Baseline the
ledger instead.

Check first:

```sql
-- Applied (recorded) engine migrations:
SELECT count(*) FROM drizzle.__drizzle_migrations;
```

Compare against the bundled count:

```bash
# Number of bundled engine migrations the build requires:
node -e "console.log(require('./packages/db/drizzle/meta/_journal.json').entries.length)"
```

- **Counts equal** → ledger is in sync; nothing to do.
- **Ledger count < bundled count, but the schema already matches head** → the
  schema is physically present but unrecorded. **Baseline** per UPGRADING.md §3
  "To adopt an existing push-built DB": confirm parity by applying the bundled
  migrations against an *empty throwaway* DB (proves they describe the current
  schema), then seed the live ledger by marking the already-present migrations
  as applied (insert the corresponding `__drizzle_migrations` rows) so the count
  matches — rather than letting `db:migrate` attempt DDL that already exists.
- **Ledger count < bundled count AND the schema genuinely lacks objects** →
  these are real pending migrations; `db:migrate` will apply them at Step 6.
  No baseline needed.

The client ledger (`__client_migrations`) needs no baseline: it starts empty and
the client track is additive from zero.

---

## Step 6 — Deploy [MANUAL — operator, PROD]

Trigger the Railway deploy of **both** services from the same ref (api + worker
move in lockstep — UPGRADING.md preamble). Push to the connected branch or
`railway up` per service.

Deploy sequence (automatic):

1. `buildCommand` → `pnpm install && pnpm --filter @hogsend/api build`
   (resolves published `@hogsend/*` from npm, then tsup-bundles the client).
2. `preDeployCommand` → **engine migrate** (`db:migrate`) applies any pending
   engine migrations under lock `4812007`; on success, **client migrate**
   (`db:migrate:client`) applies the client track (skips gracefully if
   `CLIENT_MIGRATIONS_FOLDER` is empty).
3. New API boots → boot guard asserts **engine** `inSync` (fatal if behind).
4. Railway healthcheck hits `/v1/health` (timeout 120s).

If preDeploy fails, Railway does **not** cut traffic to the new release — the
old release keeps serving. Investigate logs before retrying.

---

## Step 7 — Verify parity [MANUAL — operator, PROD]

Mirror the smoke assertions against the live deployment.

- **(e) Same journeys fire.** Fire a known prod-safe trigger (e.g. the
  `test.signup` the smoke uses, or a real journey trigger) through the live
  ingest endpoint, then confirm the journey reaches `completed`:
  - Hatchet dashboard shows the task ran, OR
  - `journeyStates` row for that user/journey has `status = "completed"` and a
    `journey:completed` event exists.
  - This is exactly what `apps/api/scripts/smoke.ts` asserts in-process; you can
    also point it at the live API (see "SMOKE_BASE_URL" note below) if added.
- **(f) Tracked emails send.** A send goes out with **rewritten** tracked links
  (`/v1/t/c/:id`) and an injected **open pixel** (`/v1/t/o/:id`). Click a link
  and confirm a `link_clicks` row is recorded and `emailSends.clickedAt` is set
  (first click only).
- **(g) `/v1/health` both tracks inSync:**
  ```bash
  curl -s https://api.hogsend.com/v1/health | jq '{status, schema}'
  ```
  Expect `status == "healthy"` and
  `schema.engine.inSync == true && schema.client.inSync == true` (NOT
  `migration_pending`).

> **Optional `SMOKE_BASE_URL` mode.** `apps/api/scripts/smoke.ts` currently boots
> an in-process app. If you want to run the same assertions against the live
> endpoint, extend it to read `process.env.SMOKE_BASE_URL` and `fetch()` that
> base instead of `app.request()`. This is optional and not required for Phase 6.

---

## Step 8 — Prove the clean-upgrade path [MANUAL — operator]

The whole point of the consumer model is that the next engine release is a
no-merge `pnpm up`. Prove it on a follow-up branch:

```bash
pnpm up "@hogsend/*"            # bumps the pinned engine + siblings to latest
pnpm install                    # refresh lockfile
# Local gate (§ checklist a–d) must stay green:
pnpm check-types && pnpm build && pnpm lint && pnpm --filter @hogsend/api test
```

Then redeploy (ideally to a staging Railway service if one exists). On deploy,
`db:migrate` applies any **new** engine migrations bundled in the upgraded
`@hogsend/db` with **no manual merge**, and `/v1/health` returns to
`engine.inSync == true`. That round-trip is the Phase 6 success criterion (h).

> If you have **patched** or **ejected** the engine, `pnpm up` behaves
> differently — see UPGRADING.md "If you've patched or ejected the engine".

---

## Step 9 — Rollback policy [MANUAL — operator, PROD]

In priority order (UPGRADING.md rollback policy):

1. **Roll forward.** Ship a patch release with a corrective migration. Preferred
   — preserves all data written since the upgrade.
2. **Redeploy the prior release.** Engine migrations are forward-only and
   additive, so the previous code runs fine against the newer schema
   (expand/contract). This recovers from a bad *code* deploy without data loss.
3. **Restore the Step 2 snapshot (last resort).** Only if the upgrade corrupted
   or lost data — you lose everything written since the backup:
   ```bash
   pg_restore --clean --if-exists --no-owner --no-privileges \
     --dbname="$PROD_DATABASE_URL" backups/hogsend-<stamp>.dump
   ```

Never hand-write a `down` migration against production.

---

## Verification checklist (collected)

**Local gate — all green before any prod step:**

- [ ] (a) `pnpm check-types`
- [ ] (b) `pnpm build`
- [ ] (c) `pnpm lint`
- [ ] (d) `pnpm --filter @hogsend/api test` (114 + any added tests)

**Production-parity gate — post-deploy:**

- [ ] (e) Same journeys fire → `journeyStates.status = completed` +
      `journey:completed`.
- [ ] (f) Tracked emails send → rewritten `/v1/t/c/:id` links + `/v1/t/o/:id`
      pixel; click records `link_clicks` + sets `emailSends.clickedAt`.
- [ ] (g) `/v1/health` → `status: healthy`,
      `schema.engine.inSync && schema.client.inSync`.
- [ ] (h) `pnpm up @hogsend/*` + redeploy applies new engine migrations with no
      manual merge; `/v1/health` returns to inSync.

---

## Strategy B (fallback) — fresh `create-hogsend` repo + content copy

Use only if Strategy A is blocked. Cleanest proof of the scaffolder, highest
churn (new git history).

1. `pnpm dlx create-hogsend@latest hogsend-app` — scaffold the client-repo shape
   (thin `src/index.ts` + `src/worker.ts`, pinned `@hogsend/*`, `migrations/` +
   `drizzle.client.config.ts`, Railway configs).
2. Copy content across from this repo: `apps/api/src/journeys/`,
   `apps/api/src/webhook-sources/`, `apps/api/src/workflows/`,
   `apps/api/src/__tests__/`, the env template, and any client `migrations/`.
3. Reconcile env vars and the Railway service settings
   (`CLIENT_MIGRATIONS_FOLDER`, etc.).
4. Point the **same** Railway services at the new repo, then run Steps 0–9 above
   against it.

---

## Risks & sharp edges (operator must read)

- **Prereqs gate (Step 0).** Phase 6 cannot run until `@hogsend/engine` is
  published and the two-track shape is live. Step 0 aborts otherwise.
- **db:push ledger gotcha (Step 5).** Engine track may report `inSync:false`
  despite present tables. **Baseline** the ledger; never re-run destructive DDL.
- **Advisory lock.** The chained preDeploy is correct because the two migrate
  CLIs run as separate, sequential processes (engine releases its lock before
  client starts). Do not collapse them into one process without giving the
  client track a distinct lock key.
- **Cross-track coupling.** Keep client migrations **additive-only** against
  engine tables — never drop/rename/retype an engine column from the client
  track, or a future engine upgrade will collide.
- **api/worker lockstep.** Deploy both services from the same ref together so
  api + worker + schema move as one unit.
- **Expand/contract.** Old code runs against the new schema during the deploy
  window and for in-flight Hatchet tasks — every migration in the release must
  be backward-compatible with the currently-running code.
