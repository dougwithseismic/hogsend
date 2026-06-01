# Phase 2 — Two-Track Migrations (KEYSTONE) — Implementation Plan

**Status:** PLANNING ONLY. Do not implement from this doc without the green-gate
checklist at the bottom. Phases 0 + 1 are done and verified (102 tests + smoke
green). This phase **parameterizes** the existing migrator / version probe /
boot guard / health block — it does not rewrite them.

**Design (locked, D4):**
- **Engine track** — migrations bundled in `@hogsend/db/drizzle`, ledger
  `drizzle.__drizzle_migrations` (schema `drizzle`, table `__drizzle_migrations`),
  owned upstream, versioned with the package. This is today's only track.
- **Client track** — migrations in the client repo's `migrations/` folder, ledger
  `drizzle.__client_migrations` (schema `drizzle`, table `__client_migrations`),
  owned by the client.
- Drizzle's `MigrationConfig` accepts `migrationsTable` + `migrationsSchema`
  (verified against the installed `drizzle-orm` typings), so each track applies
  against its own ledger in the same database. Run **engine-first, then client**.

**Reuse map (do NOT reinvent):**
- `packages/db/src/migrate.ts` — hardened migrator (advisory lock 4812007,
  lock_timeout 10s, statement_timeout 15min, short-circuit on inSync). Parameterize.
- `packages/db/src/version.ts` — `getSchemaVersion(db)` count-based probe + the
  journal import + `getBundledMigrations()`. Parameterize.
- `apps/api/src/index.ts` — boot guard. Re-target to the engine track explicitly.
- `packages/engine/src/routes/health.ts` — `/v1/health` schema block. Widen.
- `apps/api/src/__tests__/migration-system.test.ts` — extend to both tracks.

---

## Constants (single source of truth)

Add to `packages/db/src/version.ts` (exported, reused by migrate.ts + tests):

```ts
export const ENGINE_MIGRATIONS_SCHEMA = "drizzle";
export const ENGINE_MIGRATIONS_TABLE = "__drizzle_migrations";
export const CLIENT_MIGRATIONS_SCHEMA = "drizzle";
export const CLIENT_MIGRATIONS_TABLE = "__client_migrations";
```

Rationale: the engine values MUST match Drizzle's defaults so the existing
populated `drizzle.__drizzle_migrations` ledger keeps working unchanged
(back-compat — no re-stamping of any existing DB). The client table is a sibling
in the same `drizzle` schema (D4: two ledgers, one schema, no second pg schema).

---

## Step 1 — Parameterize the version probe (`packages/db/src/version.ts`)

The current `getSchemaVersion(db)` hardcodes (a) the bundled journal import and
(b) the `FROM drizzle.__drizzle_migrations` table. Split into a parameterized
core + two named wrappers + a back-compat default.

**New internal signature (the workhorse):**

```ts
export interface VersionSource {
  /** Journal entries (idx/tag/when) that this track's code requires. */
  journal: JournalShape;
  /** Ledger schema, e.g. "drizzle". */
  ledgerSchema: string;
  /** Ledger table, e.g. "__drizzle_migrations" / "__client_migrations". */
  ledgerTable: string;
}

async function readSchemaVersion(
  db: ExecutableDb,
  source: VersionSource,
): Promise<SchemaVersion>;
```

- Move the existing body of `getSchemaVersion` into `readSchemaVersion`, replacing:
  - `getBundledMigrations()` → a local `getJournalEntries(source.journal)` that
    sorts `source.journal.entries` by idx (keep `getBundledMigrations()` as the
    engine-journal wrapper so the existing export keeps its exact behavior).
  - the literal `sql\`... FROM drizzle.__drizzle_migrations\`` → use
    `sql.identifier(source.ledgerSchema)` + `sql.identifier(source.ledgerTable)`
    (import `sql` is already present). Build:
    `sql\`SELECT count(*)::int AS count FROM \${sql.identifier(source.ledgerSchema)}.\${sql.identifier(source.ledgerTable)}\``.
    Keep the existing try/catch → "table doesn't exist yet ⇒ appliedCount 0".
  - Keep the count-based applied/pending/inSync math byte-for-byte.

