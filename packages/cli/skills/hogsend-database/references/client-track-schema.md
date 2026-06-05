# Client-track schema — what you own

Your app's tables live in **`src/schema/index.ts`** and migrate on the **client
track**. This is the only schema file you author. Engine tables live in
`@hogsend/db` and are off-limits to redefine.

## What you own vs what the engine owns

| | Owner | Where it lives | Ledger | Drift gating |
|---|---|---|---|---|
| **Client tables** (your app data) | You | `src/schema/index.ts` → `./migrations` | `drizzle.__client_migrations` | non-fatal → `/v1/health` |
| **Engine tables** (`contacts`, `journeyStates`, `emailSends`, `trackedLinks`, `linkClicks`, `emailPreferences`, `bucketMemberships`, `userEvents`, auth, alert/import/dlq tables, …) | `@hogsend/db` | inside the published `@hogsend/db` package | `drizzle.__drizzle_migrations` | **fatal at boot** |

**Rule:** never re-declare an engine table (`contacts`, `journey_states`,
`email_sends`, etc.) in `src/schema/`. If you do, `db:generate` will try to
create a table the engine already manages and your client migration will collide
with engine objects. Import them from `@hogsend/db` instead.

## Adding a table

Open `src/schema/index.ts` and add a `pgTable`. The scaffold ships a starter
table (`clientNotes`) you can rename or replace:

```ts
// src/schema/index.ts
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * CLIENT-track schema. Engine tables (contacts, journeyStates, emailSends,
 * tracking, ...) live in @hogsend/db and migrate on the ENGINE track — do NOT
 * redefine them here. Add only your own app-specific tables.
 */
export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Match the engine's contact identity: contacts.externalId is the user id
    // you pass to ingest/journeys. Keep it text, not a FK, to stay decoupled.
    userId: text("user_id").notNull(),
    subject: text("subject").notNull(),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("support_tickets_user_id_idx").on(table.userId)],
);
```

Then generate + apply (see `migrations.md`):

```bash
pnpm db:generate
pnpm db:migrate
```

## Conventions worth matching

Engine tables use these patterns; mirroring them keeps your schema consistent:

- **`uuid("id").primaryKey().defaultRandom()`** for surrogate keys.
- **`timestamp(..., { withTimezone: true })`** — always timezone-aware.
- **`text("user_id")`** to reference a contact by its external id (the same id
  you pass to `ctx.trigger`/ingest). Engine tables denormalize `user_id` as
  plain `text` rather than a hard FK to `contacts`, so you stay decoupled from
  engine internals — do the same.
- Add `index(...)` on the columns you filter/sort by.

## Reading engine tables from your code

You don't redefine engine tables — you import them. The engine container exposes
the schema-aware Drizzle db; engine table objects come from `@hogsend/db`:

```ts
// e.g. inside a custom workflow or route handler
import { contacts, emailSends } from "@hogsend/db";
import { eq } from "drizzle-orm";

// `db` is the container's Drizzle instance (c.get("container").db, or
// client.db). It already knows the full engine + your client schema.
const rows = await db
  .select()
  .from(contacts)
  .where(eq(contacts.externalId, "user_123"));
```

Joining your client table to an engine table (e.g. `support_tickets.userId` ↔
`contacts.externalId`) works because both are registered on the same Drizzle
instance — your client schema is bundled into the consumer build alongside
`@hogsend/db`.

## Don't edit

- Anything under `@hogsend/db` (it's a dependency, not your source).
- The engine ledger `drizzle.__drizzle_migrations`.
- The engine's `drizzle.config` / migration folder — you only have your own
  client `drizzle.config.ts` and `./migrations`.
