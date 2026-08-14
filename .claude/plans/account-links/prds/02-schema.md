# PRD 02 — `linked_accounts` schema + migration (`@hogsend/db`)

## Goal
Add the `linked_accounts` table to `@hogsend/db` with the four indexes the consistency contract
and the policy engine depend on. Purely additive: no existing table changes, no column drops, no
data backfill. After this PRD the store (PRD 03) has somewhere to write and the version race has
its backstop constraint.

## Locked decisions specific to this PRD

- The table is `linked_accounts` (DECISIONS §2) and it is a NEW TABLE, not new columns on
  `contacts` (DECISIONS §7): a suite of N providers cannot keep adding columns.
- `version bigint NOT NULL`, monotonic per `(provider, provider_user_id)` across ALL rows for the
  pair, live and unlinked (DECISIONS §5.1). Every mutation gets its own version. This PRD supplies
  the column and the constraint; the computation lives in PRD 03.
- **The version crosses every boundary as a STRING** (DECISIONS §5.1). Postgres `bigint` exceeds
  `Number.MAX_SAFE_INTEGER`, so the drizzle column is declared `mode: "bigint"` and every consumer
  serializes with `String(row.version)`. A `mode: "number"` column would silently round a large
  version, and a rounded version breaks the consumer's `incoming.version > stored.version` guard in
  exactly the case that guard exists for. See T1's column comment.
- **No property-sync columns here.** PRD 14 owns `synced_at` (plus its partial scan index) and adds
  them in its OWN additive migration on top of this one, so this table ships without them. That
  split is deliberate: this PRD is the consistency contract's storage, PRD 14 is the sync
  bookkeeping, and they are independently shippable.
- The lost-race backstop is a unique constraint on `(provider, provider_user_id, version)`
  (DECISIONS §5.6) so a lost race surfaces as a retryable 23505 rather than a silent duplicate
  version.
- **`contacts.discordId` is untouched, in either direction.** Discord is out of v1 (DECISIONS §12),
  so there is no mirror to dual-write and no backfill to run: `plugin-discord` remains the sole
  writer of that column and keeps working exactly as it does today. No change to
  `packages/db/src/schema/contacts.ts`, and no PRD in this stack may add one.
- Soft-unlink, not delete: an unlinked row stays so the version sequence for the pair stays
  monotonic and the history is auditable. The FK cascade below is therefore a backstop for a
  DB-level hard delete, not the production deletion path; contact deletion is owned by PRD 04
  (DECISIONS §15.3).

## Acceptance criteria (EARS)

- WHEN the migration is applied, the system SHALL create table `linked_accounts` with exactly the
  columns in T1 and SHALL alter no other table.
- WHEN two live rows are attempted for the same `(provider, provider_user_id)`, the system SHALL
  reject the second with 23505 on `linked_accounts_provider_uid_live_idx`.
- WHEN a row is soft-unlinked (`unlinked_at` set) and a new live row is inserted for the same
  `(provider, provider_user_id)`, the system SHALL accept it, because the live-uniqueness index is
  partial on `unlinked_at IS NULL`.
- WHEN two rows are attempted with the same `(provider, provider_user_id, version)`, the system
  SHALL reject the second with 23505 on `linked_accounts_provider_uid_version_idx`, whether or not
  either row is live.
- WHEN a contact already holds a live `singleton` row for a provider and a second live
  `singleton` row for the same `(contact_id, provider)` is attempted, the system SHALL reject it
  with 23505 on `linked_accounts_contact_provider_singleton_idx`.
- WHEN a contact holds live NON-singleton rows for a provider, the system SHALL allow any number
  of them, because the singleton index is partial on `singleton`.
- WHEN a contact row is hard-deleted AT THE DATABASE LEVEL, the system SHALL cascade-delete its
  `linked_accounts` rows. **This is a backstop, not a code path.** No production path in this repo
  hard-deletes a contact: a merge soft-deletes the loser (`deletedAt`), and both `softDeleteContact`
  (`engine/src/lib/contacts.ts:2873`) and the admin delete route
  (`engine/src/routes/admin/contacts.ts:651-671`) soft-delete too. So this criterion certifies
  behaviour that never fires in production, and must not be read as "deletes are covered". Merge
  repointing AND contact deletion/erasure are both owned by PRD 04 (DECISIONS §15.3); without PRD 04
  a live link outlives its owner forever and the pair stays permanently locked.
- WHEN `tokens` is written, the system SHALL store an opaque sealed blob as `text`, never
  queryable JSON.