**Public API (exported):**

```ts
// Engine track — bundled journal + drizzle.__drizzle_migrations.
export async function getEngineSchemaVersion(
  db: ExecutableDb,
): Promise<SchemaVersion>;

// Client track — caller supplies its own journal (the client repo's
// migrations/meta/_journal.json), ledger drizzle.__client_migrations.
export async function getClientSchemaVersion(
  db: ExecutableDb,
  journal: JournalShape,
): Promise<SchemaVersion>;

// BACK-COMPAT default == engine. Boot guard + health import this today.
export async function getSchemaVersion(
  db: ExecutableDb,
): Promise<SchemaVersion>;  // delegates to getEngineSchemaVersion
```

- `getEngineSchemaVersion` calls `readSchemaVersion(db, { journal, ENGINE_*… })`
  where `journal` is the existing `import ... _journal.json`.
- `getSchemaVersion` becomes a one-line delegate to `getEngineSchemaVersion`
  (KEEP the export — `apps/api/src/index.ts` and `packages/engine/.../health.ts`
  and the existing tests all import it; we MUST NOT break those imports).
- `getClientSchemaVersion` requires the caller to pass the journal because the
  client journal lives in the *client repo*, not in `@hogsend/db`. In this monorepo
  there is no client journal yet, so the engine never imports one — the tests
  supply a synthetic one (see Step 6).
- Export `JournalShape` as a public type (tests construct one). Currently it is an
  internal `interface JournalShape`; add `export` to it.

**Why count-based stays correct per track:** each ledger is independent; the
engine ledger row count vs engine journal length, the client ledger row count vs
client journal length. No cross-track interaction in the math.

---

## Step 2 — Parameterize the migrator (`packages/db/src/migrate.ts`)

Current file is a top-level script (reads `DATABASE_URL`, runs once, exits). Keep
it runnable as a script (`tsx src/migrate.ts` is the `db:migrate` npm script and
is called by CI + railway today) but factor the run logic into a parameterized,
importable function so both tracks share the advisory lock + timeouts.

**New importable function:**

```ts
export interface MigrateTrackOptions {
  /** Already-constructed postgres-js client (max:1, idle_timeout:0). */
  client: ReturnType<typeof postgres>;
  /** drizzle(client) instance bound to that client. */
  db: ReturnType<typeof drizzle>;
  migrationsFolder: string;
  migrationsTable: string;
  migrationsSchema: string;
  /** Per-track version probe so logging reports the right pending set. */
  version: (db: ExecutableDb) => Promise<SchemaVersion>;
  /** Label for log lines, e.g. "engine" / "client". */
  label: string;
}

export async function migrateTrack(opts: MigrateTrackOptions): Promise<void>;
```

`migrateTrack` body = today's `run()`, generalized:
- `SET lock_timeout = '10s'`, `SET statement_timeout = '15min'` (unchanged).
- `SELECT pg_advisory_lock(4812007)` … `finally pg_advisory_unlock(4812007)`
  (unchanged — same lock key serializes BOTH tracks; that is fine and desirable,
  the two tracks run sequentially under one lock acquisition per call).
- `const before = await opts.version(opts.db);` short-circuit on `inSync` with the
  existing "already up to date" log, prefixed with `[${opts.label}]`.
- `await migrate(opts.db, { migrationsFolder, migrationsTable, migrationsSchema })`.
- `const after = await opts.version(opts.db);` log "complete … now at after.applied".

**Engine / client entrypoints (exported, importable):**

```ts
// Engine track: bundled @hogsend/db/drizzle folder + default ledger.
export async function migrateEngine(databaseUrl: string): Promise<void>;

// Client track: caller's migrations folder + __client_migrations ledger.
// Caller also passes the client journal so the version probe can short-circuit.
export async function migrateClient(
  databaseUrl: string,
  migrationsFolder: string,
  journal: JournalShape,
): Promise<void>;
```

