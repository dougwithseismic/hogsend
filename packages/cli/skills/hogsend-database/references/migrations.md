# Migrations — db:generate → db:migrate

Your client track is plain Drizzle Kit. Three scripts ship in the scaffold's
`package.json`:

```jsonc
{
  "db:generate": "drizzle-kit generate",                          // diff schema -> ./migrations
  "db:push":     "drizzle-kit push",                              // direct sync (dev shortcut)
  "db:migrate":  "tsx --env-file-if-exists=.env scripts/migrate.ts" // engine THEN client
}
```

## drizzle.config.ts (client track)

Your `drizzle.config.ts` points Drizzle Kit at your schema, your migrations
folder, and — critically — the **client** ledger, never the engine's:

```ts
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./migrations",
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  migrations: {
    table: "__client_migrations", // client ledger — NOT __drizzle_migrations
    schema: "drizzle",
  },
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://hogsend:hogsend@localhost:5434/hogsend",
  },
});
```

The `migrations.table: "__client_migrations"` line is what keeps your generated
SQL on the client track and out of the engine's `drizzle.__drizzle_migrations`
ledger.

## The flow

```bash
# 1. Edit src/schema/index.ts (add/change a pgTable)

# 2. Generate a client migration from the diff
pnpm db:generate
#    -> writes ./migrations/NNNN_<name>.sql
#    -> updates ./migrations/meta/_journal.json + a snapshot

# 3. Apply: engine track first, then your client track
pnpm db:migrate
```

`pnpm db:migrate` runs `scripts/migrate.ts`, which calls `@hogsend/db`'s
`migrateEngine(...)` and then `migrateClient(...)`:

```ts
// scripts/migrate.ts (scaffolded) — the shape, not for you to edit casually
import { type JournalShape, migrateClient, migrateEngine } from "@hogsend/db";

await migrateEngine(databaseUrl);                         // engine track first
// resolve ./migrations + read meta/_journal.json, then:
await migrateClient(databaseUrl, migrationsFolder, journal); // your client track
```

Engine runs first so your client migrations can safely reference engine tables.
Both tracks run under a shared Postgres advisory lock, so concurrent deploys /
replicas serialize instead of racing.

## The `./migrations` directory + meta journal

```
migrations/
  0000_init.sql          # your generated SQL
  meta/
    _journal.json        # ordered list of your migrations (idx/tag/when)
    0000_snapshot.json   # Drizzle's snapshot for the next diff
```

`meta/_journal.json` is the source of truth for the client track. Its entries
drive which client migrations `db:migrate` applies. **Commit the whole
`migrations/` folder.** An empty journal (`{ entries: [] }`) means a trivially
in-sync client track — fine if you have no client tables yet.

### Surfacing client drift on `/v1/health` (opt-in wiring)

The `schema.client` block on `GET /v1/health` is computed from a `clientJournal`
you pass into `createHogsendClient`. It is **opt-in** — `createHogsendClient`
defaults `clientJournal` to `{ entries: [] }`, so until you wire it the client
track always reports `inSync: true` regardless of pending client migrations.
Import your journal and thread it through in `src/index.ts`:

```ts
// src/index.ts
import { createHogsendClient } from "@hogsend/engine";
import journal from "../migrations/meta/_journal.json" with { type: "json" };
import { buckets } from "./buckets/index.js";
import { templates } from "./emails/index.js";
import { journeys } from "./journeys/index.js";

const client = createHogsendClient({
  journeys,
  buckets,
  email: { templates },
  clientJournal: journal, // now /v1/health.schema.client reflects YOUR migrations
});
```

`clientJournal` is the only client-track wiring; `JournalShape` (the `{ entries }`
type) is re-exported from `@hogsend/engine` if you need to annotate it. The
engine never gates boot on it — it only feeds the non-fatal `/v1/health` block.

## `db:push` — the dev shortcut (and its trap)

`pnpm db:push` runs `drizzle-kit push`: it diffs `src/schema/index.ts` against
the live database and applies the changes **directly**, without writing a
migration file or a ledger row. Great for fast local iteration.

The trap: `db:push` leaves the **ledger behind the actual schema**. A later
`db:migrate` (or the boot guard) then sees migrations it thinks are pending even
though the objects already exist. So:

- **Local-only churn:** `db:push` is fine.
- **Anything you intend to deploy:** use `db:generate` + `db:migrate`, never
  `db:push`. Deployments apply migration files; a `push`-only change won't exist
  in `./migrations` and won't ship.

Recovering a database that drifted because of `db:push` is covered in
`schema-drift.md`.