- WHEN `pnpm db:generate` is re-run with no schema change, the system SHALL produce no new
  migration file (proving the checked-in SQL matches the schema).
- WHEN a `version` greater than `Number.MAX_SAFE_INTEGER` is written and read back, the system
  SHALL return it without loss of precision and SHALL NOT surface it as a JS `number`.

## Tasks

### T1 — The table
_Boundary:_ `packages/db`
_Depends:_ —

Create `packages/db/src/schema/linked-accounts.ts`. Follow the conventions of
`packages/db/src/schema/groups.ts` and `group-memberships.ts` (the most recent additive pair):
`timestamps` spread from `./_shared.js` (`packages/db/src/schema/_shared.ts:3-10`), a doc comment
that states WHY each index exists, `uuid("id").defaultRandom().primaryKey()`.

```ts
import { sql } from "drizzle-orm";
import {
  bigint, boolean, index, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { contacts } from "./contacts.js";

/**
 * One row per platform-account link, live or historical. A link is an identity
 * FACT (a player proved control of a Steam or Twitch account) and a
 * lifecycle EVENT, so rows are SOFT-unlinked, never deleted: the version
 * sequence for a `(provider, provider_user_id)` pair must stay monotonic across
 * relinks, and the history is what lets a customer audit who owned an account
 * when.
 */
export const linkedAccounts = pgTable(
  "linked_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** An `AccountLinkProvider` meta.id ("steam"/"twitch"). NOT
     * foreign-keyed: providers are code-defined, exactly like
     * `provider_credentials.provider_id`. */
    provider: text("provider").notNull(),
    /** The platform's IMMUTABLE id. Never a vanity/display name — those are
     * user-editable, so keying on one lets a rename land on another player's
     * link row. The mutable label lives in `username` below. */
    providerUserId: text("provider_user_id").notNull(),
    /** Display only. Refreshed opportunistically; never a key. */
    username: text("username"),
    /** Only ever set from a provider-VERIFIED address (DECISIONS §6.4). An
     * unverified provider email is a property, not an identity key. */
    verifiedEmail: text("verified_email"),
    avatarUrl: text("avatar_url"),
    /**
     * AES-256-GCM sealed blob (base64url), produced by the engine's
     * `lib/provider-credentials.ts` crypto. `text` and NOT `jsonb` for the same
     * reason as `provider_credentials.payload`: the contents must not be
     * queryable — tokens are opaque at the database layer by design. NULL for
     * providers that hold no tokens (Steam has none: OpenID 2.0 issues none).
     */
    tokens: text("tokens"),
    /** "oauth" (a completed hosted callback) or "import" (the INSERT-ONLY
     * carve-out, DECISIONS §6.2). Only "oauth" may ever displace a live owner. */
    method: text("method").$type<"oauth" | "import">().notNull().default("oauth"),
    /** Mirrors the provider's `multiple: false`. Materialized as a column
     * rather than read from code because a partial unique index cannot consult
     * a TypeScript definition, and the one-per-contact rule has to be enforced
     * by the database or it is not enforced at all. */
    singleton: boolean("singleton").notNull().default(false),
    /**
     * Monotonic per (provider, provider_user_id), across ALL rows for the pair,
     * live and unlinked (DECISIONS §5.1). Every mutation gets its own version;
     * a relink burns two.
     *
     * `mode: "bigint"` deliberately, NOT `mode: "number"`: a Postgres bigint
     * exceeds Number.MAX_SAFE_INTEGER, and `mode: "number"` would round one
     * SILENTLY. The consumer's whole contract is `incoming.version >
     * stored.version` (DECISIONS §5.3), so a rounded version breaks the guard in
     * exactly the case it exists for, and breaks it invisibly.
     *
     * The cost is that `JSON.stringify` THROWS on a JS BigInt. That is the
     * desired posture, not a problem to route around: a loud throw at the
     * serialization boundary beats a silent wrong answer in a customer's
     * mirror. Every boundary therefore serializes explicitly with
     * `String(row.version)` (DECISIONS §5.1) — the outbound payloads (PRD 08),
     * the routes (PRD 09), the SDK types (PRD 12) and the admin reads (PRD 15).
     */
    version: bigint("version", { mode: "bigint" }).notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).defaultNow().notNull(),
    /** NULL = live. Set = soft-unlinked; the row stays forever. */
    unlinkedAt: timestamp("unlinked_at", { withTimezone: true }),
    /** Why the LAST transition happened: "player" | "api" | "relinked"
     * (DECISIONS §8). NULL on a live row. */
    unlinkReason: text("unlink_reason"),
    /** Provider-side revocation (invalid_grant): the LINK SURVIVES and the
     * property SYNC dies (DECISIONS §10). Set this, null the blob, skip in
     * future cron runs. Never auto-unlink. */
    tokensRevokedAt: timestamp("tokens_revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [ /* T2 */ ],
);
```