- `migrateEngine`: build the `max:1` client + drizzle, resolve the bundled folder
  (`new URL("../drizzle", import.meta.url).pathname` — unchanged), call
  `migrateTrack` with `ENGINE_MIGRATIONS_SCHEMA/TABLE`, `version: getEngineSchemaVersion`,
  `label: "engine"`. Keep the `existsSync(folder)` skip guard. End the client in a
  `finally`.
- `migrateClient`: same client/db construction; folder + journal passed in; table/schema
  = `CLIENT_*`; `version: (db) => getClientSchemaVersion(db, journal)`; `label: "client"`.

**Keep the CLI behavior (the `db:migrate` script):** the bottom-of-file
`run().then(...).catch(...)` block stays, but rewrite `run()` to:
- read `DATABASE_URL` (existing fail-fast), then `await migrateEngine(databaseUrl)`.
- **Engine only.** The `@hogsend/db` package has no knowledge of any client repo's
  `migrations/` folder, so `db:migrate` (engine) and a separate client migrate are
  distinct commands. The client track is invoked by the *client repo's* own script
  (Phase 3 scaffolder) / railway preDeploy (Step 5), pointing `migrateClient` at its
  local `migrations/`. In THIS monorepo `apps/api` has no client migrations yet, so
  nothing calls `migrateClient` in production paths — only the tests do (Step 6).

