import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { contacts } from "./contacts.js";
import { groups } from "./groups.js";

/**
 * Join table associating a contact with a group (e.g. a person belonging to a
 * "company"). Unlike bucket_memberships (which joins on the text user_id key),
 * both sides here are real uuid FKs — a membership row is created after both the
 * group and the contact exist.
 */
export const groupMemberships = pgTable(
  "group_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Multi-tenant insurance (nullable today, NOT in the unique key).
    organizationId: text("organization_id"),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    // Optional role of the contact within the group (e.g. "admin", "member").
    role: text("role"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    ...timestamps,
  },
  (table) => [
    // Exactly one membership per (group, contact).
    uniqueIndex("group_memberships_group_contact_unique_idx").on(
      table.groupId,
      table.contactId,
    ),
    index("group_memberships_group_id_idx").on(table.groupId), // a group's members
    index("group_memberships_contact_id_idx").on(table.contactId), // a contact's groups
  ],
);