Note `unlinkReason` is an addition to the column list in the backlog brief: DECISIONS §8's
`account.unlinked` payload carries `reason`, and PRD 04's singleton-collision resolution needs to
record `"relinked"` on the loser row. Without the column the reason is unrecoverable from the pull
plane one second after the webhook is emitted.

### T2 — The four indexes
_Boundary:_ `packages/db`
_Depends:_ T1

```ts
  (table) => [
    // Live-uniqueness: at most ONE live link per platform account, ever. The
    // partial predicate (`WHERE unlinked_at IS NULL`) is what lets a relink
    // keep the old row for history — identical idiom to the contacts identity
    // indexes at contacts.ts:96-113 and groups_type_key_unique_idx at
    // groups.ts:54-56.
    uniqueIndex("linked_accounts_provider_uid_live_idx")
      .on(table.provider, table.providerUserId)
      .where(sql`unlinked_at IS NULL`),
    // One-per-contact enforcement for `multiple: false` providers. Partial on
    // BOTH predicates, so `multiple: true` providers (singleton=false) are
    // untouched and unlinked rows never block a relink.
    uniqueIndex("linked_accounts_contact_provider_singleton_idx")
      .on(table.contactId, table.provider)
      .where(sql`unlinked_at IS NULL AND singleton`),
    // THE LOST-RACE BACKSTOP (DECISIONS §5.6). NOT partial: the version
    // sequence spans live AND unlinked rows, so a partial index here would let
    // a relink re-issue a version an unlinked row already burned, and the
    // consumer's `incoming.version > stored.version` guard would silently
    // discard the newer truth. Under the advisory lock this constraint should
    // never fire; when it does it means the lock was lost or bypassed, and a
    // 23505 is a retryable failure while a duplicate version is a permanent,
    // invisible wrong answer.
    uniqueIndex("linked_accounts_provider_uid_version_idx")
      .on(table.provider, table.providerUserId, table.version),
    // "What is this contact linked to right now" — the contact-detail panel,
    // the manage page, and PRD 04's merge repoint all read this way.
    index("linked_accounts_contact_live_idx")
      .on(table.contactId)
      .where(sql`unlinked_at IS NULL`),
  ],
```

### T3 — Wire into the schema barrel and relations
_Boundary:_ `packages/db`
_Depends:_ T1

- Add `export * from "./linked-accounts.js";` to `packages/db/src/schema/index.ts`, alphabetically
  (it lands next to `./links.js`).
- Add relations in `packages/db/src/schema/relations.ts` mirroring
  `groupMembershipsRelations` (`relations.ts:108-118`): `linkedAccountsRelations` with
  `contact: one(contacts, { fields: [linkedAccounts.contactId], references: [contacts.id] })`, and
  add `linkedAccounts: many(linkedAccounts)` to `contactsRelations`.

### T4 — Generate the migration
_Boundary:_ `packages/db`
_Depends:_ T1-T3

Run `cd packages/db && pnpm db:generate` (drizzle-kit, config at
`packages/db/drizzle.config.ts`, output `./drizzle`). It emits the next numbered file after
`0071_gigantic_mulholland_black.sql` (so `0072_<name>.sql`) plus an updated
`drizzle/meta/_journal.json` and snapshot. Commit all of them; never hand-edit the generated SQL
except to add a comment.

The expected DDL, for review against what drizzle emits:

```sql
CREATE TABLE "linked_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contact_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "provider_user_id" text NOT NULL,
  "username" text,
  "verified_email" text,
  "avatar_url" text,
  "tokens" text,
  "method" text DEFAULT 'oauth' NOT NULL,
  "singleton" boolean DEFAULT false NOT NULL,
  "version" bigint NOT NULL,
  "linked_at" timestamp with time zone DEFAULT now() NOT NULL,
  "unlinked_at" timestamp with time zone,
  "unlink_reason" text,
  "tokens_revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "linked_accounts" ADD CONSTRAINT "linked_accounts_contact_id_contacts_id_fk"
  FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade;
CREATE UNIQUE INDEX "linked_accounts_provider_uid_live_idx"
  ON "linked_accounts" ("provider","provider_user_id") WHERE unlinked_at IS NULL;
CREATE UNIQUE INDEX "linked_accounts_contact_provider_singleton_idx"
  ON "linked_accounts" ("contact_id","provider") WHERE unlinked_at IS NULL AND singleton;
CREATE UNIQUE INDEX "linked_accounts_provider_uid_version_idx"
  ON "linked_accounts" ("provider","provider_user_id","version");
CREATE INDEX "linked_accounts_contact_live_idx"
  ON "linked_accounts" ("contact_id") WHERE unlinked_at IS NULL;
```