Add a thin client-migrate CLI shim for the dogfood/test path:
- New script `packages/db/src/migrate-client.ts` that reads `DATABASE_URL`,
  `CLIENT_MIGRATIONS_FOLDER` (env), loads `<folder>/meta/_journal.json`, and calls
  `migrateClient(...)`. Add `"db:migrate:client": "tsx src/migrate-client.ts"` to
  `packages/db/package.json` scripts. The tests can shell out to this exactly like
  they shell out to `db:migrate` today (preserves the "run the REAL migrator binary
  and assert on its stdout" testing approach).

**Re-export from `@hogsend/db` (`packages/db/src/index.ts`):**

```ts
export {
  getBundledMigrations,
  getSchemaVersion,            // back-compat (engine default)
  getEngineSchemaVersion,
  getClientSchemaVersion,
  type JournalShape,
  type MigrationEntry,
  type SchemaVersion,
} from "./version.js";
export { migrateEngine, migrateClient, migrateTrack } from "./migrate.js";
```

Note: `migrate.ts` currently runs its CLI block at import time. Guard the CLI
block so importing the module (to get `migrateEngine`/`migrateClient`) does NOT
trigger a migration run + `process.exit`. Wrap the bottom block in:
`if (import.meta.url === pathToFileURL(process.argv[1]).href) { run()... }`
(import `pathToFileURL` from `node:url`). This is required because `index.ts`
will now re-export from it.

---

## Step 3 — Re-export the new probes from `@hogsend/engine`

`packages/engine/src/index.ts` line 12 currently:
`export { getBundledMigrations, getSchemaVersion } from "@hogsend/db";`

Widen to also surface the per-track probes (the boot guard + health route consume
them via the engine, and Phase 3 client code will too):

```ts
export {
  getBundledMigrations,
  getSchemaVersion,
  getEngineSchemaVersion,
  getClientSchemaVersion,
  type JournalShape,
  type SchemaVersion,
} from "@hogsend/db";
```

(Engine does NOT re-export `migrateEngine/migrateClient` unless a consumer needs
them at runtime — railway calls the `@hogsend/db` scripts directly, so leave
those out of the engine surface for now to keep the API minimal.)

---

## Step 4 — Boot guard re-targeted to the ENGINE track (`apps/api/src/index.ts`)

Current guard imports `getSchemaVersion` and asserts `inSync`. Change to the
explicit engine probe and document the client-track policy.

- Replace the `getSchemaVersion` import (from `@hogsend/engine`) with
  `getEngineSchemaVersion`.
- Replace `const schema = await getSchemaVersion(container.db);` with
  `const schema = await getEngineSchemaVersion(container.db);`.
- Keep the existing `SKIP_SCHEMA_CHECK` bypass, the error message, the
  `dbClient.end` + `process.exit(1)`, and the success log — wording unchanged
  except it now refers to the engine track.
- Add a comment block documenting the **client-track gating policy** (decision in
  this phase):

  > The ENGINE track gates boot: the running build hard-requires its bundled
  > engine schema, so a behind-engine DB is a fatal misconfiguration. The CLIENT
  > track does **not** gate boot — the client owns it, may legitimately deploy
  > app code ahead of an additive client migration, and a pending client
  > migration must not take the whole API down. Client-track drift is surfaced
  > (non-fatally) via `/v1/health` (`schema.client.inSync:false` ⇒ status
  > `migration_pending`) and is the operator's responsibility to resolve.

  This keeps back-compat: `getEngineSchemaVersion === getSchemaVersion` behavior,
  so all 102 existing tests and the smoke (`SKIP_SCHEMA_CHECK=true`) are unaffected.

---

## Step 5 — Widen `/v1/health` to both tracks (`packages/engine/src/routes/health.ts`)

Current `schema` block is `{ applied, required, inSync, pending }`. Widen to a
per-track block. Decision: **breaking-but-clearer** nested shape, because Phase 2
success criteria explicitly require `schema: { engine: {...}, client: {...} }`.

**New Zod schema:**

```ts
const trackSchema = z.object({
  applied: z.string().nullable(),
  required: z.string().nullable(),
  inSync: z.boolean(),
  pending: z.array(z.string()),
});

// inside healthResponseSchema:
schema: z.object({
  engine: trackSchema,
  client: trackSchema,
}),
```

**Handler changes:**
- Replace the single `getSchemaVersion(db)` in the `Promise.all` with both probes:
  `getEngineSchemaVersion(db)` and `getClientSchemaVersion(db, clientJournal)`.
- **Client journal source:** the engine has no client journal. Resolve it from the
  container so the client app can inject its own. Add an OPTIONAL field to the
  container/createApp options: `clientMigrations?: { journal: JournalShape }`
  (threaded through `CreateAppOptions` → available on the Hono context, or read
  from `c.get("container")`). When ABSENT (this monorepo today — `apps/api` has no
  client migrations), the client track reports an **empty journal**:
  `{ entries: [] }` ⇒ `required:null, applied:null, pending:[], inSync:true`. An
  empty client track is trivially in sync and never flips `migration_pending`.
  - Concretely: add `clientJournal?: JournalShape` to `CreateAppOptions` in
    `packages/engine/src/app.ts`; default to `{ entries: [] }`; pass it into the
    health router (the router already reads the container; pass the journal via a
    small closure/factory or stash it on the container — preferred: add
    `clientJournal` to the container in `createContainer` options so health reads
    `container.clientJournal ?? { entries: [] }`). Pick ONE seam and keep it
    consistent with D2 injection style (container override is the established seam).
- `migration_pending` if **either** track has `!inSync`:
  `const inSync = engine.inSync && client.inSync;`
  `status = !inSync ? "migration_pending" : allUp ? "healthy" : "degraded";`
- Response `schema` becomes `{ engine: {...}, client: {...} }`.

**Back-compat note for the doc/CHANGELOG:** this changes the `/v1/health`
response shape (the `schema` block moves from flat to nested). Call this out as a
minor-but-visible API change. The existing health test asserts on
`body.schema.required/applied/inSync` (flat) — it MUST be updated to
`body.schema.engine.*` (Step 6). No external consumer in-repo depends on the flat
shape besides that test and `docs/UPGRADING.md` (Step 7 updates the doc example).

---

## Step 6 — Tests: extend `apps/api/src/__tests__/migration-system.test.ts`

Keep ALL existing tests green; the only existing edit is the health-endpoint test
(flat → nested `schema.engine`). Everything else is additive. Both tracks run
against the SAME throwaway DB (`hogsend_migrate_test`) that the suite already
creates/drops in `beforeAll`/`afterAll`.

**Test fixtures for a synthetic client track:**
- Create a fixture client migrations folder under the test dir, e.g.
  `apps/api/src/__tests__/fixtures/client-migrations/` containing:
  - `0000_client_init.sql` — a trivially additive migration that does NOT touch
    engine tables, e.g.:
    `CREATE TABLE IF NOT EXISTS client_demo (id serial primary key, note text);`
    (Add a `--> statement-breakpoint` if multiple statements, matching drizzle
    format.)
  - `meta/_journal.json` — minimal drizzle journal:
    `{ "version":"7","dialect":"postgresql","entries":[{"idx":0,"version":"7","when":1,"tag":"0000_client_init","breakpoints":true}] }`
  - `meta/0000_snapshot.json` — drizzle requires a snapshot file per migration to
    read the folder; provide a minimal valid snapshot (or generate one once via a
    throwaway `drizzle-kit` run and commit it). If hand-authoring is brittle,
    generate the fixture with `drizzle-kit generate` against a tiny throwaway
    schema and copy the output in. **Author note:** verify `migrate()` reads the
    fixture folder cleanly before relying on it (drizzle validates journal⇄snapshot
    pairing).
- Helper to load the fixture journal in-test:
  `const clientJournal = JSON.parse(readFileSync(<fixture>/meta/_journal.json))`.
- Helper to run the client migrator binary (mirrors `runMigrator`):

```ts
function runClientMigrator(databaseUrl: string, folder: string): string {
  return execSync("pnpm --filter @hogsend/db db:migrate:client 2>&1", {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl,
           CLIENT_MIGRATIONS_FOLDER: folder },
  });
}
```

**New `describe("two-track migrations against a throwaway database")` block —
sequenced (engine first, then client) since they share one DB:**

1. **`engine track applies first and is independent of the client ledger`**
   - `runMigrator(TEST_URL)` (existing engine binary).
   - `const e = await getEngineSchemaVersion(testDb);`
     - `expect(e.inSync).toBe(true)`
     - `expect(e.applied).toBe(getBundledMigrations().at(-1)?.tag)`
   - `const c = await getClientSchemaVersion(testDb, clientJournal);`
     - client ledger does not exist yet ⇒ `expect(c.inSync).toBe(false)`,
       `expect(c.applied).toBeNull()`, `expect(c.pending).toEqual(["0000_client_init"])`.
   - Assert the engine ledger table exists and the client one does NOT yet:
     query `to_regclass('drizzle.__drizzle_migrations')` non-null,
     `to_regclass('drizzle.__client_migrations')` null.

2. **`client track applies into its own ledger without touching the engine ledger`**
   - capture engine row count before:
     `SELECT count(*) FROM drizzle.__drizzle_migrations`.
   - `const out = runClientMigrator(TEST_URL, CLIENT_FIXTURE_DIR);`
     - `expect(out).toMatch(/\[client\] Applying \d+ migration/)`
     - `expect(out).toMatch(/Migrations complete/)`
   - `const c = await getClientSchemaVersion(testDb, clientJournal);`
     - `expect(c.inSync).toBe(true)`, `expect(c.applied).toBe("0000_client_init")`,
       `expect(c.pending).toHaveLength(0)`.
   - engine ledger UNCHANGED: `SELECT count(*) FROM drizzle.__drizzle_migrations`
     equals the before count; `getEngineSchemaVersion(testDb).inSync === true`.
   - client table created: `SELECT to_regclass('drizzle.__client_migrations')`
     non-null; `SELECT to_regclass('public.client_demo')` non-null.

3. **`each ledger lives at its own table`** (independence proof)
   - `expect(ENGINE_MIGRATIONS_TABLE).not.toBe(CLIENT_MIGRATIONS_TABLE)`.
   - both tables present; counts read independently and match each journal length:
     engine count === `getBundledMigrations().length`,
     client count === `clientJournal.entries.length`.

4. **`client track is idempotent — re-running applies nothing`**
   - `const out = runClientMigrator(TEST_URL, CLIENT_FIXTURE_DIR);`
   - `expect(out).toMatch(/already up to date/i)`.
   - `getClientSchemaVersion(testDb, clientJournal).inSync === true`.

5. **`engine track stays idempotent after client applied`** (cross-track no-op)
   - `runMigrator(TEST_URL)` ⇒ `expect(out).toMatch(/already up to date/i)`.
   - confirms applying client migrations did not perturb engine inSync.

6. **`client pending is detected per track`**
   - simulate a client behind state: `DELETE FROM drizzle.__client_migrations`
     (or delete newest row). `getClientSchemaVersion(testDb, clientJournal)`:
     `inSync:false`, `pending` equals the deleted tag(s). Engine probe still
     `inSync:true` (proves per-track isolation of pending detection).
   - re-run `runClientMigrator` to restore (leave DB clean for later tests / no-op).

7. **`boot guard keys off the ENGINE track only`**
   - import `getEngineSchemaVersion` (the function the guard now calls).
   - With client ledger artificially behind (delete a client row), assert
     `getEngineSchemaVersion(testDb).inSync === true` — i.e. the guard's signal is
     unaffected by client drift. (We assert the guard's *input*, mirroring how the
     existing "boot guard trips" test asserts `getSchemaVersion` rather than
     spawning the process.) Restore the client row after.

**Update the existing health-endpoint test (`describe("health endpoint exposes
schema state")`):**
- It currently asserts `body.schema.required/applied/inSync` (flat). Change to:
  - `const engine = await getEngineSchemaVersion(container.db);`
  - `expect(body.schema.engine.required).toBe(engine.required)`
  - `expect(body.schema.engine.applied).toBe(engine.applied)`
  - `expect(body.schema.engine.inSync).toBe(engine.inSync)`
  - `expect(body.schema.engine.required).toBe(getBundledMigrations().at(-1)?.tag ?? null)`
  - `expect(body.schema.client).toBeDefined()` and, since `apps/api` injects no
    client journal, `expect(body.schema.client.inSync).toBe(true)` +
    `expect(body.schema.client.pending).toEqual([])`.
  - keep the `if (engine.inSync) expect(body.status).not.toBe("migration_pending")`
    invariant.
- This test runs against the shared dev DB (5434), which has NO client ledger and
  NO injected client journal ⇒ empty client track ⇒ `inSync:true`. Safe.

**Add a `client track on an empty journal is trivially in sync` unit test**
(no DB write needed beyond an empty ledger): `getClientSchemaVersion(testDb,
{ entries: [] })` ⇒ `{ required:null, applied:null, pending:[], inSync:true }`.
Guards the health-default path.

**Keep the existing engine tests** ("reports every migration pending on empty",
"applies all from empty", "is idempotent", "detects DB behind build") — these
still call `getSchemaVersion`/`getBundledMigrations` which keep working. Optionally
rename their `describe` to "engine track …" for clarity but DO NOT change
assertions.

---

## Step 7 — Railway preDeploy (config only; do NOT run railway)

`railway.toml` `preDeployCommand` currently:
`pnpm --filter @hogsend/db db:migrate`

Change to engine-then-client (engine MUST succeed first):
```toml
preDeployCommand = "pnpm --filter @hogsend/db db:migrate && pnpm --filter @hogsend/db db:migrate:client"
```
- `db:migrate:client` reads `CLIENT_MIGRATIONS_FOLDER` from env (set per service to
  the client repo's `migrations` dir). In THIS dogfood repo there is no client
  migrations folder, so either (a) leave only the engine command and add the
  client command as a documented comment for the scaffolded client repo, or
  (b) make `db:migrate:client` a no-op when `CLIENT_MIGRATIONS_FOLDER` is unset
  (the shim already skips via `existsSync`). **Recommended:** ship both commands
  but make the client shim skip gracefully when the folder is absent/empty, so the
  same `railway.toml` works for both this repo and scaffolded clients.
- Mirror the same change into `railway.worker.toml` only if it runs a preDeploy
  migrate (check; the worker generally should not — engine doc says worker has no
  healthcheck and migrations run on the API service's preDeploy). Leave worker
  alone unless it currently migrates.
- **Do not run any `railway` command.** Config edit only.

---

## Step 8 — CI (`.github/workflows/ci.yml`) migrations job: exercise both tracks

The `migrations` job runs against its own throwaway `hogsend` DB on
`postgres:17-alpine` (port 5432). Extend it AFTER the existing engine steps:

- After step 2 (fresh engine apply) and step 3 (engine idempotency), add:
  - **Client fresh apply:**
    `CLIENT_MIGRATIONS_FOLDER=apps/api/src/__tests__/fixtures/client-migrations \
     pnpm --filter @hogsend/db db:migrate:client` (reuses the test fixture as the
    canonical sample client track — there is no production client folder in-repo).
  - **Client idempotency:** run the same command again, assert no-op. (Either grep
    stdout for "already up to date", or just assert exit 0 + a follow-up
    `getClientSchemaVersion` check via a tiny `tsx -e` snippet.)
- In the **upgrade-from-previous-release** step (step 4): the client fixture lives
  under `apps/api` (not `packages/db`), so the `git checkout "$BASE" -- packages/db`
  does not affect it; after restoring HEAD `packages/db`, additionally run the
  client migrate against `upgrade_test` to prove engine-upgrade-then-client-apply
  works on a populated DB. Keep this additive; do not weaken existing assertions.
- Also ensure the `test` job (vitest, port 5434) still runs `db:migrate` (engine)
  before `pnpm test` — UNCHANGED; the new two-track vitest tests create their own
  throwaway DB and shell out to `db:migrate:client` themselves, so no CI change is
  needed there beyond the existing engine migrate.

---

## Step 9 — Docs: cross-track sharp edge in `docs/UPGRADING.md`

Add a new top-level section "## Two-track migrations (engine + client)" covering:
- The two ledgers: engine `drizzle.__drizzle_migrations` (owned by `@hogsend/db`,
  versioned with the package) vs client `drizzle.__client_migrations` (owned by the
  client repo's `migrations/`). They apply independently, engine-first.
- **Boot gating policy:** engine track gates boot (fatal if behind); client track
  does NOT gate boot (surfaced via `/v1/health` `schema.client.inSync`, operator-
  resolved). Cross-reference Step 4's comment.
- **The cross-track sharp edge:** a client migration that ALTERs an *engine* table
  (rather than adding the client's own tables) couples the two tracks. Guidance:
  - **Additive-only against engine tables** — add your own columns/tables; never
    drop/rename/retype engine columns from the client track.
  - **Re-verify after every engine upgrade** — an engine migration may move a table
    your client migration assumed; run `/v1/health` and your client migrate after
    `pnpm up @hogsend/*`.
  - Engine schema changes follow **expand→migrate→contract** (link the existing
    section). Client migrations that depend on an engine column must wait for the
    column to reach the contract/stable state.
- **Update the `/v1/health` example JSON** in the existing "Verifying an upgrade"
  section from the flat `schema` block to the new nested
  `schema: { engine: {…}, client: {…} }` shape; explain `migration_pending` is true
  if EITHER track is behind.

---

## Files touched (exact list)

- `packages/db/src/version.ts` — parameterize; add constants, `readSchemaVersion`,
  `getEngineSchemaVersion`, `getClientSchemaVersion`, export `JournalShape`; keep
  `getSchemaVersion` as engine delegate, keep `getBundledMigrations`.
- `packages/db/src/migrate.ts` — add `migrateTrack`, `migrateEngine`,
  `migrateClient`; guard the CLI block with `import.meta.url` check; CLI `run()`
  calls `migrateEngine`.
- `packages/db/src/migrate-client.ts` — NEW client-migrate CLI shim
  (`CLIENT_MIGRATIONS_FOLDER` env, loads journal, calls `migrateClient`, graceful
  skip when folder absent/empty).
- `packages/db/src/index.ts` — re-export new probes + migrate fns + `JournalShape`.
- `packages/db/package.json` — add `"db:migrate:client": "tsx src/migrate-client.ts"`.
- `packages/engine/src/index.ts` — widen the `@hogsend/db` re-export.
- `packages/engine/src/container.ts` (and/or `app.ts`) — add optional
  `clientJournal` injection seam (default `{ entries: [] }`).
- `packages/engine/src/routes/health.ts` — nested `schema.{engine,client}` block;
  both probes; `migration_pending` if either pending.
- `apps/api/src/index.ts` — boot guard → `getEngineSchemaVersion`; policy comment.
- `apps/api/src/__tests__/migration-system.test.ts` — extend (both-track block,
  updated health test, empty-client unit test).
- `apps/api/src/__tests__/fixtures/client-migrations/**` — NEW fixture track
  (`0000_client_init.sql` + `meta/_journal.json` + `meta/0000_snapshot.json`).
- `railway.toml` — preDeploy engine-then-client.
- `.github/workflows/ci.yml` — migrations job exercises client track + upgrade.
- `docs/UPGRADING.md` — two-track section + updated `/v1/health` example.

---

## Verification checklist (mirrors the TODO's Phase 2 Verify/Success)

- [ ] `pnpm check-types` green across all workspaces.
- [ ] `pnpm build` (turbo) green.
- [ ] `pnpm lint` green (Biome: 2-space, double quotes, semicolons, 80-col).
- [ ] `pnpm --filter @hogsend/api test` — all 102 existing tests STILL green +
      new two-track tests pass. (`migration-system.test.ts` creates its own
      throwaway `hogsend_migrate_test`; never mutates the shared 5434 dev DB
      destructively.)
- [ ] Two-track tests prove: engine applies first; client applies into its own
      `drizzle.__client_migrations` without touching `drizzle.__drizzle_migrations`;
      ledgers are independent; pending detected per track; idempotent per track;
      boot guard keys off the engine probe; `/v1/health` reports both tracks.
- [ ] `getSchemaVersion` (back-compat) still equals engine behavior; boot guard
      and the smoke (`SKIP_SCHEMA_CHECK=true`) unaffected.
- [ ] `/v1/health` returns `schema: { engine: {...}, client: {...} }`, each
      `{ required, applied, pending, inSync }`; `migration_pending` iff either track
      behind; empty/absent client journal ⇒ client track trivially in sync.
- [ ] `railway.toml` preDeploy = engine migrate then client migrate (config only,
      NO `railway` command run).
- [ ] `docs/UPGRADING.md` documents the cross-track sharp edge (additive-only client
      migrations against engine tables; re-verify after engine upgrades; nested
      health example).
- [ ] CI migrations job exercises both tracks (fresh apply, idempotency) +
      upgrade-from-previous-release applies engine then client on populated data.
- [ ] (When infra up, optional) `pnpm --filter @hogsend/api smoke` still 9/9.

---

## Risks / sharp edges

- **Drizzle fixture pairing:** `migrate()` validates the journal⇄snapshot pairing
  in the client fixture folder; a hand-authored `meta/0000_snapshot.json` may be
  rejected. Mitigation: generate the fixture once via `drizzle-kit generate`
  against a tiny throwaway schema and commit the output rather than hand-writing.
- **`migrate.ts` import side-effects:** the file runs a migration + `process.exit`
  at import today; re-exporting from it (`index.ts`) requires the
  `import.meta.url === pathToFileURL(process.argv[1]).href` CLI guard, else any
  import of `@hogsend/db` would fire a real migration. Must verify the guard works
  under both `tsx` (dev/CI script) and bundled consumers.
- **`/v1/health` shape change** (flat → nested `schema`) is a visible API change.
  In-repo only the one test + the UPGRADING example reference the flat shape;
  external dashboards (if any) must be updated. Flag in the CHANGELOG/changeset.
- **Shared advisory lock across tracks:** both tracks use `pg_advisory_lock(4812007)`.
  Sequential calls (engine then client) each acquire+release, so no deadlock; but a
  client migrate cannot run concurrently with an engine migrate on the same DB —
  which is the desired serialization, not a bug.
- **Client journal injection seam:** picking the wrong seam (app.ts option vs
  container field) risks inconsistency with the D2 injection style. Decision in
  this plan: use the container-override style (consistent with D2) — add
  `clientJournal` to `createContainer` options, default `{ entries: [] }`, read in
  health via `c.get("container")`.
- **CI fixture path coupling:** CI reuses the vitest fixture folder as the sample
  client track. If the fixture moves, both the test and the CI job must update —
  keep the path in one documented place.
