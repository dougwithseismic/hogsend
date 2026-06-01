# Upgrading Hogsend

> For **how versions are cut and what a version _means_** (the publish set,
> the two-phase changesets flow, and the semver rules that decide major/minor/
> patch), see [RELEASING.md](./RELEASING.md). This document is about applying an
> upgrade safely; RELEASING.md is about producing one.

This document is the **contract** for upgrading a running Hogsend deployment that
already has production data. Read it before every upgrade.

Hogsend ships `api`, `worker`, and `db` (schema migrations) as a **single
versioned unit** — they must always move in lockstep. Never run an `api` build
against a `worker` or schema from a different release.

---

## TL;DR upgrade checklist

1. **Back up the database** (snapshot or `pg_dump`). This is your only rollback.
2. Read the `CHANGELOG` entry for the target version — look for ⚠️ breaking notes
   and any **manual backfill** steps.
3. Deploy the new release. Railway's `preDeployCommand` runs `db:migrate`
   automatically *before* the new API boots.
4. Confirm `GET /v1/health` reports the expected `version` **and**
   `schema.applied === schema.required` (status `healthy`, not `migration_pending`).
5. If a release notes a backfill job, trigger/verify it after the deploy.

---

## Core rules

### 1. Migrations are forward-only

We do **not** ship `down` migrations for production. A `down` that drops a column
or table is data loss, not a rollback. To recover from a bad upgrade you either:

- **roll forward** with a patch release containing a fix migration, or
- **restore** the pre-upgrade database snapshot.

This is why step 1 of every upgrade is a backup.

### 2. Expand → migrate → contract (never break running code)

Railway runs `db:migrate` *before* the new code is live, and the `worker`
deploys separately — so during the deploy window **old code runs against the new
schema**, and in-flight Hatchet tasks (journeys mid-sleep, queued sends) execute
old code. Therefore:

> Every migration must be backward-compatible with the code version currently
> running. Never make a destructive change in the *same* release that the code
> stops needing it.

Destructive changes (drop/rename column, tighten `NOT NULL`, change a type,
add/strengthen a constraint) are split across **three** releases:

| Release         | Schema change                                  | Code change                          |
| --------------- | ---------------------------------------------- | ------------------------------------ |
| **N — expand**  | add new column (nullable / defaulted), new table | write to *both* old + new, read old |
| **N+1 — migrate** | backfill (batched, idempotent, off-line job)  | read new, stop writing old           |
| **N+2 — contract** | drop old column / tighten constraint          | new only                             |

A rename = add-new + backfill + drop-old across these three releases. Never one.

### 3. `db:push` is dev-only — production is always `db:migrate`

`pnpm db:push` mutates the schema with no migration record and no review. Use it
on a throwaway local DB only. Production and staging upgrade exclusively through
versioned migrations applied by `db:migrate`.

> **Gotcha — the migration ledger.** `db:push` (and seeding into a fresh DB)
> creates the schema **without** writing rows to `drizzle.__drizzle_migrations`.
> The boot guard and `/v1/health` judge "in sync" by that ledger, so a
> push-bootstrapped database reports `inSync: false` and the API will refuse to
> start — even though the tables exist. Always bring up real databases with
> `db:migrate` from day one. To adopt an existing push-built DB, **baseline** it
> once: apply migrations against an empty DB to confirm parity, then run
> `db:migrate` on the real DB (drizzle records each migration it applies) — or,
> if the schema already matches head, seed the ledger by marking migrations
> applied. For local dev you can also set `SKIP_SCHEMA_CHECK=true` to bypass the
> guard.

### 4. Backfills do not run inside migrations

A migration that does `UPDATE big_table SET ...` locks rows and can run for
minutes against a live DB. Migrations only add the column/table. The data
backfill ships as a **Hatchet job** — batched, idempotent, resumable, and
observable — and is called out in the release notes.

---

## Authoring a migration (for contributors)

```bash
# 1. Edit the Drizzle schema in packages/db/src/schema/*.ts
# 2. Generate the migration (creates a numbered file in packages/db/drizzle/)
cd packages/db && pnpm db:generate
# 3. Review the generated SQL. For indexes on large tables, rewrite the
#    statement as CREATE INDEX CONCURRENTLY in its own non-transactional
#    migration (concurrent index creation cannot run inside a transaction).
# 4. Commit schema + migration TOGETHER. CI fails if `db:generate` would
#    produce a non-empty diff (schema drift) or if any migration fails to apply.
```

Guidelines:

- **Additive per release.** No drops/renames in the same release that stops using
  the column (see rule 2).
- **New `NOT NULL` columns need a default** (or add nullable → backfill → set
  `NOT NULL` across releases) so existing rows don't break the migration.
