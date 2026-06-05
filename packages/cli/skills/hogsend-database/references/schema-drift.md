# Schema drift — fatal engine track vs non-fatal client track

"Drift" = the migrations a build requires don't match what's applied to the
database. Hogsend treats the two tracks **asymmetrically**, and that asymmetry
is the whole mental model.

## The gating policy

- **Engine track → FATAL at boot.** The running build hard-requires its bundled
  engine schema. If the database is behind, the engine table you query may be
  missing a column, so the app **refuses to start** rather than 500 later. A
  database that is *ahead* of the build is fine (forward-compatible).
- **Client track → NON-FATAL.** You own it. You may legitimately deploy app code
  ahead of an additive client migration, and a pending client migration must not
  take the whole API down. It surfaces (not blocks) on `/v1/health`.

The boot guard lives in the scaffold's `src/index.ts` and checks only the engine
track:

```ts
// src/index.ts (scaffolded boot guard)
import { getEngineSchemaVersion } from "@hogsend/engine";

if (process.env.SKIP_SCHEMA_CHECK !== "true") {
  const schema = await getEngineSchemaVersion(client.db);
  if (!schema.inSync) {
    client.logger.error(
      `Database schema is out of date: this build requires ${schema.required}, ` +
        `database is at ${schema.applied ?? "(empty)"}. ` +
        `Pending migration(s): ${schema.pending.join(", ") || "(unknown — is the DB reachable?)"}. ` +
        "Run `pnpm db:migrate`, or set SKIP_SCHEMA_CHECK=true to bypass.",
    );
    await client.dbClient.end({ timeout: 5 });
    process.exit(1);
  }
  client.logger.info(`Database schema in sync at ${schema.applied}`);
}
```

Note it calls `getEngineSchemaVersion` (re-exported by `@hogsend/engine`) — the
**client** track is deliberately NOT in the boot guard. `client.db` is the
container's Drizzle instance; `client.dbClient` is the underlying postgres-js
connection it closes before exiting.

## Reading drift off `GET /v1/health`

`/v1/health` reports both tracks. The top-level `status` is `migration_pending`
if **either** track is behind:

```jsonc
{
  "status": "migration_pending",        // healthy | degraded | migration_pending
  "schema": {
    "engine": { "applied": "0042_…", "required": "0042_…", "inSync": true,  "pending": [] },
    "client": { "applied": "0000_init", "required": "0001_add_tickets",
                "inSync": false, "pending": ["0001_add_tickets"] }
  },
  "components": { "database": { "status": "up" }, "redis": { "status": "up" } }
}
```

- `schema.engine.inSync: false` should be impossible on a *running* app — the
  boot guard would have exited. If you ever see it, the app was started with
  `SKIP_SCHEMA_CHECK=true`.
- `schema.client.inSync: false` is the normal "I haven't run `db:migrate` yet"
  signal — non-fatal, but your responsibility to clear. **Note:** the client
  block only reflects your migrations if you wired `clientJournal` into
  `createHogsendClient` (it defaults to `{ entries: [] }` ⇒ always `inSync: true`).
  See the `clientJournal` opt-in wiring in `migrations.md`.

`status` decoding:

| `status` | meaning |
|---|---|
| `healthy` | both tracks `inSync`, db + redis up |
| `degraded` | both tracks `inSync`, but db or redis is down |
| `migration_pending` | engine OR client track is behind |

To check this from the CLI (any instance, local or prod) without parsing JSON by
hand, use `hogsend doctor --json` — see the **hogsend-cli** skill. It hits the
unauthenticated `/v1/health` and gives a drift verdict.

## Fixing drift

- **Client track behind** (the common case): `pnpm db:migrate`. If you changed
  `src/schema/` but never generated, run `pnpm db:generate` first.
- **Engine track behind** (app won't boot after a `@hogsend/*` bump): `pnpm
  db:migrate` applies the new engine migrations that arrived with the bump, then
  the boot guard passes.

## `SKIP_SCHEMA_CHECK` — emergency bypass only

`SKIP_SCHEMA_CHECK=true` makes `src/index.ts` skip the engine boot guard so the
app starts even on a behind-engine database. Use it only to bring an instance up
during an incident; it does NOT fix the schema, and the first query against a
missing column will still fail. Clear the drift with `db:migrate` and remove the
flag.

## The `db:push` ledger trap (and recovery)

A database bootstrapped with `pnpm db:push` has the schema objects but **no
ledger rows** — so `db:migrate` and the boot guard think migrations are pending
even though every object already exists, and you'll see `migration_pending` /
"type already exists" errors.

- **Client track:** since `db:push` is for throwaway local churn, the cleanest
  fix is to reset that dev database and run `pnpm db:migrate` from clean, so the
  ledger and schema agree. For anything real, generate + migrate from the start.
- **Engine track:** `@hogsend/db` ships a `db:stamp` recovery tool that records
  every bundled engine migration as *applied* WITHOUT running SQL — for the
  exact case where a dev DB was `db:push`-ed and the engine ledger is behind a
  schema that already matches HEAD. It is an engine-package script (run inside
  `@hogsend/db`), not a consumer command, and it is dangerous if the schema is
  genuinely missing objects (it would mark migrations applied without creating
  them). Reach for a clean `db:migrate` first; only stamp when you are certain
  the schema already matches HEAD.

## Bottom line

You can only cause **client-track** drift (it's the only track you author), and
client-track drift never takes the app down — it just lights up
`migration_pending` on `/v1/health` until you `pnpm db:migrate`. Engine-track
drift is the engine's job to gate, and it does so fatally at boot.
