import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { contacts } from "./contacts.js";

/**
 * Alias table for identity resolution. After a merge (or a fill-in-link
 * "promote"), a stale identity key — the loser's old external_id / email /
 * anonymous_id — sits on a soft-deleted row, so the `deleted_at IS NULL`
 * lookups in `findByExternalId`/`findByEmail` miss it. This table lets a stale
 * key resolve to the SURVIVOR contact instead of minting a fresh row and
 * re-splitting history (risk 5). Each `findByX` falls back to it on a miss.
 */
export const contactAliases = pgTable(
  "contact_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The SURVIVOR a stale key resolves TO.
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    // 'email' | 'external' | 'anonymous' | 'discord'
    aliasKind: text("alias_kind").notNull(),
    // The stale key value (the loser's old external_id / normalized email /
    // anonymous_id).
    aliasValue: text("alias_value").notNull(),
    // Provenance: the loser contact id this alias came from (nullable — a
    // 'promote' alias may have no distinct loser row).
    fromContactId: uuid("from_contact_id"),
    // 'merge' | 'promote'
    reason: text("reason").notNull(),
    ...timestamps,
  },
  (table) => [
    // One alias per (kind, value): a stale key resolves to exactly one survivor.
    uniqueIndex("contact_aliases_kind_value_idx").on(
      table.aliasKind,
      table.aliasValue,
    ),
    index("contact_aliases_contact_id_idx").on(table.contactId),
    // Supports the engine-internal `followToSurvivor` chain-follow: from a
    // soft-deleted loser's row id to its survivor, keyed on `from_contact_id`.
    index("contact_aliases_from_contact_id_idx").on(table.fromContactId),
  ],
);
