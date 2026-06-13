import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id"),
    /**
     * Stable external/distinct id (= the `user_id` text key joined by every
     * contact-referencing table). NULLABLE since D1: contacts can be email-only
     * or anonymous-only. Uniqueness is enforced by the partial-unique index
     * below (scoped to live, non-deleted rows) rather than an inline `.unique()`
     * — a soft-deleted loser row must be able to keep its stale external_id
     * until a merge re-points it.
     */
    externalId: text("external_id"),
    email: text("email"),
    /**
     * Stable anonymous/distinct id for the future anonymous→identified path.
     * NULLABLE. Like external_id, uniqueness is enforced by a partial-unique
     * index scoped to live, non-deleted rows.
     */
    anonymousId: text("anonymous_id"),
    /**
     * Nullable Discord user id (snowflake) attached to an email-keyed contact
     * when a member completes the per-member OAuth link. Like external_id it is
     * a RESOLVABLE identity key (a fourth `Kind`), NOT a property — but it is
     * NEVER the canonical text key (`external_id ?? anonymous_id ?? id`), so it
     * does not participate in the history re-point. Uniqueness is the
     * partial-unique live-row index below, identical to
     * contacts_external_id_unique_idx.
     */
    discordId: text("discord_id"),
    /**
     * Opportunistic IANA-timezone cache (e.g. "America/New_York"). Populated
     * best-effort when a tz is resolved from PostHog person props. PostHog and
     * `properties` jsonb remain authoritative sources — this column sits below
     * them in the resolution precedence, so nothing is blocked on it.
     */
    timezone: text("timezone"),
    properties: jsonb("properties")
      .$type<Record<string, unknown>>()
      .default({}),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Plain (non-unique) lookup index on email — kept for the email-search path.
    index("contacts_email_idx").on(table.email),
    // D1 partial-unique identity indexes. Each is scoped to live rows
    // (`WHERE col IS NOT NULL AND deleted_at IS NULL`) so a soft-deleted loser
    // row can retain its stale key until a merge re-points it (merge soft-
    // deletes the loser FIRST, then copies keys onto the survivor — risk 4).
    uniqueIndex("contacts_external_id_unique_idx")
      .on(table.externalId)
      .where(sql`external_id IS NOT NULL AND deleted_at IS NULL`),
    // Functional partial-unique on lower(email) — email is a case-insensitive
    // resolvable identity key. Emails are stored already-normalized (trim +
    // toLowerCase), so lower() here is belt-and-suspenders.
    uniqueIndex("contacts_email_unique_idx")
      .on(sql`lower(email)`)
      .where(sql`email IS NOT NULL AND deleted_at IS NULL`),
    uniqueIndex("contacts_anonymous_id_unique_idx")
      .on(table.anonymousId)
      .where(sql`anonymous_id IS NOT NULL AND deleted_at IS NULL`),
    uniqueIndex("contacts_discord_id_unique_idx")
      .on(table.discordId)
      .where(sql`discord_id IS NOT NULL AND deleted_at IS NULL`),
  ],
);
