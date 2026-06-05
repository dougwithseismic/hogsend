---
name: hogsend-database
description: Use when changing the database schema or running migrations in a Hogsend app — adding your own (client-track) tables in src/schema/ with Drizzle pgTable then db:generate + db:migrate, understanding the two-track system (engine-owned tables in @hogsend/db gate boot; your client tables are non-fatal), reading schema drift off /v1/health, using db:push as a dev shortcut, or bypassing the boot guard with SKIP_SCHEMA_CHECK.
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Hogsend Database

Hogsend runs **two independent migration tracks** against one Postgres
database. As a consumer (a scaffolded, content-only app) you own exactly one of
them: the **client track** — your own tables in `src/schema/index.ts`, your own
migrations in `./migrations`. The other — the **engine track** — is owned by
`@hogsend/db`, ships with `@hogsend/*` version bumps, and you never author it.

This skill helps you add tables, generate + apply migrations, and read schema
drift correctly without touching engine-internal files.

## Key concepts (read this first)

- **You own `src/schema/index.ts` only.** Define your app tables there with
  Drizzle's `pgTable`. `pnpm db:generate` diffs that file and writes a migration
  into `./migrations`; `pnpm db:migrate` applies it.
- **Engine tables live in `@hogsend/db`, not your repo.** `contacts`,
  `journeyStates`, `emailSends`, `trackedLinks`, `linkClicks`,
  `emailPreferences`, `bucketMemberships`, `userEvents`, auth tables, and the
  rest are engine-owned. **Never redefine them in `src/schema/`** — import them
  from `@hogsend/db` if you need to read/join them.
- **Two ledgers, one `drizzle` schema.** Engine track records into
  `drizzle.__drizzle_migrations`; client track into `drizzle.__client_migrations`.
  Your `drizzle.config.ts` is wired to the client ledger, so `db:generate`
  can never collide with the engine's.
- **Drift gating is asymmetric.** Engine-track drift is **fatal at boot** — the
  running build hard-requires its bundled engine schema. Client-track drift is
  **non-fatal**; once you wire `clientJournal` into `createHogsendClient` it
  surfaces on `GET /v1/health` as `status: "migration_pending"` for you to
  resolve (the block is opt-in — see `references/migrations.md`). You may
  legitimately deploy app code ahead of an additive client migration.

## The everyday flow

```bash
pnpm db:generate    # diff src/schema/index.ts -> new file in ./migrations
pnpm db:migrate     # apply ENGINE track first, then your CLIENT track
# then confirm both tracks are inSync on GET /v1/health
```

`scripts/migrate.ts` always runs engine-then-client (engine first so your client
tables can reference engine tables). Railway's `preDeployCommand` runs the same
`pnpm db:migrate` before every deploy.

## Task playbooks — load the matching reference

- **Add / change your own tables; what you may and may NOT touch** →
  `references/client-track-schema.md`
- **The db:generate → db:migrate flow, drizzle.config, the migrations dir +
  meta journal, the db:push shortcut** → `references/migrations.md`
- **Schema drift: fatal engine-track at boot vs non-fatal client-track on
  /v1/health, SKIP_SCHEMA_CHECK, recovering a db:push'd ledger** →
  `references/schema-drift.md`

## Cross-skill links

- Verifying a running instance's schema tracks (`schema.engine` /
  `schema.client`, `inSync`) from the CLI — see the **hogsend-cli** skill
  (`hogsend doctor --json`).
- Querying with conditions / property checks / time windows over engine tables
  (events, email engagement) — see the **hogsend-conditions** skill.