**Migration track.** This is an ENGINE-track migration: `packages/db/drizzle` is applied by
`packages/db/src/migrate.ts` into `drizzle.__engine_migrations`
(`ENGINE_MIGRATIONS_TABLE`/`ENGINE_MIGRATIONS_SCHEMA`, see `migrate.ts:1-22`). The CLIENT track
(`migrate-client.ts`, `CLIENT_MIGRATIONS_FOLDER`) belongs to consumer repos and gets NOTHING from
this PRD. Both tracks serialize behind the same advisory lock `4812007` (`migrate.ts:22`), so a
consumer deploy running both in sequence is safe.

### T5 — Schema tests
_Boundary:_ `apps/api`
_Depends:_ T4

`apps/api/src/__tests__/linked-accounts-schema.test.ts`, against the real test database (the
existing suite convention: `process.env.DATABASE_URL` defaulting to
`postgresql://growthhog:growthhog@localhost:5434/growthhog`, see
`apps/api/src/__tests__/resolve-policy-trusted-kinds.test.ts:1-30`). Every row this suite creates
must be namespaced by a per-run prefix and cleaned in `afterAll`, and every assertion scoped to
that namespace, never a whole-table count.

Cases, each asserting the SQLSTATE and the CONSTRAINT NAME, not just "it threw":

1. `rejects a second live row for the same provider and provider_user_id`
2. `allows a new live row after the previous one is soft-unlinked`
3. `rejects a duplicate (provider, provider_user_id, version) even when one row is unlinked`
4. `rejects a second live singleton row for the same (contact, provider)`
5. `allows many live non-singleton rows for the same (contact, provider)`
6. `cascades on a hard contact delete` — a DB-level backstop only. Name it
   `cascades on a hard contact delete (backstop; no production path hard-deletes)` and add a
   comment pointing at PRD 04's `unlinkAccountsForContactInTx`, so nobody reads a green here as
   "contact deletion is handled".
7. `a version above Number.MAX_SAFE_INTEGER round-trips without loss` — insert
   `9007199254740993n`, read the row back through drizzle, and assert the value is a `bigint` whose
   `String()` is exactly `"9007199254740993"`. This test FAILS if the column is ever changed back to
   `mode: "number"`, which is the point (DECISIONS §5.1).

23505 detection: drizzle wraps the postgres error, so walk `err.cause` for `code === "23505"` and
`constraint_name` rather than string-matching the message. This is the same idiom the repo already
relies on for partial-index conflicts.

### T6 — Changeset
_Boundary:_ `.changeset`
_Depends:_ T1-T5

Minor changeset for `@hogsend/db` (new exported table) and a patch note that consumers must run
`pnpm db:migrate` on upgrade.

## Seams
None. Local Postgres on 5434 (docker compose) is all this needs.

## Done when
- [ ] `packages/db/src/schema/linked-accounts.ts` exists, exported from the schema barrel, with
      relations wired.
- [ ] `packages/db/drizzle/0072_*.sql` is committed together with the updated
      `drizzle/meta/_journal.json` and snapshot.
- [ ] Re-running `cd packages/db && pnpm db:generate` produces NO new migration file.
- [ ] `git diff --stat` shows no modification to any other file under `packages/db/src/schema/`
      except `index.ts` and `relations.ts`.
- [ ] All seven schema tests pass against a freshly migrated database.
- [ ] The `version` column is `mode: "bigint"`; `grep -n 'mode: "number"'
      packages/db/src/schema/linked-accounts.ts` returns nothing.
- [ ] No `synced_at` column is present: it belongs to PRD 14's migration.
- [ ] `pnpm lint` green.
- [ ] `pnpm -C $WT/packages/<pkg> exec tsc --noEmit` for every package touched (NOT root `check-types` — vacuous, DECISIONS §4).
- [ ] `pnpm -C $WT exec turbo run test --filter='!@hogsend/api'` (the `exec` is load-bearing — DECISIONS §4).
- [ ] `cd apps/api && pnpm test` green.
- [ ] `pnpm build` green.
- [ ] A changeset exists for `@hogsend/db`.
- [ ] One conventional commit, e.g. `feat(db): add linked_accounts table`.

## Implementation Notes
