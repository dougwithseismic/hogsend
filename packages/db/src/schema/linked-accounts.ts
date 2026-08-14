import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { contacts } from "./contacts.js";

/**
 * One row per platform-account link, live or historical. A link is an identity
 * FACT (a player proved control of a Steam or Twitch account) and a lifecycle
 * EVENT, so rows are SOFT-unlinked, never deleted: the version sequence for a
 * `(provider, provider_user_id)` pair must stay monotonic across relinks, and
 * the history is what lets a customer audit who owned an account when.
 *
 * A NEW TABLE rather than new columns on `contacts` (DECISIONS §7): a suite of
 * N providers cannot keep adding columns.
 */
export const linkedAccounts = pgTable(
  "linked_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * The owning contact. NOT NULL — a link is only ever written from a flow
     * where the contact is already bound, so there is no orphan-key-awaiting-
     * merge case (DECISIONS §7).
     *
     * `onDelete: "cascade"` is a DATABASE-LEVEL BACKSTOP, not the deletion
     * path. NO code path in this repo hard-deletes a contact: a merge
     * soft-deletes the loser (`deletedAt`), and both `softDeleteContact` and
     * the admin delete route soft-delete too. So this cascade never fires in
     * production, and a green test for it must NOT be read as "contact
     * deletion is handled". Soft-unlinking a deleted contact's live links
     * (and repointing them on merge) is owned separately (DECISIONS §15.3);
     * until that exists, a live row outlives its owner and keeps the
     * `(provider, provider_user_id)` pair permanently locked.
     */
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /**
     * An `AccountLinkProvider` meta.id ("steam"/"twitch"). NOT foreign-keyed:
     * providers are code-defined, exactly like `provider_credentials.provider_id`.
     */
    provider: text("provider").notNull(),
    /**
     * The platform's IMMUTABLE id. Never a vanity/display name — those are
     * user-editable, so keying on one lets a rename land on another player's
     * link row. The mutable label lives in `username` below.
     */
    providerUserId: text("provider_user_id").notNull(),
    /** Display only. Refreshed opportunistically; never a key. */
    username: text("username"),
    /**
     * Only ever set from a provider-VERIFIED address (DECISIONS §6.4). An
     * unverified provider email is dropped entirely, and even a verified one is
     * a contact PROPERTY, never a merge key.
     */
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
    /**
     * "oauth" (a completed hosted callback) or "import" (the INSERT-ONLY
     * carve-out, DECISIONS §6.2). Only "oauth" may ever displace a live owner.
     */
    method: text("method")
      .$type<"oauth" | "import">()
      .notNull()
      .default("oauth"),
    /**
     * Mirrors the provider's `multiple: false`. Materialized as a column rather
     * than read from code because a partial unique index cannot consult a
     * TypeScript definition, and the one-per-contact rule has to be enforced by
     * the database or it is not enforced at all.
     */
    singleton: boolean("singleton").notNull().default(false),
    /**
     * Monotonic per (provider, provider_user_id), across ALL rows for the pair,
     * live and unlinked (DECISIONS §5.1). Every mutation gets its own version;
     * a relink burns two.
     *
     * `mode: "bigint"` deliberately, NOT the `number` mode: a Postgres bigint
     * exceeds Number.MAX_SAFE_INTEGER, and the `number` mode would round one
     * SILENTLY. The consumer's whole contract is `incoming.version >
     * stored.version` (DECISIONS §5.3), so a rounded version breaks the guard
     * in exactly the case it exists for, and breaks it invisibly.
     *
     * The cost is that `JSON.stringify` THROWS on a JS BigInt. That is the
     * desired posture, not a problem to route around: a loud throw at the
     * serialization boundary beats a silent wrong answer in a customer's
     * mirror. Every boundary therefore serializes explicitly with
     * `String(row.version)` (DECISIONS §5.1).
     */
    version: bigint("version", { mode: "bigint" }).notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** NULL = live. Set = soft-unlinked; the row stays forever. */
    unlinkedAt: timestamp("unlinked_at", { withTimezone: true }),
    /**
     * Why the LAST transition happened: "player" | "api" | "relinked"
     * (DECISIONS §8). NULL on a live row. Without this column the reason is
     * unrecoverable from the pull plane one second after the webhook is emitted.
     */
    unlinkReason: text("unlink_reason"),
    /**
     * Provider-side revocation (invalid_grant): the LINK SURVIVES and the
     * property SYNC dies (DECISIONS §10). Set this, null the blob, skip in
     * future sync runs. Never auto-unlink.
     */
    tokensRevokedAt: timestamp("tokens_revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Live-uniqueness: at most ONE live link per platform account, ever. The
    // partial predicate (`WHERE unlinked_at IS NULL`) is what lets a relink keep
    // the old row for history — identical idiom to the contacts identity indexes
    // and groups_type_key_unique_idx.
    uniqueIndex("linked_accounts_provider_uid_live_idx")
      .on(table.provider, table.providerUserId)
      .where(sql`unlinked_at IS NULL`),
    // One-per-contact enforcement for `multiple: false` providers. Partial on
    // BOTH predicates, so `multiple: true` providers (singleton=false) are
    // untouched and unlinked rows never block a relink.
    uniqueIndex("linked_accounts_contact_provider_singleton_idx")
      .on(table.contactId, table.provider)
      .where(sql`unlinked_at IS NULL AND singleton`),
    // THE LOST-RACE BACKSTOP (DECISIONS §5.6). NOT partial: the version sequence
    // spans live AND unlinked rows, so a partial index here would let a relink
    // re-issue a version an unlinked row already burned, and the consumer's
    // `incoming.version > stored.version` guard would silently discard the newer
    // truth. Under the advisory lock this constraint should never fire; when it
    // does it means the lock was lost or bypassed, and a 23505 is a retryable
    // failure while a duplicate version is a permanent, invisible wrong answer.
    uniqueIndex("linked_accounts_provider_uid_version_idx").on(
      table.provider,
      table.providerUserId,
      table.version,
    ),
    // "What is this contact linked to right now" — the contact-detail panel,
    // the manage page, and the merge repoint all read this way.
    index("linked_accounts_contact_live_idx")
      .on(table.contactId)
      .where(sql`unlinked_at IS NULL`),
  ],
);