- **Large indexes → `CREATE INDEX CONCURRENTLY`** in a dedicated migration.
- **Heavy data changes → Hatchet backfill job**, not the migration.

---

## Rollback policy

There is no automated rollback. In priority order:

1. **Roll forward** — ship a patch release with a corrective migration. Preferred,
   because it preserves all data written since the upgrade.
2. **Restore the snapshot** — only if the upgrade corrupted or lost data. You lose
   everything written between the snapshot and the restore, so treat as last
   resort.

Never hand-write a `down` migration against production to "undo" a release.

### If you've patched or ejected the engine

The [Extend → Patch → Eject ladder](./customizing-the-engine.md) changes what an
upgrade does:

- **Patched** (`pnpm patch @hogsend/engine`): on `pnpm up`, if the patched lines
  moved, install **fails loudly** with `Could not apply patch …`. Refresh the
  patch against the new version (re-run the `pnpm patch` cycle), or escalate to
  Eject if it keeps conflicting.
- **Ejected** (`hogsend eject @hogsend/engine` → `vendor/engine`): that one
  package no longer tracks upstream — you merge engine changes into
  `vendor/engine` by hand. **Every other `@hogsend/*` still `pnpm up`s.** The
  two-track migration story below is unaffected: engine migrations ship from
  whatever `@hogsend/db` you resolve.

See [customizing-the-engine.md](./customizing-the-engine.md) for the full
contract at each rung.

---

## Two-track migrations (engine + client)

Hogsend runs **two independent migration tracks** against the same database,
each with its own ledger in the `drizzle` schema:

| Track      | Migrations live in                       | Ledger                          | Owned by              |
| ---------- | ---------------------------------------- | ------------------------------- | --------------------- |
| **engine** | `@hogsend/db` (bundled with the package) | `drizzle.__drizzle_migrations`  | upstream (the engine) |
| **client** | your repo's `migrations/` folder         | `drizzle.__client_migrations`   | you (the client)      |

They apply **engine-first, then client** (Railway's `preDeployCommand` runs
`db:migrate` then `db:migrate:client`). Each track's count-based version probe
compares its ledger against its own journal — the tracks never interact in the
version math, and both serialize behind the same advisory lock so a client
migrate can never race an engine migrate on the same DB.

### Boot gating policy

- **Engine track gates boot (fatal).** The running build hard-requires its
  bundled engine schema, so a behind-engine database is a fatal
  misconfiguration: the API logs the pending migrations and exits non-zero.
- **Client track does NOT gate boot.** The client owns it and may legitimately
  deploy app code slightly ahead of an additive client migration; a pending
  client migration must not take the whole API down. Client-track drift is
  surfaced non-fatally via `GET /v1/health` (`schema.client.inSync: false` ⇒
  status `migration_pending`) and is the operator's responsibility to resolve.

### The cross-track sharp edge

A client migration that **ALTERs an engine table** (rather than adding the
client's own tables) couples the two tracks. Guidance:

- **Additive-only against engine tables.** Add your own columns/tables; **never
  drop, rename, or retype an engine column from the client track.** The engine
  may move or remove that column in a future release and your client migration
  will silently diverge or fail.
- **Re-verify after every engine upgrade.** An engine migration may relocate a
  table or column your client migration assumed. After `pnpm up @hogsend/*`,
  run `db:migrate` (engine) then `db:migrate:client`, and check `/v1/health`
  reports both tracks `inSync`.
- **Respect expand → migrate → contract** (see rule 2 above) for the engine
  schema. A client migration that depends on an engine column must wait until
  that column has reached its stable (contract) state — never build on a column
  the engine is mid-way through adding or removing.

---

## Verifying an upgrade

`GET /v1/health` reports both the application version and the schema state of
**both tracks**:

```jsonc
{
  "status": "healthy",          // or "migration_pending" / "degraded"
  "version": "1.4.0",
  "schema": {
    "engine": {
      "required": "0012",        // latest engine migration bundled in this build
      "applied": "0012",         // latest engine migration applied to the DB
      "inSync": true,
      "pending": []              // engine migrations the code needs but DB lacks
    },
    "client": {
      "required": "0003",        // latest client migration in your repo (or null)
      "applied": "0003",         // latest client migration applied to the DB
      "inSync": true,
      "pending": []              // client migrations not yet applied
    }
  }
}
```

- A client repo that ships no migrations reports an **empty client track**
  (`required: null`, `applied: null`, `pending: []`, `inSync: true`) — trivially
  in sync, never flips `migration_pending`.
- `applied === required` on a track → that track is in sync with the code. ✅
- `migration_pending` is set when **either** track is behind. The engine track
  additionally asserts at boot and refuses to serve if behind, turning silent
  breakage into a clear, actionable error; the client track only surfaces here.
